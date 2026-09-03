import { buildJobDescription, DeliverableManifest } from "@bnbagent/sdk/erc8183";
import { verifyMessage } from "ethers";
import { getAddress, keccak256, toBytes } from "viem";
import { z } from "zod";

import {
  LpRebalanceDeliverableSchema,
  LpRebalanceRequestSchema,
  type LpRebalanceDeliverable,
  type LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";
import { canonicalHash } from "../core/canonical.js";
import { parseFixed } from "../core/fixed.js";
import { validateEvidence } from "../providers/provider-utils.js";

const BNB_LP_RANGE_PROVIDER = {
  agentTokenId: 265375,
  endpoint: "https://bnb-lp.172-104-171-139.nip.io/",
  registryOwner: "0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b",
  kernel: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6",
  paymentToken: "0xcE24439F2D9C6a2289F741120FE202248B666666",
  maximumPriceAtomic: "100000000000000000",
  allowedDeliveryOrigins: [
    "https://bnb-lp.172-104-171-139.nip.io",
    "https://bnb-lp-api.172-104-171-139.nip.io",
  ],
} as const;

const MAXIMUM_QUOTE_WINDOW_SECONDS = 900;

const quoteTerms = {
  deliverables:
    "Return a machine-readable LP range recommendation or HOLD/refusal attributable to this exact requestId, including source block, proposed ticks, expected costs, expiry, and reasons.",
  quality_standards:
    "Bind to the exact requestId and BSC block; do not claim execution; preserve buyer maxActionUsd, maxGasUsd, maxSlippageBps, deadline, and all constraints; refuse if data is stale or unsupported.",
} as const;

const QuoteDataSchema = z
  .object({
    request: z
      .object({
        task_description: z.string().min(1),
        terms: z
          .object({
            deliverables: z.string().min(1),
            quality_standards: z.string().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
    request_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    response: z
      .object({
        accepted: z.literal(true),
        terms: z
          .object({
            deliverables: z.string().min(1),
            quality_standards: z.string().min(1),
            price: z.string().regex(/^\d+$/),
            currency: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          })
          .passthrough(),
        estimated_completion_seconds: z.number().int().positive(),
        quote_expires_at: z.number().int().positive(),
        negotiated_at: z.number().int().positive(),
      })
      .passthrough(),
    response_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    negotiation_hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
    provider_sig: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
    chain_id: z.literal(56),
    verifying_contract: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  })
  .passthrough();

const QuoteEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: z
      .object({
        kind: z.literal("message"),
        messageId: z.string().min(1),
        parts: z
          .array(
            z
              .object({
                kind: z.literal("data"),
                data: QuoteDataSchema,
              })
              .passthrough(),
          )
          .min(1),
      })
      .passthrough(),
  })
  .strict();

const FundedEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: z
      .object({
        kind: z.literal("message"),
        messageId: z.string().min(1),
        parts: z
          .array(
            z
              .object({
                kind: z.literal("data"),
                data: z
                  .object({
                    status: z.enum(["accepted", "rejected"]),
                    job_id: z.union([z.number().int().safe().nonnegative(), z.string().regex(/^\d+$/)]),
                  })
                  .passthrough(),
              })
              .passthrough(),
          )
          .min(1),
      })
      .passthrough(),
  })
  .strict();

const DeliverableManifestDocumentSchema = z
  .object({
    version: z.literal(1),
    job_id: z.number().int().safe().nonnegative(),
    chain_id: z.literal(56),
    contracts: z
      .object({
        commerce: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        router: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        policy: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      })
      .passthrough(),
    response: z
      .object({
        content: z.string().min(1),
        content_type: z.string().min(1).optional(),
      })
      .strict(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type BnbLpSignedQuote = z.infer<typeof QuoteDataSchema>;

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortCanonical((value as Record<string, unknown>)[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical quote content cannot contain non-finite numbers");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value)).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function keccakCanonical(value: unknown): string {
  return keccak256(toBytes(canonicalJson(value)));
}

function sanitizeForClaim(value: unknown): string {
  const input = typeof value === "string" ? value : String(value);
  let output = "";
  for (const character of input.replaceAll("[", "(").replaceAll("]", ")")) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x20 || character === "\t" || character === "\n") {
      output += character;
    }
  }
  return output;
}

function signedDescriptionContent(quote: BnbLpSignedQuote): Record<string, unknown> {
  const terms: Record<string, unknown> = {
    deliverables: sanitizeForClaim(quote.response.terms.deliverables),
    quality_standards: sanitizeForClaim(quote.response.terms.quality_standards),
  };
  const successCriteria = quote.response.terms.success_criteria;
  if (Array.isArray(successCriteria) && successCriteria.length > 0) {
    terms.success_criteria = successCriteria.map(sanitizeForClaim);
  }
  return {
    version: 1,
    negotiated_at: quote.response.negotiated_at,
    task: sanitizeForClaim(quote.request.task_description),
    terms,
    price: quote.response.terms.price,
    currency: quote.response.terms.currency,
    quote_expires_at: quote.response.quote_expires_at,
    chain_id: quote.chain_id,
    verifying_contract: getAddress(quote.verifying_contract),
  };
}

function responseHashContent(quote: BnbLpSignedQuote): Record<string, unknown> {
  return {
    accepted: quote.response.accepted,
    terms: quote.response.terms,
    estimated_completion_seconds: quote.response.estimated_completion_seconds,
    quote_expires_at: quote.response.quote_expires_at,
  };
}

function authenticatedQuote(quote: BnbLpSignedQuote): Record<string, unknown> {
  return {
    ...signedDescriptionContent(quote),
    negotiation_hash: quote.negotiation_hash,
    provider_sig: quote.provider_sig,
  };
}

function taskDescription(request: LpRebalanceRequest): string {
  return `Evaluate this exact PositionCrew LP_REBALANCE request without changing its fields. Canonical raw-request hash: ${canonicalHash(request)}. Request: ${JSON.stringify(request)}`;
}

export function buildBnbLpRangeQuoteRequest(
  input: LpRebalanceRequest,
  messageId = crypto.randomUUID(),
): Record<string, unknown> {
  const request = LpRebalanceRequestSchema.parse(input);
  return {
    jsonrpc: "2.0",
    id: messageId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId,
        parts: [
          {
            kind: "data",
            data: {
              skill: "negotiate",
              task_description: taskDescription(request),
              terms: quoteTerms,
            },
          },
        ],
      },
    },
  };
}

async function readBoundedJson(
  response: Response,
  maximumBytes = 128 * 1024,
): Promise<unknown> {
  if (!response.body) throw new Error("External LP quote response has no body");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`External LP quote exceeds ${maximumBytes} bytes`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel("response exceeds PositionCrew limit").catch(() => undefined);
      throw new Error(`External LP quote exceeds ${maximumBytes} bytes`);
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

export interface BnbLpRangeQuoteTrace {
  schemaVersion: "positioncrew.live-match.lp-quote-trace.v1";
  adapterId: "positioncrew:a2a:bnb-lp-range:quote:v1";
  providerAgentTokenId: 265375;
  endpoint: string;
  frozenRequest: LpRebalanceRequest;
  frozenRequestHash: string;
  nativeRequest: Record<string, unknown>;
  nativeRequestHash: string;
  startedAt: string;
  completedAt: string;
  durationMilliseconds: number;
  authenticatedQuote: ReturnType<typeof authenticatedQuote>;
  jobDescription: string;
  jobDescriptionHash: string;
  negotiatedAt: number;
  quoteExpiresAt: number;
  declaredEstimatedCompletionSeconds: number;
  protocolIntegrity: {
    requestHash: string;
    responseHash: string;
    boundary: string;
  };
  recoveredSigner: string;
  states: {
    identity: "FROZEN_REGISTRY_OWNER_SIGNATURE_MATCHED";
    liveness: "A2A_RESPONDED";
    compatibility: "DECLARED_ONLY_DELIVERY_VALIDATION_PENDING";
    activation: "SIGNED_QUOTE_ACCEPTED_FUNDING_NOT_PERFORMED";
    selection: "NOT_ELIGIBLE_YET";
  };
  boundary: string;
}

export async function requestBnbLpRangeQuote(
  input: LpRebalanceRequest,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<BnbLpRangeQuoteTrace> {
  const frozenRequest = LpRebalanceRequestSchema.parse(input);
  const nativeRequest = buildBnbLpRangeQuoteRequest(frozenRequest);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const startedClock = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("external A2A timeout"), 12_000);
  let envelopeInput: unknown;
  try {
    const response = await fetchImpl(BNB_LP_RANGE_PROVIDER.endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(nativeRequest),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`External LP quote failed with HTTP ${response.status}`);
    }
    envelopeInput = await readBoundedJson(response);
  } finally {
    clearTimeout(timeout);
  }

  const envelope = QuoteEnvelopeSchema.parse(envelopeInput);
  if (envelope.id !== nativeRequest.id) {
    throw new Error("External LP quote does not bind the JSON-RPC request id");
  }
  const quote = envelope.result.parts[0]!.data;
  const expectedDescription = taskDescription(frozenRequest);
  if (
    quote.request.task_description !== expectedDescription ||
    quote.request.terms.deliverables !== quoteTerms.deliverables ||
    quote.request.terms.quality_standards !== quoteTerms.quality_standards ||
    quote.response.terms.deliverables !== quoteTerms.deliverables ||
    quote.response.terms.quality_standards !== quoteTerms.quality_standards
  ) {
    throw new Error("External LP quote changed the frozen job or quality terms");
  }
  if (!sameAddress(quote.verifying_contract, BNB_LP_RANGE_PROVIDER.kernel)) {
    throw new Error("External LP quote uses an unexpected ERC-8183 kernel");
  }
  if (frozenRequest.chainId !== quote.chain_id) {
    throw new Error("Frozen PositionCrew LP request chain does not match the provider quote chain");
  }
  if (!sameAddress(quote.response.terms.currency, BNB_LP_RANGE_PROVIDER.paymentToken)) {
    throw new Error("External LP quote uses an unexpected payment token");
  }
  if (BigInt(quote.response.terms.price) > BigInt(BNB_LP_RANGE_PROVIDER.maximumPriceAtomic)) {
    throw new Error("External LP quote exceeds the frozen maximum price");
  }
  const verificationTime = options.now ?? new Date();
  const verificationMilliseconds = verificationTime.getTime();
  const requestedAtMilliseconds = Date.parse(frozenRequest.requestedAt);
  if (requestedAtMilliseconds > verificationMilliseconds) {
    throw new Error("Frozen PositionCrew LP request is future-dated at quote verification");
  }
  const postRequestEvidence = [
    ...frozenRequest.sources.map((source) => ({
      label: `source ${source.sourceId}`,
      observedAt: source.observedAt,
    })),
    {
      label: `market observation ${frozenRequest.marketState.sourceId}`,
      observedAt: frozenRequest.marketState.observedAt,
    },
  ].filter((item) => Date.parse(item.observedAt) > requestedAtMilliseconds);
  if (postRequestEvidence.length > 0) {
    throw new Error(
      `Frozen PositionCrew LP evidence was captured after request creation: ${postRequestEvidence.map((item) => item.label).join(", ")}`,
    );
  }
  const evidence = validateEvidence({
    sources: frozenRequest.sources,
    observations: [frozenRequest.marketState],
    requestedAt: frozenRequest.requestedAt,
    deadline: frozenRequest.deadline,
    maxDataAgeSeconds: frozenRequest.maxDataAgeSeconds,
    now: verificationTime,
  });
  if (evidence.status !== "OK") {
    throw new Error(
      `Frozen PositionCrew LP request evidence failed at quote verification: ${evidence.status}: ${evidence.reasons.join(" ")}`,
    );
  }
  const recomputedRequestHash = keccakCanonical(quote.request);
  if (recomputedRequestHash.toLowerCase() !== quote.request_hash.toLowerCase()) {
    throw new Error("External LP request_hash does not match the echoed canonical request");
  }
  const recomputedResponseHash = keccakCanonical(responseHashContent(quote));
  if (recomputedResponseHash.toLowerCase() !== quote.response_hash.toLowerCase()) {
    throw new Error("External LP response_hash does not match the canonical quote response");
  }
  const recomputedNegotiationHash = keccakCanonical(signedDescriptionContent(quote));
  if (recomputedNegotiationHash.toLowerCase() !== quote.negotiation_hash.toLowerCase()) {
    throw new Error("External LP negotiation_hash does not match the signed quote content");
  }
  const nowSeconds = Math.floor(verificationMilliseconds / 1_000);
  if (quote.response.quote_expires_at <= nowSeconds) {
    throw new Error("External LP quote is already expired");
  }
  if (quote.response.quote_expires_at <= quote.response.negotiated_at) {
    throw new Error("External LP quote expiry is not later than its negotiation time");
  }
  if (
    quote.response.quote_expires_at - quote.response.negotiated_at >
    MAXIMUM_QUOTE_WINDOW_SECONDS
  ) {
    throw new Error("External LP quote exceeds the SDK maximum 900-second quote window");
  }
  if (quote.response.negotiated_at * 1_000 < requestedAtMilliseconds - 1_000) {
    throw new Error("External LP negotiation predates the frozen PositionCrew request");
  }
  if (
    quote.response.negotiated_at > nowSeconds + 60 ||
    quote.response.negotiated_at < nowSeconds - 300
  ) {
    throw new Error("External LP quote negotiation time is outside the admitted window");
  }
  const recoveredSigner = verifyMessage(quote.negotiation_hash, quote.provider_sig);
  if (!sameAddress(recoveredSigner, BNB_LP_RANGE_PROVIDER.registryOwner)) {
    throw new Error("External LP quote signer does not match the frozen ERC-8004 owner");
  }
  const jobDescription = buildJobDescription(quote as unknown as Record<string, unknown>);

  const completedAt = verificationTime;
  return {
    schemaVersion: "positioncrew.live-match.lp-quote-trace.v1",
    adapterId: "positioncrew:a2a:bnb-lp-range:quote:v1",
    providerAgentTokenId: BNB_LP_RANGE_PROVIDER.agentTokenId,
    endpoint: BNB_LP_RANGE_PROVIDER.endpoint,
    frozenRequest,
    frozenRequestHash: canonicalHash(frozenRequest),
    nativeRequest,
    nativeRequestHash: canonicalHash(nativeRequest),
    startedAt: now.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMilliseconds: Math.round(performance.now() - startedClock),
    authenticatedQuote: authenticatedQuote(quote),
    jobDescription,
    jobDescriptionHash: canonicalHash(jobDescription),
    negotiatedAt: quote.response.negotiated_at,
    quoteExpiresAt: quote.response.quote_expires_at,
    declaredEstimatedCompletionSeconds: quote.response.estimated_completion_seconds,
    protocolIntegrity: {
      requestHash: quote.request_hash,
      responseHash: quote.response_hash,
      boundary:
        "These canonical hashes detect inconsistent protocol payloads but are not covered by the provider owner signature. PositionCrew does not use or expose unsigned response extensions as authenticated quote terms.",
    },
    recoveredSigner,
    states: {
      identity: "FROZEN_REGISTRY_OWNER_SIGNATURE_MATCHED",
      liveness: "A2A_RESPONDED",
      compatibility: "DECLARED_ONLY_DELIVERY_VALIDATION_PENDING",
      activation: "SIGNED_QUOTE_ACCEPTED_FUNDING_NOT_PERFORMED",
      selection: "NOT_ELIGIBLE_YET",
    },
    boundary:
      "This trace proves an identity-bound signed quote and SDK-native job description for the exact current LP request. estimated_completion_seconds is TLS-observed operational metadata, not provider-signature-authenticated. It does not prove a compatible delivery, payment, provider selection, LP execution, or investment performance.",
  };
}

export interface BnbLpFundedNotification {
  schemaVersion: "positioncrew.live-match.lp-funded-notification.v1";
  endpoint: string;
  messageId: string;
  commerceJobId: string;
  status: "accepted";
  providerMessageId: string;
  boundary: string;
}

export async function notifyBnbLpRangeFunded(
  commerceJobId: bigint,
  options: { fetchImpl?: typeof fetch; messageId?: string } = {},
): Promise<BnbLpFundedNotification> {
  if (commerceJobId < 0n || commerceJobId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("External LP funded notification requires a safe-integer job ID");
  }
  const messageId = options.messageId ?? crypto.randomUUID();
  const request = {
    jsonrpc: "2.0",
    id: messageId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId,
        parts: [{ kind: "data", data: { skill: "notify_funded", job_id: Number(commerceJobId) } }],
      },
    },
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("external A2A timeout"), 12_000);
  let envelopeInput: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(BNB_LP_RANGE_PROVIDER.endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`External LP funded notification failed with HTTP ${response.status}`);
    }
    envelopeInput = await readBoundedJson(response);
  } finally {
    clearTimeout(timeout);
  }
  const envelope = FundedEnvelopeSchema.parse(envelopeInput);
  if (envelope.id !== messageId) {
    throw new Error("External LP funded notification does not bind the JSON-RPC request id");
  }
  const data = envelope.result.parts[0]!.data;
  if (String(data.job_id) !== commerceJobId.toString()) {
    throw new Error("External LP funded notification returned a different job ID");
  }
  if (data.status !== "accepted") {
    throw new Error("External LP provider rejected the funded job notification");
  }
  return {
    schemaVersion: "positioncrew.live-match.lp-funded-notification.v1",
    endpoint: BNB_LP_RANGE_PROVIDER.endpoint,
    messageId,
    commerceJobId: commerceJobId.toString(),
    status: "accepted",
    providerMessageId: envelope.result.messageId,
    boundary:
      "The provider acknowledged a funded ERC-8183 job. Delivery, compatibility, settlement, LP execution, and investment performance remain unproved.",
  };
}

