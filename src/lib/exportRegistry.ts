/**
 * What panels holding results add to the analysis export (state/store.ts
 * exportAnalysis): files (tables, gene lists) and a methods paragraph with
 * its references. A panel registers a provider while it is on screen; the
 * provider returns null when there is nothing to add yet (not run), and an
 * out-of-date result is left out (markExportStale).
 */
import type { MethodsExtra } from "@achi/core/analysisExport";

export interface ExportContribution {
  files: { path: string; content: string }[];
  methods?: MethodsExtra;
}

/** A provider returns "stale" when its last result no longer matches the inputs or settings. */
type Provider = () => ExportContribution | null | "stale";
const providers = new Map<string, Provider>();
// Panels whose shown result is out of date (marked as they render).
const staleKeys = new Set<string>();

/** What each provider is called in the export's README and notice. */
const LABELS: Record<string, string> = {
  enrichment: "reference-set enrichment",
  motifs: "motif enrichment",
  go: "GO enrichment",
  expression: "expression",
  signal: "signal profiles",
  permutation: "the pairwise permutation test",
  genes: "nearest genes",
};

/** Registers (or replaces) the provider for `key`; returns its unregister function. */
export function registerExport(key: string, provider: Provider): () => void {
  providers.set(key, provider);
  return () => {
    if (providers.get(key) === provider) {
      providers.delete(key);
      staleKeys.delete(key);
    }
  };
}

/**
 * Marks `key`'s result as out of date (or current again). An out-of-date
 * result is left out of the export, so the tables always match the
 * settings file written next to them.
 */
export function markExportStale(key: string, stale: boolean): void {
  if (stale) staleKeys.add(key);
  else staleKeys.delete(key);
}

export function collectExports(): { current: ExportContribution[]; outOfDate: string[] } {
  const current: ExportContribution[] = [];
  const outOfDate: string[] = [];
  for (const [key, provider] of providers) {
    const c = staleKeys.has(key) ? "stale" : provider();
    if (c === "stale") outOfDate.push(LABELS[key] ?? key);
    else if (c) current.push(c);
  }
  return { current, outOfDate };
}
