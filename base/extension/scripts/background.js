/**
 * scripts/background.js — EAX Service Worker
 *
 * Responsibilities:
 *   1. History extraction (chrome.history) — returns domains + page titles
 *   2. AdScience AI semantic classification (Transformers.js / ONNX WASM)
 *
 * The ML pipeline is initialized ONCE when the extension loads and is reused
 * for every "classify" message from the popup.
 *
 * Key classification improvements:
 *   - Uses PAGE TITLES as primary signal (semantically rich)
 *   - Falls back to processed domain tokens if titles aren't available
 *   - Spread-aware normalization: uniform/uncertain model output → low scores
 *     (fixes the all-100% bug with generic browsing history)
 */

import { pipeline, env } from './transformers/transformers.min.js';

// ── Transformers.js Environment Config ──────────────────────────
env.allowLocalModels   = false;
env.useBrowserCache    = true;
env.backends.onnx.wasm.wasmPaths = new URL('./transformers/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

// ── Constants ────────────────────────────────────────────────────
const CATEGORIES = ['crypto', 'ai', 'finance', 'gaming', 'dev'];

// We define strong semantic sentences for each category to embed as reference vectors.
// Semantic Search computes vector similarity rather than logical entailment.
const CATEGORY_TEXTS = [
  'The user is interested in cryptocurrency, blockchain technology, web3, DeFi, NFTs, bitcoin, ethereum, and crypto trading.',
  'The user is interested in artificial intelligence, AI tools, machine learning, chatbots, language models, and AI assistants.',
  'The user is interested in personal finance, banking, investing, stock markets, loans, insurance, and managing money.',
  'The user is interested in video games, gaming, esports, game reviews, gaming hardware, and entertainment.',
  'The user is interested in software development, programming, coding, open source projects, and building applications.'
];

// Switch to a lightweight semantic embedding model for Cosine Similarity classification
const MODEL_ID    = 'Xenova/all-MiniLM-L6-v2';
const MAX_RETRIES = 2;

// Recency weighting: more recent browsing should matter more for ad assignment.
// Tunable constant; chosen for a "quick intent" window without needing labels.
const RECENCY_TAU_DAYS = 7;

// Cache the computed embedding vectors for our 5 categories
let categoryEmbeddings = null;

// Returns cosine similarity between two normalized vectors
function dotProduct(vecA, vecB) {
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += vecA[i] * vecB[i];
  }
  return sum;
}

// ── Structural subdomain prefixes to strip ───────────────────────
// These are generic infrastructure prefixes, not interest-specific.
const SUBDOMAIN_PREFIXES = new Set([
  'www', 'mail', 'accounts', 'login', 'auth', 'sso', 'oauth',
  'static', 'cdn', 'api', 'app', 'web', 'mobile', 'm', 'en',
  'docs', 'help', 'support', 'status', 'admin', 'dashboard',
]);

// ── Noise token filter ───────────────────────────────────────────
function isNoiseToken(token) {
  if (!token || token.length <= 2) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(token)) return true;
  if (token === 'localhost' || token === 'local') return true;
  return false;
}

function recencyWeight(lastVisitTimeMs) {
  // lastVisitTimeMs comes from chrome.history; if missing, fall back to a neutral weight.
  if (typeof lastVisitTimeMs !== 'number' || !Number.isFinite(lastVisitTimeMs)) return 0.5;

  const now = Date.now();
  const ageMs = Math.max(0, now - lastVisitTimeMs);
  const tauMs = RECENCY_TAU_DAYS * 24 * 60 * 60 * 1000;
  // exp(-age/tau) in (0, 1]
  return Math.exp(-ageMs / tauMs);
}

// ── Pipeline state ───────────────────────────────────────────────
let classifierPipeline = null;
let isInitializing     = false;
let initQueue          = [];

// ── keepAlive alarm ──────────────────────────────────────────────
chrome.alarms.create('eax-keepalive', { periodInMinutes: 0.33 });
chrome.alarms.onAlarm.addListener(() => {});

