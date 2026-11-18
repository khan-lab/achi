import { abortIfCancelled, loadRefText, onceFor, type Bedtools, type Runtime } from "./runtime";
import type { SummaryItem } from "./types";

/**
 * "Nearest gene by TSS" — for each region in a set, find every equally-
 * nearest protein-coding gene's TSS via `bedtools closest -d -t all`
 * (unsigned distance, every tie kept, no distance cutoff). See
 * docs/methods.md for why this is a descriptive assignment, not a
 * statistical test, and docs/provenance.md for how `genes_tss.bed` (built
 * by public/refdata/build_peak_annotation.py) was derived.
 *
 * Structured region→gene associations are preserved (not just a flat name
 * list) so this data can later feed a background gene universe for
 * GO/pathway enrichment (genes near any input region, not genome-wide) —
 * not built yet, but the shape doesn't need to change to support it.
 */


export interface RegionGeneAssociation {
  region: { chrom: string; start: number; end: number };
  geneName: string;
  geneId: string;
  strand: string;
  distance: number;
}

/** Load + mount `genes_tss.bed` for an assembly; returns its mounted path. */
export async function fetchAndMountGeneTss(rt: Runtime, assembly: string): Promise<string> {
  const data = await loadRefText(rt, `refdata/${assembly}/genes_tss.bed`, `${assembly}/genes_tss.bed`);
  const mountName = `${assembly}.genes_tss.bed`;
  await rt.bedtools.mount([{ name: mountName, data }]);
  return `${rt.bedtools.dir}/${mountName}`;
}

export async function mountRawRegions(bt: Bedtools, id: string, text: string): Promise<string> {
  const name = `${id}.genelist.raw`;
  await bt.mount([{ name, data: text }]);
  return `${bt.dir}/${name}`;
}

/**
 * `bedtools closest -d -t all` stdout: A's columns (variable width) then
 * B's fixed 6 columns (chrom, start, end, "geneName|geneId", score,
 * strand) then a trailing unsigned-distance column — read from the end so
 * this doesn't care how many columns A itself has (BED3, BED6, or the
 * 10-column narrowPeak-like shape this app's fixtures use). `-t all`
 * means a region with N equally-near genes produces N output lines, all
 * kept here as separate associations (not deduped yet).
 */
export function parseClosestGeneAssociations(stdout: string): RegionGeneAssociation[] {
  const out: RegionGeneAssociation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (fields.length < 10) continue;
    const n = fields.length;
    const distance = Number(fields[n - 1]);
    const strand = fields[n - 2];
    const name = fields[n - 4];
    const [geneName, geneId] = name.split("|");
    if (!Number.isFinite(distance) || !geneName) continue;
    out.push({
      region: { chrom: fields[0], start: Number(fields[1]), end: Number(fields[2]) },
      geneName,
      geneId: geneId ?? "",
      strand,
      distance,
    });
  }
  return out;
}

export async function computeGeneAssociations(bt: Bedtools, item: SummaryItem, geneTssPath: string): Promise<RegionGeneAssociation[]> {
  const rawPath = await mountRawRegions(bt, item.id, await item.getRawText());
  const result = await bt.exec(`bedtools closest -d -t all -a ${rawPath} -b ${geneTssPath}`);
  return parseClosestGeneAssociations(result.stdout);
}

/** Deduplicated, alphabetically sorted gene symbols — what the gene panel displays/exports. The structured associations stay the source of truth. */
export function uniqueGeneNames(associations: RegionGeneAssociation[]): string[] {
  return [...new Set(associations.map((a) => a.geneName))].sort((a, b) => a.localeCompare(b));
}

/**
 * Nearest gene by TSS for each item (`bedtools closest -d -t all` against
 * the assembly's genes_tss.bed, mounted once per bedtools). Reports each
 * item's associations as they are ready; checks for cancellation before
 * each item.
 */
export async function runNearestGenes(
  rt: Runtime,
  assembly: string,
  items: SummaryItem[],
  o: { onResult?: (associations: RegionGeneAssociation[], item: SummaryItem) => void; signal?: AbortSignal } = {}
): Promise<RegionGeneAssociation[][]> {
  abortIfCancelled(o.signal);
  const tssPath = await onceFor(rt.bedtools, `genes_tss:${assembly}`, () => fetchAndMountGeneTss(rt, assembly));
  const out: RegionGeneAssociation[][] = [];
  for (const item of items) {
    abortIfCancelled(o.signal);
    const associations = await computeGeneAssociations(rt.bedtools, item, tssPath);
    out.push(associations);
    o.onResult?.(associations, item);
  }
  return out;
}
