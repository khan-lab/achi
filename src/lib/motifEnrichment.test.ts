import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CPG_STRATA, GC_STRATA, compositionStrata, cpgRatio, gcPerMille, gcStrata, motifEnrichment, scanPlan } from "./motifEnrichment";
import { backgroundOf, encodeSequence, hasHit, integerMatrix, logOddsMatrix, thresholdForP, type Background } from "./pwm";
import { benjaminiHochberg, mantelHaenszel } from "./stats";

/**
 * Motif enrichment: for each selected group and motif, the share of the
 * group's regions with at least one site, against the other regions of the
 * analysis, by a Cochran–Mantel–Haenszel test over GC-content strata.
 * Real data: hg38 sequence around example super-enhancers (150 K562, 150
 * HepG2; tests/fixtures/motifs) and JASPAR 2026 matrices.
 */
const DIR = join(__dirname, "..", "..", "tests", "fixtures", "motifs");
const expected: { background: Background; p: number; motifs: { id: string; name: string; pfm: number[][] }[] } = JSON.parse(readFileSync(join(DIR, "expected_moods.json"), "utf8"));
const codes = readFileSync(join(DIR, "sequences.fa"), "utf8")
  .split(">")
  .filter(Boolean)
  .map((b) => encodeSequence(b.split("\n").slice(1).join("").trim()));
// The first 150 are K562 regions (owner 1), the rest HepG2 (owner 2).
const owner = Int32Array.from(codes.map((_, i) => (i < 150 ? 1 : 2)));
const bg = backgroundOf(codes);
const hitsOf = (name: string) => {
  const m = expected.motifs.find((x) => x.name === name)!;
  const im = integerMatrix(logOddsMatrix(m.pfm, bg));
  const t = thresholdForP(im, bg, 1e-4);
  return Uint8Array.from(codes.map((c) => (hasHit(c, im, t) ? 1 : 0)));
};

describe("gcPerMille and gcStrata", () => {
  it("is G+C over A+C+G+T in thousandths, -1 without bases; strata are GC quintiles", () => {
    expect(gcPerMille(encodeSequence("GGCCAATTNN"))).toBe(500);
    expect(gcPerMille(encodeSequence("GGGA"))).toBe(750);
    expect(gcPerMille(encodeSequence("NNN"))).toBe(-1);
    const gc = Int32Array.from(codes.map(gcPerMille));
    const s = gcStrata(gc);
    expect(Math.max(...s) + 1).toBe(GC_STRATA);
    const counts = Array.from({ length: GC_STRATA }, (_, k) => s.filter((x) => x === k).length);
    counts.forEach((n) => expect(n).toBeGreaterThan(40)); // 300 sequences in roughly equal fifths
  });
});

describe("cpgRatio and compositionStrata", () => {
  it("is observed / expected CpG (CG count × length / (C count × G count)), NaN without C or G", () => {
    // CGCG: 2 CpG, 2 C, 2 G, 4 bases -> 2 * 4 / (2 * 2) = 2
    expect(cpgRatio(encodeSequence("CGCG"))).toBeCloseTo(2, 12);
    expect(cpgRatio(encodeSequence("CCGGAATT"))).toBeCloseTo((1 * 8) / (2 * 2), 12);
    expect(Number.isNaN(cpgRatio(encodeSequence("AATT")))).toBe(true);
    // N breaks a dinucleotide and is not counted.
    expect(cpgRatio(encodeSequence("CNG"))).toBe(0);
  });
  it("crosses GC quintiles with CpG tertiles (15 strata), windows without C or G in the lowest CpG tertile", () => {
    const gc = Int32Array.from(codes.map(gcPerMille));
    const cpg = Float64Array.from(codes.map(cpgRatio));
    const s = compositionStrata(gc, cpg);
    expect(Math.max(...s) + 1).toBeLessThanOrEqual(GC_STRATA * CPG_STRATA);
    const g = gcStrata(gc);
    s.forEach((x, i) => expect(Math.floor(x / CPG_STRATA)).toBe(g[i]));
    expect(new Set(s).size).toBeGreaterThan(10);
  });
});

