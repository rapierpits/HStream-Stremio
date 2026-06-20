const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');

let puppeteer;
let chromium;

// Verifichiamo se siamo su Render
const isRender = process.env.RENDER || process.env.RENDER_EXTERNAL_HOSTNAME;

if (isRender) {
    chromium = require('@sparticuz/chromium');
    puppeteer = require('puppeteer-core');
} else {
    puppeteer = require('puppeteer-core');
}

const app = express();
const port = process.env.PORT || 7000;

// Get server URL based on environment. Used to build absolute subtitle URLs,
// so it must resolve to an address Stremio can actually reach.
function getServerURL() {
    if (process.env.RENDER) {
        return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
    }
    if (process.env.ADDON_PUBLIC_URL) {
        return process.env.ADDON_PUBLIC_URL.replace(/\/+$/, '');
    }
    try {
        const os = require('os');
        const ifaces = os.networkInterfaces();
        let candidate = null;
        for (const name of Object.keys(ifaces)) {
            for (const i of ifaces[name]) {
                if (i.family !== 'IPv4' || i.internal) continue;
                if (i.address.startsWith('169.254.')) continue;        // link-local
                if (i.address.startsWith('192.168.56.')) continue;     // common virtual adapter
                if (!candidate) candidate = i.address;                  // first real LAN IP wins
            }
        }
        if (candidate) return `http://${candidate}:${port}`;
    } catch (e) {
        debug('Could not determine LAN IP:', e.message);
    }
    return `http://localhost:${port}`;
}

// Configurazione aggiornata
const manifest = {
    id: 'org.hstreammoe',
    version: '1.4.1',
    name: 'HStream',
    description: 'Watch videos from hstream.moe with per-episode quality selection (up to 4K) and subtitles',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    idPrefixes: ['hstream:'],
    catalogs: [
        {
            type: 'movie',
            id: 'hstream-popular',
            name: 'HStream - Most Viewed',
            extra: [
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ],
            pageSize: 100
        },
        {
            type: 'movie',
            id: 'hstream-recent',
            name: 'HStream - Recently Released',
            extra: [
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ],
            pageSize: 100
        }
    ],
    logo: 'https://hstream.moe/images/cropped-HS-1-270x270.webp',
    background: 'https://i.imgur.com/cQc3rO1.png'
};

const builder = new addonBuilder(manifest);
const DEBUG = true;

// Utility function for delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function debug(...args) {
    if (DEBUG) console.log(...args);
}

class Cache {
    constructor(ttl = 3600000) {
        this.data = new Map();
        this.ttl = ttl;
    }
    get(key) {
        if (!this.data.has(key)) return null;
        const item = this.data.get(key);
        if (Date.now() > item.expires) {
            this.data.delete(key);
            return null;
        }
        return item.value;
    }
    set(key, value, customTtl = null) {
        const expires = Date.now() + (customTtl || this.ttl);
        this.data.set(key, { value, expires });
    }
    clear() {
        this.data.clear();
    }
}

const catalogCache = new Cache(3 * 60 * 60 * 1000);
const metaCache = new Cache(6 * 60 * 60 * 1000);
const streamCache = new Cache(1 * 60 * 60 * 1000);

const SITE_PAGE_SIZE = 25;   // hstream.moe returns 25 items per search page
const STREMIO_PAGE = 100;    // how many items we hand back to Stremio per request (matches manifest pageSize)
const MAX_SITE_PAGES = 200;  // safety ceiling (~5000 items)

// On memory-constrained hosts (Render free = 512MB) keeping Chrome resident and
// running many parallel tabs causes OOM kills. There we launch/close the browser
// per operation (like the original code) and scrape fewer pages at once.
const LOW_MEMORY = isRender || process.env.LOW_MEMORY === '1';
const PERSISTENT_BROWSER = !LOW_MEMORY;
const CONCURRENT_PAGES = 5;  // site pages fetched in parallel per batch (matches the original, Render-proven profile)

// Cache for converted subtitles (key = .ass url -> srt text)
const subsCache = new Cache(12 * 60 * 60 * 1000);

