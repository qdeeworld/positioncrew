import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const config = resolve(root, "dist/server/wrangler.local.json");
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const persistence = await mkdtemp(join(tmpdir(), "positioncrew-altana-d1-"));

function execute(sql, json = false) {
  const result = spawnSync(wrangler, [
    "d1", "execute", "DB", "--local", "--config", config,
    "--persist-to", persistence, "--command", sql,
    ...(json ? ["--json"] : []),
  ], { cwd: root, encoding: "utf8" });
  return result;
}

try {
  execFileSync(wrangler, [
    "d1", "migrations", "apply", "DB", "--local", "--config", config,
    "--persist-to", persistence,
  ], { cwd: root, stdio: "ignore" });

  const activationId = "10000000-0000-4000-8000-000000000001";
  const insert = execute(`INSERT INTO altana_venus_activations (
    activation_id, idempotency_key, source_hire_id, source_receipt_id,
    client_key_hash, day_bucket, state, created_at
  ) VALUES (
    '${activationId}', 'activation-state-machine-test',
    '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003',
    'sha256:test-client', '2026-09-02', 'CREATED', '2026-09-02T00:00:00.000Z'
  )`);
  assert.equal(insert.status, 0, `${insert.stderr}${insert.stdout}`);

  for (const [from, to] of [
    ["CREATED", "RUNNING"],
    ["RUNNING", "CHAIN_SUBMITTED"],
    ["CHAIN_SUBMITTED", "CHAIN_CONFIRMED"],
    ["CHAIN_CONFIRMED", "CONFIRMED"],
    ["CONFIRMED", "COMPLETED"],
  ]) {
    const transition = execute(
      `UPDATE altana_venus_activations SET state = '${to}' WHERE activation_id = '${activationId}' AND state = '${from}'`,
    );
    assert.equal(transition.status, 0, `${from} -> ${to}: ${transition.stderr}${transition.stdout}`);
  }

  const query = execute(
    `SELECT state FROM altana_venus_activations WHERE activation_id = '${activationId}'`,
    true,
  );
  assert.equal(query.status, 0, `${query.stderr}${query.stdout}`);
  const envelopes = JSON.parse(query.stdout);
  assert.equal(envelopes[0].results[0].state, "COMPLETED");

  const invalid = execute(
    `UPDATE altana_venus_activations SET state = 'UNKNOWN' WHERE activation_id = '${activationId}'`,
  );
  assert.notEqual(invalid.status, 0, "D1 accepted an unknown activation state");
  assert.match(`${invalid.stderr}${invalid.stdout}`, /constraint|CHECK/iu);

  console.log("D1 Altana activation state machine reached COMPLETED and rejected UNKNOWN");
} finally {
  await rm(persistence, { recursive: true, force: true });
}
