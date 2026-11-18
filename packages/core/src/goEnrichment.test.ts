import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CISTROMEGO_DEFAULTS, cistromeGoTestAsync, prepareCistromeGo, type RpModel } from "./cistromeGo";
import { GREAT_RUN_DEFAULTS, goTsv, peaksWithScores, runGoEnrichment, type GoGroup } from "./goEnrichment";
import { assignRegions, greatTest, inputsGoTest, prepareGreat, type GoData } from "./great";
import { parseChromSizes } from "./inputValidation";
import { scanMotifsInline } from "./motifScan";
import { memoryBedtools } from "./testkit";
import type { Runtime } from "./runtime";
import type { Interval } from "./types";

/**
 * GO enrichment as every layer runs it: the GREAT-like (vs. genome or vs.
 * the input sets) and Cistrome-GO-like tests over each selected group, with
 * the rows, TSV and summaries the web app shows and downloads. Real data:
 * two ENCODE H3K27ac fixtures as groups, and the bundled hg38 GO data and
 * Cistrome-GO gene model, read through the runtime.
 */
const ROOT = join(__dirname, "../../..");
const PUBLIC = join(ROOT, "public");
const fixture = (f: string) => readFileSync(join(ROOT, "tests/fixtures/encode", f), "utf8");
const regionsOf = (text: string): Interval[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .map(([chrom, a, b]) => ({ chrom, start: +a, end: +b }))
    .sort((x, y) => (x.chrom < y.chrom ? -1 : x.chrom > y.chrom ? 1 : x.start - y.start));
const HEART = fixture("heart_h3k27ac_ENCFF059ERB.subsample.bed");
const LIVER = fixture("liver_h3k27ac_ENCFF805YRQ.subsample.bed");
const groups: GoGroup[] = [
  { mask: 1, label: "Heart", regions: regionsOf(HEART), scoreSource: HEART },
  { mask: 2, label: "Liver", regions: regionsOf(LIVER), scoreSource: LIVER },
];
const allSubsets = groups.map((g) => ({ mask: g.mask, regions: g.regions }));

function runtime() {
  const loaded: string[] = [];
  const rt: Runtime = { bedtools: memoryBedtools(), refdata: { text: async (p) => (loaded.push(p), readFileSync(join(PUBLIC, p), "utf8")) }, scanMotifs: scanMotifsInline };
  return { rt, loaded };
}
const go = JSON.parse(readFileSync(join(PUBLIC, "refdata/hg38/go/go.json"), "utf8")) as GoData;
const sizes = parseChromSizes(readFileSync(join(PUBLIC, "refdata/hg38/hg38.chrom.sizes"), "utf8"));
const gaps = readFileSync(join(PUBLIC, "refdata/hg38/go/gaps.bed"), "utf8");

describe("peaksWithScores", () => {
  it("gives each region the score (column 5) of its line in the set's file, duplicates in file order", () => {
    const text = "chr1\t10\t20\tp1\t58\nchr1\t10\t20\tp2\t7\nchr2\t5\t9\tp3\t3\n";
    const out = peaksWithScores([{ chrom: "chr1", start: 10, end: 20 }, { chrom: "chr1", start: 10, end: 20 }, { chrom: "chr2", start: 5, end: 9 }, { chrom: "chr3", start: 1, end: 2 }], text);
    expect(out.map((p) => p.score)).toEqual([58, 7, 3, undefined]);
  });
  it("leaves every region unscored when any line has no numeric score (BED3, or a non-numeric column 5)", () => {
    const r = [{ chrom: "chr1", start: 10, end: 20 }];
    expect(peaksWithScores(r, "chr1\t10\t20\n")).toEqual(r);
    expect(peaksWithScores(r, "chr1\t10\t20\tp\t58\nchr1\t30\t40\tq\t.\n")).toEqual(r);
    expect(peaksWithScores(r, undefined)).toEqual(r);
  });
  it("reads the real narrowPeak scores of an ENCODE fixture", () => {
    const peaks = peaksWithScores(groups[0].regions, HEART);
    expect(peaks.every((p) => typeof p.score === "number")).toBe(true);
  });
});

describe("runGoEnrichment, GREAT-like", () => {
  it("vs. genome: one row per greatTest term, enriched first by q, with the TSV columns of the download; GO data read once", async () => {
    const { rt, loaded } = runtime();
    const settings = { ...GREAT_RUN_DEFAULTS, background: "genome" as const };
    const progress: string[] = [];
    const run = await runGoEnrichment(rt, { method: "great", ns: "BP", assembly: "hg38", groups, allSubsets, great: settings, cgo: CISTROMEGO_DEFAULTS }, { onProgress: (p) => progress.push(p.label) });
    expect(run.tsvHead).toEqual(["subset", "go_id", "term", "regions_hit", "regions", "genome_fraction", "binom_fold", "binom_p", "binom_q", "genes_hit", "genes_selected", "term_genes", "genes", "hyper_fold", "hyper_p", "hyper_q", "significant"]);
    const prepared = prepareGreat(go, sizes, gaps, settings);
    const raw = greatTest(prepared, assignRegions(groups[0].regions, prepared), "BP", settings);
    const heart = run.groups[0];
    expect(heart.rows).toHaveLength(raw.length);
    const byId = new Map(raw.map((r) => [r.id, r]));
    for (const row of heart.rows) {
      const r = byId.get(row.id)!;
      expect(row.tsv).toEqual([r.id, r.name, r.k, r.n, r.fraction, r.binomFold, r.binomP, r.binomQ, r.j, r.m, r.K, r.N, r.hyperFold, r.hyperP, r.hyperQ, r.significant ? "yes" : "no"]);
      expect([row.q, row.fold, row.significant]).toEqual([r.binomQ, r.binomFold, r.significant]);
    }
    const cmp = (x: { fold: number; q: number }, y: { fold: number; q: number }) => Number(y.fold > 1) - Number(x.fold > 1) || x.q - y.q;
    heart.rows.slice(1).forEach((row, i) => expect(cmp(heart.rows[i], row)).toBeLessThanOrEqual(0));
    expect(heart.summary).toMatch(/^\d+ significant terms? \(binomial and hypergeometric q < 0\.05, fold ≥ 2\) · 2,000 regions · domains /);
    expect(progress).toHaveLength(groups.length);

    const tsv = goTsv(run).trimEnd().split("\n");
    expect(tsv[0]).toBe(run.tsvHead.join("\t"));
    expect(tsv).toHaveLength(1 + run.groups[0].rows.length + run.groups[1].rows.length);
    expect(tsv[1].startsWith("Heart\tGO:")).toBe(true);
    expect(goTsv(run, 2).split("\n")[1].startsWith("Liver\t")).toBe(true);

    await runGoEnrichment(rt, { method: "great", ns: "MF", assembly: "hg38", groups, allSubsets, great: settings, cgo: CISTROMEGO_DEFAULTS });
    expect(loaded.sort()).toEqual(["refdata/hg38/go/gaps.bed", "refdata/hg38/go/go.json", "refdata/hg38/hg38.chrom.sizes"]);
  });

  it("vs. the input sets: one row per inputsGoTest term, significant when q < threshold and enriched", async () => {
    const { rt } = runtime();
    const settings = { ...GREAT_RUN_DEFAULTS, background: "inputs" as const };
    const run = await runGoEnrichment(rt, { method: "great", ns: "BP", assembly: "hg38", groups, allSubsets, great: settings, cgo: CISTROMEGO_DEFAULTS });
    expect(run.tsvHead).toEqual(["subset", "go_id", "term", "term_genes", "subset_hit", "subset_no_hit", "rest_hit", "rest_no_hit", "odds_ratio", "p", "q", "significant"]);
    const prepared = prepareGreat(go, sizes, gaps, settings);
    const owner = Int32Array.from(allSubsets.flatMap((s) => s.regions.map(() => s.mask)));
    const raw = inputsGoTest(prepared, assignRegions(allSubsets.flatMap((s) => s.regions), prepared), owner, 2, "BP", settings);
    const byId = new Map(raw.map((r) => [r.id, r]));
    const liver = run.groups[1];
    expect(liver.rows).toHaveLength(raw.length);
    for (const row of liver.rows) {
      const r = byId.get(row.id)!;
      const significant = r.q < settings.qThreshold && r.oddsRatio > 1;
      expect(row.tsv).toEqual([r.id, r.name, r.K, ...r.table, r.oddsRatio, r.p, r.q, significant ? "yes" : "no"]);
      expect(row.significant).toBe(significant);
    }
    expect(liver.summary).toMatch(/· 2,000 subset regions vs 2,000 others · domains /);
  });
});

describe("runGoEnrichment, Cistrome-GO-like", () => {
  it("one row per XL-mHG term, by q, with the leading genes; the gene model read once", async () => {
    const { rt, loaded } = runtime();
    const one = [groups[0]];
    const run = await runGoEnrichment(rt, { method: "cistromego", ns: "MF", assembly: "hg38", groups: one, allSubsets, great: GREAT_RUN_DEFAULTS, cgo: CISTROMEGO_DEFAULTS });
    const model = JSON.parse(readFileSync(join(PUBLIC, "refdata/hg38/cistromego/rp_model.json"), "utf8")) as RpModel;
    const raw = await cistromeGoTestAsync(prepareCistromeGo(model, go), peaksWithScores(one[0].regions, HEART), "MF", CISTROMEGO_DEFAULTS);
    const rows = run.groups[0].rows;
    expect(rows.map((r) => r.id).sort()).toEqual(raw.rows.map((r) => r.id).sort());
    // By q (ties by fold, which is NaN for terms with no genes above the cutoff, so only q is checked).
    rows.slice(1).forEach((r, i) => expect(rows[i].q).toBeLessThanOrEqual(r.q));
    const first = raw.rows.find((r) => r.id === rows[0].id)!;
    expect(rows[0].genes).toEqual(first.leadGenes);
    expect(rows[0].tsv.at(-1)).toBe(first.leadGenes.join(","));
    expect(run.groups[0].summary).toMatch(/· top [\d,]+ peaks by score ·/);
    expect(loaded.filter((p) => p.endsWith("rp_model.json"))).toEqual(["refdata/hg38/cistromego/rp_model.json"]);
  });
});
