require("dotenv").config({ path: "../../super_new_new_frontend/.env.local" });
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

// In-memory data stores
const ads = new Map();       // advertiserId → ad creative
const matches = [];          // { advertiserId, user, txHash, timestamp }
const impressions = [];      // { advertiserId, user, payoutWei, payoutATTN, txHash, timestamp }

// Contract configuration
const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS
  || "0x33786a4bee9587b673e874b8f8a07e11f2d23820";
const ATTN_ADDRESS = process.env.NEXT_PUBLIC_ATTN_TOKEN_ADDRESS
  || "0x4b5af68fa19759806f78235b535cd50d69979838";

// Use the same RPC that wagmi uses for transactions
const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

// ABI matches merged EAX.sol:
//   MatchRevealed(address user, uint8 advertiserId, uint64 score, uint64 maxScore)
//   ImpressionRecorded(address user, uint8 advertiserId, uint256 payoutWei)
const EAX_ABI = [
  "event MatchRevealed(address indexed user, uint8 advertiserId, uint64 score, uint64 maxScore)",
  "event ImpressionRecorded(address indexed user, uint8 advertiserId, uint256 payoutWei)",
  "event AdvertiserRegistered(uint256 indexed id, address indexed addr, uint64 bid)",
  "function getAdvertiser(uint256) view returns (uint64[5] vector, uint64 bid, uint256 balance, address addr, bool active)",
  "function nextAdvertiserId() view returns (uint256)"
];

let provider;
let contract;
let listenersAttached = false;

// Blockchain indexer logic
async function startIndexer() {
  console.log("[Indexer] Connecting to chain...");

  try {
    provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
      staticNetwork: true,
      batchMaxCount: 1
    });
    contract = new ethers.Contract(CONTRACT_ADDRESS, EAX_ABI, provider);

    // Attempt historical sync within a timeout
    await Promise.race([
      syncHistorical(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))
    ]);
  } catch (err) {
    console.log(`[Indexer] Historical sync skipped: ${err.message}`);
  }

  // Attach live listeners regardless of history sync
  attachListeners();
}

async function syncHistorical() {
  const latestBlock = await provider.getBlockNumber();
  // Only query 10k blocks back to avoid rate limits on free RPCs
  const fromBlock = Math.max(0, latestBlock - 10000);
  console.log(`[Indexer] Querying events from block ${fromBlock} to ${latestBlock}...`);

  const [matchEvents, impEvents] = await Promise.all([
    contract.queryFilter("MatchRevealed", fromBlock, latestBlock),
    contract.queryFilter("ImpressionRecorded", fromBlock, latestBlock),
  ]);

  for (const ev of matchEvents) {
    matches.push({
      advertiserId: Number(ev.args[1]),
      user: ev.args[0],
      score: Number(ev.args[2]),
      maxScore: Number(ev.args[3]),
      txHash: ev.transactionHash,
      timestamp: Date.now() - 60000 // approximate
    });
  }
  for (const ev of impEvents) {
    const payoutWei = ev.args[2];
    impressions.push({
      advertiserId: Number(ev.args[1]),
      user: ev.args[0],
      payoutWei: payoutWei.toString(),
      payoutATTN: Number(ethers.formatEther(payoutWei)),
      txHash: ev.transactionHash,
      timestamp: Date.now() - 60000
    });
  }

  console.log(`[Indexer] Synced ${matchEvents.length} matches, ${impEvents.length} impressions from chain.`);
}

function attachListeners() {
  if (listenersAttached || !contract) return;
  listenersAttached = true;

  console.log(`[Indexer] Listening for live events on ${CONTRACT_ADDRESS.slice(0, 10)}...`);

  contract.on("MatchRevealed", (user, advertiserId, score, maxScore, ev) => {
    console.log(`[Event] MatchRevealed → adv #${advertiserId}, score ${score}/${maxScore}`);
    matches.push({
      advertiserId: Number(advertiserId),
      user,
      score: Number(score),
      maxScore: Number(maxScore),
      txHash: ev.log.transactionHash,
      timestamp: Date.now()
    });
  });

  contract.on("ImpressionRecorded", (user, advertiserId, payoutWei, ev) => {
    const payoutATTN = Number(ethers.formatEther(payoutWei));
    console.log(`[Event] ImpressionRecorded → adv #${advertiserId}, payout ${payoutATTN} ATTN`);
    impressions.push({
      advertiserId: Number(advertiserId),
      user,
      payoutWei: payoutWei.toString(),
      payoutATTN,
      txHash: ev.log.transactionHash,
      timestamp: Date.now()
    });
  });
}

