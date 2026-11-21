import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { GO_CLUSTER_DEFAULTS, clusterTerms, compareGoGroups, goCompareTsv, termKappa, type GoComparison } from "./goCompare";
import { CISTROMEGO_DEFAULTS, GREAT_RUN_DEFAULTS, goTermGenes, runGoEnrichment, type GoGroup, type GoGroupResult } from "./goEnrichment";
import type { GoData } from "./great";
import { scanMotifsInline } from "./motifScan";
import { memoryBedtools } from "./testkit";
import type { Runtime } from "./runtime";
import type { Interval } from "./types";

/**
 * Comparing GO results across the selected groups: one row per term (or per
 * cluster of similar terms, Metascape's kappa clustering), one column per
 * group. Real data: the bundled hg38 GO annotation, and GREAT-like results
 * of two ENCODE H3K27ac fixtures (heart, liver).
 */
const ROOT = join(__dirname, "../../..");
const PUBLIC = join(ROOT, "public");
const go = JSON.parse(readFileSync(join(PUBLIC, "refdata/hg38/go/go.json"), "utf8")) as GoData;
const bpGenes = new Map(go.terms.BP.map(([id, , genes]) => [id, genes]));

describe("termKappa", () => {
  it("reproduces Metascape's worked example: 7 genes, terms of 3 and 4 genes agreeing on 6, kappa = 0.72", () => {
    // Metascape blog, "Clustering Enriched Ontology Terms": agreement 6/7, chance agreement 24/49.
    expect(termKappa([0, 1, 2], [0, 1, 2, 3], 7)).toBeCloseTo(0.72, 10);
  });
  it("is 1 for identical terms, and negative for disjoint ones", () => {
    expect(termKappa([1, 4, 5], [1, 4, 5], 10)).toBe(1);
    expect(termKappa([0, 1], [2, 3], 4)).toBeLessThan(0);
  });
  it("on real GO terms: the regulation of cell migration and of cell motility are near-identical; insulin response is unrelated", () => {
    const ids = ["GO:0030334", "GO:2000145", "GO:0032868"];
    const universe = new Set(ids.flatMap((id) => bpGenes.get(id)!));
    const index = new Map([...universe].map((g, i) => [g, i]));
    const k = (a: string, b: string) => termKappa(bpGenes.get(a)!.map((g) => index.get(g)!), bpGenes.get(b)!.map((g) => index.get(g)!), universe.size);
    expect(k("GO:0030334", "GO:2000145")).toBeGreaterThan(0.7);
    expect(k("GO:0030334", "GO:0032868")).toBeLessThan(0.3);
  });
});

describe("clusterTerms (average linkage on 1 − kappa, cut at kappa > minKappa)", () => {
  it("groups real GO terms: migration, motility and locomotion together; the insulin responses together; nothing across", () => {
    const ids = ["GO:0030334", "GO:2000145", "GO:0040012", "GO:0032868", "GO:0032869"];
    const labels = clusterTerms(
      ids.map((id) => bpGenes.get(id)!),
      0.3,
    );
    expect(labels).toEqual([0, 0, 0, 1, 1]);
  });
  it("numbers clusters in order of their first term, so the most significant term (listed first) labels cluster 0", () => {
    expect(clusterTerms([[5, 6], [1, 2, 3], [1, 2, 3]], 0.3)).toEqual([0, 1, 1]);
  });
  it("uses average linkage: a term joins a cluster only if its mean kappa to the members is above the cut", () => {
    const r = (lo: number, hi: number) => Array.from({ length: hi - lo }, (_, i) => lo + i);
    const far = r(20, 40); // a term sharing nothing, so the gene universe is wider than the three
    const A = r(0, 6);
    const B = r(1, 7);
    const n = 10 + 20; // the union: genes 0–9 and 20–39
    // C overlaps B enough to pass on its own (single linkage would chain it on), but not A.
    const C = r(4, 10);
    expect(termKappa(B, C, n)).toBeGreaterThan(0.3);
    expect((termKappa(B, C, n) + termKappa(A, C, n)) / 2).toBeLessThan(0.3);
    expect(clusterTerms([A, B, C, far], 0.3)).toEqual([0, 0, 1, 2]);
    // A wider C passes on average too and joins.
    const C2 = r(3, 10);
    expect((termKappa(B, C2, n) + termKappa(A, C2, n)) / 2).toBeGreaterThan(0.3);
    expect(clusterTerms([A, B, C2, far], 0.3)).toEqual([0, 0, 0, 1]);
  });
  it("keeps a pair at exactly the threshold apart (Metascape: similarity > 0.3)", () => {
    // Metascape's example pair (kappa 0.72 over 7 genes), the 7 genes made up by a third term.
    const k = termKappa([0, 1, 2], [0, 1, 2, 3], 7);
    expect(clusterTerms([[0, 1, 2], [0, 1, 2, 3], [4, 5, 6]], k)).toEqual([0, 1, 2]);
    expect(clusterTerms([[0, 1, 2], [0, 1, 2, 3], [4, 5, 6]], k - 1e-9)).toEqual([0, 0, 1]);
  });
});

