/**
 * eax-sdk/api.js
 * 
 * Backend API calls + ad rendering
 * Handles: fetching ad creatives, rendering ad cards
 */

import { getConfig, getUserAddress, getActiveAdvertiser, recordImpression } from "./contract.js";

function shouldUsePurchaseAgent(ad, options = {}) {
  if (options.enablePurchasingAgent === false) return false;
  if (options.enablePurchasingAgent === true) return true;

  const purchaseAmount = Number(ad?.purchaseAmount || ad?.price || options.purchaseAmount || 0);
  return purchaseAmount > 0 || Boolean(ad?.requiresConfirmation);
}

function buildPurchasePayload(ad, options = {}) {
  const userAddress = getUserAddress();
  const purchaseAmount = Number(ad?.purchaseAmount || ad?.price || options.purchaseAmount || 0);

  return {
    userAddress,
    merchantId: options.merchantId || ad?.merchantId || `merchant-${ad?.advertiserId ?? "unknown"}`,
    productUrl: ad?.link,
    title: ad?.title,
    adId: ad?.advertiserId,
    amount: purchaseAmount,
    currency: options.purchaseCurrency || ad?.purchaseCurrency || "USDC",
    requiresConfirmation: options.requiresConfirmation ?? ad?.requiresConfirmation ?? purchaseAmount > 25,
    metadata: options.metadata || {},
    idempotencyKey:
      options.idempotencyKey ||
      `purchase:${String(userAddress || "anonymous").toLowerCase()}:${String(ad?.advertiserId ?? "x")}:${String(ad?.link ?? "")}:${purchaseAmount}`,
  };
}

