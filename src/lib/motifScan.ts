/**
 * The browser's motif scanner (@achi/core/motifScan's MotifScanner): the
 * scan runs on several Web Workers, motifs shared out between them; on one
 * thread (scanMotifsInline) where workers are not available.
 */
import { scanMotifsInline, type MotifScanner, type ScanResult } from "@achi/core/motifScan";

export const scanMotifs: MotifScanner = async (packed, pfms, bg, p, o = {}): Promise<ScanResult> => {
  if (typeof Worker === "undefined") return scanMotifsInline(packed, pfms, bg, p, o);
  const hits: Uint8Array[] = new Array(pfms.length);
  const thresholds = new Int32Array(pfms.length);
  const total = pfms.length;
  let done = 0;
  const n = Math.max(1, Math.min(Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 8, pfms.length));
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
};