// Map hstream language names -> ISO 639-2 codes used by Stremio
const LANG_MAP = {
    'English': 'eng', 'German': 'ger', 'Spanish': 'spa', 'French': 'fre',
    'Hindi': 'hin', 'Portuguese': 'por', 'Russian': 'rus', 'Italian': 'ita',
    'Japanese': 'jpn', 'Chinese': 'chi', 'Arabic': 'ara'
};

// hstream encodes quality in the <source size="..."> attribute.
// The "i" variants (1081/2161) are the 48fps interpolated versions.
const QUALITY_INFO = {
    '2161': { label: '2160p (4K) 48FPS', rank: 6 },
    '2160': { label: '2160p (4K)',       rank: 5 },
    '1081': { label: '1080p 48FPS',      rank: 4 },
    '1080': { label: '1080p',            rank: 3 },
    '720':  { label: '720p',             rank: 2 },
    '480':  { label: '480p',             rank: 1 },
    '360':  { label: '360p',             rank: 0 }
};

function qualityInfo(size) {
    return QUALITY_INFO[String(size)] || { label: size ? `${size}p` : 'Unknown', rank: -1 };
}

// Minimal HTTP(S) GET that returns the body as a string (follows one level of redirect).
function httpGet(url, redirects = 3) {
    return new Promise((resolve, reject) => {
        let lib;
        try {
            lib = url.startsWith('https') ? require('https') : require('http');
        } catch (e) {
            return reject(e);
        }
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://hstream.moe/'
            }
        }, res => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(httpGet(res.headers.location, redirects - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Subtitle request timeout')));
    });
}

// Convert an ASS timestamp (H:MM:SS.cs, centiseconds) to milliseconds.
function assTimeToMs(t) {
    const m = String(t).trim().match(/(\d+):(\d{2}):(\d{2})[.:](\d{1,3})/);
    if (!m) return null;
    const [, h, mm, ss, frac] = m;
    const cs = frac.length === 2 ? parseInt(frac, 10) * 10 : parseInt(frac.padEnd(3, '0').slice(0, 3), 10);
    return ((parseInt(h, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10)) * 1000) + cs;
}

