import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nonLocalUrls } from "./browserTracks";
import { normalizeRegionText } from "./inputValidation";
import { parseBed } from "./intervals";
import {
  detectLocalFormat,
  localTrackConfig,
  makeSeqFetch,
  pairLocalFiles,
  prepareLocalReference,
  prepareLocalTrack,
  readReferenceSequence,
  type LocalReference,
  type LocalTrack,
} from "./localTracks";

/**
 * Local genome-browser tracks: files from the user's disk, shown in the
 * genome browser only (not part of the intersection analysis). Real data:
 * UCSC's example bigBed and the header of its example bigWig
 * (tests/fixtures/ucsc), and the ENCODE peak fixtures. Privacy rule: a
 * local track's igv configuration points at the File itself, never at a URL.
 */

const ROOT = join(__dirname, "../..");
const sizesOf = (asm: string) =>
  Object.fromEntries(
    readFileSync(join(ROOT, `public/refdata/${asm}/${asm}.chrom.sizes`), "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("\t"))
      .map(([c, n]) => [c, Number(n)]),
  ) as Record<string, number>;
const HG38 = sizesOf("hg38");
const MM10 = sizesOf("mm10");
const fixture = (path: string) => readFileSync(join(ROOT, "tests/fixtures", path));
const asFile = (bytes: Uint8Array | string, name: string) => new File([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], name);
const HEART = fixture("encode/heart_h3k27ac_ENCFF059ERB.subsample.bed").toString("utf8");
const BIGBED = fixture("ucsc/bigBedExample.bb");
const BIGWIG_HEAD = fixture("ucsc/bigWigExample.first64k.bw");
const BAM = fixture("igv/hg00096_hg38.bam");
const BAI = fixture("igv/hg00096_hg38.bam.bai");
const CRAM = fixture("igv/hg00096_hg38.cram");
const CRAI = fixture("igv/hg00096_hg38.cram.crai");
const CHRM_FA = fixture("ucsc/hg38_chrM.fa");
const CHRM_FAI = fixture("ucsc/hg38_chrM.fa.fai");
/** chrM as one string, from the FASTA itself: what any slice read through the .fai must match. */
const CHRM_SEQ = CHRM_FA.toString("utf8").split("\n").slice(1).join("").toUpperCase();
const ORIGIN = "https://khan-lab.github.io";

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function ok(r: LocalTrack | { error: string }): LocalTrack {
  if ("error" in r) throw new Error(`expected a track, got: ${r.error}`);
  return r;
}

describe("detectLocalFormat", () => {
  it("knows the formats by file name, case-insensitively, with .gz for text formats", () => {
    const f = (n: string) => {
      const r = detectLocalFormat(n);
      return "error" in r ? "error" : `${r.format}/${r.kind}/${r.text ? "text" : "binary"}`;
    };
    expect(f("H3K27ac.bw")).toBe("bigwig/signal/binary");
    expect(f("H3K27ac.bigWig")).toBe("bigwig/signal/binary");
    expect(f("peaks.bb")).toBe("bigbed/annotation/binary");
    expect(f("peaks.bigBed")).toBe("bigbed/annotation/binary");
    expect(f("peaks.bed")).toBe("bed/annotation/text");
    expect(f("peaks.BED.gz")).toBe("bed/annotation/text");
    expect(f("ENCFF1.narrowPeak.gz")).toBe("narrowpeak/annotation/text");
    expect(f("ENCFF1.broadPeak")).toBe("broadpeak/annotation/text");
    expect(f("cov.bedGraph")).toBe("bedgraph/signal/text");
    expect(f("cov.bdg.gz")).toBe("bedgraph/signal/text");
    expect(f("calls.vcf.gz")).toBe("vcf/annotation/text");
  });
  it("knows BAM and CRAM as alignments read in ranges", () => {
    expect(detectLocalFormat("reads.bam")).toEqual({ format: "bam", kind: "alignment", text: false });
    expect(detectLocalFormat("reads.CRAM")).toEqual({ format: "cram", kind: "alignment", text: false });
  });
  it("names what it does not take", () => {
    for (const n of ["x.txt", "x.bw.gz", "x.gtf", "x", "x.bam.gz", "x.sam"]) expect(detectLocalFormat(n)).toHaveProperty("error");
    expect((detectLocalFormat("x.txt") as { error: string }).error).toMatch(/bigWig.*bigBed.*BED.*narrowPeak.*bedGraph.*VCF.*BAM.*CRAM/);
  });
});

describe("prepareLocalTrack: bigWig and bigBed", () => {
  it("takes a real bigBed and a real bigWig header as they are, without reading them whole", async () => {
    const bb = asFile(BIGBED, "bigBedExample.bb");
    const t = ok(await prepareLocalTrack(bb, HG38, "a"));
    expect(t).toMatchObject({ id: "a", name: "bigBedExample.bb", format: "bigbed", kind: "annotation" });
    expect(t.file).toBe(bb); // the File itself: igv reads byte ranges from it
    expect(t.regions).toBeUndefined();
    const bw = ok(await prepareLocalTrack(asFile(BIGWIG_HEAD, "bigWigExample.bw"), HG38, "b"));
    expect(bw).toMatchObject({ format: "bigwig", kind: "signal" });
  });
  it("rejects a file whose signature does not match its extension", async () => {
    expect(await prepareLocalTrack(asFile(BIGBED, "renamed.bw"), HG38, "x")).toEqual({ error: expect.stringMatching(/renamed\.bw is not a bigWig file/) });
    expect(await prepareLocalTrack(asFile(BIGWIG_HEAD, "renamed.bb"), HG38, "x")).toEqual({ error: expect.stringMatching(/is not a bigBed file/) });
    expect(await prepareLocalTrack(asFile(HEART, "peaks.bw"), HG38, "x")).toHaveProperty("error");
  });
});

describe("prepareLocalTrack: text formats", () => {
  const expected = parseBed(normalizeRegionText(HEART).bedText);

  it("reads a BED file: regions for the overview, the file for igv, no warning when it fits the assembly", async () => {
    const t = ok(await prepareLocalTrack(asFile(HEART, "heart.bed"), HG38, "h"));
    expect(t).toMatchObject({ name: "heart.bed", format: "bed", kind: "annotation", warnings: [] });
    expect(t.regions).toHaveLength(expected.length);
    expect(await t.file.text()).toContain(HEART.split("\n")[0].split("\t").slice(0, 3).join("\t"));
  });

  it("reads gzip-compressed text the same, and gives igv the uncompressed file", async () => {
    const t = ok(await prepareLocalTrack(asFile(await gzip(HEART), "heart.bed.gz"), HG38, "g"));
    expect(t.regions).toEqual(ok(await prepareLocalTrack(asFile(HEART, "heart.bed"), HG38, "h")).regions);
    expect(t.file.name).toBe("heart.bed");
    expect((await t.file.text()).startsWith("chr")).toBe(true);
  });

  it("renames Ensembl-style chromosomes (1, 2, MT) to the assembly's (chr1, chr2, chrM), for igv and the overview, and says so", async () => {
    const ensembl = HEART.split("\n").map((l) => l.replace(/^chr/, "")).join("\n");
    const t = ok(await prepareLocalTrack(asFile(ensembl, "ensembl.bed"), HG38, "e"));
    expect(t.regions).toHaveLength(expected.length);
    expect(t.regions!.every((r) => r.chrom.startsWith("chr"))).toBe(true);
    expect((await t.file.text()).split("\n")[0]).toMatch(/^chr/);
    expect(t.warnings.join(" ")).toMatch(/1, 2, … were read as chr1, chr2, …/);
  });

  it("warns when chromosomes are missing from the assembly and leaves those regions out of the overview", async () => {
    // Human peaks against mm10: chr20-22 do not exist in mouse.
    const t = ok(await prepareLocalTrack(asFile(HEART, "heart.bed"), MM10, "m"));
    const missing = expected.filter((r) => !(r.chrom in MM10)).length;
    expect(missing).toBeGreaterThan(0);
    expect(t.regions!.length).toBe(expected.length - missing);
    expect(t.warnings.join(" ")).toMatch(/not in this assembly/);
  });

  it("keeps bedGraph as a signal track: checked, but no overview rows", async () => {
    const bedGraph = HEART.split("\n")
      .filter(Boolean)
      .map((l) => {
        const c = l.split("\t");
        return [c[0], c[1], c[2], c[6]].join("\t"); // narrowPeak signalValue as the value
      })
      .join("\n");
    const t = ok(await prepareLocalTrack(asFile(bedGraph, "signal.bedGraph"), HG38, "s"));
    expect(t).toMatchObject({ format: "bedgraph", kind: "signal", regions: undefined });
  });

  it("rejects text that is not regions, and text over the size limit", async () => {
    expect(await prepareLocalTrack(asFile(BIGBED, "binary.bed"), HG38, "x")).toEqual({ error: expect.stringMatching(/binary\.bed/) });
    expect(await prepareLocalTrack(asFile(HEART, "heart.bed"), HG38, "x", { maxBytes: 1000 })).toEqual({ error: expect.stringMatching(/the limit is/) });
  });
});

describe("localTrackConfig", () => {
  const file = asFile("x", "x");
  const config = (format: LocalTrack["format"], kind: LocalTrack["kind"]) =>
    localTrackConfig({ id: "t", name: "my track", file, format, kind, warnings: [], nRegions: 10 }) as unknown as Record<string, unknown>;

  it("hands igv the File itself, with the format stated and no index to look up", () => {
    expect(config("bigwig", "signal")).toMatchObject({ type: "wig", format: "bigwig", url: file, name: "my track", autoscale: true });
    expect(config("bedgraph", "signal")).toMatchObject({ type: "wig", format: "bedgraph", url: file, indexed: false });
    expect(config("bigbed", "annotation")).toMatchObject({ type: "annotation", format: "bigbed", url: file });
    expect(config("narrowpeak", "annotation")).toMatchObject({ type: "annotation", format: "narrowpeak", url: file, indexed: false });
    expect(config("vcf", "annotation")).toMatchObject({ type: "variant", format: "vcf", url: file, indexed: false });
  });

  it("contains no URL at all: nothing for igv to fetch from a server", () => {
    for (const [f, k] of [["bigwig", "signal"], ["bigbed", "annotation"], ["bed", "annotation"], ["bedgraph", "signal"], ["vcf", "annotation"]] as const) {
      const c = config(f, k);
      expect(nonLocalUrls(c, ORIGIN)).toEqual([]);
      expect(Object.keys(c)).not.toContain("indexURL");
      expect(c.url).toBeInstanceOf(File);
    }
  });
});

describe("pairLocalFiles", () => {
  const names = (r: ReturnType<typeof pairLocalFiles>) => ({
    items: r.items.map((i) => [i.file.name, i.index?.name ?? null]),
    reference: r.reference ? [r.reference.fasta.name, r.reference.fai.name] : null,
    errors: r.errors,
  });
  it("pairs BAM, CRAM and FASTA with their indexes, by either naming convention, case-insensitively", () => {
    const r = pairLocalFiles([
      asFile(BAM, "a.bam"), asFile(BAI, "a.bam.bai"),
      asFile(CRAM, "b.cram"), asFile(CRAI, "B.crai"),
      asFile(CHRM_FA, "ref.fa"), asFile(CHRM_FAI, "ref.fa.fai"),
      asFile(HEART, "peaks.bed"),
    ]);
    expect(names(r)).toEqual({ items: [["a.bam", "a.bam.bai"], ["b.cram", "B.crai"], ["peaks.bed", null]], reference: ["ref.fa", "ref.fa.fai"], errors: [] });
  });
  it("says which index is missing, which index has no data file, and that CSI is not read", () => {
    const r = pairLocalFiles([asFile(BAM, "a.bam"), asFile(CRAI, "orphan.crai"), asFile(BAI, "c.bam.csi")]);
    expect(r.items).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/a\.bam needs its index \(a\.bam\.bai or a\.bai\)/);
    expect(r.errors.join(" ")).toMatch(/orphan\.crai: no matching/);
    expect(r.errors.join(" ")).toMatch(/c\.bam\.csi: CSI indexes are not supported/);
  });
  it("takes one reference at a time and needs its .fai", () => {
    expect(pairLocalFiles([asFile(CHRM_FA, "ref.fa")]).errors.join(" ")).toMatch(/ref\.fa needs its index \(ref\.fa\.fai/);
    expect(pairLocalFiles([asFile(CHRM_FA, "ref.fa.gz"), asFile(CHRM_FAI, "ref.fa.gz.fai")]).errors.join(" ")).toMatch(/compressed FASTA/);
    const two = pairLocalFiles([asFile(CHRM_FA, "a.fa"), asFile(CHRM_FAI, "a.fa.fai"), asFile(CHRM_FA, "b.fasta"), asFile(CHRM_FAI, "b.fasta.fai")]);
    expect(two.errors.join(" ")).toMatch(/one reference FASTA at a time/);
  });
});

describe("prepareLocalTrack: BAM and CRAM", () => {
  it("takes a real BAM with its .bai and a real CRAM with its .crai, as they are", async () => {
    const bam = asFile(BAM, "hg00096.bam");
    const bai = asFile(BAI, "hg00096.bam.bai");
    const t = ok(await prepareLocalTrack(bam, HG38, "b", { index: bai }));
    expect(t).toMatchObject({ format: "bam", kind: "alignment", name: "hg00096.bam" });
    expect(t.file).toBe(bam);
    expect(t.index).toBe(bai);
    expect(ok(await prepareLocalTrack(asFile(CRAM, "x.cram"), HG38, "c", { index: asFile(CRAI, "x.cram.crai") }))).toMatchObject({ format: "cram" });
  });
  it("checks the file and its index by their first bytes (BGZF + BAM, BAI, CRAM, gzip CRAI)", async () => {
    const err = async (f: File, i: File) => (await prepareLocalTrack(f, HG38, "x", { index: i })) as { error: string };
    expect((await err(asFile(CRAM, "x.bam"), asFile(BAI, "x.bai"))).error).toMatch(/x\.bam is not a BAM file/);
    expect((await err(asFile(await gzip(HEART), "x.bam"), asFile(BAI, "x.bai"))).error).toMatch(/is not a BAM file/); // gzip, not BGZF BAM
    expect((await err(asFile(BAM, "x.bam"), asFile(CRAI, "x.bai"))).error).toMatch(/x\.bai is not a BAM index/);
    expect((await err(asFile(BAM, "x.cram"), asFile(CRAI, "x.crai"))).error).toMatch(/x\.cram is not a CRAM file/);
    expect((await err(asFile(CRAM, "x.cram"), asFile(BAI, "x.crai"))).error).toMatch(/x\.crai is not a CRAM index/);
    expect(await prepareLocalTrack(asFile(BAM, "x.bam"), HG38, "x")).toEqual({ error: expect.stringMatching(/needs its index/) });
  });
});

describe("prepareLocalReference and readReferenceSequence", () => {
  const ref = async () => (await prepareLocalReference(asFile(CHRM_FA, "chrM.fa"), asFile(CHRM_FAI, "chrM.fa.fai"), HG38, "r")) as LocalReference;

  it("accepts a FASTA whose sequences match the assembly, and says how much of it it covers", async () => {
    const r = await ref();
    expect(r).toMatchObject({ name: "chrM.fa" });
    expect(r.warnings.join(" ")).toMatch(/Covers 1 of 25 chromosomes/);
  });
  it("reads any slice through the .fai exactly as the FASTA has it, across line breaks, upper-cased", async () => {
    const r = await ref();
    for (const [s, e] of [[0, 10], [45, 55], [49, 51], [16500, 16569], [0, 16569]] as const)
      expect(await readReferenceSequence(r, "chrM", s, e)).toBe(CHRM_SEQ.slice(s, e));
    expect(await readReferenceSequence(r, "MT", 0, 5)).toBe(CHRM_SEQ.slice(0, 5)); // Ensembl name
    expect(await readReferenceSequence(r, "chr1", 0, 5)).toBeNull();
  });
  it("refuses a FASTA from another assembly, a .fai of another file, and files that are not FASTA", async () => {
    const lengthOff = CHRM_FAI.toString("utf8").replace("16569", "16571");
    expect(await prepareLocalReference(asFile(CHRM_FA, "m.fa"), asFile(lengthOff, "m.fa.fai"), HG38, "r")).toEqual({
      error: expect.stringMatching(/m\.fa does not match this assembly: chrM is 16,571 bp in it but 16,569 bp in the assembly/),
    });
    const otherName = CHRM_FAI.toString("utf8").replace("chrM", "chrUn_x");
    expect(await prepareLocalReference(asFile(CHRM_FA, "m.fa"), asFile(otherName, "m.fa.fai"), HG38, "r")).toHaveProperty("error");
    expect(await prepareLocalReference(asFile(HEART, "m.fa"), asFile(CHRM_FAI, "m.fa.fai"), HG38, "r")).toEqual({ error: expect.stringMatching(/m\.fa is not a FASTA file/) });
    expect(await prepareLocalReference(asFile(CHRM_FA, "m.fa"), asFile(HEART, "m.fa.fai"), HG38, "r")).toEqual({ error: expect.stringMatching(/m\.fa\.fai is not a FASTA index/) });
  });
});

describe("makeSeqFetch (CRAM reference)", () => {
  it("answers cram-js: sequence index -> name from the CRAM header, 1-based inclusive range, from the local FASTA", async () => {
    const r = (await prepareLocalReference(asFile(CHRM_FA, "chrM.fa"), asFile(CHRM_FAI, "chrM.fa.fai"), HG38, "r")) as LocalReference;
    const fetch = makeSeqFetch(r);
    // cram-js calls it as a method of its CramFile, which has getSamHeader()
    const cramFile = { getSamHeader: async () => [{ tag: "HD", data: [] }, { tag: "SQ", data: [{ tag: "SN", value: "chr8" }] }, { tag: "SQ", data: [{ tag: "SN", value: "chrM" }] }] };
    expect(await fetch.call(cramFile, 1, 1, 10)).toBe(CHRM_SEQ.slice(0, 10));
    expect(await fetch.call(cramFile, 1, 101, 150)).toBe(CHRM_SEQ.slice(100, 150));
    await expect(fetch.call(cramFile, 0, 1, 10)).rejects.toThrow(/chr8 is not in chrM\.fa/);
  });
});

describe("localTrackConfig: alignments", () => {
  const bam = asFile(BAM, "a.bam");
  const bai = asFile(BAI, "a.bam.bai");
  it("gives igv the BAM and its index as Files; a CRAM also gets the local reference, and nothing has a URL", async () => {
    const c = localTrackConfig({ id: "a", name: "a.bam", file: bam, index: bai, format: "bam", kind: "alignment", warnings: [] }) as unknown as Record<string, unknown>;
    expect(c).toMatchObject({ type: "alignment", format: "bam", url: bam, indexURL: bai });
    expect(nonLocalUrls(c, ORIGIN)).toEqual([]);
    const r = (await prepareLocalReference(asFile(CHRM_FA, "chrM.fa"), asFile(CHRM_FAI, "chrM.fa.fai"), HG38, "r")) as LocalReference;
    const cram = asFile(CRAM, "b.cram");
    const cc = localTrackConfig({ id: "b", name: "b.cram", file: cram, index: asFile(CRAI, "b.crai"), format: "cram", kind: "alignment", warnings: [] }, r) as unknown as Record<string, unknown>;
    expect(cc).toMatchObject({ type: "alignment", format: "cram", url: cram, checkSequenceMD5: true });
    expect(typeof cc.seqFetch).toBe("function");
    expect(nonLocalUrls(cc, ORIGIN)).toEqual([]);
    expect(() => localTrackConfig({ id: "b", name: "b.cram", file: cram, index: cram, format: "cram", kind: "alignment", warnings: [] })).toThrow(/reference/);
  });
});
