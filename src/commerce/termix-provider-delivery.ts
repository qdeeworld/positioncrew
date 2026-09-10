import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeFunctionData, parseAbi } from "viem";
import { z } from "zod";
import {
  LendingRescueDeliverableSchema,
  LendingRescueRequestSchema,
} from "../contracts/lending-rescue.js";
import {
  AddressSchema,
  PositiveDecimalSchema,
  TimestampSchema,
} from "../contracts/common.js";
import { canonicalHash } from "../core/canonical.js";
import { evaluateLendingRescue } from "../evaluators/lending-rescue.js";
import { createLendingRescueDeliverable } from "../providers/lending-rescue.js";
import type { VenusAccountProbe } from "../telemetry/bsc.js";
import {
  AacpOrderStatusSchema,
  AacpOrderTxIntentSchema,
} from "./aacp-lifecycle.js";
import { EvaluationReceiptSchema } from "./types.js";

const Bytes32Schema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RawSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const TERMIX_PROVIDER_ABI = parseAbi([
  "function acceptOrder(bytes32 orderId)",
  "function submitDelivery(bytes32 orderId, bytes32 deliveryHash)",
]);

export const TermixProviderOrderSchema = z.object({
  id: z.string().min(1).max(200),
  onChainOrderId: Bytes32Schema,
  status: AacpOrderStatusSchema,
  amount: PositiveDecimalSchema,
  currency: z.enum(["USDC", "USDT"]),
  clientAgentId: z.string().min(1),
  clientAccountId: z.string().min(1),
  providerAgentId: z.string().min(1),
  listingId: z.string().min(1),
  acceptDeadline: TimestampSchema.nullable().optional(),
  deliveryDueAt: TimestampSchema.nullable(),
  challengeWindowEndsAt: TimestampSchema.nullable().optional(),
  redoUsed: z.boolean(),
  availableActions: z.object({
    canProviderAccept: z.boolean().optional(),
    canSubmitDelivery: z.boolean(),
  }).passthrough(),
}).passthrough();

export const TermixContractsConfigSchema = z.object({
  chainId: z.literal(56),
  settlementCurrencies: z.array(z.object({
    symbol: z.enum(["USDC", "USDT"]),
    decimals: z.number().int().positive(),
    address: AddressSchema,
    contracts: z.object({ escrow: AddressSchema }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

const TermixLendingRequestFields = {
  orderId: z.string().min(1).max(200),
  account: AddressSchema,
  targetHealthFactor: PositiveDecimalSchema,
  stressPriceDropBps: z.number().int().min(0).max(5_000),
  maxActionUsd: PositiveDecimalSchema,
  maxGasUsd: PositiveDecimalSchema,
  maxSlippageBps: z.number().int().min(0).max(2_000),
};

export const TermixLendingBuyerRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-lending-buyer-request.v1"),
  ...TermixLendingRequestFields,
}).strict().superRefine((value, context) => {
  if (Number(value.targetHealthFactor) <= 1) {
    context.addIssue({
      code: "custom",
      path: ["targetHealthFactor"],
      message: "targetHealthFactor must be greater than 1",
    });
  }
});

export const TermixBuyerMessageLocatorSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-buyer-message-locator.v1"),
  orderId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  since: TimestampSchema,
}).strict();

export const TermixRuntimeBuyerMessageSchema = z.object({
  messageId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  conversationKind: z.string().min(1).optional(),
  orderId: z.string().min(1).max(200),
  kind: z.literal("TEXT"),
  text: z.string().min(1).max(16_000),
  from: z.object({
    accountId: z.string().min(1),
    walletAddress: AddressSchema.optional(),
    displayName: z.string().nullish(),
    handle: z.string().nullish(),
  }).passthrough(),
  createdAt: TimestampSchema,
}).passthrough();

export const TermixLendingIntakeSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-lending-intake.v1"),
  ...TermixLendingRequestFields,
  buyerEvidence: z.object({
    source: z.enum(["TERMIX_RUNTIME_INBOX", "TERMIX_ORDER_SCOPE"]),
    conversationId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
    senderAccountId: z.string().min(1),
    senderWalletAddress: AddressSchema.nullable(),
    messageCreatedAt: TimestampSchema,
    rawMessageHash: Sha256Schema,
    parsedRequestHash: Sha256Schema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (Number(value.targetHealthFactor) <= 1) {
    context.addIssue({
      code: "custom",
      path: ["targetHealthFactor"],
      message: "targetHealthFactor must be greater than 1",
    });
  }
});

const TermixArtifactOrderSchema = z.object({
  id: z.string().min(1),
  onChainOrderId: Bytes32Schema,
  listingId: z.string().min(1),
  clientAgentId: z.string().min(1),
  clientAccountId: z.string().min(1),
  providerAgentId: z.string().min(1),
  amount: PositiveDecimalSchema,
  currency: z.enum(["USDC", "USDT"]),
  deliveryRound: z.number().int().min(1).max(2),
  deliveryDueAt: TimestampSchema,
  challengeWindowEndsAt: TimestampSchema.nullable(),
}).strict();

export const TermixLendingDeliveryArtifactSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-lending-delivery.v1"),
  generatedAt: TimestampSchema,
  order: TermixArtifactOrderSchema,
  intake: TermixLendingIntakeSchema,
  request: LendingRescueRequestSchema,
  result: LendingRescueDeliverableSchema,
  evaluation: EvaluationReceiptSchema,
  evidence: z.object({
    bscBlockNumber: z.string().regex(/^\d+$/),
    bscExplorerUrl: z.string().url(),
    observationGeneratedAt: TimestampSchema,
    intakeHash: Sha256Schema,
    requestHash: Sha256Schema,
    resultHash: Sha256Schema,
    evaluationHash: Sha256Schema,
  }).strict(),
  boundaries: z.object({
    walletSignatureCreated: z.literal(false),
    transactionBroadcast: z.literal(false),
    protocolActionExecuted: z.literal(false),
    settlementCompleted: z.literal(false),
    note: z.string().min(1),
  }).strict(),
}).strict();

