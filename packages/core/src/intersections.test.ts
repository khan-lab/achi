import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blacklistPath } from "./blacklist";
import { computeSubsets, parseBed, sortIntervals } from "./intervals";
import { labelSubsets, runBlacklistCheck, runIntersections, subsetFileText } from "./intersections";
import { scanMotifsInline } from "./motifScan";
import { forgetSet } from "./pipeline";
import type { Bedtools, Runtime } from "./runtime";
import { memoryBedtools } from "./testkit";

/**
 * Intersections as every layer runs them, on the real ENCODE H3K27ac
 * fixtures. The bedtools path (here an in-memory bedtools with 1 bp
 * overlaps) must give the same subsets as lib/intervals.ts, the pure
 * TypeScript 1 bp algorithm that differential.test.ts checks against
 * native bedtools.
 */
const ROOT = join(__dirname, "../../..");
const names = ["heart_h3k27ac_ENCFF059ERB.subsample.bed", "liver_h3k27ac_ENCFF805YRQ.subsample.bed", "lung_h3k27ac_ENCFF314QTE.subsample.bed"];
const texts = names.map((f) => readFileSync(join(ROOT, "tests/fixtures/encode", f), "utf8"));
const inputs = (prefix: string) => texts.map((t, i) => ({ id: `${prefix}${i}`, name: ["Heart", "Liver", "Lung"][i], file: new Blob([t]) }));
const rt = (bedtools: Bedtools): Runtime => ({ bedtools, refdata: { text: async (p) => readFileSync(join(ROOT, "public", p), "utf8") }, scanMotifs: scanMotifsInline });
const failing = (): Bedtools => ({ ...memoryBedtools(), exec: async () => Promise.reject(new Error("bedtools crashed")) });

describe("runIntersections", () => {
  it("gives the subsets of the 1 bp overlap rule, and each set's sorted regions", async () => {
    const sets = inputs("a");
    const out = await runIntersections(rt(memoryBedtools()), { sets, overlapFlags: "" });
    const expected = computeSubsets(texts.map((t, i) => ({ id: `a${i}`, regions: sortIntervals(parseBed(t)) })));
    const key = (s: { mask: number; regions: { chrom: string; start: number; end: number }[] }) => `${s.mask}:${s.regions.map((r) => `${r.chrom}:${r.start}-${r.end}`).join(",")}`;
    expect(out.subsets.map(key).sort()).toEqual(expected.map(key).sort());
    expect(out.subsets.length).toBeGreaterThan(3); // real overlaps between the tissues
    expect(out.sets.map((s) => s.nRegions)).toEqual(texts.map((t) => parseBed(t).length));
    expect(out).toMatchObject({ usedFallback: false, fallbackOverlapUnsupported: false });
    sets.forEach((s) => forgetSet(s.id));
  });

  it("falls back to the TypeScript algorithm when bedtools fails, unless told not to", async () => {
    const out = await runIntersections(rt(failing()), { sets: inputs("b"), overlapFlags: "-f 0.50" });
    expect(out).toMatchObject({ usedFallback: true, fallbackOverlapUnsupported: true });
    expect(out.subsets.length).toBeGreaterThan(3);
    await expect(runIntersections(rt(failing()), { sets: inputs("c"), overlapFlags: "" }, { fallback: false })).rejects.toThrow("bedtools crashed");
  });

  it("needs at least two sets for subsets", async () => {
    const out = await runIntersections(rt(memoryBedtools()), { sets: inputs("d").slice(0, 1), overlapFlags: "" });
    expect(out.subsets).toEqual([]);
    expect(out.sets[0].nRegions).toBe(parseBed(texts[0]).length);
  });
});

describe("labelSubsets and subsetFileText", () => {
  it("names a subset by its sets ('Heart only', 'Heart ∩ Liver') with their codes", () => {
    const sets = [
      { id: "a", name: "Heart", code: "HRT" },
      { id: "b", name: "Liver", code: "LIV" },
    ];
    const iv = { chrom: "chr1", start: 1, end: 5 };
    const [one, both] = labelSubsets(
      [
        { mask: 1, memberIds: ["a"], regions: [iv], nRegions: 1, nBp: 4 },
        { mask: 3, memberIds: ["a", "b"], regions: [], nRegions: 0, nBp: 0 },
      ],
      sets
    );
    expect(one).toMatchObject({ label: "Heart only", code: "HRT", degree: 1 });
    expect(both).toMatchObject({ label: "Heart ∩ Liver", code: "HRT·LIV", degree: 2 });
    expect(subsetFileText(one)).toBe("chr1\t1\t5\n");
    expect(subsetFileText({ ...both, items: ["TP53", "MYC"] })).toBe("TP53\nMYC\n");
  });
});

describe("runBlacklistCheck", () => {
  it("flags each region overlapping the assembly's ENCODE blacklist by at least 1 bp; null for a set it could not check", async () => {
    const bl = parseBed(readFileSync(join(ROOT, "public", blacklistPath("hg38")), "utf8"));
    const sets = texts.map((t, i) => ({ id: `bl${i}`, name: names[i], text: t }));
    const out = await runBlacklistCheck(rt(memoryBedtools()), "hg38", sets);
    out.forEach((r, i) => {
      const expected = parseBed(texts[i]).map((q) => (bl.some((b) => b.chrom === q.chrom && b.start < q.end && q.start < b.end) ? 1 : 0));
      expect(Array.from(r.hits!)).toEqual(expected);
    });
    expect(out.reduce((n, r) => n + r.hits!.reduce((a, h) => a + h, 0), 0)).toBeGreaterThan(0);
    const warned: string[] = [];
    const bad = await runBlacklistCheck(rt(failing()), "hg38", sets.slice(0, 1), { onFailure: (s) => warned.push(s.name) });
    expect(bad[0].hits).toBeNull();
    expect(warned).toEqual([names[0]]);
  });
});
