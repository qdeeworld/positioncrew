import { z } from "zod";
import { PositionCrewRequestSchema, type PositionCrewRequest } from "../contracts/index.js";
import { canonicalHash, canonicalJson } from "../core/canonical.js";

const SourceSchema = z.object({
  blockNumber: z.string().regex(/^[1-9]\d*$/),
  observedAt: z.string().datetime({ offset: true }),
  explorerUrl: z.string().url(),
}).strict();

export const ServerObservationBindingSchema = z.object({
  schemaVersion: z.literal("positioncrew.server-observation-binding.v1"),
  snapshotId: z.string().min(8).max(120),
  service: z.enum(["LENDING_RESCUE", "LP_REBALANCE", "YIELD_OPTIMIZATION", "BOUNDED_GRID"]),
  chainId: z.literal(56),
  account: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  observation: SourceSchema,
  immutableRequestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  requestDeadline: z.string().datetime({ offset: true }),
  maxDataAgeSeconds: z.number().int().positive().max(3_600),
  maximumSlippageBps: z.number().int().min(0).max(10_000),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ServerObservationBinding = z.infer<typeof ServerObservationBindingSchema>;
type Source = z.infer<typeof SourceSchema>;

export class SourceObservationBindingError extends Error {
  readonly code = "REFRESH_REQUIRED";
  constructor(message = "Reload the market or position to obtain a current server-bound observation before creating or running this hire.") {
    super(message);
    this.name = "SourceObservationBindingError";
  }
}

const COMMON_POLICY_FIELDS = ["maxActionUsd", "maxGasUsd", "maxSlippageBps", "deadline", "maxDataAgeSeconds"];
const POLICY_FIELDS: Record<PositionCrewRequest["service"], readonly string[]> = {
  LENDING_RESCUE: ["allowedActions", "targetHealthFactor", "stressPriceDropBps", "oracleDeviationToleranceBps"],
  LP_REBALANCE: ["minimumWidthTicks", "maximumWidthTicks", "edgeBufferBps", "highVolatilityBps", "maximumToken0ShareBps", "maximumToken1ShareBps", "minimumNetBenefitUsd", "evaluationHorizonHours"],
  YIELD_OPTIMIZATION: ["protocolAllowlist", "maximumRiskTier", "maximumProtocolConcentrationBps", "maximumLockupSeconds", "minimumLiquidityUsd", "minimumNetBenefitUsd", "evaluationHorizonDays"],
  BOUNDED_GRID: ["capitalUsd", "lowerPrice", "upperPrice", "levelCount", "maximumInventoryUsd", "maximumLossUsd", "minimumExpectedNetProfitUsd", "minimumLiquidityUsd", "maximumVolatilityBps", "expectedCompletedCycles", "orderExpirySeconds"],
};

// Remove only documented buyer policy. New financial fields are bound by default.
// In particular: all assets/capacities, observed costs, and LP tick spacing remain.
function immutableProjection(request: PositionCrewRequest): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(request);
  for (const field of COMMON_POLICY_FIELDS) delete result[field];
  if (request.service === "LENDING_RESCUE") {
    for (const field of POLICY_FIELDS.LENDING_RESCUE) delete result[field];
  } else {
    const constraints: Record<string, unknown> = { ...request.constraints };
    for (const field of POLICY_FIELDS[request.service]) delete constraints[field];
    result.constraints = constraints;
    if (request.service === "YIELD_OPTIMIZATION") delete result.capitalUsd;
  }
  return result;
}

async function signingKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32 || secret.length > 512 || !secret.trim()) {
    throw new SourceObservationBindingError("Server observation binding is unavailable. Refresh after the service is configured.");
  }
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function parseRequest(input: unknown): PositionCrewRequest {
  const parsed = PositionCrewRequestSchema.safeParse(input);
  if (!parsed.success) throw new SourceObservationBindingError();
  return parsed.data;
}

