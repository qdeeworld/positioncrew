import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseTransaction,
  parseAbi,
  recoverTransactionAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";
import {
  VENUS_TESTNET_NATIVE_SUPPLY,
  VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY,
  VenusTestnetNativeSupplyEvidenceSchema,
  VenusTestnetNativeSupplyIntentSchema,
  VenusTestnetNativeSupplySubmissionSchema,
  commitVenusTestnetNativeSupplyEvidence,
  commitVenusTestnetNativeSupplyIntent,
  commitVenusTestnetNativeSupplySubmission,
  verifyVenusTestnetNativeSupplyEvidence,
  verifyVenusTestnetNativeSupplySubmission,
  type VenusAccountSnapshotEvidence,
  type VenusTestnetNativeSupplyEvidence,
  type VenusTestnetNativeSupplyIntent,
  type VenusTestnetNativeSupplySubmission,
} from "./venus-testnet-native-supply-evidence.js";

const VBNB_ABI = parseAbi([
  "function mint() payable",
  "function comptroller() view returns (address)",
  "function balanceOf(address account) view returns (uint256)",
  "function getAccountSnapshot(address account) view returns (uint256 errorCode, uint256 vTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)",
  "event Mint(address minter, uint256 mintAmount, uint256 mintTokens)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

const UNITROLLER_ABI = parseAbi([
  "function markets(address market) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)",
]);

export interface VenusRpcTransaction {
  hash: Hash;
  chainId: number | null;
  type: string;
  blockNumber: bigint | null;
  blockHash: Hash | null;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  gasPrice: bigint | null;
}

export interface VenusRpcReceipt {
  transactionHash: Hash;
  blockNumber: bigint;
  blockHash: Hash;
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: Array<{ address: Address; data: Hex; topics: readonly Hex[]; logIndex: number }>;
}

export interface VenusNativeSupplyRpc {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlockHash(blockNumber: bigint): Promise<Hash | null>;
  getBalance(address: Address, blockNumber?: bigint): Promise<bigint>;
  getPendingNonce(address: Address): Promise<number>;
  getCodeHash(address: Address, blockNumber?: bigint): Promise<Hash | null>;
  getComptroller(vToken: Address, blockNumber?: bigint): Promise<Address>;
  getMarket(comptroller: Address, vToken: Address, blockNumber?: bigint): Promise<{ isListed: boolean; isVenus: boolean }>;
  getVTokenBalance(vToken: Address, account: Address, blockNumber?: bigint): Promise<bigint>;
  getAccountSnapshot(vToken: Address, account: Address, blockNumber?: bigint): Promise<readonly [bigint, bigint, bigint, bigint]>;
  simulateMint(vToken: Address, account: Address, value: bigint): Promise<void>;
  estimateMintGas(vToken: Address, account: Address, value: bigint): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  sendRawTransaction(rawTransaction: Hex): Promise<Hash>;
  getTransaction(hash: Hash): Promise<VenusRpcTransaction | null>;
  getTransactionReceipt(hash: Hash): Promise<VenusRpcReceipt>;
}

export interface VenusNativeSupplySigner {
  address: Address;
  signLegacyTransaction(transaction: {
    chainId: 97;
    to: Address;
    data: Hex;
    value: bigint;
    nonce: number;
    gas: bigint;
    gasPrice: bigint;
  }): Promise<Hex>;
}

export interface VenusNativeSupplyDependencies {
  testnet: VenusNativeSupplyRpc;
  mainnet: Pick<VenusNativeSupplyRpc, "getChainId" | "getBalance" | "getPendingNonce">;
}

function normalizeSnapshot(snapshot: readonly [bigint, bigint, bigint, bigint]): VenusAccountSnapshotEvidence {
  if (snapshot[0] !== 0n) throw new Error(`Venus account snapshot returned error ${snapshot[0]}`);
  return {
    errorCode: "0",
    vTokenBalanceRaw: snapshot[1].toString(),
    borrowBalanceRaw: snapshot[2].toString(),
    exchangeRateMantissa: snapshot[3].toString(),
  };
}

function requireExactActor(actorInput: string): typeof VENUS_TESTNET_NATIVE_SUPPLY.actor {
  const actor = getAddress(actorInput);
  if (actor !== VENUS_TESTNET_NATIVE_SUPPLY.actor) {
    throw new Error(`Actor must be the dedicated testnet wallet ${VENUS_TESTNET_NATIVE_SUPPLY.actor}`);
  }
  return VENUS_TESTNET_NATIVE_SUPPLY.actor;
}

function requireCodeHash(actual: Hash | null, expected: string, label: string): void {
  if (!actual) throw new Error(`${label} has no runtime bytecode`);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} runtime bytecode hash mismatch`);
  }
}

function sameHash(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertRpcTransactionMatchesIntent(
  transaction: VenusRpcTransaction,
  expectedHash: Hash,
  intent: VenusTestnetNativeSupplyIntent,
): void {
  if (!sameHash(transaction.hash, expectedHash)) throw new Error("Fetched transaction hash mismatch");
  if (transaction.chainId !== 97 || transaction.type !== "legacy") {
    throw new Error("Transaction is not a legacy EIP-155 BSC Testnet transaction");
  }
  if (
    getAddress(transaction.from) !== getAddress(intent.actor) ||
    !transaction.to || getAddress(transaction.to) !== getAddress(intent.transaction.to) ||
    transaction.input.toLowerCase() !== intent.transaction.data.toLowerCase() ||
    transaction.value !== BigInt(intent.transaction.valueWei) ||
    transaction.nonce !== Number(intent.transaction.nonce) ||
    transaction.gas !== BigInt(intent.transaction.gasLimit) ||
    transaction.gasPrice !== BigInt(intent.transaction.gasPriceWei)
  ) {
    throw new Error("Transaction does not match the frozen Venus supply intent");
  }
}

async function assertMainnetIsolation(
  mainnet: VenusNativeSupplyDependencies["mainnet"],
  actor: Address,
  observedAt: string,
) {
  const chainId = await mainnet.getChainId();
  if (chainId !== VENUS_TESTNET_NATIVE_SUPPLY.mainnetChainId) {
    throw new Error(`Mainnet isolation RPC returned chain ${chainId}, expected 56`);
  }
  const [nativeBalance, pendingNonce] = await Promise.all([
    mainnet.getBalance(actor),
    mainnet.getPendingNonce(actor),
  ]);
  if (nativeBalance !== 0n) throw new Error("Dedicated testnet signer has non-zero BSC mainnet native balance");
  if (pendingNonce !== 0) throw new Error("Dedicated testnet signer has a non-zero BSC mainnet pending nonce");
  return {
    observedAt,
    chainId: 56 as const,
    nativeBalanceWei: "0" as const,
    pendingNonce: "0" as const,
  };
}

async function assertProtocolState(
  client: VenusNativeSupplyRpc,
  actor: Address,
  blockNumber: bigint,
) {
  const vToken = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb);
  const comptroller = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.unitroller);
  const [vTokenCode, comptrollerCode, reportedComptroller, market, nativeBalance, vTokenBalance, accountSnapshot] =
    await Promise.all([
      client.getCodeHash(vToken, blockNumber),
      client.getCodeHash(comptroller, blockNumber),
      client.getComptroller(vToken, blockNumber),
      client.getMarket(comptroller, vToken, blockNumber),
      client.getBalance(actor, blockNumber),
      client.getVTokenBalance(vToken, actor, blockNumber),
      client.getAccountSnapshot(vToken, actor, blockNumber),
    ]);
  requireCodeHash(vTokenCode, VENUS_TESTNET_NATIVE_SUPPLY.vBnbRuntimeCodeHash, "Venus vBNB");
  requireCodeHash(comptrollerCode, VENUS_TESTNET_NATIVE_SUPPLY.unitrollerRuntimeCodeHash, "Venus Unitroller");
  if (getAddress(reportedComptroller) !== comptroller) throw new Error("vBNB reports an unexpected comptroller");
  if (!market.isListed || !market.isVenus) throw new Error("vBNB is not an active listed Venus market");
  if (accountSnapshot[0] !== 0n) throw new Error(`Venus account snapshot returned error ${accountSnapshot[0]}`);
  return { nativeBalance, vTokenBalance, accountSnapshot };
}

export async function prepareVenusTestnetNativeSupply(
  input: { actor: string; amountTbnb: string; operationId?: string; now?: Date },
  dependencies: VenusNativeSupplyDependencies,
): Promise<VenusTestnetNativeSupplyIntent> {
  const actor = requireExactActor(input.actor);
  if (input.amountTbnb !== VENUS_TESTNET_NATIVE_SUPPLY.amountTbnb) {
    throw new Error(`Supply amount must be exactly ${VENUS_TESTNET_NATIVE_SUPPLY.amountTbnb} tBNB`);
  }
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const [testnetChainId, blockNumber] = await Promise.all([
    dependencies.testnet.getChainId(),
    dependencies.testnet.getBlockNumber(),
  ]);
  if (testnetChainId !== VENUS_TESTNET_NATIVE_SUPPLY.chainId) {
    throw new Error(`Testnet RPC returned chain ${testnetChainId}, expected 97`);
  }
  const mainnetIsolation = await assertMainnetIsolation(dependencies.mainnet, actor, observedAt);
  const protocolState = await assertProtocolState(dependencies.testnet, actor, blockNumber);
  const amountWei = BigInt(VENUS_TESTNET_NATIVE_SUPPLY.amountWei);
  await dependencies.testnet.simulateMint(getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb), actor, amountWei);
  const [estimatedGas, gasPrice, pendingNonce] = await Promise.all([
    dependencies.testnet.estimateMintGas(getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb), actor, amountWei),
    dependencies.testnet.getGasPrice(),
    dependencies.testnet.getPendingNonce(actor),
  ]);
  if (!Number.isSafeInteger(pendingNonce) || pendingNonce < 0) throw new Error("Pending nonce is unsafe");
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  const maximumGasCost = gasLimit * gasPrice;
  if (gasPrice <= 0n || gasLimit <= 0n) throw new Error("Gas estimate and price must be positive");
  if (maximumGasCost > BigInt(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei)) {
    throw new Error("Estimated Venus supply gas cost exceeds the hard 0.0001 tBNB cap");
  }
  if (protocolState.nativeBalance < amountWei + maximumGasCost) {
    throw new Error("Dedicated testnet signer cannot fund the exact supply plus bounded gas");
  }
  const preflightWithoutHash = {
    observedAt,
    blockNumber: blockNumber.toString(),
    nativeBalanceWei: protocolState.nativeBalance.toString(),
    vTokenBalanceRaw: protocolState.vTokenBalance.toString(),
    accountSnapshot: normalizeSnapshot(protocolState.accountSnapshot),
    marketListed: true as const,
    venusMarket: true as const,
    comptrollerMatches: true as const,
    simulationPassed: true as const,
    mainnetIsolation,
  };
  const { canonicalHash } = await import("../core/canonical.js");
  return commitVenusTestnetNativeSupplyIntent({
    schemaVersion: "positioncrew.venus-testnet-native-supply-intent.v1",
    operationId: input.operationId ?? crypto.randomUUID(),
    createdAt: observedAt,
    expiresAt: new Date(now.getTime() + VENUS_TESTNET_NATIVE_SUPPLY.intentTtlMilliseconds).toISOString(),
    chainId: 97,
    actor,
    protocol: {
      vTokenAddress: VENUS_TESTNET_NATIVE_SUPPLY.vBnb,
      comptrollerAddress: VENUS_TESTNET_NATIVE_SUPPLY.unitroller,
      vTokenRuntimeCodeHash: VENUS_TESTNET_NATIVE_SUPPLY.vBnbRuntimeCodeHash,
      comptrollerRuntimeCodeHash: VENUS_TESTNET_NATIVE_SUPPLY.unitrollerRuntimeCodeHash,
      sourceCommit: VENUS_TESTNET_NATIVE_SUPPLY.sourceCommit,
      sourceUrls: [
        VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[0],
        VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[1],
        VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[2],
      ],
    },
    transaction: {
      type: "legacy",
      chainId: 97,
      from: actor,
      to: VENUS_TESTNET_NATIVE_SUPPLY.vBnb,
      data: VENUS_TESTNET_NATIVE_SUPPLY.mintSelector,
      amountTbnb: VENUS_TESTNET_NATIVE_SUPPLY.amountTbnb,
      valueWei: VENUS_TESTNET_NATIVE_SUPPLY.amountWei,
      nonce: pendingNonce.toString(),
      gasLimit: gasLimit.toString(),
      gasPriceWei: gasPrice.toString(),
      maxGasCostWei: VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei,
    },
    preflight: { ...preflightWithoutHash, preflightHash: canonicalHash(preflightWithoutHash) },
  });
}

export async function signVenusTestnetNativeSupply(
  intentInput: unknown,
  signer: VenusNativeSupplySigner,
  dependencies: VenusNativeSupplyDependencies,
  now = new Date(),
): Promise<VenusTestnetNativeSupplySubmission> {
  const intent = VenusTestnetNativeSupplyIntentSchema.parse(intentInput);
  const actor = requireExactActor(signer.address);
  if (actor !== intent.actor) throw new Error("Decrypted keystore does not control the reviewed actor");
  if (now.getTime() < Date.parse(intent.createdAt)) throw new Error("Signing clock precedes the Venus supply intent");
  if (now.getTime() >= Date.parse(intent.expiresAt)) throw new Error("Venus supply intent has expired");
  const [testnetChainId, pendingNonce, blockNumber, currentGasPrice] = await Promise.all([
    dependencies.testnet.getChainId(),
    dependencies.testnet.getPendingNonce(actor),
    dependencies.testnet.getBlockNumber(),
    dependencies.testnet.getGasPrice(),
  ]);
  if (testnetChainId !== 97) throw new Error("Testnet chain changed before signing");
  if (pendingNonce.toString() !== intent.transaction.nonce) throw new Error("Pending nonce changed after preparation");
  if (currentGasPrice > BigInt(intent.transaction.gasPriceWei)) throw new Error("Gas price rose above the reviewed legacy transaction price");
  await assertMainnetIsolation(dependencies.mainnet, actor, now.toISOString());
  const protocolState = await assertProtocolState(dependencies.testnet, actor, blockNumber);
  const maximumGasCost = BigInt(intent.transaction.gasLimit) * BigInt(intent.transaction.gasPriceWei);
  if (maximumGasCost > BigInt(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei)) throw new Error("Reviewed gas cost exceeds hard cap");
  if (protocolState.nativeBalance < BigInt(intent.transaction.valueWei) + maximumGasCost) {
    throw new Error("Dedicated testnet signer balance changed below the reviewed bound");
  }
  await dependencies.testnet.simulateMint(
    getAddress(intent.transaction.to),
    actor,
    BigInt(intent.transaction.valueWei),
  );
  const currentEstimatedGas = await dependencies.testnet.estimateMintGas(
    getAddress(intent.transaction.to),
    actor,
    BigInt(intent.transaction.valueWei),
  );
  if (currentEstimatedGas <= 0n || currentEstimatedGas > BigInt(intent.transaction.gasLimit)) {
    throw new Error("Current Venus mint gas estimate exceeds the frozen gas limit");
  }
  const rawTransaction = await signer.signLegacyTransaction({
    chainId: 97,
    to: getAddress(intent.transaction.to),
    data: intent.transaction.data as Hex,
    value: BigInt(intent.transaction.valueWei),
    nonce: Number(intent.transaction.nonce),
    gas: BigInt(intent.transaction.gasLimit),
    gasPrice: BigInt(intent.transaction.gasPriceWei),
  });
  return commitVenusTestnetNativeSupplySubmission({
    schemaVersion: "positioncrew.venus-testnet-native-supply-submission.v1",
    signedAt: now.toISOString(),
    intent,
    rawTransaction,
    transactionHash: keccak256(rawTransaction),
  });
}

export async function broadcastIdenticalVenusSubmission(
  submissionInput: unknown,
  dependencies: VenusNativeSupplyDependencies,
  clock: () => Date = () => new Date(),
): Promise<Hash> {
  const submission = verifyVenusTestnetNativeSupplySubmission(submissionInput);
  await assertSignedLegacyTransactionMatches({
    rawTransaction: submission.rawTransaction as Hex,
    transactionHash: submission.transactionHash as Hash,
    actor: getAddress(submission.intent.actor),
    chainId: 97,
    to: getAddress(submission.intent.transaction.to),
    data: submission.intent.transaction.data as Hex,
    value: BigInt(submission.intent.transaction.valueWei),
    nonce: Number(submission.intent.transaction.nonce),
    gas: BigInt(submission.intent.transaction.gasLimit),
    gasPrice: BigInt(submission.intent.transaction.gasPriceWei),
  });
  const inspection = await inspectVenusSubmissionBroadcastState(submission, dependencies, clock);
  if (inspection.state === "ALREADY_KNOWN") return inspection.transactionHash;
  if (clock().getTime() >= Date.parse(submission.intent.expiresAt)) {
    throw new Error("Venus supply intent expired immediately before broadcast");
  }
  const returnedHash = await dependencies.testnet.sendRawTransaction(submission.rawTransaction as Hex);
  if (returnedHash.toLowerCase() !== submission.transactionHash.toLowerCase()) {
    throw new Error("RPC returned a hash that does not match the frozen raw transaction");
  }
  return returnedHash;
}

export type VenusSubmissionBroadcastState =
  | { state: "ALREADY_KNOWN"; transactionHash: Hash }
  | { state: "READY_TO_SEND"; transactionHash: Hash };

export async function inspectVenusSubmissionBroadcastState(
  submissionInput: unknown,
  dependencies: VenusNativeSupplyDependencies,
  clock: () => Date = () => new Date(),
): Promise<VenusSubmissionBroadcastState> {
  const submission = verifyVenusTestnetNativeSupplySubmission(submissionInput);
  const transactionHash = submission.transactionHash as Hash;
  if (await dependencies.testnet.getChainId() !== 97) {
    throw new Error("Raw transaction broadcaster is not on BSC Testnet");
  }
  const knownTransaction = await dependencies.testnet.getTransaction(transactionHash);
  if (knownTransaction) {
    assertRpcTransactionMatchesIntent(knownTransaction, transactionHash, submission.intent);
    return { state: "ALREADY_KNOWN", transactionHash };
  }
  const currentTime = clock();
  if (currentTime.getTime() < Date.parse(submission.signedAt)) {
    throw new Error("Broadcast clock precedes the signed submission");
  }
  if (currentTime.getTime() >= Date.parse(submission.intent.expiresAt)) {
    throw new Error("Unknown Venus supply transaction cannot be broadcast after intent expiry");
  }
  const actor = getAddress(submission.intent.actor);
  if (await dependencies.testnet.getChainId() !== 97) throw new Error("Testnet chain changed before broadcast");
  const [pendingNonce, blockNumber] = await Promise.all([
    dependencies.testnet.getPendingNonce(actor),
    dependencies.testnet.getBlockNumber(),
  ]);
  if (pendingNonce.toString() !== submission.intent.transaction.nonce) {
    throw new Error("Pending nonce changed before broadcast");
  }
  await assertMainnetIsolation(dependencies.mainnet, actor, clock().toISOString());
  const protocolState = await assertProtocolState(dependencies.testnet, actor, blockNumber);
  const value = BigInt(submission.intent.transaction.valueWei);
  const maximumGasCost = BigInt(submission.intent.transaction.gasLimit) * BigInt(submission.intent.transaction.gasPriceWei);
  if (maximumGasCost > BigInt(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei)) {
    throw new Error("Frozen broadcast gas cost exceeds the hard cap");
  }
  if (protocolState.nativeBalance < value + maximumGasCost) {
    throw new Error("Dedicated testnet signer cannot fund the exact supply plus frozen gas");
  }
  await dependencies.testnet.simulateMint(getAddress(submission.intent.transaction.to), actor, value);
  const currentEstimatedGas = await dependencies.testnet.estimateMintGas(
    getAddress(submission.intent.transaction.to),
    actor,
    value,
  );
  if (currentEstimatedGas <= 0n || currentEstimatedGas > BigInt(submission.intent.transaction.gasLimit)) {
    throw new Error("Current Venus mint gas estimate exceeds the frozen gas limit before broadcast");
  }
  if (clock().getTime() >= Date.parse(submission.intent.expiresAt)) {
    throw new Error("Venus supply intent expired during final broadcast checks");
  }
  return { state: "READY_TO_SEND", transactionHash };
}

export interface ExpectedSignedLegacyTransaction {
  rawTransaction: Hex;
  transactionHash: Hash;
  actor: Address;
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  gasPrice: bigint;
}

export async function assertSignedLegacyTransactionMatches(
  expected: ExpectedSignedLegacyTransaction,
): Promise<void> {
  if (keccak256(expected.rawTransaction).toLowerCase() !== expected.transactionHash.toLowerCase()) {
    throw new Error("Signed raw transaction hash does not match the committed submission hash");
  }
  let parsed: ReturnType<typeof parseTransaction>;
  try {
    parsed = parseTransaction(expected.rawTransaction as TransactionSerialized);
  } catch {
    throw new Error("Signed raw transaction is not a valid serialized EVM transaction");
  }
  if (parsed.type !== "legacy") throw new Error("Signed raw transaction is not legacy type");
  if (parsed.chainId !== expected.chainId) throw new Error("Signed raw transaction chain ID mismatch");
  if (!parsed.to || getAddress(parsed.to) !== getAddress(expected.to)) throw new Error("Signed raw transaction target mismatch");
  if ((parsed.data ?? "0x").toLowerCase() !== expected.data.toLowerCase()) throw new Error("Signed raw transaction calldata mismatch");
  if ((parsed.value ?? 0n) !== expected.value) throw new Error("Signed raw transaction value mismatch");
  if (parsed.nonce !== expected.nonce) throw new Error("Signed raw transaction nonce mismatch");
  if (parsed.gas !== expected.gas) throw new Error("Signed raw transaction gas limit mismatch");
  if (parsed.gasPrice !== expected.gasPrice) throw new Error("Signed raw transaction gas price mismatch");
  let recovered: Address;
  try {
    recovered = getAddress(await recoverTransactionAddress({
      serializedTransaction: expected.rawTransaction as TransactionSerialized,
    }));
  } catch {
    throw new Error("Signed raw transaction sender could not be recovered");
  }
  if (recovered !== getAddress(expected.actor)) throw new Error("Signed raw transaction sender mismatch");
}

function decodeSupplyEvents(receipt: VenusRpcReceipt) {
  let mintEvent: { minter: Address; mintAmount: bigint; mintTokens: bigint; logIndex: number } | null = null;
  let transferEvent: { from: Address; to: Address; amount: bigint; logIndex: number } | null = null;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== VENUS_TESTNET_NATIVE_SUPPLY.vBnb) continue;
    try {
      const decoded = decodeEventLog({
        abi: VBNB_ABI,
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
      if (decoded.eventName === "Mint") {
        if (mintEvent) throw new Error("Receipt contains multiple Venus Mint events");
        mintEvent = { ...decoded.args, logIndex: log.logIndex };
      } else if (decoded.eventName === "Transfer") {
        const from = getAddress(decoded.args.from);
        const to = getAddress(decoded.args.to);
        if (from === "0x0000000000000000000000000000000000000000" && to === VENUS_TESTNET_NATIVE_SUPPLY.actor) {
          if (transferEvent) throw new Error("Receipt contains multiple matching vBNB mint transfers");
          transferEvent = { from, to, amount: decoded.args.amount, logIndex: log.logIndex };
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("multiple")) throw error;
    }
  }
  if (!mintEvent || !transferEvent) throw new Error("Receipt is missing the required Venus Mint or vBNB Transfer event");
  return { mintEvent, transferEvent };
}

interface ValidatedMinedVenusSupply {
  transaction: VenusRpcTransaction;
  receipt: VenusRpcReceipt;
  finalityBlock: bigint;
  confirmations: bigint;
  previousBlock: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  snapshotBefore: readonly [bigint, bigint, bigint, bigint];
  snapshotAfter: readonly [bigint, bigint, bigint, bigint];
  events: ReturnType<typeof decodeSupplyEvents>;
  transactionCost: bigint;
}

async function validateMinedVenusSupply(
  intent: VenusTestnetNativeSupplyIntent,
  expectedHash: Hash,
  client: VenusNativeSupplyRpc,
): Promise<ValidatedMinedVenusSupply> {
  if (await client.getChainId() !== 97) throw new Error("Receipt validation RPC is not on BSC Testnet");
  const [transaction, receipt, finalityBlock] = await Promise.all([
    client.getTransaction(expectedHash),
    client.getTransactionReceipt(expectedHash),
    client.getBlockNumber(),
  ]);
  if (!transaction) throw new Error("Venus supply transaction is not known on BSC Testnet");
  if (!sameHash(transaction.hash, expectedHash) || !sameHash(receipt.transactionHash, expectedHash)) {
    throw new Error("Transaction, receipt, and submission hashes do not match");
  }
  assertRpcTransactionMatchesIntent(transaction, expectedHash, intent);
  if (receipt.status !== "success") throw new Error("Venus native supply transaction reverted");
  if (transaction.blockNumber === null || transaction.blockHash === null) throw new Error("Transaction is not block-pinned");
  if (
    transaction.blockNumber !== receipt.blockNumber ||
    !sameHash(transaction.blockHash, receipt.blockHash)
  ) throw new Error("Transaction and receipt block mismatch");
  if (finalityBlock < receipt.blockNumber) throw new Error("Finality observation precedes the receipt block");
  const confirmations = finalityBlock - receipt.blockNumber + 1n;
  if (confirmations < BigInt(VENUS_TESTNET_NATIVE_SUPPLY.confirmations)) {
    throw new Error("Venus supply receipt has fewer than 12 confirmations");
  }
  const canonicalBlockHash = await client.getBlockHash(receipt.blockNumber);
  if (!canonicalBlockHash || !sameHash(canonicalBlockHash, receipt.blockHash) || !sameHash(canonicalBlockHash, transaction.blockHash)) {
    throw new Error("Receipt block is not canonical at the confirmed block height");
  }
  if (receipt.blockNumber === 0n) throw new Error("Cannot reconstruct a pre-transaction block");
  const previousBlock = receipt.blockNumber - 1n;
  const actor = getAddress(intent.actor);
  const vToken = getAddress(intent.transaction.to);
  const protocolState = await assertProtocolState(client, actor, receipt.blockNumber);
  const [balanceBefore, snapshotBefore] = await Promise.all([
    client.getVTokenBalance(vToken, actor, previousBlock),
    client.getAccountSnapshot(vToken, actor, previousBlock),
  ]);
  const balanceAfter = protocolState.vTokenBalance;
  const snapshotAfter = protocolState.accountSnapshot;
  if (snapshotBefore[0] !== 0n || snapshotAfter[0] !== 0n) {
    throw new Error("Block-pinned Venus account snapshot returned a non-zero error code");
  }
  if (snapshotBefore[1] !== balanceBefore || snapshotAfter[1] !== balanceAfter) {
    throw new Error("Block-pinned Venus account snapshot balance mismatch");
  }
  const events = decodeSupplyEvents(receipt);
  if (
    getAddress(events.mintEvent.minter) !== actor ||
    events.mintEvent.mintAmount !== BigInt(intent.transaction.valueWei) ||
    events.mintEvent.mintTokens <= 0n ||
    getAddress(events.transferEvent.from) !== "0x0000000000000000000000000000000000000000" ||
    getAddress(events.transferEvent.to) !== actor ||
    events.transferEvent.amount !== events.mintEvent.mintTokens
  ) throw new Error("Venus Mint and Transfer evidence does not match the reviewed supply");
  if (balanceAfter < balanceBefore || balanceAfter - balanceBefore !== events.mintEvent.mintTokens) {
    throw new Error("Block-pinned vBNB balance delta does not equal the Mint event");
  }
  if (receipt.gasUsed <= 0n || receipt.gasUsed > transaction.gas) {
    throw new Error("Receipt gas used exceeds the signed gas limit");
  }
  if (transaction.gasPrice === null || receipt.effectiveGasPrice !== transaction.gasPrice) {
    throw new Error("Receipt gas price does not match the signed legacy gas price");
  }
  const transactionCost = receipt.gasUsed * receipt.effectiveGasPrice;
  if (transactionCost > BigInt(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei)) {
    throw new Error("Actual transaction cost exceeded the hard gas cap");
  }
  return {
    transaction,
    receipt,
    finalityBlock,
    confirmations,
    previousBlock,
    balanceBefore,
    balanceAfter,
    snapshotBefore,
    snapshotAfter,
    events,
    transactionCost,
  };
}

export async function reconcileVenusTestnetNativeSupply(
  submissionInput: unknown,
  client: VenusNativeSupplyRpc,
  now = new Date(),
): Promise<VenusTestnetNativeSupplyEvidence> {
  const submission = verifyVenusTestnetNativeSupplySubmission(submissionInput);
  const intent = submission.intent;
  const validated = await validateMinedVenusSupply(intent, submission.transactionHash as Hash, client);
  const { transaction, receipt, finalityBlock, confirmations, previousBlock, balanceBefore, balanceAfter, snapshotBefore, snapshotAfter, events, transactionCost } = validated;
  const evidence = commitVenusTestnetNativeSupplyEvidence({
    schemaVersion: "positioncrew.venus-testnet-native-supply-receipt.v1",
    evidenceId: "venus-bsc-testnet-native-supply-1",
    completedAt: now.toISOString(),
    relationship: "FOUNDER_CONTROLLED_TESTNET_ACTION",
    network: {
      name: "BSC Testnet",
      chainId: 97,
      receiptBlockNumber: receipt.blockNumber.toString(),
      receiptBlockHash: receipt.blockHash,
      finalityObservationBlockNumber: finalityBlock.toString(),
      confirmationsObserved: Number(confirmations),
      explorerUrl: `https://testnet.bscscan.com/tx/${transaction.hash}`,
    },
    protocol: {
      name: "Venus Core Pool",
      marketSymbol: "vBNB",
      vTokenAddress: VENUS_TESTNET_NATIVE_SUPPLY.vBnb,
      comptrollerAddress: VENUS_TESTNET_NATIVE_SUPPLY.unitroller,
      sourceCommit: VENUS_TESTNET_NATIVE_SUPPLY.sourceCommit,
      sourceUrls: [
        VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[0],
        VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[1],
        VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[2],
      ],
      vTokenRuntimeCodeHash: VENUS_TESTNET_NATIVE_SUPPLY.vBnbRuntimeCodeHash,
      comptrollerRuntimeCodeHash: VENUS_TESTNET_NATIVE_SUPPLY.unitrollerRuntimeCodeHash,
    },
    actor: {
      wallet: VENUS_TESTNET_NATIVE_SUPPLY.actor,
      role: "FOUNDER_CONTROLLED_TESTNET_WALLET",
      externalBuyer: false,
    },
    intent,
    transaction: {
      hash: transaction.hash,
      chainId: 97,
      type: "legacy",
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      from: VENUS_TESTNET_NATIVE_SUPPLY.actor,
      to: VENUS_TESTNET_NATIVE_SUPPLY.vBnb,
      input: VENUS_TESTNET_NATIVE_SUPPLY.mintSelector,
      valueWei: VENUS_TESTNET_NATIVE_SUPPLY.amountWei,
      nonce: transaction.nonce.toString(),
      gasLimit: transaction.gas.toString(),
      gasPriceWei: transaction.gasPrice!.toString(),
      status: "SUCCESS",
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
      transactionCostWei: transactionCost.toString(),
      explorerUrl: `https://testnet.bscscan.com/tx/${transaction.hash}`,
    },
    proof: {
      previousBlockNumber: previousBlock.toString(),
      mintEvent: {
        minter: VENUS_TESTNET_NATIVE_SUPPLY.actor,
        mintAmountWei: VENUS_TESTNET_NATIVE_SUPPLY.amountWei,
        mintTokensRaw: events.mintEvent.mintTokens.toString(),
        logIndex: events.mintEvent.logIndex,
      },
      transferEvent: {
        from: "0x0000000000000000000000000000000000000000",
        to: VENUS_TESTNET_NATIVE_SUPPLY.actor,
        amountRaw: events.transferEvent.amount.toString(),
        logIndex: events.transferEvent.logIndex,
      },
      vTokenBalanceBeforeRaw: balanceBefore.toString(),
      vTokenBalanceAfterRaw: balanceAfter.toString(),
      vTokenBalanceDeltaRaw: (balanceAfter - balanceBefore).toString(),
      accountSnapshotBefore: normalizeSnapshot(snapshotBefore),
      accountSnapshotAfter: normalizeSnapshot(snapshotAfter),
      proofHash: "sha256:" + "0".repeat(64),
    },
    claimBoundary: [
      VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY[0],
      VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY[1],
      VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY[2],
      VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY[3],
      VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY[4],
    ],
  });
  return VenusTestnetNativeSupplyEvidenceSchema.parse(evidence);
}

