import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PSEUDOCOUNT, SCALE, backgroundOf, encodeSequence, hasHit, hitPositions, integerMatrix, logOddsMatrix, packSequences, scanPacked, tailProbability, thresholdForP, type Background } from "./pwm";

/**
 * Position weight matrices and scanning for motif enrichment. Checked
 * against MOODS 1.9.4 (Korhonen et al., 2017; used only to make the
 * fixture, never shipped) on real data: JASPAR 2026 CORE vertebrate
 * matrices and hg38 sequence (±100 bp around the centres of example
 * super-enhancers), see tests/fixtures/motifs/PROVENANCE.md.
 */
const DIR = join(__dirname, "..", "..", "..", "tests", "fixtures", "motifs");
interface Expected {
  pseudocount: number;
  p: number;
  background: Background;
  motifs: { id: string; name: string; pfm: number[][]; logOdds: number[][]; threshold: number; hits: [number, number, number][] }[];
}
const expected: Expected = JSON.parse(readFileSync(join(DIR, "expected_moods.json"), "utf8"));
const seqs = readFileSync(join(DIR, "sequences.fa"), "utf8")
  .split(">")
  .filter(Boolean)
  .map((block) => block.split("\n").slice(1).join("").trim());
const codes = seqs.map(encodeSequence);

describe("encodeSequence and backgroundOf", () => {
  it("codes A C G T as 0-3 (either case) and anything else as 4", () => {
    expect(Array.from(encodeSequence("ACGTacgtNn-R"))).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 4, 4, 4, 4]);
  });
  it("is the strand-symmetric base composition of the sequences, as in the fixture", () => {
    const bg = backgroundOf(codes);
    bg.forEach((x, i) => expect(x).toBeCloseTo(expected.background[i], 9));
    expect(bg[0]).toBeCloseTo(bg[3], 12);
    expect(bg[1]).toBeCloseTo(bg[2], 12);
  });
});

describe("logOddsMatrix", () => {
  it("matches MOODS log_odds (natural log, pseudocount spread by the background) for every fixture motif", () => {
    expect(PSEUDOCOUNT).toBe(expected.pseudocount);
    for (const m of expected.motifs) {
      const lo = logOddsMatrix(m.pfm, expected.background);
      lo.forEach((col, j) => col.forEach((v, b) => expect(v).toBeCloseTo(m.logOdds[j][b], 9)));
    }
  });
});

describe("thresholdForP", () => {
  it("is exact for the integer matrix: brute force over every sequence of a short motif agrees", () => {
    const m = expected.motifs.find((x) => x.pfm.length <= 8)!;
    const im = integerMatrix(logOddsMatrix(m.pfm, expected.background));
    const L = im.length;
    const bg = expected.background;
    // P(S >= t) for every t, by enumeration.
    const tail = new Map<number, number>();
    for (let n = 0; n < 4 ** L; n++) {
      let s = 0;
      let pr = 1;
      for (let j = 0, x = n; j < L; j++, x >>= 2) {
        s += im.fwd[j * 4 + (x & 3)];
        pr *= bg[x & 3];
      }
      tail.set(s, (tail.get(s) ?? 0) + pr);
    }
    const scores = [...tail.keys()].sort((a, b) => b - a);
    const pAtLeast = (t: number) => scores.filter((s) => s >= t).reduce((a, s) => a + tail.get(s)!, 0);
    for (const p of [1e-2, 1e-3, 1e-4]) {
      const t = thresholdForP(im, bg, p);
      expect(pAtLeast(t)).toBeLessThanOrEqual(p * (1 + 1e-9));
      expect(pAtLeast(t - 1)).toBeGreaterThan(p);
    }
  });
  it("agrees with MOODS threshold_from_p, except where MOODS lets through more than p (short motifs: coarse score steps)", () => {
    let close = 0;
    for (const m of expected.motifs) {
      const im = integerMatrix(logOddsMatrix(m.pfm, expected.background));
      const t = thresholdForP(im, expected.background, expected.p);
      if (Math.abs(t / SCALE - m.threshold) < 0.01 * m.pfm.length + 0.02) close++;
      // Where they differ, ours is the one that keeps P(S >= t) <= p; MOODS's own threshold exceeds it.
      else expect(tailProbability(im, expected.background, Math.ceil(m.threshold * SCALE - 1e-9))).toBeGreaterThan(1.5 * expected.p);
      expect(tailProbability(im, expected.background, t)).toBeLessThanOrEqual(expected.p * (1 + 1e-9));
    }
    expect(close).toBeGreaterThanOrEqual(expected.motifs.length - 2);
  });
});

