import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalHash } from "../src/core/canonical.js";
import {
  VENUS_TESTNET_NATIVE_SUPPLY,
  VenusTestnetNativeSupplyEvidenceSchema,
  VenusTestnetNativeSupplyIntentSchema,
  VenusTestnetNativeSupplySubmissionSchema,
  commitVenusTestnetNativeSupplySubmission,
  commitVenusTestnetNativeSupplyEvidence,
  verifyVenusTestnetNativeSupplyEvidence,
} from "../src/commerce/venus-testnet-native-supply-evidence.js";
import {
  broadcastIdenticalVenusSubmission,
  assertSignedLegacyTransactionMatches,
  inspectVenusSubmissionBroadcastState,
  prepareVenusTestnetNativeSupply,
  reconcileVenusTestnetNativeSupply,
  signVenusTestnetNativeSupply,
  verifyVenusTestnetNativeSupplyOnchain,
  type VenusNativeSupplyRpc,
  type VenusRpcReceipt,
  type VenusRpcTransaction,
} from "../src/commerce/venus-testnet-native-supply-operator.js";
import { atomicWriteNew0600 } from "../src/cli/venus-testnet-native-supply.js";

const ACTOR = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.actor);
const VBNB = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.vBnb);
const UNITROLLER = getAddress(VENUS_TESTNET_NATIVE_SUPPLY.unitroller);
const NOW = new Date("2026-08-24T12:00:00.000Z");
const RAW_TRANSACTION = "0x0102" as Hex;
const TRANSACTION_HASH = keccak256(RAW_TRANSACTION);
const MINT_TOKENS = 500_000n;
const DISPOSABLE_SIGNER = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const OTHER_DISPOSABLE_SIGNER = privateKeyToAccount(
  "0x2222222222222222222222222222222222222222222222222222222222222222",
);
const EVENT_ABI = parseAbi([
  "event Mint(address minter, uint256 mintAmount, uint256 mintTokens)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

function supplyLogs(): VenusRpcReceipt["logs"] {
  return [
    {
      address: VBNB,
      topics: encodeEventTopics({ abi: EVENT_ABI, eventName: "Mint" }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(
        parseAbiParameters("address minter, uint256 mintAmount, uint256 mintTokens"),
        [ACTOR, BigInt(VENUS_TESTNET_NATIVE_SUPPLY.amountWei), MINT_TOKENS],
      ),
      logIndex: 2,
    },
    {
      address: VBNB,
      topics: encodeEventTopics({
        abi: EVENT_ABI,
        eventName: "Transfer",
        args: { from: "0x0000000000000000000000000000000000000000", to: ACTOR },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters(parseAbiParameters("uint256 amount"), [MINT_TOKENS]),
      logIndex: 3,
    },
  ];
}

class FakeRpc implements VenusNativeSupplyRpc {
  chainId = 97;
  blockNumber = 111n;
  canonicalBlockHash: Hash | null = `0x${"ab".repeat(32)}` as Hash;
  nativeBalance = 1_000_000_000_000_000_000n;
  pendingNonce = 7;
  vTokenCodeHash: Hash | null = VENUS_TESTNET_NATIVE_SUPPLY.vBnbRuntimeCodeHash;
  unitrollerCodeHash: Hash | null = VENUS_TESTNET_NATIVE_SUPPLY.unitrollerRuntimeCodeHash;
  comptroller = UNITROLLER;
  market = { isListed: true, isVenus: true };
  gasEstimate = 50_000n;
  gasEstimateCalls = 0;
  gasPrice = 1_000_000_000n;
  simulateCalls = 0;
  simulationError: Error | null = null;
  sentRaw: Hex[] = [];
  balanceBefore = 0n;
  balanceAfter = MINT_TOKENS;
  transaction: VenusRpcTransaction | null = {
    hash: TRANSACTION_HASH,
    chainId: 97,
    type: "legacy",
    blockNumber: 100n,
    blockHash: `0x${"ab".repeat(32)}` as Hash,
    from: ACTOR,
    to: VBNB,
    input: VENUS_TESTNET_NATIVE_SUPPLY.mintSelector,
    value: BigInt(VENUS_TESTNET_NATIVE_SUPPLY.amountWei),
    nonce: 7,
    gas: 60_000n,
    gasPrice: 1_000_000_000n,
  };
  receipt: VenusRpcReceipt = {
    transactionHash: TRANSACTION_HASH,
    blockNumber: 100n,
    blockHash: `0x${"ab".repeat(32)}` as Hash,
    status: "success",
    gasUsed: 20_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs: supplyLogs(),
  };

  getChainId = async () => this.chainId;
  getBlockNumber = async () => this.blockNumber;
  getBlockHash = async (_blockNumber: bigint) => this.canonicalBlockHash;
  getBalance = async (_address: Address, _blockNumber?: bigint) => this.nativeBalance;
  getPendingNonce = async (_address: Address) => this.pendingNonce;
  getCodeHash = async (address: Address, _blockNumber?: bigint) =>
    getAddress(address) === VBNB ? this.vTokenCodeHash : this.unitrollerCodeHash;
  getComptroller = async (_vToken: Address, _blockNumber?: bigint) => this.comptroller;
  getMarket = async (_comptroller: Address, _vToken: Address, _blockNumber?: bigint) => this.market;
  getVTokenBalance = async (_vToken: Address, _account: Address, blockNumber?: bigint) =>
    blockNumber === 99n ? this.balanceBefore : blockNumber === 100n ? this.balanceAfter : this.balanceBefore;
  getAccountSnapshot: VenusNativeSupplyRpc["getAccountSnapshot"] = async (_vToken: Address, _account: Address, blockNumber?: bigint) => {
    const balance = blockNumber === 100n ? this.balanceAfter : this.balanceBefore;
    return [0n, balance, 0n, 20_000_000_000_000_000_000_000_000n] as const;
  };
  simulateMint = async (_vToken: Address, _account: Address, _value: bigint) => {
    this.simulateCalls += 1;
    if (this.simulationError) throw this.simulationError;
  };
  estimateMintGas = async (_vToken: Address, _account: Address, _value: bigint) => {
    this.gasEstimateCalls += 1;
    return this.gasEstimate;
  };
  getGasPrice = async () => this.gasPrice;
  sendRawTransaction = async (rawTransaction: Hex) => {
    this.sentRaw.push(rawTransaction);
    return keccak256(rawTransaction);
  };
  getTransaction = async (_hash: Hash) => this.transaction;
  getTransactionReceipt = async (_hash: Hash) => this.receipt;
}

function dependencies(testnet = new FakeRpc(), mainnet = new FakeRpc()) {
  mainnet.chainId = 56;
  mainnet.nativeBalance = 0n;
  mainnet.pendingNonce = 0;
  return { testnet, mainnet };
}

async function prepared(deps = dependencies()) {
  return prepareVenusTestnetNativeSupply({
    actor: ACTOR,
    amountTbnb: "0.0001",
    operationId: "11111111-1111-4111-8111-111111111111",
    now: NOW,
  }, deps);
}

async function signed(deps = dependencies()) {
  const intent = await prepared(deps);
  let signCalls = 0;
  const submission = await signVenusTestnetNativeSupply(intent, {
    address: ACTOR,
    signLegacyTransaction: async (transaction) => {
      signCalls += 1;
      expect(transaction).toMatchObject({
        chainId: 97,
        to: VBNB,
        data: "0x1249c58b",
        value: 100_000_000_000_000n,
        nonce: 7,
      });
      return RAW_TRANSACTION;
    },
  }, deps, new Date("2026-08-24T12:01:00.000Z"));
  return { intent, submission, signCalls };
}

describe("bounded Venus BSC Testnet native supply", () => {
  it("creates frozen state with 0600 permissions and never replaces it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "positioncrew-venus-state-"));
    const path = join(directory, "submission.json");
    await atomicWriteNew0600(path, { version: 1 });

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(atomicWriteNew0600(path, { version: 2 })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1 });
  });

  it("prepares one exact, canonical, simulate-first legacy intent", async () => {
    const deps = dependencies();
    const intent = await prepared(deps);

    expect(intent.chainId).toBe(97);
    expect(intent.actor).toBe(ACTOR);
    expect(intent.transaction).toMatchObject({
      type: "legacy",
      to: VBNB,
      data: "0x1249c58b",
      amountTbnb: "0.0001",
      valueWei: "100000000000000",
      maxGasCostWei: "100000000000000",
      nonce: "7",
    });
    expect(intent.preflight.mainnetIsolation).toMatchObject({
      chainId: 56,
      nativeBalanceWei: "0",
      pendingNonce: "0",
    });
    expect(deps.testnet.simulateCalls).toBe(1);
    expect(VenusTestnetNativeSupplyIntentSchema.parse(intent)).toEqual(intent);

    const tampered = structuredClone(intent);
    (tampered.transaction as { valueWei: string }).valueWei = "100000000000001";
    expect(() => VenusTestnetNativeSupplyIntentSchema.parse(tampered)).toThrow();

    const stalePreflight = structuredClone(intent);
    stalePreflight.preflight.nativeBalanceWei = "999999999999999999";
    const { intentHash: _intentHash, ...staleContent } = stalePreflight;
    stalePreflight.intentHash = canonicalHash(staleContent);
    expect(() => VenusTestnetNativeSupplyIntentSchema.parse(stalePreflight)).toThrow("Preflight commitment mismatch");
  });

  it("rejects amount, mainnet exposure, nonce, code, market, and gas-cap mutations", async () => {
    const wrongAmount = dependencies();
    await expect(prepareVenusTestnetNativeSupply({ actor: ACTOR, amountTbnb: "0.0002", now: NOW }, wrongAmount)).rejects.toThrow("exactly 0.0001");

    const mainnetValue = dependencies();
    mainnetValue.mainnet.nativeBalance = 1n;
    await expect(prepared(mainnetValue)).rejects.toThrow("non-zero BSC mainnet native balance");

    const mainnetNonce = dependencies();
    mainnetNonce.mainnet.pendingNonce = 1;
    await expect(prepared(mainnetNonce)).rejects.toThrow("non-zero BSC mainnet pending nonce");

    const wrongCode = dependencies();
    wrongCode.testnet.vTokenCodeHash = `0x${"00".repeat(32)}`;
    await expect(prepared(wrongCode)).rejects.toThrow("bytecode hash mismatch");

    const unlisted = dependencies();
    unlisted.testnet.market = { isListed: false, isVenus: true };
    await expect(prepared(unlisted)).rejects.toThrow("active listed Venus market");

    const expensive = dependencies();
    expensive.testnet.gasPrice = 2_000_000_000n;
    await expect(prepared(expensive)).rejects.toThrow("hard 0.0001 tBNB cap");
  });

  it("repeats safety checks immediately before signing and signs exactly once", async () => {
    const deps = dependencies();
    const result = await signed(deps);
    expect(result.signCalls).toBe(1);
    expect(result.submission.transactionHash).toBe(TRANSACTION_HASH);
    expect(deps.testnet.simulateCalls).toBe(2);
    expect(VenusTestnetNativeSupplySubmissionSchema.parse(result.submission)).toEqual(result.submission);

    const changedNonce = dependencies();
    const intent = await prepared(changedNonce);
    changedNonce.testnet.pendingNonce = 8;
    await expect(signVenusTestnetNativeSupply(intent, {
      address: ACTOR,
      signLegacyTransaction: async () => RAW_TRANSACTION,
    }, changedNonce, new Date("2026-08-24T12:01:00.000Z"))).rejects.toThrow("Pending nonce changed");

    const mainnetChanged = dependencies();
    const reviewed = await prepared(mainnetChanged);
    mainnetChanged.mainnet.nativeBalance = 1n;
    await expect(signVenusTestnetNativeSupply(reviewed, {
      address: ACTOR,
      signLegacyTransaction: async () => RAW_TRANSACTION,
    }, mainnetChanged, new Date("2026-08-24T12:01:00.000Z"))).rejects.toThrow("mainnet native balance");

    const gasChanged = dependencies();
    const gasReviewed = await prepared(gasChanged);
    gasChanged.testnet.gasEstimate = 60_001n;
    await expect(signVenusTestnetNativeSupply(gasReviewed, {
      address: ACTOR,
      signLegacyTransaction: async () => RAW_TRANSACTION,
    }, gasChanged, new Date("2026-08-24T12:01:00.000Z"))).rejects.toThrow("exceeds the frozen gas limit");
  });

  it("requires signedAt inside the frozen intent window", async () => {
    const intent = await prepared();
    expect(() => commitVenusTestnetNativeSupplySubmission({
      schemaVersion: "positioncrew.venus-testnet-native-supply-submission.v1",
      signedAt: intent.expiresAt,
      intent,
      rawTransaction: RAW_TRANSACTION,
      transactionHash: TRANSACTION_HASH,
    })).toThrow("validity window");
  });

  it("parses and recovers the exact signed legacy transaction before authorization", async () => {
    const expected = {
      chainId: 97,
      to: VBNB,
      data: VENUS_TESTNET_NATIVE_SUPPLY.mintSelector as Hex,
      value: BigInt(VENUS_TESTNET_NATIVE_SUPPLY.amountWei),
      nonce: 7,
      gas: 60_000n,
      gasPrice: 1_000_000_000n,
    } as const;
    const rawTransaction = await DISPOSABLE_SIGNER.signTransaction({
      ...expected,
      type: "legacy",
    });
    await expect(assertSignedLegacyTransactionMatches({
      rawTransaction,
      transactionHash: keccak256(rawTransaction),
      actor: DISPOSABLE_SIGNER.address,
      ...expected,
    })).resolves.toBeUndefined();

    const sameSignerMutations = [
      { ...expected, to: UNITROLLER },
      { ...expected, data: "0x" as Hex },
      { ...expected, value: expected.value + 1n },
      { ...expected, nonce: expected.nonce + 1 },
      { ...expected, gas: expected.gas + 1n },
      { ...expected, gasPrice: expected.gasPrice + 1n },
      { ...expected, chainId: 56 },
    ];
    for (const mutation of sameSignerMutations) {
      const mutatedRaw = await DISPOSABLE_SIGNER.signTransaction({ ...mutation, type: "legacy" });
      await expect(assertSignedLegacyTransactionMatches({
        rawTransaction: mutatedRaw,
        transactionHash: keccak256(mutatedRaw),
        actor: DISPOSABLE_SIGNER.address,
        ...expected,
      })).rejects.toThrow("mismatch");
    }

    const wrongSignerRaw = await OTHER_DISPOSABLE_SIGNER.signTransaction({ ...expected, type: "legacy" });
    await expect(assertSignedLegacyTransactionMatches({
      rawTransaction: wrongSignerRaw,
      transactionHash: keccak256(wrongSignerRaw),
      actor: DISPOSABLE_SIGNER.address,
      ...expected,
    })).rejects.toThrow("sender mismatch");
  });

  it("never sends a reconstructed wrong-signer submission with recomputed commitments", async () => {
    const deps = dependencies();
    const { submission } = await signed(deps);
    const intent = submission.intent;
    const wrongSignerRaw = await OTHER_DISPOSABLE_SIGNER.signTransaction({
      type: "legacy",
      chainId: 97,
      to: VBNB,
      data: VENUS_TESTNET_NATIVE_SUPPLY.mintSelector,
      value: BigInt(VENUS_TESTNET_NATIVE_SUPPLY.amountWei),
      nonce: Number(intent.transaction.nonce),
      gas: BigInt(intent.transaction.gasLimit),
      gasPrice: BigInt(intent.transaction.gasPriceWei),
    });
    const reconstructed = commitVenusTestnetNativeSupplySubmission({
      schemaVersion: "positioncrew.venus-testnet-native-supply-submission.v1",
      signedAt: submission.signedAt,
      intent,
      rawTransaction: wrongSignerRaw,
      transactionHash: keccak256(wrongSignerRaw),
    });
    expect(VenusTestnetNativeSupplySubmissionSchema.parse(reconstructed)).toEqual(reconstructed);
    await expect(broadcastIdenticalVenusSubmission(reconstructed, deps)).rejects.toThrow(
      "sender mismatch",
    );
    expect(deps.testnet.sentRaw).toEqual([]);
  });

  it("never resends a known hash and rejects expired unknown transactions", async () => {
    const known = dependencies();
    const knownSubmission = (await signed(known)).submission;
    known.testnet.gasEstimate = 0n;
    known.testnet.gasEstimateCalls = 0;
    await expect(inspectVenusSubmissionBroadcastState(
      knownSubmission,
      known,
      () => new Date("2026-08-24T12:30:00.000Z"),
    )).resolves.toEqual({ state: "ALREADY_KNOWN", transactionHash: TRANSACTION_HASH });
    expect(known.testnet.gasEstimateCalls).toBe(0);
    expect(known.testnet.sentRaw).toEqual([]);

    const unknown = dependencies();
    const unknownSubmission = (await signed(unknown)).submission;
    unknown.testnet.transaction = null;
    await expect(inspectVenusSubmissionBroadcastState(
      unknownSubmission,
      unknown,
      () => new Date("2026-08-24T12:30:00.000Z"),
    )).rejects.toThrow("cannot be broadcast after intent expiry");
    expect(unknown.testnet.sentRaw).toEqual([]);
  });

  it("blocks gas-estimate drift and permits the fake send only after a valid fresh estimate", async () => {
    const drifted = dependencies();
    const driftedSubmission = (await signed(drifted)).submission;
    drifted.testnet.transaction = null;
    drifted.testnet.gasEstimate = 60_001n;
    drifted.testnet.gasEstimateCalls = 0;
    await expect(inspectVenusSubmissionBroadcastState(
      driftedSubmission,
      drifted,
      () => new Date("2026-08-24T12:02:00.000Z"),
    )).rejects.toThrow("exceeds the frozen gas limit before broadcast");
    expect(drifted.testnet.gasEstimateCalls).toBe(1);
    expect(drifted.testnet.sentRaw).toEqual([]);

    const valid = dependencies();
    const validSubmission = (await signed(valid)).submission;
    valid.testnet.transaction = null;
    valid.testnet.gasEstimate = 60_000n;
    valid.testnet.gasEstimateCalls = 0;
    const inspection = await inspectVenusSubmissionBroadcastState(
      validSubmission,
      valid,
      () => new Date("2026-08-24T12:02:00.000Z"),
    );
    expect(inspection.state).toBe("READY_TO_SEND");
    expect(valid.testnet.gasEstimateCalls).toBe(1);
    if (inspection.state === "READY_TO_SEND") {
      await valid.testnet.sendRawTransaction(validSubmission.rawTransaction as Hex);
    }
    expect(valid.testnet.sentRaw).toEqual([RAW_TRANSACTION]);
  });

  it("fails every fresh pre-send invariant without sending", async () => {
    const cases: Array<{ mutate: (deps: ReturnType<typeof dependencies>) => void; message: string }> = [
      { mutate: (deps) => { deps.testnet.chainId = 56; }, message: "not on BSC Testnet" },
      { mutate: (deps) => { deps.testnet.pendingNonce = 8; }, message: "Pending nonce changed" },
      { mutate: (deps) => { deps.mainnet.nativeBalance = 1n; }, message: "mainnet native balance" },
      { mutate: (deps) => { deps.testnet.vTokenCodeHash = `0x${"00".repeat(32)}`; }, message: "bytecode hash mismatch" },
      { mutate: (deps) => { deps.testnet.market = { isListed: false, isVenus: true }; }, message: "active listed Venus market" },
      { mutate: (deps) => { deps.testnet.nativeBalance = 1n; }, message: "cannot fund" },
      { mutate: (deps) => { deps.testnet.simulationError = new Error("simulation rejected"); }, message: "simulation rejected" },
      { mutate: (deps) => { deps.testnet.gasEstimate = 60_001n; }, message: "exceeds the frozen gas limit before broadcast" },
    ];
    for (const scenario of cases) {
      const deps = dependencies();
      const submission = (await signed(deps)).submission;
      deps.testnet.transaction = null;
      scenario.mutate(deps);
      await expect(inspectVenusSubmissionBroadcastState(
        submission,
        deps,
        () => new Date("2026-08-24T12:02:00.000Z"),
      )).rejects.toThrow(scenario.message);
      expect(deps.testnet.sentRaw).toEqual([]);
    }
  });

  it("reconciles Mint, Transfer, confirmations, cost, and pinned balance delta", async () => {
    const deps = dependencies();
    const { submission } = await signed(deps);
    const evidence = await reconcileVenusTestnetNativeSupply(
      submission,
      deps.testnet,
      new Date("2026-08-24T12:05:00.000Z"),
    );

    expect(evidence.relationship).toBe("FOUNDER_CONTROLLED_TESTNET_ACTION");
    expect(evidence.network.confirmationsObserved).toBe(12);
    expect(evidence.proof.mintEvent).toMatchObject({
      minter: ACTOR,
      mintAmountWei: "100000000000000",
      mintTokensRaw: MINT_TOKENS.toString(),
    });
    expect(evidence.proof.vTokenBalanceDeltaRaw).toBe(MINT_TOKENS.toString());
    expect(JSON.stringify(evidence)).not.toContain("rawTransaction");
    expect(VenusTestnetNativeSupplyEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(verifyVenusTestnetNativeSupplyEvidence(evidence)).toEqual(evidence);
    await expect(verifyVenusTestnetNativeSupplyOnchain(evidence, deps.testnet)).resolves.toEqual(evidence);

    const { commitments: _commitments, ...forgedContent } = evidence;
    const forged = commitVenusTestnetNativeSupplyEvidence({
      ...forgedContent,
      transaction: {
        ...forgedContent.transaction,
        gasUsed: "20001",
        transactionCostWei: "20001000000000",
      },
    });
    expect(VenusTestnetNativeSupplyEvidenceSchema.parse(forged)).toEqual(forged);
    await expect(verifyVenusTestnetNativeSupplyOnchain(forged, deps.testnet)).rejects.toThrow(
      "Published transaction differs",
    );

    const tampered = structuredClone(evidence);
    (tampered.proof as { vTokenBalanceAfterRaw: string }).vTokenBalanceAfterRaw = "500001";
    expect(() => verifyVenusTestnetNativeSupplyEvidence(tampered)).toThrow();
  });

  it("fails closed on reverted, immature, missing-event, and balance-mismatch receipts", async () => {
    const reverted = dependencies();
    const revertedSubmission = (await signed(reverted)).submission;
    reverted.testnet.receipt = { ...reverted.testnet.receipt, status: "reverted" };
    await expect(reconcileVenusTestnetNativeSupply(revertedSubmission, reverted.testnet)).rejects.toThrow("reverted");

    const immature = dependencies();
    const immatureSubmission = (await signed(immature)).submission;
    immature.testnet.blockNumber = 110n;
    await expect(reconcileVenusTestnetNativeSupply(immatureSubmission, immature.testnet)).rejects.toThrow("fewer than 12");

    const missingEvent = dependencies();
    const missingSubmission = (await signed(missingEvent)).submission;
    missingEvent.testnet.receipt = { ...missingEvent.testnet.receipt, logs: [] };
    await expect(reconcileVenusTestnetNativeSupply(missingSubmission, missingEvent.testnet)).rejects.toThrow("missing the required");

    const wrongDelta = dependencies();
    const wrongDeltaSubmission = (await signed(wrongDelta)).submission;
    wrongDelta.testnet.balanceAfter = MINT_TOKENS + 1n;
    await expect(reconcileVenusTestnetNativeSupply(wrongDeltaSubmission, wrongDelta.testnet)).rejects.toThrow("balance delta");

    const receiptHash = dependencies();
    const receiptHashSubmission = (await signed(receiptHash)).submission;
    receiptHash.testnet.receipt = { ...receiptHash.testnet.receipt, transactionHash: `0x${"cd".repeat(32)}` as Hash };
    await expect(reconcileVenusTestnetNativeSupply(receiptHashSubmission, receiptHash.testnet)).rejects.toThrow("hashes do not match");

    const fetchedHash = dependencies();
    const fetchedHashSubmission = (await signed(fetchedHash)).submission;
    fetchedHash.testnet.transaction = { ...fetchedHash.testnet.transaction!, hash: `0x${"ef".repeat(32)}` as Hash };
    await expect(reconcileVenusTestnetNativeSupply(fetchedHashSubmission, fetchedHash.testnet)).rejects.toThrow("hashes do not match");

    const reorged = dependencies();
    const reorgedSubmission = (await signed(reorged)).submission;
    reorged.testnet.canonicalBlockHash = `0x${"01".repeat(32)}` as Hash;
    await expect(reconcileVenusTestnetNativeSupply(reorgedSubmission, reorged.testnet)).rejects.toThrow("not canonical");

    const snapshotMismatch = dependencies();
    const snapshotMismatchSubmission = (await signed(snapshotMismatch)).submission;
    snapshotMismatch.testnet.getAccountSnapshot = async (_vToken, _account, blockNumber) => [
      0n,
      blockNumber === 100n ? snapshotMismatch.testnet.balanceAfter + 1n : snapshotMismatch.testnet.balanceBefore,
      0n,
      20_000_000_000_000_000_000_000_000n,
    ] as const;
    await expect(reconcileVenusTestnetNativeSupply(snapshotMismatchSubmission, snapshotMismatch.testnet)).rejects.toThrow("snapshot balance mismatch");

    const snapshotError = dependencies();
    const snapshotErrorSubmission = (await signed(snapshotError)).submission;
    snapshotError.testnet.getAccountSnapshot = async (_vToken, _account, blockNumber) => [
      blockNumber === 99n ? 1n : 0n,
      blockNumber === 100n ? snapshotError.testnet.balanceAfter : snapshotError.testnet.balanceBefore,
      0n,
      20_000_000_000_000_000_000_000_000n,
    ] as const;
    await expect(reconcileVenusTestnetNativeSupply(snapshotErrorSubmission, snapshotError.testnet)).rejects.toThrow("non-zero error code");
  });
});
