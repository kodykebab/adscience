"use client";
import { useState, useEffect, useRef } from "react";
import { ethers, BrowserProvider } from "ethers";
import EAXJson from "../../contracts/out/EAX.sol/EAX.json";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";
const CATEGORIES = ["CRYPTO", "AI", "FINANCE", "GAMING", "DEV"];

export default function PublisherDemo() {
  const [status, setStatus] = useState("Checking wallet...");
  const [ad, setAd] = useState<any>(null);
  const [impression, setImpression] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [matchInfo, setMatchInfo] = useState<{ score: number; maxScore: number; quality: number; bid: number; advVector: number[] } | null>(null);
  const adContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkAndServe();
  }, []);

  const checkAndServe = async () => {
    try {
      if (!window.ethereum) {
        setStatus("No wallet detected. Install MetaMask.");
        setLoading(false);
        return;
      }

      const provider = new BrowserProvider(window.ethereum as any);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const userAddress = await signer.getAddress();

      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "";
      if (!contractAddress) {
        setStatus("Contract address not configured.");
        setLoading(false);
        return;
      }

      const contract = new ethers.Contract(contractAddress, EAXJson.abi, signer);

      // Read activeAdvertiser from chain
      const hasMatch = await contract.hasActiveMatch(userAddress);
      if (!hasMatch) {
        setStatus("No active ad assignment. Run a match first on the main page.");
        setLoading(false);
        return;
      }

      const advId = Number(await contract.activeAdvertiser(userAddress));

      // Read match score data from chain
      const score = Number(await contract.matchScore(userAddress));
      const maxScore = Number(await contract.matchMaxScore(userAddress));
      const quality = maxScore > 0 ? Math.round((score * 100) / maxScore) : 0;

      // Read advertiser data for bid and vector using explicit getter
      const advData = await contract.getAdvertiser(advId);
      // getAdvertiser returns: (uint64[5] vector, uint64 bid, uint256 balance, address addr, bool active)
      const advVector = Array.from({ length: 5 }, (_, i) => Number(advData[0][i]));
      const bid = Number(advData[1]);
      const estimatedPayout = maxScore > 0 ? (bid * score / maxScore) : 0;

      setMatchInfo({ score, maxScore, quality, bid, advVector });
      setStatus(`Active match found! Advertiser #${advId} | ${quality}% match quality | Est. payout: ${estimatedPayout.toFixed(2)} ATTN`);

      // Fetch ad creative from backend
      const res = await fetch(`${BACKEND_URL}/getAd/${advId}`);
      if (!res.ok) {
        setStatus(`Advertiser #${advId} has no ad creative registered. Ask the advertiser to upload one.`);
        setLoading(false);
        return;
      }

      const adData = await res.json();
      setAd(adData);
      setLoading(false);

    } catch (e: any) {
      setStatus("Error: " + e.message);
      setLoading(false);
    }
  };

  const handleRecordImpression = async () => {
    try {
      setStatus("Confirm impression transaction in your wallet...");

      const provider = new BrowserProvider(window.ethereum as any);
      const signer = await provider.getSigner();
      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "";
      const contract = new ethers.Contract(contractAddress, EAXJson.abi, signer);

      const tx = await contract.recordImpression();
      setStatus("Recording impression on-chain...");
      const receipt = await tx.wait();

      // Parse ImpressionRecorded event — uint256 payoutWei
      const iface = new ethers.Interface(EAXJson.abi);
      let payoutWei = BigInt(0);
      let advId = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "ImpressionRecorded") {
            advId = Number(parsed.args[1]);
            payoutWei = parsed.args[2]; // uint256 payoutWei
            break;
          }
        } catch {}
      }

      const payoutATTN = Number(ethers.formatEther(payoutWei));
      setImpression({ txHash: tx.hash, payout: payoutATTN, advId, quality: matchInfo?.quality || 0 });
      setStatus(`Payout received! +${payoutATTN.toFixed(4)} ATTN for viewing this ad.`);

    } catch (e: any) {
      setStatus("Impression Error: " + (e.reason || e.message));
    }
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans flex flex-col justify-center items-center relative overflow-hidden">
      {/* Background */}
      <div className="absolute top-[-10%] left-[-15%] w-[50%] h-[50%] bg-[#06b6d4] opacity-15 blur-[150px] rounded-full pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-15%] w-[50%] h-[50%] bg-[#8b5cf6] opacity-15 blur-[150px] rounded-full pointer-events-none"></div>

      <div className="z-10 w-full max-w-3xl">
        {/* Header */}
        <div className="flex justify-between items-center mb-8 px-2">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-cyan-400 to-purple-500 text-transparent bg-clip-text">
              Publisher Demo
            </h1>
            <p className="text-zinc-500 text-sm mt-1">
              This simulates a third-party website using the EAX SDK to serve privacy-preserving ads.
            </p>
          </div>
          <a href="/" className="text-zinc-500 hover:text-white transition-colors text-sm font-medium border border-zinc-700/50 rounded-lg px-4 py-2 hover:bg-zinc-800">
            ← Back
          </a>
        </div>

        {/* SDK Integration Code Preview */}
        <div className="bg-zinc-900/60 backdrop-blur-xl border border-zinc-800 p-6 rounded-2xl mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-mono text-zinc-500 bg-zinc-800 px-2 py-1 rounded">integration.js</span>
            <span className="text-xs text-cyan-400/60">How this page works</span>
          </div>
          <pre className="text-sm text-zinc-400 font-mono overflow-x-auto leading-relaxed"><code>{`import { initEAX, getAd, renderAd } from "eax-sdk";

await initEAX({ contractAddress, backendUrl });
const ad = await getAd();     // reads chain + fetches creative
await renderAd(slot, ad);     // renders + triggers score-proportional payout`}</code></pre>
        </div>

        {/* Status */}
        <div className="bg-zinc-900/40 border border-zinc-800 p-4 rounded-xl mb-6 flex items-center gap-3">
          {loading && <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse"></span>}
          <span className="text-sm text-zinc-300 font-mono">{status}</span>
        </div>

        {/* Match Quality Panel */}
        {matchInfo && !impression && (
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6 mb-6">
            <div className="text-xs text-zinc-600 uppercase tracking-widest mb-4">Match Quality Analysis</div>
            <div className="flex items-center gap-6">
              {/* Quality Ring */}
              <div className="relative w-24 h-24 flex-shrink-0">
                <svg className="w-24 h-24 -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" stroke="#27272a" strokeWidth="8" fill="none" />
                  <circle
                    cx="50" cy="50" r="42"
                    stroke={matchInfo.quality > 70 ? '#10b981' : matchInfo.quality > 40 ? '#3b82f6' : '#ef4444'}
                    strokeWidth="8" fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${matchInfo.quality * 2.64} 264`}
                    className="transition-all duration-1000"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className={`text-xl font-extrabold ${matchInfo.quality > 70 ? 'text-emerald-400' : matchInfo.quality > 40 ? 'text-blue-400' : 'text-red-400'}`}>
                    {matchInfo.quality}%
                  </span>
                </div>
              </div>
              {/* Score Details */}
              <div className="flex-1 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">Dot Product Score</span>
                  <span className="text-zinc-300 font-mono">{matchInfo.score.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">Max Possible Score</span>
                  <span className="text-zinc-300 font-mono">{matchInfo.maxScore.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">Advertiser Bid</span>
                  <span className="text-zinc-300 font-mono">{matchInfo.bid} ATTN</span>
                </div>
                <div className="flex justify-between text-sm border-t border-zinc-700/50 pt-2 mt-2">
                  <span className="text-zinc-400 font-medium">Estimated Payout</span>
                  <span className="text-emerald-400 font-bold font-mono">
                    {matchInfo.maxScore > 0 ? (matchInfo.bid * matchInfo.score / matchInfo.maxScore).toFixed(4) : '0'} ATTN
                  </span>
                </div>
              </div>
            </div>
            {/* Advertiser Target Vector */}
            <div className="mt-4 pt-4 border-t border-zinc-700/50">
              <span className="text-xs text-zinc-600 uppercase tracking-wider">Advertiser Target Weights</span>
              <div className="flex gap-2 mt-2">
                {matchInfo.advVector.map((w, i) => (
                  <div key={i} className="flex-1 text-center">
                    <div className="text-[10px] text-zinc-600 mb-1">{CATEGORIES[i]}</div>
                    <div className={`text-xs font-mono px-1 py-0.5 rounded ${w > 50 ? 'bg-purple-500/20 text-purple-300' : w > 0 ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-900 text-zinc-700'}`}>
                      {w}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3">
              <p className="text-[11px] text-zinc-600">
                Formula: <code className="text-zinc-500">payout = bid × (dotProduct / maxPossible) = {matchInfo.bid} × ({matchInfo.score} / {matchInfo.maxScore})</code>
              </p>
            </div>
          </div>
        )}

        {/* Ad Slot */}
        {ad && !impression && (
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-8">
            <div className="text-xs text-zinc-600 uppercase tracking-widest mb-4">Ad Slot — Served via EAX SDK</div>
            
            <div ref={adContainerRef} className="flex justify-center mb-6">
              <div style={{
                background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
                border: "1px solid rgba(139, 92, 246, 0.3)",
                borderRadius: "16px",
                padding: "24px",
                maxWidth: "400px",
                fontFamily: "system-ui, sans-serif",
                color: "#fff",
                boxShadow: "0 8px 32px rgba(139, 92, 246, 0.15)",
              }}>
                {ad.image && (
                  <img src={ad.image} alt={ad.title} style={{
                    width: "100%",
                    borderRadius: "12px",
                    marginBottom: "16px",
                    objectFit: "cover",
                    maxHeight: "200px",
                  }} />
                )}
                <div className="flex items-center gap-2 mb-2">
                  <span className="bg-purple-500/20 border border-purple-500/40 px-2 py-0.5 rounded text-[11px] text-purple-400 tracking-wide">EAX AD</span>
                  <span className="text-[11px] text-zinc-600">Privacy-Preserving</span>
                  {matchInfo && (
                    <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded ${matchInfo.quality > 70 ? 'bg-emerald-900/30 text-emerald-400' : matchInfo.quality > 40 ? 'bg-blue-900/30 text-blue-400' : 'bg-red-900/30 text-red-400'}`}>
                      {matchInfo.quality}% match
                    </span>
                  )}
                </div>
                <h3 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-500 text-transparent bg-clip-text mb-3">{ad.title}</h3>
                <a href={ad.link} target="_blank" rel="noopener noreferrer" className="inline-block bg-gradient-to-r from-purple-600 to-pink-600 text-white px-6 py-2.5 rounded-lg font-semibold text-sm hover:opacity-85 transition-opacity">
                  {ad.cta || "Learn More"}
                </a>
                <p className="mt-3 text-[11px] text-zinc-600">🔒 Matched via encrypted weighted intent</p>
              </div>
            </div>

            <button
              onClick={handleRecordImpression}
              className="w-full bg-gradient-to-r from-cyan-600 to-purple-600 text-white text-lg font-bold py-4 rounded-xl shadow-lg hover:shadow-cyan-500/25 hover:from-cyan-500 hover:to-purple-500 transition-all duration-300 transform hover:-translate-y-0.5 active:translate-y-0"
            >
              Confirm Impression → Earn ATTN
            </button>
            <p className="text-xs text-zinc-600 mt-3 text-center">
              Payout is <strong className="text-zinc-400">score-proportional</strong>: better match quality = higher reward.
              This triggers <code className="text-zinc-500">recordImpression()</code> on-chain.
            </p>
          </div>
        )}

        {/* Payout Result */}
        {impression && (
          <div className="bg-gradient-to-br from-emerald-500/10 to-cyan-500/10 border border-emerald-500/30 rounded-2xl p-8 text-center">
            <span className="text-emerald-400 text-lg font-bold">Impression Recorded!</span>
            <div className="text-5xl font-extrabold text-white mt-4 mb-2">+{impression.payout.toFixed(4)} ATTN</div>
            <div className="flex items-center justify-center gap-3 mb-4">
              <span className="text-zinc-400 text-sm">
                Earned for viewing Advertiser #{impression.advId}&apos;s ad
              </span>
              <span className={`text-xs font-mono px-2 py-0.5 rounded ${impression.quality > 70 ? 'bg-emerald-900/30 text-emerald-400' : impression.quality > 40 ? 'bg-blue-900/30 text-blue-400' : 'bg-red-900/30 text-red-400'}`}>
                {impression.quality}% match
              </span>
            </div>
            <div className="break-all bg-zinc-900/60 p-3 rounded-lg text-emerald-400 text-xs font-mono border border-emerald-900/30">
              Tx: {impression.txHash}
            </div>
            <a href="/" className="inline-block mt-6 text-cyan-400 hover:text-cyan-300 text-sm underline underline-offset-4 transition-colors">
              Run another match →
            </a>
          </div>
        )}

        {/* No match state */}
        {!ad && !loading && (
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-8 text-center">
            <p className="text-zinc-500 text-lg mb-4">No ad to serve yet.</p>
            <a href="/" className="inline-block bg-gradient-to-r from-emerald-600 to-teal-600 text-white px-8 py-3 rounded-xl font-bold hover:opacity-90 transition-opacity">
              Run a Match First →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
