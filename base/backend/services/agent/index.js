const crypto = require("crypto");
const path = require("path");
const { createAuditLogStore } = require("./audit-log");
const { createMockLocusClient } = require("./mock-locus");
const { evaluatePurchasePolicy, countRecentAttempts, countDuplicateIntents } = require("./policy-engine");

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}

function createPurchasingAgentService(options = {}) {
  const auditLog = createAuditLogStore(
    options.auditLogPath || path.join(process.cwd(), "audit", "purchase-agent.jsonl")
  );
  const locus = createMockLocusClient({
    defaultBalances: options.defaultBalances,
    logger: (type, payload) => auditLog.append({ type: `locus:${type}`, ...payload }),
  });

  const requests = new Map();
  const idempotencyIndex = new Map();
  const revokedWallets = new Set();

  const policy = {
    approvalThreshold: options.approvalThreshold ?? 25,
    confirmationThreshold: options.confirmationThreshold ?? 250,
    hardLimit: options.hardLimit ?? 5000,
    rateLimitWindowMs: options.rateLimitWindowMs ?? 60_000,
    duplicateWindowMs: options.duplicateWindowMs ?? 5 * 60_000,
    maxAttemptsPerWindow: options.maxAttemptsPerWindow ?? 3,
    allowedCurrencies: options.allowedCurrencies || ["USDC", "ATTN"],
  };

  function getRecentRequests(userAddress) {
    const normalized = normalizeAddress(userAddress);
    return Array.from(requests.values()).filter((request) => request.userAddress === normalized);
  }

  function serializeRequest(request) {
    if (!request) return null;
    const balance = locus.getBalance(request.userAddress, request.currency);
    return {
      requestId: request.requestId,
      status: request.status,
      decision: request.decision,
      userAddress: request.userAddress,
      merchantId: request.merchantId,
      productUrl: request.productUrl,
      title: request.title,
      adId: request.adId,
      amount: request.amount,
      currency: request.currency,
      requiresConfirmation: request.requiresConfirmation,
      riskScore: request.riskScore,
      reasons: request.reasons,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      expiresAt: request.expiresAt,
      idempotencyKey: request.idempotencyKey,
      approval: request.approval || null,
      payment: request.payment || null,
      balance,
    };
  }

  function buildContext(intent) {
    const recentRequests = getRecentRequests(intent.userAddress);
    const now = Date.now();
    const recentAttempts = countRecentAttempts(recentRequests, normalizeAddress(intent.userAddress), policy.rateLimitWindowMs, now);
    const duplicateCount = countDuplicateIntents(recentRequests, intent, policy.duplicateWindowMs, now);
    const balance = locus.getBalance(intent.userAddress, intent.currency);
    const firstTimeMerchant = !recentRequests.some((request) => request.merchantId === intent.merchantId && request.status === "completed");

    return {
      now,
      recentAttempts,
      duplicateCount,
      firstTimeMerchant,
      availableBalance: balance.available,
      revoked: revokedWallets.has(normalizeAddress(intent.userAddress)) || balance.revoked,
    };
  }

  async function previewPurchase(rawIntent) {
    const intent = {
      userAddress: normalizeAddress(rawIntent.userAddress),
      merchantId: String(rawIntent.merchantId || rawIntent.advertiserId || rawIntent.adId || "unknown-merchant"),
      productUrl: String(rawIntent.productUrl || rawIntent.link || ""),
      title: String(rawIntent.title || rawIntent.productTitle || "Untitled purchase"),
      adId: rawIntent.adId !== undefined ? Number(rawIntent.adId) : null,
      amount: Number(rawIntent.amount || rawIntent.purchaseAmount || 0),
      currency: String(rawIntent.currency || rawIntent.purchaseCurrency || "USDC").toUpperCase(),
      requiresConfirmation: Boolean(rawIntent.requiresConfirmation),
      forceManualReview: Boolean(rawIntent.forceManualReview),
      metadata: rawIntent.metadata || {},
      idempotencyKey: String(rawIntent.idempotencyKey || rawIntent.purchaseId || crypto.randomUUID()),
      walletPermissionsRevoked: Boolean(rawIntent.walletPermissionsRevoked),
    };

    if (!intent.userAddress) {
      throw new Error("userAddress is required");
    }

    if (!intent.productUrl) {
      throw new Error("productUrl is required");
    }

    if (intent.amount < 0) {
      throw new Error("amount cannot be negative");
    }

    const existingRequestId = idempotencyIndex.get(intent.idempotencyKey);
    if (existingRequestId) {
      const existing = requests.get(existingRequestId);
      return {
        ...serializeRequest(existing),
        idempotent: true,
      };
    }

    const context = buildContext(intent);
    const policyDecision = evaluatePurchasePolicy(intent, context, policy);

    const requestId = crypto.randomUUID();
    const request = {
      requestId,
      userAddress: intent.userAddress,
      merchantId: intent.merchantId,
      productUrl: intent.productUrl,
      title: intent.title,
      adId: intent.adId,
      amount: intent.amount,
      currency: intent.currency,
      requiresConfirmation: policyDecision.requiresConfirmation,
      riskScore: policyDecision.riskScore,
      reasons: policyDecision.reasons,
      decision: policyDecision.decision,
      status: policyDecision.decision,
      idempotencyKey: intent.idempotencyKey,
      metadata: intent.metadata,
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      approval: null,
      payment: null,
      authorizationId: null,
    };

    if (policyDecision.decision === "declined") {
      requests.set(requestId, request);
      idempotencyIndex.set(intent.idempotencyKey, requestId);
      auditLog.append({
        type: "purchase.declined",
        requestId,
        userAddress: request.userAddress,
        merchantId: request.merchantId,
        productUrl: request.productUrl,
        amount: request.amount,
        currency: request.currency,
        reasons: policyDecision.reasons,
        riskScore: policyDecision.riskScore,
      });

      return serializeRequest(request);
    }

    const authorization = locus.authorizeTransfer({
      walletAddress: request.userAddress,
      merchantId: request.merchantId,
      currency: request.currency,
      amount: request.amount,
      requestId,
    });

    request.authorizationId = authorization.authorizationId;

    if (policyDecision.decision === "pending_confirmation") {
      request.status = "pending_confirmation";
      request.updatedAt = new Date().toISOString();
      requests.set(requestId, request);
      idempotencyIndex.set(intent.idempotencyKey, requestId);

      auditLog.append({
        type: "purchase.pending_confirmation",
        requestId,
        userAddress: request.userAddress,
        merchantId: request.merchantId,
        productUrl: request.productUrl,
        amount: request.amount,
        currency: request.currency,
        reasons: policyDecision.reasons,
        riskScore: policyDecision.riskScore,
        authorizationId: authorization.authorizationId,
      });

      return {
        ...serializeRequest(request),
        message: "User confirmation required before settlement.",
      };
    }

    const payment = locus.captureTransfer({ authorizationId: authorization.authorizationId });
    request.status = "completed";
    request.updatedAt = new Date().toISOString();
    request.payment = payment;
    request.approval = {
      approvedBy: "policy-engine",
      approvedAt: new Date().toISOString(),
      mode: "auto",
    };
    requests.set(requestId, request);
    idempotencyIndex.set(intent.idempotencyKey, requestId);

    auditLog.append({
      type: "purchase.completed",
      requestId,
      userAddress: request.userAddress,
      merchantId: request.merchantId,
      productUrl: request.productUrl,
      amount: request.amount,
      currency: request.currency,
      transactionHash: payment.transactionHash,
      transactionId: payment.transactionId,
      authorizationId: authorization.authorizationId,
    });

    return serializeRequest(request);
  }

  async function confirmPurchase(requestId, input = {}) {
    const request = requests.get(requestId);
    if (!request) {
      throw new Error("purchase request not found");
    }

    if (request.status === "completed") {
      return serializeRequest(request);
    }

    if (request.status !== "pending_confirmation") {
      throw new Error(`request is not pending confirmation (current status: ${request.status})`);
    }

    if (new Date(request.expiresAt).getTime() < Date.now()) {
      locus.voidTransfer({ authorizationId: request.authorizationId });
      request.status = "expired";
      request.updatedAt = new Date().toISOString();
      auditLog.append({
        type: "purchase.expired",
        requestId,
        userAddress: request.userAddress,
        merchantId: request.merchantId,
      });
      return serializeRequest(request);
    }

    if (revokedWallets.has(request.userAddress) || locus.getBalance(request.userAddress, request.currency).revoked) {
      locus.voidTransfer({ authorizationId: request.authorizationId });
      request.status = "declined";
      request.updatedAt = new Date().toISOString();
      request.decision = "declined";
      request.reasons = ["user permissions revoked"];
      auditLog.append({
        type: "purchase.revoked",
        requestId,
        userAddress: request.userAddress,
        merchantId: request.merchantId,
      });
      return serializeRequest(request);
    }

    if (input.approved === false) {
      locus.voidTransfer({ authorizationId: request.authorizationId });
      request.status = "declined";
      request.updatedAt = new Date().toISOString();
      request.decision = "declined";
      request.reasons = ["user declined confirmation"];
      auditLog.append({
        type: "purchase.user_declined",
        requestId,
        userAddress: request.userAddress,
        merchantId: request.merchantId,
      });
      return serializeRequest(request);
    }

    const payment = locus.captureTransfer({ authorizationId: request.authorizationId });
    request.status = "completed";
    request.updatedAt = new Date().toISOString();
    request.approval = {
      approvedBy: normalizeAddress(input.approvedBy || request.userAddress),
      approvedAt: new Date().toISOString(),
      mode: input.mode || "manual",
    };
    request.payment = payment;

    auditLog.append({
      type: "purchase.confirmed",
      requestId,
      userAddress: request.userAddress,
      merchantId: request.merchantId,
      productUrl: request.productUrl,
      amount: request.amount,
      currency: request.currency,
      transactionHash: payment.transactionHash,
      transactionId: payment.transactionId,
      approvedBy: request.approval.approvedBy,
    });

    return serializeRequest(request);
  }

  function revokePermissions(userAddress, reason = "revoked-by-user") {
    const normalized = normalizeAddress(userAddress);
    revokedWallets.add(normalized);
    locus.revokeWallet(normalized, reason);

    auditLog.append({
      type: "purchase.permissions_revoked",
      userAddress: normalized,
      reason,
    });

    return {
      userAddress: normalized,
      revoked: true,
      reason,
    };
  }

  function restorePermissions(userAddress) {
    const normalized = normalizeAddress(userAddress);
    revokedWallets.delete(normalized);
    locus.restoreWallet(normalized);

    auditLog.append({
      type: "purchase.permissions_restored",
      userAddress: normalized,
    });

    return {
      userAddress: normalized,
      revoked: false,
    };
  }

  function getRequest(requestId) {
    return serializeRequest(requests.get(requestId));
  }

  function listRequests(filter = {}) {
    return Array.from(requests.values())
      .filter((request) => {
        if (filter.userAddress && request.userAddress !== normalizeAddress(filter.userAddress)) return false;
        if (filter.status && request.status !== filter.status) return false;
        if (filter.merchantId && request.merchantId !== String(filter.merchantId)) return false;
        return true;
      })
      .map(serializeRequest);
  }

  function getAuditTrail(filter = {}) {
    return auditLog.list(filter);
  }

  function seedWalletBalance(userAddress, currency, amount) {
    return locus.seedBalance(normalizeAddress(userAddress), currency, amount);
  }

  function health() {
    return {
      ok: true,
      pendingRequests: listRequests({ status: "pending_confirmation" }).length,
      completedRequests: listRequests({ status: "completed" }).length,
      declinedRequests: listRequests({ status: "declined" }).length,
      revokedWallets: revokedWallets.size,
      auditEvents: auditLog.size,
    };
  }

  return {
    previewPurchase,
    confirmPurchase,
    revokePermissions,
    restorePermissions,
    getRequest,
    listRequests,
    getAuditTrail,
    seedWalletBalance,
    getWalletSnapshot: (userAddress) => locus.getWalletSnapshot(normalizeAddress(userAddress)),
    health,
  };
}

module.exports = {
  createPurchasingAgentService,
};