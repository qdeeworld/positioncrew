import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EVMWalletProvider, ERC8183Client, JobStatus } from "@bnbagent/sdk";
import {
  createPublicClient,
  createWalletClient,
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

async function boundedJson(url: string, maximumBytes = 128 * 1024): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
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
  return JSON.parse(new TextDecoder().decode(body));
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
const accountToInspect = getAddress(argument("account") ?? DEFAULT_ACCOUNT);
const rpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const payment = brainOnBnbPaymentContract();
const paymentToken = getAddress(payment.paymentToken);
const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
const [chainId, nativeBalance, tokenBalance, wrappedBalance, quoted] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: EXPECTED_WALLET }),
  publicClient.readContract({ address: paymentToken, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] }),
  publicClient.readContract({ address: WBNB, abi: erc20Abi, functionName: "balanceOf", args: [EXPECTED_WALLET] }),
  publicClient.simulateContract({
    account: EXPECTED_WALLET,
    address: PANCAKE_V3_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: WBNB, tokenOut: paymentToken, amountIn: SWAP_INPUT, fee: FEE, sqrtPriceLimitX96: 0n }],
  }),
]);
if (chainId !== 56) throw new Error(`RPC chain mismatch: expected 56, received ${chainId}`);
const [quotedOutput] = quoted.result;
const minimumOutput = quotedOutput * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n;
const existingCommittedSwapInput = tokenBalance >= PAYMENT_BUDGET
  ? SWAP_INPUT
  : wrappedBalance < SWAP_INPUT ? wrappedBalance : SWAP_INPUT;
const requiredWrapInput = tokenBalance >= PAYMENT_BUDGET ? 0n : SWAP_INPUT - existingCommittedSwapInput;
const nativeDecrease = CAMPAIGN_STARTING_NATIVE_BALANCE - nativeBalance;
if (nativeDecrease < existingCommittedSwapInput) throw new Error("Campaign native-balance accounting is inconsistent");
const gasAlreadySpent = nativeDecrease - existingCommittedSwapInput;
if (gasAlreadySpent > MAX_TOTAL_GAS) throw new Error("Campaign gas ceiling was already exceeded");
const remainingGasCeiling = MAX_TOTAL_GAS - gasAlreadySpent;
if (minimumOutput < PAYMENT_BUDGET) throw new Error("Bounded swap cannot acquire the external provider budget");
if (nativeBalance < requiredWrapInput + remainingGasCeiling) throw new Error("Operator wallet cannot preserve the remaining swap input and gas ceiling");

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
  activation: { provider: payment.provider, kernel: payment.kernel, budgetAtomic: PAYMENT_BUDGET },
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
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${json({
  schemaVersion: "positioncrew.live-match.external-activation-checkpoint.v1",
  recordedAt: new Date().toISOString(),
  state: "BROADCAST_NOT_STARTED",
  preflight,
  resumeJobId,
  boundary: "The output path is writable and the dry-run passed. No transaction represented by this checkpoint has been broadcast.",
})}\n`, { mode: 0o600, flag: "wx" });

const now = new Date();
const frozenJob = HealthFactorLiveMatchJobSchema.parse({
  schemaVersion: "positioncrew.live-match.health-factor-job.v1",
  jobId: `pc-live-match-${crypto.randomUUID()}`,
  category: "HEALTH_FACTOR_MONITORING",
  chainId: 56,
  protocol: "Venus Classic",
  account: accountToInspect,
  requestedAt: now.toISOString(),
  deadline: new Date(now.getTime() + 15 * 60_000).toISOString(),
  requiredOutputs: ["CURRENT_HEALTH_FACTOR", "LIQUIDATION_DISTANCE", "COLLATERAL_STRESS_TABLE", "PROTOCOL_CROSS_CHECK", "BLOCK_ATTRIBUTION"],
  maximumPrice: { amountAtomic: PAYMENT_BUDGET.toString(), token: paymentToken, chainId: 56 },
});
const quote = await requestBrainHealthFactorQuote(frozenJob);
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
};
const description = JSON.stringify(descriptionBinding);
let commerceJobId: bigint;
let originalOnchainDescription: string;
let resumedJobBudget: bigint | null = null;
if (resumeJobId !== null) {
  const existingJob = await client.getJob(resumeJobId);
  if (existingJob.client.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) throw new Error("Resumed job client does not match the frozen wallet");
  if (existingJob.provider.toLowerCase() !== payment.provider.toLowerCase()) throw new Error("Resumed job provider does not match the accepted quote");
  if (existingJob.status !== JobStatus.OPEN) throw new Error("Resumed job is not OPEN");
  if (existingJob.budget !== 0n && existingJob.budget !== PAYMENT_BUDGET) throw new Error("Resumed job has an unexpected budget");
  if (existingJob.expiredAt <= BigInt(Math.floor(Date.now() / 1000)) + disputeWindow) throw new Error("Resumed job cannot clear the policy dispute window");
  let existingDescription: unknown;
  try {
    existingDescription = JSON.parse(existingJob.description) as unknown;
  } catch {
    throw new Error("Resumed job description is not valid JSON");
  }
  if (canonicalHash(existingDescription) !== canonicalHash(descriptionBinding)) {
    throw new Error("Resumed job description does not bind the current account, request hash, service, and quote");
  }
  commerceJobId = resumeJobId;
  originalOnchainDescription = existingJob.description;
  resumedJobBudget = existingJob.budget;
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
  transactions,
  cumulativeGasWei: cumulativeGas,
  boundary: "The exact job terms and commerce job ID are durable. Registration, budget setup, funding, and provider notification may still be pending.",
})}\n`, { mode: 0o600 });
if (resumeJobId !== null) {
  if (resumedJobBudget === 0n) {
    await client.setBudget(commerceJobId, PAYMENT_BUDGET);
    await enforceTotalGas("set-budget");
  }
} else {
  await client.registerJob(commerceJobId);
  await enforceTotalGas("register-job");
  await client.setBudget(commerceJobId, PAYMENT_BUDGET);
  await enforceTotalGas("set-budget");
}
if (tokenBalance < PAYMENT_BUDGET) {
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
  transactions,
  cumulativeGasWei: cumulativeGas,
  boundary: "The exact job terms are verified and the recovery checkpoint is durable. Escrow funding and provider notification have not started.",
})}\n`, { mode: 0o600 });
await client.fund(commerceJobId, PAYMENT_BUDGET, { approveFloor: 0n });
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
  transactions,
  cumulativeGasWei: cumulativeGas,
  boundary: "Escrow funding is confirmed, but provider notification, delivery and PositionCrew output compatibility remain pending.",
})}\n`, { mode: 0o600 });
const notification = await notifyBrainHealthFactorFunded({ messageId: frozenJob.jobId, commerceJobId, account: accountToInspect });

