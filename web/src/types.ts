import type { LpLiveMatchAudition, LpLiveMatchExecution, LpLiveMatchProviderSelection } from "../../src/marketplace/lp-live-match-schema.js";

export type ServiceId =
  | "LENDING_RESCUE"
  | "LP_REBALANCE"
  | "YIELD_OPTIMIZATION"
  | "BOUNDED_GRID";

export interface AssetIdentity {
  symbol: string;
  address: string;
  decimals: number;
}

export interface LendingAction {
  kind: "REPAY_DEBT" | "ADD_COLLATERAL";
  amount: string;
  amountBaseUnits: string;
  amountUsd: string;
  asset: AssetIdentity;
  projectedHealthFactor: string;
  estimatedGasUsd: string;
  executeBefore: string;
  maxSlippageBps: number;
  preconditions: string[];
}

export interface ProviderDeliverable {
  service: ServiceId;
  status: string;
  decision: string;
  summary: string;
  expiresAt: string;
  invalidationConditions?: string[];
  refusalReasons?: string[];
  limitations?: string[];
  recommendation?: LendingAction | null;
  alternatives?: LendingAction[];
  position?: {
    collateralValueUsd: string;
    debtValueUsd: string;
    currentHealthFactor: string | null;
    stressedHealthFactor: string | null;
    targetHealthFactor: string;
  };
  proposedRange?: { lowerTick: number; upperTick: number } | null;
  expectedNetBenefitUsd?: string;
  estimatedRebalanceCostUsd?: string;
  breakEvenHours?: string | null;
  inventoryExposure?: { token0Bps: number; token1Bps: number };
  actionSteps?: string[];
  selectedOpportunityId?: string | null;
  allocationUsd?: string;
  grossApyBps?: number | null;
  currentWeightedApyBps?: number;
  netBenefitUsd?: string;
  migrationCostUsd?: string;
  breakEvenDays?: string | null;
  risks?: string[];
  orders?: Array<{
    side: "BUY" | "SELL";
    price: string;
    baseAmount: string;
    maximumQuoteAmount: string;
  }>;
  expectedNetProfitUsd?: string;
  worstCaseLossUsd?: string;
  maximumInventoryUsd?: string;
  cancellationConditions?: string[];
}

export interface JobHistoryEntry {
  state: string;
  at: string;
  reference: string;
}

export type JobRequestMode = "FROZEN_FIXTURE" | "CALLER_SUPPLIED_OBSERVATIONS";

export interface CurrentMarketplaceObservation {
  blockNumber: string;
  observedAt: string;
  explorerUrl: string;
}

export type CurrentLendingObservation = CurrentMarketplaceObservation;

export interface FixtureJobResponse {
  liveMatchExecution?: LpLiveMatchExecution;
  schemaVersion: "positioncrew.fixture-job-response.v1";
  evidenceMode: "FROZEN_BSC_TEST_FIXTURE" | "CALLER_SUPPLIED_OBSERVATIONS" | "CURRENT_BLOCK_PINNED";
  commerceMode: "IN_MEMORY_CONFORMANCE";
  advantageStatus: "PENDING_INDEPENDENT_BLIND_EVALUATION";
  generatedAt: string;
  claimBoundary: string[];
  benchmarkLock: {
    fixtureHash: string;
    rubricHash: string;
    protocolHash: string;
  } | null;
  receipt: {
    mode: "PUBLIC_REPRODUCIBLE" | "SESSION_EMBEDDED";
    path: string | null;
    evaluationHash: string;
  };
  result: {
    job: {
      jobId: string;
      state: string;
      envelopeHash: string;
      providerId: string;
      evaluatorId: string;
      history: JobHistoryEntry[];
      deliverable: { deliverableHash: string };
    };
    request: {
      service: ServiceId;
      account: string;
      chainId: 56 | 97;
      maxActionUsd: string;
      maxGasUsd: string;
      maxSlippageBps: number;
      maxDataAgeSeconds: number;
      [key: string]: unknown;
    };
    deliverable: ProviderDeliverable;
    evaluation: {
      score: number;
      passed: boolean;
      evaluationHash: string;
      checks: Array<{ id: string; passed: boolean; critical: boolean }>;
    };
  };
}

export interface MatrixResponse {
  schemaVersion: "positioncrew.provider-matrix-response.v1";
  results: FixtureJobResponse[];
}

export interface ProviderListing {
  providerId: string;
  slug: string;
  name: string;
  service: ServiceId;
  category: string;
  summary: string;
  method: "POST";
  endpoint: string;
  healthEndpoint: string;
  manifestEndpoint: string;
  requestSchema: string;
  deliverableSchema: string;
  price: { amount: "5"; token: "TEST_USDC"; chainId: 97 };
  identity: {
    protocol: "ERC-8004";
    network: "BSC_TESTNET";
    chainId: 97;
    registry: string;
    agentId: number;
    owner: string;
    registrationTransaction: string;
    explorerUrl: string;
  };
  availability: "FIXTURE_API_REACHABLE";
  verification: "DETERMINISTIC_CONFORMANCE";
  settlement: "IN_MEMORY_CONFORMANCE";
}

export interface ProviderCatalogResponse {
  schemaVersion: "positioncrew.provider-catalog-response.v1";
  generatedAt: string;
  commerceAdapter: "AACP_PRODUCTION_RUNTIME_PENDING";
  providers: ProviderListing[];
}

export interface ExternalComparisonCandidate {
  agentTokenId: string;
  name: string;
  relationship: "THIRD_PARTY_COMPARISON_ONLY";
  verdict: "PASS_FOR_COMPARISON_ONLY" | "LISTED_ONLY";
  identity: {
    protocol: "ERC-8004";
    chainId: 56;
    registry: string;
    owner: string;
    verification: "DIRECT_OWNER_OF" | "REGISTRY_INDEXER_RECORD";
    checkedAt: string;
    blockNumber: string;
    sourceUrl: string;
    explorerUrl: string;
  };
  category: {
    service: ServiceId;
    label: string;
    mappingBasis: "PUBLIC_NAME_AND_METADATA";
    sourceUrl: string;
  };
  serviceReachability: {
    status: "REACHABLE" | "LISTED_ONLY";
    checkedAt: string;
    endpointUrl: string | null;
    httpStatus: number | null;
    sourceUrl: string;
  };
  pricing: {
    mode: "QUOTE_REQUIRED" | "NOT_PUBLISHED" | "UNVERIFIED_MARKETPLACE_ASSERTION";
    amount: null;
    token: null;
    chainId: null;
    sourceUrl: string;
  };
  feedback: { recordCount: number; aggregateScore: null; sourceUrl: string };
  validation: { recordCount: number; successfulCount: number; summary: null; sourceUrl: string };
  positionCrewCertified: false;
  positionCrewActivation: "NOT_SUPPORTED";
  claimBoundary: string[];
}

