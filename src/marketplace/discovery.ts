import { z } from "zod";
import {
  BoundedGridDeliverableSchema,
  BoundedGridRequestSchema,
  LendingRescueDeliverableSchema,
  LendingRescueRequestSchema,
  LpRebalanceDeliverableSchema,
  LpRebalanceRequestSchema,
  YieldOptimizationDeliverableSchema,
  YieldOptimizationRequestSchema,
  type PositionCrewRequest,
} from "../contracts/index.js";
import { PROVIDER_CATALOG, type ProviderListing } from "./catalog.js";
import {
  EXTERNAL_COMPARISON_SNAPSHOT_ROUTE,
  ExternalComparisonSnapshotSchema,
} from "./external-comparisons.js";
import {
  PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY,
  PROVIDER_CONTRACT_PREFLIGHT_ROUTE,
  ProviderContractPacketSchema,
  ProviderContractPreflightResultSchema,
  ProviderContractTemplateResponseSchema,
} from "./provider-compatibility.js";
import {
  FreshMarketplaceChainSchema,
  FreshMarketplaceHireRequestSchema,
} from "../commerce/fresh-hire-schema.js";
import {
  VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE,
  VENUS_TESTNET_NATIVE_SUPPLY_PUBLIC_CLAIM_BOUNDARY,
} from "../commerce/venus-testnet-native-supply-publication.js";
import { VenusTestnetNativeSupplyEvidenceSchema } from "../commerce/venus-testnet-native-supply-evidence.js";

type ServiceId = PositionCrewRequest["service"];

const SCHEMA_REGISTRY = new Map<string, z.ZodType>([
  ["positioncrew.lending-rescue.request.v1", LendingRescueRequestSchema],
  ["positioncrew.lending-rescue.deliverable.v1", LendingRescueDeliverableSchema],
  ["positioncrew.lp-rebalance.request.v1", LpRebalanceRequestSchema],
  ["positioncrew.lp-rebalance.deliverable.v1", LpRebalanceDeliverableSchema],
  ["positioncrew.yield-optimization.request.v1", YieldOptimizationRequestSchema],
  ["positioncrew.yield-optimization.deliverable.v1", YieldOptimizationDeliverableSchema],
  ["positioncrew.bounded-grid.request.v1", BoundedGridRequestSchema],
  ["positioncrew.bounded-grid.deliverable.v1", BoundedGridDeliverableSchema],
]);

function absolute(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

function componentName(schemaId: string): string {
  return schemaId
    .split(/[.-]/)
    .filter((part) => part !== "positioncrew" && part !== "v1")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function schemaUrl(origin: string, schemaId: string): string {
  return absolute(origin, `/api/schemas/${schemaId}`);
}

export function getProviderBySlug(slug: string): ProviderListing | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.slug === slug);
}

export function getSchemaDocument(schemaId: string): Record<string, unknown> | null {
  const schema = SCHEMA_REGISTRY.get(schemaId);
  if (!schema) return null;
  return {
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
    $id: schemaId,
    title: schemaId,
  };
}

