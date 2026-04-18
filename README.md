# 🔬 AdScience — Encrypted Attention Exchange (EAX)

> **Privacy-preserving ad targeting powered by Fully Homomorphic Encryption (FHE) on-chain.**

AdScience is a full-stack, end-to-end privacy-preserving advertising protocol. It classifies user interests **locally** using an in-browser ML model, encrypts the resulting weighted intent vector via **FHE (CoFHE/Fhenix)**, runs **encrypted weighted dot-product matching** on-chain against advertisers, and pays users **proportionally to match quality** in `ATTN` tokens when they view a matched ad — all without ever revealing raw browsing data to any server or advertiser.

### Smart Contract Addresses (Ethereum Sepolia)
- **EAX Protocol Contract**: `0x33786a4bee9587b673e874b8f8a07e11f2d23820`
- **ERC-20 (ATTN) Token**: `0x4b5af68fa19759806f78235b535cd50d69979838`

---

## 📐 System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                 MATCH PHASE (Site A — EAX DApp)              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Chrome Extension                                            │
│  ├── History Extraction  (chrome.history API + recency)      │
│  ├── Local ML Inference  (MiniLM embeddings via ONNX WASM)   │
│  │   └── Sentence-Transformers/all-MiniLM-L6-v2              │
│  │   └── Softmax-normalized cosine similarity scoring        │
│  └── Weighted Vector     [75, 90, 20, 5, 60] (0–100 scale)  │
│            │                                                 │
│            │ postMessage (content.js bridge)                  │
│            ▼                                                 │
│  Next.js DApp (localhost:3000)                               │
│  ├── CoFHE SDK encrypt  → euint64[5] ciphertext             │
│  ├── matchIntent() tx   → EAX.sol (Sepolia)                 │
│  │   └── FHE weighted dot-product vs. all advertiser vectors │
│  │   └── Encrypted winner + score selected                   │
│  ├── Threshold Network decrypts winner index + match score   │
│  └── revealMatch() tx   → activeAdvertiser[user] = id       │
│        └── stores matchScore + matchMaxScore on-chain        │
│                                                              │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│              SERVE PHASE (Site B — Any Publisher)             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  EAX SDK (@kodykebab/eax-sdk)                                │
│  ├── getActiveAdvertiser()  → reads chain + match quality    │
│  ├── getAd()               → fetches creative from backend  │
│  ├── renderAd()            → injects ad into DOM             │
│  └── recordImpression()    → score-proportional payout ✅    │
│        └── payout = bid × (matchScore / maxScore)            │
│                                                              │
│  Ad Creative Backend (localhost:4000 — Express.js)           │
│  ├── POST /registerAd      → stores creative in memory      │
│  └── GET  /getAd/:id       → returns ad creative            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

### 1. 🧠 ML Engine: Binary → Weighted Classification (Background.js)

**File**: `base/extension/scripts/background.js` — **~414 lines changed**

This is the **largest and most impactful change**. The entire ML classification pipeline was rewritten.

#### What changed:

| Aspect | `main` | `dynnamictrip` |
|--------|--------|----------------|
| **ML Model** | `Xenova/mobilebert-uncased-mnli` (zero-shot NLI) | `Sentence-Transformers/all-MiniLM-L6-v2` (sentence embeddings) |
| **Pipeline** | `zero-shot-classification` (Transformers.js) | `feature-extraction` (sentence embeddings + cosine similarity) |
| **Output** | Binary vector `[0, 1, 1, 0, 1]` | Weighted vector `[75, 90, 20, 5, 60]` (0–100 per category) |
| **Input data** | Domain names only | Domain names + page titles + recency weights |
| **Inference strategy** | Single pass over all domains | Multi-chunk recency-weighted inference (up to 4 passes) |
| **Normalization** | Threshold-based (`> 0.2 → 1`) | Softmax with temperature parameter (`T=0.1`) |
| **Crash protection** | Basic try/catch | 500-char truncation to prevent ONNX WASM Error Code 6 |

#### Key technical details:

- **Category embeddings are pre-computed at startup**: Each of the 5 categories (crypto, ai, finance, gaming, dev) is expanded into a rich descriptive sentence and embedded once. User browsing chunks are then scored via cosine similarity against these precomputed vectors.
- **Recency weighting**: History entries are sorted by `lastVisitTime`. An exponential decay function (`halfLifeMs = 7 days`) weights recent visits higher. Chunks are ordered by recency, and each chunk's scores are multiplied by its average recency weight.
- **Multi-chunk inference**: Titles are split into up to 4 recency-ordered batches. Each chunk is independently embedded and compared, then weighted-averaged into the final vector. This provides more stable results than a single-pass approach.
- **Softmax normalization**: Raw cosine similarities are passed through a softmax with `T=0.1` to distribute scores across categories, rather than forcing the top category to dominate.
- **New message API**: The extension now exposes `classify`, `extractHistory`, and `modelStatus` message actions instead of inline classification in `popup.js`.

