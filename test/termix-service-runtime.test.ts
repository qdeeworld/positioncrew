import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {encodeFunctionData,parseAbi,keccak256} from "viem";
const mocks=vi.hoisted(()=>({client:{getChainId:vi.fn(),getTransactionReceipt:vi.fn(),sendRawTransaction:vi.fn(),waitForTransactionReceipt:vi.fn(),getTransactionCount:vi.fn(),call:vi.fn(),estimateGas:vi.fn(),getGasPrice:vi.fn()},sign:vi.fn(),spawn:vi.fn(),probe:vi.fn()}));
vi.mock("viem",async original=>({...await original<typeof import("viem")>(),createPublicClient:()=>mocks.client}));
vi.mock("viem/accounts",()=>({privateKeyToAccount:()=>({address:"0xADd748C416E8A7efd7d65D18Abb121dea268ddF9",signTransaction:mocks.sign})}));
vi.mock("node:child_process",async original=>({...await original<typeof import("node:child_process")>(),spawnSync:mocks.spawn}));
vi.mock("../src/telemetry/bsc.js",()=>({inspectVenusAccount:mocks.probe}));
import {runTermixService,collectRuntimeMessages} from "../src/cli/run-termix-service.js";
import {LENDING_AGENT,LENDING_LISTING} from "../src/commerce/termix-service-policy.js";