export function buildProviderManifest(
  provider: ProviderListing,
  origin: string,
  generatedAt = new Date(),
): Record<string, unknown> {
  return {
    schemaVersion: "positioncrew.provider-manifest.v1",
    generatedAt: generatedAt.toISOString(),
    provider: {
      providerId: provider.providerId,
      operator: "PositionCrew",
      relationship: "FIRST_PARTY",
      name: provider.name,
      service: provider.service,
      category: provider.category,
      summary: provider.summary,
    },
    identity: provider.identity,
    transport: {
      protocol: "HTTPS_JSON",
      job: {
        method: provider.method,
        url: absolute(origin, provider.endpoint),
        contentType: "application/json",
        bodyEnvelope: {
          mode: "CALLER_SUPPLIED_OBSERVATIONS",
          request: `<${provider.requestSchema}>`,
        },
        evidenceModes: {
          default: "CALLER_SUPPLIED_OBSERVATIONS",
          lockedReceipt: "FROZEN_FIXTURE",
        },
      },
      health: {
        method: "GET",
        url: absolute(origin, provider.healthEndpoint),
      },
      schemas: {
        request: schemaUrl(origin, provider.requestSchema),
        deliverable: schemaUrl(origin, provider.deliverableSchema),
      },
    },
    pricing: {
      ...provider.price,
      judgeTrial: {
        amount: "0",
        token: "NONE",
        walletRequired: false,
        settlement: "NO_PAYMENT",
      },
    },
    verification: {
      mode: provider.verification,
      healthUrl: absolute(origin, provider.healthEndpoint),
      catalogUrl: absolute(origin, "/api/providers"),
    },
    commerce: {
      settlement: provider.settlement,
      adapter: "AACP_PRODUCTION_RUNTIME_PENDING",
      readinessUrl: absolute(origin, "/api/commerce/aacp"),
      freshHistoricalHireUrl: absolute(origin, "/api/benchmark-hires"),
      freshCurrentHireUrl: absolute(origin, "/api/benchmark-hires"),
      boundary:
        "The public endpoint supports three frozen historical-fixture hires and four current block-referenced BSC hires. Both are $0 no-wallet analysis paths with server-persisted request and result receipts; neither collects the listed price, independently verifies caller-supplied observations, executes a protocol transaction, or proves external demand.",
    },
  };
}

export function buildMarketplaceManifest(
  origin: string,
  generatedAt = new Date(),
): Record<string, unknown> {
  return {
    schemaVersion: "positioncrew.marketplace-manifest.v1",
    generatedAt: generatedAt.toISOString(),
    name: "PositionCrew",
    operator: "PositionCrew",
    chain: { name: "BNB Smart Chain", chainId: 56 },
    identityNetwork: {
      name: "BNB Smart Chain Testnet",
      chainId: 97,
      protocol: "ERC-8004",
      registry: PROVIDER_CATALOG[0]?.identity.registry,
    },
    catalogUrl: absolute(origin, "/api/providers"),
    openApiUrl: absolute(origin, "/openapi.json"),
    operatingRecordUrl: absolute(origin, "/api/operations/production"),
    marketplaceDeliveryEvidenceUrl: absolute(origin, "/api/benchmarks/marketplace-provenance"),
    externalComparisonSnapshotUrl: absolute(origin, EXTERNAL_COMPARISON_SNAPSHOT_ROUTE),
    providerContractPreflightUrl: absolute(origin, PROVIDER_CONTRACT_PREFLIGHT_ROUTE),
    venusTestnetNativeSupplyEvidenceUrl: absolute(origin, VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE),
    aacpReadinessUrl: absolute(origin, "/api/commerce/aacp"),
    freshHistoricalHireUrl: absolute(origin, "/api/benchmark-hires"),
    freshCurrentHireUrl: absolute(origin, "/api/benchmark-hires"),
    providers: PROVIDER_CATALOG.map((provider) => ({
      providerId: provider.providerId,
      service: provider.service,
      identity: provider.identity,
      manifestUrl: absolute(origin, provider.manifestEndpoint),
      healthUrl: absolute(origin, provider.healthEndpoint),
    })),
    claims: {
      categoryCoverage: "4_OF_4",
      providerIdentity: "ERC8004_BSC_TESTNET_VERIFIED",
      settlement: "IN_MEMORY_CONFORMANCE",
      aacp: "PRODUCTION_RUNTIME_PENDING",
      judgeTrial: "NO_WALLET_PROVIDER_CALL",
      freshHistoricalHire: "D1_PERSISTED_ZERO_COST_HISTORICAL_FIXTURE",
      freshCurrentHire: "D1_PERSISTED_ZERO_COST_CURRENT_BLOCK_PINNED",
      externalComparisons: "FOUR_THIRD_PARTY_EVIDENCE_ONLY_NON_ACTIVATABLE",
      providerContractPreflight: "CALLER_SUPPLIED_JSON_CONTRACT_ONLY",
      venusTestnetNativeSupply: VENUS_TESTNET_NATIVE_SUPPLY_PUBLIC_CLAIM_BOUNDARY,
      agentAdvantage: "PENDING_INDEPENDENT_BLIND_EVALUATION",
    },
  };
}

