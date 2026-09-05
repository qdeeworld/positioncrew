import { z } from "zod";
import { HashSchema, TimestampSchema } from "../contracts/common.js";

export const LpLiveMatchProviderKeySchema = z.enum(["POSITIONCREW", "HEYANON"]);

export const LpLiveMatchCheckSchema = z.object({
  code: z.string().min(1).max(120),
  status: z.enum(["PASS", "FAIL"]),
  detail: z.string().min(1).max(500),
}).strict();

export const LpLiveMatchIdentitySchema = z.object({
  protocol: z.literal("ERC-8004"),
  network: z.enum(["BSC_MAINNET", "BSC_TESTNET"]),
  chainId: z.union([z.literal(56), z.literal(97)]),
  agentId: z.string().regex(/^[1-9]\d*$/),
  owner: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
}).strict();

export const LpLiveMatchCandidateSchema = z.object({
  providerKey: LpLiveMatchProviderKeySchema,
  providerId: z.string().min(3).max(160),
  name: z.string().min(1).max(120),
  identity: LpLiveMatchIdentitySchema,
  endpoint: z.string().url(),
  adapterId: z.string().min(3).max(160),
  status: z.enum(["COMPATIBLE", "INCOMPATIBLE", "UNAVAILABLE"]),
  selectable: z.boolean(),
  rawResponseHash: HashSchema.nullable(),
  normalizedResponseHash: HashSchema.nullable(),
  // Optional for immutable pre-upgrade auditions; never default or rewrite them.
  materialTermsHash: HashSchema.optional(),
  latencyMilliseconds: z.number().int().positive(),
  checks: z.array(LpLiveMatchCheckSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.selectable !== (value.status === "COMPATIBLE")) {
    context.addIssue({
      code: "custom",
      path: ["selectable"],
      message: "Only a fully compatible LP candidate may be selectable",
    });
  }
  if (value.selectable && (value.rawResponseHash === null || value.normalizedResponseHash === null)) {
    context.addIssue({
      code: "custom",
      path: ["rawResponseHash"],
      message: "A selectable LP candidate requires raw and normalized response commitments",
    });
  }
});

export const LpLiveMatchAuditionSchema = z.object({
  schemaVersion: z.literal("positioncrew.lp-live-match-audition.v1"),
  requestHash: HashSchema,
  source: z.object({
    blockNumber: z.string().regex(/^[1-9]\d*$/),
    observedAt: TimestampSchema,
    explorerUrl: z.string().url(),
  }).strict(),
  auditionedAt: TimestampSchema,
  candidates: z.array(LpLiveMatchCandidateSchema).length(2),
  claimBoundary: z.tuple([
    z.string().min(10),
    z.string().min(10),
    z.string().min(10),
  ]),
}).strict().superRefine((value, context) => {
  const keys = value.candidates.map((candidate) => candidate.providerKey);
  if (new Set(keys).size !== 2 || !keys.includes("POSITIONCREW") || !keys.includes("HEYANON")) {
    context.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "LP Live Match requires exactly one PositionCrew and one HeyAnon candidate",
    });
  }
});

export const LpLiveMatchRunRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.lp-live-match-selection-request.v1"),
  selectedProvider: LpLiveMatchProviderKeySchema,
  auditionHash: HashSchema,
}).strict();

export const LpLiveMatchProviderSelectionSchema = z.object({
  schemaVersion: z.literal("positioncrew.lp-live-match-provider-selection.v1"),
  selectedProvider: LpLiveMatchProviderKeySchema,
  providerId: z.string().min(3).max(160),
  providerName: z.string().min(1).max(120),
  identity: LpLiveMatchIdentitySchema,
  endpoint: z.string().url(),
  adapterId: z.string().min(3).max(160),
  auditionHash: HashSchema,
  selectedAt: TimestampSchema,
}).strict();

export const LpLiveMatchExecutionSchema = z.object({
  schemaVersion: z.literal("positioncrew.lp-live-match-execution.v1"),
  source: z.object({
    hireId: z.string().uuid(),
    jobId: z.string().uuid(),
    requestHash: HashSchema,
    evidenceHash: HashSchema,
    blockNumber: z.string().regex(/^[1-9]\d*$/),
    observedAt: TimestampSchema,
    explorerUrl: z.string().url(),
  }).strict(),
  selection: LpLiveMatchProviderSelectionSchema,
  invocation: z.object({
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    latencyMilliseconds: z.number().int().positive(),
    endpoint: z.string().url(),
    rawResponseHash: HashSchema.nullable(),
    normalizedResponseHash: HashSchema,
    checks: z.array(LpLiveMatchCheckSchema).min(1),
  }).strict(),
  outcome: z.enum(["DELIVERED", "REFUSED"]),
  commerce: z.object({
    directCostUsd: z.literal("0.00"),
    walletRequired: z.literal(false),
    payment: z.literal("NONE"),
    settlement: z.literal("NONE"),
  }).strict(),
  claimBoundary: z.tuple([
    z.string().min(10),
    z.string().min(10),
    z.string().min(10),
  ]),
}).strict();

export type LpLiveMatchAudition = z.infer<typeof LpLiveMatchAuditionSchema>;
export type LpLiveMatchCandidate = z.infer<typeof LpLiveMatchCandidateSchema>;
export type LpLiveMatchRunRequest = z.infer<typeof LpLiveMatchRunRequestSchema>;
export type LpLiveMatchProviderSelection = z.infer<typeof LpLiveMatchProviderSelectionSchema>;
export type LpLiveMatchExecution = z.infer<typeof LpLiveMatchExecutionSchema>;
