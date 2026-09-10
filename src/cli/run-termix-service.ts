import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { isCliEntrypoint } from "../core/cli-entrypoint.js";
import { spawnSync } from "node:child_process";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { z } from "zod";
import { canonicalHash } from "../core/canonical.js";
import { atomicJson } from "../core/atomic-json.js";
import { TermixRuntimeClient } from "../commerce/aacp-runtime.js";
import { assertTermixProviderIntent, normalizeTermixProviderOrder, createTermixLendingIntakeFromOrderScope, createTermixLendingIntakeFromRuntimeMessage, LENDING_REQUIREMENTS_GUIDE, type TermixProviderOrder } from "../commerce/termix-provider-delivery.js";
import { validateServicePolicy, assertServiceOrder, assertZeroStakeConfig, reserveOrder, ServiceLedgerSchema, SELLER_WALLET, type ServiceLedger } from "../commerce/termix-service-policy.js";
import { inspectVenusAccount } from "../telemetry/bsc.js";
import { fetchOrders } from "./watch-termix-orders.js";
import { protectedText, durableJournal, validateDeliveryPolicy } from "./fulfill-termix-lending.js";

const BASE = "https://platform-backend.prod.termix.live";
const log = (value: unknown) => console.log(JSON.stringify(value));
const SignedSchema = z.object({raw:z.string().regex(/^0x[0-9a-f]+$/),hash:z.string().regex(/^0x[0-9a-f]{64}$/),expiresAt:z.string().datetime()});

/** Resolve only the latest buyer-origin text; never accept a prior valid message
 * after a newer ambiguous correction, nor interpret a provider/system message. */
export function intakeFromMessages(order: TermixProviderOrder, messages: unknown[]) {
  const conversationId = z.object({id:z.string().min(1)}).parse(order.conversation).id;
  const texts = messages.filter((input): input is Record<string, unknown> => {
    if (!input || typeof input !== "object") return false;
    const message = input as Record<string, unknown>;
    return message.orderId === order.id && message.conversationId === conversationId && message.kind === "TEXT" &&
      (message.from as {accountId?:string} | undefined)?.accountId === order.clientAccountId;
  }).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  const message = texts[0];
  if (!message) throw new Error("No buyer requirements message");
  const createdAt = z.string().datetime().parse(message.createdAt);
  const locator = {schemaVersion:"positioncrew.termix-buyer-message-locator.v1" as const,orderId:order.id,conversationId,
    messageId:z.string().parse(message.messageId),since:new Date(Date.parse(createdAt)-1).toISOString()};
  return {intake:createTermixLendingIntakeFromRuntimeMessage(order,locator,message),locator};
}
export function assertNoPendingNonce(latest: number, pending: number) {
  if (latest !== pending) throw new Error("Seller wallet has an unresolved pending transaction; no new signature");
}