async function submitPurchaseIntent(ad, options = {}) {
  const config = getConfig();
  if (!config?.backendUrl) {
    throw new Error("Call initEAX() first");
  }

  const payload = buildPurchasePayload(ad, options);
  if (!payload.userAddress) {
    throw new Error("A connected wallet is required for purchase authorization");
  }

  const response = await fetch(`${config.backendUrl}/agent/purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let result;
  if (response.headers.get("content-type")?.includes("application/json")) {
    result = await response.json();
  } else {
    try {
      result = await response.json();
    } catch {
      const text = await response.text();
      throw new Error(`Unexpected response: ${response.status} ${text.slice(0, 100)}`);
    }
  }

  if (!response.ok && result?.error) {
    throw new Error(result.error);
  }

  return result;
}

async function confirmPurchaseIntent(requestId, options = {}) {
  const config = getConfig();
  if (!config?.backendUrl) {
    throw new Error("Call initEAX() first");
  }

  const payload = {
    approved: options.approved !== false,
    approvedBy: options.approvedBy || getUserAddress(),
    mode: options.mode || "manual",
  };

  const response = await fetch(`${config.backendUrl}/agent/purchase/${requestId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let result;
  if (response.headers.get("content-type")?.includes("application/json")) {
    result = await response.json();
  } else {
    try {
      result = await response.json();
    } catch {
      const text = await response.text();
      throw new Error(`Unexpected response: ${response.status} ${text.slice(0, 100)}`);
    }
  }

  if (!response.ok && result?.error) {
    throw new Error(result.error);
  }

  return result;
}

/**
 * Get the matched ad for the current user.
 * Reads activeAdvertiser from the contract, then fetches the creative from the backend.
 * 
 * @param {string} [userAddress] - defaults to connected wallet
 * @returns {Object|null} Ad creative object or null if no active match
 */
export async function getAd(userAddress) {
  const config = getConfig();
  if (!config) throw new Error("Call initEAX() first");

  // Read assignment from chain
  const match = await getActiveAdvertiser(userAddress);
  if (!match) return null;

  // Fetch creative from backend
  const res = await fetch(`${config.backendUrl}/getAd/${match.advertiserId}`);
  if (!res.ok) {
    console.warn(`[EAX SDK] No ad creative found for advertiser ${match.advertiserId}`);
    return null;
  }

  return await res.json();
}

/**
 * Render an ad into a DOM container and trigger on-chain impression (payout).
 * 
 * @param {HTMLElement} container - DOM element to render the ad into
 * @param {Object} ad - Ad creative object from getAd()
 * @param {Object} [options]
 * @param {boolean} [options.triggerImpression=true] - Whether to call recordImpression on-chain
 * @returns {{ txHash?: string, payout?: number }}
 */
export async function renderAd(container, ad, options = {}) {
  const { 
      triggerImpression = true, 
      interactive = false,
      onImpressionRecorded = null,
      enablePurchasingAgent,
  if (!container || !ad) {
    console.warn("[EAX SDK] renderAd: missing container or ad");
    return {};
  }

  // Create a unique ID for the button to avoid conflicts if multiple ads render
  const uniqueId = Math.random().toString(36).substr(2, 9);
  const btnId = `eax-btn-${uniqueId}`;
  const statusId = `eax-status-${uniqueId}`;
  const ctaId = `eax-cta-${uniqueId}`;

  // Render the ad card
  container.innerHTML = `
    <div style="
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1px solid rgba(139, 92, 246, 0.3);
      border-radius: 16px;
      padding: 24px;
      max-width: 400px;
      font-family: system-ui, -apple-system, sans-serif;
      color: #fff;
      box-shadow: 0 8px 32px rgba(139, 92, 246, 0.15);
      transition: transform 0.2s, box-shadow 0.2s;
    " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 12px 40px rgba(139,92,246,0.25)'"
       onmouseout="this.style.transform='none';this.style.boxShadow='0 8px 32px rgba(139,92,246,0.15)'">
      ${ad.image ? `<img src="${ad.image}" alt="${ad.title}" style="
        width: 100%;
        border-radius: 12px;
        margin-bottom: 16px;
        object-fit: cover;
        max-height: 200px;
      " />` : ""}
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span style="
          background: rgba(139, 92, 246, 0.2);
          border: 1px solid rgba(139, 92, 246, 0.4);
          padding: 2px 8px;
          border-radius: 6px;
          font-size: 11px;
          color: #a78bfa;
          letter-spacing: 0.5px;
        ">EAX AD</span>
        <span style="font-size: 11px; color: #666;">Privacy-Preserving</span>
      </div>
      <h3 style="
        margin: 0 0 12px 0;
        font-size: 20px;
        font-weight: 700;
        background: linear-gradient(to right, #a78bfa, #ec4899);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      ">${ad.title}</h3>
      <a href="${ad.link}" id="${ctaId}" target="_blank" rel="noopener noreferrer" style="
        display: inline-block;
        background: linear-gradient(to right, #8b5cf6, #ec4899);
        color: #fff;
        padding: 10px 24px;
        border-radius: 10px;
        text-decoration: none;
        font-weight: 600;
        font-size: 14px;
        transition: opacity 0.2s;
      " onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">${ad.cta || "Learn More"}</a>
      
      ${interactive ? `
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(139, 92, 246, 0.2);">
          <button id="${btnId}" style="
            width: 100%;
            background: rgba(139, 92, 246, 0.1);
            border: 1px solid #8b5cf6;
            color: #a78bfa;
            padding: 12px;
            border-radius: 8px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s;
          " onmouseover="this.style.background='rgba(139, 92, 246, 0.2)'" onmouseout="this.style.background='rgba(139, 92, 246, 0.1)'">
            Confirm Impression & Earn ATTN
          </button>
          <p id="${statusId}" style="margin-top: 8px; font-size: 12px; color: #ef4444; text-align: center; display: none;"></p>
        </div>
      ` : `
        <div style="margin-top: 12px; font-size: 11px; color: #555; display: flex; align-items: center; gap: 4px;">
          🔒 Matched via encrypted intent · You earned ATTN for viewing
        </div>
      `}
    </div>
  `;

  const ctaEl = container.querySelector(`#${ctaId}`);
  if (ctaEl && shouldUsePurchaseAgent(ad, { ...options, enablePurchasingAgent })) {
    ctaEl.addEventListener("click", async (event) => {
      event.preventDefault();

      const originalLabel = ctaEl.textContent || ad.cta || "Learn More";
      ctaEl.textContent = "Checking purchase policy...";
      ctaEl.style.pointerEvents = "none";
      ctaEl.style.opacity = "0.75";

      try {
        const preview = await submitPurchaseIntent(ad, options);

        if (preview.status === "declined") {
          ctaEl.textContent = originalLabel;
          ctaEl.style.pointerEvents = "auto";
          ctaEl.style.opacity = "1";
          if (onPurchaseDecision) onPurchaseDecision(preview);
          console.warn("[EAX SDK] Purchase declined:", preview.reasons?.join(", ") || "policy blocked");
          return;
        }

        let finalized = preview;
        if (preview.status === "pending_confirmation") {
          const approval = confirmPurchaseCallback
            ? await confirmPurchaseCallback(preview)
            : window.confirm(
                `Approve ${preview.amount} ${preview.currency} purchase from ${preview.title}?`
              );

          if (approval === false) {
            finalized = await confirmPurchaseIntent(preview.requestId, { approved: false, mode: "manual" });
            ctaEl.textContent = originalLabel;
            ctaEl.style.pointerEvents = "auto";
            ctaEl.style.opacity = "1";
            if (onPurchaseDecision) onPurchaseDecision(finalized);
            return;
          }

          finalized = await confirmPurchaseIntent(preview.requestId, { approved: true, mode: "manual" });
        }

        if (onPurchaseDecision) onPurchaseDecision(finalized);

        // Try opening in new tab, fallback to same tab
        const purchaseWindow = window.open(ad.link, "_blank", "noopener,noreferrer");
        if (!purchaseWindow) {
          window.location.assign(ad.link);
        }

        ctaEl.textContent = originalLabel;
        ctaEl.style.pointerEvents = "auto";
        ctaEl.style.opacity = "1";
      } catch (err) {
        console.warn("[EAX SDK] Purchase flow failed:", err.message);
        ctaEl.textContent = originalLabel;
        ctaEl.style.pointerEvents = "auto";
        ctaEl.style.opacity = "1";
        if (onPurchaseDecision) onPurchaseDecision({ status: "error", error: err.message });
      }
    });
  }

  if (interactive) {
    const btn = container.querySelector(`#${btnId}`);
    const statusEl = container.querySelector(`#${statusId}`);
    
    if (btn && statusEl) {
      btn.addEventListener("click", async () => {
        btn.innerText = "Processing Transaction...";
        btn.style.opacity = "0.7";
        btn.style.pointerEvents = "none";
        statusEl.style.display = "none";
        
        try {
          const result = await recordImpression();
          
          btn.style.display = "none";
          statusEl.style.display = "block";
          statusEl.style.color = "#10b981";
          statusEl.innerHTML = `✅ Successfully earned +${result.payout} ATTN`;
          
          if (onImpressionRecorded) {
            onImpressionRecorded(result);
          }
        } catch (err) {
          console.warn("[EAX SDK] Impression recording failed:", err.message);
          btn.innerText = "Confirm Impression & Earn ATTN";
          btn.style.opacity = "1";
          btn.style.pointerEvents = "auto";
          statusEl.style.display = "block";
          statusEl.style.color = "#ef4444";
          statusEl.innerText = "Transaction failed or rejected.";
        }
      });
    }
    return { interactive: true };
  }

  // Auto trigger fallback
  if (triggerImpression) {
    try {
      const result = await recordImpression();
      console.log(`[EAX SDK] Ad rendered + auto-impression recorded | Payout: ${result.payout} ATTN`);
      return result;
    } catch (err) {
      console.warn("[EAX SDK] Auto-impression failed:", err.message);
      return {};
    }
  }

  return {};
}
