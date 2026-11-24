import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBed } from "./intervals";
import {
  OverlapIndex,
  PERMUTATION_DEFAULTS,
  allowedSpace,
  countOverlapping,
  hashRegions,
  parseOverlapRule,
  permutationMethods,
  permutationStats,
  permutationTsv,
  randomStream,
  runPermutation,
  shuffleRegions,
} from "./permutation";
import type { Interval } from "./types";
import type { Runtime } from "./runtime";
import { memoryBedtools } from "./testkit";

/**
 * The permutation test of overlap (Pairwise view, CLI --pairwise permutation):
 * A's regions are shuffled within the allowed genome (no assembly gap, no
 * blacklist), B stays fixed, and the number of A regions overlapping B is
 * compared with its distribution over the shuffles. Real ENCODE H3K27ac
 * fixtures (GRCh38) and the hg38 reference files the app ships.
 */
const ROOT = join(__dirname, "../../..");
const FIX = join(ROOT, "tests/fixtures/encode");
const REF = join(ROOT, "public/refdata/hg38");
const files = {
  heart: join(FIX, "heart_h3k27ac_ENCFF059ERB.subsample.bed"),
  liver: join(FIX, "liver_h3k27ac_ENCFF805YRQ.subsample.bed"),
  lung: join(FIX, "lung_h3k27ac_ENCFF314QTE.subsample.bed"),
};
const read = (p: string) => readFileSync(p, "utf8");
const heart = parseBed(read(files.heart));
const liver = parseBed(read(files.liver));
const sizesText = read(join(REF, "hg38.chrom.sizes"));
const gaps = parseBed(read(join(REF, "go/gaps.bed")));
const blacklist = parseBed(read(join(REF, "blacklist/encode_blacklist_v2.bed")));

