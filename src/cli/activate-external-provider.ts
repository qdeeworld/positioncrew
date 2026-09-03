import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EVMWalletProvider, ERC8183Client, JobStatus } from "@bnbagent/sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { canonicalHash } from "../core/canonical.js";
import {
  brainOnBnbPaymentContract,
  HealthFactorLiveMatchJobSchema,
  notifyBrainHealthFactorFunded,
  requestBrainHealthFactorQuote,
  validateBrainHealthFactorDelivery,
  verifyBrainPrepaymentCapabilityProof,
} from "../marketplace/a2a-live-match.js";

const EXPECTED_WALLET = getAddress("0xADd748C416E8A7efd7d65D18Abb121dea268ddF9");
const WBNB = getAddress("0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c");
const PANCAKE_V3_QUOTER = getAddress("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997");
const PANCAKE_V3_ROUTER = getAddress("0x13f4EA83D0bd40E75C8222255bc855a974568Dd4");
const SWAP_INPUT = parseEther("0.00025");
const MAX_TOTAL_GAS = parseEther("0.00035");
const CAMPAIGN_STARTING_NATIVE_BALANCE = 977_552_965_000_000n;
const PAYMENT_BUDGET = 100_000_000_000_000_000n;
const FEE = 500;
const MAX_SLIPPAGE_BPS = 100n;
const DEFAULT_ACCOUNT = getAddress("0xe02702687b1653a782af57fbcc56d59b7e99a935");

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

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

async function boundedDocument(url: string, expectedOrigin: string, maximumBytes = 128 * 1024): Promise<{ document: unknown; raw: string }> {
  const requestedUrl = new URL(url);
  if (requestedUrl.protocol !== "https:" || requestedUrl.origin !== expectedOrigin) {
    throw new Error("Deliverable URL is outside the frozen provider HTTPS origin");
  }
  const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(12_000) });
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || finalUrl.origin !== expectedOrigin) {
    throw new Error("Deliverable redirect left the frozen provider HTTPS origin");
  }
  if (!response.ok || !response.body) throw new Error(`Deliverable fetch failed with HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel("deliverable exceeds PositionCrew limit");
      throw new Error(`Deliverable exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(body);
  return { document: JSON.parse(raw), raw };
}

function unwrapBrainResult(document: unknown): unknown {
  if (typeof document !== "object" || document === null || !("result" in document)) {
    throw new Error("Brain delivery envelope has no result field");
  }
  return (document as { result: unknown }).result;
}

async function loadPrivateKey(path: string): Promise<Hex> {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Operator key file must not be accessible by group or other users");
  const key = (await readFile(path, "utf8")).trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Operator key file is not a 32-byte 0x-prefixed key");
  return key as Hex;
}

const broadcast = process.argv.includes("--broadcast");
const confirmation = argument("confirmation-token");
const resumeJobId = argument("resume-job-id") ? BigInt(argument("resume-job-id")!) : null;
const resumeCheckpointArgument = argument("resume-checkpoint");
const capabilityProofArgument = argument("capability-proof");
const challengeCheckpointArgument = argument("challenge-checkpoint");
const paidCapabilityTrial = process.argv.includes("--paid-capability-trial");
const resumeDeliveryValidation = process.argv.includes("--resume-delivery-validation");
if (resumeJobId !== null && !resumeCheckpointArgument) {
  throw new Error("--resume-job-id requires --resume-checkpoint=<original activation checkpoint>");
}
if (resumeDeliveryValidation && resumeJobId === null) {
  throw new Error("--resume-delivery-validation requires --resume-job-id and its checkpoint");
}
const accountToInspect = getAddress(argument("account") ?? DEFAULT_ACCOUNT);
const rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const payment = brainOnBnbPaymentContract();
const paymentToken = getAddress(payment.paymentToken);
const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
const [chainId, nativeBalance, tokenBalance, wrappedBalance] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: EXPECTED_WALLET }),
  publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] }),
  publicClient.readContract({ address: WBNB, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] }),
]);
const quotedOutput = resumeDeliveryValidation
  ? 0n
  : (await publicClient.simulateContract({
    account: EXPECTED_WALLET,
    address: PANCAKE_V3_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: WBNB, tokenOut: paymentToken, amountIn: SWAP_INPUT, fee: FEE, sqrtPriceLimitX96: 0n }],
  })).result[0];
