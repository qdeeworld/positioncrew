import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { EVMWalletProvider, ERC8183Client, JobStatus } from "@bnbagent/sdk";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

import { LpRebalanceRequestSchema, type LpRebalanceRequest } from "../contracts/lp-rebalance.js";
import { canonicalHash } from "../core/canonical.js";
import {
  bnbLpRangePaymentContract,
  notifyBnbLpRangeFunded,
  requestBnbLpRangeQuote,
  validateBnbLpRangeDelivery,
  type BnbLpRangeQuoteTrace,
} from "../marketplace/bnb-lp-range-a2a-adapter.js";
import { inspectPancakePosition } from "../telemetry/bsc.js";

const EXPECTED_WALLET = getAddress("0xADd748C416E8A7efd7d65D18Abb121dea268ddF9");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const PANCAKE_V3_QUOTER = getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const PANCAKE_V3_ROUTER = getAddress("0x13f4EA83D0bd40E75C8222255bc855a974568Dd4");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const POSITION_ID = "1456267";
const ACTIVATION_WINDOW_SECONDS = 1_200;
const MINIMUM_DELIVERY_SECONDS = 600;
const FUNDING_BUFFER_SECONDS = 180;
const MAXIMUM_SLIPPAGE_BPS = 100n;
const SWAP_FEE = 500;
const DEFAULT_SWAP_INPUT = parseEther("0.00013");
const GAS_PRICE_MULTIPLIER = 2n;
const GAS_HEADROOM_BPS = 13_000n;

const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const wbnbAbi = [
  ...erc20Abi,
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

const quoterAbi = [{
  type: "function",
  name: "quoteExactInputSingle",
  stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }],
  outputs: [
    { name: "amountOut", type: "uint256" },
    { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" },
    { name: "gasEstimate", type: "uint256" },
  ],
}] as const;

const routerAbi = [{
  type: "function",
  name: "exactInputSingle",
  stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "recipient", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "amountOutMinimum", type: "uint256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }],
  outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;

const commerceAbi = [{
  type: "function",
  name: "createJob",
  stateMutability: "nonpayable",
  inputs: [
    { name: "provider", type: "address" },
    { name: "evaluator", type: "address" },
    { name: "expiredAt", type: "uint256" },
    { name: "description", type: "string" },
    { name: "hook", type: "address" },
  ],
  outputs: [{ name: "jobId", type: "uint256" }],
}] as const;

const registryAbi = [{
  type: "function",
  name: "ownerOf",
  stateMutability: "view",
  inputs: [{ name: "tokenId", type: "uint256" }],
  outputs: [{ name: "owner", type: "address" }],
}] as const;

interface ApprovalEnvelope {
  schemaVersion: "positioncrew.live-match.lp-activation-approval.v1";
  chainId: 56;
  wallet: string;
  provider: string;
  agentTokenId: number;
  contracts: { commerce: string; router: string; policy: string; registry: string };
  payment: { token: string; exactAmountAtomic: string; maximumLossAtomic: string };
  swap: { tokenIn: string; tokenOut: string; router: string; maximumInputWei: string; minimumOutputAtomic: string; maximumSlippageBps: string };
  gas: { maximumTotalGasWei: string; gasPriceCeilingWei: string; gasUnitsEnvelope: string };
  frozenRequestHash: string;
  jobDescriptionHash: string;
  quoteExpiresAt: number;
  noLpExecution: true;
  noAutomaticSettlementDisputeOrRefund: true;
}

interface ActivationPreflight {
  schemaVersion: "positioncrew.live-match.lp-activation-preflight.v1";
  recordedAt: string;
  ready: boolean;
  blockers: string[];
  positionId: string;
  frozenRequest: LpRebalanceRequest;
  quote: BnbLpRangeQuoteTrace;
  protocol: {
    chainId: number;
    registryOwner: string;
    commerce: string;
    router: string;
    policy: string;
    paymentToken: string;
    disputeWindowSeconds: string;
    onchainExpiredAt: string;
  };
  balances: { nativeWei: string; wrappedNativeWei: string; paymentTokenAtomic: string; paymentAllowanceAtomic: string };
  swap: { required: boolean; inputWei: string; requiredAdditionalWrapWei: string; quotedOutputAtomic: string; minimumOutputAtomic: string };
  gas: { currentGasPriceWei: string; gasPriceCeilingWei: string; createJobGasEstimate: string; gasUnitsEnvelope: string; maximumTotalGasWei: string };
  approvalEnvelope: ApprovalEnvelope;
  approvalHash: string;
  notificationMessageId: string;
  recovery: { maximumLossAtomic: string; automaticActions: "NONE"; separateApprovalRequired: string[] };
  boundary: string;
}

interface TransactionRecord {
  phase: string;
  hash: Hex;
  blockNumber: string;
  gasWei: string;
}

interface ActivationCheckpoint {
  schemaVersion: "positioncrew.live-match.lp-activation-checkpoint.v1";
  checkpointHash?: string;
  updatedAt: string;
  state: string;
  pendingPhase: string | null;
  preflight: ActivationPreflight;
  commerceJobId: string | null;
  committedSwapInputWei: string;
  transactions: TransactionRecord[];
  fundedBlock: string | null;
  fundedAt: string | null;
  notification: unknown;
  result: unknown;
  boundary: string;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`Preflight ${key} is missing`);
  return field;
}

async function loadPrivateKey(path: string): Promise<Hex> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Operator key file must not be accessible by group or other users");
  const key = (await readFile(path, "utf8")).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Operator key file is not a 32-byte 0x-prefixed key");
  return key as Hex;
}

