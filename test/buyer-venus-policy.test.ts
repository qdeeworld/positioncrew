import { buyerVenusFixture as fixture } from "./buyer-venus-fixture.js";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Transaction, type TransactionReceipt } from "viem";
import { buildSupplyIntent, buyerAssessmentCostDefaults, BUYER_TOKEN_ABI, BUYER_VTOKEN_ABI, VENUS_BUYER_COMPTROLLER, VENUS_BUYER_IMPLEMENTATION, VENUS_BUYER_MARKETS, type BuyerVenusSnapshot } from "../src/commerce/buyer-venus-policy.js";
import { verifyBuyerSupply } from "../src/commerce/buyer-venus-confirm.js";
import { YieldOptimizationRequestSchema } from "../src/contracts/yield-optimization.js";
import { createYieldOptimizationDeliverable } from "../src/providers/yield-optimization.js";
import { parseFixed } from "../src/core/fixed.js";
import type { FreshMarketplaceChain } from "../src/commerce/fresh-hire-schema.js";

const now = new Date("2026-09-09T07:00:10Z");
const account = "0x1111111111111111111111111111111111111111";
const market = VENUS_BUYER_MARKETS[0];
const hash = `0x${"a".repeat(64)}` as const;
// Synthetic boundary cases; no customer, wallet signature or mainnet execution.


