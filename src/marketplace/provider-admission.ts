export type ProviderAdmissionStage =
  | "UNLISTED"
  | "LISTED"
  | "VERIFIED"
  | "LIVE"
  | "COMPATIBLE"
  | "ACTIVATABLE"
  | "SELECTED";

export interface ProviderIdentityEvidence {
  agentId: string;
  chainId: number;
  registryAddress: string;
  ownerAddress: string;
  metadataUri: string;
  verifiedAt: string;
  registryReadSucceeded: boolean;
  metadataMatchesRegistry: boolean;
}

export interface ProviderLivenessEvidence {
  endpoint: string;
  checkedAt: string;
  statusCode: number;
  responseTimeMs: number;
  advertisedRequestSchemas: string[];
  advertisedResponseSchemas: string[];
}

export interface ProviderCapabilityChallenge {
  challengeId: string;
  providerAgentId: string;
  jobFingerprint: string;
  requestSchema: string;
  requestHash: string;
  validatorVersion: string;
  issuedAt: string;
  expiresAt: string;
  completedAt: string | null;
  responseHash: string | null;
  responseSchema: string | null;
  financialValueAtomic: string;
  providerParsedRequest: boolean;
  responseSchemaValid: boolean;
  conformancePassed: boolean;
  usefulResultProduced: boolean;
  quoteOnly: boolean;
  refusalReason: string | null;
}

export interface ProviderActivationEvidence {
  activationPath: "AACP" | "ERC8183" | "X402" | "DIRECT";
  termsHash: string;
  priceAtomic: string;
  paymentToken: string;
  settlementContract: string | null;
  activationPreviewSucceeded: boolean;
  authorityBoundaryDeclared: boolean;
  refundOrDisputePathDeclared: boolean;
}

export interface ProviderAdmissionCandidate {
  providerName: string;
  identity: ProviderIdentityEvidence | null;
  liveness: ProviderLivenessEvidence | null;
  challenge: ProviderCapabilityChallenge | null;
  activation: ProviderActivationEvidence | null;
}

export interface ProviderAdmissionDecision {
  providerName: string;
  stage: Exclude<ProviderAdmissionStage, "SELECTED">;
  admitted: boolean;
  reasons: string[];
  jobFingerprint: string | null;
}

