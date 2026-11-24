/**
 * Signal profiles over regions: our reimplementation of deepTools
 * computeMatrix (Ramírez et al., 2016), checked against deepTools 4.0.0 on
 * real data (signalMatrix.test.ts, tests/fixtures/deeptools/PROVENANCE.md).
 *
 * For each region, a row of bins:
 *  - scale-regions: `upstream` bp before the region, the region itself
 *    stretched to `body` bp, and `downstream` bp after it. Body bin k covers
 *    start + floor(k·L/n) to start + floor((k+1)·L/n), n = body / binSize;
 *  - reference-point: `upstream` bp before and `downstream` bp after one point
 *    of the region: its 5' end ("start": the start on + and unstranded, the
 *    end on −), its centre (floor((start + end) / 2)) or its 3' end ("end").
 * Rows always run 5' to 3': on − the bins are reversed, so upstream is to the
 * right of the region on the genome. Each bin's value is the mean signal over
 * the bases in it that have data; a bin with none is NaN, or 0 with
 * `missingAsZero` (deepTools --missingDataAsZero).
 *
 * The rest summarises a matrix: the mean ± standard error per bin (the
 * profile), row order, k-means clusters of rows, and each region's own mean
 * signal (the per-region summary).
 */

export type ProfileMode = "scale" | "reference";
export type ReferencePoint = "start" | "center" | "end";

export interface ProfileParams {
  mode: ProfileMode;
  /** Reference-point mode only. */
  referencePoint: ReferencePoint;
  upstream: number;
  downstream: number;
  /** Scale-regions mode only: the length every region is stretched or shrunk to. */
  body: number;
  binSize: number;
  missingAsZero: boolean;
}

export interface ProfileRegion {
  chrom: string;
  start: number;
  end: number;
  strand?: "+" | "-" | ".";
  name?: string;
}

export interface SignalInterval {
  start: number;
  end: number;
  score: number;
}

export type SignalRead = (chrom: string, start: number, end: number) => Promise<SignalInterval[]>;

export interface SignalMatrix {
  /** Row-major, nRows × nBins. */
  values: Float32Array;
  nRows: number;
  nBins: number;
  /** Each region's mean signal over its own bases with data (with `withRegionMeans`). */
  regionMeans?: Float64Array;
}

export const MAX_BINS = 1000;

export function binCounts(p: ProfileParams): { up: number; body: number; down: number; total: number } {
  const up = Math.round(p.upstream / p.binSize);
  const down = Math.round(p.downstream / p.binSize);
  const body = p.mode === "scale" ? Math.round(p.body / p.binSize) : 0;
  return { up, body, down, total: up + body + down };
}

/** Why these settings cannot be used, or null. */
export function validateProfileParams(p: ProfileParams): string | null {
  if (!Number.isInteger(p.binSize) || p.binSize < 1) return "The bin size must be a whole number of bases, at least 1.";
  const parts: [string, number][] = [
    ["Upstream", p.upstream],
    ["Downstream", p.downstream],
  ];
  if (p.mode === "scale") parts.push(["The region body", p.body]);
  for (const [label, v] of parts) {
    if (!Number.isInteger(v) || v < 0) return `${label} must be a whole number of bases.`;
    if (v % p.binSize) return `${label} (${v.toLocaleString("en-US")} bp) must be a multiple of the bin size (${p.binSize} bp).`;
  }
  if (p.mode === "scale" && p.body < p.binSize) return "The region body must be at least one bin long.";
  const { total } = binCounts(p);
  if (total < 1) return "Use flanks or a body of at least one bin.";
  if (total > MAX_BINS) return `That makes ${total.toLocaleString("en-US")} bins per region; the most is ${MAX_BINS.toLocaleString("en-US")}. Use larger bins or shorter flanks.`;
  return null;
}

