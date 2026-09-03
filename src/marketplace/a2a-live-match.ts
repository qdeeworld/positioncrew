import { z } from "zod";
import { AddressSchema, TimestampSchema } from "../contracts/common.js";
import { canonicalHash } from "../core/canonical.js";

const BRAIN_ON_BNB = {
  agentId: 302257,
  endpoint: "https://agent.brainonbnb.com/a2a",
  provider: "0x73809F69916FcF7Ddc5BB1315fBdf96A569a5963",
  kernel: "0xEa4DAa3100A767e86FDed867729ae7446476EBA6",
  paymentToken: "0xcE24439F2D9C6a2289F741120FE202248B666666",
} as const;

const RequiredHealthFactorOutputSchema = z.enum([
  "CURRENT_HEALTH_FACTOR",
  "LIQUIDATION_DISTANCE",
  "COLLATERAL_STRESS_TABLE",
  "PROTOCOL_CROSS_CHECK",
  "BLOCK_ATTRIBUTION",
]);

export const HealthFactorLiveMatchJobSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.live-match.health-factor-job.v1"),
    jobId: z.string().min(8).max(120),
    category: z.literal("HEALTH_FACTOR_MONITORING"),
    chainId: z.literal(56),
    protocol: z.literal("Venus Classic"),
    account: AddressSchema,
    requestedAt: TimestampSchema,
    deadline: TimestampSchema,
    requiredOutputs: z.array(RequiredHealthFactorOutputSchema).min(1),
    maximumPrice: z
      .object({
        amountAtomic: z.string().regex(/^\d+$/),
        token: AddressSchema,
        chainId: z.literal(56),
      })
      .strict(),
  })
  .strict()
  .superRefine((job, context) => {
    if (Date.parse(job.deadline) <= Date.parse(job.requestedAt)) {
      context.addIssue({
        code: "custom",
        path: ["deadline"],
        message: "deadline must be after requestedAt",
      });
    }
  });

export type HealthFactorLiveMatchJob = z.infer<typeof HealthFactorLiveMatchJobSchema>;

const AcceptedQuoteSchema = z
  .object({
    accepted: z.literal(true),
    provider: AddressSchema,
    price: z.string().regex(/^\d+$/),
    price_display: z.string().min(1),
    currency: z.string().min(1),
    service: z.literal("health_factor"),
    category: z.literal("health-factor-monitoring"),
    deliverables: z.string().min(1),
    needs: z.object({ address: z.string().min(1) }).strict(),
    estimated_completion_seconds: z.number().int().positive(),
    instructions: z.string().min(1),
    chain_id: z.literal(56),
    verifying_contract: AddressSchema,
    payment_token: AddressSchema,
  })
  .strict();

const RejectedQuoteSchema = z
  .object({
    accepted: z.literal(false),
    reason: z.string().min(1),
    services: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const QuoteEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: z.discriminatedUnion("accepted", [
      AcceptedQuoteSchema,
      RejectedQuoteSchema,
    ]),
  })
  .strict();

const FundedNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string().min(1),
    result: z.unknown(),
  })
  .passthrough();

const BrainHealthFactorDeliverySchema = z
  .object({
    service: z.literal("health_factor"),
    position: z
      .object({
        account: AddressSchema,
        protocol: z.string().min(1),
        chain: z.literal("eip155:56"),
        has_position: z.boolean(),
        health_factor: z.number().finite().positive(),
        liquidatable: z.boolean(),
        borrowed_usd: z.number().finite().nonnegative(),
        collateral_usd: z.number().finite().nonnegative(),
        cross_check: z
          .object({
            venus_headroom_usd: z.number().finite(),
            our_headroom_usd: z.number().finite(),
            difference_usd: z.number().finite(),
            agrees: z.boolean(),
            venus_error_code: z.number().int(),
          })
          .passthrough(),
        measured_at: TimestampSchema,
        block_number: z.number().int().positive().optional(),
        observed_block: z.number().int().positive().optional(),
      })
      .passthrough(),
    drawdown: z
      .object({
        tolerable_collateral_drop_pct: z.number().finite().nonnegative(),
        stress: z
          .array(
            z
              .object({
                collateral_drop_pct: z.number().finite().positive(),
                health_factor: z.number().finite().positive(),
                liquidatable: z.boolean(),
              })
              .strict(),
          )
          .min(3),
      })
      .passthrough(),
  })
  .passthrough();

export const BrainPrepaymentCapabilityProofSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.live-match.prepayment-capability-proof.v1"),
    providerAgentId: z.literal(302257),
    adapterId: z.literal("positioncrew:a2a:brain-on-bnb:health-factor:v1"),
    frozenJobHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    responseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    providerNativeUrl: z.string().url(),
    financialValueAtomic: z.literal("0"),
    issuedAt: TimestampSchema,
    completedAt: TimestampSchema,
  })
  .strict();

export type BrainPrepaymentCapabilityProof = z.infer<
  typeof BrainPrepaymentCapabilityProofSchema
>;

export interface ExternalQuoteTrace {
  schemaVersion: "positioncrew.live-match.adapter-trace.v1";
  adapterId: "positioncrew:a2a:brain-on-bnb:health-factor:v1";
  providerAgentId: 302257;
  endpoint: string;
  frozenJob: HealthFactorLiveMatchJob;
  frozenJobHash: string;
  nativeRequest: Record<string, unknown>;
  nativeRequestHash: string;
  startedAt: string;
  completedAt: string;
  durationMilliseconds: number;
  quote: z.infer<typeof AcceptedQuoteSchema>;
  states: {
    identity: "REGISTRY_OBSERVED_NOT_REVERIFIED_IN_SPIKE";
    liveness: "A2A_RESPONDED";
    compatibility: "DECLARED_ONLY_RESULT_VALIDATION_PENDING";
    activation: "QUOTE_ACCEPTED_FUNDING_NOT_PERFORMED";
    selection: "NOT_ELIGIBLE_YET";
  };
  boundary: string;
}

function buildDeliverables(job: HealthFactorLiveMatchJob): string {
  const required = job.requiredOutputs.join(", ");
  return [
    `Measure the Venus health factor and liquidation distance for BSC account ${job.account}.`,
    "Include a collateral stress table and cross-check the result against Venus getAccountLiquidity.",
    `Attribute the result to the observed BSC block. Required normalized outputs: ${required}.`,
    `The result must be produced before ${job.deadline}.`,
  ].join(" ");
}

export function buildBrainHealthFactorQuoteRequest(
  input: HealthFactorLiveMatchJob,
): Record<string, unknown> {
  const job = HealthFactorLiveMatchJobSchema.parse(input);
  return {
    jsonrpc: "2.0",
    id: job.jobId,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId: job.jobId,
        parts: [
          {
            kind: "data",
            data: {
              skill: "negotiate",
              terms: {
                deliverables: buildDeliverables(job),
              },
            },
          },
        ],
      },
    },
  };
}

