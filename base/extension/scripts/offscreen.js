import { pipeline, env } from './transformers/transformers.min.js';

// Environment config
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

// Constants
const CATEGORIES = ['crypto', 'ai', 'finance', 'gaming', 'dev'];

const CATEGORY_TEXTS = [
  'cryptocurrency blockchain web3 defi nft bitcoin ethereum trading',
  'artificial intelligence ai machine learning language models chatbots',
  'personal finance banking investing stock markets loans insurance',
  'video games gaming esports twitch playstation xbox entertainment',
  'software development programming coding developer open source'
];

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MAX_RETRIES = 2;

let categoryEmbeddings = null;

function dotProduct(vecA, vecB) {
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += vecA[i] * vecB[i];
  }
  return sum;
}

const SUBDOMAIN_PREFIXES = new Set([
  'www', 'mail', 'accounts', 'login', 'auth', 'sso', 'oauth',
  'static', 'cdn', 'api', 'app', 'web', 'mobile', 'm', 'en',
  'docs', 'help', 'support', 'status', 'admin', 'dashboard',
  'com', 'net', 'org', 'co', 'in', 'uk', 'us', 'io', 'edu', 'gov'
]);

function isNoiseToken(token) {
  if (!token) return true;
  if (token.length <= 2 && token !== 'ai' && token !== 'tv') return true;
  if (/^\d+$/.test(token)) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(token)) return true;
  if (token === 'localhost' || token === 'local') return true;
  return false;
}

// Pipeline state
let classifierPipeline = null;
let isInitializing = false;
let initQueue = [];
let modelDownloadProgress = 0;

