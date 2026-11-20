import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { resolveOverlapFlags } from "@achi/core/bedtoolsOptions";
import { permutationMethods, permutationTsv, runPermutation, type PermutationRun, type PermutationSettings } from "@achi/core/permutation";
import { registerExport } from "../lib/exportRegistry";
import { webRuntime } from "../lib/runtime";
import type { ComputeProgress } from "./ComputeStatus";

/** A run as shown, with the inputs it was run for. */
export interface ShownPermutation {
  key: string;
  run: PermutationRun;
  sets: { id: string; name: string }[];
}

// Survives the Pairwise view being left and opened again.
let last: ShownPermutation | null = null;

/** What a result was run for: assembly, overlap rule, settings and the included sets' contents. */
function inputsKey(assembly: string, overlapFlags: string, settings: PermutationSettings, setIds: string[]): string {
  return JSON.stringify([assembly, overlapFlags, settings, setIds]);
}

// In the analysis export whichever view is open, while it matches the current inputs and settings.
registerExport("permutation", () => {
  if (!last) return null;
  const st = useStore.getState();
  const included = st.sets.filter((x) => x.included);
  const now = inputsKey(st.assembly, resolveOverlapFlags(st.overlapPreset, st.advancedBedtoolsOptions), st.permutationSettings, included.map((x) => x.contentKey));
  if (now !== last.key) return "stale";
  // Current names: a set renamed since the run keeps its result.
  const names = new Map(included.map((x) => [x.contentKey, x.name]));
  const sets = last.sets.map((x) => ({ id: x.id, name: names.get(x.id) ?? x.name }));
  const r = last.run;
  return {
    files: [{ path: "tables/pairwise_permutation.tsv", content: permutationTsv(sets, r) }],
    methods: permutationMethods({ assembly: r.assembly, overlapFlags: r.overlapFlags, settings: r.settings, blacklistExcluded: r.blacklistExcluded }),
  };
});

/**
 * The Pairwise view's permutation test: settings, Run, progress. Runs only
 * when asked (it can take a while on large sets); the result is shown by
 * the heatmap and added to Export analysis (registered above, whichever
 * view is open) with its methods paragraph.
 */
export function usePermutation(sets: { id: string; name: string; file: Blob }[], overlapFlags: string) {
  const assembly = useStore((s) => s.assembly);
  const settings = useStore((s) => s.permutationSettings);
  const [shown, setShown] = useState<ShownPermutation | null>(last);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Set ids are content keys (PairwiseHeatmap), as in the export check above.
  const key = inputsKey(assembly, overlapFlags, settings, sets.map((s) => s.id));
  const stale = shown !== null && shown.key !== key;

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setProgress({ done: 0, total: sets.length * settings.n, label: "Loading assembly gaps", unit: "permutations" });
    try {
      const result = await runPermutation(
        webRuntime,
        { assembly, sets, overlapFlags, settings },
        { signal: abort.signal, onProgress: (p) => setProgress(p), pause: () => new Promise((r) => setTimeout(r)) }
      );
      last = { key, run: result, sets: sets.map((s) => ({ id: s.id, name: s.name })) };
      setShown(last);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === abort) setProgress(null);
    }
  };
  const cancel = () => {
    abortRef.current?.abort();
    setProgress(null);
  };
  return { assembly, settings, shown, stale, progress, error, run, cancel };
}

