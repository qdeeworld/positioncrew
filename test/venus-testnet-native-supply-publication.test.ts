import { describe, expect, it } from "vitest";
import worker from "../worker/index.js";
import {
  VENUS_TESTNET_NATIVE_SUPPLY_ARTIFACT_HASH,
  VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE,
  VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE,
  VENUS_TESTNET_NATIVE_SUPPLY_PUBLIC_CLAIM_BOUNDARY,
  VENUS_TESTNET_NATIVE_SUPPLY_TRANSACTION_HASH,
} from "../src/commerce/venus-testnet-native-supply-publication.js";
import { verifyVenusTestnetNativeSupplyEvidence } from "../src/commerce/venus-testnet-native-supply-evidence.js";

const fetchWorker = worker.fetch as unknown as (
  request: Request,
  env: { ASSETS: { fetch(request: Request): Promise<Response> }; DB: unknown },
  context: { waitUntil(promise: Promise<unknown>): void },
) => Promise<Response>;

async function requestPublication(method = "GET"): Promise<Response> {
  return fetchWorker(
    new Request(`https://positioncrew.dolepee.com${VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE_ROUTE}`, { method }),
    {
      ASSETS: { fetch: async () => new Response("not used", { status: 500 }) },
      DB: {},
    },
    { waitUntil: () => undefined },
  );
}

describe("Venus BSC Testnet native-supply publication", () => {
  it("freezes the exact schema-valid artifact and canonical commitments", () => {
    expect(verifyVenusTestnetNativeSupplyEvidence(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE)).toEqual(
      VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE,
    );
    expect(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE.commitments.artifactHash).toBe(
      VENUS_TESTNET_NATIVE_SUPPLY_ARTIFACT_HASH,
    );
    expect(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE.transaction.hash).toBe(
      VENUS_TESTNET_NATIVE_SUPPLY_TRANSACTION_HASH,
    );
    expect(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE.intent.transaction).toMatchObject({
      amountTbnb: "0.0001",
      valueWei: "100000000000000",
    });
  });

  it("contains no signed raw transaction, secret, keystore, or local path material", () => {
    const serialized = JSON.stringify(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE);
    for (const forbidden of [
      /rawTransaction/i,
      /private[-_ ]?key/i,
      /password/i,
      /keystore/i,
      /mnemonic/i,
      /seed[-_ ]?phrase/i,
      /\/Users\//,
      /\/home\//,
      /\/root\//,
      /[A-Za-z]:\\\\/,
    ]) expect(serialized).not.toMatch(forbidden);
  });

  it("retains the complete optional-evidence claim boundary", () => {
    expect(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE.relationship).toBe("FOUNDER_CONTROLLED_TESTNET_ACTION");
    expect(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE.actor.externalBuyer).toBe(false);
    expect(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE.intent.preflight.mainnetIsolation).toMatchObject({
      chainId: 56,
      nativeBalanceWei: "0",
      pendingNonce: "0",
    });
    for (const phrase of [
      "Optional sponsor and execution evidence",
      "disclosed-operator",
      "BSC Testnet",
      "exactly 0.0001 tBNB",
      "observed zero native BNB balance",
      "did not inventory tokens or NFTs",
      "external buyer",
      "revenue",
      "autonomous custody",
      "strategy return",
      "repeated track record",
      "marketplace demand",
      "financial performance",
    ]) expect(VENUS_TESTNET_NATIVE_SUPPLY_PUBLIC_CLAIM_BOUNDARY).toContain(phrase);
  });

  it("serves the exact immutable artifact over a GET-only public-CORS route", async () => {
    const response = await requestPublication();
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await response.json()).toEqual(VENUS_TESTNET_NATIVE_SUPPLY_EVIDENCE);

    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const rejected = await requestPublication(method);
      expect(rejected.status).toBe(405);
      expect(await rejected.json()).toMatchObject({ error: "METHOD_NOT_ALLOWED" });
    }
  });
});
