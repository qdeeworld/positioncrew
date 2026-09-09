import { z } from "zod";
import { decodeFunctionData, encodeFunctionData, parseEventLogs, type Address, type Hex, type Transaction } from "viem";
import { parseFixed, FIXED_SCALE } from "../core/fixed.js";
import { FreshMarketplaceStore, type D1Database } from "./d1-marketplace-store.js";
import { BuyerVenusStore, type BuyerVenusState } from "./d1-buyer-venus-store.js";
import { buyerVenusPublicClient, readBuyerVenusSnapshot, simulateBuyerStep, type BuyerVenusPublicClient } from "./buyer-venus-read.js";
import { BUYER_TOKEN_ABI, BUYER_VTOKEN_ABI, VENUS_BUYER_MARKETS, buildSupplyIntent, checkBuyerSnapshot, requireBuyer, sameAddress, supplySource, type BuyerVenusStep } from "./buyer-venus-policy.js";
import { verifyBuyerSupply, verifyBuyerRedemption } from "./buyer-venus-confirm.js";
import { verifyServerObservationBinding } from "./server-observation-binding.js";
import { sha256Commitment } from "./fresh-hire-schema.js";

const AddressInput = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const HashInput = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const StepInput = z.number().int().min(0).max(2);
const CONFIRMATIONS = 15n;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});
async function body(request: Request) {
  requireBuyer(request.headers.get("Content-Type")?.includes("application/json"), "Send application/json.");
  const reader = request.body?.getReader();
  requireBuyer(reader, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      requireBuyer(total <= 4096, "Execution request is too large.");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
function matchTransaction(tx: Transaction, account: string, step: BuyerVenusStep) {
  requireBuyer(tx.chainId === 56 && sameAddress(tx.from, account) && tx.to !== null && sameAddress(tx.to, step.to) &&
    tx.input === step.data && tx.value === 0n && tx.nonce === step.nonce,
  "This transaction does not match the saved wallet, market, amount and nonce. Do not send it again.");
}
async function confirmedReceipt(client: BuyerVenusPublicClient, hash: Hex, allowRevert = false) {
  try {
    const receipt = await client.getTransactionReceipt({ hash });
    const [head, block] = await Promise.all([client.getBlockNumber(), client.getBlock({ blockNumber: receipt.blockNumber })]);
    requireBuyer(block.hash === receipt.blockHash, "The transaction block changed. Wait and reload its status.");
    if (head - receipt.blockNumber + 1n < CONFIRMATIONS) return null;
    requireBuyer(allowRevert || receipt.status === "success", "The transaction reverted. Its gas may have been spent. Start a new assessment before any new deposit.");
    return receipt;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
    throw error;
  }
}
function withdrawalStep(state: BuyerVenusState): BuyerVenusStep {
  requireBuyer(state.withdrawal, "Request a withdrawal quote first.");
  return { kind: "WITHDRAW", to: state.intent.market, data: state.withdrawal.data, value: "0x0",
    nonce: state.withdrawal.nonce, gas: state.withdrawal.gas, gasPrice: state.withdrawal.gasPrice };
}

export async function handleBuyerVenus(request: Request, options: {
  db: D1Database; observationKey?: string; client?: BuyerVenusPublicClient; now?: Date;
}): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/api\/buyer-venus\/([a-fA-F0-9-]{36})(?:\/(prepare|preflight|confirm|withdraw-quote|withdraw-preflight|withdraw-confirm))?$/.exec(url.pathname);
  if (!match) return json({ error: "NOT_FOUND", details: ["Unknown buyer execution route."] }, 404);
  try {
    const receiptId = z.string().uuid().parse(match[1]);
    const action = match[2];
    const store = new BuyerVenusStore(options.db);
    const fresh = new FreshMarketplaceStore(options.db);
    const client = options.client ?? buyerVenusPublicClient();
    const now = options.now ?? new Date();
    let state = await store.get(receiptId);
    if (!action && request.method === "GET") return json({ state });
    if (request.method !== "POST" || !action) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    const input = await body(request);
    if (action === "prepare") {
      const { account } = z.object({ account: AddressInput }).strict().parse(input);
      if (state) {
        requireBuyer(sameAddress(state.intent.account, account), "Connect the wallet used for this assessment.");
        return json({ state });
      }
      const chain = await fresh.getReceipt(receiptId);
      requireBuyer(chain?.receipt, "Complete a current Yield assessment first.");
      const source = supplySource(chain, account, now);
      const evidence = chain.hire.evidence;
      requireBuyer(evidence?.evidenceClass === "CURRENT_BLOCK_PINNED", "Current server-bound evidence is required.");
      await verifyServerObservationBinding(source.request, { ...evidence.source, binding: evidence.observationBinding }, options.observationKey, now);
      const [requestHash, deliverableHash] = await Promise.all([sha256Commitment(source.request), sha256Commitment(source.result)]);
      requireBuyer(requestHash === chain.hire.requestHash && deliverableHash === chain.receipt.deliverableHash, "The assessment commitments do not match its saved recommendation.");
      const snapshot = await readBuyerVenusSnapshot(client, account as Address);
      const intent = buildSupplyIntent(chain, account, snapshot, new Date());
      await simulateBuyerStep(client, intent, 0);
      state = await store.create(intent);
      return json({ state }, 201);
    }
    requireBuyer(state, "Prepare and save the buyer's exact execution plan first.");
    const intent = state.intent;
    if (action === "preflight") {
      const { step: index } = z.object({ step: StepInput }).strict().parse(input);
      const step = intent.steps[index];
      requireBuyer(step, "Unknown transaction step.");
      requireBuyer(!state.transactions[String(index)], "A transaction is already recorded for this step. Confirm its status; do not resend.");
      requireBuyer(intent.steps.slice(0, index).every((_, i) => state!.confirmedSteps.includes(i)), "Confirm each earlier approval before continuing.");
      requireBuyer(now.getTime() < Date.parse(intent.expiresAt), "The review window expired. Run a new assessment before signing.");
      const chain = await fresh.getReceipt(receiptId);
      requireBuyer(chain, "The source assessment is unavailable.");
      const snapshot = await readBuyerVenusSnapshot(client, intent.account as Address);
      const next = buildSupplyIntent(chain, intent.account, snapshot, new Date());
      requireBuyer(next.amountRaw === intent.amountRaw && next.steps[0]?.to === step.to && next.steps[0]?.data === step.data && next.steps[0]?.nonce === step.nonce,
        "The wallet or recommendation changed. A new assessment and consent are required; transaction parameters were not changed.");
      requireBuyer(snapshot.gasPrice <= BigInt(step.gasPrice) && snapshot.treasuryPercent.toString() === intent.treasuryPercent &&
        parseFixed(next.projectedNetBenefitUsd) >= parseFixed(intent.projectedNetBenefitUsd),
      "The reviewed cost or benefit changed. Obtain a new assessment before signing.");
      await simulateBuyerStep(client, intent, index);
      requireBuyer(Date.now() < Date.parse(intent.expiresAt), "The review window expired during preflight.");
      return json({ state, step, checkedAt: new Date().toISOString() });
    }
    if (action === "confirm") {
      const { step: index, transactionHash } = z.object({ step: StepInput, transactionHash: HashInput }).strict().parse(input);
      const step = intent.steps[index];
      requireBuyer(step, "Unknown transaction step.");
      requireBuyer(!state.transactions[String(index)] || state.transactions[String(index)]!.toLowerCase() === transactionHash.toLowerCase(), "Another transaction is already bound to this step.");
      const tx = await client.getTransaction({ hash: transactionHash as Hex });
      matchTransaction(tx, intent.account, step);
      if (!state.transactions[String(index)]) {
        state.transactions[String(index)] = transactionHash;
        state = await store.update(state);
      }
      if (state.confirmedSteps.includes(index)) return json({ state });
      const receipt = await confirmedReceipt(client, transactionHash as Hex);
      if (!receipt) return json({ state, pending: true }, 202);
      if (step.kind === "SUPPLY") {
        const blockNumber = receipt.blockNumber;
        const [exchangeRate, vTokenBalance, tokenBalance] = await Promise.all([
          client.readContract({ address: intent.market as Address, abi: BUYER_VTOKEN_ABI, functionName: "exchangeRateStored", blockNumber }),
          client.readContract({ address: intent.market as Address, abi: BUYER_VTOKEN_ABI, functionName: "balanceOf", args: [intent.account as Address], blockNumber }),
          client.readContract({ address: intent.token as Address, abi: BUYER_TOKEN_ABI, functionName: "balanceOf", args: [intent.account as Address], blockNumber }),
        ]);
        const block = await client.getBlock({ blockNumber });
        requireBuyer(block.hash, "The transaction block is unavailable.");
        state.supplyProof = verifyBuyerSupply(intent, tx, receipt, { blockNumber, blockHash: block.hash, exchangeRate, vTokenBalance, tokenBalance });
      } else {
        const decoded = decodeFunctionData({ abi: BUYER_TOKEN_ABI, data: step.data as Hex });
        requireBuyer(decoded.functionName === "approve", "Unexpected approval step.");
        const approvals = parseEventLogs({ abi: BUYER_TOKEN_ABI, eventName: "Approval", logs: receipt.logs, strict: true });
        requireBuyer(approvals.some(log => sameAddress(log.address, intent.token) && sameAddress(log.args.owner, intent.account) && sameAddress(log.args.spender, intent.market) && log.args.value === decoded.args[1]), "The exact token allowance was not confirmed.");
      }
      state.confirmedSteps.push(index);
      return json({ state: await store.update(state) });
    }
    requireBuyer(state.supplyProof, "Confirm the supplied position before preparing its withdrawal.");
    if (action === "withdraw-quote") {
      z.object({}).strict().parse(input);
      requireBuyer(!state.withdrawal?.proof, "This deposit has already been withdrawn.");
      requireBuyer(!state.withdrawal?.transactionHash, "A withdrawal transaction is already recorded. Confirm it before taking another action.");
      const snapshot = await readBuyerVenusSnapshot(client, intent.account as Address);
      checkBuyerSnapshot(snapshot, VENUS_BUYER_MARKETS[0], new Date(), "WITHDRAW");
      const shares = BigInt(state.supplyProof.mintedSharesRaw);
      const underlying = shares * snapshot.exchangeRate / FIXED_SCALE;
      requireBuyer(shares > 0n && snapshot.vTokenBalance >= shares, "The wallet no longer holds all shares minted by this deposit.");
      requireBuyer(snapshot.cash >= underlying, "Venus currently lacks enough available cash for this withdrawal. The position remains in your wallet; retry when liquidity is available.");
      const gasPrice = (snapshot.gasPrice * 12n + 9n) / 10n;
      requireBuyer(snapshot.nativeBalance >= gasPrice * 500_000n, "The wallet needs native BNB for withdrawal gas.");
      state.withdrawal = { data: encodeFunctionData({ abi: BUYER_VTOKEN_ABI, functionName: "redeem", args: [shares] }),
        nonce: snapshot.nonce, gas: "500000", gasPrice: gasPrice.toString(), shares: shares.toString(),
        expectedUnderlyingRaw: (underlying - underlying * snapshot.treasuryPercent / FIXED_SCALE).toString(),
        treasuryPercent: snapshot.treasuryPercent.toString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), transactionHash: null, proof: null };
      await simulateBuyerStep(client, { account: intent.account, steps: [withdrawalStep(state)] }, 0);
      return json({ state: await store.update(state) });
    }
    if (action === "withdraw-confirm") {
      const { transactionHash } = z.object({ transactionHash: HashInput }).strict().parse(input);
      if (state.failedWithdrawals?.some(failure => failure.transactionHash.toLowerCase() === transactionHash.toLowerCase())) return json({ state, reverted: true });
    }
    const step = withdrawalStep(state);
    requireBuyer(state.withdrawal, "Request a withdrawal quote first.");
    if (action === "withdraw-preflight") {
      z.object({}).strict().parse(input);
      requireBuyer(!state.withdrawal.transactionHash && !state.withdrawal.proof, "This withdrawal has already been sent. Check its status.");
      requireBuyer(Date.now() < Date.parse(state.withdrawal.expiresAt), "The withdrawal quote expired. Request a fresh quote.");
      const snapshot = await readBuyerVenusSnapshot(client, intent.account as Address);
      checkBuyerSnapshot(snapshot, VENUS_BUYER_MARKETS[0], new Date(), "WITHDRAW");
      const underlying = BigInt(state.withdrawal.shares) * snapshot.exchangeRate / FIXED_SCALE;
      requireBuyer(snapshot.nonce === step.nonce && snapshot.gasPrice <= BigInt(step.gasPrice) && snapshot.treasuryPercent.toString() === state.withdrawal.treasuryPercent,
        "The wallet, withdrawal fee or gas changed. Review a fresh quote before signing.");
      requireBuyer(snapshot.vTokenBalance >= BigInt(state.withdrawal.shares) && snapshot.cash >= underlying && snapshot.nativeBalance >= BigInt(step.gas) * BigInt(step.gasPrice), "Shares, liquidity or BNB gas are no longer sufficient for this withdrawal.");
      await simulateBuyerStep(client, { account: intent.account, steps: [step] }, 0);
      return json({ state, step, checkedAt: new Date().toISOString() });
    }
    const { transactionHash } = z.object({ transactionHash: HashInput }).strict().parse(input);
    requireBuyer(!state.withdrawal.transactionHash || state.withdrawal.transactionHash.toLowerCase() === transactionHash.toLowerCase(), "Another withdrawal transaction is already recorded.");
    const tx = await client.getTransaction({ hash: transactionHash as Hex });
    matchTransaction(tx, intent.account, step);
    if (!state.withdrawal.transactionHash) {
      state.withdrawal.transactionHash = transactionHash;
      state = await store.update(state);
    }
    if (state.withdrawal!.proof) return json({ state });
    const receipt = await confirmedReceipt(client, transactionHash as Hex, true);
    if (!receipt) return json({ state, pending: true }, 202);
    if (receipt.status === "reverted") {
      state.failedWithdrawals = [...(state.failedWithdrawals ?? []), { transactionHash, blockHash: receipt.blockHash,
        actualGasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() }];
      state.withdrawal = null;
      return json({ state: await store.update(state), reverted: true });
    }
    state.withdrawal!.proof = verifyBuyerRedemption(state.supplyProof!, tx, receipt, BigInt(state.withdrawal!.shares), step.data as Hex);
    return json({ state: await store.update(state) });
  } catch (error) {
    return json({ error: "BUYER_EXECUTION_STOPPED", details: [error instanceof z.ZodError ? "The execution request is invalid." : error instanceof Error ? error.message : "Execution verification is unavailable."] }, 409);
  }
}
