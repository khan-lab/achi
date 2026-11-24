/**
 * Expression near the selected regions (the Expression panel; the CLI's
 * --expression; MCP run_analysis expression): a differential-expression
 * table (DESeq2, edgeR, limma...) and, for each selected group of regions,
 * two tests of whether genes near the regions change in one direction.
 *
 * BETA-like (Wang et al. 2013, BETA basic), the main result:
 *   Every protein-coding gene (GENCODE, refdata/<asm>/genes_tss.bed) gets a
 *   regulatory potential from the group's regions,
 *     RP = Σ exp(−(0.5 + 4·d/D)) over region centres within D of its TSS
 *   (d = distance, D = 100 kb by default; BETA's score). Genes of the table
 *   are ranked by RP, highest first (ties share the average rank).
 *   H0 (activating): the RP ranks of up-regulated genes have the same
 *   distribution as those of non-differential genes; H0 (repressive): the
 *   same for down-regulated genes. One-sided two-sample Kolmogorov–Smirnov
 *   tests (alternative: up, or down, genes rank higher), asymptotic p.
 *   Target genes: up or down genes with RP > 0, by the rank product
 *   (RP rank / n) × (DE rank / n), DE rank by padj then |log2FC|.
 *
 * Nearest gene, a second view: each region's nearest protein-coding TSS
 * (bedtools closest -d -t all, as the Genes tab); H0: log2 fold changes of
 * those genes have the same distribution as those of all other genes of
 * the table; two-sided Mann–Whitney U test.
 *
 * The universe is the table's genes that match a GENCODE protein-coding
 * gene (Ensembl id, else symbol) and have both a log2 fold change and an
 * adjusted p-value. Benjamini–Hochberg q over all tests of the run.
 */
import { runNearestGenes } from "./geneList";
import { parseBed } from "./intervals";
import { abortIfCancelled, loadRefText, type Runtime } from "./runtime";
import { benjaminiHochberg, mannWhitneyU } from "./stats";
import type { MethodsExtra } from "./analysisExport";
import type { Interval, SummaryItem } from "./types";

// ---- settings ----

export interface ExpressionSettings {
  /** Up or down: adjusted p below this... */
  padj: number;
  /** ... and |log2 fold change| at least this. */
  minAbsLog2fc: number;
  /** Regions whose centre is within this distance of a TSS add to its regulatory potential (BETA: 100 kb). */
  distance: number;
}

export const EXPRESSION_DEFAULTS: ExpressionSettings = { padj: 0.05, minAbsLog2fc: 1, distance: 100_000 };

export function validateExpressionSettings(s: ExpressionSettings): string | null {
  if (!(s.padj > 0 && s.padj <= 1)) return "The adjusted p-value cut-off must be above 0 and at most 1.";
  if (!(s.minAbsLog2fc >= 0 && s.minAbsLog2fc <= 20)) return "The |log2 fold change| cut-off must be from 0 to 20.";
  if (!(Number.isInteger(s.distance) && s.distance >= 1000 && s.distance <= 1_000_000)) return "The distance must be a whole number of base pairs from 1,000 to 1,000,000.";
  return null;
}

// ---- the table ----

export interface DeRow {
  /** As in the table: an Ensembl id or a symbol. */
  id: string;
  /** A second gene column (gene_name, symbol), when the table has one. */
  name: string;
  log2fc: number;
  padj: number;
}

export interface DeTable {
  rows: DeRow[];
  /** The columns used, as named in the header ("(first column)" for an unnamed row-name column). */
  columns: { id: string; log2fc: string; padj: string };
  /** Rows without a log2 fold change or adjusted p-value (e.g. DESeq2's independent filtering), left out. */
  nMissing: number;
}

const LOG2FC = ["log2foldchange", "logfc", "log2fc", "avg_log2fc", "log2_fold_change", "log2(fc)", "log2fold_change"];
const PADJ = ["padj", "fdr", "adj.p.val", "p_val_adj", "qvalue", "q_value", "q.value", "adj_pval", "adj.pval", "p.adjust", "fdr_bh"];
const ID = ["gene_id", "geneid", "ensembl_gene_id", "ensembl_id", "ensembl", "id", "gene", "genes", "gene_name", "symbol", "gene_symbol", "x"];
const NAME = ["gene_name", "symbol", "gene_symbol", "genes", "gene", "external_gene_name"];
const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
const ENSEMBL = /^ENS[A-Z]*G\d+(\.\d+)?$/;

