/**
 * Genome-wide view of the selected subsets, with the input sets as context
 * (components/GenomeView.tsx, GenomeSpy, MIT; a card in the selected-subset
 * section). Where the regions of each
 * set and subset lie along the whole genome, zoomable down to single
 * regions, with a brush to count regions in an interval and open it in the
 * genome browser.
 *
 * Kept free of GenomeSpy itself so it can be tested in node. Privacy rule,
 * as for the genome browser: the assembly is given inline (contigs from the
 * bundled chrom.sizes), and all data is passed by name from memory
 * (`api.datasets.set`); the spec contains no URL.
 *
 * Two layers per track:
 * - density: regions per 1 Mb bin, counted by region midpoint, drawn as a
 *   strip whose opacity is the bin's count relative to the track's busiest
 *   bin. Shows where a set or subset concentrates at genome scale;
 * - regions: every region as a rectangle (tracks up to REGION_ROW_LIMIT
 *   regions; larger ones are shown by density only), resolved when zoomed in.
 */
import type { Interval } from "../types";
import type { ChromSizes } from "./inputValidation";
import { SHARED_SUBSET_COLOR, type Locus } from "./browserTracks";

export interface Contig {
  name: string;
  size: number;
}

export interface GenomeTrack {
  key: string;
  name: string;
  color: string;
  regions: Interval[];
}

export const DENSITY_BIN = 1_000_000;
/** Colour of reference-set context rows (ClinVar, cCREs, ...): neutral ink, distinct from set colours and the UpSet grey. */
export const REF_TRACK_COLOR = "#55637a";
/** Regions drawn individually per track; above this a track is shown by density only. */
export const REGION_ROW_LIMIT = 500_000;

/** Natural chromosome order: numbered (1, 2, ..., 22), then X, Y, M, then anything else by name. */
function chromRank(name: string): [number, number, string] {
  const n = name.replace(/^chr/i, "");
  if (/^\d+$/.test(n)) return [0, Number(n), ""];
  const special = ["X", "Y", "M", "MT"].indexOf(n.toUpperCase());
  if (special >= 0) return [1, special, ""];
  return [2, 0, name];
}

/** The assembly for GenomeSpy, in natural chromosome order (chrom.sizes files are sorted by size). */
export function contigsFromSizes(sizes: ChromSizes): Contig[] {
  return Object.entries(sizes)
    .map(([name, size]) => ({ name, size }))
    .sort((a, b) => {
      const [ga, na, sa] = chromRank(a.name);
      const [gb, nb, sb] = chromRank(b.name);
      return ga - gb || na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
    });
}

/**
 * Included sets in order (as context, unless `includeSets` is false), then
 * the selected subsets (set colour if single-set, UpSet grey if shared),
 * then any chosen bundled reference sets as context rows.
 */
export function genomeTracks(
  sets: { id: string; name: string; color: string; included: boolean; regions: Interval[] }[],
  subsets: { mask: number; label: string; memberIds: string[]; regions: Interval[] }[],
  selected: ReadonlySet<number>,
  opts: { includeSets?: boolean; refs?: { key: string; name: string; regions: Interval[] }[] } = {},
): GenomeTrack[] {
  const tracks: GenomeTrack[] =
    opts.includeSets === false ? [] : sets.filter((s) => s.included).map((s) => ({ key: `set:${s.id}`, name: s.name, color: s.color, regions: s.regions }));
  for (const s of subsets) {
    if (!selected.has(s.mask)) continue;
    const color = s.memberIds.length === 1 ? (sets.find((x) => x.id === s.memberIds[0])?.color ?? SHARED_SUBSET_COLOR) : SHARED_SUBSET_COLOR;
    // "∩" -> "&": GenomeSpy's built-in font has no ∩ glyph and would draw "?".
    tracks.push({ key: `subset:${s.mask}`, name: `Subset: ${s.label.replaceAll("∩", "&")}`, color, regions: s.regions });
  }
  for (const r of opts.refs ?? []) tracks.push({ key: `ref:${r.key}`, name: `Ref: ${r.name}`, color: REF_TRACK_COLOR, regions: r.regions });
  return tracks;
}

export interface DensityRow {
  track: string;
  chrom: string;
  start: number;
  end: number;
  count: number;
  /** count / the track's largest bin count, in (0, 1]. */
  frac: number;
}