describe("motifEnrichment", () => {
  const names = ["GATA2", "GATA1", "HNF4A", "FOXA2", "HNF1A", "CTCF"];
  const hits = names.map(hitsOf);
  const strata = gcStrata(Int32Array.from(codes.map(gcPerMille)));
  const pool = new Uint8Array(codes.length).fill(1);
  const valid = new Uint8Array(codes.length).fill(1);
  const cells = motifEnrichment({ owner, pool, valid, strata, hits, keys: [1, 2] });

  it("tests every group against every motif, with the CMH test over GC strata and BH over all of them", () => {
    expect(cells).toHaveLength(2 * names.length);
    for (const c of cells) {
      const inG = (i: number) => owner[i] === c.key;
      const per: [number, number, number, number][] = Array.from({ length: GC_STRATA }, () => [0, 0, 0, 0]);
      codes.forEach((_, i) => per[strata[i]][(inG(i) ? 0 : 2) + (hits[c.motif][i] ? 0 : 1)]++);
      const mh = mantelHaenszel(per);
      expect(c.p).toBeCloseTo(mh.p, 12);
      expect(c.oddsRatio).toBeCloseTo(mh.oddsRatio, 12);
      expect(c.table).toEqual(per.reduce((t, x) => t.map((v, k) => v + x[k]) as [number, number, number, number], [0, 0, 0, 0]));
    }
    const q = benjaminiHochberg(cells.map((c) => c.p));
    cells.forEach((c, i) => expect(c.q).toBeCloseTo(q[i], 12));
  });

  it("reports a motif with no site on either side as untestable (odds ratio NaN, p 1), not as depleted", () => {
    const none = motifEnrichment({ owner, pool, valid, strata, hits: [new Uint8Array(codes.length)], keys: [1] })[0];
    expect(none.table).toEqual([0, 150, 0, 150]);
    expect(Number.isNaN(none.oddsRatio)).toBe(true);
    expect(none.p).toBe(1);
  });

  it("counts a whole set (negative key) as every subset it is a member of, and only sampled regions as the rest", () => {
    // Owners: 1 (A only), 3 (A ∩ B), 2 (B only). Set A = key -1. Region 5 is outside the background sample.
    const own = Int32Array.from([1, 3, 3, 2, 2, 2]);
    const h = [Uint8Array.from([1, 1, 0, 1, 0, 1])];
    const pl = Uint8Array.from([1, 1, 1, 1, 1, 0]);
    const one = new Uint8Array(6);
    const [setA] = motifEnrichment({ owner: own, pool: pl, valid: new Uint8Array(6).fill(1), strata: one, hits: h, keys: [-1] });
    expect(setA.table).toEqual([2, 1, 1, 1]);
    // Regions without sequence (all N) are left out.
    const [noN] = motifEnrichment({ owner: own, pool: pl, valid: Uint8Array.from([1, 1, 1, 1, 0, 1]), strata: one, hits: h, keys: [-1] });
    expect(noN.table).toEqual([2, 1, 1, 0]);
  });
});

describe("scanPlan", () => {
  const universe = Int32Array.from([...Array(30_000).fill(1), ...Array(10_000).fill(2), ...Array(500).fill(4)]);
  it("scans everything when the analysis is small", () => {
    const p = scanPlan(Int32Array.from([1, 2, 2, 4]), [4], { maxPool: 10, maxGroup: 10 });
    expect(Array.from(p.scan)).toEqual([0, 1, 2, 3]);
    expect(Array.from(p.pool)).toEqual([1, 1, 1, 1]);
  });
  it("otherwise samples the background evenly and keeps each selected group (up to a cap), the same every time", () => {
    const p = scanPlan(universe, [4, -1], { maxPool: 4_000, maxGroup: 2_000, seed: 7 });
    const inPool = Array.from(p.scan).filter((_, k) => p.pool[k]);
    expect(inPool.length).toBe(4_000);
    // The pool is a uniform sample: about 30k/40.5k of it is owner 1.
    const share = inPool.filter((i) => universe[i] === 1).length / inPool.length;
    expect(share).toBeGreaterThan(0.7);
    expect(share).toBeLessThan(0.78);
    // Owner 4 (500 regions) is selected: all of it is scanned. Set -1 (owner 1, 30,000) is capped at 2,000 plus what the pool holds.
    expect(Array.from(p.scan).filter((i) => universe[i] === 4).length).toBe(500);
    expect(Array.from(p.scan).filter((i) => universe[i] === 1).length).toBeLessThanOrEqual(2_000 + 4_000);
    expect(scanPlan(universe, [4, -1], { maxPool: 4_000, maxGroup: 2_000, seed: 7 })).toEqual(p);
    expect(Array.from(p.scan)).toEqual([...p.scan].sort((a, b) => a - b));
  });
});
