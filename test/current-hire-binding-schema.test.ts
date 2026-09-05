import { describe, expect, it } from "vitest";
import { z } from "zod";
import lending from "../fixtures/lending-rescue/stressed-venus-position.v1.json" with { type: "json" };
import lp from "../fixtures/provider-conformance/lp-valid.v2.json" with { type: "json" };
import yieldInput from "../fixtures/yield-optimization/venus-to-beefy.v1.json" with { type: "json" };
import grid from "../fixtures/provider-conformance/grid-valid.v2.json" with { type: "json" };
import {
  CurrentBlockPinnedEvidenceSchema,
  CurrentGridMarketplaceHireRequestSchema,
  CurrentLendingMarketplaceHireRequestSchema,
  CurrentLpMarketplaceHireRequestSchema,
  CurrentYieldMarketplaceHireRequestSchema,
  FreshMarketplaceHireRequestSchema,
  LendingProviderAuditionHireRequestSchema,
} from "../src/commerce/fresh-hire-schema.js";
import { issueServerObservationBinding } from "../src/commerce/server-observation-binding.js";
import { PositionCrewRequestSchema } from "../src/contracts/index.js";
import { buildOpenApiDocument } from "../src/marketplace/discovery.js";

const NOW = new Date("2026-08-12T16:00:30.000Z");
const KEY = "test-only-current-hire-schema-observation-key-0000000000000001";
const observation = {
  blockNumber: "30000000",
  observedAt: "2026-08-12T15:59:00.000Z",
  explorerUrl: "https://bscscan.com/block/30000000",
};
const variants = [
  { name: "Lending", slug: "lending-rescue", fixture: lending,
    schema: CurrentLendingMarketplaceHireRequestSchema,
    protocol: "Venus Classic", sourceId: "venus-mainnet-block-30000000", requestId: "venus-schema-30000000" },
  { name: "LP", slug: "lp-rebalance", fixture: lp,
    schema: CurrentLpMarketplaceHireRequestSchema,
    protocol: "PancakeSwap V3 position analysis", sourceId: "pancake-position-mainnet-block-30000000", requestId: "pancake-position-1456267-30000000" },
  { name: "Yield", slug: "yield-optimization", fixture: yieldInput,
    schema: CurrentYieldMarketplaceHireRequestSchema,
    protocol: "Venus Core Pool stablecoin supply", sourceId: "venus-yield-mainnet-block-30000000", requestId: "venus-yield-30000000" },
  { name: "Grid", slug: "bounded-grid", fixture: grid,
    schema: CurrentGridMarketplaceHireRequestSchema,
    protocol: "PancakeSwap V3 bounded grid policy", sourceId: "pancake-v3-mainnet-block-30000000", requestId: "pancake-grid-30000000" },
] as const;

function bindObservationFields(value: unknown, sourceId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => bindObservationFields(item, sourceId));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "sourceId" ? sourceId
        : key === "observedAt" ? observation.observedAt
          : bindObservationFields(item, sourceId),
    ]));
  }
  return value;
}

async function boundInput(variant: typeof variants[number]) {
  const request = PositionCrewRequestSchema.parse(bindObservationFields(variant.fixture, variant.sourceId));
  request.chainId = 56;
  request.requestId = variant.requestId;
  request.protocol = variant.protocol;
  request.requestedAt = "2026-08-12T16:00:00.000Z";
  request.deadline = "2026-08-12T16:05:00.000Z";
  request.maxDataAgeSeconds = 300;
  request.sources = [{
    sourceId: variant.sourceId,
    label: "Synthetic schema fixture at BSC block 30000000",
    uri: observation.explorerUrl,
    observedAt: observation.observedAt,
  }];
  if (request.service === "LENDING_RESCUE") request.market = "0xfD36E2c2a6789Db23113685031d7F16329158384";
  const observationBinding = await issueServerObservationBinding(request, observation, KEY, NOW);
  return {
    schemaVersion: "positioncrew.fresh-marketplace-hire-request.v2" as const,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    benchmarkSlug: variant.slug,
    providerSlug: variant.slug,
    evidenceMode: "CURRENT_BLOCK_PINNED" as const,
    observation,
    observationBinding,
    request,
  };
}