export interface BnbLpDeliveryCheck {
  id: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface BnbLpDeliveryValidation {
  schemaVersion: "positioncrew.live-match.lp-delivery-validation.v1";
  status: "COMPATIBLE" | "INCOMPATIBLE";
  currentState: "CURRENTLY_ACTIONABLE" | "CURRENTLY_NO_ACTION" | "HISTORICAL_OR_INVALID";
  manifestHash: string | null;
  deliverable: LpRebalanceDeliverable | null;
  checks: BnbLpDeliveryCheck[];
  boundary: string;
}

function deliveryFailure(
  checks: BnbLpDeliveryCheck[],
  detail: string,
): BnbLpDeliveryValidation {
  checks.push({ id: "delivery-contract", status: "FAIL", detail });
  return {
    schemaVersion: "positioncrew.live-match.lp-delivery-validation.v1",
    status: "INCOMPATIBLE",
    currentState: "HISTORICAL_OR_INVALID",
    manifestHash: null,
    deliverable: null,
    checks,
    boundary:
      "The attributable delivery failed PositionCrew's exact-job contract. Funding or submission alone does not make this provider compatible, selected, safe to settle, or authorized to move LP capital.",
  };
}

export function validateBnbLpRangeDelivery(input: {
  request: LpRebalanceRequest;
  manifestDocument: unknown;
  commerceJobId: bigint;
  onchainDeliverable: `0x${string}`;
  fundedAt: string;
  submittedAt: string;
  expectedContracts: { commerce: string; router: string; policy: string };
  now?: Date;
}): BnbLpDeliveryValidation {
  const request = LpRebalanceRequestSchema.parse(input.request);
  const checks: BnbLpDeliveryCheck[] = [];
  const add = (id: string, passed: boolean, detail: string): void => {
    checks.push({ id, status: passed ? "PASS" : "FAIL", detail });
  };
  const manifestResult = DeliverableManifestDocumentSchema.safeParse(input.manifestDocument);
  if (!manifestResult.success) {
    return deliveryFailure(checks, `Strict ERC-8183 manifest rejected: ${manifestResult.error.issues[0]?.message ?? "invalid manifest"}`);
  }
  if (input.commerceJobId > BigInt(Number.MAX_SAFE_INTEGER)) {
    return deliveryFailure(checks, "ERC-8183 job ID exceeds the manifest's safe integer representation");
  }
  const document = manifestResult.data;
  let manifest: DeliverableManifest;
  try {
    manifest = DeliverableManifest.fromDict(document as unknown as Record<string, unknown>);
  } catch (error) {
    return deliveryFailure(checks, error instanceof Error ? error.message : "SDK manifest parsing failed");
  }
  add("job-id", manifest.jobId === Number(input.commerceJobId), "Manifest job_id must equal the funded ERC-8183 job.");
  add("chain-id", manifest.chainId === 56, "Manifest chain_id must be BSC mainnet 56.");
  for (const key of ["commerce", "router", "policy"] as const) {
    add(
      `contract-${key}`,
      sameAddress(manifest.contracts[key] ?? "", input.expectedContracts[key]),
      `Manifest ${key} contract must match the precommitted ERC-8183 deployment.`,
    );
  }
  add("manifest-hash", manifest.verify(input.onchainDeliverable), "Canonical manifest hash must match the on-chain deliverable bytes32.");

  let content: unknown;
  try {
    content = JSON.parse(manifest.response.content) as unknown;
  } catch {
    return deliveryFailure(checks, "Manifest response content is not JSON");
  }
  if (typeof content === "object" && content !== null && "result" in content) {
    content = (content as { result: unknown }).result;
  }
  const outputResult = LpRebalanceDeliverableSchema.safeParse(content);
  if (!outputResult.success) {
    return deliveryFailure(checks, `LP deliverable schema rejected: ${outputResult.error.issues[0]?.message ?? "invalid output"}`);
  }
  const output = outputResult.data;
  const fundedAt = Date.parse(input.fundedAt);
  const submittedAt = Date.parse(input.submittedAt);
  const generatedAt = Date.parse(output.generatedAt);
  const expiresAt = Date.parse(output.expiresAt);
  const deadline = Date.parse(request.deadline);
  add("request-id", output.requestId === request.requestId, "Delivery must bind the exact PositionCrew requestId.");
  const sourceBlock = request.sources[0]?.sourceId.match(/(?:block-)(\d+)$/)?.[1] ?? null;
  add(
    "source-block-binding",
    sourceBlock !== null && request.requestId.endsWith(`-${sourceBlock}`) && output.requestId === request.requestId,
    "The exact requestId must transitively bind the block encoded in the frozen PositionCrew source.",
  );
  add("generated-after-funding", generatedAt >= fundedAt, "Delivery must be generated no earlier than the funded block timestamp.");
  add("generated-before-submission", generatedAt <= submittedAt, "Delivery must be generated no later than its on-chain submission timestamp.");
  add("submitted-by-deadline", submittedAt <= deadline, "On-chain submission must occur by the frozen request deadline.");
  add("expiry-after-submission", expiresAt > submittedAt, "Delivery expiry must be later than on-chain submission.");
  add("expiry-by-request-deadline", expiresAt <= deadline, "Delivery expiry must not exceed the frozen request deadline.");

  const refusal = output.status.startsWith("REFUSED_");
  const noAction = output.status === "NO_ACTION";
  const actionable = output.status === "ACTIONABLE";
  add(
    "status-decision",
    refusal
      ? output.decision === "NONE" && output.proposedRange === null
      : noAction
        ? output.decision === "HOLD" && output.proposedRange === null
        : !["NONE", "HOLD"].includes(output.decision),
    "Status, decision, and proposed-range semantics must agree.",
  );
  const rangeRequired = actionable && ["WIDEN", "NARROW", "SHIFT"].includes(output.decision);
  const rangeForbidden = output.decision === "EXIT" || refusal || noAction;
  add(
    "range-presence",
    rangeRequired ? output.proposedRange !== null : rangeForbidden ? output.proposedRange === null : true,
    "Range-changing decisions require a range; HOLD, NONE, EXIT, and refusals do not.",
  );
  if (output.proposedRange) {
    const width = output.proposedRange.upperTick - output.proposedRange.lowerTick;
    add("range-order", width > 0, "Proposed lower tick must be below upper tick.");
    add(
      "tick-spacing",
      output.proposedRange.lowerTick % request.constraints.tickSpacing === 0 &&
        output.proposedRange.upperTick % request.constraints.tickSpacing === 0,
      "Proposed ticks must align with the pool tick spacing.",
    );
    add(
      "range-width",
      width >= request.constraints.minimumWidthTicks && width <= request.constraints.maximumWidthTicks,
      "Proposed width must remain inside buyer constraints.",
    );
    add(
      "current-tick-in-range",
      request.marketState.currentTick >= output.proposedRange.lowerTick &&
        request.marketState.currentTick < output.proposedRange.upperTick,
      "A replacement range must contain the frozen current tick.",
    );
    const existingWidth = request.position.upperTick - request.position.lowerTick;
    add(
      "decision-width-semantics",
      output.decision === "WIDEN"
        ? width > existingWidth
        : output.decision === "NARROW"
          ? width < existingWidth
          : output.decision === "SHIFT"
            ? output.proposedRange.lowerTick !== request.position.lowerTick ||
              output.proposedRange.upperTick !== request.position.upperTick
            : true,
      "WIDEN and NARROW must change width in the stated direction; SHIFT must change at least one endpoint.",
    );
  }
  add(
    "inventory-total",
    output.inventoryExposure.token0Bps + output.inventoryExposure.token1Bps === 10_000,
    "Inventory exposure must sum to 10,000 bps.",
  );
  add(
    "inventory-caps",
    output.inventoryExposure.token0Bps <= request.constraints.maximumToken0ShareBps &&
      output.inventoryExposure.token1Bps <= request.constraints.maximumToken1ShareBps,
    "Inventory exposure must respect both buyer caps.",
  );
  add(
    "action-cost-cap",
    parseFixed(output.estimatedRebalanceCostUsd) <= parseFixed(request.maxActionUsd),
    "Estimated rebalance cost must not exceed maxActionUsd.",
  );
  add(
    "input-gas-cap",
    parseFixed(request.constraints.estimatedGasUsd) <= parseFixed(request.maxGasUsd),
    "The frozen position's gas estimate must fit maxGasUsd.",
  );
  add(
    "minimum-net-benefit",
    !actionable || output.decision === "EXIT" ||
      parseFixed(output.expectedNetBenefitUsd) >= parseFixed(request.constraints.minimumNetBenefitUsd),
    "An actionable range change must clear the buyer's minimum net benefit.",
  );

  const compatible = checks.every((check) => check.status === "PASS");
  const current = compatible && expiresAt > (input.now ?? new Date()).getTime();
  return {
    schemaVersion: "positioncrew.live-match.lp-delivery-validation.v1",
    status: compatible ? "COMPATIBLE" : "INCOMPATIBLE",
    currentState: current
      ? actionable
        ? "CURRENTLY_ACTIONABLE"
        : "CURRENTLY_NO_ACTION"
      : "HISTORICAL_OR_INVALID",
    manifestHash: manifest.manifestHash(),
    deliverable: output,
    checks,
    boundary: compatible
      ? "The funded provider delivered an attributable output that passed the exact frozen LP job contract. This proves compatibility for one snapshot, not provider superiority, payment settlement, LP execution, or investment performance."
      : "The attributable delivery failed at least one exact-job check. It is not eligible for selection or settlement and grants no LP authority.",
  };
}

export function bnbLpRangePaymentContract(): {
  agentTokenId: number;
  endpoint: string;
  provider: string;
  kernel: string;
  paymentToken: string;
  maximumPriceAtomic: string;
  allowedDeliveryOrigins: readonly string[];
} {
  return {
    agentTokenId: BNB_LP_RANGE_PROVIDER.agentTokenId,
    endpoint: BNB_LP_RANGE_PROVIDER.endpoint,
    provider: BNB_LP_RANGE_PROVIDER.registryOwner,
    kernel: BNB_LP_RANGE_PROVIDER.kernel,
    paymentToken: BNB_LP_RANGE_PROVIDER.paymentToken,
    maximumPriceAtomic: BNB_LP_RANGE_PROVIDER.maximumPriceAtomic,
    allowedDeliveryOrigins: BNB_LP_RANGE_PROVIDER.allowedDeliveryOrigins,
  };
}
