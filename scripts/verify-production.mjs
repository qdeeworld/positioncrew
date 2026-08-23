import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
} from "viem";

const baseUrl = new URL(
  process.env.POSITIONCREW_BASE_URL ?? "https://positioncrew.dolepee.com",
);
const outputPath = resolve(
  process.env.POSITIONCREW_HEALTH_OUTPUT ?? "/tmp/positioncrew-production-health.json",
);
const expectedServices = new Set([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);
const expectedAacpAgentTokenIds = new Set(["266229", "266231", "266232", "266234"]);
const expectedAacpListings = new Map([
  ["266229", "cmsrfz5ze0t4otn01pm8bdane"],
  ["266231", "cmsrg0fq00td7tn01awonk3td"],
  ["266232", "cmsrg1lr20tkytn01gs2ynens"],
  ["266234", "cmsrg2czh0tohtn01ng23b34c"],
]);
const expectedAacpOwner = "0xbad35fa6e368e90fc4faf63507f2d0a2fdf94baf";
const referencePancakePositionId = "1456267";
const checks = [];
const monitorRunId = String(Date.now());
const monitorRequestTimeoutMs = 15_000;
const bscTestnetRpc =
  process.env.BSC_TESTNET_RPC_URL ?? "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
const bscTestnet = defineChain({
  id: 97,
  name: "BSC Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [bscTestnetRpc] } },
});
const identityClient = createPublicClient({ chain: bscTestnet, transport: http() });
const identityAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);
const erc8183CommerceAbi = parseAbi([
  "function getJob(uint256 jobId) view returns ((uint256 id,address client,address provider,address evaluator,string description,uint256 budget,uint256 expiredAt,uint8 status,address hook,uint256 submittedAt,bytes32 deliverable))",
  "function paymentToken() view returns (address)",
  "function platformFeeBP() view returns (uint256)",
]);
const erc8183RouterAbi = parseAbi([
  "function policyWhitelist(address policy) view returns (bool)",
  "event JobRegistered(uint256 indexed jobId,address indexed policy,address indexed client)",
]);
const erc8183PolicyAbi = parseAbi([
  "function disputeWindow() view returns (uint256)",
  "function voteQuorum() view returns (uint256)",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function localUrl(input) {
  const url = new URL(input, baseUrl);
  assert(url.origin === baseUrl.origin, `Refusing cross-origin discovery URL: ${url}`);
  return url;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function canonicalSha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fetchReadOnly(url, init) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(monitorRequestTimeoutMs),
      });
      if (attempt === 1 && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        await sleep(250);
        continue;
      }
      return { response, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
      await sleep(250);
    }
  }
  throw lastError;
}

async function fetchText(name, input) {
  const url = localUrl(input);
  url.searchParams.set("positioncrew_monitor", monitorRunId);
  const startedAt = performance.now();
  const { response, attempts } = await fetchReadOnly(url, {
    headers: {
      Accept: "text/html",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
    },
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.text();
  checks.push({ name, url: url.toString(), status: response.status, latencyMs, attempts });
  assert(response.ok, `${name} returned HTTP ${response.status}`);
  return body;
}

async function fetchJson(name, input) {
  const url = localUrl(input);
  url.searchParams.set("positioncrew_monitor", monitorRunId);
  const startedAt = performance.now();
  const { response, attempts } = await fetchReadOnly(url, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
    },
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.json().catch(() => null);
  checks.push({ name, url: url.toString(), status: response.status, latencyMs, attempts });
  const failureDetail = body && typeof body === "object"
    ? `: ${JSON.stringify(body).slice(0, 500)}`
    : "";
  assert(response.ok, `${name} returned HTTP ${response.status}${failureDetail}`);
  assert(body && typeof body === "object", `${name} did not return a JSON object`);
  return body;
}

async function postJson(name, input, payload) {
  const url = localUrl(input);
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "PositionCrew-Production-Monitor/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const body = await response.json().catch(() => null);
  checks.push({ name, url: url.toString(), status: response.status, latencyMs });
  assert(response.ok, `${name} returned HTTP ${response.status}`);
  assert(body && typeof body === "object", `${name} did not return a JSON object`);
  return body;
}

function rebaseObservationTimes(value, observedAt) {
  if (Array.isArray(value)) {
    return value.map((item) => rebaseObservationTimes(item, observedAt));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "observedAt" ? observedAt : rebaseObservationTimes(child, observedAt),
    ]),
  );
}

function buildMonitorRequest(request, now) {
  const observedAt = now.toISOString();
  const next = rebaseObservationTimes(structuredClone(request), observedAt);
  next.requestId = `production-monitor-${String(request.service).toLowerCase()}-${now.getTime()}`;
  next.requestedAt = observedAt;
  next.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();
  return next;
}

function decodeAgentUri(agentUri) {
  const separator = agentUri.indexOf(",");
  assert(separator > 0, "ERC-8004 agent URI is not a data URI");
  const metadata = agentUri.slice(0, separator);
  const payload = agentUri.slice(separator + 1);
  const json = metadata.endsWith(";base64")
    ? Buffer.from(payload, "base64").toString("utf8")
    : decodeURIComponent(payload);
  return JSON.parse(json);
}

async function verifyIdentity(entry) {
  const identity = entry.identity;
  assert(identity?.protocol === "ERC-8004", `${entry.service} has no ERC-8004 identity`);
  assert(identity.chainId === 97, `${entry.service} identity is not on BSC testnet`);
  const startedAt = performance.now();
  const contract = { address: identity.registry, abi: identityAbi };
  const [owner, agentUri, receipt] = await Promise.all([
    identityClient.readContract({ ...contract, functionName: "ownerOf", args: [BigInt(identity.agentId)] }),
    identityClient.readContract({ ...contract, functionName: "tokenURI", args: [BigInt(identity.agentId)] }),
    identityClient.getTransactionReceipt({ hash: identity.registrationTransaction }),
  ]);
  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  checks.push({
    name: `${entry.service}:erc8004-identity`,
    url: bscTestnetRpc,
    status: 200,
    latencyMs,
  });
  assert(owner.toLowerCase() === identity.owner.toLowerCase(), `${entry.service} identity owner mismatch`);
  assert(receipt.status === "success", `${entry.service} registration transaction failed`);
  const registration = decodeAgentUri(agentUri);
  assert(registration.name?.startsWith("PositionCrew "), `${entry.service} identity name mismatch`);
  const discoveredManifest = new URL(entry.manifestUrl);
  assert(
    registration.services?.some((service) => {
      const registeredEndpoint = new URL(service.endpoint);
      return (
        registeredEndpoint.protocol === "https:" &&
        registeredEndpoint.hostname === "positioncrew.dolepee.com" &&
        registeredEndpoint.pathname === discoveredManifest.pathname
      );
    }),
    `${entry.service} identity does not bind its manifest`,
  );
  return { agentId: identity.agentId, owner, registrationTransaction: identity.registrationTransaction };
}

