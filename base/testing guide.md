# Testing EAX Authentically

Since we have removed all mocks and fakes from the system, you must test the protocol end-to-end realistically. 

This requires running the Fhenix CoFHE environment, loading the Chrome Extension, and configuring the Next.js target.

## Step 1: Deploy EAX Smart Contract
For genuine Fully Homomorphic Encryption testing, we are utilizing the **Fhenix CoFHE (Coprocessor for FHE)**, which allows you to execute fully encrypted logic natively on host EVM chains like Base!

1. CD into your contracts folder: `cd base/contracts`
2. Install dependencies: `npm install` (make sure OpenZeppelin and `fhenixprotocol/cofhe-contracts` are resolved).
3. Open `foundry.toml` and ensure mappings are configured to `node_modules` (This has already been added to the codebase).
4. Export your private key to your terminal session (or create a `.env` file in the `contracts/` directory containing `PRIVATE_KEY="your_wallet_private_key"`).
```bash
export PRIVATE_KEY="your_actual_private_key"
forge script script/Deploy.s.sol:DeployScript --rpc-url https://sepolia.base.org --broadcast
```
5. **CRITICAL**: Copy the deployed `EAX` contract address from the console output.

## Step 2: Configure the Web Interface
1. CD into the base frontend folder: `cd base`
2. Install the necessary crypto dependencies since we enabled real ethers/fhenixjs logic:
```bash
npm install ethers @cofhe/sdk viem
```
3. Create a `.env.local` file in `/base`:
```
NEXT_PUBLIC_EAX_CONTRACT_ADDRESS="<YOUR_DEPLOYED_CONTRACT_ADDRESS>"
```
4. Run the development server: `npm run dev`
5. Keep `http://localhost:3000` open in your Chrome Browser.

## Step 3: Load the Chrome Extension
The extension executes actual queries against your local `qwen3` Ollama instance.
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `/base/extension` folder.
4. Pin the new "EAX" extension to your Chrome toolbar.

---

## Step 4: The 100% Authentic Workflow Demo

### Phase A: Register an Advertiser
1. Navigate to `/advertiser` on your Next.js app (`http://localhost:3000/advertiser`).
2. Select categories you wish to bid for (e.g., `CRYPTO` and `AI`). Set your bid to `50` ATTN limit.
3. Click **Register Intent Target** - Metamask will pop up.
4. Sign the transaction (Ensure Metamask is set to your specified Fhenix network).
5. Ensure the transaction resolves and your advertiser index is registered!

### Phase B: Analyze & Encrypt Intent
1. Open up some new tabs and browse a few test websites (maybe some crypto news or GitHub) to populate local `chrome.history`.
2. Ensure you are looking at `http://localhost:3000/` as your active tab.
3. Click the Chrome Extension popup icon.
4. Click **Match My Attention**.
   - Your local history is parsed.
   - A POST request is made cleanly to your `Ollama` API to categorize the data.
   - A `window.postMessage` bridge executes directly into the Next.js app via `content.js`, injecting the resulting JSON intention vector.

### Phase C: On-chain Verification
1. Watch the UI closely. The Next.js app will receive the vector and prompt Metamask via `BrowserProvider`.
2. Click **Approve** in Metamask.
   - `fhenixjs` encrypts the 5 vector arguments instantaneously into ciphertexts.
   - The ciphertext array is dispatched to `matchIntent()`.
3. Fhenix computes the match synchronously.
4. Await network threshold decryption to claim your ATTN payout!
