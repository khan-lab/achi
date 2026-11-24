/**
 * GO enrichment of selected groups, as the web app, CLI and MCP server run
 * it: the GREAT-like test (great.ts; against the genome, or against the
 * other regions of the analysis) or the Cistrome-GO-like test
 * (cistromeGo.ts), with the rows, TSV and one-line summaries every layer
 * shows. Reference data (GO annotation, gaps, chromosome sizes, the
 * Cistrome-GO gene model) is read through the runtime and prepared once per
 * reference-data source.
 */
import {
  CISTROMEGO_DEFAULTS,
  cistromeGoTestAsync,
  prepareCistromeGo,
  type CgoPeak,
  type CistromeGoSettings,
  type PreparedCistromeGo,
  type RpModel,
} from "./cistromeGo";
import { GO_NAMESPACES, GREAT_DEFAULTS, assignRegions, greatTest, inputsGoTest, prepareGreat, type GoData, type GoNamespace, type GreatSettings, type PreparedGreat } from "./great";
import { parseChromSizes } from "./inputValidation";
import { abortIfCancelled, loadRefText, onceFor, yieldToEventLoop, type Runtime } from "./runtime";
import { inGroup } from "./selection";
import type { Interval } from "./types";

export type GoMethod = "great" | "cistromego";
export type GoBackground = "inputs" | "genome";
/** GREAT's settings plus the background it is tested against (default genome, as in GREAT). */
export type GreatRunSettings = GreatSettings & { background: GoBackground };
export const GREAT_RUN_DEFAULTS: GreatRunSettings = { ...GREAT_DEFAULTS, background: "genome" };
export { CISTROMEGO_DEFAULTS };

/** One selected group: a subset (mask >= 1) or a whole set (negative key, selection.ts). */
export interface GoGroup {
  mask: number;
  label: string;
  regions: Interval[];
  /** A whole input set, tested as the subsets it is a member of. */
  whole?: boolean;
  /** Cistrome-GO: the BED text of the group's first set, whose column 5 gives the peak scores (peaksWithScores). */
  scoreSource?: string;
}

export interface GoRow {
  id: string;
  name: string;
  /** q of the test that ranks terms (binomial vs. genome, Fisher vs. input sets, XL-mHG for Cistrome-GO). */
  q: number;
  fold: number;
  significant: boolean;
  /** Cistrome-GO: the leading genes. */
  genes?: string[];
  /** One line describing the test result, as shown under the term. */
  detail: string;
  /** The row's TSV fields after the group label (GoRun.tsvHead). */
  tsv: (string | number)[];
}

export interface GoGroupResult {
  mask: number;
  label: string;
  rows: GoRow[];
  summary: string;
}

export interface GoRun {
  method: GoMethod;
  background: GoBackground;
  ns: GoNamespace;
  qThreshold: number;
  tsvHead: string[];
  groups: GoGroupResult[];
  /** The settings it ran with, for the methods text. */
  settings: GreatRunSettings | CistromeGoSettings;
}

export interface GoRequest {
  method: GoMethod;
  ns: GoNamespace;
  assembly: string;
  groups: GoGroup[];
  /** Every subset of the analysis: the background of the GREAT-like test against the input sets. */
  allSubsets: { mask: number; regions: Interval[] }[];
  great: GreatRunSettings;
  cgo: CistromeGoSettings;
}

export interface GoProgress {
  done: number;
  total: number;
  label: string;
  unit: string;
}

export const fmtP = (p: number) => (p === 0 ? "<1e-300" : p < 0.001 ? p.toExponential(1) : p.toPrecision(2));
export const fmtFold = (f: number) => (!Number.isFinite(f) ? (f > 0 ? "∞" : "n/a") : f >= 10 ? f.toFixed(0) : f.toFixed(2));
export const fmtKb = (bp: number) => (bp >= 1000 ? `${(bp / 1000).toLocaleString()} kb` : `${bp} bp`);
export const goNamespaceLabel = (ns: GoNamespace) => GO_NAMESPACES.find((n) => n.id === ns)!.label;

