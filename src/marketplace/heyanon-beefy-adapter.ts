import { z } from "zod";
import {
  YieldOptimizationRequestSchema,
  type YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";

export const HEYANON_BEEFY = {
  name: "Beefy powered by HeyAnon",
  agentTokenId: 45422,
  owner: "0xda977767452c5dd021624511f14df67b6c9c2c1b",
  endpoint: "https://erc8004.heyanon.ai/mcp/beefy",
} as const;

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

const BeefyVaultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  chain: z.literal("bsc"),
  tokenProviderId: z.string().min(1),
  platform: z.string().min(1),
  token: z.string().min(1),
  tokenAddress: AddressSchema,
  tvl: z.number().nonnegative(),
  poolTvl: z.number().nonnegative(),
  apy: z.number().nonnegative(),
}).strict();

const BeefyToolEnvelopeSchema = z.object({
  project: z.literal("beefy"),
  operation: z.literal("getVaultsWithTokens"),
  data: z.array(z.object({
    chain: z.literal("bsc"),
    token: z.string().min(1),
    vaults: z.array(BeefyVaultSchema),
  }).strict()),
}).strict();

const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    content: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

export type HeyAnonBeefyVault = z.infer<typeof BeefyVaultSchema>;

export interface HeyAnonBeefyCheck {
  code:
    | "PUBLIC_REMOTE_ENDPOINT"
    | "REQUEST_ASSET_DISCOVERY"
    | "OPPORTUNITY_IDENTITY_COVERAGE"
    | "APY_AND_LIQUIDITY_EVIDENCE"
    | "OBSERVATION_ATTRIBUTION"
    | "RISK_LOCKUP_AND_COST_EVIDENCE"
    | "EXACT_OUTPUT_CONTRACT"
    | "ENDPOINT_DOMAIN_CONTROL";
  status: "PASS" | "FAIL";
  detail: string;
}

export interface HeyAnonBeefyMatch {
  opportunityId: string;
  vaultId: string;
  vaultAddress: string;
  requestGrossApyBps: number;
  providerGrossApyBps: number;
  requestLiquidityUsd: string;
  providerVaultTvlUsd: string;
  providerPoolTvlUsd: string;
}

export interface HeyAnonBeefyAssessment {
  schemaVersion: "positioncrew.external-yield-adapter-assessment.v1";
  adapterId: "positioncrew:mcp:heyanon-beefy:yield:v1";
  provider: typeof HEYANON_BEEFY;
  requestId: string;
  requestedSymbols: string[];
  matches: HeyAnonBeefyMatch[];
  checks: HeyAnonBeefyCheck[];
  status: "PARTIAL_COMPATIBILITY";
  eligibleForYieldOptimization: false;
  claimBoundary: string[];
}

function parseMcpBody(raw: string): unknown {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : raw) as unknown;
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Beefy returned an invalid non-negative decimal");
  }
  return value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 12,
  });
}

export async function fetchHeyAnonBeefyVaults(
  symbols: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<HeyAnonBeefyVault[]> {
  const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))]
    .filter(Boolean)
    .sort();
  if (normalized.length === 0) {
    throw new Error("At least one asset symbol is required for Beefy discovery");
  }
  const response = await fetchImpl(HEYANON_BEEFY.endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "getVaultsWithTokens",
        arguments: {
          tokensOnChains: [{ chainName: "bsc", tokenSymbols: normalized }],
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`HeyAnon Beefy MCP returned HTTP ${response.status}`);
  }
  const mcp = McpResponseSchema.parse(parseMcpBody(await response.text()));
  const content = mcp.result.content.find((item) => item.type === "text");
  if (!content) {
    throw new Error("HeyAnon Beefy MCP returned no text result");
  }
  const envelope = BeefyToolEnvelopeSchema.parse(JSON.parse(content.text) as unknown);
  return envelope.data.flatMap((group) => group.vaults);
}

