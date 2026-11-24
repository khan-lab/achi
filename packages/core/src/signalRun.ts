/**
 * Signal profiles of selected groups, as the web app, CLI and MCP server run
 * them: a deepTools computeMatrix-style matrix per bigWig track over every
 * group's regions (signalMatrix.ts), rows sorted by mean signal or split
 * into k-means clusters, a colour range per track, and each region's mean
 * signal compared between groups with a two-sided Mann–Whitney U test
 * (Benjamini–Hochberg per track). Opening a track is the caller's: a local
 * bigWig (bigwigSource.ts), or a public one read privately or exactly.
 */
import { chromAlias } from "./bigwigSource";
import { computeSignalMatrix, kmeansRows, rowMean, type ProfileParams, type ProfileRegion, type SignalMatrix, type SignalRead } from "./signalMatrix";
import { abortIfCancelled } from "./runtime";
import { benjaminiHochberg, mannWhitneyU } from "./stats";
import type { Interval } from "./types";

/** Most regions in one run (rows of every heatmap). */
export const MAX_SIGNAL_ROWS = 20_000;

export type SignalSort = "desc" | "asc" | "keep";

export interface SignalGroup {
  mask: number;
  label: string;
}

/** A track as opened: chromosomes and a reader, and how it was read when that is only known once open (e.g. the summary layer used). */
export interface OpenedSignal {
  chroms: Map<string, number>;
  read: SignalRead;
  how?: string;
  level?: number;
}

export interface SignalTrack {
  id: string;
  name: string;
  /** How it is read, for the note under the figure and the methods text (or from OpenedSignal.how). */
  how?: string;
  host?: string;
  exact?: boolean;
  /** Regions read at once (range requests to a server); 1 for local files. */
  concurrency?: number;
  open: () => Promise<OpenedSignal>;
}

export interface SignalTrackInfo {
  id: string;
  name: string;
  how: string;
  host?: string;
  /** Private mode: the summary layer's resolution (bp). */
  level?: number;
  exact?: boolean;
}

export interface PairStat {
  /** Index of the track in run.tracks. */
  ti: number;
  track: string;
  a: number;
  b: number;
  nA: number;
  nB: number;
  medianA: number;
  medianB: number;
  U: number;
  p: number;
  q: number;
  /** Why the pair was not tested (p and q are NaN): the groups share regions (a whole set and its own subsets, or two overlapping sets), or one has no signal. */
  untested?: "overlap" | "nodata";
}

export interface SignalRun {
  params: ProfileParams;
  sort: SignalSort;
  k: number;
  tracks: SignalTrackInfo[];
  groups: SignalGroup[];
  regions: (ProfileRegion & { group: number })[];
  matrices: SignalMatrix[];
  /** Display order of region indexes, grouped (by group, or by cluster when k > 1). */
  order: number[];
  /** Per region: its display band (group index, or cluster). */
  band: Int32Array;
  clusters: Int32Array | null;
  /** Per track, its colour-scale range. */
  ranges: [number, number][];
  stats: PairStat[];
  /** The number of regions before sampling down to the cap, or null. */
  sampledFrom: number | null;
}

export interface SignalRequest {
  /** For messages ("Is it for hg38?"). */
  assembly: string;
  params: ProfileParams;
  sort: SignalSort;
  /** k-means clusters of the rows (1 = none). */
  k: number;
  groups: (SignalGroup & { regions: Interval[] })[];
  /** overlaps[a][b]: groups a and b can hold the same loci (selection.ts sharesRegions), so the Mann–Whitney test, which needs independent groups, is skipped. */
  overlaps: boolean[][];
  tracks: SignalTrack[];
  /** Most regions read (a fixed sample above it): MAX_SIGNAL_ROWS, or fewer for range requests. */
  cap: number;
}

export interface SignalProgress {
  done: number;
  total: number;
  label: string;
  unit?: string;
}

export function median(v: number[]): number {
  const s = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Deterministic subsample (seeded Fisher–Yates) of n items, keeping their order. */
export function sample<T>(items: T[], n: number): T[] {
  let a = 12345;
  const rand = () => {
    a = (a * 1103515245 + 12345) >>> 0;
    return a / 4294967296;
  };
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, n)
    .sort((x, y) => x - y)
    .map((i) => items[i]);
}