export interface ExternalComparisonSnapshot {
  schemaVersion: "positioncrew.external-comparison-snapshot.v1";
  snapshotId: "bsc-mainnet-2026-08-24";
  checkedAt: string;
  chain: { name: "BNB Smart Chain"; chainId: 56; blockNumber: string; registry: string };
  selectedAgentTokenIds: ["269228", "265375", "265876", "267697"];
  candidates: ExternalComparisonCandidate[];
  claimBoundary: string[];
  snapshotHash: string;
}

export interface AacpRuntimeRotationEvidence {
  schemaVersion: "positioncrew.termix-runtime-rotations.v1";
  network: "bsc-mainnet";
  chainId: 56;
  service: "LENDING_RESCUE";
  role: "DEDICATED_FLAGSHIP_RUNTIME";
  owner: string;
  handle: "positioncrew-rescue-adf9.agent";
  agentId: string;
  agentTokenId: "293111";
  runtimeInstance: "dedicated-lending";
  observationSource: "DEDICATED_VPS_SYSTEMD_JOURNAL";
  eventName: "termix.runtime-token.renewal-complete";
  renewalUnit: "positioncrew-runtime-renew@dedicated-lending.service";
  redactedJournalEventCanonicalization: "UTF8_JSON_STRINGIFY_ORDERED_KEYS_NO_NEWLINE";
  archiveAttestation: {
    provider: "GITHUB_ARTIFACT_ATTESTATIONS";
    predicateType: "https://slsa.dev/provenance/v1";
    bundlePath: "evidence/termix-runtime-rotation-attestation.bundle.jsonl";
    bundleSha256: string;
    signerWorkflow: "dolepee/positioncrew/.github/workflows/production-smoke.yml";
    sourceCommit: string;
    sourceRef: "refs/heads/fix/runtime-rotation-evidence";
    runId: string;
    runAttempt: number;
    runUrl: string;
    event: "workflow_dispatch";
    conclusion: "success";
    runnerEnvironment: "github-hosted";
    rotationManifestPath: "evidence/termix-runtime-rotation-events.manifest.json";
    rotationManifestSha256: string;
    subjectCount: number;
  };
  rotations: Array<{
    sequence: number;
    completedAt: string;
    expiresAt: string;
    rotated: true;
    restarted: true;
    redactedJournalEventSha256: string;
    onlineObservation: {
      observedAt: string;
      source: "GITHUB_ACTIONS_PRODUCTION_SMOKE";
      runId: string;
      url: string;
      githubRun: {
        workflowId: "333142188";
        workflowPath: ".github/workflows/production-smoke.yml";
        event: "schedule";
        status: "completed";
        conclusion: "success";
        headBranch: "main";
        headSha: string;
        runAttempt: number;
      };
      artifact: {
        id: string;
        name: string;
        archivePath: string;
        archiveSha256: string;
        sizeBytes: number;
        reportFileName: "positioncrew-production-health.json";
        reportSha256: string;
      };
      healthReport: {
        schemaVersion: "positioncrew.production-health-report.v1";
        baseUrl: "https://positioncrew.dolepee.com";
        checkedAt: string;
        completedAt: string;
        status: "OPERATIONAL";
        aacpGeneratedAt: string;
        dedicatedFlagship: {
          agentId: string;
          agentTokenId: string;
          listingStatus: "PUBLISHED";
          a2aStatus: "ONLINE";
          status: "ONLINE_AND_LISTED";
        };
      };
      productionStatus: "OPERATIONAL";
      listingStatus: "PUBLISHED";
      liveListingVerified: true;
      a2aStatus: "ONLINE";
      presence: "online";
      status: "ONLINE_AND_LISTED";
    };
  }>;
  verifiedAt: string;
  boundaries: string[];
  verifiedRotationCount: number;
  firstCompletedAt: string;
  latestCompletedAt: string;
  latestTokenExpiresAt: string;
}