export async function runTermixService() {
  const execute = process.argv.includes("--execute");
  const policy = validateServicePolicy(JSON.parse(protectedText(process.env.TERMIX_SERVICE_POLICY_FILE ?? "")));
  const root = process.env.TERMIX_SERVICE_STATE_DIR ?? "";
  if (!isAbsolute(root)) throw new Error("Service state directory must be absolute");
  mkdirSync(root,{recursive:true,mode:0o700});
  const ledgerPath = resolve(root,"ledger.json");
  let ledger: ServiceLedger = existsSync(ledgerPath) ? ServiceLedgerSchema.parse(JSON.parse(protectedText(ledgerPath))) : {
    schemaVersion:"positioncrew.termix-service-ledger.v1",policyHash:canonicalHash(policy),reservations:{}};
  if (ledger.policyHash !== canonicalHash(policy)) throw new Error("Service policy changed; explicit ledger migration required");
  const token = protectedText(process.env.TERMIX_SESSION_TOKEN_FILE ?? "");
  const runtime = new TermixRuntimeClient(protectedText(process.env.TERMIX_RUNTIME_TOKEN_FILE ?? ""));
  async function api(path: string, method: "GET" | "POST" = "GET") {
    const response = await fetch(BASE+path,{method,headers:{Authorization:`Bearer ${token}`,Accept:"application/json"},signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`TermiX ${method} failed (${response.status})`);
    return response.json();
  }
  const readOrder = async (id: string) => normalizeTermixProviderOrder(await api(`/api/v1/orders/${encodeURIComponent(id)}`));
  const config = assertZeroStakeConfig(await api("/api/v1/config/contracts"),policy);
  const client = createPublicClient({chain:bsc,transport:http("https://bsc-dataseed.bnbchain.org",{timeout:15000,retryCount:2})});
  if (await client.getChainId() !== 56) throw new Error("Wrong chain");

  // Recover every journal before admitting another order. An RPC outage must not
  // be mistaken for a dropped transaction; nonce equality is checked before signing.
  for (const [id, reservation] of Object.entries(ledger.reservations)) {
    const directory = resolve(root,id);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter(n=>n.endsWith("-signed.json"))) {
      const signed = SignedSchema.parse(JSON.parse(protectedText(resolve(directory,name))));
      if (keccak256(signed.raw as Hex) !== signed.hash) throw new Error("Signed journal corrupt");
      const receipt = await client.getTransactionReceipt({hash:signed.hash as Hex}).catch(error=>{
        if (error.name === "TransactionReceiptNotFoundError") return null;
        throw error;
      });
      if (receipt) {
        if (receipt.status !== "success") throw new Error(`Signed transaction reverted for ${id}; reconciliation required`);
        continue;
      }
      const order = (validateDeliveryPolicy(reservation.policy,await readOrder(id))).order;
      if (Date.parse(signed.expiresAt) <= Date.now()+60000) throw new Error(`Unconfirmed transaction expired for ${id}; reconciliation required`);
      if (name.startsWith("accept") ? order.status !== "PENDING_ACCEPT" : !["FUNDED","IN_PROGRESS"].includes(order.status)) throw new Error("Unconfirmed transaction conflicts with order state");
      if (!execute) {log({event:"service.pending-journal",orderId:id,hash:signed.hash});return;}
      await client.sendRawTransaction({serializedTransaction:signed.raw as Hex}).catch(error=>{
        // A known transaction may already be in the node's pool; wait for it.
        if (!/already known/i.test(String(error.shortMessage ?? error.message))) throw error;
      });
      const recovered = await client.waitForTransactionReceipt({hash:signed.hash as Hex,timeout:60000});
      if (recovered.status !== "success") throw new Error("Recovered service transaction reverted");
    }
  }
  const orders = await fetchOrders(BASE,token);
  let failures = 0;
  for (const raw of orders) {
    let mayHaveSigned = false;
    // The account can own other agents. Do not treat their orders as malformed jobs.
    if ((raw.seller as {id?:string} | undefined)?.id !== policy.providerAgentId && raw.providerAgentId !== policy.providerAgentId) continue;
    try {
      let order = await readOrder(raw.id);
      const reservation = ledger.reservations[order.id];
      if (["SETTLED","CANCELLED"].includes(order.status)) {
        if (reservation && !reservation.closedAt && execute) {
          reservation.closedAt = new Date().toISOString();
          await atomicJson(ledgerPath,ledger);
        }
        continue;
      }
      if (["DELIVERED","ACCEPTED"].includes(order.status)) continue;
      assertServiceOrder(order,policy);
      const directory = resolve(root,order.id);
      if (!reservation) {
        let intake, locator;
        try {intake = createTermixLendingIntakeFromOrderScope(order);} catch {
          let since = z.string().datetime().parse(order.createdAt);
          const messages: unknown[] = [];
          let exhausted = false;
          for (let page=0;page<20;page++) {
            const batch = await runtime.poll(since,100);
            messages.push(...batch);
            if (batch.length < 100) {exhausted=true;break;}
            const next = batch.map(m=>m.createdAt).sort().at(-1)!;
            if (Date.parse(next)<=Date.parse(since)) throw new Error("Inbox pagination stalled; cannot safely choose current requirements");
            since=next;
          }
          if (!exhausted) throw new Error("Inbox pagination limit reached");
          try {({intake,locator}=intakeFromMessages(order,messages));} catch {
            const conversationId = z.object({id:z.string()}).parse(order.conversation).id;
            // Stable key makes retrying a failed/ambiguous HTTP response idempotent.
            const relevant = messages.filter(m=>{const v=m as {orderId?:string;kind?:string;from?:{accountId?:string}};return v.orderId===order.id && v.kind==="TEXT" && v.from?.accountId===order.clientAccountId;});
            const key = `pc-intake-${canonicalHash({orderId:order.id,messages:relevant}).slice(7,39)}`;
            const noticePath = resolve(root,`notice-${key}.json`);
            if (execute && !existsSync(noticePath)) {
              await runtime.reply(conversationId,LENDING_REQUIREMENTS_GUIDE,key);
              await atomicJson(noticePath,{orderId:order.id,key});
            }
            log({event:"service.needs-requirements",orderId:order.id,execute});
            continue;
          }
        }
        // Verify this supported account can actually be observed before accepting paid work.
        await inspectVenusAccount(intake.account,{targetHealthFactor:intake.targetHealthFactor,stressPriceDropBps:intake.stressPriceDropBps,maxActionUsd:intake.maxActionUsd,maxGasUsd:intake.maxGasUsd,maxSlippageBps:intake.maxSlippageBps});
        const next = reserveOrder(ledger,policy,order,intake,locator);
        if (!execute) {log({event:"service.would-admit",orderId:order.id,currency:order.currency,amount:order.amount});continue;}
        // This reservation survives all retries and is never reclaimed on failure.
        await atomicJson(ledgerPath,next);
        ledger=next;
      }
      if (!execute) {log({event:"service.would-resume",orderId:order.id,status:order.status});continue;}
      mkdirSync(directory,{recursive:true,mode:0o700});
      const deliveryPolicy = ledger.reservations[order.id]!.policy;
      validateDeliveryPolicy(deliveryPolicy,order);
      await atomicJson(resolve(directory,"policy.json"),deliveryPolicy);
      if (order.status === "PENDING_ACCEPT") {
        const journalPath = resolve(directory,"accept-signed.json");
        if (existsSync(journalPath)) {log({event:"service.awaiting-acceptance-index",orderId:order.id});continue;}
        const freshConfig = assertZeroStakeConfig(await api("/api/v1/config/contracts"),policy);
        const intentRaw = await api(`/api/v1/orders/${encodeURIComponent(order.id)}/provider-accept/prepare`,"POST");
        order = await readOrder(order.id);
        validateDeliveryPolicy(deliveryPolicy,order);
        assertServiceOrder(order,policy);
        const guard = assertTermixProviderIntent(order,freshConfig,intentRaw,"acceptOrder",{allowUnflaggedAcceptance:true});
        const to = (guard.intent.contract ?? guard.intent.to!) as Hex;
        const data = (guard.intent.callData ?? guard.intent.data!) as Hex;
        await client.call({account:SELLER_WALLET,to,data,value:0n});
        const gas = await client.estimateGas({account:SELLER_WALLET,to,data,value:0n}) * 120n / 100n;
        const gasPrice = await client.getGasPrice();
        if (gas * gasPrice > BigInt(policy.maxGasWei)) throw new Error("Acceptance gas exceeds policy");
        const account = privateKeyToAccount(protectedText(process.env.TERMIX_DELIVERY_OWNER_KEY_FILE ?? "") as Hex);
        if (account.address.toLowerCase() !== SELLER_WALLET.toLowerCase()) throw new Error("Wrong signing owner");
        const [latest,pending] = await Promise.all([client.getTransactionCount({address:SELLER_WALLET,blockTag:"latest"}),client.getTransactionCount({address:SELLER_WALLET,blockTag:"pending"})]);
        assertNoPendingNonce(latest,pending);
        assertServiceOrder(order,policy);
        mayHaveSigned = true;
        const signed = await account.signTransaction({chainId:56,type:"legacy",to,data,value:0n,gas,gasPrice,nonce:pending});
        const hash = keccak256(signed);
        // Short acceptance retry window, bounded further by known order deadlines.
        const expiresAt = new Date(Math.min(Date.now()+120000,Date.parse(policy.expiresAt),Date.parse(order.acceptDeadline ?? order.deliveryDueAt!))).toISOString();
        durableJournal(journalPath,JSON.stringify({raw:signed,hash,expiresAt}));
        assertServiceOrder(order,policy);
        await client.sendRawTransaction({serializedTransaction:signed});
        const receipt = await client.waitForTransactionReceipt({hash,timeout:60000});
        if (receipt.status !== "success") throw new Error("Acceptance reverted");
        log({event:"service.accepted",orderId:order.id,hash});
        order=await readOrder(order.id);
      }
      if (!["FUNDED","IN_PROGRESS"].includes(order.status) || !order.availableActions.canSubmitDelivery) continue;
      const [latest,pending] = await Promise.all([client.getTransactionCount({address:SELLER_WALLET,blockTag:"latest"}),client.getTransactionCount({address:SELLER_WALLET,blockTag:"pending"})]);
      assertNoPendingNonce(latest,pending);
      mayHaveSigned = true;
      const completed = spawnSync(process.execPath,[process.env.TERMIX_FULFILL_SCRIPT ?? "/opt/positioncrew-termix-orders/fulfill-termix-lending.mjs"],{
        env:{...process.env,TERMIX_DELIVERY_POLICY_FILE:resolve(directory,"policy.json"),TERMIX_FULFILLMENT_STATE_DIR:directory},encoding:"utf8",timeout:300000,maxBuffer:2*1024*1024});
      if (completed.status !== 0) {
        await atomicJson(resolve(directory,"last-worker-failure.json"),{at:new Date().toISOString(),status:completed.status,signal:completed.signal,stderr:completed.stderr?.slice(0,16000),error:completed.error?.message});
        throw new Error("Delivery worker failed; inspect protected order checkpoint and failure record");
      }
      log({event:"service.fulfillment-complete",orderId:order.id});
    } catch (error) {
      failures++;
      log({event:"service.order-blocked",orderId:raw.id,error:error instanceof Error ? error.message : "Unknown failure"});
      // Stop this signing batch after any failure: a child may have persisted a
      // signature. The next run reconciles every journal before signing again.
      if (execute && mayHaveSigned) break;
    }
  }
  log({event:"service.scan-complete",execute,orders:orders.length,reserved:Object.keys(ledger.reservations).length,failures,escrow:config.settlementCurrencies.find(c=>c.symbol===policy.currency)!.contracts.escrow});
  if (failures) process.exitCode=1;
}
if (isCliEntrypoint(import.meta.url, process.argv[1], "run-termix-service")) runTermixService().catch(error=>{
  log({event:"service.failed",error:error.shortMessage ?? error.message});process.exitCode=1;
});
