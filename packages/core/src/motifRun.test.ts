import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SequenceSource } from "./genomeSequence";
import type { JasparFile, MotifCollection } from "./motifCollections";
import { compositionStrata, cpgRatio, gcPerMille, motifEnrichment, scanPlan } from "./motifEnrichment";
import { MOTIF_TSV_HEAD, motifTsv, runMotifEnrichment } from "./motifRun";
import { scanMotifsInline } from "./motifScan";
import { backgroundOf, encodeSequence, packSequences } from "./pwm";
import type { Runtime } from "./runtime";
import { buildUniverse } from "./subsetEnrichment";
import { memoryBedtools } from "./testkit";

/**
 * Motif enrichment as every layer runs it. Real data: hg38 sequence around
 * 150 K562 and 150 HepG2 example super-enhancers and 26 JASPAR 2026
 * matrices (tests/fixtures/motifs). The regions are placed 1 kb apart on a
 * stand-in chromosome; the sequence source answers each ±100 bp window with
 * its fixture sequence.
 */
const DIR = join(__dirname, "..", "..", "..", "tests", "fixtures", "motifs");
const expected: { motifs: { id: string; name: string; pfm: number[][] }[] } = JSON.parse(readFileSync(join(DIR, "expected_moods.json"), "utf8"));
const seqs = readFileSync(join(DIR, "sequences.fa"), "utf8")
  .split(">")
  .filter(Boolean)
  .map((b) => b.split("\n").slice(1).join("").trim());
const region = (i: number) => ({ chrom: "chrS", start: i * 1000, end: i * 1000 + 200 });
const subsets = [
  { mask: 1, regions: seqs.slice(0, 150).map((_, i) => region(i)) },
  { mask: 2, regions: seqs.slice(150).map((_, i) => region(150 + i)) },
];
const source: SequenceSource = {
  label: "fixture sequences",
  read: async (windows) => windows.map((w) => (w.chrom === "chrS" && w.start % 1000 === 0 ? (seqs[w.start / 1000] ?? null) : null)),
};
const jaspar: JasparFile = {
  release: "JASPAR 2026",
  collection: "CORE",
  taxon: "vertebrates",
  nonRedundant: true,
  source: "tests/fixtures/motifs",
  sourceMd5: "",
  sourceMatrices: expected.motifs.length,
  licence: "CC BY 4.0",
  citation: "",
  motifs: expected.motifs.map((m) => ({ id: m.id, name: m.name, class: ["C"], family: ["F"], taxon: "vertebrates", pfm: m.pfm })),
};
const collection: MotifCollection = { id: "fixture", label: "fixture", files: ["fixture.json"], methods: "fixture", help: "" };

function runtime() {
  const loaded: string[] = [];
  const rt: Runtime = { bedtools: memoryBedtools(), refdata: { text: async (p) => (loaded.push(p), JSON.stringify(jaspar)) }, scanMotifs: scanMotifsInline };
  return { rt, loaded };
}

describe("runMotifEnrichment", () => {
  it("scans the window around each region's centre and tests each group against the rest over composition strata", async () => {
    const { rt, loaded } = runtime();
    const labels: string[] = [];
    const run = await runMotifEnrichment(rt, { assembly: "hg38", collection, subsets, groups: [1, 2], half: 100, p: 1e-4, source }, { onProgress: (p) => labels.push(p.label) });

    // The same steps by hand.
    const universe = buildUniverse(subsets);
    const plan = scanPlan(universe.owner, [1, 2]);
    expect(plan.scan.length).toBe(300); // under the pool limit: every region is scanned
    const codes = Array.from(plan.scan, (i) => encodeSequence(seqs[i]));
    const gc = Int32Array.from(codes, gcPerMille);
    const valid = Uint8Array.from(gc, (g) => (g >= 0 ? 1 : 0));
    const scan = await scanMotifsInline(packSequences(codes), jaspar.motifs.map((m) => m.pfm), backgroundOf(codes), 1e-4);
    const cells = motifEnrichment({ owner: Int32Array.from(plan.scan, (i) => universe.owner[i]), pool: plan.pool, valid, strata: compositionStrata(gc, Float64Array.from(codes, cpgRatio)), hits: scan.hits, keys: [1, 2] });

    expect(run.cells).toEqual(cells);
    expect(run).toMatchObject({ release: "JASPAR 2026", keys: [1, 2], half: 100, p: 1e-4, nScanned: 300, nUniverse: 300, nNoSequence: 0, source: "fixture sequences", assembly: "hg38" });
    expect(run.motifs.map((m) => m.id)).toEqual(jaspar.motifs.map((m) => m.id));
    expect(labels).toEqual(expect.arrayContaining(["Loading JASPAR matrices", "Reading sequence", "Scanning 26 JASPAR motifs"]));
    await runMotifEnrichment(rt, { assembly: "hg38", collection, subsets, groups: [1], half: 100, p: 1e-4, source });
    expect(loaded).toEqual(["refdata/jaspar/fixture.json"]); // once per reference-data source
  });

  it("scans at most maxScan regions (the exact mode's limit), half for the pool", async () => {
    const { rt } = runtime();
    const run = await runMotifEnrichment(rt, { assembly: "hg38", collection, subsets, groups: [1], half: 100, p: 1e-4, source, maxScan: 200 });
    expect(run.nScanned).toBeLessThanOrEqual(200);
    expect(run.nUniverse).toBe(300);
  });

  it("refuses a source with no sequence for any region (the wrong genome)", async () => {
    const { rt } = runtime();
    const none: SequenceSource = { label: "empty.2bit", read: async (w) => w.map(() => null) };
    await expect(runMotifEnrichment(rt, { assembly: "hg38", collection, subsets, groups: [1], half: 100, p: 1e-4, source: none })).rejects.toThrow("No sequence was found for these regions in empty.2bit: is it the hg38 genome?");
  });

  it("writes the TSV of the download, one row per group and motif", async () => {
    const { rt } = runtime();
    const run = await runMotifEnrichment(rt, { assembly: "hg38", collection, subsets, groups: [1, 2], half: 100, p: 1e-4, source });
    const lines = motifTsv(run, (k) => (k === 1 ? "K562 only" : "HepG2 only")).trimEnd().split("\n");
    expect(lines[0]).toBe(MOTIF_TSV_HEAD.join("\t"));
    expect(lines).toHaveLength(1 + run.cells.length);
    const c = run.cells[0];
    const m = run.motifs[c.motif];
    expect(lines[1].split("\t")).toEqual([c.key === 1 ? "K562 only" : "HepG2 only", m.id, "CORE", m.name, "C", "F", String(c.table[0]), String(c.table[0] + c.table[1]), String(c.table[2]), String(c.table[2] + c.table[3]), String(c.oddsRatio), String(c.p), String(c.q), "CMH, 15 strata (GC quintile x CpG o/e tertile)"]);
  });
});
