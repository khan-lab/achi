/**
 * Achi's runtime for Node (@achi/core/runtime): native bedtools, reference
 * data from the Achi site (checked and cached) or a local copy, and motif
 * scanning on one thread.
 */
import { scanMotifsInline } from "@achi/core/motifScan";
import type { Runtime } from "@achi/core/runtime";
import { nativeBedtools, type NativeBedtools } from "./nativeBedtools";
import { nodeRefData, type NodeRefData, type NodeRefDataOptions } from "./refdata";

export type NodeRuntime = Runtime & {
  bedtools: NativeBedtools;
  refdata: NodeRefData;
  /** Removes bedtools' temporary directory. */
  close(): Promise<void>;
};

export async function createNodeRuntime(o: { bedtools?: string; refdata?: NodeRefDataOptions } = {}): Promise<NodeRuntime> {
  const bedtools = await nativeBedtools({ binary: o.bedtools });
  const refdata = nodeRefData(o.refdata);
  return { bedtools, refdata, scanMotifs: scanMotifsInline, close: () => bedtools.close() };
}
