import { useEffect, useRef, useState } from "react";
import { SelectFirstHint } from "./CollapsiblePanel";
import { usePanelStatus } from "./panelState";
import { count, panelStatus } from "./panelStatus";
import { color as d3color, interpolateLab } from "d3";
import { useChosenGroups, useStore } from "../state/store";
import { chosenGroups } from "@achi/core/selection";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, truncateToWidth } from "../lib/textMeasure";
import { referenceSetTsv, runReferenceSetEnrichment, testableAnnotations, type EnrichmentCell } from "@achi/core/subsetEnrichment";
import type { ExternalAnnotation } from "@achi/core/externalAnnotations";
import { ComputeOverlay, type ComputeProgress } from "./ComputeStatus";
import { Icon } from "./Icon";
import { TopRowsInput } from "./TopRowsInput";
import { DEFAULT_TOP_ROWS, rankRows } from "@achi/core/heatmapRows";
import { markExportStale, registerExport } from "../lib/exportRegistry";
import { enrichmentMethods } from "@achi/core/analysisExport";
import { webRuntime } from "../lib/runtime";

// Concrete colours so exported SVG/PNG render without this page's CSS.
const INK = "#101826";
const INK_3 = "#8b97a9";
/** The heatmap frame (as the signal heatmaps). */
const AXIS = "#3a4250";
const PAPER = "#ffffff";
const NA_FILL = "#f4f5f7";
// Diverging blue <-> red with a grey midpoint (dataviz reference palette),
// interpolated in Lab so equal steps look equal.
const DEPLETED = "#2a78d6";
const NEUTRAL = "#f0efec";
const ENRICHED = "#e34948";
const LOG2_CLIP = 3;

const CELL_W = 40;
const CELL_H = 24;
const PAD = 10;
const LABEL_FONT = 11.5;
const ROW_LABEL_MAX_W = 140;
const COL_LABEL_MAX_W = 150;

function cellColor(or: number): string {
  if (Number.isNaN(or)) return NA_FILL;
  const v = Math.max(-LOG2_CLIP, Math.min(LOG2_CLIP, Math.log2(or))) / LOG2_CLIP;
  return v < 0 ? interpolateLab(NEUTRAL, DEPLETED)(-v) : interpolateLab(NEUTRAL, ENRICHED)(v);
}
/** White text on dark cells, ink on light ones. */
function textOn(fill: string): string {
  const c = d3color(fill)?.rgb();
  if (!c) return INK;
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 140 ? "#ffffff" : INK;
}
function stars(q: number): string {
  return q < 0.001 ? "***" : q < 0.01 ? "**" : q < 0.05 ? "*" : "";
}
function fmtOr(or: number): string {
  if (Number.isNaN(or)) return "n/a";
  if (or === Infinity) return "∞";
  if (or === 0) return "0";
  return or >= 10 ? or.toFixed(0) : or >= 1 ? or.toFixed(1) : or.toFixed(2);
}
function fmtP(p: number): string {
  if (p === 0) return "<1e-300";
  return p < 0.001 ? p.toExponential(1) : p.toPrecision(2);
}

interface RunResult {
  key: string;
  adjust: boolean;
  masks: number[];
  annotations: ExternalAnnotation[];
  cells: EnrichmentCell[];
}

// Survives the panel unmounting when the selection is cleared and re-made.
let lastResult: RunResult | null = null;
let lastTop = DEFAULT_TOP_ROWS;

