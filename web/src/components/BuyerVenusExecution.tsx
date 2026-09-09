import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { buyerWalletAccount, sendBuyerWalletStep } from "../buyer-wallet.js";
import type { BuyerVenusState } from "../../../src/commerce/d1-buyer-venus-store.js";
import type { BuyerVenusStep } from "../../../src/commerce/buyer-venus-policy.js";

interface Reply { state: BuyerVenusState | null; step?: BuyerVenusStep; pending?: boolean; reverted?: boolean; details?: string[]; }
interface Pending { step: number | "withdraw"; transactionHash: string | null; awaitingWallet: boolean; }
const short = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`;
const units = (raw: string, decimals: number) => formatUnits(BigInt(raw), decimals);

export function BuyerVenusExecution({ receiptId }: { receiptId: string }) {
  const [state, setState] = useState<BuyerVenusState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading saved execution status…");
  const [consent, setConsent] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const inFlight = useRef(false);
  const storageKey = `positioncrew.buyer-venus.v1:${receiptId}`;
  const endpoint = `/api/buyer-venus/${receiptId}`;

  async function api(action?: string, input?: unknown): Promise<Reply> {
    const response = await fetch(action ? `${endpoint}/${action}` : endpoint, action ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input ?? {}), cache: "no-store", signal: AbortSignal.timeout(25_000),
    } : { cache: "no-store", signal: AbortSignal.timeout(25_000) });
    const reply = await response.json() as Reply;
    if (!response.ok) throw new Error(reply.details?.[0] ?? `Execution service returned HTTP ${response.status}.`);
    setState(reply.state);
    return reply;
  }
  function savePending(value: Pending | null) {
    // Persist the uncertainty marker before invoking a wallet. A crash or lost
    // wallet response must not offer an automatic second transaction.
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
    setPending(value);
  }
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Execution verification is unavailable."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    let cancelled = false;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const value = JSON.parse(saved) as Pending;
        if ((value.step === "withdraw" || [0, 1, 2].includes(value.step)) &&
          (value.transactionHash === null || /^0x[0-9a-fA-F]{64}$/.test(value.transactionHash))) setPending(value);
      }
    } catch { setError("Browser recovery storage is unavailable. Enable it before sending a transaction."); }
    void fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(25_000) }).then(async response => {
      if (!response.ok) throw new Error("Saved execution status could not be loaded.");
      const reply = await response.json() as Reply;
      if (cancelled) return;
      setState(reply.state); setMessage("");
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Status unavailable."); });
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [endpoint, storageKey]);

  async function prepare() {
    const account = await buyerWalletAccount(true);
    await api("prepare", { account });
    setConsent(false); setMessage("Review the exact amount and costs below. Your wallet will ask for each transaction separately.");
  }
  async function confirm(saved: Pending) {
    if (!saved.transactionHash) throw new Error("Check your wallet activity for this transaction. Enter its hash below to recover; do not send another transaction.");
    const reply = saved.step === "withdraw"
      ? await api("withdraw-confirm", { transactionHash: saved.transactionHash })
      : await api("confirm", { step: saved.step, transactionHash: saved.transactionHash });
    if (reply.pending) { setMessage("Transaction recorded. Waiting for 15 BSC confirmations; you can safely reload this page."); return; }
    savePending(null); setConsent(false);
    if (reply.reverted) { setMessage("The withdrawal reverted and spent gas. Your shares were not redeemed. Check availability and review a fresh quote before trying again."); return; }
    setMessage(saved.step === "withdraw" ? "Withdrawal verified: the underlying USDT was delivered to your wallet." : reply.state?.supplyProof ? "Supply verified: your wallet received vUSDT." : "Exact token allowance confirmed. Review the next transaction.");
  }
  async function send(index: number | "withdraw") {
    if (!state || !consent) throw new Error("Review and confirm the transaction details first.");
    const reply = index === "withdraw" ? await api("withdraw-preflight") : await api("preflight", { step: index });
    if (!reply.step || !reply.state) throw new Error("No verified transaction was returned.");
    const reviewedStep = index === "withdraw" && state.withdrawal ? {
      kind: "WITHDRAW", to: state.intent.market, data: state.withdrawal.data, value: "0x0", nonce: state.withdrawal.nonce,
      gas: state.withdrawal.gas, gasPrice: state.withdrawal.gasPrice,
    } : index !== "withdraw" ? state.intent.steps[index] : null;
    if (JSON.stringify(reply.state.intent) !== JSON.stringify(state.intent) || !reviewedStep ||
      ["kind", "to", "data", "value", "nonce", "gas", "gasPrice"].some(key =>
        (reviewedStep as Record<string, unknown>)[key] !== (reply.step as unknown as Record<string, unknown>)[key]) ||
      (index === "withdraw" && JSON.stringify(reply.state.withdrawal) !== JSON.stringify(state.withdrawal))) {
      setConsent(false);
      throw new Error("The transaction details changed after your review. Review the updated details before approving again.");
    }
    const expiresAt = index === "withdraw" ? reply.state.withdrawal!.expiresAt : reply.state.intent.expiresAt;
    savePending({ step: index, transactionHash: null, awaitingWallet: true });
    setMessage("Check the wallet, network, token, amount and maximum gas in your wallet before approving.");
    let hash: string;
    try { hash = await sendBuyerWalletStep(reply.state.intent.account, reply.step, expiresAt); }
    catch (cause) {
      // EIP-1193 user rejection proves no transaction was authorized. Other
      // failures can follow a broadcast and must retain the uncertainty marker.
      if (typeof cause === "object" && cause !== null && (("code" in cause && cause.code === 4001) || ("notBroadcast" in cause && cause.notBroadcast === true))) savePending(null);
      throw cause;
    }
    const saved: Pending = { step: index, transactionHash: hash, awaitingWallet: false };
    savePending(saved);
    await confirm(saved);
  }
  const intent = state?.intent;
  const nextIndex = state?.intent.steps.findIndex((_, i) => !state.confirmedSteps.includes(i)) ?? -1;
  const nextStep = nextIndex >= 0 ? state?.intent.steps[nextIndex] : undefined;
  const recordedHash = state?.withdrawal?.transactionHash && !state.withdrawal.proof
    ? { step: "withdraw" as const, transactionHash: state.withdrawal.transactionHash, awaitingWallet: false }
    : nextIndex >= 0 && state?.transactions[String(nextIndex)] ? { step: nextIndex, transactionHash: state.transactions[String(nextIndex)]!, awaitingWallet: false } : null;
  const outstanding = pending ?? recordedHash;
  useEffect(() => {
    if (!outstanding?.transactionHash) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      if (inFlight.current) return;
      if (++attempts > 10) { window.clearInterval(timer); return; }
      void run(() => confirm(outstanding));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [outstanding?.transactionHash, outstanding?.step]);
  const expired = intent ? clock >= Date.parse(intent.expiresAt) : false;
  const withdrawalExpired = state?.withdrawal ? clock >= Date.parse(state.withdrawal.expiresAt) : false;
  const [recoveryHash, setRecoveryHash] = useState("");

  return <section className="activation-sandbox buyer-venus" aria-labelledby="buyer-venus-title" aria-busy={busy}>
    <div className="activation-sandbox__intro">
      <span className="eyebrow">Buyer-approved · BSC mainnet</span>
      <h2 id="buyer-venus-title">Supply the USDT your assessment recommends</h2>
      <p>Use USDT already in the assessed wallet. PositionCrew checks the recommendation again, then your wallet approves the exact allowance and supply. The received vUSDT remains in your wallet.</p>
    </div>
    {!intent && <button type="button" className="primary-action" disabled={busy || Boolean(outstanding)} onClick={() => void run(prepare)}>Connect wallet and review this recommendation</button>}
    {intent && <>
      <dl className="buyer-venus__facts">
        <div><dt>Wallet</dt><dd>{short(intent.account)}</dd></div>
        <div><dt>USDT to supply</dt><dd>{units(intent.amountRaw, 18)}</dd></div>
        <div><dt>Maximum entry gas</dt><dd>{units(intent.maxGasCostWei, 18)} BNB</dd></div>
        <div><dt>Estimated withdrawal gas reserve</dt><dd>{units(intent.expectedWithdrawalGasWei, 18)} BNB</dd></div>
        <div><dt>Estimated protocol exit fee</dt><dd>${intent.expectedProtocolExitFeeUsd}</dd></div>
        <div><dt>Projected benefit after round-trip costs</dt><dd>${intent.projectedNetBenefitUsd}</dd></div>
      </dl>
      <details><summary>Inspect the exact asset and market</summary><p>Token: <code>{intent.token}</code><br />Venus market: <code>{intent.market}</code><br />Assessment: <a href={`/api/benchmark-receipts/${receiptId}`} target="_blank" rel="noreferrer">Original provider receipt</a></p></details>
      <p className="activation-sandbox__boundary">Rates, prices, gas and withdrawal liquidity can change. The review expires before signing; an already signed Venus transaction has no automatic onchain expiry or minimum-receipt protection. Read the wallet request before approving.</p>
      {!state?.supplyProof && !outstanding && nextStep && <>
        {expired ? <p role="status">The recommendation expired. Refresh current markets and run a new assessment. Any existing approval remains visible in your wallet.</p> : <>
          <label className="buyer-venus__consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>I reviewed the wallet, amount, costs and protocol risks for this transaction.</span></label>
          <button type="button" className="primary-action" disabled={busy || !consent} onClick={() => void run(() => send(nextIndex))}>
            {nextStep.kind === "RESET_APPROVAL" ? "Reset the existing USDT allowance" : nextStep.kind === "APPROVE" ? "Approve this exact USDT allowance" : "Supply this exact USDT amount"}
          </button>
        </>}
      </>}
    </>}
    {outstanding && <div className="buyer-venus__pending">
      {outstanding.transactionHash ? <>
        <p>Transaction recorded: <a href={`https://bscscan.com/tx/${outstanding.transactionHash}`} target="_blank" rel="noreferrer">Check wallet transaction</a></p>
        <button type="button" disabled={busy} onClick={() => void run(() => confirm(outstanding))}>Check confirmation</button>
      </> : <>
        <p role="status">A wallet request was started, but its outcome is unknown. Check wallet activity before taking another action.</p>
        <label><span>Transaction hash from your wallet</span><input value={recoveryHash} onChange={event => setRecoveryHash(event.target.value.trim())} placeholder="0x…" spellCheck={false} /></label>
        <button type="button" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash)} onClick={() => void run(async () => { const saved = { ...outstanding, transactionHash: recoveryHash, awaitingWallet: false }; savePending(saved); await confirm(saved); })}>Recover this transaction</button>
        <p>If your wallet shows no submitted transaction, recheck this step before retrying.</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          if (outstanding.step === "withdraw") await api("withdraw-preflight"); else await api("preflight", { step: outstanding.step });
          savePending(null); setConsent(false); setMessage("The original transaction is still eligible. Review it again before opening your wallet.");
        })}>Recheck the original transaction</button>
      </>}
    </div>}
    {state?.supplyProof && <div className="buyer-venus__position">
      <h3>Your verified Venus position</h3>
      {state.failedWithdrawals?.map(failure => <p key={failure.transactionHash}>A previous withdrawal reverted and spent {units(failure.actualGasWei, 18)} BNB gas. <a href={`https://bscscan.com/tx/${failure.transactionHash}`} target="_blank" rel="noreferrer">Inspect failed withdrawal</a></p>)}
      <p>{units(state.supplyProof.mintedSharesRaw, 8)} vUSDT received; underlying value at confirmation: {units(state.supplyProof.underlyingValueRaw, 18)} USDT.</p>
      <p><a href={`https://bscscan.com/tx/${state.supplyProof.transactionHash}`} target="_blank" rel="noreferrer">Supply transaction</a> · <a href={endpoint} target="_blank" rel="noreferrer">Saved execution receipt</a></p>
      {!state.supplyProof.withinSupplyGasLimit && <p role="alert">Actual supply gas exceeded the reviewed gas limit. Inspect the wallet transaction before further action.</p>}
      {state.withdrawal?.proof ? <p role="status">Withdrawn: {units(state.withdrawal.proof.receivedUnderlyingRaw, 18)} USDT delivered. <a href={`https://bscscan.com/tx/${state.withdrawal.proof.transactionHash}`} target="_blank" rel="noreferrer">Withdrawal transaction</a></p> : !outstanding && <>
        <p>Withdraw only the shares minted by this deposit. Available protocol cash and sufficient BNB gas are required.</p>
        <button type="button" disabled={busy} onClick={() => void run(async () => { await api("withdraw-quote"); setConsent(false); setMessage("Review the fresh withdrawal quote before approving in your wallet."); })}>{state.withdrawal ? "Refresh withdrawal quote" : "Check withdrawal availability"}</button>
        {state.withdrawal && <>
          <p>Expected receipt: {units(state.withdrawal.expectedUnderlyingRaw, 18)} USDT. Maximum gas: {units((BigInt(state.withdrawal.gas) * BigInt(state.withdrawal.gasPrice)).toString(), 18)} BNB.</p>
          {withdrawalExpired ? <p>Refresh this expired quote before signing.</p> : <>
            <label className="buyer-venus__consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>I reviewed this withdrawal and its maximum gas cost.</span></label>
            <button type="button" className="primary-action" disabled={busy || !consent} onClick={() => void run(() => send("withdraw"))}>Withdraw this deposit to my wallet</button>
          </>}
        </>}
      </>}
    </div>}
    {message && <p role="status" aria-live="polite">{message}</p>}
    {error && <p className="wallet-probe-error" role="alert">{error}</p>}
  </section>;
}