function msToSrtTime(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(h)}:${p(m)}:${p(s)},${p(millis, 3)}`;
}

// Strip ASS override tags / drawing commands and normalise line breaks.
function stripAssText(text) {
    return text
        .replace(/\{[^}]*\}/g, '')   // {\override} blocks
        .replace(/\\[Nn]/g, '\n')     // hard / soft line breaks
        .replace(/\\h/g, ' ')          // hard space
        .replace(/[ \t]+/g, ' ')
        .trim();
}

// Convert a full ASS subtitle file into SRT text that Stremio can render.
function assToSrt(ass) {
    const lines = ass.split(/\r?\n/);
    let inEvents = false;
    let format = null;
    const events = [];

    for (const raw of lines) {
        const line = raw.trim();
        if (/^\[Events\]/i.test(line)) { inEvents = true; continue; }
        if (/^\[.+\]$/.test(line)) { inEvents = false; continue; }
        if (!inEvents) continue;

        if (/^Format\s*:/i.test(line)) {
            format = line.replace(/^Format\s*:/i, '').split(',').map(s => s.trim().toLowerCase());
            continue;
        }
        if (/^Dialogue\s*:/i.test(line) && format) {
            const rest = line.replace(/^Dialogue\s*:/i, '');
            const parts = rest.split(',');
            const textIdx = format.indexOf('text');
            const startIdx = format.indexOf('start');
            const endIdx = format.indexOf('end');
            if (textIdx === -1 || startIdx === -1 || endIdx === -1) continue;
            // Text is the last field and may contain commas, so re-join the tail.
            const text = parts.slice(textIdx).join(',');
            events.push({
                start: assTimeToMs(parts[startIdx]),
                end: assTimeToMs(parts[endIdx]),
                text: stripAssText(text)
            });
        }
    }

    events.sort((a, b) => (a.start || 0) - (b.start || 0));

    let out = '';
    let n = 1;
    for (const e of events) {
        if (e.start === null || e.end === null || !e.text) continue;
        out += `${n++}\n${msToSrtTime(e.start)} --> ${msToSrtTime(e.end)}\n${e.text}\n\n`;
    }
    return out;
}

async function launchBrowser() {
    let options = {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080',
            '--headless=new'
        ]
    };

    if (isRender) {
        debug('Running on Render, using @sparticuz/chromium');
        try {
            options = {
                ...options,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
                ignoreHTTPSErrors: true
            };
        } catch (error) {
            console.error('Error configuring chromium on Render:', error);
            throw error;
        }
    } else {
        // Array di possibili percorsi di Chrome su Windows
        const windowsChromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        ];

        // Cerca il primo percorso valido
        let chromePath = null;
        for (const path of windowsChromePaths) {
            try {
                if (require('fs').existsSync(path)) {
                    chromePath = path;
                    break;
                }
            } catch (e) {
                continue;
            }
        }

        if (!chromePath) {
            throw new Error('Chrome non trovato. Assicurati che Chrome sia installato nel tuo sistema.');
        }

        options.executablePath = chromePath;
    }

    try {
        debug('Launching browser with options:', JSON.stringify(options, null, 2));
        const browser = await puppeteer.launch(options);
        debug('Browser launched successfully');
        return browser;
    } catch (error) {
        console.error('Error launching browser:', error);
        throw error;
    }
}

// Browser lifecycle. In persistent mode (local) we keep one Chrome warm and reuse
// it across requests for speed. In low-memory mode (Render) we launch a fresh
// browser per operation and close it afterwards to stay within the RAM budget.
let sharedBrowser = null;
let browserLaunching = null;
async function getBrowser() {
    if (!PERSISTENT_BROWSER) {
        // Caller is responsible for closing this via closeBrowser().
        return launchBrowser();
    }
    if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
    if (browserLaunching) return browserLaunching;
    browserLaunching = launchBrowser().then(b => {
        sharedBrowser = b;
        b.on('disconnected', () => { sharedBrowser = null; });
        browserLaunching = null;
        return b;
    }).catch(err => {
        browserLaunching = null;
        throw err;
    });
    return browserLaunching;
}

// Only closes the browser in low-memory mode; in persistent mode it's kept warm.
async function closeBrowser(browser) {
    if (!PERSISTENT_BROWSER && browser) {
        await browser.close().catch(() => {});
    }
}

async function fetchCatalog(skip = 0, search = '', catalogType = 'popular') {
    debug(`fetchCatalog: skip=${skip}, catalogType=${catalogType}, search="${search}"`);

    // Global cache of all items scraped so far for this catalog/search.
    const globalCacheKey = search ? `search-${search}-all` : `catalog-${catalogType}-all`;
    const cached = catalogCache.get(globalCacheKey) || { items: [], pagesLoaded: 0, exhausted: false };
    let { items, pagesLoaded, exhausted } = cached;

    const seen = new Set(items.map(i => i.id));
    const target = skip + STREMIO_PAGE; // how many items we need to satisfy this request

    // Each hstream search page yields SITE_PAGE_SIZE (25) items. Keep loading
    // batches of consecutive site pages until we have enough, run out, or hit the ceiling.
    while (items.length < target && !exhausted && pagesLoaded < MAX_SITE_PAGES) {
        const pagesToLoad = [];
        for (let i = 1; i <= CONCURRENT_PAGES && pagesLoaded + i <= MAX_SITE_PAGES; i++) {
            pagesToLoad.push(pagesLoaded + i);
        }
        if (pagesToLoad.length === 0) break;

        debug(`Loading site pages ${pagesToLoad.join(', ')} (have ${items.length}, need ${target})`);

        let browser;
        try {
            browser = await getBrowser();
            const pages = await Promise.all(pagesToLoad.map(p => fetchPage(browser, p, search, catalogType)));

            let newCount = 0;
            let emptyPages = 0;
            for (const pageItems of pages) {
                if (!pageItems || pageItems.length === 0) { emptyPages++; continue; }
                for (const it of pageItems) {
                    if (it && it.id && !seen.has(it.id)) {
                        seen.add(it.id);
                        items.push(it);
                        newCount++;
                    }
                }
            }
            pagesLoaded += pagesToLoad.length;

            // If a whole batch produced nothing, we've reached the end of the listing.
            if (newCount === 0 || emptyPages === pagesToLoad.length) {
                exhausted = true;
            }

            catalogCache.set(globalCacheKey, { items, pagesLoaded, exhausted });
            debug(`Now have ${items.length} unique items (pagesLoaded=${pagesLoaded}, exhausted=${exhausted})`);
        } catch (error) {
            console.error(`Error fetching site pages ${pagesToLoad.join(', ')}:`, error.message);
            break;
        } finally {
            await closeBrowser(browser);
        }
    }

    const slice = items.slice(skip, skip + STREMIO_PAGE);
    debug(`Returning ${slice.length} items (skip=${skip}, total cached=${items.length})`);
    return slice;
}

async function fetchPage(browser, pageNum, search = '', catalogType = 'popular') {
    const page = await browser.newPage();
    
    try {
        // Set longer timeouts
        await page.setDefaultNavigationTimeout(60000);
        await page.setDefaultTimeout(60000);
        
        // Set up request interception to block unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

        const baseUrl = search ? 
            `https://hstream.moe/search?q=${encodeURIComponent(search)}&page=${pageNum}&view=poster` : 
            `https://hstream.moe/search?view=poster&order=${catalogType === 'recent' ? 'recently-released' : 'view-count'}&page=${pageNum}`;

        debug(`Fetching catalog from: ${baseUrl}`);
        
        // Try to load the page with retries
        let retries = 3;
        let response;
        while (retries > 0) {
            try {
                response = await page.goto(baseUrl, { 
                    waitUntil: 'domcontentloaded',
                    timeout: 60000 
                });
                if (response.status() === 200) break;
                retries--;
                if (retries > 0) await delay(2000); // Wait 2 seconds before retry
            } catch (error) {
                debug(`Error loading page ${pageNum}, retries left: ${retries-1}:`, error.message);
                retries--;
                if (retries === 0) throw error;
                await delay(2000);
            }
        }

        if (!response || response.status() !== 200) {
            debug(`Page ${pageNum} returned status ${response?.status() || 'unknown'}`);
            return [];
        }

        // Wait for the actual episode links (present in the server-rendered HTML);
        // lighter and faster than waiting for the grid container to become "visible".
        try {
            await page.waitForSelector('a[href*="/hentai/"]', { timeout: 20000 });
        } catch (error) {
            debug(`Timeout waiting for episode links on page ${pageNum}, trying to continue anyway`);
        }

        // Extract items even if some elements are not fully loaded
        const pageItems = await page.evaluate((catalogType) => {
            const results = [];
            const containers = [
                ...document.querySelectorAll('div[wire\\:key^="episode-"]'),
                ...document.querySelectorAll('div.grid > div'),
                ...document.querySelectorAll('div.grid > a'),
                ...document.querySelectorAll('div[role="grid"] > div'),
                ...document.querySelectorAll('div.grid div[role="gridcell"]'),
                ...document.querySelectorAll('div.relative.p-1.mb-8.w-full'),
                ...document.querySelectorAll('div.grid div.relative')
            ];
            
            containers.forEach((item, index) => {
                try {
                    const link = item.tagName === 'A' ? item : item.querySelector('a');
                    if (!link || !link.href) return;
                    
                    const href = link.href;
                    if (!href.includes('/hentai/')) return;
                    
                    const episodeMatch = href.match(/-(\d+)$/);
                    const episodeNumber = episodeMatch ? episodeMatch[1] : null;
                    
                    const urlParts = href.split('/hentai/');
                    if (urlParts.length < 2) return;
                    
                    const rawId = urlParts[1];
                    const baseId = rawId.replace(/\/?(?:-watch)?(?:-online)?(?:-free)?(?:-streaming)?(?:-sub)?(?:-eng)?(?:-ita)?(?:-\d+)?$/, '');
                    const id = episodeNumber ? `${baseId}-${episodeNumber}` : baseId;
                    if (!id) return;
                    
                    // Include catalog type in the ID
                    const fullId = `hstream:${catalogType}:${id}`;
                    
                    const titleCandidates = [
                        link.querySelector('div.absolute p.text-sm'),
                        link.querySelector('p.text-sm'),
                        item.querySelector('div.absolute p.text-sm'),
                        item.querySelector('p.text-sm'),
                        link.querySelector('[title]'),
                        item.querySelector('[title]'),
                        link.querySelector('img[alt]'),
                        item.querySelector('img[alt]')
                    ];
                    
                    let title = 'Unknown Title';
                    for (const candidate of titleCandidates) {
                        if (candidate) {
                            const text = candidate.textContent?.trim() || 
                                       candidate.getAttribute('title')?.trim() ||
                                       candidate.getAttribute('alt')?.trim();
                            if (text) {
                                title = text;
                                break;
                            }
                        }
                    }
                    
                    // Append the episode number only if the title doesn't already end with it.
                    if (episodeMatch && !new RegExp(`-\\s*${episodeMatch[1]}\\s*$`).test(title)) {
                        title = `${title} - ${episodeMatch[1]}`;
                    }

                    const imgCandidates = [
                        link.querySelector('img'),
                        item.querySelector('img')
                    ];

                    let poster = '';
                    for (const img of imgCandidates) {
                        if (img) {
                            poster = img.src || img.getAttribute('data-src') || '';
                            if (poster) break;
                        }
                    }

                    if (poster && !poster.startsWith('http')) {
                        poster = `https://hstream.moe${poster}`;
                    }

                    // Card badges: either the quality (e.g. "4k | FHD 48fps") and/or
                    // content tags (e.g. "Scat + Horror"), depending on the title.
                    const badgeEls = [...link.querySelectorAll('div.rounded-full, span.rounded-full')];
                    const badges = [...new Set(
                        badgeEls.map(b => b.textContent.replace(/\s+/g, ' ').trim())
                                .filter(t => t && t.length <= 50 && !/^\d+$/.test(t))
                    )];
                    const qualityBadge = badges.join(' | ');
                    // View count next to the eye icon.
                    const eye = link.querySelector('i.fa-eye') || item.querySelector('i.fa-eye');
                    const views = eye?.parentElement?.textContent.trim() || '';

                    results.push({
                        id: fullId,
                        type: 'movie',
                        name: title,
                        poster: poster,
                        posterShape: 'poster',
                        link: href,
                        episodeNumber: episodeNumber,
                        quality: qualityBadge,
                        views: views
                    });
                } catch (err) {
                    console.error(`Error processing item ${index}:`, err);
                }
            });
            return results;
        }, catalogType);

        return pageItems;
    } catch (error) {
        console.error(`Error processing page ${pageNum}:`, error);
        return [];
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

async function fetchVideoDetails(url) {
    // Correzione URL duplicato
    if (url.includes('hstream.moehttps://')) {
        url = url.replace('hstream.moehttps://', 'https://');
    }

    const cacheKey = `details-${url}`;
    const cached = streamCache.get(cacheKey);
    if (cached) return cached;

    let page;
    let browser;
    try {
        browser = await getBrowser();
        page = await browser.newPage();

        // Block heavy resources for speed; we only need the rendered DOM.
        // The <source>/<a .ass> elements are server-rendered, so blocking
        // images/css/fonts/the actual video does not remove them.
        await page.setRequestInterception(true);
        page.on('request', request => {
            const t = request.resourceType();
            if (t === 'image' || t === 'stylesheet' || t === 'font' || t === 'media') {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        debug(`Fetching video details from: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // The quality <source> tags are injected by the player JS shortly after load,
        // so wait for an actual <source src> rather than the (initially empty) <video>.
        try {
            await page.waitForSelector('video source[src]', { timeout: 30000 });
        } catch (e) {
            debug('No <source> appeared in time, extracting whatever is present');
            await delay(2000);
        }

        // Extract every quality <source>, every subtitle (.ass/.srt/.vtt) link, and meta.
        const data = await page.evaluate(() => {
            // --- video sources (one per quality) ---
            const sources = [];
            const seen = new Set();
            document.querySelectorAll('video source[src]').forEach(source => {
                const src = source.getAttribute('src');
                if (!src || !/^https?:/i.test(src) || seen.has(src)) return;
                seen.add(src);
                sources.push({
                    url: src,
                    size: source.getAttribute('size') || source.getAttribute('label') || source.getAttribute('title') || '',
                    mode: source.getAttribute('mode') || ''
                });
            });

            // --- subtitles: direct download links (.ass / .srt / .vtt) ---
            const subtitles = [];
            const subSeen = new Set();
            document.querySelectorAll('a[href*=".ass"], a[href*=".srt"], a[href*=".vtt"]').forEach(a => {
                const href = a.getAttribute('href');
                if (!href || subSeen.has(href)) return;
                subSeen.add(href);
                // Language: prefer visible text, fall back to the download filename.
                const text = (a.textContent || '').trim();
                const dl = a.getAttribute('download') || '';
                const langName = (text.match(/[A-Za-z]+/) || dl.match(/-([A-Za-z]+)\.(?:ass|srt|vtt)$/i) || [])[0] ||
                                 (dl.match(/-([A-Za-z]+)\.(?:ass|srt|vtt)$/i) || [])[1] || 'English';
                const isAuto = text.toLowerCase().includes('auto');
                const format = (href.split('.').pop() || '').toLowerCase().split(/[?#]/)[0];
                subtitles.push({ url: href, langName: langName.trim(), isAuto, format });
            });

            // --- meta ---
            const title = document.querySelector('h1')?.textContent.trim() ||
                          document.title.replace(' - HStream', '').replace(/in 4k.*$/, '').trim();
            const japaneseTitle = document.querySelector('h2.inline')?.textContent.trim();
            const description = document.querySelector('meta[name="description"]')?.content ||
                                document.querySelector('meta[property="og:description"]')?.content ||
                                document.querySelector('.text-gray-800.dark\\:text-gray-200.leading-tight')?.textContent.trim() ||
                                '';
            const releaseInfo = document.querySelector('a[data-te-toggle="tooltip"][title*="Released"]')?.textContent
                                .match(/\d{4}-\d{2}-\d{2}/)?.[0];
            const studio = document.querySelector('a[href*="studios"], a[href*="studio"], a[href*="brand"]')?.textContent.trim();
            // Genres/tags links look like ?tags[0]=big-boobs . Drop the pure quality
            // tags (4k / 48fps) since quality is already a separate stream choice.
            const genres = [...new Set(
                Array.from(document.querySelectorAll('a[href*="tags%5B"], a[href*="tags["]'))
                    .map(tag => tag.textContent.replace(/\s+/g, ' ').trim())
                    .filter(Boolean)
                    .filter(t => !/^(4k|48fps|4k\s*48fps)$/i.test(t))
            )];
            const viewCount = document.querySelector('a.text-xl i.fa-eye')?.nextSibling?.textContent.trim();
            const episodeNumber = title.match(/\s*-\s*(\d+)$/)?.[1];

            return { sources, subtitles, title, japaneseTitle, description, releaseInfo, studio, genres, viewCount, episodeNumber };
        });

        await page.close().catch(() => {});
        page = null;

        // Build Stremio subtitle objects, routed through our own SRT-conversion endpoint
        // (hstream serves .ass, which Stremio cannot render).
        const serverUrl = getServerURL();
        const subtitles = data.subtitles.map(sub => {
            let absUrl = sub.url;
            if (!/^https?:/i.test(absUrl)) {
                absUrl = absUrl.startsWith('//') ? `https:${absUrl}` : `https://hstream.moe${absUrl.startsWith('/') ? '' : '/'}${absUrl}`;
            }
            const langCode = LANG_MAP[sub.langName] || 'eng';
            const enc = Buffer.from(absUrl).toString('base64url');
            return {
                id: `${langCode}${sub.isAuto ? '-auto' : ''}`,
                url: `${serverUrl}/subs/${enc}.srt`,
                lang: langCode
            };
        });

        // Build one Stremio stream per quality, best first.
        const streams = data.sources
            .map(s => ({ ...s, info: qualityInfo(s.size) }))
            .sort((a, b) => b.info.rank - a.info.rank)
            .map(s => {
                const stream = {
                    name: `HStream\n${s.info.label}`,
                    title: data.title + (subtitles.length ? `\n🗨 ${subtitles.length} sub` : ''),
                    url: s.url,
                    behaviorHints: { bingeGroup: `hstream-${s.size || 'default'}` }
                };
                if (subtitles.length) stream.subtitles = subtitles;
                return stream;
            });

        debug(`Found ${streams.length} quality streams with ${subtitles.length} subtitle tracks for "${data.title}"`);

        const result = {
            title: data.title,
            japaneseTitle: data.japaneseTitle,
            description: data.description,
            releaseInfo: data.releaseInfo,
            studio: data.studio,
            genres: data.genres,
            viewCount: data.viewCount,
            episodeNumber: data.episodeNumber,
            subtitles,
            streams
        };

        streamCache.set(cacheKey, result);
        return result;
    } catch (error) {
        console.error('Video details error:', error);
        if (page) await page.close().catch(() => {});
        return { title: 'Unknown', streams: [], subtitles: [] };
    } finally {
        await closeBrowser(browser);
    }
}

// Find a catalog item by id, progressively loading more pages if needed.
// Reuses fetchCatalog so pagination/caching/the shared browser all behave consistently.
async function findItemById(id, catalogType) {
    const cacheKey = `catalog-${catalogType}-all`;
    const getItems = () => (catalogCache.get(cacheKey)?.items) || [];

    let item = getItems().find(i => i.id === id);
    if (item) return item;

    debug(`Item ${id} not cached, loading more pages to find it`);
    let lastCount = -1;
    while (!item) {
        const skip = getItems().length;
        if (skip === lastCount) break; // no progress -> avoid infinite loop
        lastCount = skip;
        await fetchCatalog(skip, '', catalogType);
        const items = getItems();
        item = items.find(i => i.id === id);
        const cached = catalogCache.get(cacheKey);
        if (item || !cached || cached.exhausted) break;
    }
    return item || null;
}

// Handlers
builder.defineCatalogHandler(async ({ type, id, extra }) => {
    debug('Catalog request with extra:', extra);
    let skip = 0;
    let search = '';

    try {
        if (typeof extra === 'string') {
            const params = new URLSearchParams(extra);
            skip = parseInt(params.get('skip')) || 0;
            search = params.get('search') || '';
        } else if (extra && typeof extra === 'object') {
            skip = parseInt(extra.skip) || 0;
            search = extra.search || '';
        }
    } catch (err) {
        console.error('Error parsing extra params:', err);
    }

    const catalogType = id === 'hstream-recent' ? 'recent' : 'popular';
    debug(`Processing catalog request: skip=${skip}, search="${search}", type=${catalogType}`);
    const catalog = await fetchCatalog(skip, search, catalogType);

    const metas = catalog.map(item => {
        // Build a short preview description from what the listing card exposes
        // (real genres only exist on the detail page, which the meta handler fills in).
        const descParts = [];
        if (item.quality) descParts.push(item.quality);
        if (item.views) descParts.push(`👁 ${item.views}`);
        const meta = {
            id: item.id,
            type: 'movie',
            name: item.name,
            poster: item.poster,
            posterShape: 'poster'
        };
        if (descParts.length) meta.description = descParts.join('  •  ');
        return meta;
    });

    debug(`Returning ${metas.length} items for skip=${skip}`);
    return { metas };
});

builder.defineMetaHandler(async ({ id }) => {
    debug('Meta request for id:', id);
    
    // Extract catalog type from ID
    const [prefix, catalogType, ...rest] = id.split(':');
    const itemId = rest.join(':'); // In case the original ID contained colons
    debug(`Processing meta request for ${catalogType} catalog, item ID: ${itemId}`);

    const item = await findItemById(id, catalogType);

    if (!item) {
        debug(`Item ${id} not found in catalog`);
        return { meta: null };
    }

    debug(`Found item: ${item.name}`);
    const details = await fetchVideoDetails(item.link);
    
    return {
        meta: {
            id: item.id,
            type: 'movie',
            name: details.title || item.name,
            poster: item.poster,
            background: item.poster,
            description: details.description,
            releaseInfo: details.releaseInfo,
            genres: details.genres,
            posterShape: 'poster',
            runtime: 'Episode ' + details.episodeNumber,
            language: 'jpn',
            country: 'ja',
            awards: details.viewCount ? `${details.viewCount} views` : undefined,
            director: details.studio,
            imdbRating: '18+',
            originalTitle: details.japaneseTitle
        }
    };
});

builder.defineStreamHandler(async ({ id }) => {
    debug('Stream request for id:', id);
    
    // Extract catalog type from ID
    const [prefix, catalogType, ...rest] = id.split(':');
    const itemId = rest.join(':'); // In case the original ID contained colons
    debug(`Processing stream request for ${catalogType} catalog, item ID: ${itemId}`);

    const item = await findItemById(id, catalogType);

    if (!item) {
        debug(`Item ${id} not found in catalog`);
        return { streams: [] };
    }

    debug(`Found item: ${item.name}, fetching video details from ${item.link}`);
    const details = await fetchVideoDetails(item.link);

    // Streams already come fully formed (one per quality, subtitles attached).
    if (!details.streams || details.streams.length === 0) {
        debug('No streams found, adding external URL');
        return { streams: [{ name: 'HStream', title: 'Open in Browser', externalUrl: item.link }] };
    }

    debug(`Returning ${details.streams.length} quality streams with ${details.subtitles?.length || 0} subtitle tracks`);
    return { streams: details.streams };
});

// Server setup
const addonInterface = builder.getInterface();
app.use(cors());
app.get('/', (_, res) => {
    res.redirect('/manifest.json');
});
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));