export const TermixFulfillmentStageSchema = z.enum([
  "ORDER_OBSERVED",
  "ACCEPT_INTENT_PREPARED",
  "NEEDS_BUYER_INPUT",
  "DELIVERABLE_PREPARED",
  "ARTIFACT_REGISTERED",
  "SUBMIT_INTENT_PREPARED",
  "DELIVERED",
  "EXPIRED",
  "BLOCKED",
]);

const PreparedArtifactSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.literal("application/json"),
  sizeBytes: z.number().int().positive(),
  sha256: RawSha256Schema,
  deliveryHash: Bytes32Schema,
  manifestSource: z.literal("TERMIX_ARTIFACT_IDS").optional(),
  localPath: z.string().min(1),
  remoteArtifactId: z.string().min(1).nullable(),
  publicUrl: z.string().url().nullable(),
  resultExpiresAt: TimestampSchema,
}).strict();

export const TermixFulfillmentCheckpointSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-lending-fulfillment.v1"),
  chainId: z.literal(56),
  baseUrl: z.string().url(),
  providerAgentId: z.string().min(1),
  listingId: z.string().min(1),
  orderId: z.string().min(1),
  deliveryRound: z.number().int().min(1).max(2),
  stage: TermixFulfillmentStageSchema,
  order: TermixProviderOrderSchema,
  orderHash: Sha256Schema,
  intake: TermixLendingIntakeSchema.nullable(),
  intakeHash: Sha256Schema.nullable(),
  artifact: PreparedArtifactSchema.nullable(),
  acceptIntent: AacpOrderTxIntentSchema.nullable(),
  acceptIntentHash: Sha256Schema.nullable(),
  submitIntent: AacpOrderTxIntentSchema.nullable(),
  submitIntentHash: Sha256Schema.nullable(),
  preparedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  boundaries: z.object({
    acceptanceBroadcast: z.literal(false),
    deliveryBroadcast: z.literal(false),
    walletSignatureCreated: z.literal(false),
    settlementCompleted: z.literal(false),
  }).strict(),
  checkpointHash: Sha256Schema,
}).strict();

export type TermixProviderOrder = z.infer<typeof TermixProviderOrderSchema>;
export type TermixContractsConfig = z.infer<typeof TermixContractsConfigSchema>;
export type TermixLendingBuyerRequest = z.infer<typeof TermixLendingBuyerRequestSchema>;
export type TermixBuyerMessageLocator = z.infer<typeof TermixBuyerMessageLocatorSchema>;
export type TermixLendingIntake = z.infer<typeof TermixLendingIntakeSchema>;
export type TermixLendingDeliveryArtifact = z.infer<typeof TermixLendingDeliveryArtifactSchema>;
export type TermixFulfillmentCheckpoint = z.infer<typeof TermixFulfillmentCheckpointSchema>;

