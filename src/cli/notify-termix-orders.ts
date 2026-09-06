import { readdir, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const AlertSchema = z.object({
  schemaVersion: z.literal("positioncrew.termix-order-alert.v1"),
  observedAt: z.string().datetime(),
  agentId: z.string().min(1),
  order: z.object({
    orderId: z.string().min(1),
    status: z.string().min(1),
    deliveryDueAt: z.string().datetime().nullable(),
    availableActions: z.record(z.string(), z.unknown()),
  }),
});

export interface TelegramNotificationOptions {
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
}

const TelegramAcceptanceSchema = z.object({
  ok: z.literal(true),
  result: z.object({ message_id: z.number().int().positive() }),
});

export async function sendTelegram(message: string, options: TelegramNotificationOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const dedicatedToken = env.POSITIONCREW_TELEGRAM_BOT_TOKEN?.trim();
  const dedicatedChatId = env.POSITIONCREW_TELEGRAM_CHAT_ID?.trim();
  const hasDedicatedPair = Boolean(dedicatedToken && dedicatedChatId);
  const token = hasDedicatedPair ? dedicatedToken : env.CROSSWIND_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = hasDedicatedPair ? dedicatedChatId : env.CROSSWIND_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error("Telegram alert token or chat ID is not configured.");

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new Error("Telegram alert transport failed or timed out.");
  }
  if (!response.ok) throw new Error(`Telegram alert HTTP request failed with status ${response.status}.`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Telegram alert response could not be read as JSON.");
  }
  if (!TelegramAcceptanceSchema.safeParse(body).success) {
    throw new Error("Telegram did not confirm alert acceptance.");
  }
}

export async function notifyTermixOrderAlerts(
  options: TelegramNotificationOptions & { outbox?: string } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const outbox = resolve(options.outbox?.trim() || env.TERMIX_ORDER_OUTBOX_PATH?.trim() || "/var/lib/positioncrew-termix-orders/outbox");
  const names = (await readdir(outbox)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  if (!names.length) return;
  const alerts = await Promise.all(names.map(async (name) => ({
    name,
    alert: AlertSchema.parse(JSON.parse(await readFile(resolve(outbox, name), "utf8"))),
  })));
  const batch = alerts.slice(0, 12);
  const lines = batch.map(({ alert }) =>
    `${alert.order.orderId}: ${alert.order.status}, due ${alert.order.deliveryDueAt ?? "not reported"}`
  );
  const overflow = alerts.length > batch.length ? `\n+${alerts.length - batch.length} more queued for the next alert.` : "";
  await sendTelegram(
    `PositionCrew has ${alerts.length} queued TermiX order transition(s); this alert covers ${batch.length}:\n${lines.join("\n")}${overflow}\nNo transaction was performed automatically.`,
    options,
  );
  for (const { name } of batch) await unlink(resolve(outbox, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  notifyTermixOrderAlerts().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "termix.order-alert.failed",
      error: error instanceof Error ? error.message : "Unknown order-alert failure",
    })}\n`);
    process.exitCode = 1;
  });
}
