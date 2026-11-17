import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  binWindows,
  computeSignalMatrix,
  kmeansRows,
  meanOverBins,
  profileStats,
  regionMeans,
  rowOrder,
  validateProfileParams,
  type ProfileParams,
  type ProfileRegion,
  type SignalInterval,
} from "./signalMatrix";
import { openBigWig } from "./bigwigSource";

/**
 * Signal profiles over regions, as deepTools computeMatrix does them. Parity
 * against deepTools 4.0.0 itself on real data (tests/fixtures/deeptools,
 * PROVENANCE.md): ENCODE K562 H3K27ac fold change on chr21, the example K562
 * super-enhancers there (scale-regions) and 30 GENCODE TSSs on both strands
 * (reference-point).
 */
const ROOT = join(__dirname, "..", "..");
const DT = (f: string) => join(ROOT, "tests/fixtures/deeptools", f);
const bed = (f: string): ProfileRegion[] =>
  readFileSync(DT(f), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("\t"))
    .map((c) => ({ chrom: c[0], start: Number(c[1]), end: Number(c[2]), name: c[3], strand: (c[5] as "+" | "-" | ".") ?? "." }));
const deeptoolsTab = (f: string): number[][] =>
  readFileSync(DT(f), "utf8")
    .trim()
    .split("\n")
    .slice(3)
    .map((l) => l.split("\t").map((v) => (v === "nan" ? NaN : Number(v))));
const bigwig = () =>
  openBigWig(new File([new Uint8Array(readFileSync(DT("k562_h3k27ac_ENCFF381NDD.chr21_windows.bw")))], "k562.bw"));

const SE = bed("k562_chr21_super_enhancers.bed");
const TSS = bed("chr21_tss.bed");
const base: ProfileParams = { mode: "scale", referencePoint: "center", upstream: 10000, downstream: 10000, body: 5000, binSize: 200, missingAsZero: false };

function expectMatrix(values: Float32Array, nBins: number, expected: number[][]) {
  expect(values.length).toBe(expected.length * nBins);
  let worst = 0;
  expected.forEach((row, r) => {
    expect(row.length).toBe(nBins);
    row.forEach((v, b) => {
      const got = values[r * nBins + b];
      if (Number.isNaN(v)) expect(got).toBeNaN();
      else worst = Math.max(worst, Math.abs(got - v));
    });
  });
  // deepTools prints 6 decimals; values are stored as float32.
  expect(worst).toBeLessThan(2e-5);
}

describe("computeSignalMatrix matches deepTools computeMatrix on real data", () => {
  it("scale-regions: 5 kb body, 10 kb flanks, 200 bp bins (125 bins)", async () => {
    const m = await computeSignalMatrix(SE, (await bigwig()).read, base);
    expect(m.nBins).toBe(125);
    expectMatrix(m.values, m.nBins, deeptoolsTab("scale_se.tab"));
  });

  it("scale-regions with missing data as zero", async () => {
    const m = await computeSignalMatrix(SE, (await bigwig()).read, { ...base, missingAsZero: true });
    expectMatrix(m.values, m.nBins, deeptoolsTab("scale_se_zero.tab"));
  });

  it("reference-point at the 5' end, strand-aware (TSS), ±3 kb in 50 bp bins", async () => {
    expect(TSS.some((r) => r.strand === "-") && TSS.some((r) => r.strand === "+")).toBe(true);
    const m = await computeSignalMatrix(TSS, (await bigwig()).read, { ...base, mode: "reference", referencePoint: "start", upstream: 3000, downstream: 3000, binSize: 50 });
    expect(m.nBins).toBe(120);
    expectMatrix(m.values, m.nBins, deeptoolsTab("refpoint_tss.tab"));
  });

  it("reference-point at the centre, ±10 kb in 500 bp bins", async () => {
    const m = await computeSignalMatrix(SE, (await bigwig()).read, { ...base, mode: "reference", referencePoint: "center", binSize: 500 });
    expectMatrix(m.values, m.nBins, deeptoolsTab("refpoint_se_center.tab"));
  });

  it("also gives each region's own mean signal in the same pass, as regionMeans", async () => {
    const src = await bigwig();
    // ±2 kb around the centre does not cover a 25 kb super-enhancer: the region is read in full.
    const m = await computeSignalMatrix(SE, src.read, { ...base, mode: "reference", upstream: 2000, downstream: 2000, binSize: 100 }, { withRegionMeans: true });
    const direct = await regionMeans(SE, src.read);
    expect(m.regionMeans).toHaveLength(SE.length);
    m.regionMeans!.forEach((v, i) => expect(v).toBeCloseTo(direct[i], 9));
  });

  it("reports progress and stops when aborted", async () => {
    const seen: number[] = [];
    const m = await computeSignalMatrix(SE.slice(0, 3), (await bigwig()).read, base, { onProgress: (d) => seen.push(d) });
    expect(m.nRows).toBe(3);
    expect(seen.at(-1)).toBe(3);
    const ac = new AbortController();
    ac.abort();
    await expect(computeSignalMatrix(SE, (await bigwig()).read, base, { signal: ac.signal })).rejects.toThrow(/abort/i);
  });
});

