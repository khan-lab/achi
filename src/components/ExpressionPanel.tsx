import { memo, useEffect, useRef, useState } from "react";
import { useChosenGroups, useStore } from "../state/store";
import { EXPRESSION_DEFAULTS, expressionMethods, expressionTsvs, parseDeTable, runExpression, type DeTable, type ExpressionGroupResult, type ExpressionRun } from "@achi/core/expression";
import { subsetToBedText } from "@achi/core/pipeline";
import { markExportStale, registerExport } from "../lib/exportRegistry";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { webRuntime } from "../lib/runtime";
import { PALETTE } from "../types";
import { ComputeOverlay, type ComputeProgress } from "./ComputeStatus";
import { NumField, SettingsShell } from "./GoEnrichmentPanel";
import { Icon } from "./Icon";
import { usePanelStatus } from "./panelState";
import { count, panelStatus } from "./panelStatus";

const INK = "#101826";
const INK_3 = "#8b97a9";
const GRID = "#e3e7ee";
const PAPER = "#ffffff";
const UP = "rgb(214,40,40)";
const DOWN = "rgb(43,74,224)";
const STATIC = "#7d8796";
const TARGET_ROWS = 25;
const EXAMPLE = "examples/expression/HepG2_vs_K562.deseq2.tsv";

interface Loaded {
  name: string;
  text: string;
  parsed: DeTable;
  example: boolean;
}
interface Shown {
  key: string;
  run: ExpressionRun;
  colors: string[];
  table: string;
}

// Survive the panel unmounting when the selection is cleared and re-made.
let lastTable: Loaded | null = null;
let lastResult: Shown | null = null;

const fmtP = (p: number) => (!Number.isFinite(p) ? "n/a" : p === 0 ? "< 1e-300" : p < 1e-3 ? p.toExponential(1) : p.toPrecision(2));
const fmtFc = (x: number) => (Number.isFinite(x) ? (x > 0 ? "+" : "") + x.toFixed(2) : "n/a");
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
const sig = (q: number) => (q < 0.001 ? " ***" : q < 0.01 ? " **" : q < 0.05 ? " *" : "");

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/tab-separated-values" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Expression near the selected subsets and sets: a DE table (DESeq2, edgeR,
 * limma) and, per group, BETA-like tests (regulatory potential ranks of up
 * and down genes against non-differential genes) and a nearest-gene
 * comparison of log2 fold changes. Runs in the browser; the table is not
 * uploaded.
 */
