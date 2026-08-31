import type {
  LendingRescueDeliverable,
  LendingRescueRequest,
} from "../contracts/lending-rescue.js";

const ENDPOINT = "https://www.useaiki.xyz/v1/reference/venus/agent/315943";

export const AIKI_VENUS_GUARDIAN = {
  name: "AiKi Venus Health Factor Guardian",
  tokenId: "315943",
  chainId: 56,
  endpoint: ENDPOINT,
} as const;

interface FixedPointUsd {
  amount?: string;
  asset?: string;
  decimals?: number;
}

interface AiKiVenusAssessment {
  account?: string;
  protocol?: string;
  category?: string;
  assessmentVersion?: string;
  observedAt?: string;
  status?: string;
  minimumHealthFactor?: string;
  healthFactor?: string;
  supplied?: FixedPointUsd;
  adjustedCollateral?: FixedPointUsd;
  borrowed?: FixedPointUsd;
  controllerLiquidity?: FixedPointUsd;
  controllerShortfall?: FixedPointUsd;
  methodology?: string;
  consistency?: { verified?: boolean; detail?: string };
  caveats?: string[];
}

interface AiKiVenusResponse {
  assessment?: AiKiVenusAssessment;
  evidence?: { observationsInserted?: number; persisted?: boolean };
}

export interface AiKiVenusCheck {
  code: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface AiKiVenusAudition {
  schemaVersion: "positioncrew.external-lending-audition.v1";
  provider: typeof AIKI_VENUS_GUARDIAN;
  evaluatedAt: string;
  outcome: "SEMANTICALLY_COMPARABLE" | "INCOMPATIBLE" | "UNAVAILABLE";
  attributableResult: boolean;
  completedSamePositionAssessment: boolean;
  persistedByProvider: boolean;
  externalHealthFactor: string | null;
  firstPartyHealthFactor: string | null;
  healthFactorDifferenceBps: number | null;
  externalRiskStatus: string;
  firstPartyDecision: string;
  exactRequestAccepted: false;
  exactOutputContract: false;
  eligibleForRescueSelection: false;
  eligibleForLiveMatch: false;
  checks: AiKiVenusCheck[];
  response?: AiKiVenusResponse;
  boundary: string;
}

function pass(code: string, detail: string): AiKiVenusCheck {
  return { code, status: "PASS", detail };
}

function fail(code: string, detail: string): AiKiVenusCheck {
  return { code, status: "FAIL", detail };
}

export async function auditionAiKiVenusGuardian(
  request: LendingRescueRequest,
  firstParty: LendingRescueDeliverable,
  options: { fetchImpl?: typeof fetch; endpoint?: string; now?: Date } = {},
): Promise<AiKiVenusAudition> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? ENDPOINT;
  const now = options.now ?? new Date();
  let responseBody: AiKiVenusResponse;

