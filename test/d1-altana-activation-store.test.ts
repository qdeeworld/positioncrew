import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AltanaVenusActivationCapacityExceeded,
  AltanaVenusActivationStore,
} from "../src/commerce/d1-altana-activation-store.js";
import type { D1Database } from "../src/commerce/d1-marketplace-store.js";

function database(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0005_altana_venus_activations.sql", import.meta.url), "utf8"));
  return {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const statement = sqlite.prepare(sql);
          return {
            async first<T>() {
              return (statement.get(...values) as T | undefined) ?? null;
            },
            async run() {
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  } as D1Database;
}

function creation(index: number, createdAt: string) {
  const digit = String(index);
  return {
    activationId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
    idempotencyKey: `altana-state-test-${digit.repeat(16)}`,
    sourceHireId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-9${digit.repeat(3)}-${digit.repeat(12)}`,
    sourceReceiptId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-a${digit.repeat(3)}-${digit.repeat(12)}`,
    clientKeyHash: `sha256:client-${digit}`,
    dayBucket: "2026-09-02",
    createdAt,
    globalDailyLimit: 8,
  };
}

describe("Altana activation D1 leases", () => {
  it("terminally expires CREATED work before a delayed claim can broadcast", async () => {
    const store = new AltanaVenusActivationStore(database());
    const created = await store.create(creation(1, "2026-09-02T00:00:00.000Z"));
    const claim = await store.claim(created.activationId, "2026-09-02T00:05:01.000Z");
    expect(claim.claimed).toBe(false);
    expect(claim.activation).toMatchObject({
      state: "FAILED",
      error: { code: "ACTIVATION_START_EXPIRED" },
    });
  });

  it("blocks a recent broadcast but releases admission after the delegated spend window", async () => {
    const store = new AltanaVenusActivationStore(database());
    const first = await store.create(creation(1, "2026-09-02T00:00:00.000Z"));
    expect((await store.claim(first.activationId, "2026-09-02T00:00:01.000Z")).claimed).toBe(true);
    await store.persistChainSubmitted({
      activationId: first.activationId,
      executionJson: JSON.stringify({ transactionHash: `0x${"1".repeat(64)}` }),
      executionHash: `sha256:${"2".repeat(64)}`,
    });

    await expect(store.create(creation(2, "2026-09-02T00:01:00.000Z")))
      .rejects.toBeInstanceOf(AltanaVenusActivationCapacityExceeded);
    await expect(store.create(creation(2, "2026-09-02T00:01:07.000Z")))
      .resolves.toMatchObject({ state: "CREATED" });
  });

  it("uses startedAt for a RUNNING lease and eventually releases abandoned work", async () => {
    const store = new AltanaVenusActivationStore(database());
    const first = await store.create(creation(1, "2026-09-02T00:00:00.000Z"));
    expect((await store.claim(first.activationId, "2026-09-02T00:04:59.000Z")).claimed).toBe(true);

    await expect(store.create(creation(2, "2026-09-02T00:05:30.000Z")))
      .rejects.toBeInstanceOf(AltanaVenusActivationCapacityExceeded);
    await expect(store.create(creation(2, "2026-09-02T00:10:00.000Z")))
      .resolves.toMatchObject({ state: "CREATED" });
  });
});
