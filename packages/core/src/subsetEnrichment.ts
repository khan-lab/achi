import { abortIfCancelled, loadRefText, type Runtime } from "./runtime";
import { EXTERNAL_ANNOTATIONS, type ExternalAnnotation } from "./externalAnnotations";
import { parseIntersectCounts } from "./pipeline";
import { benjaminiHochberg, fisherExact, mantelHaenszel, oddsRatio } from "./stats";
import type { Interval } from "./types";
import { inGroup } from "./selection";

/**
 * Subset enrichment for the built-in reference region sets — the null
 * models are specified in docs/methods.md ("Subset enrichment for
 * reference region sets"); this file implements exactly that.
 *
 * Input-sets background: the universe is every region assigned to some
 * subset (each input locus once). One `bedtools intersect -c` per
 * reference set flags which universe regions hit it; every (subset,
 * reference set) 2×2 table then comes from those flags in plain JS, so the
 * number of bedtools runs doesn't grow with the number of subsets.
 *
 * There is deliberately no whole-genome background here: `bedtools
 * fisher`, the obvious candidate, degenerates when interval sizes differ
 * greatly (subset peaks of ~30 kb vs 1-bp variants) — see
 * docs/methods.md.
 */

const LENGTH_STRATA = 5;

export interface EnrichmentUniverse {
  /** BED lines, one per universe region, grouped by subset. */
  bedText: string;
  /** Mask of the subset each universe region belongs to. */
  owner: Int32Array;
  lengths: Int32Array;
}

export interface EnrichmentCell {
  mask: number;
  annotationId: string;
  /** 2×2 table: in S & hit, in S & no hit, rest & hit, rest & no hit. */
  table: [number, number, number, number];
  oddsRatio: number;
  p: number;
  /** Benjamini–Hochberg over every cell of the same run. */
  q: number;
}

export function buildUniverse(subsets: { mask: number; regions: Interval[] }[]): EnrichmentUniverse {
  const n = subsets.reduce((k, s) => k + s.regions.length, 0);
  const owner = new Int32Array(n);
  const lengths = new Int32Array(n);
  const lines: string[] = [];
  let i = 0;
  for (const s of subsets) {
    for (const r of s.regions) {
      owner[i] = s.mask;
      lengths[i] = r.end - r.start;
      lines.push(`${r.chrom}\t${r.start}\t${r.end}`);
      i++;
    }
  }
  return { bedText: lines.length ? lines.join("\n") + "\n" : "", owner, lengths };
}

/**
 * Length stratum (0..k−1) of each region. Cut-off j (1..k−1) is the
 * ⌈j/k · N⌉-th smallest length (inverse ECDF); a region's stratum is the
 * number of cut-offs strictly below its length, so equal lengths share a
 * stratum.
 */
export function lengthStrata(lengths: Int32Array, k = LENGTH_STRATA): Uint8Array {
  const n = lengths.length;
  const out = new Uint8Array(n);
  if (!n) return out;
  const sorted = Int32Array.from(lengths).sort();
  const cuts: number[] = [];
  for (let j = 1; j < k; j++) cuts.push(sorted[Math.ceil((j / k) * n) - 1]);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of cuts) if (lengths[i] > c) s++;
    out[i] = s;
  }
  return out;
}

type Table = [number, number, number, number];

/** The 2×2 table for subset `mask` (or a whole set, by its negative key: lib/selection.ts) against one reference set's hit flags, and the same table per stratum when `strata` is given. */
export function enrichmentCounts(owner: Int32Array, hits: Uint8Array, mask: number, strata?: Uint8Array): { table: Table; strata: Table[] } {
  const table: Table = [0, 0, 0, 0];
  const per: Table[] = [];
  for (let i = 0; i < owner.length; i++) {
    const cell = (inGroup(owner[i], mask) ? 0 : 2) + (hits[i] ? 0 : 1);
    table[cell]++;
    if (strata) {
      const s = strata[i];
      while (per.length <= s) per.push([0, 0, 0, 0]);
      per[s][cell]++;
    }
  }
  return { table, strata: per };
}

/** Reference sets that can be tested for this assembly: available files, minus any that is currently an included input set (the subsets are defined by it). */
export function testableAnnotations(assembly: string, loaded: { fileName: string; included: boolean }[]): ExternalAnnotation[] {
  const inUse = new Set(loaded.filter((s) => s.included).map((s) => s.fileName));
  return EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === assembly && a.path && !inUse.has(`${a.id}.bed`));
}

