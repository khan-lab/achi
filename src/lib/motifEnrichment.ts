/**
 * Motif enrichment of selected subsets and sets (components/MotifEnrichmentPanel.tsx).
 * The null model is in docs/methods.md ("Motif enrichment (JASPAR)").
 *
 * Universe: every region of the analysis (each locus once: the subsets'
 * regions, lib/subsetEnrichment.ts buildUniverse), one window per region
 * (±100 bp around its centre by default). A region "has" a motif when the
 * window holds at least one site (lib/pwm.ts, p < 1e-4, either strand).
 * For each selected group and motif, the 2×2 table is: the group's regions
 * with / without a site against the other regions with / without one, per
 * stratum of base composition (quintiles of the windows' G+C crossed with
 * tertiles of their observed/expected CpG), combined by the
 * Cochran–Mantel–Haenszel test (lib/stats.ts); Benjamini–Hochberg over every
 * (group, motif) cell of the run. A whole set is every subset it is a
 * member of (lib/selection.ts inGroup).
 *
 * Large analyses are sampled (scanPlan): the background is an even random
 * sample of the universe, and each selected group is scanned in full up to
 * a cap (a random sample above it). "The other regions" are then the
 * background sample's regions outside the group.
 */
import { benjaminiHochberg, mantelHaenszel } from "@achi/core/stats";
import { lengthStrata } from "./subsetEnrichment";
import { inGroup } from "@achi/core/selection";

export const GC_STRATA = 5;

/** G+C as a share of A+C+G+T, in thousandths; -1 if the window has no bases. */
export function gcPerMille(codes: Uint8Array): number {
  let gc = 0;
  let n = 0;
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c > 3) continue;
    n++;
    if (c === 1 || c === 2) gc++;
  }
  return n ? Math.round((1000 * gc) / n) : -1;
}

/** GC stratum (0..k−1, quantile cut-offs as lengthStrata) of each window; windows without bases go to 0 (they are left out as invalid). */
export function gcStrata(gc: Int32Array, k = GC_STRATA): Uint8Array {
  const idx: number[] = [];
  for (let i = 0; i < gc.length; i++) if (gc[i] >= 0) idx.push(i);
  const s = lengthStrata(Int32Array.from(idx.map((i) => gc[i])), k);
  const out = new Uint8Array(gc.length);
  idx.forEach((i, j) => (out[i] = s[j]));
  return out;
}

export const CPG_STRATA = 3;

/** Observed / expected CpG of a window: CpG count × bases / (C count × G count); NaN without C or G. N breaks a dinucleotide. */
export function cpgRatio(codes: Uint8Array): number {
  let c = 0;
  let g = 0;
  let cg = 0;
  let n = 0;
  for (let i = 0; i < codes.length; i++) {
    const x = codes[i];
    if (x > 3) continue;
    n++;
    if (x === 1) c++;
    else if (x === 2) {
      g++;
      if (i > 0 && codes[i - 1] === 1) cg++;
    }
  }
  return c && g ? (cg * n) / (c * g) : NaN;
}

/**
 * The strata the test is stratified over: GC quintile × CpG tertile
 * (observed/expected; CpG-island-like windows are their own stratum), so
 * GC-rich and CpG-rich motifs are compared within like composition.
 * Stratum = gcStratum × CPG_STRATA + cpgStratum.
 */
export function compositionStrata(gc: Int32Array, cpg: Float64Array, kGc = GC_STRATA, kCpg = CPG_STRATA): Uint8Array {
  const g = gcStrata(gc, kGc);
  const idx: number[] = [];
  for (let i = 0; i < cpg.length; i++) if (gc[i] >= 0 && Number.isFinite(cpg[i])) idx.push(i);
  const t = lengthStrata(Int32Array.from(idx.map((i) => Math.round(cpg[i] * 1000))), kCpg);
  const c = new Uint8Array(cpg.length);
  idx.forEach((i, j) => (c[i] = t[j]));
  return Uint8Array.from(g, (x, i) => x * kCpg + c[i]);
}

