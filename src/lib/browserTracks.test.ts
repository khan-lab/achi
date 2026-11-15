import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTERNAL_ANNOTATIONS } from "./externalAnnotations";
import {
  browserConfig,
  exportFileName,
  formatLocus,
  fromIgvLocus,
  geneModelsUrl,
  geneTrack,
  igvGenome,
  nonLocalUrls,
  padLocus,
  parseGeneModels,
  parseLocus,
  referenceOptions,
  referenceTrack,
  regionTrack,
  subsetTrackColor,
  visibilityWindowFor,
  type GeneIndex,
} from "./browserTracks";

/**
 * The genome browser (components/GenomeBrowser.tsx, igv.js) must show the
 * user's sets without sending anything anywhere: every URL in the igv
 * configuration is the app's own, the genome is defined by the bundled
 * chrom.sizes (no FASTA, no igv.org genome list), and locus search is
 * resolved here, against the bundled gene models, not by igv's default
 * search service. Real data: the vendored hg38 chrom.sizes and gene models.
 */

const PUBLIC = join(__dirname, "../../public");
const sizesOf = (asm: string) =>
  Object.fromEntries(
    readFileSync(join(PUBLIC, `refdata/${asm}/${asm}.chrom.sizes`), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("\t"))
      .map(([c, n]) => [c, Number(n)]),
  ) as Record<string, number>;
const HG38 = sizesOf("hg38");
const BASE = "https://khan-lab.github.io/intervene-secure/";
const ORIGIN = "https://khan-lab.github.io";

/** A real row of public/refdata/hg38/genes/gene_models.bed (GAPDH, GENCODE v50, Ensembl canonical). */
const GAPDH_ROW = "chr12\t6534516\t6538371\tGAPDH|ENSG00000111640.17|protein_coding\t0\t+\t6534832\t6538170\t0\t9\t53,52,100,107,91,116,82,413,271,\t0,293,1977,2167,2403,2584,2792,3067,3584,\n";

const GENES: GeneIndex = new Map([
  ["GAPDH", [{ name: "GAPDH", chrom: "chr12", start: 6534516, end: 6538374 }]],
  ["TP53", [{ name: "TP53", chrom: "chr17", start: 7661778, end: 7687538 }]],
]);

describe("parseLocus", () => {
  it("reads 1-based inclusive coordinates with commas and returns 0-based half-open", () => {
    expect(parseLocus("chr1:1,001-2,000", HG38)).toEqual({ chrom: "chr1", start: 1000, end: 2000 });
    expect(parseLocus("  chr1:1001-2000 ", HG38)).toEqual({ chrom: "chr1", start: 1000, end: 2000 });
    expect(parseLocus("chr1:1001..2000", HG38)).toEqual({ chrom: "chr1", start: 1000, end: 2000 });
  });
  it("accepts chromosome names without chr, and in any case", () => {
    expect(parseLocus("1:1001-2000", HG38)).toEqual({ chrom: "chr1", start: 1000, end: 2000 });
    expect(parseLocus("chrx:1-100", HG38)).toEqual({ chrom: "chrX", start: 0, end: 100 });
    expect(parseLocus("X:1-100", HG38)).toEqual({ chrom: "chrX", start: 0, end: 100 });
  });
  it("shows a whole chromosome for a bare name", () => {
    expect(parseLocus("chr21", HG38)).toEqual({ chrom: "chr21", start: 0, end: HG38.chr21 });
  });
  it("centres a 101 bp window on a single position", () => {
    expect(parseLocus("chr2:5,000", HG38)).toEqual({ chrom: "chr2", start: 4949, end: 5050 });
  });
  it("clamps to the chromosome", () => {
    expect(parseLocus(`chrM:1-99999999`, HG38)).toEqual({ chrom: "chrM", start: 0, end: HG38.chrM });
  });
  it("finds genes by symbol, in any case", () => {
    expect(parseLocus("gapdh", HG38, GENES)).toEqual({ chrom: "chr12", start: 6534516, end: 6538374 });
    expect(parseLocus("TP53", HG38, GENES)).toEqual({ chrom: "chr17", start: 7661778, end: 7687538 });
  });
  it("rejects what it cannot place, with a reason", () => {
    expect(parseLocus("", HG38)).toHaveProperty("error");
    expect(parseLocus("chr99:1-10", HG38)).toHaveProperty("error");
    expect(parseLocus("chr1:500-100", HG38)).toHaveProperty("error");
    expect(parseLocus("NOTAGENE", HG38, GENES)).toHaveProperty("error");
    expect(parseLocus("GAPDH", HG38)).toHaveProperty("error"); // gene models not loaded yet
  });
});

