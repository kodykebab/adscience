const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory ad creative storage ────────────────────────────────
// Maps advertiserId (number) → ad creative object
const ads = new Map();

// ── Routes ───────────────────────────────────────────────────────

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ads: ads.size });
});

// Register ad creative (called by advertiser portal after on-chain registration)
app.post("/registerAd", (req, res) => {
  const { advertiserId, title, image, cta, link } = req.body;

  if (advertiserId === undefined || !title || !link) {
    return res.status(400).json({ error: "Missing required fields: advertiserId, title, link" });
  }

  ads.set(Number(advertiserId), {
    advertiserId: Number(advertiserId),
    title,
    image: image || "",
    cta: cta || "Learn More",
    link,
    registeredAt: Date.now(),
  });

  console.log(`[Ad Registered] ID: ${advertiserId} | Title: "${title}"`);
  res.json({ success: true, advertiserId: Number(advertiserId) });
});

// Fetch ad creative by advertiser ID (called by SDK after reading activeAdvertiser from chain)
app.get("/getAd/:advertiserId", (req, res) => {
  const id = Number(req.params.advertiserId);
  const ad = ads.get(id);

  if (!ad) {
    return res.status(404).json({ error: "No ad creative found for this advertiser", advertiserId: id });
  }

  res.json(ad);
});

// List all registered ads (debugging / admin)
app.get("/ads", (_req, res) => {
  res.json(Array.from(ads.values()));
});

// ── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  EAX Ad Server running on :${PORT}      ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  POST /registerAd                    ║`);
  console.log(`  ║  GET  /getAd/:advertiserId           ║`);
  console.log(`  ║  GET  /ads                           ║`);
  console.log(`  ║  GET  /health                        ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
