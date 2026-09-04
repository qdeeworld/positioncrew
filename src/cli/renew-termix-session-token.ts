import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { resolveRuntimeTokenExpiry } from "../commerce/aacp-runtime.js";

export const TERMIX_SESSION_EXPECTED_WALLET = getAddress(
  "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9",
);
export const TERMIX_SESSION_REQUIRED_AGENT_ID = "cmt4dzxvcli4tw70125nd5ra8";
export const TERMIX_SESSION_RENEWAL_WINDOW_MS = 6 * 60 * 60 * 1_000;
export const TERMIX_SESSION_MIN_ISSUED_LIFETIME_MS = 6 * 60 * 60 * 1_000;

export const TERMIX_SESSION_RENEWAL_ERROR_CODES = [
  "OWNED_AGENT_UNAUTHORIZED",
  "OWNED_AGENT_FORBIDDEN",
  "OWNED_AGENT_INVALID_RESPONSE",
  "OWNED_AGENT_REQUIRED_AGENT_MISSING",
  "OWNED_AGENT_TRANSPORT_FAILED",
  "OWNED_AGENT_SERVER_ERROR",
  "OWNED_AGENT_UNEXPECTED_STATUS",
  "INTERNAL_ERROR",
] as const;

export type TermixSessionRenewalErrorCode =
  (typeof TERMIX_SESSION_RENEWAL_ERROR_CODES)[number];

class TermixSessionRenewalError extends Error {
  constructor(
    readonly code: TermixSessionRenewalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TermixSessionRenewalError";
  }
}

const NonceResponseSchema = z.object({
  nonce: z.string().min(1).max(1_024),
  message: z.string().min(1).max(8_192),
});

const WalletAuthResponseSchema = z.object({
  accessToken: z.string().min(16).max(4_096),
});

const OwnedAgentsResponseSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1) }).passthrough()),
}).passthrough();

export interface SessionRenewalEnvironment {
  ownerKeyFile: string;
  tokenPath: string;
  baseUrl: string;
}

type SessionAccount = {
  address: `0x${string}`;
  signMessage: (args: { message: string }) => Promise<`0x${string}`>;
};

type AtomicSecretHandle = {
  writeFile?: (data: string, encoding: "utf8") => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

export type AtomicSecretOperations = {
  open: (path: string, flags: number, mode?: number) => Promise<AtomicSecretHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

interface SessionRenewalDependencies {
  fetchImpl?: typeof fetch;
  now?: Date;
  readOwnerKey?: (path: string) => Promise<Hex>;
  accountFromPrivateKey?: (key: Hex) => SessionAccount;
  atomicOperations?: AtomicSecretOperations;
}

const DEFAULT_ATOMIC_SECRET_OPERATIONS: AtomicSecretOperations = {
  open,
  rename,
  unlink,
};

function absolutePath(value: string | undefined, name: string): string {
  const path = value?.trim();
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return path;
}

export function parseSessionRenewalEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SessionRenewalEnvironment {
  return {
    ownerKeyFile: absolutePath(
      env.TERMIX_SESSION_OWNER_KEY_FILE ||
        (env.CREDENTIALS_DIRECTORY ? `${env.CREDENTIALS_DIRECTORY}/owner-key` : undefined),
      "TERMIX_SESSION_OWNER_KEY_FILE",
    ),
    tokenPath: absolutePath(env.TERMIX_SESSION_TOKEN_PATH, "TERMIX_SESSION_TOKEN_PATH"),
    baseUrl: (env.TERMIX_BASE_URL?.trim() || "https://platform-backend.prod.termix.live").replace(/\/$/, ""),
  };
}

export function protectedOwnerKeyMetadataAccepted(stats: {
  isFile: boolean;
  mode: number;
  size: number;
}): boolean {
  return stats.isFile &&
    ((stats.mode & 0o777) === 0o400 || (stats.mode & 0o777) === 0o600) &&
    stats.size >= 64 &&
    stats.size <= 68;
}

export async function readProtectedSessionOwnerKey(path: string): Promise<Hex> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!protectedOwnerKeyMetadataAccepted({
      isFile: stats.isFile(),
      mode: stats.mode,
      size: stats.size,
    })) {
      throw new Error("TermiX owner-key credential must be root-owned, regular, and mode 0400 or 0600");
    }
    const key = (await handle.readFile("utf8")).trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(key)) {
      throw new Error("TermiX owner-key credential is malformed");
    }
    return key as Hex;
  } finally {
    await handle.close();
  }
}