export function SubsetEnrichmentPanel() {
  const subsets = useStore((s) => s.subsets);
  const sets = useStore((s) => s.sets);
  const assembly = useStore((s) => s.assembly);
  const mainStatus = useStore((s) => s.status);
  const [adjust, setAdjust] = useState(lastResult?.adjust ?? true);
  const [top, setTopState] = useState(lastTop);
  const setTop = (n: number) => ((lastTop = n), setTopState(n));
  const [result, setResult] = useState<RunResult | null>(lastResult);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const chosen = useChosenGroups();
  const annotations = testableAnnotations(assembly, sets);
  // Reference sets left out because they are analysed input sets.
  const skipped = testableAnnotations(assembly, []).filter((a) => !annotations.includes(a)).map((a) => a.setName);
  const universeSig = subsets.map((s) => `${s.mask}:${s.nRegions}:${s.nBp}`).join(",");
  const key = [adjust, assembly, chosen.map((s) => s.mask).join("|"), universeSig, annotations.map((a) => a.id).join("|")].join("#");
  const stale = result !== null && result.key !== key;
  useEffect(() => markExportStale("enrichment", stale), [stale]);
  const busy = progress !== null;
  const nSignificant = result ? rankRows(result.cells, (c) => c.annotationId).filter((r) => r.q < 0.05).length : 0;
  usePanelStatus(panelStatus({ progress, error, hasResult: result !== null, stale, done: `${count(nSignificant, "reference set")} q < 0.05` }));

  const run = async () => {
    if (!chosen.length || !annotations.length) return;
    setError(null);
    let done = 0;
    const total = annotations.length;
    setProgress({ done, total, label: "Loading reference sets" });
    const onStep = (label: string) => setProgress({ done: ++done, total, label });
    try {
      const cells = await runReferenceSetEnrichment(webRuntime, { subsets, groups: chosen.map((s) => s.mask), annotations, adjust }, { onStep });
      const r: RunResult = { key, adjust, masks: chosen.map((s) => s.mask), annotations, cells };
      lastResult = r;
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  const shown = result;
  const cellOf = (mask: number, id: string) => shown?.cells.find((c) => c.mask === mask && c.annotationId === id);
  // A whole set (negative key) is tested as every subset it is a member of: lib/selection.ts inGroup.
  const subsetOf = (mask: number) => chosenGroups([mask], subsets, sets.filter((s) => s.included))[0];

  /** The run as a TSV: also what the analysis export takes (lib/exportRegistry.ts). */
  const tsvText = (r: RunResult) => referenceSetTsv(r, subsetOf);
  const tsvRef = useRef(tsvText);
  useEffect(() => {
    tsvRef.current = tsvText;
  });
  // Contributes the last run to "Export analysis" while this panel is shown.
  useEffect(
    () =>
      registerExport("enrichment", () =>
        lastResult
          ? {
              files: [{ path: "tables/enrichment_reference_sets.tsv", content: tsvRef.current(lastResult) }],
              methods: enrichmentMethods({ adjust: lastResult.adjust, referenceNames: lastResult.annotations.map((a) => a.name) }),
            }
          : null,
      ),
    [],
  );

  const exportTsv = () => {
    if (!shown) return;
    const blob = new Blob([tsvText(shown)], { type: "text/tab-separated-values" });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = "achi-enrichment.tsv";
    document.body.appendChild(el);
    el.click();
    el.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`annowrap${busy ? " busy" : ""}`} aria-busy={busy} style={{ minHeight: 120 }}>
      {busy && <ComputeOverlay label={progress.label} progress={progress} />}
      <div className="rowsplit" style={{ marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <label className="checkrow" title="Cochran–Mantel–Haenszel test across five region-length strata, so longer regions hitting more by chance don't drive the result">
          <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} />
          <span className="k">Adjust for region length</span>
        </label>
        <button className="ghost" disabled={busy || mainStatus === "running" || !chosen.length || !annotations.length} onClick={() => void run()}>
          {result ? "Run again" : "Run enrichment"}
        </button>
      </div>
      {!chosen.length && (
        <div style={{ margin: "0 0 10px" }}>
          <SelectFirstHint />
        </div>
      )}

      <div className="hint" style={{ margin: "0 0 10px" }}>
        Compares each selected subset or set with all other regions of this analysis (the background): what sets it apart within
        your experiment.{" "}
        Tests {annotations.length} reference set{annotations.length === 1 ? "" : "s"} for{" "}
        {assembly}; the first run downloads them (cached afterwards). Nothing is uploaded.
        {skipped.length > 0 && ` Not tested, because ${skipped.length === 1 ? "it is an analysed input set" : "they are analysed input sets"}: ${skipped.join(", ")}.`}
      </div>

      {error && <div className="hint error">{error}</div>}
      {!annotations.length && <div className="hint">No reference sets are available for {assembly}.</div>}
      {stale && !busy && chosen.length > 0 && <div className="setinfo" style={{ marginBottom: 8 }}>Settings or selection changed since this result. Press Run again to update it.</div>}

      {shown && chosen.length > 0 && (
        <div className={stale ? "stale" : undefined}>
          <EnrichmentHeatmap result={shown} top={top} subsetOf={subsetOf} cellOf={cellOf} svgRef={svgRef} />
          <div className="plotactions">
            <div style={{ marginRight: "auto" }}>
              <TopRowsInput value={top} max={shown.annotations.length} noun="reference sets" onChange={setTop} />
            </div>
            <button className="iconbtn" title="Download results as TSV" aria-label="Download enrichment results as TSV" onClick={exportTsv}>
              <Icon name="download" />
            </button>
            <button className="iconbtn" title="Export SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, "achi-enrichment.svg")}>
              SVG
            </button>
            <button className="iconbtn" title="Export PNG" onClick={() => svgRef.current && void downloadPng(svgRef.current, "achi-enrichment.png")}>
              PNG
            </button>
          </div>
          <EnrichmentTable result={shown} subsetOf={subsetOf} />
        </div>
      )}
    </div>
  );
}

type SubsetLookup = (mask: number) => { label: string; code: string } | undefined;

function EnrichmentHeatmap({
  result,
  top,
  subsetOf,
  cellOf,
  svgRef,
}: {
  result: RunResult;
  top: number;
  subsetOf: SubsetLookup;
  cellOf: (mask: number, id: string) => EnrichmentCell | undefined;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  // The `top` reference sets by their best q over the groups (enriched or depleted), most significant first.
  const byId = new Map(result.annotations.map((a) => [a.id, a]));
  const ranked = rankRows(result.cells, (c) => c.annotationId);
  const rows = ranked.slice(0, top).flatMap((r) => byId.get(r.row) ?? []);
  const nSignificant = ranked.filter((r) => r.q < 0.05).length;
  const cols = result.masks;
  const rowLabelW = Math.min(ROW_LABEL_MAX_W, Math.max(...rows.map((a) => estimateTextWidth(a.setName, LABEL_FONT))));
  const colLabels = cols.map((m) => truncateToWidth(subsetOf(m)?.label ?? String(m), COL_LABEL_MAX_W, LABEL_FONT));
  const colLabelH = Math.min(COL_LABEL_MAX_W, Math.max(...colLabels.map((l) => estimateTextWidth(l, LABEL_FONT)))) * Math.SQRT1_2 + 14;
  const gridX = PAD + rowLabelW + 8;
  const gridY = PAD + colLabelH;
  const gridW = cols.length * CELL_W;
  const legendY = gridY + rows.length * CELL_H + 22;
  const legendW = 180;
  const legendText = [
    "depleted ← → enriched · * q < 0.05 · ** q < 0.01 · *** q < 0.001",
    `Background: all regions of the analysis · ${result.adjust ? "CMH test, 5 length strata" : "Fisher's exact test"}`,
  ];
  const legendTextW = Math.max(...legendText.map((t) => estimateTextWidth(t, 10)));
  const width = Math.max(gridX + gridW + colLabelH * 0.7, gridX + legendW, gridX + legendTextW) + PAD;
  const height = legendY + 70;
  const gradId = "enrich-grad";

  return (
    <div className="heatwrap">
      <div className="setinfo">
        {nSignificant === 0
          ? `No reference set reaches q < 0.05 in any group; the ${rows.length} with the smallest q ${rows.length === 1 ? "is" : "are"} shown.`
          : `${nSignificant} of ${ranked.length} reference sets reach q < 0.05 in at least one group; showing the top ${rows.length}, most significant first.`}
      </div>
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Subset enrichment heatmap">
        <defs>
          <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
            {[-3, -2, -1, 0, 1, 2, 3].map((v) => (
              <stop key={v} offset={`${((v + 3) / 6) * 100}%`} stopColor={cellColor(2 ** v)} />
            ))}
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={width} height={height} fill={PAPER} />
        {cols.map((m, j) => {
          const x = gridX + j * CELL_W + CELL_W / 2;
          return (
            <text key={m} x={x} y={gridY - 6} fontSize={LABEL_FONT} fill={INK} transform={`rotate(-45 ${x} ${gridY - 6})`}>
              <title>{subsetOf(m)?.label}</title>
              {colLabels[j]}
            </text>
          );
        })}
        {rows.map((a, i) => {
          const y = gridY + i * CELL_H;
          return (
            <g key={a.id}>
              <text x={gridX - 8} y={y + CELL_H / 2 + 4} textAnchor="end" fontSize={LABEL_FONT} fill={INK}>
                <title>{a.name}</title>
                {truncateToWidth(a.setName, rowLabelW, LABEL_FONT)}
              </text>
              {cols.map((m, j) => {
                const c = cellOf(m, a.id);
                if (!c) return null;
                const fill = cellColor(c.oddsRatio);
                const t = c.table;
                const tip = `${subsetOf(m)?.label} × ${a.name}\nodds ratio ${fmtOr(c.oddsRatio)} · p ${fmtP(c.p)} · q ${fmtP(c.q)}\n${t[0].toLocaleString()} of ${(t[0] + t[1]).toLocaleString()} ${m < 0 ? "regions of the set's subsets" : "subset regions"} hit, vs ${t[2].toLocaleString()} of ${(t[2] + t[3]).toLocaleString()} other regions`;
                return (
                  <g key={m}>
                    <title>{tip}</title>
                    <rect x={gridX + j * CELL_W} y={y} width={CELL_W} height={CELL_H} fill={fill} stroke={PAPER} strokeWidth={1} shapeRendering="crispEdges" />
                    {c.q < 0.05 && (
                      <text x={gridX + j * CELL_W + CELL_W / 2} y={y + CELL_H / 2 + 7} textAnchor="middle" fontSize={12} fontFamily="monospace" fill={textOn(fill)}>
                        {stars(c.q)}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        {rows.length > 0 && <rect x={gridX} y={gridY} width={gridW} height={rows.length * CELL_H} fill="none" stroke={AXIS} shapeRendering="crispEdges" />}
        {/* legend */}
        <text x={gridX} y={legendY - 6} fontSize={10} fill={INK_3}>
          Odds ratio (colour: log₂, clipped at ±3)
        </text>
        <rect x={gridX} y={legendY} width={legendW} height={10} fill={`url(#${gradId})`} stroke={AXIS} shapeRendering="crispEdges" />
        {[0.125, 0.5, 1, 2, 8].map((v) => {
          const x = gridX + ((Math.log2(v) + 3) / 6) * legendW;
          return (
            <text key={v} x={x} y={legendY + 24} textAnchor="middle" fontSize={9.5} fontFamily="monospace" fill={INK_3}>
              {v < 1 ? `1/${1 / v}` : v}
            </text>
          );
        })}
        {legendText.map((t, i) => (
          <text key={i} x={gridX} y={legendY + 44 + i * 15} fontSize={10} fill={INK_3}>
            {t}
          </text>
        ))}
      </svg>
    </div>
  );
}

function EnrichmentTable({ result, subsetOf }: { result: RunResult; subsetOf: SubsetLookup }) {
  const sorted = [...result.cells].sort((x, y) => x.q - y.q || x.p - y.p);
  return (
    <div className="regions-scroll" style={{ maxHeight: 240, marginTop: 10 }}>
      <table className="subtable" aria-label="Enrichment results, most significant first">
        <thead>
          <tr>
            <th>Subset</th>
            <th>Reference set</th>
            <th title="Subset regions hitting the reference set / all subset regions">Subset hit</th>
            <th title="Other regions of the analysis hitting the reference set / all of them">Others hit</th>
            <th>Odds ratio</th>
            <th>p</th>
            <th>q</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const a = result.annotations.find((x) => x.id === c.annotationId);
            const t = c.table;
            return (
              <tr key={`${c.mask}-${c.annotationId}`}>
                <td>{subsetOf(c.mask)?.label ?? c.mask}</td>
                <td>{a?.setName}</td>
                <td className="mono">{`${t[0].toLocaleString()} / ${(t[0] + t[1]).toLocaleString()}`}</td>
                <td className="mono">{`${t[2].toLocaleString()} / ${(t[2] + t[3]).toLocaleString()}`}</td>
                <td className="mono">{fmtOr(c.oddsRatio)}</td>
                <td className="mono">{fmtP(c.p)}</td>
                <td className="mono">
                  {fmtP(c.q)} {stars(c.q)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
