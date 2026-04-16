"use client";
import { useState, useEffect, useRef } from "react";
import { ethers, BrowserProvider } from "ethers";
import EAXJson from "../../contracts/out/EAX.sol/EAX.json";
import Link from "next/link";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const CATEGORIES = ["CRYPTO", "AI", "FINANCE", "GAMING", "DEV"];

export default function PublisherDemo() {
  const [status, setStatus] = useState("Connecting wallet...");
  const [ad, setAd] = useState<any>(null);
  const [impression, setImpression] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [matchInfo, setMatchInfo] = useState<{ score: number; maxScore: number; quality: number; bid: number; advVector: number[] } | null>(null);

  useEffect(() => { checkAndServe(); }, []);

  const checkAndServe = async () => {
    try {
      if (!window.ethereum) { setStatus("No wallet detected. Install MetaMask."); setLoading(false); return; }
      const provider = new BrowserProvider(window.ethereum as any);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const userAddress = await signer.getAddress();
      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "";
      if (!contractAddress) { setStatus("Contract address not configured."); setLoading(false); return; }

      const contract = new ethers.Contract(contractAddress, EAXJson.abi, signer);
      const hasMatch = await contract.hasActiveMatch(userAddress);
      if (!hasMatch) {
        setStatus("No active ad match found. Run a match first.");
        setLoading(false);
        return;
      }

      const advId = Number(await contract.activeAdvertiser(userAddress));

      // Read match score data
      const score = Number(await contract.matchScore(userAddress));
      const maxScore = Number(await contract.matchMaxScore(userAddress));
      const quality = maxScore > 0 ? Math.round((score * 100) / maxScore) : 0;

      // Read advertiser data for bid + vector
      const advData = await contract.getAdvertiser(advId);
      const advVector = Array.from({ length: 5 }, (_, i) => Number(advData[0][i]));
      const bid = Number(advData[1]);

      setMatchInfo({ score, maxScore, quality, bid, advVector });
      setStatus(`Match found — Advertiser #${advId} · ${quality}% match quality. Loading ad...`);

      const res = await fetch(`${BACKEND_URL}/getAd/${advId}`);
      if (!res.ok) {
        setStatus(`Advertiser #${advId} has no creative uploaded yet.`);
        setLoading(false);
        return;
      }

      const adData = await res.json();
      setAd(adData);
      setStatus(`Serving ad from Advertiser #${advId}`);
      setLoading(false);
    } catch (e: any) {
      setStatus("Error: " + e.message);
      setLoading(false);
    }
  };

  const handleRecordImpression = async () => {
    try {
      setStatus("Confirm impression in wallet...");
      const provider = new BrowserProvider(window.ethereum as any);
      const signer = await provider.getSigner();
      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "";
      const contract = new ethers.Contract(contractAddress, EAXJson.abi, signer);

      const tx = await contract.recordImpression();
      setStatus("Recording on-chain...");
      const receipt = await tx.wait();

      const iface = new ethers.Interface(EAXJson.abi);
      let payoutWei = BigInt(0), advId = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "ImpressionRecorded") { advId = Number(parsed.args[1]); payoutWei = parsed.args[2]; break; }
        } catch { }
      }

      const payoutATTN = Number(ethers.formatEther(payoutWei));
      setImpression({ txHash: tx.hash, payout: payoutATTN, advId, quality: matchInfo?.quality || 0 });
      setStatus(`✓ Earned ${payoutATTN.toFixed(4)} ATTN!`);
    } catch (e: any) {
      setStatus("Error: " + (e.reason || e.message));
    }
  };

  return (
    <div className="min-h-screen bg-[#030303] text-white font-sans">
      {/* Top nav */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-xl font-display">EAX</span>
          <span className="text-xs text-white/40 font-mono">protocol</span>
        </Link>
        <div className="flex gap-3">
          <Link href="/advertiser" className="text-white/50 hover:text-white text-sm transition-colors px-4 py-2 border border-white/10 rounded-lg hover:border-white/25">
            For Advertisers
          </Link>
          <Link href="/" className="text-white/50 hover:text-white text-sm transition-colors px-4 py-2 border border-white/10 rounded-lg hover:border-white/25">
            ← Home
          </Link>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-12">
          <span className="inline-flex items-center gap-3 text-sm font-mono text-white/40 mb-4">
            <span className="w-8 h-px bg-white/20" />
            Publisher Demo
          </span>
          <h1 className="text-5xl lg:text-6xl font-display tracking-tight text-white mb-4">
            Serve ads.
            <br />
            <span className="text-white/50">Earn ATTN.</span>
          </h1>
          <p className="text-lg text-white/50 leading-relaxed max-w-xl">
            This page simulates a publisher website using the EAX SDK.
            It reads the on-chain match, fetches the ad creative, and records impressions for payout.
          </p>
        </div>

        {/* SDK preview */}
        <div className="bg-white/[0.03] border border-white/10 rounded-xl p-6 mb-8">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-xs font-mono text-white/30 bg-white/[0.05] px-2.5 py-1 rounded">integration.js</span>
            <span className="text-xs text-white/20">How this page works</span>
          </div>
          <pre className="text-sm text-white/60 font-mono leading-relaxed overflow-x-auto"><code>{`import { initEAX, getAd, renderAd } from "eax-sdk";

await initEAX({ contractAddress, backendUrl });
const ad = await getAd();     // reads chain + fetches creative
await renderAd(slot, ad);     // renders + triggers payout`}</code></pre>
        </div>

        {/* Match Quality Panel */}
        {matchInfo && !impression && (
          <div className="bg-white/[0.02] border border-white/10 rounded-xl p-6 mb-8">
            <div className="text-[10px] text-white/30 font-mono uppercase tracking-widest mb-4">Match Quality Analysis</div>
            <div className="flex items-center gap-6">
              {/* Quality ring */}
              <div className="relative w-20 h-20 flex-shrink-0">
                <svg className="w-20 h-20 -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,0.06)" strokeWidth="8" fill="none" />
                  <circle
                    cx="50" cy="50" r="42"
                    stroke={matchInfo.quality > 70 ? 'rgba(52,211,153,0.8)' : matchInfo.quality > 40 ? 'rgba(255,255,255,0.6)' : 'rgba(248,113,113,0.6)'}
                    strokeWidth="8" fill="none" strokeLinecap="round"
                    strokeDasharray={`${matchInfo.quality * 2.64} 264`}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-lg font-display text-white">{matchInfo.quality}%</span>
                </div>
              </div>
              {/* Score details */}
              <div className="flex-1 space-y-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-white/30">Dot Product Score</span>
                  <span className="text-white/70">{matchInfo.score.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-white/30">Max Possible</span>
                  <span className="text-white/70">{matchInfo.maxScore.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-white/30">Advertiser Bid</span>
                  <span className="text-white/70">{matchInfo.bid} ATTN</span>
                </div>
                <div className="flex justify-between text-xs font-mono border-t border-white/[0.08] pt-2">
                  <span className="text-white/50">Est. Payout</span>
                  <span className="text-white font-bold">{matchInfo.maxScore > 0 ? (matchInfo.bid * matchInfo.score / matchInfo.maxScore).toFixed(4) : '0'} ATTN</span>
                </div>
              </div>
            </div>
            {/* Advertiser vector */}
            <div className="mt-4 pt-4 border-t border-white/[0.06] flex gap-1">
              {matchInfo.advVector.map((w, i) => (
                <div key={i} className="flex-1 text-center">
                  <div className="text-[9px] text-white/20 font-mono mb-1">{CATEGORIES[i]}</div>
                  <span className={`text-[11px] font-mono px-1 py-0.5 rounded ${w > 50 ? 'bg-white/15 text-white' : w > 0 ? 'bg-white/[0.06] text-white/50' : 'text-white/15'
                    }`}>{w}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status */}
        <div className="flex items-center gap-3 bg-white/[0.03] border border-white/10 rounded-xl px-5 py-3 mb-8">
          {loading && <span className="w-2 h-2 rounded-full bg-white/40 animate-pulse"></span>}
          <span className={`text-sm font-mono ${status.startsWith("✓") ? "text-emerald-400" : status.startsWith("Error") ? "text-red-400" : "text-white/60"}`}>
            {status}
          </span>
        </div>

        {/* Ad Slot */}
        {ad && !impression && (
          <div className="space-y-6">
            {/* The ad card */}
            <div className="border border-white/10 rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
                <span className="text-xs font-mono text-white/30 uppercase tracking-widest">Ad Slot — EAX SDK</span>
                <span className="text-[11px] text-white/20 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  Privacy-preserving
                </span>
              </div>

              <div className="p-8 flex justify-center">
                <div className="max-w-sm w-full">
                  {ad.image && (
                    <img src={ad.image} alt={ad.title} className="w-full rounded-xl mb-6 object-cover max-h-[200px] border border-white/10" />
                  )}
                  <div className="flex items-center gap-2.5 mb-3">
                    <span className="bg-white/10 border border-white/15 px-2.5 py-0.5 rounded text-[11px] text-white/60 tracking-wide font-mono">EAX AD</span>
                  </div>
                  <h3 className="text-2xl font-display text-white mb-4">{ad.title}</h3>
                  <a
                    href={ad.link} target="_blank" rel="noopener noreferrer"
                    className="inline-block bg-white text-black px-6 py-2.5 rounded-lg font-semibold text-sm hover:bg-white/90 transition-colors"
                  >
                    {ad.cta || "Learn More"}
                  </a>
                  <p className="mt-4 text-[11px] text-white/30">🔒 Matched via encrypted intent vectors</p>
                </div>
              </div>
            </div>

            {/* Record impression */}
            <button
              onClick={handleRecordImpression}
              className="w-full bg-white text-black text-base font-bold py-4 rounded-xl hover:bg-white/90 transition-all duration-200 transform hover:-translate-y-0.5 active:translate-y-0 shadow-[0_0_30px_rgba(255,255,255,0.1)]"
            >
              Confirm Impression → Earn ATTN
            </button>
            <p className="text-xs text-white/30 text-center">
              Calls <code className="text-white/50">recordImpression()</code> on-chain. You receive the advertiser&apos;s bid in ATTN tokens.
            </p>
          </div>
        )}

        {/* Payout result */}
        {impression && (
          <div className="border border-emerald-500/20 rounded-2xl p-10 text-center bg-emerald-500/[0.03]">
            <span className="text-emerald-400 text-lg font-semibold">Impression Recorded</span>
            <div className="text-6xl font-display text-white mt-4 mb-3">+{impression.payout.toFixed(4)} ATTN</div>
            {impression.quality > 0 && (
              <div className="flex items-center justify-center gap-2 mb-3">
                <div className="w-24 h-1 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{
                    width: `${impression.quality}%`,
                    background: impression.quality > 70 ? 'rgba(52,211,153,0.8)' : 'rgba(255,255,255,0.5)'
                  }} />
                </div>
                <span className="text-xs font-mono text-white/40">{impression.quality}% match</span>
              </div>
            )}
            <p className="text-white/40 text-sm mb-6">
              Earned for viewing Advertiser #{impression.advId}&apos;s ad
            </p>
            <div className="bg-white/[0.03] border border-white/10 rounded-lg p-4 font-mono text-xs text-emerald-400/70 break-all mb-6">
              Tx: {impression.txHash}
            </div>
            <Link href="/" className="text-white/50 hover:text-white text-sm underline underline-offset-4 transition-colors">
              Back to home →
            </Link>
          </div>
        )}

        {/* No match state */}
        {!ad && !loading && (
          <div className="border border-white/10 rounded-2xl p-12 text-center">
            <div className="text-4xl mb-4">📡</div>
            <h2 className="text-2xl font-display text-white mb-3">No ad to serve</h2>
            <p className="text-white/40 text-sm mb-8 max-w-md mx-auto">
              No active match found for your wallet. Run a match on the main dApp first, then come back here to see the served ad.
            </p>
            <Link
              href="/app"
              className="inline-block bg-white text-black px-8 py-3 rounded-xl font-bold text-sm hover:bg-white/90 transition-colors"
            >
              Run a Match First →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