  try {
    const query = new URLSearchParams({
      account: request.account,
      minimumHealthFactor: request.targetHealthFactor,
    });
    const response = await fetchImpl(`${endpoint}?${query.toString()}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) throw new Error(`assessment returned HTTP ${response.status}`);
    responseBody = (await response.json()) as AiKiVenusResponse;
  } catch (error) {
    return {
      schemaVersion: "positioncrew.external-lending-audition.v1",
      provider: AIKI_VENUS_GUARDIAN,
      evaluatedAt: now.toISOString(),
      outcome: "UNAVAILABLE",
      attributableResult: false,
      completedSamePositionAssessment: false,
      persistedByProvider: false,
      externalHealthFactor: null,
      firstPartyHealthFactor: firstParty.position.currentHealthFactor,
      healthFactorDifferenceBps: null,
      externalRiskStatus: "UNKNOWN",
      firstPartyDecision: firstParty.decision,
      exactRequestAccepted: false,
      exactOutputContract: false,
      eligibleForRescueSelection: false,
      eligibleForLiveMatch: false,
      checks: [
        fail(
          "PUBLIC_ASSESSMENT",
          error instanceof Error ? error.message : "Public assessment failed.",
        ),
      ],
      boundary:
        "No payment, negotiation, provider selection, rescue action, signature, or transaction occurred.",
    };
  }

  const assessment = responseBody.assessment;
  const checks: AiKiVenusCheck[] = [];
  checks.push(
    assessment
      ? pass("PUBLIC_ASSESSMENT", "Provider returned an attributable assessment.")
      : fail("PUBLIC_ASSESSMENT", "Provider returned no assessment."),
  );
  checks.push(
    assessment?.account?.toLowerCase() === request.account.toLowerCase()
      ? pass("ACCOUNT", "Provider assessed the exact request account.")
      : fail("ACCOUNT", "Provider assessed a different account."),
  );
  checks.push(
    assessment?.protocol === "Venus" && assessment.category === "health_factor"
      ? pass("SERVICE", "Provider returned a Venus health-factor assessment.")
      : fail("SERVICE", "Provider did not return the expected Venus assessment."),
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
    assessment?.consistency?.verified === true
      ? pass("PROTOCOL_CROSS_CHECK", "Provider reports Comptroller consistency verified.")
      : fail("PROTOCOL_CROSS_CHECK", "Provider did not verify Comptroller consistency."),
  );
  checks.push(
    responseBody.evidence?.persisted === true &&
      (responseBody.evidence.observationsInserted ?? 0) > 0
      ? pass(
          "PERSISTENCE",
          `Provider persisted ${responseBody.evidence.observationsInserted} observations.`,
        )
      : fail("PERSISTENCE", "Provider did not confirm persisted observations."),
  );

  const externalHealth = Number(assessment?.healthFactor);
  const firstPartyHealth = Number(firstParty.position.currentHealthFactor);
  const healthFactorDifferenceBps =
    Number.isFinite(externalHealth) && Number.isFinite(firstPartyHealth) && firstPartyHealth > 0
      ? (Math.abs(externalHealth - firstPartyHealth) / firstPartyHealth) * 10_000
      : null;
  checks.push(
    healthFactorDifferenceBps !== null && healthFactorDifferenceBps <= 5
      ? pass(
          "HEALTH_FACTOR_ALIGNMENT",
          `Health factors differ by ${healthFactorDifferenceBps.toFixed(4)} bps.`,
        )
      : fail("HEALTH_FACTOR_ALIGNMENT", "Health factors differ by more than 5 bps."),
  );
  checks.push(
    fail(
      "BLOCK_ATTRIBUTION",
      "Provider supplies observation time but not the exact BSC block used for the assessment.",
    ),
  );
  checks.push(
    fail(
      "EXACT_REQUEST_ACCEPTANCE",
      "Provider accepts account and minimum health factor, not positioncrew.lending-rescue.request.v1 constraints.",
    ),
  );
  checks.push(
    fail(
      "RESCUE_OUTPUT_CONTRACT",
      "Provider diagnoses risk but does not return a bounded rescue action in positioncrew.lending-rescue.deliverable.v1.",
    ),
  );

  const comparableCodes = [
    "PUBLIC_ASSESSMENT",
    "ACCOUNT",
    "SERVICE",
    "FRESHNESS",
    "PROTOCOL_CROSS_CHECK",
    "PERSISTENCE",
    "HEALTH_FACTOR_ALIGNMENT",
  ];
  const comparable = comparableCodes
    .map((code) => checks.find((check) => check.code === code))
    .every((check) => check?.status === "PASS");

  return {
    schemaVersion: "positioncrew.external-lending-audition.v1",
    provider: AIKI_VENUS_GUARDIAN,
    evaluatedAt: now.toISOString(),
    outcome: comparable ? "SEMANTICALLY_COMPARABLE" : "INCOMPATIBLE",
    attributableResult: Boolean(assessment),
    completedSamePositionAssessment: comparable,
    persistedByProvider: responseBody.evidence?.persisted === true,
    externalHealthFactor: assessment?.healthFactor ?? null,
    firstPartyHealthFactor: firstParty.position.currentHealthFactor,
    healthFactorDifferenceBps,
    externalRiskStatus: assessment?.status ?? "UNKNOWN",
    firstPartyDecision: firstParty.decision,
    exactRequestAccepted: false,
    exactOutputContract: false,
    eligibleForRescueSelection: false,
    eligibleForLiveMatch: false,
    checks,
    response: responseBody,
    boundary:
      "This proves two providers completed comparable health assessments of the same Venus account. AiKi did not accept the complete rescue contract, propose the bounded action, become selected, receive payment, or execute a transaction.",
  };
}