/** The bins of one region, [start, end) on the genome, in output order (5' to 3'). */
export function binWindows(r: ProfileRegion, p: ProfileParams): [number, number][] {
  const minus = r.strand === "-";
  const b = p.binSize;
  const steps = (from: number, n: number): [number, number][] => Array.from({ length: n }, (_, k) => [from + k * b, from + (k + 1) * b]);
  // Genome order (left to right): what lies left of the anchor is upstream on +, downstream on −.
  const left = minus ? p.downstream : p.upstream;
  const right = minus ? p.upstream : p.downstream;
  let bins: [number, number][];
  if (p.mode === "reference") {
    const five = minus ? r.end : r.start;
    const three = minus ? r.start : r.end;
    const ref = p.referencePoint === "center" ? Math.floor((r.start + r.end) / 2) : p.referencePoint === "start" ? five : three;
    bins = steps(ref - left, (left + right) / b);
  } else {
    const n = Math.round(p.body / b);
    const L = r.end - r.start;
    const body: [number, number][] = Array.from({ length: n }, (_, k) => [r.start + Math.floor((k * L) / n), r.start + Math.floor(((k + 1) * L) / n)]);
    bins = [...steps(r.start - left, left / b), ...body, ...steps(r.end, right / b)];
  }
  return minus ? bins.reverse() : bins;
}

/** First index whose interval ends after `pos` (intervals sorted and not overlapping). */
function firstEndingAfter(iv: SignalInterval[], pos: number): number {
  let lo = 0;
  let hi = iv.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (iv[mid].end <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mean signal over the bases with data in each bin; NaN (or 0) where none. `intervals` sorted by start. */
export function meanOverBins(intervals: SignalInterval[], bins: [number, number][], missingAsZero = false): Float64Array {
  const out = new Float64Array(bins.length);
  bins.forEach(([s, e], i) => {
    let sum = 0;
    let covered = 0;
    for (let j = firstEndingAfter(intervals, s); j < intervals.length && intervals[j].start < e; j++) {
      const w = Math.min(e, intervals[j].end) - Math.max(s, intervals[j].start);
      if (w > 0) {
        sum += intervals[j].score * w;
        covered += w;
      }
    }
    out[i] = covered ? sum / covered : missingAsZero ? 0 : NaN;
  });
  return out;
}

function aborted(): Error {
  return new Error("Aborted");
}

export async function computeSignalMatrix(
  regions: ProfileRegion[],
  read: SignalRead,
  p: ProfileParams,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; withRegionMeans?: boolean; concurrency?: number } = {}
): Promise<SignalMatrix> {
  const problem = validateProfileParams(p);
  if (problem) throw new Error(problem);
  const nBins = binCounts(p).total;
  const values = new Float32Array(regions.length * nBins);
  const means = opts.withRegionMeans ? new Float64Array(regions.length) : undefined;
  let next = 0;
  let done = 0;
  const one = async (i: number) => {
    const r = regions[i];
    const bins = binWindows(r, p);
    let lo = means ? r.start : Infinity;
    let hi = means ? r.end : -Infinity;
    for (const [s, e] of bins) {
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    }
    // One read covers the bins and, when asked, the region itself.
    const iv = hi > 0 ? await read(r.chrom, Math.max(0, lo), hi) : [];
    values.set(meanOverBins(iv, bins, p.missingAsZero), i * nBins);
    if (means) means[i] = meanOverBins(iv, [[r.start, r.end]])[0];
    done++;
    if (done % 25 === 0 || done === regions.length) opts.onProgress?.(done, regions.length);
  };
  // Several regions in flight at once (remote files: one request each), each written to its own row.
  const worker = async () => {
    while (next < regions.length) {
      if (opts.signal?.aborted) throw aborted();
      await one(next++);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, regions.length)) }, worker));
  if (opts.signal?.aborted) throw aborted();
  return { values, nRows: regions.length, nBins, ...(means ? { regionMeans: means } : {}) };
}

/** Each region's mean signal over its own bases with data (NaN if none). */
export async function regionMeans(regions: ProfileRegion[], read: SignalRead, opts: { signal?: AbortSignal } = {}): Promise<number[]> {
  const out: number[] = [];
  for (const r of regions) {
    if (opts.signal?.aborted) throw aborted();
    out.push(meanOverBins(await read(r.chrom, r.start, r.end), [[r.start, r.end]])[0]);
  }
  return out;
}