/** Reads a DE table: tab- or comma-separated, header row; finds the gene, log2 fold change and adjusted p columns by their usual names. */
export function parseDeTable(text: string): DeTable | { error: string } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) return { error: "The expression table is empty: it needs a header row and one row per gene." };
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const split = (l: string) => l.split(sep).map(unquote);
  let head = split(lines[0]);
  const firstRow = split(lines[1]);
  // R's write.table with row names: the header has one field fewer, or an empty first one.
  let rowNames = head[0] === "";
  if (head.length === firstRow.length - 1) {
    head = ["", ...head];
    rowNames = true;
  }
  const lower = head.map((h) => h.toLowerCase());
  const find = (names: string[], not: number[] = []) => {
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0 && !not.includes(i)) return i;
    }
    return -1;
  };
  const fc = find(LOG2FC);
  if (fc < 0) return { error: `The expression table has no log2 fold change column (looked for ${LOG2FC.slice(0, 4).join(", ")}...).` };
  const pa = find(PADJ);
  if (pa < 0) return { error: `The expression table has no adjusted p-value column (looked for ${PADJ.slice(0, 4).join(", ")}...).` };
  // The gene column: a named one holding Ensembl ids first, then any named one, then the first column.
  const candidates = ID.map((n) => lower.indexOf(n)).filter((i) => i >= 0 && i !== fc && i !== pa);
  const ensemblCol = candidates.find((i) => ENSEMBL.test(firstRow[i] ?? ""));
  const id = rowNames ? 0 : (ensemblCol ?? candidates[0] ?? 0);
  const nameCol = find(NAME, [id, fc, pa]);
  const rows: DeRow[] = [];
  let nMissing = 0;
  for (const l of lines.slice(1)) {
    const f = split(l);
    const log2fc = Number(f[fc]);
    const padj = Number(f[pa]);
    const gid = f[id] ?? "";
    if (!gid || f[fc] === "" || f[pa] === "" || !Number.isFinite(log2fc) || !Number.isFinite(padj)) {
      nMissing++;
      continue;
    }
    rows.push({ id: gid, name: nameCol >= 0 ? (f[nameCol] ?? "") : "", log2fc, padj });
  }
  return { rows, columns: { id: rowNames ? "(first column)" : head[id], log2fc: head[fc], padj: head[pa] }, nMissing };
}

// ---- genes ----

export interface GeneTss {
  chrom: string;
  tss: number;
  strand: string;
  symbol: string;
  /** Ensembl gene id with its version, as in genes_tss.bed. */
  id: string;
}

/** refdata/<asm>/genes_tss.bed: one protein-coding gene per line, name "SYMBOL|ENSG.version". */
export function parseGeneTss(text: string): GeneTss[] {
  const out: GeneTss[] = [];
  for (const l of text.split("\n")) {
    const f = l.split("\t");
    if (f.length < 4) continue;
    const [symbol, id] = f[3].split("|");
    out.push({ chrom: f[0], tss: Number(f[1]), strand: f[5] ?? ".", symbol, id: id ?? "" });
  }
  return out;
}

export interface MatchedGene {
  gene: GeneTss;
  log2fc: number;
  padj: number;
}

const noVersion = (id: string) => id.replace(/\.\d+$/, "");

/** The table's genes that are GENCODE protein-coding genes: by Ensembl id (any version), else by symbol (exact, then ignoring case); a symbol naming two genes is skipped. */
export function matchGenes(rows: DeRow[], genes: GeneTss[]): { matched: MatchedGene[]; unmatched: number; ambiguous: number; duplicates: number } {
  const byId = new Map(genes.map((g) => [noVersion(g.id), g]));
  const bySymbol = new Map<string, GeneTss | null>();
  const byUpper = new Map<string, GeneTss | null>();
  for (const g of genes) {
    bySymbol.set(g.symbol, bySymbol.has(g.symbol) ? null : g);
    const u = g.symbol.toUpperCase();
    byUpper.set(u, byUpper.has(u) ? null : g);
  }
  const symbol = (s: string): GeneTss | null | undefined => (bySymbol.has(s) ? bySymbol.get(s) : byUpper.get(s.toUpperCase()));
  const seen = new Set<string>();
  const matched: MatchedGene[] = [];
  let unmatched = 0;
  let ambiguous = 0;
  let duplicates = 0;
  for (const r of rows) {
    let g: GeneTss | null | undefined = ENSEMBL.test(r.id) ? byId.get(noVersion(r.id)) : undefined;
    if (g === undefined && r.name) g = symbol(r.name);
    if (g === undefined && !ENSEMBL.test(r.id)) g = symbol(r.id);
    if (g === null) {
      ambiguous++;
      continue;
    }
    if (!g) {
      unmatched++;
      continue;
    }
    if (seen.has(g.id)) {
      duplicates++;
      continue;
    }
    seen.add(g.id);
    matched.push({ gene: g, log2fc: r.log2fc, padj: r.padj });
  }
  return { matched, unmatched, ambiguous, duplicates };
}