// ---- reference data, prepared once per reference-data source ----

function loadGo(rt: Runtime, assembly: string) {
  return onceFor(rt.refdata, `go:${assembly}`, async () => {
    const what = `GO data for ${assembly}`;
    const [go, gaps, sizes] = await Promise.all([
      loadRefText(rt, `refdata/${assembly}/go/go.json`, what),
      loadRefText(rt, `refdata/${assembly}/go/gaps.bed`, what),
      loadRefText(rt, `refdata/${assembly}/${assembly}.chrom.sizes`, what),
    ]);
    return { go: JSON.parse(go) as GoData, sizes: parseChromSizes(sizes), gaps };
  });
}

/** Each term's annotated genes (indices into the GO data's gene list), for grouping similar terms (goCompare.ts). */
export async function goTermGenes(rt: Runtime, assembly: string, ns: GoNamespace): Promise<Map<string, number[]>> {
  const { go } = await loadGo(rt, assembly);
  return new Map(go.terms[ns].map(([id, , genes]) => [id, genes]));
}

function loadGreat(rt: Runtime, assembly: string, s: GreatSettings): Promise<PreparedGreat> {
  return onceFor(rt.refdata, `great:${[assembly, s.upstream, s.downstream, s.maxExtension].join("|")}`, async () => {
    const { go, sizes, gaps } = await loadGo(rt, assembly);
    return prepareGreat(go, sizes, gaps, s);
  });
}

function loadCistromeGo(rt: Runtime, assembly: string): Promise<PreparedCistromeGo> {
  return onceFor(rt.refdata, `cistromego:${assembly}`, async () => {
    const [{ go }, model] = await Promise.all([loadGo(rt, assembly), loadRefText(rt, `refdata/${assembly}/cistromego/rp_model.json`, `the Cistrome-GO gene model for ${assembly}`)]);
    return prepareCistromeGo(JSON.parse(model) as RpModel, go);
  });
}

/**
 * A group's regions as Cistrome-GO peaks. Regions come from the
 * combination's first set; column 5 of that set's file is the peak score
 * when every line has a numeric one (narrowPeak), as Cistrome-GO requires.
 */
export function peaksWithScores(regions: Interval[], setText: string | undefined): CgoPeak[] {
  if (setText === undefined) return regions;
  const scores = new Map<string, number[]>();
  for (const line of setText.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    const score = f.length >= 5 && f[4] !== "" ? Number(f[4]) : NaN;
    if (!Number.isFinite(score)) return regions;
    const key = `${f[0]}\t${f[1]}\t${f[2]}`;
    const list = scores.get(key);
    if (list) list.push(score);
    else scores.set(key, [score]);
  }
  return regions.map((r) => ({ ...r, score: scores.get(`${r.chrom}\t${r.start}\t${r.end}`)?.shift() }));
}

// ---- the run ----

