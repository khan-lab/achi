/**
 * Track and genome configuration for the genome browser
 * (components/GenomeBrowser.tsx, igv.js), kept free of igv itself so it can
 * be tested in node.
 *
 * Privacy rule: the browser view sends nothing anywhere. Concretely,
 * - the user's sets and subsets are passed to igv as in-memory features,
 *   never as files or URLs;
 * - the genome is the app's own chrom.sizes (`format: "chromsizes"`): no
 *   FASTA and no genome id that igv would resolve through its genome list
 *   on igv.org;
 * - igv's built-in genome list is switched off (`loadDefaultGenomes: false`;
 *   otherwise igv fetches igv.org/genomes/genomes3.json on start);
 * - igv's navigation bar is hidden (its search box queries igv.org's locus
 *   service); `parseLocus` resolves coordinates and gene names here,
 *   against the bundled gene models;
 * - reference sets and gene models are fetched from the app's own origin.
 * `nonLocalUrls` checks a finished configuration against that rule.
 *
 * Coordinates: `Locus` is 0-based half-open, like BED and igv's internal
 * features; text the user types or sees is 1-based inclusive
 * ("chr1:1,001-2,000" = bases 1001..2000 = { start: 1000, end: 2000 }).
 */
import { EXTERNAL_ANNOTATIONS, type ExternalAnnotation } from "@achi/core/externalAnnotations";
import { blacklistPath, hasBlacklist } from "./blacklist";
import type { ChromSizes } from "@achi/core/inputValidation";
import type { Interval } from "../types";

export interface Locus {
  chrom: string;
  start: number;
  end: number;
}

export interface GeneEntry extends Locus {
  name: string;
}

/** Upper-cased gene symbol -> its gene models (a symbol can occur more than once). */
export type GeneIndex = Map<string, GeneEntry[]>;

/** Same grey the UpSet plot uses for subsets shared by more than one set. */
export const SHARED_SUBSET_COLOR = "#93989d";

const SINGLE_POSITION_HALF_WIDTH = 50;
const MIN_PADDED_WIDTH = 200;
const PAD_FRACTION = 0.2;

function resolveChrom(name: string, sizes: ChromSizes): string | undefined {
  if (name in sizes) return name;
  const lower = name.toLowerCase();
  const withChr = lower.startsWith("chr") ? lower : `chr${lower}`;
  return Object.keys(sizes).find((c) => c.toLowerCase() === withChr);
}

const num = (s: string) => Number(s.replace(/,/g, ""));

/**
 * A typed locus or gene symbol -> 0-based half-open locus, clamped to the
 * chromosome. Accepts "chr1:1,001-2,000", "1:1001..2000", "chrX" (whole
 * chromosome), "chr2:5,000" (101 bp centred there) and gene symbols (case
 * insensitive; the first model if a symbol occurs more than once).
 */
export function parseLocus(query: string, sizes: ChromSizes, genes?: GeneIndex | null): Locus | { error: string } {
  const q = query.trim();
  if (!q) return { error: "Type a locus (chr1:1,000-2,000) or a gene name." };
  const m = /^([^:\s]+)(?::([\d,]+)(?:\s*(?:-|\.\.)\s*([\d,]+))?)?$/.exec(q);
  if (m) {
    const chrom = resolveChrom(m[1], sizes);
    if (chrom) {
      const size = sizes[chrom];
      if (m[2] === undefined) return { chrom, start: 0, end: size };
      if (m[3] === undefined) {
        const pos = num(m[2]) - 1;
        return { chrom, start: Math.max(0, pos - SINGLE_POSITION_HALF_WIDTH), end: Math.min(size, pos + SINGLE_POSITION_HALF_WIDTH + 1) };
      }
      const start = Math.max(0, num(m[2]) - 1);
      const end = Math.min(size, num(m[3]));
      if (!(start < end)) return { error: `${q}: the start is not before the end.` };
      return { chrom, start, end };
    }
    if (m[2] !== undefined) return { error: `${m[1]} is not a chromosome of this assembly.` };
  }
  const hits = genes?.get(q.toUpperCase());
  if (hits?.length) {
    const g = hits[0];
    return { chrom: g.chrom, start: g.start, end: g.end };
  }
  if (!genes) return { error: `${q}: gene names can be searched once the gene models have loaded.` };
  return { error: `${q}: not a chromosome or a gene of this assembly.` };
}

/** igv's `currentLoci()` string ("chr1:1001-2000", fractional after zooming) -> the whole bases it covers. */
export function fromIgvLocus(s: string): Locus | null {
  const m = /^(.+):([\d.]+)-([\d.]+)$/.exec(s.replace(/,/g, ""));
  if (!m) return null;
  return { chrom: m[1], start: Math.max(0, Math.floor(Number(m[2]) - 1)), end: Math.ceil(Number(m[3])) };
}

