import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPRESSION_DEFAULTS,
  betaRp,
  classifyGenes,
  expressionMethods,
  expressionTsvs,
  ksOneSided,
  matchGenes,
  parseDeTable,
  parseGeneTss,
  rankDescending,
  regulatoryPotential,
  runExpression,
} from "./expression";
import { parseBed } from "./intervals";
import { mannWhitneyU } from "./stats";
import type { Bedtools, Runtime } from "./runtime";
import type { SummaryItem } from "./types";

/**
 * Expression near the selected regions (the Expression panel; CLI
 * --expression): a DESeq2/edgeR/limma table, genes linked to regions, and
 * two tests per group: BETA-like (regulatory potential ranks of up and of
 * down genes against non-differential genes, one-sided KS) and nearest-gene
 * (log2FC of the regions' nearest genes against all other genes,
 * Mann–Whitney). Real data: the example table (ENCODE HepG2 vs K562 by
 * DESeq2, public/examples/expression) and the example super-enhancers.
 */
const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DE = read("public/examples/expression/HepG2_vs_K562.deseq2.tsv");
const TSS = read("public/refdata/hg38/genes_tss.bed");
const HEPG2 = read("public/examples/hg38_ses/HepG2.bed");
const K562 = read("public/examples/hg38_ses/K562.bed");

/** The example table re-written as edgeR, limma and DESeq2-write.csv would, from its own rows. */
function asFormat(kind: "edger" | "limma" | "csv"): string {
  const lines = DE.trim().split("\n").slice(1, 201).map((l) => l.split("\t"));
  if (kind === "edger") return ["genes\tlogFC\tlogCPM\tPValue\tFDR", ...lines.map((f) => [f[1], f[3], "5", f[5], f[6]].join("\t"))].join("\n");
  if (kind === "limma") return ["ID\tlogFC\tAveExpr\tt\tP.Value\tadj.P.Val\tB", ...lines.map((f) => [f[0] + ".7", f[3], "5", "1", f[5], f[6], "0"].join("\t"))].join("\n");
  return ['"","baseMean","log2FoldChange","lfcSE","stat","pvalue","padj"', ...lines.map((f) => [`"${f[0]}"`, f[2], f[3], f[4], "1", f[5], f[6]].join(","))].join("\n");
}

describe("parseDeTable", () => {
  it("reads DESeq2, edgeR and limma tables, tab or comma separated, and says which columns it used", () => {
    const deseq = parseDeTable(DE);
    if ("error" in deseq) throw new Error(deseq.error);
    expect(deseq.columns).toEqual({ id: "gene_id", log2fc: "log2FoldChange", padj: "padj" });
    expect(deseq.rows[0]).toEqual({ id: "ENSG00000081051", name: "AFP", log2fc: 11.95, padj: 1.633e-217 });
    expect(deseq.rows.length + deseq.nMissing).toBe(DE.trim().split("\n").length - 1);
    expect(deseq.nMissing).toBeGreaterThan(0); // DESeq2's independent filtering leaves padj NA

    const edger = parseDeTable(asFormat("edger"));
    if ("error" in edger) throw new Error(edger.error);
    expect(edger.columns).toEqual({ id: "genes", log2fc: "logFC", padj: "FDR" });
    expect(edger.rows[0]).toMatchObject({ id: "AFP", log2fc: 11.95 });

    const limma = parseDeTable(asFormat("limma"));
    if ("error" in limma) throw new Error(limma.error);
    expect(limma.columns).toEqual({ id: "ID", log2fc: "logFC", padj: "adj.P.Val" });

    const csv = parseDeTable(asFormat("csv"));
    if ("error" in csv) throw new Error(csv.error);
    expect(csv.columns.id).toBe("(first column)");
    expect(csv.rows[1]).toMatchObject({ id: "ENSG00000156515", log2fc: -10.27, padj: 5.77e-195 });
  });

  it("says what is missing", () => {
    expect(parseDeTable("gene\tbaseMean\npa\t1\n")).toEqual({ error: expect.stringMatching(/log2 fold change/) });
    expect(parseDeTable("gene\tlog2FoldChange\nA\t1\n")).toEqual({ error: expect.stringMatching(/adjusted p/) });
    expect(parseDeTable("")).toEqual({ error: expect.stringMatching(/empty/) });
  });
});