if (chainId !== 56) throw new Error(`RPC chain mismatch: expected 56, received ${chainId}`);
const minimumOutput = quotedOutput * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n;
let existingCommittedSwapInput = resumeDeliveryValidation
  ? 0n
  : wrappedBalance < SWAP_INPUT ? wrappedBalance : SWAP_INPUT;
let requiredWrapInput = resumeDeliveryValidation || tokenBalance >= PAYMENT_BUDGET ? 0n : SWAP_INPUT - existingCommittedSwapInput;
const nativeDecrease = resumeDeliveryValidation ? 0n : CAMPAIGN_STARTING_NATIVE_BALANCE - nativeBalance;
if (!resumeDeliveryValidation && nativeDecrease < existingCommittedSwapInput) throw new Error("Campaign native-balance accounting is inconsistent");
const gasAlreadySpent = resumeDeliveryValidation ? 0n : nativeDecrease - existingCommittedSwapInput;
if (!resumeDeliveryValidation && !broadcast && gasAlreadySpent > MAX_TOTAL_GAS) throw new Error("Campaign gas ceiling was already exceeded");
const remainingGasCeiling = MAX_TOTAL_GAS - gasAlreadySpent;
if (!resumeDeliveryValidation && !broadcast && minimumOutput < PAYMENT_BUDGET) throw new Error("Bounded swap cannot acquire the external provider maximum budget");
if (!resumeDeliveryValidation && !broadcast && nativeBalance < requiredWrapInput + remainingGasCeiling) throw new Error("Operator wallet cannot preserve the maximum swap input and gas ceiling");

const preflight = {
  schemaVersion: "positioncrew.live-match.activation-preflight.v1",
  mode: broadcast ? "BROADCAST_REQUESTED" : "DRY_RUN",
  chainId,
  wallet: EXPECTED_WALLET,
  accountToInspect,
  balances: { nativeWei: nativeBalance, wrappedNativeWei: wrappedBalance, paymentTokenAtomic: tokenBalance },
  swap: {
    inputWei: SWAP_INPUT,
    requiredAdditionalWrapWei: requiredWrapInput,
    quotedOutputAtomic: quotedOutput,
    minimumOutputAtomic: minimumOutput,
    maximumSlippageBps: MAX_SLIPPAGE_BPS,
    route: { tokenIn: WBNB, tokenOut: paymentToken, fee: FEE, router: PANCAKE_V3_ROUTER },
  },
  activation: { provider: payment.provider, kernel: payment.kernel, maximumBudgetAtomic: PAYMENT_BUDGET },
  maximumTotalGasWei: MAX_TOTAL_GAS,
  gasAlreadySpentWei: gasAlreadySpent,
  remainingGasCeilingWei: remainingGasCeiling,
  boundary: "Dry-run proves current balances, chain binding, contract addresses and swap output only. It does not prove delivery compatibility or authorize a transaction.",
};

if (!broadcast) {
  process.stdout.write(`${json(preflight)}\n`);
  process.exit(0);
}
if (confirmation !== "I_CONFIRM_POSITIONCREW_MAINNET_ACTIVATION") {
  throw new Error("Broadcast requires --confirmation-token=I_CONFIRM_POSITIONCREW_MAINNET_ACTIVATION after explicit user approval");
}
const keyPath = process.env.POSITIONCREW_OPERATOR_KEY_FILE;
if (!keyPath) throw new Error("POSITIONCREW_OPERATOR_KEY_FILE is required for broadcast mode");
const privateKey = await loadPrivateKey(keyPath);
const account = privateKeyToAccount(privateKey);
if (getAddress(account.address) !== EXPECTED_WALLET) throw new Error("Operator key does not match the frozen wallet");
const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });
let cumulativeGas = 0n;
let committedSwapInput = existingCommittedSwapInput;
const transactions: Array<{ phase: string; hash: Hex; gasWei: bigint }> = [];

