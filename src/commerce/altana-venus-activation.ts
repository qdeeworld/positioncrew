import { BNB_TESTNET, createClient, signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  padHex,
  type Address,
  type Hex,
} from "viem";
import { bscTestnet } from "viem/chains";
import { z } from "zod";

export const ALTANA_VENUS_ACTOR = "0x50da554F1bF6A86469DB201C56bfe967d2E7c43d" as Address;
export const ALTANA_VENUS_VBNB = "0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c" as Address;
export const ALTANA_VENUS_MINT_SELECTOR = "0x1249c58b" as Hex;
export const ALTANA_VENUS_SUPPLY_WEI = 100_000_000_000_000n;
// Altana's native-token rule is one aggregate ceiling for the payable call and
// relay fee; it does not earmark value between them. PositionCrew's only
// execution path still hardcodes the 0.0001 tBNB product action below.
export const ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI = 200_000_000_000_000n;
export const ALTANA_VENUS_DAILY_ACTIVATION_LIMIT = 8;
export const ALTANA_VENUS_CLAIM_BOUNDARY =
  "Founder-funded BSC Testnet sandbox action. It proves one selector-bound Altana session execution and durable before/after evidence; it is not a mainnet lending rescue, user custody, payment, revenue, yield, or investment-performance claim.";

export const AltanaVenusActivationRequestSchema = z.object({
  schemaVersion: z.literal("positioncrew.altana-venus-activation.request.v1"),
  sourceHireId: z.string().uuid(),
  sourceReceiptId: z.string().uuid(),
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

export type AltanaVenusActivationRequest = z.infer<typeof AltanaVenusActivationRequestSchema>;

export const AltanaVenusSessionSecretSchema = z.object({
  schemaVersion: z.literal("positioncrew.altana-venus-session-secret.v1"),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  publicKey: z.string().regex(/^0x[0-9a-fA-F]+$/),
  expiry: z.number().int().positive(),
  grantTransactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  permissions: z.object({
    calls: z.tuple([z.object({
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      signature: z.literal("mint()"),
    }).strict()]),
    spend: z.tuple([z.object({
      limit: z.string().regex(/^\d+$/),
      period: z.literal("minute"),
    }).strict()]),
  }).strict(),
}).strict();

export type AltanaVenusSessionSecret = z.infer<typeof AltanaVenusSessionSecretSchema>;

export interface AltanaVenusExecutionEvidence {
  chainId: 97;
  actor: Address;
  target: Address;
  selector: Hex;
  suppliedWei: string;
  transactionHash: Hex;
  callsId: Hex;
  submittedAt: string;
  beforeBlockNumber: string;
  confirmedBlockNumber: string;
  vTokenBalanceBefore: string;
  vTokenBalanceAfter: string;
  vTokenDelta: string;
  session: {
    publicKey: Hex;
    expiry: number;
    grantTransactionHash: Hex;
    permissions: {
      calls: [{ to: Address; signature: "mint()" }];
      spend: [{ limit: string; period: "minute" }];
    };
  };
}

export type AltanaVenusSubmittedExecution = Omit<
  AltanaVenusExecutionEvidence,
  "transactionHash" | "confirmedBlockNumber" | "vTokenBalanceAfter" | "vTokenDelta"
>;

export type AltanaVenusConfirmedExecution = Omit<
  AltanaVenusExecutionEvidence,
  "vTokenBalanceAfter" | "vTokenDelta"
>;

export class AltanaSubmissionPersistenceError extends Error {
  readonly code = "ALTANA_SUBMISSION_PERSISTENCE_FAILED";
  constructor(
    readonly submission: AltanaVenusSubmittedExecution,
    options?: ErrorOptions,
  ) {
    super("A submitted transaction could not yet be persisted", options);
    this.name = "AltanaSubmissionPersistenceError";
  }
}

export class AltanaConfirmationPersistenceError extends Error {
  readonly code = "ALTANA_CONFIRMATION_PERSISTENCE_FAILED";
  constructor(
    readonly confirmation: AltanaVenusConfirmedExecution,
    options?: ErrorOptions,
  ) {
    super("A confirmed transaction could not yet be persisted", options);
    this.name = "AltanaConfirmationPersistenceError";
  }
}

const BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

const KEYSTORE_IS_VALID_KEY_ABI = [{
  type: "function",
  name: "isValidKey",
  stateMutability: "view",
  inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }],
  outputs: [{ name: "valid", type: "bool" }],
}] as const;

