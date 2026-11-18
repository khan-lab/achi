import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserConfig, nonLocalUrls } from "./browserTracks";
import {
  CONSENT_HOSTS,
  ENCODE_ASSEMBLY,
  encodeSearchUrl,
  parseEncodeSearch,
  parseTrackInput,
  remoteTrackConfig,
  remoteTracksUrl,
  urlTrack,
  type RemoteTrack,
  type RemoteTrackList,
} from "./remoteTracks";

/**
 * Public tracks for the genome browser (phase 2): ENCODE and SCREEN files
 * read by igv.js in byte ranges, only after the user agrees. Fixtures: the
 * vendored curated lists (public/refdata/<asm>/remote/tracks.json, built
 * by build_remote_tracks.py) and real ENCODE API responses
 * (tests/fixtures/encode_api/).
 */

const PUBLIC = join(__dirname, "../../public");
const API = join(__dirname, "../../tests/fixtures/encode_api");
const BASE = "https://khan-lab.github.io/achi/";
const ORIGIN = "https://khan-lab.github.io";
const CONSENTED = new Set(CONSENT_HOSTS.map((h) => h.host));

const list = (asm: string) => JSON.parse(readFileSync(join(PUBLIC, `refdata/${asm}/remote/tracks.json`), "utf8")) as RemoteTrackList;

describe("curated public track lists", () => {
  it("exist for hg38, hg19 and mm10, and not for mm9 (ENCODE and SCREEN have nothing curated for it)", () => {
    for (const asm of ["hg38", "hg19", "mm10"]) expect(existsSync(join(PUBLIC, `refdata/${asm}/remote/tracks.json`))).toBe(true);
    expect(existsSync(join(PUBLIC, "refdata/mm9/remote/tracks.json"))).toBe(false);
    expect(remoteTracksUrl("hg38", BASE)).toBe(`${BASE}refdata/hg38/remote/tracks.json`);
  });

  for (const asm of ["hg38", "hg19", "mm10"]) {
    it(`${asm}: every track is a bigWig/bigBed on a host the consent notice names, ids unique`, () => {
      const l = list(asm);
      expect(l.assembly).toBe(asm);
      const ids = new Set<string>();
      for (const t of l.tracks) {
        expect(["bigwig", "bigbed"]).toContain(t.kind);
        const u = new URL(t.url);
        expect(u.protocol).toBe("https:");
        expect(CONSENTED.has(u.hostname)).toBe(true);
        expect(l.hosts).toContain(u.hostname);
        expect(ids.has(t.id)).toBe(false);
        ids.add(t.id);
        expect(t.name.length).toBeGreaterThan(0);
        expect(t.source.startsWith("https://")).toBe(true);
      }
    });
  }

  it("hg38 has the SCREEN merged signals, the cCRE registry and four assays for each example cell line", () => {
    const t = list("hg38").tracks;
    expect(t.filter((x) => x.id.startsWith("screen-hg38-")).map((x) => x.name)).toEqual([
      "SCREEN DNase (merged)",
      "SCREEN ATAC (merged)",
      "SCREEN H3K4me3 (merged)",
      "SCREEN H3K27ac (merged)",
      "SCREEN CTCF (merged)",
    ]);
    expect(t.find((x) => x.id === "ENCFF217ARC")?.kind).toBe("bigbed"); // V4 registry, ENCSR800VNX
    for (const cell of ["GM12878", "HepG2", "K562", "MCF-7", "H1"])
      expect(t.filter((x) => x.group === `ENCODE: ${cell}`).map((x) => x.name.slice(cell.length + 1))).toEqual(["DNase", "H3K27ac", "H3K4me3", "CTCF", "cCREs"]);
    expect(t.filter((x) => x.group === "Conservation (UCSC)").map((x) => x.name)).toEqual(["phyloP, 100 vertebrates", "phyloP, 241 mammals (Zoonomia)"]);
    expect(t.filter((x) => x.group.startsWith("TF binding sites")).map((x) => x.name)).toEqual(["JASPAR 2024 TFBS"]);
  });

  it("hg19 and mm10 have their own conservation and JASPAR tracks; hg19 its cell-type cCREs", () => {
    expect(list("hg19").tracks.filter((x) => x.group === "Conservation (UCSC)").map((x) => x.name)).toEqual(["phyloP, 100 vertebrates"]);
    expect(list("mm10").tracks.filter((x) => x.group === "Conservation (UCSC)").map((x) => x.name)).toEqual(["phyloP, 60 vertebrates"]);
    for (const asm of ["hg19", "mm10"]) expect(list(asm).tracks.some((x) => x.name === "JASPAR 2024 TFBS")).toBe(true);
    expect(list("hg19").tracks.filter((x) => x.name.endsWith(" cCREs"))).toHaveLength(5);
  });

  it("dense bigBeds (JASPAR: every motif match) are drawn only when zoomed in", () => {
    const j = list("hg38").tracks.find((x) => x.name === "JASPAR 2024 TFBS")!;
    expect(j.visibilityWindow).toBeLessThanOrEqual(50_000);
    expect(remoteTrackConfig(j).visibilityWindow).toBe(j.visibilityWindow);
    // Every motif match is in the file, most weak: shade by score and stack, so strong sites stand out.
    expect(remoteTrackConfig(j)).toMatchObject({ useScore: true, displayMode: "EXPANDED" });
    expect(remoteTrackConfig(list("hg38").tracks.find((x) => x.id === "ENCFF217ARC")!)).toMatchObject({ displayMode: "COLLAPSED" });
    expect(remoteTrackConfig(list("hg38").tracks.find((x) => x.id === "ENCFF217ARC")!)).not.toHaveProperty("useScore");
  });
});