async function enforceTotalGas(phase: string): Promise<void> {
  const currentNativeBalance = await publicClient.getBalance({ address: EXPECTED_WALLET });
  const totalNativeDecrease = CAMPAIGN_STARTING_NATIVE_BALANCE - currentNativeBalance;
  if (totalNativeDecrease < committedSwapInput) {
    throw new Error(`${phase} native-balance accounting is inconsistent`);
  }
  cumulativeGas = totalNativeDecrease - committedSwapInput;
  if (cumulativeGas > MAX_TOTAL_GAS) {
    throw new Error(`${phase} exceeded the frozen total gas ceiling`);
  }
}

async function record(phase: string, hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${phase} transaction reverted: ${hash}`);
  const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;
  transactions.push({ phase, hash, gasWei });
  await enforceTotalGas(phase);
}

const outputPath = resolve(
  argument("output") ??
    `positioncrew-external-activation-${resumeJobId?.toString() ?? crypto.randomUUID()}.json`,
);
const resumeCheckpointPath = resumeCheckpointArgument ? resolve(resumeCheckpointArgument) : null;
if (resumeCheckpointPath === outputPath) {
  throw new Error("Resume checkpoint and new output checkpoint must use different paths");
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${json({
  schemaVersion: "positioncrew.live-match.external-activation-checkpoint.v1",
  recordedAt: new Date().toISOString(),
  state: "BROADCAST_NOT_STARTED",
  preflight,
  resumeJobId,
  boundary: "The output path is writable and the dry-run passed. No transaction represented by this checkpoint has been broadcast.",
})}\n`, { mode: 0o600, flag: "wx" });

