import {
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  isAddress,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  BoundedGridRequestSchema,
  type BoundedGridRequest,
} from "../contracts/bounded-grid.js";
import {
  LendingRescueRequestSchema,
  type LendingRescueRequest,
} from "../contracts/lending-rescue.js";
import {
  LpRebalanceRequestSchema,
  type LpRebalanceRequest,
} from "../contracts/lp-rebalance.js";
import {
  YieldOptimizationRequestSchema,
  type YieldOptimizationRequest,
} from "../contracts/yield-optimization.js";
import { FIXED_SCALE, formatFixed } from "../core/fixed.js";

const MAINNET_RPC = "https://bsc-dataseed-public.bnbchain.org";
const LOG_RPC = "https://bsc-rpc.publicnode.com";
const LEGACY_MAINNET_RPC = "https://bsc-dataseed.bnbchain.org";
const TESTNET_RPC = "https://bsc-testnet-dataseed.bnbchain.org";
const RPC_TRANSPORT_ATTEMPTS = 2;
const RPC_RETRY_DELAY_MS = 150;
const RPC_HEDGE_DELAY_MS = 150;

const PANCAKE_V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865" as Address;
const PANCAKE_V3_POSITION_MANAGER = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364" as Address;
const PANCAKE_MASTER_CHEF_V3 = "0x556B9306565093C855AEA9AE92A594704c2Cd59e" as Address;
const PANCAKE_V3_SWAP_TOPIC =
  "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83" as Hex;
const NATIVE_BNB = "0x0000000000000000000000000000000000000000" as Address;
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address;
const USDT = "0x55d398326f99059fF775485246999027B3197955" as Address;
const VENUS_COMPTROLLER = "0xfD36E2c2a6789Db23113685031d7F16329158384" as Address;
const VENUS_VUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255" as Address;
const VENUS_VBNB = "0xA07c5b74C9B40447a954e1466938b865b6BBea36" as Address;
const VENUS_STABLE_MARKETS = [
  {
    symbol: "USDC",
    vToken: "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8" as Address,
    underlying: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" as Address,
  },
  {
    symbol: "USDT",
    vToken: VENUS_VUSDT,
    underlying: USDT,
  },
  {
    symbol: "DAI",
    vToken: "0x334b3eCB4DCa3593BCCC3c7EBD1A1C1d1780FBF1" as Address,
    underlying: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" as Address,
  },
  {
    symbol: "FDUSD",
    vToken: "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba" as Address,
    underlying: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409" as Address,
  },
] as const;

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const POSITION_MANAGER_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)",
]);
const VTOKEN_ABI = parseAbi([
  "function supplyRatePerBlock() view returns (uint256)",
  "function borrowRatePerBlock() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function getAccountSnapshot(address account) view returns (uint256 errorCode, uint256 vTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)",
  "function underlying() view returns (address)",
]);
const COMPTROLLER_ABI = parseAbi([
  "function getAccountLiquidity(address account) view returns (uint256 errorCode, uint256 liquidity, uint256 shortfall)",
  "function getAssetsIn(address account) view returns (address[] markets)",
  "function markets(address market) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus, uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa, uint96 marketPoolId, bool isBorrowAllowed)",
  "function getEffectiveLtvFactor(address account, address market, uint8 weightingStrategy) view returns (uint256)",
  "function oracle() view returns (address)",
  "function vaiController() view returns (address)",
]);
const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const ORACLE_ABI = parseAbi([
  "function getUnderlyingPrice(address vToken) view returns (uint256)",
]);
const VAI_CONTROLLER_ABI = parseAbi([
  "function getVAIAddress() view returns (address)",
  "function getVAIRepayAmount(address account) view returns (uint256)",
]);

interface RpcCall {
  method: string;
  params: unknown[];
}

interface RpcResult {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTransportError";
  }
}

export function firstSuccessfulRpcTransport<T>(
  candidates: readonly string[],
  operation: (candidate: string) => Promise<T>,
  hedgeDelayMs = 0,
): Promise<T> {
  if (candidates.length === 0) {
    return Promise.reject(new RpcTransportError("No BSC RPC providers are configured"));
  }
  return new Promise<T>((resolve, reject) => {
    let pending = candidates.length;
    let settled = false;
    const failures: string[] = [];
    let deterministicError: unknown;
    const launched = new Set<number>();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const clearTimers = () => timers.forEach((timer) => clearTimeout(timer));
    const launchCandidate = (index: number) => {
      if (settled || launched.has(index)) return;
      launched.add(index);
      const candidate = candidates[index]!;
      void Promise.resolve().then(() => operation(candidate)).then((value) => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(value);
      }).catch((error: unknown) => {
        if (settled) return;
        if (error instanceof RpcTransportError) {
          failures.push(`${new URL(candidate).host}: ${error.message}`);
        } else if (deterministicError === undefined) {
          deterministicError = error;
        }
        pending -= 1;
        if (pending === 0) {
          settled = true;
          clearTimers();
          reject(deterministicError ?? new RpcTransportError(
            `BSC RPC providers unavailable (${failures.join("; ")})`,
          ));
        } else if (hedgeDelayMs > 0) {
          // A failed endpoint should not delay the next available route.
          const next = candidates.findIndex((_candidate, candidateIndex) => !launched.has(candidateIndex));
          if (next >= 0) launchCandidate(next);
        }
      });
    };
    if (hedgeDelayMs > 0) {
      // Avoid sending every healthy read to all providers. Slow requests still
      // gain backup routes quickly, without waiting for the transport timeout.
      for (let index = 1; index < candidates.length; index += 1) {
        timers.push(setTimeout(() => launchCandidate(index), index * hedgeDelayMs));
      }
      launchCandidate(0);
    } else {
      for (let index = 0; index < candidates.length; index += 1) launchCandidate(index);
    }
  });
}

interface RpcBlock {
  number: Hex;
  hash: Hex;
  timestamp: Hex;
}

interface RpcLog {
  data: Hex;
  topics: Hex[];
}

export function rpcFallbacks(primary: string): readonly string[] {
  if (primary === MAINNET_RPC) return [MAINNET_RPC, LOG_RPC, LEGACY_MAINNET_RPC];
  if (primary === LOG_RPC) return [LOG_RPC, MAINNET_RPC, LEGACY_MAINNET_RPC];
  if (primary === LEGACY_MAINNET_RPC) {
    return [LEGACY_MAINNET_RPC, MAINNET_RPC, LOG_RPC];
  }
  return [primary];
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isRetryableRpcFailure(error: NonNullable<RpcResult["error"]>): boolean {
  const executionFailure = /execution reverted|invalid opcode|out of gas|revert/i.test(
    `${error.message} ${typeof error.data === "string" ? error.data : ""}`,
  );
  if (executionFailure) return false;
  return (
    error.code === -32_002 ||
    error.code === -32_005 ||
    /busy|gateway|header not found|internal error|limit|rate|temporar|timeout/i.test(error.message)
  );
}

function rpcEntryError(error: NonNullable<RpcResult["error"]>): Error {
  const message = `BSC RPC ${error.code}: ${error.message}`;
  if (isRetryableRpcFailure(error)) {
    return new RpcTransportError(message);
  }
  return new Error(message);
}

async function rpcBatchOnce(rpcUrl: string, calls: readonly RpcCall[]): Promise<unknown[]> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(
        calls.map((call, index) => ({
          jsonrpc: "2.0",
          id: index + 1,
          method: call.method,
          params: call.params,
        })),
      ),
    });
  } catch (error) {
    throw new RpcTransportError(
      `BSC RPC request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new RpcTransportError(`BSC RPC returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RpcTransportError("BSC RPC returned malformed JSON");
  }
  const entries = (Array.isArray(payload) ? payload : [payload]) as RpcResult[];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return calls.map((_, index) => {
    const entry = byId.get(index + 1);
    if (!entry) throw new RpcTransportError(`BSC RPC omitted response ${index + 1}`);
    if (entry.error) throw rpcEntryError(entry.error);
    if (entry.result === undefined) {
      throw new RpcTransportError(`BSC RPC response ${index + 1} has no result`);
    }
    return entry.result;
  });
}

export { rpcFallbacks as bscReadRpcFallbacks };

async function rpcBatch(rpcUrl: string, calls: readonly RpcCall[]): Promise<unknown[]> {
  const failures: string[] = [];
  const candidates = rpcFallbacks(rpcUrl);
  for (let attempt = 1; attempt <= RPC_TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      return await firstSuccessfulRpcTransport(
        candidates,
        async (candidate) => rpcBatchOnce(candidate, calls),
        RPC_HEDGE_DELAY_MS,
      );
    } catch (error) {
      if (!(error instanceof RpcTransportError)) throw error;
      failures.push(`attempt ${attempt}: ${error.message}`);
    }
    if (attempt < RPC_TRANSPORT_ATTEMPTS) await wait(RPC_RETRY_DELAY_MS);
  }
  throw new RpcTransportError(`BSC RPC providers unavailable (${failures.join("; ")})`);
}