export function assessHeyAnonBeefyForYieldRequest(
  input: YieldOptimizationRequest,
  vaults: HeyAnonBeefyVault[],
): HeyAnonBeefyAssessment {
  const request = YieldOptimizationRequestSchema.parse(input);
  const requestedSymbols = [...new Set(
    request.opportunities.map((opportunity) => opportunity.asset.symbol.toUpperCase()),
  )].sort();
  const matches = request.opportunities.flatMap((opportunity) => {
    const address = opportunity.vaultOrMarket.toLowerCase();
    const match = vaults.find((vault) =>
      vault.tokenAddress.toLowerCase() === address || vault.id === opportunity.opportunityId
    );
    return match ? [{
      opportunityId: opportunity.opportunityId,
      vaultId: match.id,
      vaultAddress: match.tokenAddress,
      requestGrossApyBps: opportunity.grossApyBps,
      providerGrossApyBps: Math.round(match.apy * 10_000),
      requestLiquidityUsd: opportunity.liquidityUsd,
      providerVaultTvlUsd: decimal(match.tvl),
      providerPoolTvlUsd: decimal(match.poolTvl),
    }] : [];
  });
  const allMatched = matches.length === request.opportunities.length;
  const checks: HeyAnonBeefyCheck[] = [
    {
      code: "PUBLIC_REMOTE_ENDPOINT",
      status: "PASS",
      detail: "The public ERC-8004 MCP endpoint returned a schema-valid Beefy vault response.",
    },
    {
      code: "REQUEST_ASSET_DISCOVERY",
      status: vaults.length > 0 ? "PASS" : "FAIL",
      detail: vaults.length > 0
        ? `The provider returned ${vaults.length} BSC vault record(s) for the requested asset set.`
        : "The provider returned no BSC vault records for the requested asset set.",
    },
    {
      code: "OPPORTUNITY_IDENTITY_COVERAGE",
      status: allMatched ? "PASS" : "FAIL",
      detail: allMatched
        ? "Every frozen opportunity matched an external vault by exact address or provider vault ID."
        : `${matches.length}/${request.opportunities.length} frozen opportunities matched an external vault by exact identity.`,
    },
    {
      code: "APY_AND_LIQUIDITY_EVIDENCE",
      status: matches.length > 0 ? "PASS" : "FAIL",
      detail: matches.length > 0
        ? "Matched provider records include APY, vault TVL, and pool TVL."
        : "No matched provider record can bind APY or liquidity to the frozen job.",
    },
    {
      code: "OBSERVATION_ATTRIBUTION",
      status: "FAIL",
      detail: "The provider response does not include an observation time, BSC block, or source identifier.",
    },
    {
      code: "RISK_LOCKUP_AND_COST_EVIDENCE",
      status: "FAIL",
      detail: "The provider response does not bind risk tier, lockup, entry cost, or exit cost to each vault.",
    },
    {
      code: "EXACT_OUTPUT_CONTRACT",
      status: "FAIL",
      detail: "The provider returns vault discovery data, not positioncrew.yield-optimization.deliverable.v1.",
    },
    {
      code: "ENDPOINT_DOMAIN_CONTROL",
      status: "FAIL",
      detail: "Endpoint ownership is represented by ERC-8004 metadata but separate domain-control proof is unavailable.",
    },
  ];
  return {
    schemaVersion: "positioncrew.external-yield-adapter-assessment.v1",
    adapterId: "positioncrew:mcp:heyanon-beefy:yield:v1",
    provider: HEYANON_BEEFY,
    requestId: request.requestId,
    requestedSymbols,
    matches,
    checks,
    status: "PARTIAL_COMPATIBILITY",
    eligibleForYieldOptimization: false,
    claimBoundary: [
      "This is a read-only external-provider audition, not a hire, payment, activation, or transaction.",
      "PositionCrew does not import missing safety fields from the frozen request as if the provider supplied them.",
      "No provider ranking or selection claim is earned until an exact output contract passes.",
    ],
  };
}

export async function auditionHeyAnonBeefyForYieldRequest(
  input: YieldOptimizationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<HeyAnonBeefyAssessment> {
  const request = YieldOptimizationRequestSchema.parse(input);
  const symbols = request.opportunities.map((opportunity) => opportunity.asset.symbol);
  const vaults = await fetchHeyAnonBeefyVaults(symbols, fetchImpl);
  return assessHeyAnonBeefyForYieldRequest(request, vaults);
}