let frozenJob;
let quote;
let resumeCheckpointState: string | null = null;
let resumeCheckpointNotification: unknown = null;
let checkpointCommittedSwapInput = 0n;
if (resumeJobId !== null && resumeCheckpointPath) {
  const checkpoint = JSON.parse(await readFile(resumeCheckpointPath, "utf8")) as Record<string, unknown>;
  resumeCheckpointState = typeof checkpoint.state === "string" ? checkpoint.state : null;
  resumeCheckpointNotification = checkpoint.notification ?? null;
  const recordedSwap = Array.isArray(checkpoint.transactions)
    ? checkpoint.transactions.find((entry) =>
      typeof entry === "object" && entry !== null &&
      (entry as Record<string, unknown>).phase === "swap-wbnb-for-u" &&
      typeof (entry as Record<string, unknown>).hash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test((entry as Record<string, unknown>).hash as string)
    ) as Record<string, unknown> | undefined
    : undefined;
  if (recordedSwap) {
    const swapHash = recordedSwap.hash as Hex;
    const [swapTransaction, swapReceipt] = await Promise.all([
      publicClient.getTransaction({ hash: swapHash }),
      publicClient.getTransactionReceipt({ hash: swapHash }),
    ]);
    const decodedSwap = decodeFunctionData({ abi: routerAbi, data: swapTransaction.input });
    const [swapParameters] = decodedSwap.args;
    if (
      swapReceipt.status !== "success" ||
      swapTransaction.from.toLowerCase() !== EXPECTED_WALLET.toLowerCase() ||
      swapTransaction.to?.toLowerCase() !== PANCAKE_V3_ROUTER.toLowerCase() ||
      decodedSwap.functionName !== "exactInputSingle" ||
      swapParameters.amountIn !== SWAP_INPUT ||
      swapParameters.tokenIn.toLowerCase() !== WBNB.toLowerCase() ||
      swapParameters.tokenOut.toLowerCase() !== paymentToken.toLowerCase()
    ) {
      throw new Error("Resume checkpoint swap transaction does not match the frozen acquisition");
    }
    checkpointCommittedSwapInput = SWAP_INPUT;
  }
  if (String(checkpoint.commerceJobId) !== resumeJobId.toString()) {
    throw new Error("Resume checkpoint does not bind the requested ERC-8183 job ID");
  }
  const storedQuote = checkpoint.reaffirmationQuote ?? checkpoint.quote;
  const checkpointQuote = typeof storedQuote === "object" && storedQuote !== null
    ? storedQuote as Record<string, unknown>
    : null;
  if (!checkpointQuote) throw new Error("Resume checkpoint has no immutable accepted quote");
  frozenJob = HealthFactorLiveMatchJobSchema.parse(checkpoint.frozenJob ?? checkpointQuote.frozenJob);
  if (frozenJob.account.toLowerCase() !== accountToInspect.toLowerCase()) {
    throw new Error("Resume checkpoint account does not match --account");
  }
  if (
    frozenJob.maximumPrice.amountAtomic !== PAYMENT_BUDGET.toString() ||
    frozenJob.maximumPrice.token.toLowerCase() !== paymentToken.toLowerCase()
  ) {
    throw new Error("Resume checkpoint payment boundary does not match the frozen activation budget and token");
  }
  if (!resumeDeliveryValidation && Date.parse(frozenJob.deadline) <= Date.now()) {
    throw new Error("Resume checkpoint frozen request is past its delivery deadline");
  }
  if (checkpointQuote.frozenJobHash !== canonicalHash(frozenJob)) {
    throw new Error("Resume checkpoint quote does not bind its frozen request");
  }
  const acceptedQuote = typeof checkpointQuote.quote === "object" && checkpointQuote.quote !== null
    ? checkpointQuote.quote as Record<string, unknown>
    : null;
  if (
    !acceptedQuote ||
    acceptedQuote.service !== "health_factor" ||
    typeof acceptedQuote.price !== "string" ||
    !/^\d+$/.test(acceptedQuote.price) ||
    BigInt(acceptedQuote.price) > PAYMENT_BUDGET ||
    typeof acceptedQuote.provider !== "string" ||
    acceptedQuote.provider.toLowerCase() !== payment.provider.toLowerCase() ||
    typeof acceptedQuote.verifying_contract !== "string" ||
    acceptedQuote.verifying_contract.toLowerCase() !== payment.kernel.toLowerCase() ||
    typeof acceptedQuote.payment_token !== "string" ||
    acceptedQuote.payment_token.toLowerCase() !== paymentToken.toLowerCase()
  ) {
    throw new Error("Resume checkpoint accepted quote is invalid or exceeds the frozen budget");
  }
  quote = checkpointQuote as unknown as Awaited<ReturnType<typeof requestBrainHealthFactorQuote>>;
} else {
  if (!challengeCheckpointArgument) {
    throw new Error(
      "Broadcast blocked: prepare and complete a zero-value challenge, then supply --challenge-checkpoint=<frozen challenge>.",
    );
  }
  const challengeCheckpoint = JSON.parse(
    await readFile(resolve(challengeCheckpointArgument), "utf8"),
  ) as Record<string, unknown>;
  if (challengeCheckpoint.schemaVersion !== "positioncrew.live-match.challenge-checkpoint.v1") {
    throw new Error("Challenge checkpoint schema is unsupported");
  }
  frozenJob = HealthFactorLiveMatchJobSchema.parse(challengeCheckpoint.frozenJob);
  if (challengeCheckpoint.frozenJobHash !== canonicalHash(frozenJob)) {
    throw new Error("Challenge checkpoint does not bind its frozen job");
  }
  if (frozenJob.account.toLowerCase() !== accountToInspect.toLowerCase()) {
    throw new Error("Challenge checkpoint account does not match --account");
  }
  if (
    frozenJob.maximumPrice.amountAtomic !== PAYMENT_BUDGET.toString() ||
    frozenJob.maximumPrice.token.toLowerCase() !== paymentToken.toLowerCase()
  ) {
    throw new Error("Challenge checkpoint payment boundary does not match the activation budget and token");
  }
  if (Date.parse(frozenJob.deadline) <= Date.now()) {
    throw new Error("Challenge checkpoint is past its delivery deadline");
  }
  quote = await requestBrainHealthFactorQuote(frozenJob);
}
const acceptedPrice = BigInt(quote.quote.price);
if (!resumeDeliveryValidation) {
  existingCommittedSwapInput = checkpointCommittedSwapInput > 0n
    ? checkpointCommittedSwapInput
    : wrappedBalance < SWAP_INPUT ? wrappedBalance : SWAP_INPUT;
  committedSwapInput = existingCommittedSwapInput;
  requiredWrapInput = tokenBalance >= acceptedPrice ? 0n : SWAP_INPUT - existingCommittedSwapInput;
  const exactNativeDecrease = CAMPAIGN_STARTING_NATIVE_BALANCE - nativeBalance;
  if (exactNativeDecrease < existingCommittedSwapInput) throw new Error("Campaign native-balance accounting is inconsistent");
  const exactGasAlreadySpent = exactNativeDecrease - existingCommittedSwapInput;
  if (exactGasAlreadySpent > MAX_TOTAL_GAS) throw new Error("Campaign gas ceiling was already exceeded");
  const exactRemainingGasCeiling = MAX_TOTAL_GAS - exactGasAlreadySpent;
  if (minimumOutput < acceptedPrice) throw new Error("Bounded swap cannot acquire the accepted provider quote");
  if (nativeBalance < requiredWrapInput + exactRemainingGasCeiling) throw new Error("Operator wallet cannot preserve the quoted swap input and gas ceiling");
}
if (!capabilityProofArgument && !paidCapabilityTrial) {
  throw new Error(
    "Broadcast blocked: supply --capability-proof=<provider-native zero-value challenge manifest> or explicitly choose --paid-capability-trial.",
  );
}
const capabilityProof = capabilityProofArgument
  ? await verifyBrainPrepaymentCapabilityProof(
      frozenJob,
      JSON.parse(await readFile(resolve(capabilityProofArgument), "utf8")) as unknown,
    )
  : null;