describe("scanning", () => {
  it("finds the sites MOODS finds, on both strands, in real sequence; they differ only on ties at the threshold (integer rounding)", () => {
    let agree = 0;
    let ties = 0;
    for (const m of expected.motifs) {
      const lo = logOddsMatrix(m.pfm, expected.background);
      const im = integerMatrix(lo);
      const t = Math.ceil(m.threshold * SCALE - 1e-9);
      const ours = new Set<string>();
      codes.forEach((c, i) => hitPositions(c, im, t).forEach(([pos, strand]) => ours.add(`${i}:${pos}:${strand}`)));
      const theirs = new Set(m.hits.map(([i, pos, strand]) => `${i}:${pos}:${strand}`));
      const floatScore = (k: string) => {
        const [i, pos, strand] = k.split(":").map(Number);
        let x = 0;
        for (let j = 0; j < lo.length; j++) {
          const c = codes[i][pos + j];
          x += strand ? lo[lo.length - 1 - j][3 - c] : lo[j][c];
        }
        return x;
      };
      for (const k of new Set([...ours, ...theirs])) {
        if (ours.has(k) && theirs.has(k)) agree++;
        else {
          // A site only one scanner reports scores at the threshold, within the rounding of L integer scores.
          expect(Math.abs(floatScore(k) - m.threshold)).toBeLessThanOrEqual((0.5 / SCALE) * lo.length + 1e-9);
          ties++;
        }
      }
    }
    expect(agree).toBeGreaterThan(450);
    expect(ties / (agree + ties)).toBeLessThan(0.06);
  });
  it("hasHit is whether a sequence has any site (what the enrichment counts), and skips windows with N", () => {
    for (const m of expected.motifs) {
      const im = integerMatrix(logOddsMatrix(m.pfm, expected.background));
      const t = thresholdForP(im, expected.background, expected.p);
      codes.forEach((c) => expect(hasHit(c, im, t)).toBe(hitPositions(c, im, t).length > 0));
    }
    const m = expected.motifs[0];
    const im = integerMatrix(logOddsMatrix(m.pfm, expected.background));
    expect(hasHit(encodeSequence("N".repeat(50)), im, -1e9)).toBe(false);
  });
});

describe("packSequences and scanPacked (what the scanning workers run)", () => {
  it("packs sequences end to end and finds, per sequence, the same answer as hasHit", () => {
    const packed = packSequences(codes);
    expect(packed.offsets.length).toBe(codes.length + 1);
    expect(packed.codes.length).toBe(codes.reduce((a, c) => a + c.length, 0));
    for (const m of expected.motifs.slice(0, 8)) {
      const im = integerMatrix(logOddsMatrix(m.pfm, expected.background));
      const t = thresholdForP(im, expected.background, expected.p);
      expect(Array.from(scanPacked(packed, im, t))).toEqual(codes.map((c) => (hasHit(c, im, t) ? 1 : 0)));
    }
  });
  it("never lets a site span two sequences", () => {
    // Two halves of a perfect site in neighbouring sequences: no hit.
    const m = expected.motifs.find((x) => x.name === "CTCF")!;
    const im = integerMatrix(logOddsMatrix(m.pfm, expected.background));
    const best = m.pfm.map((col) => "ACGT"[col.indexOf(Math.max(...col))]).join("");
    const t = thresholdForP(im, expected.background, expected.p);
    expect(hasHit(encodeSequence(best), im, t)).toBe(true);
    const half = best.length >> 1;
    expect(Array.from(scanPacked(packSequences([encodeSequence(best.slice(0, half)), encodeSequence(best.slice(half))]), im, t))).toEqual([0, 0]);
  });
});
