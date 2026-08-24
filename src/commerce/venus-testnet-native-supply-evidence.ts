import { z } from "zod";
import { AddressSchema, HashSchema, TimestampSchema } from "../contracts/common.js";
import { canonicalHash } from "../core/canonical.js";

const UintStringSchema = z.string().regex(/^(0|[1-9]\d*)$/, "Expected an unsigned integer string");
const HexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/, "Expected hex bytes");
const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Expected 32-byte hex");
const TransactionHashSchema = Bytes32Schema;

export const VENUS_TESTNET_NATIVE_SUPPLY = {
  chainId: 97,
  mainnetChainId: 56,
  actor: "0x50da554F1bF6A86469DB201C56bfe967d2E7c43d",
  vBnb: "0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c",
  unitroller: "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D",
  mintSelector: "0x1249c58b",
  amountTbnb: "0.0001",
  amountWei: "100000000000000",
  maxGasCostWei: "100000000000000",
  intentTtlMilliseconds: 10 * 60_000,
  confirmations: 12,
  vBnbRuntimeCodeHash: "0xcc20f27bd25a7af8587849a15291244e3aa8018a01cb81ef15e6fd1b78f85ac1",
  unitrollerRuntimeCodeHash: "0x4b4e586288eed4781d5ccd0ff329746c38ed2c4bfd4472c1986f5bf663ad0ba0",
  sourceCommit: "2ef5ebeff8062bbc8b6cfcda67c2c176299373c0",
  sourceUrls: [
    "https://github.com/VenusProtocol/venus-protocol/blob/2ef5ebeff8062bbc8b6cfcda67c2c176299373c0/deployments/bsctestnet/vBNB.json",
    "https://github.com/VenusProtocol/venus-protocol/blob/2ef5ebeff8062bbc8b6cfcda67c2c176299373c0/deployments/bsctestnet/Unitroller.json",
    "https://github.com/VenusProtocol/venus-protocol/blob/2ef5ebeff8062bbc8b6cfcda67c2c176299373c0/contracts/Tokens/VTokens/VBNB.sol",
  ],
} as const;

export const VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY = [
  "This is one founder-controlled BSC Testnet native tBNB supply into the Venus Core Pool, not a BSC mainnet action.",
  "Testnet tBNB and vBNB are not represented as revenue, paid value, or financial performance.",
  "The receipt proves one successful mint to the named operator wallet; it does not prove an external buyer, marketplace hire, settlement, or autonomous execution.",
  "No collateral enablement, borrow, leverage, redemption, rescue, or withdrawal is performed by this action.",
  "This point-in-time receipt does not guarantee future Venus availability, yield, safety, or repeated execution.",
] as const;

const AccountSnapshotSchema = z.object({
  errorCode: UintStringSchema,
  vTokenBalanceRaw: UintStringSchema,
  borrowBalanceRaw: UintStringSchema,
  exchangeRateMantissa: UintStringSchema,
}).strict();

const MainnetIsolationSchema = z.object({
  observedAt: TimestampSchema,
  chainId: z.literal(56),
  nativeBalanceWei: z.literal("0"),
  pendingNonce: z.literal("0"),
}).strict();

const IntentContentSchema = z.object({
  schemaVersion: z.literal("positioncrew.venus-testnet-native-supply-intent.v1"),
  operationId: z.string().uuid(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  chainId: z.literal(97),
  actor: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.actor),
  protocol: z.object({
    vTokenAddress: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.vBnb),
    comptrollerAddress: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.unitroller),
    vTokenRuntimeCodeHash: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.vBnbRuntimeCodeHash),
    comptrollerRuntimeCodeHash: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.unitrollerRuntimeCodeHash),
    sourceCommit: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceCommit),
    sourceUrls: z.tuple([
      z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[0]),
      z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[1]),
      z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[2]),
    ]),
  }).strict(),
  transaction: z.object({
    type: z.literal("legacy"),
    chainId: z.literal(97),
    from: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.actor),
    to: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.vBnb),
    data: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.mintSelector),
    amountTbnb: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.amountTbnb),
    valueWei: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.amountWei),
    nonce: UintStringSchema,
    gasLimit: UintStringSchema.refine((value) => BigInt(value) > 0n, "gasLimit must be positive"),
    gasPriceWei: UintStringSchema.refine((value) => BigInt(value) > 0n, "gasPriceWei must be positive"),
    maxGasCostWei: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei),
  }).strict(),
  preflight: z.object({
    observedAt: TimestampSchema,
    blockNumber: UintStringSchema,
    nativeBalanceWei: UintStringSchema,
    vTokenBalanceRaw: UintStringSchema,
    accountSnapshot: AccountSnapshotSchema,
    marketListed: z.literal(true),
    venusMarket: z.literal(true),
    comptrollerMatches: z.literal(true),
    simulationPassed: z.literal(true),
    mainnetIsolation: MainnetIsolationSchema,
    preflightHash: HashSchema,
  }).strict(),
}).strict();

