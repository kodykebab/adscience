const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPurchasingAgentService } = require("../services/agent");

function makeService() {
  const auditPath = path.join(os.tmpdir(), `purchase-agent-${Date.now()}-${Math.random()}.jsonl`);
  fs.rmSync(auditPath, { force: true });
  return createPurchasingAgentService({
    auditLogPath: auditPath,
    defaultBalances: {
      USDC: 100,
      ATTN: 100,
    },
    approvalThreshold: 25,
    confirmationThreshold: 250,
  });
}

test("auto-approves and captures small purchases", async () => {
  const service = makeService();

  const result = await service.previewPurchase({
    userAddress: "0xabc123",
    merchantId: "merchant-1",
    productUrl: "https://shop.example/item-1",
    title: "Item 1",
    amount: 10,
    currency: "USDC",
    idempotencyKey: "purchase-1",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.decision, "approved");
  assert.ok(result.payment);
  assert.equal(result.payment.amount, 10);

  const wallet = service.getWalletSnapshot("0xabc123");
  assert.equal(wallet.balances.USDC, 90);
  assert.equal(wallet.reserved.USDC, 0);
});

test("requires confirmation for medium purchases before capture", async () => {
  const service = makeService();

  const preview = await service.previewPurchase({
    userAddress: "0xabc123",
    merchantId: "merchant-2",
    productUrl: "https://shop.example/item-2",
    title: "Item 2",
    amount: 50,
    currency: "USDC",
    requiresConfirmation: true,
    idempotencyKey: "purchase-2",
  });

  assert.equal(preview.status, "pending_confirmation");
  assert.equal(preview.requiresConfirmation, true);
  assert.ok(preview.approval === null);

  const confirmed = await service.confirmPurchase(preview.requestId, {
    approved: true,
    approvedBy: "0xabc123",
    mode: "manual",
  });

  assert.equal(confirmed.status, "completed");
  assert.ok(confirmed.payment);

  const wallet = service.getWalletSnapshot("0xabc123");
  assert.equal(wallet.balances.USDC, 50);
  assert.equal(wallet.reserved.USDC, 0);
});

test("declines duplicate and revoked purchase attempts", async () => {
  const service = makeService();

  const first = await service.previewPurchase({
    userAddress: "0xabc123",
    merchantId: "merchant-3",
    productUrl: "https://shop.example/item-3",
    title: "Item 3",
    amount: 20,
    currency: "USDC",
    idempotencyKey: "purchase-3",
  });

  const duplicate = await service.previewPurchase({
    userAddress: "0xabc123",
    merchantId: "merchant-3",
    productUrl: "https://shop.example/item-3",
    title: "Item 3",
    amount: 20,
    currency: "USDC",
    idempotencyKey: "purchase-3",
  });

  assert.equal(first.status, "completed");
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.requestId, first.requestId);

  service.revokePermissions("0xabc123", "user revoked permissions");

  const declined = await service.previewPurchase({
    userAddress: "0xabc123",
    merchantId: "merchant-4",
    productUrl: "https://shop.example/item-4",
    title: "Item 4",
    amount: 5,
    currency: "USDC",
    idempotencyKey: "purchase-4",
  });

  assert.equal(declined.status, "declined");
  assert.match((declined.reasons || []).join(" "), /revoked/i);
});
