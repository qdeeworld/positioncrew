import { z } from "zod";
import dedicatedLendingIdentityArtifact from "../../evidence/termix-dedicated-lending.mainnet.json" with { type: "json" };
import {
  AddressSchema,
  HashSchema,
  TimestampSchema,
} from "../contracts/common.js";
import {
  LendingRescueRequestSchema,
  type LendingRescueRequest,
} from "../contracts/lending-rescue.js";
import { PROVIDER_CATALOG } from "./catalog.js";
import { EXTERNAL_COMPARISON_SNAPSHOT } from "./external-comparisons.js";

function normalizeCommitmentValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Audition commitments reject non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCommitmentValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) output[key] = normalizeCommitmentValue(entry);
    }
    return output;
  }
  throw new Error(`Unsupported audition commitment value type: ${typeof value}`);
}

async function auditionCommitment(value: unknown): Promise<string> {
  const canonical = JSON.stringify(normalizeCommitmentValue(value));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return "sha256:" + Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

const DedicatedLendingIdentitySchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-dedicated-lending.v1"),
  network: z.literal("bsc-mainnet"),
  chainId: z.literal(56),
  identityRegistry: AddressSchema,
  service: z.literal("LENDING_RESCUE"),
  role: z.literal("DEDICATED_FLAGSHIP_RUNTIME"),
  owner: AddressSchema,
  agentTokenId: z.string().regex(/^[1-9]\d*$/),
  registrationTransaction: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  listingUrl: z.string().url(),
}).passthrough();

const LendingAuditionObservationSchema = z.object({
  blockNumber: z.string().regex(/^[1-9]\d*$/),
  observedAt: TimestampSchema,
  explorerUrl: z.string().url(),
}).strict();

export const LendingProviderAuditionCheckSchema = z.object({
  code: z.enum([
    "EXACT_SERVICE_MATCH",
    "REQUEST_CONTRACT_SUPPORTED",
    "POSITIONCREW_ACTIVATION_SUPPORTED",
    "EXECUTION_ADAPTER_AVAILABLE",
    "OUTPUT_VALIDATOR_AVAILABLE",
  ]),
  status: z.enum(["PASS", "FAIL"]),
  detail: z.string().min(1).max(280),
}).strict();

export const LendingProviderAuditionCandidateSchema = z.object({
  candidateId: z.string().min(1),
  name: z.string().min(1),
  relationship: z.enum(["FIRST_PARTY", "THIRD_PARTY_COMPARISON_ONLY"]),
  identity: z.object({
    protocol: z.literal("ERC-8004"),
    chainId: z.literal(56),
    registry: AddressSchema,
    agentTokenId: z.string().regex(/^[1-9]\d*$/),
    owner: AddressSchema,
    explorerUrl: z.string().url(),
    listingUrl: z.string().url().nullable(),
  }).strict(),
  executionAdapter: z.object({
    mode: z.enum(["POSITIONCREW_IN_PROCESS", "NONE"]),
    callable: z.boolean(),
    publicEndpoint: z.string().startsWith("/").nullable(),
    externalProviderInvoked: z.literal(false),
  }).strict(),
  eligibility: z.enum(["ELIGIBLE", "INELIGIBLE"]),
  executionState: z.enum(["SELECTED_PENDING_RUN", "INELIGIBLE_NOT_INVOKED"]),
  checks: z.array(LendingProviderAuditionCheckSchema).min(1),
}).strict().superRefine((value, context) => {
  const failed = value.checks.some((check) => check.status === "FAIL");
  if (value.eligibility === "ELIGIBLE" && (failed || !value.executionAdapter.callable)) {
    context.addIssue({
      code: "custom",
      path: ["eligibility"],
      message: "Eligible candidates require a callable adapter and no failed checks",
    });
  }
  if (value.eligibility === "INELIGIBLE" && !failed) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "Ineligible candidates require at least one explicit failed check",
    });
  }
  if (
    value.executionState === "INELIGIBLE_NOT_INVOKED" &&
    (value.eligibility !== "INELIGIBLE" || value.executionAdapter.externalProviderInvoked)
  ) {
    context.addIssue({
      code: "custom",
      path: ["executionState"],
      message: "An ineligible candidate must remain uninvoked",
    });
  }
});

