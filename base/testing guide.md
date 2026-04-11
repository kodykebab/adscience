# Testing EAX — End-to-End Demo Guide

Since we have removed all mocks and fakes from the system, you must test the protocol end-to-end realistically. 

This requires deploying to Ethereum Sepolia (where the Fhenix CoFHE TaskManager is fully operational), loading the Chrome Extension, and configuring the Next.js DApp.

## Prerequisites

- **Metamask** installed in Chrome, switched to the **Ethereum Sepolia** network.
- **Sepolia ETH** in your wallet for gas fees. Get some from a faucet (e.g., `sepoliafaucet.com`).
- **Foundry** installed (`forge`, `cast`).
- **Node.js** (v18+).

---

## Step 1: Deploy EAX Smart Contract

The EAX contract uses **Fhenix CoFHE (Coprocessor for FHE)** — an on-chain coprocessor that enables encrypted matching directly on Ethereum Sepolia via a predeployed TaskManager.

1. CD into the contracts folder:
```bash
cd base/contracts
```
2. Install Solidity dependencies:
```bash
npm install
```
3. Export your deployer private key:
```bash
export PRIVATE_KEY="your_actual_private_key"
```
4. Deploy to **Ethereum Sepolia**:
```bash
forge script script/Deploy.s.sol:DeployScript --rpc-url https://ethereum-sepolia-rpc.publicnode.com --broadcast
```
5. **CRITICAL**: Copy the deployed `EAX` contract address from the console output.

---

## Step 2: Configure the Web Interface

1. CD into the base frontend folder:
```bash
cd base
```
2. Install dependencies:
```bash
npm install ethers @cofhe/sdk viem
```
3. Create a `.env.local` file in `/base`:
```
NEXT_PUBLIC_EAX_CONTRACT_ADDRESS="<YOUR_DEPLOYED_CONTRACT_ADDRESS>"
```
4. Start the dev server:
```bash
npm run dev -- --webpack
```
5. Keep `http://localhost:3000` open in Chrome.

---

## Step 3: Load the Chrome Extension

The extension uses `Transformers.js` (MobileBERT via WebAssembly) for **fully local, on-device ML classification** — no external API calls.

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked** → select the `base/extension` folder.
4. Pin the **AdScience** extension to your toolbar.

---

## Step 4: End-to-End Workflow

### Phase A — Register an Advertiser
1. Navigate to `http://localhost:3000/advertiser`.
2. Select targeting categories (e.g., `CRYPTO` + `AI`). Set your bid (e.g., `50` ATTN).
3. Click **Register Intent Target** → Metamask pops up.
4. Confirm the transaction (**ensure Metamask is on Ethereum Sepolia**).
5. Wait for block confirmation.

### Phase B — Classify & Submit Encrypted Intent
1. Browse a few websites (crypto news, GitHub, etc.) to populate your `chrome.history`.
2. Make sure `http://localhost:3000` is your **active tab**.
3. Click the **AdScience** extension icon in the toolbar.
4. Click **Start Analysis** — the local ML model loads and classifies your browsing history into a 5-category binary vector.
5. When classification finishes, click **Encrypt & Submit**.
   - The extension dispatches the vector to the DApp via `content.js` → `window.postMessage`.
   - The DApp receives it and initialises the `@cofhe/sdk`:
     - Fetches the FHE public key from the CoFHE network
     - Builds a ZK proof of each encrypted value
     - Sends the proof to the CoFHE verifier for signature
   - Metamask pops up to confirm the `matchIntent()` transaction.

### Phase C — On-chain FHE Matching
1. Approve the transaction in Metamask.
2. The CoFHE TaskManager validates each encrypted input's ZK proof signature.
3. `EAX.sol` computes encrypted dot products between your vector and all registered advertiser vectors.
4. The winner and payout are stored as encrypted values on-chain.
5. The encrypted results are submitted to the Fhenix Threshold Decryption network.

### Phase D — Claim Payout
1. After the threshold network decrypts the result, anyone can call `revealAndClaim()` with the decrypted values and threshold signature.
2. The winning advertiser's bid (in ATTN tokens) is transferred to the user's wallet.

---

## Architecture Summary

```
┌──────────────────┐     postMessage     ┌──────────────────────┐
│  Chrome Extension │ ─────────────────> │  Next.js DApp        │
│  (Transformers.js)│   binary vector    │  (ethers + @cofhe/sdk)│
│  Local ML (WASM)  │                    │                      │
└──────────────────┘                     └──────────┬───────────┘
                                                    │
                                          CoFHE SDK │ encryptInputs()
                                          ZK prove  │ .execute()
                                                    ▼
                                         ┌──────────────────────┐
                                         │  Fhenix CoFHE Testnet│
                                         │  ZK Verifier (HTTPS) │
                                         └──────────┬───────────┘
                                                    │ signed ctHashes
                                                    ▼
                                         ┌──────────────────────┐
                                         │  Ethereum Sepolia    │
                                         │  EAX.sol + TaskMgr   │
                                         │  FHE dot product     │
                                         └──────────────────────┘
```

## Troubleshooting

| Issue | Fix |
|---|---|
| Extension says "Error: Connect securely via localhost:3000" | Refresh your `localhost:3000` tab AFTER reloading the extension |
| `Expected value which is bigint or hex string` | Ensure `@cofhe/sdk` is installed (not the old `fhenixjs`) |
| `shorter than expected public key: 2` | You're on the wrong chain — switch `chains.baseSepolia` → `chains.sepolia` |
| Metamask not popping up | Ensure Metamask is set to **Ethereum Sepolia** (chainId 11155111) |
| Transaction reverts on-chain | Ensure the contract has been deployed to **Ethereum Sepolia**, not Base Sepolia |
