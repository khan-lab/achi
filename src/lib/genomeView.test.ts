import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nonLocalUrls } from "./browserTracks";
import { normalizeRegionText } from "./inputValidation";
import { parseBed, sortIntervals } from "./intervals";
import {
  brushLoci,
  contigsFromSizes,
  countInLocus,
  densityRows,
  genomeExportName,
  genomeSpec,
  genomeTracks,
  regionRows,
  REF_TRACK_COLOR,
  REGION_ROW_LIMIT,
  type GenomeTrack,
} from "./genomeView";
import { LOCAL_TRACK_COLOR } from "./localTracks";
import type { Interval } from "../types";

/**
 * Genome-wide view of sets and selected subsets (components/GenomeView.tsx,
 * GenomeSpy). Real data: the ENCODE fixtures and the vendored hg38
 * chrom.sizes. The spec is checked to stay inside the app: inline contigs,
 * no data URLs, data passed by name from memory.
 */

const ROOT = join(__dirname, "../..");
const SIZES = Object.fromEntries(
  readFileSync(join(ROOT, "public/refdata/hg38/hg38.chrom.sizes"), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("\t"))
    .map(([c, n]) => [c, Number(n)]),
) as Record<string, number>;
const fixture = (name: string): Interval[] =>
  sortIntervals(parseBed(normalizeRegionText(readFileSync(join(ROOT, "tests/fixtures/encode", name), "utf8")).bedText));
const HEART = fixture("heart_h3k27ac_ENCFF059ERB.subsample.bed");
const LIVER = fixture("liver_h3k27ac_ENCFF805YRQ.subsample.bed");
const ORIGIN = "https://khan-lab.github.io";

describe("contigsFromSizes", () => {
  it("orders chromosomes naturally (1..22, X, Y, M), not by size as chrom.sizes does, keeping sizes", () => {
    const c = contigsFromSizes(SIZES);
    expect(c[0]).toEqual({ name: "chr1", size: SIZES.chr1 });
    expect(c.map((x) => x.name)).toEqual([...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), "chrX", "chrY", "chrM"]);
    expect(contigsFromSizes({ chr2: 5, chrUn_x: 1, chr10: 3, chrM: 2, chr1: 9, chrX: 4 }).map((x) => x.name)).toEqual(["chr1", "chr2", "chr10", "chrX", "chrM", "chrUn_x"]);
  });
});

describe("genomeTracks", () => {
  const sets = [
    { id: "a", name: "Heart", color: "#2B6FE0", included: true, regions: HEART },
    { id: "b", name: "Liver", color: "#C2611A", included: true, regions: LIVER },
    { id: "c", name: "Off", color: "#000000", included: false, regions: [] },
  ];
  const subsets = [
    { mask: 1, label: "Heart only", memberIds: ["a"], regions: HEART.slice(0, 5) },
    { mask: 3, label: "Heart ∩ Liver", memberIds: ["a", "b"], regions: HEART.slice(5, 9) },
  ];
  it("lists included sets, then the selected subsets (set colour, or UpSet grey when shared)", () => {
    const t = genomeTracks(sets, subsets, new Set([3, 1]));
    expect(t.map((x) => [x.name, x.color, x.regions.length])).toEqual([
      ["Heart", "#2B6FE0", HEART.length],
      ["Liver", "#C2611A", LIVER.length],
      ["Subset: Heart only", "#2B6FE0", 5],
      ["Subset: Heart & Liver", "#93989d", 4],
    ]);
  });
  it("names a selected whole set as a set, in its own colour", () => {
    const whole = { mask: -2, label: "Liver (all)", memberIds: ["b"], regions: LIVER, whole: true };
    expect(genomeTracks(sets, [...subsets, whole], new Set([-2]), { includeSets: false }).map((t) => [t.key, t.name, t.color, t.regions.length])).toEqual([["subset:-2", "Set: Liver (all)", "#C2611A", LIVER.length]]);
  });
  it("can leave the input sets out, showing only the selected subsets", () => {
    expect(genomeTracks(sets, subsets, new Set([1, 3]), { includeSets: false }).map((t) => t.name)).toEqual(["Subset: Heart only", "Subset: Heart & Liver"]);
  });
  it("adds chosen reference sets last, as context rows in one neutral colour, named as references", () => {
    const vista = fixture("lung_h3k27ac_ENCFF314QTE.subsample.bed");
    const t = genomeTracks(sets, subsets, new Set([1]), { includeSets: false, refs: [{ key: "vista", name: "VISTA enhancers", regions: vista }] });
    expect(t.map((x) => [x.key, x.name, x.color, x.regions.length])).toEqual([
      ["subset:1", "Subset: Heart only", "#2B6FE0", 5],
      ["ref:vista", "Ref: VISTA enhancers", REF_TRACK_COLOR, vista.length],
    ]);
  });
  it("adds local interval files last, after the reference sets, in the local-track colour", () => {
    const lung = fixture("lung_h3k27ac_ENCFF314QTE.subsample.bed");
    const t = genomeTracks(sets, subsets, new Set([1]), {
      includeSets: false,
      refs: [{ key: "vista", name: "VISTA enhancers", regions: HEART }],
      locals: [{ key: "l1", name: "my_peaks.bed", regions: lung }],
    });
    expect(t.map((x) => [x.key, x.name, x.color])).toEqual([
      ["subset:1", "Subset: Heart only", "#2B6FE0"],
      ["ref:vista", "Ref: VISTA enhancers", REF_TRACK_COLOR],
      ["local:l1", "Local: my_peaks.bed", LOCAL_TRACK_COLOR],
    ]);
    expect(t[2].regions).toBe(lung);
  });
  it("writes ∩ as & in track names: GenomeSpy's built-in font has no ∩ glyph (it draws '?')", () => {
    expect(genomeTracks(sets, subsets, new Set([3])).map((t) => t.name).join()).not.toContain("∩");
  });
});

