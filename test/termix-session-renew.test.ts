import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import {
  TERMIX_SESSION_EXPECTED_WALLET,
  TERMIX_SESSION_REQUIRED_AGENT_ID,
  atomicInstallSessionToken,
  protectedOwnerKeyMetadataAccepted,
  protectedSessionTokenMetadataAccepted,
  renewTermixSession,
  sessionRenewalFailureLogRecord,
  sessionRenewalLogRecord,
  sessionTokenNeedsRenewal,
} from "../src/cli/renew-termix-session-token.js";

const NOW = new Date("2026-09-04T06:00:00.000Z");
const TEST_KEY = `0x${"1".repeat(64)}` as Hex;

function jwt(expiresAt: Date): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt.getTime() / 1_000) }))
    .toString("base64url");
  return `header.${payload}.signature`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "positioncrew-session-renew-"));
  const tokenPath = join(directory, "termix-session.token");
  return {
    directory,
    tokenPath,
    config: {
      ownerKeyFile: "/run/credentials/owner-key",
      tokenPath,
      baseUrl: "https://platform-backend.prod.termix.live",
    },
  };
}

function testAccount(signMessage = vi.fn(async () => `0x${"2".repeat(130)}` as Hex)) {
  return {
    address: TERMIX_SESSION_EXPECTED_WALLET,
    signMessage,
  };
}