/** Input-sets background: every (subset, reference set) cell, BH-adjusted together. */
export function unionEnrichment(
  universe: EnrichmentUniverse,
  annotations: { id: string; hits: Uint8Array }[],
  masks: number[],
  adjustForLength: boolean
): EnrichmentCell[] {
  const strata = adjustForLength ? lengthStrata(universe.lengths) : undefined;
  const cells: Omit<EnrichmentCell, "q">[] = [];
  for (const mask of masks) {
    for (const a of annotations) {
      const t = enrichmentCounts(universe.owner, a.hits, mask, strata);
      if (adjustForLength) {
        const mh = mantelHaenszel(t.strata);
        cells.push({ mask, annotationId: a.id, table: t.table, oddsRatio: mh.oddsRatio, p: mh.p });
      } else {
        const [x, y, z, w] = t.table;
        cells.push({ mask, annotationId: a.id, table: t.table, oddsRatio: oddsRatio(x, y, z, w), p: fisherExact(x, y, z, w) });
      }
    }
  }
  const q = benjaminiHochberg(cells.map((c) => c.p));
  return cells.map((c, i) => ({ ...c, q: q[i] }));
}

// ---- bedtools glue ----

const annotationTextCache = new Map<string, string>();

async function annotationText(rt: Runtime, a: ExternalAnnotation): Promise<string> {
  const cached = annotationTextCache.get(a.id);
  if (cached !== undefined) return cached;
  const text = await loadRefText(rt, a.path!, a.name);
  annotationTextCache.set(a.id, text);
  return text;
}

export type StepCallback = (label: string) => void;

/** Hit flags of every universe region against each reference set: one `bedtools intersect -c` per set. */
export async function universeHits(
  rt: Runtime,
  universe: EnrichmentUniverse,
  annotations: ExternalAnnotation[],
  onStep?: StepCallback
): Promise<{ id: string; hits: Uint8Array }[]> {
  // Download every reference set at once (cached after the first run) rather than one per bedtools step.
  await Promise.all(annotations.map((a) => annotationText(rt, a)));
  const bt = rt.bedtools;
  const uName = "enrichment.universe.bed";
  await bt.mount([{ name: uName, data: universe.bedText }]);
  const out: { id: string; hits: Uint8Array }[] = [];
  try {
    for (const a of annotations) {
      const name = `enrichment.ref.${a.id}.bed`;
      await bt.mount([{ name, data: await annotationText(rt, a) }]);
      try {
        const res = await bt.exec(`bedtools intersect -a ${bt.dir}/${uName} -b ${bt.dir}/${name} -c`);
        out.push({ id: a.id, hits: parseIntersectCounts(res.stdout, universe.owner.length) });
      } finally {
        await bt.unmount([name]);
      }
      onStep?.(a.name);
    }
  } finally {
    await bt.unmount([uName]);
  }
  return out;
}

/**
 * Enrichment of each group (a subset mask, or a whole set's negative key:
 * selection.ts inGroup) for each reference set, against the other regions
 * of the analysis: the universe is every region of every subset, each
 * reference set's overlaps are counted with `bedtools intersect -c`, and
 * each group is tested with Fisher's exact test or, with `adjust`, a
 * Cochran–Mantel–Haenszel test over region-length strata; q-values by
 * Benjamini–Hochberg over every cell. One step per reference set.
 */
export async function runReferenceSetEnrichment(
  rt: Runtime,
  req: { subsets: { mask: number; regions: Interval[] }[]; groups: number[]; annotations: ExternalAnnotation[]; adjust: boolean },
  o: { onStep?: StepCallback; signal?: AbortSignal } = {}
): Promise<EnrichmentCell[]> {
  abortIfCancelled(o.signal);
  const universe = buildUniverse(req.subsets);
  const hits = await universeHits(rt, universe, req.annotations, (label) => {
    o.onStep?.(label);
    abortIfCancelled(o.signal);
  });
  return unionEnrichment(universe, hits, req.groups, req.adjust);
}

export const REFERENCE_SET_TSV_HEAD = ["subset", "subset_code", "reference_set", "background", "test", "subset_hit", "subset_no_hit", "rest_hit", "rest_no_hit", "odds_ratio", "p", "q"];

/** A run as TSV: the download, and what the analysis export takes. `groupOf` names a group by its key. */
export function referenceSetTsv(
  run: { adjust: boolean; cells: EnrichmentCell[]; annotations: ExternalAnnotation[] },
  groupOf: (mask: number) => { label: string; code: string } | undefined
): string {
  const test = run.adjust ? "CMH (5 length strata)" : "Fisher exact";
  const rows = run.cells.map((c) => {
    const s = groupOf(c.mask);
    const a = run.annotations.find((x) => x.id === c.annotationId);
    return [s?.label ?? c.mask, s?.code ?? "", a?.name ?? c.annotationId, "input sets", test, ...c.table, c.oddsRatio, c.p, c.q].join("\t");
  });
  return [REFERENCE_SET_TSV_HEAD.join("\t"), ...rows].join("\n") + "\n";
}