async function ensurePipeline() {
  if (classifierPipeline) return classifierPipeline;

  if (isInitializing) {
    return new Promise((resolve, reject) => {
      initQueue.push({ resolve, reject });
    });
  }

  isInitializing = true;
  console.log('[EAX Offscreen] Loading Semantic Embeddings pipeline...');

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      classifierPipeline = await pipeline('feature-extraction', MODEL_ID, {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.progress) {
            modelDownloadProgress = Math.round(p.progress);
            console.log(`[EAX Offscreen] Model download: ${modelDownloadProgress}%`);
          }
        }
      });
      console.log('[EAX Offscreen] Model ready. Computing base semantic embeddings...');

      categoryEmbeddings = await Promise.all(CATEGORY_TEXTS.map(async (text) => {
        const embed = await classifierPipeline(text, { pooling: 'mean', normalize: true });
        return Array.from(embed.data);
      }));

      console.log('[EAX Offscreen] Semantic initialization complete.');
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[EAX Offscreen] Init attempt ${attempt} failed:`, err.message);
      if (attempt <= MAX_RETRIES) await new Promise(r => setTimeout(r, 2000));
    }
  }

  isInitializing = false;

  if (!classifierPipeline) {
    const err = lastErr || new Error('Pipeline init failed');
    initQueue.forEach(q => q.reject(err));
    initQueue = [];
    throw err;
  }

  initQueue.forEach(q => q.resolve(classifierPipeline));
  initQueue = [];
  return classifierPipeline;
}

// Warm up
ensurePipeline().catch(e => console.error("[EAX Offscreen] Warm-up failed", e));

function preprocessDomains(domains) {
  const tokens = new Set();
  for (const domain of domains) {
    const parts = domain.toLowerCase().split('.');
    for (const part of parts) {
      if (SUBDOMAIN_PREFIXES.has(part)) continue;
      const words = part.split(/[-_0-9]+/).filter(w => w.length > 0);
      for (const word of words) {
        if (!isNoiseToken(word)) tokens.add(word);
      }
    }
  }
  return Array.from(tokens);
}

// Capped Proportional Normalization
function applyCappedNormalization(rawScores) {
  const maxRaw = Math.max(...rawScores);
  const NOISE_THRESHOLD = 0.05;

  if (maxRaw < NOISE_THRESHOLD) return [0, 0, 0, 0, 0];

  const CONTRAST_POWER = 2.0;
  const sharpened = rawScores.map(s => Math.pow(s / maxRaw, CONTRAST_POWER));

  const CAP = 95;
  const maxSharp = Math.max(...sharpened);
  const vector = sharpened.map(s => {
    const scaled = Math.round((s / maxSharp) * CAP);
    return Math.max(0, Math.min(100, scaled));
  });

  const FLOOR_THRESHOLD = 3;
  return vector.map(v => v < FLOOR_THRESHOLD ? 0 : v);
}

function buildCleanInput(titles, domainTokens) {
  const seen = new Set();
  const unique = titles.filter(t => {
    const key = t.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  const cleaned = unique.map(t => 
    t.replace(/\s*[|\-–—]\s*(?:Google|GitHub|Facebook|Twitter|Reddit|YouTube|X|Medium|LinkedIn)[\s\w]*$/i, '')
     .replace(/https?:\/\/\S+/g, '')
     .replace(/\s+/g, ' ')
     .trim()
  ).filter(t => t.length > 5);
  
  let text = cleaned.join('. ');
  if (domainTokens.length > 0) {
    text += '. Sites: ' + domainTokens.slice(0, 10).join(', ');
  }
  
  if (text.length > 380) {
    text = text.substring(0, 380);
    const lastSentence = Math.max(text.lastIndexOf('. '), text.lastIndexOf('; '));
    if (lastSentence > 200) text = text.substring(0, lastSentence + 1);
  }
  
  return text;
}

// Bootstrap queue logic
let bootstrapQueue = [];
let isProcessingBootstrap = false;

async function processBootstrapAsync(request) {
  const { domains, titles, recencyWeights } = request;
  
  try {
    const classifier = await ensurePipeline();
    const titleEntries = (titles || []).map((t, idx) => ({
      title: (t || '').trim(),
      weight: typeof recencyWeights[idx] === 'number' && Number.isFinite(recencyWeights[idx]) ? recencyWeights[idx] : 1
    }));

    const usefulTitleEntries = titleEntries
      .filter(e => e.title.length > 8)
      .filter(e => !e.title.match(/^https?:\/\//))
      .map(e => ({
        ...e,
        title: e.title
          .replace(/\s*[|\-]\s*(Google|GitHub|Facebook|Twitter|Reddit|YouTube)[\s\w]*$/i, '')
          .trim()
      }))
      .filter(e => e.title.length > 5)
      .slice(0, 60);

    const domainTokens = preprocessDomains(domains).slice(0, 60);

    if (usefulTitleEntries.length === 0 && domainTokens.length === 0) {
      await chrome.storage.local.set({ eax_live_profile: [0, 0, 0, 0, 0] });
      return;
    }

    const MAX_CHUNKS = 4;
    const chunks = []; 

    if (usefulTitleEntries.length > 0) {
      const groups = _buildSemanticChunks(usefulTitleEntries, MAX_CHUNKS);
      for (const group of groups) {
        if (group.length === 0) continue;
        const chunkWeight = group.reduce((s, e) => s + e.weight, 0) / group.length;
        const groupTitles = group.map(e => e.title);
        const text = buildCleanInput(groupTitles, domainTokens);
        if (text) {
           chunks.push({ text, weight: chunkWeight });
        }
      }
    } else {
      const chunkCount = Math.min(MAX_CHUNKS, Math.max(1, domainTokens.length));
      const chunkSizeTokens = Math.ceil(domainTokens.length / chunkCount);
      for (let i = 0; i < chunkCount; i++) {
        const tokenChunk = domainTokens.slice(i * chunkSizeTokens, (i + 1) * chunkSizeTokens);
        if (tokenChunk.length === 0) continue;
        chunks.push({
          text: buildCleanInput([], tokenChunk),
          weight: 1
        });
      }
    }

    let maxScores = [0, 0, 0, 0, 0];

    for (let i = 0; i < chunks.length; i++) {
      const { text, weight } = chunks[i];
      const embed = await classifier(text, { pooling: 'mean', normalize: true });
      const textVec = Array.from(embed.data);

      for (let c = 0; c < 5; c++) {
        const sim = dotProduct(textVec, categoryEmbeddings[c]);
        const weightedSim = weight * Math.max(0, sim);
        if (weightedSim > maxScores[c]) {
          maxScores[c] = weightedSim;
        }
      }
    }

    const finalVector = applyCappedNormalization(maxScores);
    console.log('[EAX Offscreen] Bootstrap Final vector:', CATEGORIES.map((c, i) => `${c}:${finalVector[i]}`).join(' '));
    // Send back to background script to save
    chrome.runtime.sendMessage({ action: 'UPDATE_PROFILE', newProfile: finalVector });
  } catch (err) {
    console.error('[EAX Offscreen] Bootstrap failed:', err);
  }
}

async function runBootstrapQueue() {
  if (isProcessingBootstrap || bootstrapQueue.length === 0) return;
  isProcessingBootstrap = true;
  
  while (bootstrapQueue.length > 0) {
    const req = bootstrapQueue.shift();
    await processBootstrapAsync(req);
  }
  
  isProcessingBootstrap = false;
}

// Live visit inference
let isProcessingLive = false;
let liveVisitQueue = [];

async function processLiveVisitQueue() {
  if (isProcessingLive || liveVisitQueue.length === 0) return;
  isProcessingLive = true;

  try {
    const classifier = await ensurePipeline();

    while (liveVisitQueue.length > 0) {
      const { visit, currentProfile } = liveVisitQueue.shift();
      const text = `${visit.title}. ${visit.description}`.trim().substring(0, 300);
      
      // Permit short high-density strings (e.g., pure search queries like "AI" or "BTC") 
      // but drop completely empty / broken payloads.
      if (text.length < 3) continue;

      console.log(`[EAX Offscreen] Live processing =>`, `"${text}"`);

      const embed = await classifier(text, { pooling: 'mean', normalize: true });
      const textVec = Array.from(embed.data);

      let rawScores = [0, 0, 0, 0, 0];
      for (let c = 0; c < 5; c++) {
        rawScores[c] = Math.max(0, dotProduct(textVec, categoryEmbeddings[c]));
      }

      // Check for signal
      const maxRaw = Math.max(...rawScores);
      if (maxRaw < 0.2) continue; // Noise

      const visitVector = applyCappedNormalization(rawScores);

      const isNew = currentProfile.every(v => v === 0);
      let newProfile = [0, 0, 0, 0, 0];

      if (isNew) {
        newProfile = [...visitVector];
      } else {
        const ALPHA_UP = 0.05;   
        const ALPHA_DOWN = 0.005; 
        for (let i = 0; i < 5; i++) {
          const alpha = visitVector[i] > currentProfile[i] ? ALPHA_UP : ALPHA_DOWN;
          newProfile[i] = Math.max(0, Math.round((1 - alpha) * currentProfile[i] + alpha * visitVector[i]));
        }
      }

      // Send to background script to save
      chrome.runtime.sendMessage({ action: 'UPDATE_PROFILE', newProfile });
      console.log('[EAX Offscreen] Live Profile Updated:', CATEGORIES.map((c, i) => `${c}:${newProfile[i]}`).join(' '));
    }
  } catch (e) {
    console.error('[EAX Offscreen] Live visit ML failed:', e);
  } finally {
    isProcessingLive = false;
  }
}

// Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target !== 'offscreen') return false;

  if (request.action === 'modelStatus') {
    sendResponse({ ready: !!classifierPipeline, progress: modelDownloadProgress });
    return false;
  }

  if (request.action === 'bootstrap_classify') {
    console.log('[EAX Offscreen] Queueing Bootstrap...');
    bootstrapQueue.push(request);
    runBootstrapQueue();
    sendResponse({ status: 'processing', message: 'Bootstrap queued' });
    return false; 
  }

  if (request.action === 'LOG_LIVE_VISIT') {
    // request.currentProfile is provided by background.js
    liveVisitQueue.push({ visit: request, currentProfile: request.currentProfile });
    processLiveVisitQueue();
    sendResponse({ status: 'queued' });
    return false;
  }
});

function _buildSemanticChunks(entries, maxChunks) {
  const TOPIC_KEYWORDS = [
    /\b(crypt|bitcoin|btc|eth|blockchain|web3|defi|nft|token|swap|wallet|solana|metamask|uniswap)\b/i,
    /\b(ai|artificial|gpt|llm|openai|claude|gemini|copilot|neural|machine learn|deep learn|chatbot)\b/i,
    /\b(finance|stock|invest|bank|loan|insurance|trading|market|portfolio|dividend|mutual fund)\b/i,
    /\b(game|gaming|esport|steam|twitch|playstation|xbox|nintendo|rpg|mmorpg|valorant|fortnite)\b/i,
    /\b(github|stackoverflow|npm|pypi|docker|kubernetes|react|angular|python|rust|golang|devops|api|sdk|code|programming)\b/i,
  ];

  function assignTopic(title) {
    for (let t = 0; t < TOPIC_KEYWORDS.length; t++) {
      if (TOPIC_KEYWORDS[t].test(title)) return t;
    }
    return -1;
  }

  const tagged = entries.map(e => ({ ...e, topic: assignTopic(e.title) }));
  const groups = [];
  let current = [tagged[0]];
  for (let i = 1; i < tagged.length; i++) {
    if (tagged[i].topic === current[0].topic && tagged[i].topic !== -1) {
      current.push(tagged[i]);
    } else {
      groups.push(current);
      current = [tagged[i]];
    }
  }
  groups.push(current);

  while (groups.length > maxChunks) {
    let minSize = Infinity;
    let minIdx = 0;
    for (let i = 0; i < groups.length - 1; i++) {
      const combined = groups[i].length + groups[i + 1].length;
      if (combined < minSize) {
        minSize = combined;
        minIdx = i;
      }
    }
    groups[minIdx] = groups[minIdx].concat(groups[minIdx + 1]);
    groups.splice(minIdx + 1, 1);
  }

  return groups;
}
