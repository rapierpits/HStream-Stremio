const { addonBuilder } = require('stremio-addon-sdk');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const cors = require('cors');
const ip = require('ip');

puppeteer.use(StealthPlugin());
const app = express();
const port = process.env.PORT || 7000;

// Get server URL based on environment
function getServerURL() {
    if (process.env.RENDER) {
        // On Render.com
        return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
    }
    // Locally
    try {
        const ip = require('ip');
        return `http://${ip.address()}:${port}`;
    } catch (e) {
        return `http://localhost:${port}`;
    }
}

// Configurazione aggiornata
const manifest = {
    id: 'org.hstreammoe',
    version: '1.2.0',
    name: 'HStream',
    description: 'Watch videos from hstream.moe with quality selection',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    idPrefixes: ['hstream:'],
    catalogs: [
        {
            type: 'movie',
            id: 'hstream-popular',
            name: 'Most Viewed',
            extra: [
                { name: 'skip', isRequired: false },
                { name: 'search', isRequired: false }
            ],
            pageSize: 500
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

const ITEMS_PER_PAGE = 500;  // Aumentato da 100 a 500
const MAX_PAGES = 20;  // Questo ci darà un massimo di 10000 elementi
const CONCURRENT_PAGES = 5;  // Manteniamo 5 pagine in parallelo

async function launchBrowser() {
    const options = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920x1080'
        ]
    };

    if (process.env.RENDER) {
        // Su Render, usa Chrome installato nel sistema
        const chromium = require('chrome-aws-lambda');
        options.executablePath = await chromium.executablePath;
    }

    return await puppeteer.launch(options);
}

async function fetchCatalog(skip = 0, search = '') {
    debug(`Calculating pagination: skip=${skip}, pageNum=${Math.floor(skip / ITEMS_PER_PAGE) + 1}`);
    
    // Manteniamo una cache globale di tutti gli elementi
    const globalCacheKey = search ? `search-${search}-all` : 'catalog-all';
    let allItems = catalogCache.get(globalCacheKey) || [];
    
    // Se non abbiamo abbastanza elementi nella cache per questo skip, dobbiamo caricare più pagine
    while (allItems.length < skip + ITEMS_PER_PAGE && allItems.length < MAX_PAGES * ITEMS_PER_PAGE) {
        const nextPage = Math.floor(allItems.length / ITEMS_PER_PAGE) + 1;
        const pagesToLoad = [];
        
        // Prepara il batch di pagine da caricare
        for (let i = 0; i < CONCURRENT_PAGES && nextPage + i <= MAX_PAGES; i++) {
            pagesToLoad.push(nextPage + i);
        }
        
        if (pagesToLoad.length === 0) break;
        
        debug(`Need more items. Loading pages ${pagesToLoad.join(', ')}`);

        let browser;
        try {
            browser = await launchBrowser();

            // Fetch multiple pages in parallel
            const pagePromises = pagesToLoad.map(pageNum => fetchPage(browser, pageNum, search));
            const pages = await Promise.all(pagePromises);

            const pageItems = pages.flat().filter(Boolean);

            if (pageItems.length === 0) {
                debug(`No items found on pages ${pagesToLoad.join(', ')}, stopping pagination`);
                break;
            }

            debug(`Found ${pageItems.length} items on pages ${pagesToLoad.join(', ')}`);
            debug(`Total items in cache: ${allItems.length + pageItems.length}`);
            
            // Aggiungiamo i nuovi elementi alla cache globale
            allItems = [...allItems, ...pageItems];
            catalogCache.set(globalCacheKey, allItems);

        } catch (error) {
            console.error(`Error fetching pages ${pagesToLoad.join(', ')}:`, error);
            break;
        } finally {
            if (browser) await browser.close();
        }
    }

    // Restituiamo la porzione richiesta degli elementi
    const start = skip;
    const end = Math.min(skip + ITEMS_PER_PAGE, allItems.length);
    debug(`Returning items from ${start} to ${end} (total items: ${allItems.length})`);
    return allItems.slice(start, end);
}

async function fetchPage(browser, pageNum, search = '') {
        const page = await browser.newPage();

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setJavaScriptEnabled(true);

        const baseUrl = search ? 
            `https://hstream.moe/search?q=${encodeURIComponent(search)}&page=${pageNum}&view=poster` : 
            `https://hstream.moe/search?view=poster&order=view-count&page=${pageNum}`;

        debug(`Fetching catalog from: ${baseUrl}`);
        const response = await page.goto(baseUrl, { 
            waitUntil: 'networkidle2', 
            timeout: 30000 
        });

        if (response.status() !== 200) {
            debug(`Page ${pageNum} returned status ${response.status()}`);
            return [];
        }

        await page.waitForSelector('div.grid', { timeout: 15000 });
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1000);

        return await page.evaluate(() => {
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
                    
                    // Extract episode number if present
                    const episodeMatch = href.match(/-(\d+)$/);
                    const episodeNumber = episodeMatch ? episodeMatch[1] : null;
                    
                    const urlParts = href.split('/hentai/');
                    if (urlParts.length < 2) return;
                    
                    const rawId = urlParts[1];
                    // Modify the ID to include episode number if present
                    const baseId = rawId.replace(/\/?(?:-watch)?(?:-online)?(?:-free)?(?:-streaming)?(?:-sub)?(?:-eng)?(?:-ita)?(?:-\d+)?$/, '');
                    const id = episodeNumber ? `${baseId}-${episodeNumber}` : baseId;
                    if (!id) return;
                    
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
                    
                    // Add episode number to title if present
                    if (episodeNumber) {
                        title = `${title} - ${episodeNumber}`;
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

                    results.push({
                        id: `hstream:${id}`,
                        type: 'movie',
                        name: title,
                        poster: poster,
                        posterShape: 'poster',
                        link: href,
                        episodeNumber: episodeNumber
                    });
                } catch (err) {
                    console.error(`Error processing item ${index}:`, err);
                }
            });
            return results;
        });
    } finally {
        await page.close();
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

    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        const streams = new Map(); // Using Map to prevent duplicates
        
        page.on('request', request => {
            const requestUrl = request.url();
            if (requestUrl.match(/\.(m3u8|mp4|mkv|avi|mov)(\?|$)/i)) {
                let quality = 'Unknown';
                if (requestUrl.includes('2160')) quality = '4k';
                else if (requestUrl.includes('1080')) quality = '1080p';
                else if (requestUrl.includes('720')) quality = '720p';
                else if (requestUrl.includes('480')) quality = '480p';
                else if (requestUrl.includes('360')) quality = '360p';
                
                // Use quality as key to prevent duplicates
                streams.set(quality, { url: requestUrl, quality });
                request.abort();
            } else {
                request.continue();
            }
        });

        debug(`Fetching video details from: ${url}`);
        await page.goto(url, { 
            waitUntil: 'networkidle2', 
            timeout: 60000 
        });

        // Wait for video player to load
        await page.waitForSelector('video', { timeout: 30000 });

        // Get video sources and subtitles from the page
        const videoData = await page.evaluate(() => {
            const sources = new Map();
            const subtitles = new Map();
            
            console.log('Searching for subtitle download links...');
            // Extract subtitles from download links first (higher priority)
            const subtitleButtons = document.querySelectorAll('button.group.rounded-md.shadow.bg-rose-600');
            console.log(`Found ${subtitleButtons.length} potential subtitle buttons`);
            
            subtitleButtons.forEach(button => {
                const link = button.querySelector('a[href*=".ass"], a[href*=".srt"], a[href*=".vtt"]');
                if (!link) return;

                const href = link.getAttribute('href');
                if (!href) return;

                // Get language from button text
                const buttonText = button.textContent.trim();
                const langMatch = buttonText.match(/^([A-Za-z]+)/);
                
                // Map language codes to ISO 639-2 codes
                const langMap = {
                    'English': 'eng',
                    'German': 'ger',
                    'Spanish': 'spa',
                    'French': 'fre',
                    'Hindi': 'hin',
                    'Portuguese': 'por',
                    'Russian': 'rus',
                    'Italian': 'ita'
                };

                let lang = langMatch ? langMatch[1] : 'English';
                const langCode = langMap[lang] || 'eng';

                // Check if it's auto-translated
                const isAuto = buttonText.toLowerCase().includes('auto translated');
                
                subtitles.set(lang, {
                    url: href,
                    lang: langCode,
                    id: langCode,
                    name: `${lang}${isAuto ? ' (Auto)' : ''}`
                });
            });
            
            // Extract subtitles from tracks as fallback
            console.log('Searching for track elements...');
            document.querySelectorAll('track[kind="subtitles"], track[kind="captions"]').forEach(track => {
                if (track.src) {
                    const lang = track.srclang || 'und';
                    const label = track.label || lang;
                    console.log('Found track subtitle:', { src: track.src, lang, label });
                    
                    subtitles.set(lang, {
                        url: track.src,
                        lang: lang,
                        id: label,
                        format: track.src.split('.').pop().toLowerCase()
                    });
                }
            });

            // Process video sources
            const videos = document.querySelectorAll('video');
            videos.forEach(video => {
                if (video.src) {
                    const quality = video.getAttribute('size') || 'Default';
                    sources.set(quality, {
                        url: video.src,
                        quality: quality
                    });
                }
                
                video.querySelectorAll('source').forEach(source => {
                    if (source.src) {
                        const quality = source.getAttribute('size') || 
                                      source.getAttribute('label') || 
                                      source.getAttribute('title') || 
                                      'Unknown';
                        sources.set(quality, {
                            url: source.src,
                            quality: quality
                        });
                    }
                });

                // Check for text tracks in video elements
                video.querySelectorAll('track').forEach(track => {
                    if (track.src && (track.kind === 'subtitles' || track.kind === 'captions')) {
                        const lang = track.srclang || 'und';
                        const label = track.label || lang;
                        console.log('Found video track subtitle:', { src: track.src, lang, label });
                        
                        subtitles.set(lang, {
                            url: track.src,
                            lang: lang,
                            id: label,
                            format: track.src.split('.').pop().toLowerCase()
                        });
                    }
                });
            });
            
            const subtitleArray = Array.from(subtitles.values());
            console.log(`Found ${subtitleArray.length} unique subtitles:`, subtitleArray);
            
            return {
                sources: Array.from(sources.values()),
                subtitles: subtitleArray
            };
        });

        // Add video sources to our streams Map
        videoData.sources.forEach(source => {
            if (!streams.has(source.quality)) {
                streams.set(source.quality, source);
            }
        });

        const meta = await page.evaluate(() => {
            // Get title from multiple sources
            const title = document.querySelector('h1')?.textContent.trim() || 
                         document.title.replace(' - HStream', '').replace(/in 4k.*$/, '').trim();
            
            // Get Japanese title if available
            const japaneseTitle = document.querySelector('h2.inline')?.textContent.trim();
            
            // Get description from meta tags first (usually more complete)
            const description = document.querySelector('meta[name="description"]')?.content ||
                              document.querySelector('meta[property="og:description"]')?.content ||
                              document.querySelector('.text-gray-800.dark\\:text-gray-200.leading-tight')?.textContent.trim() ||
                              '';

            // Get release date
            const releaseDate = document.querySelector('a[data-te-toggle="tooltip"][title*="Released"]')?.textContent
                                .match(/\d{4}-\d{2}-\d{2}/)?.[0];

            // Get studio
            const studio = document.querySelector('a[href*="studios"]')?.textContent.trim();

            // Get all tags/genres
            const genres = Array.from(document.querySelectorAll('ul li a[href*="tags"]'))
                .map(tag => tag.textContent.trim())
                .filter(tag => tag.length > 0);

            // Get view count
            const viewCount = document.querySelector('a.text-xl i.fa-eye')?.nextSibling?.textContent.trim();

            // Get episode number
            const episodeNumber = title.match(/\s*-\s*(\d+)$/)?.[1];

            // Get subtitles
            const subtitles = [];
            const subtitleButtons = document.querySelectorAll('button.group.rounded-md.shadow.bg-rose-600');
            
            subtitleButtons.forEach(button => {
                const link = button.querySelector('a[href*=".ass"], a[href*=".srt"], a[href*=".vtt"]');
                if (!link) return;

                const href = link.getAttribute('href');
                if (!href) return;

                // Get language from button text
                const buttonText = button.textContent.trim();
                const langMatch = buttonText.match(/^([A-Za-z]+)/);
                
                // Map language codes to ISO 639-2 codes
                const langMap = {
                    'English': 'eng',
                    'German': 'ger',
                    'Spanish': 'spa',
                    'French': 'fre',
                    'Hindi': 'hin',
                    'Portuguese': 'por',
                    'Russian': 'rus',
                    'Italian': 'ita'
                };

                let lang = langMatch ? langMatch[1] : 'English';
                const langCode = langMap[lang] || 'eng';

                // Check if it's auto-translated
                const isAuto = buttonText.toLowerCase().includes('auto translated');
                
                subtitles.push({
                    url: href,
                    lang: langCode,
                    id: langCode,
                    name: `${lang}${isAuto ? ' (Auto)' : ''}`
                });
            });

            return {
                title,
                japaneseTitle,
                description,
                releaseInfo: releaseDate,
                studio,
                genres,
                viewCount,
                episodeNumber,
                subtitles
            };
        });

        await browser.close();

        // Convert streams Map to array and format for Stremio
        const uniqueStreams = Array.from(streams.values())
            .filter(stream => {
                try {
                    return new URL(stream.url).protocol === 'https:';
                } catch {
                    return false;
                }
            })
            .map(stream => {
                const streamData = {
                    title: stream.quality,
                    url: stream.url,
                    name: `${meta.title} (${stream.quality})`
                };

                if (videoData.subtitles && videoData.subtitles.length > 0) {
                    streamData.subtitles = videoData.subtitles.map(sub => ({
                        id: sub.id,
                        url: sub.url,
                        lang: sub.lang,
                        format: sub.format,
                        name: `${sub.lang.toUpperCase()} Subtitles`
                    }));
                }

                return streamData;
            });

        debug(`Found ${uniqueStreams.length} streams with ${videoData.subtitles.length} subtitle tracks`);

        const result = {
            ...meta,
            streams: uniqueStreams
        };

        streamCache.set(cacheKey, result);
        return result;
    } catch (error) {
        console.error('Video details error:', error);
        if (browser) await browser.close();
        return { 
            title: 'Unknown', 
            streams: [] 
        };
    }
}

