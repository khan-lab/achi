/**
 * Permutation test of overlap between region sets (the Pairwise view's
 * "Permutation"; the CLI's --pairwise permutation), as in regioneR's
 * permTest with numOverlaps and randomizeRegions:
 *
 *   H0: A's regions lie where they do independently of B, given each
 *   region's length and (by default) chromosome.
 *
 * Each permutation places every region of A again, keeping its length,
 * uniformly at random among the start positions where it lies entirely in
 * the allowed genome: its own chromosome (or anywhere), minus the UCSC
 * assembly gaps (refdata/<asm>/go/gaps.bed, the same file GREAT uses) and,
 * by default, the ENCODE blacklist. Placed regions may overlap each other.
 * B stays as it is. The statistic is the number of A regions overlapping
 * at least one B region under the analysis's overlap rule (bedtools -f,
 * -F, -r, -e); the observed count is compared with the permuted ones by
 * empirical p-values (b + 1) / (m + 1).
 *
 * Randomness comes from a seeded generator here, not from the platform, so
 * the web app, the CLI and the MCP server give identical permutations for
 * the same seed. Each set's permutations are seeded by the seed, the set's
 * own regions and the permutation number, so they do not change when other
 * sets are added, removed or reordered.
 */
import { hasBlacklist, blacklistPath } from "./blacklist";
import { parseBed } from "./intervals";
import { abortIfCancelled, loadRefText, type Runtime } from "./runtime";
import { benjaminiHochberg } from "./stats";
import type { MethodsExtra } from "./analysisExport";
import type { Interval } from "./types";

// ---- settings ----

export interface PermutationSettings {
  /** Number of permutations. */
  n: number;
  seed: number;
  /** Keep each region on its own chromosome (default), or place it anywhere in the genome. */
  sameChromosome: boolean;
  /** Never place a region on the ENCODE blacklist (where the assembly has one). */
  excludeBlacklist: boolean;
}

export const PERMUTATION_DEFAULTS: PermutationSettings = { n: 1000, seed: 1, sameChromosome: true, excludeBlacklist: true };
export const PERMUTATION_LIMITS = { minN: 10, maxN: 100_000 };

/** Assemblies with UCSC assembly gaps (refdata/<asm>/go/gaps.bed, public/refdata/build_go.py). */
export const GAP_ASSEMBLIES = ["hg38", "hg19", "mm10", "mm9"];

export function validatePermutationSettings(s: PermutationSettings): string | null {
  if (!Number.isInteger(s.n) || s.n < PERMUTATION_LIMITS.minN || s.n > PERMUTATION_LIMITS.maxN) return `The number of permutations must be a whole number from ${PERMUTATION_LIMITS.minN} to ${PERMUTATION_LIMITS.maxN.toLocaleString("en-US")}.`;
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff) return "The seed must be a whole number from 0 to 4,294,967,295.";
  return null;
}

// ---- the overlap rule ----

/** bedtools' overlap options: fractions of A (-f) and B (-F), reciprocal (-r), either (-e). 0 means any overlap of ≥ 1 bp. */
export interface OverlapRule {
  f: number;
  F: number;
  r: boolean;
  e: boolean;
}

export function parseOverlapRule(flags: string): OverlapRule | { error: string } {
  const t = flags.trim().split(/\s+/).filter(Boolean);
  const rule: OverlapRule = { f: 0, F: 0, r: false, e: false };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (tok === "-f" || tok === "-F") {
      const v = Number(t[++i]);
      if (!(v > 0 && v <= 1)) return { error: `The overlap option ${tok} needs a fraction above 0 and at most 1.` };
      if (tok === "-f") rule.f = v;
      else rule.F = v;
    } else if (tok === "-r") rule.r = true;
    else if (tok === "-e") rule.e = true;
    else return { error: `The permutation test supports the overlap options -f, -F, -r and -e; ${tok} is not one of them. Change the overlap setting to use it.` };
  }
  if (rule.r) rule.F = rule.f;
  return rule;
}

function satisfies(rule: OverlapRule, ov: number, lenA: number, lenB: number): boolean {
  if (rule.f === 0 && rule.F === 0) return true;
  const okA = rule.f === 0 || ov / lenA >= rule.f;
  const okB = rule.F === 0 || ov / lenB >= rule.F;
  return rule.e ? okA || okB : okA && okB;
}

// ---- B, indexed for "does this region overlap B?" ----