export function ExpressionPanel() {
  const assembly = useStore((s) => s.assembly);
  const subsets = useStore((s) => s.subsets);
  const mainStatus = useStore((s) => s.status);
  const settings = useStore((s) => s.expressionSettings);
  const setSettings = useStore((s) => s.setExpressionSettings);
  const chosen = useChosenGroups();
  const [table, setTable] = useState<Loaded | null>(lastTable);
  const [result, setResult] = useState<Shown | null>(lastResult);
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const busy = progress !== null;

  const universeSig = subsets.map((s) => `${s.mask}:${s.nRegions}:${s.nBp}`).join(",");
  const key = JSON.stringify([assembly, chosen.map((c) => `${c.mask}:${c.nRegions}`), universeSig, table ? `${table.name}:${table.text.length}` : null, settings]);
  const stale = result !== null && result.key !== key;
  useEffect(() => markExportStale("expression", stale), [stale]);
  const nSig = result ? result.run.groups.reduce((n, g) => n + [g.beta.up.q, g.beta.down.q, g.nearest.q].filter((q) => q < 0.05).length, 0) : 0;
  usePanelStatus(panelStatus({ progress, error, hasResult: result !== null, stale, done: `${count(nSig, "test")} q < 0.05` }));

  useEffect(
    () =>
      registerExport("expression", () => {
        if (!lastResult) return null;
        const t = expressionTsvs(lastResult.run);
        return {
          files: [
            { path: "tables/expression_beta.tsv", content: t.beta },
            { path: "tables/expression_nearest.tsv", content: t.nearest },
            { path: "tables/expression_targets.tsv", content: t.targets },
          ],
          methods: expressionMethods({ assembly: lastResult.run.assembly, settings: lastResult.run.settings, table: lastResult.run.table }),
        };
      }),
    []
  );
  useEffect(() => () => abortRef.current?.abort(), []);

  const load = (name: string, text: string, example: boolean) => {
    const parsed = parseDeTable(text);
    if ("error" in parsed) {
      setError(`${name}: ${parsed.error}`);
      return;
    }
    setError(null);
    lastTable = { name, text, parsed, example };
    setTable(lastTable);
  };
  const loadExample = async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${EXAMPLE}`);
      if (!res.ok) throw new Error(`the example table could not be loaded (${res.status})`);
      load("HepG2_vs_K562.deseq2.tsv", await res.text(), true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async () => {
    if (!table || !chosen.length) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setProgress({ done: 0, total: chosen.length * 2 + 1, label: "Matching genes", unit: "steps" });
    try {
      const groups = chosen.map((s, i) => ({ id: String(s.mask), version: `${s.mask}:${s.nRegions}:${s.nBp}`, name: s.label, color: PALETTE[i % PALETTE.length], getRawText: () => Promise.resolve(subsetToBedText(s)) }));
      const r = await runExpression(webRuntime, { assembly, groups, deText: table.text, settings }, { signal: abort.signal, onProgress: (p) => setProgress(p) });
      lastResult = { key, run: r, colors: groups.map((g) => g.color), table: table.name };
      setResult(lastResult);
      setActive(0);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === abort) setProgress(null);
    }
  };

  const d = EXPRESSION_DEFAULTS;
  const set = (patch: Partial<typeof settings>) => setSettings({ ...settings, ...patch });
  const nChanged = (Object.keys(d) as (keyof typeof d)[]).filter((k) => settings[k] !== d[k]).length;

  return (
    <div className={busy ? "annowrap busy" : "annowrap"} aria-busy={busy}>
      {busy && <ComputeOverlay label={progress!.label} progress={progress} />}
      <div className="permrow">
        <input
          ref={fileRef}
          type="file"
          accept=".tsv,.txt,.csv,.tab,text/tab-separated-values,text/csv"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) load(f.name, await f.text(), false);
          }}
        />
        <button className="ghost" onClick={() => fileRef.current?.click()} title="A table with one row per gene: gene id or symbol, log2 fold change and adjusted p-value (DESeq2, edgeR, limma). Read here; not uploaded.">
          {table ? "Choose another table…" : "Choose DE table…"}
        </button>
        {assembly === "hg38" && !table?.example && (
          <button className="ghost" onClick={() => void loadExample()} title="HepG2 vs K562, ENCODE total RNA-seq, DESeq2 (public/examples/expression)">
            Use example table
          </button>
        )}
        <button className="ghost" disabled={!table || busy || mainStatus === "running" || !chosen.length} onClick={() => void run()}>
          {result ? "Run again" : "Run expression test"}
        </button>
      </div>
      {table && (
        <div className="setinfo" style={{ margin: "0 0 8px" }}>
          <b>{table.name}</b> · {table.parsed.rows.length.toLocaleString("en-US")} genes with values
          {table.parsed.nMissing ? ` (${table.parsed.nMissing.toLocaleString("en-US")} without, left out)` : ""} · columns {table.parsed.columns.id}, {table.parsed.columns.log2fc}, {table.parsed.columns.padj}
          {table.example ? " · example: HepG2 vs K562, ENCODE total RNA-seq, DESeq2; positive log2FC = higher in HepG2" : ""}
        </div>
      )}
      <div className="hint" style={{ margin: "0 0 8px" }}>
        Are genes near each group's regions up- or down-regulated? BETA-like: every gene gets a regulatory potential from the group's regions within {settings.distance / 1000} kb of its TSS (closer counts more); up and down genes are each compared with
        non-differential genes by their rank (one-sided Kolmogorov–Smirnov). Nearest gene: log2 fold changes of the regions' nearest genes against all other genes (Mann–Whitney). The table stays in your browser.
      </div>
      <SettingsShell nChanged={nChanged} onReset={() => setSettings({ ...d })}>
        <NumField label="Adjusted p below" step={0.01} value={settings.padj} def={d.padj} min={1e-10} max={1} help="A gene is up or down when its adjusted p-value is below this and its |log2 fold change| is at least the next value." onChange={(v) => set({ padj: v })} />
        <NumField label="|log2 fold change| at least" step={0.5} value={settings.minAbsLog2fc} def={d.minAbsLog2fc} min={0} max={20} onChange={(v) => set({ minAbsLog2fc: v })} />
        <NumField label="Distance to TSS" scale={1000} unit="kb" value={settings.distance} def={d.distance} min={1000} max={1_000_000} help="Regions with their centre within this distance of a TSS add to its regulatory potential (BETA: 100 kb)." onChange={(v) => set({ distance: Math.round(v) })} />
      </SettingsShell>
      {error && <div className="hint error">{error}</div>}
      {stale && !busy && <div className="setinfo" style={{ marginBottom: 8 }}>Table, selection or settings changed since this result. Press Run again to update it.</div>}
      {result && <ResultView shown={result} active={Math.min(active, result.run.groups.length - 1)} onSelect={setActive} stale={stale} />}
    </div>
  );
}

const ResultView = memo(function ResultView({ shown, active, onSelect, stale }: { shown: Shown; active: number; onSelect: (i: number) => void; stale: boolean }) {
  const { run, colors } = shown;
  const t = run.table;
  const g = run.groups[active];
  const svgRef = useRef<SVGSVGElement | null>(null);
  const tsv = expressionTsvs(run);
  return (
    <div className={stale ? "stale" : undefined}>
      <div className="setinfo" style={{ margin: "0 0 8px" }}>
        {t.nMatched.toLocaleString("en-US")} of {t.nRows.toLocaleString("en-US")} genes matched protein-coding genes ({run.assembly}): {t.nUp.toLocaleString("en-US")} up, {t.nDown.toLocaleString("en-US")} down (adjusted p &lt; {run.settings.padj}, |log2FC| ≥ {run.settings.minAbsLog2fc}),{" "}
        {t.nStatic.toLocaleString("en-US")} non-differential.
        {t.nUnmatched + t.nAmbiguous ? ` ${(t.nUnmatched + t.nAmbiguous).toLocaleString("en-US")} not matched (non-coding, other ids, or a symbol naming two genes).` : ""}
      </div>
      <div className="regions-scroll" style={{ marginBottom: 10 }}>
        <table className="subtable" aria-label="Expression tests per group">
          <thead>
            <tr>
              <th>Group</th>
              <th title="Regions in the group">Regions</th>
              <th title="BETA-like: up genes rank higher by regulatory potential than non-differential genes (one-sided KS)">Up genes · BETA</th>
              <th title="BETA-like: down genes rank higher by regulatory potential than non-differential genes (one-sided KS)">Down genes · BETA</th>
              <th title="Median log2 fold change of the regions' nearest genes, and of all other genes; Mann–Whitney p">Nearest genes · log2FC</th>
            </tr>
          </thead>
          <tbody>
            {run.groups.map((x, i) => (
              <tr key={x.id} className={i === active ? "sel" : undefined} onClick={() => onSelect(i)} style={{ cursor: "pointer" }}>
                <td>
                  <span className="swatch" style={{ background: colors[i], marginRight: 6 }} />
                  {x.name}
                </td>
                <td className="mono">{x.nRegions.toLocaleString("en-US")}</td>
                <td className="mono">
                  p {fmtP(x.beta.up.p)}, q {fmtP(x.beta.up.q)}
                  {sig(x.beta.up.q)}
                </td>
                <td className="mono">
                  p {fmtP(x.beta.down.p)}, q {fmtP(x.beta.down.q)}
                  {sig(x.beta.down.q)}
                </td>
                <td className="mono">
                  {fmtFc(x.nearest.medianLinked)} vs {fmtFc(x.nearest.medianOther)}, q {fmtP(x.nearest.q)}
                  {sig(x.nearest.q)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tabs wrap" role="tablist" aria-label="Group" style={{ marginBottom: 8 }}>
        {run.groups.map((x, i) => (
          <button key={x.id} className="tab" role="tab" aria-selected={i === active} onClick={() => onSelect(i)}>
            <span className="swatch" style={{ background: colors[i], marginRight: 6 }} />
            {x.name}
          </button>
        ))}
      </div>
      <BetaPlot g={g} svgRef={svgRef} title={`${g.name}: genes ranked by regulatory potential`} maxDistance={run.settings.distance} />
      <div className="setinfo" style={{ margin: "4px 0 8px" }}>
        Nearest genes of {g.name}: {g.nearest.nLinked.toLocaleString("en-US")} genes, {pct(g.nearest.fracUpLinked)} up and {pct(g.nearest.fracDownLinked)} down, against {pct(g.nearest.fracUpOther)} and {pct(g.nearest.fracDownOther)} of all other genes.
      </div>
      <div className="plotactions">
        <button className="iconbtn" title="Download the BETA-like tests of every group as TSV" onClick={() => download("achi-expression-beta.tsv", tsv.beta)}>
          <Icon name="download" />
        </button>
        <button className="iconbtn" title="Download the nearest-gene tests of every group as TSV" onClick={() => download("achi-expression-nearest.tsv", tsv.nearest)}>
          Nearest TSV
        </button>
        <button className="iconbtn" title="Download the target genes (up or down, with regulatory potential) of every group as TSV" onClick={() => download("achi-expression-targets.tsv", tsv.targets)}>
          Targets TSV
        </button>
        <button className="iconbtn" title="Export SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, "achi-expression-beta.svg")}>
          SVG
        </button>
        <button className="iconbtn" title="Export PNG" onClick={() => svgRef.current && void downloadPng(svgRef.current, "achi-expression-beta.png")}>
          PNG
        </button>
      </div>
      <div className="regions-scroll" style={{ maxHeight: 320, marginTop: 8 }}>
        <table className="subtable" aria-label={`Target genes of ${g.name}`}>
          <thead>
            <tr>
              <th>Gene</th>
              <th>Class</th>
              <th>log2FC</th>
              <th>adj. p</th>
              <th title="Regulatory potential (BETA) and its rank among all genes">RP (rank)</th>
              <th title={`Regions with their centre within ${run.settings.distance / 1000} kb of the TSS`}>Regions</th>
              <th title="(RP rank / n) × (DE rank / n); smaller = stronger target">Rank product</th>
            </tr>
          </thead>
          <tbody>
            {g.targets.slice(0, TARGET_ROWS).map((x) => (
              <tr key={x.geneId}>
                <td>
                  {x.symbol} <span className="setinfo mono">{x.geneId}</span>
                </td>
                <td style={{ color: x.class === "up" ? UP : DOWN }}>{x.class}</td>
                <td className="mono">{fmtFc(x.log2fc)}</td>
                <td className="mono">{fmtP(x.padj)}</td>
                <td className="mono">
                  {x.rp.toFixed(3)} ({Math.round(x.rpRank).toLocaleString("en-US")})
                </td>
                <td className="mono">{x.nRegionsWithin}</td>
                <td className="mono">{x.rankProduct.toExponential(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="setinfo">
        {g.targets.length.toLocaleString("en-US")} target genes (up or down, with regulatory potential above 0); the first {Math.min(TARGET_ROWS, g.targets.length)} shown, all in Targets TSV and Export analysis.
      </div>
    </div>
  );
});

/** BETA's plot: cumulative fraction of up, down and non-differential genes against genes ranked by regulatory potential. */
function BetaPlot({ g, svgRef, title, maxDistance }: { g: ExpressionGroupResult; svgRef: React.RefObject<SVGSVGElement | null>; title: string; maxDistance: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 280;
  const m = { l: 52, r: 150, t: 28, b: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  // The y axis up to the highest curve, rounded up to a tenth: at 100 % each curve is its class's fraction with RP > 0.
  const top = Math.max(0.1, Math.ceil(Math.max(...[g.curves.up, g.curves.down, g.curves.static].map((c) => c.at(-1)![1])) * 10) / 10);
  const x = (f: number) => m.l + f * iw;
  const y = (f: number) => m.t + (1 - f / top) * ih;
  const series = [
    { key: "up", label: "Up", color: UP, pts: g.curves.up, n: g.beta.up.n, p: g.beta.up.p, dash: undefined },
    { key: "down", label: "Down", color: DOWN, pts: g.curves.down, n: g.beta.down.n, p: g.beta.down.p, dash: undefined },
    { key: "static", label: "Non-differential", color: STATIC, pts: g.curves.static, n: g.beta.nStatic, p: NaN, dash: "5 4" },
  ];
  const path = (pts: [number, number][]) => pts.map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join("");
  const hi = hover === null ? null : Math.round(hover * 100);
  return (
    <div style={{ position: "relative", overflowX: "auto" }}>
      <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} fontFamily="Inter Tight, system-ui, sans-serif">
        <rect width={W} height={H} fill={PAPER} />
        <text x={m.l} y={16} fontSize={12} fill={INK} fontWeight={600}>
          {title}
        </text>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={m.l} x2={m.l + iw} y1={y(v * top)} y2={y(v * top)} stroke={GRID} />
            <text x={m.l - 6} y={y(v * top) + 4} fontSize={10} fill={INK_3} textAnchor="end">
              {`${Math.round(v * top * 1000) / 10}%`}
            </text>
            <text x={x(v)} y={m.t + ih + 16} fontSize={10} fill={INK_3} textAnchor="middle">
              {`${v * 100}%`}
            </text>
          </g>
        ))}
        <text x={m.l + iw / 2} y={H - 6} fontSize={11} fill={INK} textAnchor="middle">
          {`The ${g.nGenesWithRp.toLocaleString("en-US")} genes with a region within ${(maxDistance / 1000).toLocaleString("en-US")} kb, ranked by regulatory potential`}
        </text>
        <text transform={`translate(13 ${m.t + ih / 2}) rotate(-90)`} fontSize={11} fill={INK} textAnchor="middle">
          Cumulative fraction of each class
        </text>
        {series.map((s) => (
          <path key={s.key} d={path(s.pts)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" />
        ))}
        {/* Legend, which doubles as the direct labels, with each test's p. */}
        {series.map((s, i) => (
          <g key={s.key} transform={`translate(${m.l + iw + 14} ${m.t + 8 + i * 34})`}>
            <line x1={0} x2={18} y1={0} y2={0} stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} />
            <text x={24} y={4} fontSize={11} fill={INK}>
              {s.label} ({s.n.toLocaleString("en-US")})
            </text>
            {Number.isFinite(s.p) && (
              <text x={24} y={18} fontSize={10} fill={INK_3}>
                KS p = {fmtP(s.p)}
              </text>
            )}
          </g>
        ))}
        {hi !== null && (
          <g pointerEvents="none">
            <line x1={x(hi / 100)} x2={x(hi / 100)} y1={m.t} y2={m.t + ih} stroke={INK_3} strokeDasharray="2 3" />
            {series.map((s) => (
              <circle key={s.key} cx={x(hi / 100)} cy={y(s.pts[hi][1])} r={4} fill={PAPER} stroke={s.color} strokeWidth={2} />
            ))}
          </g>
        )}
        <rect
          x={m.l}
          y={m.t}
          width={iw}
          height={ih}
          fill="transparent"
          onPointerMove={(e) => {
            const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
            setHover(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
          }}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hi !== null && (
        <div className="sp-tip" style={{ left: x(hi / 100) + (hi > 50 ? -10 : 10), top: m.t, transform: hi > 50 ? "translateX(-100%)" : undefined }}>
          <div>
            <b>Top {hi}%</b> of the genes with regulatory potential hold
          </div>
          {series.map((s) => (
            <div key={s.key}>
              <span className="swatch" style={{ background: s.color, marginRight: 6 }} />
              {pct(s.pts[hi][1])} of {s.label.toLowerCase()} genes
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