export const VenusTestnetNativeSupplyIntentSchema = IntentContentSchema.extend({
  intentHash: HashSchema,
}).strict().superRefine((intent, context) => {
  if (Date.parse(intent.expiresAt) - Date.parse(intent.createdAt) !== VENUS_TESTNET_NATIVE_SUPPLY.intentTtlMilliseconds) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Intent must expire exactly ten minutes after creation" });
  }
  const gasCost = BigInt(intent.transaction.gasLimit) * BigInt(intent.transaction.gasPriceWei);
  if (gasCost > BigInt(VENUS_TESTNET_NATIVE_SUPPLY.maxGasCostWei)) {
    context.addIssue({ code: "custom", path: ["transaction", "gasLimit"], message: "Maximum transaction gas cost exceeds the hard cap" });
  }
  const { intentHash: _intentHash, ...content } = intent;
  if (canonicalHash(content) !== intent.intentHash) {
    context.addIssue({ code: "custom", path: ["intentHash"], message: "Intent commitment mismatch" });
  }
});

export type VenusTestnetNativeSupplyIntent = z.infer<typeof VenusTestnetNativeSupplyIntentSchema>;

export function commitVenusTestnetNativeSupplyIntent(
  content: z.input<typeof IntentContentSchema>,
): VenusTestnetNativeSupplyIntent {
  const parsed = IntentContentSchema.parse(content);
  return VenusTestnetNativeSupplyIntentSchema.parse({ ...parsed, intentHash: canonicalHash(parsed) });
}

const SubmissionContentSchema = z.object({
  schemaVersion: z.literal("positioncrew.venus-testnet-native-supply-submission.v1"),
  signedAt: TimestampSchema,
  intent: VenusTestnetNativeSupplyIntentSchema,
  rawTransaction: HexSchema.refine((value) => value.length > 4, "Signed transaction is empty"),
  transactionHash: TransactionHashSchema,
}).strict();

export const VenusTestnetNativeSupplySubmissionSchema = SubmissionContentSchema.extend({
  submissionHash: HashSchema,
}).strict().superRefine((submission, context) => {
  const { submissionHash: _submissionHash, ...content } = submission;
  if (canonicalHash(content) !== submission.submissionHash) {
    context.addIssue({ code: "custom", path: ["submissionHash"], message: "Submission commitment mismatch" });
  }
});

export type VenusTestnetNativeSupplySubmission = z.infer<typeof VenusTestnetNativeSupplySubmissionSchema>;

export function commitVenusTestnetNativeSupplySubmission(
  content: z.input<typeof SubmissionContentSchema>,
): VenusTestnetNativeSupplySubmission {
  const parsed = SubmissionContentSchema.parse(content);
  return VenusTestnetNativeSupplySubmissionSchema.parse({
    ...parsed,
    submissionHash: canonicalHash(parsed),
  });
}

const NormalizedTransactionSchema = z.object({
  hash: TransactionHashSchema,
  chainId: z.literal(97),
  type: z.literal("legacy"),
  blockNumber: UintStringSchema,
  blockHash: Bytes32Schema,
  from: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.actor),
  to: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.vBnb),
  input: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.mintSelector),
  valueWei: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.amountWei),
  nonce: UintStringSchema,
  status: z.literal("SUCCESS"),
  gasUsed: UintStringSchema,
  effectiveGasPriceWei: UintStringSchema,
  transactionCostWei: UintStringSchema,
  explorerUrl: z.string().url(),
}).strict();

const MintEventSchema = z.object({
  minter: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.actor),
  mintAmountWei: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.amountWei),
  mintTokensRaw: UintStringSchema.refine((value) => BigInt(value) > 0n, "Minted vBNB must be positive"),
  logIndex: z.number().int().nonnegative(),
}).strict();

const TransferEventSchema = z.object({
  from: z.literal("0x0000000000000000000000000000000000000000"),
  to: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.actor),
  amountRaw: UintStringSchema.refine((value) => BigInt(value) > 0n, "Transfer amount must be positive"),
  logIndex: z.number().int().nonnegative(),
}).strict();

