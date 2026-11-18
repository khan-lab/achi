import { abortIfCancelled, isDoneFor, loadRefText, onceFor, type Bedtools, type Runtime } from "./runtime";
import type { SummaryItem } from "./types";

/**
 * ChIPseeker-style peak annotation (plotAnnoBar / plotDistToTSS) against
 * GENCODE-derived reference BEDs — see docs/methods.md for the exact
 * category windows/priority order and docs/provenance.md for how the
 * reference BEDs under `public/refdata/<assembly>/anno/` were built
 * (`build_peak_annotation.py`).
 *
 * Verified empirically (not assumed) that neither `bedtools intersect
 * -u`/`-v` nor `bedtools closest` require sorted input to give correct,
 * order-independent results on real data — so unlike `lib/pairwiseStats.ts`'s
 * Fisher path, no genome-aware sort step is needed here, matching
 * `lib/summaryStats.ts`'s `computeSummary`.
 */


export interface AnnoCategoryDef {
  key: string;
  label: string;
  /** Filename under `public/refdata/<assembly>/anno/`, or null for the catch-all last category (no reference file — it's whatever nothing else matched). */
  file: string | null;
}

/** Priority order = display/stacking order = the order the user specified; a peak is assigned to the first category (top to bottom) it overlaps. */
export const ANNO_CATEGORIES: AnnoCategoryDef[] = [
  { key: "tss", label: "TSS", file: "tss_points.bed" },
  { key: "core_promoter", label: "Core promoter", file: "core_promoter.bed" },
  { key: "promoter_proximal", label: "Promoter-proximal", file: "promoter_proximal.bed" },
  { key: "5utr", label: "5' UTR", file: "5utr.bed" },
  { key: "first_exon", label: "First coding exon", file: "first_exon.bed" },
  { key: "other_exon", label: "Other coding exon", file: "other_exon.bed" },
  { key: "3utr", label: "3' UTR", file: "3utr.bed" },
  { key: "first_intron", label: "First intron", file: "first_intron.bed" },
  { key: "other_intron", label: "Other intron", file: "other_intron.bed" },
  { key: "downstream", label: "Immediate downstream", file: "downstream.bed" },
  { key: "distal_intergenic", label: "Distal intergenic", file: null },
];

/** Reports one finished step (a reference file loaded, or one bedtools run); `label` says what it was. */
export type AnnoStepCallback = (label: string) => void;

const REFERENCE_FILES = ANNO_CATEGORIES.filter((c) => c.file).length;

/** bedtools runs per annotated item: an `intersect -u` and `-v` per category with a reference file, then one `closest`. */
export const ANNOTATE_STEPS_PER_ITEM = 2 * REFERENCE_FILES + 1;

/** Steps to annotate `nItems` items, plus one per reference file when they still have to be loaded. */
export function annotationStepTotal(nItems: number, referencesLoaded: boolean): number {
  return (referencesLoaded ? 0 : REFERENCE_FILES) + nItems * ANNOTATE_STEPS_PER_ITEM;
}

interface DistanceBin {
  label: string;
  /** Inclusive lower bound, or -Infinity for the first bin. */
  lo: number;
  /** Inclusive upper bound, or +Infinity for the last bin. */
  hi: number;
}

/** Signed-distance-to-TSS bins for plotDistToTSS — this project's own choice, documented in docs/methods.md (not lifted from a specific external tool's defaults). */
export const DISTANCE_BINS: DistanceBin[] = [
  { label: "≤ -100kb", lo: -Infinity, hi: -100000 },
  { label: "-100..-10kb", lo: -100000, hi: -10000 },
  { label: "-10..-5kb", lo: -10000, hi: -5000 },
  { label: "-5..-1kb", lo: -5000, hi: -1000 },
  { label: "-1..0kb", lo: -1000, hi: 0 },
  { label: "0..1kb", lo: 0, hi: 1000 },
  { label: "1..5kb", lo: 1000, hi: 5000 },
  { label: "5..10kb", lo: 5000, hi: 10000 },
  { label: "10..100kb", lo: 10000, hi: 100000 },
  { label: "> 100kb", lo: 100000, hi: Infinity },
];

/** Which bin a signed distance falls into, using the (lo, hi] convention documented in docs/methods.md — each bin's lower bound is exclusive, upper bound inclusive, except the first bin (<= its hi). */
export function bucketDistance(d: number): string {
  for (const bin of DISTANCE_BINS) {
    if (d > bin.lo && d <= bin.hi) return bin.label;
  }
  return DISTANCE_BINS[DISTANCE_BINS.length - 1].label;
}

/** `bedtools closest -D b` stdout: the trailing signed-distance column of each line. */
export function parseClosestDistances(stdout: string): number[] {
  const distances: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const d = Number(fields[fields.length - 1]);
    if (Number.isFinite(d)) distances.push(d);
  }
  return distances;
}

function countBedLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => l.trim()).length;
}

export interface PeakAnno {
  id: string;
  name: string;
  color: string;
  total: number;
  categoryCounts: Record<string, number>;
  distances: number[];
}

/** Load + mount every category reference BED for an assembly; returns each category's mounted path, keyed by category `key` (categories with no reference file, i.e. "distal_intergenic", are omitted). */
export async function fetchAndMountAnnotation(rt: Runtime, assembly: string, onStep?: AnnoStepCallback): Promise<Record<string, string>> {
  const bt = rt.bedtools;
  const paths: Record<string, string> = {};
  for (const cat of ANNO_CATEGORIES) {
    if (!cat.file) continue;
    const data = await loadRefText(rt, `refdata/${assembly}/anno/${cat.file}`, `${assembly}/anno/${cat.file}`);
    const mountName = `${assembly}.anno.${cat.file}`;
    await bt.mount([{ name: mountName, data }]);
    paths[cat.key] = `${bt.dir}/${mountName}`;
    onStep?.(`Loading GENCODE ${cat.label} reference`);
  }
  return paths;
}

