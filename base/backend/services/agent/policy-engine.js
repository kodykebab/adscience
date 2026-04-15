function countRecentAttempts(requests, walletAddress, windowMs, now) {
  return requests.filter((request) => {
    if (request.userAddress !== walletAddress) return false;
    if (request.status === "voided") return false;
    return now - request.createdAtMs <= windowMs;
  }).length;
}

function countDuplicateIntents(requests, intent, windowMs, now) {
  return requests.filter((request) => {
    if (request.userAddress !== intent.userAddress) return false;
    if (request.merchantId !== intent.merchantId) return false;
    if (request.productUrl !== intent.productUrl) return false;
    if (request.currency !== intent.currency) return false;
    if (request.amount !== intent.amount) return false;
    return now - request.createdAtMs <= windowMs;
  }).length;
}

function evaluatePurchasePolicy(intent, context = {}, policy = {}) {
  const reasons = [];
  let riskScore = 0;

  const amount = Number(intent.amount || 0);
  const available = Number(context.availableBalance ?? 0);
  const revoked = Boolean(context.revoked);
  const currency = String(intent.currency || "USDC").toUpperCase();

  const approvalThreshold = Number(policy.approvalThreshold ?? 25);
  const confirmationThreshold = Number(policy.confirmationThreshold ?? 250);
  const hardLimit = Number(policy.hardLimit ?? 5000);
  const rateLimitWindowMs = Number(policy.rateLimitWindowMs ?? 60_000);
  const duplicateWindowMs = Number(policy.duplicateWindowMs ?? 5 * 60_000);
  const maxAttemptsPerWindow = Number(policy.maxAttemptsPerWindow ?? 3);

  if (!policy.allowedCurrencies || policy.allowedCurrencies.length === 0) {
    policy.allowedCurrencies = ["USDC", "ATTN"];
  }

  if (!policy.allowedCurrencies.includes(currency)) {
    return {
      decision: "declined",
      requiresConfirmation: false,
      riskScore: 100,
      reasons: [`currency ${currency} is not allowed`],
      action: "unsupported_currency",
    };
  }

  if (revoked || intent.userPermissionsRevoked) {
    return {
      decision: "declined",
      requiresConfirmation: false,
      riskScore: 100,
      reasons: ["user permissions revoked"],
      action: "permissions_revoked",
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      decision: "declined",
      requiresConfirmation: false,
      riskScore: 100,
      reasons: ["purchase amount must be greater than zero"],
      action: "invalid_amount",
    };
  }

  if (amount > hardLimit) {
    return {
      decision: "declined",
      requiresConfirmation: false,
      riskScore: 100,
      reasons: [`amount exceeds hard limit of ${hardLimit}`],
      action: "hard_limit_exceeded",
    };
  }

  if (available < amount) {
    return {
      decision: "declined",
      requiresConfirmation: false,
      riskScore: 90,
      reasons: ["insufficient balance"],
      action: "insufficient_balance",
    };
  }

  const recentAttempts = context.recentAttempts || 0;
  if (recentAttempts >= maxAttemptsPerWindow) {
    riskScore += 35;
    reasons.push(`too many attempts in the last ${Math.round(rateLimitWindowMs / 1000)}s`);
  }

  const duplicateCount = context.duplicateCount || 0;
  if (duplicateCount > 0) {
    riskScore += 45;
    reasons.push("duplicate purchase detected");
  }

  if (context.firstTimeMerchant) {
    riskScore += 10;
    reasons.push("first-time merchant");
  }

  if (amount > approvalThreshold) {
    riskScore += 20;
    reasons.push(`amount exceeds auto-approval threshold of ${approvalThreshold}`);
  }

  if (intent.forceManualReview) {
    riskScore += 100;
    reasons.push("manual review requested");
  }

  if (intent.requiresConfirmation || amount > approvalThreshold || riskScore >= 25) {
    return {
      decision: "pending_confirmation",
      requiresConfirmation: true,
      riskScore: Math.min(99, riskScore || 25),
      reasons,
      action: amount > confirmationThreshold ? "manual_approval_required" : "user_confirmation_required",
    };
  }

  return {
    decision: "approved",
    requiresConfirmation: false,
    riskScore,
    reasons,
    action: "auto_approved",
  };
}

module.exports = {
  evaluatePurchasePolicy,
  countRecentAttempts,
  countDuplicateIntents,
};