async function readBoundedJson(response: Response, maximumBytes = 64 * 1024): Promise<unknown> {
  if (!response.body) {
    throw new Error("External A2A response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel("response exceeds PositionCrew limit");
      throw new Error(`External A2A response exceeds ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export async function requestBrainHealthFactorQuote(
  input: HealthFactorLiveMatchJob,
  fetchImplementation: typeof fetch = fetch,
): Promise<ExternalQuoteTrace> {
  const frozenJob = HealthFactorLiveMatchJobSchema.parse(input);
  const nativeRequest = buildBrainHealthFactorQuoteRequest(frozenJob);
  const startedAt = new Date();
  const startedClock = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("external A2A timeout"), 12_000);
  let response: Response;
  try {
    response = await fetchImplementation(BRAIN_ON_BNB.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(nativeRequest),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`External A2A quote failed with HTTP ${response.status}`);
  }
  const envelope = QuoteEnvelopeSchema.parse(await readBoundedJson(response));
  if (!envelope.result.accepted) {
    throw new Error(`External provider rejected the frozen job: ${envelope.result.reason}`);
  }
  const quote = envelope.result;
  if (
    !sameAddress(quote.provider, BRAIN_ON_BNB.provider) ||
    !sameAddress(quote.verifying_contract, BRAIN_ON_BNB.kernel) ||
    !sameAddress(quote.payment_token, frozenJob.maximumPrice.token)
  ) {
    throw new Error("External quote identity, kernel, or payment token does not match the frozen adapter contract");
  }
  if (BigInt(quote.price) > BigInt(frozenJob.maximumPrice.amountAtomic)) {
    throw new Error("External quote exceeds the frozen maximum price");
  }
  const completedAt = new Date();
  return {
    schemaVersion: "positioncrew.live-match.adapter-trace.v1",
    adapterId: "positioncrew:a2a:brain-on-bnb:health-factor:v1",
    providerAgentId: BRAIN_ON_BNB.agentId,
    endpoint: BRAIN_ON_BNB.endpoint,
    frozenJob,
    frozenJobHash: canonicalHash(frozenJob),
    nativeRequest,
    nativeRequestHash: canonicalHash(nativeRequest),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMilliseconds: Math.round(performance.now() - startedClock),
    quote,
    states: {
      identity: "REGISTRY_OBSERVED_NOT_REVERIFIED_IN_SPIKE",
      liveness: "A2A_RESPONDED",
      compatibility: "DECLARED_ONLY_RESULT_VALIDATION_PENDING",
      activation: "QUOTE_ACCEPTED_FUNDING_NOT_PERFORMED",
      selection: "NOT_ELIGIBLE_YET",
    },
    boundary:
      "This trace proves a bounded provider-native quote only. No job was funded, no useful provider result was delivered, no output compatibility was validated, no provider was selected, and no BSC state changed.",
  };
}

export function brainOnBnbPaymentContract(): {
  provider: string;
  kernel: string;
  paymentToken: string;
} {
  return {
    provider: BRAIN_ON_BNB.provider,
    kernel: BRAIN_ON_BNB.kernel,
    paymentToken: BRAIN_ON_BNB.paymentToken,
  };
}

export function validateBrainHealthFactorDelivery(
  input: HealthFactorLiveMatchJob,
  deliveryInput: unknown,
  authoritativeSubmittedAt?: string,
): {
  status: "COMPATIBLE" | "INCOMPATIBLE";
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  parsedDelivery: z.infer<typeof BrainHealthFactorDeliverySchema> | null;
  boundary: string;
} {
  const job = HealthFactorLiveMatchJobSchema.parse(input);
  const parsed = BrainHealthFactorDeliverySchema.safeParse(deliveryInput);
  if (!parsed.success) {
    return {
      status: "INCOMPATIBLE",
      checks: [{ id: "OUTPUT_SCHEMA", passed: false, detail: z.prettifyError(parsed.error) }],
      parsedDelivery: null,
      boundary: "The external result did not satisfy the provider-specific output schema. No normalized PositionCrew result was created.",
    };
  }
  const delivery = parsed.data;
  const stress = delivery.drawdown.stress;
  const measuredAt = Date.parse(delivery.position.measured_at);
  const submittedAt = authoritativeSubmittedAt ? Date.parse(authoritativeSubmittedAt) : null;
  const normalizedProtocol = delivery.position.protocol.trim().toLowerCase();
  const protocolMatches = normalizedProtocol === "venus" ||
    normalizedProtocol === "venus classic" ||
    normalizedProtocol === "venus protocol";
  const monotonicStress = stress.every((row, index) => index === 0 || row.collateral_drop_pct > stress[index - 1]!.collateral_drop_pct)
    && stress.every((row, index) => index === 0 || row.health_factor <= stress[index - 1]!.health_factor);
  const observedBlock = delivery.position.block_number ?? delivery.position.observed_block;
  const checks = [
    { id: "OUTPUT_SCHEMA", passed: true, detail: "Provider result parses under the frozen Brain health-factor adapter schema." },
    { id: "ACCOUNT_BINDING", passed: delivery.position.account.toLowerCase() === job.account.toLowerCase(), detail: `Expected ${job.account}; received ${delivery.position.account}.` },
    { id: "CHAIN_BINDING", passed: delivery.position.chain === "eip155:56", detail: `Received ${delivery.position.chain}.` },
    { id: "PROTOCOL_BINDING", passed: protocolMatches, detail: `Expected Venus Classic; received ${delivery.position.protocol}.` },
    { id: "CURRENT_HEALTH_FACTOR", passed: Number.isFinite(delivery.position.health_factor), detail: `Received ${delivery.position.health_factor}.` },
    { id: "LIQUIDATION_DISTANCE", passed: Number.isFinite(delivery.drawdown.tolerable_collateral_drop_pct), detail: `Received ${delivery.drawdown.tolerable_collateral_drop_pct}%.` },
    { id: "COLLATERAL_STRESS_TABLE", passed: monotonicStress, detail: monotonicStress ? `${stress.length} monotonic stress rows received.` : "Stress rows are not strictly increasing in drawdown with non-increasing health factor." },
    { id: "PROTOCOL_CROSS_CHECK", passed: delivery.position.cross_check.agrees && delivery.position.cross_check.venus_error_code === 0, detail: `agrees=${delivery.position.cross_check.agrees}; differenceUsd=${delivery.position.cross_check.difference_usd}; venusErrorCode=${delivery.position.cross_check.venus_error_code}.` },
    { id: "BLOCK_ATTRIBUTION", passed: observedBlock !== undefined, detail: observedBlock === undefined ? "No BSC block number was returned." : `Observed at BSC block ${observedBlock}.` },
    { id: "DELIVERY_WINDOW", passed: measuredAt >= Date.parse(job.requestedAt) && measuredAt <= Date.parse(job.deadline), detail: `Measured at ${delivery.position.measured_at}; required window ${job.requestedAt} through ${job.deadline}.` },
    { id: "SUBMISSION_CAUSALITY", passed: submittedAt === null || Math.floor(measuredAt / 1_000) <= Math.floor(submittedAt / 1_000), detail: submittedAt === null ? "No authoritative submission timestamp was supplied for this prepayment check." : `Measured at ${delivery.position.measured_at}; submitted onchain at ${authoritativeSubmittedAt} (second precision).` },
  ];
  const compatible = checks.every((check) => check.passed);
  return {
    status: compatible ? "COMPATIBLE" : "INCOMPATIBLE",
    checks,
    parsedDelivery: delivery,
    boundary: compatible
      ? "The provider-specific result passed every frozen health-factor compatibility check. This does not rank provider performance or authorize a financial action."
      : "At least one frozen compatibility check failed. No normalized PositionCrew result, provider eligibility, selection, or ranking was created.",
  };
}

export async function verifyBrainPrepaymentCapabilityProof(
  input: HealthFactorLiveMatchJob,
  proofInput: unknown,
  fetchImplementation: typeof fetch = fetch,
): Promise<{
  proof: BrainPrepaymentCapabilityProof;
  delivery: z.infer<typeof BrainHealthFactorDeliverySchema>;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}> {
  const job = HealthFactorLiveMatchJobSchema.parse(input);
  const proof = BrainPrepaymentCapabilityProofSchema.parse(proofInput);
  if (proof.frozenJobHash !== canonicalHash(job)) {
    throw new Error("Prepayment capability proof does not bind the exact frozen job");
  }
  const providerOrigin = new URL(BRAIN_ON_BNB.endpoint).origin;
  const proofUrl = new URL(proof.providerNativeUrl);
  if (
    proofUrl.protocol !== "https:" ||
    proofUrl.origin !== providerOrigin ||
    !proofUrl.pathname.startsWith("/a2a/capability-proofs/")
  ) {
    throw new Error("Prepayment capability proof is not hosted on the provider's frozen proof path");
  }
  const issuedAt = Date.parse(proof.issuedAt);
  const completedAt = Date.parse(proof.completedAt);
  if (
    issuedAt < Date.parse(job.requestedAt) ||
    completedAt < issuedAt ||
    completedAt > Date.parse(job.deadline)
  ) {
    throw new Error("Prepayment capability proof was not completed inside the frozen job window");
  }
  const response = await fetchImplementation(proof.providerNativeUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Provider-native capability proof failed with HTTP ${response.status}`);
  }
  const deliveryInput = await readBoundedJson(response);
  if (canonicalHash(deliveryInput) !== proof.responseHash) {
    throw new Error("Provider-native capability response does not match its frozen hash");
  }
  const validation = validateBrainHealthFactorDelivery(job, deliveryInput);
  if (validation.status !== "COMPATIBLE" || validation.parsedDelivery === null) {
    const failed = validation.checks
      .filter((check) => !check.passed)
      .map((check) => check.id)
      .join(", ");
    throw new Error(`Prepayment capability response is incompatible: ${failed || "unknown validation failure"}`);
  }
  return {
    proof,
    delivery: validation.parsedDelivery,
    checks: validation.checks,
  };
}

export async function notifyBrainHealthFactorFunded(
  input: {
    messageId: string;
    commerceJobId: bigint;
    account: string;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const account = AddressSchema.parse(input.account);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("external A2A timeout"), 12_000);
  let response: Response;
  try {
    response = await fetchImplementation(BRAIN_ON_BNB.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: input.messageId,
        method: "message/send",
        params: {
          message: {
            role: "user",
            messageId: input.messageId,
            parts: [
              {
                kind: "data",
                data: {
                  skill: "notify_funded",
                  job_id: input.commerceJobId.toString(),
                  address: account,
                },
              },
            ],
          },
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`External funded-job notification failed with HTTP ${response.status}`);
  }
  return FundedNotificationEnvelopeSchema.parse(await readBoundedJson(response));
}