// Subtitle conversion endpoint: fetches the original .ass from hstream's CDN
// and returns SRT that Stremio can render. The .ass URL is base64url-encoded
// into the path so the URL ends in .srt (Stremio is picky about extensions).
app.get('/subs/:enc.srt', async (req, res) => {
    try {
        const assUrl = Buffer.from(req.params.enc, 'base64url').toString('utf8');
        if (!/^https?:\/\//i.test(assUrl)) return res.status(400).send('Invalid url');

        let srt = subsCache.get(assUrl);
        if (!srt) {
            const raw = await httpGet(assUrl);
            // Already SRT/VTT? convert VTT->SRT lightly, pass SRT through, else parse ASS.
            if (/^\s*WEBVTT/i.test(raw)) {
                srt = raw.replace(/^\s*WEBVTT.*?\r?\n/i, '').replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2');
            } else if (/-->/.test(raw) && !/^\[Script Info\]/i.test(raw.trim())) {
                srt = raw;
            } else {
                srt = assToSrt(raw);
            }
            if (srt && srt.trim()) subsCache.set(assUrl, srt);
        }

        res.set('Content-Type', 'application/x-subrip; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        res.send(srt || '');
    } catch (err) {
        console.error('Subtitle conversion error:', err.message);
        res.status(502).send('');
    }
});

app.get('/:resource/:type/:id.json', async (req, res) => {
    const { resource, type, id } = req.params;
    const result = await addonInterface.get(resource, type, id, null);
    res.json(result);
});
app.get('/:resource/:type/:id/:extra.json', async (req, res) => {
    const { resource, type, id, extra } = req.params;
    let extraObj = null;
    
    try {
        if (extra && extra !== 'undefined') {
            try {
                extraObj = JSON.parse(decodeURIComponent(extra));
            } catch (e) {
                const params = new URLSearchParams(extra);
                extraObj = {};
                for (const [key, value] of params) {
                    if (key === 'skip') {
                        extraObj[key] = parseInt(value);
                    } else {
                        extraObj[key] = value;
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error parsing extra:', err);
    }
    
    debug('Request params:', { resource, type, id, extra: extraObj });
    const result = await addonInterface.get(resource, type, id, extraObj);
    res.json(result);
});

const serverUrl = getServerURL();
app.listen(port, '0.0.0.0', () => {
    console.log(`Addon running on ${serverUrl}`);
    if (!process.env.RENDER) {
        console.log(`Local URL: http://127.0.0.1:${port}`);
    }
    console.log(`Install URL: ${serverUrl}/manifest.json`);
    // Warm up Chrome in the background so the first catalog request is faster.
    // Skip on low-memory hosts (Render) where we launch/close per request instead.
    if (PERSISTENT_BROWSER) {
        getBrowser().then(() => debug('Browser pre-warmed')).catch(() => {});
    }
});