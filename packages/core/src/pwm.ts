/**
 * Position weight matrices for motif enrichment (components/MotifEnrichmentPanel.tsx):
 * JASPAR frequency matrices to log-odds scores, an exact score threshold
 * for a p-value, and scanning of both strands. Our own code (MIT, like the
 * rest of the app); checked against MOODS (pwm.test.ts), which is not
 * shipped.
 *
 * - Log-odds: column j, base b: ln(((c_jb + ps·bg_b) / (N_j + ps)) / bg_b),
 *   pseudocount ps = 0.8 spread by the background (as MOODS log_odds and
 *   TFBSTools' default), natural log.
 * - Scores are rounded to integers in units of 1/SCALE nat, and the
 *   threshold is exact for that integer matrix: the smallest t with
 *   P(S ≥ t) ≤ p under an i.i.d. background, by dynamic programming over
 *   the score distribution (as TFM-Pvalue and FIMO do it, on a finer grid).
 * - The background is the strand-symmetric base composition of the
 *   sequences scanned.
 * - A site is a window of the motif's length with no N whose score on
 *   either strand is at least the threshold.
 */

/** Probabilities of A, C, G, T. */
export type Background = [number, number, number, number];

export const PSEUDOCOUNT = 0.8;
/** Integer score units per nat. */
export const SCALE = 100;

export interface ScoredMatrix {
  length: number;
  /** length × 4, [A, C, G, T] per column, integer scores. */
  fwd: Int32Array;
  /** The reverse complement, same layout. */
  rev: Int32Array;
  /** suffixMax[j]: the best score of columns j..length-1 (suffixMax[length] = 0), for early exit. */
  fwdSuffixMax: Int32Array;
  revSuffixMax: Int32Array;
}

/** A, C, G, T as 0-3 (either case); anything else (N, gaps, IUPAC) as 4. */
export function encodeSequence(seq: string): Uint8Array {
  const out = new Uint8Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i) | 0x20;
    out[i] = c === 97 ? 0 : c === 99 ? 1 : c === 103 ? 2 : c === 116 ? 3 : 4;
  }
  return out;
}

/** Strand-symmetric base composition of the sequences (A = T, C = G); uniform if there are no bases. */
export function backgroundOf(seqs: Uint8Array[]): Background {
  const n = [0, 0, 0, 0];
  for (const s of seqs) for (let i = 0; i < s.length; i++) if (s[i] < 4) n[s[i]]++;
  const total = n[0] + n[1] + n[2] + n[3];
  if (!total) return [0.25, 0.25, 0.25, 0.25];
  const at = (n[0] + n[3]) / 2 / total;
  const cg = (n[1] + n[2]) / 2 / total;
  return [at, cg, cg, at];
}

/** Natural-log log-odds, columns of [A, C, G, T]. */
export function logOddsMatrix(pfm: number[][], bg: Background, ps = PSEUDOCOUNT): number[][] {
  return pfm.map((col) => {
    const n = col[0] + col[1] + col[2] + col[3];
    return col.map((c, b) => Math.log((c + ps * bg[b]) / (n + ps) / bg[b]));
  });
}

function suffixMax(m: Int32Array, length: number): Int32Array {
  const out = new Int32Array(length + 1);
  for (let j = length - 1; j >= 0; j--) out[j] = out[j + 1] + Math.max(m[j * 4], m[j * 4 + 1], m[j * 4 + 2], m[j * 4 + 3]);
  return out;
}

export function integerMatrix(logOdds: number[][], scale = SCALE): ScoredMatrix {
  const length = logOdds.length;
  const fwd = new Int32Array(length * 4);
  logOdds.forEach((col, j) => col.forEach((v, b) => (fwd[j * 4 + b] = Math.round(v * scale))));
  const rev = new Int32Array(length * 4);
  for (let j = 0; j < length; j++) for (let b = 0; b < 4; b++) rev[j * 4 + b] = fwd[(length - 1 - j) * 4 + (3 - b)];
  return { length, fwd, rev, fwdSuffixMax: suffixMax(fwd, length), revSuffixMax: suffixMax(rev, length) };
}