describe("fromIgvLocus", () => {
  it("reads igv's current locus, which is fractional after zooming, as whole bases covering it", () => {
    expect(fromIgvLocus("chr12:6499999.5-6580000.5")).toEqual({ chrom: "chr12", start: 6499998, end: 6580001 });
    expect(fromIgvLocus("chr1:1,001-2,000")).toEqual({ chrom: "chr1", start: 1000, end: 2000 });
    expect(fromIgvLocus("chr1")).toBeNull();
  });
});

describe("exportFileName", () => {
  it("names a browser export after the locus shown (1-based, no separators)", () => {
    expect(exportFileName({ chrom: "chr12", start: 6534299, end: 6534700 }, "svg")).toBe("intervene-browser_chr12_6534300-6534700.svg");
    expect(exportFileName({ chrom: "chrX", start: 0, end: 156040895 }, "png")).toBe("intervene-browser_chrX_1-156040895.png");
  });
});

describe("formatLocus / padLocus", () => {
  it("formats as 1-based inclusive with thousands separators (round trip)", () => {
    const l = { chrom: "chr1", start: 1000, end: 2000 };
    expect(formatLocus(l)).toBe("chr1:1,001-2,000");
    expect(parseLocus(formatLocus(l), HG38)).toEqual(l);
  });
  it("pads by 20% on each side, at least to 200 bp, inside the chromosome", () => {
    expect(padLocus({ chrom: "chr1", start: 10000, end: 11000 }, HG38)).toEqual({ chrom: "chr1", start: 9800, end: 11200 });
    expect(padLocus({ chrom: "chr1", start: 10000, end: 10001 }, HG38)).toEqual({ chrom: "chr1", start: 9900, end: 10101 });
    expect(padLocus({ chrom: "chr1", start: 0, end: 1000 }, HG38)).toEqual({ chrom: "chr1", start: 0, end: 1200 });
    const end = HG38.chrM;
    expect(padLocus({ chrom: "chrM", start: end - 100, end }, HG38).end).toBe(end);
  });
});

