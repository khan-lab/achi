import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openBigWig } from "./bigwigSource";
import { computeSignalMatrix, type ProfileParams } from "./signalMatrix";
import { runSignalProfiles, sampleRegions, signalClustersBed, signalMatrixTsv, signalRegionMeansTsv, signalStatsTsv, type SignalTrack } from "./signalRun";
import { mannWhitneyU } from "./stats";

/**
 * Signal profiles as every layer runs them. Real data: ENCODE K562 H3K27ac
 * signal on chr21 (tests/fixtures/deeptools, the matrices checked against
 * deepTools in signalMatrix.test.ts), over K562 super-enhancers and chr21
 * TSSs as two groups.
 */
const DT = (f: string) => join(__dirname, "..", "..", "..", "tests/fixtures/deeptools", f);
const bed = (f: string) =>
  readFileSync(DT(f), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("\t"))
    .map((c) => ({ chrom: c[0], start: Number(c[1]), end: Number(c[2]) }));
const SE = bed("k562_chr21_super_enhancers.bed");
const TSS = bed("chr21_tss.bed");
const file = () => new Blob([new Uint8Array(readFileSync(DT("k562_h3k27ac_ENCFF381NDD.chr21_windows.bw")))]);
const track = (): SignalTrack => ({ id: "k562", name: "K562 H3K27ac", how: "file on this computer", open: () => openBigWig(file()) });
const params: ProfileParams = { mode: "scale", referencePoint: "center", upstream: 2000, downstream: 2000, body: 5000, binSize: 200, missingAsZero: false };
const groups = [
  { mask: 1, label: "Super-enhancers", regions: SE },
  { mask: 2, label: "TSS", regions: TSS },
];
const disjoint = [
  [false, false],
  [false, false],
];

describe("sampleRegions", () => {
  it("keeps everything under the cap; above it, a fixed sample in the original order", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(sampleRegions(items, 100)).toEqual({ items, sampledFrom: null });
    const s = sampleRegions(items, 10);
    expect(s.sampledFrom).toBe(50);
    expect(s.items).toHaveLength(10);
    expect([...s.items].sort((a, b) => a - b)).toEqual(s.items);
    expect(sampleRegions(items, 10).items).toEqual(s.items); // deterministic
  });
});

describe("runSignalProfiles", () => {
  it("computes each track's matrix over every group's regions, with region means, and tests the groups' means", async () => {
    const labels: string[] = [];
    const run = await runSignalProfiles({ assembly: "hg38", params, sort: "desc", k: 1, groups, overlaps: disjoint, tracks: [track()], cap: 20_000 }, { onProgress: (p) => labels.push(p.label) });
    const regions = [...SE.map((r) => ({ ...r, group: 0 })), ...TSS.map((r) => ({ ...r, group: 1 }))];
    expect(run.regions).toEqual(regions);
    expect(run.sampledFrom).toBeNull();
    const src = await openBigWig(file());
    const direct = await computeSignalMatrix(regions, src.read, params, { withRegionMeans: true });
    expect(Array.from(run.matrices[0].values)).toEqual(Array.from(direct.values));
    expect(Array.from(run.matrices[0].regionMeans!)).toEqual(Array.from(direct.regionMeans!));
    expect(labels).toContain("Reading K562 H3K27ac");

    // Rows by group, highest mean first within each.
    expect(run.order.slice(0, SE.length).every((i) => i < SE.length)).toBe(true);
    expect(run.clusters).toBeNull();

    const means = direct.regionMeans!;
    const mw = mannWhitneyU(Array.from(means.slice(0, SE.length)), Array.from(means.slice(SE.length)));
    expect(run.stats).toHaveLength(1);
    expect(run.stats[0]).toMatchObject({ ti: 0, track: "K562 H3K27ac", a: 0, b: 1, U: mw.U, p: mw.p, q: mw.p, nA: mw.n1, nB: mw.n2 });
  });

  it("skips the test for groups that share regions, and clusters the rows with k > 1", async () => {
    const run = await runSignalProfiles({ assembly: "hg38", params, sort: "keep", k: 2, groups, overlaps: [[false, true], [true, false]], tracks: [track()], cap: 20_000 });
    expect(run.stats[0]).toMatchObject({ untested: "overlap" });
    expect(run.stats[0].p).toBeNaN();
    expect(run.clusters).toHaveLength(SE.length + TSS.length);
    expect(new Set(run.clusters).size).toBe(2);
    expect(signalClustersBed(run).trimEnd().split("\n")).toHaveLength(SE.length + TSS.length);
  });

  it("refuses a track with none of the regions' chromosomes", async () => {
    const elsewhere = [{ mask: 1, label: "chr1", regions: [{ chrom: "chr1", start: 1_000_000, end: 1_001_000 }] }];
    await expect(runSignalProfiles({ assembly: "hg38", params, sort: "desc", k: 1, groups: elsewhere, overlaps: [[false]], tracks: [track()], cap: 20_000 })).rejects.toThrow(/K562 H3K27ac has none of the subsets' chromosomes \(it names chr21.*Is it for hg38\?/);
  });

  it("writes the downloads: matrix, region means, tests", async () => {
    const run = await runSignalProfiles({ assembly: "hg38", params, sort: "desc", k: 1, groups, overlaps: disjoint, tracks: [track()], cap: 20_000 });
    const m = signalMatrixTsv(run, 0).trimEnd().split("\n");
    expect(m[0]).toBe("# K562 H3K27ac; scale-regions, upstream 2000, body 5000, downstream 2000, bin 200 bp");
    expect(m[1].split("\t").slice(0, 5)).toEqual(["chrom", "start", "end", "subset", "bin_1"]);
    expect(m).toHaveLength(2 + SE.length + TSS.length);
    expect(signalRegionMeansTsv(run).split("\n")[0]).toBe("chrom\tstart\tend\tsubset\tmean_K562 H3K27ac");
    const st = signalStatsTsv(run).trimEnd().split("\n");
    expect(st[0]).toBe("track\tsubset_a\tsubset_b\tn_a\tn_b\tmedian_a\tmedian_b\tU\tp\tq\ttest");
    expect(st[1]).toMatch(/^K562 H3K27ac\tSuper-enhancers\tTSS\t\d+\t\d+\t.*\tMann-Whitney U, two-sided, normal approximation$/);
  });
});
