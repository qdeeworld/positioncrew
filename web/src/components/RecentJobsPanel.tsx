import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Play, RefreshCw, Trash2 } from "lucide-react";
import {
  clearRecentJobReferences,
  isFreshMarketplaceChainForReference,
  isRecentJobChangeDetail,
  readRecentJobReferences,
  RECENT_JOB_CHANGED_EVENT,
  RECENT_JOB_STORAGE_KEY,
  removeRecentJobReference,
  sessionJobFromFreshChain,
  type RecentJobHistoryRead,
  type RecentJobReference,
} from "../job-history";
import type { FreshMarketplaceChain, ServiceId, SessionJob } from "../types";

const SERVICE_NAMES: Record<ServiceId, string> = {
  LENDING_RESCUE: "Lending Rescue",
  LP_REBALANCE: "LP Rebalance",
  YIELD_OPTIMIZATION: "Yield Optimisation",
  BOUNDED_GRID: "Bounded Grid",
};
const POLL_DELAY_MS = 500;
const POLL_LIMIT = 60;

type LoadPhase = "LOADING" | "READY" | "UNAVAILABLE";

interface RecentJobItem {
  reference: RecentJobReference;
  phase: LoadPhase;
  chain: FreshMarketplaceChain | null;
  busy: boolean;
  error: string | null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Server status unavailable";
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "Time unavailable";
}