export function protectedSessionTokenMetadataAccepted(
  stats: { isFile: boolean; uid: number; mode: number; size: number },
  expectedUid = process.geteuid?.() ?? stats.uid,
): boolean {
  return stats.isFile &&
    stats.uid === expectedUid &&
    (stats.mode & 0o777) === 0o600 &&
    stats.size <= 4_097;
}

export async function readProtectedSessionToken(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!protectedSessionTokenMetadataAccepted({
      isFile: stats.isFile(),
      uid: stats.uid,
      mode: stats.mode,
      size: stats.size,
    })) {
      throw new Error("TermiX session token must be a regular owner file with mode 0600");
    }
    return (await handle.readFile("utf8")).trim();
  } finally {
    await handle.close();
  }
}

function validSessionExpiry(token: string | undefined): Date | undefined {
  if (!token || token.length > 4_096 || /\s/.test(token)) return undefined;
  const expiry = resolveRuntimeTokenExpiry(token);
  return expiry && Number.isFinite(expiry.getTime()) ? expiry : undefined;
}

export function sessionTokenNeedsRenewal(token: string | undefined, now = new Date()): boolean {
  const expiry = validSessionExpiry(token);
  return !expiry || expiry.getTime() <= now.getTime() + TERMIX_SESSION_RENEWAL_WINDOW_MS;
}

function shortTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