const report = {
  schemaVersion: "positioncrew.production-health-report.v1",
  checkedAt: new Date().toISOString(),
  baseUrl: baseUrl.origin,
  status: "FAILED",
  checks,
  providers: [],
  error: null,
};

try {
  const marketplace = await fetchJson(
    "marketplace-manifest",
    "/.well-known/positioncrew.json",
  );
  assert(
    marketplace.schemaVersion === "positioncrew.marketplace-manifest.v1",
    "Unexpected marketplace manifest schema",
  );
  assert(Array.isArray(marketplace.providers), "Marketplace providers are missing");
  assert(marketplace.providers.length === 4, "Marketplace must expose exactly four providers");
  assert(
    marketplace.claims?.settlement === "IN_MEMORY_CONFORMANCE",
    "Marketplace settlement boundary changed unexpectedly",
  );
  assert(
    marketplace.claims?.providerIdentity === "ERC8004_BSC_TESTNET_VERIFIED",
    "Marketplace identity claim changed unexpectedly",
  );
  assert(
    marketplace.claims?.judgeTrial === "NO_WALLET_PROVIDER_CALL",
    "Marketplace judge-trial boundary changed unexpectedly",
  );
  assert(
    marketplace.claims?.aacp === "PRODUCTION_RUNTIME_PENDING",
    "Marketplace AACP claim boundary changed unexpectedly",
  );
  assert(
    new URL(marketplace.operatingRecordUrl).origin === baseUrl.origin,
    "Marketplace operating record is not canonical",
  );
  assert(
    new URL(marketplace.marketplaceDeliveryEvidenceUrl).origin === baseUrl.origin,
    "Marketplace delivery evidence is not canonical",
  );
  assert(
    new URL(marketplace.aacpReadinessUrl).origin === baseUrl.origin,
    "Marketplace AACP readiness record is not canonical",
  );

  const aacpReadiness = await fetchJson(
    "aacp-production-readiness",
    marketplace.aacpReadinessUrl,
  );
  assert(
    aacpReadiness.schemaVersion === "positioncrew.aacp-production-readiness.v1",
    "Unexpected AACP readiness schema",
  );
  assert(aacpReadiness.network?.chainId === 56, "AACP readiness is not on BNB Chain");
  assert(
    aacpReadiness.state !== "SOURCE_UNAVAILABLE" &&
      aacpReadiness.state !== "PROTOCOL_DEGRADED" &&
      aacpReadiness.state !== "MARKETPLACE_DISCOVERY_DEGRADED",
    `AACP production rail is ${aacpReadiness.state}`,
  );
  assert(
    aacpReadiness.protocol?.contractCount > 0 &&
      aacpReadiness.protocol.deployedCount === aacpReadiness.protocol.contractCount,
    "AACP production contract bytecode is incomplete",
  );
  assert(
    aacpReadiness.protocol?.currencies?.map((currency) => currency.symbol).join(",") ===
      "USDC,USDT",
    "AACP production settlement currencies changed",
  );
  assert(
    aacpReadiness.marketplace?.requiredProviderCount === 4 &&
      aacpReadiness.marketplace.providers?.length === 4,
    "AACP readiness does not cover all four PositionCrew providers",
  );
  assert(
    aacpReadiness.marketplace.registeredIdentityCount === 4 &&
      aacpReadiness.marketplace.providers.every(
        (provider) =>
          expectedAacpAgentTokenIds.has(provider.agentTokenId) &&
          provider.identity?.onchainVerified === true &&
          provider.identity.owner?.toLowerCase() === expectedAacpOwner,
      ),
    "AACP readiness does not verify all four mainnet identities",
  );
  assert(
    ["LISTINGS_PUBLISHED_RUNTIME_PENDING", "PROVIDERS_ONLINE"].includes(
      aacpReadiness.state,
    ) &&
      aacpReadiness.marketplace.indexedProviderCount === 4 &&
      aacpReadiness.marketplace.publishedListingCount === 4 &&
      aacpReadiness.marketplace.discoveryDegraded === false,
    "AACP readiness does not report four published providers",
  );
  assert(
    aacpReadiness.marketplace.providers.every(
      (provider) =>
        expectedAacpListings.get(provider.agentTokenId) === provider.listingId &&
        provider.listingStatus === "PUBLISHED" &&
        provider.liveListingVerified === true &&
        typeof provider.listingUrl === "string" &&
        new URL(provider.listingUrl).hostname === "www.agent.family",
    ),
    "AACP public listing identity or status changed",
  );
  const onlineAacpProviders = aacpReadiness.marketplace.providers.filter(
    (provider) =>
      provider.a2aStatus === "ONLINE" &&
      provider.presence === "online" &&
      provider.status === "ONLINE_AND_LISTED",
  );
  assert(
    onlineAacpProviders.length === aacpReadiness.marketplace.onlineProviderCount,
    "AACP runtime count is inconsistent with provider state",
  );
  assert(
    aacpReadiness.marketplace.dedicatedFlagship?.agentId === "cmt4dzxvcli4tw70125nd5ra8" &&
      aacpReadiness.marketplace.dedicatedFlagship?.agentTokenId === "293111" &&
      aacpReadiness.marketplace.dedicatedFlagship?.listingId === "cmt4e8j3nlmuiw7019f4qf24x" &&
      aacpReadiness.marketplace.dedicatedFlagship?.owner === "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9" &&
      aacpReadiness.marketplace.dedicatedFlagship?.onchainVerified === true &&
      aacpReadiness.marketplace.dedicatedFlagship?.listingStatus === "PUBLISHED" &&
      aacpReadiness.marketplace.dedicatedFlagship?.a2aStatus === "ONLINE" &&
      aacpReadiness.marketplace.dedicatedFlagship?.status === "ONLINE_AND_LISTED",
    "Dedicated Lending Rescue flagship is not published and online",
  );
  assert(
    (onlineAacpProviders.length === 4 && aacpReadiness.state === "PROVIDERS_ONLINE") ||
      (onlineAacpProviders.length < 4 &&
        aacpReadiness.state === "LISTINGS_PUBLISHED_RUNTIME_PENDING"),
    "AACP readiness state is inconsistent with live runtime presence",
  );
  assert(
    aacpReadiness.integration?.guide?.status === "CURRENT_HUMAN_GUIDE_VERIFIED" &&
      aacpReadiness.integration?.guide?.openApiStatus === "SAMPLE_SPEC_NOT_USED",
    "AACP guide verification boundary changed",
  );
  assert(
    aacpReadiness.integration?.runtime?.status === "PREISSUED_TOKEN_ADAPTER_IMPLEMENTED" &&
      aacpReadiness.integration.runtime.ownerSignerOnHost === true &&
      aacpReadiness.integration.runtime.autoRenewsToken === true &&
      aacpReadiness.integration.runtime.tokenLifetimeHours === 12,
    "AACP runtime signing or expiry boundary changed",
  );
  const runtimeEvidence = aacpReadiness.integration.runtime.rotationEvidence;
  const rotations = runtimeEvidence?.rotations ?? [];
  assert(
    aacpReadiness.integration.runtime.automationScope === "DEDICATED_FLAGSHIP_ONLY" &&
      aacpReadiness.integration.runtime.signerIsolation ===
        "ROOT_ONLY_SYSTEMD_RENEWAL_UNIT" &&
      aacpReadiness.integration.runtime.pollerHasSigningMaterial === false &&
      aacpReadiness.integration.runtime.originalProvidersAutoRenew === false,
    "AACP runtime automation scope is overstated",
  );
  assert(
    runtimeEvidence?.schemaVersion === "positioncrew.termix-runtime-rotations.v1" &&
      runtimeEvidence.agentId ===
        aacpReadiness.marketplace.dedicatedFlagship.agentId &&
      runtimeEvidence.agentTokenId ===
        aacpReadiness.marketplace.dedicatedFlagship.agentTokenId &&
      runtimeEvidence.handle === aacpReadiness.marketplace.dedicatedFlagship.handle &&
      runtimeEvidence.verifiedRotationCount === rotations.length &&
      rotations.length >= 3,
    "Dedicated runtime rotation evidence is missing or unbound",
  );
  assert(
    rotations.every(
      (rotation, index) =>
        rotation.sequence === index + 1 &&
        rotation.rotated === true &&
        rotation.restarted === true &&
        /^[0-9a-f]{64}$/.test(rotation.redactedJournalEventSha256) &&
        createHash("sha256")
          .update(
            JSON.stringify({
              at: rotation.completedAt,
              event: runtimeEvidence.eventName,
              agentId: runtimeEvidence.agentId,
              runtimeInstance: runtimeEvidence.runtimeInstance,
              rotated: rotation.rotated,
              restarted: rotation.restarted,
              expiresAt: rotation.expiresAt,
            }),
          )
          .digest("hex") === rotation.redactedJournalEventSha256 &&
        Date.parse(rotation.expiresAt) > Date.parse(rotation.completedAt) &&
        Date.parse(rotation.onlineObservation.observedAt) >
          Date.parse(rotation.completedAt) &&
        Date.parse(rotation.onlineObservation.observedAt) <
          Date.parse(rotation.expiresAt) &&
        (index === rotations.length - 1 ||
          Date.parse(rotation.onlineObservation.observedAt) <
            Date.parse(rotations[index + 1].completedAt)) &&
        rotation.onlineObservation.a2aStatus === "ONLINE" &&
        rotation.onlineObservation.status === "ONLINE_AND_LISTED" &&
        (index === 0 ||
          (Date.parse(rotation.completedAt) >
            Date.parse(rotations[index - 1].completedAt) &&
            Date.parse(rotation.expiresAt) >
              Date.parse(rotations[index - 1].expiresAt))),
    ),
    "Dedicated runtime rotations are not ordered verified completion events",
  );
  assert(
    runtimeEvidence.boundaries
      .join(" ")
      .includes("do not establish continuous uptime"),
    "Rotation evidence overstates uptime",
  );
  assert(
    aacpReadiness.integration?.orderGuard?.status ===
      "STRICT_LOCAL_LIFECYCLE_IMPLEMENTED" &&
      aacpReadiness.integration.orderGuard.chainId === 56 &&
      aacpReadiness.integration.orderGuard.signerOnGuard === false &&
      aacpReadiness.integration.orderGuard.broadcastsTransactions === false &&
      aacpReadiness.integration.orderGuard.abiDecodedIntentBinding === true &&
      aacpReadiness.integration.orderGuard.minedTransactionBinding === true &&
      aacpReadiness.integration.orderGuard.indexerReconciliationRequired === true &&
      aacpReadiness.integration.orderGuard.guardedActions?.join(",") ===
        "approveEscrow,createOrder,cancelPending,acceptOrder,submitDelivery,cancelExpired,releaseEscrow,requestRedo,claimAfterTimeout,openChallenge",
    "AACP order guard boundary changed",
  );
  assert(
    aacpReadiness.integration?.lifecycle?.join(",") ===
      "WALLET_SESSION,AGENT_PREPARE_MINT_INDEX,LISTING_CREATE_PUBLISH,A2A_RUNTIME,CHECKOUT_APPROVE_CREATE,PENDING_OR_EXPIRED_CANCELLATION,PROVIDER_ACCEPT,ARTIFACT_REGISTER_SUBMIT,BUYER_RELEASE_REDO_DISPUTE_OR_TIMEOUT,INDEXER_RECONCILE",
    "AACP documented lifecycle changed",
  );
  assert(
    new Set(aacpReadiness.marketplace.providers.map((provider) => provider.handle)).size === 4 &&
      aacpReadiness.marketplace.providers.every((provider) =>
        provider.handle.startsWith("positioncrew-") && provider.handle.endsWith(".agent"),
      ),
    "AACP provider handles are missing or duplicated",
  );
  assert(
    aacpReadiness.boundaries?.join(" ").includes("does not claim"),
    "AACP readiness overstates paid production activity",
  );
  report.aacpReadiness = aacpReadiness;
  report.aacpRuntime = {
    requiredForCoreHealth: false,
    status: onlineAacpProviders.length === 4 ? "ONLINE" : "RUNTIME_PENDING",
    onlineProviderCount: onlineAacpProviders.length,
    requiredProviderCount: 4,
    dedicatedFlagshipStatus: aacpReadiness.marketplace.dedicatedFlagship.status,
    verifiedAutomaticRotations: runtimeEvidence.verifiedRotationCount,
    latestRotationAt: runtimeEvidence.latestCompletedAt,
    boundary:
      "TermiX integration is optional for the challenge. Expiring A2A presence is reported separately and never converted into continuous-uptime evidence.",
  };

  const marketplaceDelivery = await fetchJson(
    "marketplace-delivery-evidence",
    marketplace.marketplaceDeliveryEvidenceUrl,
  );
  assert(
    marketplaceDelivery.schemaVersion === "positioncrew.marketplace-invocation-evidence.v1",
    "Unexpected marketplace delivery evidence schema",
  );
  const { evidenceHash: _marketplaceEvidenceHash, ...marketplaceDeliveryBody } = marketplaceDelivery;
  assert(
    canonicalSha256(marketplaceDeliveryBody) === marketplaceDelivery.evidenceHash,
    "Marketplace delivery evidence commitment is invalid",
  );
  assert(
    marketplaceDelivery.protocolHash ===
      "sha256:4935a4d6a32291112a1f64911765429ca90e65aa9a8a2d966634833cced597e4",
    "Marketplace delivery evidence changed its precommitted protocol",
  );
  assert(
    marketplaceDelivery.aggregate?.plannedAttemptCount === 6 &&
      marketplaceDelivery.aggregate?.recordedAttemptCount === 6 &&
      marketplaceDelivery.aggregate?.successCount === 6 &&
      marketplaceDelivery.aggregate?.allAttemptsSucceeded === true,
    "Marketplace delivery evidence does not contain six successful retained attempts",
  );
  assert(
    marketplaceDelivery.records?.length === 6 &&
      marketplaceDelivery.records.every(
        (record, index) =>
          record.sequenceNumber === index + 1 &&
          record.success === true &&
          record.httpStatus === 200 &&
          record.observation?.jobState === "COMPLETED" &&
          record.observation?.jobHistory?.join(",") ===
            "CREATED,FUNDED,ASSIGNED,SUBMITTED,EVALUATED,COMPLETED",
      ),
    "Marketplace delivery records are missing, reordered, or incomplete",
  );
  assert(
    marketplaceDelivery.summaries?.length === 3 &&
      marketplaceDelivery.summaries.every(
        (summary) =>
          summary.attemptCount === 2 &&
          summary.successCount === 2 &&
          summary.outputHashesMatch === true &&
          summary.evaluationHashesMatch === true &&
          summary.medianElapsedMilliseconds > 0,
      ),
    "Marketplace delivery summaries are inconsistent",
  );
  report.marketplaceDeliveryEvidence = marketplaceDelivery;

  const advantagePublication = await fetchJson(
    "agent-advantage-publication",
    "/evidence/agent-advantage-status.json",
  );
  assert(
    advantagePublication.schemaVersion === "positioncrew.agent-advantage-publication.v1",
    "Unexpected Agent Advantage publication schema",
  );
  assert(advantagePublication.taskCount === 3, "Agent Advantage task count changed");
  if (advantagePublication.status === "PENDING_INDEPENDENT_BLIND_EVALUATION") {
    assert(advantagePublication.reportUrl === null, "Pending Agent Advantage status exposes a report URL");
    assert(advantagePublication.reportHash === null, "Pending Agent Advantage status exposes a report hash");
    assert(
      advantagePublication.supportedAdvantageCount === null,
      "Pending Agent Advantage status exposes a result",
    );
  } else {
    assert(advantagePublication.status === "PUBLISHED", "Unknown Agent Advantage publication state");
    assert(
      advantagePublication.reportUrl === "/evidence/agent-advantage/",
      "Published Agent Advantage report URL changed",
    );
    assert(
      Number.isInteger(advantagePublication.supportedAdvantageCount) &&
        advantagePublication.supportedAdvantageCount >= 0 &&
        advantagePublication.supportedAdvantageCount <= 3,
      "Published Agent Advantage result count is invalid",
    );
    assert(
      Number.isInteger(advantagePublication.agentBlindQualityScore) &&
        advantagePublication.agentBlindQualityScore >= 0 &&
        advantagePublication.agentBlindQualityScore <= 300,
      "Published Agent Advantage quality score is invalid",
    );
    const advantageReport = await fetchJson(
      "agent-advantage-report",
      "/evidence/agent-advantage/agent-advantage-report.json",
    );
    assert(
      advantageReport.schemaVersion === "positioncrew.agent-advantage-report.v4",
      "Unexpected Agent Advantage report schema",
    );
    assert(
      advantageReport.reportHash === advantagePublication.reportHash,
      "Published Agent Advantage report hash differs from its status record",
    );
    const { reportHash: _reportHash, ...reportBody } = advantageReport;
    assert(
      canonicalSha256(reportBody) === advantageReport.reportHash,
      "Published Agent Advantage report commitment is invalid",
    );
    assert(
      advantageReport.summary?.evidenceManifestHash === advantagePublication.evidenceManifestHash,
      "Published Agent Advantage evidence manifest differs from its status record",
    );
    assert(
      canonicalSha256(
        advantageReport.tasks.map((task) => ({
          benchmarkSlug: task.benchmarkSlug,
          evidenceManifestHash: task.evidenceManifestHash,
        })),
      ) === advantageReport.summary?.evidenceManifestHash,
      "Published Agent Advantage task manifests are not bound to the report summary",
    );
    assert(
      advantageReport.summary?.supportedAdvantageCount ===
        advantagePublication.supportedAdvantageCount,
      "Published Agent Advantage summary differs from its status record",
    );
    const attachedMarketplaceDelivery = await fetchJson(
      "agent-advantage-marketplace-delivery",
      "/evidence/agent-advantage/marketplace-invocation-evidence.json",
    );
    assert(
      attachedMarketplaceDelivery.evidenceHash ===
        advantageReport.summary?.marketplaceEvidenceHash &&
        attachedMarketplaceDelivery.protocolHash ===
          advantageReport.summary?.marketplaceProtocolHash &&
        attachedMarketplaceDelivery.aggregate?.successCount === 6,
      "Published Agent Advantage report has inconsistent marketplace delivery evidence",
    );
    const attachedCommerceLedger = await fetchJson(
      "agent-advantage-commerce-ledger",
      "/evidence/agent-advantage/erc8183-jobs.testnet.json",
    );
    assert(
      canonicalSha256(attachedCommerceLedger) ===
        advantageReport.trackRecord?.onchainTestnet?.ledgerHash &&
        attachedCommerceLedger.summary?.completedLifecycles ===
          advantageReport.trackRecord?.onchainTestnet?.completedLifecycles &&
        attachedCommerceLedger.summary?.fundedCompletedJobs ===
          advantageReport.trackRecord?.onchainTestnet?.fundedCompletedJobs &&
        attachedCommerceLedger.summary?.externalBuyerJobs === 0 &&
        attachedCommerceLedger.summary?.externalRevenue === "0",
      "Published Agent Advantage track record differs from its onchain ledger",
    );
    assert(
      advantageReport.tasks?.every(
        (task) =>
          task.marketplaceDelivery?.attemptCount === 2 &&
          task.marketplaceDelivery?.successCount === 2 &&
          task.marketplaceDelivery?.allAttemptsSucceeded === true &&
          task.marketplaceDelivery?.medianElapsedMilliseconds > 0,
      ),
      "Published Agent Advantage tasks omit marketplace delivery provenance",
    );
    const advantageHtml = await fetchText(
      "agent-advantage-report-html",
      advantagePublication.reportUrl,
    );
    assert(
      advantageHtml.includes("PositionCrew Agent Advantage Report") &&
        advantageHtml.includes(advantageReport.reportHash) &&
        !advantageHtml.includes("Synthetic Layout"),
      "Published Agent Advantage presentation is missing its title or commitment",
    );
  }
  const advantagePublicationApi = await fetchJson(
    "agent-advantage-publication-api",
    "/api/benchmarks/status",
  );
  assert(
    JSON.stringify(advantagePublicationApi) === JSON.stringify(advantagePublication),
    "Benchmark status API differs from the tracked Agent Advantage publication status",
  );
  report.agentAdvantagePublication = advantagePublication;

  const founderAdvantagePublication = await fetchJson(
    "founder-agent-advantage-publication",
    "/evidence/founder-agent-advantage-status.json",
  );
  assert(
    founderAdvantagePublication.schemaVersion ===
      "positioncrew.founder-agent-advantage-publication.v1",
    "Unexpected founder Agent Advantage publication schema",
  );
  assert(
    founderAdvantagePublication.taskCount === 3,
    "Founder Agent Advantage task count changed",
  );
  assert(
    founderAdvantagePublication.qualityMethod === "CANONICAL_EXACT_OUTPUT_PARITY" &&
      founderAdvantagePublication.qualityScore === null,
    "Founder comparison inferred a quality score instead of exact-output parity",
  );
  assert(
    founderAdvantagePublication.independent === false &&
      founderAdvantagePublication.blind === false,
    "Founder comparison changed its non-independent or non-blind boundary",
  );
  if (founderAdvantagePublication.status === "PENDING_FOUNDER_COMPARISON") {
    assert(
      founderAdvantagePublication.reportUrl === null &&
        founderAdvantagePublication.reportHash === null &&
        founderAdvantagePublication.evidenceManifestHash === null &&
        founderAdvantagePublication.publishedAt === null &&
        founderAdvantagePublication.exactOutputParityCount === null &&
        founderAdvantagePublication.recordedSpeedAdvantageCount === null,
      "Pending founder comparison exposes a report or result",
    );
  } else {
    assert(
      founderAdvantagePublication.status === "PUBLISHED",
      "Unknown founder Agent Advantage publication state",
    );
    assert(
      founderAdvantagePublication.reportUrl === "/evidence/agent-advantage-founder/",
      "Published founder Agent Advantage report URL changed",
    );
    assert(
      Number.isInteger(founderAdvantagePublication.exactOutputParityCount) &&
        founderAdvantagePublication.exactOutputParityCount >= 0 &&
        founderAdvantagePublication.exactOutputParityCount <= 3 &&
        Number.isInteger(founderAdvantagePublication.recordedSpeedAdvantageCount) &&
        founderAdvantagePublication.recordedSpeedAdvantageCount >= 0 &&
        founderAdvantagePublication.recordedSpeedAdvantageCount <= 3,
      "Published founder comparison counts are invalid",
    );
    const founderAdvantageReport = await fetchJson(
      "founder-agent-advantage-report",
      "/evidence/agent-advantage-founder/founder-agent-advantage-report.json",
    );
    assert(
      founderAdvantageReport.schemaVersion ===
        "positioncrew.founder-agent-advantage-report.v2",
      "Unexpected founder Agent Advantage report schema",
    );
    assert(
      founderAdvantageReport.reportHash === founderAdvantagePublication.reportHash,
      "Published founder Agent Advantage report hash differs from its status record",
    );
    const { reportHash: _founderReportHash, ...founderReportBody } = founderAdvantageReport;
    assert(
      canonicalSha256(founderReportBody) === founderAdvantageReport.reportHash,
      "Published founder Agent Advantage report commitment is invalid",
    );
    const founderAdvantageHtml = await fetchText(
      "founder-agent-advantage-report-html",
      founderAdvantagePublication.reportUrl,
    );
    assert(
      founderAdvantageHtml.includes("Founder-operated") &&
        founderAdvantageHtml.includes(founderAdvantageReport.reportHash),
      "Published founder comparison presentation omits its method or commitment",
    );
  }
  const founderAdvantagePublicationApi = await fetchJson(
    "founder-agent-advantage-publication-api",
    "/api/benchmarks/founder-comparison/status",
  );
  assert(
    JSON.stringify(founderAdvantagePublicationApi) ===
      JSON.stringify(founderAdvantagePublication),
    "Founder comparison status API differs from its tracked static publication status",
  );
  report.founderAgentAdvantagePublication = founderAdvantagePublication;

  const openApi = await fetchJson("openapi", marketplace.openApiUrl);
  assert(openApi.openapi === "3.1.0", "OpenAPI version is not 3.1.0");
  const requiredOpenApiOperations = [
    ["/api/status", "get", "getSystemTelemetry"],
    ["/api/commerce/aacp", "get", "getAacpProductionReadiness"],
    ["/api/operations/production", "get", "getProductionTrackRecord"],
    ["/api/benchmarks/status", "get", "getBenchmarkPublicationStatus"],
    [
      "/api/benchmarks/founder-comparison/status",
      "get",
      "getFounderBenchmarkPublicationStatus",
    ],
    [
      "/api/benchmarks/marketplace-provenance",
      "get",
      "getMarketplaceInvocationEvidence",
    ],
    ["/api/benchmark-hires", "post", "createFreshMarketplaceHire"],
    ["/api/benchmark-hires/{hireId}", "get", "getFreshMarketplaceHire"],
    [
      "/api/benchmark-hires/{hireId}/jobs",
      "post",
      "runFreshMarketplaceHire",
    ],
    [
      "/api/benchmark-receipts/{receiptId}",
      "get",
      "getFreshMarketplaceReceipt",
    ],
    [
      "/api/providers/lending-rescue/jobs",
      "get",
      "getLendingRescueRequestFixture",
    ],
    [
      "/api/providers/lending-rescue/jobs",
      "post",
      "runLendingRescueRequest",
    ],
    [
      "/api/providers/lp-rebalance/jobs",
      "get",
      "getLpRebalanceRequestFixture",
    ],
    [
      "/api/providers/lp-rebalance/jobs",
      "post",
      "runLpRebalanceRequest",
    ],
    [
      "/api/providers/yield-optimization/jobs",
      "get",
      "getYieldOptimizationRequestFixture",
    ],
    [
      "/api/providers/yield-optimization/jobs",
      "post",
      "runYieldOptimizationRequest",
    ],
    [
      "/api/providers/bounded-grid/jobs",
      "get",
      "getBoundedGridRequestFixture",
    ],
    [
      "/api/providers/bounded-grid/jobs",
      "post",
      "runBoundedGridRequest",
    ],
    ["/api/wallets/{account}/venus", "get", "inspectVenusAccount"],
    ["/api/positions/pancake/{tokenId}", "get", "inspectPancakePosition"],
    ["/api/markets/venus/stable-yields", "get", "inspectVenusStableYields"],
    [
      "/api/markets/pancake/wbnb-usdt/grid",
      "get",
      "inspectPancakeGridMarket",
    ],
  ];
  for (const [path, method, operationId] of requiredOpenApiOperations) {
    assert(
      openApi.paths?.[path]?.[method]?.operationId === operationId,
      `OpenAPI omits required operation ${operationId} at ${method.toUpperCase()} ${path}`,
    );
  }
  assert(
    openApi.paths?.["/api/operations/production"]?.get?.operationId ===
      "getProductionTrackRecord",
    "OpenAPI omits the production verification record",
  );
  assert(
    openApi.paths?.["/api/benchmarks/status"]?.get?.operationId ===
      "getBenchmarkPublicationStatus",
    "OpenAPI omits the benchmark publication status",
  );
  assert(
    openApi.paths?.["/api/benchmarks/founder-comparison/status"]?.get?.operationId ===
      "getFounderBenchmarkPublicationStatus",
    "OpenAPI omits the founder benchmark publication status",
  );
  assert(
    openApi.paths?.["/api/benchmarks/marketplace-provenance"]?.get?.operationId ===
      "getMarketplaceInvocationEvidence",
    "OpenAPI omits marketplace delivery evidence",
  );
  assert(
    openApi.paths?.["/api/commerce/aacp"]?.get?.operationId ===
      "getAacpProductionReadiness",
    "OpenAPI omits TermiX production readiness",
  );
  assert(
    openApi.paths?.["/api/markets/pancake/wbnb-usdt/grid"]?.get?.operationId ===
      "inspectPancakeGridMarket",
    "OpenAPI omits the live Pancake grid probe",
  );
  assert(
    openApi.paths?.["/api/markets/venus/stable-yields"]?.get?.operationId ===
      "inspectVenusStableYields",
    "OpenAPI omits the live Venus yield probe",
  );
  assert(
    openApi.paths?.["/api/positions/pancake/{tokenId}"]?.get?.operationId ===
      "inspectPancakePosition",
    "OpenAPI omits the live Pancake position probe",
  );

  const productionRecord = await fetchJson(
    "production-track-record",
    marketplace.operatingRecordUrl,
  );
  assert(
    productionRecord.schemaVersion === "positioncrew.production-track-record.v1",
    "Unexpected production track-record schema",
  );
  assert(
    productionRecord.epoch?.schemaVersion === "positioncrew.production-monitor-epoch.v1",
    "Production track record has no fixed epoch",
  );
  assert(
    productionRecord.epoch?.startedAt === "2026-08-13T04:00:00.000Z",
    "Production monitoring epoch changed",
  );
  assert(
    productionRecord.epoch?.aggregation?.coverage === "LATEST_100_SCHEDULED_RUNS",
    "Production track record changed its disclosed aggregation window",
  );
  assert(
    productionRecord.epoch?.aggregation?.excludeEvents?.includes("push") &&
      productionRecord.epoch?.aggregation?.excludeEvents?.includes("workflow_dispatch"),
    "Production track record no longer excludes non-scheduled runs",
  );
  assert(Array.isArray(productionRecord.runs), "Production track-record runs are missing");
  assert(
    productionRecord.summary?.observedRunCount === productionRecord.runs.length,
    "Production track-record observed count is inconsistent",
  );
  if (productionRecord.status === "SOURCE_UNAVAILABLE") {
    assert(
      productionRecord.source?.sourceStatus === "UNAVAILABLE" &&
        productionRecord.summary?.totalScheduledRunsSinceEpoch === null &&
        productionRecord.summary?.rollingPassRatePct === null,
      "Unavailable production source inferred a reliability result",
    );
  } else {
    assert(
      productionRecord.source?.sourceStatus === "AVAILABLE",
      "Available production record has the wrong source state",
    );
    assert(
      Number.isInteger(productionRecord.summary?.totalScheduledRunsSinceEpoch) &&
        productionRecord.summary.totalScheduledRunsSinceEpoch >= productionRecord.runs.length,
      "Production track-record total count is invalid",
    );
    assert(
      productionRecord.summary.completedRuns + productionRecord.summary.pendingRuns ===
        productionRecord.runs.length,
      "Production track-record completion counts are inconsistent",
    );
    assert(
      productionRecord.summary.successfulRuns + productionRecord.summary.unsuccessfulRuns ===
        productionRecord.summary.completedRuns,
      "Production track-record conclusions are inconsistent",
    );
    assert(
      new Set(productionRecord.runs.map((run) => run.runId)).size ===
        productionRecord.runs.length,
      "Production track record contains duplicate runs",
    );
    assert(
      productionRecord.runs.every(
        (run) => Date.parse(run.createdAt) >= Date.parse(productionRecord.epoch.startedAt),
      ),
      "Production track record includes a run before its epoch",
    );
  }
  report.productionTrackRecord = productionRecord;

  const zeroVenus = await fetchJson(
    "venus-zero-position",
    "/api/wallets/0x0000000000000000000000000000000000000000/venus",
  );
  assert(
    zeroVenus.schemaVersion === "positioncrew.venus-account-probe.v1",
    "Unexpected Venus account probe schema",
  );
  assert(zeroVenus.state === "NO_POSITION", "Zero address unexpectedly has a Venus position");
  assert(zeroVenus.position?.debtValueUsd === "0", "Zero address Venus debt is nonzero");
  assert(
    zeroVenus.position?.collateralValueUsd === "0",
    "Zero address Venus collateral is nonzero",
  );
  assert(zeroVenus.rescueRequest === null, "Zero address produced a rescue request");
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(zeroVenus.source?.explorerUrl ?? ""),
    "Venus account probe is not linked to its pinned BSC block",
  );

  const pancakeGrid = await fetchJson(
    "pancake-grid-market",
    "/api/markets/pancake/wbnb-usdt/grid",
  );
  assert(
    pancakeGrid.schemaVersion === "positioncrew.pancake-grid-probe.v1",
    "Unexpected Pancake grid probe schema",
  );
  assert(pancakeGrid.state === "READY", "Pancake grid probe is not ready");
  assert(Number(pancakeGrid.market?.spotPriceUsd) > 0, "Pancake grid spot price is invalid");
  assert(
    Number(pancakeGrid.market?.activeLiquidityUsd) > 0,
    "Pancake grid active liquidity is invalid",
  );
  assert(
    Number(pancakeGrid.market?.reserveValueUsd) > 0,
    "Pancake grid reserve value is invalid",
  );
  assert(
    pancakeGrid.market?.volatilitySampleCount >= 3,
    "Pancake grid volatility has too few samples",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(pancakeGrid.source?.explorerUrl ?? ""),
    "Pancake grid probe is not linked to its pinned BSC block",
  );
  assert(
    pancakeGrid.gridRequest?.marketState?.sourceId === pancakeGrid.gridRequest?.sources?.[0]?.sourceId,
    "Pancake grid request source binding is inconsistent",
  );
  const pancakeGridJob = await postJson(
    "pancake-grid-live-job",
    "/api/providers/bounded-grid/jobs",
    { request: pancakeGrid.gridRequest },
  );
  assert(
    pancakeGridJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
    "Pancake grid job changed its evidence mode",
  );
  assert(pancakeGridJob.result?.job?.state === "COMPLETED", "Pancake grid job did not complete");
  assert(pancakeGridJob.result?.evaluation?.score === 100, "Pancake grid job score is not 100/100");

  const pancakePosition = await fetchJson(
    "pancake-lp-position",
    `/api/positions/pancake/${referencePancakePositionId}`,
  );
  assert(
    pancakePosition.schemaVersion === "positioncrew.pancake-position-probe.v1",
    "Unexpected Pancake position probe schema",
  );
  assert(pancakePosition.state === "READY", "Pancake position probe is not ready");
  assert(
    pancakePosition.position?.tokenId === referencePancakePositionId,
    "Pancake position probe returned the wrong NFT",
  );
  assert(Number(pancakePosition.position?.positionValueUsd) > 0, "Pancake position value is invalid");
  assert(Number(pancakePosition.position?.uncollectedFeesUsd) >= 0, "Pancake position fees are invalid");
  assert(
    Number(pancakePosition.market?.measurementWindowSeconds) > 0,
    "Pancake position has no measured swap window",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(pancakePosition.source?.explorerUrl ?? ""),
    "Pancake position probe is not linked to its pinned BSC block",
  );
  assert(
    pancakePosition.lpRequest?.marketState?.sourceId === pancakePosition.lpRequest?.sources?.[0]?.sourceId,
    "Pancake position request source binding is inconsistent",
  );
  const pancakePositionJob = await postJson(
    "pancake-lp-live-job",
    "/api/providers/lp-rebalance/jobs",
    { request: pancakePosition.lpRequest },
  );
  assert(
    pancakePositionJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
    "Pancake position job changed its evidence mode",
  );
  assert(pancakePositionJob.result?.job?.state === "COMPLETED", "Pancake position job did not complete");
  assert(pancakePositionJob.result?.evaluation?.score === 100, "Pancake position job score is not 100/100");

  const venusYield = await fetchJson(
    "venus-yield-market",
    "/api/markets/venus/stable-yields",
  );
  assert(
    venusYield.schemaVersion === "positioncrew.venus-yield-probe.v1",
    "Unexpected Venus yield probe schema",
  );
  assert(venusYield.state === "READY", "Venus yield probe is not ready");
  assert(venusYield.markets?.length === 4, "Venus yield probe does not cover four stable markets");
  assert(
    new Set(venusYield.markets.map((market) => market.symbol)).size === 4,
    "Venus yield markets are duplicated",
  );
  assert(
    venusYield.markets.every(
      (market) => market.baseSupplyApyBps >= 0 && Number(market.availableLiquidityUsd) > 0,
    ),
    "Venus yield probe contains an invalid APY or available-cash value",
  );
  assert(
    Number(venusYield.source?.measuredSecondsPerBlock) > 0,
    "Venus yield probe has no measured block interval",
  );
  assert(
    /^https:\/\/bscscan\.com\/block\/\d+$/.test(venusYield.source?.explorerUrl ?? ""),
    "Venus yield probe is not linked to its pinned BSC block",
  );
  assert(
    venusYield.yieldRequest?.opportunities?.every(
      (opportunity) => opportunity.sourceId === venusYield.yieldRequest?.sources?.[0]?.sourceId,
    ),
    "Venus yield request source binding is inconsistent",
  );
  const venusYieldJob = await postJson(
    "venus-yield-live-job",
    "/api/providers/yield-optimization/jobs",
    { request: venusYield.yieldRequest },
  );
  assert(
    venusYieldJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
    "Venus yield job changed its evidence mode",
  );
  assert(venusYieldJob.result?.job?.state === "COMPLETED", "Venus yield job did not complete");
  assert(venusYieldJob.result?.evaluation?.score === 100, "Venus yield job score is not 100/100");

  for (const entry of marketplace.providers) {
    assert(expectedServices.has(entry.service), `Unexpected provider service: ${entry.service}`);
    const identity = await verifyIdentity(entry);
    const manifest = await fetchJson(`${entry.service}:manifest`, entry.manifestUrl);
    assert(manifest.provider?.service === entry.service, `${entry.service} manifest mismatch`);
    assert(manifest.identity?.agentId === identity.agentId, `${entry.service} manifest identity mismatch`);
    assert(manifest.provider?.relationship === "FIRST_PARTY", `${entry.service} ownership is unclear`);
    assert(
      manifest.commerce?.settlement === "IN_MEMORY_CONFORMANCE",
      `${entry.service} settlement boundary changed unexpectedly`,
    );
    assert(
      manifest.commerce?.adapter === "AACP_PRODUCTION_RUNTIME_PENDING" &&
        new URL(manifest.commerce?.readinessUrl).origin === baseUrl.origin,
      `${entry.service} AACP readiness binding changed unexpectedly`,
    );
    assert(
      manifest.pricing?.judgeTrial?.amount === "0" &&
        manifest.pricing?.judgeTrial?.walletRequired === false &&
        manifest.pricing?.judgeTrial?.settlement === "NO_PAYMENT",
      `${entry.service} no-wallet trial boundary changed unexpectedly`,
    );

    const health = await fetchJson(`${entry.service}:health`, manifest.transport?.health?.url);
    assert(health.status === "OPERATIONAL", `${entry.service} is ${health.status}`);
    assert(health.conformance?.score === 100, `${entry.service} conformance is not 100/100`);

    const requestSchema = await fetchJson(
      `${entry.service}:request-schema`,
      manifest.transport?.schemas?.request,
    );
    const deliverableSchema = await fetchJson(
      `${entry.service}:deliverable-schema`,
      manifest.transport?.schemas?.deliverable,
    );
    assert(requestSchema.type === "object", `${entry.service} request schema is invalid`);
    assert(deliverableSchema.type === "object", `${entry.service} deliverable schema is invalid`);

    const job = await fetchJson(`${entry.service}:job`, manifest.transport?.job?.url);
    assert(job.result?.request?.service === entry.service, `${entry.service} job routed incorrectly`);
    assert(job.result?.job?.state === "COMPLETED", `${entry.service} job did not complete`);
    assert(job.result?.evaluation?.score === 100, `${entry.service} job score is not 100/100`);
    assert(job.evidenceMode === "FROZEN_BSC_TEST_FIXTURE", `${entry.service} GET job is not locked`);
    assert(job.receipt?.mode === "PUBLIC_REPRODUCIBLE", `${entry.service} GET receipt is not public`);

    const monitorStartedAt = new Date();
    const interactiveRequest = buildMonitorRequest(job.result.request, monitorStartedAt);
    const interactiveJob = await postJson(
      `${entry.service}:interactive-job`,
      manifest.transport?.job?.url,
      { request: interactiveRequest },
    );
    assert(
      interactiveJob.evidenceMode === "CALLER_SUPPLIED_OBSERVATIONS",
      `${entry.service} default POST did not use caller-supplied observations`,
    );
    assert(interactiveJob.result?.job?.state === "COMPLETED", `${entry.service} interactive job did not complete`);
    assert(interactiveJob.result?.evaluation?.score === 100, `${entry.service} interactive score is not 100/100`);
    assert(interactiveJob.benchmarkLock === null, `${entry.service} interactive job exposed a benchmark lock`);
    assert(interactiveJob.receipt?.mode === "SESSION_EMBEDDED", `${entry.service} interactive receipt is not session-only`);
    assert(interactiveJob.receipt?.path === null, `${entry.service} interactive job exposed a public receipt path`);
    assert(
      Date.parse(interactiveJob.result?.deliverable?.expiresAt) > monitorStartedAt.getTime(),
      `${entry.service} interactive result is already expired`,
    );
    assert(
      Date.parse(interactiveJob.result?.deliverable?.expiresAt) <= Date.parse(interactiveRequest.deadline),
      `${entry.service} interactive expiry exceeds the buyer deadline`,
    );

    const lockedJob = await postJson(
      `${entry.service}:locked-job`,
      manifest.transport?.job?.url,
      { mode: "FROZEN_FIXTURE", request: job.result.request },
    );
    assert(lockedJob.evidenceMode === "FROZEN_BSC_TEST_FIXTURE", `${entry.service} locked POST changed mode`);
    assert(
      lockedJob.result?.evaluation?.evaluationHash === job.result.evaluation.evaluationHash,
      `${entry.service} locked POST changed the evaluation hash`,
    );
    assert(lockedJob.receipt?.path === job.receipt.path, `${entry.service} locked POST changed the receipt path`);

    report.providers.push({
      providerId: manifest.provider.providerId,
      service: entry.service,
      health: health.status,
      conformanceScore: health.conformance.score,
      jobState: job.result.job.state,
      evaluationHash: job.result.evaluation.evaluationHash,
      identity,
    });
  }

  assert(
    new Set(report.providers.map((provider) => provider.service)).size === 4,
    "Provider services are duplicated",
  );

  const commerceLedger = await fetchJson("erc8183-ledger", "/api/commerce/erc8183");
  assert(
    commerceLedger.schemaVersion === "positioncrew.erc8183-testnet-ledger.v1",
    "Unexpected ERC-8183 ledger schema",
  );
  assert(commerceLedger.summary.completedLifecycles === 7, "ERC-8183 lifecycle count changed");
  assert(commerceLedger.summary.fundedCompletedJobs === 6, "ERC-8183 funded count changed");
  assert(commerceLedger.summary.externalBuyerJobs === 0, "ERC-8183 operator boundary changed");
  assert(commerceLedger.jobs.length === 7, "ERC-8183 ledger must contain seven jobs");
  assert(
    new Set(
      commerceLedger.jobs
        .filter((job) => job.runType === "FUNDED_CATEGORY_RECEIPT")
        .map((job) => job.service),
    ).size === 4,
    "ERC-8183 flagship receipts do not cover all four services",
  );

  const commerceAddress = commerceLedger.protocol.commerce;
  const routerAddress = commerceLedger.protocol.router;
  const policyAddress = commerceLedger.protocol.policy;
  const [paymentToken, platformFeeBps, policyWhitelisted, disputeWindow, voteQuorum] =
    await Promise.all([
      identityClient.readContract({ address: commerceAddress, abi: erc8183CommerceAbi, functionName: "paymentToken" }),
      identityClient.readContract({ address: commerceAddress, abi: erc8183CommerceAbi, functionName: "platformFeeBP" }),
      identityClient.readContract({ address: routerAddress, abi: erc8183RouterAbi, functionName: "policyWhitelist", args: [policyAddress] }),
      identityClient.readContract({ address: policyAddress, abi: erc8183PolicyAbi, functionName: "disputeWindow" }),
      identityClient.readContract({ address: policyAddress, abi: erc8183PolicyAbi, functionName: "voteQuorum" }),
    ]);
  assert(paymentToken.toLowerCase() === commerceLedger.protocol.paymentToken.toLowerCase(), "ERC-8183 payment token mismatch");
  assert(platformFeeBps === 0n, "ERC-8183 platform fee changed");
  assert(policyWhitelisted, "ERC-8183 policy is no longer whitelisted");
  assert(disputeWindow === 900n, "ERC-8183 dispute window changed");
  assert(voteQuorum === 1n, "ERC-8183 vote quorum changed");

  report.commerce = [];
  for (const ledgerJob of commerceLedger.jobs) {
    const startedAt = performance.now();
    const manifestUrl = new URL(ledgerJob.manifestUrl);
    assert(
      manifestUrl.origin === "https://positioncrew.dolepee.com",
      `ERC-8183 job ${ledgerJob.jobId} manifest is not on the canonical domain`,
    );
    const [onchainJob, registerReceipt, settleReceipt, manifest] = await Promise.all([
      identityClient.readContract({
        address: commerceAddress,
        abi: erc8183CommerceAbi,
        functionName: "getJob",
        args: [BigInt(ledgerJob.jobId)],
      }),
      identityClient.getTransactionReceipt({ hash: ledgerJob.transactions.register }),
      identityClient.getTransactionReceipt({ hash: ledgerJob.transactions.settle }),
      fetchJson(
        `erc8183-job-${ledgerJob.jobId}-manifest`,
        `${manifestUrl.pathname}${manifestUrl.search}`,
      ),
    ]);
    // APEX clears jobPolicy after settlement, so policy provenance lives in JobRegistered.
    const registrationEvents = parseEventLogs({
      abi: erc8183RouterAbi,
      eventName: "JobRegistered",
      logs: registerReceipt.logs,
    });
    assert(registerReceipt.status === "success", `ERC-8183 job ${ledgerJob.jobId} registration failed`);
    assert(registrationEvents.length === 1, `ERC-8183 job ${ledgerJob.jobId} registration event missing`);
    const registration = registrationEvents[0].args;
    checks.push({
      name: `erc8183-job-${ledgerJob.jobId}-chain`,
      url: bscTestnetRpc,
      status: 200,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    });
    assert(onchainJob.status === 3, `ERC-8183 job ${ledgerJob.jobId} is not completed`);
    assert(
      onchainJob.client.toLowerCase() === commerceLedger.parties.client.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} client mismatch`,
    );
    assert(
      onchainJob.provider.toLowerCase() === commerceLedger.parties.provider.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} provider mismatch`,
    );
    assert(
      onchainJob.budget === BigInt(ledgerJob.budgetBaseUnits),
      `ERC-8183 job ${ledgerJob.jobId} budget mismatch`,
    );
    assert(
      onchainJob.deliverable.toLowerCase() === ledgerJob.manifestHash.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} onchain manifest mismatch`,
    );
    assert(
      registration.jobId === BigInt(ledgerJob.jobId),
      `ERC-8183 job ${ledgerJob.jobId} registration ID mismatch`,
    );
    assert(
      registration.policy.toLowerCase() === policyAddress.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} registered policy mismatch`,
    );
    assert(
      registration.client.toLowerCase() === commerceLedger.parties.client.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} registered client mismatch`,
    );
    assert(settleReceipt.status === "success", `ERC-8183 job ${ledgerJob.jobId} settlement failed`);
    assert(
      keccak256(stringToHex(canonicalJson(manifest))).toLowerCase() === ledgerJob.manifestHash.toLowerCase(),
      `ERC-8183 job ${ledgerJob.jobId} public manifest hash mismatch`,
    );
    report.commerce.push({
      jobId: ledgerJob.jobId,
      service: ledgerJob.service,
      status: "COMPLETED",
      budgetBaseUnits: ledgerJob.budgetBaseUnits,
      manifestHash: ledgerJob.manifestHash,
      registrationTransaction: ledgerJob.transactions.register,
      settlementTransaction: ledgerJob.transactions.settle,
    });
  }
  report.status = "OPERATIONAL";
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.checkCount = checks.length;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Production health report: ${outputPath}`);
}