async function retrieveChain(reference: RecentJobReference): Promise<FreshMarketplaceChain> {
  const response = await fetch(`/api/benchmark-hires/${encodeURIComponent(reference.hireId)}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isFreshMarketplaceChainForReference(payload, reference)) {
    throw new Error("Server receipt did not match this device reference");
  }
  return payload;
}

function stateCopy(item: RecentJobItem): { label: string; detail: string } {
  if (item.phase === "LOADING") {
    return { label: "Checking", detail: "Checking server status..." };
  }
  if (item.phase === "UNAVAILABLE") {
    return { label: "Unavailable", detail: "Server status unavailable; this device reference was retained." };
  }

  switch (item.chain?.job.state) {
    case "CREATED":
      return { label: "Recorded", detail: "Recorded, not started." };
    case "RUNNING":
      return { label: "Running", detail: "Provider is evaluating." };
    case "FAILED":
      return { label: "Failed", detail: `Run failed: ${item.chain.job.error ?? "No server detail was provided."}` };
    case "COMPLETED":
      return { label: "Completed", detail: "Result and receipt are ready." };
    default:
      return { label: "Unavailable", detail: "Server status unavailable; this device reference was retained." };
  }
}

export function RecentJobsPanel({ onOpenJob }: { onOpenJob: (job: SessionJob) => void }) {
  const mounted = useRef(true);
  const suppressedIds = useRef(new Set<string>());
  const trackedIds = useRef(new Set<string>());
  const [items, setItems] = useState<RecentJobItem[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [corruptCount, setCorruptCount] = useState(0);

  const updateItem = useCallback((reference: RecentJobReference, patch: Partial<RecentJobItem>) => {
    if (!mounted.current || suppressedIds.current.has(reference.hireId)) {
      return;
    }
    setItems((current) => {
      const existing = current.find((item) => item.reference.hireId === reference.hireId);
      const next: RecentJobItem = {
        reference,
        phase: "LOADING",
        chain: null,
        busy: false,
        error: null,
        ...existing,
        ...patch,
      };
      return existing
        ? current.map((item) => item.reference.hireId === reference.hireId ? next : item)
        : [next, ...current].slice(0, 20);
    });
  }, []);

  const followJob = useCallback(async (
    reference: RecentJobReference,
    initial: FreshMarketplaceChain,
    includeCreated: boolean,
  ): Promise<FreshMarketplaceChain> => {
    let current = initial;
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      const shouldWait = current.job.state === "RUNNING" || (includeCreated && current.job.state === "CREATED");
      if (!shouldWait) {
        return current;
      }
      await wait(POLL_DELAY_MS);
      current = await retrieveChain(reference);
      updateItem(reference, { phase: "READY", chain: current, busy: true, error: null });
    }
    return current;
  }, [updateItem]);

  const refresh = useCallback(async (
    reference: RecentJobReference,
    watchNewCreation = false,
  ): Promise<FreshMarketplaceChain | null> => {
    updateItem(reference, { phase: "LOADING", busy: true, error: null });
    try {
      let chain = await retrieveChain(reference);
      updateItem(reference, { phase: "READY", chain, busy: true, error: null });
      if (watchNewCreation && (chain.job.state === "RUNNING" || chain.job.state === "CREATED")) {
        chain = await followJob(reference, chain, watchNewCreation);
      }
      updateItem(reference, { phase: "READY", chain, busy: false, error: null });
      return chain;
    } catch (error) {
      updateItem(reference, { phase: "UNAVAILABLE", chain: null, busy: false, error: safeError(error) });
      return null;
    }
  }, [followJob, updateItem]);

  const hydrate = useCallback((history: RecentJobHistoryRead) => {
    const nextIds = new Set(history.entries.map((entry) => entry.hireId));
    for (const hireId of trackedIds.current) {
      if (!nextIds.has(hireId)) {
        suppressedIds.current.add(hireId);
      }
    }
    for (const hireId of nextIds) {
      suppressedIds.current.delete(hireId);
    }
    trackedIds.current = nextIds;
    setStorageAvailable(history.available);
    setCorruptCount(history.corruptCount);
    setItems(history.entries.map((reference) => ({
      reference,
      phase: "LOADING",
      chain: null,
      busy: true,
      error: null,
    })));
    setInitializing(false);
    for (const reference of history.entries) {
      void refresh(reference);
    }
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    hydrate(readRecentJobReferences());
    return () => {
      mounted.current = false;
    };
  }, [hydrate]);

  useEffect(() => {
    const handleRecentJob = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isRecentJobChangeDetail(detail)) {
        return;
      }
      setStorageAvailable(detail.storageAvailable);
      if (!detail.storageAvailable) {
        return;
      }
      suppressedIds.current.delete(detail.reference.hireId);
      trackedIds.current.add(detail.reference.hireId);
      updateItem(detail.reference, { phase: "LOADING", chain: null, busy: true, error: null });
      void refresh(detail.reference, true);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === RECENT_JOB_STORAGE_KEY) {
        hydrate(readRecentJobReferences());
      }
    };

    window.addEventListener(RECENT_JOB_CHANGED_EVENT, handleRecentJob);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(RECENT_JOB_CHANGED_EVENT, handleRecentJob);
      window.removeEventListener("storage", handleStorage);
    };
  }, [hydrate, refresh, updateItem]);

  const resume = async (item: RecentJobItem) => {
    updateItem(item.reference, { busy: true, error: null });
    try {
      const response = await fetch(`/api/benchmark-hires/${encodeURIComponent(item.reference.hireId)}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        throw new Error(`Run request returned ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (!isFreshMarketplaceChainForReference(payload, item.reference)) {
        throw new Error("Run response did not match this device reference");
      }
      updateItem(item.reference, { phase: "READY", chain: payload, busy: true, error: null });
      const settled = await followJob(item.reference, payload, true);
      updateItem(item.reference, { phase: "READY", chain: settled, busy: false, error: null });
    } catch (error) {
      updateItem(item.reference, { phase: "UNAVAILABLE", chain: null, busy: false, error: safeError(error) });
    }
  };

  const openResult = async (item: RecentJobItem) => {
    const current = await refresh(item.reference);
    if (!current) {
      return;
    }
    const job = sessionJobFromFreshChain(current);
    if (job) {
      onOpenJob(job);
    }
  };

  const remove = (item: RecentJobItem) => {
    const result = removeRecentJobReference(item.reference.hireId);
    setStorageAvailable(result.ok);
    if (result.ok) {
      suppressedIds.current.add(item.reference.hireId);
      trackedIds.current.delete(item.reference.hireId);
      setItems((current) => current.filter((candidate) => candidate.reference.hireId !== item.reference.hireId));
    }
  };

  const clear = () => {
    const result = clearRecentJobReferences();
    setStorageAvailable(result.ok);
    if (result.ok) {
      for (const item of items) {
        suppressedIds.current.add(item.reference.hireId);
      }
      trackedIds.current.clear();
      setItems([]);
      setCorruptCount(0);
    }
  };

  return (
    <section className="recent-device-jobs" data-testid="recent-jobs-device" aria-labelledby="recent-device-jobs-title">
      <div className="section-bar recent-device-jobs-bar">
        <div>
          <span className="section-kicker">Device recovery</span>
          <h2 id="recent-device-jobs-title">Recent jobs on this device</h2>
          <p className="recent-device-boundary">
            This browser stores job references only. Status and results reload from PositionCrew&apos;s server; no wallet or account ownership is inferred.
          </p>
        </div>
        <div className="recent-device-summary">
          <span>{items.length} saved {items.length === 1 ? "job" : "jobs"}</span>
          {items.length > 0 && (
            <button type="button" className="device-clear-button" onClick={clear}>
              <Trash2 size={16} aria-hidden="true" /> Clear device list
            </button>
          )}
        </div>
      </div>

      {!storageAvailable && (
        <p className="recent-device-alert" role="status">
          Device storage is unavailable. This job can still finish, but it will not be restored after this tab closes.
        </p>
      )}
      {corruptCount > 0 && (
        <p className="recent-device-alert" role="status">
          {corruptCount} invalid saved {corruptCount === 1 ? "reference was" : "references were"} ignored.
        </p>
      )}

      <div className="history-table-wrap recent-device-table-wrap">
        <table className="history-table recent-device-table">
          <thead>
            <tr>
              <th>Saved</th>
              <th>Service</th>
              <th>Status</th>
              <th>What happens next</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const copy = stateCopy(item);
              const chain = item.chain;
              const completed = item.phase === "READY" && chain?.job.state === "COMPLETED" && chain.receipt;
              return (
                <tr key={item.reference.hireId}>
                  <td data-label="Saved">{formatTime(chain?.hire.createdAt ?? item.reference.rememberedAt)}</td>
                  <td data-label="Service"><strong>{SERVICE_NAMES[item.reference.service]}</strong></td>
                  <td data-label="Status">
                    <span className={`recent-job-state recent-job-state-${copy.label.toLowerCase()}`}>{copy.label}</span>
                  </td>
                  <td data-label="What happens next">
                    <span>{copy.detail}</span>
                    {item.phase === "UNAVAILABLE" && item.error && <small>{item.error}</small>}
                  </td>
                  <td data-label="Actions">
                    <div className="recent-job-actions">
                      {completed && (
                        <>
                          <button type="button" onClick={() => void openResult(item)} disabled={item.busy}>
                            {item.busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <ExternalLink size={16} aria-hidden="true" />}
                            Open result
                          </button>
                          <a href={chain.receipt?.publicUrl}>
                            <ExternalLink size={16} aria-hidden="true" /> Open receipt
                          </a>
                        </>
                      )}
                      {item.phase === "READY" && (chain?.job.state === "CREATED" || chain?.job.state === "RUNNING") && (
                        <button type="button" onClick={() => void resume(item)} disabled={item.busy}>
                          <Play size={16} aria-hidden="true" /> {chain.job.state === "RUNNING" ? "Recover run" : "Resume run"}
                        </button>
                      )}
                      {item.phase === "UNAVAILABLE" && (
                        <button type="button" onClick={() => void refresh(item.reference)} disabled={item.busy}>
                          <RefreshCw className={item.busy ? "spin" : undefined} size={16} aria-hidden="true" /> Retry status
                        </button>
                      )}
                      <button
                        type="button"
                        className="recent-job-remove"
                        onClick={() => remove(item)}
                        aria-label={`Remove ${SERVICE_NAMES[item.reference.service]} job from this device`}
                      >
                        <Trash2 size={16} aria-hidden="true" /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {initializing && <div className="empty-table" role="status">Checking this device for saved jobs...</div>}
        {!initializing && items.length === 0 && (
          <div className="empty-table">
            No saved jobs on this device. Run a current hire to keep its server receipt available after reload.
          </div>
        )}
      </div>
      <p className="recent-device-clear-note">
        Clearing this list affects this browser only. Public receipts remain available if you saved their links.
      </p>
    </section>
  );
}
