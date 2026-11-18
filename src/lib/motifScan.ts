/**
 * Runs the motif scan (lib/pwm.ts) on several Web Workers, motifs shared
 * out between them; inline where workers are not available (tests).
 */
import { integerMatrix, logOddsMatrix, scanPacked, thresholdForP, type Background, type PackedSequences } from "./pwm";

export interface ScanResult {
  /** Per motif: 1 per sequence with a site. */
  hits: Uint8Array[];
  /** Per motif: the integer score threshold used (lib/pwm.ts SCALE units). */
  thresholds: Int32Array;
}

export async function scanMotifs(
  packed: PackedSequences,
  pfms: number[][][],
  bg: Background,
  p: number,
  o: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; workers?: number } = {}
): Promise<ScanResult> {
  const hits: Uint8Array[] = new Array(pfms.length);
  const thresholds = new Int32Array(pfms.length);
  const total = pfms.length;
  let done = 0;
  if (typeof Worker === "undefined") {
    pfms.forEach((pfm, i) => {
      const m = integerMatrix(logOddsMatrix(pfm, bg));
      thresholds[i] = thresholdForP(m, bg, p);
      hits[i] = scanPacked(packed, m, thresholds[i]);
      o.onProgress?.(++done, total);
    });
    return { hits, thresholds };
  }
  const n = Math.max(1, Math.min(o.workers ?? Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 8, pfms.length));
  const shares: { i: number; pfm: number[][] }[][] = Array.from({ length: n }, () => []);
  pfms.forEach((pfm, i) => shares[i % n].push({ i, pfm }));
  const workers: Worker[] = [];
  try {
    await Promise.all(
      shares.map(
        (motifs) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(new URL("./motifScan.worker.ts", import.meta.url), { type: "module" });
            workers.push(w);
            o.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
            w.onerror = (e) => reject(new Error(e.message || "The motif scan stopped with an error."));
            w.onmessage = (e: MessageEvent<{ i: number; t: number; hits: Uint8Array } | { done: true }>) => {
              if ("done" in e.data) return resolve();
              hits[e.data.i] = e.data.hits;
              thresholds[e.data.i] = e.data.t;
              o.onProgress?.(++done, total);
            };
            w.postMessage({ packed, bg, p, motifs });
          })
      )
    );
  } finally {
    workers.forEach((w) => w.terminate());
  }
  return { hits, thresholds };
}
