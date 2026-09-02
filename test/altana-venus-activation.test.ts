import { describe, expect, it } from "vitest";
import { signerFromPrivateKey } from "@altananetwork/sdk";
import {
  ALTANA_VENUS_ACTOR,
  ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI,
  ALTANA_VENUS_VBNB,
  parseAltanaVenusSessionSecret,
  publicAltanaVenusSession,
} from "../src/commerce/altana-venus-activation.js";

const privateKey = `0x${"11".repeat(32)}` as `0x${string}`;
const signer = signerFromPrivateKey(privateKey);

function secret(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: "positioncrew.altana-venus-session-secret.v1",
    walletAddress: ALTANA_VENUS_ACTOR,
    privateKey,
    publicKey: signer.publicKey,
    expiry: 2_000_000_000,
    grantTransactionHash: `0x${"22".repeat(32)}`,
    permissions: {
      calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" }],
      spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString(), period: "minute" }],
    },
    ...overrides,
  });
}

describe("Altana Venus session boundary", () => {
  it("reconstructs only the exact actor, selector target, spend cap and expiry", () => {
    const parsed = parseAltanaVenusSessionSecret(secret(), 1_900_000_000_000);
    expect(parsed.session.walletAddress).toBe(ALTANA_VENUS_ACTOR);
    expect(parsed.session.permissions.calls).toEqual([{ to: ALTANA_VENUS_VBNB, signature: "mint()" }]);
    expect(publicAltanaVenusSession(secret(), 1_900_000_000_000)).not.toHaveProperty("privateKey");
  });

  it("fails closed for an expired session", () => {
    expect(() => parseAltanaVenusSessionSecret(secret({ expiry: 1_800_000_000 }), 1_900_000_000_000))
      .toThrow("ALTANA_SESSION_EXPIRED");
  });

  it("fails closed for a broader spend cap", () => {
    expect(() => parseAltanaVenusSessionSecret(secret({
      permissions: {
        calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" }],
        spend: [{ limit: "300000000000000", period: "minute" }],
      },
    }), 1_900_000_000_000)).toThrow("ALTANA_SESSION_SPEND_SCOPE_MISMATCH");
  });
});
