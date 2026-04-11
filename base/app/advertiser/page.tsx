"use client";
import { useState } from "react";
import Link from "next/link";
import { ethers, BrowserProvider } from "ethers";

// Minimal ABI required for EAX Advertiser capabilities
const EAX_ABI = [
  "function registerAdvertiser(uint64[5] calldata _vector, uint64 _bid) external"
];

export default function RegisterAdvertiser() {
  const [bid, setBid] = useState<number>(10);
  const [vector, setVector] = useState<number[]>([0, 0, 0, 0, 0]);
  const categories = ["crypto", "ai", "finance", "gaming", "dev"];
  const [txHash, setTxHash] = useState("");
  const [status, setStatus] = useState("Awaiting Configuration");

  const toggleCategory = (index: number) => {
    const newVector = [...vector];
    newVector[index] = newVector[index] === 1 ? 0 : 1;
    setVector(newVector);
  };

  const handleRegister = async () => {
    if (vector.every(v => v === 0)) {
      setStatus("Error: Select at least one category to target.");
      return;
    }
    
    setStatus("Initiating Smart Contract Registration...");
    
    try {
      if (!window.ethereum) {
        setStatus("Error: Metamask / Ethereum wallet not detected.");
        return;
      }
      
      const provider = new BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []); // Prompts metamask connection
      const signer = await provider.getSigner();

      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";
      if (contractAddress === "0x0000000000000000000000000000000000000000") {
          setStatus("Error: NEXT_PUBLIC_EAX_CONTRACT_ADDRESS is not set inside your .env.local file.");
          return;
      }

      const contract = new ethers.Contract(contractAddress, EAX_ABI, signer);
      
      setStatus("Confirm transaction in your wallet...");
      const tx = await contract.registerAdvertiser(vector, bid);
      setTxHash(tx.hash);
      
      setStatus("Waiting for block confirmation...");
      await tx.wait();

      setStatus("Advertiser successfully registered! ID: " + tx.hash);
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
          Target encrypted intent blindly. Select the categories your ads apply to, and set your max bid. EAX handles the matching securely over CoFHE.
        </p>

        <div className="space-y-6">
            {/* Categories */}
            <div className="bg-zinc-800/40 p-6 rounded-2xl border border-zinc-700/50">
                <label className="block text-zinc-300 font-medium mb-3 text-sm tracking-wide uppercase">Select Target Interests</label>
                <div className="flex flex-wrap gap-3">
                    {categories.map((cat, i) => (
                    <button 
                        key={cat} 
                        onClick={() => toggleCategory(i)}
                        className={`px-5 py-3 rounded-xl text-sm font-bold transition-all duration-200 border ${
                            vector[i] === 1 
                                ? 'bg-purple-500/20 text-purple-300 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.2)]' 
                                : 'bg-zinc-900/50 text-zinc-500 border-zinc-700 hover:border-zinc-500'
                        }`}
                    >
                        {cat.toUpperCase()} ({vector[i]})
                    </button>
                    ))}
                </div>
            </div>

            {/* Bid Map */}
            <div className="bg-zinc-800/40 p-6 rounded-2xl border border-zinc-700/50 flex gap-4 items-center">
                <div className="flex-1">
                    <label className="block text-zinc-300 font-medium mb-2 text-sm tracking-wide uppercase">Your Max Bid (ATTN)</label>
                    <p className="text-xs text-zinc-500 max-w-sm mb-3">
                        This is what you pay when an encrypted user matches your targeting fully. Higher bids prioritize your brand.
                    </p>
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                    <input 
                        type="number" 
                        min="1" 
                        value={bid} 
                        onChange={(e) => setBid(parseInt(e.target.value) || 0)}
                        className="bg-zinc-900 text-white font-bold text-2xl w-32 p-3 text-center rounded-xl border border-zinc-700 focus:outline-none focus:border-purple-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex items-center justify-between px-2">
                <span className="text-zinc-400 text-sm">{status}</span>
                {txHash && <span className="bg-purple-900/40 px-3 py-1 rounded-full text-purple-400 text-xs font-mono border border-purple-800/50">{txHash}</span>}
            </div>

            {/* Action */}
            <button 
                onClick={handleRegister}
                className="w-full bg-gradient-to-r from-purple-600 to-pink-600 text-white text-lg font-bold py-4 rounded-xl shadow-lg hover:shadow-purple-500/25 hover:from-purple-500 hover:to-pink-500 transition-all duration-300 transform hover:-translate-y-0.5 active:translate-y-0 mt-4"
            >
                Register Intent Target
            </button>
        </div>
      </div>
      
    </div>
  );
}