async function rpcRequestOnce(rpcUrl: string, call: RpcCall): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params }),
    });
  } catch (error) {
    throw new RpcTransportError(
      `BSC RPC request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new RpcTransportError(`BSC RPC returned HTTP ${response.status}`);
  let entry: RpcResult;
  try {
    entry = await response.json() as RpcResult;
  } catch {
    throw new RpcTransportError("BSC RPC returned malformed JSON");
  }
  if (entry.error) throw rpcEntryError(entry.error);
  if (entry.result === undefined) throw new RpcTransportError("BSC RPC response has no result");
  return entry.result;
}

async function rpcRequest(rpcUrl: string, call: RpcCall): Promise<unknown> {
  const failures: string[] = [];
  // Official BNB dataseeds disable eth_getLogs. They are not log fallbacks.
  const candidates = call.method === "eth_getLogs" ? [rpcUrl] : rpcFallbacks(rpcUrl);
  for (let attempt = 1; attempt <= RPC_TRANSPORT_ATTEMPTS; attempt += 1) {
    try {
      return await firstSuccessfulRpcTransport(
        candidates,
        async (candidate) => rpcRequestOnce(candidate, call),
        RPC_HEDGE_DELAY_MS,
      );
    } catch (error) {
      if (!(error instanceof RpcTransportError)) throw error;
      failures.push(`attempt ${attempt}: ${error.message}`);
    }
    if (attempt < RPC_TRANSPORT_ATTEMPTS) await wait(RPC_RETRY_DELAY_MS);
  }
  throw new RpcTransportError(`BSC RPC providers unavailable (${failures.join("; ")})`);
}

async function configuredPancakeLogs(
  endpoint: string,
  blockNumber: bigint,
  blockHash: Hex,
  call: RpcCall,
): Promise<unknown> {
  // This value comes only from the Worker secret, never from a buyer request.
  // Do not include provider errors or URL paths in diagnostics: they can carry keys.
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("BSC log RPC configuration is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("BSC log RPC requires an HTTPS endpoint without userinfo or fragment");
  }
  // This integration relies on NodeReal's documented 50,000-record limit.
  // An arbitrary provider may silently truncate at a smaller limit, so it must
  // not inherit this completeness check without its own reviewed adapter.
  if (
    parsed.hostname !== "bsc-mainnet.nodereal.io" || parsed.port || parsed.search ||
    !/^\/v1\/[0-9a-f]{32}$/i.test(parsed.pathname)
  ) {
    throw new Error("BSC log RPC requires the supported NodeReal BSC endpoint");
  }
  let identity: unknown[];
  try {
    identity = await rpcBatchOnce(endpoint, [
      { method: "eth_chainId", params: [] },
      { method: "eth_getBlockByNumber", params: [toHex(blockNumber), false] },
    ]);
  } catch {
    throw new RpcTransportError("Configured BSC log RPC identity read failed");
  }
  const [chainId, blockValue] = identity;
  const block = rpcBlock(blockValue, "Configured BSC log RPC block");
  if (
    typeof chainId !== "string" || !/^0x[0-9a-f]+$/i.test(chainId) ||
    BigInt(chainId) !== 56n || BigInt(block.number) !== blockNumber ||
    block.hash.toLowerCase() !== blockHash.toLowerCase()
  ) {
    throw new Error("Configured BSC log RPC does not match the pinned BSC block");
  }
  let logs: unknown;
  let terminalBlockValue: unknown;
  try {
    logs = await rpcRequest(endpoint, call);
    terminalBlockValue = await rpcRequest(endpoint, {
      method: "eth_getBlockByNumber",
      params: [toHex(blockNumber), false],
    });
  } catch {
    throw new RpcTransportError("Configured BSC log RPC request failed");
  }
  const terminalBlock = rpcBlock(terminalBlockValue, "Configured BSC log RPC terminal block");
  if (
    BigInt(terminalBlock.number) !== blockNumber ||
    terminalBlock.hash.toLowerCase() !== blockHash.toLowerCase()
  ) {
    throw new Error("Pinned BSC block changed during the configured log read");
  }
  return logs;
}

async function rpcBatchChunked(
  rpcUrl: string,
  calls: readonly RpcCall[],
  chunkSize = 10,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let index = 0; index < calls.length; index += chunkSize) {
    results.push(...await rpcBatch(rpcUrl, calls.slice(index, index + chunkSize)));
  }
  return results;
}

function rpcHex(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error(`${label} returned an invalid hex value`);
  }
  return value as Hex;
}

function rpcBlock(value: unknown, label: string): RpcBlock {
  if (typeof value !== "object" || value === null) throw new Error(`${label} is unavailable`);
  const candidate = value as Partial<RpcBlock>;
  return {
    number: rpcHex(candidate.number, `${label} number`),
    hash: rpcHex(candidate.hash, `${label} hash`),
    timestamp: rpcHex(candidate.timestamp, `${label} timestamp`),
  };
}

function ethCall(to: Address, data: Hex, blockTag: Hex): RpcCall {
  return { method: "eth_call", params: [{ to, data }, blockTag] };
}

function ethCallFrom(from: Address, to: Address, data: Hex, blockTag: Hex): RpcCall {
  return { method: "eth_call", params: [{ from, to, data }, blockTag] };
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
    poolAddress: Address;
    feeTier: 100;
    spotPriceUsd: string;
    tick: number;
    liquidityRaw: string;
    observedAt: string;
    explorerUrl: string;
  };
  venus: {
    market: "vUSDT";
    address: Address;
    supplyAprPct: string;
    borrowAprPct: string;
    availableLiquidityUsd: string;
    totalBorrowsUsd: string;
    observedAt: string;
    explorerUrl: string;
  };
}

export interface VenusAccountProbe {
  schemaVersion: "positioncrew.venus-account-probe.v1";
  generatedAt: string;
  chainId: 56;
  account: Address;
  state: "NO_POSITION" | "LIQUID" | "SHORTFALL";
  nativeBalanceBnb: string;
  usdtBalance: string;
  liquidityUsd: string;
  shortfallUsd: string;
  enteredMarkets: Address[];
  position: {
    collateralValueUsd: string;
    liquidationWeightedCollateralUsd: string;
    debtValueUsd: string;
    healthFactor: string | null;
    markets: Array<{
      vToken: Address;
      symbol: string;
      underlying: Address;
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
  rescueRequest: LendingRescueRequest;
  source: {
    comptroller: Address;
    blockNumber: string;
    explorerUrl: string;
  };
  boundary: string;
}

export interface VenusRescueRequestOptions {
  targetHealthFactor?: string;
  stressPriceDropBps?: number;
  maxActionUsd?: string;
  maxGasUsd?: string;
  maxSlippageBps?: number;
}

export interface PancakeGridProbe {
  schemaVersion: "positioncrew.pancake-grid-probe.v1";
  generatedAt: string;
  chainId: 56;
  state: "READY";
  market: {
    pair: "WBNB/USDT";
    poolAddress: Address;
    feeTier: 100;
    spotPriceUsd: string;
    activeLiquidityUsd: string;
    reserveValueUsd: string;
    realizedVolatilityBps: number;
    volatilityWindowSeconds: number;
    volatilitySampleCount: number;
  };
  gridRequest: BoundedGridRequest;
  source: {
    blockNumber: string;
    blockTimestamp: string;
    explorerUrl: string;
    poolExplorerUrl: string;
  };
  boundary: string;
}

export interface PancakeGridRequestOptions {
  account?: string;
  capitalUsd?: number;
}

export interface PancakeGridPriceSample {
  sampledAt: string;
  spotPriceUsd: string;
  source: {
    chainId: 56;
    market: "WBNB/USDT";
    protocol: "PancakeSwap V3";
    poolAddress: Address;
    blockNumber: string;
    blockHash: Hex;
    blockTimestamp: string;
    explorerUrl: string;
    confirmationDepth: number;
    finality: "FINALIZED_OR_32_CONFIRMATIONS";
  };
}

export interface VenusYieldProbe {
  schemaVersion: "positioncrew.venus-yield-probe.v1";
  generatedAt: string;
  chainId: 56;
  state: "READY";
  markets: Array<{
    opportunityId: string;
    symbol: string;
    vToken: Address;
    underlying: Address;
    baseSupplyApyBps: number;
    availableLiquidityUsd: string;
  }>;
  yieldRequest: YieldOptimizationRequest;
  source: {
    comptroller: Address;
    oracle: Address;
    blockNumber: string;
    blockTimestamp: string;
    measuredSecondsPerBlock: number;
    explorerUrl: string;
  };
  boundary: string;
}

export interface VenusYieldRequestOptions {
  account?: string;
  capitalUsd?: number;
}

export interface PancakePositionProbe {
  schemaVersion: "positioncrew.pancake-position-probe.v1";
  generatedAt: string;
  chainId: 56;
  state: "READY";
  position: {
    tokenId: string;
    owner: Address;
    custody: "DIRECT_OR_OTHER" | "MASTER_CHEF_V3";
    positionManager: Address;
    pool: Address;
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
  lpRequest: LpRebalanceRequest;
  source: {
    blockNumber: string;
    blockTimestamp: string;
    explorerUrl: string;
    positionExplorerUrl: string;
    poolExplorerUrl: string;
  };
  boundary: string;
}

function nowMs(): number {
  return Date.now();
}

function decimal(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

function tokenAmount(raw: bigint, decimals: number): string {
  const rendered = formatUnits(raw, decimals);
  return rendered.includes(".") ? rendered.replace(/0+$/, "").replace(/\.$/, "") : rendered;
}

function oraclePriceFixed(priceRaw: bigint, underlyingDecimals: number): bigint {
  return (priceRaw * 10n ** BigInt(underlyingDecimals)) / FIXED_SCALE;
}

export function venusUsdValueFixed(amountRaw: bigint, oraclePriceRaw: bigint): bigint {
  return (amountRaw * oraclePriceRaw) / FIXED_SCALE;
}

export function venusLiquidityTotalsFixed(
  markets: readonly {
    suppliedUsd: bigint;
    borrowedUsd: bigint;
    liquidationThreshold: bigint;
    collateralEnabled: boolean;
  }[],
  additionalDebtUsd = 0n,
): {
  collateralValueUsd: bigint;
  liquidationWeightedCollateralUsd: bigint;
  debtValueUsd: bigint;
  liquidityUsd: bigint;
  shortfallUsd: bigint;
} {
  let collateralValueUsd = 0n;
  let liquidationWeightedCollateralUsd = 0n;
  let debtValueUsd = additionalDebtUsd;
  for (const market of markets) {
    if (market.collateralEnabled) {
      collateralValueUsd += market.suppliedUsd;
      liquidationWeightedCollateralUsd +=
        (market.suppliedUsd * market.liquidationThreshold) / FIXED_SCALE;
    }
    debtValueUsd += market.borrowedUsd;
  }
  return {
    collateralValueUsd,
    liquidationWeightedCollateralUsd,
    debtValueUsd,
    liquidityUsd: liquidationWeightedCollateralUsd >= debtValueUsd
      ? liquidationWeightedCollateralUsd - debtValueUsd
      : 0n,
    shortfallUsd: debtValueUsd > liquidationWeightedCollateralUsd
      ? debtValueUsd - liquidationWeightedCollateralUsd
      : 0n,
  };
}

function minimumPositiveGasLimit(estimatedGasUsd: bigint): string {
  const doubled = estimatedGasUsd * 2n;
  const floor = 100_000_000_000_000_000n;
  return formatFixed(doubled > floor ? doubled : floor, 6);
}

export function poolPriceFromSqrtPriceX96(sqrtPriceX96: bigint): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  return ratio === 0 ? 0 : 1 / ratio;
}

export function pancakeActiveLiquidityUsd(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  token1PriceUsd: number,
  token0PriceUsd = 1,
): number {
  if (
    sqrtPriceX96 <= 0n ||
    liquidity <= 0n ||
    !Number.isFinite(token0PriceUsd) ||
    token0PriceUsd <= 0 ||
    !Number.isFinite(token1PriceUsd) ||
    token1PriceUsd <= 0
  ) {
    throw new Error("Positive pool price, liquidity, and token USD prices are required");
  }
  const q96 = 2n ** 96n;
  const token0VirtualRaw = (liquidity * q96) / sqrtPriceX96;
  const token1VirtualRaw = (liquidity * sqrtPriceX96) / q96;
  return Number(formatUnits(token0VirtualRaw, 18)) * token0PriceUsd +
    Number(formatUnits(token1VirtualRaw, 18)) * token1PriceUsd;
}

export function v3PositionTokenAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  lowerTick: number,
  upperTick: number,
  token0Decimals = 18,
  token1Decimals = 18,
): { token0Amount: number; token1Amount: number } {
  if (
    liquidity <= 0n ||
    sqrtPriceX96 <= 0n ||
    !Number.isInteger(lowerTick) ||
    !Number.isInteger(upperTick) ||
    lowerTick >= upperTick ||
    token0Decimals < 0 ||
    token1Decimals < 0
  ) {
    throw new Error("A positive V3 position, ordered ticks, and valid token decimals are required");
  }
  const sqrtCurrent = Number(sqrtPriceX96) / 2 ** 96;
  const sqrtLower = Math.pow(1.0001, lowerTick / 2);
  const sqrtUpper = Math.pow(1.0001, upperTick / 2);
  const liquidityNumber = Number(liquidity);
  let token0Raw = 0;
  let token1Raw = 0;
  if (sqrtCurrent <= sqrtLower) {
    token0Raw = liquidityNumber * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper);
  } else if (sqrtCurrent < sqrtUpper) {
    token0Raw = liquidityNumber * (sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper);
    token1Raw = liquidityNumber * (sqrtCurrent - sqrtLower);
  } else {
    token1Raw = liquidityNumber * (sqrtUpper - sqrtLower);
  }
  const token0Amount = token0Raw / 10 ** token0Decimals;
  const token1Amount = token1Raw / 10 ** token1Decimals;
  if (!Number.isFinite(token0Amount) || !Number.isFinite(token1Amount)) {
    throw new Error("V3 position amounts exceed the supported numeric range");
  }
  return { token0Amount, token1Amount };
}

function signedWord(data: Hex, index: number): bigint {
  const start = 2 + index * 64;
  const word = data.slice(start, start + 64);
  if (word.length !== 64) throw new Error("PancakeSwap log data is truncated");
  const unsigned = BigInt(`0x${word}`);
  return unsigned >= 2n ** 255n ? unsigned - 2n ** 256n : unsigned;
}

export function annualizedRatePct(ratePerBlock: bigint, secondsPerBlock: number): number {
  if (secondsPerBlock <= 0) return 0;
  const blocksPerYear = 31_536_000 / secondsPerBlock;
  return Number(formatUnits(ratePerBlock, 18)) * blocksPerYear * 100;
}

export function annualizedYieldBps(ratePerBlock: bigint, secondsPerBlock: number): number {
  if (ratePerBlock < 0n || secondsPerBlock <= 0) return 0;
  const rate = Number(formatUnits(ratePerBlock, 18));
  const blocksPerYear = 31_536_000 / secondsPerBlock;
  const annualYield = Math.expm1(blocksPerYear * Math.log1p(rate));
  if (!Number.isFinite(annualYield) || annualYield < 0) {
    throw new Error("Venus supply rate cannot be annualized safely");
  }
  return Math.min(1_000_000, Math.round(annualYield * 10_000));
}

export function realizedVolatilityBpsFromTickCumulatives(
  tickCumulatives: readonly bigint[],
  intervalSeconds: number,
): number {
  if (tickCumulatives.length < 3 || intervalSeconds <= 0) {
    throw new Error("At least three ordered tick cumulatives and a positive interval are required");
  }
  const averageTicks = Array.from({ length: tickCumulatives.length - 1 }, (_, index) =>
    Number(tickCumulatives[index]! - tickCumulatives[index + 1]!) / intervalSeconds,
  );
  const squaredReturns = averageTicks.slice(0, -1).map((tick, index) => {
    const nextTick = averageTicks[index + 1]!;
    const returnBps = (tick - nextTick) * Math.log(1.0001) * 10_000;
    return returnBps * returnBps;
  });
  return Math.max(0, Math.round(Math.sqrt(squaredReturns.reduce((sum, value) => sum + value, 0))));
}

async function readPancakeVolatility(
  poolAddress: Address,
  blockTag: Hex,
): Promise<{ realizedVolatilityBps: number; windowSeconds: number; sampleCount: number }> {
  const windows = [21_600, 14_400, 7_200, 3_600] as const;
  for (const windowSeconds of windows) {
    const intervalSeconds = Math.floor(windowSeconds / 12);
    const secondsAgos = Array.from({ length: 13 }, (_, index) => index * intervalSeconds);
    try {
      const [observationValue] = await rpcBatch(MAINNET_RPC, [
        ethCall(
          poolAddress,
          encodeFunctionData({
            abi: POOL_ABI,
            functionName: "observe",
            args: [secondsAgos],
          }),
          blockTag,
        ),
      ]);
      const observations = decodeFunctionResult({
        abi: POOL_ABI,
        functionName: "observe",
        data: rpcHex(observationValue, "PancakeSwap observations"),
      });
      return {
        realizedVolatilityBps: realizedVolatilityBpsFromTickCumulatives(
          observations[0],
          intervalSeconds,
        ),
        windowSeconds,
        sampleCount: observations[0].length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("OLD")) throw error;
      // Sparse observation rings can reject older lookbacks. Shorter windows remain fail-closed.
    }
  }
  throw new Error("PancakeSwap pool has insufficient observations for a one-hour volatility window");
}

async function readPancakeSwapRunRate(
  poolAddress: Address,
  blockNumber: bigint,
  blockTimestamp: bigint,
  secondsPerBlock: number,
  token0Decimals: number,
  token0PriceUsd: number,
  feeTier: number,
  logRpc?: { endpoint: string; blockHash: Hex },
): Promise<{
  volumeRunRate24hUsd: number;
  feesRunRate24hUsd: number;
  measurementWindowSeconds: number;
  normalizationFactor: number;
  swapCount: number;
}> {
  const desiredBlocks = Math.ceil(3_600 / Math.max(0.1, secondsPerBlock));
  const measuredBlocks = BigInt(Math.min(8_000, Math.max(120, desiredBlocks)));
  const startBlockNumber = blockNumber > measuredBlocks ? blockNumber - measuredBlocks : 0n;
  const [startBlockValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: [toHex(startBlockNumber), false] },
  ]);
  const startBlock = rpcBlock(startBlockValue, "PancakeSwap volume-window start block");
  const measurementWindowSeconds = Math.max(
    1,
    Number(blockTimestamp - BigInt(startBlock.timestamp)),
  );
  const logCall: RpcCall = {
    method: "eth_getLogs",
    params: [{
      address: poolAddress,
      fromBlock: toHex(startBlockNumber),
      toBlock: toHex(blockNumber),
      topics: [PANCAKE_V3_SWAP_TOPIC],
    }],
  };
  const logValue = logRpc
    ? await configuredPancakeLogs(logRpc.endpoint, blockNumber, logRpc.blockHash, logCall)
    : await rpcRequest(LOG_RPC, logCall);
  if (!Array.isArray(logValue)) throw new Error("PancakeSwap swap logs are unavailable");
  if (logValue.length >= 50_000) {
    throw new Error("PancakeSwap swap logs may have reached the provider response cap");
  }
  const logs = logValue as RpcLog[];
  let token0VolumeRaw = 0n;
  for (const log of logs) {
    if (typeof log.data !== "string" || !Array.isArray(log.topics)) {
      throw new Error("PancakeSwap returned a malformed swap log");
    }
    const amount0 = signedWord(log.data, 0);
    token0VolumeRaw += amount0 < 0n ? -amount0 : amount0;
  }
  const measuredVolumeUsd = Number(formatUnits(token0VolumeRaw, token0Decimals)) * token0PriceUsd;
  const normalizationFactor = 86_400 / measurementWindowSeconds;
  const volumeRunRate24hUsd = measuredVolumeUsd * normalizationFactor;
  const feesRunRate24hUsd = volumeRunRate24hUsd * feeTier / 1_000_000;
  if (
    !Number.isFinite(volumeRunRate24hUsd) ||
    volumeRunRate24hUsd < 0 ||
    !Number.isFinite(feesRunRate24hUsd) ||
    feesRunRate24hUsd < 0
  ) {
    throw new Error("PancakeSwap swap volume cannot be normalized safely");
  }
  return {
    volumeRunRate24hUsd,
    feesRunRate24hUsd,
    measurementWindowSeconds,
    normalizationFactor,
    swapCount: logs.length,
  };
}

async function chainProbe(
  chainId: 56 | 97,
  name: string,
  rpcUrl: string,
  explorerUrl: string,
): Promise<{ probe: ChainProbe; secondsPerBlock: number }> {
  const startedAt = nowMs();
  const [latestValue, gasPriceValue] = await rpcBatch(rpcUrl, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_gasPrice", params: [] },
  ]);
  const latest = rpcBlock(latestValue, `${name} latest block`);
  const latestNumber = BigInt(latest.number);
  const latestTimestamp = BigInt(latest.timestamp);
  const priorNumber = latestNumber > 120n ? latestNumber - 120n : 0n;
  const [priorValue] = await rpcBatch(rpcUrl, [
    { method: "eth_getBlockByNumber", params: [toHex(priorNumber), false] },
  ]);
  const prior = rpcBlock(priorValue, `${name} prior block`);
  const gasPrice = BigInt(rpcHex(gasPriceValue, `${name} gas price`));
  const observedAt = Math.floor(Date.now() / 1000);
  const secondsPerBlock = Math.max(
    0.1,
    Number(latestTimestamp - BigInt(prior.timestamp)) / 120,
  );
  return {
    probe: {
      chainId,
      name,
      blockNumber: latestNumber.toString(),
      blockTimestamp: new Date(Number(latestTimestamp) * 1000).toISOString(),
      blockAgeSeconds: Math.max(0, observedAt - Number(latestTimestamp)),
      gasPriceGwei: decimal(Number(formatUnits(gasPrice, 9)), 3),
      rpcLatencyMs: Math.max(1, nowMs() - startedAt),
      rpcUrl,
      explorerUrl: `${explorerUrl}/block/${latestNumber}`,
    },
    secondsPerBlock,
  };
}

export async function getSystemTelemetry(): Promise<SystemTelemetry> {
  const [mainnet, testnet] = await Promise.all([
    chainProbe(56, "BNB Smart Chain", MAINNET_RPC, "https://bscscan.com"),
    chainProbe(97, "BSC Testnet", TESTNET_RPC, "https://testnet.bscscan.com"),
  ]);
  const mainnetBlockTag = toHex(BigInt(mainnet.probe.blockNumber));

  const mainnetValues = await rpcBatch(MAINNET_RPC, [
      ethCall(
        PANCAKE_V3_FACTORY,
        encodeFunctionData({
          abi: FACTORY_ABI,
          functionName: "getPool",
          args: [WBNB, USDT, 100],
        }),
        mainnetBlockTag,
      ),
      ethCall(
        VENUS_VUSDT,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "supplyRatePerBlock" }),
        mainnetBlockTag,
      ),
      ethCall(
        VENUS_VUSDT,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "borrowRatePerBlock" }),
        mainnetBlockTag,
      ),
      ethCall(
        VENUS_VUSDT,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "getCash" }),
        mainnetBlockTag,
      ),
      ethCall(
        VENUS_VUSDT,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "totalBorrows" }),
        mainnetBlockTag,
      ),
    ]);

  const poolAddress = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "getPool",
    data: rpcHex(mainnetValues[0], "PancakeSwap pool"),
  });
  if (poolAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("PancakeSwap WBNB/USDT 0.01% pool is unavailable");
  }

  const [slot0Value, liquidityValue] = await rpcBatch(MAINNET_RPC, [
    ethCall(
      poolAddress,
      encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" }),
      mainnetBlockTag,
    ),
    ethCall(
      poolAddress,
      encodeFunctionData({ abi: POOL_ABI, functionName: "liquidity" }),
      mainnetBlockTag,
    ),
  ]);
  const slot0 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "slot0",
    data: rpcHex(slot0Value, "PancakeSwap slot0"),
  });
  const liquidity = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "liquidity",
    data: rpcHex(liquidityValue, "PancakeSwap liquidity"),
  });
  const supplyRate = decodeFunctionResult({
    abi: VTOKEN_ABI,
    functionName: "supplyRatePerBlock",
    data: rpcHex(mainnetValues[1], "Venus supply rate"),
  });
  const borrowRate = decodeFunctionResult({
    abi: VTOKEN_ABI,
    functionName: "borrowRatePerBlock",
    data: rpcHex(mainnetValues[2], "Venus borrow rate"),
  });
  const cash = decodeFunctionResult({
    abi: VTOKEN_ABI,
    functionName: "getCash",
    data: rpcHex(mainnetValues[3], "Venus cash"),
  });
  const totalBorrows = decodeFunctionResult({
    abi: VTOKEN_ABI,
    functionName: "totalBorrows",
    data: rpcHex(mainnetValues[4], "Venus total borrows"),
  });

  const generatedAt = new Date().toISOString();

  return {
    schemaVersion: "positioncrew.system-telemetry.v1",
    generatedAt,
    mainnet: mainnet.probe,
    testnet: testnet.probe,
    market: {
      pair: "WBNB/USDT",
      venue: "PancakeSwap V3",
      poolAddress,
      feeTier: 100,
      spotPriceUsd: decimal(poolPriceFromSqrtPriceX96(slot0[0]), 2),
      tick: slot0[1],
      liquidityRaw: liquidity.toString(),
      observedAt: generatedAt,
      explorerUrl: `https://bscscan.com/address/${poolAddress}`,
    },
    venus: {
      market: "vUSDT",
      address: VENUS_VUSDT,
      supplyAprPct: decimal(annualizedRatePct(supplyRate, mainnet.secondsPerBlock), 2),
      borrowAprPct: decimal(annualizedRatePct(borrowRate, mainnet.secondsPerBlock), 2),
      availableLiquidityUsd: decimal(Number(formatUnits(cash, 18)), 0),
      totalBorrowsUsd: decimal(Number(formatUnits(totalBorrows, 18)), 0),
      observedAt: generatedAt,
      explorerUrl: `https://bscscan.com/address/${VENUS_VUSDT}`,
    },
  };
}