describe("matchGenes", () => {
  const genes = parseGeneTss(TSS);

  it("matches Ensembl ids without their version, then symbols; skips symbols that name two genes", () => {
    const de = parseDeTable(DE);
    if ("error" in de) throw new Error(de.error);
    const m = matchGenes(de.rows, genes);
    expect(m.matched.length).toBe(14_662); // of 20,107 protein-coding genes: those with counts and a DESeq2 padj
    const afp = m.matched.find((g) => g.gene.symbol === "AFP")!;
    expect(afp.log2fc).toBe(11.95);
    // Symbols only (edgeR table above): the same genes found by name.
    const bySymbol = parseDeTable(asFormat("edger"));
    if ("error" in bySymbol) throw new Error(bySymbol.error);
    const s = matchGenes(bySymbol.rows, genes);
    expect(s.matched.map((g) => g.gene.id).slice(0, 5)).toEqual(m.matched.filter((g) => de.rows.slice(0, 200).some((r) => r.id === g.gene.id.split(".")[0])).map((g) => g.gene.id).slice(0, 5));
    // A versioned id matches (limma table above).
    const v = parseDeTable(asFormat("limma"));
    if ("error" in v) throw new Error(v.error);
    expect(matchGenes(v.rows, genes).matched.length).toBe(m.matched.filter((g) => de.rows.slice(0, 200).some((r) => r.id === g.gene.id.split(".")[0])).length);
    const dupSymbol = genes.find((g, i) => genes.findIndex((h) => h.symbol === g.symbol) !== i)!.symbol;
    expect(matchGenes([{ id: dupSymbol, name: "", log2fc: 1, padj: 0.01 }], genes)).toMatchObject({ matched: [], ambiguous: 1 });
    expect(matchGenes([{ id: "NOT_A_GENE", name: "", log2fc: 1, padj: 0.01 }], genes)).toMatchObject({ matched: [], unmatched: 1 });
  });
});

describe("regulatoryPotential (BETA)", () => {
  it("is Σ exp(−(0.5 + 4d/100 kb)) over region centres within 100 kb of each TSS", () => {
    const genes = parseGeneTss(TSS).filter((g) => g.chrom === "chr4" || g.chrom === "chr19");
    const regions = parseBed(HEPG2);
    const rp = regulatoryPotential(regions, genes, 100_000);
    // Brute force.
    genes.forEach((g, i) => {
      let want = 0;
      for (const r of regions) {
        if (r.chrom !== g.chrom) continue;
        const d = Math.abs(Math.floor((r.start + r.end) / 2) - g.tss);
        if (d <= 100_000) want += betaRp(d, 100_000);
      }
      expect(rp[i]).toBeCloseTo(want, 12);
    });
    expect(betaRp(0, 100_000)).toBeCloseTo(Math.exp(-0.5), 15);
    expect(betaRp(100_000, 100_000)).toBeCloseTo(Math.exp(-4.5), 15);
    const afp = genes.findIndex((g) => g.symbol === "AFP");
    expect(rp[afp]).toBeGreaterThan(0);
  });

  it("ranks genes by it, highest first, ties sharing the average rank", () => {
    expect([...rankDescending(Float64Array.from([0.5, 0, 2, 0, 0.5]))]).toEqual([2.5, 4.5, 1, 4.5, 2.5]);
  });
});

