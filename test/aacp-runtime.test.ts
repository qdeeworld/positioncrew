import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TermixRuntimeClient,
  assertRuntimeTokenFresh,
  buildTermixRuntimeDecision,
  createTermixRuntimeState,
  hasProcessedRuntimeMessage,
  recordTermixRuntimeDecision,
  resolveRuntimeTokenExpiry,
  runtimePollSince,
  type TermixRuntimeMessage,
} from "../src/commerce/aacp-runtime.js";
import {
  TERMIX_RUNTIME_CREDENTIAL_EXIT_CODE,
  TermixRuntimeCredentialFileError,
  bundleRuntimeArtifact,
  migrateLegacyRuntimeState,
  parseRuntimeEnvironment,
  runRuntimeCycle,
  runtimeExitCode,
  validateProtectedRuntimeTokenFile,
} from "../src/cli/run-termix-runtime.js";
import {
  actionableOrders,
  atomicJson,
  unseenOrderTransitions,
} from "../src/cli/watch-termix-orders.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function message(
  overrides: Partial<TermixRuntimeMessage> = {},
): TermixRuntimeMessage {
  return {
    messageId: "message-1",
    conversationId: "conversation-1",
    conversationKind: "DIRECT_MESSAGE",
    orderId: null,
    prepaymentOrderId: null,
    disputeId: null,
    kind: "TEXT",
    text: "What do you need and what will I receive?",
    from: {
      accountId: "account-1",
      walletAddress: "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF",
      displayName: "Buyer",
      handle: "buyer.agent",
    },
    createdAt: "2026-08-13T11:59:00.000Z",
    ...overrides,
  };
}

function jwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("PositionCrew TermiX A2A runtime", () => {
  it("alerts once per actionable TermiX order transition for the exact provider", () => {
    const initial = {
      schemaVersion: "positioncrew.termix-order-watch.v1" as const,
      agentId: "agent-1",
      observations: {},
      lastPollAt: null,
    };
    const orders = actionableOrders([
      { id: "order-1", status: "PENDING_ACCEPT", providerAgentId: "agent-1", deliveryDueAt: null },
      { id: "order-2", status: "SETTLED", providerAgentId: "agent-1", deliveryDueAt: null },
      { id: "order-3", status: "FUNDED", providerAgentId: "agent-2", deliveryDueAt: null },
    ], "agent-1");
    expect(orders.map((order) => order.id)).toEqual(["order-1"]);

    const first = unseenOrderTransitions(initial, orders);
    expect(first.changed.map((order) => order.id)).toEqual(["order-1"]);
    expect(unseenOrderTransitions(first.state, orders).changed).toEqual([]);

    const advanced = unseenOrderTransitions(first.state, [{
      ...orders[0]!,
      status: "IN_PROGRESS",
      availableActions: { canSubmitDelivery: true },
    }]);
    expect(advanced.changed.map((order) => order.id)).toEqual(["order-1"]);
  });

  it("publishes an alert durably before the watcher may advance its cursor", async () => {
    const operations: string[] = [];
    let openCount = 0;
    await atomicJson("/var/spool/positioncrew-termix-order-outbox/alert.json", { orderId: "order-1" }, 0o640, {
      mkdir: async () => {
        operations.push("mkdir");
      },
      open: async () => {
        openCount += 1;
        if (openCount === 1) {
          operations.push("open-temporary");
          return {
            writeFile: async () => {
              operations.push("write-temporary");
            },
            sync: async () => {
              operations.push("fsync-temporary");
            },
            close: async () => {
              operations.push("close-temporary");
            },
          };
        }
        operations.push("open-directory");
        return {
          sync: async () => {
            operations.push("fsync-directory");
          },
          close: async () => {
            operations.push("close-directory");
          },
        };
      },
      rename: async () => {
        operations.push("rename");
      },
      unlink: async () => {
        operations.push("unlink");
      },
    });
    operations.push("persist-cursor");

    expect(operations).toEqual([
      "mkdir",
      "open-temporary",
      "write-temporary",
      "fsync-temporary",
      "close-temporary",
      "rename",
      "open-directory",
      "fsync-directory",
      "close-directory",
      "persist-cursor",
    ]);
  });

  it("bounds a full paginated poll and schedules the next run after completion", () => {
    const service = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-orders.service", import.meta.url),
      "utf8",
    );
    const timer = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-orders.timer", import.meta.url),
      "utf8",
    );
    const credentialOverride = readFileSync(
      new URL(
        "../deploy/systemd/positioncrew-termix-orders.service.d/zzzz-load-credential.conf",
        import.meta.url,
      ),
      "utf8",
    );

    expect(service).toContain("TimeoutStartSec=5h");
    expect(service).toContain("WorkingDirectory=/opt/positioncrew-termix-orders");
    expect(service).toContain(
      "ConditionFileNotEmpty=/opt/positioncrew-termix-orders/watch-termix-orders.mjs",
    );
    expect(service).toContain(
      "ExecStart=/usr/bin/node /opt/positioncrew-termix-orders/watch-termix-orders.mjs",
    );
    expect(service).toContain(
      "Environment=TERMIX_SESSION_TOKEN_FILE=%d/session-token",
    );
    expect(service).not.toContain("LoadCredential=");
    expect(credentialOverride).toContain(
      "LoadCredential=session-token:/var/lib/positioncrew-termix-session-renew/termix-session.token",
    );
    expect(credentialOverride).toContain("NoNewPrivileges=true");
    expect(service).toContain("ProtectHome=yes");
    expect(service).not.toContain("/home/crosswind");
    expect(timer).toContain("OnBootSec=7min");
    expect(timer).toContain("OnUnitInactiveSec=1min");
    expect(timer).not.toContain("OnUnitActiveSec=");
  });

  it("installs bundled TermiX order services into an accessible root-owned runtime", () => {
    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { scripts: Record<string, string> };
    const alertService = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-order-alert.service", import.meta.url),
      "utf8",
    );
    const installer = readFileSync(
      new URL("../deploy/install-positioncrew-termix-orders.sh", import.meta.url),
      "utf8",
    );
    const sysusers = readFileSync(
      new URL("../deploy/sysusers.d/positioncrew-termix-orders.conf", import.meta.url),
      "utf8",
    );
    const renewalSysusers = readFileSync(
      new URL("../deploy/sysusers.d/positioncrew-termix-session-renew.conf", import.meta.url),
      "utf8",
    );
    const renewalService = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-session-renew.service", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts.build).toContain("npm run build:termix-orders");
    expect(packageJson.scripts["build:termix-orders"]).toContain("--bundle");
    expect(packageJson.scripts["build:termix-orders"]).toContain("src/cli/watch-termix-orders.ts");
    expect(packageJson.scripts["build:termix-orders"]).toContain("src/cli/notify-termix-orders.ts");
    expect(packageJson.scripts["build:termix-session-renewer"]).toContain(
      "--outfile=dist/termix-session-renew/renew-termix-session-token.mjs",
    );
    expect(alertService).toContain(
      "ExecStart=/usr/bin/node /opt/positioncrew-termix-orders/notify-termix-orders.mjs",
    );
    expect(installer).toContain(
      "/usr/bin/install -d -o root -g root -m 0755 \"${artifact_root}\"",
    );
    expect(installer).toContain(
      "/usr/bin/install -d -o root -g root -m 0755 \"${session_renewer_artifact_root}\"",
    );
    expect(installer).toContain(
      "/usr/bin/install -d -o root -g root -m 0755 /etc/sysusers.d",
    );
    expect(installer).toContain(
      "/usr/bin/install -d -o root -g root -m 0755 /etc/tmpfiles.d",
    );
    expect(installer).toContain(
      "/usr/bin/install -d -o root -g root -m 0755 /etc/systemd/system",
    );
    expect(installer).toContain("/usr/bin/install -T -o root -g root -m 0555");
    expect(installer).toContain("preflight_renewed_session_token");
    expect(installer).toContain("/usr/bin/systemctl daemon-reload");
    expect(installer).toContain("/usr/bin/systemctl enable --now");
    expect(installer).toContain("positioncrew-termix-orders.timer");
    expect(installer).toContain("positioncrew-termix-order-alert.path");
    expect(installer).toContain("positioncrew-termix-session-renew.timer");
    expect(installer).not.toContain("try-restart");
    expect(sysusers.trim()).toBe(
      'u positioncrew-orders - "PositionCrew TermiX order observer" /nonexistent',
    );
    expect(renewalSysusers.trim()).toBe(
      'u positioncrew-session-renew - "PositionCrew TermiX session renewer" /nonexistent',
    );
    expect(renewalService).toContain("User=positioncrew-session-renew");
    expect(renewalService).toContain("Group=positioncrew-session-renew");
    expect(renewalService).toContain(
      "ExecStart=/usr/bin/node /opt/positioncrew-termix-session-renew/renew-termix-session-token.mjs",
    );
    expect(installer.indexOf("systemctl start positioncrew-termix-session-renew.service")).toBeLessThan(
      installer.indexOf("\"${observer_source}\" \\\n  \"${artifact_root}/watch-termix-orders.mjs\""),
    );
    expect(installer.indexOf("preflight_renewed_session_token")).toBeLessThan(
      installer.indexOf("\"${observer_source}\" \\\n  \"${artifact_root}/watch-termix-orders.mjs\""),
    );
  });

  it.each([
    ["LENDING_RESCUE", "target health factor", "smallest bounded repay", "lending-rescue"],
    ["LP_REBALANCE", "PancakeSwap V3 position", "range shift or HOLD", "lp-rebalance"],
    ["YIELD_OPTIMIZATION", "stablecoin allocation", "migration break-even", "yield-optimization"],
    ["BOUNDED_GRID", "WBNB/USDT market snapshot", "grid specification", "bounded-grid"],
  ] as const)(
    "returns an immediately useful %s response without fabricating execution",
    (service, requiredInput, usefulResult, slug) => {
      const decision = buildTermixRuntimeDecision(message(), service);

      expect(decision.disposition).toBe("REPLY");
      if (decision.disposition !== "REPLY") throw new Error("Expected a reply");
      expect(decision.text).toContain("5 USDC");
      expect(decision.text).toContain(requiredInput);
      expect(decision.text).toContain(usefulResult);
      expect(decision.text).toContain("machine-readable JSON");
      expect(decision.text).toContain(`/providers/${slug}`);
      expect(decision.text).toContain(`/api/providers/${slug}/manifest`);
      expect(decision.text).toContain("only after their AACP on-chain state is verified");
      expect(decision.text).not.toMatch(/executed|completed order|earned|revenue/i);
    },
  );

  it("never auto-replies to a dispute or value-bearing delivery thread", () => {
    expect(
      buildTermixRuntimeDecision(
        message({ conversationKind: "CHALLENGE", disputeId: "dispute-1" }),
        "LENDING_RESCUE",
      ),
    ).toEqual({ disposition: "OPERATOR_REQUIRED", reason: "DISPUTE_OR_OPERATOR_CASE" });
    expect(
      buildTermixRuntimeDecision(
        message({ conversationKind: "ORDER_DELIVERY", orderId: "order-1" }),
        "LENDING_RESCUE",
      ),
    ).toEqual({ disposition: "OPERATOR_REQUIRED", reason: "VALUE_BEARING_ORDER" });
  });

  it("ignores platform events and empty messages", () => {
    expect(
      buildTermixRuntimeDecision(message({ kind: "ORDER_EVENT" }), "BOUNDED_GRID"),
    ).toEqual({ disposition: "IGNORE", reason: "NON_TEXT_EVENT" });
    expect(
      buildTermixRuntimeDecision(message({ text: "   " }), "BOUNDED_GRID"),
    ).toEqual({ disposition: "IGNORE", reason: "EMPTY_MESSAGE" });
  });

  it("persists idempotency and an overlap cursor without losing equal-time messages", () => {
    const initial = createTermixRuntimeState("agent-1", "LP_REBALANCE", NOW);
    const decision = buildTermixRuntimeDecision(message(), "LP_REBALANCE");
    const next = recordTermixRuntimeDecision(initial, message(), decision, NOW);

    expect(hasProcessedRuntimeMessage(next, "message-1")).toBe(true);
    expect(runtimePollSince(next)).toBe("2026-08-13T11:59:59.000Z");
    expect(next.lastReplyAt).toBe(NOW.toISOString());
  });

  it("decodes token expiry and fails closed inside the refresh buffer", () => {
    const future = Math.floor(NOW.getTime() / 1_000) + 3_600;
    expect(resolveRuntimeTokenExpiry(jwt(future))?.toISOString()).toBe(
      "2026-08-13T13:00:00.000Z",
    );
    expect(
      assertRuntimeTokenFresh(jwt(future), { now: NOW }).toISOString(),
    ).toBe("2026-08-13T13:00:00.000Z");

    const nearExpiry = Math.floor(NOW.getTime() / 1_000) + 60;
    expect(() => assertRuntimeTokenFresh(jwt(nearExpiry), { now: NOW })).toThrow(
      "fail-closed refresh window",
    );
    expect(() => assertRuntimeTokenFresh("opaque-runtime-token", { now: NOW })).toThrow(
      "expiry is unknown",
    );
  });

  it("marks token expiry as a non-retryable service exit", () => {
    const nearExpiry = jwt(Math.floor(NOW.getTime() / 1_000) + 60);
    let expiryError: unknown;
    try {
      assertRuntimeTokenFresh(nearExpiry, { now: NOW });
    } catch (error) {
      expiryError = error;
    }

    expect(runtimeExitCode(expiryError)).toBe(TERMIX_RUNTIME_CREDENTIAL_EXIT_CODE);
    expect(runtimeExitCode(new Error("temporary network failure"))).toBe(1);
  });

  it("refuses a host environment containing wallet signing material", () => {
    const base = {
      TERMIX_A2A_AGENT_ID: "agent-1",
      TERMIX_A2A_RUNTIME_TOKEN: jwt(Math.floor(NOW.getTime() / 1_000) + 3_600),
      POSITIONCREW_SERVICE: "LENDING_RESCUE",
    };
    expect(() => parseRuntimeEnvironment({ ...base, WALLET_KEY: "secret" }, [])).toThrow(
      "must not receive an owner private key",
    );
    expect(() => parseRuntimeEnvironment({ ...base, PRIVATE_KEY: "secret" }, [])).toThrow(
      "must not receive an owner private key",
    );
  });

  it("loads only a protected, unambiguous runtime credential file", () => {
    const directory = mkdtempSync(join(tmpdir(), "positioncrew-runtime-credential-"));
    const tokenFile = join(directory, "runtime-token");
    const token = jwt(Math.floor(NOW.getTime() / 1_000) + 3_600);
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const base = {
      TERMIX_A2A_AGENT_ID: "agent-1",
      POSITIONCREW_SERVICE: "LENDING_RESCUE",
      TERMIX_A2A_RUNTIME_TOKEN_FILE: tokenFile,
    };

    try {
      expect(parseRuntimeEnvironment(base, []).token).toBe(token);
      expect(parseRuntimeEnvironment(
        {
          TERMIX_A2A_AGENT_ID: "agent-1",
          POSITIONCREW_SERVICE: "LENDING_RESCUE",
        },
        ["--runtime-token-file", tokenFile],
      ).token).toBe(token);
      expect(() => parseRuntimeEnvironment(
        { ...base, TERMIX_A2A_RUNTIME_TOKEN_FILE: join(directory, "override") },
        ["--runtime-token-file", tokenFile],
      )).toThrow("conflicts with TERMIX_A2A_RUNTIME_TOKEN_FILE");
      expect(() => parseRuntimeEnvironment(base, ["--runtime-token-file"])).toThrow(
        "requires an absolute path",
      );
      expect(() =>
        parseRuntimeEnvironment({ ...base, TERMIX_A2A_RUNTIME_TOKEN: token }, []),
      ).toThrow("either TERMIX_A2A_RUNTIME_TOKEN or TERMIX_A2A_RUNTIME_TOKEN_FILE");

      chmodSync(tokenFile, 0o644);
      expect(() => parseRuntimeEnvironment(base, [])).toThrow(
        "must not be accessible by group or others",
      );
      expect(() => validateProtectedRuntimeTokenFile(tokenFile)).toThrow(
        TermixRuntimeCredentialFileError,
      );

      chmodSync(tokenFile, 0o600);
      const tokenOwner = statSync(tokenFile).uid;
      expect(() => validateProtectedRuntimeTokenFile(tokenFile, {
        expectedOwnerUserId: tokenOwner,
        trustedRoot: directory,
      })).not.toThrow();
      expect(() => validateProtectedRuntimeTokenFile(tokenFile, {
        expectedOwnerUserId: tokenOwner + 1,
        trustedRoot: directory,
      })).toThrow(`must be owned by UID ${tokenOwner + 1}`);
      chmodSync(directory, 0o770);
      expect(() => validateProtectedRuntimeTokenFile(tokenFile, {
        expectedOwnerUserId: tokenOwner,
        trustedRoot: directory,
      })).toThrow("trusted path must not be writable by group or others");
      chmodSync(directory, 0o700);

      const tokenLink = join(directory, "runtime-token-link");
      symlinkSync(tokenFile, tokenLink);
      expect(() => validateProtectedRuntimeTokenFile(tokenLink)).toThrow(
        "must reference a regular file",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates a protected legacy cursor once without overwriting runtime state", () => {
    const directory = mkdtempSync(join(tmpdir(), "positioncrew-runtime-state-"));
    const legacyDirectory = join(directory, "legacy");
    const targetDirectory = join(directory, "target");
    const privateTargetDirectory = join(directory, "private", "target");
    const legacyPath = join(legacyDirectory, "lending.json");
    const targetPath = join(targetDirectory, "runtime.json");
    const state = createTermixRuntimeState("agent-1", "LENDING_RESCUE", NOW);
    mkdirSync(legacyDirectory, { mode: 0o700 });
    mkdirSync(privateTargetDirectory, { recursive: true, mode: 0o700 });
    symlinkSync(join("private", "target"), targetDirectory, "dir");
    writeFileSync(legacyPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    try {
      expect(migrateLegacyRuntimeState(
        legacyPath,
        targetPath,
        "agent-1",
        "LENDING_RESCUE",
      )).toBe("MIGRATED");
      expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual(state);
      expect(statSync(targetPath).mode & 0o077).toBe(0);
      expect(readdirSync(privateTargetDirectory)).toEqual(["runtime.json"]);

      writeFileSync(legacyPath, "{}\n", { mode: 0o600 });
      expect(migrateLegacyRuntimeState(
        legacyPath,
        targetPath,
        "agent-1",
        "LENDING_RESCUE",
      )).toBe("TARGET_PRESENT");
      expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual(state);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("builds the reproducible runtime bundle pinned by the systemd unit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "positioncrew-runtime-bundle-"));
    const firstPath = join(directory, "first.mjs");
    const secondPath = join(directory, "second.mjs");
    try {
      await bundleRuntimeArtifact(firstPath);
      await bundleRuntimeArtifact(secondPath);
      const first = readFileSync(firstPath);
      const second = readFileSync(secondPath);
      expect(first).toEqual(second);
      const unit = readFileSync(
        new URL("../deploy/systemd/positioncrew-runtime@.service", import.meta.url),
        "utf8",
      );
      const pinnedHash = unit.match(
        /echo "([a-f0-9]{64})  \/opt\/positioncrew-runtime\/\.positioncrew-runtime\.mjs\.candidate"/,
      )?.[1];
      expect(pinnedHash).toBe(createHash("sha256").update(first).digest("hex"));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("binds the systemd unit to the built runtime and guarded migration preflights", () => {
    const unit = readFileSync(
      new URL("../deploy/systemd/positioncrew-runtime@.service", import.meta.url),
      "utf8",
    );
    expect(unit).toContain("WorkingDirectory=-/opt/positioncrew-runtime");
    expect(unit).toContain(
      "ExecStart=/usr/bin/env -i TERMIX_A2A_AGENT_ID=${TERMIX_A2A_AGENT_ID} POSITIONCREW_SERVICE=${POSITIONCREW_SERVICE}",
    );
    expect(unit).toContain("/usr/bin/node /opt/positioncrew-runtime/positioncrew-runtime.mjs --runtime-token-file %d/runtime-token");
    expect(unit).not.toContain("BindReadOnlyPaths=/home/crosswind/apps/positioncrew");
    expect(unit).toContain(
      "ConditionFileNotEmpty=/home/crosswind/.local/lib/positioncrew/positioncrew-runtime.mjs",
    );
    expect(unit).toContain("ExecStartPre=+/usr/bin/env -i /usr/bin/install -d -o root -g root -m 0755");
    expect(unit).toContain("ExecStartPre=+/usr/bin/env -i /usr/bin/install -T -o root -g root -m 0500");
    expect(unit).toContain("/usr/bin/sha256sum --check --status");
    expect(unit).toContain("ExecStartPre=+/usr/bin/env -i /usr/bin/chmod 0555");
    expect(unit).toContain("ExecStartPre=+/usr/bin/env -i /usr/bin/mv -fT");
    expect(unit).toContain(
      "EnvironmentFile=/home/crosswind/.config/positioncrew/runtimes/%i.env",
    );
    expect(unit).not.toContain("EnvironmentFile=/etc/positioncrew-runtime/%i.env");
    expect(unit).toContain(
      "UnsetEnvironment=TERMIX_A2A_RUNTIME_TOKEN TERMIX_A2A_RUNTIME_TOKEN_FILE WALLET_KEY PRIVATE_KEY NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT GLIBC_TUNABLES BASH_ENV ENV",
    );
    expect(unit).toContain("--validate-runtime-token-file /etc/positioncrew-runtime/credentials/%i.token");
    expect(unit).toContain("--migrate-runtime-state /run/positioncrew-legacy-state/%i.json");
    expect(unit).toContain("ExecStartPre=!/usr/bin/env -i");
    expect(unit).not.toContain("ExecStartPre=+/usr/bin/node");
    expect(unit).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE");
    expect(unit).toContain("AmbientCapabilities=\n");
    expect(unit).toContain("BindReadOnlyPaths=-/home/crosswind/.local/state/positioncrew");
  });

  it("keeps TermiX order observation separate from Telegram credentials", () => {
    const observer = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-orders.service", import.meta.url),
      "utf8",
    );
    const alertPath = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-order-alert.path", import.meta.url),
      "utf8",
    );
    const alert = readFileSync(
      new URL("../deploy/systemd/positioncrew-termix-order-alert.service", import.meta.url),
      "utf8",
    );
    const observerCredentialOverride = readFileSync(
      new URL(
        "../deploy/systemd/positioncrew-termix-orders.service.d/zzzz-load-credential.conf",
        import.meta.url,
      ),
      "utf8",
    );

    expect(observer).not.toContain("LoadCredential=");
    expect(observer).toContain(
      "TERMIX_SESSION_TOKEN_FILE=%d/session-token",
    );
    expect(observerCredentialOverride).toContain("LoadCredential=\n");
    expect(observerCredentialOverride).toContain(
      "LoadCredential=session-token:/var/lib/positioncrew-termix-session-renew/termix-session.token",
    );
    expect(observerCredentialOverride).toContain("NoNewPrivileges=true");
    expect(observer).toContain("User=positioncrew-orders");
    expect(observer).toContain("StateDirectoryMode=0700");
    expect(observer).toContain("ReadWritePaths=/var/spool/positioncrew-termix-order-outbox");
    expect(observer).not.toContain("CacheDirectory");
    expect(observer).toContain("UMask=0007");
    expect(observer).not.toContain("crosswind.env");
    expect(observer).not.toMatch(/TELEGRAM|WALLET_KEY|PRIVATE_KEY/);
    expect(alertPath).toContain("PathExistsGlob=/var/spool/positioncrew-termix-order-outbox/*.json");
    expect(alert).toContain("EnvironmentFile=/etc/crosswind/crosswind.env");
    expect(alert).toContain("SupplementaryGroups=positioncrew-orders");
    expect(alert).toContain("Restart=on-failure");
    expect(alert).toContain("StartLimitIntervalSec=0");
    expect(alert).toContain("notify-termix-orders.mjs");
    expect(alert).not.toContain("termix-session.token");
    expect(alert).not.toContain("LoadCredential=");
  });

  it("uses only a bearer runtime token for inbox, signal, and reply calls", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/inbox")) return Response.json({ items: [] });
      return Response.json({ id: "reply-1" });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const client = new TermixRuntimeClient(
      "runtime-token-with-no-signing-material",
      "https://platform-backend.prod.termix.live",
      fetchImpl,
    );

    await client.poll(NOW.toISOString());
    await client.signal("conversation-1");
    await client.reply("conversation-1", "Ready.", "reply-key-1");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe(
        "Bearer runtime-token-with-no-signing-material",
      );
      expect(JSON.stringify(init)).not.toMatch(/wallet|private|signature/i);
    }
  });

  it("deduplicates a replayed inbox item across cycles", async () => {
    const token = jwt(Math.floor(NOW.getTime() / 1_000) + 3_600);
    const config = parseRuntimeEnvironment(
      {
        TERMIX_A2A_AGENT_ID: "agent-1",
        TERMIX_A2A_RUNTIME_TOKEN: token,
        POSITIONCREW_SERVICE: "YIELD_OPTIMIZATION",
        TERMIX_A2A_STATE_PATH: "/tmp/positioncrew-runtime-test.json",
      },
      ["--once"],
    );
    const transport = {
      poll: vi.fn(async () => [message()]),
      signal: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    };
    let state = createTermixRuntimeState("agent-1", "YIELD_OPTIMIZATION", NOW);
    state = await runRuntimeCycle(config, state, transport, NOW);
    state = await runRuntimeCycle(
      config,
      state,
      transport,
      new Date("2026-08-13T12:01:00.000Z"),
    );

    expect(transport.poll).toHaveBeenCalledTimes(2);
    expect(transport.reply).toHaveBeenCalledTimes(1);
    expect(state.processedMessageIds).toEqual(["message-1"]);
  });
});