let root:string,previousEnv:NodeJS.ProcessEnv,previousArgs:string[],orders:Record<string,any>[],replies:number,messages:unknown[];
const policy={schemaVersion:"positioncrew.termix-service-policy.v1",startsAt:"2026-09-10T17:00:00Z",expiresAt:"2026-09-24T17:00:00Z",chainId:56,providerAgentId:LENDING_AGENT,listingId:LENDING_LISTING,currency:"USDC",amount:"5",escrow:`0x${"22".repeat(20)}`,maxGasWei:"34000000000000",maxTotalGasWei:"2040000000000000",maxRollingGasWei:"408000000000000",maxOrders:20};
function order(n=1){const id=`cmtvlt4q41b4tw001odmxvhk${n}`;return {id,chainOrderId:`0x${String(n).padStart(64,"0")}`,status:"PENDING_ACCEPT",buyer:{id:"buyer",clientAgentId:"buyer-agent"},seller:{id:LENDING_AGENT},listingId:LENDING_LISTING,budget:"5",currency:"USDC",createdAt:"2026-09-10T17:30:00Z",deadlines:{deliveryDueAt:"2026-09-12T17:30:00Z"},redoUsed:false,availableActions:{canSubmitDelivery:false},conversation:{id:"chat"},scope:`Buyer requirements:\n${JSON.stringify({schemaVersion:"positioncrew.termix-lending-buyer-request.v1",orderId:id,account:`0x${"44".repeat(20)}`,targetHealthFactor:"1.25",stressPriceDropBps:1000,maxActionUsd:"250",maxGasUsd:"0.1",maxSlippageBps:30})}`};}
beforeEach(()=>{
 vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-10T18:00:00Z"));vi.clearAllMocks();
 previousEnv={...process.env};previousArgs=process.argv;process.argv=["node","test","--execute"];
 root=mkdtempSync(join(tmpdir(),"pc-service-"));orders=[order()];replies=0;messages=[];
 for(const [name,value] of Object.entries({policy:JSON.stringify(policy),session:"test-session",runtime:"test-runtime",key:"test-key"}))writeFileSync(join(root,name),value,{mode:0o600});
 Object.assign(process.env,{TERMIX_SERVICE_POLICY_FILE:join(root,"policy"),TERMIX_SESSION_TOKEN_FILE:join(root,"session"),TERMIX_RUNTIME_TOKEN_FILE:join(root,"runtime"),TERMIX_DELIVERY_OWNER_KEY_FILE:join(root,"key"),TERMIX_SERVICE_STATE_DIR:join(root,"state")});
 mocks.client.getChainId.mockResolvedValue(56);mocks.client.getTransactionReceipt.mockResolvedValue({status:"success"});mocks.client.waitForTransactionReceipt.mockResolvedValue({status:"success"});mocks.client.getTransactionCount.mockResolvedValue(3);mocks.client.call.mockResolvedValue({data:"0x"});mocks.client.estimateGas.mockResolvedValue(100000n);mocks.client.getGasPrice.mockResolvedValue(100000000n);mocks.sign.mockResolvedValue("0x12");mocks.probe.mockResolvedValue({});
 mocks.client.sendRawTransaction.mockImplementation(async()=>{orders[0]!.status="FUNDED";orders[0]!.availableActions.canSubmitDelivery=true;return keccak256("0x12");});
 mocks.spawn.mockImplementation(()=>{orders[0]!.status="DELIVERED";orders[0]!.availableActions.canSubmitDelivery=false;return {status:0,stdout:"",stderr:""};});
 vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(String(input));let value:unknown;
  if(url.pathname==="/api/v1/config/contracts")value={chainId:56,settlementCurrencies:[{symbol:"USDC",address:`0x${"33".repeat(20)}`,decimals:18,providerLockBps:0,contracts:{escrow:policy.escrow}}]};
  else if(url.pathname==="/api/v1/orders")value={items:orders,page:1,totalPages:1};
  else if(url.pathname.endsWith("/provider-accept/prepare")){const o=orders.find(o=>url.pathname.includes(o.id))!;value={id:"intent",status:"PREPARED",nonceKey:"nonce",action:"acceptOrder",chainId:56,value:"0",contract:policy.escrow,callData:encodeFunctionData({abi:parseAbi(["function acceptOrder(bytes32 orderId)"]),functionName:"acceptOrder",args:[o.chainOrderId]})};}
  else if(url.pathname==="/api/v1/a2a/runtime/inbox")value={items:messages};
  else if(url.pathname==="/api/v1/a2a/runtime/reply"){replies++;expect(init?.method).toBe("POST");value={};}
  else value=orders.find(o=>url.pathname===`/api/v1/orders/${o.id}`);
  if(!value)throw new Error(`Unexpected endpoint ${url.pathname}`);
  return new Response(JSON.stringify(value),{status:200,headers:{"Content-Type":"application/json"}});
 }));
 vi.spyOn(console,"log").mockImplementation(()=>{});
});
afterEach(()=>{process.env=previousEnv;process.argv=previousArgs;process.exitCode=0;rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
describe("service coordinator integration with simulated chain and authenticated API",()=>{
 it("accepts and dispatches a new paid order once, then ignores repeat settled/delivered events",async()=>{
  await runTermixService();expect(mocks.sign).toHaveBeenCalledTimes(1);expect(mocks.spawn).toHaveBeenCalledTimes(1);
  const ledger=JSON.parse(readFileSync(join(root,"state","ledger.json"),"utf8"));expect(Object.keys(ledger.reservations)).toEqual([orders[0]!.id]);
  await runTermixService();expect(mocks.sign).toHaveBeenCalledTimes(1);expect(mocks.spawn).toHaveBeenCalledTimes(1);
 });
 it("resumes accepted delivery inside the ten-minute admission cutoff",async()=>{
  const expiry=new Date(Date.now()+660000).toISOString();
  writeFileSync(join(root,"policy"),JSON.stringify({...policy,expiresAt:expiry}),{mode:0o600});orders[0]!.deadlines.deliveryDueAt=expiry;
  mocks.spawn.mockReturnValueOnce({status:1,stderr:"temporary failure"});await runTermixService();
  vi.setSystemTime(new Date(Date.now()+420000));await runTermixService();
  expect(mocks.sign).toHaveBeenCalledTimes(1);expect(mocks.spawn).toHaveBeenCalledTimes(2);
 });
 it("overlaps timestamp boundaries and retains a correction beside the hundredth message",async()=>{
  const start="2026-09-10T17:30:00Z", boundary="2026-09-10T17:31:00.000Z";
  const first=Array.from({length:100},(_,i)=>({messageId:`m-${i}`,createdAt:i===99 ? boundary : new Date(Date.parse(start)+i).toISOString()}));
  const correction={messageId:"correction",createdAt:boundary};
  const poll=vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([first[99],correction]);
  const result=await collectRuntimeMessages(poll,start);expect(result).toHaveLength(101);expect(result).toContainEqual(correction);expect(poll.mock.calls[1]![0]).toBe("2026-09-10T17:30:59.999Z");
 });
 it("fails closed when a timestamp page repeats without exposing its remaining messages",async()=>{
  const batch=Array.from({length:100},(_,i)=>({messageId:`m-${i}`,createdAt:"2026-09-10T17:31:00Z"}));
  await expect(collectRuntimeMessages(vi.fn().mockResolvedValue(batch),"2026-09-10T17:30:00Z")).rejects.toThrow("saturated timestamp");
 });
 it("asks for missing inputs once and never accepts ambiguous work",async()=>{
  orders[0]!.scope="ambiguous";await runTermixService();await runTermixService();expect(replies).toBe(1);expect(mocks.sign).not.toHaveBeenCalled();expect(mocks.spawn).not.toHaveBeenCalled();
 });
 it("rejects a chat correction arriving during the live account read before reserving or signing",async()=>{
  const text=orders[0]!.scope.split("Buyer requirements:\n")[1];orders[0]!.scope="Needs clarification";
  const initial={messageId:"first",conversationId:"chat",conversationKind:"ORDER_DELIVERY",orderId:orders[0]!.id,kind:"TEXT",text,from:{accountId:"buyer",walletAddress:`0x${"44".repeat(20)}`},createdAt:"2026-09-10T17:40:00Z"};
  messages=[initial];mocks.probe.mockImplementationOnce(async()=>{messages.push({...initial,messageId:"correction",text:JSON.stringify({...JSON.parse(text),maxActionUsd:"1"}),createdAt:"2026-09-10T17:41:00Z"});return {};});
  await runTermixService();expect(mocks.sign).not.toHaveBeenCalled();expect(existsSync(join(root,"state","ledger.json"))).toBe(false);
 });
 it("does not accept when the supported account cannot be observed",async()=>{
  mocks.probe.mockRejectedValueOnce(new Error("Oracle unavailable"));await runTermixService();expect(mocks.sign).not.toHaveBeenCalled();expect(mocks.spawn).not.toHaveBeenCalled();
 });
 it("persists the exact acceptance signature before a broadcast outage and recovers without signing again",async()=>{
  mocks.client.sendRawTransaction.mockRejectedValueOnce(new Error("RPC unavailable"));await runTermixService();expect(mocks.sign).toHaveBeenCalledTimes(1);
  const signed=JSON.parse(readFileSync(join(root,"state",orders[0]!.id,"accept-signed.json"),"utf8"));expect(signed.hash).toBe(keccak256(signed.raw));
  mocks.client.getTransactionReceipt.mockRejectedValueOnce(Object.assign(new Error("not found"),{name:"TransactionReceiptNotFoundError"}));
  await runTermixService();expect(mocks.sign).toHaveBeenCalledTimes(1);expect(mocks.client.sendRawTransaction).toHaveBeenLastCalledWith({serializedTransaction:signed.raw});expect(mocks.spawn).toHaveBeenCalledTimes(1);
 });
 it("does not rebroadcast when the receipt read fails for an unknown RPC reason",async()=>{
  await runTermixService();mocks.client.getTransactionReceipt.mockRejectedValueOnce(new Error("RPC timeout"));await expect(runTermixService()).rejects.toThrow("RPC timeout");expect(mocks.client.sendRawTransaction).toHaveBeenCalledTimes(1);
 });
 it("stops the signing batch after an ambiguous child failure",async()=>{
  orders.push(order(2));mocks.spawn.mockReturnValueOnce({status:1,stderr:"failure"});await runTermixService();expect(mocks.sign).toHaveBeenCalledTimes(1);expect(mocks.spawn).toHaveBeenCalledTimes(1);
 });
 it("skips a malformed unrelated job without starving valid orders",async()=>{
  orders.unshift({...order(2),budget:"100"});await runTermixService();expect(mocks.sign).toHaveBeenCalledTimes(1);
 });
 it("never signs or replies in dry-run mode",async()=>{
  process.argv=["node","test"];await runTermixService();expect(mocks.probe).toHaveBeenCalled();expect(mocks.sign).not.toHaveBeenCalled();expect(mocks.spawn).not.toHaveBeenCalled();expect(replies).toBe(0);
 });
});
