import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet } from "ethers";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  VENUS_TESTNET_NATIVE_SUPPLY,
  VenusTestnetNativeSupplyIntentSchema,
  VenusTestnetNativeSupplySubmissionSchema,
  verifyVenusTestnetNativeSupplyEvidence,
} from "../commerce/venus-testnet-native-supply-evidence.js";
import {
  broadcastIdenticalVenusSubmission,
  createViemVenusRpcClient,
  prepareVenusTestnetNativeSupply,
  reconcileVenusTestnetNativeSupply,
  signVenusTestnetNativeSupply,
  verifyVenusTestnetNativeSupplyOnchain,
} from "../commerce/venus-testnet-native-supply-operator.js";

const DEFAULT_TESTNET_RPC = "https://bsc-testnet-dataseed.bnbchain.org";
const DEFAULT_MAINNET_RPC = "https://bsc-dataseed-public.bnbchain.org";
const KEYSTORE_ENV = "POSITIONCREW_VENUS_TESTNET_KEYSTORE_FILE";
const PASSWORD_ENV = "POSITIONCREW_VENUS_TESTNET_PASSWORD_FILE";

function parsedArguments(argv: string[]): { command: string; values: Map<string, string>; flags: Set<string> } {
  const [command, ...rest] = argv;
  if (!command || !["prepare", "broadcast", "reconcile", "verify"].includes(command)) {
    throw new Error("Usage: evidence:venus-testnet-supply -- <prepare|broadcast|reconcile|verify> [flags]");
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name?.startsWith("--")) throw new Error(`Unexpected argument: ${String(name)}`);
    if (values.has(name) || flags.has(name)) throw new Error(`Duplicate argument: ${name}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(name);
    } else {
      values.set(name, next);
      index += 1;
    }
  }
  if (values.has("--private-key") || flags.has("--private-key")) {
    throw new Error("Raw private-key arguments are forbidden; use the fixed encrypted-keystore file variables");
  }
  return { command, values, flags };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

function requireOnly(
  args: { values: Map<string, string>; flags: Set<string> },
  allowedValues: readonly string[],
  allowedFlags: readonly string[],
): void {
  for (const name of args.values.keys()) if (!allowedValues.includes(name)) throw new Error(`Unsupported argument ${name}`);
  for (const name of args.flags) if (!allowedFlags.includes(name)) throw new Error(`Unsupported flag ${name}`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function atomicWriteNew0600(pathInput: string, value: unknown): Promise<string> {
  const path = resolve(pathInput);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await link(temporary, path);
    await chmod(path, 0o600);
    return path;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function requirePrivateFile(pathInput: string, label: string): Promise<string> {
  if (!isAbsolute(pathInput)) throw new Error(`${label} path must be absolute`);
  const path = resolve(pathInput);
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if ((details.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600`);
  if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  return path;
}

function clients() {
  return {
    testnet: createViemVenusRpcClient("testnet", process.env.BSC_TESTNET_RPC_URL ?? DEFAULT_TESTNET_RPC),
    mainnet: createViemVenusRpcClient("mainnet", process.env.BSC_MAINNET_RPC_URL ?? DEFAULT_MAINNET_RPC),
  };
}

async function encryptedKeystoreSigner() {
  const keystoreInput = process.env[KEYSTORE_ENV];
  const passwordInput = process.env[PASSWORD_ENV];
  if (!keystoreInput || !passwordInput) {
    throw new Error(`${KEYSTORE_ENV} and ${PASSWORD_ENV} must name encrypted-keystore and password files`);
  }
  const keystorePath = await requirePrivateFile(keystoreInput, "Keystore");
  const passwordPath = await requirePrivateFile(passwordInput, "Password");
  const [encryptedJson, passwordFile] = await Promise.all([
    readFile(keystorePath, "utf8"),
    readFile(passwordPath, "utf8"),
  ]);
  const password = passwordFile.replace(/\r?\n$/, "");
  if (password.length === 0) throw new Error("Password file is empty");
  let wallet: Awaited<ReturnType<typeof Wallet.fromEncryptedJson>>;
  try {
    wallet = await Wallet.fromEncryptedJson(encryptedJson, password);
  } catch {
    throw new Error("Encrypted keystore could not be decrypted");
  }
  if (getAddress(wallet.address) !== VENUS_TESTNET_NATIVE_SUPPLY.actor) {
    throw new Error("Encrypted keystore does not control the dedicated testnet actor");
  }
  const account = privateKeyToAccount(wallet.privateKey as Hex);
  return {
    address: account.address,
    signLegacyTransaction: (transaction: {
      chainId: 97;
      to: `0x${string}`;
      data: Hex;
      value: bigint;
      nonce: number;
      gas: bigint;
      gasPrice: bigint;
    }) => account.signTransaction({ ...transaction, type: "legacy" }),
  };
}