export async function verifyVenusTestnetNativeSupplyOnchain(
  evidenceInput: unknown,
  client: VenusNativeSupplyRpc,
): Promise<VenusTestnetNativeSupplyEvidence> {
  const evidence = verifyVenusTestnetNativeSupplyEvidence(evidenceInput);
  const validated = await validateMinedVenusSupply(evidence.intent, evidence.transaction.hash as Hash, client);
  const { transaction, receipt, finalityBlock, confirmations, previousBlock, balanceBefore, balanceAfter, snapshotBefore, snapshotAfter, events, transactionCost } = validated;
  const expectedExplorerUrl = `https://testnet.bscscan.com/tx/${transaction.hash}`;
  const recordedFinality = BigInt(evidence.network.finalityObservationBlockNumber);
  const recordedConfirmations = recordedFinality - receipt.blockNumber + 1n;
  if (
    evidence.network.receiptBlockNumber !== receipt.blockNumber.toString() ||
    !sameHash(evidence.network.receiptBlockHash, receipt.blockHash) ||
    recordedFinality > finalityBlock ||
    recordedConfirmations !== BigInt(evidence.network.confirmationsObserved) ||
    recordedConfirmations < BigInt(VENUS_TESTNET_NATIVE_SUPPLY.confirmations) ||
    evidence.network.explorerUrl !== expectedExplorerUrl
  ) throw new Error("Published network finality evidence differs from BSC Testnet");
  if (
    !sameHash(evidence.transaction.hash, transaction.hash) ||
    evidence.transaction.chainId !== transaction.chainId ||
    evidence.transaction.type !== transaction.type ||
    evidence.transaction.blockNumber !== transaction.blockNumber!.toString() ||
    !sameHash(evidence.transaction.blockHash, transaction.blockHash!) ||
    getAddress(evidence.transaction.from) !== getAddress(transaction.from) ||
    getAddress(evidence.transaction.to) !== getAddress(transaction.to!) ||
    evidence.transaction.input.toLowerCase() !== transaction.input.toLowerCase() ||
    evidence.transaction.valueWei !== transaction.value.toString() ||
    evidence.transaction.nonce !== transaction.nonce.toString() ||
    evidence.transaction.gasLimit !== transaction.gas.toString() ||
    evidence.transaction.gasPriceWei !== transaction.gasPrice!.toString() ||
    evidence.transaction.gasUsed !== receipt.gasUsed.toString() ||
    evidence.transaction.effectiveGasPriceWei !== receipt.effectiveGasPrice.toString() ||
    evidence.transaction.transactionCostWei !== transactionCost.toString() ||
    evidence.transaction.explorerUrl !== expectedExplorerUrl
  ) throw new Error("Published transaction differs from BSC Testnet");
  if (
    evidence.proof.previousBlockNumber !== previousBlock.toString() ||
    evidence.proof.mintEvent.minter !== getAddress(events.mintEvent.minter) ||
    evidence.proof.mintEvent.mintAmountWei !== events.mintEvent.mintAmount.toString() ||
    evidence.proof.mintEvent.mintTokensRaw !== events.mintEvent.mintTokens.toString() ||
    evidence.proof.mintEvent.logIndex !== events.mintEvent.logIndex ||
    evidence.proof.transferEvent.from !== getAddress(events.transferEvent.from) ||
    evidence.proof.transferEvent.to !== getAddress(events.transferEvent.to) ||
    evidence.proof.transferEvent.amountRaw !== events.transferEvent.amount.toString() ||
    evidence.proof.transferEvent.logIndex !== events.transferEvent.logIndex ||
    evidence.proof.vTokenBalanceBeforeRaw !== balanceBefore.toString() ||
    evidence.proof.vTokenBalanceAfterRaw !== balanceAfter.toString() ||
    evidence.proof.vTokenBalanceDeltaRaw !== (balanceAfter - balanceBefore).toString() ||
    JSON.stringify(evidence.proof.accountSnapshotBefore) !== JSON.stringify(normalizeSnapshot(snapshotBefore)) ||
    JSON.stringify(evidence.proof.accountSnapshotAfter) !== JSON.stringify(normalizeSnapshot(snapshotAfter))
  ) throw new Error("Published Venus proof differs from BSC Testnet");
  if (confirmations < BigInt(VENUS_TESTNET_NATIVE_SUPPLY.confirmations)) {
    throw new Error("Published receipt is not sufficiently confirmed");
  }
  return evidence;
}

