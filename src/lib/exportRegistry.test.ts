import { describe, expect, it } from "vitest";
import { collectExports, markExportStale, registerExport } from "./exportRegistry";

/**
 * Panels with results (enrichment, GO, gene lists) contribute tables and a
 * methods paragraph to the analysis export while they hold a result.
 */
describe("export registry", () => {
  it("collects what registered providers return now, in registration order, skipping empty ones", () => {
    let result: string | null = null;
    const offA = registerExport("enrichment", () => (result ? { files: [{ path: "tables/enrichment.tsv", content: result }] } : null));
    const offB = registerExport("go", () => ({ files: [{ path: "tables/go.tsv", content: "x" }], methods: { methods: "GO.", references: [] } }));
    expect(collectExports().current.map((c) => c.files[0].path)).toEqual(["tables/go.tsv"]);
    result = "a\tb\n";
    expect(collectExports().current.map((c) => c.files[0].path)).toEqual(["tables/enrichment.tsv", "tables/go.tsv"]);
    offA();
    offB();
    expect(collectExports()).toEqual({ current: [], outOfDate: [] });
  });
  it("replaces a provider registered again under the same key, and an old unregister does not remove the new one", () => {
    const off1 = registerExport("k", () => ({ files: [{ path: "1", content: "" }] }));
    const off2 = registerExport("k", () => ({ files: [{ path: "2", content: "" }] }));
    off1();
    expect(collectExports().current.map((c) => c.files[0].path)).toEqual(["2"]);
    off2();
  });
  it("leaves out a result marked out of date, or one its provider reports as stale, and names both", () => {
    let permStale = false;
    const offGo = registerExport("go", () => ({ files: [{ path: "tables/go.tsv", content: "x" }] }));
    const offPerm = registerExport("permutation", () => (permStale ? "stale" : { files: [{ path: "tables/perm.tsv", content: "y" }] }));
    markExportStale("go", true);
    permStale = true;
    expect(collectExports()).toEqual({ current: [], outOfDate: ["GO enrichment", "the pairwise permutation test"] });
    markExportStale("go", false);
    permStale = false;
    expect(collectExports().current.map((c) => c.files[0].path)).toEqual(["tables/go.tsv", "tables/perm.tsv"]);
    // Unregistering forgets the mark: a panel shown again starts current.
    markExportStale("go", true);
    offGo();
    const offGo2 = registerExport("go", () => ({ files: [{ path: "tables/go.tsv", content: "x" }] }));
    expect(collectExports().outOfDate).toEqual([]);
    offGo2();
    offPerm();
  });
});