function hasBedtools(): boolean {
  try {
    execFileSync("bedtools", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

const overlapsAny = (r: Interval, mask: Interval[]) => mask.some((m) => m.chrom === r.chrom && m.start < r.end && r.start < m.end);

describe("parseOverlapRule", () => {
  it("reads the overlap flags the analysis uses, and refuses others", () => {
    expect(parseOverlapRule("")).toEqual({ f: 0, F: 0, r: false, e: false });
    expect(parseOverlapRule("-f 0.5")).toEqual({ f: 0.5, F: 0, r: false, e: false });
    expect(parseOverlapRule("-f 0.5 -r")).toEqual({ f: 0.5, F: 0.5, r: true, e: false });
    expect(parseOverlapRule("-f 0.3 -F 0.6 -e")).toEqual({ f: 0.3, F: 0.6, r: false, e: true });
    expect(parseOverlapRule("-s")).toEqual({ error: expect.stringMatching(/-s/) });
    expect(parseOverlapRule("-f 2")).toEqual({ error: expect.stringMatching(/-f/) });
  });
});

describe("randomStream", () => {
  it("is the same sequence for the same seed and salts on every platform, and differs otherwise", () => {
    const a = randomStream(1, 7, 0);
    const first = [a(), a(), a()];
    const b = randomStream(1, 7, 0);
    expect([b(), b(), b()]).toEqual(first);
    // Pinned: a change here changes every published result for a given seed.
    expect(first).toMatchInlineSnapshot(`
      [
        969872162,
        3555296230,
        4232748400,
      ]
    `);
    const c = randomStream(2, 7, 0);
    expect(c()).not.toBe(first[0]);
    const d = randomStream(1, 7, 1);
    expect(d()).not.toBe(first[0]);
    for (const x of first) expect(Number.isInteger(x) && x >= 0 && x < 2 ** 32).toBe(true);
  });
});

describe("hashRegions", () => {
  it("depends on the regions, not on their order in the file", () => {
    expect(hashRegions([...heart].reverse())).toBe(hashRegions(heart));
    expect(hashRegions(liver)).not.toBe(hashRegions(heart));
  });
});

describe("allowedSpace", () => {
  it("is each chromosome minus assembly gaps and, when asked, the blacklist", () => {
    const withBl = allowedSpace(sizesText, [gaps, blacklist]);
    const noBl = allowedSpace(sizesText, [gaps]);
    const genome = sizesText
      .trim()
      .split("\n")
      .reduce((t, l) => t + Number(l.split("\t")[1]), 0);
    const gapBp = gaps.reduce((t, g) => t + g.end - g.start, 0);
    expect(noBl.total).toBe(genome - gapBp);
    expect(withBl.total).toBeLessThan(noBl.total);
    expect(withBl.chroms).toEqual(noBl.chroms);
    // hg38 chr1 starts with 10 kb of N.
    expect(noBl.segments.get("chr1")!.starts[0]).toBe(10_000);
  });
});

describe("countOverlapping", () => {
  it.runIf(hasBedtools())("counts A regions overlapping B exactly as bedtools intersect -u, for every overlap rule", () => {
    const idx = new OverlapIndex(liver);
    for (const flags of ["", "-f 0.5", "-f 0.5 -r", "-F 0.5", "-f 0.5 -F 0.5 -e", "-f 0.9"]) {
      const rule = parseOverlapRule(flags);
      if ("error" in rule) throw new Error(rule.error);
      const native = execFileSync("bedtools", ["intersect", "-u", "-a", files.heart, "-b", files.liver, ...flags.split(" ").filter(Boolean)], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean).length;
      expect([flags, countOverlapping(heart, idx, rule)]).toEqual([flags, native]);
    }
  });
});

describe("shuffleRegions", () => {
  const space = allowedSpace(sizesText, [gaps, blacklist]);

  it("keeps every region's length and chromosome, never touches a gap or the blacklist, and repeats for the same seed", () => {
    const one = shuffleRegions(heart, space, randomStream(1, 0, 0), true);
    expect(one.leftOut).toBe(0);
    expect(one.regions.map((r) => [r.chrom, r.end - r.start])).toEqual(heart.map((r) => [r.chrom, r.end - r.start]));
    for (const r of one.regions) expect(overlapsAny(r, gaps) || overlapsAny(r, blacklist)).toBe(false);
    expect(shuffleRegions(heart, space, randomStream(1, 0, 0), true).regions).toEqual(one.regions);
    expect(shuffleRegions(heart, space, randomStream(1, 0, 1), true).regions).not.toEqual(one.regions);
  });

  it("anywhere in the genome, places regions on chromosomes in proportion to their allowed length", () => {
    const many: Interval[] = Array.from({ length: 20 }, () => heart).flat();
    const out = shuffleRegions(many, space, randomStream(3, 0, 0), false);
    const onChr1 = out.regions.filter((r) => r.chrom === "chr1").length / out.regions.length;
    const chr1 = space.segments.get("chr1")!.total / space.total;
    expect(Math.abs(onChr1 - chr1)).toBeLessThan(0.01);
    for (const r of out.regions.slice(0, 2000)) expect(overlapsAny(r, gaps) || overlapsAny(r, blacklist)).toBe(false);
  });

  it("leaves out regions on chromosomes outside the assembly or longer than any allowed stretch", () => {
    const odd: Interval[] = [
      { chrom: "chrUn_KI270742v1", start: 0, end: 100 },
      { chrom: "chrY", start: 0, end: 200_000_000 },
      ...heart.slice(0, 5),
    ];
    const out = shuffleRegions(odd, space, randomStream(1, 0, 0), true);
    expect(out.leftOut).toBe(2);
    expect(out.regions).toHaveLength(5);
  });
});

describe("permutationStats", () => {
  it("compares the observed count with the shuffles: fold, z, one-sided and two-sided empirical p", () => {
    const s = permutationStats(5, Int32Array.from([1, 2, 5, 7]));
    expect(s.mean).toBe(3.75);
    expect(s.sd).toBeCloseTo(Math.sqrt(((1 - 3.75) ** 2 + (2 - 3.75) ** 2 + (5 - 3.75) ** 2 + (7 - 3.75) ** 2) / 3), 12);
    expect(s.fold).toBeCloseTo(5 / 3.75, 12);
    expect(s.pGreater).toBe(3 / 5); // (1 + #{≥ 5}) / (n + 1)
    expect(s.pLess).toBe(4 / 5); // (1 + #{≤ 5}) / (n + 1)
    expect(s.p).toBe(1); // min(1, 2 × min)
    const enriched = permutationStats(9, Int32Array.from([1, 2, 3, 4]));
    expect(enriched.pGreater).toBe(1 / 5);
    expect(enriched.p).toBe(2 / 5);
    expect(permutationStats(0, Int32Array.from([0, 0])).fold).toBeNaN();
    expect(permutationStats(3, Int32Array.from([0, 0])).fold).toBe(Infinity);
  });
});

describe("runPermutation", () => {
  const rt = () => {
    const ref: Record<string, string> = {
      "refdata/hg38/hg38.chrom.sizes": sizesText,
      "refdata/hg38/go/gaps.bed": read(join(REF, "go/gaps.bed")),
      "refdata/hg38/blacklist/encode_blacklist_v2.bed": read(join(REF, "blacklist/encode_blacklist_v2.bed")),
    };
    const r: Runtime = { bedtools: memoryBedtools(), refdata: { text: async (p) => ref[p] ?? Promise.reject(new Error(`no ${p}`)) }, scanMotifs: async () => { throw new Error("not used"); } };
    return r;
  };
  const sets = Object.entries(files).map(([name, p]) => ({ id: name, name, file: new Blob([read(p)]) }));

  it("tests every ordered pair, reproducibly, with BH q-values across the pairs", async () => {
    const settings = { ...PERMUTATION_DEFAULTS, n: 200 };
    const progress: number[] = [];
    const run = await runPermutation(rt(), { assembly: "hg38", sets, overlapFlags: "", settings }, { onProgress: (p) => progress.push(p.done) });
    expect(run.pairs.map((p) => `${p.a}>${p.b}`)).toEqual(["heart>liver", "heart>lung", "liver>heart", "liver>lung", "lung>heart", "lung>liver"]);
    for (const p of run.pairs) {
      expect(p.perms).toHaveLength(200);
      expect(p.observed).toBeGreaterThan(p.mean); // H3K27ac peaks of three tissues share far more sites than chance
      expect(p.p).toBe(2 / 201); // no shuffle reaches the observed count: the smallest p for 200 shuffles
      expect(p.q).toBeGreaterThanOrEqual(p.p);
    }
    // heart → liver observed is bedtools intersect -u's count.
    expect(run.pairs[0].observed).toBe(countOverlapping(heart, new OverlapIndex(liver), { f: 0, F: 0, r: false, e: false }));
    expect(progress.at(-1)).toBe(3 * 200);
    const again = await runPermutation(rt(), { assembly: "hg38", sets, overlapFlags: "", settings });
    expect(again.pairs.map((p) => [...p.perms])).toEqual(run.pairs.map((p) => [...p.perms]));
    // A set's shuffles depend on its own regions and the seed, not on the other sets loaded.
    const two = await runPermutation(rt(), { assembly: "hg38", sets: sets.slice(0, 2), overlapFlags: "", settings });
    expect([...two.pairs[0].perms]).toEqual([...run.pairs[0].perms]);
  });

  it("says why it cannot run: an overlap rule it does not support, an assembly without gaps", async () => {
    await expect(runPermutation(rt(), { assembly: "hg38", sets, overlapFlags: "-s", settings: PERMUTATION_DEFAULTS })).rejects.toThrow(/-s/);
    await expect(runPermutation(rt(), { assembly: "hs1", sets, overlapFlags: "", settings: PERMUTATION_DEFAULTS })).rejects.toThrow(/hs1/);
  });

  it("writes a table and a methods paragraph that state the null", async () => {
    const run = await runPermutation(rt(), { assembly: "hg38", sets: sets.slice(0, 2), overlapFlags: "-f 0.5", settings: { ...PERMUTATION_DEFAULTS, n: 50 } });
    const tsv = permutationTsv(sets, run).split("\n");
    expect(tsv[0]).toBe("set_a\tset_b\tn_a_tested\tn_a_left_out\tobserved\tmean_shuffled\tsd_shuffled\tfold\tz\tp_greater\tp_less\tp_two_sided\tq");
    expect(tsv).toHaveLength(4);
    const m = permutationMethods({ assembly: "hg38", overlapFlags: "-f 0.5", settings: run.settings }).methods;
    expect(m).toMatch(/50 permutations/);
    expect(m).toMatch(/seed 1/);
    expect(m).toMatch(/same chromosome/);
    expect(m).toMatch(/ENCODE blacklist/);
    expect(m).toMatch(/-f 0\.5/);
    expect(m).toMatch(/Benjamini–Hochberg/);
  });
});