describe("igv configuration stays on the app's own origin", () => {
  it("defines the genome from the bundled chrom.sizes: no FASTA, no genome id igv would look up", () => {
    const g = igvGenome("hg38", BASE);
    expect(g.format).toBe("chromsizes");
    expect(g.fastaURL).toBe(`${BASE}refdata/hg38/hg38.chrom.sizes`);
    expect(g.id).not.toBe("hg38"); // a bare "hg38" makes igv fetch its genome list from igv.org
    expect(g).not.toHaveProperty("twoBitURL");
  });

  it("draws chromosome bands from the bundled UCSC cytoband files (igv loads them only with whole-genome view on)", () => {
    for (const asm of ["hg38", "hg19", "mm10", "mm9"]) {
      const g = igvGenome(asm, BASE);
      expect(g.cytobandURL).toBe(`${BASE}refdata/${asm}/cytoband.txt`);
      expect(g.wholeGenomeView).toBe(true);
      const sizes = sizesOf(asm);
      const rows = readFileSync(join(PUBLIC, `refdata/${asm}/cytoband.txt`), "utf8").trim().split("\n").map((l) => l.split("\t"));
      const bad = rows.filter(([c, s, e, , stain]) => !(c in sizes) || !(Number(s) < Number(e)) || Number(e) > sizes[c] || !stain);
      expect(bad).toEqual([]);
      for (const c of ["chr1", "chrX"]) expect(rows.some((r) => r[0] === c && r[4].startsWith("g"))).toBe(true); // real bands (gneg/gpos), not one ideogram block
    }
  });

  it("draws user sets from memory, never by URL", () => {
    const t = regionTrack("HepG2", "#2B6FE0", [
      { chrom: "chr1", start: 10, end: 20 },
      { chrom: "chr2", start: 5, end: 9 },
    ]);
    expect(t).not.toHaveProperty("url");
    expect(t.features).toEqual([
      { chr: "chr1", start: 10, end: 20 },
      { chr: "chr2", start: 5, end: 9 },
    ]);
    expect(t.color).toBe("#2B6FE0");
  });

  it("limits drawing of very large sets to zoomed-in views", () => {
    expect(visibilityWindowFor(1000)).toBe(-1);
    expect(visibilityWindowFor(50_000)).toBe(-1);
    expect(visibilityWindowFor(200_000)).toBeGreaterThan(0);
    expect(visibilityWindowFor(2_000_000)).toBeLessThan(visibilityWindowFor(200_000));
  });

  it("colours single-set subsets by their set and shared subsets grey, as in the UpSet plot", () => {
    const sets = [
      { id: "a", color: "#111111" },
      { id: "b", color: "#222222" },
    ];
    expect(subsetTrackColor({ memberIds: ["b"] }, sets)).toBe("#222222");
    expect(subsetTrackColor({ memberIds: ["a", "b"] }, sets)).toBe("#93989d");
  });

  it("loads bundled reference sets and gene models from the app itself", () => {
    for (const a of EXTERNAL_ANNOTATIONS.filter((x) => x.path)) {
      const t = referenceTrack(a, BASE);
      expect(t.url).toBe(`${BASE}${a.path}`);
      expect(existsSync(join(PUBLIC, a.path!))).toBe(true);
    }
    for (const asm of ["hg38", "hg19", "mm10", "mm9"]) {
      const url = geneModelsUrl(asm, BASE);
      expect(url.startsWith(`${BASE}refdata/${asm}/`)).toBe(true);
      expect(existsSync(join(PUBLIC, url.slice(BASE.length)))).toBe(true);
    }
  });

  it("lists the bundled reference sets of an assembly, plus the ENCODE problematic regions where they exist", () => {
    const hg38 = referenceOptions("hg38");
    expect(hg38.map((r) => r.id)).toEqual([...EXTERNAL_ANNOTATIONS.filter((a) => a.assembly === "hg38" && a.path).map((a) => a.id), "encode-blacklist"]);
    for (const asm of ["hg38", "hg19", "mm10", "mm9"]) for (const r of referenceOptions(asm)) expect(existsSync(join(PUBLIC, r.path))).toBe(true);
    expect(referenceOptions("mm9").some((r) => r.id === "encode-blacklist")).toBe(false);
  });

  it("a complete browser configuration contains no URL outside the app", () => {
    const hg38Refs = EXTERNAL_ANNOTATIONS.filter((x) => x.assembly === "hg38" && x.path);
    const cfg = browserConfig({
      assembly: "hg38",
      base: BASE,
      locus: { chrom: "chr12", start: 6534516, end: 6538374 },
      tracks: [geneTrack(parseGeneModels(GAPDH_ROW).features), regionTrack("s", "#000000", [{ chrom: "chr1", start: 1, end: 2 }]), ...hg38Refs.map((a) => referenceTrack(a, BASE))],
    });
    expect(nonLocalUrls(cfg, ORIGIN)).toEqual([]);
    expect(cfg.showNavigation).toBe(false); // igv's own search box would query igv.org
    expect(cfg.loadDefaultGenomes).toBe(false); // otherwise igv fetches igv.org/genomes/genomes3.json on start
    expect(cfg.genomeList).toEqual([]);
    expect(cfg).not.toHaveProperty("genome");
  });

  it("nonLocalUrls catches remote URLs anywhere in a configuration", () => {
    const cfg = { reference: { fastaURL: `${BASE}x` }, tracks: [{ url: "https://www.encodeproject.org/files/X/@@download/X.bigWig" }, { indexURL: "//cdn.example.org/i" }] };
    expect(nonLocalUrls(cfg, ORIGIN)).toEqual(["https://www.encodeproject.org/files/X/@@download/X.bigWig", "//cdn.example.org/i"]);
  });
});

