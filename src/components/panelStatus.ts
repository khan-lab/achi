/**
 * The status a collapsed analysis panel shows in its header ("running 40%",
 * "14 motifs q < 0.05", "out of date · …"), and which panels this browser
 * keeps collapsed. Presentation only.
 */
import type { ComputeProgress } from "./ComputeStatus";

export type PanelTone = "idle" | "busy" | "done" | "stale" | "error";

export interface PanelStatus {
  tone: PanelTone;
  text: string;
}

/** Running, then error, then not run, then the result (marked out of date when stale). */
export function panelStatus(o: { progress?: ComputeProgress | null; busy?: boolean; error?: string | null; hasResult: boolean; stale?: boolean; done?: string }): PanelStatus {
  if (o.progress || o.busy) {
    const pct = o.progress && o.progress.total > 0 ? Math.round((o.progress.done / o.progress.total) * 100) : null;
    return { tone: "busy", text: pct === null ? "running" : `running ${pct}%` };
  }
  if (o.error) return { tone: "error", text: "error" };
  if (!o.hasResult) return { tone: "idle", text: "not run" };
  const done = o.done ?? "done";
  return o.stale ? { tone: "stale", text: `out of date · ${done}` } : { tone: "done", text: done };
}

export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void } | null;
const KEY = "achi.panels";

function browserStorage(): Store {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function closedPanels(store: Store): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(store?.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** Open unless this browser stored the panel closed. Storage can be missing or blocked: then everything is open. */
export function readPanelOpen(id: string, store: Store = browserStorage()): boolean {
  return closedPanels(store)[id] !== true;
}

export function writePanelOpen(id: string, open: boolean, store: Store = browserStorage()): void {
  writeAllPanelsOpen([id], open, store);
}

export function writeAllPanelsOpen(ids: string[], open: boolean, store: Store = browserStorage()): void {
  const closed = closedPanels(store);
  for (const id of ids) {
    if (open) delete closed[id];
    else closed[id] = true;
  }
  try {
    store?.setItem(KEY, JSON.stringify(closed));
  } catch {
    // Blocked storage: the panel still toggles, it just isn't remembered.
  }
}