/** Normalize the public marketplace order DTO without silently accepting conflicting bindings. */
export function normalizeTermixProviderOrder(input: unknown): TermixProviderOrder {
  const raw = z.record(z.string(), z.unknown()).parse(input);
  const nested = (key: string) => z.record(z.string(), z.unknown()).parse(raw[key] ?? {});
  const buyer = nested("buyer"), seller = nested("seller"), deadlines = nested("deadlines");
  const mapped: Record<string, unknown> = {
    onChainOrderId: raw.chainOrderId, amount: raw.budget,
    clientAgentId: buyer.clientAgentId, clientAccountId: buyer.id,
    providerAgentId: seller.id, deliveryDueAt: deadlines.deliveryDueAt,
    challengeWindowEndsAt: deadlines.challengeWindowEndsAt,
  };
  const out = { ...raw };
  for (const [key, value] of Object.entries(mapped)) {
    if (value === undefined) continue;
    if (raw[key] !== undefined && raw[key] !== value) throw new Error(`Conflicting TermiX order field: ${key}`);
    out[key] = value;
  }
  return TermixProviderOrderSchema.parse(out);
}

export const LENDING_REQUIREMENTS_GUIDE = `Please send these fields with your own limits (replace every value). I will validate them before accepting the work. This service analyses Venus Classic on BSC; it does not execute transactions.
Account: your 0x wallet address
Target health factor: your target above 1
Stress price drop (%): your stress percentage, 0–50
Maximum action (USD): your action budget
Maximum gas (USD): your gas budget
Maximum slippage (bps): your slippage limit
Analysis only: yes`;

export function parseTermixLendingRequirements(textInput: string, orderId: string) {
  const text = textInput.trim();
  let request: unknown;
  if (text.startsWith("{")) request = JSON.parse(text);
  else if (text.includes("\n") && text.split(/\r?\n/).every(line => /^\s*[^:]+:/.test(line))) {
    const fields: Record<string, unknown> = {};
    const labels: Record<string, string> = {account:"account", "target health factor":"targetHealthFactor", "stress price drop (%)":"stressPriceDropBps", "maximum action (usd)":"maxActionUsd", "maximum gas (usd)":"maxGasUsd", "maximum slippage (bps)":"maxSlippageBps", "analysis only":"analysisOnly"};
    for (const line of text.split(/\r?\n/)) {
      const colon = line.indexOf(":"), label = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
      const key = labels[label];
      if (!key || key in fields || !value) throw new Error("Unknown, duplicate or empty requirement field");
      if (key === "analysisOnly") { if (value.toLowerCase() !== "yes") throw new Error("This service is analysis only"); fields[key] = true; }
      else if (key === "stressPriceDropBps" || key === "maxSlippageBps") {
        if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid numeric requirement");
        fields[key] = Number(value) * (key === "stressPriceDropBps" ? 100 : 1);
      } else fields[key] = value;
    }
    if (!fields.analysisOnly) throw new Error("Confirm analysis only: yes");
    delete fields.analysisOnly;
    request = {schemaVersion:"positioncrew.termix-lending-buyer-request.v1",orderId,...fields};
  } else {
    const match = /^Assess the current Venus BSC mainnet position for (0x[a-fA-F0-9]{40})\. Target health factor (\d+(?:\.\d+)?); stress collateral prices by (\d+(?:\.\d+)?)%; maximum action budget USD (\d+(?:\.\d+)?); maximum gas USD (\d+(?:\.\d+)?); maximum slippage (\d+) bps\. Deliver current health factor, debt and collateral observations, stressed health factor, a bounded rescue recommendation or explicit no-action\/insufficient-budget result, projected health factor, source block, expiry, and a machine-readable report with a concise explanation\. Analysis only; do not execute protocol transactions\.$/.exec(text);
    if (!match) throw new Error("Unsupported or ambiguous buyer requirements; buyer clarification required");
    request = { schemaVersion: "positioncrew.termix-lending-buyer-request.v1", orderId: orderId,
      account: match[1], targetHealthFactor: match[2], stressPriceDropBps: Number(match[3]) * 100,
      maxActionUsd: match[4], maxGasUsd: match[5], maxSlippageBps: Number(match[6]) };
  }
  const parsed = TermixLendingBuyerRequestSchema.parse(request);
  if (parsed.orderId !== orderId) throw new Error("Request belongs to another order");
  return parsed;
}

