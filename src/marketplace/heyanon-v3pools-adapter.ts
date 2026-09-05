import { z } from "zod";
import { createBscVerificationRpc, type BscVerificationRpc } from "./bsc-verification-rpc.js";

export const HEYANON_V3_POOLS = {
  name: "V3 Pools powered by HeyAnon",
  agentTokenId: 45650,
  owner: "0xda977767452c5dd021624511f14df67b6c9c2c1b",
  endpoint: "https://erc8004.heyanon.ai/mcp/v3pools",
} as const;

export const PANCAKE_V3_POSITION_MANAGER =
  "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364";

const AddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const DecimalSchema = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

const ExternalPositionSchema = z.object({
  chainName: z.literal("bsc"),
  protocol: z.literal("Pancake"),
  positionId: z.string().regex(/^\d+$/),
  token0: z.object({ symbol: z.string().min(1), address: AddressSchema }).strict(),
  token1: z.object({ symbol: z.string().min(1), address: AddressSchema }).strict(),
  fee: z.string().regex(/^\d+(\.\d+)?%$/),
  liquidity: z.string().regex(/^\d+$/),
  amount0: DecimalSchema,
  amount0Pct: z.number().min(0).max(100),
  amount1: DecimalSchema,
  amount1Pct: z.number().min(0).max(100),
  pendingFee0: DecimalSchema,
  pendingFee1: DecimalSchema,
  currentPrice: DecimalSchema,
  lowerPrice: DecimalSchema,
  upperPrice: DecimalSchema,
}).strict();

const ToolEnvelopeSchema = z.object({
  project: z.literal("v3pools"),
  operation: z.literal("getLpPosition"),
  data: z.object({ positions: z.array(ExternalPositionSchema).min(1) }).strict(),
}).strict();

const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

export type HeyAnonV3Position = z.infer<typeof ExternalPositionSchema>;

export interface PinnedPancakeV3Position {
  blockNumber: number;
  positionId: string;
  owner: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
}

export interface HeyAnonV3PositionAssessment {
  schemaVersion: "positioncrew.external-lp-position-assessment.v1";
  adapterId: "positioncrew:mcp:heyanon-v3pools:lp-position:v1";
  provider: typeof HEYANON_V3_POOLS;
  positionManager: typeof PANCAKE_V3_POSITION_MANAGER;
  external: HeyAnonV3Position;
  onchain: PinnedPancakeV3Position;
  checks: Array<{
    code: string;
    status: "PASS" | "FAIL";
    detail: string;
  }>;
  status: "PARTIAL_COMPATIBILITY";
  eligibleForLpRebalance: false;
  claimBoundary: string[];
}

function parseEventStream(raw: string): unknown {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : raw) as unknown;
}

function argument(positionId: string): string {
  const value = BigInt(positionId);
  if (value < 0n) throw new Error("Position ID must be non-negative");
  return value.toString(16).padStart(64, "0");
}

function addressWord(word: string): string {
  return `0x${word.slice(-40)}`.toLowerCase();
}

function uintWord(word: string): bigint {
  return BigInt(`0x${word}`);
}

function int24Word(word: string): number {
  const masked = Number(uintWord(word) & 0xff_ffffn);
  return masked >= 0x80_0000 ? masked - 0x100_0000 : masked;
}