export interface AacpProductionReadiness {
  schemaVersion: "positioncrew.aacp-production-readiness.v1";
  generatedAt: string;
  state:
    | "SOURCE_UNAVAILABLE"
    | "PROTOCOL_DEGRADED"
    | "MARKETPLACE_DISCOVERY_DEGRADED"
    | "ONBOARDING_PENDING"
    | "IDENTITIES_MINTED_LISTINGS_PENDING"
    | "LISTINGS_PUBLISHED_RUNTIME_PENDING"
    | "PROVIDERS_ONLINE";
  source: {
    apiBase: string;
    configUrl: string;
    rpcUrl: string;
    docsUrl: string;
  };
  network: {
    chainId: 56;
    name: string;
    blockNumber: string | null;
    explorerUrl: string;
  };
  protocol: {
    protocolFeeBps: number | null;
    currencyCount: number | null;
    deployedCount: number;
    contractCount: number;
    contracts: Array<{
      name: string;
      kind: string;
      currency: string | null;
      address: string;
      deployed: boolean;
      codeBytes: number;
      explorerUrl: string;
    }>;
    currencies: Array<{
      symbol: "USDC" | "USDT";
      decimals: number;
      address: string;
      default: boolean;
      protocolFeeBps: number;
      providerLockBps: number | null;
      escrow: string;
      staking: string;
    }>;
  };
  integration: {
    guide: {
      status: "CURRENT_HUMAN_GUIDE_VERIFIED";
      indexUrl: string;
      openApiUrl: string;
      openApiStatus: "SAMPLE_SPEC_NOT_USED";
    };
    runtime: {
      status: "PREISSUED_TOKEN_ADAPTER_IMPLEMENTED";
      ownerSignerOnHost: true;
      autoRenewsToken: true;
      automationScope: "DEDICATED_FLAGSHIP_ONLY";
      signerIsolation: "ROOT_ONLY_SYSTEMD_RENEWAL_UNIT";
      pollerHasSigningMaterial: false;
      originalProvidersAutoRenew: false;
      tokenLifetimeHours: 12;
      expiryBufferSeconds: number;
      pollSeconds: number;
      automaticConversationKinds: string[];
      operatorRequiredConversationKinds: string[];
      rotationEvidence: AacpRuntimeRotationEvidence;
    };
    orderGuard: {
      status: "STRICT_LOCAL_LIFECYCLE_IMPLEMENTED";
      chainId: 56;
      signerOnGuard: false;
      broadcastsTransactions: false;
      abiDecodedIntentBinding: true;
      minedTransactionBinding: true;
      indexerReconciliationRequired: true;
      guardedActions: string[];
    };
    lifecycle: string[];
  };
  marketplace: {
    requiredProviderCount: number;
    registeredIdentityCount: number;
    indexedProviderCount: number;
    publishedListingCount: number;
    onlineProviderCount: number;
    discoveryDegraded: boolean;
    providers: Array<{
      service: ServiceId;
      handle: string;
      agentId: string | null;
      agentTokenId: string | null;
      listingId: string | null;
      listingStatus: string | null;
      listingUrl: string | null;
      liveListingVerified: boolean;
      a2aStatus: string | null;
      presence: string | null;
      verified: boolean;
      status:
        | "HANDLE_AVAILABLE"
        | "HANDLE_UNRESOLVED"
        | "IDENTITY_ONCHAIN"
        | "IDENTITY_ONCHAIN_DISCOVERY_DEGRADED"
        | "AGENT_INDEXED"
        | "LISTED_OFFLINE"
        | "ONLINE_AND_LISTED"
        | "DISCOVERY_UNAVAILABLE"
        | "LISTING_DISCOVERY_UNAVAILABLE"
        | "UPSTREAM_UNAVAILABLE";
      identity: {
        service: ServiceId;
        handle: string;
        agentTokenId: string;
        metadataUrl: string;
        metadataSha256: string;
        description: string;
        tags: string[];
        registrationTransaction: string;
        blockNumber: number;
        blockTimestamp: string;
        gasCostBnb: string;
        owner: string;
        onchainVerified: true;
        explorerUrl: string;
      } | null;
    }>;
    dedicatedFlagship: {
      schemaVersion: "positioncrew.termix-dedicated-lending.v1";
      network: "bsc-mainnet";
      chainId: 56;
      identityRegistry: string;
      service: "LENDING_RESCUE";
      role: "DEDICATED_FLAGSHIP_RUNTIME";
      owner: string;
      onchainVerified: boolean;
      explorerUrl: string;
      handle: string;
      agentId: string;
      agentTokenId: string;
      metadataUrl: string;
      metadataSha256: string;
      registrationTransaction: string;
      blockNumber: number;
      blockTimestamp: string;
      gasCostBnb: string;
      listingId: string;
      listingUrl: string;
      listingStatus: string | null;
      liveListingVerified: boolean;
      a2aStatus: string | null;
      presence: string | null;
      verified: boolean;
      status: "ONLINE_AND_LISTED" | "LISTED_OFFLINE" | "LISTING_DISCOVERY_UNAVAILABLE" | "UPSTREAM_UNAVAILABLE";
      boundaries: string[];
    };
  };
  boundaries: string[];
}

export interface SessionJob {
  response: FixtureJobResponse;
  responseTimeMs: number;
  ranAt: string;
  marketplaceTrace?: FreshMarketplaceChain;
}

export type FreshMarketplaceBenchmarkSlug =
  | "lending-rescue"
  | "lp-rebalance"
  | "yield-optimization"
  | "bounded-grid";
export type HistoricalMarketplaceBenchmarkSlug = Exclude<
  FreshMarketplaceBenchmarkSlug,
  "yield-optimization"
>;

export interface LendingProviderAuditionCheck {
  code:
    | "EXACT_SERVICE_MATCH"
    | "REQUEST_CONTRACT_SUPPORTED"
    | "POSITIONCREW_ACTIVATION_SUPPORTED"
    | "EXECUTION_ADAPTER_AVAILABLE"
    | "OUTPUT_VALIDATOR_AVAILABLE";
  status: "PASS" | "FAIL";
  detail: string;
}

export interface LendingProviderAuditionCandidate {
  candidateId: string;
  name: string;
  relationship: "FIRST_PARTY" | "THIRD_PARTY_COMPARISON_ONLY";
  identity: {
    protocol: "ERC-8004";
    chainId: 56;
    registry: string;
    agentTokenId: string;
    owner: string;
    explorerUrl: string;
    listingUrl: string | null;
  };
  executionAdapter: {
    mode: "POSITIONCREW_IN_PROCESS" | "NONE";
    callable: boolean;
    publicEndpoint: string | null;
    externalProviderInvoked: false;
  };
  eligibility: "ELIGIBLE" | "INELIGIBLE";
  executionState: "SELECTED_PENDING_RUN" | "INELIGIBLE_NOT_INVOKED";
  checks: LendingProviderAuditionCheck[];
}

export interface ExternalProviderAuditionEvidence {
  schemaVersion: "positioncrew.external-provider-audition.v1";
  recordedAt: string;
  chainId: 56;
  provider: {
    name: string;
    address: string;
  };
  commerce: {
    protocol: "ERC-8183";
    jobId: string;
    kernel: string;
    submissionTransaction: string;
    deliverableUrl: string;
    deliverableHash: string;
    contentHashMatchesOnchain: true;
    escrowedAmount: "0.10 U";
    settlementStatus?: "PENDING_OPTIMISTIC_WINDOW";
  };
  job: {
    service: "HEALTH_FACTOR_MONITORING";
    protocol: "Venus Classic";
    account: string;
    deadline: string;
  };
  validation: {
    status: "DELIVERED_INCOMPATIBLE";
    passedChecks: number;
    failedChecks: number;
    checks: Array<{
      code:
        | "IDENTITY_AND_DELIVERY"
        | "CONTENT_HASH"
        | "REQUIRED_POSITION_FIELDS"
        | "PROTOCOL_BINDING"
        | "PROTOCOL_CROSS_CHECK"
        | "BLOCK_ATTRIBUTION";
      status: "PASS" | "FAIL";
      detail: string;
    }>;
    boundary: string;
  };
}

export interface LendingProviderAudition {
  schemaVersion: "positioncrew.lending-provider-audition.v1";
  policyVersion: "positioncrew.lending-provider-eligibility.v1";
  service: "LENDING_RESCUE";
  requestHash: string;
  observation: CurrentMarketplaceObservation;
  evaluatedAt: string;
  candidates: LendingProviderAuditionCandidate[];
  externalProviderAudit?: ExternalProviderAuditionEvidence;
  selection: {
    winnerCandidateId: string;
    winnerProviderId: string;
    winnerProviderSlug: "lending-rescue";
    eligibleCandidateCount: 1;
    basis: "SOLE_ELIGIBLE_CANDIDATE";
  };
  claimBoundary: string[];
  auditionHash: string;
}