async function prepare(args: ReturnType<typeof parsedArguments>): Promise<void> {
  requireOnly(args, ["--from", "--amount-tbnb", "--intent-out"], []);
  const output = required(args.values, "--intent-out");
  const intent = await prepareVenusTestnetNativeSupply({
    actor: required(args.values, "--from"),
    amountTbnb: required(args.values, "--amount-tbnb"),
  }, clients());
  const path = await atomicWriteNew0600(output, intent);
  process.stdout.write(`${JSON.stringify({ state: "PREPARED", intentHash: intent.intentHash, expiresAt: intent.expiresAt, path })}\n`);
}

async function broadcast(args: ReturnType<typeof parsedArguments>): Promise<void> {
  requireOnly(
    args,
    ["--intent", "--expected-intent-hash", "--confirm-chain-id", "--confirm-vbnb", "--submission", "--submission-out"],
    ["--broadcast", "--identical-raw-retry"],
  );
  if (!args.flags.has("--broadcast")) throw new Error("Broadcast requires the explicit --broadcast flag");
  const dependencies = clients();
  const existingSubmissionPath = args.values.get("--submission");
  if (existingSubmissionPath) {
    if (!args.flags.has("--identical-raw-retry")) throw new Error("Existing submissions require --identical-raw-retry");
    if (args.values.has("--intent") || args.values.has("--submission-out")) throw new Error("Identical retry accepts only the existing submission");
    const submission = VenusTestnetNativeSupplySubmissionSchema.parse(await readJson(existingSubmissionPath));
    const transactionHash = await broadcastIdenticalVenusSubmission(submission, dependencies);
    process.stdout.write(`${JSON.stringify({ state: "IDENTICAL_RAW_TRANSACTION_SENT", transactionHash })}\n`);
    return;
  }
  if (args.flags.has("--identical-raw-retry")) throw new Error("--identical-raw-retry requires --submission");
  if (required(args.values, "--confirm-chain-id") !== "97") throw new Error("--confirm-chain-id must be exactly 97");
  if (getAddress(required(args.values, "--confirm-vbnb")) !== VENUS_TESTNET_NATIVE_SUPPLY.vBnb) {
    throw new Error("--confirm-vbnb does not match the pinned Venus BSC Testnet market");
  }
  const intent = VenusTestnetNativeSupplyIntentSchema.parse(await readJson(required(args.values, "--intent")));
  if (required(args.values, "--expected-intent-hash") !== intent.intentHash) throw new Error("Expected intent commitment does not match");
  const signer = await encryptedKeystoreSigner();
  const submission = await signVenusTestnetNativeSupply(intent, signer, dependencies);
  const submissionPath = await atomicWriteNew0600(
    args.values.get("--submission-out") ?? ".state/venus-testnet-native-supply-submission.json",
    submission,
  );
  const transactionHash = await broadcastIdenticalVenusSubmission(submission, dependencies);
  process.stdout.write(`${JSON.stringify({ state: "RAW_TRANSACTION_SENT", transactionHash, submissionPath })}\n`);
}

async function reconcile(args: ReturnType<typeof parsedArguments>): Promise<void> {
  requireOnly(args, ["--submission", "--evidence-out"], []);
  const submission = VenusTestnetNativeSupplySubmissionSchema.parse(await readJson(required(args.values, "--submission")));
  const evidence = await reconcileVenusTestnetNativeSupply(submission, clients().testnet);
  const path = await atomicWriteNew0600(required(args.values, "--evidence-out"), evidence);
  process.stdout.write(`${JSON.stringify({ state: "RECONCILED", transactionHash: evidence.transaction.hash, artifactHash: evidence.commitments.artifactHash, path })}\n`);
}

async function verify(args: ReturnType<typeof parsedArguments>): Promise<void> {
  requireOnly(args, ["--evidence"], []);
  const evidence = verifyVenusTestnetNativeSupplyEvidence(await readJson(required(args.values, "--evidence")));
  await verifyVenusTestnetNativeSupplyOnchain(evidence, clients().testnet);
  process.stdout.write(`${JSON.stringify({ state: "VERIFIED", transactionHash: evidence.transaction.hash, artifactHash: evidence.commitments.artifactHash })}\n`);
}

export async function runVenusTestnetNativeSupplyCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parsedArguments(argv);
  if (args.command === "prepare") await prepare(args);
  else if (args.command === "broadcast") await broadcast(args);
  else if (args.command === "reconcile") await reconcile(args);
  else await verify(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runVenusTestnetNativeSupplyCli();
}