---

### 2. 📜 Smart Contract: Weighted Matching + Score-Proportional Payouts (EAX.sol)

**File**: `base/contracts/src/EAX.sol` — **~220 lines changed**

The core on-chain logic was upgraded from binary matching to a full weighted dot-product auction with proportional payouts.

#### What changed:

| Aspect | `main` | `dynnamictrip` |
|--------|--------|----------------|
| **Advertiser vectors** | Binary `[1, 0, 1, 0, 0]` (on/off per category) | Weighted `[80, 30, 0, 0, 0]` (0–100 per category) |
| **Dot product** | `score += userVec[i]` if `advVec[i] == 1` | `score += userVec[i] × advVec[i]` (FHE weighted multiply) |
| **Match output** | Encrypted winner index only | Encrypted winner index **+ encrypted raw dot-product score** |
| **Payout** | Flat `bid` per impression | `bid × (matchScore / maxScore)` — proportional to match quality |
| **FHE init** | In constructor (expensive, caused deployment timeouts) | Lazy init via `_ensureFHEInit()` on first `matchIntent()` call |
| **Bootstrapping** | `initializeAdvertisers()` hardcoded 3 advertisers | Removed — register dynamically via `/advertiser` portal |
| **Validation** | Minimal | Weights must be 0–100, at least one category required, bid > 0 |
| **Winner selection** | `gt(bidValue, maxValue)` against zero initial | First-candidate baseline to avoid `gt(x, 0)` edge case |
| **Event signature** | `ImpressionRecorded(user, advId, uint64 payout)` | `ImpressionRecorded(user, advId, uint256 payoutWei)` |
| **New storage** | — | `matchScore`, `matchMaxScore` mappings; `winnerScore` in MatchTask |
| **New function** | — | `getAdvertiser(id)` view function for reading full advertiser data |

#### Payout formula:
```
dotProduct = Σ(userVector[i] × advVector[i])   for i in 0..4
maxScore   = Σ(advVector[i] × 100)             (perfect user match)
payoutWei  = bid × (dotProduct / maxScore) × 10^18

Example:
  Advertiser vector: [80, 30,  0,  0,  0]   bid = 15 ATTN
  User vector:       [70, 20, 10,  0,  5]

  dotProduct = 70×80 + 20×30 + 10×0 + 0×0 + 5×0 = 6200
  maxScore   = 80×100 + 30×100 = 11000
  matchQuality = 6200 / 11000 = 56.4%
  payout = 15 × 0.564 = 8.45 ATTN
```

---

### 3. 🔌 EAX SDK: Weighted API + Score Decryption (eax-sdk/)

**Files**: `base/eax-sdk/api.js`, `base/eax-sdk/contract.js`, `base/eax-sdk/package.json`

#### `api.js` (~41 lines changed):
- `runMatch()` now decrypts **two** ciphertext handles (winner index + match score) instead of one
- `revealMatch()` now passes **5 arguments** (taskId, winnerIndex, winnerSig, winnerScore, scoreSig) instead of 3
- Return value now includes `{ score, maxScore, quality }` alongside `advertiserId`
- `getActiveAdvertiser()` now returns `{ advertiserId, score, maxScore, quality }` via new contract reads
- `recordImpression()` now returns `{ payoutWei, payoutATTN }` (proper wei → ATTN conversion)
- Extracted `_decryptWithRetry()` helper (was inline retry loop, now reusable for both decryptions)

#### `contract.js` (~134 lines changed):
- Updated ABI to include new functions: `getAdvertiser()`, `matchScore()`, `matchMaxScore()`
- Updated `revealMatch()` signature to accept 5 args
- Updated `ImpressionRecorded` event to use `uint256 payoutWei`
- Updated `MatchRevealed` event to include `score` and `maxScore` params

#### `package.json` (~17 lines changed):
- Package renamed from `eax-sdk` to `@kodykebab/eax-sdk`
- Added `"author": "kritarth"` and `"scripts"` block

---

### 4. 🖥️ Extension Popup: Weighted Display + Delegated Classification (popup.js)

