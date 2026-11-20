/**
 * State shared by the collapsible analysis panels (CollapsiblePanel.tsx):
 * which panels are open, and the status a panel reports for its header.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { readPanelOpen, writeAllPanelsOpen, type PanelStatus } from "./panelStatus";

// Which panels are open, shared by the panels and the "Collapse all" button.
// Kept in memory as well as in localStorage, so toggling works when storage is blocked.
const openState = new Map<string, boolean>();
const listeners = new Set<() => void>();
export const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const isOpen = (id: string) => {
  if (!openState.has(id)) openState.set(id, readPanelOpen(id));
  return openState.get(id)!;
};
export function setPanelsOpen(ids: string[], open: boolean) {
  for (const id of ids) openState.set(id, open);
  writeAllPanelsOpen(ids, open);
  for (const l of listeners) l();
}
export const usePanelOpen = (id: string) => useSyncExternalStore(subscribe, () => isOpen(id));

export const StatusContext = createContext<(s: PanelStatus | null) => void>(() => {});

/**
 * Reports the status shown in the header of the collapsible panel around
 * this component (when collapsed). Outside one it does nothing, so a panel
 * can call it unconditionally.
 */
export function usePanelStatus(s: PanelStatus | null): void {
  const set = useContext(StatusContext);
  const tone = s?.tone;
  const text = s?.text;
  useEffect(() => {
    set(tone && text !== undefined ? { tone, text } : null);
  }, [set, tone, text]);
}