/** The items, or a fixed sample of `cap` of them (and how many there were). */
export function sampleRegions<T>(items: T[], cap: number): { items: T[]; sampledFrom: number | null } {
  return items.length > cap ? { items: sample(items, cap), sampledFrom: items.length } : { items, sampledFrom: null };
}

export async function runSignalProfiles(req: SignalRequest, o: { onProgress?: (p: SignalProgress) => void; signal?: AbortSignal } = {}): Promise<SignalRun> {
  const all = req.groups.flatMap((g, i) => g.regions.map((r) => ({ chrom: r.chrom, start: r.start, end: r.end, group: i })));
  const { items: regions, sampledFrom } = sampleRegions(all, req.cap);
  const total = regions.length * req.tracks.length;
  const matrices: SignalMatrix[] = [];
  const tracks: SignalTrackInfo[] = [];
  for (const [ti, t] of req.tracks.entries()) {
    abortIfCancelled(o.signal);
    o.onProgress?.({ done: ti * regions.length, total, label: `Reading ${t.name}`, unit: "regions" });
    const src = await t.open();
    tracks.push({ id: t.id, name: t.name, how: src.how ?? t.how ?? "", ...(t.host ? { host: t.host } : {}), ...(src.level !== undefined ? { level: src.level } : {}), ...(t.exact ? { exact: true } : {}) });
    const shared = new Set(regions.map((r) => r.chrom)).size;
    const named = [...new Set(regions.map((r) => r.chrom))].filter((c) => chromAlias(c, src.chroms)).length;
    if (!named) throw new Error(`${t.name} has none of the subsets' chromosomes (it names ${[...src.chroms.keys()].slice(0, 3).join(", ")}…). Is it for ${req.assembly}?`);
    if (named < shared) console.info(`${t.name}: ${shared - named} of the subsets' chromosomes are not in this bigWig; their bins are empty.`);
    matrices.push(
      await computeSignalMatrix(regions, src.read, req.params, {
        signal: o.signal,
        withRegionMeans: true,
        concurrency: t.concurrency ?? 1,
        onProgress: (d) => o.onProgress?.({ done: ti * regions.length + d, total, label: `Reading ${t.name}`, unit: "regions" }),
      })
    );
  }
  return buildSignalRun({ params: req.params, sort: req.sort, k: req.k, tracks, groups: req.groups.map(({ mask, label }) => ({ mask, label })), regions, matrices, sampledFrom, overlaps: req.overlaps });
}

/** Order, clusters, colour ranges and tests of computed matrices (no reading). */
export function buildSignalRun(x: Omit<SignalRun, "order" | "band" | "clusters" | "ranges" | "stats"> & { overlaps: boolean[][] }): SignalRun {
  const n = x.regions.length;
  const nB = x.matrices[0]?.nBins ?? 0;
  // Rows across all tracks side by side: what sorting and clustering use (as deepTools does).
  const joined = new Float32Array(n * nB * x.matrices.length);
  const width = nB * x.matrices.length;
  for (let r = 0; r < n; r++) x.matrices.forEach((m, t) => joined.set(m.values.subarray(r * nB, (r + 1) * nB), r * width + t * nB));
  const all = Array.from({ length: n }, (_, i) => i);
  const clusters = x.k > 1 ? kmeansRows(joined, width, all, x.k, 1) : null;
  const band = clusters ?? Int32Array.from(x.regions.map((r) => r.group));
  const nBands = clusters ? Math.max(...clusters) + 1 : x.groups.length;
  const means = all.map((r) => rowMean(joined, width, r));
  const order: number[] = [];
  for (let b = 0; b < nBands; b++) {
    const rows = all.filter((r) => band[r] === b);
    if (x.sort !== "keep")
      rows.sort((p, q) => {
        const a = means[p];
        const c = means[q];
        if (Number.isNaN(a) || Number.isNaN(c)) return Number(Number.isNaN(a)) - Number(Number.isNaN(c));
        return x.sort === "desc" ? c - a : a - c;
      });
    order.push(...rows);
  }
  const ranges = x.matrices.map((m): [number, number] => {
    const v = Array.from(m.values).filter((y) => !Number.isNaN(y));
    if (v.length > 200_000) v.length = 200_000;
    v.sort((a, b) => a - b);
    const lo = Math.min(0, quantile(v, 0.02));
    const hi = quantile(v, 0.98);
    return [lo, hi > lo ? hi : lo + 1];
  });
  // Per-region mean signal compared between groups (not clusters: those are made from the signal itself).
  const stats: PairStat[] = [];
  x.tracks.forEach((t, ti) => {
    const byGroup = x.groups.map((_, g) => x.regions.map((r, i) => (r.group === g ? x.matrices[ti].regionMeans![i] : NaN)).filter((v) => !Number.isNaN(v)));
    const pairs: PairStat[] = [];
    for (let a = 0; a < x.groups.length; a++)
      for (let b = a + 1; b < x.groups.length; b++) {
        const r = mannWhitneyU(byGroup[a], byGroup[b]);
        // Not tested (p and q are NaN, left out of BH): groups that share regions (the test needs independent groups), or one without signal at any of its regions.
        const untested = x.overlaps[a]?.[b] ? ("overlap" as const) : !(r.n1 && r.n2) ? ("nodata" as const) : undefined;
        const p = untested ? NaN : r.p;
        pairs.push({
          ti,
          track: t.name,
          a,
          b,
          nA: r.n1,
          nB: r.n2,
          medianA: median(byGroup[a]),
          medianB: median(byGroup[b]),
          U: untested ? NaN : r.U,
          p,
          q: p,
          ...(untested ? { untested } : {}),
        });
      }
    const tested = pairs.filter((p) => !Number.isNaN(p.p));
    const q = benjaminiHochberg(tested.map((p) => p.p));
    tested.forEach((p, i) => (p.q = q[i]));
    stats.push(...pairs);
  });
  return { params: x.params, sort: x.sort, k: x.k, tracks: x.tracks, groups: x.groups, regions: x.regions, matrices: x.matrices, order, band, clusters, ranges, stats, sampledFrom: x.sampledFrom };
}