export type GeneClass = "up" | "down" | "static";

export function classifyGenes(rows: { log2fc: number; padj: number }[], s: ExpressionSettings): GeneClass[] {
  return rows.map((r) => (r.padj < s.padj && r.log2fc >= s.minAbsLog2fc ? "up" : r.padj < s.padj && r.log2fc <= -s.minAbsLog2fc ? "down" : "static"));
}

// ---- regulatory potential ----

/** BETA's score of one region at distance d from a TSS: exp(−(0.5 + 4·d/D)). */
export const betaRp = (d: number, distance: number) => Math.exp(-(0.5 + (4 * d) / distance));

function centresByChrom(regions: Interval[]): Map<string, Float64Array> {
  const m = new Map<string, number[]>();
  for (const r of regions) {
    const c = Math.floor((r.start + r.end) / 2);
    const a = m.get(r.chrom);
    if (a) a.push(c);
    else m.set(r.chrom, [c]);
  }
  return new Map([...m].map(([k, v]) => [k, Float64Array.from(v).sort()]));
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function rpAndCounts(regions: Interval[], genes: GeneTss[], distance: number): { rp: Float64Array; n: Int32Array } {
  const centres = centresByChrom(regions);
  const rp = new Float64Array(genes.length);
  const n = new Int32Array(genes.length);
  genes.forEach((g, i) => {
    const c = centres.get(g.chrom);
    if (!c) return;
    let s = 0;
    let k = 0;
    for (let j = lowerBound(c, g.tss - distance); j < c.length && c[j] <= g.tss + distance; j++) {
      s += betaRp(Math.abs(c[j] - g.tss), distance);
      k++;
    }
    rp[i] = s;
    n[i] = k;
  });
  return { rp, n };
}

/** Each gene's regulatory potential from the regions (BETA). */
export function regulatoryPotential(regions: Interval[], genes: GeneTss[], distance: number): Float64Array {
  return rpAndCounts(regions, genes, distance).rp;
}

/** Ranks, 1 = the highest value; ties share the average rank. */
export function rankDescending(v: Float64Array): Float64Array {
  const order = Array.from(v.keys()).sort((a, b) => v[b] - v[a]);
  const ranks = new Float64Array(v.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && v[order[j + 1]] === v[order[i]]) j++;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) ranks[order[k]] = r;
    i = j + 1;
  }
  return ranks;
}

// ---- statistics ----

/**
 * One-sided two-sample Kolmogorov–Smirnov test, alternative "x is
 * stochastically smaller" (its CDF lies above y's): D⁺ = max(F_x − F_y)
 * over the pooled values (ties together), p = exp(−2·mn/(m+n)·D⁺²), the
 * asymptotic p of R's ks.test(x, y, alternative = "greater", exact = FALSE)
 * (R evaluates it as 1 − (1 − e^(−x)), which loses relative accuracy below
 * about 1e-15; e^(−x) is computed directly here).
 */
export function ksOneSided(x: number[], y: number[]): { D: number; p: number } {
  const m = x.length;
  const n = y.length;
  if (!m || !n) return { D: NaN, p: 1 };
  const a = Float64Array.from(x).sort();
  const b = Float64Array.from(y).sort();
  let i = 0;
  let j = 0;
  let D = 0;
  while (i < m || j < n) {
    const v = Math.min(i < m ? a[i] : Infinity, j < n ? b[j] : Infinity);
    while (i < m && a[i] === v) i++;
    while (j < n && b[j] === v) j++;
    D = Math.max(D, i / m - j / n);
  }
  return { D, p: Math.min(1, Math.exp(-2 * ((m * n) / (m + n)) * D * D)) };
}

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// ---- the analysis, as the web app, CLI and MCP server run it ----