/** Only parse explicit supported fields; ask for clarification instead of guessing constraints. */
export function createTermixLendingIntakeFromOrderScope(orderInput: unknown): TermixLendingIntake {
  const order = normalizeTermixProviderOrder(orderInput);
  const scope = z.string().min(1).max(16000).parse(order.scope);
  const marker = "Buyer requirements:\n";
  if (scope.split(marker).length !== 2) throw new Error("Order needs one explicit Buyer requirements section");
  const parsed = parseTermixLendingRequirements(scope.split(marker)[1]!, order.id);
  const createdAt = TimestampSchema.parse(order.createdAt);
  return TermixLendingIntakeSchema.parse({ ...parsed, schemaVersion: "positioncrew.termix-lending-intake.v1",
    buyerEvidence: { source: "TERMIX_ORDER_SCOPE", conversationId: order.id,
      messageId: canonicalHash(scope), senderAccountId: order.clientAccountId,
      senderWalletAddress: null, messageCreatedAt: createdAt, rawMessageHash: canonicalHash(scope),
      parsedRequestHash: canonicalHash(parsed) } });
}

export function assertTermixProviderOrder(
  input: unknown,
  expected: { orderId: string; providerAgentId: string; listingId: string },
): TermixProviderOrder {
  const order = normalizeTermixProviderOrder(input);
  if (order.id !== expected.orderId) throw new Error("TermiX returned a different order ID");
  if (order.providerAgentId !== expected.providerAgentId) {
    throw new Error("TermiX order belongs to a different provider agent");
  }
  if (order.listingId !== expected.listingId) {
    throw new Error("TermiX order belongs to a different service listing");
  }
  return order;
}

export function createTermixLendingIntakeFromRuntimeMessage(
  orderInput: unknown,
  locatorInput: unknown,
  messageInput: unknown,
): TermixLendingIntake {
  const order = TermixProviderOrderSchema.parse(orderInput);
  const locator = TermixBuyerMessageLocatorSchema.parse(locatorInput);
  const message = TermixRuntimeBuyerMessageSchema.parse(messageInput);
  if (locator.orderId !== order.id || message.orderId !== order.id) {
    throw new Error("TermiX buyer message is not bound to the exact order");
  }
  if (message.conversationId !== locator.conversationId || message.messageId !== locator.messageId) {
    throw new Error("TermiX buyer message does not match the requested platform locator");
  }
  if (message.from.accountId !== order.clientAccountId) {
    throw new Error("TermiX buyer message sender is not the order client account");
  }
  const buyerRequest = parseTermixLendingRequirements(message.text, order.id);
  return TermixLendingIntakeSchema.parse({
    ...buyerRequest,
    schemaVersion: "positioncrew.termix-lending-intake.v1",
    buyerEvidence: {
      source: "TERMIX_RUNTIME_INBOX",
      conversationId: message.conversationId,
      messageId: message.messageId,
      senderAccountId: message.from.accountId,
      senderWalletAddress: message.from.walletAddress ?? null,
      messageCreatedAt: message.createdAt,
      rawMessageHash: canonicalHash(message.text),
      parsedRequestHash: canonicalHash(buyerRequest),
    },
  });
}

function artifactOrderIdentity(orderInput: unknown) {
  const order = TermixProviderOrderSchema.parse(orderInput);
  if (!order.deliveryDueAt) throw new Error("Deliverable TermiX order is missing deliveryDueAt");
  return TermixArtifactOrderSchema.parse({
    id: order.id,
    onChainOrderId: order.onChainOrderId,
    listingId: order.listingId,
    clientAgentId: order.clientAgentId,
    clientAccountId: order.clientAccountId,
    providerAgentId: order.providerAgentId,
    amount: order.amount,
    currency: order.currency,
    deliveryRound: order.redoUsed ? 2 : 1,
    deliveryDueAt: order.deliveryDueAt,
    challengeWindowEndsAt: order.challengeWindowEndsAt ?? null,
  });
}