export async function runGoEnrichment(rt: Runtime, req: GoRequest, o: { onProgress?: (p: GoProgress) => void; signal?: AbortSignal } = {}): Promise<GoRun> {
  const { ns, groups } = req;
  abortIfCancelled(o.signal);
  if (req.method === "great") return runGreat(rt, req, o);

  const cgo = req.cgo;
  const q = cgo.qThreshold;
  const prepared = await loadCistromeGo(rt, req.assembly);
  o.onProgress?.({ done: 0, total: groups.length, unit: "subsets done", label: `Preparing ${goNamespaceLabel(ns).toLowerCase()} terms${cgo.dedup ? " (removing redundant terms)" : ""}` });
  await yieldToEventLoop();
  prepared.terms(ns, cgo); // warm the redundancy filter (cached per namespace) while the label above shows
  const out: GoGroupResult[] = [];
  for (const [i, s] of groups.entries()) {
    abortIfCancelled(o.signal);
    o.onProgress?.({ done: i, total: groups.length, unit: "subsets done", label: `${s.label}: regulatory potential and gene ranking` });
    await yieldToEventLoop();
    const res = await cistromeGoTestAsync(prepared, peaksWithScores(s.regions, s.scoreSource), ns, cgo, (d, n) =>
      o.onProgress?.({ done: i + d / n, total: groups.length, unit: "subsets done", label: `${s.label}: XL-mHG test, ${d.toLocaleString()} of ${n.toLocaleString()} GO terms` })
    );
    const rows: GoRow[] = res.rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        q: r.q,
        fold: r.fold,
        significant: r.q < q,
        genes: r.leadGenes,
        detail: `${r.k} of ${r.K} term genes in the top ${r.cutoff.toLocaleString()} of ${r.N.toLocaleString()} genes · XL-mHG p ${fmtP(r.p)} · q ${fmtP(r.q)}`,
        tsv: [r.id, r.name, r.K, r.N, r.L, r.cutoff, r.k, r.fold, r.stat, r.p, r.q, r.q < q ? "yes" : "no", r.leadGenes.join(",")],
      }))
      .sort((x, y) => x.q - y.q || y.fold - x.fold);
    const nSig = rows.filter((r) => r.significant).length;
    const auto = cgo.decay === "auto" ? ` (auto: ${Math.round(100 * Math.max(...Object.values(res.fractions)))}% of peaks within 1 kb of a TSS)` : "";
    const peaks = res.scored ? `top ${res.nPeaksUsed.toLocaleString()} peaks by score` : `all ${res.nPeaksUsed.toLocaleString()} regions (no score column)`;
    const summary = `${nSig} term${nSig === 1 ? "" : "s"} with q < ${q} · half-decay ${fmtKb(res.decay)}${auto} · ${peaks} · ${res.ranking.nPositive.toLocaleString()} genes with adjusted RP > 0 · L = ${res.ranking.L.toLocaleString()}`;
    out.push({ mask: s.mask, label: s.label, rows, summary });
  }
  return {
    method: "cistromego",
    background: req.great.background,
    ns,
    qThreshold: q,
    tsvHead: ["subset", "go_id", "term", "term_genes", "ranked_genes", "L", "cutoff", "term_genes_above_cutoff", "fold", "mhg_stat", "p", "q", "significant", "leading_genes"],
    groups: out,
    settings: { ...cgo },
  };
}

