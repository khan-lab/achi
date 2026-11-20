import { useEffect, useRef, useState } from "react";
import { usePanelStatus } from "./panelState";
import { panelStatus } from "./panelStatus";
import { useStore } from "../state/store";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import {
  runSetSummary,
  filterCanonicalChromosomes,
  sortChromosomesNaturally,
  getAggregateRow,
  type SummaryRow,
} from "@achi/core/summaryStats";
import type { SummaryItem } from "@achi/core/types";
import { webRuntime } from "../lib/runtime";

export type { SummaryItem };

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
function bpfmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} Mb`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kb`;
  return `${n} bp`;
}

// Concrete colors (not CSS vars) so the exported standalone SVG/PNG render
// correctly outside this page's stylesheet — same convention as every
// other plot in this app.
const INK_3 = "#8b97a9";
const LINE_STRONG = "#93989d";
const PAPER = "#ffffff";

const BAR_W = 8;
const BAR_GAP = 2;
const GROUP_GAP = 12;
const PLOT_H = 180;
const TOP_PAD = 16;
// Left/bottom padding each reserve two rows: tick numbers + axis title
// (y-axis title rotated -90 at x=14, matching UpSetPlot's convention).
const LEFT_PAD = 60;
const RIGHT_PAD = 14;
const BOTTOM_PAD = 36;
const Y_TICKS = 4;

type Metric = "count" | "bp";

// Module-level, not component state: this component unmounts whenever
// `view` navigates away from "summary" (App.tsx only renders it on that
// tab), so a plain useRef/useState pair would silently redo every set's
// bedtools summary call each time a user glances at another tab and comes
// back. Keyed by (assembly, item id, item version), so this still
// self-invalidates correctly if the same id's content ever changes.
const summaryRowsCache = new Map<string, SummaryRow[]>();


/**
 * Per-item descriptive statistics via `bedtools summary -i -g` — one call
 * per item (not per pair), no sort step needed first (verified
 * empirically that unsorted input produces identical output). See
 * lib/summaryStats.ts's module docstring for the real output quirks this
 * was built against, and docs/methods.md for why this module has no null
 * model (it's purely descriptive, not a statistical test).
 */