const sdkWallet = new EVMWalletProvider({ password: randomBytes(32).toString("hex"), privateKey, persist: false });
const client = await ERC8183Client.create({ walletProvider: sdkWallet, network: "bsc-mainnet" });
if (client.address !== EXPECTED_WALLET) throw new Error("SDK wallet identity changed after preflight");
const disputeWindow = await client.policy.disputeWindow();
const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + disputeWindow + 3_600n;
const descriptionBinding = {
  schema: frozenJob.schemaVersion,
  requestHash: quote.frozenJobHash,
  account: frozenJob.account,
  service: quote.quote.service,
  quotedPrice: quote.quote.price,
  capabilityMode: capabilityProof ? "PREPAYMENT_ZERO_VALUE_PROOF" : "PAID_DELIVERY_VALIDATION",
  capabilityProofHash: capabilityProof ? canonicalHash(capabilityProof.proof) : null,
};
const legacyDescriptionBinding = capabilityProof
  ? {
      schema: frozenJob.schemaVersion,
      requestHash: quote.frozenJobHash,
      account: frozenJob.account,
      service: quote.quote.service,
      quotedPrice: quote.quote.price,
      capabilityProofHash: canonicalHash(capabilityProof.proof),
    }
  : null;
const description = JSON.stringify(descriptionBinding);
let commerceJobId: bigint;
let originalOnchainDescription: string;
let resumedJobBudget: bigint | null = null;
let resumedJobStatus: JobStatus | null = null;
if (resumeJobId !== null) {
  const existingJob = await client.getJob(resumeJobId);
  if (existingJob.client.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) throw new Error("Resumed job client does not match the frozen wallet");
  if (existingJob.provider.toLowerCase() !== payment.provider.toLowerCase()) throw new Error("Resumed job provider does not match the accepted quote");
  const resumableForDelivery = existingJob.status === JobStatus.FUNDED ||
    existingJob.status === JobStatus.SUBMITTED ||
    existingJob.status === JobStatus.COMPLETED;
  if (resumeDeliveryValidation ? !resumableForDelivery : existingJob.status !== JobStatus.OPEN) {
    throw new Error(resumeDeliveryValidation
      ? "Delivery-validation resume requires a FUNDED, SUBMITTED, or COMPLETED job"
      : "Transaction resume requires an OPEN job");
  }
  const legacyMaximumBudget = existingJob.budget === PAYMENT_BUDGET &&
    (resumeDeliveryValidation || existingJob.status === JobStatus.OPEN);
  if (existingJob.budget !== 0n && existingJob.budget !== acceptedPrice && !legacyMaximumBudget) {
    throw new Error("Resumed job budget does not match the accepted quote");
  }
  if (!resumeDeliveryValidation && existingJob.expiredAt <= BigInt(Math.floor(Date.now() / 1000)) + disputeWindow) throw new Error("Resumed job cannot clear the policy dispute window");
  let existingDescription: unknown;
  try {
    existingDescription = JSON.parse(existingJob.description) as unknown;
  } catch {
    throw new Error("Resumed job description is not valid JSON");
  }
  if (
    canonicalHash(existingDescription) !== canonicalHash(descriptionBinding) &&
    (!legacyDescriptionBinding || canonicalHash(existingDescription) !== canonicalHash(legacyDescriptionBinding))
  ) {
    throw new Error("Resumed job description does not bind the current account, request hash, service, and quote");
  }
  commerceJobId = resumeJobId;
  originalOnchainDescription = existingJob.description;
  resumedJobBudget = existingJob.budget;
  resumedJobStatus = existingJob.status;
} else {
  const creation = await client.createJob({ provider: payment.provider, expiredAt, description });
  await enforceTotalGas("create-job");
  if (creation.jobId === null) throw new Error("ERC-8183 job was broadcast but its job ID could not be recovered; reconcile before retrying");
  commerceJobId = creation.jobId;
  originalOnchainDescription = description;
}
await writeFile(outputPath, `${json({
  schemaVersion: "positioncrew.live-match.external-activation-checkpoint.v1",
  recordedAt: new Date().toISOString(),
  state: "ESCROW_SETUP_PENDING",
  preflight,
  commerceJobId,
  resumedExistingJob: resumeJobId !== null,
  originalOnchainDescription,
  frozenJob,
  reaffirmationQuote: quote,
  capabilityProof,
  transactions,
  cumulativeGasWei: cumulativeGas,
  boundary: "The exact job terms and commerce job ID are durable. Registration, budget setup, funding, and provider notification may still be pending.",
})}\n`, { mode: 0o600 });
let notification: Awaited<ReturnType<typeof notifyBrainHealthFactorFunded>> | null = null;
if (!resumeDeliveryValidation) {
  if (resumeJobId !== null) {
    if (resumedJobBudget !== acceptedPrice) {
      await client.setBudget(commerceJobId, acceptedPrice);
      await enforceTotalGas("set-budget");
    }
  } else {
    await client.registerJob(commerceJobId);
    await enforceTotalGas("register-job");
    await client.setBudget(commerceJobId, acceptedPrice);
    await enforceTotalGas("set-budget");
  }
  if (tokenBalance < acceptedPrice) {
    if (requiredWrapInput > 0n) {
      committedSwapInput += requiredWrapInput;
      await record("wrap-bnb", await walletClient.writeContract({ account, chain: bsc, address: WBNB, abi: wbnbAbi, functionName: "deposit", value: requiredWrapInput }));
    }
    const allowance = await publicClient.readContract({ address: WBNB, abi: erc20Abi, functionName: "allowance", args: [EXPECTED_WALLET, PANCAKE_V3_ROUTER] });
    if (allowance < SWAP_INPUT) {
      await record("approve-wbnb", await walletClient.writeContract({ account, chain: bsc, address: WBNB, abi: erc20Abi, functionName: "approve", args: [PANCAKE_V3_ROUTER, SWAP_INPUT] }));
    }
    await record("swap-wbnb-for-u", await walletClient.writeContract({
      account,
      chain: bsc,
      address: PANCAKE_V3_ROUTER,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [{ tokenIn: WBNB, tokenOut: paymentToken, fee: FEE, recipient: EXPECTED_WALLET, amountIn: SWAP_INPUT, amountOutMinimum: minimumOutput, sqrtPriceLimitX96: 0n }],
    }));
  }
  await writeFile(outputPath, `${json({
    schemaVersion: "positioncrew.live-match.external-activation-checkpoint.v1",
    recordedAt: new Date().toISOString(),
    state: "ESCROW_FUNDING_PENDING",
    preflight,
    commerceJobId,
    resumedExistingJob: resumeJobId !== null,
    originalOnchainDescription,
    frozenJob,
    reaffirmationQuote: quote,
    capabilityProof,
    transactions,
    cumulativeGasWei: cumulativeGas,
    boundary: "The exact job terms are verified and the recovery checkpoint is durable. Escrow funding and provider notification have not started.",
  })}\n`, { mode: 0o600 });
  await client.fund(commerceJobId, acceptedPrice, { approveFloor: 0n });
  await enforceTotalGas("fund-job");
  await writeFile(outputPath, `${json({
    schemaVersion: "positioncrew.live-match.external-activation-checkpoint.v1",
    recordedAt: new Date().toISOString(),
    state: "FUNDED_NOTIFICATION_PENDING",
    preflight,
    commerceJobId,
    resumedExistingJob: resumeJobId !== null,
    originalOnchainDescription,
    reaffirmationQuote: quote,
    capabilityProof,
    transactions,
    cumulativeGasWei: cumulativeGas,
    boundary: "Escrow funding is confirmed, but provider notification, delivery and PositionCrew output compatibility remain pending.",
  })}\n`, { mode: 0o600 });
  notification = await notifyBrainHealthFactorFunded({ messageId: frozenJob.jobId, commerceJobId, account: accountToInspect });
}