/** The distribution of the integer score of one window under `bg`: probabilities indexed from the lowest score `lo`. */
function scoreDistribution(m: ScoredMatrix, bg: Background): { lo: number; dist: Float64Array } {
  let lo = 0;
  let hi = 0;
  let dist = new Float64Array([1]);
  for (let j = 0; j < m.length; j++) {
    const w = [m.fwd[j * 4], m.fwd[j * 4 + 1], m.fwd[j * 4 + 2], m.fwd[j * 4 + 3]];
    const cmin = Math.min(...w);
    const cmax = Math.max(...w);
    const next = new Float64Array(hi - lo + cmax - cmin + 1);
    for (let s = 0; s < dist.length; s++) {
      const pr = dist[s];
      if (!pr) continue;
      for (let b = 0; b < 4; b++) next[s + w[b] - cmin] += pr * bg[b];
    }
    lo += cmin;
    hi += cmax;
    dist = next;
  }
  return { lo, dist };
}

/** P(S ≥ t) for one window of a random sequence drawn from `bg` (exact for the integer matrix). */
export function tailProbability(m: ScoredMatrix, bg: Background, t: number): number {
  const { lo, dist } = scoreDistribution(m, bg);
  let p = 0;
  for (let s = Math.max(0, t - lo); s < dist.length; s++) p += dist[s];
  return p;
}

/** The smallest integer score t with P(S ≥ t) ≤ p for a random sequence drawn from `bg` (exact for the integer matrix). */
export function thresholdForP(m: ScoredMatrix, bg: Background, p: number): number {
  const { lo, dist } = scoreDistribution(m, bg);
  let tail = 0;
  for (let s = dist.length - 1; s >= 0; s--) {
    tail += dist[s];
    if (tail > p * (1 + 1e-12)) return lo + s + 1;
  }
  return lo; // every score qualifies (p ≥ 1)
}

/** Score of the window at `pos` on one strand, or -Infinity once it cannot reach `t` or meets an N. */
function windowScore(seq: Uint8Array, pos: number, m: Int32Array, suffix: Int32Array, length: number, t: number): number {
  let s = 0;
  for (let j = 0; j < length; j++) {
    const c = seq[pos + j];
    if (c > 3) return -Infinity;
    s += m[j * 4 + c];
    if (s + suffix[j + 1] < t) return -Infinity;
  }
  return s;
}

/** Every site: [window start, strand (0 forward, 1 reverse)]. */
export function hitPositions(seq: Uint8Array, m: ScoredMatrix, t: number): [number, number][] {
  const out: [number, number][] = [];
  for (let pos = 0; pos + m.length <= seq.length; pos++) {
    if (windowScore(seq, pos, m.fwd, m.fwdSuffixMax, m.length, t) >= t) out.push([pos, 0]);
    if (windowScore(seq, pos, m.rev, m.revSuffixMax, m.length, t) >= t) out.push([pos, 1]);
  }
  return out;
}

/** Whether the sequence has at least one site (stops at the first). */
export function hasHit(seq: Uint8Array, m: ScoredMatrix, t: number): boolean {
  for (let pos = 0; pos + m.length <= seq.length; pos++) {
    if (windowScore(seq, pos, m.fwd, m.fwdSuffixMax, m.length, t) >= t) return true;
    if (windowScore(seq, pos, m.rev, m.revSuffixMax, m.length, t) >= t) return true;
  }
  return false;
}

/** Sequences end to end (offsets[i]..offsets[i+1] is sequence i), for sending to a worker in one piece. */
export interface PackedSequences {
  codes: Uint8Array;
  offsets: Int32Array;
}

export function packSequences(seqs: Uint8Array[]): PackedSequences {
  const offsets = new Int32Array(seqs.length + 1);
  seqs.forEach((s, i) => (offsets[i + 1] = offsets[i] + s.length));
  const codes = new Uint8Array(offsets[seqs.length]);
  seqs.forEach((s, i) => codes.set(s, offsets[i]));
  return { codes, offsets };
}

/** 1 for each packed sequence with at least one site (sites never span two sequences). */
export function scanPacked(p: PackedSequences, m: ScoredMatrix, t: number): Uint8Array {
  const n = p.offsets.length - 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (hasHit(p.codes.subarray(p.offsets[i], p.offsets[i + 1]), m, t)) out[i] = 1;
  return out;
}