describe("buyer Venus feasibility policy", () => {
  it.each([50_000_000n, 1_000_000_000n, 1_234_567_891n])("keeps published round-trip components within the fresh cost limit at gas price %s", gasPrice => {
    const costs = buyerAssessmentCostDefaults({ capitalUsd: parseFixed("1000"), gasPrice, bnbPrice: parseFixed("755.787456"), treasuryPercent: 0n, grossApyBps: 185, evaluationHorizonDays: 90 });
    const total = parseFixed(costs.estimatedEntryCostUsd) + parseFixed(costs.estimatedExitCostUsd);
    expect(total).toBeLessThanOrEqual(parseFixed(costs.maxExecutionCostUsd));
    expect(costs.maxGasUsd).toBe(costs.maxExecutionCostUsd);
    const { chain, snapshot } = fixture();
    Object.assign(chain.hire.request, { maxExecutionCostUsd: costs.maxExecutionCostUsd, maxGasUsd: costs.maxGasUsd });
    Object.assign(snapshot, { gasPrice, bnbPrice: parseFixed("755.787456") });
    expect(() => buildSupplyIntent(chain, account, snapshot, now)).not.toThrow();
  });
  it("includes a nonzero protocol exit fee in the fresh assessment's stated withdrawal cost", () => {
    const input = { capitalUsd: parseFixed("1000"), gasPrice: 50_000_000n, bnbPrice: parseFixed("750"), grossApyBps: 500, evaluationHorizonDays: 90 };
    const free = buyerAssessmentCostDefaults({ ...input, treasuryPercent: 0n });
    const fee = buyerAssessmentCostDefaults({ ...input, treasuryPercent: parseFixed("0.001") });
    expect(parseFixed(fee.estimatedExitCostUsd) - parseFixed(free.estimatedExitCostUsd)).toBeGreaterThan(parseFixed("1"));
    expect(parseFixed(fee.maxExecutionCostUsd)).toBe(parseFixed(fee.estimatedEntryCostUsd) + parseFixed(fee.estimatedExitCostUsd));
  });
  it("binds an actual provider recommendation to exact existing USDT, exact approval and nonce", () => {
    const { chain, snapshot, result } = fixture();
    const intent = buildSupplyIntent(chain, account, snapshot, now);
    expect(result.allocationUsd).toBe("900");
    expect(intent.amountRaw).toBe(parseFixed("900").toString());
    expect(intent.steps.map(step => step.kind)).toEqual(["APPROVE", "SUPPLY"]);
    expect(intent.steps.map(step => step.nonce)).toEqual([7, 8]);
    expect(decodeFunctionData({ abi: BUYER_TOKEN_ABI, data: intent.steps[0]!.data as `0x${string}` }).args).toEqual([market.market, parseFixed("900")]);
    expect(intent.sourceReceiptId).toBe(chain.receipt!.receiptId);
    expect(intent.sourceRequestHash).toBe(chain.hire.requestHash);
    expect(intent.expiryMeaning).toBe("PRE_SIGN_CHECK_ONLY_NOT_ONCHAIN_DEADLINE");
  });
  it("independently includes entry and withdrawal gas in net benefit", () => {
    const { chain, snapshot } = fixture();
    const intent = buildSupplyIntent(chain, account, snapshot, now);
    // 900 * 5% * 90/365 - (100k + 500k + 500k) * 0.06 gwei * $750/BNB.
    const expected = parseFixed("900") * 500n * 90n / (10_000n * 365n) - parseFixed("0.0495");
    expect(parseFixed(intent.projectedNetBenefitUsd)).toBe(expected / 10n ** 10n * 10n ** 10n);
    expect(intent.expectedWithdrawalGasWei).toBe("30000000000000");
  });
  it("resets a pre-existing allowance and never asks for unlimited approval", () => {
    const { chain, snapshot } = fixture(); snapshot.allowance = 2n ** 256n - 1n;
    const intent = buildSupplyIntent(chain, account, snapshot, now);
    expect(intent.steps.map(step => step.kind)).toEqual(["RESET_APPROVAL", "APPROVE", "SUPPLY"]);
    expect(decodeFunctionData({ abi: BUYER_TOKEN_ABI, data: intent.steps[0]!.data as `0x${string}` }).args?.[1]).toBe(0n);
  });
  it("needs no approval when the existing allowance is already exact", () => {
    const { chain, snapshot } = fixture(); snapshot.allowance = parseFixed("900");
    expect(buildSupplyIntent(chain, account, snapshot, now).steps.map(step => step.kind)).toEqual(["SUPPLY"]);
  });
  it.each([
    ["different chain", { chainId: 97 }, /network/],
    ["insufficient asset", { tokenBalance: 1n }, /does not hold enough/],
    ["insufficient BNB reserve", { nativeBalance: 36_000_000_000_000n }, /reserve/],
    ["changed implementation", { implementation: account }, /implementation changed/],
    ["wrong token decimals", { tokenDecimals: 6 }, /identity/],
    ["wrong share decimals", { vTokenDecimals: 18 }, /identity/],
    ["unlisted market", { listed: false }, /unavailable/],
    ["paused mint", { mintPaused: true }, /unavailable/],
    ["paused withdrawal", { redeemPaused: true }, /unavailable/],
    ["collateral enrollment", { assetsIn: [market.market] }, /collateral/],
    ["stale snapshot", { timestamp: BigInt(now.getTime() / 1000) - 31n }, /not current/],
    ["future snapshot", { timestamp: BigInt(now.getTime() / 1000) + 11n }, /not current/],
    ["zero oracle", { tokenPrice: 0n }, /price or gas/],
    ["lower live return", { currentApyBps: 0 }, /HOLD/],
    ["expensive gas", { gasPrice: 10_000_000_000n }, /execution-cost/],
    ["insufficient protocol cash", { cash: 0n }, /liquidity/],
    ["full supply cap", { supplyCap: parseFixed("1") }, /supply cap/],
    ["expensive protocol exit fee", { treasuryPercent: parseFixed("0.01") }, /execution-cost/],
  ] as const)("refuses %s", (_label, changes, message) => {
    const { chain, snapshot } = fixture(); Object.assign(snapshot, changes);
    expect(() => buildSupplyIntent(chain, account, snapshot, now)).toThrow(message);
  });
  it("does not silently reduce an allocation to pay new costs", () => {
    const { chain, snapshot } = fixture(); chain.hire.request.capitalUsd = "900.02";
    expect(() => buildSupplyIntent(chain, account, snapshot, now)).toThrow(/will not be silently reduced/);
  });
  it("refuses another wallet, a historical result, a failed evaluation, and an expired recommendation", () => {
    const { chain, snapshot } = fixture();
    expect(() => buildSupplyIntent(chain, market.token, snapshot, now)).toThrow(/wallet used/);
    expect(() => buildSupplyIntent(chain, account, snapshot, new Date("2026-09-09T07:02:00Z"))).toThrow(/expired/);
    chain.hire.evidenceMode = "HISTORICAL_FIXTURE";
    expect(() => buildSupplyIntent(chain, account, snapshot, now)).toThrow(/current Yield/);
    chain.hire.evidenceMode = "CURRENT_BLOCK_PINNED";
    (chain.receipt!.response as { result: { evaluation: { passed: boolean } } }).result.evaluation.passed = false;
    expect(() => buildSupplyIntent(chain, account, snapshot, now)).toThrow();
  });
});

