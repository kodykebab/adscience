// background.js focuses on non-UI tasks (history fetching)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractHistory") {
    // We want the last 100 visits
    chrome.history.search({text: '', maxResults: 100}, (results) => {
      const seen = new Set();
      const entries = [];
      
      results.forEach((page) => {
        try {
          const url = new URL(page.url);
          // Only keep http/https schemes, ignore chrome:// and others
          if(url.protocol === 'http:' || url.protocol === 'https:') {
            const domain = url.hostname.replace(/^www\./, '');
            
            // Deduplicate by domain, but keep the FIRST (most recent) title
            if (!seen.has(domain)) {
              seen.add(domain);
              entries.push({
                domain: domain,
                title: page.title || ''  // chrome.history provides this!
              });
            }
          }
        } catch (e) {
          // invalid url, skip
        }
      });
      
      sendResponse({ status: "success", entries: entries, domains: entries.map(e => e.domain) });
    });
    
    return true; // Keep the message channel open for sendResponse
  }
});