export function buildOpenApiDocument(origin: string): Record<string, unknown> {
  const schemas: Record<string, unknown> = Object.fromEntries(
    [...SCHEMA_REGISTRY.entries()].map(([schemaId, schema]) => [
      componentName(schemaId),
      z.toJSONSchema(schema, { target: "draft-2020-12" }),
    ]),
  );
  schemas.FreshMarketplaceHireRequest = z.toJSONSchema(
    FreshMarketplaceHireRequestSchema,
    { target: "draft-2020-12" },
  );
  schemas.FreshMarketplaceChain = z.toJSONSchema(
    FreshMarketplaceChainSchema,
    { target: "draft-2020-12" },
  );
  schemas.ExternalComparisonSnapshot = z.toJSONSchema(
    ExternalComparisonSnapshotSchema,
    { target: "draft-2020-12" },
  );
  schemas.ProviderContractPacket = z.toJSONSchema(
    ProviderContractPacketSchema,
    { target: "draft-2020-12" },
  );
  schemas.ProviderContractPreflightResult = z.toJSONSchema(
    ProviderContractPreflightResultSchema,
    { target: "draft-2020-12" },
  );
  schemas.ProviderContractTemplateResponse = z.toJSONSchema(
    ProviderContractTemplateResponseSchema,
    { target: "draft-2020-12" },
  );
  schemas.VenusTestnetNativeSupplyEvidence = z.toJSONSchema(
    VenusTestnetNativeSupplyEvidenceSchema,
    { target: "draft-2020-12" },
  );
  const providerPaths = Object.fromEntries(
    PROVIDER_CATALOG.map((provider) => [
      provider.endpoint,
      {
        get: {
          summary: `Run the frozen ${provider.category.toLowerCase()} conformance fixture`,
          operationId: `get${componentName(provider.requestSchema)}Fixture`,
          responses: { "200": { description: "Completed conformance lifecycle" } },
        },
        post: {
          summary: provider.summary,
          operationId: `run${componentName(provider.requestSchema)}`,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["request"],
                  properties: {
                    mode: {
                      type: "string",
                      enum: ["CALLER_SUPPLIED_OBSERVATIONS", "FROZEN_FIXTURE"],
                      default: "CALLER_SUPPLIED_OBSERVATIONS",
                      description:
                        "Use caller-supplied observations and timestamps for an interactive scenario. FROZEN_FIXTURE reproduces the historical public receipt and is not a current execution instruction.",
                    },
                    request: {
                      $ref: `#/components/schemas/${componentName(provider.requestSchema)}`,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: `Lifecycle receipt containing a ${provider.deliverableSchema} at result.deliverable`,
            },
            "409": { description: "Provider and requested service do not match" },
            "422": { description: "Request failed schema validation" },
          },
        },
      },
    ]),
  );
  const paths = {
    ...providerPaths,
    [EXTERNAL_COMPARISON_SNAPSHOT_ROUTE]: {
      get: {
        summary: "Read the immutable third-party comparison-candidate evidence snapshot",
        operationId: "getExternalComparisonSnapshot",
        responses: {
          "200": {
            description: "Four externally owned evidence-only candidates with no activation or certification",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ExternalComparisonSnapshot" },
              },
            },
          },
        },
      },
    },
    [PROVIDER_CONTRACT_PREFLIGHT_ROUTE]: {
      get: {
        summary: "Load one reference provider-contract packet per capital category",
        operationId: "getProviderContractPreflightTemplates",
        description: PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY,
        responses: {
          "200": {
            description: "Four caller-editable reference packets with no external activation or certification",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ProviderContractTemplateResponse" } } },
          },
        },
      },
      post: {
        summary: "Check a caller-supplied provider packet against one frozen capital-service contract",
        operationId: "runProviderContractPreflight",
        description: PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY,
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ProviderContractPacket" } } },
        },
        responses: {
          "200": {
            description: "Deterministic CONTRACT_PASS or CONTRACT_FAIL with explicit NOT_PROVEN checks",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ProviderContractPreflightResult" } } },
          },
          "400": { description: "Body is not valid JSON" },
          "413": { description: "Body exceeds the bounded request size" },
        },
      },
    },
    [VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE]: {
      get: {
        summary: "Read the immutable bounded Venus BSC Testnet native-supply receipt",
        description: VENUS_TESTNET_NATIVE_SUPPLY_PUBLIC_CLAIM_BOUNDARY,
        operationId: "getVenusTestnetNativeSupplyEvidence",
        responses: {
          "200": {
            description: "One founder-controlled 0.0001 tBNB integration receipt with strict claim boundaries",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/VenusTestnetNativeSupplyEvidence" },
              },
            },
          },
        },
      },
    },
    "/api/benchmark-hires": {
      post: {
        summary: "Persist a $0 no-wallet historical or current block-referenced hire before provider computation",
        operationId: "createFreshMarketplaceHire",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FreshMarketplaceHireRequest" },
            },
          },
        },
        responses: {
          "201": { description: "Unique hire and CREATED job persisted" },
          "200": { description: "Idempotent replay of an existing hire" },
          "400": { description: "Request body is not valid JSON" },
          "409": { description: "Idempotency key or frozen provider binding conflict" },
          "413": { description: "Request body exceeds 32768 bytes" },
          "429": { description: "Public durable-hire creation boundary reached" },
          "422": { description: "Request is not one of the three historical or four current task bindings" },
        },
      },
    },
    "/api/benchmark-hires/{hireId}": {
      get: {
        summary: "Read a complete persisted hire, job, and optional receipt chain",
        operationId: "getFreshMarketplaceHire",
        parameters: [{
          name: "hireId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        }],
        responses: {
          "200": {
            description: "Current server-persisted chain",
            content: { "application/json": { schema: { $ref: "#/components/schemas/FreshMarketplaceChain" } } },
          },
          "404": { description: "Unknown hire" },
        },
      },
    },
    "/api/benchmark-hires/{hireId}/jobs": {
      post: {
        summary: "Claim and run the already-persisted provider job",
        operationId: "runFreshMarketplaceHire",
        parameters: [{
          name: "hireId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        }],
        responses: {
          "202": { description: "Persisted job is RUNNING" },
          "200": { description: "Idempotent replay of a terminal job" },
          "404": { description: "Unknown hire" },
        },
      },
    },
    "/api/benchmark-receipts/{receiptId}": {
      get: {
        summary: "Read an immutable public receipt and its hire chain",
        operationId: "getFreshMarketplaceReceipt",
        parameters: [{
          name: "receiptId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        }],
        responses: {
          "200": {
            description: "$0 historical or current block-referenced receipt with exact response commitments",
            content: { "application/json": { schema: { $ref: "#/components/schemas/FreshMarketplaceChain" } } },
          },
          "404": { description: "Unknown receipt" },
        },
      },
    },
    "/api/status": {
      get: {
        summary: "Read current BSC, PancakeSwap, Venus, and integration-boundary telemetry",
        operationId: "getSystemTelemetry",
        responses: { "200": { description: "Current public system telemetry" } },
      },
    },
    "/api/operations/production": {
      get: {
        summary: "Read the non-cherry-picked scheduled production verification record",
        operationId: "getProductionTrackRecord",
        responses: {
          "200": {
            description:
              "Every observed scheduled verification run after the fixed epoch, or a bounded source-unavailable record",
          },
        },
      },
    },
    "/api/evidence/bounded-grid-forward-shadow": {
      get: {
        summary: "Read the forward-only zero-fund Bounded Grid shadow ledger",
        operationId: "getBoundedGridForwardShadowLedger",
        responses: {
          "200": {
            description: "Precommitted current hires, actual sampled observations, retained refusals, voids, and conservative simulated outcomes",
          },
        },
      },
    },
    "/api/evidence/bounded-grid-forward-shadow/windows/{runId}": {
      get: {
        summary: "Read one immutable or in-progress Bounded Grid shadow window",
        operationId: "getBoundedGridForwardShadowWindow",
        parameters: [{
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^bg-[0-9]{8}-[0-9]{2}$" },
        }],
        responses: {
          "200": { description: "Full ordered event chain and exact current-hire binding" },
          "404": { description: "Unknown forward shadow window" },
        },
      },
    },
    "/api/benchmarks/status": {
      get: {
        summary: "Read the truthful Agent Advantage publication status",
        operationId: "getBenchmarkPublicationStatus",
        responses: {
          "200": {
            description:
              "The tracked pending or independently verified published status without inferred completion",
          },
        },
      },
    },
    "/api/benchmarks/founder-comparison/status": {
      get: {
        summary: "Read the founder-operated Agent Advantage comparison status",
        operationId: "getFounderBenchmarkPublicationStatus",
        responses: {
          "200": {
            description:
              "The tracked founder-operated, non-independent, non-blind exact-output comparison status",
          },
        },
      },
    },
    "/api/benchmarks/marketplace-provenance": {
      get: {
        summary: "Read the precommitted public marketplace delivery record",
        operationId: "getMarketplaceInvocationEvidence",
        responses: {
          "200": {
            description:
              "Six retained no-retry Provider invocations with end-to-end timing and exact output commitments",
          },
        },
      },
    },
    "/api/commerce/aacp": {
      get: {
        summary: "Read verified TermiX production AACP deployment and PositionCrew onboarding state",
        operationId: "getAacpProductionReadiness",
        responses: {
          "200": {
            description:
              "Fail-closed BNB Chain contract probes and public Agent.family provider/listing discovery",
          },
        },
      },
    },
    "/api/wallets/{account}/venus": {
      get: {
        summary: "Convert a block-pinned Venus Classic account into an unsigned rescue request",
        operationId: "inspectVenusAccount",
        parameters: [{
          name: "account",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
        }],
        responses: {
          "200": { description: "Venus account probe and optional rescue request" },
          "500": { description: "Pinned reads were unavailable or failed reconciliation" },
        },
      },
    },
    "/api/markets/pancake/wbnb-usdt/grid": {
      get: {
        summary: "Build an unsigned bounded-grid request from one pinned PancakeSwap block",
        operationId: "inspectPancakeGridMarket",
        responses: {
          "200": { description: "Pinned Pancake market probe and unsigned grid request" },
          "500": { description: "Pinned market reads or minimum observation history were unavailable" },
        },
      },
    },
    "/api/positions/pancake/{tokenId}": {
      get: {
        summary: "Convert a block-pinned PancakeSwap V3 position NFT into an unsigned LP request",
        operationId: "inspectPancakePosition",
        parameters: [{
          name: "tokenId",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[1-9][0-9]{0,77}$" },
        }],
        responses: {
          "200": { description: "Pinned LP position probe and unsigned rebalance request" },
          "500": { description: "Position, pool, oracle, fee, or swap-window reads were unavailable" },
        },
      },
    },
    "/api/markets/venus/stable-yields": {
      get: {
        summary: "Build an unsigned yield-allocation request from one pinned Venus block",
        operationId: "inspectVenusStableYields",
        responses: {
          "200": { description: "Pinned Venus stablecoin base-rate probe and unsigned allocation request" },
          "500": { description: "Pinned market, oracle, token, or gas reads were unavailable" },
        },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "PositionCrew Provider API",
      version: "1.0.0",
      description:
        "Machine-readable contracts for four bounded BSC capital providers. Three frozen historical tasks expose a separate D1-persisted $0 no-wallet hire and receipt path. Interactive simulations do not become marketplace evidence, and paid settlement or external demand is not claimed.",
    },
    servers: [{ url: origin }],
    paths,
    components: { schemas },
  };
}

export function schemaIdsForService(service: ServiceId): [string, string] {
  const provider = PROVIDER_CATALOG.find((candidate) => candidate.service === service);
  if (!provider) throw new Error(`Unknown service: ${service}`);
  return [provider.requestSchema, provider.deliverableSchema];
}
