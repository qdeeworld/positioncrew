import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyTermixOrderAlerts,
  sendTelegram,
  type TelegramNotificationOptions,
} from "../src/cli/notify-termix-orders.js";

const configuredEnv = {
  POSITIONCREW_TELEGRAM_BOT_TOKEN: "test-dedicated-token",
  POSITIONCREW_TELEGRAM_CHAT_ID: "test-dedicated-chat",
  CROSSWIND_TELEGRAM_BOT_TOKEN: "test-legacy-token",
  CROSSWIND_TELEGRAM_CHAT_ID: "test-legacy-chat",
};
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function telegramResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeOutbox(count: number): Promise<{ outbox: string; names: string[] }> {
  const outbox = await mkdtemp(join(tmpdir(), "positioncrew-order-notifier-"));
  directories.push(outbox);
  const names = Array.from({ length: count }, (_, index) => `${index.toString(16).padStart(64, "0")}.json`);
  await Promise.all(names.map((name, index) => writeFile(join(outbox, name), JSON.stringify({
    schemaVersion: "positioncrew.termix-order-alert.v1",
    observedAt: "2026-09-06T00:00:00.000Z",
    agentId: "test-agent",
    order: {
      orderId: `order-${index}`,
      status: "CREATED",
      deliveryDueAt: null,
      availableActions: {},
    },
  }))));
  return { outbox, names };
}