/** File name for an export of the browser view: achi-browser_chr12_6534300-6534700.svg (1-based). */
export function exportFileName(l: Locus, ext: "svg" | "png"): string {
  return `achi-browser_${l.chrom}_${l.start + 1}-${l.end}.${ext}`;
}

export function formatLocus(l: Locus): string {
  const f = (n: number) => n.toLocaleString("en-US");
  return `${l.chrom}:${f(l.start + 1)}-${f(l.end)}`;
}

/** A region with 20% margin on each side, at least 200 bp wide, inside the chromosome. */
export function padLocus(l: Locus, sizes: ChromSizes): Locus {
  const width = l.end - l.start;
  const pad = Math.max(Math.round(width * PAD_FRACTION), Math.ceil((MIN_PADDED_WIDTH - width) / 2));
  return { chrom: l.chrom, start: Math.max(0, l.start - pad), end: Math.min(sizes[l.chrom] ?? Number.MAX_SAFE_INTEGER, l.end + pad) };
}

// ---- igv configuration ----------------------------------------------------

export interface IgvGenome {
  id: string;
  name: string;
  format: "chromsizes";
  fastaURL: string;
  cytobandURL: string;
  wholeGenomeView: true;
}

/**
 * Genome = the bundled chrom.sizes, with the bundled UCSC cytobands for the
 * ideogram (igv loads cytobands only when whole-genome view is allowed). The
 * id is prefixed so igv never matches it to a genome of its own.
 */
export function igvGenome(assembly: string, base: string): IgvGenome {
  return {
    id: `achi-${assembly}`,
    name: assembly,
    format: "chromsizes",
    fastaURL: `${base}refdata/${assembly}/${assembly}.chrom.sizes`,
    cytobandURL: `${base}refdata/${assembly}/cytoband.txt`,
    wholeGenomeView: true,
  };
}

export interface IgvFeature {
  chr: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface IgvTrack {
  type: "annotation" | "wig" | "variant" | "alignment";
  name: string;
  color?: string;
  displayMode?: "COLLAPSED" | "EXPANDED" | "SQUISHED";
  height?: number;
  visibilityWindow?: number;
  features?: IgvFeature[];
  /** A URL on the app's origin or a consented host, or a local File (lib/localTracks.ts). */
  url?: string | File;
  format?: "bed" | "bigbed" | "bigwig" | "narrowpeak" | "broadpeak" | "bedgraph" | "vcf" | "bam" | "cram";
  /** BAM/CRAM: the local .bai / .crai. */
  indexURL?: File;
  /** CRAM: reference bases from the user's local FASTA (lib/localTracks.ts makeSeqFetch). */
  seqFetch?: (this: never, seqId: number, start: number, end: number) => Promise<string>;
  checkSequenceMD5?: boolean;
  indexed?: false;
  autoscale?: boolean;
  useScore?: boolean;
  removable?: boolean;
  order?: number;
}

/**
 * Largest view, in bp, in which a set is drawn. Sets up to 50,000 regions
 * are drawn at any zoom. Larger ones get a window holding about 20,000 of
 * their regions at genome-average density (6e13 bp·regions ≈ 20,000 ×
 * 3.1 Gb), at least 100 kb: 200,000 regions -> 300 Mb (any chromosome),
 * 2,000,000 -> 30 Mb. Zoomed out further, igv says to zoom in.
 */
export function visibilityWindowFor(nRegions: number): number {
  if (nRegions <= 50_000) return -1;
  return Math.max(100_000, Math.round(6e13 / nRegions));
}

/** A user set or subset, drawn from memory: igv receives the regions, not a file or URL. */
export function regionTrack(name: string, color: string, regions: Interval[]): IgvTrack {
  return {
    type: "annotation",
    name,
    color,
    displayMode: "COLLAPSED",
    height: 28,
    visibilityWindow: visibilityWindowFor(regions.length),
    features: regions.map((r) => ({ chr: r.chrom, start: r.start, end: r.end })),
    removable: false,
  };
}

export function subsetTrackColor(subset: { memberIds: string[] }, sets: { id: string; color: string }[]): string {
  if (subset.memberIds.length !== 1) return SHARED_SUBSET_COLOR;
  return sets.find((s) => s.id === subset.memberIds[0])?.color ?? SHARED_SUBSET_COLOR;
}

/** Bundled reference sets of an assembly (as in External annotations), plus the ENCODE problematic regions where available. */
export function referenceOptions(assembly: string): { id: string; name: string; path: string }[] {
  const opts = EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === assembly && a.path).map((a) => ({ id: a.id, name: a.name, path: a.path! }));
  if (hasBlacklist(assembly)) opts.push({ id: "encode-blacklist", name: "ENCODE problematic regions (v2)", path: blacklistPath(assembly) });
  return opts;
}