interface ChromIndex {
  starts: Float64Array;
  ends: Float64Array;
  /** Largest end among regions 0..i. */
  maxEnd: Float64Array;
}

/** B's regions per chromosome, sorted by start, with the running maximum end. */
export class OverlapIndex {
  private readonly byChrom = new Map<string, ChromIndex>();

  constructor(regions: Interval[]) {
    const groups = new Map<string, Interval[]>();
    for (const r of regions) {
      const g = groups.get(r.chrom);
      if (g) g.push(r);
      else groups.set(r.chrom, [r]);
    }
    for (const [chrom, g] of groups) {
      g.sort((a, b) => a.start - b.start || a.end - b.end);
      const starts = Float64Array.from(g, (r) => r.start);
      const ends = Float64Array.from(g, (r) => r.end);
      const maxEnd = new Float64Array(g.length);
      let m = -Infinity;
      for (let i = 0; i < g.length; i++) maxEnd[i] = m = Math.max(m, ends[i]);
      this.byChrom.set(chrom, { starts, ends, maxEnd });
    }
  }

  /** Whether [start, end) on `chrom` overlaps some region under `rule`. */
  hits(chrom: string, start: number, end: number, rule: OverlapRule): boolean {
    const c = this.byChrom.get(chrom);
    if (!c) return false;
    // Last region starting before `end`.
    let lo = 0;
    let hi = c.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (c.starts[mid] < end) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo - 1; j >= 0 && c.maxEnd[j] > start; j--) {
      if (c.ends[j] <= start) continue;
      const ov = Math.min(end, c.ends[j]) - Math.max(start, c.starts[j]);
      if (satisfies(rule, ov, end - start, c.ends[j] - c.starts[j])) return true;
    }
    return false;
  }
}

/** Regions of `a` overlapping at least one region of the index (bedtools intersect -u's count). */
export function countOverlapping(a: Interval[], idx: OverlapIndex, rule: OverlapRule): number {
  let n = 0;
  for (const r of a) if (idx.hits(r.chrom, r.start, r.end, rule)) n++;
  return n;
}

// ---- random numbers (identical on every platform) ----