const ACCOUNT_GET_KEYS_ABI = [{
  type: "function",
  name: "getKeys",
  stateMutability: "view",
  inputs: [],
  outputs: [
    {
      name: "keys",
      type: "tuple[]",
      components: [
        { name: "expiry", type: "uint40" },
        { name: "keyType", type: "uint8" },
        { name: "isSuperAdmin", type: "bool" },
        { name: "publicKey", type: "bytes" },
      ],
    },
    { name: "keyHashes", type: "bytes32[]" },
  ],
}] as const;

const ACCOUNT_PERMISSION_ABI = [
  {
    type: "function",
    name: "canExecute",
    stateMutability: "view",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "canExecutePackedInfos",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    type: "function",
    name: "spendInfos",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{
      name: "results",
      type: "tuple[]",
      components: [
        { name: "token", type: "address" },
        { name: "period", type: "uint8" },
        { name: "limit", type: "uint256" },
        { name: "spent", type: "uint256" },
        { name: "lastUpdated", type: "uint256" },
        { name: "currentSpent", type: "uint256" },
        { name: "current", type: "uint256" },
      ],
    }],
  },
] as const;

const ALTANA_NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as Address;
const ALTANA_SCOPE_PROBE_TARGET = "0x0000000000000000000000000000000000000001" as Address;
const ALTANA_SCOPE_PROBE_SELECTOR = "0xffffffff" as Hex;

interface AltanaAccountKeyMetadata {
  expiry: bigint;
  keyType: number;
  isSuperAdmin: boolean;
  publicKey: Hex;
}

function parseAltanaAccountKeyMetadata(raw: unknown): AltanaAccountKeyMetadata {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  const values = Array.isArray(raw)
    ? raw
    : [record?.expiry, record?.keyType, record?.isSuperAdmin, record?.publicKey];
  const [expiryRaw, keyTypeRaw, isSuperAdminRaw, publicKeyRaw] = values;
  const expiry = typeof expiryRaw === "bigint"
    ? expiryRaw
    : typeof expiryRaw === "number" && Number.isSafeInteger(expiryRaw) && expiryRaw >= 0
      ? BigInt(expiryRaw)
      : null;
  if (
    expiry === null ||
    typeof keyTypeRaw !== "number" ||
    !Number.isInteger(keyTypeRaw) ||
    typeof isSuperAdminRaw !== "boolean" ||
    typeof publicKeyRaw !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(publicKeyRaw)
  ) {
    throw new Error("ALTANA_SESSION_ACCOUNT_METADATA_INVALID");
  }
  return {
    expiry,
    keyType: keyTypeRaw,
    isSuperAdmin: isSuperAdminRaw,
    publicKey: publicKeyRaw as Hex,
  };
}

function parseAltanaSpendInfo(raw: unknown): { token: Address; period: number; limit: bigint } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  const values = Array.isArray(raw)
    ? raw
    : [record?.token, record?.period, record?.limit];
  const [tokenRaw, periodRaw, limitRaw] = values;
  if (
    typeof tokenRaw !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(tokenRaw) ||
    typeof periodRaw !== "number" ||
    !Number.isInteger(periodRaw) ||
    typeof limitRaw !== "bigint"
  ) {
    throw new Error("ALTANA_SESSION_SPEND_METADATA_INVALID");
  }
  return { token: tokenRaw as Address, period: periodRaw, limit: limitRaw };
}

const AltanaRelayStatusSchema = z.object({
  status: z.union([z.number(), z.string()]),
  receipts: z.array(z.object({
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  }).passthrough()).optional(),
}).passthrough();

export function confirmedAltanaRelayTransaction(raw: unknown): Hex {
  const status = AltanaRelayStatusSchema.parse(raw);
  if ([400, 500, 600, "FAILED"].includes(status.status)) throw new Error("ALTANA_EXECUTION_FAILED");
  const transactionHash = status.receipts?.[0]?.transactionHash;
  if ((status.status !== 200 && status.status !== "CONFIRMED") || !transactionHash) {
    throw new Error("ALTANA_RELAY_PENDING");
  }
  return transactionHash as Hex;
}