const LendingProviderAuditionBaseSchema = z.object({
  schemaVersion: z.literal("positioncrew.lending-provider-audition.v1"),
  policyVersion: z.literal("positioncrew.lending-provider-eligibility.v1"),
  service: z.literal("LENDING_RESCUE"),
  requestHash: HashSchema,
  observation: LendingAuditionObservationSchema,
  evaluatedAt: TimestampSchema,
  candidates: z.array(LendingProviderAuditionCandidateSchema).length(2),
  selection: z.object({
    winnerCandidateId: z.string().min(1),
    winnerProviderId: z.string().min(1),
    winnerProviderSlug: z.literal("lending-rescue"),
    eligibleCandidateCount: z.literal(1),
    basis: z.literal("SOLE_ELIGIBLE_CANDIDATE"),
  }).strict(),
  claimBoundary: z.array(z.string().min(1)).length(4),
}).strict();

export const LendingProviderAuditionSchema = LendingProviderAuditionBaseSchema.extend({
  auditionHash: HashSchema,
}).strict().superRefine((value, context) => {
  const eligible = value.candidates.filter((candidate) => candidate.eligibility === "ELIGIBLE");
  const selected = value.candidates.find(
    (candidate) => candidate.candidateId === value.selection.winnerCandidateId,
  );
  if (
    eligible.length !== 1 ||
    !selected ||
    selected.eligibility !== "ELIGIBLE" ||
    selected.executionState !== "SELECTED_PENDING_RUN" ||
    selected.candidateId !== value.selection.winnerProviderId
  ) {
    context.addIssue({
      code: "custom",
      path: ["selection"],
      message: "The selected provider must be the sole eligible candidate",
    });
  }
});

export type LendingProviderAudition = z.infer<typeof LendingProviderAuditionSchema>;
export type LendingProviderAuditionCandidate = z.infer<
  typeof LendingProviderAuditionCandidateSchema
>;

export async function verifyLendingProviderAuditionCommitment(
  input: LendingProviderAudition,
): Promise<boolean> {
  const { auditionHash, ...payload } = input;
  return await auditionCommitment(payload) === auditionHash;
}

export const LENDING_PROVIDER_AUDITION_CLAIM_BOUNDARY = [
  "ERC-8004 mainnet identity evidence is recorded separately from the adapter that executes this job.",
  "The third-party comparison candidate is not invoked because PositionCrew has no supported exact-request adapter for it.",
  "Selection proves sole eligibility under this policy; it is not a quality ranking or performance comparison.",
  "This creates no payment, TermiX order, external-provider execution, settlement, signature, custody, or protocol transaction.",
] as const;

export class NoEligibleLendingProviderError extends Error {
  readonly code = "NO_ELIGIBLE_PROVIDER";
  readonly domain = "positioncrew.lending-provider-audition";

  constructor() {
    super("No Lending provider has a callable exact-request adapter and output validator");
    this.name = "NoEligibleLendingProviderError";
  }
}

export function isNoEligibleLendingProviderError(
  error: unknown,
): error is NoEligibleLendingProviderError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return candidate.name === "NoEligibleLendingProviderError" &&
    candidate.code === "NO_ELIGIBLE_PROVIDER" &&
    candidate.domain === "positioncrew.lending-provider-audition";
}

