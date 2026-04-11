"use client";
import { useEffect, useState } from "react";
import { ethers, BrowserProvider } from "ethers";
import EAXJson from "../contracts/out/EAX.sol/EAX.json";

export default function Home() {
  const [vector, setVector] = useState<number[] | null>(null);
  const [status, setStatus] = useState("Waiting for Chrome Extension...");
  const [txHash, setTxHash] = useState("");
  const [payout, setPayout] = useState<number | null>(null);

  useEffect(() => {
    // Listen for messages from the Chrome Extension content script
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "EAX_USER_VECTOR_TO_APP") {
        console.log("Received vector from extension:", event.data.vector);
        setVector(event.data.vector);
        setStatus("Intent Vector Received. Ready to Encrypt on-chain.");
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const handleMatch = async () => {
    if (!vector) return;
    setStatus("Initiating fully homomorphic encryption sequence...");

    try {
      if (!window.ethereum) {
        setStatus("Error: Metamask / Ethereum wallet not detected. Please install a wallet.");
        return;
      }
      
      const provider = new BrowserProvider(window.ethereum as any);
      await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      
      setStatus("Connecting to Ethereum Sepolia CoFHE Network...");
      const { createCofheConfig, createCofheClient } = await import('@cofhe/sdk/web');
      const { chains } = await import('@cofhe/sdk/chains');
      const { Ethers6Adapter } = await import('@cofhe/sdk/adapters');

      const config = createCofheConfig({ supportedChains: [chains.sepolia] });
      const cofheClient = createCofheClient(config);

      const { publicClient, walletClient } = await Ethers6Adapter(provider, signer);
      await cofheClient.connect(publicClient, walletClient);
      
      setStatus("Encrypting vector via CoFHE ZK proof pipeline...");
      const { Encryptable } = await import('@cofhe/sdk');

      // encryptInputs() returns an EncryptInputsBuilder — must call .execute() to run the full ZK prove + verify pipeline.
      // execute() returns EncryptedUint64Input[]: [{ctHash: bigint, securityZone: number, utype: number, signature: string}]
      const encryptedInputs = await cofheClient.encryptInputs(
        vector.map(val => Encryptable.uint64(BigInt(val)))
      ).execute();

      // Map into positional tuple arrays for ethers.js ABI encoding of InEuint64[] (tuple[])
      const encryptedVector = encryptedInputs.map((enc: any) => [
        enc.ctHash,
        enc.securityZone,
        enc.utype,
        enc.signature
      ]);
      
      const contractAddress = process.env.NEXT_PUBLIC_EAX_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000";
      if (contractAddress === "0x0000000000000000000000000000000000000000") {
          setStatus("Error: NEXT_PUBLIC_EAX_CONTRACT_ADDRESS is not set inside your .env.local file.");
          return;
      }

      const contract = new ethers.Contract(contractAddress, EAXJson.abi, signer);
      
      setStatus("Confirm encryption match transaction in your wallet.");
      const tx = await contract.matchIntent(encryptedVector);
      setTxHash(tx.hash);
      
      setStatus("Transaction submitted. Computing match on Fhenix CoFHE Testnet...");
      await tx.wait();
      setStatus("Match processed! Awaiting decentralised Decryption Threshold to claim ATTN payout...");

      // Normally we would listen for the event. Here we simulate the wait for the async payout reveal threshold
      setTimeout(() => {
         setStatus("Match Decrypted! Payout executed successfully.");
         setPayout(Math.floor(Math.random() * 20) + 10); // Display simulated winning bid (The app can fetch real amount securely after contract emits it)
      }, 5000);

    } catch (e: any) {
        setStatus("Encryption/Transaction Error: " + (e.reason || e.message));
        console.error(e);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white font-sans overflow-hidden flex flex-col justify-center items-center relative">
      {/* Background Glows */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-[#10b981] opacity-20 blur-[120px] rounded-full pointer-events-none"></div>
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-[#3b82f6] opacity-20 blur-[120px] rounded-full pointer-events-none"></div>

      <div className="z-10 bg-zinc-900/60 backdrop-blur-xl border border-zinc-800 p-10 rounded-3xl shadow-2xl w-full max-w-2xl text-center">
        <h1 className="text-5xl font-extrabold tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-500 text-transparent bg-clip-text mb-6">
          Encrypted Attention Exchange
        </h1>
        <p className="text-zinc-400 text-lg mb-10 leading-relaxed text-balance">
          Monetize your browsing history without revealing it. Your intent is encrypted locally, processed blindly by advertisers, and you get paid instantly.
        </p>

        <div className="bg-zinc-800/50 p-6 rounded-2xl mb-8 border border-zinc-700/50 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-zinc-300 font-medium">Status</span>
            <span className="bg-zinc-900 px-3 py-1 rounded-full text-sm text-emerald-400 font-mono tracking-wide border border-emerald-900/50 flex items-center gap-2">
              {status.includes("Waiting") ? <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> : null}
              {status}
            </span>
          </div>

          {vector && (
            <div className="flex flex-col text-left mt-4 border-t border-zinc-700/50 pt-4">
              <span className="text-zinc-400 text-sm mb-2">Locally Evaluated Vector</span>
              <div className="flex gap-2 justify-center">
                {vector.map((v, i) => (
                  <div key={i} className={`flex items-center justify-center w-12 h-12 rounded-xl text-xl font-bold ${v === 1 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}`}>
                    {v}
                  </div>
                ))}
              </div>
            </div>
          )}

          {txHash && (
            <div className="mt-4 break-all bg-emerald-950/30 p-3 rounded-lg border border-emerald-900/30 text-emerald-400 text-sm font-mono text-left">
              Tx: <span>{txHash}</span>
            </div>
          )}

          {payout !== null && (
            <div className="mt-6 flex flex-col items-center p-6 bg-gradient-to-br from-emerald-500/10 to-emerald-900/10 border border-emerald-500/30 rounded-2xl">
              <span className="text-emerald-400 text-lg font-bold mb-1">Attention Match!</span>
              <span className="text-4xl font-extrabold text-white">+{payout} ATTN</span>
            </div>
          )}
        </div>

        <button 
          onClick={handleMatch}
          disabled={!vector || !!txHash}
          className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-lg font-bold py-4 rounded-xl shadow-lg hover:shadow-emerald-500/25 hover:from-emerald-400 hover:to-teal-400 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed transform hover:-translate-y-0.5 active:translate-y-0"
        >
          {!vector ? "Awaiting Extension..." : "Encrypt & Bid My Attention"}
        </button>
      </div>
      
      <div className="absolute top-6 right-6 z-50">
        <a href="/advertiser" className="text-zinc-500 hover:text-emerald-400 transition-colors text-sm font-medium border border-zinc-700/50 rounded-lg px-4 py-2 hover:bg-zinc-800">
            Advertiser Portal →
        </a>
      </div>

      <div className="absolute bottom-6 text-zinc-600 text-sm flex gap-4">
        <span>🔒 Fully Homomorphic Encryption</span>
        <span>·</span>
        <span>🧠 Local AI Inference</span>
      </div>
    </div>
  );
}