async function parsedJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function validateOwnedAgentSession(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<"VALID" | "REAUTHENTICATE"> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/agents`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_TRANSPORT_FAILED",
      "TermiX owned-agent validation transport failed",
    );
  }
  if (response.status === 401) return "REAUTHENTICATE";
  if (response.status === 403) {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_FORBIDDEN",
      "TermiX owned-agent validation was forbidden",
    );
  }
  if (response.status >= 500) {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_SERVER_ERROR",
      `TermiX owned-agent validation failed with HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_UNEXPECTED_STATUS",
      `TermiX owned-agent validation failed with HTTP ${response.status}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_INVALID_RESPONSE",
      "TermiX owned-agent validation returned invalid JSON",
    );
  }
  const parsed = OwnedAgentsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_INVALID_RESPONSE",
      "TermiX owned-agent validation returned an invalid response",
    );
  }
  if (!parsed.data.items.some((agent) => agent.id === TERMIX_SESSION_REQUIRED_AGENT_ID)) {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_REQUIRED_AGENT_MISSING",
      "TermiX wallet session does not own the required dedicated agent",
    );
  }
  return "VALID";
}

export async function atomicInstallSessionToken(
  path: string,
  token: string,
  operations: AtomicSecretOperations = DEFAULT_ATOMIC_SECRET_OPERATIONS,
): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const temporaryHandle = await operations.open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!temporaryHandle.writeFile) throw new Error("Session-token temporary file is not writable");
      await temporaryHandle.writeFile(`${token}\n`, "utf8");
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await operations.rename(temporary, path);
    renamed = true;
    const directoryHandle = await operations.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!renamed) {
      try {
        await operations.unlink(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
    }
    throw error;
  }
}

export async function renewTermixSession(
  config: SessionRenewalEnvironment,
  dependencies: SessionRenewalDependencies = {},
): Promise<{ rotated: boolean; expiresAt: string; tokenHash: string }> {
  const now = dependencies.now ?? new Date();
  const ownerKey = await (dependencies.readOwnerKey ?? readProtectedSessionOwnerKey)(config.ownerKeyFile);
  const account = (dependencies.accountFromPrivateKey ?? privateKeyToAccount)(ownerKey);
  if (getAddress(account.address) !== TERMIX_SESSION_EXPECTED_WALLET) {
    throw new Error("Owner-key credential does not match the fixed TermiX wallet");
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const currentToken = await readProtectedSessionToken(config.tokenPath);
  const currentExpiry = validSessionExpiry(currentToken);
  if (currentToken && currentExpiry && currentExpiry.getTime() > now.getTime()) {
    const currentValidation = await validateOwnedAgentSession(config.baseUrl, currentToken, fetchImpl);
    if (
      currentValidation === "VALID" &&
      currentExpiry.getTime() > now.getTime() + TERMIX_SESSION_RENEWAL_WINDOW_MS
    ) {
      return {
        rotated: false,
        expiresAt: currentExpiry.toISOString(),
        tokenHash: shortTokenHash(currentToken),
      };
    }
  }

  const nonceResponse = await fetchImpl(`${config.baseUrl}/api/v1/auth/nonce`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: TERMIX_SESSION_EXPECTED_WALLET }),
    signal: AbortSignal.timeout(15_000),
  });
  const nonceParsed = NonceResponseSchema.safeParse(
    await parsedJson(nonceResponse, "TermiX nonce request"),
  );
  if (!nonceParsed.success) throw new Error("TermiX nonce response is invalid");
  const signature = await account.signMessage({ message: nonceParsed.data.message });

  const authResponse = await fetchImpl(`${config.baseUrl}/api/v1/auth/wallet`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: TERMIX_SESSION_EXPECTED_WALLET,
      nonce: nonceParsed.data.nonce,
      signature,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const authParsed = WalletAuthResponseSchema.safeParse(
    await parsedJson(authResponse, "TermiX wallet authentication"),
  );
  if (!authParsed.success || /\s/.test(authParsed.data.accessToken)) {
    throw new Error("TermiX wallet authentication returned an invalid session token");
  }
  const issuedToken = authParsed.data.accessToken;
  const issuedExpiry = validSessionExpiry(issuedToken);
  if (
    !issuedExpiry ||
    issuedExpiry.getTime() < now.getTime() + TERMIX_SESSION_MIN_ISSUED_LIFETIME_MS
  ) {
    throw new Error("TermiX wallet authentication returned a session without sufficient lifetime");
  }

  if (await validateOwnedAgentSession(config.baseUrl, issuedToken, fetchImpl) !== "VALID") {
    throw new TermixSessionRenewalError(
      "OWNED_AGENT_UNAUTHORIZED",
      "TermiX wallet session was rejected after authentication",
    );
  }

  await atomicInstallSessionToken(
    config.tokenPath,
    issuedToken,
    dependencies.atomicOperations,
  );
  return {
    rotated: true,
    expiresAt: issuedExpiry.toISOString(),
    tokenHash: shortTokenHash(issuedToken),
  };
}

export function sessionRenewalLogRecord(
  result: { rotated: boolean; expiresAt: string; tokenHash: string },
): { event: string; wallet: string; expiry: string; tokenHash: string; rotated: boolean } {
  return {
    event: "termix.wallet-session.renewal-complete",
    wallet: TERMIX_SESSION_EXPECTED_WALLET,
    expiry: result.expiresAt,
    tokenHash: result.tokenHash,
    rotated: result.rotated,
  };
}

export function sessionRenewalFailureLogRecord(
  error: unknown,
): { event: string; wallet: string; code: TermixSessionRenewalErrorCode } {
  return {
    event: "termix.wallet-session.renewal-failed",
    wallet: TERMIX_SESSION_EXPECTED_WALLET,
    code: error instanceof TermixSessionRenewalError ? error.code : "INTERNAL_ERROR",
  };
}

async function main(): Promise<void> {
  const result = await renewTermixSession(parseSessionRenewalEnvironment());
  process.stdout.write(`${JSON.stringify(sessionRenewalLogRecord(result))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify(sessionRenewalFailureLogRecord(error))}\n`);
    process.exitCode = 1;
  });
}
