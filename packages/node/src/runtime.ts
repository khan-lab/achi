/**
 * Achi's runtime for Node (@achi/core/runtime): native bedtools, reference
 * data from the Achi site (checked and cached) or a local copy, and motif
 * scanning on worker threads (motifThreads.ts) when given a worker entry
 * file, on one thread otherwise.
 */
import { scanMotifsInline } from "@achi/core/motifScan";
import type { Runtime } from "@achi/core/runtime";
import { threadedMotifScanner } from "./motifThreads";
import { nativeBedtools, type NativeBedtools } from "./nativeBedtools";
import { nodeRefData, type NodeRefData, type NodeRefDataOptions } from "./refdata";

export type NodeRuntime = Runtime & {
  bedtools: NativeBedtools;
  refdata: NodeRefData;
  /** Removes bedtools' temporary directory. */
  close(): Promise<void>;
};

export interface NodeRuntimeOptions {
  bedtools?: string;
  refdata?: NodeRefDataOptions;
  /** A JavaScript file that runs the motif scan when started as a worker thread (motifThreads.ts); without it, motifs are scanned on this thread. */
  motifWorker?: string | URL;
  /** Worker threads for the motif scan (default: one fewer than the computer has, at most 8). */
  threads?: number;
}

export async function createNodeRuntime(o: NodeRuntimeOptions = {}): Promise<NodeRuntime> {
  const bedtools = await nativeBedtools({ binary: o.bedtools });
  const refdata = nodeRefData(o.refdata);
  const scanMotifs = o.motifWorker ? threadedMotifScanner({ entry: o.motifWorker, threads: o.threads }) : scanMotifsInline;
  return { bedtools, refdata, scanMotifs, close: () => bedtools.close() };
}