let finalStatus = await client.getJobStatus(commerceJobId);
const pollDeadline = Date.now() + 5 * 60_000;
while (finalStatus === JobStatus.FUNDED && Date.now() < pollDeadline) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  finalStatus = await client.getJobStatus(commerceJobId);
}
const deliverableUrl = finalStatus === JobStatus.SUBMITTED || finalStatus === JobStatus.COMPLETED
  ? await client.getDeliverableUrl(commerceJobId)
  : null;
const deliverable = deliverableUrl ? await boundedJson(deliverableUrl) : null;
const evidence = {
  schemaVersion: "positioncrew.live-match.external-activation.v1",
  recordedAt: new Date().toISOString(),
  preflight,
  frozenJob,
  quote,
  commerceJobId,
  resumedExistingJob: resumeJobId !== null,
  originalOnchainDescription,
  transactions,
  cumulativeGasWei: cumulativeGas,
  notification,
  finalStatus: JobStatus[finalStatus],
  deliverableUrl,
  deliverable,
  states: {
    identity: "REGISTRY_OBSERVED",
    liveness: "A2A_RESPONDED",
    activation: "MAINNET_ERC8183_FUNDED",
    delivery: deliverable ? "DELIVERED_UNVALIDATED" : "NOT_DELIVERED_WITHIN_POLL_WINDOW",
    compatibility: "PENDING_POSITIONCREW_OUTPUT_VALIDATOR",
    selection: "NOT_ELIGIBLE_YET",
  },
  boundary: "Funding proves attributable mainnet activation only. The provider is not PositionCrew-compatible or eligible until its delivered output passes a category-specific validator without invented fields.",
};
await writeFile(outputPath, `${json(evidence)}\n`, { mode: 0o600 });
process.stdout.write(`${json({ outputPath, commerceJobId, finalStatus: JobStatus[finalStatus], deliverableUrl, cumulativeGasWei: cumulativeGas, transactions })}\n`);
