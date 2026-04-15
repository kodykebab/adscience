const crypto = require("crypto");

function toCurrencyKey(currency) {
  return String(currency || "USDC").trim().toUpperCase();
}

function createWalletState(defaultBalances) {
  return {
    balances: {
      USDC: Number(defaultBalances?.USDC ?? 1000),
      ATTN: Number(defaultBalances?.ATTN ?? 1000),
    },
    reserved: {
      USDC: 0,
      ATTN: 0,
    },
    revoked: false,
  };
}

function createMockLocusClient({ defaultBalances, logger } = {}) {
  const wallets = new Map();
  const merchants = new Map();
  const authorizations = new Map();

  function getWallet(walletAddress) {
    const key = String(walletAddress || "").toLowerCase();
    if (!key) {
      throw new Error("walletAddress is required");
    }

    if (!wallets.has(key)) {
      wallets.set(key, createWalletState(defaultBalances));
    }

    return wallets.get(key);
  }

  function getBalance(walletAddress, currency = "USDC") {
    const wallet = getWallet(walletAddress);
    const currencyKey = toCurrencyKey(currency);
    return {
      currency: currencyKey,
      available: wallet.balances[currencyKey] ?? 0,
      reserved: wallet.reserved[currencyKey] ?? 0,
      total: (wallet.balances[currencyKey] ?? 0) + (wallet.reserved[currencyKey] ?? 0),
      revoked: wallet.revoked,
    };
  }

  function seedBalance(walletAddress, currency, amount) {
    const wallet = getWallet(walletAddress);
    const currencyKey = toCurrencyKey(currency);
    wallet.balances[currencyKey] = Number(amount);
    return getBalance(walletAddress, currencyKey);
  }

  function authorizeTransfer({ walletAddress, merchantId, currency, amount, requestId }) {
    const wallet = getWallet(walletAddress);
    const currencyKey = toCurrencyKey(currency);
    const normalizedAmount = Number(amount);

    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      throw new Error("amount must be a positive number");
    }

    if (wallet.revoked) {
      throw new Error("wallet permissions revoked");
    }

    const available = wallet.balances[currencyKey] ?? 0;
    if (available < normalizedAmount) {
      throw new Error("insufficient balance");
    }

    wallet.balances[currencyKey] = available - normalizedAmount;
    wallet.reserved[currencyKey] = (wallet.reserved[currencyKey] ?? 0) + normalizedAmount;

    const authorizationId = crypto.randomUUID();
    authorizations.set(authorizationId, {
      authorizationId,
      walletAddress: String(walletAddress).toLowerCase(),
      merchantId: String(merchantId || "unknown-merchant"),
      currency: currencyKey,
      amount: normalizedAmount,
      requestId: requestId || null,
      status: "authorized",
      createdAt: new Date().toISOString(),
    });

    logger?.("authorize", authorizations.get(authorizationId));

    return {
      authorizationId,
      currency: currencyKey,
      amount: normalizedAmount,
      availableAfterReserve: wallet.balances[currencyKey],
    };
  }

  function captureTransfer({ authorizationId }) {
    const authorization = authorizations.get(authorizationId);
    if (!authorization) {
      throw new Error("authorization not found");
    }

    if (authorization.status !== "authorized") {
      return authorization;
    }

    const wallet = getWallet(authorization.walletAddress);
    wallet.reserved[authorization.currency] = Math.max(
      0,
      (wallet.reserved[authorization.currency] ?? 0) - authorization.amount
    );

    const merchantKey = authorization.merchantId;
    merchants.set(merchantKey, {
      merchantId: merchantKey,
      currency: authorization.currency,
      balance: (merchants.get(merchantKey)?.balance ?? 0) + authorization.amount,
    });

    authorization.status = "captured";
    authorization.capturedAt = new Date().toISOString();
    authorization.transactionId = crypto.randomUUID();
    authorization.transactionHash = `0x${crypto.randomBytes(16).toString("hex")}`;

    logger?.("capture", authorization);

    return {
      transactionId: authorization.transactionId,
      transactionHash: authorization.transactionHash,
      merchantId: merchantKey,
      walletAddress: authorization.walletAddress,
      currency: authorization.currency,
      amount: authorization.amount,
    };
  }

  function voidTransfer({ authorizationId }) {
    const authorization = authorizations.get(authorizationId);
    if (!authorization || authorization.status !== "authorized") {
      return null;
    }

    const wallet = getWallet(authorization.walletAddress);
    wallet.reserved[authorization.currency] = Math.max(
      0,
      (wallet.reserved[authorization.currency] ?? 0) - authorization.amount
    );
    wallet.balances[authorization.currency] = (wallet.balances[authorization.currency] ?? 0) + authorization.amount;
    authorization.status = "voided";
    authorization.voidedAt = new Date().toISOString();

    logger?.("void", authorization);

    return authorization;
  }

  function revokeWallet(walletAddress, reason = "revoked-by-user") {
    const wallet = getWallet(walletAddress);
    wallet.revoked = true;
    logger?.("revoke", {
      walletAddress: String(walletAddress).toLowerCase(),
      reason,
    });
    return getBalance(walletAddress, "USDC");
  }

  function restoreWallet(walletAddress) {
    const wallet = getWallet(walletAddress);
    wallet.revoked = false;
    logger?.("restore", {
      walletAddress: String(walletAddress).toLowerCase(),
    });
    return getBalance(walletAddress, "USDC");
  }

  return {
    getBalance,
    seedBalance,
    authorizeTransfer,
    captureTransfer,
    voidTransfer,
    revokeWallet,
    restoreWallet,
    getWalletSnapshot(walletAddress) {
      const wallet = getWallet(walletAddress);
      return {
        walletAddress: String(walletAddress).toLowerCase(),
        balances: { ...wallet.balances },
        reserved: { ...wallet.reserved },
        revoked: wallet.revoked,
      };
    },
    getMerchantSnapshot(merchantId) {
      return merchants.get(String(merchantId || "unknown-merchant")) || null;
    },
  };
}

module.exports = {
  createMockLocusClient,
};