export function parseAltanaVenusSessionSecret(serialized: string, now = Date.now()): {
  session: Session;
  grantTransactionHash: Hex;
} {
  const parsed = AltanaVenusSessionSecretSchema.parse(JSON.parse(serialized));
  const signer = signerFromPrivateKey(parsed.privateKey as Hex);
  const walletAddress = getAddress(parsed.walletAddress);
  const target = getAddress(parsed.permissions.calls[0].to);
  if (walletAddress !== getAddress(ALTANA_VENUS_ACTOR)) throw new Error("ALTANA_SESSION_ACTOR_MISMATCH");
  if (target !== getAddress(ALTANA_VENUS_VBNB)) throw new Error("ALTANA_SESSION_TARGET_MISMATCH");
  if (signer.publicKey.toLowerCase() !== parsed.publicKey.toLowerCase()) {
    throw new Error("ALTANA_SESSION_PUBLIC_KEY_MISMATCH");
  }
  if (parsed.expiry * 1_000 <= now + 60_000) throw new Error("ALTANA_SESSION_EXPIRED");
  if (BigInt(parsed.permissions.spend[0].limit) !== ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI) {
    throw new Error("ALTANA_SESSION_SPEND_SCOPE_MISMATCH");
  }
  return {
    session: {
      walletAddress,
      signer,
      publicKey: parsed.publicKey as Hex,
      expiry: parsed.expiry,
      permissions: {
        calls: [{ to: target, signature: "mint()" }],
        spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI, period: "minute" }],
      },
    },
    grantTransactionHash: parsed.grantTransactionHash as Hex,
  };
}

export function publicAltanaVenusSession(serialized: string, now = Date.now()) {
  const { session, grantTransactionHash } = parseAltanaVenusSessionSecret(serialized, now);
  return {
    actor: session.walletAddress,
    publicKey: session.publicKey,
    expiry: session.expiry,
    grantTransactionHash,
    permissions: {
      calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" as const }],
      spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString(), period: "minute" as const }],
    },
  };
}

