// Bridge script to forward messages from background to page context.

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (request.type === "EAX_USER_VECTOR_TO_APP") {
        console.log("AdScience Content Script Forwarding ML intent payload to DApp window...");
        // Pass to the React App layer listening on the standard window event bridge
        window.postMessage({ type: "EAX_USER_VECTOR_TO_APP", vector: request.vector }, "*");
        sendResponse({status: "success"});
    }
});

// Metadata extraction logic with search engine handling.
const hostname = window.location.hostname.toLowerCase();
const searchEngines = [
    'google.', 'bing.com', 'duckduckgo.com', 'yahoo.com', 
    'baidu.com', 'yandex.ru', 'ecosia.org', 'search.brave.com'
];
const isSearchEngine = searchEngines.some(engine => hostname.includes(engine));

// Delay search pages by 10 seconds. If the user clicks a result before then, the tab navigates,
// this script dies, and the search query is cleanly dropped in favor of the actual destination page.
const WAIT_TIME = isSearchEngine ? 10000 : 2000;

setTimeout(() => {
    try {
        let title = document.title || '';
        
        if (isSearchEngine) {
            // Strip search engine suffixes (e.g. " - Google Search", " at DuckDuckGo")
            title = title.replace(/\s*[-–|]\s*(Google Search|Search|Yahoo Search|Brave Search)$/i, '')
                         .replace(/\s*at\s*DuckDuckGo$/i, '')
                         .trim();
            
            // If the query is meaningful, send it immediately and skip the rest of the heavy DOM extraction
            if (title.length > 3) {
                chrome.runtime.sendMessage({
                    action: "LOG_LIVE_VISIT",
                    domain: window.location.hostname,
                    title: title,
                    description: ''
                });
            }
            return; 
        }
        
        const metaDesc = document.querySelector('meta[name="description"]')?.content?.trim() || '';
        const ogDesc = document.querySelector('meta[property="og:description"]')?.content?.trim() || '';
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';
        
        const paragraphs = document.querySelectorAll('main p, article p, [role="main"] p, .content p, #content p, p');
        let firstParagraph = '';
        for (const p of paragraphs) {
            const text = p.textContent?.trim() || '';
            if (text.length > 40 && !text.match(/cookie|privacy policy|accept all/i)) {
                firstParagraph = text.substring(0, 200);
                break;
            }
        }
        
        const candidates = [
            { text: ogDesc, score: ogDesc.length > 30 ? 3 : 0 },
            { text: metaDesc, score: metaDesc.length > 30 && !metaDesc.match(/^(Welcome|Home|Official)/i) ? 2 : 0 },
            { text: firstParagraph, score: firstParagraph.length > 50 ? 2.5 : 0 },
            { text: h1, score: h1.length > 5 ? 1 : 0 },
        ].filter(c => c.text && c.score > 0)
         .sort((a, b) => b.score - a.score);
        
        description = candidates.slice(0, 2).map(c => c.text).join('. ');
        
        // Only classify if there's actual semantic text available
        if (title.length > 5 || description.length > 10) {
            chrome.runtime.sendMessage({
                action: "LOG_LIVE_VISIT",
                domain: window.location.hostname,
                title: title.trim(),
                description: description.trim()
            });
        }
    } catch (e) {
        console.error("[EAX] Failed to extract page metadata:", e);
    }
}, WAIT_TIME);
