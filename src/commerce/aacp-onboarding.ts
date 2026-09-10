import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { z } from "zod";
import { AddressSchema, TimestampSchema } from "../contracts/common.js";
import {
  AACP_BSC_API,
  AACP_BSC_RPC,
  AACP_BSC_RPC_FALLBACK,
  AACP_PROVIDER_BLUEPRINTS,
  fetchAacpProductionConfig,
} from "./aacp-production.js";

const AgentCategorySchema = z.enum(["Market & Protocol Research", "Security & Verification"]);
const SettlementSymbolSchema = z.enum(["USDC", "USDT"]);

export const AacpAgentPreparePayloadSchema = z
  .object({
    name: z
      .string()
      .min(3)
      .max(48)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
        "Agent.family mint names must be base names without @ or .agent",
      ),
    displayName: z.string().min(3).max(120),
    category: AgentCategorySchema,
    description: z.string().min(32).max(1_000),
    tags: z.array(z.string().min(1).max(80)).min(1).max(12),
  })
  .strict();

export const AacpListingCreatePayloadSchema = z
  .object({
    title: z.string().min(3).max(160),
    category: AgentCategorySchema,
    basePrice: z.string().regex(/^[1-9]\d*(?:\.\d{1,18})?$/),
    currency: SettlementSymbolSchema,
    deliveryDays: z.number().int().min(1).max(365),
    description: z.string().min(64).max(4_000),
    skillTag: z.string().min(1).max(80),
    tags: z.array(z.string().min(1).max(80)).min(1).max(12),
    instantBuyable: z.boolean(),
    publicSearch: z.boolean(),
    challengeWindowHours: z.number().int().min(1).max(720),
    settlementType: z.enum(["escrow", "optimistic"]),
    proofMethod: z.enum(["optimistic", "manual", "evaluator"]),
    bondAmount: z.string().regex(/^\d+(?:\.\d{1,18})?$/),
    coverImageUrl: z.string().url(),
    coverImageAlt: z.string().min(20).max(300),
  })
  .strict();

const AacpOnboardingEntrySchema = z
  .object({
    service: z.enum([
      "LENDING_RESCUE",
      "LP_REBALANCE",
      "YIELD_OPTIMIZATION",
      "BOUNDED_GRID",
    ]),
    agent: AacpAgentPreparePayloadSchema,
    listing: AacpListingCreatePayloadSchema,
  })
  .strict();

export const AacpOnboardingManifestSchema = z
  .object({
    schemaVersion: z.literal("positioncrew.aacp-onboarding-manifest.v1"),
    generatedAt: TimestampSchema,
    chainId: z.literal(56),
    apiBase: z.literal(AACP_BSC_API),
    ownerWallet: AddressSchema,
    requiresWalletSession: z.literal(true),
    walletSignedAgentMints: z.literal(4),
    offchainListingPublishes: z.literal(4),
    entries: z.array(AacpOnboardingEntrySchema).length(4),
  })
  .strict()
  .superRefine((manifest, context) => {
    const mintNames = manifest.entries.map((entry) => entry.agent.name.toLowerCase());
    const services = manifest.entries.map((entry) => entry.service);
    const listingTitles = manifest.entries.map((entry) => entry.listing.title.toLowerCase());
    for (const [path, values] of [
      ["agent.name", mintNames],
      ["service", services],
      ["listing.title", listingTitles],
    ] as const) {
      if (new Set(values).size !== manifest.entries.length) {
        context.addIssue({
          code: "custom",
          path: ["entries"],
          message: `${path} values must be unique across the four providers`,
        });
      }
    }
  });

export type AacpOnboardingManifest = z.infer<typeof AacpOnboardingManifestSchema>;