export interface CurrentBlockPinnedMarketplaceEvidence {
  lpLiveMatchAudition?: LpLiveMatchAudition;
  schemaVersion: "positioncrew.current-block-pinned-evidence.v1";
  evidenceClass: "CURRENT_BLOCK_PINNED";
  chainId: 56;
  source: CurrentMarketplaceObservation;
  freshnessAtCreation: "FRESH" | "STALE" | "FUTURE_DATED";
  evaluatedAt: string;
  maxDataAgeSeconds: number;
  providerAudition?: LendingProviderAudition;
  externalLendingComparison?: {
    schemaVersion: "positioncrew.external-lending-comparison-summary.v1";
    provider: { name: string; erc8004TokenId: string; endpoint: string };
    evaluatedAt: string;
    account: string;
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
    eligibleForMonitoringActivation: boolean;
    eligibleForRescueSelection: false;
    eligibleForLiveMatch: false;
    checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
    boundary: string;
  };
  externalProviderComparison?: {
    schemaVersion: "positioncrew.external-lp-comparison-summary.v1";
    provider: {
      name: string;
      erc8004TokenId: string;
      endpoint: string;
    };
    evaluatedAt: string;
    positionTokenId: string;
    outcome: "SEMANTICALLY_COMPARABLE" | "INCOMPATIBLE" | "UNAVAILABLE";
    attributableResult: boolean;
    completedSamePositionAssessment: boolean;
    persistedByProvider: boolean;
    externalDecision: "HOLD" | "REBALANCE" | "UNKNOWN";
    firstPartyDecision: string;
    exactRequestAccepted: false;
    eligibleForPositionAssessmentActivation: boolean;
    eligibleForLiveMatch: boolean;
    adapterNormalized?: boolean;
    externalRange?: { lowerTick: number; upperTick: number; widthTicks: number };
    normalizedDeliverable?: FixtureJobResponse["result"]["deliverable"];
    selection?: {
      selectedProvider: "POSITIONCREW" | "EXTERNAL";
      externalEligible: boolean;
      basis: string;
    };
    checks: Array<{
      code: string;
      status: "PASS" | "FAIL";
      detail: string;
    }>;
    boundary: string;
  };
  externalGridComparison?: {
    schemaVersion: "positioncrew.external-grid-comparison-summary.v1";
    provider: { name: string; erc8004TokenId: string; endpoint: string };
    evaluatedAt: string;
    pool: string;
    outcome: "SEMANTICALLY_COMPARABLE" | "PARTIAL_COMPATIBILITY" | "INCOMPATIBLE" | "UNAVAILABLE";
    positionCrewDecision: string;
    externalRecommendation: string | null;
    externalState: string | null;
    tickLower?: number | null;
    tickUpper?: number | null;
    exactRangeAccepted?: boolean;
    attributable: boolean;
    persisted?: boolean;
    exactRequestAccepted: false;
    eligibleForRangeAssessmentActivation: boolean;
    eligibleForGridSelection: boolean;
    eligibleForLiveMatch: boolean;
    adapterNormalized?: boolean;
    providerRange?: {
      widthPct: number;
      lowerPrice: number;
      upperPrice: number;
      netAfterRebalancingUsdInWindow: number;
    } | null;
    measuredWindow?: { fromBlock: number; toBlock: number; swaps: number; minutes: number } | null;
    normalizedDeliverable?: Record<string, unknown>;
    selection?: {
      selectedProvider: "POSITIONCREW" | "EXTERNAL";
      externalEligible: boolean;
      basis: string;
    };
    checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
    boundary: string;
  };
  externalYieldComparison?: {
    schemaVersion: "positioncrew.external-yield-comparison-summary.v1";
    provider: { name: string; erc8004TokenId: string; endpoint: string };
    evaluatedAt: string;
    outcome: "SEMANTICALLY_COMPARABLE" | "PARTIAL_COMPATIBILITY" | "INCOMPATIBLE" | "UNAVAILABLE";
    marketCount: number;
    positionCrewSelectedMarket: string | null;
    externalRecommendedMarket: string | null;
    sameRateLeader: boolean;
    positionCrewGrossApyBps: number | null;
    externalSimpleAnnualRateBps: number | null;
    rateDifferenceBps: number | null;
    attributable: boolean;
    persisted: boolean;
    exactRequestAccepted: false;
    eligibleForRateRankingActivation: boolean;
    eligibleForYieldSelection: boolean;
    eligibleForLiveMatch: boolean;
    adapterNormalized?: boolean;
    normalizedDeliverable?: Record<string, unknown>;
    selection?: {
      selectedProvider: "POSITIONCREW" | "EXTERNAL";
      externalEligible: boolean;
      basis: string;
    };
    checks: Array<{ code: string; status: "PASS" | "FAIL"; detail: string }>;
    boundary: string;
  };
}

export interface HistoricalFixtureMarketplaceEvidence {
  schemaVersion: "positioncrew.historical-fixture-evidence.v1";
  evidenceClass: "HISTORICAL_FIXTURE";
  benchmarkSlug: HistoricalMarketplaceBenchmarkSlug;
  requestSchema: string;
}

export type PersistedMarketplaceEvidence =
  | CurrentBlockPinnedMarketplaceEvidence
  | HistoricalFixtureMarketplaceEvidence;

export type FreshMarketplaceStatus = "HIRE_RECORDED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface FreshMarketplaceChain {
  schemaVersion: "positioncrew.fresh-marketplace-chain.v1";
  claimBoundary: [string, string, string, string];
  hire: {
    hireId: string;
    idempotencyKey: string;
    providerSlug: FreshMarketplaceBenchmarkSlug;
    providerId: string;
    benchmarkSlug: FreshMarketplaceBenchmarkSlug;
    service: ServiceId;
    evidenceMode: "HISTORICAL_FIXTURE" | "CURRENT_BLOCK_PINNED";
    commerce: { directCostUsd: "0.00"; walletRequired: false; settlement: "NO_PAYMENT" };
    request: Record<string, unknown>;
    requestHash: string;
    evidence: PersistedMarketplaceEvidence | null;
    evidenceHash?: string;
    providerHash?: string;
    createdAt: string;
  };
  job: {
    jobId: string;
    state: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED";
    providerSelection?: LpLiveMatchProviderSelection | null;
    providerSelectionHash?: string | null;
    status: FreshMarketplaceStatus;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    apiDurationMilliseconds: number | null;
    error: { code: string; message: string } | null;
  };
  receipt: {
    receiptId: string;
    publicUrl: string;
    responseHash: string;
    deliverableHash: string;
    evaluationHash: string;
    createdAt: string;
    response: FixtureJobResponse;
  } | null;
}

