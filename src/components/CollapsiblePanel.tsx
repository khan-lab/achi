import { useCallback, useId, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import type { PanelStatus } from "./panelStatus";
import { isOpen, setPanelsOpen, StatusContext, subscribe, usePanelOpen, WaitingContext } from "./panelState";

/** One button above the panels (Selection card): collapses every panel listed while any is open, otherwise expands them all. */
export function CollapseAllButton({ ids, waiting = false }: { ids: string[]; waiting?: boolean }) {
  const anyOpen = useSyncExternalStore(subscribe, () => ids.some((id) => isOpen(id, waiting)));
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
 * `waiting` (nothing selected yet): folded unless opened, and the header
 * says what it needs instead of the panel's own status.
 */
export function CollapsiblePanel({ id, title, waiting = false, children }: { id: string; title: string; waiting?: boolean; children: React.ReactNode }) {
  const open = usePanelOpen(id, waiting);
  const [status, setStatusState] = useState<PanelStatus | null>(null);
  const setStatus = useCallback((s: PanelStatus | null) => setStatusState(s), []);
  const bodyId = useId();

  const toggle = () => setPanelsOpen([id], !open);
  const shown: PanelStatus | null = waiting ? { tone: "idle", text: "select a subset or set" } : status;

  return (
    <div className={open ? "card panel" : "card panel collapsed"}>
      <button type="button" className="panelhd" aria-expanded={open} aria-controls={bodyId} onClick={toggle} title={open ? "Collapse this panel (results are kept)" : "Expand this panel"}>
        <span className="eyebrow">{title}</span>
        {!open && shown && <span className={`panelstatus ${shown.tone}`}>{shown.text}</span>}
        <span className="panelchev" aria-hidden="true">
          <Icon name={open ? "chevronUp" : "chevronDown"} />
        </span>
      </button>
      <div id={bodyId} hidden={!open}>
        <WaitingContext.Provider value={waiting}>
          <StatusContext.Provider value={setStatus}>{children}</StatusContext.Provider>
        </WaitingContext.Provider>
      </div>
    </div>
  );
}

/** Next to a disabled Run button while nothing is selected: what to do first. */
export function SelectFirstHint() {
  return (
    <span className="hint" style={{ margin: 0 }}>
      Select a subset or set above first: a bar or set name in UpSet, a count in Venn, or a row in Table.
    </span>
  );
}