export async function verifyLiveAltanaVenusSession(
  serialized: string,
  now = Date.now(),
  readContract?: (request: unknown) => Promise<unknown>,
) {
  const parsed = parseAltanaVenusSessionSecret(serialized, now);
  const session = publicAltanaVenusSession(serialized, now);
  const registryKeyId = keccak256(session.publicKey as Hex);
  const accountPublicKeyHash = keccak256(padHex(parsed.session.signer.address, { size: 32 }));
  const accountKeyHash = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }],
    [2n, accountPublicKeyHash],
  ));
  const rpc = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.publicRpcUrl) });
  const read = readContract ?? ((request: unknown) => rpc.readContract(request as never));
  const [
    registryValid,
    accountKeysRaw,
    executeInfosRaw,
    exactCallAllowed,
    alternateTargetAllowed,
    alternateSelectorAllowed,
    spendInfosRaw,
  ] = await Promise.all([
    read({
      address: BNB_TESTNET.keyStore,
      abi: KEYSTORE_IS_VALID_KEY_ABI,
      functionName: "isValidKey",
      args: [ALTANA_VENUS_ACTOR, registryKeyId],
    }),
    read({
      address: ALTANA_VENUS_ACTOR,
      abi: ACCOUNT_GET_KEYS_ABI,
      functionName: "getKeys",
    }),
    read({
      address: ALTANA_VENUS_ACTOR,
      abi: ACCOUNT_PERMISSION_ABI,
      functionName: "canExecutePackedInfos",
      args: [accountKeyHash],
    }),
    read({
      address: ALTANA_VENUS_ACTOR,
      abi: ACCOUNT_PERMISSION_ABI,
      functionName: "canExecute",
      args: [accountKeyHash, ALTANA_VENUS_VBNB, ALTANA_VENUS_MINT_SELECTOR],
    }),
    read({
      address: ALTANA_VENUS_ACTOR,
      abi: ACCOUNT_PERMISSION_ABI,
      functionName: "canExecute",
      args: [accountKeyHash, ALTANA_SCOPE_PROBE_TARGET, ALTANA_VENUS_MINT_SELECTOR],
    }),
    read({
      address: ALTANA_VENUS_ACTOR,
      abi: ACCOUNT_PERMISSION_ABI,
      functionName: "canExecute",
      args: [accountKeyHash, ALTANA_VENUS_VBNB, ALTANA_SCOPE_PROBE_SELECTOR],
    }),
    read({
      address: ALTANA_VENUS_ACTOR,
      abi: ACCOUNT_PERMISSION_ABI,
      functionName: "spendInfos",
      args: [accountKeyHash],
    }),
  ]);
  if (registryValid !== true) throw new Error("ALTANA_SESSION_KEYSTORE_INVALID");
  const accountKeys = Array.isArray(accountKeysRaw) && Array.isArray(accountKeysRaw[0])
    ? accountKeysRaw[0]
    : [];
  const keyHashes = Array.isArray(accountKeysRaw) && Array.isArray(accountKeysRaw[1])
    ? accountKeysRaw[1].filter((value): value is string => typeof value === "string")
    : [];
  const matchingKeyIndex = keyHashes.findIndex(
    (value) => value.toLowerCase() === accountKeyHash.toLowerCase(),
  );
  if (matchingKeyIndex < 0) {
    throw new Error("ALTANA_SESSION_ACCOUNT_UNAUTHORIZED");
  }
  const matchingKey = parseAltanaAccountKeyMetadata(accountKeys[matchingKeyIndex]);
  const expectedAccountPublicKey = padHex(parsed.session.signer.address, { size: 32 });
  if (matchingKey.expiry !== BigInt(parsed.session.expiry)) {
    throw new Error("ALTANA_SESSION_ACCOUNT_EXPIRY_MISMATCH");
  }
  if (matchingKey.keyType !== 2) throw new Error("ALTANA_SESSION_ACCOUNT_KEY_TYPE_MISMATCH");
  if (matchingKey.isSuperAdmin) throw new Error("ALTANA_SESSION_ACCOUNT_SUPER_ADMIN");
  if (matchingKey.publicKey.toLowerCase() !== expectedAccountPublicKey.toLowerCase()) {
    throw new Error("ALTANA_SESSION_ACCOUNT_PUBLIC_KEY_MISMATCH");
  }
  const executeInfos = Array.isArray(executeInfosRaw)
    ? executeInfosRaw.filter((value): value is string => typeof value === "string")
    : [];
  if (
    executeInfos.length !== 1 ||
    exactCallAllowed !== true ||
    alternateTargetAllowed !== false ||
    alternateSelectorAllowed !== false
  ) {
    throw new Error("ALTANA_SESSION_EXECUTION_SCOPE_MISMATCH");
  }
  const spendInfos = Array.isArray(spendInfosRaw) ? spendInfosRaw : [];
  if (spendInfos.length !== 1) throw new Error("ALTANA_SESSION_SPEND_SCOPE_MISMATCH");
  const spendInfo = parseAltanaSpendInfo(spendInfos[0]);
  if (
    spendInfo.token.toLowerCase() !== ALTANA_NATIVE_TOKEN.toLowerCase() ||
    spendInfo.period !== 0 ||
    spendInfo.limit !== ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI
  ) {
    throw new Error("ALTANA_SESSION_SPEND_SCOPE_MISMATCH");
  }
  return {
    ...session,
    verification: {
      registryKeyId,
      accountKeyHash,
      keyStore: BNB_TESTNET.keyStore,
      registryValid: true as const,
      accountAuthorized: true as const,
      accountKeyExpiry: Number(matchingKey.expiry),
      accountKeyType: matchingKey.keyType,
      accountKeyIsSuperAdmin: matchingKey.isSuperAdmin,
      accountKeyPublicKey: matchingKey.publicKey,
      liveExecutionRuleCount: executeInfos.length,
      liveCallScopeVerified: true as const,
      liveSpendRuleCount: spendInfos.length,
      liveSpendToken: spendInfo.token,
      liveSpendPeriod: "minute" as const,
      liveSpendLimit: spendInfo.limit.toString(),
      checkedAt: new Date(now).toISOString(),
    },
  };
}