export async function inspectPancakeGridMarket(
  options: PancakeGridRequestOptions = {},
): Promise<PancakeGridProbe> {
  const accountInput = options.account ?? NATIVE_BNB;
  if (!isAddress(accountInput)) throw new Error("A valid EVM account address is required");
  const account = accountInput as Address;
  const capitalUsd = options.capitalUsd ?? 1_000;
  if (!Number.isFinite(capitalUsd) || capitalUsd < 1 || capitalUsd > 10_000_000) {
    throw new Error("capitalUsd must be between 1 and 10000000");
  }

  const [blockValue, gasPriceValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_gasPrice", params: [] },
  ]);
  const block = rpcBlock(blockValue, "BNB Smart Chain latest block");
  const [poolValue] = await rpcBatch(MAINNET_RPC, [
    ethCall(
      PANCAKE_V3_FACTORY,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [WBNB, USDT, 100],
      }),
      block.number,
    ),
  ]);
  const poolAddress = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "getPool",
    data: rpcHex(poolValue, "PancakeSwap WBNB/USDT pool"),
  });
  if (poolAddress === NATIVE_BNB) throw new Error("PancakeSwap WBNB/USDT pool is unavailable");

  const [
    token0Value,
    token1Value,
    slot0Value,
    liquidityValue,
    wbnbBalanceValue,
    usdtBalanceValue,
  ] = await rpcBatch(MAINNET_RPC, [
    ethCall(
      poolAddress,
      encodeFunctionData({ abi: POOL_ABI, functionName: "token0" }),
      block.number,
    ),
    ethCall(
      poolAddress,
      encodeFunctionData({ abi: POOL_ABI, functionName: "token1" }),
      block.number,
    ),
    ethCall(
      poolAddress,
      encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" }),
      block.number,
    ),
    ethCall(
      poolAddress,
      encodeFunctionData({ abi: POOL_ABI, functionName: "liquidity" }),
      block.number,
    ),
    ethCall(
      WBNB,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddress] }),
      block.number,
    ),
    ethCall(
      USDT,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [poolAddress] }),
      block.number,
    ),
  ]);
  const token0 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "token0",
    data: rpcHex(token0Value, "PancakeSwap token0"),
  });
  const token1 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "token1",
    data: rpcHex(token1Value, "PancakeSwap token1"),
  });
  if (token0.toLowerCase() !== USDT.toLowerCase() || token1.toLowerCase() !== WBNB.toLowerCase()) {
    throw new Error("PancakeSwap WBNB/USDT token ordering changed unexpectedly");
  }
  const slot0 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "slot0",
    data: rpcHex(slot0Value, "PancakeSwap slot0"),
  });
  const activeLiquidity = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "liquidity",
    data: rpcHex(liquidityValue, "PancakeSwap active liquidity"),
  });
  const wbnbBalance = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: rpcHex(wbnbBalanceValue, "PancakeSwap WBNB balance"),
  });
  const usdtBalance = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: rpcHex(usdtBalanceValue, "PancakeSwap USDT balance"),
  });
  const volatility = await readPancakeVolatility(poolAddress, block.number);
  const spotPriceUsd = poolPriceFromSqrtPriceX96(slot0[0]);
  if (!Number.isFinite(spotPriceUsd) || spotPriceUsd <= 0) {
    throw new Error("PancakeSwap returned an invalid spot price");
  }
  const reserveValueUsd =
    Number(formatUnits(wbnbBalance, 18)) * spotPriceUsd + Number(formatUnits(usdtBalance, 18));
  const activeLiquidityUsd = pancakeActiveLiquidityUsd(slot0[0], activeLiquidity, spotPriceUsd);
  if (!Number.isFinite(reserveValueUsd) || reserveValueUsd <= 0) {
    throw new Error("PancakeSwap returned an invalid reserve value");
  }
  if (!Number.isFinite(activeLiquidityUsd) || activeLiquidityUsd <= 0) {
    throw new Error("PancakeSwap returned an invalid active-liquidity value");
  }

  const observedAt = new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString();
  const requestedAtDate = new Date();
  const requestedAt = requestedAtDate.toISOString();
  const deadline = new Date(requestedAtDate.getTime() + 120_000).toISOString();
  const blockNumber = BigInt(block.number).toString();
  const sourceId = `pancake-v3-mainnet-block-${blockNumber}`;
  const halfWidthBps = Math.min(
    1_500,
    Math.max(200, Math.ceil(volatility.realizedVolatilityBps * 2)),
  );
  const lowerPrice = spotPriceUsd * (1 - halfWidthBps / 10_000);
  const upperPrice = spotPriceUsd * (1 + halfWidthBps / 10_000);
  const gasPrice = BigInt(rpcHex(gasPriceValue, "BSC gas price"));
  const estimatedGasUsd = Math.max(
    0.01,
    Number(formatEther(gasPrice * 600_000n)) * spotPriceUsd,
  );
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  const gridRequest = BoundedGridRequestSchema.parse({
    schemaVersion: "positioncrew.bounded-grid.request.v1",
    service: "BOUNDED_GRID",
    requestId: `pancake-grid-${blockNumber}`,
    chainId: 56,
    account,
    protocol: "PancakeSwap V3 bounded grid policy",
    requestedAt,
    deadline,
    maxDataAgeSeconds: 120,
    maxActionUsd: decimal(capitalUsd, 2),
    maxGasUsd: decimal(Math.max(0.25, estimatedGasUsd * 2), 6),
    maxSlippageBps: 10,
    sources: [
      {
        sourceId,
        label: "Block-pinned PancakeSwap V3 WBNB/USDT market state",
        uri: explorerUrl,
        observedAt,
      },
    ],
    venue: poolAddress,
    baseAsset: { symbol: "WBNB", address: WBNB, decimals: 18 },
    quoteAsset: { symbol: "USDT", address: USDT, decimals: 18 },
    marketState: {
      midPrice: decimal(spotPriceUsd, 6),
      liquidityUsd: decimal(activeLiquidityUsd, 2),
      realizedVolatilityBps: volatility.realizedVolatilityBps,
      venueFeeBps: 1,
      observedAt,
      sourceId,
    },
    constraints: {
      capitalUsd: decimal(capitalUsd, 2),
      lowerPrice: decimal(lowerPrice, 6),
      upperPrice: decimal(upperPrice, 6),
      levelCount: 5,
      maximumInventoryUsd: decimal(capitalUsd * 0.6, 2),
      maximumLossUsd: decimal(capitalUsd * 0.15, 2),
      minimumExpectedNetProfitUsd: decimal(Math.max(1, capitalUsd * 0.005), 2),
      minimumLiquidityUsd: "100000",
      maximumVolatilityBps: Math.min(
        100_000,
        Math.max(1_000, Math.ceil(volatility.realizedVolatilityBps * 2.5)),
      ),
      expectedCompletedCycles: 10,
      estimatedGasUsd: decimal(estimatedGasUsd, 6),
      orderExpirySeconds: 120,
    },
  });

  return {
    schemaVersion: "positioncrew.pancake-grid-probe.v1",
    generatedAt: requestedAt,
    chainId: 56,
    state: "READY",
    market: {
      pair: "WBNB/USDT",
      poolAddress,
      feeTier: 100,
      spotPriceUsd: gridRequest.marketState.midPrice,
      activeLiquidityUsd: gridRequest.marketState.liquidityUsd,
      reserveValueUsd: decimal(reserveValueUsd, 2),
      realizedVolatilityBps: volatility.realizedVolatilityBps,
      volatilityWindowSeconds: volatility.windowSeconds,
      volatilitySampleCount: volatility.sampleCount,
    },
    gridRequest,
    source: {
      blockNumber,
      blockTimestamp: observedAt,
      explorerUrl,
      poolExplorerUrl: `https://bscscan.com/address/${poolAddress}`,
    },
    boundary:
      "Token ordering, spot price, current active virtual liquidity, reserve balances, volatility observations, and gas were read for one BSC block. The grid is unsigned, assumes future completed cycles, and must be re-quoted and bound to the executing account before any order is placed.",
  };
}

