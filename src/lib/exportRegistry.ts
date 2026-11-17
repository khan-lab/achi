/**
 * What panels holding results add to the analysis export (state/store.ts
 * exportAnalysis): files (tables, gene lists) and a methods paragraph with
 * its references. A panel registers a provider while it is on screen; the
 * provider returns null when there is nothing to add yet (not run).
 */
import type { MethodsExtra } from "./analysisExport";

export interface ExportContribution {
  files: { path: string; content: string }[];
  methods?: MethodsExtra;
}

type Provider = () => ExportContribution | null;
const providers = new Map<string, Provider>();

/** Registers (or replaces) the provider for `key`; returns its unregister function. */
export function registerExport(key: string, provider: Provider): () => void {
  providers.set(key, provider);
  return () => {
    if (providers.get(key) === provider) providers.delete(key);
  };
}

export function collectExports(): ExportContribution[] {
  return [...providers.values()].map((p) => p()).filter((c): c is ExportContribution => c !== null);
}
