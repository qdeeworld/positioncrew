import type {
  LpRebalanceDeliverable,
  LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";

const ENDPOINT =
  "https://www.useaiki.xyz/v1/reference/pancake/rebalancer/agent/315944";

export const AIKI_PANCAKE_REBALANCER = {
  name: "AiKi PancakeSwap LP Rebalancer",
  tokenId: "315944",
  chainId: 56,
  endpoint: ENDPOINT,
} as const;

interface AiKiAssessment {
  tokenId?: string;
  owner?: string;
  token0?: string;
  token1?: string;
  fee?: number;
  tickLower?: number;
  tickUpper?: number;
  liquidity?: string;
  currentTick?: number;
  pool?: string;
  observedAt?: string;
  category?: string;
  assessmentVersion?: string;
  state?: string;
  recommendation?: string;
  methodology?: string;
  caveats?: string[];
}

interface AiKiResponse {
  assessment?: AiKiAssessment;
  evidence?: { persisted?: boolean };
}

export interface AiKiCheck {
  code: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface AiKiPancakeAudition {
  schemaVersion: "positioncrew.external-lp-audition.v1";
  provider: typeof AIKI_PANCAKE_REBALANCER;
  evaluatedAt: string;
  positionTokenId: string;
  outcome: "SEMANTICALLY_COMPARABLE" | "INCOMPATIBLE" | "UNAVAILABLE";
  attributableResult: boolean;
  completedSamePositionAssessment: boolean;
  persistedByProvider: boolean;
  exactRequestAccepted: false;
  exactOutputContract: false;
  eligibleForPositionAssessmentActivation: boolean;
  eligibleForLiveMatch: false;
  externalDecision: "HOLD" | "REBALANCE" | "UNKNOWN";
  firstPartyDecision: string;
  checks: AiKiCheck[];
  response?: AiKiResponse;
  boundary: string;
}

function pass(code: string, detail: string): AiKiCheck {
  return { code, status: "PASS", detail };
}

function fail(code: string, detail: string): AiKiCheck {
  return { code, status: "FAIL", detail };
}

function sameAddress(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

export async function auditionAiKiPancakeRebalancer(
  request: LpRebalanceRequest,
  firstParty: LpRebalanceDeliverable,
  positionTokenId: string,
  options: { fetchImpl?: typeof fetch; endpoint?: string; now?: Date } = {},
): Promise<AiKiPancakeAudition> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? ENDPOINT;
  const now = options.now ?? new Date();
  let responseBody: AiKiResponse;

  try {
    const response = await fetchImpl(
      `${endpoint}?tokenId=${encodeURIComponent(positionTokenId)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2_500),
      },
    );
    if (!response.ok) throw new Error(`assessment returned HTTP ${response.status}`);
    responseBody = (await response.json()) as AiKiResponse;
  } catch (error) {
    return {
      schemaVersion: "positioncrew.external-lp-audition.v1",
      provider: AIKI_PANCAKE_REBALANCER,
      evaluatedAt: now.toISOString(),
      positionTokenId,
      outcome: "UNAVAILABLE",
      attributableResult: false,
      completedSamePositionAssessment: false,
      persistedByProvider: false,
      exactRequestAccepted: false,
      exactOutputContract: false,
      eligibleForPositionAssessmentActivation: false,
      eligibleForLiveMatch: false,
      externalDecision: "UNKNOWN",
      firstPartyDecision: firstParty.decision,
      checks: [
        fail(
          "PUBLIC_ASSESSMENT",
          error instanceof Error ? error.message : "Public assessment failed.",
        ),
      ],
      boundary:
        "No payment, negotiation, activation, signature, transaction, or protocol action occurred.",
    };
  }

  const assessment = responseBody.assessment;
  const checks: AiKiCheck[] = [];
  checks.push(
    assessment
      ? pass("PUBLIC_ASSESSMENT", "Provider returned an attributable assessment.")
      : fail("PUBLIC_ASSESSMENT", "Provider returned no assessment."),
  );
  checks.push(
    assessment?.tokenId === positionTokenId
      ? pass("POSITION_ID", `Provider assessed NFT ${positionTokenId}.`)
      : fail("POSITION_ID", "Provider assessed a different NFT."),
  );
  checks.push(
    sameAddress(assessment?.owner, request.account)
      ? pass("OWNER", "Provider owner matches the request account.")
      : fail("OWNER", "Provider owner differs from the request account."),
  );
  checks.push(
    sameAddress(assessment?.pool, request.pool)
      ? pass("POOL", "Provider pool matches the request pool.")
      : fail("POOL", "Provider pool differs from the request pool."),
  );
  checks.push(
    sameAddress(assessment?.token0, request.token0.address) &&
      sameAddress(assessment?.token1, request.token1.address)
      ? pass("PAIR", "Provider token addresses match the request pair.")
      : fail("PAIR", "Provider token addresses differ from the request pair."),
  );
  checks.push(
    assessment?.tickLower === request.position.lowerTick &&
      assessment?.tickUpper === request.position.upperTick &&
      assessment?.liquidity === request.position.liquidity
      ? pass("EXACT_POSITION_STATE", "Ticks and raw liquidity exactly match the request.")
      : fail("EXACT_POSITION_STATE", "Ticks or raw liquidity differ from the request."),
  );
  const observedAt = Date.parse(assessment?.observedAt ?? "");
  const ageSeconds = Number.isFinite(observedAt)
    ? Math.max(0, (now.getTime() - observedAt) / 1000)
    : Number.POSITIVE_INFINITY;
  checks.push(
    ageSeconds <= request.maxDataAgeSeconds
      ? pass("FRESHNESS", `Provider observation age is ${ageSeconds.toFixed(1)} seconds.`)
      : fail("FRESHNESS", "Provider observation exceeds the request freshness limit."),
  );
  checks.push(
    responseBody.evidence?.persisted === true
      ? pass("PERSISTENCE", "Provider marks the assessment persisted.")
      : fail("PERSISTENCE", "Provider does not mark the assessment persisted."),
  );

  const externalDecision =
    assessment?.recommendation === "HOLD"
      ? "HOLD"
      : assessment?.recommendation?.includes("REBALANCE")
        ? "REBALANCE"
        : "UNKNOWN";
  checks.push(
    externalDecision !== "UNKNOWN" && externalDecision === firstParty.decision
      ? pass("DECISION_ALIGNMENT", `Both providers return ${externalDecision}.`)
      : fail(
          "DECISION_ALIGNMENT",
          `External ${externalDecision} differs from PositionCrew ${firstParty.decision}.`,
        ),
  );
  checks.push(
    fail(
      "BLOCK_ATTRIBUTION",
      "Provider supplies observation time but not the exact BSC block used for the decision.",
    ),
  );
  checks.push(
    fail(
      "EXACT_REQUEST_ACCEPTANCE",
      "Provider accepts an NFT tokenId, not positioncrew.lp-rebalance.request.v1 constraints.",
    ),
  );
  checks.push(
    fail(
      "EXACT_OUTPUT_CONTRACT",
      "Provider output is pancake-v3-rebalance/v1, not positioncrew.lp-rebalance.deliverable.v1.",
    ),
  );

  const comparableCodes = [
    "PUBLIC_ASSESSMENT",
    "POSITION_ID",
    "OWNER",
    "POOL",
    "PAIR",
    "EXACT_POSITION_STATE",
    "FRESHNESS",
    "PERSISTENCE",
    "DECISION_ALIGNMENT",
  ];
  const comparable = comparableCodes
    .map((code) => checks.find((check) => check.code === code))
    .every((check) => check?.status === "PASS");

  return {
    schemaVersion: "positioncrew.external-lp-audition.v1",
    provider: AIKI_PANCAKE_REBALANCER,
    evaluatedAt: now.toISOString(),
    positionTokenId,
    outcome: comparable ? "SEMANTICALLY_COMPARABLE" : "INCOMPATIBLE",
    attributableResult: Boolean(assessment),
    completedSamePositionAssessment: comparable,
    persistedByProvider: responseBody.evidence?.persisted === true,
    exactRequestAccepted: false,
    exactOutputContract: false,
    eligibleForPositionAssessmentActivation: comparable,
    eligibleForLiveMatch: false,
    externalDecision,
    firstPartyDecision: firstParty.decision,
    checks,
    response: responseBody,
    boundary:
      "This proves two providers completed semantically comparable assessments of the same live LP position. It does not prove exact PositionCrew request acceptance, provider selection, activation, payment, execution, or that either provider is stronger.",
  };
}