export interface ExpressionTarget {
  geneId: string;
  symbol: string;
  class: GeneClass;
  log2fc: number;
  padj: number;
  rp: number;
  rpRank: number;
  deRank: number;
  rankProduct: number;
  /** Regions with their centre within the distance of the TSS. */
  nRegionsWithin: number;
}

export interface ExpressionGroupResult {
  id: string;
  name: string;
  nRegions: number;
  /** Genes with RP > 0. */
  nGenesWithRp: number;
  beta: { up: { n: number; D: number; p: number; q: number }; down: { n: number; D: number; p: number; q: number }; nStatic: number };
  /**
   * BETA's plot: the cumulative fraction of each class's genes (of all its
   * genes) among the top x of the genes with RP > 0 ranked by RP, at x = 0,
   * 1, ..., 100 %. Genes with RP 0 (no region within the distance) share
   * the bottom rank and are not drawn; at 100 % each curve gives the
   * fraction of its class with RP > 0.
   */
  curves: { up: [number, number][]; down: [number, number][]; static: [number, number][] };
  nearest: { nLinked: number; medianLinked: number; medianOther: number; U: number; p: number; q: number; fracUpLinked: number; fracUpOther: number; fracDownLinked: number; fracDownOther: number };
  /** Up and down genes with RP > 0, smallest rank product first. */
  targets: ExpressionTarget[];
}

export interface ExpressionTableSummary {
  columns: DeTable["columns"];
  nRows: number;
  nMissing: number;
  nMatched: number;
  nUnmatched: number;
  nAmbiguous: number;
  nDuplicates: number;
  nUp: number;
  nDown: number;
  nStatic: number;
}

export interface ExpressionRun {
  assembly: string;
  settings: ExpressionSettings;
  table: ExpressionTableSummary;
  groups: ExpressionGroupResult[];
}