export async function mountRawPeaks(bt: Bedtools, id: string, text: string): Promise<string> {
  const name = `${id}.peaks.raw`;
  await bt.mount([{ name, data: text }]);
  return `${bt.dir}/${name}`;
}

/**
 * Priority-chain classification: for each category (in priority order),
 * split the currently-unclassified peaks into hits (assigned this
 * category) and remaining (checked against the next category) via
 * `bedtools intersect -u`/`-v` — the same two-flag chaining technique
 * `lib/pipeline.ts`'s `computeRowSubset` already uses for combinatorial
 * subsets, applied here to a priority list instead of a truth table.
 * Whatever's left after every category is "distal intergenic".
 */
let classifyRuns = 0;

export async function classifyPeaks(
  bt: Bedtools,
  rawPath: string,
  categoryPaths: Record<string, string>,
  onStep?: AnnoStepCallback
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let remainingPath = rawPath;
  let remainingText = "";
  let step = 0;
  // Unique per call: a second annotation started while this one is still
  // running (e.g. another subset clicked) gets its own intermediate files
  // instead of overwriting these between our intersect calls.
  const run = ++classifyRuns;
  const mounted: string[] = [];

  for (const cat of ANNO_CATEGORIES) {
    if (!cat.file) continue;
    const catPath = categoryPaths[cat.key];
    const hits = await bt.exec(`bedtools intersect -u -a ${remainingPath} -b ${catPath}`);
    counts[cat.key] = countBedLines(hits.stdout);
    onStep?.(cat.label);

    const remaining = await bt.exec(`bedtools intersect -v -a ${remainingPath} -b ${catPath}`);
    remainingText = remaining.stdout;
    const remainingName = `classify_${run}_remaining_${step++}.bed`;
    await bt.mount([{ name: remainingName, data: remainingText }]);
    mounted.push(remainingName);
    remainingPath = `${bt.dir}/${remainingName}`;
    onStep?.(`${cat.label} (remaining regions)`);
  }

  counts.distal_intergenic = countBedLines(remainingText);
  await bt.unmount(mounted);
  return counts;
}

/** Strand-aware signed distance from each peak to its nearest TSS (negative = upstream, positive = downstream of the nearest TSS's own strand). */
export async function distanceToTSS(bt: Bedtools, rawPath: string, tssPointsPath: string): Promise<number[]> {
  const result = await bt.exec(`bedtools closest -a ${rawPath} -b ${tssPointsPath} -D b -t first`);
  return parseClosestDistances(result.stdout);
}

/** One item's full peak-annotation record — the ChIPseeker-style "peakAnno" object; a `PeakAnno[]` is the "peakAnnoList" both plotAnnoBar and plotDistToTSS consume. */
export async function annotatePeaks(
  bt: Bedtools,
  item: SummaryItem,
  categoryPaths: Record<string, string>,
  onStep?: AnnoStepCallback
): Promise<PeakAnno> {
  const rawPath = await mountRawPeaks(bt, item.id, await item.getRawText());
  // Sequential, not concurrent — every other bedtools call site awaits one
  // at a time (in the browser, against the single WebAssembly worker); two
  // command chains racing against the same virtual filesystem is untested
  // territory not worth risking here for a two-call sequence.
  const step = onStep && ((label: string) => onStep(`${item.name}: ${label}`));
  const categoryCounts = await classifyPeaks(bt, rawPath, categoryPaths, step);
  const distances = await distanceToTSS(bt, rawPath, categoryPaths.tss);
  step?.("distance to nearest TSS");
  const total = Object.values(categoryCounts).reduce((sum, n) => sum + n, 0);
  return { id: item.id, name: item.name, color: item.color, total, categoryCounts, distances };
}

// ---- the analysis, as the web app, CLI and MCP server run it ----

const referencesKey = (assembly: string) => `anno:${assembly}`;

/** Whether `assembly`'s category reference files are already mounted for this runtime's bedtools (progress totals depend on it). */
export function hasAnnotationReferences(rt: Pick<Runtime, "bedtools">, assembly: string): boolean {
  return isDoneFor(rt.bedtools, referencesKey(assembly));
}

/**
 * Region annotation of each item against `assembly`'s GENCODE categories:
 * category counts by the priority chain, and signed distances to the
 * nearest TSS. Loads the reference files once per bedtools; reports one
 * step per bedtools run (annotationStepTotal) and each item's result as it
 * is ready. Checks for cancellation before each item.
 */
export async function runRegionAnnotation(
  rt: Runtime,
  assembly: string,
  items: SummaryItem[],
  o: { onStep?: AnnoStepCallback; onResult?: (anno: PeakAnno, item: SummaryItem) => void; signal?: AbortSignal } = {}
): Promise<PeakAnno[]> {
  abortIfCancelled(o.signal);
  const paths = await onceFor(rt.bedtools, referencesKey(assembly), () => fetchAndMountAnnotation(rt, assembly, o.onStep));
  const out: PeakAnno[] = [];
  for (const item of items) {
    abortIfCancelled(o.signal);
    const anno = await annotatePeaks(rt.bedtools, item, paths, o.onStep);
    out.push(anno);
    o.onResult?.(anno, item);
  }
  return out;
}