interface JsonSchema {
  const?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
}

describe("current-hire observation binding contract", () => {
  it.each(variants)("accepts a server-bound $name input through the direct and parent schemas", async (variant) => {
    const input = await boundInput(variant);
    expect(variant.schema.parse(input)).toEqual(input);
    expect(FreshMarketplaceHireRequestSchema.parse(input)).toEqual(input);
  });

  it.each(variants)("requires the binding in both $name request validators", async (variant) => {
    const input: Record<string, unknown> = { ...await boundInput(variant) };
    delete input.observationBinding;
    expect(() => variant.schema.parse(input)).toThrow();
    expect(() => FreshMarketplaceHireRequestSchema.parse(input)).toThrow();
  });

  it.each([
    ...variants.map(({ name, schema }) => ({ name, schema })),
    { name: "Lending audition", schema: LendingProviderAuditionHireRequestSchema },
  ])("marks observationBinding required in the generated $name JSON schema", ({ schema }) => {
    const document = z.toJSONSchema(schema, { target: "draft-2020-12" }) as JsonSchema;
    expect(document.properties?.observationBinding).toBeDefined();
    expect(document.required).toContain("observationBinding");
  });

  it("publishes the same required binding for all four current-hire OpenAPI variants", () => {
    const document = buildOpenApiDocument("https://positioncrew.example");
    const components = document.components as { schemas: Record<string, JsonSchema> };
    const schema = components.schemas.FreshMarketplaceHireRequest!;
    const current = (schema.anyOf ?? []).filter((variant) =>
      variant.properties?.evidenceMode?.const === "CURRENT_BLOCK_PINNED");
    expect(current).toHaveLength(4);
    expect(current.map((variant) => variant.properties?.benchmarkSlug?.const).sort())
      .toEqual(variants.map((variant) => variant.slug).sort());
    for (const variant of current) {
      expect(variant.properties?.observationBinding).toBeDefined();
      expect(variant.required).toContain("observationBinding");
    }
  });

  it("also requires the binding in the separate public Lending audition request", async () => {
    const current = await boundInput(variants[0]);
    const input = {
      schemaVersion: "positioncrew.lending-provider-audition-hire-request.v1",
      idempotencyKey: current.idempotencyKey,
      evidenceMode: current.evidenceMode,
      observation: current.observation,
      observationBinding: current.observationBinding,
      request: current.request,
    };
    expect(LendingProviderAuditionHireRequestSchema.parse(input)).toEqual(input);
    const unbound: Record<string, unknown> = { ...input };
    delete unbound.observationBinding;
    expect(() => LendingProviderAuditionHireRequestSchema.parse(unbound)).toThrow();
  });

  it("preserves legacy persisted evidence without silently adding a binding", () => {
    const legacy = {
      schemaVersion: "positioncrew.current-block-pinned-evidence.v1",
      evidenceClass: "CURRENT_BLOCK_PINNED",
      chainId: 56,
      source: observation,
      freshnessAtCreation: "FRESH",
      evaluatedAt: NOW.toISOString(),
      maxDataAgeSeconds: 300,
    };
    const parsed = CurrentBlockPinnedEvidenceSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed).not.toHaveProperty("observationBinding");
  });

  it("retains optionality only on the persisted-evidence JSON schema", () => {
    const schema = z.toJSONSchema(CurrentBlockPinnedEvidenceSchema, { target: "draft-2020-12" }) as JsonSchema;
    expect(schema.properties?.observationBinding).toBeDefined();
    expect(schema.required).not.toContain("observationBinding");
  });
});