// Start indexer (non-blocking — server starts even if RPC is slow)
startIndexer();

// API Routes

// GET /analytics?advertiserId=N
app.get("/analytics", (req, res) => {
  const advId = Number(req.query.advertiserId);
  if (isNaN(advId)) return res.status(400).json({ error: "Missing advertiserId" });

  const advMatches = matches.filter(m => m.advertiserId === advId);
  const advImps   = impressions.filter(i => i.advertiserId === advId);

  // --- total spend (in ATTN) ---
  const totalSpend = advImps.reduce((s, i) => s + i.payoutATTN, 0);

  // --- spend rate (ATTN / min) ---
  let spendRate = 0;
  if (advImps.length >= 2) {
    const sorted = [...advImps].sort((a, b) => a.timestamp - b.timestamp);
    const windowMs = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
    if (windowMs > 0) spendRate = totalSpend / (windowMs / 60000);
  }

  // --- avg payout interval ---
  let avgPayoutInterval = "N/A";
  if (advImps.length >= 2) {
    const sorted = [...advImps].sort((a, b) => a.timestamp - b.timestamp);
    const windowMs = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;
    const avgMs = windowMs / (sorted.length - 1);
    const secs = Math.round(avgMs / 1000);
    avgPayoutInterval = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`;
  }

  // --- win rate (this advertiser's matches / all matches) ---
  const winRate = matches.length > 0 ? advMatches.length / matches.length : 0;

  // --- remaining budget (estimate: initial budget from registration - total spend) ---
  const ad = ads.get(advId);
  const initialBudget = ad ? ad.budget || 0 : 0;
  const remainingBudget = Math.max(0, initialBudget - totalSpend);

  res.json({
    impressions: advImps.length,
    totalSpend: Number(totalSpend.toFixed(4)),
    spendRate: Number(spendRate.toFixed(4)),
    avgPayoutInterval,
    winRate: Number(winRate.toFixed(2)),
    remainingBudget: Number(remainingBudget.toFixed(4)),
    matchCount: advMatches.length,
  });
});

// Health endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    ads: ads.size,
    matchesLogged: matches.length,
    impressionsLogged: impressions.length
  });
});

// Register ad creative
app.post("/registerAd", (req, res) => {
  const { advertiserId, title, image, cta, link, budget } = req.body;
  if (advertiserId === undefined || !title || !link) {
    return res.status(400).json({ error: "Missing required fields: advertiserId, title, link" });
  }

  ads.set(Number(advertiserId), {
    advertiserId: Number(advertiserId),
    title,
    image: image || "",
    cta: cta || "Learn More",
    link,
    budget: Number(budget) || 0,
    registeredAt: Date.now(),
  });

  console.log(`[Ad] Registered #${advertiserId}: "${title}"`);
  res.json({ success: true, advertiserId: Number(advertiserId) });
});

// Fetch ad creative
app.get("/getAd/:advertiserId", (req, res) => {
  const id = Number(req.params.advertiserId);
  const ad = ads.get(id);
  if (!ad) return res.status(404).json({ error: "No ad creative found", advertiserId: id });
  res.json(ad);
});

// List all ads
app.get("/ads", (_req, res) => {
  res.json(Array.from(ads.values()));
});

// Server initialization
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  EAX Analytics Backend on :${PORT}       ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  GET  /analytics?advertiserId=X      ║`);
  console.log(`  ║  POST /registerAd                    ║`);
  console.log(`  ║  GET  /getAd/:advertiserId           ║`);
  console.log(`  ║  GET  /health                        ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