export interface ProviderSelection {
  stage: "SELECTED";
  jobFingerprint: string;
  selectedProviderAgentId: string;
  selectionPolicy: "LOWEST_PRICE_THEN_LATENCY";
  comparedProviderAgentIds: string[];
  explanation: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

function validDate(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function appendFailure(reasons: string[], condition: boolean, reason: string): boolean {
  if (!condition) reasons.push(reason);
  return condition;
}

export function evaluateProviderAdmission(
  candidate: ProviderAdmissionCandidate,
  now = new Date(),
  maximumLivenessAgeSeconds = 300,
): ProviderAdmissionDecision {
  const reasons: string[] = [];
  const identity = candidate.identity;
  if (!identity) {
    return {
      providerName: candidate.providerName,
      stage: "UNLISTED",
      admitted: false,
      reasons: ["No registry identity evidence was supplied."],
      jobFingerprint: null,
    };
  }

  let stage: ProviderAdmissionDecision["stage"] = "LISTED";
  const identityVerified = [
    appendFailure(reasons, identity.agentId.trim().length > 0, "Registry agent ID is missing."),
    appendFailure(reasons, Number.isSafeInteger(identity.chainId) && identity.chainId > 0, "Registry chain ID is invalid."),
    appendFailure(reasons, ADDRESS.test(identity.registryAddress), "Registry address is invalid."),
    appendFailure(reasons, ADDRESS.test(identity.ownerAddress), "Registry owner address is invalid."),
    appendFailure(reasons, identity.metadataUri.trim().length > 0, "Registry metadata URI is missing."),
    appendFailure(reasons, identity.registryReadSucceeded, "The on-chain identity read did not succeed."),
    appendFailure(reasons, identity.metadataMatchesRegistry, "Provider metadata does not match the registry record."),
    appendFailure(reasons, validDate(identity.verifiedAt) !== null, "Identity verification time is invalid."),
  ].every(Boolean);
  if (!identityVerified) return { providerName: candidate.providerName, stage, admitted: false, reasons, jobFingerprint: null };
  stage = "VERIFIED";

  const liveness = candidate.liveness;
  if (!liveness) {
    reasons.push("No endpoint liveness evidence was supplied.");
    return { providerName: candidate.providerName, stage, admitted: false, reasons, jobFingerprint: null };
  }
  const checkedAt = validDate(liveness.checkedAt);
  const livenessFresh = checkedAt !== null && now.getTime() - checkedAt >= 0 && now.getTime() - checkedAt <= maximumLivenessAgeSeconds * 1000;
  const live = [
    appendFailure(reasons, /^https:\/\//.test(liveness.endpoint), "Provider endpoint is not HTTPS."),
    appendFailure(reasons, liveness.statusCode >= 200 && liveness.statusCode < 300, "Provider endpoint did not return a successful status."),
    appendFailure(reasons, Number.isFinite(liveness.responseTimeMs) && liveness.responseTimeMs >= 0, "Provider response time is invalid."),
    appendFailure(reasons, livenessFresh, "Provider liveness evidence is missing, future-dated, or stale."),
  ].every(Boolean);
  if (!live) return { providerName: candidate.providerName, stage, admitted: false, reasons, jobFingerprint: null };
  stage = "LIVE";

  const challenge = candidate.challenge;
  if (!challenge) {
    reasons.push("No exact-request capability challenge was completed.");
    return { providerName: candidate.providerName, stage, admitted: false, reasons, jobFingerprint: null };
  }
  const issuedAt = validDate(challenge.issuedAt);
  const expiresAt = validDate(challenge.expiresAt);
  const completedAt = challenge.completedAt === null ? null : validDate(challenge.completedAt);
  const schemasAdvertised =
    liveness.advertisedRequestSchemas.includes(challenge.requestSchema) &&
    challenge.responseSchema !== null &&
    liveness.advertisedResponseSchemas.includes(challenge.responseSchema);
  const challengeValid = [
    appendFailure(reasons, challenge.providerAgentId === identity.agentId, "Challenge provider does not match the verified identity."),
    appendFailure(reasons, challenge.jobFingerprint.trim().length > 0, "Challenge job fingerprint is missing."),
    appendFailure(reasons, challenge.requestHash.trim().length > 0, "Challenge request hash is missing."),
    appendFailure(reasons, challenge.validatorVersion.trim().length > 0, "Challenge validator version is missing."),
    appendFailure(reasons, NON_NEGATIVE_INTEGER.test(challenge.financialValueAtomic), "Challenge financial value is invalid."),
    appendFailure(reasons, challenge.financialValueAtomic === "0", "Compatibility must be proven with a zero-value challenge before funding."),
    appendFailure(reasons, issuedAt !== null && expiresAt !== null && completedAt !== null, "Challenge timing evidence is incomplete."),
    appendFailure(
      reasons,
      issuedAt !== null && expiresAt !== null && completedAt !== null && completedAt >= issuedAt && completedAt <= expiresAt,
      "Challenge was not completed inside its frozen validity window.",
    ),
    appendFailure(reasons, schemasAdvertised, "Challenge schemas do not match the provider's live advertised contract."),
    appendFailure(reasons, challenge.providerParsedRequest, "Provider did not parse the exact frozen request."),
    appendFailure(reasons, challenge.responseHash !== null && challenge.responseHash.length > 0, "Challenge response hash is missing."),
    appendFailure(reasons, challenge.responseSchemaValid, "Challenge response failed its declared schema."),
    appendFailure(reasons, challenge.conformancePassed, "Challenge response failed PositionCrew conformance."),
    appendFailure(reasons, challenge.usefulResultProduced, "Challenge did not produce a useful result or bounded refusal."),
    appendFailure(reasons, !challenge.quoteOnly, "A signed quote does not prove request compatibility."),
  ].every(Boolean);
  if (!challengeValid) {
    return {
      providerName: candidate.providerName,
      stage,
      admitted: false,
      reasons,
      jobFingerprint: challenge.jobFingerprint || null,
    };
  }
  stage = "COMPATIBLE";

  const activation = candidate.activation;
  if (!activation) {
    reasons.push("No bounded activation evidence was supplied.");
    return { providerName: candidate.providerName, stage, admitted: false, reasons, jobFingerprint: challenge.jobFingerprint };
  }
  const activatable = [
    appendFailure(reasons, activation.termsHash.trim().length > 0, "Activation terms hash is missing."),
    appendFailure(reasons, NON_NEGATIVE_INTEGER.test(activation.priceAtomic), "Activation price is invalid."),
    appendFailure(reasons, ADDRESS.test(activation.paymentToken), "Activation payment token is invalid."),
    appendFailure(reasons, activation.activationPreviewSucceeded, "Activation preview did not succeed."),
    appendFailure(reasons, activation.authorityBoundaryDeclared, "Activation authority boundary is not declared."),
    appendFailure(reasons, activation.refundOrDisputePathDeclared, "Activation refund or dispute path is not declared."),
  ].every(Boolean);
  if (!activatable) {
    return { providerName: candidate.providerName, stage, admitted: false, reasons, jobFingerprint: challenge.jobFingerprint };
  }

  return {
    providerName: candidate.providerName,
    stage: "ACTIVATABLE",
    admitted: true,
    reasons: ["Identity, liveness, exact-request compatibility, and bounded activation checks passed."],
    jobFingerprint: challenge.jobFingerprint,
  };
}

export function selectEligibleProvider(
  candidates: ProviderAdmissionCandidate[],
  now = new Date(),
): ProviderSelection | null {
  const eligible = candidates
    .map((candidate) => ({ candidate, decision: evaluateProviderAdmission(candidate, now) }))
    .filter(
      (entry): entry is typeof entry & {
        candidate: ProviderAdmissionCandidate & {
          identity: ProviderIdentityEvidence;
          liveness: ProviderLivenessEvidence;
          challenge: ProviderCapabilityChallenge;
          activation: ProviderActivationEvidence;
        };
      } => entry.decision.stage === "ACTIVATABLE" && entry.decision.admitted,
    );

  if (eligible.length < 2) return null;
  const reference = eligible[0];
  if (!reference) return null;
  const jobFingerprint = reference.candidate.challenge.jobFingerprint;
  const comparable = eligible.filter(
    ({ candidate }) =>
      candidate.challenge.jobFingerprint === jobFingerprint &&
      candidate.challenge.validatorVersion === reference.candidate.challenge.validatorVersion &&
      candidate.challenge.requestHash === reference.candidate.challenge.requestHash,
  );
  if (comparable.length < 2) return null;

  comparable.sort((left, right) => {
    const priceDifference = BigInt(left.candidate.activation.priceAtomic) - BigInt(right.candidate.activation.priceAtomic);
    if (priceDifference !== 0n) return priceDifference < 0n ? -1 : 1;
    return left.candidate.liveness.responseTimeMs - right.candidate.liveness.responseTimeMs;
  });

  const selected = comparable[0];
  if (!selected) return null;
  return {
    stage: "SELECTED",
    jobFingerprint,
    selectedProviderAgentId: selected.candidate.identity.agentId,
    selectionPolicy: "LOWEST_PRICE_THEN_LATENCY",
    comparedProviderAgentIds: comparable.map(({ candidate }) => candidate.identity.agentId),
    explanation: "Selected among comparable, activatable providers by the disclosed lowest-price-then-latency policy; this is not a claim of universal provider superiority.",
  };
}
