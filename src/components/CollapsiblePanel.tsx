import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import type { PanelStatus } from "./panelStatus";
import { isOpen, setPanelsOpen, StatusContext, subscribe, usePanelOpen } from "./panelState";

/** One button above the panels (Selection card): collapses every panel listed while any is open, otherwise expands them all. */
export function CollapseAllButton({ ids }: { ids: string[] }) {
  const anyOpen = useSyncExternalStore(subscribe, () => ids.some(isOpen));
  return (
    <button
      className="iconbtn"
      onClick={() => setPanelsOpen(ids, !anyOpen)}
      aria-label={anyOpen ? "Collapse all analysis panels" : "Expand all analysis panels"}
      title={anyOpen ? "Collapse all analysis panels below (results are kept)" : "Expand all analysis panels below"}
    >
      <Icon name={anyOpen ? "collapseAll" : "expandAll"} />
    </button>
  );
}

/**
 * An analysis card in the middle column whose whole header folds it.
 * Collapsing only hides the body: the panel stays mounted, so its results,
 * settings and any running analysis are kept and it still adds its tables
 * to Export analysis. This browser remembers which panels are collapsed.
 */
export function CollapsiblePanel({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const open = usePanelOpen(id);
  const [status, setStatusState] = useState<PanelStatus | null>(null);
  const setStatus = useCallback((s: PanelStatus | null) => setStatusState(s), []);
  const bodyId = useId();

  const toggle = () => setPanelsOpen([id], !open);

  return (
    <div className={open ? "card panel" : "card panel collapsed"}>
      <button type="button" className="panelhd" aria-expanded={open} aria-controls={bodyId} onClick={toggle} title={open ? "Collapse this panel (results are kept)" : "Expand this panel"}>
        <span className="eyebrow">{title}</span>
        {!open && status && <span className={`panelstatus ${status.tone}`}>{status.text}</span>}
        <span className="panelchev" aria-hidden="true">
          <Icon name={open ? "chevronUp" : "chevronDown"} />
        </span>
      </button>
      <div id={bodyId} hidden={!open}>
        <StatusContext.Provider value={setStatus}>{children}</StatusContext.Provider>
      </div>
    </div>
  );
}