describe("bundled gene models (one transcript per gene, GENCODE)", () => {
  for (const asm of ["hg38", "hg19", "mm10", "mm9"]) {
    it(`${asm}: valid BED12 inside the chromosomes, one row per gene, every protein-coding gene of genes_tss.bed present`, () => {
      const sizes = sizesOf(asm);
      const text = readFileSync(join(PUBLIC, `refdata/${asm}/genes/gene_models.bed`), "utf8");
      const rows = text.trim().split("\n").map((l) => l.split("\t"));
      const ids = new Set<string>();
      const problems: string[] = [];
      for (const f of rows) {
        const bad = (why: string) => problems.length < 5 && problems.push(`${why}: ${f.join(" ")}`);
        if (f.length !== 12) { bad("not 12 columns"); continue; }
        const [chrom, s, e, , , strand, ts, te, , n, sizesCol, startsCol] = f;
        const start = Number(s), end = Number(e);
        if (!(sizes[chrom] >= end)) bad("past the chromosome end");
        if (!(start < end)) bad("empty");
        if (strand !== "+" && strand !== "-") bad("strand");
        if (!(Number(ts) >= start && Number(te) <= end && Number(ts) <= Number(te))) bad("coding range");
        const bs = sizesCol.split(",").filter(Boolean).map(Number);
        const bo = startsCol.split(",").filter(Boolean).map(Number);
        if (bs.length !== Number(n) || bo.length !== Number(n)) bad("block count");
        if (bo[0] !== 0 || bo[bo.length - 1] + bs[bs.length - 1] !== end - start) bad("blocks do not span the transcript");
        for (let i = 1; i < bo.length; i++) if (bo[i] < bo[i - 1] + bs[i - 1]) bad("overlapping blocks");
        const id = f[3].split("|")[1];
        if (ids.has(id)) bad("second row for a gene");
        ids.add(id);
      }
      expect(problems).toEqual([]);
      const tss = readFileSync(join(PUBLIC, `refdata/${asm}/genes_tss.bed`), "utf8").trim().split("\n");
      expect(tss.filter((l) => !ids.has(l.split("\t")[3].split("|")[1]))).toEqual([]);
    }, 30_000);
  }

  it("parseGeneModels turns BED12 into igv features with exons, coding range and the gene's id and type", () => {
    const { features, index } = parseGeneModels(GAPDH_ROW);
    expect(features).toHaveLength(1);
    const f = features[0];
    expect(f).toMatchObject({ chr: "chr12", start: 6534516, end: 6538371, strand: "+", name: "GAPDH", cdStart: 6534832, cdEnd: 6538170 });
    expect(f.exons).toHaveLength(9);
    expect(f.exons[0]).toEqual({ start: 6534516, end: 6534569, utr: true }); // 5' UTR: coding starts in exon 2
    expect(f.exons[8]).toEqual({ start: 6538100, end: 6538371, cdEnd: 6538170 });
    expect(f.gene_id).toBe("ENSG00000111640.17");
    expect(f.gene_type).toBe("protein_coding");
    expect(index.get("GAPDH")).toEqual([{ name: "GAPDH", chrom: "chr12", start: 6534516, end: 6538371 }]);
  });

  it("parseGeneModels indexes symbols, case-insensitively, with the gene's span", () => {
    const idx = parseGeneModels(readFileSync(join(PUBLIC, "refdata/hg38/genes/gene_models.bed"), "utf8")).index;
    const g = idx.get("GAPDH")![0];
    expect(g.chrom).toBe("chr12");
    expect(g.end - g.start).toBeGreaterThan(1000);
    expect(parseLocus("gapdh", HG38, idx)).toEqual({ chrom: g.chrom, start: g.start, end: g.end });
    expect(idx.size).toBeGreaterThan(19000);
  });
});
