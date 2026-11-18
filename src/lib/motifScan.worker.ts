/**
 * Scans packed sequences for a share of the motifs (lib/motifScan.ts sends
 * each worker its own share). For each motif: log-odds against the run's
 * background, the exact threshold for p, then 1 per sequence with a site.
 */
import { integerMatrix, logOddsMatrix, scanPacked, thresholdForP, type Background, type PackedSequences } from "@achi/core/pwm";

interface Job {
  packed: PackedSequences;
  bg: Background;
  p: number;
  motifs: { i: number; pfm: number[][] }[];
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { packed, bg, p, motifs } = e.data;
  for (const { i, pfm } of motifs) {
    const m = integerMatrix(logOddsMatrix(pfm, bg));
    const t = thresholdForP(m, bg, p);
    const hits = scanPacked(packed, m, t);
    (self as unknown as Worker).postMessage({ i, t, hits }, [hits.buffer]);
  }
  (self as unknown as Worker).postMessage({ done: true });
};