describe("igv track configuration for public tracks", () => {
  const bw: RemoteTrack = list("hg38").tracks.find((t) => t.id === "ENCFF469WVA")!;
  const bb: RemoteTrack = list("hg38").tracks.find((t) => t.id === "ENCFF217ARC")!;

  it("bigWig -> wig track, bigBed -> annotation track, both by URL (igv reads byte ranges)", () => {
    expect(remoteTrackConfig(bw)).toMatchObject({ type: "wig", format: "bigwig", url: bw.url, name: bw.name, autoscale: true });
    expect(remoteTrackConfig(bb)).toMatchObject({ type: "annotation", format: "bigbed", url: bb.url, name: bb.name });
  });

  it("a configuration with public tracks reaches only the hosts the user agreed to", () => {
    const cfg = browserConfig({ assembly: "hg38", base: BASE, locus: { chrom: "chr1", start: 0, end: 1000 }, tracks: [remoteTrackConfig(bw), remoteTrackConfig(bb)] });
    expect(nonLocalUrls(cfg, ORIGIN, CONSENTED)).toEqual([]);
    expect(nonLocalUrls(cfg, ORIGIN)).toHaveLength(2); // without consent, both are outside the app
    const other = urlTrack("https://example.org/x.bw");
    expect(nonLocalUrls(browserConfig({ assembly: "hg38", base: BASE, locus: { chrom: "chr1", start: 0, end: 1 }, tracks: [remoteTrackConfig(other as RemoteTrack)] }), ORIGIN, CONSENTED)).toEqual(["https://example.org/x.bw"]);
  });
});

describe("parseTrackInput", () => {
  it("recognises ENCODE file accessions", () => {
    expect(parseTrackInput(" encff469wva ")).toEqual({ kind: "accession", accession: "ENCFF469WVA" });
  });
  it("recognises bigWig and bigBed URLs by extension, https only", () => {
    expect(parseTrackInput("https://downloads.wenglab.org/hg38.phyloP100way.bw")).toEqual({ kind: "url", url: "https://downloads.wenglab.org/hg38.phyloP100way.bw", format: "bigwig" });
    expect(parseTrackInput("https://example.org/a/b.bigBed?x=1")).toEqual({ kind: "url", url: "https://example.org/a/b.bigBed?x=1", format: "bigbed" });
    expect(parseTrackInput("https://example.org/b.bigwig")).toMatchObject({ format: "bigwig" });
    expect(parseTrackInput("https://example.org/b.bb")).toMatchObject({ format: "bigbed" });
    expect(parseTrackInput("http://example.org/b.bw")).toHaveProperty("error"); // the app is served over https
    expect(parseTrackInput("https://example.org/peaks.bed")).toHaveProperty("error"); // whole-file formats: add as a set instead
  });
  it("treats anything else as an ENCODE search", () => {
    expect(parseTrackInput("HepG2 CTCF")).toEqual({ kind: "search", term: "HepG2 CTCF" });
    expect(parseTrackInput(" ")).toHaveProperty("error");
  });
});

describe("ENCODE search and accession lookup", () => {
  it("builds a search for released bigWig/bigBed files of the current assembly, sending only the search words", () => {
    const u = new URL(encodeSearchUrl({ term: "HepG2 CTCF" }, "hg38"));
    expect(u.origin).toBe("https://www.encodeproject.org");
    expect(u.searchParams.get("searchTerm")).toBe("HepG2 CTCF");
    expect(u.searchParams.get("assembly")).toBe("GRCh38");
    expect(u.searchParams.getAll("file_format").sort()).toEqual(["bigBed", "bigWig"]);
    expect(u.searchParams.get("status")).toBe("released");
    expect(u.searchParams.getAll("field")).toContain("cloud_metadata.url");
    const a = new URL(encodeSearchUrl({ accession: "ENCFF469WVA" }, "hg38"));
    expect(a.searchParams.get("accession")).toBe("ENCFF469WVA");
    expect(a.searchParams.get("assembly")).toBeNull(); // look it up anywhere, then say if it is the wrong assembly
    expect(ENCODE_ASSEMBLY).toEqual({ hg38: "GRCh38", hg19: "hg19", mm10: "mm10", mm9: "mm9" });
  });

  it("turns search results into tracks read from ENCODE's public S3 bucket", () => {
    const json = JSON.parse(readFileSync(join(API, "search_GRCh38_HepG2_CTCF.json"), "utf8"));
    const { tracks, skipped } = parseEncodeSearch(json, "hg38");
    expect(skipped).toEqual([]);
    expect(tracks.map((t) => t.id)).toEqual(json["@graph"].map((g: { accession: string }) => g.accession));
    for (const t of tracks) expect(new URL(t.url).hostname).toBe("encode-public.s3.amazonaws.com");
    expect(tracks[0]).toMatchObject({ kind: "bigwig", name: "HepG2 CTCF ChIA-PET signal of unique reads", group: "ENCODE search" });
    expect(tracks[1].kind).toBe("bigbed");
    expect(tracks[4].name).toBe("HepG2 signal p-value"); // no assay or target in the record
  });

  it("skips files on another assembly, saying why", () => {
    const json = JSON.parse(readFileSync(join(API, "accessions_ENCFF469WVA_ENCFF901GZH.json"), "utf8"));
    const { tracks, skipped } = parseEncodeSearch(json, "hg38");
    expect(tracks.map((t) => t.id)).toEqual(["ENCFF469WVA"]);
    expect(skipped).toEqual([{ accession: "ENCFF901GZH", reason: "is on hg19, not hg38" }]);
  });
});
