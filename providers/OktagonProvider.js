// ------------------------------------------------------------------------------
// OktagonProvider.js
// Oktagon MMA provider — scrapes fighter art from oktagonmma.com
// Falls back to TheSportsDB for event/league metadata
//
// Fighter images are pulled from:
//   https://oktagonmma.com/en/fighters/
// TheSportsDB league ID: search "Oktagon" at thesportsdb.com
// ------------------------------------------------------------------------------

const axios = require('axios');
const BaseProvider = require('./BaseProvider');
const { getTeamMatchScoreWithOverrides } = require('../helpers/teamUtils');
const { applyTeamOverrides } = require('../helpers/teamUtils');
const logger = require('../helpers/logger');
const fsCache = require('../helpers/fsCache');
const { TeamNotFoundError } = require('../helpers/errors');
const { REQUEST_TIMEOUT } = require('../helpers/requestConfig');

class OktagonProvider extends BaseProvider {
    constructor() {
        super();
        this.CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours (roster changes more often)
        this.REQUEST_TIMEOUT = REQUEST_TIMEOUT;
        this.FIGHTERS_URL = 'https://oktagonmma.com/en/fighters/';
        this.THESPORTSDB_API_KEY = process.env.THESPORTSDB_API_KEY || '3';
        this.THESPORTSDB_LEAGUE_ID = '5702'; // Oktagon MMA on TheSportsDB
    }

    getProviderId() {
        return 'oktagon';
    }

    getConfigKey() {
        return 'oktagon';
    }

    // -------------------------------------------------------------------------
    // Public API (matches BaseProvider contract)
    // -------------------------------------------------------------------------

    async resolveTeam(league, fighterIdentifier) {
        if (!league || !fighterIdentifier) {
            throw new Error('Both league and fighter identifier are required');
        }

        const fighters = await this.fetchFighterData();

        let bestMatch = null;
        let bestScore = 0;

        for (const fighter of fighters) {
            const fighterObj = {
                fullName: fighter.fullName,
                name: fighter.lastName,
                city: fighter.firstName,
                abbreviation: (fighter.firstName?.[0] || '') + (fighter.lastName?.[0] || '')
            };

            const score = getTeamMatchScoreWithOverrides(
                fighterIdentifier,
                fighterObj,
                fighter.slug,
                league.shortName.toLowerCase()
            );

            if (score > bestScore) {
                bestScore = score;
                bestMatch = fighter;
            }
        }

        if (!bestMatch || bestScore === 0) {
            const fighterList = fighters.map(f => ({
                displayName: f.fullName,
                fullName: f.fullName,
                firstName: f.firstName,
                lastName: f.lastName
            })).sort((a, b) => a.displayName.localeCompare(b.displayName));

            throw new TeamNotFoundError(fighterIdentifier, league, fighterList);
        }

        const athleteData = {
            id: bestMatch.slug,
            slug: bestMatch.slug,
            city: bestMatch.firstName,
            name: bestMatch.lastName,
            fullName: bestMatch.fullName,
            abbreviation: (bestMatch.firstName?.[0] || '') + (bestMatch.lastName?.[0] || ''),
            conference: bestMatch.weightClass || null,
            division: bestMatch.weightClass || null,
            logo: bestMatch.imageUrl,
            logoAlt: bestMatch.imageUrl,
            color: '#1a1a2e',      // Oktagon brand dark navy
            alternateColor: '#e63329' // Oktagon brand red
        };

        return applyTeamOverrides(athleteData, league.shortName.toLowerCase(), bestMatch.slug);
    }

    async getLeagueLogoUrl(league, darkLogoPreferred = true) {
        // Check if a custom logo is set in leagues.json first
        if (darkLogoPreferred && league.logoUrlDark) return league.logoUrlDark;
        if (league.logoUrl) return league.logoUrl;

        // Fetch badge from TheSportsDB
        try {
            const url = `https://www.thesportsdb.com/api/v1/json/${this.THESPORTSDB_API_KEY}/lookupleague.php?id=${this.THESPORTSDB_LEAGUE_ID}`;
            const response = await axios.get(url, { timeout: this.REQUEST_TIMEOUT });
            const leagueData = response.data?.leagues?.[0];
            return leagueData?.strBadge || leagueData?.strLogo || null;
        } catch (error) {
            logger.warn('OktagonProvider: Failed to fetch league logo from TheSportsDB', { error: error.message });
            return null;
        }
    }

    clearCache() {
        fsCache.clearSubdir('oktagon');
    }

    // -------------------------------------------------------------------------
    // Fighter scraping
    // -------------------------------------------------------------------------

    /**
     * Fetch and parse the Oktagon fighters page.
     * The page at /en/fighters/ renders fighter cards with:
     *   - Fighter name in <h4> or similar heading
     *   - Fighter image in <img> inside the card
     *   - Optional weight class / record metadata
     *
     * Returns array of { fullName, firstName, lastName, slug, imageUrl, weightClass }
     */
    async fetchFighterData() {
        const cacheKey = 'fighters_all';
        const cached = fsCache.getJSON('oktagon', cacheKey, this.CACHE_DURATION);
        if (cached) {
            logger.debug('OktagonProvider: serving fighters from cache');
            return cached;
        }

        logger.info('OktagonProvider: fetching fighters from oktagonmma.com');

        try {
            const response = await axios.get(this.FIGHTERS_URL, {
                timeout: this.REQUEST_TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; game-thumbs/1.0)',
                    'Accept': 'text/html'
                }
            });

