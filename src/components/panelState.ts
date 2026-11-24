/**
 * State shared by the collapsible analysis panels (CollapsiblePanel.tsx):
 * which panels are open, and the status a panel reports for its header.
 *
 * Before anything is selected the panels are "waiting": shown folded (a
 * list of what can be run) unless opened while waiting. Opening or folding
 * a panel is remembered either way.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import { readPanelOpen, writeAllPanelsOpen, type PanelStatus } from "./panelStatus";

// Which panels are open, shared by the panels and the "Collapse all" button.
// Kept in memory as well as in localStorage, so toggling works when storage is blocked.
const openState = new Map<string, boolean>();
// Panels opened while waiting (nothing selected); the rest wait folded.
const waitOpen = new Set<string>();
const listeners = new Set<() => void>();
export const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const isOpen = (id: string, waiting = false) => {
  if (waiting) return waitOpen.has(id);
  if (!openState.has(id)) openState.set(id, readPanelOpen(id));
  return openState.get(id)!;
};
export function setPanelsOpen(ids: string[], open: boolean) {
  for (const id of ids) {
    openState.set(id, open);
    if (open) waitOpen.add(id);
    else waitOpen.delete(id);
  }
  writeAllPanelsOpen(ids, open);
  for (const l of listeners) l();
}
export const usePanelOpen = (id: string, waiting = false) => useSyncExternalStore(subscribe, () => isOpen(id, waiting));

/** True inside a panel shown before anything is selected (Summary and annotation read it; the Set Summary tab is never waiting). */
export const WaitingContext = createContext(false);
export const usePanelWaiting = () => useContext(WaitingContext);

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