export function assertTermixLendingArtifactOrder(
  artifactInput: unknown,
  orderInput: unknown,
): TermixLendingDeliveryArtifact {
  const artifact = TermixLendingDeliveryArtifactSchema.parse(artifactInput);
  const currentIdentity = artifactOrderIdentity(orderInput);
  if (canonicalHash(artifact.order) !== canonicalHash(currentIdentity)) {
    throw new Error("Prepared artifact does not match the refreshed immutable order identity");
  }
  return artifact;
}

function intentTarget(intent: z.infer<typeof AacpOrderTxIntentSchema>): string {
  return intent.contract ?? intent.to!;
}

function intentData(intent: z.infer<typeof AacpOrderTxIntentSchema>): `0x${string}` {
  return (intent.callData ?? intent.data!) as `0x${string}`;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertDeadline(deadline: string | null | undefined, now: Date, safetySeconds: number): void {
  if (!deadline) throw new Error("TermiX order is missing the required deadline");
  if (Date.parse(deadline) - now.getTime() < safetySeconds * 1_000) {
    throw new Error(`TermiX deadline has less than ${safetySeconds} seconds remaining`);
  }
}

export function assertTermixProviderIntent(
  orderInput: unknown,
  configInput: unknown,
  intentInput: unknown,
  expectedAction: "acceptOrder" | "submitDelivery",
  options: { expectedDeliveryHash?: string; now?: Date; safetySeconds?: number; allowUnflaggedAcceptance?: boolean } = {},
): { intent: z.infer<typeof AacpOrderTxIntentSchema>; intentHash: string; deliveryHash: string | null } {
  const order = TermixProviderOrderSchema.parse(orderInput);
  const config = TermixContractsConfigSchema.parse(configInput);
  const intent = AacpOrderTxIntentSchema.parse(intentInput);
  const now = options.now ?? new Date();
  const safetySeconds = options.safetySeconds ?? 120;
  if (intent.action !== expectedAction) {
    throw new Error(`Expected ${expectedAction} intent, received ${intent.action}`);
  }
  if (intent.chainId !== config.chainId || intent.value !== "0") {
    throw new Error("TermiX provider intent must target BNB Chain without native value");
  }
  const settlement = config.settlementCurrencies.find((item) => item.symbol === order.currency);
  if (!settlement) throw new Error(`No TermiX escrow is configured for ${order.currency}`);
  if (!sameHex(intentTarget(intent), settlement.contracts.escrow)) {
    throw new Error("TermiX provider intent targets an unexpected escrow contract");
  }
  if (expectedAction === "acceptOrder") {
    if (order.status !== "PENDING_ACCEPT" || (order.availableActions.canProviderAccept !== true && !(options.allowUnflaggedAcceptance && order.availableActions.canProviderAccept === undefined))) {
      throw new Error("TermiX order is not explicitly ready for provider acceptance");
    }
    // Current API omits this flag/deadline. The bounded coordinator also requires
    // a fresh successful contract simulation; the contract enforces acceptWindow.
    if (order.acceptDeadline || !options.allowUnflaggedAcceptance) assertDeadline(order.acceptDeadline, now, safetySeconds);
    else assertDeadline(order.deliveryDueAt, now, safetySeconds);
  } else {
    if (!["FUNDED", "IN_PROGRESS"].includes(order.status)) {
      throw new Error("TermiX order is not in a deliverable state");
    }
    if (order.availableActions.canSubmitDelivery !== true) {
      throw new Error("TermiX order is not explicitly ready for delivery");
    }
    assertDeadline(order.deliveryDueAt, now, safetySeconds);
  }

  let decoded: ReturnType<typeof decodeFunctionData<typeof TERMIX_PROVIDER_ABI>>;
  try {
    decoded = decodeFunctionData({ abi: TERMIX_PROVIDER_ABI, data: intentData(intent) });
  } catch {
    throw new Error(`${expectedAction} calldata is not a valid TermiX provider call`);
  }
  if (decoded.functionName !== expectedAction) {
    throw new Error(`${expectedAction} intent uses an unexpected function selector`);
  }
  const args = (decoded.args ?? []) as readonly unknown[];
  const encodedOrderId = args[0];
  if (typeof encodedOrderId !== "string" || !sameHex(encodedOrderId, order.onChainOrderId)) {
    throw new Error(`${expectedAction} intent is bound to a different on-chain order`);
  }
  let deliveryHash: string | null = null;
  if (expectedAction === "submitDelivery") {
    const encodedDeliveryHash = args[1];
    const expectedDeliveryHash = Bytes32Schema.parse(options.expectedDeliveryHash);
    if (typeof encodedDeliveryHash !== "string" || !sameHex(encodedDeliveryHash, expectedDeliveryHash)) {
      throw new Error("submitDelivery intent is not bound to the reviewed artifact hash");
    }
    deliveryHash = expectedDeliveryHash;
  }
  return { intent, intentHash: canonicalHash(intent), deliveryHash };
}

export function createTermixLendingDeliveryArtifact(
  orderInput: unknown,
  intakeInput: unknown,
  probe: VenusAccountProbe,
  now = new Date(),
): TermixLendingDeliveryArtifact {
  const order = TermixProviderOrderSchema.parse(orderInput);
  const intake = TermixLendingIntakeSchema.parse(intakeInput);
  if (intake.orderId !== order.id) throw new Error("Lending intake belongs to a different order");
  if (probe.chainId !== 56 || !sameHex(probe.account, intake.account)) {
    throw new Error("Venus observation is not bound to the requested BSC account");
  }
  const request = LendingRescueRequestSchema.parse(probe.rescueRequest);
  const expectedOptions = {
    targetHealthFactor: intake.targetHealthFactor,
    stressPriceDropBps: intake.stressPriceDropBps,
    maxActionUsd: intake.maxActionUsd,
    maxGasUsd: intake.maxGasUsd,
    maxSlippageBps: intake.maxSlippageBps,
  };
  for (const [key, expected] of Object.entries(expectedOptions)) {
    if (request[key as keyof typeof expectedOptions] !== expected) {
      throw new Error(`Venus request does not preserve buyer constraint ${key}`);
    }
  }
  const result = createLendingRescueDeliverable(request, now);
  const evaluation = evaluateLendingRescue(
    request,
    result,
    "positioncrew-termix-provider-gate",
    now,
  );
  if (!evaluation.passed) throw new Error("Generated Lending deliverable failed conformance");
  return TermixLendingDeliveryArtifactSchema.parse({
    schemaVersion: "positioncrew.termix-lending-delivery.v1",
    generatedAt: now.toISOString(),
    order: artifactOrderIdentity(order),
    intake,
    request,
    result,
    evaluation,
    evidence: {
      bscBlockNumber: probe.source.blockNumber,
      bscExplorerUrl: probe.source.explorerUrl,
      observationGeneratedAt: probe.generatedAt,
      intakeHash: canonicalHash(intake),
      requestHash: canonicalHash(request),
      resultHash: canonicalHash(result),
      evaluationHash: evaluation.evaluationHash,
    },
    boundaries: {
      walletSignatureCreated: false,
      transactionBroadcast: false,
      protocolActionExecuted: false,
      settlementCompleted: false,
      note: "This artifact is a bounded unsigned analysis. A separately confirmed on-chain delivery transaction is still required.",
    },
  });
}

export function termixDeliveryArtifactDescriptor(
  artifactInput: unknown,
): {
  artifact: TermixLendingDeliveryArtifact;
  content: string;
  fileName: string;
  contentType: "application/json";
  sizeBytes: number;
  sha256: string;
  deliveryHash: string;
} {
  const artifact = TermixLendingDeliveryArtifactSchema.parse(artifactInput);
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  const encoded = new TextEncoder().encode(content);
  const digest = bytesToHex(sha256(encoded));
  const safeOrderId = artifact.order.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    artifact,
    content,
    fileName: `positioncrew-lending-${safeOrderId}-round-${artifact.order.deliveryRound}.json`,
    contentType: "application/json",
    sizeBytes: encoded.byteLength,
    sha256: digest,
    deliveryHash: `0x${digest}`,
  };
}

type CheckpointDraft = Omit<TermixFulfillmentCheckpoint, "checkpointHash">;

export function sealTermixFulfillmentCheckpoint(
  input: CheckpointDraft,
): TermixFulfillmentCheckpoint {
  return TermixFulfillmentCheckpointSchema.parse({
    ...input,
    checkpointHash: canonicalHash(input),
  });
}

export function verifyTermixFulfillmentCheckpoint(input: unknown): TermixFulfillmentCheckpoint {
  const checkpoint = TermixFulfillmentCheckpointSchema.parse(input);
  const { checkpointHash, ...body } = checkpoint;
  if (canonicalHash(body) !== checkpointHash) throw new Error("TermiX fulfillment checkpoint hash mismatch");
  return checkpoint;
}
