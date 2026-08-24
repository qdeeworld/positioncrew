import { z } from "zod";
import snapshotArtifact from "../../evidence/external-comparison-candidates.mainnet.json" with { type: "json" };
import { canonicalHash } from "../core/canonical.js";

const ServiceSchema = z.enum([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);
const HttpUrlSchema = z.string().url().refine((value) => value.startsWith("https://"));
const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ExternalComparisonCandidateSchema = z.object({
  agentTokenId: z.string().regex(/^[1-9][0-9]*$/),
  name: z.string().min(1),
  relationship: z.literal("THIRD_PARTY_COMPARISON_ONLY"),
  verdict: z.enum(["PASS_FOR_COMPARISON_ONLY", "LISTED_ONLY"]),
  identity: z.object({
    protocol: z.literal("ERC-8004"),
    chainId: z.literal(56),
    registry: AddressSchema,
    owner: AddressSchema,
    verification: z.enum(["DIRECT_OWNER_OF", "REGISTRY_INDEXER_RECORD"]),
    checkedAt: z.string().datetime(),
    blockNumber: z.string().regex(/^[1-9][0-9]*$/),
    sourceUrl: HttpUrlSchema,
    explorerUrl: HttpUrlSchema,
  }).strict(),
  category: z.object({
    service: ServiceSchema,
    label: z.string().min(1),
    mappingBasis: z.literal("PUBLIC_NAME_AND_METADATA"),
    sourceUrl: HttpUrlSchema,
  }).strict(),
  serviceReachability: z.object({
    status: z.enum(["REACHABLE", "LISTED_ONLY"]),
    checkedAt: z.string().datetime(),
    endpointUrl: HttpUrlSchema.nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    sourceUrl: HttpUrlSchema,
  }).strict(),
  pricing: z.object({
    mode: z.enum(["QUOTE_REQUIRED", "NOT_PUBLISHED", "UNVERIFIED_MARKETPLACE_ASSERTION"]),
    amount: z.null(),
    token: z.null(),
    chainId: z.null(),
    sourceUrl: HttpUrlSchema,
  }).strict(),
  feedback: z.object({
    recordCount: z.number().int().min(0),
    aggregateScore: z.null(),
    sourceUrl: HttpUrlSchema,
  }).strict(),
  validation: z.object({
    recordCount: z.number().int().min(0),
    successfulCount: z.number().int().min(0),
    summary: z.null(),
    sourceUrl: HttpUrlSchema,
  }).strict(),
  positionCrewCertified: z.literal(false),
  positionCrewActivation: z.literal("NOT_SUPPORTED"),
  claimBoundary: z.array(z.string().min(1)).min(1),
}).strict();

export const ExternalComparisonSnapshotSchema = z.object({
  schemaVersion: z.literal("positioncrew.external-comparison-snapshot.v1"),
  snapshotId: z.literal("bsc-mainnet-2026-08-24"),
  checkedAt: z.string().datetime(),
  chain: z.object({
    name: z.literal("BNB Smart Chain"),
    chainId: z.literal(56),
    blockNumber: z.string().regex(/^[1-9][0-9]*$/),
    registry: AddressSchema,
  }).strict(),
  selectedAgentTokenIds: z.tuple([
    z.literal("269228"),
    z.literal("265375"),
    z.literal("265876"),
    z.literal("267697"),
  ]),
  candidates: z.array(ExternalComparisonCandidateSchema).length(4),
  claimBoundary: z.array(z.string().min(1)).min(1),
  snapshotHash: HashSchema,
}).strict();

export type ExternalComparisonSnapshot = z.infer<typeof ExternalComparisonSnapshotSchema>;

export const EXTERNAL_COMPARISON_SNAPSHOT_ROUTE =
  "/api/evidence/external-comparisons/2026-08-24" as const;

const parsed = ExternalComparisonSnapshotSchema.parse(snapshotArtifact);
const { snapshotHash, ...hashPayload } = parsed;
if (canonicalHash(hashPayload) !== snapshotHash) {
  throw new Error("External comparison snapshot hash mismatch");
}

const expectedServices = [
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
] as const;
if (parsed.candidates.some((candidate, index) => candidate.category.service !== expectedServices[index])) {
  throw new Error("External comparison category order changed");
}
if (new Set(parsed.candidates.map((candidate) => candidate.identity.owner.toLowerCase())).size !== 4) {
  throw new Error("External comparison candidates must have distinct owner wallets");
}
if (parsed.candidates.some((candidate) =>
  candidate.identity.owner.toLowerCase() === "0xadd748c416e8a7efd7d65d18abb121dea268ddf9"
)) {
  throw new Error("External comparison candidate uses the PositionCrew flagship owner");
}

export const EXTERNAL_COMPARISON_SNAPSHOT: ExternalComparisonSnapshot = Object.freeze(parsed);
