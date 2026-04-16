/**
 * eax-sdk/contract.js
 * 
 * Contract interactions: initEAX + runMatch
 * Handles: wallet connection, CoFHE encryption, on-chain matching, threshold decryption, reveal
 * 
 * v2: Dynamic weighted vectors (0–100), dual decryption (winner + score),
 *     score-proportional payouts.
 */

// Minimal ABI — only the functions/events the SDK needs
// Matches the merged EAX.sol:
//   revealMatch(taskId, winnerIndex, winnerSig, winnerScore, scoreSig)
//   ImpressionRecorded emits uint256 payoutWei
//   MatchRevealed emits uint64 score, uint64 maxScore
const EAX_ABI = [
  "function matchIntent(tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)[] calldata _encVec) external returns (uint256)",
  "function revealMatch(uint256 _taskId, uint8 _winnerIndex, bytes calldata _winnerSig, uint64 _winnerScore, bytes calldata _scoreSig) external",
  "function recordImpression() external",
  "function activeAdvertiser(address) view returns (uint8)",
  "function hasActiveMatch(address) view returns (bool)",
  "function matchScore(address) view returns (uint64)",
  "function matchMaxScore(address) view returns (uint64)",
  "function getAdvertiser(uint256) view returns (uint64[5] vector, uint64 bid, uint256 balance, address addr, bool active)",
  "function tasks(uint256) view returns (uint256 winnerIndex, uint256 winnerScore, address user, bool exists, bool revealed)",
  "event AdvertiserRegistered(uint256 indexed id, address indexed addr, uint64 bid)",
  "event MatchSubmitted(uint256 indexed taskId, address indexed user)",
  "event MatchRevealed(address indexed user, uint8 advertiserId, uint64 score, uint64 maxScore)",
  "event ImpressionRecorded(address indexed user, uint8 advertiserId, uint256 payoutWei)",
];

// Module state
let _config = null;
let _provider = null;
let _signer = null;
let _contract = null;
let _userAddress = null;

/**
 * Initialize the EAX SDK.
 * Must be called before runMatch() or getAd().
 * Idempotent: safe to call multiple times.
 * 
 * @param {Object} config
 * @param {string} config.contractAddress - Deployed EAX contract address
 * @param {string} config.backendUrl - Ad creative server URL (e.g. http://localhost:4000)
 */
export async function initEAX({ contractAddress, backendUrl }) {
  if (!contractAddress || !backendUrl) {
    throw new Error("initEAX requires contractAddress and backendUrl");
  }

  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("No Ethereum wallet detected. Install MetaMask.");
  }

  // Idempotency: skip if already initialized for the same contract
  if (_contract && _config?.contractAddress === contractAddress && _userAddress) {
    return { userAddress: _userAddress };
  }

  const { ethers, BrowserProvider } = await import("ethers");

  _provider = new BrowserProvider(window.ethereum);
  await _provider.send("eth_requestAccounts", []);
  _signer = await _provider.getSigner();
  _userAddress = await _signer.getAddress();

  _contract = new ethers.Contract(contractAddress, EAX_ABI, _signer);

  _config = { contractAddress, backendUrl };

  console.log(`[EAX SDK] Initialized | User: ${_userAddress} | Contract: ${contractAddress}`);
  return { userAddress: _userAddress };
}

/**
 * Run the full encrypted matching pipeline:
 * 1. Wait for extension to deliver weighted intent vector (0–100 per category)
 * 2. Encrypt via CoFHE ZK proof pipeline
 * 3. Submit matchIntent() on-chain
 * 4. Await threshold decryption of BOTH winner index and match score
 * 5. Call revealMatch() to assign activeAdvertiser with score data
 * 
 * @returns {{ advertiserId: number, score: number, maxScore: number, quality: number, taskId: string, txHash: string }}
 */