function sealCheckpoint(checkpoint: ActivationCheckpoint): ActivationCheckpoint {
  const { checkpointHash: _ignored, ...content } = checkpoint;
  return { ...content, checkpointHash: canonicalHash(content) };
}

function verifyCheckpoint(checkpoint: ActivationCheckpoint): void {
  const { checkpointHash, ...content } = checkpoint;
  if (!checkpointHash || checkpointHash !== canonicalHash(content)) throw new Error("Activation checkpoint integrity check failed");
}

async function writeCheckpoint(path: string, checkpoint: ActivationCheckpoint, exclusive = false): Promise<void> {
  const sealed = sealCheckpoint(checkpoint);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  if (exclusive) {
    await writeFile(path, `${json(sealed)}\n`, { mode: 0o600, flag: "wx" });
    return;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${json(sealed)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function freezeActivationRequest(request: LpRebalanceRequest, now = new Date()): LpRebalanceRequest {
  return LpRebalanceRequestSchema.parse({
    ...request,
    requestedAt: now.toISOString(),
    deadline: new Date(now.getTime() + ACTIVATION_WINDOW_SECONDS * 1_000).toISOString(),
    maxDataAgeSeconds: ACTIVATION_WINDOW_SECONDS,
  });
}

async function buildPreflight(): Promise<ActivationPreflight> {
  const rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const payment = bnbLpRangePaymentContract();
  const readClient = await ERC8183Client.create({ network: "bsc-mainnet" });
  const probe = await inspectPancakePosition(argument("position-id") ?? POSITION_ID);
  const frozenRequest = freezeActivationRequest(probe.lpRequest);
  const quote = await requestBnbLpRangeQuote(frozenRequest);
  const acceptedPrice = BigInt(String(quote.authenticatedQuote.price));
  const disputeWindow = await readClient.policy.disputeWindow();
  const onchainExpiredAt = BigInt(Math.floor(Date.parse(frozenRequest.deadline) / 1_000)) + disputeWindow;
  const paymentToken = getAddress(await readClient.paymentToken());
  const swapInput = argument("maximum-swap-wei") ? BigInt(argument("maximum-swap-wei")!) : DEFAULT_SWAP_INPUT;
  const [chainId, nativeBalance, wrappedBalance, paymentBalance, paymentAllowance, owner, gasPrice] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBalance({ address: EXPECTED_WALLET }),
    publicClient.readContract({ address: WBNB, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] }),
    publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] }),
    publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: "allowance", args: [EXPECTED_WALLET, getAddress(payment.kernel)] }),
    publicClient.readContract({ address: getAddress(readClient.network.registryContract), abi: registryAbi, functionName: "ownerOf", args: [BigInt(payment.agentTokenId)] }),
    publicClient.getGasPrice(),
  ]);
  const swapRequired = paymentBalance < acceptedPrice;
  const quotedOutput = swapRequired
    ? (await publicClient.simulateContract({
        account: EXPECTED_WALLET,
        address: PANCAKE_V3_QUOTER,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn: WBNB, tokenOut: paymentToken, amountIn: swapInput, fee: SWAP_FEE, sqrtPriceLimitX96: 0n }],
      })).result[0]
    : 0n;
  const minimumOutput = quotedOutput * (10_000n - MAXIMUM_SLIPPAGE_BPS) / 10_000n;
  const requiredAdditionalWrap = swapRequired && wrappedBalance < swapInput ? swapInput - wrappedBalance : 0n;
  let createJobGasEstimate = 0n;
  const blockers: string[] = [];
  try {
    createJobGasEstimate = await publicClient.estimateContractGas({
      account: EXPECTED_WALLET,
      address: getAddress(payment.kernel),
      abi: commerceAbi,
      functionName: "createJob",
      args: [getAddress(payment.provider), getAddress(readClient.network.routerContract), onchainExpiredAt, quote.jobDescription, getAddress(readClient.network.routerContract)],
    });
  } catch (error) {
    blockers.push(`Exact createJob gas estimate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const conservativeRemainingGasUnits = swapRequired ? 1_150_000n : 720_000n;
  const gasUnitsEnvelope = (createJobGasEstimate + conservativeRemainingGasUnits) * GAS_HEADROOM_BPS / 10_000n;
  const gasPriceCeiling = gasPrice * GAS_PRICE_MULTIPLIER;
  const maximumTotalGasWei = gasUnitsEnvelope * gasPriceCeiling;
  if (chainId !== 56 || readClient.network.chainId !== 56) blockers.push("RPC or SDK network is not BSC mainnet chain 56");
  if (!same(getAddress(readClient.network.commerceContract), getAddress(payment.kernel))) blockers.push("SDK commerce contract differs from the signed quote kernel");
  if (!same(paymentToken, getAddress(payment.paymentToken))) blockers.push("Kernel payment token differs from the frozen provider currency");
  if (!same(owner, getAddress(payment.provider)) || !same(owner, getAddress(quote.recoveredSigner))) blockers.push("Current ERC-8004 owner does not match the signed quote provider");
  if (acceptedPrice <= 0n || acceptedPrice > BigInt(payment.maximumPriceAtomic)) blockers.push("Signed quote price is outside the frozen 0 < price <= 0.1 U boundary");
  if (quote.quoteExpiresAt - quote.negotiatedAt > 900) blockers.push("Signed quote exceeds the SDK 900-second quote window");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (quote.quoteExpiresAt - nowSeconds < FUNDING_BUFFER_SECONDS) blockers.push("Signed quote lacks the 180-second funding buffer");
  const deliverySeconds = Math.max(MINIMUM_DELIVERY_SECONDS, quote.declaredEstimatedCompletionSeconds);
  if (Math.floor(Date.parse(frozenRequest.deadline) / 1_000) - nowSeconds < deliverySeconds + FUNDING_BUFFER_SECONDS) blockers.push("Frozen request cannot cover delivery estimate plus funding buffer");
  if (paymentAllowance !== 0n && paymentAllowance !== acceptedPrice) blockers.push("Existing payment-token allowance is neither zero nor the exact accepted price");
  if (swapRequired && paymentBalance + minimumOutput < acceptedPrice) blockers.push("Bounded swap minimum output cannot cover the accepted quote");
  if (nativeBalance < requiredAdditionalWrap + maximumTotalGasWei) {
    blockers.push(`Native balance is short by ${(requiredAdditionalWrap + maximumTotalGasWei - nativeBalance).toString()} wei for the swap plus gas envelope`);
  }
  const approvalEnvelope: ApprovalEnvelope = {
    schemaVersion: "positioncrew.live-match.lp-activation-approval.v1",
    chainId: 56,
    wallet: EXPECTED_WALLET,
    provider: getAddress(payment.provider),
    agentTokenId: payment.agentTokenId,
    contracts: {
      commerce: getAddress(readClient.network.commerceContract),
      router: getAddress(readClient.network.routerContract),
      policy: getAddress(readClient.network.policyContract),
      registry: getAddress(readClient.network.registryContract),
    },
    payment: { token: paymentToken, exactAmountAtomic: acceptedPrice.toString(), maximumLossAtomic: acceptedPrice.toString() },
    swap: { tokenIn: WBNB, tokenOut: paymentToken, router: PANCAKE_V3_ROUTER, maximumInputWei: swapInput.toString(), minimumOutputAtomic: minimumOutput.toString(), maximumSlippageBps: MAXIMUM_SLIPPAGE_BPS.toString() },
    gas: { maximumTotalGasWei: maximumTotalGasWei.toString(), gasPriceCeilingWei: gasPriceCeiling.toString(), gasUnitsEnvelope: gasUnitsEnvelope.toString() },
    frozenRequestHash: canonicalHash(frozenRequest),
    jobDescriptionHash: quote.jobDescriptionHash,
    quoteExpiresAt: quote.quoteExpiresAt,
    noLpExecution: true,
    noAutomaticSettlementDisputeOrRefund: true,
  };
  return {
    schemaVersion: "positioncrew.live-match.lp-activation-preflight.v1",
    recordedAt: new Date().toISOString(),
    ready: blockers.length === 0,
    blockers,
    positionId: probe.position.tokenId,
    frozenRequest,
    quote,
    protocol: { chainId, registryOwner: owner, commerce: readClient.network.commerceContract, router: readClient.network.routerContract, policy: readClient.network.policyContract, paymentToken, disputeWindowSeconds: disputeWindow.toString(), onchainExpiredAt: onchainExpiredAt.toString() },
    balances: { nativeWei: nativeBalance.toString(), wrappedNativeWei: wrappedBalance.toString(), paymentTokenAtomic: paymentBalance.toString(), paymentAllowanceAtomic: paymentAllowance.toString() },
    swap: { required: swapRequired, inputWei: swapInput.toString(), requiredAdditionalWrapWei: requiredAdditionalWrap.toString(), quotedOutputAtomic: quotedOutput.toString(), minimumOutputAtomic: minimumOutput.toString() },
    gas: { currentGasPriceWei: gasPrice.toString(), gasPriceCeilingWei: gasPriceCeiling.toString(), createJobGasEstimate: createJobGasEstimate.toString(), gasUnitsEnvelope: gasUnitsEnvelope.toString(), maximumTotalGasWei: maximumTotalGasWei.toString() },
    approvalEnvelope,
    approvalHash: canonicalHash(approvalEnvelope),
    notificationMessageId: crypto.randomUUID(),
    recovery: { maximumLossAtomic: acceptedPrice.toString(), automaticActions: "NONE", separateApprovalRequired: ["cancel an OPEN job", "dispute an incompatible submission", "claim a refund", "settle a compatible delivery", "execute any LP action"] },
    boundary: "This preflight buys one external LP analysis delivery for at most the exact quoted amount. It performs no LP rebalance and authorizes no /execute call, settlement, dispute, refund, or protocol-capital action. An incompatible submission can still expose the full escrow amount under the optimistic policy unless reviewed before its dispute deadline.",
  };
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function readPreflight(path: string): Promise<ActivationPreflight> {
  const input = asRecord(JSON.parse(await readFile(path, "utf8")) as unknown, "Activation preflight");
  if (input.schemaVersion !== "positioncrew.live-match.lp-activation-preflight.v1") throw new Error("Unsupported activation preflight schema");
  const preflight = input as unknown as ActivationPreflight;
  preflight.frozenRequest = LpRebalanceRequestSchema.parse(preflight.frozenRequest);
  if (preflight.approvalHash !== canonicalHash(preflight.approvalEnvelope)) throw new Error("Activation approval envelope hash mismatch");
  if (preflight.quote.jobDescriptionHash !== canonicalHash(preflight.quote.jobDescription)) throw new Error("Stored SDK job description hash mismatch");
  if (preflight.approvalEnvelope.frozenRequestHash !== canonicalHash(preflight.frozenRequest)) throw new Error("Approval does not bind the frozen LP request");
  return preflight;
}

async function boundedManifest(url: string, allowedOrigins: readonly string[]): Promise<unknown> {
  const requested = new URL(url);
  if (requested.protocol !== "https:" || !allowedOrigins.includes(requested.origin)) throw new Error("Deliverable URL is outside precommitted provider HTTPS origins");
  const response = await fetch(requested, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(12_000) });
  if (!response.ok || !response.body) throw new Error(`Deliverable fetch failed with HTTP ${response.status}`);
  if (!allowedOrigins.includes(new URL(response.url).origin)) throw new Error("Deliverable response left the precommitted provider origin");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128 * 1024) {
      await reader.cancel("deliverable exceeds PositionCrew limit");
      throw new Error("Deliverable exceeds 131072 bytes");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

async function broadcast(preflightPath: string): Promise<void> {
  const preflight = await readPreflight(preflightPath);
  const suppliedApproval = argument("approval-hash");
  if (!preflight.ready) throw new Error(`Broadcast blocked by preflight: ${preflight.blockers.join("; ")}`);
  if (suppliedApproval !== preflight.approvalHash) throw new Error("Broadcast requires the exact user-approved --approval-hash from this preflight");
  if (argument("confirmation-token") !== "I_CONFIRM_EXACT_FUNDED_LP_ANALYSIS") throw new Error("Broadcast requires --confirmation-token=I_CONFIRM_EXACT_FUNDED_LP_ANALYSIS");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const fundedAlready = argument("resume-checkpoint") !== undefined;
  if (!fundedAlready && preflight.quote.quoteExpiresAt - nowSeconds < FUNDING_BUFFER_SECONDS) throw new Error("Approved signed quote no longer has the required funding buffer; create a new preflight and approval");
  const deliverySeconds = Math.max(MINIMUM_DELIVERY_SECONDS, preflight.quote.declaredEstimatedCompletionSeconds);
  if (!fundedAlready && Math.floor(Date.parse(preflight.frozenRequest.deadline) / 1_000) - nowSeconds < deliverySeconds + FUNDING_BUFFER_SECONDS) throw new Error("Approved request no longer has enough time for funding and delivery");
  const keyPath = process.env.POSITIONCREW_OPERATOR_KEY_FILE;
  if (!keyPath) throw new Error("POSITIONCREW_OPERATOR_KEY_FILE is required for broadcast mode");
  const privateKey = await loadPrivateKey(keyPath);
  const account = privateKeyToAccount(privateKey);
  if (!same(account.address, EXPECTED_WALLET)) throw new Error("Operator key does not match the approved wallet");
  const rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });
  const payment = bnbLpRangePaymentContract();
  const sdkWallet = new EVMWalletProvider({ password: randomBytes(32).toString("hex"), privateKey, persist: false });
  const client = await ERC8183Client.create({ walletProvider: sdkWallet, network: "bsc-mainnet" });
  const paymentToken = getAddress(await client.paymentToken());
  const approval = preflight.approvalEnvelope;
  if (await publicClient.getChainId() !== 56 || client.network.chainId !== 56) throw new Error("Broadcast RPC is not BSC mainnet");
  if (!same(client.address ?? "", EXPECTED_WALLET)) throw new Error("SDK wallet changed after approval");
  if (!same(client.network.commerceContract, approval.contracts.commerce) || !same(client.network.routerContract, approval.contracts.router) || !same(client.network.policyContract, approval.contracts.policy) || !same(client.network.registryContract, approval.contracts.registry) || !same(paymentToken, approval.payment.token)) throw new Error("Live ERC-8183 deployment differs from the approved contracts");
  const owner = await publicClient.readContract({ address: getAddress(client.network.registryContract), abi: registryAbi, functionName: "ownerOf", args: [BigInt(payment.agentTokenId)] });
  if (!same(owner, approval.provider) || !same(owner, preflight.quote.recoveredSigner)) throw new Error("ERC-8004 ownership changed after approval");

  const resumePath = argument("resume-checkpoint");
  const checkpointPath = resolve(resumePath ?? argument("checkpoint") ?? `${homedir()}/.config/positioncrew/activations/bnb-lp-${preflight.approvalHash.slice(7, 19)}.json`);
  let checkpoint: ActivationCheckpoint;
  if (resumePath) {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as ActivationCheckpoint;
    verifyCheckpoint(checkpoint);
    if (checkpoint.preflight.approvalHash !== preflight.approvalHash) throw new Error("Resume checkpoint does not bind this approved preflight");
    if (checkpoint.pendingPhase) throw new Error(`Checkpoint stopped during ${checkpoint.pendingPhase}; reconcile that transaction before any retry`);
  } else {
    checkpoint = {
      schemaVersion: "positioncrew.live-match.lp-activation-checkpoint.v1",
      updatedAt: new Date().toISOString(),
      state: "BROADCAST_NOT_STARTED",
      pendingPhase: null,
      preflight,
      commerceJobId: null,
      committedSwapInputWei: "0",
      transactions: [],
      fundedBlock: null,
      fundedAt: null,
      notification: null,
      result: null,
      boundary: "No recorded transaction has moved LP capital. Recovery actions and settlement require separate approval.",
    };
    await writeCheckpoint(checkpointPath, checkpoint, true);
  }

  const gasCap = BigInt(approval.gas.maximumTotalGasWei);
  const gasPriceCeiling = BigInt(approval.gas.gasPriceCeilingWei);
  const cumulativeGas = (): bigint => checkpoint.transactions.reduce((sum, transaction) => sum + BigInt(transaction.gasWei), 0n);
  const persist = async (state: string): Promise<void> => {
    checkpoint.state = state;
    checkpoint.updatedAt = new Date().toISOString();
    await writeCheckpoint(checkpointPath, checkpoint);
  };
  const runTx = async <T extends { transactionHash: Hex; status: number; receipt: { status: string; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint } | null }>(phase: string, action: () => Promise<T>): Promise<T> => {
    checkpoint.pendingPhase = phase;
    await persist(`${phase.toUpperCase()}_PENDING`);
    const result = await action();
    const receipt = result.receipt ?? await publicClient.waitForTransactionReceipt({ hash: result.transactionHash, confirmations: 2, timeout: 120_000 });
    if (result.status !== 1 || receipt.status !== "success") throw new Error(`${phase} transaction failed: ${result.transactionHash}`);
    const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;
    checkpoint.transactions.push({ phase, hash: result.transactionHash, blockNumber: receipt.blockNumber.toString(), gasWei: gasWei.toString() });
    checkpoint.pendingPhase = null;
    if (receipt.effectiveGasPrice > gasPriceCeiling) throw new Error(`${phase} exceeded the approved gas-price ceiling`);
    if (cumulativeGas() > gasCap) throw new Error(`${phase} exceeded the approved total gas ceiling`);
    await persist(`${phase.toUpperCase()}_CONFIRMED`);
    return { ...result, receipt } as T;
  };
  const runWalletTx = async (phase: string, action: () => Promise<Hex>): Promise<void> => {
    checkpoint.pendingPhase = phase;
    await persist(`${phase.toUpperCase()}_PENDING`);
    const hash = await action();
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${phase} transaction failed: ${hash}`);
    checkpoint.transactions.push({ phase, hash, blockNumber: receipt.blockNumber.toString(), gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() });
    checkpoint.pendingPhase = null;
    if (receipt.effectiveGasPrice > gasPriceCeiling || cumulativeGas() > gasCap) throw new Error(`${phase} exceeded the approved gas envelope`);
    await persist(`${phase.toUpperCase()}_CONFIRMED`);
  };

  const acceptedPrice = BigInt(approval.payment.exactAmountAtomic);
  let paymentBalance = await publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] });
  if (paymentBalance < acceptedPrice && checkpoint.commerceJobId === null) {
    const swapInput = BigInt(approval.swap.maximumInputWei);
    const wrappedBalance = await publicClient.readContract({ address: WBNB, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] });
    const requiredWrap = wrappedBalance < swapInput ? swapInput - wrappedBalance : 0n;
    const nativeBalance = await publicClient.getBalance({ address: EXPECTED_WALLET });
    if (nativeBalance < requiredWrap + gasCap) throw new Error("Live native balance cannot preserve the approved swap and gas envelope");
    const currentQuote = (await publicClient.simulateContract({ account: EXPECTED_WALLET, address: PANCAKE_V3_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: WBNB, tokenOut: paymentToken, amountIn: swapInput, fee: SWAP_FEE, sqrtPriceLimitX96: 0n }] })).result[0];
    if (currentQuote < BigInt(approval.swap.minimumOutputAtomic)) throw new Error("Live swap quote fell below the user-approved minimum output");
    if (requiredWrap > 0n) {
      checkpoint.committedSwapInputWei = requiredWrap.toString();
      await runWalletTx("wrap-bnb", () => walletClient.writeContract({ account, chain: bsc, address: WBNB, abi: wbnbAbi, functionName: "deposit", value: requiredWrap }));
    }
    const wrappedAllowance = await publicClient.readContract({ address: WBNB, abi: erc20Abi, functionName: "allowance", args: [EXPECTED_WALLET, PANCAKE_V3_ROUTER] });
    if (wrappedAllowance !== 0n && wrappedAllowance !== swapInput) throw new Error("Unexpected WBNB router allowance requires separate cleanup approval");
    if (wrappedAllowance < swapInput) await runWalletTx("approve-wbnb", () => walletClient.writeContract({ account, chain: bsc, address: WBNB, abi: erc20Abi, functionName: "approve", args: [PANCAKE_V3_ROUTER, swapInput] }));
    await runWalletTx("swap-wbnb-for-u", () => walletClient.writeContract({ account, chain: bsc, address: PANCAKE_V3_ROUTER, abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn: WBNB, tokenOut: paymentToken, fee: SWAP_FEE, recipient: EXPECTED_WALLET, amountIn: swapInput, amountOutMinimum: BigInt(approval.swap.minimumOutputAtomic), sqrtPriceLimitX96: 0n }] }));
    paymentBalance = await publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] });
    if (paymentBalance < acceptedPrice) throw new Error("Bounded swap completed without enough U for the accepted quote");
  }

  const disputeWindow = BigInt(preflight.protocol.disputeWindowSeconds);
  const expiredAt = BigInt(preflight.protocol.onchainExpiredAt);
  if (expiredAt !== BigInt(Math.floor(Date.parse(preflight.frozenRequest.deadline) / 1_000)) + disputeWindow) throw new Error("Approved on-chain expiry no longer aligns with the request deadline and dispute window");
  let commerceJobId = checkpoint.commerceJobId === null ? null : BigInt(checkpoint.commerceJobId);
  if (commerceJobId === null) {
    const creation = await runTx("create-job", () => client.createJob({ provider: approval.provider, expiredAt, description: preflight.quote.jobDescription }));
    commerceJobId = creation.jobId;
    if (commerceJobId === null && creation.receipt) {
      const events = await client.commerce.getJobCreatedEvents(creation.receipt.blockNumber, creation.receipt.blockNumber);
      commerceJobId = events.find((event) => same(event.client, EXPECTED_WALLET) && same(event.provider, approval.provider) && event.transactionHash === creation.transactionHash)?.jobId ?? null;
    }
    if (commerceJobId === null) {
      checkpoint.state = "CREATE_JOB_ID_RECONCILIATION_REQUIRED";
      await writeCheckpoint(checkpointPath, checkpoint);
      throw new Error(`createJob confirmed at ${creation.transactionHash}, but job ID recovery requires reconciliation`);
    }
    checkpoint.commerceJobId = commerceJobId.toString();
    await persist("JOB_CREATED");
  }
  const verifyJob = async (): Promise<Awaited<ReturnType<typeof client.getJob>>> => {
    const job = await client.getJob(commerceJobId!);
    if (!same(job.client, EXPECTED_WALLET) || !same(job.provider, approval.provider) || !same(job.evaluator, approval.contracts.router) || !same(job.hook, approval.contracts.router) || job.description !== preflight.quote.jobDescription || job.expiredAt !== expiredAt) throw new Error("On-chain ERC-8183 job differs from the approved immutable terms");
    return job;
  };
  let job = await verifyJob();
  if (job.status === JobStatus.OPEN) {
    if (preflight.quote.quoteExpiresAt <= Math.floor(Date.now() / 1_000)) throw new Error("OPEN job's immutable quote expired before funding; do not fund or re-quote this job");
    const currentPolicy = await client.router.jobPolicy(commerceJobId);
    if (same(currentPolicy, ZERO_ADDRESS)) {
      await runTx("register-job", () => client.registerJob(commerceJobId!));
    } else if (!same(currentPolicy, approval.contracts.policy)) {
      throw new Error("On-chain job is bound to an unexpected policy");
    }
    job = await verifyJob();
    if (job.budget === 0n) await runTx("set-budget", () => client.setBudget(commerceJobId!, acceptedPrice));
    else if (job.budget !== acceptedPrice) throw new Error("On-chain budget differs from the exact accepted price");
    let paymentAllowance = await client.tokenAllowance(EXPECTED_WALLET, approval.contracts.commerce);
    if (paymentAllowance !== 0n && paymentAllowance !== acceptedPrice) throw new Error("Payment allowance is not zero or the exact accepted price");
    if (paymentAllowance === 0n) await runTx("approve-payment", () => client.approvePaymentToken(approval.contracts.commerce, acceptedPrice));
    paymentAllowance = await client.tokenAllowance(EXPECTED_WALLET, approval.contracts.commerce);
    if (paymentAllowance !== acceptedPrice) throw new Error("Exact payment approval did not become visible on-chain");
    await runTx("fund-job", () => client.fund(commerceJobId!, acceptedPrice, { approveFloor: 0n }));
  }
  job = await verifyJob();
  if (![JobStatus.FUNDED, JobStatus.SUBMITTED, JobStatus.COMPLETED].includes(job.status)) throw new Error(`Job status ${JobStatus[job.status]} is not resumable for delivery`);
  const fundedBlock = await client.getJobFundedBlock(commerceJobId, { negotiatedAt: preflight.quote.negotiatedAt, quoteExpiresAt: preflight.quote.quoteExpiresAt });
  if (fundedBlock === null) throw new Error("Job funding did not occur inside the provider-signed quote window");
  const fundedBlockData = await publicClient.getBlock({ blockNumber: fundedBlock });
  const fundedAtSeconds = Number(fundedBlockData.timestamp);
  if (fundedAtSeconds < preflight.quote.negotiatedAt || fundedAtSeconds > preflight.quote.quoteExpiresAt) throw new Error("Funded block timestamp is outside the signed quote window");
  checkpoint.fundedBlock = fundedBlock.toString();
  checkpoint.fundedAt = new Date(fundedAtSeconds * 1_000).toISOString();
  const residualAllowance = await client.tokenAllowance(EXPECTED_WALLET, approval.contracts.commerce);
  if (residualAllowance !== 0n) throw new Error("Funding left a residual payment-token allowance; separate revocation approval is required");
  await persist("FUNDED_VERIFIED");
  if (!checkpoint.notification && job.status === JobStatus.FUNDED) {
    checkpoint.notification = await notifyBnbLpRangeFunded(commerceJobId, { messageId: preflight.notificationMessageId });
    await persist("PROVIDER_NOTIFIED");
  }
  const pollDeadline = Date.parse(preflight.frozenRequest.deadline);
  while (job.status === JobStatus.FUNDED && Date.now() < pollDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    job = await verifyJob();
  }
  if (job.status !== JobStatus.SUBMITTED && job.status !== JobStatus.COMPLETED) {
    checkpoint.result = { status: "NOT_DELIVERED_BY_REQUEST_DEADLINE", jobStatus: JobStatus[job.status], refundEligibleAfter: new Date(Number(expiredAt) * 1_000).toISOString() };
    checkpoint.boundary = "No delivery was submitted by the frozen request deadline. Do not retry funding; cancellation or refund requires separate approval.";
    await persist("REFUND_DECISION_REQUIRED");
    process.stdout.write(`${json({ checkpointPath, commerceJobId, result: checkpoint.result })}\n`);
    return;
  }
  const deliverableUrl = await client.getDeliverableUrl(commerceJobId);
  if (!deliverableUrl) throw new Error("Submitted ERC-8183 job has no deliverable URL");
  const manifestDocument = await boundedManifest(deliverableUrl, payment.allowedDeliveryOrigins);
  const submittedAt = new Date(Number(job.submittedAt) * 1_000).toISOString();
  const validation = validateBnbLpRangeDelivery({
    request: preflight.frozenRequest,
    manifestDocument,
    commerceJobId,
    onchainDeliverable: job.deliverable,
    fundedAt: checkpoint.fundedAt!,
    submittedAt,
    expectedContracts: { commerce: approval.contracts.commerce, router: approval.contracts.router, policy: approval.contracts.policy },
  });
  const disputeDeadline = new Date((Number(job.submittedAt) + Number(disputeWindow)) * 1_000).toISOString();
  checkpoint.result = { deliverableUrl, submittedAt, disputeDeadline, validation };
  checkpoint.boundary = validation.status === "COMPATIBLE"
    ? "Delivery passed the exact LP contract. Settlement and every LP action remain separate, unapproved actions."
    : "Delivery is incompatible. The full 0.1 U can silence-approve unless the user separately authorizes a dispute before the recorded deadline.";
  await persist(validation.status === "COMPATIBLE" ? "DELIVERY_COMPATIBLE_REVIEW_REQUIRED" : "DISPUTE_DECISION_REQUIRED");
  process.stdout.write(`${json({ checkpointPath, commerceJobId, state: checkpoint.state, result: checkpoint.result, maximumLossAtomic: approval.payment.maximumLossAtomic })}\n`);
}

const broadcastRequested = process.argv.includes("--broadcast");
if (broadcastRequested) {
  const preflightPath = argument("preflight");
  if (!preflightPath) throw new Error("Broadcast requires --preflight=<approved preflight JSON>");
  await broadcast(resolve(preflightPath));
} else {
  const preflight = await buildPreflight();
  const output = argument("output");
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, `${json(preflight)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${json({ outputPath, ready: preflight.ready, blockers: preflight.blockers, approvalHash: preflight.approvalHash, approvalEnvelope: preflight.approvalEnvelope, boundary: preflight.boundary })}\n`);
  } else {
    process.stdout.write(`${json(preflight)}\n`);
  }
}
