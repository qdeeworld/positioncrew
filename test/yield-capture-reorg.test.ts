import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, toHex, type Address } from "viem";
import { inspectVenusStableYields } from "../src/telemetry/bsc.js";

const NOW = new Date("2026-09-08T02:45:00.000Z");
const BLOCK = 120610000n;
const TIME = BigInt(NOW.getTime() / 1_000);
const OBSERVED_HASH = `0x${"ab".repeat(32)}`;
const BASELINE_HASH = `0x${"cd".repeat(32)}`;
const ORACLE = "0x1111111111111111111111111111111111111111";
const markets = [
  ["USDC", "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"],
  ["USDT", "0xfD5840Cd36d94D7229439859C0112a4185BC0255", "0x55d398326f99059fF775485246999027B3197955"],
  ["DAI", "0x334b3eCB4DCa3593BCCC3c7EBD1A1C1d1780FBF1", "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3"],
  ["FDUSD", "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba", "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409"],
] as const;

type BlockHeader = { number: string; timestamp: string; hash?: string };
type RpcCall = { id: number; method: string; params: unknown[] };
type Mutation = (header: BlockHeader, baseline: boolean, afterState: boolean) => BlockHeader | null;
function installRpc(mutate: Mutation = (header) => header) {
  const calls: RpcCall[] = [];
  let stateCalls = 0;
  const headerChecks: Array<{ baseline: boolean; stateCalls: number }> = [];
  const uint = (value: bigint) => encodeAbiParameters(parseAbiParameters("uint256"), [value]);
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const payload: RpcCall | RpcCall[] = JSON.parse(String(init?.body));
    function respond(call: RpcCall) {
      calls.push(call);
      let result: unknown;
      if (call.method === "eth_getBlockByNumber") {
        const baseline = call.params[0] !== "latest" && BigInt(String(call.params[0])) === BLOCK - 120n;
        headerChecks.push({ baseline, stateCalls });
        result = mutate({ number: toHex(baseline ? BLOCK - 120n : BLOCK),
          timestamp: toHex(baseline ? TIME - 54n : TIME), hash: baseline ? BASELINE_HASH : OBSERVED_HASH }, baseline, stateCalls > 1);
      } else if (call.method === "eth_gasPrice") result = toHex(50_000_000n);
      else if (call.method === "eth_call") {
        stateCalls += 1;
        expect(call.params[1]).toBe(toHex(BLOCK));
        const input = call.params[0] as { to: string; data: string };
        const selector = input.data.slice(0, 10);
        const market = markets.find((entry) => entry[1].toLowerCase() === input.to.toLowerCase());
        const underlying = markets.find((entry) => entry[2].toLowerCase() === input.to.toLowerCase());
        if (selector === toFunctionSelector("oracle()")) result = encodeAbiParameters(parseAbiParameters("address"), [ORACLE]);
        else if (selector === toFunctionSelector("markets(address)")) {
          result = encodeAbiParameters(parseAbiParameters("bool,uint256,bool,uint256,uint256,uint96,bool"), [true, 800000000000000000n, true, 800000000000000000n, 1100000000000000000n, 0n, true]);
        } else if (selector === toFunctionSelector("underlying()") && market) result = encodeAbiParameters(parseAbiParameters("address"), [market[2] as Address]);
        else if (selector === toFunctionSelector("supplyRatePerBlock()")) result = uint(267884853n);
        else if (selector === toFunctionSelector("getCash()")) result = uint(1000000n * 10n ** 18n);
        else if (selector === toFunctionSelector("getUnderlyingPrice(address)")) result = uint(10n ** 18n);
        else if (selector === toFunctionSelector("symbol()") && underlying) result = encodeAbiParameters(parseAbiParameters("string"), [underlying[0]]);
        else if (selector === toFunctionSelector("decimals()")) result = encodeAbiParameters(parseAbiParameters("uint8"), [18]);
        else throw new Error(`Unexpected fixture eth_call ${selector}`);
      } else throw new Error(`Unexpected fixture RPC method ${call.method}`);
      return { jsonrpc: "2.0", id: call.id, result };
    }
    return Response.json(Array.isArray(payload) ? payload.map(respond) : respond(payload));
  }));
  return { calls, headerChecks };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("retained Yield capture block consistency", () => {
  it("rechecks both exact headers only after every market state call", async () => {
    const rpc = installRpc();
    const result = await inspectVenusStableYields({ retainYieldRateObservation: true });
    expect(result.yieldRateObservation?.observedBlock.blockHash).toBe(OBSERVED_HASH);
    expect(result.yieldRateObservation?.baselineBlock.blockHash).toBe(BASELINE_HASH);
    expect(result.yieldRateObservation?.marketRates).toHaveLength(4);
    const stateCount = rpc.calls.filter((call) => call.method === "eth_call").length;
    expect(stateCount).toBe(30);
    expect(rpc.headerChecks.slice(-2)).toEqual([
      { baseline: false, stateCalls: stateCount }, { baseline: true, stateCalls: stateCount },
    ]);
    expect(rpc.calls.slice(-2).map((call) => call.method)).toEqual(["eth_getBlockByNumber", "eth_getBlockByNumber"]);
  });

  it.each(["observed", "baseline"] as const)("rejects a changed %s hash before returning a retained capture", async (target) => {
    installRpc((header, baseline, afterState) => afterState && baseline === (target === "baseline")
      ? { ...header, hash: `0x${"ef".repeat(32)}` } : header);
    await expect(inspectVenusStableYields({ retainYieldRateObservation: true })).rejects.toThrow(`${target} block changed`);
  });

  it.each(["observed", "baseline"] as const)("rejects changed %s height or time even when the hash is copied", async (target) => {
    for (const field of ["number", "timestamp"] as const) {
      installRpc((header, baseline, afterState) => afterState && baseline === (target === "baseline")
        ? { ...header, [field]: toHex(BigInt(header[field]) + 1n) } : header);
      await expect(inspectVenusStableYields({ retainYieldRateObservation: true })).rejects.toThrow(`${target} block changed`);
    }
  });

  it("rejects an initially incorrect baseline height", async () => {
    installRpc((header, baseline, afterState) => baseline && !afterState ? { ...header, number: toHex(BLOCK - 119n) } : header);
    await expect(inspectVenusStableYields({ retainYieldRateObservation: true })).rejects.toThrow("baseline block changed");
  });

  it.each(["missing-hash", "invalid-hash", "missing-block"] as const)("rejects an unverifiable confirmation: %s", async (kind) => {
    installRpc((header, baseline, afterState) => {
      if (baseline || !afterState) return header;
      if (kind === "missing-block") return null;
      if (kind === "missing-hash") {
        const missingHash = { ...header };
        delete missingHash.hash;
        return missingHash;
      }
      return { ...header, hash: "0x1234" };
    });
    await expect(inspectVenusStableYields({ retainYieldRateObservation: true })).rejects.toThrow();
  });

  it("compares hashes without depending on hexadecimal letter casing", async () => {
    installRpc((header, _baseline, afterState) => afterState ? { ...header, hash: `0x${header.hash!.slice(2).toUpperCase()}` } : header);
    await expect(inspectVenusStableYields({ retainYieldRateObservation: true })).resolves.toHaveProperty("yieldRateObservation");
  });

  it("leaves the legacy non-retained capture path unchanged", async () => {
    const rpc = installRpc();
    const result = await inspectVenusStableYields();
    expect(result).not.toHaveProperty("yieldRateObservation");
    expect(rpc.headerChecks).toHaveLength(2);
  });
});
