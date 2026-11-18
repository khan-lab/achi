/**
 * Scans packed sequences for a share of the motifs (lib/motifScan.ts sends
 * each worker its own share). For each motif: log-odds against the run's
 * background, the exact threshold for p, then 1 per sequence with a site.
 */
import { scanOneMotif } from "@achi/core/motifScan";
import type { Background, PackedSequences } from "@achi/core/pwm";

interface Job {
  packed: PackedSequences;
  bg: Background;
  p: number;
  motifs: { i: number; pfm: number[][] }[];
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { packed, bg, p, motifs } = e.data;
  for (const { i, pfm } of motifs) {
    const { t, hits } = scanOneMotif(packed, pfm, bg, p);
    (self as unknown as Worker).postMessage({ i, t, hits }, [hits.buffer]);
  }
  (self as unknown as Worker).postMessage({ done: true });
};
