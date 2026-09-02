import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Wallet as EthersWallet } from "ethers";
import { BNB_TESTNET, createClient, signerFromPrivateKey } from "@altananetwork/sdk";
import { getAddress, type Hex } from "viem";
import {
  ALTANA_VENUS_ACTOR,
  ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI,
  ALTANA_VENUS_VBNB,
} from "../commerce/altana-venus-activation.js";

const home = process.env.HOME ?? "/Users/qdee";
const keystorePath = process.env.POSITIONCREW_KEYSTORE_PATH ??
  resolve(home, ".config/positioncrew/bnbagent-wallets", `${ALTANA_VENUS_ACTOR}.json`);
const passwordPath = process.env.POSITIONCREW_PASSWORD_PATH ??
  resolve(home, ".config/positioncrew/bnbagent-password");
const outputPath = process.env.POSITIONCREW_ALTANA_SESSION_PATH ??
  resolve(home, ".config/positioncrew/altana-venus-session.json");
const defaultExpiry = Math.floor(new Date("2026-09-24T00:00:00Z").getTime() / 1_000);

async function main() {
  const encrypted = await readFile(keystorePath, "utf8");
  const password = (await readFile(passwordPath, "utf8")).trim();
  const wallet = await EthersWallet.fromEncryptedJson(encrypted, password);
  if (getAddress(wallet.address) !== getAddress(ALTANA_VENUS_ACTOR)) throw new Error("Admin keystore actor mismatch");
  const signer = signerFromPrivateKey(wallet.privateKey as Hex);
  const expiry = Number(process.env.POSITIONCREW_ALTANA_SESSION_EXPIRY ?? defaultExpiry);
  if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1_000) + 3600) {
    throw new Error("Session expiry must be at least one hour in the future");
  }
  const client = createClient({ chains: [BNB_TESTNET], defaultChainId: 97 });
  const granted = await client.grantSession({
    wallet: { address: ALTANA_VENUS_ACTOR },
    signer,
    chainId: 97,
    register: true,
    expiry,
    permissions: {
      calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" }],
      spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI, period: "minute" }],
    },
  });
  if (!granted.transactionHash) throw new Error("Grant did not return a transaction hash");
  if (!("_privateKey" in granted.signer) || typeof granted.signer._privateKey !== "string") {
    throw new Error("Generated session signer is not serializable");
  }
  const secret = {
    schemaVersion: "positioncrew.altana-venus-session-secret.v1",
    walletAddress: granted.walletAddress,
    privateKey: granted.signer._privateKey,
    publicKey: granted.publicKey,
    expiry: granted.expiry,
    grantTransactionHash: granted.transactionHash,
    permissions: {
      calls: [{ to: ALTANA_VENUS_VBNB, signature: "mint()" }],
      spend: [{ limit: ALTANA_VENUS_SESSION_SPEND_LIMIT_WEI.toString(), period: "minute" }],
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(secret)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(outputPath, 0o600);
  process.stdout.write(JSON.stringify({
    status: "GRANTED",
    outputPath,
    publicKey: granted.publicKey,
    expiry: granted.expiry,
    transactionHash: granted.transactionHash,
  }, null, 2) + "\n");
}

await main();