/** A bundled reference set (external annotation), read whole from the app's own refdata/. */
export function referenceTrack(a: Pick<ExternalAnnotation, "name" | "path">, base: string): IgvTrack {
  return {
    type: "annotation",
    name: a.name,
    color: "#55637a",
    displayMode: "COLLAPSED",
    height: 28,
    url: `${base}${a.path}`,
    format: "bed",
    indexed: false,
    removable: false,
  };
}

export function geneModelsUrl(assembly: string, base: string): string {
  return `${base}refdata/${assembly}/genes/gene_models.bed`;
}

export interface GeneFeature extends IgvFeature {
  name: string;
  strand: string;
  cdStart: number;
  cdEnd: number;
  exons: { start: number; end: number; utr?: true; cdStart?: number; cdEnd?: number }[];
  gene_id: string;
  gene_type: string;
}

/**
 * gene_models.bed (BED12, name "symbol|gene_id|gene_type"; built by
 * public/refdata/build_gene_models.py) -> igv features, with exons and
 * UTRs marked exactly as igv's own BED parser does, plus a symbol index
 * for locus search.
 */
export function parseGeneModels(text: string): { features: GeneFeature[]; index: GeneIndex } {
  const features: GeneFeature[] = [];
  const index: GeneIndex = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const t = line.split("\t");
    const start = Number(t[1]);
    const end = Number(t[2]);
    const [name, geneId = "", geneType = ""] = t[3].split("|");
    const cdStart = Number(t[6]);
    const cdEnd = Number(t[7]);
    const sizes = t[10].split(",").filter(Boolean).map(Number);
    const offsets = t[11].split(",").filter(Boolean).map(Number);
    const exons: GeneFeature["exons"] = offsets.map((o, i) => {
      const e: GeneFeature["exons"][number] = { start: start + o, end: start + o + sizes[i] };
      if (e.end < cdStart || e.start > cdEnd) e.utr = true;
      else {
        if (cdStart >= e.start && cdStart <= e.end) e.cdStart = cdStart;
        if (cdEnd >= e.start && cdEnd <= e.end) e.cdEnd = cdEnd;
      }
      return e;
    });
    features.push({ chr: t[0], start, end, name, strand: t[5], cdStart, cdEnd, exons, gene_id: geneId, gene_type: geneType });
    const key = name.toUpperCase();
    const entry = { name, chrom: t[0], start, end };
    const list = index.get(key);
    if (list) list.push(entry);
    else index.set(key, [entry]);
  }
  return { features, index };
}

export function geneTrack(features: GeneFeature[]): IgvTrack {
  return {
    type: "annotation",
    name: "Genes (GENCODE, one transcript per gene)",
    color: "#101826",
    displayMode: "COLLAPSED",
    height: 50,
    visibilityWindow: 10_000_000,
    features,
    removable: false,
  };
}

export interface BrowserConfig {
  reference: IgvGenome;
  locus: string;
  tracks: IgvTrack[];
  showNavigation: false;
  showTrackLabels: true;
  showCursorGuide: true;
  showCenterGuide: false;
  showSampleNames: false;
  showSequence?: false;
  queryParametersSupported: false;
  loadDefaultGenomes: false;
  genomeList: [];
}

/** The igv.createBrowser options: own genome, no igv genome list, our locus, no igv navigation/search, no URL query handling. */
export function browserConfig(opts: { assembly: string; base: string; locus: Locus; tracks: IgvTrack[] }): BrowserConfig {
  return {
    reference: igvGenome(opts.assembly, opts.base),
    locus: `${opts.locus.chrom}:${opts.locus.start + 1}-${opts.locus.end}`,
    tracks: opts.tracks,
    showNavigation: false,
    showTrackLabels: true,
    showCursorGuide: true,
    showCenterGuide: false,
    showSampleNames: false,
    queryParametersSupported: false,
    loadDefaultGenomes: false,
    genomeList: [],
  };
}

/**
 * Every string in a configuration that addresses a host other than `origin`
 * (absolute or protocol-relative URLs), apart from `allowedHosts`: the
 * hosts the user agreed to for public tracks (lib/remoteTracks.ts).
 */
export function nonLocalUrls(config: unknown, origin: string, allowedHosts: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (/^(https?:)?\/\//i.test(v)) {
        const abs = v.startsWith("//") ? `https:${v}` : v;
        try {
          const u = new URL(abs);
          if (u.origin !== origin && !(u.protocol === "https:" && allowedHosts.has(u.hostname))) out.push(v);
        } catch {
          out.push(v);
        }
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(config);
  return out;
}