export async function executeAltanaVenusActivation(
  serializedSession: string,
  authorizeSubmission: () => Promise<void>,
  onSubmitted: (evidence: AltanaVenusSubmittedExecution) => Promise<void>,
  onConfirmed: (evidence: AltanaVenusConfirmedExecution) => Promise<void>,
): Promise<AltanaVenusExecutionEvidence> {
  const { session, grantTransactionHash } = parseAltanaVenusSessionSecret(serializedSession);
  const rpc = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.publicRpcUrl) });
  const beforeBlockNumber = await rpc.getBlockNumber();
  const before = await rpc.readContract({
    address: ALTANA_VENUS_VBNB,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [ALTANA_VENUS_ACTOR],
    blockNumber: beforeBlockNumber,
  });
  await verifyLiveAltanaVenusSession(serializedSession);
  await authorizeSubmission();
  const execution = await createClient({ chains: [BNB_TESTNET], defaultChainId: 97 }).execute({
    session,
    chainId: 97,
    noWait: true,
    calls: [{ to: ALTANA_VENUS_VBNB, value: ALTANA_VENUS_SUPPLY_WEI, data: ALTANA_VENUS_MINT_SELECTOR }],
  });
  const submitted: AltanaVenusSubmittedExecution = {
    chainId: 97,
    actor: ALTANA_VENUS_ACTOR,
    target: ALTANA_VENUS_VBNB,
    selector: ALTANA_VENUS_MINT_SELECTOR,
    suppliedWei: ALTANA_VENUS_SUPPLY_WEI.toString(),
    callsId: execution.callsId,
    submittedAt: new Date().toISOString(),
    beforeBlockNumber: beforeBlockNumber.toString(),
    vTokenBalanceBefore: before.toString(),
    session: {
      publicKey: session.publicKey,
      expiry: session.expiry,
      grantTransactionHash,
      permissions: {
        calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" }],
        spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString(), period: "minute" }],
      },
    },
  };
  try {
    await onSubmitted(submitted);
  } catch (cause) {
    throw new AltanaSubmissionPersistenceError(submitted, { cause });
  }
  const confirmed = await confirmAltanaVenusSubmittedExecution(submitted);
  try {
    await onConfirmed(confirmed);
  } catch (cause) {
    throw new AltanaConfirmationPersistenceError(confirmed, { cause });
  }
  return completeAltanaVenusExecutionEvidence(confirmed);
}

export async function confirmAltanaVenusSubmittedExecution(
  submitted: AltanaVenusSubmittedExecution,
): Promise<AltanaVenusConfirmedExecution> {
  if (!BNB_TESTNET.relayUrl) throw new Error("ALTANA_RELAY_UNAVAILABLE");
  const relay = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.relayUrl, { timeout: 60_000 }) });
  const rawStatus: unknown = await relay.request({
    method: "wallet_getCallsStatus" as never,
    params: [submitted.callsId] as never,
  });
  const transactionHash = confirmedAltanaRelayTransaction(rawStatus);
  const rpc = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.publicRpcUrl) });
  const receipt = await rpc.waitForTransactionReceipt({ hash: transactionHash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error("ALTANA_EXECUTION_REVERTED");
  return { ...submitted, transactionHash, confirmedBlockNumber: receipt.blockNumber.toString() };
}

export async function completeAltanaVenusExecutionEvidence(
  confirmed: AltanaVenusConfirmedExecution,
): Promise<AltanaVenusExecutionEvidence> {
  const rpc = createPublicClient({ chain: bscTestnet, transport: http(BNB_TESTNET.publicRpcUrl) });
  const after = await rpc.readContract({
    address: ALTANA_VENUS_VBNB,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [ALTANA_VENUS_ACTOR],
    blockNumber: BigInt(confirmed.confirmedBlockNumber),
  });
  const delta = after - BigInt(confirmed.vTokenBalanceBefore);
  if (delta <= 0n) throw new Error("ALTANA_VTOKEN_DELTA_NOT_POSITIVE");
  return {
    ...confirmed,
    vTokenBalanceAfter: after.toString(),
    vTokenDelta: delta.toString(),
  };
}
