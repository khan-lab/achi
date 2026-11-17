import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chosenGroups, inGroup, isSetKey, remapSelection, setBitOf, setGroup, setKey, sharesRegions, validSelection } from "./selection";
import { computeListSubsets, parseListText } from "./lists";
import { parseBed, sortIntervals } from "./intervals";
import type { RegionSet, Subset } from "../types";

/**
 * Selecting whole sets next to subsets. A whole set is keyed by the
 * negative of its subset bit (-1 the first included set, -2 the second,
 * -4 the third...), so it shares the selection with subset masks (always
 * positive) and never collides with one. Real data: the example gene lists
 * and the example super-enhancer BED files.
 */
const ROOT = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const CELLS = ["MCF7", "GM12878", "K562", "HepG2"];

const listSets: RegionSet[] = CELLS.map((c) => {
  const items = parseListText(read(`public/examples/lists/${c}_genes.txt`)).items;
  return { id: c, name: c, code: c.slice(0, 3).toUpperCase(), color: "#000000", defaultColor: "#000000", fileName: `${c}_genes.txt`, fileSizeBytes: 0, regions: [], nRegions: items.length, nBp: 0, included: true, items };
});
const listSubsets: Subset[] = computeListSubsets(listSets.map((s) => ({ id: s.id, items: s.items! }))).map((s) => ({
  ...s,
  label: s.memberIds.join(" ∩ "),
  code: s.memberIds.join("·"),
  degree: s.memberIds.length,
}));

const bedSet = (c: string): RegionSet => {
  const regions = sortIntervals(parseBed(read(`public/examples/hg38_ses/${c}.bed`)));
  return { id: c, name: c, code: c.slice(0, 3).toUpperCase(), color: "#000000", defaultColor: "#000000", fileName: `${c}.bed`, fileSizeBytes: 0, regions, nRegions: regions.length, nBp: regions.reduce((a, r) => a + r.end - r.start, 0), included: true };
};

describe("set keys", () => {
  it("are the negative of the set's subset bit, and only those are set keys", () => {
    expect([0, 1, 2, 7].map(setKey)).toEqual([-1, -2, -4, -128]);
    expect([-1, -2, -4, -128].map(setBitOf)).toEqual([0, 1, 2, 7]);
    expect([3, -3, 0, -256].map(setBitOf)).toEqual([null, null, null, null]);
    expect([isSetKey(-4), isSetKey(4), isSetKey(-3)]).toEqual([true, false, false]);
  });
});

describe("setGroup", () => {
  it("is the set's own regions, as given, labelled as the whole set", () => {
    const k562 = bedSet("K562");
    const g = setGroup(k562, 2);
    expect(g).toMatchObject({ mask: -4, memberIds: ["K562"], label: "K562 (all)", code: "K56-all", degree: 1, whole: true, nRegions: k562.nRegions, nBp: k562.nBp });
    expect(g.regions).toBe(k562.regions);
    expect(g.items).toBeUndefined();
  });
  it("carries the list's names in list mode", () => {
    const g = setGroup(listSets[0], 0);
    expect(g.items).toBe(listSets[0].items);
    expect(g.nRegions).toBe(listSets[0].items!.length);
  });
});

describe("chosenGroups", () => {
  it("returns subsets and whole sets in the order they were selected", () => {
    const k562Only = listSubsets.find((s) => s.mask === 4)!;
    const chosen = chosenGroups(new Set([4, -8, -1]), listSubsets, listSets);
    expect(chosen.map((g) => g.label)).toEqual([k562Only.label, "HepG2 (all)", "MCF7 (all)"]);
    expect(chosen[1].nRegions).toBe(listSets[3].items!.length);
  });
  it("skips keys with no subset or no included set behind them", () => {
    expect(chosenGroups(new Set([-16, 1 << 9]), listSubsets, listSets)).toEqual([]);
  });
});

describe("validSelection", () => {
  it("keeps subsets that still exist and sets that are still included", () => {
    const three = listSets.slice(0, 3);
    expect([...validSelection(new Set([1, -2, -8, 9999]), listSubsets, three)]).toEqual([1, -2]);
  });
});

describe("inGroup", () => {
  it("is the subset itself for a subset key, and every subset with the set's bit for a set key", () => {
    expect([inGroup(5, 5), inGroup(4, 5)]).toEqual([true, false]);
    // Set K562 (bit 2, key -4): "K562 only" (4), "K562 ∩ HepG2" (12), not "HepG2 only" (8).
    expect([inGroup(4, -4), inGroup(12, -4), inGroup(8, -4)]).toEqual([true, true, false]);
  });
  it("counts, for a set, exactly the names of its list in the subsets' universe", () => {
    const owner = listSubsets.flatMap((s) => s.items!.map(() => s.mask));
    CELLS.forEach((_, bit) => expect(owner.filter((o) => inGroup(o, setKey(bit))).length).toBe(listSets[bit].items!.length));
  });
});

describe("sharesRegions", () => {
  it("never for two different subsets (they partition the input)", () => {
    expect(sharesRegions(4, 12, listSubsets)).toBe(false);
    expect(sharesRegions(4, 4, listSubsets)).toBe(true);
  });
  it("for a set and any subset it is a member of", () => {
    expect(sharesRegions(-4, 12, listSubsets)).toBe(true);
    expect(sharesRegions(8, -4, listSubsets)).toBe(false);
  });
  it("for two sets exactly when some non-empty subset holds both", () => {
    const both = (a: number, b: number) => listSubsets.some((s) => s.nRegions > 0 && s.mask & (1 << a) && s.mask & (1 << b));
    expect(sharesRegions(-1, -2, listSubsets)).toBe(both(0, 1));
    expect(sharesRegions(-4, -4, listSubsets)).toBe(true);
    const disjoint = [{ mask: 1, nRegions: 5 }, { mask: 2, nRegions: 5 }, { mask: 3, nRegions: 0 }];
    expect(sharesRegions(-1, -2, disjoint)).toBe(false);
  });
});

describe("remapSelection", () => {
  const ids = (xs: string[]) => xs.map((id) => ({ id }));
  it("follows each set and subset to its new bit when a set before it is removed or left out", () => {
    // Before: MCF7 0, GM12878 1, K562 2, HepG2 3. GM12878 removed: K562 1, HepG2 2.
    const before = ids(CELLS);
    const after = ids(["MCF7", "K562", "HepG2"]);
    // K562 ∩ HepG2 (12) -> 6; set K562 (-4) -> -2; MCF7 only (1) stays 1.
    expect(remapSelection([12, -4, 1], before, after)).toEqual([6, -2, 1]);
  });
  it("drops what involves a set that is gone", () => {
    expect(remapSelection([2, 3, -2, -1], ids(CELLS), ids(["MCF7", "K562", "HepG2"]))).toEqual([-1]);
  });
  it("keeps selection order and leaves keys alone when nothing moved", () => {
    expect(remapSelection([-8, 5], ids(CELLS), ids(CELLS))).toEqual([-8, 5]);
  });
});
