/**
 * Public bigWigs (ENCODE, SCREEN, UCSC, a pasted https URL) for signal
 * profiles, two ways:
 *
 * - Private (default): download one summary (zoom) layer of the file for
 *   every chromosome, in full, and compute the profiles from it in the page.
 *   The bytes read are the same whatever the regions (remoteSignal.test.ts
 *   checks this), so the server learns only that the file's layer was
 *   downloaded. Resolution is the layer's (e.g. 3,072 bp); each layer item is
 *   the mean over its bases with data and is weighted by its width, which is
 *   exact for continuous signal (fold change, phyloP) and approximate where a
 *   layer item has gaps.
 * - Exact (opt-in, per run): range requests at base resolution around each
 *   region, as for a local file. The server then sees which parts of the file
 *   are read, i.e. roughly where the regions are, so the card asks every time,
 *   with this estimate, and reads at most EXACT_MAX_REGIONS regions.
 */
import { BigWig } from "@gmod/bbi";
import { RemoteFile } from "generic-filehandle2";
import { chromAlias } from "./bigwigSource";
import type { SignalInterval, SignalRead } from "./signalMatrix";

export const EXACT_MAX_REGIONS = 2000;
const LAYER_MIN = 100;
const LAYER_MAX = 20_000;
const LAYER_PREFERRED = 3000;

export interface LayerArrays {
  starts: Int32Array;
  ends: Int32Array;
  scores: Float32Array;
}

export interface SummaryLayer {
  level: number;
  items: number;
  chroms: Map<string, number>;
  read: SignalRead;
}

/** A remote bigWig, fetched without cookies or referrer. */
export function openRemoteBigWig(url: string): { bw: BigWig; size: () => Promise<number> } {
  const fh = new RemoteFile(url, { overrides: { credentials: "omit", referrerPolicy: "no-referrer" } });
  return { bw: new BigWig({ filehandle: fh }), size: async () => (await fh.stat()).size };
}

/** The file's layers worth offering (100 bp to 20 kb), and the one nearest `target` (3 kb by default). */
export function layerChoices(levels: number[], target = LAYER_PREFERRED): { levels: number[]; preferred: number | null } {
  const ok = levels.filter((l) => l >= LAYER_MIN && l <= LAYER_MAX);
  if (!ok.length) return { levels: [], preferred: null };
  const preferred = ok.reduce((a, b) => (Math.abs(Math.log(b / target)) < Math.abs(Math.log(a / target)) ? b : a));
  return { levels: ok, preferred };
}

/** Answers ranges from in-memory layer arrays (binary search on ends; items sorted, not overlapping). */
export function layerReader(data: Map<string, LayerArrays>): SignalRead {
  const names = new Map([...data.keys()].map((k) => [k, 1]));
  return async (chrom, start, end) => {
    const c = chromAlias(chrom, names);
    const d = c ? data.get(c) : undefined;
    if (!d) return [];
    let lo = 0;
    let hi = d.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d.ends[mid] <= start) lo = mid + 1;
      else hi = mid;
    }
    const out: SignalInterval[] = [];
    for (let i = lo; i < d.starts.length && d.starts[i] < end; i++) out.push({ start: d.starts[i], end: d.ends[i], score: d.scores[i] });
    return out;
  };
}

/** Reads summary layer `level` of every chromosome in the file, in full and in file order. */
export async function readSummaryLayer(bw: BigWig, level: number, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<SummaryLayer> {
  const header = await bw.getHeader();
  if (!header.zoomLevels.some((z) => z.reductionLevel === level)) throw new Error(`This bigWig has no summary layer of ${level.toLocaleString("en-US")} bp.`);
  const refs = Object.values(header.refsByNumber).sort((a, b) => a.id - b.id);
  const data = new Map<string, LayerArrays>();
  let items = 0;
  for (const [i, ref] of refs.entries()) {
    if (opts.signal?.aborted) throw new Error("Aborted");
    // bbi picks the largest layer no coarser than 2 x basesPerSpan: asking for level / 2 picks `level` itself.
    const a = await bw.getFeaturesAsArrays(ref.name, 0, ref.length, { basesPerSpan: level / 2, signal: opts.signal });
    if (!a.isSummary) throw new Error(`This bigWig has no summary layer of ${level.toLocaleString("en-US")} bp.`);
    data.set(ref.name, { starts: a.starts, ends: a.ends, scores: a.scores });
    items += a.starts.length;
    opts.onProgress?.(i + 1, refs.length);
  }
  return { level, items, chroms: new Map(refs.map((r) => [r.name, r.length])), read: layerReader(data) };
}

/**
 * About how much exact mode downloads and how long it takes, from the file's
 * size alone (reading its index would itself reveal where the regions are).
 * Calibrated on ENCODE ENCFF381NDD: data blocks around a region add about
 * 64 kb of file per region, and requests run 6 at a time.
 */
export function estimateExact(x: { fileBytes: number; genomeBp: number; regionBp: number; nRegions: number }): { bytes: number; seconds: number } {
  const perBp = x.fileBytes / x.genomeBp;
  const bytes = perBp * (x.regionBp + x.nRegions * 64_000);
  return { bytes, seconds: x.nRegions * 0.1 + bytes / 1.5e6 };
}

/** Hosts the user agreed to read public signal from, for this page session (in memory only). Separate from the genome browser's agreement. */
export const signalConsentHosts = new Set<string>();
