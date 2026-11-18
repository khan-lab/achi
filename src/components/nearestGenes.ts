import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import {
  fetchAndMountGeneTss,
  computeGeneAssociations,
  uniqueGeneNames,
  type RegionGeneAssociation,
} from "../lib/geneList";
import type { SummaryItem } from "./SummaryPlot";
import { registerExport } from "../lib/exportRegistry";
import { geneListMethods } from "@achi/core/analysisExport";

// Module-level, not component state: this panel unmounts whenever
// `selectedSubsets` empties out or `view` navigates to "summary" (App.tsx
// only renders it when a subset is selected on a non-Summary tab) — see
// the same note in SummaryPlot.tsx/RegionAnnotationPlot.tsx for why a
// plain useRef/useState pair would silently redo the bedtools closest
// call every time.
const geneTssPathCache = new Map<string, string>(); // assembly -> mounted path
const associationsCache = new Map<string, RegionGeneAssociation[]>(); // cacheKey -> associations

/**
 * Nearest gene by TSS for each selected subset or set — see
 * lib/geneList.ts's module docstring and docs/methods.md. Computed as soon
 * as a group is selected (cached per assembly and content), shown in the
 * group's card in the "Selected subsets and sets" column (Genes tab,
 * GroupGenes below), and contributed to "Export analysis".
 */
export function useNearestGenes(items: SummaryItem[]): { genesOf: (item: SummaryItem) => string[] | undefined; loading: boolean; error: string | null } {
  const assembly = useStore((s) => s.assembly);
  const geneTssPathRef = useRef(geneTssPathCache);
  const [associationsState, setAssociationsState] = useState<Map<string, RegionGeneAssociation[]>>(
    () => new Map(associationsCache)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheKey = (item: SummaryItem) => `${assembly}::${item.id}::${item.version}`;
  const itemsKey = items.map((i) => `${i.id}:${i.version}`).join(",");

  useEffect(() => {
    if (items.length < 1) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        let geneTssPath = geneTssPathRef.current.get(assembly);
        if (!geneTssPath) {
          geneTssPath = await fetchAndMountGeneTss(assembly);
          geneTssPathRef.current.set(assembly, geneTssPath);
        }

        for (const item of items) {
          if (cancelled) return;
          const key = cacheKey(item);
          if (associationsCache.has(key)) continue;
          const associations = await computeGeneAssociations(item, geneTssPath);
          if (cancelled) return;
          associationsCache.set(key, associations);
          setAssociationsState((prev) => new Map(prev).set(key, associations));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // associationsCache (the module-level Map) is read for "already
    // computed?" checks only, see the same note in SummaryPlot.tsx's effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly, itemsKey]);

  // The gene lists computed so far go into "Export analysis".
  const exportItems = useRef({ items, assembly });
  useEffect(() => {
    exportItems.current = { items, assembly };
  });
  useEffect(
    () =>
      registerExport("genes", () => {
        const { items: its, assembly: asm } = exportItems.current;
        const files = its.flatMap((item) => {
          const a = associationsCache.get(`${asm}::${item.id}::${item.version}`);
          if (!a) return [];
          const genes = uniqueGeneNames(a);
          return [{ path: `genes/${item.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.genes.txt`, content: genes.join("\n") + (genes.length ? "\n" : "") }];
        });
        return files.length ? { files, methods: geneListMethods(asm) } : null;
      }),
    [],
  );

  const genesOf = (item: SummaryItem) => {
    const a = associationsState.get(cacheKey(item));
    return a ? uniqueGeneNames(a) : undefined;
  };
  return { genesOf, loading, error };
}