// Handlers
builder.defineCatalogHandler(async ({ extra }) => {
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
    
    debug(`Processing catalog request: skip=${skip}, search="${search}"`);
    const catalog = await fetchCatalog(skip, search);
    
    const metas = catalog.map(item => ({
            id: item.id,
            type: 'movie',
            name: item.name,
            poster: item.poster,
            posterShape: 'poster'
    }));

    debug(`Returning ${metas.length} items for skip=${skip}`);
    return { metas };
});

builder.defineMetaHandler(async ({ id }) => {
    debug('Meta request for id:', id);
    
    // Get all items from the global cache
    const allItems = catalogCache.get('catalog-all') || [];
    debug(`Searching for item ${id} in ${allItems.length} cached items`);
    
    // Find the item in the cache
    let item = allItems.find(i => i.id === id);
    
    // If not found in cache, try to load more pages until we find it
    if (!item) {
        debug('Item not found in cache, trying to load more pages');
        let pageNum = Math.floor(allItems.length / ITEMS_PER_PAGE) + 1;
        let found = false;
        
        while (!found) {
            debug(`Trying to load page ${pageNum}`);
            let browser;
            try {
                browser = await launchBrowser();
                const page = await browser.newPage();
                
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
                await page.setJavaScriptEnabled(true);
                
                const baseUrl = `https://hstream.moe/search?view=poster&order=view-count&page=${pageNum}`;
                debug(`Fetching catalog from: ${baseUrl}`);
                
                const response = await page.goto(baseUrl, { 
                    waitUntil: 'networkidle2', 
                    timeout: 30000 
                });
                
                if (response.status() !== 200) {
                    debug(`Page ${pageNum} returned status ${response.status()}, stopping search`);
                    break;
                }
                
                await page.waitForSelector('div.grid', { timeout: 15000 });
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await delay(1000);
                
                const pageItems = await page.evaluate(() => {
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
                            
                            // Extract episode number if present
                            const episodeMatch = href.match(/-(\d+)$/);
                            const episodeNumber = episodeMatch ? episodeMatch[1] : null;
                            
                            const urlParts = href.split('/hentai/');
                            if (urlParts.length < 2) return;
                            
                            const rawId = urlParts[1];
                            // Modify the ID to include episode number if present
                            const baseId = rawId.replace(/\/?(?:-watch)?(?:-online)?(?:-free)?(?:-streaming)?(?:-sub)?(?:-eng)?(?:-ita)?(?:-\d+)?$/, '');
                            const id = episodeNumber ? `${baseId}-${episodeNumber}` : baseId;
                            if (!id) return;
                            
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
                            
                            // Add episode number to title if present
                            if (episodeNumber) {
                                title = `${title} - ${episodeNumber}`;
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
                            
                            results.push({
                                id: `hstream:${id}`,
                                type: 'movie',
                                name: title,
                                poster: poster,
                                posterShape: 'poster',
                                link: href,
                                episodeNumber: episodeNumber
                            });
                        } catch (err) {
                            console.error(`Error processing item ${index}:`, err);
                        }
                    });
                    return results;
                });
                
                if (pageItems.length === 0) {
                    debug(`No items found on page ${pageNum}, stopping search`);
                    break;
                }
                
                // Add new items to global cache
                allItems.push(...pageItems);
                catalogCache.set('catalog-all', allItems);
                
                // Check if we found our item
                item = pageItems.find(i => i.id === id);
                if (item) {
                    debug(`Found item on page ${pageNum}`);
                    found = true;
                    break;
                }
                
                pageNum++;
            } catch (error) {
                console.error(`Error fetching page ${pageNum}:`, error);
                break;
            } finally {
                if (browser) await browser.close();
            }
        }
    }
    
    if (!item) {
        debug(`Item ${id} not found in any page`);
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
    
    // Get all items from the global cache
    const allItems = catalogCache.get('catalog-all') || [];
    debug(`Searching for item ${id} in ${allItems.length} cached items`);
    
    // Find the item in the cache
    const item = allItems.find(i => i.id === id);
    if (!item) {
        debug(`Item ${id} not found in cache`);
        return { streams: [] };
    }
    
    debug(`Found item: ${item.name}, fetching video details from ${item.link}`);
    const details = await fetchVideoDetails(item.link);
    
    if (!details.streams || details.streams.length === 0) {
        debug('No streams found, adding external URL');
        details.streams = [{
            title: 'Open in Browser',
            externalUrl: item.link
        }];
    } else {
        // Add subtitles to all streams
        details.streams = details.streams.map(stream => {
            if (details.subtitles && details.subtitles.length > 0) {
                stream.subtitles = details.subtitles.map(sub => ({
                    id: sub.id,
                    url: sub.url,
                    lang: sub.lang,
                    name: sub.id
                }));
            }
            return stream;
        });
    }
    
    return { streams: details.streams };
});

// Server setup
const addonInterface = builder.getInterface();
app.use(cors());
app.get('/', (_, res) => {
    res.redirect('/manifest.json');
});
app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
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
});