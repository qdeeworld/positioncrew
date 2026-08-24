import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
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
  getTransaction(hash: Hash): Promise<VenusRpcTransaction>;
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
  return {
    errorCode: snapshot[0].toString(),
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
  client: VenusNativeSupplyRpc,
): Promise<Hash> {
  const submission = VenusTestnetNativeSupplySubmissionSchema.parse(submissionInput);
  if (await client.getChainId() !== 97) throw new Error("Raw transaction broadcaster is not on BSC Testnet");
  const returnedHash = await client.sendRawTransaction(submission.rawTransaction as Hex);
  if (returnedHash.toLowerCase() !== submission.transactionHash.toLowerCase()) {
    throw new Error("RPC returned a hash that does not match the frozen raw transaction");
  }
  return returnedHash;
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

export async function reconcileVenusTestnetNativeSupply(
  submissionInput: unknown,
  client: VenusNativeSupplyRpc,
  now = new Date(),
): Promise<VenusTestnetNativeSupplyEvidence> {
  const submission = VenusTestnetNativeSupplySubmissionSchema.parse(submissionInput);
  if (await client.getChainId() !== 97) throw new Error("Receipt reconciler is not on BSC Testnet");
  const [transaction, receipt, finalityBlock] = await Promise.all([
    client.getTransaction(submission.transactionHash as Hash),
    client.getTransactionReceipt(submission.transactionHash as Hash),
    client.getBlockNumber(),
  ]);
  if (receipt.status !== "success") throw new Error("Venus native supply transaction reverted");
  if (transaction.hash.toLowerCase() !== submission.transactionHash.toLowerCase()) throw new Error("Transaction hash mismatch");
  if (transaction.chainId !== 97 || transaction.type !== "legacy") throw new Error("Transaction is not a legacy EIP-155 BSC Testnet transaction");
  if (!transaction.blockNumber || !transaction.blockHash) throw new Error("Transaction is not block-pinned");
  if (transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash) throw new Error("Transaction and receipt block mismatch");
  const confirmations = finalityBlock - receipt.blockNumber + 1n;
  if (confirmations < BigInt(VENUS_TESTNET_NATIVE_SUPPLY.confirmations)) throw new Error("Venus supply receipt has fewer than 12 confirmations");
  const intent = submission.intent;
  if (
    getAddress(transaction.from) !== intent.actor ||
    !transaction.to || getAddress(transaction.to) !== intent.transaction.to ||
    transaction.input.toLowerCase() !== intent.transaction.data ||
    transaction.value.toString() !== intent.transaction.valueWei ||
    transaction.nonce.toString() !== intent.transaction.nonce
  ) throw new Error("Mined transaction does not match the reviewed Venus supply intent");
  const events = decodeSupplyEvents(receipt);
  if (
    getAddress(events.mintEvent.minter) !== intent.actor ||
    events.mintEvent.mintAmount.toString() !== intent.transaction.valueWei ||
    events.mintEvent.mintTokens <= 0n ||
    events.transferEvent.amount !== events.mintEvent.mintTokens
  ) throw new Error("Venus Mint and Transfer evidence does not match the reviewed supply");
  if (receipt.blockNumber === 0n) throw new Error("Cannot reconstruct a pre-transaction block");
  const previousBlock = receipt.blockNumber - 1n;
  const vToken = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb);
  const actor = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.actor);
  const [balanceBefore, balanceAfter, snapshotBefore, snapshotAfter] = await Promise.all([
    client.getVTokenBalance(vToken, actor, previousBlock),
    client.getVTokenBalance(vToken, actor, receipt.blockNumber),
    client.getAccountSnapshot(vToken, actor, previousBlock),
    client.getAccountSnapshot(vToken, actor, receipt.blockNumber),
  ]);
  if (balanceAfter < balanceBefore || balanceAfter - balanceBefore !== events.mintEvent.mintTokens) {
    throw new Error("Block-pinned vBNB balance delta does not equal the Mint event");
  }
  const transactionCost = receipt.gasUsed * receipt.effectiveGasPrice;
  if (transactionCost > BigInt(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei)) throw new Error("Actual transaction cost exceeded the hard gas cap");
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
  const [transaction, receipt, currentBlock] = await Promise.all([
    client.getTransaction(evidence.transaction.hash as Hash),
    client.getTransactionReceipt(evidence.transaction.hash as Hash),
    client.getBlockNumber(),
  ]);
  if (receipt.status !== "success" || currentBlock - receipt.blockNumber + 1n < 12n) throw new Error("Published receipt is not successful and sufficiently confirmed");
  if (
    transaction.hash !== evidence.transaction.hash ||
    transaction.blockHash !== evidence.transaction.blockHash ||
    transaction.value.toString() !== evidence.transaction.valueWei
  ) throw new Error("Published transaction differs from BSC Testnet");
  const events = decodeSupplyEvents(receipt);
  if (events.mintEvent.mintTokens.toString() !== evidence.proof.mintEvent.mintTokensRaw) throw new Error("Published Mint event differs from BSC Testnet");
  const before = await client.getVTokenBalance(getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb), getAddress(VENUS_TESTNET_NATIVE_SUPPLY.actor), BigInt(evidence.proof.previousBlockNumber));
  const after = await client.getVTokenBalance(getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb), getAddress(VENUS_TESTNET_NATIVE_SUPPLY.actor), BigInt(evidence.network.receiptBlockNumber));
  if (before.toString() !== evidence.proof.vTokenBalanceBeforeRaw || after.toString() !== evidence.proof.vTokenBalanceAfterRaw) throw new Error("Published balance proof differs from BSC Testnet");
  return evidence;
}

export function createViemVenusRpcClient(network: "testnet" | "mainnet", rpcUrl: string): VenusNativeSupplyRpc {
  const chain = network === "testnet" ? bscTestnet : bsc;
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }) });
  return {
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
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
      };
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
