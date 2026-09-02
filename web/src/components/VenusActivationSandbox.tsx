import { useEffect, useMemo, useState } from "react";
import { ExternalLink, LoaderCircle, LockKeyhole, ShieldCheck, TestTube2 } from "lucide-react";

interface ActivationRecord {
  activationId: string;
  state: "CREATED" | "RUNNING" | "CONFIRMED" | "COMPLETED" | "FAILED";
  receiptId: string | null;
  receipt: {
    transaction?: { hash?: string; explorerUrl?: string; vTokenDelta?: string };
    authority?: { expiry?: number; selector?: string; target?: string };
  } | null;
  error: { message: string } | null;
}

export function VenusActivationSandbox({ hireId, receiptId }: { hireId: string; receiptId: string }) {
  const [activation, setActivation] = useState<ActivationRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const idempotencyKey = useMemo(
    () => `venus-sandbox:${receiptId}`,
    [receiptId],
  );

  useEffect(() => {
    if (!activation || !["CREATED", "RUNNING", "CONFIRMED"].includes(activation.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/activations/${activation.activationId}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Status returned HTTP ${response.status}`);
        setActivation(await response.json() as ActivationRecord);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Activation status is temporarily unavailable.");
      }
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [activation]);

  async function activate() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/activations/venus-testnet-supply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "positioncrew.altana-venus-activation.request.v1",
          sourceHireId: hireId,
          sourceReceiptId: receiptId,
          idempotencyKey,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const apiError = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error.replaceAll("_", " ")
          : `Activation returned HTTP ${response.status}`;
        throw new Error(apiError);
      }
      setActivation(body as ActivationRecord);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sandbox action could not be started.");
    } finally {
      setStarting(false);
    }
  }

  const pending = starting || activation?.state === "CREATED" || activation?.state === "RUNNING" || activation?.state === "CONFIRMED";
  return (
    <section className="activation-sandbox" aria-labelledby="activation-sandbox-title">
      <div className="activation-sandbox__intro">
        <span className="eyebrow"><TestTube2 size={15} /> Optional BSC Testnet proof</span>
        <h2 id="activation-sandbox-title">See bounded authority become an onchain action</h2>
        <p>
          PositionCrew can now bind this completed decision to one founder-funded testnet supply. The delegated key can call only Venus
          <code> mint()</code>, for exactly 0.0001 tBNB, before its published expiry.
        </p>
      </div>
      <div className="activation-sandbox__limits" aria-label="Authority limits">
        <span><LockKeyhole size={16} /><strong>One method</strong><small>Venus mint()</small></span>
        <span><ShieldCheck size={16} /><strong>Fixed value</strong><small>0.0001 tBNB</small></span>
        <span><TestTube2 size={16} /><strong>Sandbox only</strong><small>No user wallet</small></span>
      </div>
      <p className="activation-sandbox__boundary">
        This does not execute the mainnet recommendation or use your funds. Capacity is deliberately small; unavailable budget fails closed.
      </p>
      {!activation && (
        <button className="primary-action" type="button" onClick={activate} disabled={pending}>
          {starting ? <><LoaderCircle className="spin" size={17} /> Starting bounded action</> : "Run 0.0001 tBNB sandbox action"}
        </button>
      )}
      {activation && (
        <div className={`activation-sandbox__status activation-sandbox__status--${activation.state.toLowerCase()}`} aria-live="polite">
          <strong>{activation.state === "COMPLETED" ? "Onchain proof complete" : activation.state.replaceAll("_", " ")}</strong>
          {pending && <span><LoaderCircle className="spin" size={16} /> Waiting for confirmed BSC Testnet evidence</span>}
          {activation.state === "FAILED" && <span>{activation.error?.message ?? "The bounded action failed closed."}</span>}
          {activation.state === "COMPLETED" && activation.receipt?.transaction && (
            <>
              <span>Positive vBNB delta: {activation.receipt.transaction.vTokenDelta ?? "recorded"}</span>
              {activation.receipt.transaction.explorerUrl && (
                <a href={activation.receipt.transaction.explorerUrl} target="_blank" rel="noreferrer">
                  Inspect transaction <ExternalLink size={14} />
                </a>
              )}
              {activation.receiptId && <a href={`/api/activation-receipts/${activation.receiptId}`} target="_blank" rel="noreferrer">Open durable activation receipt <ExternalLink size={14} /></a>}
            </>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