**File**: `base/extension/scripts/popup.js` — **~199 lines changed**

#### What changed:
- **Classification moved to background service worker**: Popup no longer imports `@huggingface/transformers` or runs ML inline. Instead, it sends a `classify` message to `background.js` and receives the weighted vector.
- **History extraction enhanced**: Now collects page titles and recency weights alongside domains, sends all three arrays to the background worker.
- **Interest display upgraded**: Categories now show percentage values (e.g., `crypto 75%`) with opacity proportional to score, instead of binary active/inactive tags.
- **Vector display**: Shows `[75, 90, 20, 5, 60]` instead of `[0, 1, 1, 0, 1]`.
- **Graceful fallback**: On classification failure, falls back to `[60, 40, 0, 0, 50]` instead of `[1, 0, 0, 0, 0]`.
- **Model readiness polling**: New `waitForModel()` function polls `background.js` via `modelStatus` message before starting classification.
- **New state variables**: `extractedTitles`, `extractedRecencyWeights` tracked alongside `extractedDomains`.

---

### 5. 🌐 Frontend DApp: Match Quality Visualization (super_new_new_frontend/)

#### `app/app/page.tsx` (~173 lines changed) — Main matching page:
- **Weighted vector display**: Replaced binary 0/1 boxes with horizontal progress bars showing 0–100 scores per category with dynamic opacity.
- **Match quality badge**: After matching, shows a quality percentage bar with color coding (green > 70%, white > 40%, red < 40%).
- **New state**: `matchQuality` computed from on-chain `winnerScore / maxPossible`.
- **5-argument revealMatch call**: Updated to pass both winner index and score signatures.
- **Score-proportional messaging**: Footer now shows "Weighted ML" and "Score-Proportional Pay" instead of "Local AI" and "Cross-Site Serving".

#### `app/demo/page.tsx` (~105 lines changed) — Publisher demo page:
- **Match Quality Analysis panel**: New SVG ring visualization showing match quality percentage, dot product score, max possible score, advertiser bid, and estimated payout.
- **Advertiser vector display**: Shows the winning advertiser's weighted targeting vector across all 5 categories.
- **Score-proportional payout**: `recordImpression()` now reads `uint256 payoutWei` and converts to ATTN with `ethers.formatEther()`.
- **Precision display**: Payouts shown with 4 decimal places (e.g., `+8.4545 ATTN`) instead of integer tokens.
- **Quality bar in payout confirmation**: After impression, shows a quality match progress bar.

#### `app/advertiser/page.tsx` (~69 lines changed) — Advertiser registration:
- **Weighted targeting UI**: Replaced binary toggle buttons with range sliders (0–100) and numeric inputs per category.
- **Live vector preview**: Shows current `[80, 30, 0, 0, 0]` vector in a compact inline display with highlight styling.
- **Total weight indicator**: Shows `Total: 110/500` in the header.
- **Updated payout explanation**: Bid description now explains `bid × (matchScore / maxScore)` formula.
- **Validation text**: "Select at least one category" → "Set at least one category weight above 0".

---

## 🏗️ Repository Structure

```
adscience/
├── base/
│   ├── contracts/src/EAX.sol       # Core FHE smart contract (weighted matching)
│   ├── contracts/script/           # Foundry deploy scripts
│   ├── eax-sdk/                    # Publisher SDK (@kodykebab/eax-sdk)
│   ├── extension/                  # Chrome extension (MiniLM ML + weighted vectors)
│   │   ├── scripts/background.js   # ML inference service worker
│   │   ├── scripts/popup.js        # Extension popup UI
│   │   └── manifest.json           # Extension config
│   ├── backend/                    # Express.js ad creative server
│   ├── app/                        # Next.js main DApp pages
│   └── testing guide.md            # End-to-end demo walkthrough
├── super_new_new_frontend/         # Marketing site + dApp UI
│   ├── app/app/                    # Match intent page
│   ├── app/demo/                   # Publisher demo + impression page
│   ├── app/advertiser/             # Advertiser registration portal
│   └── components/landing/         # Landing page sections
└── README.md
```

---

## 🚀 Quick Start

```bash
# 1. Start the backend
cd base/backend && npm install && node server.js

# 2. Start the frontend
cd super_new_new_frontend && npm install && npm run dev

# 3. Load the Chrome extension
# Go to chrome://extensions → Load unpacked → select base/extension/

# 4. Open http://localhost:3000
```

For the full end-to-end demo walkthrough, see [`base/testing guide.md`](base/testing%20guide.md).
