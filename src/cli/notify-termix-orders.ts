import { spawn } from "node:child_process";
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

async function sendTelegram(message: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "/usr/bin/npm",
      ["run", "alert:telegram", "--", "POSITIONCREW_ORDER", message],
      { cwd: "/opt/crosswind", env: process.env, stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Telegram notifier exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

async function main(): Promise<void> {
  const outbox = resolve(process.env.TERMIX_ORDER_OUTBOX_PATH?.trim() || "/var/lib/positioncrew-termix-orders/outbox");
  const names = (await readdir(outbox)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  if (!names.length) return;
  const alerts = await Promise.all(names.map(async (name) => ({
    name,
    alert: AlertSchema.parse(JSON.parse(await readFile(resolve(outbox, name), "utf8"))),
  })));
  const lines = alerts.slice(0, 12).map(({ alert }) =>
    `${alert.order.orderId}: ${alert.order.status}, due ${alert.order.deliveryDueAt ?? "not reported"}`
  );
  const overflow = alerts.length > lines.length ? `\n+${alerts.length - lines.length} more queued order transitions.` : "";
  await sendTelegram(
    `PositionCrew has ${alerts.length} TermiX order transition(s) requiring attention:\n${lines.join("\n")}${overflow}\nNo transaction was performed automatically.`,
  );
  for (const { name } of alerts) await unlink(resolve(outbox, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "termix.order-alert.failed",
      error: error instanceof Error ? error.message : "Unknown order-alert failure",
    })}\n`);
    process.exitCode = 1;
  });
}