export interface ChainProbe {
  chainId: 56 | 97;
  name: string;
  blockNumber: string;
  blockTimestamp: string;
  blockAgeSeconds: number;
  gasPriceGwei: string;
  rpcLatencyMs: number;
  rpcUrl: string;
  explorerUrl: string;
}

export interface SystemTelemetry {
  schemaVersion: "positioncrew.system-telemetry.v1";
  generatedAt: string;
  mainnet: ChainProbe;
  testnet: ChainProbe;
  market: {
    pair: "WBNB/USDT";
    venue: "PancakeSwap V3";
    poolAddress: string;
    feeTier: 100;
    spotPriceUsd: string;
    tick: number;
    liquidityRaw: string;
    observedAt: string;
    explorerUrl: string;
  };
  venus: {
    market: "vUSDT";
    address: string;
    supplyAprPct: string;
    borrowAprPct: string;
    availableLiquidityUsd: string;
    totalBorrowsUsd: string;
    observedAt: string;
    explorerUrl: string;
  };
}

export interface ProductionMonitorEpoch {
  schemaVersion: "positioncrew.production-monitor-epoch.v1";
  startedAt: string;
  baseUrl: string;
  workflow: {
    owner: string;
    repository: string;
    file: string;
    url: string;
    snapshotUrl: string;
    event: "schedule";
    cadenceMinutes: number;
  };
  verification: {
    expectedCheckCountAtEpoch: number;
    scope: string[];
  };
  aggregation: {
    coverage: "LATEST_100_SCHEDULED_RUNS";
    excludeEvents: string[];
  };
  boundary: string;
}

export interface ProductionTrackRecord {
  schemaVersion: "positioncrew.production-track-record.v1";
  generatedAt: string;
  status: "COLLECTING" | "OPERATIONAL" | "DEGRADED" | "SOURCE_UNAVAILABLE";
  epoch: ProductionMonitorEpoch;
  source: {
    provider: "GITHUB_ACTIONS_SNAPSHOT";
    snapshotUrl: string;
    workflowUrl: string;
    sourceStatus: "AVAILABLE" | "UNAVAILABLE";
  };
  summary: {
    totalScheduledRunsSinceEpoch: number | null;
    observedRunCount: number;
    completedRuns: number;
    successfulRuns: number;
    unsuccessfulRuns: number;
    pendingRuns: number;
    rollingPassRatePct: number | null;
    rollingWindowStartedAt: string | null;
    rollingWindowEndedAt: string | null;
  };
  runs: Array<{
    runId: number;
    status: string;
    conclusion: string | null;
    createdAt: string;
    completedAt: string | null;
    headSha: string;
    url: string;
  }>;
  boundary: string;
}

export interface VenusAccountProbe {
  schemaVersion: "positioncrew.venus-account-probe.v1";
  generatedAt: string;
  chainId: 56;
  account: string;
  state: "NO_POSITION" | "LIQUID" | "SHORTFALL";
  nativeBalanceBnb: string;
  usdtBalance: string;
  liquidityUsd: string;
  shortfallUsd: string;
  enteredMarkets: string[];
  position: {
    collateralValueUsd: string;
    liquidationWeightedCollateralUsd: string;
    debtValueUsd: string;
    healthFactor: string | null;
    markets: Array<{
      vToken: string;
      symbol: string;
      underlying: string;
      decimals: number;
      suppliedAmount: string;
      borrowedAmount: string;
      walletAmount: string;
      priceUsd: string;
      collateralFactorBps: number;
      liquidationThresholdBps: number;
      collateralEnabled: boolean;
    }>;
  };
  rescueRequest: FixtureJobResponse["result"]["request"] | null;
  source: {
    comptroller: string;
    blockNumber: string;
    explorerUrl: string;
  };
  boundary: string;
}

export interface PancakeGridProbe {
  schemaVersion: "positioncrew.pancake-grid-probe.v1";
  generatedAt: string;
  chainId: 56;
  state: "READY";
  market: {
    pair: "WBNB/USDT";
    poolAddress: string;
    feeTier: 100;
    spotPriceUsd: string;
    activeLiquidityUsd: string;
    reserveValueUsd: string;
    realizedVolatilityBps: number;
    volatilityWindowSeconds: number;
    volatilitySampleCount: number;
  };
  gridRequest: FixtureJobResponse["result"]["request"];
  source: {
    blockNumber: string;
    blockTimestamp: string;
    explorerUrl: string;
    poolExplorerUrl: string;
  };
  boundary: string;
}

export type BoundedGridForwardShadowState =
  | "PRECOMMITTED"
  | "REFUSED"
  | "CLOSED"
  | "VOID_SOURCE_GAP"
  | "RISK_EXIT";

export type BoundedGridForwardShadowLedgerStatus =
  | "COLLECTING"
  | "MATURE"
  | "DEGRADED"
  | "SOURCE_UNAVAILABLE";

export interface BoundedGridForwardShadowWindow {
  windowId: string;
  state: BoundedGridForwardShadowState;
  pair: "WBNB/USDT";
  sourceHireId: string | null;
  sourceRequestHash: string | null;
  sourceReceiptUrl: string | null;
  sourceBlockNumber: string | null;
  startedAt: string;
  terminalAt: string | null;
  horizonMinutes: 15;
  sampledCrossings: number;
  simulatedNetOutcomeUsd: string | null;
  receiptUrl: string;
  eventHash: string;
  previousEventHash: string | null;
}

export interface BoundedGridForwardShadowLedger {
  schemaVersion: "positioncrew.bounded-grid-forward-shadow-ledger.v1";
  generatedAt: string;
  status: BoundedGridForwardShadowLedgerStatus;
  publicUrl: string;
  model: {
    name: "CONSERVATIVE_SAMPLED_CROSSING_V1";
    strategyVersion: "positioncrew:bounded-grid-forward-shadow:v1";
    pair: "WBNB/USDT";
    capitalMode: "ZERO_FUND_SHADOW";
    cadenceMinutes: 60;
    sampleCadenceMinutes: 5;
    horizonMinutes: 15;
  };
  maturity: {
    observedDays: number;
    terminalWindowCount: number;
    minimumObservedDays: 7;
    minimumTerminalWindows: 30;
    nonVoidRatePct: number | null;
    minimumNonVoidRatePct: 90;
    hashChainValid: boolean;
    mature: boolean;
  };
  summary: {
    precommittedWindowCount: number;
    terminalWindowCount: number;
    closedWindowCount: number;
    refusedWindowCount: number;
    voidWindowCount: number;
    riskExitWindowCount: number;
    positiveWindowCount: number;
    negativeWindowCount: number;
    simulatedNetOutcomeUsd: string | null;
  };
  recentWindows: BoundedGridForwardShadowWindow[];
  claimBoundary: string[];
}