async function runGreat(rt: Runtime, req: GoRequest, o: { onProgress?: (p: GoProgress) => void; signal?: AbortSignal }): Promise<GoRun> {
  const { ns, groups, great } = req;
  const background = great.background;
  const q = great.qThreshold;
  const total = groups.length + 1;
  const prepared = await loadGreat(rt, req.assembly, great);
  const nTerms = prepared.data.terms[ns].filter((t) => t[2].length >= great.minGenes && t[2].length <= great.maxGenes).length;
  let universeGenes: (number[] | null)[] | null = null;
  let owner: Int32Array | null = null;
  if (background === "inputs") {
    owner = Int32Array.from(req.allSubsets.flatMap((s) => s.regions.map(() => s.mask)));
    universeGenes = assignRegions(
      req.allSubsets.flatMap((s) => s.regions),
      prepared
    );
  }
  const tsvHead =
    background === "genome"
      ? ["subset", "go_id", "term", "regions_hit", "regions", "genome_fraction", "binom_fold", "binom_p", "binom_q", "genes_hit", "genes_selected", "term_genes", "genes", "hyper_fold", "hyper_p", "hyper_q", "significant"]
      : ["subset", "go_id", "term", "term_genes", "subset_hit", "subset_no_hit", "rest_hit", "rest_no_hit", "odds_ratio", "p", "q", "significant"];
  const out: GoGroupResult[] = [];
  for (const [i, s] of groups.entries()) {
    abortIfCancelled(o.signal);
    o.onProgress?.({ done: i + 1, total, unit: "steps", label: `${s.label}: testing ${nTerms.toLocaleString()} GO terms` });
    await yieldToEventLoop();
    let rows: GoRow[];
    let n = 0;
    if (background === "genome") {
      rows = greatTest(prepared, assignRegions(s.regions, prepared), ns, great).map((r) => {
        n = r.n;
        return {
          id: r.id,
          name: r.name,
          q: r.binomQ,
          fold: r.binomFold,
          significant: r.significant,
          detail: `${r.k.toLocaleString()} of ${r.n.toLocaleString()} regions (expected ${(r.n * r.fraction).toFixed(1)}) · binomial q ${fmtP(r.binomQ)} · ${r.j} of ${r.m.toLocaleString()} genes, hypergeometric q ${fmtP(r.hyperQ)}`,
          tsv: [r.id, r.name, r.k, r.n, r.fraction, r.binomFold, r.binomP, r.binomQ, r.j, r.m, r.K, r.N, r.hyperFold, r.hyperP, r.hyperQ, r.significant ? "yes" : "no"],
        };
      });
    } else {
      rows = inputsGoTest(prepared, universeGenes!, owner!, s.mask, ns, great).map((r) => {
        const [a, b, c, d] = r.table;
        const significant = r.q < q && r.oddsRatio > 1;
        return {
          id: r.id,
          name: r.name,
          q: r.q,
          fold: r.oddsRatio,
          significant,
          detail: `${a.toLocaleString()} of ${(a + b).toLocaleString()} subset regions vs ${c.toLocaleString()} of ${(c + d).toLocaleString()} other regions · odds ratio ${fmtFold(r.oddsRatio)} · q ${fmtP(r.q)}`,
          tsv: [r.id, r.name, r.K, a, b, c, d, r.oddsRatio, r.p, r.q, significant ? "yes" : "no"],
        };
      });
    }
    // Enriched terms first, by q; depletion is reported in the TSV but not ranked here.
    rows.sort((x, y) => Number(y.fold > 1) - Number(x.fold > 1) || x.q - y.q);
    const nSig = rows.filter((r) => r.significant).length;
    const rule = `${fmtKb(great.upstream)} up, ${fmtKb(great.downstream)} down, up to ${fmtKb(great.maxExtension)}`;
    const summary =
      background === "genome"
        ? `${nSig} significant term${nSig === 1 ? "" : "s"} (binomial and hypergeometric q < ${q}, fold ≥ ${great.minFold}) · ${n.toLocaleString()} regions · domains ${rule}`
        : (() => {
            // A whole set is tested as the subsets it is a member of (each locus once): count those, not the set's own regions.
            const nS = owner!.reduce((k, x) => k + (inGroup(x, s.mask) ? 1 : 0), 0);
            return `${nSig} significant term${nSig === 1 ? "" : "s"} (q < ${q}, enriched) · ${nS.toLocaleString()} ${s.whole ? "regions of the set's subsets" : "subset regions"} vs ${(owner!.length - nS).toLocaleString()} others · domains ${rule}`;
          })();
    out.push({ mask: s.mask, label: s.label, rows, summary });
  }
  return { method: "great", background, ns, qThreshold: q, tsvHead, groups: out, settings: { ...great } };
}

/** Every group of a run (or the one with `onlyMask`) as TSV: the download, and what the analysis export takes. */
export function goTsv(run: GoRun, onlyMask?: number): string {
  const groups = onlyMask === undefined ? run.groups : run.groups.filter((g) => g.mask === onlyMask);
  return [run.tsvHead.join("\t"), ...groups.flatMap((g) => g.rows.map((row) => [g.label, ...row.tsv].join("\t")))].join("\n") + "\n";
}

/** File name stem of a run's downloads, e.g. achi-go-BP-greatlike-genome. */
export const goFileStem = (run: Pick<GoRun, "method" | "background" | "ns">) => `achi-go-${run.ns}-${run.method === "great" ? `greatlike-${run.background}` : "cistromegolike"}`;