let finalStatus = resumeDeliveryValidation && resumedJobStatus !== null
  ? resumedJobStatus
  : await client.getJobStatus(commerceJobId);
if (
  resumeDeliveryValidation &&
  finalStatus === JobStatus.FUNDED &&
  resumeCheckpointState !== null &&
  ["ESCROW_SETUP_PENDING", "ESCROW_FUNDING_PENDING", "FUNDED_NOTIFICATION_PENDING"].includes(resumeCheckpointState) &&
  resumeCheckpointNotification === null
) {
  notification = await notifyBrainHealthFactorFunded({ messageId: frozenJob.jobId, commerceJobId, account: accountToInspect });
}
const pollDeadline = resumeDeliveryValidation
  ? Date.parse(frozenJob.deadline)
  : Math.min(Date.now() + 5 * 60_000, Date.parse(frozenJob.deadline));
while (finalStatus === JobStatus.FUNDED && Date.now() < pollDeadline) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  finalStatus = await client.getJobStatus(commerceJobId);
}
let deliverableUrl: string | null = null;
let deliverable: unknown = null;
let deliveryRetrievalError: string | null = null;
let deliveryContentHash: `0x${string}` | null = null;
let submittedDeliverableHash: `0x${string}` | null = null;
let deliveryHashMatches = false;
let deliveryReceived = false;
let deliverySubmittedAt: string | null = null;
let deliverySubmittedWithinDeadline = false;
if (finalStatus === JobStatus.SUBMITTED || finalStatus === JobStatus.COMPLETED) {
  try {
    deliverableUrl = await client.getDeliverableUrl(commerceJobId);
    if (!deliverableUrl) throw new Error("Submitted job has no deliverable URL");
    const fetched = await boundedDocument(deliverableUrl, new URL(quote.endpoint).origin);
    deliveryContentHash = `0x${createHash("sha256").update(fetched.raw).digest("hex")}`;
    const submittedJob = await client.getJob(commerceJobId);
    submittedDeliverableHash = submittedJob.deliverable;
    deliverySubmittedAt = submittedJob.submittedAt > 0n
      ? new Date(Number(submittedJob.submittedAt) * 1_000).toISOString()
      : null;
    deliverySubmittedWithinDeadline = submittedJob.submittedAt > 0n &&
      submittedJob.submittedAt <= BigInt(Math.floor(Date.parse(frozenJob.deadline) / 1_000));
    deliveryHashMatches = deliveryContentHash.toLowerCase() === submittedDeliverableHash.toLowerCase();
    if (!deliveryHashMatches) throw new Error(`Fetched delivery hash ${deliveryContentHash} does not match onchain submission ${submittedDeliverableHash}`);
    if (!deliverySubmittedWithinDeadline) throw new Error(`Onchain delivery was submitted at ${deliverySubmittedAt ?? "an unknown time"}, after the frozen deadline ${frozenJob.deadline}`);
    deliveryReceived = true;
    deliverable = unwrapBrainResult(fetched.document);
  } catch (error) {
    deliveryRetrievalError = error instanceof Error ? error.message : "Unknown delivery retrieval failure";
  }
}
const compatibility = deliveryReceived && deliveryHashMatches
  ? validateBrainHealthFactorDelivery(frozenJob, deliverable, deliverySubmittedAt ?? undefined)
  : null;