export async function runExpression(
  rt: Runtime,
  req: { assembly: string; groups: SummaryItem[]; deText: string; settings: ExpressionSettings },
  o: { onProgress?: (p: { done: number; total: number; label: string; unit?: string }) => void; signal?: AbortSignal } = {}
): Promise<ExpressionRun> {
  const { assembly, settings } = req;
  const bad = validateExpressionSettings(settings);
  if (bad) throw new Error(bad);
  const de = parseDeTable(req.deText);
  if ("error" in de) throw new Error(de.error);
  const total = req.groups.length * 2 + 1;
  o.onProgress?.({ done: 0, total, label: "Matching genes", unit: "steps" });
  const genes = parseGeneTss(await loadRefText(rt, `refdata/${assembly}/genes_tss.bed`, `the ${assembly} gene TSSs`));
  const m = matchGenes(de.rows, genes);
  if (!m.matched.length)
    throw new Error(`None of the ${de.rows.length.toLocaleString("en-US")} genes in the expression table matched a protein-coding gene of GENCODE for ${assembly}; the table needs Ensembl gene ids or gene symbols of that assembly.`);
  const g = m.matched;
  const N = g.length;
  const cls = classifyGenes(g, settings);
  const lfc = g.map((x) => x.log2fc);
  // DE rank: padj ascending, then |log2FC| descending.
  const deOrder = Array.from(g.keys()).sort((a, b) => g[a].padj - g[b].padj || Math.abs(g[b].log2fc) - Math.abs(g[a].log2fc));
  const deRank = new Float64Array(N);
  deOrder.forEach((gi, r) => (deRank[gi] = r + 1));
  const index = new Map(g.map((x, i) => [x.gene.id, i]));
  const tssOfMatched = g.map((x) => x.gene);

  const nearestAll = await runNearestGenes(rt, assembly, req.groups, { signal: o.signal, onResult: (_, item) => o.onProgress?.({ done: req.groups.indexOf(item) + 1, total, label: `Nearest genes of ${item.name}`, unit: "steps" }) });

  type Unadjusted = Omit<ExpressionGroupResult, "beta" | "nearest"> & {
    beta: { up: { n: number; D: number; p: number }; down: { n: number; D: number; p: number }; nStatic: number };
    nearest: Omit<ExpressionGroupResult["nearest"], "q">;
  };
  const raw: Unadjusted[] = [];
  for (const [gi, item] of req.groups.entries()) {
    abortIfCancelled(o.signal);
    o.onProgress?.({ done: req.groups.length + gi + 1, total, label: `Regulatory potential of ${item.name}`, unit: "steps" });
    const regions = parseBed(await item.getRawText());
    const { rp, n } = rpAndCounts(regions, tssOfMatched, settings.distance);
    const rank = rankDescending(rp);
    const ranksOf = (c: GeneClass) => [...rank].filter((_, i) => cls[i] === c);
    const up = ranksOf("up");
    const down = ranksOf("down");
    const stat = ranksOf("static");
    const ksUp = ksOneSided(up, stat);
    const ksDown = ksOneSided(down, stat);
    const nPos = rp.filter((v) => v > 0).length;
    const curve = (r: number[]): [number, number][] => {
      const s = Float64Array.from(r).sort();
      return Array.from({ length: 101 }, (_, k) => {
        const t = (nPos * k) / 100;
        let lo = 0;
        let hi = s.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (s[mid] <= t) lo = mid + 1;
          else hi = mid;
        }
        return [k / 100, s.length ? lo / s.length : 0];
      });
    };
    // Nearest gene.
    const linked = new Set<number>();
    for (const a of nearestAll[gi]) {
      const i = index.get(a.geneId);
      if (i !== undefined) linked.add(i);
    }
    const lfcLinked = [...linked].map((i) => lfc[i]);
    const lfcOther = lfc.filter((_, i) => !linked.has(i));
    const mw = mannWhitneyU(lfcLinked, lfcOther);
    const frac = (idx: number[], c: GeneClass) => (idx.length ? idx.filter((i) => cls[i] === c).length / idx.length : NaN);
    const linkedIdx = [...linked];
    const otherIdx = Array.from(g.keys()).filter((i) => !linked.has(i));
    // Targets.
    const targets: ExpressionTarget[] = [];
    for (let i = 0; i < N; i++) {
      if (rp[i] <= 0 || cls[i] === "static") continue;
      targets.push({
        geneId: g[i].gene.id,
        symbol: g[i].gene.symbol,
        class: cls[i],
        log2fc: g[i].log2fc,
        padj: g[i].padj,
        rp: rp[i],
        rpRank: rank[i],
        deRank: deRank[i],
        rankProduct: (rank[i] / N) * (deRank[i] / N),
        nRegionsWithin: n[i],
      });
    }
    targets.sort((a, b) => a.rankProduct - b.rankProduct || b.rp - a.rp);
    raw.push({
      id: item.id,
      name: item.name,
      nRegions: regions.length,
      nGenesWithRp: nPos,
      beta: { up: { n: up.length, ...ksUp }, down: { n: down.length, ...ksDown }, nStatic: stat.length },
      curves: { up: curve(up), down: curve(down), static: curve(stat) },
      nearest: {
        nLinked: linked.size,
        medianLinked: median(lfcLinked),
        medianOther: median(lfcOther),
        U: mw.U,
        p: mw.p,
        fracUpLinked: frac(linkedIdx, "up"),
        fracUpOther: frac(otherIdx, "up"),
        fracDownLinked: frac(linkedIdx, "down"),
        fracDownOther: frac(otherIdx, "down"),
      },
      targets,
    });
  }
  const q = benjaminiHochberg(raw.flatMap((r) => [r.beta.up.p, r.beta.down.p, r.nearest.p]));
  const groups: ExpressionGroupResult[] = raw.map((r, i) => ({
    ...r,
    beta: { up: { ...r.beta.up, q: q[3 * i] }, down: { ...r.beta.down, q: q[3 * i + 1] }, nStatic: r.beta.nStatic },
    nearest: { ...r.nearest, q: q[3 * i + 2] },
  }));
  o.onProgress?.({ done: total, total, label: "Done", unit: "steps" });
  return {
    assembly,
    settings,
    table: {
      columns: de.columns,
      nRows: de.rows.length + de.nMissing,
      nMissing: de.nMissing,
      nMatched: N,
      nUnmatched: m.unmatched,
      nAmbiguous: m.ambiguous,
      nDuplicates: m.duplicates,
      nUp: cls.filter((c) => c === "up").length,
      nDown: cls.filter((c) => c === "down").length,
      nStatic: cls.filter((c) => c === "static").length,
    },
    groups,
  };
}

