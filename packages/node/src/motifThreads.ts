/**
 * The motif scan (@achi/core/motifScan's MotifScanner) on Node worker
 * threads: motifs handed out one at a time to whichever thread is free,
 * the sequences shared between threads rather than copied. Each result is
 * exactly what the one-thread scan gives; only the time differs.
 *
 * A worker thread runs a JavaScript file, so the caller names one (`entry`)
 * that calls runMotifWorker() when isMotifWorker(): the bundled achi and
 * achi-mcp files start copies of themselves this way.
 */
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { scanMotifsInline, scanOneMotif, type MotifScanner, type ScanResult } from "@achi/core/motifScan";
import type { Background, PackedSequences } from "@achi/core/pwm";
import { abortIfCancelled } from "@achi/core/runtime";

const ROLE = "achi-motif-scan";

interface Setup {
  role: typeof ROLE;
  packed: PackedSequences;
  bg: Background;
  p: number;
}
type Job = { i: number; pfm: number[][] };
type Done = { i: number; t: number; hits: Uint8Array };

/** Whether this thread was started by threadedMotifScanner. */
export function isMotifWorker(): boolean {
  return !isMainThread && (workerData as Partial<Setup> | null)?.role === ROLE;
}

/** The worker's side: scan each motif sent, send back its threshold and hits. */
export function runMotifWorker(): void {
  const { packed, bg, p } = workerData as Setup;
  parentPort!.on("message", ({ i, pfm }: Job) => {
    const { t, hits } = scanOneMotif(packed, pfm, bg, p);
    parentPort!.postMessage({ i, t, hits } satisfies Done, [hits.buffer as ArrayBuffer]);
  });
}

/** One thread fewer than the computer has (the main thread keeps one), between 1 and 8, as in the browser. */
export function defaultThreads(): number {
  return Math.max(1, Math.min(availableParallelism() - 1, 8));
}

function shared<T extends Uint8Array | Int32Array>(a: T): T {
  const copy = (a instanceof Uint8Array ? new Uint8Array(new SharedArrayBuffer(a.byteLength)) : new Int32Array(new SharedArrayBuffer(a.byteLength))) as T;
  copy.set(a);
  return copy;
}

export function threadedMotifScanner(o: { entry: string | URL; threads?: number }): MotifScanner {
  return async (packed, pfms, bg, p, so = {}): Promise<ScanResult> => {
    const n = Math.min(o.threads ?? defaultThreads(), pfms.length);
    if (n <= 1) return scanMotifsInline(packed, pfms, bg, p, so);
    abortIfCancelled(so.signal);
    const setup: Setup = { role: ROLE, packed: { codes: shared(packed.codes), offsets: shared(packed.offsets) }, bg, p };
    const hits: Uint8Array[] = new Array(pfms.length);
    const thresholds = new Int32Array(pfms.length);
    const workers: Worker[] = [];
    let next = 0;
    let done = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        so.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        const give = (w: Worker) => next < pfms.length && w.postMessage({ i: next, pfm: pfms[next++] } satisfies Job);
        for (let k = 0; k < n; k++) {
          const w = new Worker(o.entry, { workerData: setup, argv: [] });
          workers.push(w);
          w.on("message", (m: Done) => {
            hits[m.i] = m.hits;
            thresholds[m.i] = m.t;
            so.onProgress?.(++done, pfms.length);
            if (done === pfms.length) resolve();
            else give(w);
          });
          w.on("error", (e) => reject(new Error(`The motif scan stopped with an error: ${e.message}`)));
          w.on("exit", (code) => done < pfms.length && reject(new Error(`A motif scan thread stopped early (exit code ${code}).`)));
          give(w);
        }
      });
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
    }
    return { hits, thresholds };
  };
}