export async function createLendingProviderAudition(
  requestInput: LendingRescueRequest,
  observationInput: z.input<typeof LendingAuditionObservationSchema>,
  evaluatedAt: Date,
): Promise<LendingProviderAudition> {
  const request = LendingRescueRequestSchema.parse(requestInput);
  const observation = LendingAuditionObservationSchema.parse(observationInput);
  if (request.chainId !== 56) {
    throw new Error("Lending provider auditions require a BSC mainnet request");
  }
  const source = request.sources[0];
  if (
    request.sources.length !== 1 ||
    source?.uri !== observation.explorerUrl ||
    source?.observedAt !== observation.observedAt
  ) {
    throw new Error("Lending provider audition observation does not match the exact request source");
  }

  const flagshipIdentity = DedicatedLendingIdentitySchema.parse(
    dedicatedLendingIdentityArtifact,
  );
  const external = EXTERNAL_COMPARISON_SNAPSHOT.candidates.find(
    (candidate) => candidate.agentTokenId === "269228" &&
      candidate.category.service === "LENDING_RESCUE",
  );
  if (!external) {
    throw new Error("The pinned external Lending comparison candidate is unavailable");
  }

  const candidates: LendingProviderAuditionCandidate[] = [];
  const firstPartyProvider = PROVIDER_CATALOG.find(
    (provider) => provider.slug === "lending-rescue" &&
      provider.service === "LENDING_RESCUE" &&
      provider.requestSchema === request.schemaVersion,
  );
  if (firstPartyProvider) {
    candidates.push(LendingProviderAuditionCandidateSchema.parse({
      candidateId: firstPartyProvider.providerId,
      name: "PositionCrew Lending Rescue",
      relationship: "FIRST_PARTY",
      identity: {
        protocol: "ERC-8004",
        chainId: 56,
        registry: flagshipIdentity.identityRegistry,
        agentTokenId: flagshipIdentity.agentTokenId,
        owner: flagshipIdentity.owner,
        explorerUrl: `https://bscscan.com/tx/${flagshipIdentity.registrationTransaction}`,
        listingUrl: flagshipIdentity.listingUrl,
      },
      executionAdapter: {
        mode: "POSITIONCREW_IN_PROCESS",
        callable: true,
        publicEndpoint: firstPartyProvider.endpoint,
        externalProviderInvoked: false,
      },
      eligibility: "ELIGIBLE",
      executionState: "SELECTED_PENDING_RUN",
      checks: [
        {
          code: "EXACT_SERVICE_MATCH",
          status: "PASS",
          detail: "The candidate serves the exact LENDING_RESCUE job category.",
        },
        {
          code: "REQUEST_CONTRACT_SUPPORTED",
          status: "PASS",
          detail: `The local adapter parses ${request.schemaVersion} without translation.`,
        },
        {
          code: "POSITIONCREW_ACTIVATION_SUPPORTED",
          status: "PASS",
          detail: "PositionCrew controls the local adapter used by the durable hire worker.",
        },
        {
          code: "EXECUTION_ADAPTER_AVAILABLE",
          status: "PASS",
          detail: "The provider can evaluate the persisted request inside the existing job runner.",
        },
        {
          code: "OUTPUT_VALIDATOR_AVAILABLE",
          status: "PASS",
          detail: "The existing Lending deliverable schema and conformance evaluator validate the result.",
        },
      ],
    }));
  }

  candidates.push(LendingProviderAuditionCandidateSchema.parse({
    candidateId: `erc8004:56:${external.agentTokenId}`,
    name: external.name,
    relationship: "THIRD_PARTY_COMPARISON_ONLY",
    identity: {
      protocol: "ERC-8004",
      chainId: 56,
      registry: external.identity.registry,
      agentTokenId: external.agentTokenId,
      owner: external.identity.owner,
      explorerUrl: external.identity.explorerUrl,
      listingUrl: null,
    },
    executionAdapter: {
      mode: "NONE",
      callable: false,
      publicEndpoint: null,
      externalProviderInvoked: false,
    },
    eligibility: "INELIGIBLE",
    executionState: "INELIGIBLE_NOT_INVOKED",
    checks: [
      {
        code: "EXACT_SERVICE_MATCH",
        status: "PASS",
        detail: "Public name and metadata map this identity to health-factor monitoring.",
      },
      {
        code: "REQUEST_CONTRACT_SUPPORTED",
        status: "FAIL",
        detail: `No adapter proves support for the exact ${request.schemaVersion} payload.`,
      },
      {
        code: "POSITIONCREW_ACTIVATION_SUPPORTED",
        status: "FAIL",
        detail: "The pinned candidate record explicitly marks PositionCrew activation as unsupported.",
      },
      {
        code: "EXECUTION_ADAPTER_AVAILABLE",
        status: "FAIL",
        detail: "The recorded AgentCard advertises a loopback runtime, so no remotely callable exact-request adapter is available.",
      },
      {
        code: "OUTPUT_VALIDATOR_AVAILABLE",
        status: "FAIL",
        detail: "No third-party output contract is available to bind and validate a result for this request.",
      },
    ],
  }));

  const eligible = candidates.filter((candidate) => candidate.eligibility === "ELIGIBLE");
  if (eligible.length === 0) throw new NoEligibleLendingProviderError();
  if (eligible.length !== 1) {
    throw new Error("Lending eligibility policy v1 requires exactly one eligible provider");
  }
  const winner = eligible[0]!;
  const base = LendingProviderAuditionBaseSchema.parse({
    schemaVersion: "positioncrew.lending-provider-audition.v1",
    policyVersion: "positioncrew.lending-provider-eligibility.v1",
    service: "LENDING_RESCUE",
    requestHash: await auditionCommitment(request),
    observation,
    evaluatedAt: evaluatedAt.toISOString(),
    candidates,
    selection: {
      winnerCandidateId: winner.candidateId,
      winnerProviderId: winner.candidateId,
      winnerProviderSlug: "lending-rescue",
      eligibleCandidateCount: 1,
      basis: "SOLE_ELIGIBLE_CANDIDATE",
    },
    claimBoundary: [...LENDING_PROVIDER_AUDITION_CLAIM_BOUNDARY],
  });
  return LendingProviderAuditionSchema.parse({
    ...base,
    auditionHash: await auditionCommitment(base),
  });
}
