# Testing EAX — End-to-End Demo Guide

The EAX (Encrypted Attention Exchange) is a privacy-preserving ad exchange. User interests are classified locally via ML into **weighted scores (0–100)**, encrypted via FHE, matched on-chain against advertisers using weighted dot products, and ads are served across sites with **score-proportional payout** on impression.

## Prerequisites

- **Metamask** on **Ethereum Sepolia** (chainId 11155111)
- **Sepolia ETH** for gas (faucet: `sepoliafaucet.com`)
- **Foundry** installed (`forge`, `cast`)
- **Node.js** v18+

---

## Step 1: Deploy EAX Contract

```bash
cd base/contracts
npm install
export PRIVATE_KEY="your_private_key"
forge script script/Deploy.s.sol:DeployScript --rpc-url https://ethereum-sepolia-rpc.publicnode.com --broadcast
```

Copy the deployed `EAX` contract address.

> **Note**: The deploy no longer calls `initializeAdvertisers()`. The contract starts with zero advertisers — register them via the portal in Step 6A.

---

## Step 2: Configure Environment

Create `base/.env.local`:

```
NEXT_PUBLIC_EAX_CONTRACT_ADDRESS="<YOUR_DEPLOYED_CONTRACT_ADDRESS>"
NEXT_PUBLIC_BACKEND_URL="http://localhost:4000"
```

---

## Step 3: Start Backend

```bash
cd base/backend
npm install
node server.js
```

You should see the EAX Ad Server banner on port 4000.

---

## Step 4: Start Frontend

```bash
cd base
npm install ethers @cofhe/sdk viem
npm run dev
```

Keep `http://localhost:3000` open.

---

## Step 5: Load Chrome Extension

1. `chrome://extensions/` → Enable Developer mode
2. Click **Load unpacked** → select `base/extension`
3. Pin the **AdScience** extension

---

## Step 6: Full Workflow

### Phase A — Register an Advertiser + Ad Creative

1. Go to `http://localhost:3000/advertiser`
2. Set **weighted targeting** per category using the sliders (0–100):
   - e.g., CRYPTO: 80, AI: 30, FINANCE: 0, GAMING: 0, DEV: 0
   - Higher weight = stronger targeting for that interest
3. Set bid (e.g., `15` ATTN) — this is the **maximum payout** for a perfect match
4. Fill in ad creative:
   - **Title**: "Trade Crypto Securely"
   - **Image URL**: (optional)
   - **CTA**: "Start Trading"
   - **Link**: "https://example.com"
5. Click **Register Weighted Target + Ad Creative**
6. Confirm the on-chain tx in Metamask
7. The portal will:
   - Register weighted targeting vector + bid on-chain
   - Upload ad creative to the backend (POST /registerAd)

### Phase B — Run Encrypted Match

1. Browse some websites to populate `chrome.history`
2. Go to `http://localhost:3000`
3. Click the extension icon → **Start Analysis**
4. The extension classifies your history locally → generates **weighted interest scores** (0–100 per category) → sends to the page
5. Click **Encrypt & Match My Attention**
6. The flow:
   - CoFHE ZK proof encrypts your weighted intent vector
   - `matchIntent()` tx runs FHE weighted dot products on-chain
   - Threshold network decrypts **both** the winner index and match score
   - `revealMatch()` assigns `activeAdvertiser[you] = winnerId` with score data
7. You'll see: "Ad assigned! Advertiser #X | Y% match quality"

### Phase C — View Ad & Earn (Cross-Site, Score-Proportional)

1. Go to `http://localhost:3000/demo` (simulates a third-party publisher)
2. The page reads `activeAdvertiser[you]`, `matchScore[you]`, and `matchMaxScore[you]` from the contract
3. Displays the matched ad along with a **Match Quality Analysis** panel showing:
   - Dot product score vs max possible score
   - Match quality percentage
   - Estimated payout (computed from the formula below)
4. Click **Confirm Impression → Earn ATTN**
5. `recordImpression()` executes on-chain:
   - Verifies your active match
   - Computes score-proportional payout: `payout = bid × (matchScore / maxScore)`
   - Transfers the scaled payout to your wallet
   - Resets your state (one payout per match)

---

## Payout Formula

```
dotProduct = Σ(userVector[i] × advVector[i])   for i in 0..4
maxScore   = Σ(advVector[i] × 100)             (perfect user match)
payout     = bid × (dotProduct / maxScore)

Example:
  Advertiser vector: [80, 30,  0,  0,  0]   bid = 15 ATTN
  User vector:       [70, 20, 10,  0,  5]

  dotProduct = 70×80 + 20×30 + 10×0 + 0×0 + 5×0 = 6200
  maxScore   = 80×100 + 30×100 = 11000
  matchQuality = 6200 / 11000 = 56.4%
  payout = 15 × 0.564 = 8.45 ATTN
```

A **perfect match** (100% quality) pays the full bid. Weaker matches pay proportionally less.

---

## Architecture

```
MATCH PHASE (Site A — EAX DApp)
────────────────────────────────
Extension → local ML classify → [75, 90, 20, 5, 60]  (weighted 0–100)
  ↓ postMessage
DApp → CoFHE encrypt → matchIntent() tx
  ↓ FHE weighted dot product
  ↓ threshold decrypt (winner + score)
DApp → revealMatch(winnerId, score) → activeAdvertiser[user] = 2, matchScore = 6200

SERVE PHASE (Site B — Any Publisher)
────────────────────────────────
SDK → reads activeAdvertiser[user] + matchScore from chain
SDK → fetches creative from backend
SDK → renders ad with match quality display
SDK → recordImpression() → user gets score-proportional payout ✅
```

## SDK Integration (for publishers)

```js
import { initEAX, getAd, renderAd } from "eax-sdk";

await initEAX({
  contractAddress: "0x...",
  backendUrl: "http://localhost:4000"
});

const ad = await getAd();
await renderAd(document.getElementById("ad-slot"), ad);
// Payout is now score-proportional: bid × (matchScore / maxScore)
```

## Troubleshooting

| Issue | Fix |
|---|---|
| Backend not reachable | Run `node backend/server.js` on port 4000 |
| No ad shown on /demo | Register an advertiser with ad creative first |
| "No active match" | Run a match on the main page first |
| Metamask wrong network | Switch to Ethereum Sepolia (11155111) |
| Contract reverts | Redeploy after contract changes with `forge script` |
| Deploy timeout | The new contract uses lazy FHE init — no FHE calls in constructor |
| No advertisers after deploy | Register advertisers via `/advertiser` portal (no longer hardcoded) |