function fmix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Unsigned 32-bit integers from sfc32, its state set from the seed and the
 * salts (a set's hash, a permutation number) through splitmix32.
 */
export function randomStream(seed: number, ...salts: number[]): () => number {
  let s = fmix32((seed >>> 0) ^ 0x9e3779b9);
  for (const x of salts) s = fmix32((s ^ (x >>> 0)) + 0x7f4a7c15);
  const split = () => {
    s = (s + 0x9e3779b9) | 0;
    return fmix32(s);
  };
  let a = split();
  let b = split();
  let c = split();
  let d = split();
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next(); // let the state mix
  return next;
}

/** A uniform whole number in [0, w), w ≤ 2^32, without modulo bias. */
function uniform(next: () => number, w: number): number {
  const limit = 2 ** 32 - (2 ** 32 % w);
  let u = next();
  while (u >= limit) u = next();
  return u % w;
}

/** FNV-1a of the regions sorted by chromosome, start and end: the same for the same regions in any order. */
export function hashRegions(regions: Interval[]): number {
  const sorted = [...regions].sort((x, y) => (x.chrom < y.chrom ? -1 : x.chrom > y.chrom ? 1 : x.start - y.start || x.end - y.end));
  let h = 0x811c9dc5;
  for (const r of sorted) {
    const line = `${r.chrom}\t${r.start}\t${r.end}\n`;
    for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

// ---- the allowed genome ----

export interface Segments {
  starts: number[];
  ends: number[];
  /** Allowed bp before each segment. */
  before: number[];
  total: number;
  longest: number;
}

export interface ShuffleSpace {
  /** In chromosome-sizes order. */
  chroms: string[];
  segments: Map<string, Segments>;
  /** Allowed bp before each chromosome, in `chroms` order. */
  before: number[];
  total: number;
  longest: number;
}

/** Each chromosome of the sizes file minus the union of `masks` (gaps, blacklist). */
export function allowedSpace(chromSizesText: string, masks: Interval[][]): ShuffleSpace {
  const sizes = chromSizesText
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 2 && f[0] && Number(f[1]) > 0)
    .map((f) => [f[0], Number(f[1])] as const);
  const byChrom = new Map<string, Interval[]>();
  for (const m of masks.flat()) {
    const g = byChrom.get(m.chrom);
    if (g) g.push(m);
    else byChrom.set(m.chrom, [m]);
  }
  const space: ShuffleSpace = { chroms: [], segments: new Map(), before: [], total: 0, longest: 0 };
  for (const [chrom, size] of sizes) {
    const mask = (byChrom.get(chrom) ?? []).slice().sort((a, b) => a.start - b.start);
    const seg: Segments = { starts: [], ends: [], before: [], total: 0, longest: 0 };
    let pos = 0;
    const add = (s: number, e: number) => {
      if (e <= s) return;
      seg.starts.push(s);
      seg.ends.push(e);
      seg.before.push(seg.total);
      seg.total += e - s;
      seg.longest = Math.max(seg.longest, e - s);
    };
    for (const m of mask) {
      add(pos, Math.min(m.start, size));
      pos = Math.max(pos, m.end);
    }
    add(pos, size);
    space.chroms.push(chrom);
    space.segments.set(chrom, seg);
    space.before.push(space.total);
    space.total += seg.total;
    space.longest = Math.max(space.longest, seg.longest);
  }
  return space;
}

/** Index of the last entry of the ascending `before` that is ≤ x. */
function locate(before: number[], x: number): number {
  let lo = 0;
  let hi = before.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (before[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Whether a region of length `len` can be placed: its chromosome is in the space and has a long enough stretch (or, anywhere, the genome has). */
function placeable(r: Interval, space: ShuffleSpace, sameChromosome: boolean): boolean {
  const len = r.end - r.start;
  if (!space.segments.has(r.chrom)) return false;
  return len <= (sameChromosome ? space.segments.get(r.chrom)!.longest : space.longest);
}

/**
 * One start drawn uniformly among the valid starts (the region fits inside
 * one allowed segment). Rejection: a uniform allowed base, kept when the
 * region starting there fits; after 64 misses (a region nearly as long as
 * the stretches it can go in), the exact draw over valid starts.
 */
function place(len: number, chrom: string | null, space: ShuffleSpace, next: () => number): Interval {
  const total = chrom ? space.segments.get(chrom)!.total : space.total;
  for (let tries = 0; tries < 64; tries++) {
    let x = uniform(next, total);
    let c = chrom;
    if (!c) {
      const ci = locate(space.before, x);
      c = space.chroms[ci];
      x -= space.before[ci];
    }
    const seg = space.segments.get(c)!;
    const si = locate(seg.before, x);
    const start = seg.starts[si] + (x - seg.before[si]);
    if (start + len <= seg.ends[si]) return { chrom: c, start, end: start + len };
  }
  const options: { chrom: string; start: number; count: number }[] = [];
  let sum = 0;
  for (const c of chrom ? [chrom] : space.chroms) {
    const seg = space.segments.get(c)!;
    for (let i = 0; i < seg.starts.length; i++) {
      const count = seg.ends[i] - seg.starts[i] - len + 1;
      if (count > 0) {
        options.push({ chrom: c, start: seg.starts[i], count });
        sum += count;
      }
    }
  }
  let x = uniform(next, sum);
  for (const o of options) {
    if (x < o.count) return { chrom: o.chrom, start: o.start + x, end: o.start + x + len };
    x -= o.count;
  }
  throw new Error("unreachable: no valid start");
}

/** One permutation of `regions`; regions that cannot be placed are left out and counted. */
export function shuffleRegions(regions: Interval[], space: ShuffleSpace, next: () => number, sameChromosome: boolean): { regions: Interval[]; leftOut: number } {
  const out: Interval[] = [];
  let leftOut = 0;
  for (const r of regions) {
    if (!placeable(r, space, sameChromosome)) {
      leftOut++;
      continue;
    }
    out.push(place(r.end - r.start, sameChromosome ? r.chrom : null, space, next));
  }
  return { regions: out, leftOut };
}

// ---- statistics ----

export interface PermutationStats {
  mean: number;
  /** Sample standard deviation of the permuted counts. */
  sd: number;
  /** Observed / mean permuted; Inf when the mean is 0 and the observed is not, NaN when both are 0. */
  fold: number;
  z: number;
  /** (1 + #{permuted ≥ observed}) / (n + 1). */
  pGreater: number;
  /** (1 + #{permuted ≤ observed}) / (n + 1). */
  pLess: number;
  /** min(1, 2 × min(pGreater, pLess)). */
  p: number;
}

export function permutationStats(observed: number, perms: Int32Array): PermutationStats {
  const n = perms.length;
  let sum = 0;
  let ge = 0;
  let le = 0;
  for (const x of perms) {
    sum += x;
    if (x >= observed) ge++;
    if (x <= observed) le++;
  }
  const mean = sum / n;
  let ss = 0;
  for (const x of perms) ss += (x - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : NaN;
  const fold = mean > 0 ? observed / mean : observed > 0 ? Infinity : NaN;
  const z = sd > 0 ? (observed - mean) / sd : NaN;
  const pGreater = (1 + ge) / (n + 1);
  const pLess = (1 + le) / (n + 1);
  return { mean, sd, fold, z, pGreater, pLess, p: Math.min(1, 2 * Math.min(pGreater, pLess)) };
}

// ---- the analysis, as the web app, CLI and MCP server run it ----

export interface PermutationRequest {
  assembly: string;
  sets: { id: string; name: string; file: Blob }[];
  /** The analysis's overlap flags (bedtoolsOptions.ts resolveOverlapFlags). */
  overlapFlags: string;
  settings: PermutationSettings;
}

export interface PermutationPair extends PermutationStats {
  a: string;
  b: string;
  /** A's regions tested (placeable). */
  nTested: number;
  /** A's regions left out: on a chromosome outside the assembly, or longer than any allowed stretch. */
  leftOut: number;
  observed: number;
  /** The statistic in each permutation. */
  perms: Int32Array;
  /** Benjamini–Hochberg over every pair of the run. */
  q: number;
}

export interface PermutationRun {
  assembly: string;
  overlapFlags: string;
  settings: PermutationSettings;
  /** Whether the ENCODE blacklist was excluded (asked for, and the assembly has one). */
  blacklistExcluded: boolean;
  pairs: PermutationPair[];
}

/**
 * The test for every ordered pair of sets. Each set is permuted `n` times
 * and every permutation is compared with each other set. `yieldEvery`
 * lets the caller's event loop breathe (the web app passes a timeout) every
 * few permutations.
 */
export async function runPermutation(
  rt: Pick<Runtime, "refdata">,
  req: PermutationRequest,
  o: { onProgress?: (p: { done: number; total: number; label: string; unit?: string }) => void; signal?: AbortSignal; pause?: () => Promise<void> } = {}
): Promise<PermutationRun> {
  const { assembly, settings } = req;
  const rule = parseOverlapRule(req.overlapFlags);
  if ("error" in rule) throw new Error(rule.error);
  const bad = validatePermutationSettings(settings);
  if (bad) throw new Error(bad);
  if (!GAP_ASSEMBLIES.includes(assembly)) throw new Error(`The permutation test needs the assembly gaps of ${assembly}, which Achi does not have; it is available for ${GAP_ASSEMBLIES.join(", ")}.`);
  if (req.sets.length < 2) throw new Error("The permutation test needs at least two sets.");

  const sizes = await loadRefText(rt, `refdata/${assembly}/${assembly}.chrom.sizes`, `the ${assembly} chromosome sizes`);
  const masks = [parseBed(await loadRefText(rt, `refdata/${assembly}/go/gaps.bed`, `the ${assembly} assembly gaps`))];
  const blacklistExcluded = settings.excludeBlacklist && hasBlacklist(assembly);
  if (blacklistExcluded) masks.push(parseBed(await loadRefText(rt, blacklistPath(assembly), `the ${assembly} ENCODE blacklist`)));
  const space = allowedSpace(sizes, masks);

  const regions = await Promise.all(req.sets.map(async (s) => parseBed(await s.file.text())));
  const index = regions.map((r) => new OverlapIndex(r));
  const total = req.sets.length * settings.n;
  const pairs: Omit<PermutationPair, "q">[] = [];

  for (let i = 0; i < req.sets.length; i++) {
    const tested = regions[i].filter((r) => placeable(r, space, settings.sameChromosome));
    const leftOut = regions[i].length - tested.length;
    const others = req.sets.map((_, j) => j).filter((j) => j !== i);
    const perms = others.map(() => new Int32Array(settings.n));
    const hash = hashRegions(tested);
    for (let k = 0; k < settings.n; k++) {
      if (k % 10 === 0) {
        abortIfCancelled(o.signal);
        await o.pause?.();
      }
      const shuffled = shuffleRegions(tested, space, randomStream(settings.seed, hash, k), settings.sameChromosome).regions;
      others.forEach((j, m) => (perms[m][k] = countOverlapping(shuffled, index[j], rule)));
      if ((k + 1) % 10 === 0 || k + 1 === settings.n) o.onProgress?.({ done: i * settings.n + k + 1, total, label: `Shuffling ${req.sets[i].name}`, unit: "permutations" });
    }
    others.forEach((j, m) => {
      const observed = countOverlapping(tested, index[j], rule);
      pairs.push({ a: req.sets[i].id, b: req.sets[j].id, nTested: tested.length, leftOut, observed, perms: perms[m], ...permutationStats(observed, perms[m]) });
    });
  }
  const q = benjaminiHochberg(pairs.map((p) => p.p));
  return { assembly, overlapFlags: req.overlapFlags, settings, blacklistExcluded, pairs: pairs.map((p, i) => ({ ...p, q: q[i] })) };
}

// ---- table and methods ----

const tsvNum = (x: number) => (Number.isNaN(x) ? "NA" : x === Infinity ? "Inf" : x === -Infinity ? "-Inf" : String(x));

/** One row per ordered pair, in the run's order; sets named by `sets`' names. */
export function permutationTsv(sets: { id: string; name: string }[], run: PermutationRun): string {
  const name = (id: string) => sets.find((s) => s.id === id)?.name ?? id;
  const head = ["set_a", "set_b", "n_a_tested", "n_a_left_out", "observed", "mean_shuffled", "sd_shuffled", "fold", "z", "p_greater", "p_less", "p_two_sided", "q"];
  const rows = run.pairs.map((p) => [name(p.a), name(p.b), ...[p.nTested, p.leftOut, p.observed, p.mean, p.sd, p.fold, p.z, p.pGreater, p.pLess, p.p, p.q].map(tsvNum)].join("\t"));
  return [head.join("\t"), ...rows].join("\n") + "\n";
}

export const PERMUTATION_REFS = {
  regioneR:
    "Gel B, Díez-Villanueva A, Serra E, Buschbeck M, Peinado MA, Malinverni R. regioneR: an R/Bioconductor package for the association analysis of genomic regions based on permutation tests. Bioinformatics. 2016;32(2):289–291. doi:10.1093/bioinformatics/btv562",
  phipson:
    "Phipson B, Smyth GK. Permutation P-values should never be zero: calculating exact P-values when permutations are randomly drawn. Stat Appl Genet Mol Biol. 2010;9:Article39. doi:10.2202/1544-6115.1585",
};

export function permutationMethods(r: { assembly: string; overlapFlags: string; settings: PermutationSettings; blacklistExcluded?: boolean }): MethodsExtra {
  const s = r.settings;
  const blacklist = r.blacklistExcluded ?? (s.excludeBlacklist && hasBlacklist(r.assembly));
  const flags = r.overlapFlags.trim();
  const overlap = flags ? `under the overlap rule bedtools intersect ${flags} would apply` : "by at least 1 bp";
  return {
    methods:
      `For every ordered pair of input sets (A, B), overlap was tested by permutation, as in regioneR: in each of ${s.n.toLocaleString("en-US")} permutations, every region of A was placed again ` +
      `${s.sameChromosome ? "on the same chromosome" : "anywhere in the genome"}, keeping its length, uniformly among the positions where it lies entirely outside the UCSC ${r.assembly} assembly gaps` +
      `${blacklist ? " and the ENCODE blacklist v2" : ""}; placed regions could overlap one another, and B was kept as it is. ` +
      `The statistic was the number of regions of A overlapping at least one region of B ${overlap}. ` +
      `Its observed value was compared with the permuted values by the empirical p-values (1 + #{permuted ≥ observed}) / (n + 1) and (1 + #{permuted ≤ observed}) / (n + 1), with n the number of permutations; ` +
      `the two-sided p-value is twice the smaller of the two, at most 1, and q-values are Benjamini–Hochberg over all ordered pairs. Fold change is the observed count divided by the mean permuted count. ` +
      `Regions of A on chromosomes outside the ${r.assembly} chromosome sizes, or longer than any stretch they could be placed in, were left out of both the observed count and the permutations. ` +
      `Permutations were drawn with Achi's seeded generator (seed ${s.seed}), so the same seed and inputs give the same permutations in the web app and the command-line tool.`,
    references: [PERMUTATION_REFS.regioneR, PERMUTATION_REFS.phipson],
  };
}
