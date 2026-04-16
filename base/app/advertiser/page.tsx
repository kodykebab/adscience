"use client";
import { useState } from "react";
import Link from "next/link";
import { ethers, BrowserProvider } from "ethers";
import EAXJson from "../../contracts/out/EAX.sol/EAX.json";
import MockERC20Json from "../../contracts/out/MockERC20.sol/MockERC20.json";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

export default function RegisterAdvertiser() {
  const [bid, setBid] = useState<number>(10);
  const [budget, setBudget] = useState<number>(100);
  const [vector, setVector] = useState<number[]>([0, 0, 0, 0, 0]);
  const categories = ["crypto", "ai", "finance", "gaming", "dev"];
  const [txHash, setTxHash] = useState("");
  const [status, setStatus] = useState("Awaiting Configuration");
  const [assignedId, setAssignedId] = useState<number | null>(null);

  // Ad creative fields
  const [adTitle, setAdTitle] = useState("");
  const [adImage, setAdImage] = useState("");
  const [adCta, setAdCta] = useState("Learn More");
  const [adLink, setAdLink] = useState("");

  // Weighted slider: 0–100 per category
  const updateWeight = (index: number, value: number) => {
    const newVector = [...vector];
    newVector[index] = Math.min(100, Math.max(0, value));
    setVector(newVector);
  };

  const totalWeight = vector.reduce((a, b) => a + b, 0);

  const handleFaucet = async () => {
    setStatus("Requesting 10,000 ATTN from faucet...");
    try {
      if (!window.ethereum) {
        setStatus("Error: Metamask / Ethereum wallet not detected.");
        return;
      }
      const provider = new BrowserProvider(window.ethereum as any);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();

      const tokenAddress = process.env.NEXT_PUBLIC_ATTN_TOKEN_ADDRESS || "";
      if (!tokenAddress) {
        setStatus("Error: NEXT_PUBLIC_ATTN_TOKEN_ADDRESS is not set inside your .env.local file.");
        return;
      }
      const token = new ethers.Contract(tokenAddress, MockERC20Json.abi, signer);
      const tx = await token.faucet();
      setStatus("Waiting for faucet block confirmation...");
      await tx.wait();
      setStatus("Successfully minted 10,000 ATTN test tokens!");
    } catch (e: any) {
      setStatus("Faucet Error: " + (e.reason || e.message));
      console.error(e);
    }
  };

  const handleRegister = async () => {
    if (vector.every(v => v === 0)) {
      setStatus("Error: Set at least one category weight above 0.");
      return;
    }
    if (!adTitle || !adLink) {
      setStatus("Error: Ad title and link are required.");
      return;
    }

    setStatus("Initiating Smart Contract Registration...");

    try {
      if (!window.ethereum) {
        setStatus("Error: Metamask / Ethereum wallet not detected.");
        return;
      }

      const provider = new BrowserProvider(window.ethereum as any);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();

      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";
      const tokenAddress = process.env.NEXT_PUBLIC_ATTN_TOKEN_ADDRESS || "";
      if (contractAddress === "0x0000000000000000000000000000000000000000" || !tokenAddress) {
        setStatus("Error: NEXT_PUBLIC_EAX_CONTRACT_ADDRESS or NEXT_PUBLIC_ATTN_TOKEN_ADDRESS is not set in .env.local.");
        return;
      }

      const token = new ethers.Contract(tokenAddress, MockERC20Json.abi, signer);
      const contract = new ethers.Contract(contractAddress, EAXJson.abi, signer);

      setStatus("Approve EAX to spend your budget (Transaction 1/2)...");
      const budgetInWei = ethers.parseUnits(budget.toString(), 18);
      const approveTx = await token.approve(contractAddress, budgetInWei);
      await approveTx.wait();

      setStatus("Confirm Smart Contract Registration (Transaction 2/2)...");
      const tx = await contract.registerAdvertiser(vector, bid, budget);
      setTxHash(tx.hash);

      setStatus("Waiting for block confirmation...");
      const receipt = await tx.wait();

      // Parse AdvertiserRegistered event to get the assigned ID
      const iface = new ethers.Interface(EAXJson.abi);
      let advertiserId: number | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === 'AdvertiserRegistered') {
            advertiserId = Number(parsed.args[0]);
            break;
          }
        } catch {}
      }

      if (advertiserId === undefined) {
        setStatus("On-chain registration confirmed but could not parse advertiser ID.");
        return;
      }

      setAssignedId(advertiserId);
      setStatus(`On-chain registration confirmed! Advertiser ID: ${advertiserId}. Uploading ad creative...`);

      // POST ad creative to backend
      const res = await fetch(`${BACKEND_URL}/registerAd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          advertiserId,
          title: adTitle,
          image: adImage,
          cta: adCta,
          link: adLink,
          budget,
        }),
      });

      if (!res.ok) {
        setStatus(`On-chain OK (ID: ${advertiserId}) but ad creative upload failed. Is the backend running on ${BACKEND_URL}?`);
        return;
      }

      setStatus(`Advertiser #${advertiserId} fully registered! Weighted targeting + ad creative live.`);

    } catch (e: any) {
      setStatus("Registration Error: " + (e.reason || e.message));
      console.error(e);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans flex flex-col justify-center items-center relative overflow-hidden">

      {/* Background Glows */}
      <div className="absolute top-[0%] left-[-20%] w-[60%] h-[60%] bg-[#8b5cf6] opacity-20 blur-[150px] rounded-full pointer-events-none"></div>
      <div className="absolute bottom-[0%] right-[-20%] w-[60%] h-[60%] bg-[#ec4899] opacity-10 blur-[150px] rounded-full pointer-events-none"></div>

      <div className="z-10 bg-zinc-900/40 backdrop-blur-3xl border border-zinc-800/80 p-10 rounded-3xl shadow-2xl w-full max-w-2xl">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-purple-400 to-pink-500 text-transparent bg-clip-text">
            Advertiser Portal
          </h1>
          <Link href="/" className="text-zinc-500 hover:text-white transition-colors text-sm font-medium border border-zinc-700/50 rounded-lg px-4 py-2 hover:bg-zinc-800">
            ← Back to User Match
          </Link>
        </div>

        <p className="text-zinc-400 text-lg mb-8 leading-relaxed">
          Target encrypted intent with weighted precision. Set category relevance weights (0–100), your bid, deposit a budget, and upload your ad creative.
        </p>

        <div className="space-y-6">
          {/* Weighted Category Targeting */}
          <div className="bg-zinc-800/40 p-6 rounded-2xl border border-zinc-700/50">
            <div className="flex justify-between items-center mb-4">
              <label className="text-zinc-300 font-medium text-sm tracking-wide uppercase">Target Interest Weights</label>
              <span className="text-xs text-zinc-500 font-mono">Total: {totalWeight}/500</span>
            </div>
            <div className="space-y-4">
              {categories.map((cat, i) => (
                <div key={cat} className="flex items-center gap-4">
                  <span className={`w-20 text-sm font-bold uppercase tracking-wide ${vector[i] > 0 ? 'text-purple-300' : 'text-zinc-600'}`}>
                    {cat}
                  </span>
                  <div className="flex-1 relative">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={vector[i]}
                      onChange={(e) => updateWeight(i, parseInt(e.target.value))}
                      className="w-full h-2 rounded-full appearance-none cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, #8b5cf6 0%, #ec4899 ${vector[i]}%, #27272a ${vector[i]}%, #27272a 100%)`,
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={vector[i]}
                      onChange={(e) => updateWeight(i, parseInt(e.target.value) || 0)}
                      className="w-16 bg-zinc-900 text-white text-center text-sm font-mono p-1.5 rounded-lg border border-zinc-700 focus:outline-none focus:border-purple-500"
                    />
                    <span className="text-zinc-600 text-xs">%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Vector Preview */}
          <div className="bg-zinc-800/30 px-4 py-3 rounded-xl border border-zinc-700/30 flex items-center gap-3">
            <span className="text-zinc-500 text-xs font-mono">vec:</span>
            <div className="flex gap-2">
              {vector.map((v, i) => (
                <span key={i} className={`text-sm font-mono px-2 py-0.5 rounded ${v > 50 ? 'bg-purple-500/20 text-purple-300' : v > 0 ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-900 text-zinc-600'}`}>
                  {v}
                </span>
              ))}
            </div>
          </div>

          {/* Bid & Budget */}
          <div className="bg-zinc-800/40 p-6 rounded-2xl border border-zinc-700/50 flex flex-col sm:flex-row gap-4 items-center">
            <div className="flex-1">
              <label className="block text-zinc-300 font-medium mb-2 text-sm tracking-wide uppercase">Max Bid (ATTN)</label>
              <input
                type="number"
                min="1"
                value={bid}
                onChange={(e) => setBid(parseInt(e.target.value) || 0)}
                className="bg-zinc-900 text-white font-bold text-2xl w-full sm:w-32 p-3 text-center rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors"
              />
              <p className="text-xs text-zinc-500 mt-2">
                Max payout per impression. Score-proportional: <span className="text-purple-400 font-mono">bid × (matchScore / maxScore)</span>
              </p>
            </div>

            <div className="flex-1 border-t sm:border-t-0 sm:border-l border-zinc-700/50 pt-4 sm:pt-0 sm:pl-4">
              <label className="block text-zinc-300 font-medium mb-2 text-sm tracking-wide uppercase">Total Budget (ATTN)</label>
              <input
                type="number"
                min="1"
                value={budget}
                onChange={(e) => setBudget(parseInt(e.target.value) || 0)}
                className="bg-zinc-900 text-white font-bold text-2xl w-full sm:w-32 p-3 text-center rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors"
              />
              <p className="text-xs text-zinc-500 mt-2">Locked up to fund these bids.</p>
            </div>
          </div>

          <div className="flex justify-start">
            <button onClick={handleFaucet} className="px-4 py-2 bg-zinc-800 border border-zinc-700 hover:border-purple-500 hover:text-purple-400 rounded-lg text-sm text-zinc-400 transition-colors shadow-sm">
              💧 Faucet: Get 10,000 Test ATTN
            </button>
          </div>

          {/* Ad Creative */}
          <div className="bg-zinc-800/40 p-6 rounded-2xl border border-zinc-700/50 space-y-4">
            <label className="block text-zinc-300 font-medium mb-1 text-sm tracking-wide uppercase">Ad Creative</label>
            <input
              type="text"
              placeholder="Ad Title (e.g. Buy Crypto Today)"
              value={adTitle}
              onChange={(e) => setAdTitle(e.target.value)}
              className="w-full bg-zinc-900 text-white p-3 rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors text-sm"
            />
            <input
              type="url"
              placeholder="Image URL (optional)"
              value={adImage}
              onChange={(e) => setAdImage(e.target.value)}
              className="w-full bg-zinc-900 text-white p-3 rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors text-sm"
            />
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="CTA Button Text"
                value={adCta}
                onChange={(e) => setAdCta(e.target.value)}
                className="flex-1 bg-zinc-900 text-white p-3 rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors text-sm"
              />
              <input
                type="url"
                placeholder="Landing Page URL"
                value={adLink}
                onChange={(e) => setAdLink(e.target.value)}
                className="flex-1 bg-zinc-900 text-white p-3 rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors text-sm"
              />
            </div>
          </div>

          <div className="flex items-center justify-between px-2">
            <span className="text-zinc-400 text-sm">{status}</span>
            {assignedId !== null && <span className="bg-purple-900/40 px-3 py-1 rounded-full text-purple-400 text-xs font-mono border border-purple-800/50">ID: {assignedId}</span>}
          </div>

          {/* Action */}
          <button
            onClick={handleRegister}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white text-lg font-bold py-4 rounded-xl shadow-lg hover:shadow-purple-500/25 hover:from-purple-500 hover:to-pink-500 transition-all duration-300 transform hover:-translate-y-0.5 active:translate-y-0 mt-4"
          >
            Register Weighted Target + Ad Creative
          </button>
        </div>
      </div>
    </div>
  );
}