export interface PancakePositionProbe {
  schemaVersion: "positioncrew.pancake-position-probe.v1";
  generatedAt: string;
  chainId: 56;
  state: "READY";
  position: {
    tokenId: string;
    owner: string;
    custody: "DIRECT_OR_OTHER" | "MASTER_CHEF_V3";
    positionManager: string;
    pool: string;
    pair: "USDT/WBNB";
    feeTier: number;
    lowerTick: number;
    upperTick: number;
    currentTick: number;
    inRange: boolean;
    liquidity: string;
    token0Amount: string;
    token1Amount: string;
    positionValueUsd: string;
    uncollectedFeesUsd: string;
  };
  market: {
    activeLiquidityUsd: string;
    realizedVolatilityBps: number;
    volumeRunRate24hUsd: string;
    feesRunRate24hUsd: string;
    measurementWindowSeconds: number;
    swapCount: number;
  };
  lpRequest: FixtureJobResponse["result"]["request"];
  source: {
    blockNumber: string;
    blockTimestamp: string;
    explorerUrl: string;
    positionExplorerUrl: string;
    poolExplorerUrl: string;
  };
  boundary: string;
}

export interface VenusYieldProbe {
  schemaVersion: "positioncrew.venus-yield-probe.v1";
  generatedAt: string;
  chainId: 56;
  state: "READY";
  markets: Array<{
    opportunityId: string;
    symbol: string;
    vToken: string;
    underlying: string;
    baseSupplyApyBps: number;
    availableLiquidityUsd: string;
  }>;
  yieldRequest: FixtureJobResponse["result"]["request"];
  source: {
    comptroller: string;
    oracle: string;
    blockNumber: string;
    blockTimestamp: string;
    measuredSecondsPerBlock: number;
    explorerUrl: string;
  };
  boundary: string;
}

export type TermixBenchmarkService = "LENDING_RESCUE" | "LP_REBALANCE" | "BOUNDED_GRID";
export type TermixBenchmarkSlug = "lending-rescue" | "lp-rebalance" | "bounded-grid";

export type AgentAdvantagePublicationStatus =
  | {
      schemaVersion: "positioncrew.agent-advantage-publication.v1";
      status: "PENDING_INDEPENDENT_BLIND_EVALUATION";
      reportUrl: null;
      reportHash: null;
      evidenceManifestHash: null;
      publishedAt: null;
      taskCount: 3;
      supportedAdvantageCount: null;
      agentBlindQualityScore: null;
      boundary: string;
    }
  | {
      schemaVersion: "positioncrew.agent-advantage-publication.v1";
      status: "PUBLISHED";
      reportUrl: "/evidence/agent-advantage/";
      reportHash: string;
      evidenceManifestHash: string;
      publishedAt: string;
      taskCount: 3;
      supportedAdvantageCount: number;
      agentBlindQualityScore: number;
      boundary: string;
    };

export type FounderAgentAdvantagePublicationStatus =
  | {
      schemaVersion: "positioncrew.founder-agent-advantage-publication.v1";
      status: "PENDING_FOUNDER_COMPARISON";
      reportUrl: null;
      reportHash: null;
      evidenceManifestHash: null;
      publishedAt: null;
      taskCount: 3;
      exactOutputParityCount: null;
      recordedSpeedAdvantageCount: null;
      qualityMethod: "CANONICAL_EXACT_OUTPUT_PARITY";
      qualityScore: null;
      independent: false;
      blind: false;
      boundary: string;
    }
  | {
      schemaVersion: "positioncrew.founder-agent-advantage-publication.v1";
      status: "PUBLISHED";
      reportUrl: "/evidence/agent-advantage-founder/";
      reportHash: string;
      evidenceManifestHash: string;
      publishedAt: string;
      taskCount: 3;
      exactOutputParityCount: number;
      recordedSpeedAdvantageCount: number;
      qualityMethod: "CANONICAL_EXACT_OUTPUT_PARITY";
      qualityScore: null;
      independent: false;
      blind: false;
      boundary: string;
    };

export type PublicationLoadState = "LOADING" | "AVAILABLE" | "UNAVAILABLE";

const SHA256_COMMITMENT = /^sha256:[a-f0-9]{64}$/;

export function isVerifiedFounderAgentAdvantagePublication(
  value: unknown,
): value is Extract<FounderAgentAdvantagePublicationStatus, { status: "PUBLISHED" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const publishedAt = record.publishedAt;
  const boundary = typeof record.boundary === "string" ? record.boundary.toLowerCase() : "";
  return (
    record.schemaVersion === "positioncrew.founder-agent-advantage-publication.v1" &&
    record.status === "PUBLISHED" &&
    record.reportUrl === "/evidence/agent-advantage-founder/" &&
    typeof record.reportHash === "string" &&
    SHA256_COMMITMENT.test(record.reportHash) &&
    typeof record.evidenceManifestHash === "string" &&
    SHA256_COMMITMENT.test(record.evidenceManifestHash) &&
    typeof publishedAt === "string" &&
    !Number.isNaN(Date.parse(publishedAt)) &&
    new Date(publishedAt).toISOString() === publishedAt &&
    record.taskCount === 3 &&
    record.exactOutputParityCount === 3 &&
    record.recordedSpeedAdvantageCount === 3 &&
    record.qualityMethod === "CANONICAL_EXACT_OUTPUT_PARITY" &&
    record.qualityScore === null &&
    record.independent === false &&
    record.blind === false &&
    boundary.includes("founder-operated") &&
    boundary.includes("non-independent") &&
    boundary.includes("non-blind") &&
    boundary.includes("e3_server_persisted") &&
    boundary.includes("server-persisted") &&
    boundary.includes("historical-fixture") &&
    boundary.includes("no-wallet") &&
    boundary.includes("does not establish paid commerce") &&
    boundary.includes("external")
  );
}

export interface FounderAgentAdvantageTaskAtAGlance {
  service: TermixBenchmarkService;
  benchmarkSlug: TermixBenchmarkSlug;
  taskId: string;
  title: string;
  category: string;
  agentElapsedMilliseconds: number;
  manualElapsedMilliseconds: number;
  agentDirectCostUsd: "0.00";
  manualDirectCostUsd: "0";
  receiptUrl: string;
  exactCanonicalParity: true;
}

