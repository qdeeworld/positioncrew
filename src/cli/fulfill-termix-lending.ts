import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, isAbsolute, dirname } from "node:path";
import { isCliEntrypoint } from "../core/cli-entrypoint.js";
import { createPublicClient, http, keccak256, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { z } from "zod";
import { canonicalHash } from "../core/canonical.js";
import { assertTermixProviderOrder, assertTermixProviderIntent, createTermixLendingIntakeFromOrderScope,
  verifyTermixFulfillmentCheckpoint, TermixContractsConfigSchema, TermixBuyerMessageLocatorSchema } from "../commerce/termix-provider-delivery.js";

const BASE = "https://platform-backend.prod.termix.live";
const OWNER = "0xADd748C416E8A7efd7d65D18Abb121dea268ddF9";
const AGENT = "cmt4dzxvcli4tw70125nd5ra8";
const LISTING = "cmt4e8j3nlmuiw7019f4qf24x";
export const DeliveryPolicySchema = z.object({
  orderId: z.string().regex(/^[a-z0-9]{20,40}$/),
  scopeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  clientAccountId: z.string().min(1),
  onChainOrderId: z.string().regex(/^0x[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
  currency: z.enum(["USDC", "USDT"]).optional(),
  escrow: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  intakeHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  buyerMessage: TermixBuyerMessageLocatorSchema.optional(),
  maxGasWei: z.string().regex(/^[1-9][0-9]*$/),
}).strict();
export function validateDeliveryPolicy(input: unknown, orderInput: unknown, now = Date.now()) {
  const p = DeliveryPolicySchema.parse(input);
  const order = assertTermixProviderOrder(orderInput, {orderId:p.orderId, providerAgentId:AGENT, listingId:LISTING});
  if (Date.parse(p.expiresAt) <= now || BigInt(p.maxGasWei) > 34000000000000n) throw new Error("Delivery policy expired or gas cap excessive");
  if (order.currency !== (p.currency ?? "USDC") || order.amount !== "5" || order.clientAccountId !== p.clientAccountId || order.onChainOrderId !== p.onChainOrderId || canonicalHash(order.scope) !== p.scopeHash) throw new Error("Order differs from approved delivery policy");
  if (p.buyerMessage) {
    if (!p.intakeHash || p.buyerMessage.orderId !== order.id) throw new Error("Unbound buyer-message intake");
  } else createTermixLendingIntakeFromOrderScope(order);
  return {policy:p,order};
}
export function assertDeliveryWindow(policyInput: unknown, orderInput: unknown, artifactExpiresAt: string, now = Date.now()) {
  const {order}=validateDeliveryPolicy(policyInput,orderInput,now);
  if (!order.deliveryDueAt || Date.parse(order.deliveryDueAt) < now + 120000) throw new Error("Delivery deadline too close or expired");
  if (!Number.isFinite(Date.parse(artifactExpiresAt)) || Date.parse(artifactExpiresAt) < now + 60000) throw new Error("Artifact too close to expiry");
}
export function protectedText(path: string, trim = true) {
  if (!isAbsolute(path)) throw new Error("Credential path must be absolute");
  const st=lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)!==0) throw new Error("Unsafe credential permissions");
  const text=readFileSync(path,"utf8");
  return trim ? text.trim() : text;
}
export function shouldRefreshDelivery(previous: {deliveryRound: number; artifact: {resultExpiresAt: string} | null} | null, redoUsed: boolean, now = Date.now()) {
  return previous?.deliveryRound === (redoUsed ? 2 : 1) && !!previous.artifact && Date.parse(previous.artifact.resultExpiresAt) < now + 120000;
}
export function deliveryJournalName(orderId: string, redoUsed: boolean) {
  return `${orderId}.round-${redoUsed ? 2 : 1}.delivery-signed.json`;
}
export function durableJournal(path: string, content: string) {
  const fd=openSync(path,"wx",0o600);
  try {writeFileSync(fd,content);fsyncSync(fd);} finally {closeSync(fd);}
  const dir=openSync(dirname(path),"r");
  try {fsyncSync(dir);} finally {closeSync(dir);}
}
const json = (v: unknown) => JSON.stringify(v,(_,x)=>typeof x==="bigint"?String(x):x);
async function run() {
  const policyPath=process.env.TERMIX_DELIVERY_POLICY_FILE ?? "";
  const policy=DeliveryPolicySchema.parse(JSON.parse(protectedText(policyPath)));
  const root=process.env.TERMIX_FULFILLMENT_STATE_DIR ?? "";
  if (!isAbsolute(root)) throw new Error("State directory must be absolute");
  mkdirSync(root,{recursive:true,mode:0o700});
  const token=protectedText(process.env.TERMIX_SESSION_TOKEN_FILE ?? "");
  async function get(path:string) {
    const response=await fetch(BASE+path,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error(`TermiX read failed: ${response.status}`);
    return response.json();
  }
  const readOrder=()=>get(`/api/v1/orders/${policy.orderId}`);
  let {order}=validateDeliveryPolicy(policy,await readOrder());
  const journalPath=resolve(root,deliveryJournalName(policy.orderId,order.redoUsed));
  const client=createPublicClient({chain:bsc,transport:http("https://bsc-dataseed.bnbchain.org",{timeout:15000,retryCount:2})});
  if(await client.getChainId()!==56) throw new Error("Wrong chain");
  // Recover an already signed transaction before attempting to generate any new artifact.
  if (existsSync(journalPath)) {
    const signed=JSON.parse(protectedText(journalPath));
    if(keccak256(signed.raw)!==signed.hash) throw new Error("Signed journal mismatch");
    const receipt=await client.getTransactionReceipt({hash:signed.hash}).catch(()=>null);
    if(receipt){if(receipt.status!=="success")throw new Error("Delivery transaction reverted; operator required");console.log(json({event:"delivery.confirmed",hash:signed.hash}));return;}
    const known=await client.getTransaction({hash:signed.hash}).catch(()=>null);
    if(!known) {
      if(Date.parse(signed.expiresAt)<=Date.now()+30000) throw new Error("Signed artifact expired; operator reconciliation required");
      if(!["FUNDED","IN_PROGRESS"].includes(order.status)) throw new Error("Order no longer deliverable");
      assertDeliveryWindow(policy,order,signed.expiresAt);
      await client.sendRawTransaction({serializedTransaction:signed.raw});
    }
    const recovered=await client.waitForTransactionReceipt({hash:signed.hash,timeout:60000});
    if(recovered.status!=="success")throw new Error("Recovered delivery reverted");
    console.log(json({event:"delivery.confirmed",hash:signed.hash}));return;
  }
  if(["DELIVERED","ACCEPTED","SETTLED"].includes(order.status)){console.log(json({event:"delivery.already-complete",status:order.status}));return;}
  if(!["FUNDED","IN_PROGRESS"].includes(order.status)||!order.availableActions.canSubmitDelivery){console.log(json({event:"delivery.waiting",status:order.status}));return;}
  const checkpointPath=resolve(root,`${canonicalHash(policy.orderId).slice(7)}.json`);
  const previous=existsSync(checkpointPath)?verifyTermixFulfillmentCheckpoint(JSON.parse(protectedText(checkpointPath))):null;
  const args=[resolve(process.env.TERMIX_PREPARE_SCRIPT ?? "/opt/positioncrew-termix-orders/prepare-termix-lending-delivery.mjs"),"prepare-delivery","--order",policy.orderId];
  if (policy.buyerMessage) {
    const locatorPath=resolve(root,"buyer-message.json");
    writeFileSync(locatorPath,json(policy.buyerMessage),{mode:0o600});
    args.push("--intake",locatorPath);
  } else args.push("--from-order-scope");
  if(shouldRefreshDelivery(previous,order.redoUsed))args.push("--refresh-expired");
  const prepared=spawnSync(process.execPath,args,{env:{...process.env,TERMIX_AGENT_ID:AGENT,TERMIX_LISTING_ID:LISTING},encoding:"utf8",maxBuffer:2*1024*1024,timeout:180000});
  if(prepared.status!==0) throw new Error(`Delivery preparation failed: ${prepared.stderr.slice(0,1500)}`);
  const checkpoint=verifyTermixFulfillmentCheckpoint(JSON.parse(protectedText(checkpointPath)));
  ({order}=validateDeliveryPolicy(policy,await readOrder()));
  if(!checkpoint.artifact || !checkpoint.submitIntent || checkpoint.orderId!==policy.orderId || !checkpoint.intake)throw new Error("Missing prepared delivery");
  if((policy.intakeHash ?? canonicalHash(createTermixLendingIntakeFromOrderScope(order)))!==checkpoint.intakeHash)throw new Error("Prepared intake changed");
  const artifact=protectedText(checkpoint.artifact.localPath,false);
  if(createHash("sha256").update(artifact).digest("hex")!==checkpoint.artifact.sha256)throw new Error("Local artifact hash mismatch");
  // The preparation tool verifies SHA256 of both local and remote artifact bytes.
  const config=TermixContractsConfigSchema.parse(await get("/api/v1/config/contracts"));
  const guard=assertTermixProviderIntent(order,config,checkpoint.submitIntent,"submitDelivery",{expectedDeliveryHash:checkpoint.artifact.deliveryHash});
  if(guard.intentHash!==checkpoint.submitIntentHash)throw new Error("Intent checkpoint mismatch");
  const i=guard.intent;const to=(i.contract??i.to!) as Hex,data=(i.callData??i.data!) as Hex;
  if (policy.escrow && to.toLowerCase() !== policy.escrow.toLowerCase()) throw new Error("Escrow differs from approved delivery policy");
  await client.call({account:OWNER,to,data,value:0n});
  const gas=(await client.estimateGas({account:OWNER,to,data,value:0n}))*120n/100n;
  const gasPrice=await client.getGasPrice();
  if(gas*gasPrice>BigInt(policy.maxGasWei))throw new Error("Delivery gas exceeds policy");
  if(Date.parse(checkpoint.artifact.resultExpiresAt)<Date.now()+60000)throw new Error("Artifact too close to expiry");
  const account=privateKeyToAccount(protectedText(process.env.TERMIX_DELIVERY_OWNER_KEY_FILE??"") as Hex);
  if(account.address.toLowerCase()!==OWNER.toLowerCase())throw new Error("Wrong signing owner");
  const nonce=await client.getTransactionCount({address:OWNER,blockTag:"pending"});
  if (await client.getTransactionCount({address:OWNER,blockTag:"latest"}) !== nonce) throw new Error("Seller wallet has an unresolved pending transaction");
  assertDeliveryWindow(policy,order,checkpoint.artifact.resultExpiresAt);
  const raw=await account.signTransaction({chainId:56,type:"legacy",to,data,value:0n,gas,gasPrice,nonce});
  const hash=keccak256(raw);
  durableJournal(journalPath,json({raw,hash,expiresAt:checkpoint.artifact.resultExpiresAt}));
  assertDeliveryWindow(policy,order,checkpoint.artifact.resultExpiresAt);
  await client.sendRawTransaction({serializedTransaction:raw});
  const receipt=await client.waitForTransactionReceipt({hash,timeout:60000});
  if(receipt.status!=="success")throw new Error("Delivery reverted");
  console.log(json({event:"delivery.confirmed",orderId:policy.orderId,hash,gasCostBnb:formatEther(receipt.gasUsed*receipt.effectiveGasPrice)}));
}
if(isCliEntrypoint(import.meta.url, process.argv[1], "fulfill-termix-lending"))run().catch(e=>{console.error(json({event:"delivery.failed",error:e.shortMessage??e.message}));process.exitCode=1;});
