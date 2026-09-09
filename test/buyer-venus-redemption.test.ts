import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbiParameters, type Transaction, type TransactionReceipt } from "viem";
import { verifyBuyerRedemption, type BuyerVenusSupplyProof } from "../src/commerce/buyer-venus-confirm.js";
import { BUYER_TOKEN_ABI, BUYER_VTOKEN_ABI, VENUS_BUYER_MARKETS } from "../src/commerce/buyer-venus-policy.js";
import { parseFixed } from "../src/core/fixed.js";

// Synthetic regression for the allowlisted four-argument Redeem ABI. The
// official deployment artifact identifies implementation 0xCDfea50...941e;
// VToken.redeemFresh emits remainedAmount after transferring the treasury fee.
function evidence(fee = 0n) {
  const market = VENUS_BUYER_MARKETS[0];
  const account = "0x1111111111111111111111111111111111111111" as const;
  const treasury = "0x2222222222222222222222222222222222222222" as const;
  const hash = `0x${"a".repeat(64)}` as const;
  const shares = 3_600_000_000_000n, gross = parseFixed("900"), net = gross - fee;
  let index = 0;
  const log = (address: string, topics: readonly `0x${string}`[], data: `0x${string}`) => ({ address, topics, data,
    blockHash: hash, blockNumber: 124n, transactionHash: hash, transactionIndex: 0, logIndex: index++, removed: false });
  const transfer = (token: string, from: `0x${string}`, to: `0x${string}`, amount: bigint) => log(token,
    encodeEventTopics({ abi: BUYER_TOKEN_ABI, eventName: "Transfer", args: { from, to } }) as readonly `0x${string}`[],
    encodeAbiParameters(parseAbiParameters("uint256"), [amount]));
  const logs = [
    ...(fee > 0n ? [transfer(market.token, market.market, treasury, fee),
      log(market.market, encodeEventTopics({ abi: BUYER_VTOKEN_ABI, eventName: "RedeemFee" }) as readonly `0x${string}`[],
        encodeAbiParameters(parseAbiParameters("address,uint256,uint256"), [account, fee, shares]))] : []),
    transfer(market.token, market.market, account, net), transfer(market.market, account, market.market, shares),
    log(market.market, encodeEventTopics({ abi: BUYER_VTOKEN_ABI, eventName: "Redeem" }) as readonly `0x${string}`[],
      encodeAbiParameters(parseAbiParameters("address,uint256,uint256,uint256"), [account, net, shares, 0n])),
  ];
  const data = encodeFunctionData({ abi: BUYER_VTOKEN_ABI, functionName: "redeem", args: [shares] });
  const proof: BuyerVenusSupplyProof = { schemaVersion: "positioncrew.buyer-venus-supply-proof.v1", chainId: 56,
    account, token: market.token, market: market.market, mintedSharesRaw: shares.toString(),
    sourceReceiptId: "11111111-1111-4111-8111-111111111111", sourceRequestHash: `sha256:${"b".repeat(64)}`,
    transactionHash: hash, blockNumber: "123", blockHash: hash, suppliedRaw: gross.toString(),
    exchangeRateRaw: "250000000000000000000000000", underlyingValueRaw: gross.toString(), walletVTokenBalanceRaw: shares.toString(),
    actualSupplyGasWei: "10000000000000", withinSupplyGasLimit: true, boundary: "Synthetic regression fixture; no customer or mainnet action." };
  const transaction = { chainId: 56, from: account, to: market.market, input: data, value: 0n, hash, blockHash: hash, blockNumber: 124n } as unknown as Transaction;
  const receipt = { status: "success", transactionHash: hash, blockHash: hash, blockNumber: 124n,
    gasUsed: 200_000n, effectiveGasPrice: 50_000_000n, logs } as unknown as TransactionReceipt;
  return { market, account, proof, transaction, receipt, shares, data, net, gross };
}
describe("net Venus redemption evidence", () => {
  it.each([0n, parseFixed("0.9"), parseFixed("9")])("verifies the buyer's net transfer with treasury fee %s without subtracting it twice", fee => {
    const e = evidence(fee);
    expect(verifyBuyerRedemption(e.proof, e.transaction, e.receipt, e.shares, e.data).receivedUnderlyingRaw).toBe(e.net.toString());
  });
  it("rejects a gross Redeem amount that does not match the actual net buyer transfer", () => {
    const e = evidence(parseFixed("9"));
    e.receipt.logs.at(-1)!.data = encodeAbiParameters(parseAbiParameters("address,uint256,uint256,uint256"), [e.account, e.gross, e.shares, 0n]);
    expect(() => verifyBuyerRedemption(e.proof, e.transaction, e.receipt, e.shares, e.data)).toThrow(/not delivered/);
  });
  it("does not count a treasury payment as delivery to the buyer", () => {
    const e = evidence(parseFixed("9")); e.receipt.logs.splice(2, 1);
    expect(() => verifyBuyerRedemption(e.proof, e.transaction, e.receipt, e.shares, e.data)).toThrow(/not delivered/);
  });
});