describe("densityRows", () => {
  it("counts regions per 1 Mb bin by region midpoint, matching a brute-force count", () => {
    const rows = densityRows([{ key: "h", name: "Heart", color: "#000", regions: HEART }], SIZES, 1_000_000);
    const brute = new Map<string, number>();
    for (const r of HEART) {
      const k = `${r.chrom}:${Math.floor(Math.floor((r.start + r.end) / 2) / 1_000_000)}`;
      brute.set(k, (brute.get(k) ?? 0) + 1);
    }
    expect(rows).toHaveLength(brute.size);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(HEART.length);
    for (const r of rows) {
      expect(r.count).toBe(brute.get(`${r.chrom}:${r.start / 1_000_000}`));
      expect(r.end).toBe(Math.min(r.start + 1_000_000, SIZES[r.chrom]));
      expect(r.track).toBe("Heart");
    }
    const max = Math.max(...rows.map((r) => r.count));
    expect(rows.find((r) => r.count === max)!.frac).toBe(1);
    expect(Math.min(...rows.map((r) => r.frac))).toBeGreaterThan(0);
  });
  it("ignores regions on chromosomes the assembly does not have", () => {
    expect(densityRows([{ key: "x", name: "X", color: "#000", regions: [{ chrom: "chrUn_x", start: 1, end: 5 }] }], SIZES)).toEqual([]);
  });
});

describe("regionRows", () => {
  it("draws regions of tracks up to the limit and names the ones left to density only", () => {
    const big: GenomeTrack = { key: "big", name: "Big", color: "#000", regions: Array.from({ length: REGION_ROW_LIMIT + 1 }, (_, i) => ({ chrom: "chr1", start: i, end: i + 1 })) };
    const small: GenomeTrack = { key: "h", name: "Heart", color: "#000", regions: HEART };
    const { rows, densityOnly } = regionRows([small, big]);
    expect(rows).toHaveLength(HEART.length);
    expect(rows[0]).toEqual({ track: "Heart", chrom: HEART[0].chrom, start: HEART[0].start, end: HEART[0].end });
    expect(densityOnly).toEqual(["Big"]);
  });
});

describe("countInLocus", () => {
  it("counts regions overlapping a locus (half-open), matching brute force", () => {
    for (const l of [
      { chrom: "chr1", start: 0, end: 50_000_000 },
      { chrom: "chr2", start: 10_000_000, end: 10_000_001 },
      { chrom: "chrX", start: 0, end: SIZES.chrX },
      { chrom: "chr7", start: 100_000_000, end: 120_000_000 },
    ]) {
      const brute = LIVER.filter((r) => r.chrom === l.chrom && r.end > l.start && r.start < l.end).length;
      expect(countInLocus(LIVER, l)).toBe(brute);
    }
  });
});

describe("brushLoci", () => {
  const contigs = contigsFromSizes(SIZES);
  it("turns a brush within one chromosome into one locus", () => {
    expect(brushLoci([{ chrom: "chr3", pos: 1000 }, { chrom: "chr3", pos: 5000 }], contigs)).toEqual([{ chrom: "chr3", start: 1000, end: 5000 }]);
  });
  it("splits a brush across chromosomes at their ends", () => {
    expect(brushLoci([{ chrom: "chr1", pos: SIZES.chr1 - 10 }, { chrom: "chr3", pos: 20 }], contigs)).toEqual([
      { chrom: "chr1", start: SIZES.chr1 - 10, end: SIZES.chr1 },
      { chrom: "chr2", start: 0, end: SIZES.chr2 },
      { chrom: "chr3", start: 0, end: 20 },
    ]);
  });
  it("rounds fractional endpoints outward and drops empty pieces", () => {
    expect(brushLoci([{ chrom: "chr1", pos: 10.6 }, { chrom: "chr1", pos: 20.2 }], contigs)).toEqual([{ chrom: "chr1", start: 10, end: 21 }]);
    expect(brushLoci([{ chrom: "chr1", pos: SIZES.chr1 }, { chrom: "chr2", pos: 0 }], contigs)).toEqual([]);
  });
});

