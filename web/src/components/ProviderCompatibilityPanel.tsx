import { useState } from "react";
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  LoaderCircle,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { serviceLabel } from "../presentation";
import type { ServiceId } from "../types";

type CheckStatus = "PASS" | "FAIL" | "NOT_PROVEN";

interface PreflightCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  details: string[];
}

interface PreflightResult {
  schemaVersion: "positioncrew.provider-contract-preflight-result.v1";
  validatorVersion: string;
  outcome: "CONTRACT_PASS" | "CONTRACT_FAIL";
  service: ServiceId | null;
  inputHash: string;
  resultHash: string;
  checks: PreflightCheck[];
  claimBoundary: string;
}

interface TemplateResponse {
  schemaVersion: "positioncrew.provider-contract-preflight-templates.v1";
  validatorVersion: string;
  templates: Record<ServiceId, Record<string, unknown>>;
  claimBoundary: string;
}

const SERVICES: ServiceId[] = [
  "LENDING_RESCUE",
  "LP_REBALANCE",
  "YIELD_OPTIMIZATION",
  "BOUNDED_GRID",
];

export function ProviderCompatibilityPanel() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ServiceId>("LENDING_RESCUE");
  const [templates, setTemplates] = useState<TemplateResponse | null>(null);
  const [packet, setPacket] = useState("");
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadTemplates(nextCategory = category) {
    setLoadingTemplates(true);
    setError(null);
    try {
      const response = await fetch("/api/provider-contract-preflight", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Template request failed (${response.status})`);
      const payload = await response.json() as TemplateResponse;
      const template = payload.templates[nextCategory];
      if (!template) throw new Error(`No ${serviceLabel(nextCategory)} reference packet is available`);
      setTemplates(payload);
      setPacket(JSON.stringify(template, null, 2));
      setResult(null);
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "Provider packet templates are unavailable");
    } finally {
      setLoadingTemplates(false);
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !templates && !loadingTemplates) void loadTemplates();
  }

  function selectCategory(service: ServiceId) {
    setCategory(service);
    setResult(null);
    setError(null);
    const template = templates?.templates[service];
    if (template) setPacket(JSON.stringify(template, null, 2));
  }

  async function runCheck() {
    setChecking(true);
    setResult(null);
    setError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(packet) as unknown;
      } catch {
        throw new Error("Packet must be valid JSON before it can be checked");
      }
      const response = await fetch("/api/provider-contract-preflight", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { details?: unknown } | null;
        throw new Error(Array.isArray(body?.details) ? String(body.details[0]) : `Contract check failed (${response.status})`);
      }
      setResult(await response.json() as PreflightResult);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Provider packet check failed");
    } finally {
      setChecking(false);
    }
  }

  function downloadResult() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(result, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `positioncrew-${(result.service ?? "provider").toLowerCase()}-contract-preflight.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="provider-preflight" aria-labelledby="provider-preflight-heading">
      <div className="provider-preflight-intro">
        <div className="provider-preflight-mark"><Braces size={20} aria-hidden="true" /></div>
        <div>
          <span className="page-kicker">Operator onboarding seam</span>
          <h2 id="provider-preflight-heading">Check a provider packet against the contract.</h2>
          <p>Submit a manifest, representative request, actionable example, and explicit refusal. PositionCrew checks JSON conformance only; it never calls the supplied provider.</p>
        </div>
        <button type="button" aria-expanded={open} aria-controls="provider-preflight-body" onClick={toggleOpen}>
          {open ? "Close preflight" : "Check a provider packet"}
          {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
        </button>
      </div>

      {open && (
        <div className="provider-preflight-body" id="provider-preflight-body">
          <div className="provider-preflight-controls">
            <label>
              <span>Capital-service contract</span>
              <select value={category} onChange={(event) => selectCategory(event.target.value as ServiceId)} disabled={loadingTemplates || checking}>
                {SERVICES.map((service) => <option key={service} value={service}>{serviceLabel(service)}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void loadTemplates(category)} disabled={loadingTemplates || checking}>
              {loadingTemplates ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Braces size={14} aria-hidden="true" />}
              {loadingTemplates ? "Loading" : "Reset reference packet"}
            </button>
          </div>
          <label className="provider-packet-editor">
            <span>Provider packet JSON</span>
            <textarea
              aria-label="Provider packet JSON"
              value={packet}
              onChange={(event) => {
                setPacket(event.target.value);
                setResult(null);
                setError(null);
              }}
              disabled={loadingTemplates || checking}
              spellCheck={false}
            />
          </label>
          <div className="provider-preflight-submit">
            <p><ShieldQuestion size={14} aria-hidden="true" /> No URL fetch · no wallet · no persistence · no score</p>
            <button type="button" onClick={() => void runCheck()} disabled={loadingTemplates || checking || packet.trim().length === 0}>
              {checking ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
              {checking ? "Checking contract" : "Run contract check"}
            </button>
          </div>
          {error && <div className="provider-preflight-error" role="alert"><AlertTriangle size={15} aria-hidden="true" /> {error}</div>}
          {result && (
            <div className={`provider-preflight-result ${result.outcome === "CONTRACT_PASS" ? "pass" : "fail"}`} aria-live="polite">
              <div className="provider-preflight-result-head">
                <div>
                  {result.outcome === "CONTRACT_PASS" ? <CheckCircle2 size={18} aria-hidden="true" /> : <XCircle size={18} aria-hidden="true" />}
                  <span>
                    <strong>{result.outcome === "CONTRACT_PASS" ? "Packet conformance passed" : "Packet conformance failed"}</strong>
                    <small>{result.service ? serviceLabel(result.service) : "Unbound packet"}</small>
                    <small className="provider-preflight-result-qualifier">Provider not verified; activation unavailable.</small>
                  </span>
                </div>
                <button type="button" onClick={downloadResult}><Download size={14} aria-hidden="true" /> Download result</button>
              </div>
              <dl className="provider-preflight-hashes">
                <div><dt>Input hash</dt><dd><code>{result.inputHash}</code></dd></div>
                <div><dt>Result hash</dt><dd><code>{result.resultHash}</code></dd></div>
                <div><dt>Validator</dt><dd><code>{result.validatorVersion}</code></dd></div>
              </dl>
              <ol className="provider-preflight-checks">
                {result.checks.map((check) => (
                  <li className={check.status.toLowerCase().replace("_", "-")} key={check.id}>
                    <span>{check.status}</span>
                    <div><strong>{check.summary}</strong>{check.details.map((detail) => <small key={detail}>{detail}</small>)}</div>
                  </li>
                ))}
              </ol>
              <p className="provider-preflight-boundary">{result.claimBoundary}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
