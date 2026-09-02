import { describe, expect, it } from "vitest";
import { signerFromPrivateKey } from "@altananetwork/sdk";
import { encodeAbiParameters, keccak256, padHex } from "viem";
import {
  ALTANA_VENUS_ACTOR,
  ALTANA_VENUS_MINT_SELECTOR,
  ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI,
  ALTANA_VENUS_SUPPLY_WEI,
  ALTANA_VENUS_VBNB,
  confirmedAltanaRelayTransaction,
  parseAltanaVenusSessionSecret,
  publicAltanaVenusSession,
  verifyLiveAltanaVenusSession,
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
    expect(ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI).toBe(ALTANA_VENUS_SUPPLY_WEI * 2n);
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

  it("requires the session to remain live in both KeyStore and the account", async () => {
    const accountPublicKeyHash = keccak256(padHex(signer.address, { size: 32 }));
    const accountPublicKey = padHex(signer.address, { size: 32 });
    const accountKeyHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [2n, accountPublicKeyHash],
    ));
    const verified = await verifyLiveAltanaVenusSession(secret(), 1_900_000_000_000, async (request) => {
      const typed = request as { functionName?: string; args?: unknown[] };
      if (typed.functionName === "isValidKey") return true;
      if (typed.functionName === "getKeys") {
        return [[{
          expiry: 2_000_000_000n,
          keyType: 2,
          isSuperAdmin: false,
          publicKey: accountPublicKey,
        }], [accountKeyHash]];
      }
      if (typed.functionName === "canExecutePackedInfos") return [`0x${"55".repeat(32)}`];
      if (typed.functionName === "callCheckerInfos") return [];
      if (typed.functionName === "approvedSignatureCheckers") return [];
      if (typed.functionName === "canExecute") {
        return typed.args?.[1] === ALTANA_VENUS_VBNB && typed.args?.[2] === ALTANA_VENUS_MINT_SELECTOR;
      }
      if (typed.functionName === "spendInfos") {
        return [{
          token: "0x0000000000000000000000000000000000000000",
          period: 0,
          limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI,
          spent: 0n,
          lastUpdated: 0n,
          currentSpent: 0n,
          current: 0n,
        }];
      }
      throw new Error(`Unexpected function ${typed.functionName}`);
    });
    expect(verified.verification.registryValid).toBe(true);
    expect(verified.verification.accountAuthorized).toBe(true);
    expect(verified.verification.accountKeyHash).toBe(accountKeyHash);
    expect(verified.verification.accountKeyExpiry).toBe(2_000_000_000);
    expect(verified.verification.accountKeyType).toBe(2);
    expect(verified.verification.accountKeyIsSuperAdmin).toBe(false);
    expect(verified.verification.accountKeyPublicKey).toBe(accountPublicKey);
    expect(verified.verification.liveExecutionRuleCount).toBe(1);
    expect(verified.verification.liveCallScopeVerified).toBe(true);
    expect(verified.verification.liveCallCheckerRuleCount).toBe(0);
    expect(verified.verification.liveSignatureCheckerRuleCount).toBe(0);
    expect(verified.verification.liveSpendRuleCount).toBe(1);
    expect(verified.verification.liveSpendLimit).toBe(ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString());
    expect(verified.verification.registryKeyId).not.toBe(accountKeyHash);

    await expect(verifyLiveAltanaVenusSession(secret(), 1_900_000_000_000, async (request) =>
      (request as { functionName?: string }).functionName === "isValidKey" ? false : [[], []]
    )).rejects.toThrow("ALTANA_SESSION_KEYSTORE_INVALID");
    await expect(verifyLiveAltanaVenusSession(secret(), 1_900_000_000_000, async (request) =>
      (request as { functionName?: string }).functionName === "isValidKey" ? true : [[], []]
    )).rejects.toThrow("ALTANA_SESSION_ACCOUNT_UNAUTHORIZED");
  });

  it.each([
    [{ expiry: 1_999_999_999n, keyType: 2, isSuperAdmin: false, publicKey: padHex(signer.address, { size: 32 }) }, "ALTANA_SESSION_ACCOUNT_EXPIRY_MISMATCH"],
    [{ expiry: 2_000_000_000n, keyType: 1, isSuperAdmin: false, publicKey: padHex(signer.address, { size: 32 }) }, "ALTANA_SESSION_ACCOUNT_KEY_TYPE_MISMATCH"],
    [{ expiry: 2_000_000_000n, keyType: 2, isSuperAdmin: true, publicKey: padHex(signer.address, { size: 32 }) }, "ALTANA_SESSION_ACCOUNT_SUPER_ADMIN"],
    [{ expiry: 2_000_000_000n, keyType: 2, isSuperAdmin: false, publicKey: `0x${"44".repeat(32)}` }, "ALTANA_SESSION_ACCOUNT_PUBLIC_KEY_MISMATCH"],
  ])("rejects mismatched account-key metadata", async (metadata, expectedError) => {
    const accountPublicKeyHash = keccak256(padHex(signer.address, { size: 32 }));
    const accountKeyHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [2n, accountPublicKeyHash],
    ));
    await expect(verifyLiveAltanaVenusSession(secret(), 1_900_000_000_000, async (request) =>
      (request as { functionName?: string }).functionName === "isValidKey"
        ? true
        : [[metadata], [accountKeyHash]]
    )).rejects.toThrow(expectedError);
  });

  it.each([
    ["canExecutePackedInfos", [`0x${"55".repeat(32)}`, `0x${"66".repeat(32)}`], "ALTANA_SESSION_EXECUTION_SCOPE_MISMATCH"],
    ["callCheckerInfos", [{ target: ALTANA_VENUS_VBNB, checker: "0x0000000000000000000000000000000000000002" }], "ALTANA_SESSION_CALL_CHECKER_SCOPE_MISMATCH"],
    ["approvedSignatureCheckers", ["0x0000000000000000000000000000000000000002"], "ALTANA_SESSION_SIGNATURE_CHECKER_SCOPE_MISMATCH"],
    ["spendInfos", [], "ALTANA_SESSION_SPEND_SCOPE_MISMATCH"],
    ["spendInfos", [{ token: "0x0000000000000000000000000000000000000000", period: 1, limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI }], "ALTANA_SESSION_SPEND_SCOPE_MISMATCH"],
  ])("rejects broadened or replaced live %s records", async (overriddenFunction, overriddenValue, expectedError) => {
    const accountPublicKey = padHex(signer.address, { size: 32 });
    const accountPublicKeyHash = keccak256(accountPublicKey);
    const accountKeyHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }],
      [2n, accountPublicKeyHash],
    ));
    await expect(verifyLiveAltanaVenusSession(secret(), 1_900_000_000_000, async (request) => {
      const typed = request as { functionName?: string; args?: unknown[] };
      if (typed.functionName === "isValidKey") return true;
      if (typed.functionName === "getKeys") return [[{
        expiry: 2_000_000_000n,
        keyType: 2,
        isSuperAdmin: false,
        publicKey: accountPublicKey,
      }], [accountKeyHash]];
      if (typed.functionName === overriddenFunction) return overriddenValue;
      if (typed.functionName === "canExecutePackedInfos") return [`0x${"55".repeat(32)}`];
      if (typed.functionName === "callCheckerInfos") return [];
      if (typed.functionName === "approvedSignatureCheckers") return [];
      if (typed.functionName === "canExecute") {
        return typed.args?.[1] === ALTANA_VENUS_VBNB && typed.args?.[2] === ALTANA_VENUS_MINT_SELECTOR;
      }
      if (typed.functionName === "spendInfos") return [{
        token: "0x0000000000000000000000000000000000000000",
        period: 0,
        limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI,
      }];
      throw new Error(`Unexpected function ${typed.functionName}`);
    })).rejects.toThrow(expectedError);
  });
});

describe("Altana relay outbox", () => {
  it("extracts a confirmed transaction hash", () => {
    const transactionHash = `0x${"33".repeat(32)}`;
    expect(confirmedAltanaRelayTransaction({
      status: 200,
      receipts: [{ transactionHash }],
    })).toBe(transactionHash);
  });

  it("keeps pending relay calls recoverable", () => {
    expect(() => confirmedAltanaRelayTransaction({ status: 100, receipts: [] }))
      .toThrow("ALTANA_RELAY_PENDING");
  });

  it.each([400, 500, 600, "FAILED"])("marks relay failure status %s terminal", (status) => {
    expect(() => confirmedAltanaRelayTransaction({ status, receipts: [] }))
      .toThrow("ALTANA_EXECUTION_FAILED");
  });
});