export async function inspectPancakeGridPriceSample(): Promise<PancakeGridPriceSample> {
  const [latestValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
  ]);
  const latest = rpcBlock(latestValue, "BNB Smart Chain latest block");
  const latestNumber = BigInt(latest.number);
  if (latestNumber <= 32n) throw new Error("BSC does not have enough confirmed blocks");
  const sampleTag = toHex(latestNumber - 32n);
  const [sampleBlockValue, poolValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: [sampleTag, false] },
    ethCall(
      PANCAKE_V3_FACTORY,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [WBNB, USDT, 100],
      }),
      sampleTag,
    ),
  ]);
  const block = rpcBlock(sampleBlockValue, "BNB Smart Chain confirmed sample block");
  const poolAddress = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "getPool",
    data: rpcHex(poolValue, "PancakeSwap WBNB/USDT pool"),
  });
  if (poolAddress === NATIVE_BNB) throw new Error("PancakeSwap WBNB/USDT pool is unavailable");
  const [token0Value, token1Value, slot0Value] = await rpcBatch(MAINNET_RPC, [
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "token0" }), block.number),
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "token1" }), block.number),
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" }), block.number),
  ]);
  const token0 = decodeFunctionResult({ abi: POOL_ABI, functionName: "token0", data: rpcHex(token0Value, "PancakeSwap token0") });
  const token1 = decodeFunctionResult({ abi: POOL_ABI, functionName: "token1", data: rpcHex(token1Value, "PancakeSwap token1") });
  if (token0.toLowerCase() !== USDT.toLowerCase() || token1.toLowerCase() !== WBNB.toLowerCase()) {
    throw new Error("PancakeSwap WBNB/USDT token ordering changed unexpectedly");
  }
  const slot0 = decodeFunctionResult({ abi: POOL_ABI, functionName: "slot0", data: rpcHex(slot0Value, "PancakeSwap slot0") });
  const price = poolPriceFromSqrtPriceX96(slot0[0]);
  if (!Number.isFinite(price) || price <= 0) throw new Error("PancakeSwap returned an invalid sample price");
  const blockNumber = BigInt(block.number).toString();
  return {
    sampledAt: new Date().toISOString(),
    spotPriceUsd: decimal(price, 8),
    source: {
      chainId: 56,
      market: "WBNB/USDT",
      protocol: "PancakeSwap V3",
      poolAddress,
      blockNumber,
      blockHash: block.hash,
      blockTimestamp: new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString(),
      explorerUrl: `https://bscscan.com/block/${blockNumber}`,
      confirmationDepth: Number(latestNumber - BigInt(block.number)),
      finality: "FINALIZED_OR_32_CONFIRMATIONS",
    },
  };
}