export interface FounderAgentAdvantageAtAGlance {
  reportHash: string;
  evidenceManifestHash: string;
  reportUrl: "/evidence/agent-advantage-founder/";
  tasks: FounderAgentAdvantageTaskAtAGlance[];
}

export type FounderAgentAdvantageAtAGlanceLoadState = "IDLE" | PublicationLoadState;

const FOUNDER_GLANCE_TASKS = [
  {
    benchmarkSlug: "lending-rescue",
    service: "LENDING_RESCUE",
    taskId: "venus-stressed-position-20260812-001",
    title: "Bounded lending-position rescue",
    category: "Lending risk",
  },
  {
    benchmarkSlug: "lp-rebalance",
    service: "LP_REBALANCE",
    taskId: "v3-out-of-range-20260812-001",
    title: "Bounded concentrated-liquidity rebalance",
    category: "Liquidity management",
  },
  {
    benchmarkSlug: "bounded-grid",
    service: "BOUNDED_GRID",
    taskId: "bounded-grid-20260812-001",
    title: "Bounded BNB-USDT grid construction",
    category: "Trading controls",
  },
] as const satisfies ReadonlyArray<{
  benchmarkSlug: TermixBenchmarkSlug;
  service: TermixBenchmarkService;
  taskId: string;
  title: string;
  category: string;
}>;

function founderObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function founderCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(founderCanonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${founderCanonicalJson(child)}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  throw new TypeError(`Unsupported canonical value type: ${typeof value}`);
}

async function founderCanonicalSha256(value: unknown): Promise<string | null> {
  try {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(founderCanonicalJson(value)),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex}`;
  } catch {
    return null;
  }
}

export async function projectFounderAgentAdvantageAtAGlance(
  value: unknown,
  publication: FounderAgentAdvantagePublicationStatus,
): Promise<FounderAgentAdvantageAtAGlance | null> {
  if (!isVerifiedFounderAgentAdvantagePublication(publication)) return null;
  const report = founderObject(value);
  if (!report) return null;
  if (
    report.schemaVersion !== "positioncrew.founder-agent-advantage-report.v2" ||
    report.reportHash !== publication.reportHash ||
    report.evidenceManifestHash !== publication.evidenceManifestHash ||
    report.comparisonMode !== "FOUNDER_OPERATED_NON_INDEPENDENT_NON_BLIND" ||
    report.qualityMethod !== "CANONICAL_EXACT_OUTPUT_PARITY" ||
    report.qualityScore !== null
  ) return null;

  const evidenceManifest = founderObject(report.evidenceManifest);
  if (!evidenceManifest) return null;
  const { reportHash: _declaredReportHash, ...reportBody } = report;
  const [computedReportHash, computedEvidenceManifestHash] = await Promise.all([
    founderCanonicalSha256(reportBody),
    founderCanonicalSha256(evidenceManifest),
  ]);
  if (
    computedReportHash !== publication.reportHash ||
    computedEvidenceManifestHash !== publication.evidenceManifestHash
  ) return null;

  const summary = founderObject(report.summary);
  const boundaries = Array.isArray(report.claimBoundary)
    ? report.claimBoundary.filter((item): item is string => typeof item === "string")
    : [];
  const boundary = boundaries.join(" ").toLowerCase();
  if (
    !summary ||
    summary.taskCount !== 3 ||
    summary.exactOutputParityCount !== 3 ||
    summary.recordedSpeedAdvantageCount !== 3 ||
    summary.directCostUsd !== "0" ||
    summary.marketplaceEvidenceStatus !== "E3_SERVER_PERSISTED" ||
    !boundary.includes("founder-operated") ||
    !boundary.includes("non-independent") ||
    !boundary.includes("non-blind") ||
    !boundary.includes("historical fixtures") ||
    !boundary.includes("different execution contexts")
  ) return null;

  if (!Array.isArray(report.tasks) || report.tasks.length !== FOUNDER_GLANCE_TASKS.length) {
    return null;
  }

  const tasks: FounderAgentAdvantageTaskAtAGlance[] = [];
  const receiptUrls = new Set<string>();
  for (const [index, spec] of FOUNDER_GLANCE_TASKS.entries()) {
    const task = founderObject(report.tasks[index]);
    const quality = founderObject(task?.quality);
    const agent = founderObject(task?.agent);
    const manual = founderObject(task?.manual);
    const marketplace = founderObject(task?.marketplace);
    if (!task || !quality || !agent || !manual || !marketplace) return null;

    const agentElapsed = agent.officialElapsedMilliseconds;
    const manualElapsed = manual.elapsedMilliseconds;
    const receiptId = marketplace.receiptId;
    const receiptUrl = marketplace.receiptUrl;
    const deliverableHash = marketplace.deliverableHash;
    if (
      task.benchmarkSlug !== spec.benchmarkSlug ||
      task.taskId !== spec.taskId ||
      task.title !== spec.title ||
      task.category !== spec.category ||
      quality.method !== "CANONICAL_EXACT_OUTPUT_PARITY" ||
      quality.exactCanonicalParity !== true ||
      quality.qualityScore !== null ||
      quality.verdict !== "IDENTICAL_CANONICAL_OUTPUT" ||
      agent.officialTimingSource !== "POSITIONCREW_D1_HIRE_API_DURATION" ||
      !positiveInteger(agentElapsed) ||
      !positiveInteger(manualElapsed) ||
      manualElapsed <= agentElapsed ||
      marketplace.apiDurationMilliseconds !== agentElapsed ||
      agent.directCostUsd !== "0.00" ||
      manual.directCostUsd !== "0" ||
      marketplace.evidenceStatus !== "E3_SERVER_PERSISTED" ||
      marketplace.journey !== "FOUNDER_PUBLIC_WORKSPACE_COMPARISON" ||
      marketplace.evidenceMode !== "FRESH_SERVER_PERSISTED_HISTORICAL_FIXTURE_HIRE" ||
      marketplace.serverEvidenceMode !== "HISTORICAL_FIXTURE" ||
      marketplace.state !== "COMPLETED" ||
      marketplace.status !== "COMPLETED" ||
      marketplace.hireProven !== true ||
      marketplace.externalBuyer !== false ||
      marketplace.uniqueServerHire !== true ||
      marketplace.paid !== false ||
      marketplace.freshServerPersistenceProven !== true ||
      marketplace.freshUnderlyingAnalysisProven !== false ||
      typeof receiptId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(receiptId) ||
      typeof receiptUrl !== "string" ||
      receiptUrl !== `https://positioncrew.dolepee.com/api/benchmark-receipts/${receiptId}` ||
      agent.receiptId !== receiptId ||
      agent.receiptUrl !== receiptUrl ||
      typeof deliverableHash !== "string" ||
      !SHA256_COMMITMENT.test(deliverableHash) ||
      agent.deliverableHash !== deliverableHash ||
      manual.outputHash !== deliverableHash
    ) return null;

    receiptUrls.add(receiptUrl);
    tasks.push({
      service: spec.service,
      benchmarkSlug: spec.benchmarkSlug,
      taskId: spec.taskId,
      title: spec.title,
      category: spec.category,
      agentElapsedMilliseconds: agentElapsed,
      manualElapsedMilliseconds: manualElapsed,
      agentDirectCostUsd: "0.00",
      manualDirectCostUsd: "0",
      receiptUrl,
      exactCanonicalParity: true,
    });
  }
  if (receiptUrls.size !== tasks.length) return null;

  return {
    reportHash: publication.reportHash,
    evidenceManifestHash: publication.evidenceManifestHash,
    reportUrl: publication.reportUrl,
    tasks,
  };
}