export interface MotifCell {
  /** The group: a subset mask, or a whole set's negative key. */
  key: number;
  /** Index into the run's motifs (and `hits`). */
  motif: number;
  /** Summed over strata: in group & site, in group & no site, rest & site, rest & no site. */
  table: [number, number, number, number];
  oddsRatio: number;
  p: number;
  q: number;
}

/**
 * Every (group, motif) cell. Arrays are aligned with the scanned regions:
 * `owner` (subset mask), `pool` (1 if in the background sample), `valid`
 * (1 if the window had bases), `strata` (GC stratum), and per motif `hits`
 * (1 if the window has a site).
 */
export function motifEnrichment(x: { owner: Int32Array; pool: Uint8Array; valid: Uint8Array; strata: Uint8Array; hits: Uint8Array[]; keys: number[] }): MotifCell[] {
  const n = x.owner.length;
  const nStrata = Math.max(0, ...Array.from(x.strata)) + 1;
  const cells: Omit<MotifCell, "q">[] = [];
  for (const key of x.keys) {
    // 0: in the group, 2: the rest (background sample, outside the group), -1: not counted.
    const side = new Int8Array(n);
    for (let i = 0; i < n; i++) side[i] = !x.valid[i] ? -1 : inGroup(x.owner[i], key) ? 0 : x.pool[i] ? 2 : -1;
    x.hits.forEach((h, motif) => {
      const per: [number, number, number, number][] = Array.from({ length: nStrata }, () => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) if (side[i] >= 0) per[x.strata[i]][side[i] + (h[i] ? 0 : 1)]++;
      const table = per.reduce((t, s) => [t[0] + s[0], t[1] + s[1], t[2] + s[2], t[3] + s[3]] as [number, number, number, number], [0, 0, 0, 0] as [number, number, number, number]);
      const mh = mantelHaenszel(per);
      cells.push({ key, motif, table, oddsRatio: mh.oddsRatio, p: mh.p });
    });
  }
  const q = benjaminiHochberg(cells.map((c) => c.p));
  return cells.map((c, i) => ({ ...c, q: q[i] }));
}

/** Mulberry32: a small seeded generator, so a run scans the same regions every time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `k` of `items` at random (all of them if there are no more than k). */
function sampleOf(items: number[], k: number, next: () => number): number[] {
  if (items.length <= k) return items;
  const a = items.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(next() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

export const MAX_POOL = 10_000;
export const MAX_GROUP = 5_000;

/**
 * Which universe regions to scan (indexes, ascending) and which of them form
 * the background sample. Everything when the universe has at most
 * `maxPool` regions; otherwise an even random sample of `maxPool` as the
 * background, plus each selected group's regions (a random `maxGroup` when
 * it has more).
 */
export function scanPlan(universeOwner: Int32Array, keys: number[], o: { maxPool?: number; maxGroup?: number; seed?: number } = {}): { scan: Int32Array; pool: Uint8Array } {
  const maxPool = o.maxPool ?? MAX_POOL;
  const maxGroup = o.maxGroup ?? MAX_GROUP;
  const n = universeOwner.length;
  if (n <= maxPool) return { scan: Int32Array.from({ length: n }, (_, i) => i), pool: new Uint8Array(n).fill(1) };
  const next = rng(o.seed ?? 1);
  const all = Array.from({ length: n }, (_, i) => i);
  const pool = new Set(sampleOf(all, maxPool, next));
  const chosen = new Set(pool);
  for (const key of keys) {
    const members = all.filter((i) => inGroup(universeOwner[i], key));
    for (const i of sampleOf(members, maxGroup, next)) chosen.add(i);
  }
  const scan = Int32Array.from([...chosen].sort((a, b) => a - b));
  return { scan, pool: Uint8Array.from(scan, (i) => (pool.has(i) ? 1 : 0)) };
}