describe("ksOneSided", () => {
  // References: R 4.6.1 ks.test(x, y, alternative, exact = FALSE) on the example table.
  const d = DE.trim().split("\n").slice(1).map((l) => l.split("\t"));
  const baseMean = d.map((f) => Number(f[2]));

  it("is R's asymptotic one-sided two-sample KS: D⁺ = max(F_x − F_y), p = exp(−2·mn/(m+n)·D²)", () => {
    const x = baseMean.slice(0, 60);
    const y = baseMean.slice(60, 200);
    const g = ksOneSided(x, y);
    expect(g.D).toBeCloseTo(0.0071428571428597126, 12);
    expect(g.p).toBeCloseTo(0.99572345628226311, 12);
    const l = ksOneSided(y, x);
    expect(l.D).toBeCloseTo(0.57142857142856973, 12);
    // R computes this p as 1 − (1 − e^(−x)), which keeps only about 16 digits after the decimal point; e^(−x) directly is exact to the last bit.
    expect(Math.abs(l.p - 1.2243539515566226e-12)).toBeLessThan(1e-16);
  });

  it("handles tied values (ranks) as R does", () => {
    const lfc = d.slice(0, 300).map((f) => -Number(f[3]));
    const ranks = rankDescending(Float64Array.from(lfc.map((v) => -v)));
    const k = ksOneSided([...ranks.slice(0, 40)], [...ranks.slice(40)]);
    expect(k.D).toBeCloseTo(0.12307692307692311, 12);
    expect(k.p).toBeCloseTo(0.34984803298573686, 12);
  });

  it("agrees with R's wilcox.test for the nearest-gene comparison (stats.mannWhitneyU)", () => {
    const lfc = d.map((f) => Number(f[3]));
    const w = mannWhitneyU(lfc.slice(0, 50), lfc.slice(50, 400));
    expect(w.U).toBe(8745);
    expect(w.p).toBeCloseTo(0.99530484945609643, 10);
  });
});

describe("classifyGenes", () => {
  it("up: padj < α and log2FC ≥ c; down: padj < α and log2FC ≤ −c; the rest static", () => {
    const rows = [
      { log2fc: 2, padj: 0.01 },
      { log2fc: -3, padj: 0.001 },
      { log2fc: 0.5, padj: 0.001 },
      { log2fc: 4, padj: 0.2 },
      { log2fc: 1, padj: 0.049 },
    ];
    expect(classifyGenes(rows, { ...EXPRESSION_DEFAULTS, padj: 0.05, minAbsLog2fc: 1 })).toEqual(["up", "down", "static", "static", "up"]);
    expect(classifyGenes(rows, { ...EXPRESSION_DEFAULTS, padj: 0.05, minAbsLog2fc: 0 })).toEqual(["up", "down", "up", "static", "up"]);
  });
});

