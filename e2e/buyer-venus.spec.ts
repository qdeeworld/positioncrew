import { expect, test, type Page } from "@playwright/test";
import { encodeFunctionData } from "viem";
import { buyerVenusFixture } from "../test/buyer-venus-fixture.js";
import { buildSupplyIntent, BUYER_VTOKEN_ABI } from "../src/commerce/buyer-venus-policy.js";
import { runCurrentBlockPinnedProviderDeliverable } from "../src/api/fixture-jobs.js";
import { sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
import { isFreshMarketplaceChainForReference } from "../web/src/job-history.js";
import type { BuyerVenusState } from "../src/commerce/d1-buyer-venus-store.js";

const now = new Date("2026-09-09T07:00:10Z");
const hireId = "22222222-2222-4222-8222-222222222222";
const receiptId = "11111111-1111-4111-8111-111111111111";
const historyKey = "positioncrew.recent-jobs.v1";
async function install(page: Page, mode: "complete" | "pending" | "reject" | "wrong-chain" | "changed-step" = "complete") {
  const f = buyerVenusFixture();
  const response = await runCurrentBlockPinnedProviderDeliverable(f.request, f.result, now);
  const createdAt = f.request.requestedAt;
  const source = { blockNumber: "123", observedAt: createdAt, explorerUrl: "https://bscscan.com/block/123" };
  const evidence = { evidenceClass: "CURRENT_BLOCK_PINNED", source };
  const chain = { schemaVersion: "positioncrew.fresh-marketplace-chain.v1",
    hire: { hireId, service: "YIELD_OPTIMIZATION", benchmarkSlug: "yield-optimization", providerSlug: "yield-optimization",
      providerId: "positioncrew:provider:yield-optimization:v1", request: f.request, requestHash: await sha256Commitment(f.request),
      evidenceMode: "CURRENT_BLOCK_PINNED", createdAt, evidence, evidenceHash: await sha256Commitment(evidence) },
    job: { jobId: "33333333-3333-4333-8333-333333333333", state: "COMPLETED", status: "COMPLETED", createdAt, startedAt: createdAt,
      completedAt: now.toISOString(), apiDurationMilliseconds: 10, error: null, providerSelection: null, providerSelectionHash: null },
    receipt: { receiptId, publicUrl: `/api/benchmark-receipts/${receiptId}`, createdAt: now.toISOString(), responseHash: await sha256Commitment(response),
      deliverableHash: response.result.job.deliverable!.deliverableHash, evaluationHash: response.result.evaluation.evaluationHash, response } };
  expect(await isFreshMarketplaceChainForReference(chain, { hireId, service: "YIELD_OPTIMIZATION", rememberedAt: createdAt })).toBe(true);
  const intent = buildSupplyIntent(f.chain, f.request.account, f.snapshot, now);
  let state: BuyerVenusState | null = null;
  let pending = mode === "pending";
  await page.clock.install({ time: now });
  await page.addInitScript(({ historyKey, hireId, createdAt, account, mode }) => {
    localStorage.setItem(historyKey, JSON.stringify({ schemaVersion: historyKey, entries: [{ hireId, service: "YIELD_OPTIMIZATION", rememberedAt: createdAt }] }));
    (window as any).ethereum = { async request({ method, params }: any) {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
      if (method === "eth_chainId") return mode === "wrong-chain" ? "0x1" : "0x38";
      if (method === "eth_sendTransaction") {
        if (mode === "reject") throw Object.assign(new Error("User rejected the wallet request."), { code: 4001 });
        const calls = JSON.parse(localStorage.getItem("buyer-test-wallet-calls") ?? "[]");
        calls.push(params[0]); localStorage.setItem("buyer-test-wallet-calls", JSON.stringify(calls));
        return "0x" + String(calls.length).repeat(64);
      }
      throw new Error("Unexpected wallet method: " + method);
    } };
  }, { historyKey, hireId, createdAt, account: f.request.account, mode });
  await page.route(`**/api/benchmark-hires/${hireId}`, route => route.fulfill({ json: chain }));
  await page.route("**/api/markets/venus/stable-yields*", route => route.fulfill({ json: {
    state: "READY", yieldRequest: f.request, source: { blockNumber: "123", blockTimestamp: createdAt, explorerUrl: source.explorerUrl },
    markets: [{ symbol: "USDT", baseSupplyApyBps: 500, availableLiquidityUsd: "1000000" }], boundary: "Synthetic browser test market; no mainnet action.",
  } }));
  await page.route(`**/api/buyer-venus/${receiptId}**`, async route => {
    const action = new URL(route.request().url()).pathname.split("/")[4];
    const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    if (action === "prepare") state ??= { version: 0, intent, transactions: {}, confirmedSteps: [], supplyProof: null, withdrawal: null };
    if (action === "preflight") return route.fulfill({ json: { state, step: mode === "changed-step" ? { ...state!.intent.steps[input.step], gasPrice: "999999999" } : state!.intent.steps[input.step] } });
    if (action === "confirm") {
      state!.transactions[String(input.step)] = input.transactionHash;
      if (pending) return route.fulfill({ status: 202, json: { state, pending: true } });
      if (!state!.confirmedSteps.includes(input.step)) state!.confirmedSteps.push(input.step);
      if (input.step === 1) state!.supplyProof = {
        schemaVersion: "positioncrew.buyer-venus-supply-proof.v1", chainId: 56, account: intent.account as `0x${string}`,
        token: intent.token as `0x${string}`, market: intent.market as `0x${string}`, sourceReceiptId: receiptId,
        sourceRequestHash: intent.sourceRequestHash, transactionHash: input.transactionHash, blockNumber: "124", blockHash: `0x${"a".repeat(64)}`,
        suppliedRaw: intent.amountRaw, mintedSharesRaw: intent.estimatedSharesRaw, exchangeRateRaw: f.snapshot.exchangeRate.toString(),
        underlyingValueRaw: intent.amountRaw, walletVTokenBalanceRaw: intent.estimatedSharesRaw, actualSupplyGasWei: "10000000000000",
        withinSupplyGasLimit: true, boundary: "Synthetic UI receipt only.",
      };
    }
    if (action === "withdraw-quote") state!.withdrawal = {
      data: encodeFunctionData({ abi: BUYER_VTOKEN_ABI, functionName: "redeem", args: [BigInt(intent.estimatedSharesRaw)] }),
      nonce: 9, gas: "500000", gasPrice: "60000000", shares: intent.estimatedSharesRaw, expectedUnderlyingRaw: intent.amountRaw,
      treasuryPercent: "0", expiresAt: "2026-09-09T07:05:00Z", transactionHash: null, proof: null,
    };
    if (action === "withdraw-preflight") return route.fulfill({ json: { state, step: { kind: "WITHDRAW", to: intent.market, ...state!.withdrawal, value: "0x0" } } });
    if (action === "withdraw-confirm") {
      state!.withdrawal!.transactionHash = input.transactionHash;
      state!.withdrawal!.proof = { transactionHash: input.transactionHash, blockHash: `0x${"b".repeat(64)}`,
        redeemedSharesRaw: intent.estimatedSharesRaw, receivedUnderlyingRaw: intent.amountRaw, actualGasWei: "10000000000000" };
    }
    return route.fulfill({ json: { state } });
  });
  async function open() {
    await page.goto("/#jobs");
    await page.getByTestId("recent-jobs-device").getByRole("button", { name: "Open result", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Supply the USDT your assessment recommends" })).toBeVisible();
  }
  await open();
  return { intent, open, releasePending: () => { pending = false; }, calls: async () => page.evaluate(() => JSON.parse(localStorage.getItem("buyer-test-wallet-calls") ?? "[]")) };
}

test("buyer reviews, approves, supplies and withdraws through the ordinary saved result", async ({ page }) => {
  const f = await install(page);
  const panel = page.locator(".buyer-venus");
  await panel.getByRole("button", { name: "Connect wallet and review this recommendation" }).click();
  await expect(panel.getByRole("button", { name: "Approve this exact USDT allowance" })).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Approve this exact USDT allowance" }).click();
  await expect(panel.getByRole("button", { name: "Supply this exact USDT amount" })).toBeDisabled();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Supply this exact USDT amount" }).click();
  await expect(panel.getByRole("heading", { name: "Your verified Venus position" })).toBeVisible();
  const calls = await f.calls();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ chainId: "0x38", from: f.intent.account, to: f.intent.market, data: f.intent.steps[1]!.data, nonce: "0x8", value: "0x0" });
  await page.clock.fastForward(125000);
  await panel.getByRole("button", { name: "Check withdrawal availability" }).click();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Withdraw this deposit to my wallet" }).click();
  await expect(panel.getByText(/Withdrawn: 900 USDT delivered/)).toBeVisible();
  expect(await f.calls()).toHaveLength(3);
  await expect(panel.getByRole("button", { name: "Withdraw this deposit to my wallet" })).toHaveCount(0);
});

test("pending buyer transaction survives reload without a second wallet request", async ({ page }) => {
  const f = await install(page, "pending");
  const panel = page.locator(".buyer-venus");
  await panel.getByRole("button", { name: "Connect wallet and review this recommendation" }).click();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Approve this exact USDT allowance" }).click();
  await expect(panel.getByRole("button", { name: "Check confirmation" })).toBeVisible();
  await page.reload();
  await page.getByTestId("recent-jobs-device").getByRole("button", { name: "Open result", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Check confirmation" })).toBeVisible();
  expect(await f.calls()).toHaveLength(1);
  await expect(panel.getByRole("button", { name: "Approve this exact USDT allowance" })).toHaveCount(0);
  f.releasePending();
  await panel.getByRole("button", { name: "Check confirmation" }).click();
  await expect(panel.getByRole("button", { name: "Supply this exact USDT amount" })).toBeVisible();
  expect(await f.calls()).toHaveLength(1);
});

test("wallet rejection clears the uncertainty marker and keeps funds untouched", async ({ page }) => {
  const f = await install(page, "reject");
  const panel = page.locator(".buyer-venus");
  await panel.getByRole("button", { name: "Connect wallet and review this recommendation" }).click();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Approve this exact USDT allowance" }).click();
  await expect(panel.getByRole("alert")).toContainText("User rejected");
  expect(await f.calls()).toHaveLength(0);
  expect(await page.evaluate(id => localStorage.getItem(`positioncrew.buyer-venus.v1:${id}`), receiptId)).toBeNull();
});

test("a wallet on another chain cannot prepare or send the BSC recommendation", async ({ page }) => {
  const f = await install(page, "wrong-chain");
  const panel = page.locator(".buyer-venus");
  await panel.getByRole("button", { name: "Connect wallet and review this recommendation" }).click();
  await expect(panel.getByRole("alert")).toContainText("BNB Smart Chain");
  expect(await f.calls()).toHaveLength(0);
  await expect(panel.getByRole("button", { name: "Approve this exact USDT allowance" })).toHaveCount(0);
});

test("changed transaction terms invalidate consent before the wallet opens", async ({ page }) => {
  const f = await install(page, "changed-step");
  const panel = page.locator(".buyer-venus");
  await panel.getByRole("button", { name: "Connect wallet and review this recommendation" }).click();
  await panel.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Approve this exact USDT allowance" }).click();
  await expect(panel.getByRole("alert")).toContainText("details changed");
  await expect(panel.getByRole("checkbox")).not.toBeChecked();
  expect(await f.calls()).toHaveLength(0);
  expect(await page.evaluate(id => localStorage.getItem(`positioncrew.buyer-venus.v1:${id}`), receiptId)).toBeNull();
});
