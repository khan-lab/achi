import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputValidationError } from "./inputValidation";
import { computeListSubsets, listSetName, parseListText } from "./lists";

/**
 * List mode (Intervene's "list" input): sets of names (genes, SNP IDs, any
 * identifiers) intersected by exact match. Real data: the example gene lists
 * derived from the ENCODE example peaks (public/examples/lists/, see
 * build_example_lists.py).
 */

const ROOT = join(__dirname, "../..");
const list = (cell: string) => readFileSync(join(ROOT, `public/examples/lists/${cell}_genes.txt`), "utf8");
const CELLS = ["MCF7", "GM12878", "K562", "HepG2"];

describe("parseListText", () => {
  it("reads one name per line, in file order, without duplicates", () => {
    const p = parseListText(list("HepG2"));
    expect(p.items).toHaveLength(1238);
    expect(new Set(p.items).size).toBe(p.items.length);
    expect(p.items.slice(0, 3)).toEqual(list("HepG2").split("\n").slice(0, 3));
    expect(p).toMatchObject({ nDuplicates: 0, nSkipped: 0 });
  });

  it("takes the first column of tab, comma or semicolon separated lines; skips # lines, blank lines and quotes; counts repeats", () => {
    const genes = list("MCF7").trim().split("\n");
    const messy = [
      "# genes near MCF7 peaks",
      ...genes.slice(0, 50).map((g, i) => (i % 3 === 0 ? `${g}\t0.5` : i % 3 === 1 ? `"${g}",x` : `  ${g} ;y`)),
      "",
      ...genes.slice(0, 10), // repeated
    ].join("\r\n");
    const p = parseListText(messy);
    expect(p.items).toEqual(genes.slice(0, 50));
    expect(p.nDuplicates).toBe(10);
    expect(p.nSkipped).toBe(2); // the # line and the blank line
  });

  it("refuses a file with no names", () => {
    expect(() => parseListText("# only a comment\n\n")).toThrow(InputValidationError);
    expect(() => parseListText("")).toThrow(/no names/);
  });
});

describe("listSetName", () => {
  it("drops list extensions (and .gz) from the file name", () => {
    expect(listSetName("HepG2_genes.txt")).toBe("HepG2_genes");
    expect(listSetName("up.regulated.csv")).toBe("up.regulated");
    expect(listSetName("ids.tsv.gz")).toBe("ids");
    expect(listSetName("names")).toBe("names");
  });
});

describe("computeListSubsets", () => {
  const sets = CELLS.map((c) => ({ id: c, items: parseListText(list(c)).items }));
  const subsets = computeListSubsets(sets);

  it("puts every name in exactly one subset: the one for exactly the lists that contain it (brute force)", () => {
    const union = new Set(sets.flatMap((s) => s.items));
    const seen = new Map<string, number>();
    for (const s of subsets) for (const item of s.items) seen.set(item, s.mask);
    expect(seen.size).toBe(union.size);
    expect(subsets.reduce((n, s) => n + s.nRegions, 0)).toBe(union.size);
    for (const item of union) {
      const mask = sets.reduce((m, s, i) => (s.items.includes(item) ? m | (1 << i) : m), 0);
      expect(seen.get(item)).toBe(mask);
    }
  });

  it("matches each list's size when its subsets are summed, names members by id, and sorts largest first", () => {
    sets.forEach((s, i) => {
      expect(subsets.filter((x) => x.mask & (1 << i)).reduce((n, x) => n + x.nRegions, 0)).toBe(s.items.length);
    });
    for (const s of subsets) {
      expect(s.memberIds).toEqual(sets.filter((_, i) => s.mask & (1 << i)).map((x) => x.id));
      expect(s).toMatchObject({ nRegions: s.items.length, nBp: 0, regions: [] });
    }
    expect(subsets.map((s) => s.nRegions)).toEqual([...subsets.map((s) => s.nRegions)].sort((a, b) => b - a));
  });

  it("needs two lists", () => {
    expect(computeListSubsets(sets.slice(0, 1))).toEqual([]);
  });
});
