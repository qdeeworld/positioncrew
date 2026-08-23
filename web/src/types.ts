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

export interface FixtureJobResponse {
  schemaVersion: "positioncrew.fixture-job-response.v1";
  evidenceMode: "FROZEN_BSC_TEST_FIXTURE" | "CALLER_SUPPLIED_OBSERVATIONS";
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

export type FreshMarketplaceBenchmarkSlug = "lending-rescue" | "lp-rebalance" | "bounded-grid";
export type FreshMarketplaceStatus = "HIRE_RECORDED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface FreshMarketplaceChain {
  schemaVersion: "positioncrew.fresh-marketplace-chain.v1";
  claimBoundary: [string, string, string, string];
  hire: {
    hireId: string;
    idempotencyKey: string;
    providerSlug: "lending-rescue" | "lp-rebalance" | "bounded-grid";
    providerId: string;
    benchmarkSlug: FreshMarketplaceBenchmarkSlug;
    service: "LENDING_RESCUE" | "LP_REBALANCE" | "BOUNDED_GRID";
    evidenceMode: "HISTORICAL_FIXTURE";
    commerce: { directCostUsd: "0.00"; walletRequired: false; settlement: "NO_PAYMENT" };
    request: Record<string, unknown>;
    requestHash: string;
    createdAt: string;
  };
  job: {
    jobId: string;
    state: "CREATED" | "RUNNING" | "COMPLETED" | "FAILED";
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