function checkSource(request: PositionCrewRequest, input: Source, now: Date): Source {
  const parsed = SourceSchema.safeParse(input);
  if (!parsed.success) throw new SourceObservationBindingError();
  const source = parsed.data;
  const observed = Date.parse(source.observedAt);
  const clock = now.getTime();
  const requestSource = request.sources[0];
  if (!Number.isFinite(clock) || request.chainId !== 56 || request.sources.length !== 1 ||
      source.explorerUrl !== `https://bscscan.com/block/${source.blockNumber}` ||
      requestSource?.uri !== source.explorerUrl || requestSource.observedAt !== source.observedAt ||
      observed > clock || Date.parse(request.requestedAt) > clock) {
    throw new SourceObservationBindingError();
  }
  if (clock >= Math.min(Date.parse(request.deadline), observed + request.maxDataAgeSeconds * 1_000)) {
    throw new SourceObservationBindingError("This server observation has expired. Reload the market or position before continuing.");
  }
  return source;
}

/** Call only with a request freshly constructed by the server's chain probe. */
export async function issueServerObservationBinding(
  input: unknown,
  observation: Source,
  secret: string | undefined,
  now: Date,
): Promise<ServerObservationBinding> {
  const key = await signingKey(secret);
  const request = parseRequest(input);
  const source = checkSource(request, observation, now);
  const claims = {
    schemaVersion: "positioncrew.server-observation-binding.v1" as const,
    snapshotId: request.requestId,
    service: request.service,
    chainId: 56 as const,
    account: request.account,
    observation: source,
    immutableRequestHash: canonicalHash(immutableProjection(request)),
    issuedAt: now.toISOString(),
    expiresAt: new Date(Math.min(Date.parse(request.deadline), Date.parse(source.observedAt) + request.maxDataAgeSeconds * 1_000)).toISOString(),
    requestDeadline: request.deadline,
    maxDataAgeSeconds: request.maxDataAgeSeconds,
    maximumSlippageBps: request.maxSlippageBps,
  };
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(claims))));
  return ServerObservationBindingSchema.parse({ ...claims, signature: Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("") });
}

/** Authenticate supplied state, then apply the buyer's stricter validity limits. */
export async function verifyServerObservationBinding(
  input: unknown,
  observation: Source & { binding?: unknown },
  secret: string | undefined,
  now: Date,
): Promise<ServerObservationBinding> {
  const key = await signingKey(secret);
  const parsed = ServerObservationBindingSchema.safeParse(observation.binding);
  if (!parsed.success) throw new SourceObservationBindingError();
  const binding = parsed.data;
  const { signature, ...claims } = binding;
  const signatureBytes = Uint8Array.from(signature.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
  const authentic = await crypto.subtle.verify("HMAC", key, signatureBytes, new TextEncoder().encode(canonicalJson(claims)));
  if (!authentic) throw new SourceObservationBindingError("The server observation binding could not be verified. Reload the market or position.");
  const request = parseRequest(input);
  const source = checkSource(request, {
    blockNumber: observation.blockNumber,
    observedAt: observation.observedAt,
    explorerUrl: observation.explorerUrl,
  }, now);
  if (now.getTime() < Date.parse(binding.issuedAt) || now.getTime() >= Date.parse(binding.expiresAt) ||
      request.requestId !== binding.snapshotId || request.service !== binding.service ||
      request.chainId !== binding.chainId || request.account !== binding.account ||
      canonicalJson(source) !== canonicalJson(binding.observation) ||
      canonicalHash(immutableProjection(request)) !== binding.immutableRequestHash ||
      Date.parse(request.deadline) > Date.parse(binding.requestDeadline) ||
      request.maxDataAgeSeconds > binding.maxDataAgeSeconds ||
      (request.service === "LP_REBALANCE" && request.maxSlippageBps > binding.maximumSlippageBps)) {
    throw new SourceObservationBindingError("The request changed authenticated observations or exceeded their validity limits. Reload the market or position.");
  }
  return binding;
}