// ── Model init ───────────────────────────────────────────────────
async function ensurePipeline() {
  if (classifierPipeline) return classifierPipeline;

  if (isInitializing) {
    return new Promise((resolve, reject) => {
      initQueue.push({ resolve, reject });
    });
  }

  isInitializing = true;
  console.log('[EAX BG] Loading Semantic Embeddings pipeline...');

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      classifierPipeline = await pipeline('feature-extraction', MODEL_ID, {
        quantized: true,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.progress) {
            console.log(`[EAX BG] Model download: ${Math.round(p.progress)}%`);
          }
        }
      });
      console.log('[EAX BG] Model ready. Computing base semantic embeddings...');

      // Pre-compute normalized reference vectors for the 5 categories
      categoryEmbeddings = await Promise.all(CATEGORY_TEXTS.map(async (text) => {
        const embed = await classifierPipeline(text, { pooling: 'mean', normalize: true });
        return Array.from(embed.data);
      }));

      console.log('[EAX BG] Semantic initialization complete.');
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[EAX BG] Init attempt ${attempt} failed:`, err.message);
      if (attempt <= MAX_RETRIES) await sleep(2000);
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

// Warm up immediately on install/start
self.addEventListener('activate', () => {
  ensurePipeline().catch(err =>
    console.warn('[EAX BG] Warm-up failed (will retry on first use):', err.message)
  );
});

// ── Domain preprocessing ─────────────────────────────────────────
// Strips TLDs and structural subdomain prefixes, splits on hyphens.
// No hardcoded interest mappings — purely structural.
//
// 'pittvandewitt.github.io' -> ['pittvandewitt', 'github']
// 'headphonezone.in'        -> ['headphonezone']
// 'accounts.google.com'     -> ['google']
// 'localhost'               -> (filtered)
function preprocessDomains(domains) {
  const tokens = new Set();

  for (const domain of domains) {
    const parts = domain.toLowerCase().split('.');
    const meaningful = [];
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length <= 3 && meaningful.length === 0) continue;
      meaningful.unshift(parts[i]);
    }

    for (const part of meaningful) {
      if (SUBDOMAIN_PREFIXES.has(part)) continue;
      const words = part.split(/[-_0-9]+/).filter(w => w.length > 2);
      for (const word of words.length > 0 ? words : [part]) {
        if (!isNoiseToken(word)) tokens.add(word);
      }
    }
  }

  return Array.from(tokens);
}

// ── Classification ───────────────────────────────────────────────
//
// Uses page titles as primary semantic input. Page titles contain
// real content ("Headphone Zone - Best Headphones in India Online")
// which is far more informative than domain tokens ("headphonezone").
//
// Normalization:
// - Evidence is accumulated with recency weights across multiple history chunks.
// - Output uses a softmax distribution over category similarities so mixed/ambiguous
//   browsing doesn't force the top category to ~100 unless evidence is truly strong.
async function classifyBrowsing(domains, titles, recencyWeights = []) {
  const classifier = await ensurePipeline();

  // Build title+recency pairs. Titles are primary signal; domain tokens act as a fallback.
  const titleEntries = (titles || []).map((t, idx) => ({
    title: (t || '').trim(),
    weight: typeof recencyWeights[idx] === 'number' && Number.isFinite(recencyWeights[idx])
      ? recencyWeights[idx]
      : 1
  }));

  const usefulTitleEntries = titleEntries
    .filter(e => e.title.length > 8)
    .filter(e => !e.title.match(/^https?:\/\//))
    // Strip trailing "| SiteName" structural suffixes
    .map(e => ({
      ...e,
      title: e.title
        .replace(/\s*[|\-]\s*(Google|GitHub|Facebook|Twitter|Reddit|YouTube)[\s\w]*$/i, '')
        .trim()
    }))
    .filter(e => e.title.length > 5)
    // Capture a wide sample of history (but still keep compute bounded).
    .slice(0, 60);

  const domainTokens = preprocessDomains(domains).slice(0, 60);

  if (usefulTitleEntries.length === 0 && domainTokens.length === 0) {
    return [0, 0, 0, 0, 0];
  }

  const MAX_CHUNKS = 4;
  const chunks = []; // { text: string, weight: number }

  const domainText = domainTokens.slice(0, 30).join(', ');

  if (usefulTitleEntries.length > 0) {
    // Split titles into up to MAX_CHUNKS recency-ordered chunks and weight each chunk by recency.
    const chunkCount = Math.min(MAX_CHUNKS, Math.max(1, usefulTitleEntries.length));
    const chunkSize = Math.ceil(usefulTitleEntries.length / chunkCount);

    for (let i = 0; i < chunkCount; i++) {
      const chunkEntries = usefulTitleEntries.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunkEntries.length === 0) continue;

      const chunkWeight = chunkEntries.reduce((s, e) => s + e.weight, 0) / chunkEntries.length;
      const chunkTitleText = chunkEntries.map(e => e.title).slice(0, 30).join('; ');

      if (chunkTitleText && domainText) {
        chunks.push({
          text: `The user browsed: ${chunkTitleText}. Sites: ${domainText}.`,
          weight: chunkWeight
        });
      } else if (chunkTitleText) {
        chunks.push({ text: `The user browsed: ${chunkTitleText}.`, weight: chunkWeight });
      }
    }
  } else {
    // Domain-only fallback: split tokens uniformly and use equal weights.
    const chunkCount = Math.min(MAX_CHUNKS, Math.max(1, domainTokens.length));
    const chunkSizeTokens = Math.ceil(domainTokens.length / chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      const tokenChunk = domainTokens.slice(i * chunkSizeTokens, (i + 1) * chunkSizeTokens);
      if (tokenChunk.length === 0) continue;
      chunks.push({
        text: `The user visited websites related to: ${tokenChunk.join(', ')}.`,
        weight: 1
      });
    }
  }

  console.log(`[EAX BG] Running ${chunks.length} inference passes across history for higher accuracy...`);

  let summedScores = [0, 0, 0, 0, 0];
  let totalWeight = 0;

  for (let i = 0; i < chunks.length; i++) {
    let text = chunks[i].text;
    const chunkWeight = chunks[i].weight;

    totalWeight += chunkWeight;
    
    // CRITICAL FIX: ONNX Runtime WASM Error Code 6 protection
    if (text.length > 500) {
      text = text.substring(0, 500);
      text = text.substring(0, Math.max(text.lastIndexOf(' '), text.lastIndexOf(';'))) + '...';
    }

    console.log(`[EAX BG] Pass ${i+1}/${chunks.length} input length:`, text.length, 'chars');

    // Generate a normalized semantic embedding for this history chunk
    const embed = await classifier(text, { pooling: 'mean', normalize: true });
    const textVec = Array.from(embed.data);

    // Compute cosine similarity (dot product) against the 5 base category vectors
    for (let c = 0; c < 5; c++) {
      const sim = dotProduct(textVec, categoryEmbeddings[c]);
      // Similarity ranges from -1 to 1. Negative numbers mean opposite meaning, so cap at 0.
      summedScores[c] += chunkWeight * Math.max(0, sim);
    }
  }

  // Weighted average of evidence across recency-ordered chunks.
  const denom = totalWeight > 0 ? totalWeight : 1;
  const rawScores = summedScores.map(score => score / denom);

  console.log('[EAX BG] Raw scores:', CATEGORIES.map((c, i) => c + ':' + rawScores[i].toFixed(3)).join(' '));

  // ── Step 4: Normalization ──────────────────────────────────────
  const maxRaw = Math.max(...rawScores);
  const NOISE_THRESHOLD = 0.05;

  if (maxRaw < NOISE_THRESHOLD) return [0, 0, 0, 0, 0];

  // Softmax instead of max-relative scaling:
  // - avoids forcing the top category to ~100 when evidence gaps are small
  // - produces a smoother distribution over the 5 categories
  const SOFTMAX_TEMPERATURE = 0.1; // lower => peaky; higher => flatter
  const exps = rawScores.map(s => Math.exp(s / SOFTMAX_TEMPERATURE));
  const sumExp = exps.reduce((a, b) => a + b, 0) || 1;

  const vector = exps.map(e => Math.round((e / sumExp) * 100));

  console.log('[EAX BG] Recency-weighted softmax scaling | Vector:', 
    CATEGORIES.map((c, i) => `${c}:${vector[i]}`).join(' '));

  return vector;
}

// ── Message Router ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  if (request.action === 'extractHistory') {
    // By default, chrome.history.search without startTime only searches the last 24 hours.
    // Setting startTime: 0 pulls from the entire available browser history.
    chrome.history.search({ text: '', maxResults: 1000, startTime: 0 }, (results) => {
      const domainMap = new Map();

      results.forEach(page => {
        try {
          const url = new URL(page.url);
          if (url.protocol === 'http:' || url.protocol === 'https:') {
            const domain  = url.hostname.replace(/^www\./, '');
            const title   = (page.title || '').trim();
            const lastVisitTime = page.lastVisitTime;
            const current = domainMap.get(domain);

            if (!current) {
              domainMap.set(domain, { domain, title, lastVisitTime });
              return;
            }

            // Keep the longest (most informative) title per domain.
            if (title.length > (current.title || '').length) {
              current.title = title;
            }
            // Track recency as the latest visit time for this domain.
            if (typeof lastVisitTime === 'number' && lastVisitTime > (current.lastVisitTime || 0)) {
              current.lastVisitTime = lastVisitTime;
            }
          }
        } catch {}
      });

      // Sort by recency so classifier slice(0, 60) uses the most relevant signals.
      const entries = Array.from(domainMap.values())
        .sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));

      // Compute and normalize recency weights in (0, 1].
      const maxWeight = Math.max(...entries.map(e => recencyWeight(e.lastVisitTime)), 1e-9);
      const sliced = entries.slice(0, 60).map(e => ({
        domain: e.domain,
        title: e.title,
        weight: recencyWeight(e.lastVisitTime) / maxWeight
      }));

      sendResponse({
        status:  'success',
        domains: sliced.map(e => e.domain),
        titles:  sliced.map(e => e.title),
        recencyWeights: sliced.map(e => e.weight),
      });
    });
    return true;
  }

  // classify: accepts domains + titles, returns weighted vector
  if (request.action === 'classify') {
    classifyBrowsing(request.domains, request.titles || [], request.recencyWeights || [])
      .then(vector => sendResponse({ status: 'success', vector }))
      .catch(err   => sendResponse({ status: 'error', message: err.message }));
    return true;
  }

  // modelStatus: popup can poll whether model is ready
  if (request.action === 'modelStatus') {
    sendResponse({ ready: !!classifierPipeline });
    return false;
  }
});

// ── Utility ──────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
