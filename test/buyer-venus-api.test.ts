import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleBuyerVenus } from "../src/commerce/buyer-venus-api.js";
import { BuyerVenusStore } from "../src/commerce/d1-buyer-venus-store.js";
import { FreshMarketplaceStore, type D1Database } from "../src/commerce/d1-marketplace-store.js";
import { buyerVenusFixture } from "./buyer-venus-fixture.js";
import { issueServerObservationBinding } from "../src/commerce/server-observation-binding.js";
import { sha256Commitment } from "../src/commerce/fresh-hire-schema.js";
import { readBuyerVenusSnapshot, simulateBuyerStep, type BuyerVenusPublicClient } from "../src/commerce/buyer-venus-read.js";
import { VENUS_BUYER_MARKETS } from "../src/commerce/buyer-venus-policy.js";

vi.mock("../src/commerce/buyer-venus-read.js", () => ({ buyerVenusPublicClient: vi.fn(), readBuyerVenusSnapshot: vi.fn(), simulateBuyerStep: vi.fn() }));
const now = new Date("2026-09-09T07:00:10Z");
const KEY = "positioncrew-buyer-venus-unit-observation-key";
const id = "11111111-1111-4111-8111-111111111111";
function database(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE fresh_marketplace_receipts (receipt_id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO fresh_marketplace_receipts VALUES (?)").run(id);
  db.exec(readFileSync(new URL("../migrations/0007_buyer_venus_executions.sql", import.meta.url), "utf8"));
  return { prepare(sql: string) { return { bind(...values: SQLInputValue[]) { return {
    async first<T>() { return (db.prepare(sql).get(...values) as T | undefined) ?? null; },
    async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
  }; } }; } } as D1Database;
}
async function setup() {
  const f = buyerVenusFixture();
  const source = { blockNumber: "123", observedAt: "2026-09-09T07:00:00Z", explorerUrl: "https://bscscan.com/block/123" };
  f.request.sources[0]!.uri = source.explorerUrl;
  const binding = await issueServerObservationBinding(f.request, source, KEY, now);
  f.chain.hire.evidence = { schemaVersion: "positioncrew.current-block-pinned-evidence.v1", evidenceClass: "CURRENT_BLOCK_PINNED", chainId: 56,
    source, observationBinding: binding, freshnessAtCreation: "FRESH", evaluatedAt: now.toISOString(), maxDataAgeSeconds: 120 };
  f.chain.hire.requestHash = await sha256Commitment(f.request);
  f.chain.receipt!.deliverableHash = await sha256Commitment(f.result);
  vi.spyOn(FreshMarketplaceStore.prototype, "getReceipt").mockResolvedValue(f.chain);
  vi.mocked(readBuyerVenusSnapshot).mockResolvedValue(f.snapshot);
  vi.mocked(simulateBuyerStep).mockResolvedValue();
  const db = database();
  const client = { getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn(), getBlockNumber: vi.fn() };
  async function call(action: string, input: unknown = {}) {
    return handleBuyerVenus(new Request(`https://positioncrew.dolepee.com/api/buyer-venus/${id}${action ? `/${action}` : ""}`, action ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    } : {}), { db, observationKey: KEY, client: client as unknown as BuyerVenusPublicClient });
  }
  return { ...f, db, client, call };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("saved buyer execution API", () => {
  it("saves one immutable plan per receipt and returns it across repeat preparation and reload", async () => {
    const f = await setup();
    const prepared = await f.call("prepare", { account: f.request.account });
    expect(prepared.status).toBe(201);
    const first = await prepared.json() as { state: { intent: unknown } };
    expect((await f.call("prepare", { account: f.request.account })).status).toBe(200);
    expect((await (await f.call("")).json()).state.intent).toEqual(first.state.intent);
    expect(simulateBuyerStep).toHaveBeenCalledTimes(1);
  });
  it("rejects a modified result commitment before any simulation or saved intent", async () => {
    const f = await setup(); f.chain.receipt!.deliverableHash = `sha256:${"0".repeat(64)}`;
    const response = await f.call("prepare", { account: f.request.account });
    expect(response.status).toBe(409); expect((await response.json()).details[0]).toMatch(/commitments/);
    expect(simulateBuyerStep).not.toHaveBeenCalled();
    expect(await new BuyerVenusStore(f.db).get(id)).toBeNull();
  });
  it("rejects forged server observations before saving an execution", async () => {
    const f = await setup();
    if (f.chain.hire.evidence?.evidenceClass === "CURRENT_BLOCK_PINNED") f.chain.hire.evidence.observationBinding!.signature = "0".repeat(64);
    expect((await f.call("prepare", { account: f.request.account })).status).toBe(409);
    expect(simulateBuyerStep).not.toHaveBeenCalled();
  });
  it("preflight checks nonce, original amount and economic evidence again", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    expect((await f.call("preflight", { step: 0 })).status).toBe(200);
    f.snapshot.nonce++;
    const response = await f.call("preflight", { step: 0 });
    expect(response.status).toBe(409); expect((await response.json()).details[0]).toMatch(/changed/);
  });
  it("requires approvals to confirm before supply and rejects expired signing", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    expect((await f.call("preflight", { step: 1 })).status).toBe(409);
    vi.setSystemTime(new Date("2026-09-09T07:02:00Z"));
    const response = await f.call("preflight", { step: 0 });
    expect(response.status).toBe(409); expect((await response.json()).details[0]).toMatch(/expired/);
  });
  it("records a matching pending transaction before confirmation and forbids resending", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    const state = (await new BuyerVenusStore(f.db).get(id))!;
    const step = state.intent.steps[0]!;
    const hash = `0x${"e".repeat(64)}`;
    f.client.getTransaction.mockResolvedValue({ chainId: 56, from: f.request.account, to: step.to, input: step.data, value: 0n, nonce: step.nonce });
    f.client.getTransactionReceipt.mockRejectedValue(Object.assign(new Error("pending"), { name: "TransactionReceiptNotFoundError" }));
    expect((await f.call("confirm", { step: 0, transactionHash: hash })).status).toBe(202);
    expect((await new BuyerVenusStore(f.db).get(id))!.transactions["0"]).toBe(hash);
    expect((await f.call("preflight", { step: 0 })).status).toBe(409);
  });
  it("will not attach another sender's transaction to this buyer", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    f.client.getTransaction.mockResolvedValue({ chainId: 56, from: VENUS_BUYER_MARKETS[0].token, to: VENUS_BUYER_MARKETS[0].market, input: "0x00", value: 0n, nonce: 7 });
    expect((await f.call("confirm", { step: 0, transactionHash: `0x${"f".repeat(64)}` })).status).toBe(409);
    expect((await new BuyerVenusStore(f.db).get(id))!.transactions).toEqual({});
  });
  it("requires a confirmed position for withdrawal", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    expect((await f.call("withdraw-quote")).status).toBe(409);
  });
  it("withdraws only this deposit's shares after the original assessment expires", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    const store = new BuyerVenusStore(f.db);
    const state = (await store.get(id))!;
    state.supplyProof = { mintedSharesRaw: "3600000000000" } as NonNullable<typeof state.supplyProof>;
    await store.update(state);
    const later = new Date("2026-09-09T07:03:00Z");
    vi.setSystemTime(later);
    f.snapshot.timestamp = BigInt(later.getTime() / 1000);
    f.snapshot.vTokenBalance = 7_200_000_000_000n; // Includes an unrelated earlier holding.
    f.snapshot.mintPaused = true; // A mint pause alone must not block redemption.
    const response = await f.call("withdraw-quote");
    expect(response.status).toBe(200);
    const saved = (await response.json()).state;
    expect(saved.withdrawal.shares).toBe("3600000000000");
    expect((await f.call("withdraw-preflight")).status).toBe(200);
    expect(saved.intent.expiresAt).toBe("2026-09-09T07:02:00.000Z");
  });
  it("does not offer redemption when protocol cash is insufficient", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    const store = new BuyerVenusStore(f.db); const state = (await store.get(id))!;
    state.supplyProof = { mintedSharesRaw: "3600000000000" } as NonNullable<typeof state.supplyProof>;
    await store.update(state);
    f.snapshot.vTokenBalance = 3_600_000_000_000n; f.snapshot.cash = 0n;
    const response = await f.call("withdraw-quote");
    expect(response.status).toBe(409);
    expect((await response.json()).details[0]).toMatch(/lacks enough available cash/);
    expect((await store.get(id))!.withdrawal).toBeNull();
  });
  it("preserves a finalized reverted withdrawal and permits a fresh quote without resending it", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    const store = new BuyerVenusStore(f.db); const original = (await store.get(id))!;
    original.supplyProof = { mintedSharesRaw: "3600000000000" } as NonNullable<typeof original.supplyProof>;
    await store.update(original); f.snapshot.vTokenBalance = 3_600_000_000_000n;
    expect((await f.call("withdraw-quote")).status).toBe(200);
    const quoted = (await store.get(id))!; const withdrawal = quoted.withdrawal!;
    const hash = `0x${"e".repeat(64)}`, blockHash = `0x${"b".repeat(64)}`;
    f.client.getTransaction.mockResolvedValue({ chainId: 56, from: f.request.account, to: quoted.intent.market, input: withdrawal.data, value: 0n, nonce: withdrawal.nonce });
    f.client.getTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 123n, blockHash, gasUsed: 100_000n, effectiveGasPrice: 50_000_000n });
    f.client.getBlockNumber.mockResolvedValue(136n); f.client.getBlock.mockResolvedValue({ hash: blockHash });
    expect((await f.call("withdraw-confirm", { transactionHash: hash })).status).toBe(202);
    expect((await store.get(id))!.withdrawal!.transactionHash).toBe(hash);
    expect((await f.call("withdraw-quote")).status).toBe(409);
    f.client.getBlockNumber.mockResolvedValue(137n);
    const result = await (await f.call("withdraw-confirm", { transactionHash: hash })).json();
    expect(result.reverted).toBe(true); expect(result.state.withdrawal).toBeNull();
    expect(result.state.failedWithdrawals).toEqual([{ transactionHash: hash, blockHash, actualGasWei: "5000000000000" }]);
    f.snapshot.nonce++;
    expect((await f.call("withdraw-quote")).status).toBe(200);
    const refreshed = (await store.get(id))!.withdrawal;
    expect((await (await f.call("withdraw-confirm", { transactionHash: hash })).json()).reverted).toBe(true);
    expect((await store.get(id))!.withdrawal).toEqual(refreshed);
  });
  it("uses compare-and-swap persistence so concurrent requests cannot overwrite progress", async () => {
    const f = await setup(); await f.call("prepare", { account: f.request.account });
    const store = new BuyerVenusStore(f.db);
    const a = (await store.get(id))!; const b = (await store.get(id))!;
    a.transactions["0"] = `0x${"a".repeat(64)}`; await store.update(a);
    b.transactions["0"] = `0x${"b".repeat(64)}`;
    await expect(store.update(b)).rejects.toThrow(/changed/);
    expect((await store.get(id))!.transactions["0"]).toBe(a.transactions["0"]);
  });
});