/** Mean and standard error (sample SD / √n) per bin over `rows`, skipping NaN. */
export function profileStats(values: Float32Array, nBins: number, rows: number[]): { mean: Float64Array; se: Float64Array; n: Int32Array } {
  const mean = new Float64Array(nBins);
  const se = new Float64Array(nBins);
  const n = new Int32Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let sum = 0;
    let k = 0;
    for (const r of rows) {
      const v = values[r * nBins + b];
      if (!Number.isNaN(v)) {
        sum += v;
        k++;
      }
    }
    const m = k ? sum / k : NaN;
    let ss = 0;
    for (const r of rows) {
      const v = values[r * nBins + b];
      if (!Number.isNaN(v)) ss += (v - m) * (v - m);
    }
    mean[b] = m;
    n[b] = k;
    se[b] = k > 1 ? Math.sqrt(ss / (k - 1)) / Math.sqrt(k) : 0;
  }
  return { mean, se, n };
}

/** Mean over a row's bins with data (NaN if none). */
export function rowMean(values: Float32Array, nBins: number, r: number): number {
  let sum = 0;
  let k = 0;
  for (let b = 0; b < nBins; b++) {
    const v = values[r * nBins + b];
    if (!Number.isNaN(v)) {
      sum += v;
      k++;
    }
  }
  return k ? sum / k : NaN;
}

/** `rows` sorted by row mean (deepTools --sortRegions descend/ascend), rows without data last; "keep" leaves them. */
export function rowOrder(values: Float32Array, nBins: number, rows: number[], order: "desc" | "asc" | "keep"): number[] {
  if (order === "keep") return [...rows];
  const m = new Map(rows.map((r) => [r, rowMean(values, nBins, r)]));
  return [...rows].sort((a, b) => {
    const x = m.get(a)!;
    const y = m.get(b)!;
    if (Number.isNaN(x) || Number.isNaN(y)) return Number(Number.isNaN(x)) - Number(Number.isNaN(y));
    return order === "desc" ? y - x : x - y;
  });
}

/** Small seeded PRNG (mulberry32), so clusters are the same every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * k-means of the rows (Euclidean, missing bins as 0): k-means++ seeding with
 * a fixed seed, then Lloyd's iterations until no row moves (at most 100).
 * Returns a label per entry of `rows`; cluster 0 has the highest mean signal.
 */
export function kmeansRows(values: Float32Array, nBins: number, rows: number[], k: number, seed = 1): Int32Array {
  const n = rows.length;
  const kk = Math.max(1, Math.min(k, n));
  const labels = new Int32Array(n);
  if (n === 0) return labels;
  const x = (i: number, b: number) => {
    const v = values[rows[i] * nBins + b];
    return Number.isNaN(v) ? 0 : v;
  };
  const dist = (i: number, c: Float64Array) => {
    let d = 0;
    for (let b = 0; b < nBins; b++) d += (x(i, b) - c[b]) ** 2;
    return d;
  };
  const rand = rng(seed);
  const centers: Float64Array[] = [];
  const pick = (i: number) => centers.push(Float64Array.from({ length: nBins }, (_, b) => x(i, b)));
  pick(Math.floor(rand() * n));
  const d2 = new Float64Array(n).fill(Infinity);
  while (centers.length < kk) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      d2[i] = Math.min(d2[i], dist(i, centers[centers.length - 1]));
      total += d2[i];
    }
    if (!(total > 0)) break; // fewer distinct rows than k
    let target = rand() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d2[i];
      if (target <= 0) {
        chosen = i;
        break;
      }
    }
    pick(chosen);
  }
  for (let iter = 0; iter < 100; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      centers.forEach((c, j) => {
        const d = dist(i, c);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (labels[i] !== best) moved = true;
      labels[i] = best;
    }
    const sums = centers.map(() => new Float64Array(nBins));
    const counts = new Int32Array(centers.length);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      for (let b = 0; b < nBins; b++) sums[labels[i]][b] += x(i, b);
    }
    centers.forEach((c, j) => {
      if (counts[j]) for (let b = 0; b < nBins; b++) c[b] = sums[j][b] / counts[j];
    });
    if (!moved && iter > 0) break;
  }
  // Number clusters by mean signal, highest first.
  const centerMean = centers.map((c) => c.reduce((a, v) => a + v, 0) / nBins);
  const rank = centerMean.map((_, j) => j).sort((a, b) => centerMean[b] - centerMean[a]);
  const relabel = new Int32Array(centers.length);
  rank.forEach((j, r) => (relabel[j] = r));
  return labels.map((l) => relabel[l]);
}