describe("genomeSpec", () => {
  const tracks: GenomeTrack[] = [
    { key: "h", name: "Heart", color: "#2B6FE0", regions: HEART },
    { key: "s", name: "Subset: Heart only", color: "#93989d", regions: HEART.slice(0, 3) },
  ];
  const spec = genomeSpec({ contigs: contigsFromSizes(SIZES), tracks }) as Record<string, unknown>;

  it("defines the genome inline and loads nothing by URL: all data comes from memory by name", () => {
    expect(nonLocalUrls(spec, ORIGIN)).toEqual([]);
    expect(JSON.stringify(spec)).not.toMatch(/"url"/);
    const g = (spec.genomes as Record<string, { contigs: unknown[] }>)[spec.assembly as string];
    expect(g.contigs).toHaveLength(Object.keys(SIZES).length);
    const names = JSON.stringify(spec).match(/"data":\{"name":"[a-z]+"\}/g);
    expect(names?.sort()).toEqual(['"data":{"name":"density"}', '"data":{"name":"regions"}', '"data":{"name":"viewport"}']);
  });

  it("one row per track, in order, coloured like the rest of the app; zoomable x shared by all views", () => {
    const s = JSON.stringify(spec);
    expect(s).toContain('"domain":["Heart","Subset: Heart only"]');
    expect(s).toContain('"range":["#2B6FE0","#93989d"]');
    expect((spec.resolve as { scale: { x: string } }).scale.x).toBe("shared");
    expect(s).toContain('"name":"genome"');
    expect(s).not.toMatch(/"opacity":\{[^}]*"legend":(?!null)/); // the density opacity needs no legend
    expect(s).toContain('"legend":null');
  });

  it("has an interval brush on x in the view named \"regions\", where the app reads it", () => {
    const regions = (spec.vconcat as { name: string; params?: unknown }[]).find((v) => v.name === "regions")!;
    expect(regions.params).toEqual([{ name: "brush", select: { type: "interval", encodings: ["x"] } }]);
    expect(spec).not.toHaveProperty("params");
  });

  it("declares the named datasets empty at the top level; rows are set at runtime (api.datasets.set)", () => {
    expect(spec.datasets).toEqual({ density: [], regions: [], viewport: [] });
  });

  it("marks the genome browser's current locus in the chromosome strip, visible even at whole-genome scale", () => {
    const strip = (spec.vconcat as { name: string; layer?: unknown[] }[]).find((v) => v.name === "chromosomes")!;
    const marker = (strip.layer as { name?: string; data?: unknown; mark?: { type: string; minWidth?: number }; encoding?: Record<string, unknown> }[]).find(
      (l) => l.name === "viewport",
    )!;
    expect(marker.data).toEqual({ name: "viewport" });
    expect(marker.mark?.type).toBe("rect");
    expect(marker.mark?.minWidth).toBeGreaterThanOrEqual(2); // a 100 kb locus is under a pixel at genome scale
    expect(marker.encoding).toMatchObject({ x: { chrom: "chrom", pos: "start", type: "locus" }, x2: { chrom: "chrom", pos: "end" } });
  });

  it("can draw shorter rows (overview above the genome browser)", () => {
    const rows = (sp: object) => (sp as { vconcat: { name: string; height: number }[] }).vconcat.find((v) => v.name === "regions")!.height;
    const many: GenomeTrack[] = Array.from({ length: 6 }, (_, i) => ({ key: `t${i}`, name: `T${i}`, color: "#000", regions: [] }));
    expect(rows(genomeSpec({ contigs: contigsFromSizes(SIZES), tracks: many }))).toBe(6 * 22);
    expect(rows(genomeSpec({ contigs: contigsFromSizes(SIZES), tracks: many, rowHeight: 14 }))).toBe(6 * 14);
  });
});

describe("genomeExportName", () => {
  const contigs = contigsFromSizes(SIZES);
  it("names an export after what is shown: one locus, a chromosome range, or the whole genome", () => {
    expect(genomeExportName([{ chrom: "chr7", start: 999, end: 2000 }], contigs, "svg")).toBe("intervene-genome_chr7_1000-2000.svg");
    expect(genomeExportName([{ chrom: "chr1", start: 5, end: SIZES.chr1 }, { chrom: "chr2", start: 0, end: 9 }], contigs, "png")).toBe("intervene-genome_chr1-chr2.png");
    const all = contigs.map((c) => ({ chrom: c.name, start: 0, end: c.size }));
    expect(genomeExportName(all, contigs, "svg")).toBe("intervene-genome_whole.svg");
    expect(genomeExportName([], contigs, "svg")).toBe("intervene-genome.svg");
  });
});