/** Native bedtools on files in a temporary folder: enough for runNearestGenes. */
function nativeBedtools(): Bedtools & { cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "achi-expr-"));
  return {
    dir,
    mount: async (files) => files.forEach((f) => writeFileSync(join(dir, f.name), f.data)),
    unmount: async () => {},
    reset: async () => {},
    exec: async (cmd) => {
      const [bin, ...args] = cmd.split(/\s+/);
      if (bin !== "bedtools") throw new Error(cmd);
      return { stdout: execFileSync("bedtools", args, { encoding: "utf8", maxBuffer: 1 << 28 }), stderr: "" };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function hasBedtools(): boolean {
  try {
    execFileSync("bedtools", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe("runExpression", () => {
  it.runIf(hasBedtools())("HepG2 super-enhancers sit near genes up in HepG2, K562's near genes down; tables and methods state the tests", async () => {
    const bt = nativeBedtools();
    const rt: Runtime = { bedtools: bt, refdata: { text: async (p) => read(`public/${p}`) }, scanMotifs: async () => { throw new Error("not used"); } };
    const item = (name: string, text: string): SummaryItem => ({ id: name, version: "1", name, color: "#000", getRawText: async () => text });
    try {
      const run = await runExpression(rt, { assembly: "hg38", groups: [item("HepG2", HEPG2), item("K562", K562)], deText: DE, settings: EXPRESSION_DEFAULTS });
      expect(run.table.nUp).toBeGreaterThan(1000);
      expect(run.table.nDown).toBeGreaterThan(1000);
      const [hep, k562] = run.groups;
      // BETA: up genes rank higher by HepG2 RP than static genes; K562's RP favours down genes (up in K562).
      expect(hep.beta.up.p).toBeLessThan(1e-10);
      expect(hep.beta.down.p).toBeGreaterThan(0.01);
      expect(k562.beta.down.p).toBeLessThan(1e-10);
      expect(k562.beta.up.p).toBeGreaterThan(0.01);
      // Nearest gene: HepG2's nearest genes have higher log2FC than the rest; K562's lower.
      expect(hep.nearest.medianLinked).toBeGreaterThan(hep.nearest.medianOther);
      expect(hep.nearest.p).toBeLessThan(1e-6);
      expect(k562.nearest.medianLinked).toBeLessThan(k562.nearest.medianOther);
      // Curves run over the genes with RP > 0 and end at each class's fraction with RP > 0; targets are up/down genes with RP > 0, best rank product first.
      expect(hep.curves.up[0][1]).toBe(0);
      expect(hep.curves.up.at(-1)![1]).toBeCloseTo(hep.targets.filter((t) => t.class === "up").length / hep.beta.up.n, 12);
      expect(hep.curves.up.at(-1)![1]).toBeGreaterThan(hep.curves.static.at(-1)![1]);
      expect(hep.targets[0].rankProduct).toBeLessThanOrEqual(hep.targets[1].rankProduct);
      expect(hep.targets.every((t) => t.rp > 0 && t.class !== "static")).toBe(true);
      expect(hep.targets.slice(0, 50).filter((t) => t.class === "up").length).toBeGreaterThan(40);

      const t = expressionTsvs(run);
      expect(t.beta.split("\n")[0]).toBe("group\tn_regions\tclass\tn_genes\tn_static\tks_D\tp\tq");
      expect(t.beta.trim().split("\n")).toHaveLength(5);
      expect(t.nearest.split("\n")[0]).toBe("group\tn_regions\tn_linked\tmedian_log2fc_linked\tmedian_log2fc_other\tU\tp\tq\tfrac_up_linked\tfrac_up_other\tfrac_down_linked\tfrac_down_other");
      expect(t.targets.split("\n")[0]).toBe("group\tgene_id\tgene_name\tclass\tlog2fc\tpadj\trp\trp_rank\tde_rank\trank_product\tn_regions_within");
      const m = expressionMethods({ assembly: "hg38", settings: run.settings, table: run.table }).methods;
      for (const re of [/100 kb/, /exp\(−\(0\.5 \+ 4/, /Kolmogorov–Smirnov/, /Mann–Whitney/, /padj < 0\.05/, /\|log2 fold change\| ≥ 1/, /Benjamini–Hochberg/]) expect(m).toMatch(re);
    } finally {
      bt.cleanup();
    }
  }, 60_000);

  it("says why it cannot run", async () => {
    const rt: Runtime = { bedtools: nativeBedtools(), refdata: { text: async (p) => read(`public/${p}`) }, scanMotifs: async () => { throw new Error("not used"); } };
    const g: SummaryItem = { id: "x", version: "1", name: "x", color: "#000", getRawText: async () => HEPG2 };
    await expect(runExpression(rt, { assembly: "hg38", groups: [g], deText: "gene\tbaseMean\nA\t1\n", settings: EXPRESSION_DEFAULTS })).rejects.toThrow(/log2 fold change/);
    await expect(runExpression(rt, { assembly: "hg38", groups: [g], deText: "gene\tlog2FoldChange\tpadj\nNOPE\t1\t0.01\n", settings: EXPRESSION_DEFAULTS })).rejects.toThrow(/None of the 1 genes/);
  });
});