export interface BenchmarkRepeatabilityResponse {
  schemaVersion: "positioncrew.benchmark-repeatability.v1";
  generatedAt: string;
  benchmarkSlug: TermixBenchmarkSlug;
  service: TermixBenchmarkService;
  taskId: string;
  status: "REPRODUCIBLE_AGENT_REPEATS_MANUAL_PENDING";
  benchmarkLock: {
    schemaVersion: "positioncrew.benchmark-lock.v1";
    taskId: string;
    fixtureHash: string;
    rubricHash: string;
    protocolHash: string;
  };
  runs: Array<{
    runId: string;
    elapsedMilliseconds: number;
    directCostUsd: "0.00";
    qualityScore: number;
    criticalFailureCount: number;
    outputHash: string;
  }>;
  medianElapsedMilliseconds: number;
  pending: ["MANUAL_BASELINE", "INDEPENDENT_BLIND_SCORECARD"];
  boundary: string;
}

export interface BenchmarkRepeatabilityMatrixResponse {
  schemaVersion: "positioncrew.benchmark-repeatability-matrix.v1";
  generatedAt: string;
  records: BenchmarkRepeatabilityResponse[];
  pending: ["MANUAL_BASELINES", "INDEPENDENT_BLIND_SCORECARDS"];
  boundary: string;
}

export interface AgentCaptureManifestResponse {
  schemaVersion: "positioncrew.agent-capture-commitments.v1";
  createdAt: string;
  source: { repository: string; commitSha: string };
  benchmarks: Array<{
    benchmarkSlug: TermixBenchmarkSlug;
    sessionId: string;
    providerId: string;
    benchmarkLock: {
      schemaVersion: "positioncrew.benchmark-lock.v1";
      taskId: string;
      fixtureHash: string;
      rubricHash: string;
      protocolHash: string;
    };
    candidates: Array<{
      runNumber: number;
      candidateHash: string;
      outputHash: string;
      evaluationHash: string;
    }>;
  }>;
  boundary: string;
  manifestHash: string;
}

export interface MarketplaceInvocationEvidence {
  schemaVersion: "positioncrew.marketplace-invocation-evidence.v1";
  protocolHash: string;
  capturedAt: string;
  source: {
    productionBaseUrl: string;
    productionVersion: number;
    productionCommitSha: string;
    protocolCommitSha: string;
    protocolUrl: string;
  };
  records: Array<{
    sequenceNumber: number;
    benchmarkSlug: TermixBenchmarkSlug;
    service: TermixBenchmarkService;
    runNumber: number;
    endpointUrl: string;
    startedAt: string;
    completedAt: string;
    elapsedMilliseconds: number;
    directCostUsd: "0.00";
    walletRequired: false;
    httpStatus: number;
    success: boolean;
    observation: {
      evidenceMode: "FROZEN_BSC_TEST_FIXTURE";
      commerceMode: "IN_MEMORY_CONFORMANCE";
      receiptMode: "PUBLIC_REPRODUCIBLE";
      receiptUrl: string;
      jobId: string;
      jobState: "COMPLETED";
      jobHistory: string[];
      providerId: string;
      outputHash: string;
      evaluationHash: string;
      conformanceScore: 100;
      criticalFailureCount: 0;
      responseHash: string;
    } | null;
    error: string | null;
  }>;
  summaries: Array<{
    benchmarkSlug: TermixBenchmarkSlug;
    service: TermixBenchmarkService;
    attemptCount: 2;
    successCount: number;
    medianElapsedMilliseconds: number | null;
    outputHashesMatch: boolean;
    evaluationHashesMatch: boolean;
  }>;
  aggregate: {
    plannedAttemptCount: 6;
    recordedAttemptCount: 6;
    successCount: number;
    allAttemptsSucceeded: boolean;
  };
  boundaries: string[];
  evidenceHash: string;
}

export interface Erc8183TestnetLedger {
  schemaVersion: "positioncrew.erc8183-testnet-ledger.v1";
  capturedAt: string;
  network: { name: string; chainId: 97; explorer: string };
  protocol: {
    name: string;
    commerce: string;
    router: string;
    policy: string;
    paymentToken: string;
    paymentTokenSymbol: "U";
    paymentTokenDecimals: 18;
    disputeWindowSeconds: 900;
    voteQuorum: 1;
    platformFeeBps: 0;
    deploymentSource: string;
    deploymentSourceCommit: string;
  };
  parties: {
    client: string;
    provider: string;
    relationship: "SAME_DISCLOSED_OPERATOR_SEPARATE_WALLETS";
  };
  summary: {
    completedLifecycles: number;
    fundedCompletedJobs: number;
    zeroPricePathProbes: number;
    mandatoryCategoriesCovered: number;
    totalEscrowBaseUnits: string;
    totalEscrowDisplay: string;
    externalBuyerJobs: 0;
    externalRevenue: "0";
  };
  claimBoundary: string[];
  jobs: Array<{
    jobId: number;
    service: ServiceId;
    providerAgentId: number;
    runType: "ZERO_PRICE_PATH_PROBE" | "FUNDED_CATEGORY_RECEIPT" | "FUNDED_REPEAT_RECEIPT";
    budgetBaseUnits: string;
    status: "COMPLETED";
    manifestUrl: string;
    manifestHash: string;
    transactions: {
      create: string;
      setBudget: string;
      register: string;
      fund: string;
      submit: string;
      settle: string;
    };
    completedAt: string;
    completionBlock: number;
  }>;
}