describe("binWindows", () => {
  const p: ProfileParams = { ...base, mode: "reference", referencePoint: "start", upstream: 300, downstream: 100, binSize: 100 };
  it("puts upstream on the 5' side: left on +, right on − (output always runs 5' to 3')", () => {
    expect(binWindows({ chrom: "c", start: 1000, end: 2000, strand: "+" }, p)).toEqual([
      [700, 800],
      [800, 900],
      [900, 1000],
      [1000, 1100],
    ]);
    // On −, the 5' end is `end`; upstream lies to its right.
    expect(binWindows({ chrom: "c", start: 1000, end: 2000, strand: "-" }, p)).toEqual([
      [2200, 2300],
      [2100, 2200],
      [2000, 2100],
      [1900, 2000],
    ]);
  });
  it("treats unstranded regions as +, and 'end' as the 3' end", () => {
    expect(binWindows({ chrom: "c", start: 1000, end: 2000 }, { ...p, referencePoint: "end" })[3]).toEqual([2000, 2100]);
    expect(binWindows({ chrom: "c", start: 1000, end: 2000, strand: "-" }, { ...p, referencePoint: "end" })[0]).toEqual([1200, 1300]);
  });
  it("splits the body at start + floor(k·L/n) in scale-regions mode", () => {
    const w = binWindows({ chrom: "c", start: 0, end: 10 }, { ...base, upstream: 0, downstream: 0, body: 300, binSize: 100 });
    expect(w).toEqual([
      [0, 3],
      [3, 6],
      [6, 10],
    ]);
  });
});

describe("meanOverBins", () => {
  const iv: SignalInterval[] = [
    { start: 0, end: 10, score: 1 },
    { start: 10, end: 20, score: 3 },
    { start: 30, end: 40, score: 5 },
  ];
  it("averages over the bases with data, NaN where none, 0 when asked", () => {
    const out = meanOverBins(iv, [
      [5, 15],
      [15, 35],
      [20, 30],
      [-10, 0],
    ]);
    expect(out[0]).toBe(2);
    expect(out[1]).toBeCloseTo((3 * 5 + 5 * 5) / 10);
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeNaN();
    expect(meanOverBins(iv, [[20, 30]], true)[0]).toBe(0);
  });
});

describe("validateProfileParams", () => {
  it("accepts flanks and body that are multiples of the bin size, and refuses the rest", () => {
    expect(validateProfileParams(base)).toBeNull();
    expect(validateProfileParams({ ...base, upstream: 150 })).toMatch(/multiple of the bin size/);
    expect(validateProfileParams({ ...base, body: 5100 })).toMatch(/multiple of the bin size/);
    expect(validateProfileParams({ ...base, binSize: 0 })).toMatch(/bin size/);
    expect(validateProfileParams({ ...base, upstream: 1_000_000, binSize: 10 })).toMatch(/bins/);
  });
});

describe("summaries", () => {
  // 3 rows x 2 bins
  const v = Float32Array.from([1, 2, 3, NaN, 5, 6]);
  it("profileStats: mean and standard error per bin, skipping NaN", () => {
    const s = profileStats(v, 2, [0, 1, 2]);
    expect(Array.from(s.mean)).toEqual([3, 4]);
    expect(Array.from(s.n)).toEqual([3, 2]);
    expect(s.se[0]).toBeCloseTo(2 / Math.sqrt(3)); // sd 2
    expect(s.se[1]).toBeCloseTo(2); // values 2 and 6: sd √8, n 2
  });
  it("rowOrder: by row mean, highest first, rows without data last", () => {
    const w = Float32Array.from([1, 1, NaN, NaN, 9, 9, 4, 4]);
    expect(rowOrder(w, 2, [0, 1, 2, 3], "desc")).toEqual([2, 3, 0, 1]);
    expect(rowOrder(w, 2, [0, 1, 2, 3], "asc")).toEqual([0, 3, 2, 1]);
    expect(rowOrder(w, 2, [3, 0], "keep")).toEqual([3, 0]);
  });
  it("kmeansRows: the same clusters for the same seed, and separates clear groups", () => {
    const rows = [0, 0.1, 0.2, 10, 10.1, 10.2].flatMap((x) => [x, x]);
    const w = Float32Array.from(rows);
    const a = kmeansRows(w, 2, [0, 1, 2, 3, 4, 5], 2, 7);
    const b = kmeansRows(w, 2, [0, 1, 2, 3, 4, 5], 2, 7);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(new Set(Array.from(a.slice(0, 3))).size).toBe(1);
    expect(new Set(Array.from(a.slice(3))).size).toBe(1);
    expect(a[0]).not.toBe(a[3]);
    // cluster 0 is the one with the highest mean signal
    expect(a[3]).toBe(0);
    expect(Array.from(kmeansRows(w, 2, [0, 1], 5, 1)).length).toBe(2);
  });
});

describe("regionMeans", () => {
  it("is the mean over each region's bases with data, as pyBigWig stats(exact=True)", async () => {
    const exp = JSON.parse(readFileSync(DT("expected_summary.json"), "utf8"));
    const src = await bigwig();
    const se = await regionMeans(SE, src.read);
    se.forEach((v, i) => expect(v).toBeCloseTo(exp.se_means[i], 5));
    const tss = await regionMeans(
      exp.tss_regions.map(([s, e]: [number, number]) => ({ chrom: "chr21", start: s, end: e })),
      src.read
    );
    tss.forEach((v, i) => expect(v).toBeCloseTo(exp.tss_means[i], 5));
  });
});
