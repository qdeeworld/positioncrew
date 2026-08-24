import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import lendingFixture from "../fixtures/lending-rescue/stressed-venus-position.v1.json" with { type: "json" };
import {
  runFixtureRequest,
  runBenchmarkRepeatability,
  runFrozenFixture,
  runFrozenMatrix,
  runLendingRepeatability,
  runSuppliedLendingRequest,
  runSuppliedProviderRequest,
  runTermixBenchmarkRepeatability,
} from "../src/api/fixture-jobs.js";
import { PROVIDER_CATALOG } from "../src/marketplace/catalog.js";
import {
  EXTERNAL_COMPARISON_SNAPSHOT,
  EXTERNAL_COMPARISON_SNAPSHOT_ROUTE,
} from "../src/marketplace/external-comparisons.js";
import {
  buildMarketplaceManifest,
  buildOpenApiDocument,
  buildProviderManifest,
  getSchemaDocument,
  schemaIdsForService,
} from "../src/marketplace/discovery.js";

describe("public fixture job boundary", () => {
  it("returns an actionable rescue while declaring the non-onchain boundary", async () => {
    const response = await runFrozenFixture("LENDING_RESCUE");

    expect(response.result.job.state).toBe("COMPLETED");
    expect(response.result.deliverable.status).toBe("ACTIONABLE");
    expect(response.result.deliverable.service).toBe("LENDING_RESCUE");
    expect(response.commerceMode).toBe("IN_MEMORY_CONFORMANCE");
    expect(response.advantageStatus).toBe("PENDING_INDEPENDENT_BLIND_EVALUATION");
    expect(response.benchmarkLock?.fixtureHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(response.claimBoundary.join(" ")).toContain("not an AACP");
    expect(response.receipt.mode).toBe("PUBLIC_REPRODUCIBLE");
    expect(response.receipt.path).toBe(`/api/receipts/${response.result.evaluation.evaluationHash}`);

    const artifactManifest = response.result.job.deliverable;
    expect(artifactManifest).not.toBeNull();
    if (!artifactManifest) throw new Error("Completed job is missing its artifact manifest");
    const artifactUri = artifactManifest.uri;
    expect(artifactUri).toMatch(/^data:application\/json;base64,/);
    const artifact = JSON.parse(
      Buffer.from(artifactUri.slice(artifactUri.indexOf(",") + 1), "base64").toString("utf8"),
    );
    expect(artifact).toEqual(response.result.deliverable);
  });

  it("exposes all four required categories at equal conformance depth", async () => {
    const matrix = await runFrozenMatrix();

    expect(matrix.map((item) => item.result.request.service)).toEqual([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "YIELD_OPTIMIZATION",
      "BOUNDED_GRID",
    ]);
    expect(matrix.every((item) => item.result.evaluation.score === 100)).toBe(true);
    expect(matrix.every((item) => item.result.job.state === "COMPLETED")).toBe(true);
    expect(matrix.map((item) => Boolean(item.benchmarkLock))).toEqual([true, true, false, true]);
  });

  it("reproduces all three provider benchmarks without claiming agent advantage", async () => {
    const matrix = await runTermixBenchmarkRepeatability();

    expect(matrix.records.map((record) => record.service)).toEqual([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "BOUNDED_GRID",
    ]);
    for (const record of matrix.records) {
      expect(record.runs).toHaveLength(2);
      expect(record.runs.every((run) => run.qualityScore === 100)).toBe(true);
      expect(record.runs.every((run) => run.criticalFailureCount === 0)).toBe(true);
      expect(new Set(record.runs.map((run) => run.outputHash)).size).toBe(1);
      expect(record.pending).toEqual(["MANUAL_BASELINE", "INDEPENDENT_BLIND_SCORECARD"]);
      expect(record.boundary).toContain("Agent advantage is not claimed");
    }
    expect(matrix.boundary).toContain("no agent-versus-manual advantage is claimed");
    expect((await runBenchmarkRepeatability("LP_REBALANCE")).benchmarkSlug).toBe("lp-rebalance");
    expect((await runLendingRepeatability()).benchmarkSlug).toBe("lending-rescue");
  });

  it("publishes one callable provider listing for every required category", () => {
    expect(PROVIDER_CATALOG.map((provider) => provider.service)).toEqual([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "YIELD_OPTIMIZATION",
      "BOUNDED_GRID",
    ]);
    expect(new Set(PROVIDER_CATALOG.map((provider) => provider.endpoint)).size).toBe(4);
    expect(PROVIDER_CATALOG.every((provider) => provider.endpoint.startsWith("/api/providers/") && provider.endpoint.endsWith("/jobs"))).toBe(true);
    expect(PROVIDER_CATALOG.every((provider) => provider.healthEndpoint.startsWith("/api/providers/") && provider.healthEndpoint.endsWith("/health"))).toBe(true);
    expect(PROVIDER_CATALOG.every((provider) => provider.manifestEndpoint.startsWith("/api/providers/") && provider.manifestEndpoint.endsWith("/manifest"))).toBe(true);
    expect(PROVIDER_CATALOG.every((provider) => provider.settlement === "IN_MEMORY_CONFORMANCE")).toBe(true);
    expect(new Set(PROVIDER_CATALOG.map((provider) => provider.identity.agentId)).size).toBe(4);
    expect(
      PROVIDER_CATALOG.every(
        (provider) =>
          provider.identity.protocol === "ERC-8004" &&
          provider.identity.chainId === 97 &&
          provider.identity.explorerUrl.includes(provider.identity.registrationTransaction),
      ),
    ).toBe(true);
  });

  it("freezes exactly one evidence-only external candidate per category", () => {
    expect(EXTERNAL_COMPARISON_SNAPSHOT.candidates.map((candidate) => ({
      service: candidate.category.service,
      name: candidate.name,
      agentTokenId: candidate.agentTokenId,
      owner: candidate.identity.owner,
      status: candidate.serviceReachability.status,
    }))).toEqual([
      { service: "LENDING_RESCUE", name: "Health Factor Monitor", agentTokenId: "269228", owner: "0x91F4602760e1627007BFc16F78A74cF8B9De8Da2", status: "REACHABLE" },
      { service: "LP_REBALANCE", name: "BNB LP Range Rebalancer", agentTokenId: "265375", owner: "0x20f1cA5d1e5A3Ee94C29DbF95e6BF6ceA6a8d64b", status: "REACHABLE" },
      { service: "YIELD_OPTIMIZATION", name: "BNB Yield Optimizer", agentTokenId: "265876", owner: "0xd16faAa91F77397Bb84c69FBb89D11011bE11212", status: "REACHABLE" },
      { service: "BOUNDED_GRID", name: "GridMaster Ops", agentTokenId: "267697", owner: "0x16ec3C811bC03eb57B1519263803e4a22Caae154", status: "LISTED_ONLY" },
    ]);
    expect(EXTERNAL_COMPARISON_SNAPSHOT.snapshotHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(new Set(EXTERNAL_COMPARISON_SNAPSHOT.candidates.map((candidate) => candidate.category.service)).size).toBe(4);
    for (const candidate of EXTERNAL_COMPARISON_SNAPSHOT.candidates) {
      expect(candidate.identity.registry).toBe("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
      expect(candidate.identity.owner.toLowerCase()).not.toBe("0xadd748c416e8a7efd7d65d18abb121dea268ddf9");
      expect(candidate.pricing.amount).toBeNull();
      expect(candidate.feedback.aggregateScore).toBeNull();
      expect(candidate.positionCrewCertified).toBe(false);
      expect(candidate.positionCrewActivation).toBe("NOT_SUPPORTED");
      expect("activationUrl" in candidate).toBe(false);
      expect("activationMethod" in candidate).toBe(false);
    }
  });

  it("keeps the public ERC-8004 receipts aligned with the provider catalog", () => {
    const path = fileURLToPath(
      new URL("../evidence/bsc-identities.testnet.json", import.meta.url),
    );
    const evidence = JSON.parse(readFileSync(path, "utf8")) as {
      chainId: number;
      identityRegistry: string;
      providers: Array<{
        slug: string;
        agentId: number;
        owner: string;
        registrationTransaction: string;
      }>;
    };

    expect(evidence.chainId).toBe(97);
    expect(evidence.providers).toHaveLength(4);
    for (const provider of PROVIDER_CATALOG) {
      const receipt = evidence.providers.find((candidate) => candidate.slug === provider.slug);
      expect(receipt).toMatchObject({
        agentId: provider.identity.agentId,
        owner: provider.identity.owner,
        registrationTransaction: provider.identity.registrationTransaction,
      });
      expect(provider.identity.registry).toBe(evidence.identityRegistry);
    }
  });

  it("publishes self-describing provider contracts without overstating settlement", () => {
    const origin = "https://positioncrew.dolepee.com";
    const provider = PROVIDER_CATALOG[0]!;
    const manifest = buildProviderManifest(
      provider,
      origin,
      new Date("2026-08-12T23:00:00.000Z"),
    );
    const marketplace = buildMarketplaceManifest(
      origin,
      new Date("2026-08-12T23:00:00.000Z"),
    );
    const openApi = buildOpenApiDocument(origin);
    const [requestSchemaId, deliverableSchemaId] = schemaIdsForService(provider.service);
    const requestSchema = getSchemaDocument(requestSchemaId);
    const deliverableSchema = getSchemaDocument(deliverableSchemaId);

    expect(manifest).toMatchObject({
      schemaVersion: "positioncrew.provider-manifest.v1",
      provider: { providerId: provider.providerId, relationship: "FIRST_PARTY" },
      identity: { protocol: "ERC-8004", agentId: provider.identity.agentId },
      transport: {
        job: {
          bodyEnvelope: { mode: "CALLER_SUPPLIED_OBSERVATIONS" },
          evidenceModes: {
            default: "CALLER_SUPPLIED_OBSERVATIONS",
            lockedReceipt: "FROZEN_FIXTURE",
          },
        },
      },
      commerce: { settlement: "IN_MEMORY_CONFORMANCE" },
      pricing: {
        amount: "5",
        token: "TEST_USDC",
        judgeTrial: {
          amount: "0",
          walletRequired: false,
          settlement: "NO_PAYMENT",
        },
      },
    });
    expect(JSON.stringify(manifest)).toContain(`${origin}${provider.endpoint}`);
    expect(manifest).toMatchObject({
      commerce: {
        adapter: "AACP_PRODUCTION_RUNTIME_PENDING",
        readinessUrl: `${origin}/api/commerce/aacp`,
      },
    });
    expect(marketplace).toMatchObject({
      schemaVersion: "positioncrew.marketplace-manifest.v1",
      aacpReadinessUrl: `${origin}/api/commerce/aacp`,
      externalComparisonSnapshotUrl: `${origin}${EXTERNAL_COMPARISON_SNAPSHOT_ROUTE}`,
      claims: {
        categoryCoverage: "4_OF_4",
        providerIdentity: "ERC8004_BSC_TESTNET_VERIFIED",
        judgeTrial: "NO_WALLET_PROVIDER_CALL",
        aacp: "PRODUCTION_RUNTIME_PENDING",
      },
    });
    expect(openApi).toMatchObject({ openapi: "3.1.0", servers: [{ url: origin }] });
    expect(Object.keys((openApi.paths ?? {}) as object)).toHaveLength(19);
    expect(openApi.paths).toMatchObject({
      [EXTERNAL_COMPARISON_SNAPSHOT_ROUTE]: {
        get: { operationId: "getExternalComparisonSnapshot" },
      },
      "/api/status": { get: { operationId: "getSystemTelemetry" } },
      "/api/operations/production": {
        get: { operationId: "getProductionTrackRecord" },
      },
      "/api/benchmarks/status": {
        get: { operationId: "getBenchmarkPublicationStatus" },
      },
      "/api/benchmarks/founder-comparison/status": {
        get: { operationId: "getFounderBenchmarkPublicationStatus" },
      },
      "/api/benchmarks/marketplace-provenance": {
        get: { operationId: "getMarketplaceInvocationEvidence" },
      },
      "/api/commerce/aacp": {
        get: { operationId: "getAacpProductionReadiness" },
      },
      "/api/wallets/{account}/venus": { get: { operationId: "inspectVenusAccount" } },
      "/api/markets/pancake/wbnb-usdt/grid": {
        get: { operationId: "inspectPancakeGridMarket" },
      },
      "/api/positions/pancake/{tokenId}": {
        get: { operationId: "inspectPancakePosition" },
      },
      "/api/markets/venus/stable-yields": {
        get: { operationId: "inspectVenusStableYields" },
      },
    });
    expect(Object.keys((openApi.paths as Record<string, object>)[EXTERNAL_COMPARISON_SNAPSHOT_ROUTE] ?? {})).toEqual(["get"]);
    expect(
      ((openApi.paths as Record<string, { post: { requestBody: { content: { "application/json": { schema: { properties: { mode: { default: string } } } } } } } }>)[provider.endpoint]
        ?.post.requestBody.content["application/json"].schema.properties.mode.default),
    ).toBe("CALLER_SUPPLIED_OBSERVATIONS");
    expect(requestSchema).toMatchObject({ $id: requestSchemaId, type: "object" });
    expect(deliverableSchema).toMatchObject({ $id: deliverableSchemaId, type: "object" });
  });

  it("does not carry the locked benchmark onto a modified fixture", async () => {
    const modified = structuredClone(lendingFixture);
    modified.maxActionUsd = "100";
    const response = await runFixtureRequest(modified);

    expect(response.benchmarkLock).toBeNull();
    expect(response.receipt.mode).toBe("SESSION_EMBEDDED");
    expect(response.receipt.path).toBeNull();
    expect(response.result.deliverable.status).toBe("REFUSED_CONSTRAINTS");
  });

  it("evaluates fresh caller-supplied observations at the current request clock", async () => {
    const now = new Date("2026-08-13T01:45:00.000Z");
    const sourceObservedAt = new Date(now.getTime() - 1_000).toISOString();
    const matrix = await runFrozenMatrix();

    for (const item of matrix) {
      const request = JSON.parse(
        JSON.stringify(item.result.request).replaceAll(
          "2026-08-12T15:59:00.000Z",
          sourceObservedAt,
        ),
      );
      request.requestId = `interactive-${request.service.toLowerCase()}-test`;
      request.requestedAt = now.toISOString();
      request.deadline = new Date(now.getTime() + 5 * 60_000).toISOString();

      const response = await runSuppliedProviderRequest(request, now);
      expect(response.evidenceMode).toBe("CALLER_SUPPLIED_OBSERVATIONS");
      expect(response.generatedAt).toBe(now.toISOString());
      expect(response.benchmarkLock).toBeNull();
      expect(response.receipt).toMatchObject({ mode: "SESSION_EMBEDDED", path: null });
      expect(response.result.job.state).toBe("COMPLETED");
      expect(response.result.deliverable.status).toBe("ACTIONABLE");
      expect(new Date(response.result.deliverable.expiresAt).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("fails closed when a supplied request is stale", async () => {
    const response = await runSuppliedLendingRequest(
      lendingFixture,
      new Date("2026-08-12T16:04:30.000Z"),
    );

    expect(response.result.deliverable.status).toBe("REFUSED_STALE_DATA");
    if (response.result.deliverable.service !== "LENDING_RESCUE") {
      throw new Error("Expected a lending rescue deliverable");
    }
    expect(response.result.deliverable.recommendation).toBeNull();
  });
});

describe("fresh marketplace OpenAPI routes", () => {
  it("exposes the four persisted-hire operations with no extra methods", async () => {
    const { buildOpenApiDocument } = await import("../src/marketplace/discovery.js");
    const document = buildOpenApiDocument("https://positioncrew.example");
    const paths = document.paths as Record<string, Record<string, { operationId?: string }>>;
    const expected = [
      ["/api/benchmark-hires", "post", "createFreshMarketplaceHire"],
      ["/api/benchmark-hires/{hireId}", "get", "getFreshMarketplaceHire"],
      ["/api/benchmark-hires/{hireId}/jobs", "post", "runFreshMarketplaceHire"],
      ["/api/benchmark-receipts/{receiptId}", "get", "getFreshMarketplaceReceipt"],
    ] as const;

    for (const [path, method, operationId] of expected) {
      expect(Object.keys(paths[path] ?? {})).toEqual([method]);
      expect(paths[path]?.[method]?.operationId).toBe(operationId);
    }
    const hireOperation = paths["/api/benchmark-hires"]?.post as {
      responses?: Record<string, unknown>;
    };
    expect(Object.keys(hireOperation.responses ?? {})).toEqual([
      "200",
      "201",
      "400",
      "409",
      "413",
      "422",
      "429",
    ]);
  });
});