export function SummaryPlot({ items, svgRef }: { items: SummaryItem[]; svgRef?: React.RefObject<SVGSVGElement | null> }) {
  const assembly = useStore((s) => s.assembly);
  const localRef = useRef<SVGSVGElement | null>(null);
  const ref = svgRef ?? localRef;

  const [metric, setMetric] = useState<Metric>("count");
  const [summaryState, setSummaryState] = useState<Map<string, SummaryRow[]>>(() => new Map(summaryRowsCache));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePanelStatus(panelStatus({ busy: loading, error, hasResult: items.length > 0, done: `${items.length} selected` }));

  const cacheKey = (item: SummaryItem) => `${assembly}::${item.id}::${item.version}`;
  const itemsKey = items.map((i) => `${i.id}:${i.version}`).join(",");

  useEffect(() => {
    if (items.length < 1) return;
    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const todo = items.filter((item) => !summaryRowsCache.has(cacheKey(item)));
        await runSetSummary(webRuntime, assembly, todo, {
          signal: abort.signal,
          onResult: (rows, item) => {
            if (cancelled) return;
            const key = cacheKey(item);
            summaryRowsCache.set(key, rows);
            setSummaryState((prev) => new Map(prev).set(key, rows));
          },
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
    };
    // summaryRowsCache (the module-level Map) is read for "already
    // computed?" checks only, see the same note in PairwiseHeatmap.tsx's effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly, itemsKey]);

  if (items.length < 1) {
    return (
      <div className="placeholder">
        <div className="big">Load a region set</div>
        <div className="sm">Unlike the other tabs, Summary works with just one set — it's per-set, not per-overlap.</div>
      </div>
    );
  }

  const perItem = items.map((item) => sortChromosomesNaturally(filterCanonicalChromosomes(summaryState.get(cacheKey(item)) ?? [])));
  const aggregates = items.map((item) => getAggregateRow(summaryState.get(cacheKey(item)) ?? []));
  const chroms = perItem.find((rows) => rows.length)?.map((r) => r.chrom) ?? [];

  const valueOf = (row: SummaryRow | undefined): number => {
    if (!row) return 0;
    return metric === "count" ? row.numIvls : row.totalIvlBp;
  };
  const rowFor = (itemIdx: number, chrom: string): SummaryRow | undefined => perItem[itemIdx].find((r) => r.chrom === chrom);

  const maxValue = Math.max(1, ...chroms.map((c) => Math.max(...items.map((_, i) => valueOf(rowFor(i, c))))));
  const groupWidth = items.length * BAR_W + Math.max(0, items.length - 1) * BAR_GAP;
  const width = LEFT_PAD + chroms.length * (groupWidth + GROUP_GAP) - (chroms.length ? GROUP_GAP : 0) + RIGHT_PAD;
  const height = TOP_PAD + PLOT_H + BOTTOM_PAD;
  const baseline = TOP_PAD + PLOT_H;
  const yTickValues = Array.from({ length: Y_TICKS + 1 }, (_, i) => Math.round((maxValue * i) / Y_TICKS));
  const metricLabel = metric === "count" ? "intervals" : "bp";
  const fmtValue = metric === "count" ? fmt : bpfmt;
  const yAxisTitle = metric === "count" ? "Interval count" : "Total bp";
  const yAxisTitleY = (TOP_PAD + baseline) / 2;

  return (
    <div className="heatwrap">
      <div className="rowsplit" style={{ marginBottom: 10 }}>
        <div className="tabs" role="tablist" aria-label="Summary metric">
          <button className="tab" role="tab" aria-selected={metric === "count"} onClick={() => setMetric("count")}>
            Interval count
          </button>
          <button className="tab" role="tab" aria-selected={metric === "bp"} onClick={() => setMetric("bp")}>
            Total bp
          </button>
        </div>
        {error ? (
          <span className="hint error" style={{ margin: 0 }}>
            {error}
          </span>
        ) : (
          loading && (
            <span className="hint" style={{ margin: 0 }}>
              computing summary…
            </span>
          )
        )}
      </div>

      <div className="statcards">
        {items.map((item, i) => {
          const agg = aggregates[i];
          return (
            <div className="statcard" key={item.id}>
              <div className="statcard-hd">
                <span className="swatch" style={{ background: item.color }} />
                <span>{item.name}</span>
              </div>
              {agg ? (
                <div className="mono statcard-body">
                  <div>{fmt(agg.numIvls)} intervals</div>
                  <div>{bpfmt(agg.totalIvlBp)} total</div>
                  <div>
                    mean {agg.mean >= 0 ? bpfmt(Math.round(agg.mean)) : "—"} · min {agg.min >= 0 ? bpfmt(agg.min) : "—"} · max{" "}
                    {agg.max >= 0 ? bpfmt(agg.max) : "—"}
                  </div>
                </div>
              ) : (
                <div className="mono statcard-body hint">computing…</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="plotactions">
        <button className="iconbtn" title="Export SVG" onClick={() => ref.current && downloadSvg(ref.current, "achi-summary.svg")}>
          SVG
        </button>
        <button
          className="iconbtn"
          title="Export PNG"
          onClick={() => ref.current && void downloadPng(ref.current, "achi-summary.png")}
        >
          PNG
        </button>
      </div>

      <div className="plotwrap">
        <svg ref={ref} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Per-chromosome summary plot">
          <rect x={0} y={0} width={width} height={height} fill={PAPER} />
          <text
            x={14}
            y={yAxisTitleY}
            textAnchor="middle"
            fontSize={11}
            fill={INK_3}
            fontFamily="Inter Tight, sans-serif"
            transform={`rotate(-90 14 ${yAxisTitleY})`}
          >
            {yAxisTitle}
          </text>
          {yTickValues.map((v, i) => {
            // Keyed by tick index, not value — with a small maxValue
            // (e.g. before any item's summary has finished loading, when
            // maxValue falls back to 1), rounding can produce duplicate
            // values (e.g. [0,0,1,1,1]), which duplicate-value keys would
            // collide on.
            const y = baseline - (maxValue > 0 ? (v / maxValue) * PLOT_H : 0);
            return (
              <g key={i}>
                <line x1={LEFT_PAD - 4} y1={y} x2={width - RIGHT_PAD} y2={y} stroke="#eef0f3" strokeWidth={1} />
                <text x={LEFT_PAD - 8} y={y + 4} textAnchor="end" fontSize={10} fontFamily="monospace" fill={INK_3}>
                  {metric === "count" ? fmt(v) : bpfmt(v)}
                </text>
              </g>
            );
          })}
          <line x1={LEFT_PAD} y1={TOP_PAD} x2={LEFT_PAD} y2={baseline} stroke={LINE_STRONG} strokeWidth={1} />
          <line x1={LEFT_PAD} y1={baseline} x2={width - RIGHT_PAD} y2={baseline} stroke={LINE_STRONG} strokeWidth={1} />
          {chroms.map((chrom, g) => {
            const groupX = LEFT_PAD + g * (groupWidth + GROUP_GAP);
            return (
              <g key={chrom}>
                <text
                  x={groupX + groupWidth / 2}
                  y={baseline + 14}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontFamily="monospace"
                  fill={INK_3}
                >
                  {chrom.replace("chr", "")}
                </text>
                {items.map((item, i) => {
                  const row = rowFor(i, chrom);
                  const value = valueOf(row);
                  const h = maxValue > 0 ? (value / maxValue) * PLOT_H : 0;
                  const x = groupX + i * (BAR_W + BAR_GAP);
                  return (
                    <g key={item.id}>
                      <title>{`${item.name} · ${chrom} — ${fmtValue(value)} ${metricLabel}`}</title>
                      <rect x={x} y={baseline - h} width={BAR_W} height={h} fill={item.color} opacity={0.85} />
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text
            x={LEFT_PAD + (width - LEFT_PAD - RIGHT_PAD) / 2}
            y={baseline + 30}
            textAnchor="middle"
            fontSize={11}
            fill={INK_3}
            fontFamily="Inter Tight, sans-serif"
          >
            Chromosome
          </text>
        </svg>
      </div>
    </div>
  );
}