describe("received Venus position proof", () => {
  function evidence() {
    const { chain, snapshot } = fixture();
    const intent = buildSupplyIntent(chain, account, snapshot, now);
    const shares = BigInt(intent.estimatedSharesRaw);
    const log = (address: string, topics: readonly `0x${string}`[], data: `0x${string}`) => ({ address, topics, data, blockHash: hash, blockNumber: 124n, transactionHash: hash, transactionIndex: 0, logIndex: 0, removed: false });
    const transfer = (token: string, from: `0x${string}`, to: `0x${string}`, value: bigint) => log(token,
      encodeEventTopics({ abi: BUYER_TOKEN_ABI, eventName: "Transfer", args: { from, to } }) as readonly `0x${string}`[], encodeAbiParameters(parseAbiParameters("uint256"), [value]));
    const receipt = { status: "success", transactionHash: hash, blockHash: hash, blockNumber: 124n,
      gasUsed: 200_000n, effectiveGasPrice: 50_000_000n,
      logs: [log(market.market, encodeEventTopics({ abi: BUYER_VTOKEN_ABI, eventName: "Mint" }) as readonly `0x${string}`[],
        encodeAbiParameters(parseAbiParameters("address,uint256,uint256,uint256"), [account, BigInt(intent.amountRaw), shares, shares])),
      transfer(market.token, account, market.market, BigInt(intent.amountRaw)), transfer(market.market, market.market, account, shares)] } as unknown as TransactionReceipt;
    const transaction = { chainId: 56, from: account, to: market.market, input: intent.steps.at(-1)!.data,
      value: 0n, nonce: 8, hash, blockHash: hash, blockNumber: 124n } as unknown as Transaction;
    const position = { blockNumber: 124n, blockHash: hash, exchangeRate: snapshot.exchangeRate, vTokenBalance: shares, tokenBalance: parseFixed("100") };
    return { intent, receipt, transaction, position };
  }
  it("verifies underlying transfer, minted shares, and deployment-specific conversion", () => {
    const { intent, transaction, receipt, position } = evidence();
    const proof = verifyBuyerSupply(intent, transaction, receipt, position);
    expect(proof.underlyingValueRaw).toBe(intent.amountRaw);
    expect(proof.mintedSharesRaw).toBe("3600000000000");
  });
  it("does not accept EVM success without a Mint event", () => {
    const e = evidence(); e.receipt.logs.shift();
    expect(() => verifyBuyerSupply(e.intent, e.transaction, e.receipt, e.position)).toThrow(/alone does not prove/);
  });
  it("rejects wrong transaction amount, missing underlying transfer, or wrong verification block", () => {
    const e = evidence(); e.transaction.input = "0x00";
    expect(() => verifyBuyerSupply(e.intent, e.transaction, e.receipt, e.position)).toThrow(/does not match/);
    const f = evidence(); f.receipt.logs.splice(1, 1);
    expect(() => verifyBuyerSupply(f.intent, f.transaction, f.receipt, f.position)).toThrow(/underlying transfer/);
    const g = evidence(); g.position.blockNumber = 125n;
    expect(() => verifyBuyerSupply(g.intent, g.transaction, g.receipt, g.position)).toThrow(/pinned/);
  });
});