/** Regions per bin (by midpoint), per track; only non-empty bins; regions off the assembly are ignored. */
export function densityRows(tracks: GenomeTrack[], sizes: ChromSizes, bin = DENSITY_BIN): DensityRow[] {
  const out: DensityRow[] = [];
  for (const t of tracks) {
    const counts = new Map<string, Map<number, number>>();
    for (const r of t.regions) {
      if (!(r.chrom in sizes)) continue;
      const b = Math.floor(Math.floor((r.start + r.end) / 2) / bin);
      let m = counts.get(r.chrom);
      if (!m) counts.set(r.chrom, (m = new Map()));
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    let max = 0;
    for (const m of counts.values()) for (const n of m.values()) max = Math.max(max, n);
    for (const [chrom, m] of counts)
      for (const [b, count] of m) out.push({ track: t.name, chrom, start: b * bin, end: Math.min((b + 1) * bin, sizes[chrom]), count, frac: count / max });
  }
  return out;
}

export interface RegionRow {
  track: string;
  chrom: string;
  start: number;
  end: number;
}

export function regionRows(tracks: GenomeTrack[], limit = REGION_ROW_LIMIT): { rows: RegionRow[]; densityOnly: string[] } {
  const rows: RegionRow[] = [];
  const densityOnly: string[] = [];
  for (const t of tracks) {
    if (t.regions.length > limit) {
      densityOnly.push(t.name);
      continue;
    }
    for (const r of t.regions) rows.push({ track: t.name, chrom: r.chrom, start: r.start, end: r.end });
  }
  return { rows, densityOnly };
}

/** Regions overlapping a locus (half-open: end > start and start < end). */
export function countInLocus(regions: Interval[], l: Locus): number {
  let n = 0;
  for (const r of regions) if (r.chrom === l.chrom && r.end > l.start && r.start < l.end) n++;
  return n;
}

/** A brush from GenomeSpy (`complexIntervals.x`, zero-based endpoints) -> one locus per chromosome it spans. */
export function brushLoci(ends: readonly [{ chrom: string; pos: number }, { chrom: string; pos: number }], contigs: Contig[]): Locus[] {
  const [a, b] = ends;
  const i = contigs.findIndex((c) => c.name === a.chrom);
  const j = contigs.findIndex((c) => c.name === b.chrom);
  if (i < 0 || j < 0 || j < i) return [];
  const out: Locus[] = [];
  for (let k = i; k <= j; k++) {
    const c = contigs[k];
    const start = k === i ? Math.max(0, Math.floor(a.pos)) : 0;
    const end = k === j ? Math.min(c.size, Math.ceil(b.pos)) : c.size;
    if (end > start) out.push({ chrom: c.name, start, end });
  }
  return out;
}

/**
 * The GenomeSpy specification: a chromosome strip, a density strip per
 * track and a region row per track, all on one zoomable x scale ("genome").
 * Data arrives by name: "density" and "regions" are declared empty here and
 * filled at runtime with api.datasets.set().
 */
export function genomeSpec(opts: { contigs: Contig[]; tracks: GenomeTrack[] }): object {
  const names = opts.tracks.map((t) => t.name);
  const colors = opts.tracks.map((t) => t.color);
  const rowY = { field: "track", type: "nominal", scale: { domain: names, padding: 0.2 }, axis: { title: null, labelLimit: 220 } };
  const rowColor = { field: "track", type: "nominal", scale: { domain: names, range: colors }, legend: null };
  const x = (zoomAxis: boolean) => ({
    chrom: "chrom",
    pos: "start",
    type: "locus",
    scale: { name: "genome", zoom: true },
    axis: zoomAxis ? { chromGrid: true } : null,
  });
  return {
    genomes: { intervene: { contigs: opts.contigs } },
    assembly: "intervene",
    datasets: { density: [], regions: [] },
    resolve: { scale: { x: "shared" } },
    spacing: 6,
    vconcat: [
      {
        name: "chromosomes",
        height: 18,
        data: { lazy: { type: "axisGenome", channel: "x" } },
        encoding: {
          x: { field: "continuousStart", type: "locus", axis: null },
          x2: { field: "continuousEnd" },
          text: { field: "name" },
        },
        layer: [
          {
            mark: { type: "rect", tooltip: null },
            encoding: { fill: { field: "odd", type: "nominal", legend: null, scale: { domain: [true, false], range: ["#e8ecf2", "#ffffff"] } } },
          },
          { mark: { type: "text", size: 10, paddingX: 3, tooltip: null } },
        ],
      },
      {
        name: "density",
        title: { text: "Regions per Mb", fontSize: 11, anchor: "start" },
        height: Math.max(16, names.length * 12),
        data: { name: "density" },
        mark: { type: "rect", minWidth: 1 },
        encoding: {
          x: x(false),
          x2: { chrom: "chrom", pos: "end" },
          y: { ...rowY, axis: { title: null, labelLimit: 220 } },
          color: rowColor,
          opacity: { field: "frac", type: "quantitative", scale: { domain: [0, 1], range: [0.08, 1] }, legend: null },
        },
      },
      {
        name: "regions",
        title: { text: "Regions", fontSize: 11, anchor: "start" },
        height: Math.max(24, names.length * 22),
        data: { name: "regions" },
        params: [{ name: "brush", select: { type: "interval", encodings: ["x"] } }],
        mark: { type: "rect", minWidth: 1, minOpacity: 0.6 },
        encoding: {
          x: x(true),
          x2: { chrom: "chrom", pos: "end" },
          y: rowY,
          color: rowColor,
        },
      },
    ],
  };
}

/** Export file name for what the genome view shows. */
export function genomeExportName(loci: Locus[], contigs: Contig[], ext: "svg" | "png"): string {
  if (!loci.length) return `intervene-genome.${ext}`;
  const whole = loci.length === contigs.length && loci.every((l, i) => l.chrom === contigs[i].name && l.start === 0 && l.end === contigs[i].size);
  if (whole) return `intervene-genome_whole.${ext}`;
  if (loci.length === 1) return `intervene-genome_${loci[0].chrom}_${loci[0].start + 1}-${loci[0].end}.${ext}`;
  return `intervene-genome_${loci[0].chrom}-${loci[loci.length - 1].chrom}.${ext}`;
}
