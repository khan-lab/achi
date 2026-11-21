import { useEffect, useMemo, useRef, useState } from "react";
import { interpolateLab, scaleLinear } from "d3";
import { GO_CLUSTER_DEFAULTS, GO_COMPARE_DEFAULT_TOP, compareGoGroups, goCompareTsv, type GoComparison } from "@achi/core/goCompare";
import { fmtFold, fmtP, goTermGenes, type GoGroupResult } from "@achi/core/goEnrichment";
import type { GoNamespace } from "@achi/core/great";
import { webRuntime } from "../lib/runtime";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, truncateToWidth } from "../lib/textMeasure";
import { TopRowsInput } from "./TopRowsInput";

const INK = "#101826";
const INK_3 = "#8b97a9";
const AXIS_INK = "#3a4250";
const PAPER = "#ffffff";
const GUIDE = "#eef0f4";
/** Enriched but not significant: a light ring, so the significant dots carry the plot. */
const RING = "#b9c1cd";
/** −log10 q: one hue, light to dark (the motif heatmap's enrichment red). */
const Q_LIGHT = "#fbd5d0";
const Q_DARK = "#8e1b1f";

const negLog10 = (q: number) => Math.min(300, q > 0 ? -Math.log10(q) : 300);

// Choices survive remounts within the session.
const ui = { top: GO_COMPARE_DEFAULT_TOP, group: true, minKappa: GO_CLUSTER_DEFAULTS.minKappa };

export interface CompareInput {
  assembly: string;
  ns: GoNamespace;
  qThreshold: number;
  metric: string;
  foldLabel: string;
  stem: string;
  groups: (GoGroupResult & { color: string })[];
}

/**
 * The selected groups' GO results side by side (terms × groups dot plot):
 * colour −log10 q, size fold, hollow where enriched but not significant.
 * Similar terms are grouped by Metascape's kappa clustering when asked.
 * Calls `onTsv` with the comparison as shown (TSV and settings), for "Export analysis".
 */