export async function verifyPancakeGridPriceSample(sample: PancakeGridPriceSample): Promise<void> {
  const blockTag = toHex(BigInt(sample.source.blockNumber));
  const value = await rpcRequest(MAINNET_RPC, {
    method: "eth_getBlockByNumber",
    params: [blockTag, false],
  });
  const block = rpcBlock(value, "BNB Smart Chain retained sample block");
  if (
    BigInt(block.number).toString() !== sample.source.blockNumber ||
    block.hash.toLowerCase() !== sample.source.blockHash.toLowerCase() ||
    new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString() !== sample.source.blockTimestamp
  ) {
    throw new Error("Retained PancakeSwap sample block identity changed");
  }
}

export async function inspectPancakePosition(
  tokenIdInput: string | bigint,
  options: { logRpcUrl?: string } = {},
): Promise<PancakePositionProbe> {
  const tokenIdText = String(tokenIdInput);
  if (!/^\d{1,78}$/.test(tokenIdText)) {
    throw new Error("A positive PancakeSwap position NFT ID is required");
  }
  const tokenId = BigInt(tokenIdText);
  if (tokenId <= 0n || tokenId >= 2n ** 256n) {
    throw new Error("A positive PancakeSwap position NFT ID is required");
  }

  const [blockValue, gasPriceValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_gasPrice", params: [] },
  ]);
  const block = rpcBlock(blockValue, "BNB Smart Chain latest block");
  const blockNumber = BigInt(block.number);
  const priorBlockNumber = blockNumber > 120n ? blockNumber - 120n : 0n;
  const [priorBlockValue, ownerValue, positionValue, oracleValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: [toHex(priorBlockNumber), false] },
    ethCall(
      PANCAKE_V3_POSITION_MANAGER,
      encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "ownerOf", args: [tokenId] }),
      block.number,
    ),
    ethCall(
      PANCAKE_V3_POSITION_MANAGER,
      encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: "positions", args: [tokenId] }),
      block.number,
    ),
    ethCall(
      VENUS_COMPTROLLER,
      encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: "oracle" }),
      block.number,
    ),
  ]);
  const priorBlock = rpcBlock(priorBlockValue, "BNB Smart Chain prior block");
  const owner = decodeFunctionResult({
    abi: POSITION_MANAGER_ABI,
    functionName: "ownerOf",
    data: rpcHex(ownerValue, "PancakeSwap position owner"),
  });
  const position = decodeFunctionResult({
    abi: POSITION_MANAGER_ABI,
    functionName: "positions",
    data: rpcHex(positionValue, "PancakeSwap position"),
  });
  const oracle = decodeFunctionResult({
    abi: COMPTROLLER_ABI,
    functionName: "oracle",
    data: rpcHex(oracleValue, "Venus oracle"),
  });
  const token0 = position[2];
  const token1 = position[3];
  const feeTier = Number(position[4]);
  const lowerTick = Number(position[5]);
  const upperTick = Number(position[6]);
  const positionLiquidity = position[7];
  if (
    token0.toLowerCase() !== USDT.toLowerCase() ||
    token1.toLowerCase() !== WBNB.toLowerCase()
  ) {
    throw new Error("This live builder currently supports PancakeSwap V3 USDT/WBNB positions only");
  }
  if (positionLiquidity <= 0n) throw new Error("The PancakeSwap position has no active liquidity");
  if (![100, 500, 2_500, 10_000].includes(feeTier)) {
    throw new Error("The PancakeSwap position uses an unsupported fee tier");
  }

  const secondsPerBlock = Math.max(
    0.1,
    Number(BigInt(block.timestamp) - BigInt(priorBlock.timestamp)) / 120,
  );
  const [poolValue, usdtPriceValue, bnbPriceValue] = await rpcBatch(MAINNET_RPC, [
    ethCall(
      PANCAKE_V3_FACTORY,
      encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "getPool",
        args: [token0, token1, feeTier],
      }),
      block.number,
    ),
    ethCall(
      oracle,
      encodeFunctionData({ abi: ORACLE_ABI, functionName: "getUnderlyingPrice", args: [VENUS_VUSDT] }),
      block.number,
    ),
    ethCall(
      oracle,
      encodeFunctionData({ abi: ORACLE_ABI, functionName: "getUnderlyingPrice", args: [VENUS_VBNB] }),
      block.number,
    ),
  ]);
  const poolAddress = decodeFunctionResult({
    abi: FACTORY_ABI,
    functionName: "getPool",
    data: rpcHex(poolValue, "PancakeSwap position pool"),
  });
  if (poolAddress === NATIVE_BNB) throw new Error("The PancakeSwap position pool is unavailable");
  const usdtPriceRaw = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "getUnderlyingPrice",
    data: rpcHex(usdtPriceValue, "Venus USDT oracle price"),
  });
  const bnbPriceRaw = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "getUnderlyingPrice",
    data: rpcHex(bnbPriceValue, "Venus BNB oracle price"),
  });
  if (usdtPriceRaw <= 0n || bnbPriceRaw <= 0n) {
    throw new Error("Venus oracle prices are unavailable for the position pair");
  }
  const usdtPriceUsd = Number(formatFixed(oraclePriceFixed(usdtPriceRaw, 18), 8));
  const bnbPriceUsd = Number(formatFixed(oraclePriceFixed(bnbPriceRaw, 18), 8));

  const maxUint128 = 2n ** 128n - 1n;
  const poolCalls: RpcCall[] = [
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "token0" }), block.number),
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "token1" }), block.number),
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" }), block.number),
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "liquidity" }), block.number),
    ethCall(poolAddress, encodeFunctionData({ abi: POOL_ABI, functionName: "tickSpacing" }), block.number),
    ethCall(token0, encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }), block.number),
    ethCall(token0, encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }), block.number),
    ethCall(token1, encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }), block.number),
    ethCall(token1, encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }), block.number),
    ethCallFrom(
      owner,
      PANCAKE_V3_POSITION_MANAGER,
      encodeFunctionData({
        abi: POSITION_MANAGER_ABI,
        functionName: "collect",
        args: [{ tokenId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }],
      }),
      block.number,
    ),
  ];
  const poolValues = await rpcBatchChunked(MAINNET_RPC, poolCalls);
  let cursor = 0;
  const poolToken0 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "token0",
    data: rpcHex(poolValues[cursor++], "PancakeSwap pool token0"),
  });
  const poolToken1 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "token1",
    data: rpcHex(poolValues[cursor++], "PancakeSwap pool token1"),
  });
  if (poolToken0.toLowerCase() !== token0.toLowerCase() || poolToken1.toLowerCase() !== token1.toLowerCase()) {
    throw new Error("PancakeSwap position and pool token ordering do not match");
  }
  const slot0 = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "slot0",
    data: rpcHex(poolValues[cursor++], "PancakeSwap position slot0"),
  });
  const activeLiquidity = decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "liquidity",
    data: rpcHex(poolValues[cursor++], "PancakeSwap active liquidity"),
  });
  const tickSpacing = Number(decodeFunctionResult({
    abi: POOL_ABI,
    functionName: "tickSpacing",
    data: rpcHex(poolValues[cursor++], "PancakeSwap tick spacing"),
  }));
  const token0Symbol = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "symbol",
    data: rpcHex(poolValues[cursor++], "PancakeSwap token0 symbol"),
  });
  const token0Decimals = Number(decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "decimals",
    data: rpcHex(poolValues[cursor++], "PancakeSwap token0 decimals"),
  }));
  const token1Symbol = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "symbol",
    data: rpcHex(poolValues[cursor++], "PancakeSwap token1 symbol"),
  });
  const token1Decimals = Number(decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "decimals",
    data: rpcHex(poolValues[cursor++], "PancakeSwap token1 decimals"),
  }));
  const collectResult = decodeFunctionResult({
    abi: POSITION_MANAGER_ABI,
    functionName: "collect",
    data: rpcHex(poolValues[cursor], "PancakeSwap simulated fee collection"),
  });
  if (token0Symbol !== "USDT" || token1Symbol !== "WBNB" || token0Decimals !== 18 || token1Decimals !== 18) {
    throw new Error("PancakeSwap position token metadata changed unexpectedly");
  }
  if (tickSpacing <= 0 || lowerTick % tickSpacing !== 0 || upperTick % tickSpacing !== 0) {
    throw new Error("PancakeSwap position ticks do not align with the pool spacing");
  }

  const sqrtPriceX96 = slot0[0];
  const currentTick = Number(slot0[1]);
  const amounts = v3PositionTokenAmounts(
    positionLiquidity,
    sqrtPriceX96,
    lowerTick,
    upperTick,
    token0Decimals,
    token1Decimals,
  );
  const token0ValueUsd = amounts.token0Amount * usdtPriceUsd;
  const token1ValueUsd = amounts.token1Amount * bnbPriceUsd;
  const principalValueUsd = token0ValueUsd + token1ValueUsd;
  const uncollectedFeesUsd =
    Number(formatUnits(collectResult[0], token0Decimals)) * usdtPriceUsd +
    Number(formatUnits(collectResult[1], token1Decimals)) * bnbPriceUsd;
  const activeLiquidityUsd = pancakeActiveLiquidityUsd(
    sqrtPriceX96,
    activeLiquidity,
    bnbPriceUsd,
    usdtPriceUsd,
  );
  if (!Number.isFinite(principalValueUsd) || principalValueUsd <= 0 || activeLiquidityUsd <= 0) {
    throw new Error("PancakeSwap position valuation is unavailable");
  }
  const token0ShareBps = Math.min(
    10_000,
    Math.max(0, Math.round(token0ValueUsd / principalValueUsd * 10_000)),
  );
  const token1ShareBps = 10_000 - token0ShareBps;
  const [volatility, runRate] = await Promise.all([
    readPancakeVolatility(poolAddress, block.number),
    readPancakeSwapRunRate(
      poolAddress,
      blockNumber,
      BigInt(block.timestamp),
      secondsPerBlock,
      token0Decimals,
      usdtPriceUsd,
      feeTier,
      options.logRpcUrl ? { endpoint: options.logRpcUrl, blockHash: block.hash } : undefined,
    ),
  ]);

  const gasPrice = BigInt(rpcHex(gasPriceValue, "BSC gas price"));
  const estimatedGasUsd = Math.max(
    0.01,
    Number(formatEther(gasPrice * 750_000n)) * bnbPriceUsd,
  );
  const rebalanceNotionalUsd = Math.abs(token0ValueUsd - token1ValueUsd) / 2;
  const maxSlippageBps = 30;
  const estimatedSwapCostUsd = rebalanceNotionalUsd *
    (feeTier / 1_000_000 + maxSlippageBps / 10_000);
  const positionWidth = upperTick - lowerTick;
  const minimumWidthTicks = Math.max(
    tickSpacing * 2,
    Math.floor(positionWidth / (2 * tickSpacing)) * tickSpacing,
  );
  const maximumWidthTicks = Math.max(
    minimumWidthTicks,
    Math.min(887_200, Math.ceil(positionWidth * 3 / tickSpacing) * tickSpacing),
  );
  const observedAt = new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString();
  const requestedAtDate = new Date();
  const requestedAt = requestedAtDate.toISOString();
  const deadline = new Date(requestedAtDate.getTime() + 120_000).toISOString();
  const sourceId = `pancake-position-mainnet-block-${blockNumber}`;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  const lpRequest = LpRebalanceRequestSchema.parse({
    schemaVersion: "positioncrew.lp-rebalance.request.v1",
    service: "LP_REBALANCE",
    requestId: `pancake-position-${tokenId}-${blockNumber}`,
    chainId: 56,
    account: owner,
    protocol: "PancakeSwap V3 position analysis",
    requestedAt,
    deadline,
    maxDataAgeSeconds: 120,
    maxActionUsd: decimal(Math.max(1, (estimatedGasUsd + estimatedSwapCostUsd) * 2), 6),
    maxGasUsd: decimal(Math.max(0.25, estimatedGasUsd * 2), 6),
    maxSlippageBps,
    sources: [{
      sourceId,
      label: `Block-pinned PancakeSwap V3 position ${tokenId}, pool, oracle, volatility, and swap-window state`,
      uri: explorerUrl,
      observedAt,
    }],
    pool: poolAddress,
    token0: { symbol: "USDT", address: token0, decimals: token0Decimals },
    token1: { symbol: "WBNB", address: token1, decimals: token1Decimals },
    position: {
      lowerTick,
      upperTick,
      liquidity: positionLiquidity.toString(),
      positionValueUsd: decimal(principalValueUsd, 6),
      feesEarnedUsd: decimal(uncollectedFeesUsd, 6),
      token0ShareBps,
      token1ShareBps,
    },
    marketState: {
      currentTick,
      token0PriceUsd: decimal(usdtPriceUsd, 8),
      token1PriceUsd: decimal(bnbPriceUsd, 8),
      volume24hUsd: decimal(runRate.volumeRunRate24hUsd, 2),
      fees24hUsd: decimal(runRate.feesRunRate24hUsd, 2),
      poolLiquidityUsd: decimal(activeLiquidityUsd, 2),
      realizedVolatilityBps: volatility.realizedVolatilityBps,
      volumeMeasurementWindowSeconds: runRate.measurementWindowSeconds,
      volumeNormalizationFactor: decimal(runRate.normalizationFactor, 6),
      swapCount: runRate.swapCount,
      observedAt,
      sourceId,
    },
    constraints: {
      minimumWidthTicks,
      maximumWidthTicks,
      tickSpacing,
      edgeBufferBps: 1_000,
      highVolatilityBps: Math.min(
        100_000,
        Math.max(1_000, volatility.realizedVolatilityBps * 2),
      ),
      maximumToken0ShareBps: 7_500,
      maximumToken1ShareBps: 7_500,
      minimumNetBenefitUsd: decimal(Math.max(0.1, principalValueUsd * 0.001), 6),
      estimatedGasUsd: decimal(estimatedGasUsd, 6),
      estimatedSwapCostUsd: decimal(estimatedSwapCostUsd, 6),
      evaluationHorizonHours: 24,
    },
  });

  return {
    schemaVersion: "positioncrew.pancake-position-probe.v1",
    generatedAt: requestedAt,
    chainId: 56,
    state: "READY",
    position: {
      tokenId: tokenId.toString(),
      owner,
      custody: owner.toLowerCase() === PANCAKE_MASTER_CHEF_V3.toLowerCase()
        ? "MASTER_CHEF_V3"
        : "DIRECT_OR_OTHER",
      positionManager: PANCAKE_V3_POSITION_MANAGER,
      pool: poolAddress,
      pair: "USDT/WBNB",
      feeTier,
      lowerTick,
      upperTick,
      currentTick,
      inRange: currentTick >= lowerTick && currentTick < upperTick,
      liquidity: positionLiquidity.toString(),
      token0Amount: decimal(amounts.token0Amount, 8),
      token1Amount: decimal(amounts.token1Amount, 8),
      positionValueUsd: lpRequest.position.positionValueUsd,
      uncollectedFeesUsd: lpRequest.position.feesEarnedUsd,
    },
    market: {
      activeLiquidityUsd: lpRequest.marketState.poolLiquidityUsd,
      realizedVolatilityBps: volatility.realizedVolatilityBps,
      volumeRunRate24hUsd: lpRequest.marketState.volume24hUsd,
      feesRunRate24hUsd: lpRequest.marketState.fees24hUsd,
      measurementWindowSeconds: runRate.measurementWindowSeconds,
      swapCount: runRate.swapCount,
    },
    lpRequest,
    source: {
      blockNumber: blockNumber.toString(),
      blockTimestamp: observedAt,
      explorerUrl,
      positionExplorerUrl: `https://bscscan.com/nft/${PANCAKE_V3_POSITION_MANAGER}/${tokenId}`,
      poolExplorerUrl: `https://bscscan.com/address/${poolAddress}`,
    },
    boundary:
      `NFT ownership, position liquidity, range, simulated collectible fees, pool identity, token metadata, Venus oracle prices, active liquidity, volatility, gas, and a ${runRate.measurementWindowSeconds}-second onchain swap window were reconciled to a pinned BSC block. The 24-hour volume and fee fields are extrapolated run rates, not guaranteed future activity. The request is unsigned and must be revalidated before execution.`,
  };
}

