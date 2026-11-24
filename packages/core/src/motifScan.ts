/**
 * Scanning many motifs over many sequences (pwm.ts): per motif, log-odds
 * against the run's background, the exact score threshold for p, then 1 for
 * each sequence with at least one site. Environments run this their own way
 * (Web Workers in the browser, worker threads in Node) and pass it in as the
 * runtime's `scanMotifs`; scanMotifsInline is the one-thread version any
 * environment can use.
 */
import { integerMatrix, logOddsMatrix, scanPacked, thresholdForP, type Background, type PackedSequences } from "./pwm";
import { abortIfCancelled } from "./runtime";

export interface ScanResult {
  /** Per motif: 1 per sequence with a site. */
  hits: Uint8Array[];
  /** Per motif: the integer score threshold used (pwm.ts SCALE units). */
  thresholds: Int32Array;
}

export interface ScanOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export type MotifScanner = (packed: PackedSequences, pfms: number[][][], bg: Background, p: number, o?: ScanOptions) => Promise<ScanResult>;

/** Scan one motif: its threshold for p and its hit flags. */
export function scanOneMotif(packed: PackedSequences, pfm: number[][], bg: Background, p: number): { t: number; hits: Uint8Array } {
  const m = integerMatrix(logOddsMatrix(pfm, bg));
  const t = thresholdForP(m, bg, p);
  return { t, hits: scanPacked(packed, m, t) };
}

export const scanMotifsInline: MotifScanner = async (packed, pfms, bg, p, o = {}) => {
  const hits: Uint8Array[] = new Array(pfms.length);
  const thresholds = new Int32Array(pfms.length);
  for (let i = 0; i < pfms.length; i++) {
    abortIfCancelled(o.signal);
    const r = scanOneMotif(packed, pfms[i], bg, p);
    hits[i] = r.hits;
    thresholds[i] = r.t;
    o.onProgress?.(i + 1, pfms.length);
  }
  return { hits, thresholds };
};