export function GoComparePlot({ input, onTsv }: { input: CompareInput; onTsv: (shown: { tsv: string; top: number; minKappa?: number } | null) => void }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [top, setTopState] = useState(ui.top);
  const [group, setGroupState] = useState(ui.group);
  const [minKappa, setMinKappaState] = useState(ui.minKappa);
  const [kappaDraft, setKappaDraft] = useState(String(ui.minKappa));
  const [termGenes, setTermGenes] = useState<{ key: string; genes: Map<string, number[]> } | null>(null);
  const setTop = (n: number) => setTopState((ui.top = n));
  const setGroup = (b: boolean) => setGroupState((ui.group = b));
  const setMinKappa = (k: number) => setMinKappaState((ui.minKappa = k));
  const genesKey = `${input.assembly}:${input.ns}`;

  useEffect(() => {
    if (!group || termGenes?.key === genesKey) return;
    let live = true;
    void goTermGenes(webRuntime, input.assembly, input.ns).then((genes) => live && setTermGenes({ key: genesKey, genes }));
    return () => {
      live = false;
    };
  }, [group, genesKey, input.assembly, input.ns, termGenes?.key]);

  const genes = termGenes?.key === genesKey ? termGenes.genes : null;
  const waiting = group && !genes;
  const cmp = useMemo<GoComparison | null>(
    () => (waiting ? null : compareGoGroups(input.groups, { top, ...(group && genes ? { cluster: { termGenes: genes, minKappa, maxTerms: GO_CLUSTER_DEFAULTS.maxTerms } } : {}) })),
    [input.groups, top, group, genes, minKappa, waiting],
  );
  const tsv = useMemo(() => (cmp && cmp.rows.length ? goCompareTsv(cmp, input.groups) : null), [cmp, input.groups]);
  useEffect(() => onTsv(tsv && cmp ? { tsv, top: cmp.top, ...(cmp.clustered ? { minKappa: cmp.minKappa } : {}) } : null), [tsv, cmp, onTsv]);

  const maxPerGroup = Math.max(1, ...input.groups.map((g) => g.rows.filter((r) => r.significant && r.fold > 1).length));
  const download = () => {
    if (!tsv) return;
    const url = URL.createObjectURL(new Blob([tsv], { type: "text/tab-separated-values" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${input.stem}-compare.tsv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="setinfo" style={{ margin: "0 0 8px" }}>
        {!cmp
          ? "Grouping similar terms…"
          : cmp.rows.length === 0
            ? `No term is significant in any of the ${input.groups.length} selected groups.`
            : `${cmp.rows.length} ${cmp.clustered ? "groups of similar terms" : "terms"}: each subset's top ${top} significant${cmp.clustered ? ` (${cmp.nTermsClustered.toLocaleString("en-US")} significant terms grouped into ${cmp.nClusters.toLocaleString("en-US")})` : ""}, shared ones first. Colour shows −log₁₀ q, which also grows with a subset's size, so compare fold (dot size) across subsets.`}
      </div>
      {cmp && cmp.rows.length > 0 && <CompareChart cmp={cmp} input={input} svgRef={svgRef} />}
      <div className="plotactions" style={{ flexWrap: "wrap", alignItems: "center" }}>
        <TopRowsInput value={top} max={maxPerGroup} noun="terms per subset" chart="comparison" def={GO_COMPARE_DEFAULT_TOP} onChange={setTop} />
        <label className="checkrow" style={{ marginLeft: 12 }} title="Group terms whose annotated genes overlap (Cohen's kappa, average-linkage clustering), as Metascape does; each row shows the group's most significant term, and each cell the subset's best term of the group.">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} />
          <span className="k">Group similar terms, kappa &gt;</span>
        </label>
        <input
          className="param-text"
          type="number"
          min={0}
          max={0.99}
          step={0.05}
          value={kappaDraft}
          disabled={!group}
          aria-label="Kappa threshold for grouping similar terms"
          title={`Terms join a group when their kappa is above this (default ${GO_CLUSTER_DEFAULTS.minKappa}, as Metascape).`}
          onChange={(e) => {
            setKappaDraft(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(v) && v >= 0 && v < 1) setMinKappa(v);
          }}
          onBlur={() => setKappaDraft(String(minKappa))}
          style={{ width: 58 }}
        />
        <span style={{ marginRight: "auto" }} />
        <button className="iconbtn" title="Download the comparison as TSV" disabled={!tsv} onClick={download}>
          TSV
        </button>
        <button className="iconbtn" title="Export SVG" disabled={!cmp?.rows.length} onClick={() => svgRef.current && downloadSvg(svgRef.current, `${input.stem}-compare.svg`)}>
          SVG
        </button>
        <button className="iconbtn" title="Export PNG" disabled={!cmp?.rows.length} onClick={() => svgRef.current && void downloadPng(svgRef.current, `${input.stem}-compare.png`)}>
          PNG
        </button>
      </div>
    </div>
  );
}

function CompareChart({ cmp, input, svgRef }: { cmp: GoComparison; input: CompareInput; svgRef: React.RefObject<SVGSVGElement | null> }) {
  const PAD = 10;
  const CELL_W = 46;
  const CELL_H = 22;
  const R_MIN = 4;
  const R_MAX = 9.5;
  const groups = input.groups;
  const suffix = (n: number) => (n > 0 ? ` +${n}` : "");
  const labelW = Math.min(300, Math.max(120, ...cmp.rows.map((r) => estimateTextWidth(r.name + suffix(r.members.length - 1), 11) + 6)));
  const colLabels = groups.map((g) => truncateToWidth(g.label, 150, 11.5));
  const colLabelH = Math.min(150, Math.max(...colLabels.map((l) => estimateTextWidth(l, 11.5)))) * Math.SQRT1_2 + 22;
  const gridX = PAD + labelW + 8;
  const gridY = PAD + colLabelH;
  const gridW = groups.length * CELL_W;
  const gridH = cmp.rows.length * CELL_H;

  const cells = cmp.rows.flatMap((r) => r.cells.filter((c) => c !== null));
  const qMax = Math.max(negLog10(input.qThreshold) * 1.5, ...cells.map((c) => negLog10(c.q)));
  const qScale = scaleLinear().domain([0, qMax]).nice(4);
  const color = (q: number) => interpolateLab(Q_LIGHT, Q_DARK)(Math.min(1, negLog10(q) / qScale.domain()[1]));
  const finiteFolds = cells.map((c) => c.fold).filter(Number.isFinite);
  const foldCap = Math.max(2, Math.min(16, Math.ceil(Math.max(2, ...finiteFolds))));
  const radius = (f: number) => R_MIN + (R_MAX - R_MIN) * Math.sqrt((Math.min(Number.isFinite(f) ? f : foldCap, foldCap) - 1) / (foldCap - 1));
  const sizeKeys = [...new Set([1.5, Math.round(Math.sqrt(foldCap) * 10) / 10, foldCap])].filter((v) => v > 1 && v <= foldCap);

  // Keys in a column right of the grid: size, then colour (a vertical bar, high −log10 q at the top).
  const sizeX = gridX + gridW + 16;
  const SIZE_STEP = 2 * R_MAX + 6;
  const sizeTop = gridY + 18;
  const sizeBottom = sizeTop + sizeKeys.length * SIZE_STEP;
  const ticks = qScale.ticks(4);
  const COLOR_H = 100;
  const colorTop = sizeBottom + 32;
  const colorY = (t: number) => colorTop + COLOR_H - (t / qScale.domain()[1]) * COLOR_H;
  const monoW = (t: string) => t.length * 6; // monospace digits ≈ 6 px at 9.5 px
  const keyW = Math.max(
    estimateTextWidth(input.foldLabel, 10),
    estimateTextWidth("−log₁₀ q", 10),
    2 * R_MAX + 6 + Math.max(...sizeKeys.map((f) => monoW(String(f)))),
    10 + 6 + Math.max(...ticks.map((t) => monoW(String(t)))),
  );
  const legendY = Math.max(gridY + gridH, colorTop + COLOR_H) + 26;
  const footer = `Colour: −log₁₀ q (${input.metric}); size: ${input.foldLabel}, capped at ${foldCap}; grey ring: enriched, not significant; empty: not enriched.${cmp.clustered ? ` Similar terms grouped at kappa > ${cmp.minKappa} (Metascape's clustering); +n: terms in the group.` : ""}`;
  const footerLines = wrap(footer, Math.max(gridX + gridW, 420) - PAD, 10);
  const width = Math.max(gridX + gridW + colLabelH * 0.7, sizeX + keyW, PAD + Math.max(...footerLines.map((l) => estimateTextWidth(l, 10)))) + PAD;
  const height = legendY + footerLines.length * 13;

  return (
    <div className="heatwrap">
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="GO terms compared across subsets">
        <defs>
          <linearGradient id="gocmp-grad" x1="0" x2="0" y1="1" y2="0">
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <stop key={t} offset={`${t * 100}%`} stopColor={interpolateLab(Q_LIGHT, Q_DARK)(t)} />
            ))}
          </linearGradient>
        </defs>
        <rect width={width} height={height} fill={PAPER} />
        {groups.map((g, j) => {
          const x = gridX + j * CELL_W + CELL_W / 2;
          return (
            <g key={g.mask}>
              <rect x={x - 4} y={gridY - 12} width={8} height={8} rx={2} fill={g.color} />
              <text x={x + 2} y={gridY - 16} fontSize={11.5} fill={INK} transform={`rotate(-45 ${x + 2} ${gridY - 16})`}>
                <title>{g.label}</title>
                {colLabels[j]}
              </text>
            </g>
          );
        })}
        {cmp.rows.map((r, i) => {
          const y = gridY + i * CELL_H;
          const extra = r.members.length - 1;
          const name = truncateToWidth(r.name, labelW - 6 - (extra ? estimateTextWidth(suffix(extra), 11) : 0), 11);
          return (
            <g key={r.id}>
              {i > 0 && <line x1={gridX} x2={gridX + gridW} y1={y} y2={y} stroke={GUIDE} strokeWidth={1} shapeRendering="crispEdges" />}
              <text x={PAD + labelW} y={y + CELL_H / 2 + 4} textAnchor="end" fontSize={11} fill={INK}>
                <title>{[`${r.name} (${r.id})`, ...(extra ? [`Grouped with ${extra} similar term${extra === 1 ? "" : "s"}:`, ...r.members.slice(1, 16).map((m) => `  ${m.name} (${m.id})`), ...(extra > 15 ? [`  … and ${extra - 15} more`] : [])] : [])].join("\n")}</title>
                {name}
                {extra > 0 && <tspan fill={INK_3}>{suffix(extra)}</tspan>}
              </text>
              {r.cells.map((c, j) => {
                if (!c) return null;
                const cx = gridX + j * CELL_W + CELL_W / 2;
                const cy = y + CELL_H / 2;
                const fill = color(c.q);
                return (
                  <g key={j}>
                    <title>{`${groups[j].label} × ${c.name} (${c.id})\nq ${fmtP(c.q)} · ${input.foldLabel} ${fmtFold(c.fold)}${c.significant ? "" : " · not significant"}${c.id !== r.id ? `\nbest term of the group in this subset` : ""}`}</title>
                    <rect x={cx - CELL_W / 2} y={y} width={CELL_W} height={CELL_H} fill="transparent" />
                    {c.significant ? (
                      <circle cx={cx} cy={cy} r={radius(c.fold)} fill={fill} stroke={PAPER} strokeWidth={1} />
                    ) : (
                      <circle cx={cx} cy={cy} r={radius(c.fold) - 0.75} fill={PAPER} stroke={RING} strokeWidth={1.25} />
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        <rect x={gridX} y={gridY} width={gridW} height={gridH} fill="none" stroke={AXIS_INK} shapeRendering="crispEdges" />
        {/* keys in a column right of the grid: size, then colour */}
        <text x={sizeX} y={colorTop - 12} fontSize={10} fill={INK_3}>
          −log₁₀ q
        </text>
        <rect x={sizeX} y={colorTop} width={10} height={COLOR_H} fill="url(#gocmp-grad)" stroke={AXIS_INK} shapeRendering="crispEdges" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sizeX + 10} x2={sizeX + 13} y1={colorY(t)} y2={colorY(t)} stroke={AXIS_INK} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={sizeX + 16} y={colorY(t) + 3.5} fontSize={9.5} fontFamily="monospace" fill={INK_3}>
              {t}
            </text>
          </g>
        ))}
        <text x={sizeX} y={gridY + 8} fontSize={10} fill={INK_3}>
          {input.foldLabel}
        </text>
        {sizeKeys.map((f, k) => {
          const cy = sizeTop + k * SIZE_STEP + R_MAX;
          return (
            <g key={f}>
              <circle cx={sizeX + R_MAX} cy={cy} r={radius(f)} fill={INK_3} opacity={0.55} />
              <text x={sizeX + 2 * R_MAX + 6} y={cy + 3.5} fontSize={9.5} fontFamily="monospace" fill={INK_3}>
                {f}
              </text>
            </g>
          );
        })}
        {footerLines.map((l, k) => (
          <text key={k} x={PAD} y={legendY + k * 13} fontSize={10} fill={INK_3}>
            {l}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** Greedy word wrap at an estimated width. */
function wrap(text: string, maxW: number, fontSize: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    const next = line ? `${line} ${w}` : w;
    if (line && estimateTextWidth(next, fontSize) > maxW) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