export async function fetchHeyAnonV3Position(
  positionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HeyAnonV3Position> {
  argument(positionId);
  const response = await fetchImpl(HEYANON_V3_POOLS.endpoint, {
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
        name: "getLpPosition",
        arguments: { lpPositions: [{ chainName: "bsc", positionId }] },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`HeyAnon V3 MCP returned HTTP ${response.status}`);
  }
  const mcp = McpResponseSchema.parse(parseEventStream(await response.text()));
  const content = mcp.result.content.find((item) => item.type === "text");
  if (!content) throw new Error("HeyAnon V3 MCP returned no text result");
  const envelope = ToolEnvelopeSchema.parse(JSON.parse(content.text) as unknown);
  const position = envelope.data.positions.find((item) => item.positionId === positionId);
  if (!position) throw new Error("HeyAnon V3 MCP did not return the requested position ID");
  return position;
}

export async function fetchPinnedPancakeV3Position(
  positionId: string,
  rpcUrl = "https://bsc-rpc.publicnode.com",
  fetchImpl: typeof fetch = fetch,
  verificationRpc: BscVerificationRpc = createBscVerificationRpc(rpcUrl, fetchImpl),
): Promise<PinnedPancakeV3Position> {
  const encoded = argument(positionId);
  const blockHex = await verificationRpc.request("eth_blockNumber", []);
  const blockNumber = Number(BigInt(blockHex));
  const [positionRaw, ownerRaw] = await Promise.all([
    verificationRpc.request("eth_call", [{
      to: PANCAKE_V3_POSITION_MANAGER,
      data: `0x99fbab88${encoded}`,
    }, blockHex]),
    verificationRpc.request("eth_call", [{
      to: PANCAKE_V3_POSITION_MANAGER,
      data: `0x6352211e${encoded}`,
    }, blockHex]),
  ]);
  const body = positionRaw.slice(2);
  if (body.length !== 64 * 12) {
    throw new Error("Pancake V3 position response has an invalid ABI length");
  }
  const words = Array.from({ length: 12 }, (_, index) =>
    body.slice(index * 64, (index + 1) * 64)
  );
  return {
    blockNumber,
    positionId,
    owner: addressWord(ownerRaw.slice(2)),
    token0: addressWord(words[2]!),
    token1: addressWord(words[3]!),
    fee: Number(uintWord(words[4]!)),
    tickLower: int24Word(words[5]!),
    tickUpper: int24Word(words[6]!),
    liquidity: uintWord(words[7]!).toString(),
  };
}

export function assessHeyAnonV3Position(
  external: HeyAnonV3Position,
  onchain: PinnedPancakeV3Position,
): HeyAnonV3PositionAssessment {
  const externalFee = Math.round(Number.parseFloat(external.fee) * 10_000);
  const sameId = external.positionId === onchain.positionId;
  const sameTokens = external.token0.address.toLowerCase() === onchain.token0 &&
    external.token1.address.toLowerCase() === onchain.token1;
  const sameFee = externalFee === onchain.fee;
  const sameLiquidity = external.liquidity === onchain.liquidity;
  return {
    schemaVersion: "positioncrew.external-lp-position-assessment.v1",
    adapterId: "positioncrew:mcp:heyanon-v3pools:lp-position:v1",
    provider: HEYANON_V3_POOLS,
    positionManager: PANCAKE_V3_POSITION_MANAGER,
    external,
    onchain,
    checks: [
      { code: "PUBLIC_REMOTE_ENDPOINT", status: "PASS", detail: "The listed public MCP returned a schema-valid position." },
      { code: "POSITION_IDENTITY", status: sameId ? "PASS" : "FAIL", detail: sameId ? "The requested NFT ID matches." : "The external NFT ID does not match." },
      { code: "TOKEN_PAIR", status: sameTokens ? "PASS" : "FAIL", detail: sameTokens ? "Both token addresses match the pinned position manager response." : "The token pair differs from pinned BSC state." },
      { code: "FEE_TIER", status: sameFee ? "PASS" : "FAIL", detail: sameFee ? "The fee tier matches pinned BSC state." : "The fee tier differs from pinned BSC state." },
      { code: "RAW_LIQUIDITY", status: sameLiquidity ? "PASS" : "FAIL", detail: sameLiquidity ? "Raw position liquidity matches pinned BSC state." : "Raw position liquidity differs from pinned BSC state." },
      { code: "OWNER_ATTRIBUTION", status: "FAIL", detail: "The provider response omits the NFT owner; PositionCrew recovered it independently onchain." },
      { code: "PROVIDER_BLOCK_ATTRIBUTION", status: "FAIL", detail: "The provider response omits its observation block; PositionCrew's comparison is pinned independently." },
      { code: "MARKET_ECONOMICS", status: "FAIL", detail: "The provider response omits 24-hour volume, fees, realized volatility, gas, and swap cost." },
      { code: "EXACT_OUTPUT_CONTRACT", status: "FAIL", detail: "The provider returns a position observation, not positioncrew.lp-rebalance.deliverable.v1." },
    ],
    status: "PARTIAL_COMPATIBILITY",
    eligibleForLpRebalance: false,
    claimBoundary: [
      "This is a read-only observation and independent onchain cross-check, not a hire or activation.",
      "Matching identity fields do not prove a complete LP-rebalance recommendation.",
      "No approval, signature, payment, simulation, or transaction occurred.",
    ],
  };
}

export async function auditionHeyAnonV3Position(
  positionId: string,
  options: { rpcUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<HeyAnonV3PositionAssessment> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [external, onchain] = await Promise.all([
    fetchHeyAnonV3Position(positionId, fetchImpl),
    fetchPinnedPancakeV3Position(positionId, options.rpcUrl, fetchImpl),
  ]);
  return assessHeyAnonV3Position(external, onchain);
}