const EvidenceContentSchema = z.object({
  schemaVersion: z.literal("positioncrew.venus-testnet-native-supply-receipt.v1"),
  evidenceId: z.literal("venus-bsc-testnet-native-supply-1"),
  completedAt: TimestampSchema,
  relationship: z.literal("FOUNDER_CONTROLLED_TESTNET_ACTION"),
  network: z.object({
    name: z.literal("BSC Testnet"),
    chainId: z.literal(97),
    receiptBlockNumber: UintStringSchema,
    receiptBlockHash: Bytes32Schema,
    finalityObservationBlockNumber: UintStringSchema,
    confirmationsObserved: z.number().int().min(VENUS_TESTNET_NATIVE_SUPPLY.confirmations),
    explorerUrl: z.string().url(),
  }).strict(),
  protocol: z.object({
    name: z.literal("Venus Core Pool"),
    marketSymbol: z.literal("vBNB"),
    vTokenAddress: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.vBnb),
    comptrollerAddress: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.unitroller),
    sourceCommit: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceCommit),
    sourceUrls: z.tuple([
      z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[0]),
      z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[1]),
      z.literal(VENUS_TESTNET_NATIVE_SUPPLY.sourceUrls[2]),
    ]),
    vTokenRuntimeCodeHash: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.vBnbRuntimeCodeHash),
    comptrollerRuntimeCodeHash: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.unitrollerRuntimeCodeHash),
  }).strict(),
  actor: z.object({
    wallet: z.literal(VENUS_TESTNET_NATIVE_SUPPLY.actor),
    role: z.literal("FOUNDER_CONTROLLED_TESTNET_WALLET"),
    externalBuyer: z.literal(false),
  }).strict(),
  intent: VenusTestnetNativeSupplyIntentSchema,
  transaction: NormalizedTransactionSchema,
  proof: z.object({
    previousBlockNumber: UintStringSchema,
    mintEvent: MintEventSchema,
    transferEvent: TransferEventSchema,
    vTokenBalanceBeforeRaw: UintStringSchema,
    vTokenBalanceAfterRaw: UintStringSchema,
    vTokenBalanceDeltaRaw: UintStringSchema.refine((value) => BigInt(value) > 0n, "vBNB balance delta must be positive"),
    accountSnapshotBefore: AccountSnapshotSchema,
    accountSnapshotAfter: AccountSnapshotSchema,
    proofHash: HashSchema,
  }).strict(),
  commitments: z.object({
    normalizedReceiptHash: HashSchema,
    artifactHash: HashSchema,
  }).strict(),
  claimBoundary: z.tuple(VENUS_TESTNET_NATIVE_SUPPLY_CLAIM_BOUNDARY.map((entry) => z.literal(entry)) as [
    z.ZodLiteral<string>,
    z.ZodLiteral<string>,
    z.ZodLiteral<string>,
    z.ZodLiteral<string>,
    z.ZodLiteral<string>,
  ]),
}).strict();

export const VenusTestnetNativeSupplyEvidenceSchema = EvidenceContentSchema.superRefine((evidence, context) => {
  const mintTokens = BigInt(evidence.proof.mintEvent.mintTokensRaw);
  const transferAmount = BigInt(evidence.proof.transferEvent.amountRaw);
  const before = BigInt(evidence.proof.vTokenBalanceBeforeRaw);
  const after = BigInt(evidence.proof.vTokenBalanceAfterRaw);
  const delta = BigInt(evidence.proof.vTokenBalanceDeltaRaw);
  if (after - before !== delta || delta !== mintTokens || mintTokens !== transferAmount) {
    context.addIssue({ code: "custom", path: ["proof"], message: "Mint, transfer, and block-pinned vBNB balance delta do not match" });
  }
  const { proofHash: _proofHash, ...proofContent } = evidence.proof;
  if (canonicalHash(proofContent) !== evidence.proof.proofHash) {
    context.addIssue({ code: "custom", path: ["proof", "proofHash"], message: "Proof commitment mismatch" });
  }
  const normalizedReceipt = {
    network: evidence.network,
    transaction: evidence.transaction,
    proof: evidence.proof,
  };
  if (canonicalHash(normalizedReceipt) !== evidence.commitments.normalizedReceiptHash) {
    context.addIssue({ code: "custom", path: ["commitments", "normalizedReceiptHash"], message: "Normalized receipt commitment mismatch" });
  }
  const artifactContent = {
    ...evidence,
    commitments: { normalizedReceiptHash: evidence.commitments.normalizedReceiptHash },
  };
  if (canonicalHash(artifactContent) !== evidence.commitments.artifactHash) {
    context.addIssue({ code: "custom", path: ["commitments", "artifactHash"], message: "Artifact commitment mismatch" });
  }
});

export type VenusTestnetNativeSupplyEvidence = z.infer<typeof VenusTestnetNativeSupplyEvidenceSchema>;

export function commitVenusTestnetNativeSupplyEvidence(
  input: Omit<z.input<typeof EvidenceContentSchema>, "commitments">,
): VenusTestnetNativeSupplyEvidence {
  const { proofHash: _proofHash, ...proofWithoutHash } = input.proof;
  const proof = { ...proofWithoutHash, proofHash: canonicalHash(proofWithoutHash) };
  const normalizedReceiptHash = canonicalHash({
    network: input.network,
    transaction: input.transaction,
    proof,
  });
  const content = {
    ...input,
    proof,
    commitments: { normalizedReceiptHash },
  };
  return VenusTestnetNativeSupplyEvidenceSchema.parse({
    ...content,
    commitments: {
      normalizedReceiptHash,
      artifactHash: canonicalHash(content),
    },
  });
}

export function verifyVenusTestnetNativeSupplyEvidence(
  input: unknown,
): VenusTestnetNativeSupplyEvidence {
  return VenusTestnetNativeSupplyEvidenceSchema.parse(input);
}

export type VenusAccountSnapshotEvidence = z.infer<typeof AccountSnapshotSchema>;
export type VenusNormalizedTransactionEvidence = z.infer<typeof NormalizedTransactionSchema>;