export async function inspectVenusStableYields(
  options: VenusYieldRequestOptions = {},
): Promise<VenusYieldProbe> {
  const accountInput = options.account ?? NATIVE_BNB;
  if (!isAddress(accountInput)) throw new Error("A valid EVM account address is required");
  const account = accountInput as Address;
  const capitalUsd = options.capitalUsd ?? 1_000;
  if (!Number.isFinite(capitalUsd) || capitalUsd < 1 || capitalUsd > 10_000_000) {
    throw new Error("capitalUsd must be between 1 and 10000000");
  }

  const [blockValue, gasPriceValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
    { method: "eth_gasPrice", params: [] },
  ]);
  const block = rpcBlock(blockValue, "BNB Smart Chain latest block");
  const blockNumber = BigInt(block.number);
  const priorBlockNumber = blockNumber > 120n ? blockNumber - 120n : 0n;
  const [priorBlockValue, oracleValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: [toHex(priorBlockNumber), false] },
    ethCall(
      VENUS_COMPTROLLER,
      encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: "oracle" }),
      block.number,
    ),
  ]);
  const priorBlock = rpcBlock(priorBlockValue, "BNB Smart Chain prior block");
  const oracle = decodeFunctionResult({
    abi: COMPTROLLER_ABI,
    functionName: "oracle",
    data: rpcHex(oracleValue, "Venus oracle"),
  });
  const secondsPerBlock = Math.max(
    0.1,
    Number(BigInt(block.timestamp) - BigInt(priorBlock.timestamp)) / 120,
  );

  const marketCalls: RpcCall[] = [];
  for (const market of VENUS_STABLE_MARKETS) {
    marketCalls.push(
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({
          abi: COMPTROLLER_ABI,
          functionName: "markets",
          args: [market.vToken],
        }),
        block.number,
      ),
      ethCall(
        market.vToken,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "underlying" }),
        block.number,
      ),
      ethCall(
        market.vToken,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "supplyRatePerBlock" }),
        block.number,
      ),
      ethCall(
        market.vToken,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: "getCash" }),
        block.number,
      ),
      ethCall(
        oracle,
        encodeFunctionData({
          abi: ORACLE_ABI,
          functionName: "getUnderlyingPrice",
          args: [market.vToken],
        }),
        block.number,
      ),
      ethCall(
        market.underlying,
        encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }),
        block.number,
      ),
      ethCall(
        market.underlying,
        encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }),
        block.number,
      ),
    );
  }
  marketCalls.push(
    ethCall(
      oracle,
      encodeFunctionData({
        abi: ORACLE_ABI,
        functionName: "getUnderlyingPrice",
        args: [VENUS_VBNB],
      }),
      block.number,
    ),
  );
  const marketValues = await rpcBatchChunked(MAINNET_RPC, marketCalls);
  let cursor = 0;
  const decodedMarkets = VENUS_STABLE_MARKETS.map((market) => {
    const listing = decodeFunctionResult({
      abi: COMPTROLLER_ABI,
      functionName: "markets",
      data: rpcHex(marketValues[cursor++], `${market.symbol} Venus listing`),
    });
    const underlying = decodeFunctionResult({
      abi: VTOKEN_ABI,
      functionName: "underlying",
      data: rpcHex(marketValues[cursor++], `${market.symbol} underlying`),
    });
    const supplyRate = decodeFunctionResult({
      abi: VTOKEN_ABI,
      functionName: "supplyRatePerBlock",
      data: rpcHex(marketValues[cursor++], `${market.symbol} supply rate`),
    });
    const cash = decodeFunctionResult({
      abi: VTOKEN_ABI,
      functionName: "getCash",
      data: rpcHex(marketValues[cursor++], `${market.symbol} cash`),
    });
    const price = decodeFunctionResult({
      abi: ORACLE_ABI,
      functionName: "getUnderlyingPrice",
      data: rpcHex(marketValues[cursor++], `${market.symbol} oracle price`),
    });
    const symbol = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "symbol",
      data: rpcHex(marketValues[cursor++], `${market.symbol} symbol`),
    });
    const decimals = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "decimals",
      data: rpcHex(marketValues[cursor++], `${market.symbol} decimals`),
    });
    if (!listing[0]) throw new Error(`Venus ${market.symbol} market is no longer listed`);
    if (underlying.toLowerCase() !== market.underlying.toLowerCase()) {
      throw new Error(`Venus ${market.symbol} underlying changed unexpectedly`);
    }
    if (symbol !== market.symbol || decimals !== 18) {
      throw new Error(`Venus ${market.symbol} token metadata changed unexpectedly`);
    }
    if (price <= 0n) throw new Error(`Venus ${market.symbol} has no oracle price`);
    const availableLiquidityUsdFixed = venusUsdValueFixed(cash, price);
    return {
      ...market,
      baseSupplyApyBps: annualizedYieldBps(supplyRate, secondsPerBlock),
      availableLiquidityUsdFixed,
      availableLiquidityUsd: formatFixed(availableLiquidityUsdFixed, 2),
    };
  });
  const vBnbPrice = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "getUnderlyingPrice",
    data: rpcHex(marketValues[cursor], "Venus BNB oracle price"),
  });
  if (vBnbPrice <= 0n) throw new Error("Venus BNB oracle price is unavailable");

  const bnbPriceUsd = Number(formatFixed(oraclePriceFixed(vBnbPrice, 18), 8));
  const gasPrice = BigInt(rpcHex(gasPriceValue, "BSC gas price"));
  const estimatedEntryCostUsd = Math.max(
    0.01,
    Number(formatEther(gasPrice * 350_000n)) * bnbPriceUsd,
  );
  const observedAt = new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString();
  const requestedAtDate = new Date();
  const requestedAt = requestedAtDate.toISOString();
  const deadline = new Date(requestedAtDate.getTime() + 120_000).toISOString();
  const sourceId = `venus-yield-mainnet-block-${blockNumber}`;
  const explorerUrl = `https://bscscan.com/block/${blockNumber}`;
  const rankedMarkets = [...decodedMarkets].sort(
    (left, right) => right.baseSupplyApyBps - left.baseSupplyApyBps,
  );
  const yieldRequest = YieldOptimizationRequestSchema.parse({
    schemaVersion: "positioncrew.yield-optimization.request.v1",
    service: "YIELD_OPTIMIZATION",
    requestId: `venus-yield-${blockNumber}`,
    chainId: 56,
    account,
    protocol: "Venus Core Pool stablecoin supply",
    requestedAt,
    deadline,
    maxDataAgeSeconds: 120,
    maxActionUsd: decimal(Math.max(0.25, estimatedEntryCostUsd * 2), 6),
    maxGasUsd: decimal(Math.max(0.25, estimatedEntryCostUsd * 2), 6),
    maxSlippageBps: 0,
    sources: [{
      sourceId,
      label: "Block-pinned Venus Core Pool stablecoin base-rate state",
      uri: explorerUrl,
      observedAt,
    }],
    capitalUsd: decimal(capitalUsd, 2),
    currentPositions: [],
    opportunities: rankedMarkets.map((market) => ({
      opportunityId: `venus-core-${market.symbol.toLowerCase()}-supply`,
      protocol: "Venus Core Pool",
      vaultOrMarket: market.vToken,
      asset: { symbol: market.symbol, address: market.underlying, decimals: 18 },
      amountUsd: decimal(
        Math.min(capitalUsd, Number(formatFixed(market.availableLiquidityUsdFixed, 8))),
        2,
      ),
      grossApyBps: market.baseSupplyApyBps,
      liquidityUsd: market.availableLiquidityUsd,
      lockupSeconds: 0,
      estimatedEntryCostUsd: decimal(estimatedEntryCostUsd, 6),
      estimatedExitCostUsd: decimal(estimatedEntryCostUsd, 6),
      riskTier: "MEDIUM",
      observedAt,
      sourceId,
    })),
    constraints: {
      protocolAllowlist: ["Venus Core Pool"],
      maximumRiskTier: "MEDIUM",
      maximumProtocolConcentrationBps: 10_000,
      maximumLockupSeconds: 0,
      minimumLiquidityUsd: "100000",
      minimumNetBenefitUsd: "1",
      evaluationHorizonDays: 90,
    },
  });

  return {
    schemaVersion: "positioncrew.venus-yield-probe.v1",
    generatedAt: requestedAt,
    chainId: 56,
    state: "READY",
    markets: rankedMarkets.map((market) => ({
      opportunityId: `venus-core-${market.symbol.toLowerCase()}-supply`,
      symbol: market.symbol,
      vToken: market.vToken,
      underlying: market.underlying,
      baseSupplyApyBps: market.baseSupplyApyBps,
      availableLiquidityUsd: market.availableLiquidityUsd,
    })),
    yieldRequest,
    source: {
      comptroller: VENUS_COMPTROLLER,
      oracle,
      blockNumber: blockNumber.toString(),
      blockTimestamp: observedAt,
      measuredSecondsPerBlock: Number(secondsPerBlock.toFixed(4)),
      explorerUrl,
    },
    boundary:
      "Base supply APYs, available cash, oracle prices, token metadata, gas, and measured block time were read for one BSC block. Incentive rewards are excluded. Rates are variable, stablecoins can depeg, and the unsigned allocation must be revalidated before execution.",
  };
}