export function createViemVenusRpcClient(network: "testnet" | "mainnet", rpcUrl: string): VenusNativeSupplyRpc {
  const chain = network === "testnet" ? bscTestnet : bsc;
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    getBlockHash: async (blockNumber) => (await client.getBlock({ blockNumber })).hash,
    getBalance: (address, blockNumber) => client.getBalance({ address, blockNumber }),
    getPendingNonce: (address) => client.getTransactionCount({ address, blockTag: "pending" }),
    getCodeHash: async (address, blockNumber) => {
      const code = await client.getCode({ address, blockNumber });
      return code && code !== "0x" ? keccak256(code) : null;
    },
    getComptroller: async (vToken, blockNumber) => getAddress(await client.readContract({ address: vToken, abi: VBNB_ABI, functionName: "comptroller", blockNumber })),
    getMarket: async (comptroller, vToken, blockNumber) => {
      const result = await client.readContract({ address: comptroller, abi: UNITROLLER_ABI, functionName: "markets", args: [vToken], blockNumber });
      return { isListed: result[0], isVenus: result[2] };
    },
    getVTokenBalance: (vToken, account, blockNumber) => client.readContract({ address: vToken, abi: VBNB_ABI, functionName: "balanceOf", args: [account], blockNumber }),
    getAccountSnapshot: (vToken, account, blockNumber) => client.readContract({ address: vToken, abi: VBNB_ABI, functionName: "getAccountSnapshot", args: [account], blockNumber }),
    simulateMint: async (vToken, account, value) => { await client.simulateContract({ address: vToken, abi: VBNB_ABI, functionName: "mint", account, value }); },
    estimateMintGas: (vToken, account, value) => client.estimateContractGas({ address: vToken, abi: VBNB_ABI, functionName: "mint", account, value }),
    getGasPrice: () => client.getGasPrice(),
    sendRawTransaction: (rawTransaction) => client.sendRawTransaction({ serializedTransaction: rawTransaction }),
    getTransaction: async (hash) => {
      try {
        const transaction = await client.getTransaction({ hash });
        return {
          hash: transaction.hash,
          chainId: transaction.chainId ?? null,
          type: transaction.type,
          blockNumber: transaction.blockNumber,
          blockHash: transaction.blockHash,
          from: transaction.from,
          to: transaction.to,
          input: transaction.input,
          value: transaction.value,
          nonce: transaction.nonce,
          gas: transaction.gas,
          gasPrice: transaction.gasPrice ?? null,
        };
      } catch (error) {
        if (error instanceof Error && error.name === "TransactionNotFoundError") return null;
        throw error;
      }
    },
    getTransactionReceipt: async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash });
      return {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        logs: receipt.logs.map((log) => ({ address: log.address, data: log.data, topics: log.topics, logIndex: log.logIndex })),
      };
    },
  };
}