// ---- tables and methods ----

const tsvNum = (x: number) => (Number.isNaN(x) ? "NA" : x === Infinity ? "Inf" : x === -Infinity ? "-Inf" : String(x));
const row = (...v: (string | number)[]) => v.map((x) => (typeof x === "number" ? tsvNum(x) : x)).join("\t");

export function expressionTsvs(run: ExpressionRun): { beta: string; nearest: string; targets: string } {
  const beta = [
    row("group", "n_regions", "class", "n_genes", "n_static", "ks_D", "p", "q"),
    ...run.groups.flatMap((g) => (["up", "down"] as const).map((c) => row(g.name, g.nRegions, c, g.beta[c].n, g.beta.nStatic, g.beta[c].D, g.beta[c].p, g.beta[c].q))),
  ];
  const nearest = [
    row("group", "n_regions", "n_linked", "median_log2fc_linked", "median_log2fc_other", "U", "p", "q", "frac_up_linked", "frac_up_other", "frac_down_linked", "frac_down_other"),
    ...run.groups.map((g) => {
      const x = g.nearest;
      return row(g.name, g.nRegions, x.nLinked, x.medianLinked, x.medianOther, x.U, x.p, x.q, x.fracUpLinked, x.fracUpOther, x.fracDownLinked, x.fracDownOther);
    }),
  ];
  const targets = [
    row("group", "gene_id", "gene_name", "class", "log2fc", "padj", "rp", "rp_rank", "de_rank", "rank_product", "n_regions_within"),
    ...run.groups.flatMap((g) => g.targets.map((t) => row(g.name, t.geneId, t.symbol, t.class, t.log2fc, t.padj, t.rp, t.rpRank, t.deRank, t.rankProduct, t.nRegionsWithin))),
  ];
  return { beta: beta.join("\n") + "\n", nearest: nearest.join("\n") + "\n", targets: targets.join("\n") + "\n" };
}

export const EXPRESSION_REFS = {
  beta: "Wang S, Sun H, Ma J, Zang C, Wang C, Wang J, Tang Q, Meyer CA, Zhang Y, Liu XS. Target analysis by integration of transcriptome and ChIP-seq data with BETA. Nat Protoc. 2013;8(12):2502–2515. doi:10.1038/nprot.2013.150",
};

const kb = (bp: number) => (bp % 1000 === 0 ? `${bp / 1000} kb` : `${bp.toLocaleString("en-US")} bp`);

export function expressionMethods(r: { assembly: string; settings: ExpressionSettings; table: ExpressionTableSummary }): MethodsExtra {
  const s = r.settings;
  const t = r.table;
  return {
    methods:
      `Expression changes near the regions of each selected group were tested with a differential-expression table (columns ${t.columns.id}, ${t.columns.log2fc} and ${t.columns.padj}; ` +
      `${t.nMatched.toLocaleString("en-US")} of its ${t.nRows.toLocaleString("en-US")} genes matched a GENCODE protein-coding gene of ${r.assembly} by Ensembl id or symbol and had both values). ` +
      `Genes with padj < ${s.padj} and |log2 fold change| ≥ ${s.minAbsLog2fc} were called up (${t.nUp.toLocaleString("en-US")}) or down (${t.nDown.toLocaleString("en-US")}); the other ${t.nStatic.toLocaleString("en-US")} were non-differential. ` +
      `Following BETA, each gene's regulatory potential was the sum of exp(−(0.5 + 4d/${kb(s.distance)})) over the group's region centres within ${kb(s.distance)} of its TSS (d, the distance), genes were ranked by it (ties sharing the average rank), ` +
      `and the ranks of up genes and of down genes were each compared with those of non-differential genes by a one-sided two-sample Kolmogorov–Smirnov test (alternative: higher regulatory potential; asymptotic p). ` +
      `Separately, the log2 fold changes of the genes nearest to the group's regions (nearest TSS, bedtools closest -d -t all) were compared with those of all other matched genes by a two-sided Mann–Whitney U test (normal approximation with tie and continuity corrections). ` +
      `q-values are Benjamini–Hochberg over all tests of the run. Target genes are up or down genes with regulatory potential above 0, ranked by the product of their regulatory-potential rank and their differential-expression rank (padj, then |log2 fold change|), each divided by the number of genes.`,
    references: [EXPRESSION_REFS.beta],
  };
}