// ---- downloads ----

export function signalMatrixTsv(run: SignalRun, ti: number): string {
  const m = run.matrices[ti];
  const head = ["chrom", "start", "end", "subset", ...(run.clusters ? ["cluster"] : []), ...Array.from({ length: m.nBins }, (_, b) => `bin_${b + 1}`)];
  const lines = run.order.map((i) => {
    const r = run.regions[i];
    const vals = Array.from(m.values.subarray(i * m.nBins, (i + 1) * m.nBins), (v) => (Number.isNaN(v) ? "nan" : String(+v.toPrecision(6))));
    return [r.chrom, r.start, r.end, run.groups[r.group].label, ...(run.clusters ? [run.clusters[i] + 1] : []), ...vals].join("\t");
  });
  return [`# ${run.tracks[ti].name}; ${run.params.mode === "scale" ? "scale-regions" : `reference-point (${run.params.referencePoint})`}, upstream ${run.params.upstream}, ${run.params.mode === "scale" ? `body ${run.params.body}, ` : ""}downstream ${run.params.downstream}, bin ${run.params.binSize} bp`, head.join("\t"), ...lines].join("\n") + "\n";
}

export function signalRegionMeansTsv(run: SignalRun): string {
  const head = ["chrom", "start", "end", "subset", ...(run.clusters ? ["cluster"] : []), ...run.tracks.map((t) => `mean_${t.name}`)];
  const lines = run.regions.map((r, i) => [r.chrom, r.start, r.end, run.groups[r.group].label, ...(run.clusters ? [run.clusters[i] + 1] : []), ...run.matrices.map((m) => (Number.isNaN(m.regionMeans![i]) ? "nan" : String(+m.regionMeans![i].toPrecision(6))))].join("\t"));
  return [head.join("\t"), ...lines].join("\n") + "\n";
}

export function signalStatsTsv(run: SignalRun): string {
  const head = ["track", "subset_a", "subset_b", "n_a", "n_b", "median_a", "median_b", "U", "p", "q", "test"];
  const lines = run.stats.map((s) =>
    [s.track, run.groups[s.a].label, run.groups[s.b].label, s.nA, s.nB, +s.medianA.toPrecision(6), +s.medianB.toPrecision(6), ...[s.U, s.p, s.q].map((v) => (Number.isNaN(v) ? "NA" : v)), s.untested === "overlap" ? "not tested: the groups share regions" : s.untested ? "not tested: no signal in a group" : "Mann-Whitney U, two-sided, normal approximation"].join("\t")
  );
  return [head.join("\t"), ...lines].join("\n") + "\n";
}

export function signalClustersBed(run: SignalRun): string {
  return run.order.map((i) => [run.regions[i].chrom, run.regions[i].start, run.regions[i].end, `cluster_${run.clusters![i] + 1}`].join("\t")).join("\n") + "\n";
}