export async function inspectVenusAccount(
  accountInput: string,
  options: VenusRescueRequestOptions = {},
): Promise<VenusAccountProbe> {
  if (!isAddress(accountInput)) throw new Error("A valid EVM account address is required");
  const account = accountInput as Address;
  const [blockValue] = await rpcBatch(MAINNET_RPC, [
    { method: "eth_getBlockByNumber", params: ["latest", false] },
  ]);
  const block = rpcBlock(blockValue, "BNB Smart Chain latest block");
  const [
    liquidityValue,
    enteredMarketsValue,
    oracleValue,
    vaiControllerValue,
    nativeBalanceValue,
    usdtBalanceValue,
    gasPriceValue,
  ] =
    await rpcBatch(MAINNET_RPC, [
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({
          abi: COMPTROLLER_ABI,
          functionName: "getAccountLiquidity",
          args: [account],
        }),
        block.number,
      ),
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({
          abi: COMPTROLLER_ABI,
          functionName: "getAssetsIn",
          args: [account],
        }),
        block.number,
      ),
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: "oracle" }),
        block.number,
      ),
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: "vaiController" }),
        block.number,
      ),
      { method: "eth_getBalance", params: [account, block.number] },
      ethCall(
        USDT,
        encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
        block.number,
      ),
      { method: "eth_gasPrice", params: [] },
    ]);
  const [errorCode, liquidity, shortfall] = decodeFunctionResult({
    abi: COMPTROLLER_ABI,
    functionName: "getAccountLiquidity",
    data: rpcHex(liquidityValue, "Venus account liquidity"),
  });
  const enteredMarkets = decodeFunctionResult({
    abi: COMPTROLLER_ABI,
    functionName: "getAssetsIn",
    data: rpcHex(enteredMarketsValue, "Venus entered markets"),
  });
  const oracle = decodeFunctionResult({
    abi: COMPTROLLER_ABI,
    functionName: "oracle",
    data: rpcHex(oracleValue, "Venus oracle"),
  });
  const vaiController = decodeFunctionResult({
    abi: COMPTROLLER_ABI,
    functionName: "vaiController",
    data: rpcHex(vaiControllerValue, "Venus VAI controller"),
  });
  const nativeBalance = BigInt(rpcHex(nativeBalanceValue, "BNB balance"));
  const usdtBalance = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: rpcHex(usdtBalanceValue, "USDT balance"),
  });
  const gasPrice = BigInt(rpcHex(gasPriceValue, "BSC gas price"));
  if (errorCode !== 0n) throw new Error(`Venus Comptroller returned error code ${errorCode}`);

  const [vaiAddressValue, vaiDebtValue] = await rpcBatch(MAINNET_RPC, [
    ethCall(
      vaiController,
      encodeFunctionData({ abi: VAI_CONTROLLER_ABI, functionName: "getVAIAddress" }),
      block.number,
    ),
    ethCall(
      vaiController,
      encodeFunctionData({
        abi: VAI_CONTROLLER_ABI,
        functionName: "getVAIRepayAmount",
        args: [account],
      }),
      block.number,
    ),
  ]);
  const vaiAddress = decodeFunctionResult({
    abi: VAI_CONTROLLER_ABI,
    functionName: "getVAIAddress",
    data: rpcHex(vaiAddressValue, "VAI address"),
  });
  const vaiDebtRaw = decodeFunctionResult({
    abi: VAI_CONTROLLER_ABI,
    functionName: "getVAIRepayAmount",
    data: rpcHex(vaiDebtValue, "VAI debt"),
  });

  const entered = new Set(enteredMarkets.map((market) => market.toLowerCase()));
  const activeMarkets = [...enteredMarkets];

  const marketCalls: RpcCall[] = [];
  for (const vToken of activeMarkets) {
    marketCalls.push(
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: "markets", args: [vToken] }),
        block.number,
      ),
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({
          abi: COMPTROLLER_ABI,
          functionName: "getEffectiveLtvFactor",
          args: [account, vToken, 0],
        }),
        block.number,
      ),
      ethCall(
        VENUS_COMPTROLLER,
        encodeFunctionData({
          abi: COMPTROLLER_ABI,
          functionName: "getEffectiveLtvFactor",
          args: [account, vToken, 1],
        }),
        block.number,
      ),
      ethCall(
        vToken,
        encodeFunctionData({
          abi: VTOKEN_ABI,
          functionName: "getAccountSnapshot",
          args: [account],
        }),
        block.number,
      ),
      ethCall(
        oracle,
        encodeFunctionData({ abi: ORACLE_ABI, functionName: "getUnderlyingPrice", args: [vToken] }),
        block.number,
      ),
    );
    if (vToken.toLowerCase() !== VENUS_VBNB.toLowerCase()) {
      marketCalls.push(
        ethCall(
          vToken,
          encodeFunctionData({ abi: VTOKEN_ABI, functionName: "underlying" }),
          block.number,
        ),
      );
    }
  }
  marketCalls.push(
    ethCall(
      oracle,
      encodeFunctionData({
        abi: ORACLE_ABI,
        functionName: "getUnderlyingPrice",
        args: [VENUS_VBNB],
      }),
      block.number,
    ),
  );
  const marketValues = await rpcBatchChunked(MAINNET_RPC, marketCalls);
  let marketCursor = 0;
  const rawMarkets = activeMarkets.map((vToken) => {
    const listed = decodeFunctionResult({
      abi: COMPTROLLER_ABI,
      functionName: "markets",
      data: rpcHex(marketValues[marketCursor++], `${vToken} listing`),
    });
    const effectiveCollateralFactor = decodeFunctionResult({
      abi: COMPTROLLER_ABI,
      functionName: "getEffectiveLtvFactor",
      data: rpcHex(marketValues[marketCursor++], `${vToken} effective collateral factor`),
    });
    const liquidationThreshold = decodeFunctionResult({
      abi: COMPTROLLER_ABI,
      functionName: "getEffectiveLtvFactor",
      data: rpcHex(marketValues[marketCursor++], `${vToken} effective liquidation threshold`),
    });
    const accountSnapshot = decodeFunctionResult({
      abi: VTOKEN_ABI,
      functionName: "getAccountSnapshot",
      data: rpcHex(marketValues[marketCursor++], `${vToken} account snapshot`),
    });
    const priceRaw = decodeFunctionResult({
      abi: ORACLE_ABI,
      functionName: "getUnderlyingPrice",
      data: rpcHex(marketValues[marketCursor++], `${vToken} oracle price`),
    });
    const underlying = vToken.toLowerCase() === VENUS_VBNB.toLowerCase()
      ? NATIVE_BNB
      : decodeFunctionResult({
          abi: VTOKEN_ABI,
          functionName: "underlying",
          data: rpcHex(marketValues[marketCursor++], `${vToken} underlying`),
        });
    if (!listed[0]) throw new Error(`Venus market ${vToken} is no longer listed`);
    if (accountSnapshot[0] !== 0n) {
      throw new Error(`Venus market ${vToken} returned snapshot error ${accountSnapshot[0]}`);
    }
    if (priceRaw <= 0n) throw new Error(`Venus market ${vToken} has no oracle price`);
    return {
      vToken,
      underlying,
      collateralFactor: effectiveCollateralFactor,
      collateralEnabled: entered.has(vToken.toLowerCase()),
      suppliedRaw: (accountSnapshot[1] * accountSnapshot[3]) / FIXED_SCALE,
      borrowedRaw: accountSnapshot[2],
      priceRaw,
      liquidationThreshold,
    };
  });
  const vBnbPriceRaw = decodeFunctionResult({
    abi: ORACLE_ABI,
    functionName: "getUnderlyingPrice",
    data: rpcHex(marketValues[marketCursor], "vBNB oracle price"),
  });

  const uniqueUnderlyings = [...new Map(rawMarkets.map((market) => [
    market.underlying.toLowerCase(),
    market.underlying,
  ])).values()];
  const tokenCalls: RpcCall[] = [];
  for (const underlying of uniqueUnderlyings) {
    if (underlying.toLowerCase() === NATIVE_BNB.toLowerCase()) continue;
    tokenCalls.push(
      ethCall(
        underlying,
        encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }),
        block.number,
      ),
      ethCall(
        underlying,
        encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }),
        block.number,
      ),
      ethCall(
        underlying,
        encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
        block.number,
      ),
    );
  }
  tokenCalls.push(
    ethCall(
      vaiAddress,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
      block.number,
    ),
  );
  const tokenValues = tokenCalls.length > 0
    ? await rpcBatchChunked(MAINNET_RPC, tokenCalls)
    : [];
  let tokenCursor = 0;
  const tokenMetadata = new Map<string, { symbol: string; decimals: number; walletRaw: bigint }>();
  for (const underlying of uniqueUnderlyings) {
    if (underlying.toLowerCase() === NATIVE_BNB.toLowerCase()) {
      tokenMetadata.set(underlying.toLowerCase(), {
        symbol: "BNB",
        decimals: 18,
        walletRaw: nativeBalance,
      });
      continue;
    }
    const decimals = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "decimals",
      data: rpcHex(tokenValues[tokenCursor++], `${underlying} decimals`),
    });
    const symbol = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "symbol",
      data: rpcHex(tokenValues[tokenCursor++], `${underlying} symbol`),
    });
    const walletRaw = decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: "balanceOf",
      data: rpcHex(tokenValues[tokenCursor++], `${underlying} wallet balance`),
    });
    if (symbol.length > 16) throw new Error(`Unsupported Venus token symbol: ${symbol}`);
    tokenMetadata.set(underlying.toLowerCase(), { symbol, decimals, walletRaw });
  }
  const vaiWalletRaw = decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: "balanceOf",
    data: rpcHex(tokenValues[tokenCursor], "VAI wallet balance"),
  });

  const observedAt = new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString();
  const sourceId = `venus-mainnet-block-${BigInt(block.number)}`;
  const decodedMarkets = rawMarkets.map((market) => {
    const metadata = tokenMetadata.get(market.underlying.toLowerCase());
    if (!metadata) throw new Error(`Missing token metadata for ${market.underlying}`);
    const suppliedUsd = venusUsdValueFixed(market.suppliedRaw, market.priceRaw);
    const borrowedUsd = venusUsdValueFixed(market.borrowedRaw, market.priceRaw);
    return {
      ...market,
      ...metadata,
      suppliedUsd,
      borrowedUsd,
      priceFixed: oraclePriceFixed(market.priceRaw, metadata.decimals),
      collateralFactorBps: Number((market.collateralFactor * 10_000n) / FIXED_SCALE),
      liquidationThresholdBps: Number(
        (market.liquidationThreshold * 10_000n) / FIXED_SCALE,
      ),
    };
  });
  const {
    collateralValueUsd,
    liquidationWeightedCollateralUsd,
    debtValueUsd,
    liquidityUsd: expectedLiquidity,
    shortfallUsd: expectedShortfall,
  } = venusLiquidityTotalsFixed(decodedMarkets, vaiDebtRaw);

  const accountingDifference =
    (expectedLiquidity > liquidity ? expectedLiquidity - liquidity : liquidity - expectedLiquidity) +
    (expectedShortfall > shortfall ? expectedShortfall - shortfall : shortfall - expectedShortfall);
  if (accountingDifference > FIXED_SCALE) {
    throw new Error(
      `Venus market reconstruction does not match Comptroller account liquidity ` +
      `(expected liquidity ${formatFixed(expectedLiquidity, 6)}, actual ${formatFixed(liquidity, 6)}; ` +
      `expected shortfall ${formatFixed(expectedShortfall, 6)}, actual ${formatFixed(shortfall, 6)})`,
    );
  }

  const bnbPriceFixed = oraclePriceFixed(vBnbPriceRaw, 18);
  const estimatedGasUsd = (gasPrice * 350_000n * bnbPriceFixed) / FIXED_SCALE;
  const generatedAt = new Date().toISOString();
  const source = {
    sourceId,
    label: `Venus Classic account and oracle snapshot at BSC block ${BigInt(block.number)}`,
    uri: `https://bscscan.com/block/${BigInt(block.number)}`,
    observedAt,
  };
  const collateral = decodedMarkets
    .filter((market) => market.collateralEnabled && market.suppliedRaw > 0n)
    .map((market) => ({
      symbol: market.symbol,
      address: market.underlying,
      decimals: market.decimals,
      amount: tokenAmount(market.suppliedRaw, market.decimals),
      priceUsd: formatFixed(market.priceFixed, 8),
      sourceId,
      observedAt,
      liquidationThresholdBps: market.liquidationThresholdBps,
      collateralEnabled: true,
    }));
  const debt = decodedMarkets
    .filter((market) => market.borrowedRaw > 0n)
    .map((market) => ({
      symbol: market.symbol,
      address: market.underlying,
      decimals: market.decimals,
      amount: tokenAmount(market.borrowedRaw, market.decimals),
      priceUsd: formatFixed(market.priceFixed, 8),
      sourceId,
      observedAt,
    }));
  if (vaiDebtRaw > 0n) {
    debt.push({
      symbol: "VAI",
      address: vaiAddress,
      decimals: 18,
      amount: tokenAmount(vaiDebtRaw, 18),
      priceUsd: "1",
      sourceId,
      observedAt,
    });
  }
  const availableAssets = decodedMarkets.map((market) => ({
    symbol: market.symbol,
    address: market.underlying,
    decimals: market.decimals,
    availableAmount: tokenAmount(market.walletRaw, market.decimals),
  }));
  if (vaiDebtRaw > 0n || vaiWalletRaw > 0n) {
    availableAssets.push({
      symbol: "VAI",
      address: vaiAddress,
      decimals: 18,
      availableAmount: tokenAmount(vaiWalletRaw, 18),
    });
  }
  const rescueRequest = LendingRescueRequestSchema.parse({
        schemaVersion: "positioncrew.lending-rescue.request.v1",
        service: "LENDING_RESCUE",
        requestId: `venus-live-${account.toLowerCase().slice(2, 10)}-${Date.now()}`,
        chainId: 56,
        account,
        protocol: "Venus Classic",
        requestedAt: generatedAt,
        deadline: new Date(Date.parse(generatedAt) + 5 * 60_000).toISOString(),
        maxDataAgeSeconds: 300,
        maxActionUsd: options.maxActionUsd ?? "250",
        maxGasUsd: options.maxGasUsd ?? minimumPositiveGasLimit(estimatedGasUsd),
        maxSlippageBps: options.maxSlippageBps ?? 30,
        sources: [source],
        market: VENUS_COMPTROLLER,
        position: { collateral, debt },
        availableAssets,
        allowedActions: ["REPAY_DEBT", "ADD_COLLATERAL"],
        targetHealthFactor: options.targetHealthFactor ?? "1.25",
        stressPriceDropBps: options.stressPriceDropBps ?? 1_000,
        oracleDeviationToleranceBps: 100,
        estimatedGasUsd: formatFixed(estimatedGasUsd, 6),
      });
  const state =
    activeMarkets.length === 0 ? "NO_POSITION" : shortfall > 0n ? "SHORTFALL" : "LIQUID";

  return {
    schemaVersion: "positioncrew.venus-account-probe.v1",
    generatedAt,
    chainId: 56,
    account,
    state,
    nativeBalanceBnb: decimal(Number(formatEther(nativeBalance)), 6),
    usdtBalance: decimal(Number(formatUnits(usdtBalance, 18)), 2),
    liquidityUsd: decimal(Number(formatUnits(liquidity, 18)), 6),
    shortfallUsd: decimal(Number(formatUnits(shortfall, 18)), 6),
    enteredMarkets: [...enteredMarkets],
    position: {
      collateralValueUsd: formatFixed(collateralValueUsd, 6),
      liquidationWeightedCollateralUsd: formatFixed(liquidationWeightedCollateralUsd, 6),
      debtValueUsd: formatFixed(debtValueUsd, 6),
      healthFactor: debtValueUsd === 0n
        ? null
        : formatFixed((liquidationWeightedCollateralUsd * FIXED_SCALE) / debtValueUsd, 8),
      markets: decodedMarkets.map((market) => ({
        vToken: market.vToken,
        symbol: market.symbol,
        underlying: market.underlying,
        decimals: market.decimals,
        suppliedAmount: tokenAmount(market.suppliedRaw, market.decimals),
        borrowedAmount: tokenAmount(market.borrowedRaw, market.decimals),
        walletAmount: tokenAmount(market.walletRaw, market.decimals),
        priceUsd: formatFixed(market.priceFixed, 8),
        collateralFactorBps: market.collateralFactorBps,
        liquidationThresholdBps: market.liquidationThresholdBps,
        collateralEnabled: market.collateralEnabled,
      })),
    },
    rescueRequest,
    source: {
      comptroller: VENUS_COMPTROLLER,
      blockNumber: BigInt(block.number).toString(),
      explorerUrl: `https://bscscan.com/block/${BigInt(block.number)}`,
    },
    boundary: collateral.length > 0 && debt.length > 0
      ? "The embedded rescue request was reconstructed from block-pinned Venus Classic balances, collateral factors, liquidation thresholds, oracle prices, and wallet inventory. It remains unsigned and must be revalidated before execution."
      : "This block-pinned Venus Classic account has no reconstructable collateral-and-debt pair. Its embedded request is preserved so the provider can return an explicit, receipted refusal.",
  };
}