/** A small hand-written result set: three groups, terms with q and fold. */
function row(id: string, q: number, fold: number, significant = q < 0.05) {
  return { id, name: `term ${id}`, q, fold, significant, detail: "", tsv: [] };
}
const toy: GoGroupResult[] = [
  { mask: 1, label: "A", summary: "", rows: [row("t1", 1e-8, 3), row("t2", 1e-5, 2), row("t3", 0.2, 1.5), row("t4", 0.5, 0.8)] },
  { mask: 2, label: "B", summary: "", rows: [row("t2", 1e-6, 2.5), row("t5", 1e-4, 4), row("t1", 0.3, 1.2)] },
  { mask: 3, label: "C", summary: "", rows: [row("t1", 1e-3, 1.8), row("t2", 1e-3, 1.9), row("t6", 0.01, 6)] },
];

describe("compareGoGroups without clustering", () => {
  it("takes each group's top N significant enriched terms and lists their union, one cell per group", () => {
    const c = compareGoGroups(toy, { top: 1 });
    expect(c.rows.map((r) => r.id).sort()).toEqual(["t1", "t2"]); // A's top: t1; B's top: t2; C's top: t1
    const t1 = c.rows.find((r) => r.id === "t1")!;
    expect(t1.cells.map((x) => x && { q: x.q, fold: x.fold, significant: x.significant })).toEqual([
      { q: 1e-8, fold: 3, significant: true },
      { q: 0.3, fold: 1.2, significant: false }, // enriched in B but not significant: shown hollow
      { q: 1e-3, fold: 1.8, significant: true },
    ]);
  });
  it("leaves a cell empty where the term is not enriched (fold ≤ 1) or not in the group's results", () => {
    const c = compareGoGroups(toy, { top: 5 });
    expect(c.rows.find((r) => r.id === "t5")!.cells.map((x) => x !== null)).toEqual([false, true, false]);
    expect(c.rows.some((r) => r.id === "t4")).toBe(false); // depleted everywhere
    expect(c.rows.some((r) => r.id === "t3")).toBe(false); // enriched but never significant
  });
  it("orders shared terms first, then terms of one group in group order, then by the best q", () => {
    const c = compareGoGroups(toy, { top: 5 });
    expect(c.rows.map((r) => [r.id, r.nSignificant])).toEqual([
      ["t2", 3],
      ["t1", 2],
      ["t5", 1],
      ["t6", 1],
    ]);
  });
  it("has one member per row and reports no clustering", () => {
    const c = compareGoGroups(toy, { top: 5 });
    expect(c.rows.every((r) => r.members.length === 1 && r.members[0].id === r.id)).toBe(true);
    expect(c.clustered).toBe(false);
  });
});