            const fighters = this.parseFightersHtml(response.data);

            if (fighters.length === 0) {
                throw new Error('Parsed 0 fighters — HTML structure may have changed');
            }

            logger.info(`OktagonProvider: cached ${fighters.length} fighters`);
            fsCache.setJSON('oktagon', cacheKey, fighters);
            return fighters;

        } catch (error) {
            logger.error('OktagonProvider: failed to fetch fighters page', { error: error.message });
            throw new Error(`Oktagon fighter fetch failed: ${error.message}`);
        }
    }

    /**
     * Parse the Oktagon fighters HTML page.
     *
     * The fighters page uses a card layout. Each fighter card contains:
     *   - An <img> with the fighter's photo
     *   - A heading/div with the fighter's name
     *
     * We use a lightweight regex/string approach to avoid adding a full HTML
     * parser dependency (cheerio is optional — add it to package.json if preferred).
     *
     * If you have cheerio available, uncomment the cheerio block and remove
     * the regex block for more robustness.
     */
    parseFightersHtml(html) {
        const fighters = [];

        // -----------------------------------------------------------------------
        // Strategy A: cheerio (recommended — more robust)
        // Install: yarn add cheerio
        // -----------------------------------------------------------------------
        try {
            const cheerio = require('cheerio');
            const $ = cheerio.load(html);

            // Fighter cards — adjust selector if the site updates its markup
            // Typical patterns on oktagonmma.com: .fighter-card, .fighter__item, article.fighter
            const cardSelectors = [
                '.fighter-card',
                '.fighter__item',
                'article.fighter',
                '[class*="fighter"]',
                '.card'
            ];

            let $cards = $();
            for (const sel of cardSelectors) {
                $cards = $(sel);
                if ($cards.length > 0) break;
            }

            if ($cards.length === 0) {
                logger.warn('OktagonProvider: no fighter cards found with known selectors, falling back to regex');
                return this.parseFightersHtmlRegex(html);
            }

            $cards.each((_, card) => {
                const $card = $(card);

                // Fighter name — try heading tags first, then generic
                const nameEl = $card.find('h1,h2,h3,h4,h5').first();
                const rawName = nameEl.text().trim() || $card.find('[class*="name"]').first().text().trim();
                if (!rawName) return;

                // Fighter image
                const imgEl = $card.find('img').first();
                let imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';
                if (imageUrl && !imageUrl.startsWith('http')) {
                    imageUrl = `https://oktagonmma.com${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
                }

                // Weight class (optional)
                const weightClass = $card.find('[class*="weight"],[class*="class"],[class*="division"]').first().text().trim() || null;

                const fighter = this.buildFighterObject(rawName, imageUrl, weightClass);
                if (fighter) fighters.push(fighter);
            });

            return fighters;

        } catch (requireError) {
            // cheerio not available — fall back to regex
            logger.warn('OktagonProvider: cheerio not available, using regex parser');
            return this.parseFightersHtmlRegex(html);
        }
    }

    /**
     * Regex-based fallback parser.
     * Extracts fighter names from heading tags and nearby img src attributes.
     */
    parseFightersHtmlRegex(html) {
        const fighters = [];

        // Match heading tags that likely contain fighter names (h3/h4 are common for card titles)
        const headingPattern = /<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi;
        // Match img src near a fighter name
        const imgPattern = /<img[^>]+src=["']([^"']+)["'][^>]*>/i;

        let match;
        while ((match = headingPattern.exec(html)) !== null) {
            const rawName = match[1].replace(/<[^>]+>/g, '').trim();

            // Skip likely non-name headings (too long, contains digits that look like years, etc.)
            if (!rawName || rawName.length > 50 || rawName.length < 3) continue;
            if (/^\d/.test(rawName)) continue; // starts with digit

            // Look for an img tag in the 800 chars before/after this heading
            const searchWindow = html.substring(
                Math.max(0, match.index - 800),
                Math.min(html.length, match.index + 800)
            );
            const imgMatch = imgPattern.exec(searchWindow);
            let imageUrl = imgMatch ? imgMatch[1] : '';

            if (imageUrl && !imageUrl.startsWith('http')) {
                imageUrl = `https://oktagonmma.com${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
            }

            const fighter = this.buildFighterObject(rawName, imageUrl, null);
            if (fighter) fighters.push(fighter);
        }

        return fighters;
    }

    /**
     * Build a normalized fighter object from raw scraped data.
     */
    buildFighterObject(rawName, imageUrl, weightClass) {
        // Clean HTML entities
        const name = rawName
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!name) return null;

        const parts = name.split(' ');
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';

        // Generate a URL-friendly slug (e.g., "Patrik Kincl" → "patrik-kincl")
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        return {
            fullName: name,
            firstName,
            lastName,
            slug,
            imageUrl: imageUrl || null,
            weightClass: weightClass || null
        };
    }
}

module.exports = OktagonProvider;