const compatible = compatibility?.status === "COMPATIBLE";
const evidence = {
  schemaVersion: "positioncrew.live-match.external-activation.v1",
  recordedAt: new Date().toISOString(),
  preflight,
  frozenJob,
  quote,
  capabilityProof,
  commerceJobId,
  resumedExistingJob: resumeJobId !== null,
  originalOnchainDescription,
  transactions,
  cumulativeGasWei: cumulativeGas,
  notification,
  finalStatus: JobStatus[finalStatus],
  deliverableUrl,
  deliverable,
  deliveryRetrievalError,
  deliveryContentHash,
  submittedDeliverableHash,
  deliveryHashMatches,
  deliveryReceived,
  deliverySubmittedAt,
  deliverySubmittedWithinDeadline,
  compatibility,
  states: {
    identity: "REGISTRY_OBSERVED",
    liveness: "A2A_RESPONDED",
    activation: "MAINNET_ERC8183_FUNDED",
    delivery: deliveryReceived
      ? "DELIVERED"
      : deliveryRetrievalError
        ? "DELIVERY_RETRIEVAL_FAILED"
        : "NOT_DELIVERED_WITHIN_POLL_WINDOW",
    compatibility: compatible
      ? "EXACT_JOB_COMPATIBLE"
      : deliveryReceived
        ? "EXACT_JOB_INCOMPATIBLE"
        : "PENDING_PROVIDER_DELIVERY",
    selection: compatible ? "SELECTED_FOR_FUNDED_JOB" : "NOT_ELIGIBLE_YET",
  },
  boundary: compatible
    ? "The buyer funded this provider for the frozen job and its attributable delivery passed every PositionCrew category check. This proves selection for this job, not general provider superiority, protocol execution, or investment performance."
    : "Funding proves attributable mainnet activation only. The provider remains ineligible because no delivered output passed every category-specific check without invented fields.",
};
await writeFile(outputPath, `${json(evidence)}\n`, { mode: 0o600 });
process.stdout.write(`${json({ outputPath, commerceJobId, finalStatus: JobStatus[finalStatus], deliverableUrl, cumulativeGasWei: cumulativeGas, transactions })}\n`);
