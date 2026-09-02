import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const distRoot = resolve(root, "dist");
const clientRoot = resolve(distRoot, "client");
const serverRoot = resolve(distRoot, "server");
const drizzleRoot = resolve(root, "drizzle");
const migrationsRoot = resolve(root, "migrations");
const hostingManifestPath = resolve(root, ".openai", "hosting.json");
const hostingManifest = JSON.parse(await readFile(hostingManifestPath, "utf8"));

if (hostingManifest.d1 !== "DB") {
  throw new Error("Expected the PositionCrew hosting manifest to expose the DB D1 binding");
}

const migrationEntries = await readdir(migrationsRoot, { withFileTypes: true });
const migrationFiles = migrationEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();
if (
  migrationFiles.length === 0 ||
  migrationFiles.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))
) {
  throw new Error("Expected one or more ordered SQL migrations in migrations/");
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(clientRoot, { recursive: true });
await mkdir(serverRoot, { recursive: true });
await mkdir(resolve(distRoot, ".openai"), { recursive: true });

await cp(resolve(root, "dist-web"), clientRoot, { recursive: true });
await cp(
  hostingManifestPath,
  resolve(distRoot, ".openai", "hosting.json"),
);
await cp(
  drizzleRoot,
  resolve(distRoot, ".openai", "drizzle"),
  { recursive: true },
);
await cp(
  migrationsRoot,
  resolve(distRoot, ".openai", "migrations"),
  { recursive: true },
);

await build({
  entryPoints: [resolve(root, "worker", "index.ts")],
  outfile: resolve(serverRoot, "index.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  conditions: ["workerd", "browser", "import", "default"],
  external: ["node:buffer", "node:crypto"],
  logLevel: "info",
});

const workerConfig = {
  name: "positioncrew-marketplace",
  main: "index.js",
  compatibility_date: "2026-08-12",
  compatibility_flags: ["nodejs_compat"],
  no_bundle: true,
  assets: {
    directory: "../client",
    binding: "ASSETS",
    run_worker_first: true,
    not_found_handling: "single-page-application",
  },
  observability: { enabled: true },
};

// Wrangler requires an identifier for local D1 state. This sentinel is not a
// production resource ID, and the local config is used only with --local.
const localWorkerConfig = {
  ...workerConfig,
  name: "positioncrew-marketplace-local",
  d1_databases: [
    {
      binding: hostingManifest.d1,
      database_name: "positioncrew-marketplace-local",
      database_id: "00000000-0000-0000-0000-000000000001",
      // Exercise the same migration set Sites applies in production.
      migrations_dir: "../.openai/drizzle",
    },
  ],
};

await Promise.all([
  writeFile(
    resolve(serverRoot, "wrangler.json"),
    `${JSON.stringify(workerConfig, null, 2)}\n`,
  ),
  writeFile(
    resolve(serverRoot, "wrangler.local.json"),
    `${JSON.stringify(localWorkerConfig, null, 2)}\n`,
  ),
]);