export function buildAacpOnboardingManifest(
  ownerWallet: string,
  now = new Date(),
): AacpOnboardingManifest {
  return AacpOnboardingManifestSchema.parse({
    schemaVersion: "positioncrew.aacp-onboarding-manifest.v1",
    generatedAt: now.toISOString(),
    chainId: 56,
    apiBase: AACP_BSC_API,
    ownerWallet,
    requiresWalletSession: true,
    walletSignedAgentMints: 4,
    offchainListingPublishes: 4,
    entries: AACP_PROVIDER_BLUEPRINTS.map((provider) => ({
      service: provider.service,
      agent: {
        name: provider.mintName,
        displayName: provider.displayName,
        category: provider.category,
        description: provider.description,
        tags: provider.tags,
      },
      listing: provider.listing,
    })),
  });
}

const BALANCE_OF_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function decimalToUnits(value: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`${value} exceeds ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

function formatUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function rpcRead(
  rpcUrl: string,
  calls: Array<{ method: string; params: unknown[] }>,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, ...call })),
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`BSC RPC returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length !== calls.length) {
    throw new Error("BSC RPC returned an incomplete balance batch");
  }
  const responses = payload as RpcResponse[];
  const byId = new Map(responses.map((entry) => [entry.id, entry]));
  return calls.map((_, index) => {
    const entry = byId.get(index + 1);
    if (!entry) throw new Error(`BSC RPC omitted response ${index + 1}`);
    if (entry.error) throw new Error(`BSC RPC ${entry.error.code}: ${entry.error.message}`);
    return entry.result;
  });
}

function parseRpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} returned an invalid RPC quantity`);
  }
  return BigInt(value);
}

export async function inspectAacpOnboardingWallet(
  ownerWalletInput: string,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
) {
  const ownerWallet = getAddress(AddressSchema.parse(ownerWalletInput));
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = await fetchAacpProductionConfig({ fetchImpl });
  const calls = [
    { method: "eth_chainId", params: [] },
    { method: "eth_getBalance", params: [ownerWallet, "latest"] },
    ...config.settlementCurrencies.map((currency) => ({
      method: "eth_call",
      params: [
        {
          to: currency.address,
          data: encodeFunctionData({
            abi: BALANCE_OF_ABI,
            functionName: "balanceOf",
            args: [ownerWallet],
          }),
        },
        "latest",
      ],
    })),
  ];
  let values: unknown[] | null = null;
  let rpcUrl = AACP_BSC_RPC;
  let firstError: unknown = null;
  for (const candidate of [AACP_BSC_RPC, AACP_BSC_RPC_FALLBACK]) {
    try {
      values = await rpcRead(candidate, calls, fetchImpl);
      rpcUrl = candidate;
      break;
    } catch (error) {
      firstError ??= error;
    }
  }
  if (!values) throw firstError instanceof Error ? firstError : new Error("BSC RPC unavailable");
  if (values[0] !== "0x38") throw new Error(`AACP wallet RPC chain mismatch: ${String(values[0])}`);

  const nativeRaw = parseRpcQuantity(values[1], "BNB balance");
  const currencies = config.settlementCurrencies.map((currency, index) => {
    const raw = parseRpcQuantity(values![index + 2], `${currency.symbol} balance`);
    const required = AACP_PROVIDER_BLUEPRINTS.find(
      (provider) => provider.listing.currency === currency.symbol,
    )?.listing.basePrice;
    return {
      symbol: currency.symbol,
      address: currency.address,
      decimals: currency.decimals,
      raw: raw.toString(),
      display: formatUnits(raw, currency.decimals),
      oneFlagshipOrderAmount: required ?? null,
      canFundOneFlagshipOrder: required
        ? raw >= decimalToUnits(required, currency.decimals)
        : null,
    };
  });

  return {
    schemaVersion: "positioncrew.aacp-onboarding-wallet-readiness.v1" as const,
    observedAt: (options.now ?? new Date()).toISOString(),
    chainId: 56 as const,
    rpcUrl,
    ownerWallet,
    nativeGas: {
      symbol: "BNB" as const,
      raw: nativeRaw.toString(),
      display: formatUnits(nativeRaw, 18),
      present: nativeRaw > 0n,
    },
    currencies,
    boundaries: [
      "This is a read-only balance preflight; it does not estimate or reserve gas.",
      "Agent preparation, minting, listing publication, runtime token issuance, and paid orders remain explicit operator actions.",
    ],
  };
}