export async function runMatch() {
  if (!_contract) throw new Error("Call initEAX() first");

  // Step 1: Get weighted vector from extension via postMessage bridge
  const vector = await _waitForExtensionVector();

  // Step 2: Encrypt via CoFHE
  const { createCofheConfig, createCofheClient } = await import("@cofhe/sdk/web");
  const { chains } = await import("@cofhe/sdk/chains");
  const { Ethers6Adapter } = await import("@cofhe/sdk/adapters");
  const { Encryptable } = await import("@cofhe/sdk");

  const config = createCofheConfig({ supportedChains: [chains.sepolia] });
  const cofheClient = createCofheClient(config);

  const { publicClient, walletClient } = await Ethers6Adapter(_provider, _signer);
  await cofheClient.connect(publicClient, walletClient);

  const encryptedInputs = await cofheClient
    .encryptInputs(vector.map((v) => Encryptable.uint64(BigInt(v))))
    .execute();

  const encryptedVector = encryptedInputs.map((enc) => [
    enc.ctHash,
    enc.securityZone,
    enc.utype,
    enc.signature,
  ]);

  // Step 3: Submit match transaction
  const tx = await _contract.matchIntent(encryptedVector);
  const receipt = await tx.wait();

  // Parse taskId from MatchSubmitted event
  const { ethers } = await import("ethers");
  const iface = new ethers.Interface(EAX_ABI);
  let taskId;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "MatchSubmitted") {
        taskId = parsed.args[0];
        break;
      }
    } catch {}
  }

  if (taskId === undefined) throw new Error("Could not parse MatchSubmitted event");

  // Step 4: Read both encrypted handles + threshold decrypt
  const task = await _contract.tasks(taskId);
  const winnerCtHash = task[0]; // euint8 handle (winnerIndex)
  const scoreCtHash  = task[1]; // euint64 handle (winnerScore)

  await cofheClient.permits.getOrCreateSelfPermit();

  // Decrypt winner index
  const winnerResult = await _decryptWithRetry(cofheClient, winnerCtHash, "winner index");
  // Decrypt match score
  const scoreResult = await _decryptWithRetry(cofheClient, scoreCtHash, "match score");

  const winnerIndex = Number(winnerResult.decryptedValue);
  const winnerScore = Number(scoreResult.decryptedValue);

  // Compute match quality from on-chain advertiser data
  const advData = await _contract.getAdvertiser(winnerIndex);
  let maxPossible = 0;
  for (let i = 0; i < 5; i++) {
    maxPossible += Number(advData[0][i]) * 100;
  }
  const quality = maxPossible > 0 ? Math.round((winnerScore * 100) / maxPossible) : 0;

  // Step 5: Reveal match on-chain with both decrypted values
  const revealTx = await _contract.revealMatch(
    taskId,
    winnerIndex,
    winnerResult.signature,
    winnerScore,
    scoreResult.signature
  );
  await revealTx.wait();

  console.log(`[EAX SDK] Match revealed | Advertiser: ${winnerIndex} | Score: ${winnerScore} | Quality: ${quality}% | Task: ${taskId}`);

  return {
    advertiserId: winnerIndex,
    score: winnerScore,
    maxScore: maxPossible,
    quality,
    taskId: taskId.toString(),
    txHash: tx.hash,
  };
}

/**
 * Read the user's active advertiser assignment directly from the contract.
 * Returns null if user has no active match.
 * Includes match quality data for score-proportional reward estimation.
 * 
 * @param {string} [userAddress] - defaults to connected wallet
 * @returns {{ advertiserId: number, score: number, maxScore: number, quality: number } | null}
 */
export async function getActiveAdvertiser(userAddress) {
  if (!_contract) throw new Error("Call initEAX() first");
  const addr = userAddress || _userAddress;

  const hasMatch = await _contract.hasActiveMatch(addr);
  if (!hasMatch) return null;

  const advId = Number(await _contract.activeAdvertiser(addr));
  const score = Number(await _contract.matchScore(addr));
  const maxScore = Number(await _contract.matchMaxScore(addr));
  const quality = maxScore > 0 ? Math.round((score * 100) / maxScore) : 0;

  return { advertiserId: advId, score, maxScore, quality };
}

/**
 * Call recordImpression() on-chain — triggers score-proportional payout to user.
 * Payout = bid × (matchScore / maxScore) from advertiser's locked budget.
 * Should be called when the ad is actually displayed.
 * 
 * @returns {{ txHash: string, payoutWei: string, payoutATTN: number, advertiserId: number }}
 */
export async function recordImpression() {
  if (!_contract) throw new Error("Call initEAX() first");

  const advId = Number(await _contract.activeAdvertiser(_userAddress));
  const tx = await _contract.recordImpression();
  const receipt = await tx.wait();

  // Parse payout from ImpressionRecorded event (uint256 payoutWei)
  const { ethers } = await import("ethers");
  const iface = new ethers.Interface(EAX_ABI);
  let payoutWei = BigInt(0);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "ImpressionRecorded") {
        payoutWei = parsed.args[2]; // uint256 payoutWei
        break;
      }
    } catch {}
  }

  const payoutATTN = Number(ethers.formatEther(payoutWei));
  console.log(`[EAX SDK] Impression recorded | Payout: ${payoutATTN.toFixed(4)} ATTN (${payoutWei} wei)`);
  return { txHash: tx.hash, payoutWei: payoutWei.toString(), payoutATTN, advertiserId: advId };
}

// ── Internal: CoFHE decryption with retry ───────────────────────

async function _decryptWithRetry(cofheClient, ctHash, label) {
  const MAX_RETRIES = 12;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await cofheClient
        .decryptForTx(ctHash)
        .withPermit()
        .execute();
      return result;
    } catch (err) {
      const is428 = err?.message?.includes("428") || err?.message?.includes("Precondition");
      if (is428 && attempt < MAX_RETRIES) {
        console.log(`[EAX SDK] CoFHE still computing ${label} (attempt ${attempt}/${MAX_RETRIES}). Retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Threshold decryption of ${label} timed out after ${MAX_RETRIES} attempts.`);
}

// ── Internal: extension bridge ──────────────────────────────────

function _waitForExtensionVector(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Timed out waiting for extension vector. Is the EAX extension installed?"));
    }, timeoutMs);

    function handler(event) {
      if (event.data?.type === "EAX_USER_VECTOR_TO_APP") {
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(event.data.vector);
      }
    }

    window.addEventListener("message", handler);
  });
}

// Export config getter for api.js
export function getConfig() {
  return _config;
}
export function getUserAddress() {
  return _userAddress;
}
