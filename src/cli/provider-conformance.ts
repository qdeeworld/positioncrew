import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  buildProviderConformanceBundle,
  verifyProviderConformanceBundle,
} from "../marketplace/provider-conformance-bundle.js";
import {
  runProviderContractPreflight,
  verifyProviderContractPreflightResult,
} from "../marketplace/provider-compatibility.js";

const FILE_NAMES = {
  LENDING_RESCUE: "lending-rescue",
  LP_REBALANCE: "lp-rebalance",
  YIELD_OPTIMIZATION: "yield-optimization",
  BOUNDED_GRID: "bounded-grid",
} as const;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  const source = await readFile(path, "utf8");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

async function exportKit(outputArgument?: string): Promise<void> {
  const outputDirectory = resolve(outputArgument ?? "positioncrew-provider-conformance-kit");
  const packetDirectory = join(outputDirectory, "packets");
  const resultDirectory = join(outputDirectory, "results");
  await mkdir(outputDirectory, { recursive: false });
  await mkdir(packetDirectory, { recursive: false });
  await mkdir(resultDirectory, { recursive: false });

  const bundle = await buildProviderConformanceBundle();
  const files = new Map<string, string>();
  files.set("bundle.json", json(bundle));
  for (const service of bundle.services) {
    const name = FILE_NAMES[service];
    files.set(`packets/${name}.json`, json(bundle.packets[service]));
    files.set(`results/${name}.json`, json(bundle.results[service]));
  }
  files.set("README.txt", [
    "PositionCrew Provider Conformance Kit",
    "",
    "1. Replace one packet's manifest and deliverables with the external provider's values.",
    "2. Run: npm run provider:check -- <packet.json> <result.json>",
    "3. A CONTRACT_PASS proves packet conformance only. Read every NOT_PROVEN check.",
    "4. Run: npm run provider:verify-result -- <result.json> to detect report tampering.",
    "",
    bundle.claimBoundary,
    "",
  ].join("\n"));

  for (const [relativePath, body] of files) {
    await writeFile(join(outputDirectory, relativePath), body, { flag: "wx" });
  }
  const checksums = [...files.entries()]
    .map(([relativePath, body]) => `${sha256(body)}  ${relativePath}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\n") + "\n";
  await writeFile(join(outputDirectory, "SHA256SUMS"), checksums, { flag: "wx" });
  process.stdout.write(json({
    status: "EXPORTED",
    outputDirectory,
    bundleHash: bundle.bundleHash,
    services: bundle.services,
    fileCount: files.size + 1,
  }));
}

async function checkPacket(packetPath?: string, resultPath?: string): Promise<void> {
  if (!packetPath) throw new Error("check requires a provider packet JSON path");
  const result = runProviderContractPreflight(await readJson(resolve(packetPath)));
  if (resultPath) {
    const outputPath = resolve(resultPath);
    await writeFile(outputPath, json(result), { flag: "wx" });
    process.stdout.write(json({ status: result.outcome, outputPath, resultHash: result.resultHash }));
  } else {
    process.stdout.write(json(result));
  }
  if (result.outcome !== "CONTRACT_PASS") process.exitCode = 1;
}

async function verifyResult(resultPath?: string): Promise<void> {
  if (!resultPath) throw new Error("verify-result requires a preflight result JSON path");
  const valid = verifyProviderContractPreflightResult(await readJson(resolve(resultPath)));
  process.stdout.write(json({
    status: valid ? "VALID" : "INVALID",
    file: basename(resultPath),
  }));
  if (!valid) process.exitCode = 1;
}

async function verifyBundle(bundlePath?: string): Promise<void> {
  if (!bundlePath) throw new Error("verify-bundle requires a bundle JSON path");
  const valid = verifyProviderConformanceBundle(await readJson(resolve(bundlePath)));
  process.stdout.write(json({
    status: valid ? "VALID" : "INVALID",
    file: basename(bundlePath),
  }));
  if (!valid) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, argument, secondArgument] = process.argv.slice(2);
  if (command === "export") return exportKit(argument);
  if (command === "check") return checkPacket(argument, secondArgument);
  if (command === "verify-result") return verifyResult(argument);
  if (command === "verify-bundle") return verifyBundle(argument);
  throw new Error("Usage: provider-conformance <export [directory] | check packet.json [result.json] | verify-result result.json | verify-bundle bundle.json>");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
