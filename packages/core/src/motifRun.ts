/**
 * Motif enrichment of selected groups, as the web app, CLI and MCP server
 * run it (the statistics are in motifEnrichment.ts; null model in
 * docs/methods.md): JASPAR matrices (read through the runtime) scanned over
 * a window around each region's centre, sequence from the given source, and
 * each group tested against the other regions of the analysis with a
 * Cochran–Mantel–Haenszel test over composition strata.
 */
import { centreWindow, type SequenceSource } from "./genomeSequence";
import { mergeCollections, type JasparFile, type JasparMotif, type MotifCollection } from "./motifCollections";
import { compositionStrata, cpgRatio, gcPerMille, motifEnrichment, scanPlan, type MotifCell } from "./motifEnrichment";
import { backgroundOf, encodeSequence, packSequences } from "./pwm";
import { abortIfCancelled, loadRefText, onceFor, type Runtime } from "./runtime";
import { buildUniverse } from "./subsetEnrichment";
import type { Interval } from "./types";

export interface MotifRunRequest {
  assembly: string;
  collection: MotifCollection;
  /** Every subset of the analysis (the universe). */
  subsets: { mask: number; regions: Interval[] }[];
  /** The groups tested: subset masks, or whole sets' negative keys (selection.ts). */
  groups: number[];
  /** Bases each side of a region's centre that are scanned. */
  half: number;
  /** Site p-value threshold. */
  p: number;
  source: SequenceSource;
  /** Most regions to scan (exact range-request mode); half of them for the comparison pool. */
  maxScan?: number;
}

export interface MotifRun {
  release: string;
  collection: MotifCollection;
  motifs: JasparMotif[];
  keys: number[];
  cells: MotifCell[];
  half: number;
  p: number;
  nScanned: number;
  nUniverse: number;
  /** Scanned regions the source had no sequence for (left out of the test). */
  nNoSequence: number;
  /** The sequence source's label, for the methods text. */
  source: string;
  assembly: string;
}

export interface MotifProgress {
  done: number;
  total: number;
  label: string;
  unit?: string;
}

/** One JASPAR file (refdata/jaspar), read once per reference-data source. */
export function loadJasparFile(rt: Runtime, file: string): Promise<JasparFile> {
  return onceFor(rt.refdata, `jaspar:${file}`, async () => JSON.parse(await loadRefText(rt, `refdata/jaspar/${file}`, `the JASPAR matrices (${file})`)) as JasparFile);
}

export async function runMotifEnrichment(rt: Runtime, req: MotifRunRequest, o: { onProgress?: (p: MotifProgress) => void; signal?: AbortSignal } = {}): Promise<MotifRun> {
  const { groups: keys, source } = req;
  abortIfCancelled(o.signal);
  o.onProgress?.({ done: 0, total: 0, label: "Loading JASPAR matrices" });
  const docs = await Promise.all(req.collection.files.map((f) => loadJasparFile(rt, f)));
  const motifs = mergeCollections(docs);
  const universe = buildUniverse(req.subsets);
  const regions = req.subsets.flatMap((s) => s.regions);
  let plan = scanPlan(universe.owner, keys);
  if (req.maxScan !== undefined && plan.scan.length > req.maxScan) plan = scanPlan(universe.owner, keys, { maxPool: req.maxScan / 2, maxGroup: Math.max(100, Math.floor(req.maxScan / 2 / keys.length)) });
  const windows = Array.from(plan.scan, (i) => centreWindow(regions[i], req.half));

  o.onProgress?.({ done: 0, total: windows.length, label: "Reading sequence", unit: "regions" });
  const seqs = await source.read(windows, {
    signal: o.signal,
    onProgress: (pr) =>
      o.onProgress?.({ done: pr.unit === "bytes" ? pr.done / 1e6 : pr.done, total: pr.unit === "bytes" ? pr.total / 1e6 : pr.total, label: pr.label, unit: pr.unit === "bytes" ? "MB" : pr.unit }),
  });
  const codes = seqs.map((s) => (s ? encodeSequence(s) : new Uint8Array(0)));
  const gc = Int32Array.from(codes, gcPerMille);
  const valid = Uint8Array.from(gc, (g) => (g >= 0 ? 1 : 0));
  const nNoSequence = valid.length - valid.reduce((a, v) => a + v, 0);
  if (nNoSequence === valid.length) throw new Error(`No sequence was found for these regions in ${source.label}: is it the ${req.assembly} genome?`);
  const bg = backgroundOf(codes.filter((_, i) => valid[i]));
  const packed = packSequences(codes);

  abortIfCancelled(o.signal);
  const scanLabel = (t: number) => `Scanning ${t.toLocaleString("en-US")} JASPAR motifs`;
  o.onProgress?.({ done: 0, total: motifs.length, label: scanLabel(motifs.length), unit: "motifs" });
  const scan = await rt.scanMotifs(
    packed,
    motifs.map((m) => m.pfm),
    bg,
    req.p,
    { signal: o.signal, onProgress: (d, t) => o.onProgress?.({ done: d, total: t, label: scanLabel(t), unit: "motifs" }) }
  );
  const owner = Int32Array.from(plan.scan, (i) => universe.owner[i]);
  const cells = motifEnrichment({ owner, pool: plan.pool, valid, strata: compositionStrata(gc, Float64Array.from(codes, cpgRatio)), hits: scan.hits, keys });
  return {
    release: docs[0].release,
    collection: req.collection,
    motifs,
    keys,
    cells,
    half: req.half,
    p: req.p,
    nScanned: plan.scan.length,
    nUniverse: universe.owner.length,
    nNoSequence,
    source: source.label,
    assembly: req.assembly,
  };
}

export const MOTIF_TSV_HEAD = ["group", "matrix_id", "collection", "tf", "class", "family", "group_with_site", "group_regions", "rest_with_site", "rest_regions", "odds_ratio", "p", "q", "test"];

/** Every cell of a run as TSV: the download, and what the analysis export takes. `labelOf` names a group by its key. */
export function motifTsv(run: Pick<MotifRun, "cells" | "motifs">, labelOf: (key: number) => string): string {
  const rows = run.cells.map((c) => {
    const m = run.motifs[c.motif];
    const t = c.table;
    return [labelOf(c.key), m.id, m.id.startsWith("UN") ? "UNVALIDATED" : "CORE", m.name, m.class.join("; "), m.family.join("; "), t[0], t[0] + t[1], t[2], t[2] + t[3], c.oddsRatio, c.p, c.q, "CMH, 15 strata (GC quintile x CpG o/e tertile)"].join("\t");
  });
  return [MOTIF_TSV_HEAD.join("\t"), ...rows].join("\n") + "\n";
}