describe("TermiX order notifier", () => {
  const failures: Array<{
    name: string;
    env: NonNullable<TelegramNotificationOptions["env"]>;
    response: () => Promise<Response>;
    error: string;
    attempts: number;
  }> = [
    {
      name: "missing Telegram configuration",
      env: {},
      response: async () => telegramResponse({ ok: true, result: { message_id: 1 } }),
      error: "Telegram alert token or chat ID is not configured.",
      attempts: 0,
    },
    {
      name: "missing chat ID",
      env: { POSITIONCREW_TELEGRAM_BOT_TOKEN: configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN },
      response: async () => telegramResponse({ ok: true, result: { message_id: 1 } }),
      error: "Telegram alert token or chat ID is not configured.",
      attempts: 0,
    },
    {
      name: "missing token",
      env: { POSITIONCREW_TELEGRAM_CHAT_ID: configuredEnv.POSITIONCREW_TELEGRAM_CHAT_ID },
      response: async () => telegramResponse({ ok: true, result: { message_id: 1 } }),
      error: "Telegram alert token or chat ID is not configured.",
      attempts: 0,
    },
    {
      name: "dedicated token and legacy chat without a complete pair",
      env: {
        POSITIONCREW_TELEGRAM_BOT_TOKEN: configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN,
        CROSSWIND_TELEGRAM_BOT_TOKEN: " ",
        CROSSWIND_TELEGRAM_CHAT_ID: configuredEnv.CROSSWIND_TELEGRAM_CHAT_ID,
      },
      response: async () => telegramResponse({ ok: true, result: { message_id: 1 } }),
      error: "Telegram alert token or chat ID is not configured.",
      attempts: 0,
    },
    {
      name: "legacy token and dedicated chat without a complete pair",
      env: {
        POSITIONCREW_TELEGRAM_CHAT_ID: configuredEnv.POSITIONCREW_TELEGRAM_CHAT_ID,
        CROSSWIND_TELEGRAM_BOT_TOKEN: configuredEnv.CROSSWIND_TELEGRAM_BOT_TOKEN,
        CROSSWIND_TELEGRAM_CHAT_ID: " ",
      },
      response: async () => telegramResponse({ ok: true, result: { message_id: 1 } }),
      error: "Telegram alert token or chat ID is not configured.",
      attempts: 0,
    },
    {
      name: "transport error containing a private URL",
      env: configuredEnv,
      response: async () => {
        throw new Error(`Transport failed at https://api.telegram.org/bot${configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN}/sendMessage`);
      },
      error: "Telegram alert transport failed or timed out.",
      attempts: 1,
    },
    {
      name: "HTTP error despite an acceptance-shaped body",
      env: configuredEnv,
      response: async () => telegramResponse({
        ok: true,
        result: { message_id: 1 },
        description: configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN,
      }, 503),
      error: "Telegram alert HTTP request failed with status 503.",
      attempts: 1,
    },
    {
      name: "Telegram ok false",
      env: configuredEnv,
      response: async () => telegramResponse({
        ok: false,
        description: configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN,
      }),
      error: "Telegram did not confirm alert acceptance.",
      attempts: 1,
    },
    {
      name: "malformed response JSON",
      env: configuredEnv,
      response: async () => new Response(configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN),
      error: "Telegram alert response could not be read as JSON.",
      attempts: 1,
    },
    {
      name: "missing acceptance message ID",
      env: configuredEnv,
      response: async () => telegramResponse({ ok: true, result: {} }),
      error: "Telegram did not confirm alert acceptance.",
      attempts: 1,
    },
    {
      name: "nonpositive acceptance message ID",
      env: configuredEnv,
      response: async () => telegramResponse({ ok: true, result: { message_id: 0 } }),
      error: "Telegram did not confirm alert acceptance.",
      attempts: 1,
    },
    {
      name: "fractional acceptance message ID",
      env: configuredEnv,
      response: async () => telegramResponse({ ok: true, result: { message_id: 1.5 } }),
      error: "Telegram did not confirm alert acceptance.",
      attempts: 1,
    },
  ];

  it.each(failures)("retains queued alerts after $name without leaking raw errors", async (failure) => {
    const { outbox, names } = await makeOutbox(2);
    const fetchImpl = vi.fn(failure.response);

    await expect(notifyTermixOrderAlerts({
      outbox,
      env: failure.env,
      fetchImpl,
    })).rejects.toEqual(new Error(failure.error));

    expect((await readdir(outbox)).sort()).toEqual(names);
    expect(fetchImpl).toHaveBeenCalledTimes(failure.attempts);
  });

  it("posts one bounded plain-text batch and deletes only the first 12 after confirmed acceptance", async () => {
    const { outbox, names } = await makeOutbox(14);
    await writeFile(join(outbox, "unrelated.json"), "not an order alert");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      telegramResponse({ ok: true, result: { message_id: 42 }, extra: "allowed Telegram metadata" })
    );

    await notifyTermixOrderAlerts({ outbox, env: configuredEnv, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/bottest-dedicated-token/sendMessage");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      redirect: "error",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeout).toHaveBeenCalledWith(8_000);
    const lines = Array.from({ length: 12 }, (_, index) => `order-${index}: CREATED, due not reported`);
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: "test-dedicated-chat",
      text: `PositionCrew has 14 queued TermiX order transition(s); this alert covers 12:\n${lines.join("\n")}\n+2 more queued for the next alert.\nNo transaction was performed automatically.`,
    });
    expect((await readdir(outbox)).sort()).toEqual([...names.slice(12), "unrelated.json"].sort());
  });

  it.each([
    {
      name: "the complete dedicated pair takes precedence",
      dedicatedToken: " test-dedicated-token ",
      dedicatedChatId: " test-dedicated-chat ",
      expectedToken: "test-dedicated-token",
      expectedChatId: "test-dedicated-chat",
    },
    {
      name: "only a dedicated token falls back to both legacy values",
      dedicatedToken: "test-dedicated-token",
      dedicatedChatId: "",
      expectedToken: "test-legacy-token",
      expectedChatId: "test-legacy-chat",
    },
    {
      name: "only a dedicated chat falls back to both legacy values",
      dedicatedToken: " ",
      dedicatedChatId: "test-dedicated-chat",
      expectedToken: "test-legacy-token",
      expectedChatId: "test-legacy-chat",
    },
    {
      name: "blank dedicated values fall back to both legacy values",
      dedicatedToken: " ",
      dedicatedChatId: "",
      expectedToken: "test-legacy-token",
      expectedChatId: "test-legacy-chat",
    },
  ])("uses the configured outbox and a complete credential pair: $name", async (credentials) => {
    const { outbox } = await makeOutbox(1);
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      telegramResponse({ ok: true, result: { message_id: 1 } })
    );
    await notifyTermixOrderAlerts({
      env: {
        ...configuredEnv,
        POSITIONCREW_TELEGRAM_BOT_TOKEN: credentials.dedicatedToken,
        POSITIONCREW_TELEGRAM_CHAT_ID: credentials.dedicatedChatId,
        TERMIX_ORDER_OUTBOX_PATH: outbox,
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/bot" + credentials.expectedToken + "/sendMessage");
    expect(JSON.parse(String(init?.body)).chat_id).toBe(credentials.expectedChatId);
    expect(await readdir(outbox)).toEqual([]);
  });

  it("does not send anything for an empty outbox", async () => {
    const { outbox } = await makeOutbox(0);
    const fetchImpl = vi.fn(async () => telegramResponse({ ok: true, result: { message_id: 1 } }));
    await notifyTermixOrderAlerts({ outbox, env: {}, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes a response-body read failure without retaining the private cause", async () => {
    const response = telegramResponse({ ok: true, result: { message_id: 1 } });
    vi.spyOn(response, "json").mockRejectedValue(new Error(configuredEnv.POSITIONCREW_TELEGRAM_BOT_TOKEN));
    const fetchImpl = vi.fn(async () => response);

    await expect(sendTelegram("test message", { env: configuredEnv, fetchImpl }))
      .rejects.toEqual(new Error("Telegram alert response could not be read as JSON."));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
