import { z } from "zod";

import { runFrozenMatrix } from "../api/fixture-jobs.js";
import { canonicalHash } from "../core/canonical.js";
import { PROVIDER_CATALOG } from "./catalog.js";
import {
  PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY,
  PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION,
  ProviderContractPacketSchema,
  ProviderContractPreflightResultSchema,
  buildProviderContractTemplate,
  runProviderContractPreflight,
  verifyProviderContractPreflightResult,
} from "./provider-compatibility.js";

const ServiceIdSchema = z.enum([
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
]);

export const ProviderConformanceBundleSchema = z.object({
  schemaVersion: z.literal("positioncrew.provider-conformance-bundle.v1"),
  validatorVersion: z.literal(PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION),
  services: z.array(ServiceIdSchema).length(4),
  packets: z.record(ServiceIdSchema, ProviderContractPacketSchema),
  results: z.record(ServiceIdSchema, ProviderContractPreflightResultSchema),
  bundleHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  claimBoundary: z.literal(PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY),
}).strict();

export type ProviderConformanceBundle = z.infer<typeof ProviderConformanceBundleSchema>;

const SERVICE_ORDER = ServiceIdSchema.options;

export async function buildProviderConformanceBundle(): Promise<ProviderConformanceBundle> {
  const matrix = await runFrozenMatrix();
  const packets = Object.fromEntries(matrix.map((response) => {
    const service = response.result.request.service;
    const provider = PROVIDER_CATALOG.find((candidate) => candidate.service === service);
    if (!provider) throw new Error(`Provider catalog is missing ${service}`);
    return [service, buildProviderContractTemplate(
      provider,
      response.result.request,
      response.result.deliverable,
    )];
  }));
  const results = Object.fromEntries(SERVICE_ORDER.map((service) => {
    const packet = packets[service];
    if (!packet) throw new Error(`Frozen provider packet is missing ${service}`);
    const result = runProviderContractPreflight(packet);
    if (result.outcome !== "CONTRACT_PASS" || !verifyProviderContractPreflightResult(result)) {
      throw new Error(`Frozen ${service} provider packet failed its own preflight`);
    }
    return [service, result];
  }));
  const base = {
    schemaVersion: "positioncrew.provider-conformance-bundle.v1" as const,
    validatorVersion: PROVIDER_CONTRACT_PREFLIGHT_VALIDATOR_VERSION,
    services: [...SERVICE_ORDER],
    packets,
    results,
    claimBoundary: PROVIDER_CONTRACT_PREFLIGHT_BOUNDARY,
  };
  return ProviderConformanceBundleSchema.parse({
    ...base,
    bundleHash: canonicalHash(base),
  });
}

export function verifyProviderConformanceBundle(input: unknown): boolean {
  const parsed = ProviderConformanceBundleSchema.safeParse(input);
  if (!parsed.success) return false;
  const { bundleHash, ...base } = parsed.data;
  if (canonicalHash(base) !== bundleHash) return false;
  return parsed.data.services.every((service) => {
    const packet = parsed.data.packets[service];
    const result = parsed.data.results[service];
    return result.inputHash === runProviderContractPreflight(packet).inputHash &&
      result.outcome === "CONTRACT_PASS" &&
      verifyProviderContractPreflightResult(result);
  });
}
