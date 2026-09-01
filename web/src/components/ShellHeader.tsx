import { FileCheck2, GitBranch, Network, Store } from "lucide-react";

export type AppView = "marketplace" | "jobs" | "evidence";

const views: Array<{ id: AppView; label: string; icon: typeof Store }> = [
  { id: "marketplace", label: "Marketplace", icon: Store },
  { id: "jobs", label: "Jobs", icon: Network },
  { id: "evidence", label: "Proof & history", icon: FileCheck2 },
];

export function ShellHeader({
  view,
  onNavigate,
  apiState,
  jobCount,
}: {
  view: AppView;
  onNavigate: (view: AppView) => void;
  apiState: "online" | "loading" | "unavailable";
  jobCount: number;
}) {
  return (
    <header className="shell-header">
      <div className="shell-header-inner">
        <button className="brand-button" type="button" onClick={() => onNavigate("marketplace")}>
          <img src="/positioncrew-mark.svg" alt="" width="34" height="34" />
          <span><strong>PositionCrew</strong><small>Agent capital desk</small></span>
        </button>
        <div className="header-right">
          <nav className="global-nav" aria-label="Primary navigation">
            {views.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={view === item.id ? "active" : ""}
                  aria-current={view === item.id ? "page" : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon size={15} aria-hidden="true" />
                  {item.label}
                  {item.id === "jobs" && jobCount > 0 && <span className="nav-count">{jobCount}</span>}
                </button>
              );
            })}
          </nav>
          <div className="header-actions">
            <span className="network-chip"><i /> BNB Smart Chain</span>
            <span className={`api-state ${apiState}`} role="status">
              <i /> {apiState === "online" ? "API reachable" : apiState === "unavailable" ? "API unavailable" : "Connecting"}
            </span>
            <a href="https://github.com/qdeeworld/positioncrew" target="_blank" rel="noreferrer">
              <GitBranch size={15} aria-hidden="true" /> Source
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