describe("compareGoGroups on real GREAT-like results (ENCODE heart and liver H3K27ac)", () => {
  const regionsOf = (text: string): Interval[] =>
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .map(([chrom, a, b]) => ({ chrom, start: +a, end: +b }))
      .sort((x, y) => (x.chrom < y.chrom ? -1 : x.chrom > y.chrom ? 1 : x.start - y.start));
  const fixture = (f: string) => readFileSync(join(ROOT, "tests/fixtures/encode", f), "utf8");
  const groups: GoGroup[] = [
    { mask: 1, label: "Heart", regions: regionsOf(fixture("heart_h3k27ac_ENCFF059ERB.subsample.bed")) },
    { mask: 2, label: "Liver", regions: regionsOf(fixture("liver_h3k27ac_ENCFF805YRQ.subsample.bed")) },
  ];
  const rt: Runtime = { bedtools: memoryBedtools(), refdata: { text: async (p) => readFileSync(join(PUBLIC, p), "utf8") }, scanMotifs: scanMotifsInline };
  let results: GoGroupResult[];
  let termGenes: Map<string, number[]>;
  let plain: GoComparison;
  let grouped: GoComparison;
  beforeAll(async () => {
    const run = await runGoEnrichment(rt, {
      method: "great",
      ns: "BP",
      assembly: "hg38",
      groups,
      allSubsets: groups.map((g) => ({ mask: g.mask, regions: g.regions })),
      great: GREAT_RUN_DEFAULTS,
      cgo: CISTROMEGO_DEFAULTS,
    });
    results = run.groups;
    termGenes = await goTermGenes(rt, "hg38", "BP");
    plain = compareGoGroups(results, { top: 15 });
    grouped = compareGoGroups(results, { top: 15, cluster: { termGenes, ...GO_CLUSTER_DEFAULTS } });
  }, 120_000);

  it("goTermGenes gives each term's annotated genes, as in the bundled GO data", () => {
    expect(termGenes.size).toBe(go.terms.BP.length);
    expect(termGenes.get("GO:0030334")).toEqual(bpGenes.get("GO:0030334"));
  });
  it("without clustering, every row is a term significant in at least one tissue, among its top 15", () => {
    expect(plain.rows.length).toBeGreaterThan(0);
    expect(plain.rows.length).toBeLessThanOrEqual(30);
    for (const r of plain.rows) expect(r.nSignificant).toBeGreaterThan(0);
  });
  it("with clustering, each row is a cluster labelled by its most significant member, and its cell in a tissue is that tissue's best member", () => {
    expect(grouped.clustered).toBe(true);
    expect(grouped.rows.some((r) => r.members.length > 1)).toBe(true);
    const byId = results.map((g) => new Map(g.rows.map((x) => [x.id, x])));
    for (const r of grouped.rows) {
      const bestQ = (id: string) => Math.min(...byId.filter((m) => (m.get(id)?.fold ?? 0) > 1).map((m) => m.get(id)!.q));
      expect(r.id).toBe(r.members[0].id);
      for (const m of r.members) expect(bestQ(r.id)).toBeLessThanOrEqual(bestQ(m.id));
      r.cells.forEach((cell, gi) => {
        if (!cell) return;
        const enrichedMembers = r.members.map((m) => byId[gi].get(m.id)).filter((x) => x && x.fold > 1);
        expect(cell.q).toBe(Math.min(...enrichedMembers.map((x) => x!.q)));
      });
    }
  });
  it("no two rows of the clustered view share a term; each tissue adds at most 15 rows", () => {
    const all = grouped.rows.flatMap((r) => r.members.map((m) => m.id));
    expect(new Set(all).size).toBe(all.length);
    expect(grouped.rows.length).toBeLessThanOrEqual(2 * 15);
    expect(grouped.nClusters).toBeLessThan(grouped.nTermsClustered);
  });
  it("clusters at most maxTerms terms, the most significant ones", () => {
    const c = compareGoGroups(results, { top: 15, cluster: { termGenes, minKappa: 0.3, maxTerms: 20 } });
    expect(c.nTermsClustered).toBe(20);
  });
  it("the TSV has one line per row, members and each group's q, fold and significance", () => {
    const tsv = goCompareTsv(grouped, results).trimEnd().split("\n");
    expect(tsv[0].split("\t")).toEqual(["go_id", "term", "n_similar", "similar_terms", "Heart_q", "Heart_fold", "Heart_significant", "Liver_q", "Liver_fold", "Liver_significant"]);
    expect(tsv.length).toBe(grouped.rows.length + 1);
    const first = tsv[1].split("\t");
    expect(first[0]).toBe(grouped.rows[0].id);
    expect(Number(first[2])).toBe(grouped.rows[0].members.length - 1);
  });
});
