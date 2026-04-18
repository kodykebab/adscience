// Background service worker for history extraction and message routing.

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';

// Offscreen lifecycle management
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
  });

  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS'], // Web workers for WASM execution
    justification: 'Running background ONNX inference models'
  });
}

// History extraction helpers
const RECENCY_TAU_DAYS = 7;
function recencyWeight(lastVisitTimeMs) {
  if (typeof lastVisitTimeMs !== 'number' || !Number.isFinite(lastVisitTimeMs)) return 0.5;
  const ageMs = Math.max(0, Date.now() - lastVisitTimeMs);
  const tauMs = RECENCY_TAU_DAYS * 24 * 60 * 60 * 1000;
  return Math.exp(-ageMs / tauMs);
}

// Message router
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'extractHistory') {
    chrome.history.search({ text: '', maxResults: 1000, startTime: 0 }, (results) => {
      const domainMap = new Map();

      results.forEach(page => {
        try {
          const url = new URL(page.url);
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            const domain = url.hostname.replace(/^www\./, '');
            const title = (page.title || '').trim();
            const lastVisitTime = page.lastVisitTime;
            const current = domainMap.get(domain);

            if (!current) {
              domainMap.set(domain, { domain, title, lastVisitTime });
              return;
            }

            if (title.length > (current.title || '').length) {
              current.title = title;
            }
            if (typeof lastVisitTime === 'number' && lastVisitTime > (current.lastVisitTime || 0)) {
              current.lastVisitTime = lastVisitTime;
            }
          }
        } catch { }
      });

      const entries = Array.from(domainMap.values())
        .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));

      const maxWeight = Math.max(...entries.map(e => recencyWeight(e.lastVisitTime)), 1e-9);
      const sliced = entries.slice(0, 60).map(e => ({
        domain: e.domain,
        title: e.title,
        weight: recencyWeight(e.lastVisitTime) / maxWeight
      }));

      sendResponse({
        status: 'success',
        domains: sliced.map(e => e.domain),
        titles: sliced.map(e => e.title),
        recencyWeights: sliced.map(e => e.weight),
      });
    });
    return true;
  }

  // Handle Profile Update from Offscreen
  if (request.action === 'UPDATE_PROFILE') {
    chrome.storage.local.set({ eax_live_profile: request.newProfile || [0,0,0,0,0] });
    sendResponse({ status: 'saved' });
    return false;
  }

  // Model Status Check
  if (request.action === 'modelStatus') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'modelStatus' });
        sendResponse(result);
      } catch (err) {
        sendResponse({ status: 'error', message: err.message });
      }
    })();
    return true;
  }

  // Classify Operation (Bootstrap from popup)
  if (request.action === 'classify') {
    (async () => {
      try {
        const data = await chrome.storage.local.get(['eax_live_profile']);
        if (data.eax_live_profile && !data.eax_live_profile.every(v => v === 0)) {
           // Return cached profile instantly
           sendResponse({ status: 'success', vector: data.eax_live_profile, method: 'live_dom' });
           return;
        }

        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'bootstrap_classify',
          domains: request.domains,
          titles: request.titles,
          recencyWeights: request.recencyWeights
        });
        sendResponse(result);
      } catch (err) {
        console.error('[EAX BG] Offscreen routing failed:', err);
        sendResponse({ status: 'error', message: err.message });
      }
    })();
    return true;
  }

  // Live Visit Logging
  if (request.action === 'LOG_LIVE_VISIT') {
    (async () => {
      try {
        const data = await chrome.storage.local.get(['eax_live_profile']);
        const currentProfile = data.eax_live_profile || [0, 0, 0, 0, 0];

        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'LOG_LIVE_VISIT',
          ...request,
          currentProfile: currentProfile
        });
        sendResponse(result);
      } catch (err) {
        console.error('[EAX BG] Live Visit route failed:', err);
        sendResponse({ status: 'error', message: err.message });
      }
    })();
    return true;
  }
});