describe("TermiX wallet-session renewal", () => {
  it("accepts only root-owned regular owner keys with mode 0400 or 0600", () => {
    expect(protectedOwnerKeyMetadataAccepted({ isFile: true, mode: 0o400, size: 67 })).toBe(true);
    expect(protectedOwnerKeyMetadataAccepted({ isFile: true, mode: 0o600, size: 67 })).toBe(true);
    expect(protectedOwnerKeyMetadataAccepted({ isFile: true, mode: 0o640, size: 67 })).toBe(false);
    expect(protectedOwnerKeyMetadataAccepted({ isFile: false, mode: 0o600, size: 67 })).toBe(false);
    expect(protectedSessionTokenMetadataAccepted(
      { isFile: true, uid: 501, mode: 0o600, size: 512 },
      501,
    )).toBe(true);
    expect(protectedSessionTokenMetadataAccepted(
      { isFile: true, uid: 0, mode: 0o600, size: 512 },
      501,
    )).toBe(false);
    expect(protectedSessionTokenMetadataAccepted(
      { isFile: true, uid: 501, mode: 0o640, size: 512 },
      501,
    )).toBe(false);
  });

  it("does nothing while the installed JWT has more than six hours remaining", async () => {
    const { directory, tokenPath, config } = fixture();
    const token = jwt(new Date(NOW.getTime() + 7 * 60 * 60 * 1_000));
    writeFileSync(tokenPath, token, { mode: 0o600 });
    const fetchMock = vi.fn(async () => Response.json({
      items: [{ id: TERMIX_SESSION_REQUIRED_AGENT_ID }],
    }));
    const readOwnerKey = vi.fn(async () => TEST_KEY);
    try {
      await expect(renewTermixSession(config, {
        now: NOW,
        fetchImpl: fetchMock as unknown as typeof fetch,
        readOwnerKey,
        accountFromPrivateKey: () => testAccount(),
      })).resolves.toMatchObject({ rotated: false });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${config.baseUrl}/api/v1/agents`);
      expect(readOwnerKey).toHaveBeenCalledOnce();
      expect(sessionTokenNeedsRenewal(token, NOW)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signs the returned nonce message and validates provider-order access before install", async () => {
    const { directory, tokenPath, config } = fixture();
    const oldToken = jwt(new Date(NOW.getTime() - 60_000));
    const issuedToken = jwt(new Date(NOW.getTime() + 24 * 60 * 60 * 1_000));
    writeFileSync(tokenPath, oldToken, { mode: 0o600 });
    const signMessage = vi.fn(async () => `0x${"2".repeat(130)}` as Hex);
    let requestCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({ nonce: "nonce-1", message: "Sign this exact TermiX nonce" });
      }
      if (requestCount === 2) return Response.json({ accessToken: issuedToken });
      return Response.json({ items: [{ id: TERMIX_SESSION_REQUIRED_AGENT_ID }] });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    try {
      await expect(renewTermixSession(config, {
        now: NOW,
        fetchImpl,
        readOwnerKey: async () => TEST_KEY,
        accountFromPrivateKey: () => testAccount(signMessage),
      })).resolves.toMatchObject({ rotated: true });

      expect(signMessage).toHaveBeenCalledWith({ message: "Sign this exact TermiX nonce" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${config.baseUrl}/api/v1/auth/nonce`);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        walletAddress: TERMIX_SESSION_EXPECTED_WALLET,
      });
      expect(fetchMock.mock.calls[1]?.[0]).toBe(`${config.baseUrl}/api/v1/auth/wallet`);
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
        walletAddress: TERMIX_SESSION_EXPECTED_WALLET,
        nonce: "nonce-1",
        signature: `0x${"2".repeat(130)}`,
      });
      expect(fetchMock.mock.calls[2]?.[0]).toBe(
        `${config.baseUrl}/api/v1/agents`,
      );
      expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${issuedToken}`,
      );
      expect(readFileSync(tokenPath, "utf8")).toBe(`${issuedToken}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects the wrong owner address before any authentication request", async () => {
    const { directory, tokenPath, config } = fixture();
    writeFileSync(tokenPath, jwt(new Date(NOW.getTime() + 60_000)), { mode: 0o600 });
    const fetchImpl = vi.fn();
    try {
      await expect(renewTermixSession(config, {
        now: NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        readOwnerKey: async () => TEST_KEY,
        accountFromPrivateKey: () => ({
          ...testAccount(),
          address: "0x0000000000000000000000000000000000000001",
        }),
      })).rejects.toThrow("does not match the fixed TermiX wallet");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the old token when read-only session validation fails", async () => {
    const { directory, tokenPath, config } = fixture();
    const oldToken = jwt(new Date(NOW.getTime() - 60_000));
    const issuedToken = jwt(new Date(NOW.getTime() + 24 * 60 * 60 * 1_000));
    writeFileSync(tokenPath, oldToken, { mode: 0o600 });
    let requestCount = 0;
    const fetchMock = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) return Response.json({ nonce: "nonce-1", message: "message" });
      if (requestCount === 2) return Response.json({ accessToken: issuedToken });
      return new Response(null, { status: 401 });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    try {
      await expect(renewTermixSession(config, {
        now: NOW,
        fetchImpl,
        readOwnerKey: async () => TEST_KEY,
        accountFromPrivateKey: () => testAccount(),
      })).rejects.toThrow("was rejected after authentication");
      expect(readFileSync(tokenPath, "utf8")).toBe(oldToken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a fresh current token when ownership validation is temporarily unavailable", async () => {
    const { directory, tokenPath, config } = fixture();
    const currentToken = jwt(new Date(NOW.getTime() + 7 * 60 * 60 * 1_000));
    writeFileSync(tokenPath, currentToken, { mode: 0o600 });
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    try {
      await expect(renewTermixSession(config, {
        now: NOW,
        fetchImpl: fetchMock as unknown as typeof fetch,
        readOwnerKey: async () => TEST_KEY,
        accountFromPrivateKey: () => testAccount(),
      })).rejects.toThrow("owned-agent validation failed with HTTP 503");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(readFileSync(tokenPath, "utf8")).toBe(currentToken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "HTTP 403",
      response: async () => new Response(null, { status: 403 }),
      code: "OWNED_AGENT_FORBIDDEN",
    },
    {
      name: "invalid JSON",
      response: async () => new Response("private response body {"),
      code: "OWNED_AGENT_INVALID_RESPONSE",
    },
    {
      name: "invalid response schema",
      response: async () => Response.json({ items: "private response data" }),
      code: "OWNED_AGENT_INVALID_RESPONSE",
    },
    {
      name: "a missing required owned agent",
      response: async () => Response.json({ items: [{ id: "some-other-agent" }] }),
      code: "OWNED_AGENT_REQUIRED_AGENT_MISSING",
    },
    {
      name: "a transport failure",
      response: async () => { throw new Error("private transport details"); },
      code: "OWNED_AGENT_TRANSPORT_FAILED",
    },
    {
      name: "HTTP 503",
      response: async () => new Response("private server response", { status: 503 }),
      code: "OWNED_AGENT_SERVER_ERROR",
    },
    {
      name: "an unexpected HTTP status",
      response: async () => new Response("private unexpected response", { status: 418 }),
      code: "OWNED_AGENT_UNEXPECTED_STATUS",
    },
  ])("does not reauthenticate or replace the current token after $name", async ({ response, code }) => {
    const { directory, tokenPath, config } = fixture();
    const currentToken = jwt(new Date(NOW.getTime() + 7 * 60 * 60 * 1_000));
    writeFileSync(tokenPath, currentToken, { mode: 0o600 });
    const signMessage = vi.fn(async () => `0x${"2".repeat(130)}` as Hex);
    const fetchMock = vi.fn(response);
    try {
      const error = await renewTermixSession(config, {
        now: NOW,
        fetchImpl: fetchMock as unknown as typeof fetch,
        readOwnerKey: async () => TEST_KEY,
        accountFromPrivateKey: () => testAccount(signMessage),
      }).then(() => undefined, (reason: unknown) => reason);

      expect(error).toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(signMessage).not.toHaveBeenCalled();
      expect(readFileSync(tokenPath, "utf8")).toBe(currentToken);
      expect(sessionRenewalFailureLogRecord(error)).toEqual({
        event: "termix.wallet-session.renewal-failed",
        wallet: TERMIX_SESSION_EXPECTED_WALLET,
        code,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reauthenticates a still-unexpired current token only after owned-agent HTTP 401", async () => {
    const { directory, tokenPath, config } = fixture();
    const currentToken = jwt(new Date(NOW.getTime() + 7 * 60 * 60 * 1_000));
    const issuedToken = jwt(new Date(NOW.getTime() + 24 * 60 * 60 * 1_000));
    writeFileSync(tokenPath, currentToken, { mode: 0o600 });
    const signMessage = vi.fn(async () => `0x${"2".repeat(130)}` as Hex);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      switch (fetchMock.mock.calls.length) {
        case 1: return new Response(null, { status: 401 });
        case 2: return Response.json({ nonce: "nonce-1", message: "sign me" });
        case 3: return Response.json({ accessToken: issuedToken });
        default: return Response.json({ items: [{ id: TERMIX_SESSION_REQUIRED_AGENT_ID }] });
      }
    });
    try {
      await expect(renewTermixSession(config, {
        now: NOW,
        fetchImpl: fetchMock as unknown as typeof fetch,
        readOwnerKey: async () => TEST_KEY,
        accountFromPrivateKey: () => testAccount(signMessage),
      })).resolves.toMatchObject({ rotated: true });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `${config.baseUrl}/api/v1/agents`,
        `${config.baseUrl}/api/v1/auth/nonce`,
        `${config.baseUrl}/api/v1/auth/wallet`,
        `${config.baseUrl}/api/v1/agents`,
      ]);
      expect(signMessage).toHaveBeenCalledOnce();
      expect(readFileSync(tokenPath, "utf8")).toBe(`${issuedToken}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fsyncs the temporary token and parent directory around the atomic rename", async () => {
    const operations: string[] = [];
    let openCount = 0;
    await atomicInstallSessionToken("/etc/positioncrew-runtime/credentials/token", "jwt", {
      open: async () => {
        openCount += 1;
        if (openCount === 1) {
          operations.push("open-temporary");
          return {
            writeFile: async () => { operations.push("write-temporary"); },
            sync: async () => { operations.push("fsync-temporary"); },
            close: async () => { operations.push("close-temporary"); },
          };
        }
        operations.push("open-directory");
        return {
          sync: async () => { operations.push("fsync-directory"); },
          close: async () => { operations.push("close-directory"); },
        };
      },
      rename: async () => { operations.push("rename"); },
      unlink: async () => { operations.push("unlink"); },
    });
    expect(operations).toEqual([
      "open-temporary",
      "write-temporary",
      "fsync-temporary",
      "close-temporary",
      "rename",
      "open-directory",
      "fsync-directory",
      "close-directory",
    ]);
  });

  it("emits only the wallet, rotation result, expiry, and short token hash on success", () => {
    const record = sessionRenewalLogRecord({
      rotated: false,
      expiresAt: "2026-09-05T06:00:00.000Z",
      tokenHash: "123456789abc",
    });
    expect(record).toEqual({
      event: "termix.wallet-session.renewal-complete",
      wallet: TERMIX_SESSION_EXPECTED_WALLET,
      expiry: "2026-09-05T06:00:00.000Z",
      tokenHash: "123456789abc",
      rotated: false,
    });
    expect(Object.keys(record).sort()).toEqual([
      "event",
      "expiry",
      "rotated",
      "tokenHash",
      "wallet",
    ]);
  });

  it("redacts unknown failure details behind a finite safe error code", () => {
    const secret = "secret-token-and-response-body";
    const record = sessionRenewalFailureLogRecord(new Error(secret));
    expect(record).toEqual({
      event: "termix.wallet-session.renewal-failed",
      wallet: TERMIX_SESSION_EXPECTED_WALLET,
      code: "INTERNAL_ERROR",
    });
    expect(Object.keys(record).sort()).toEqual(["code", "event", "wallet"]);
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it("installs unit-specific credential overrides and recurring non-overlapping timers", () => {
    const observer = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-orders.service", import.meta.url),
      "utf8",
    );
    const observerTimer = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-orders.timer", import.meta.url),
      "utf8",
    );
    const renewal = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-session-renew.service", import.meta.url),
      "utf8",
    );
    const renewalOverride = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-session-renew.service.d/zzzz-load-credential.conf", import.meta.url),
      "utf8",
    );
    const observerOverride = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-orders.service.d/zzzz-load-credential.conf", import.meta.url),
      "utf8",
    );
    const renewalTimer = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-session-renew.timer", import.meta.url),
      "utf8",
    );
    const installer = readFileSync(
      new URL("../deploy/install-positioncrew-termix-orders.sh", import.meta.url),
      "utf8",
    );
    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    const alert = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-order-alert.service", import.meta.url),
      "utf8",
    );

    expect(observer).toContain(
      "TERMIX_SESSION_TOKEN_FILE=%d/session-token",
    );
    expect(observer).not.toContain("LoadCredential=");
    expect(observerOverride).toContain(
      "LoadCredential=session-token:/var/lib/positioncrew-termix-session-renew/termix-session.token",
    );
    expect(observerOverride).toContain("NoNewPrivileges=true");
    expect(observerTimer).toContain("OnBootSec=7min");
    expect(observerTimer).toContain("OnUnitInactiveSec=1min");
    expect(renewal).toContain("User=positioncrew-session-renew");
    expect(renewal).toContain("Group=positioncrew-session-renew");
    expect(renewal).toContain("TERMIX_SESSION_OWNER_KEY_FILE=%d/owner-key");
    expect(renewal).toContain(
      "TERMIX_SESSION_TOKEN_PATH=/var/lib/positioncrew-termix-session-renew/termix-session.token",
    );
    expect(renewal).toContain("StateDirectory=positioncrew-termix-session-renew");
    expect(renewal).toContain("StateDirectoryMode=0700");
    expect(renewal).not.toContain("LoadCredential=");
    expect(renewal).toContain(
      "ExecStart=/usr/bin/node /opt/positioncrew-termix-session-renew/renew-termix-session-token.mjs",
    );
    expect(renewal).not.toContain("ReadWritePaths=/etc/positioncrew-runtime/credentials");
    expect(renewal).not.toContain(
      "AssertFileNotEmpty=/etc/positioncrew-runtime/credentials/termix-session.token",
    );
    expect(renewal).not.toContain("Restart=");
    expect(renewal).not.toContain("RestartSec=");
    expect(renewal).not.toContain("StartLimitIntervalSec=");
    expect(renewal).toContain("TimeoutStartSec=2min");
    expect(renewalOverride).toContain("LoadCredential=\nLoadCredential=owner-key:");
    expect(renewalOverride).toContain("NoNewPrivileges=true");
    expect(renewalTimer).toContain("OnBootSec=1min");
    expect(renewalTimer).toContain("OnUnitInactiveSec=1h");
    expect(renewalTimer).toContain("RandomizedDelaySec=2min");
    expect(renewalTimer).toContain("Persistent=true");
    expect(installer).toContain("preflight_root_secret \"${owner_key}\"");
    expect(installer).not.toContain("preflight_root_secret \"${session_token}\"");
    expect(installer.indexOf("preflight_root_secret \"${owner_key}\"")).toBeLessThan(
      installer.indexOf("/usr/bin/install -d"),
    );
    expect(installer).toContain("zzzz-load-credential.conf");
    expect(installer).toContain("renew-termix-session-token.mjs");
    expect(installer).toContain("positioncrew-termix-session-renew.timer");
    expect(installer.indexOf("systemctl start positioncrew-termix-session-renew.service")).toBeLessThan(
      installer.indexOf("\"${observer_source}\" \\\n  \"${artifact_root}/watch-termix-orders.mjs\""),
    );
    expect(alert).not.toMatch(/owner-key|session-token|termix-session\.token/);
    expect(packageJson.scripts.build).toContain("npm run build:termix-session-renewer");
    expect(packageJson.scripts["build:termix-session-renewer"]).toContain(
      "src/cli/renew-termix-session-token.ts",
    );
  });
});
