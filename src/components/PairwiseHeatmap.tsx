import { useEffect, useRef, useState } from "react";
import { useStore, type PairwiseStat } from "../state/store";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, truncateToWidth } from "../lib/textMeasure";
import { resolveOverlapFlags } from "@achi/core/bedtoolsOptions";
import { runPairwise, type FisherResult, type JaccardResult, type ReldistResult } from "@achi/core/pairwiseStats";
import { webRuntime } from "../lib/runtime";
import { PermutationControls } from "./PermutationControls";
import { usePermutation } from "./usePermutation";

// Concrete colors (not CSS vars) so the exported standalone SVG/PNG render
// correctly outside this page's stylesheet.
const INK = "#101826";
const PAPER = "#ffffff";
const CELL = 44;
const PAD = 10;
const LABEL_FONT_SIZE = 11.5;
// Row headers are horizontal and width-constrained (they sit in a fixed
// column before the grid), so long names truncate with an ellipsis —
// same pattern as UpSetPlot/SetRail.
const ROW_LABEL_MAX_W = 100;
const ROW_LABEL_GAP = 8;
// Column headers rotate diagonally instead of truncating (ADR: rotating
// reads better than an ellipsis for a name repeated across every column
// vs. row), so they only get a soft cap — genuinely pathological names
// still truncate rather than blowing out the plot's height indefinitely.
const COL_LABEL_MAX_W = 160;
// +45, not -45: with textAnchor="end" the label extends left of its pivot
// before rotation, and SVG's y-down coordinate system means a positive
// angle here tips that leftward run upward (away from the grid below);
// -45 would tip it downward, into the grid — verified empirically, easy
// to get backwards by reasoning about it as if y pointed up.
const COL_LABEL_ANGLE = 45;

// Clamp so an underflowed p-value (JS rounds anything below ~1e-308 to
// exactly 0, and bedtools' own output can print e.g. "0.0000e+00") doesn't
// produce -log10(0) = Infinity.
const NEG_LOG10_MAX = 20;
function negLog10Clamped(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return NEG_LOG10_MAX;
  return Math.min(NEG_LOG10_MAX, -Math.log10(p));
}
function significanceAlpha(p: number): number {
  return 0.12 + (negLog10Clamped(p) / NEG_LOG10_MAX) * 0.75;
}

const STAT_TABS: { id: PairwiseStat; label: string }[] = [
  { id: "jaccard", label: "Jaccard" },
  { id: "fisher", label: "Fisher" },
  { id: "reldist", label: "Reldist" },
  { id: "permutation", label: "Permutation" },
];

function pairKey(aId: string, bId: string): string {
  return `${aId}::${bId}`;
}

/** Fisher's cache key also carries the overlap flags — matching `bedtools fisher`'s -f/-F/-r/-s/-S support for the same "Minimum overlap" setting the UpSet/Venn subsets use — so switching that setting doesn't serve stale results. */
function fisherKey(aId: string, bId: string, overlapFlags: string): string {
  return `${aId}::${bId}::${overlapFlags}`;
}

/**
 * Jaccard/Fisher/Reldist (matching the Intervene CLI's own
 * `intervene pairwise --compute {jaccard,fisher,reldist}`) each run real
 * `bedtools jaccard`/`fisher`/`reldist` per ordered pair — see
 * lib/pairwiseStats.ts. Ordered (not symmetric) pairs because with overlap
 * options (-f/-r) jaccard(A,B) ≠ jaccard(B,A), and reldist(A,B) ≠
 * reldist(B,A) in general. Jaccard and Fisher apply the same overlap
 * options as the UpSet subsets.
 */
export function PairwiseHeatmap({ svgRef }: { svgRef?: React.RefObject<SVGSVGElement | null> }) {
  const allSets = useStore((s) => s.sets);
  // Every cache below is keyed by `id`; use the content key so a set's
  // blacklist-filtered and unfiltered versions are cached separately.
  const sets = allSets.filter((x) => x.included).map((x) => ({ ...x, id: x.contentKey }));
  const assembly = useStore((s) => s.assembly);
  const pairwiseStat = useStore((s) => s.pairwiseStat);
  const setPairwiseStat = useStore((s) => s.setPairwiseStat);
  const overlapPreset = useStore((s) => s.overlapPreset);
  const advancedBedtoolsOptions = useStore((s) => s.advancedBedtoolsOptions);
  const overlapFlags = resolveOverlapFlags(overlapPreset, advancedBedtoolsOptions);
  const localRef = useRef<SVGSVGElement | null>(null);
  const ref = svgRef ?? localRef;

  const [jaccardCache, setJaccardCache] = useState<Map<string, JaccardResult>>(new Map());
  const [fisherCache, setFisherCache] = useState<Map<string, FisherResult>>(new Map());
  const [reldistCache, setReldistCache] = useState<Map<string, ReldistResult>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setsKey = sets.map((s) => s.id).join(",");
  const perm = usePermutation(
    sets.map((s) => ({ id: s.id, name: s.name, file: s.file })),
    overlapFlags
  );

  useEffect(() => {
    // The permutation test runs when asked (PermutationControls), not on opening the tab.
    if (sets.length < 2 || pairwiseStat === "permutation") return;
    const stat = pairwiseStat;
    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Jaccard needs no genome file (as in the CLI), so wrong-assembly sets still work there.
        const keyOf = (a: string, b: string) => (stat === "reldist" ? pairKey(a, b) : fisherKey(a, b, overlapFlags));
        const have = stat === "jaccard" ? jaccardCache : stat === "fisher" ? fisherCache : reldistCache;
        await runPairwise(
          webRuntime,
          { stat, assembly, sets: sets.map((s) => ({ id: s.id, name: s.name, file: s.file })), overlapFlags },
          {
            signal: abort.signal,
            skip: (a, b) => have.has(keyOf(a, b)),
            onResult: (a, b, result) => {
              if (cancelled) return;
              const key = keyOf(a, b);
              if (stat === "jaccard") setJaccardCache((prev) => new Map(prev).set(key, result as JaccardResult));
              else if (stat === "fisher") setFisherCache((prev) => new Map(prev).set(key, result as FisherResult));
              else setReldistCache((prev) => new Map(prev).set(key, result as ReldistResult));
            },
          }
        );
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
    // jaccardCache/fisherCache/reldistCache are read for "already computed?" checks only
    // (to avoid redundant bedtools calls); including them would re-run this
    // effect after every single cache update it itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairwiseStat, setsKey, assembly, overlapFlags]);

  if (sets.length < 2) {
    return (
      <div className="placeholder">
        <div className="big">Load two or more region sets</div>
        <div className="sm">Pairwise comparisons need at least two included sets.</div>
      </div>
    );
  }

  // Small Jaccards (common between peak sets and point variants) would all read "0.00" at 2 decimals.
  const fmtJaccard = (j: number) => (j === 0 ? "0" : j >= 0.01 ? j.toFixed(2) : j.toExponential(1));
  const bp = (n: number) => `${n.toLocaleString("en-US")} bp`;

  const rowLabelW = Math.min(ROW_LABEL_MAX_W, Math.max(0, ...sets.map((s) => estimateTextWidth(s.name, LABEL_FONT_SIZE))));
  const labelW = rowLabelW + ROW_LABEL_GAP;
  // Column headers rotate at COL_LABEL_ANGLE (-45°), anchored at their
  // bottom-right corner, so their reserved height is the diagonal
  // projection of the longest name's width, not the font's line height.
  const colNameW = Math.min(COL_LABEL_MAX_W, Math.max(0, ...sets.map((s) => estimateTextWidth(s.name, LABEL_FONT_SIZE))));
  const labelH = 16 + colNameW * Math.SQRT1_2;

  const width = labelW + sets.length * CELL + PAD * 2;
  const height = labelH + sets.length * CELL + PAD * 2;

  function renderCell(row: (typeof sets)[number], col: (typeof sets)[number]) {
    if (row.id === col.id) {
      return { fill: PAPER, alpha: 0, main: "—", title: row.name };
    }

    if (pairwiseStat === "jaccard") {
      const r = jaccardCache.get(fisherKey(row.id, col.id, overlapFlags));
      if (!r) return { fill: PAPER, alpha: 0, main: "…", title: `${row.name} → ${col.name} — computing…` };
      const alpha = 0.12 + r.jaccard * 0.75;
      return {
        fill: `rgba(43,74,224,${alpha})`,
        alpha,
        main: fmtJaccard(r.jaccard),
        title: `${row.name} → ${col.name} — Jaccard ${r.jaccard.toPrecision(3)} (shared ${bp(r.intersection)} of ${bp(r.union)})`,
      };
    }

    if (pairwiseStat === "fisher") {
      const r = fisherCache.get(fisherKey(row.id, col.id, overlapFlags));
      if (!r) return { fill: PAPER, alpha: 0, main: "…", title: `${row.name} → ${col.name} — computing…` };
      if (Number.isNaN(r.ratio)) {
        // bedtools fisher's table degenerates for very different interval
        // sizes (e.g. 30 kb peaks vs 1-bp variants); its p = 1 is not a result.
        return {
          fill: PAPER,
          alpha: 0,
          main: "n/a",
          title: `${row.name} → ${col.name} — bedtools fisher could not estimate this pair (its interval-count model breaks down when interval sizes differ greatly). Use Jaccard, or Enrichment of selected subsets and sets.`,
        };
      }
      const negLog = negLog10Clamped(r.twoTailP);
      return {
        fill: `rgba(214,40,40,${significanceAlpha(r.twoTailP)})`,
        alpha: significanceAlpha(r.twoTailP),
        main: negLog.toFixed(1),
        title: `${row.name} → ${col.name} — Fisher two-tail p = ${r.twoTailP.toExponential(2)}, odds ratio = ${r.ratio.toFixed(3)}`,
      };
    }

    if (pairwiseStat === "permutation") {
      const run = perm.shown?.run;
      const r = run?.pairs.find((x) => x.a === row.id && x.b === col.id);
      if (!run || !r) return { fill: PAPER, alpha: 0, main: "·", title: `${row.name} → ${col.name} — press Run permutation test` };
      const minP = 2 / (run.settings.n + 1);
      const alpha = r.q < 0.05 ? 0.2 + 0.65 * Math.min(1, Math.log10(1 / r.q) / Math.log10(1 / minP)) : 0;
      const enriched = r.observed > r.mean;
      const fold = Number.isFinite(r.fold) ? (r.fold >= 10 ? r.fold.toFixed(0) : r.fold.toFixed(1)) : r.fold === Infinity ? "∞" : "n/a";
      const leftOut = r.leftOut ? `; ${r.leftOut.toLocaleString("en-US")} of its regions left out (chromosome outside ${run.assembly}, or too long to place)` : "";
      return {
        fill: alpha ? (enriched ? `rgba(214,40,40,${alpha})` : `rgba(43,74,224,${alpha})`) : PAPER,
        alpha,
        main: fold,
        title:
          `${row.name} → ${col.name} — ${r.observed.toLocaleString("en-US")} of ${r.nTested.toLocaleString("en-US")} regions overlap; over ${run.settings.n.toLocaleString("en-US")} shuffles ` +
          `${r.mean.toFixed(1)} ± ${r.sd.toFixed(1)}; fold ${Number.isFinite(r.fold) ? r.fold.toFixed(2) : fold}, z ${Number.isFinite(r.z) ? r.z.toFixed(1) : "n/a"}; two-sided p = ${r.p.toPrecision(2)}, q = ${r.q.toPrecision(2)}${leftOut}`,
      };
    }

    // reldist — KS p-value drives the color but is only shown on hover
    // (via the tooltip below), not in the cell itself; the cell shows just
    // the median relative distance.
    const r = reldistCache.get(pairKey(row.id, col.id));
    if (!r) return { fill: PAPER, alpha: 0, main: "…", title: `${row.name} → ${col.name} — computing…` };
    return {
      fill: `rgba(214,40,40,${significanceAlpha(r.ksP)})`,
      alpha: significanceAlpha(r.ksP),
      main: r.median.toFixed(3),
      title: `${row.name} → ${col.name} — median reldist = ${r.median.toFixed(3)}, KS p vs. uniform = ${r.ksP.toExponential(2)}`,
    };
  }

  return (
    <div className="heatwrap">
      <div className="rowsplit" style={{ marginBottom: 10 }}>
        <div className="tabs" role="tablist" aria-label="Pairwise statistic">
          {STAT_TABS.map((t) => (
            <button
              key={t.id}
              className="tab"
              role="tab"
              aria-selected={pairwiseStat === t.id}
              onClick={() => setPairwiseStat(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {error ? (
          <span className="hint error" style={{ margin: 0 }}>
            {error}
          </span>
        ) : (
          loading && pairwiseStat !== "permutation" && (
            <span className="hint" style={{ margin: 0 }}>
              computing {pairwiseStat}…
            </span>
          )
        )}
      </div>

      {pairwiseStat === "permutation" && <PermutationControls p={perm} nSets={sets.length} />}

      <svg
        ref={ref}
        className={pairwiseStat === "permutation" && perm.stale ? "stale" : undefined}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Pairwise ${pairwiseStat} heatmap`}
      >
        <rect x={0} y={0} width={width} height={height} fill={PAPER} />
        {sets.map((col, c) => {
          const anchorX = PAD + labelW + c * CELL + CELL / 2;
          const anchorY = PAD + labelH - 8;
          return (
            <text
              key={col.id}
              x={anchorX}
              y={anchorY}
              textAnchor="end"
              fontSize={LABEL_FONT_SIZE}
              fontFamily="monospace"
              fill={INK}
              transform={`rotate(${COL_LABEL_ANGLE} ${anchorX} ${anchorY})`}
            >
              <title>{col.name}</title>
              {truncateToWidth(col.name, COL_LABEL_MAX_W, LABEL_FONT_SIZE)}
            </text>
          );
        })}
        {sets.map((row, r) => (
          <g key={row.id}>
            <text
              x={PAD + labelW - ROW_LABEL_GAP}
              y={PAD + labelH + r * CELL + CELL / 2 + 4}
              textAnchor="end"
              fontSize={LABEL_FONT_SIZE}
              fontFamily="monospace"
              fill={INK}
            >
              <title>{row.name}</title>
              {truncateToWidth(row.name, rowLabelW, LABEL_FONT_SIZE)}
            </text>
            {sets.map((col, c) => {
              const cell = renderCell(row, col);
              return (
                <g key={col.id}>
                  <title>{cell.title}</title>
                  <rect
                    x={PAD + labelW + c * CELL}
                    y={PAD + labelH + r * CELL}
                    width={CELL - 2}
                    height={CELL - 2}
                    fill={cell.fill}
                  />
                  <text
                    x={PAD + labelW + c * CELL + CELL / 2}
                    y={PAD + labelH + r * CELL + CELL / 2 + 4}
                    textAnchor="middle"
                    fontSize={LABEL_FONT_SIZE}
                    fontFamily="monospace"
                    fill={cell.alpha > 0.5 ? "#ffffff" : INK}
                  >
                    {cell.main}
                  </text>
                </g>
              );
            })}
          </g>
        ))}
      </svg>

      {pairwiseStat === "jaccard" && (
        <p className="hint">
          Cell = <code>bedtools jaccard</code> of row → column: shared base pairs over the base pairs covered by either
          set, from 0 (no overlap) to 1 (identical). Respects the Minimum overlap / advanced bedtools options setting
          above, same as the UpSet/Venn subsets.
        </p>
      )}
      {pairwiseStat === "fisher" && (
        <p className="hint">
          Color = −log10(two-tailed Fisher p-value) vs. expected-by-chance overlap; <b>lower / redder = more significant</b>.
          Respects the Minimum overlap / advanced bedtools options setting above, same as the UpSet/Venn subsets.
        </p>
      )}
      {pairwiseStat === "reldist" && (
        <p className="hint">
          Cell = median relative distance; color = −log10(KS p-value) testing the row→column relative-distance
          distribution against uniform (bedtools' own null for "unrelated") — redder = less uniform / more spatially
          related. Hover a cell for the exact p-value.
        </p>
      )}

      {pairwiseStat === "permutation" && (
        <p className="hint">
          Cell = regions of the row set overlapping the column set ÷ the mean over shuffles of the row set (1 = as expected by chance). Coloured when q &lt; 0.05 (Benjamini–Hochberg over all
          pairs): <b style={{ color: "rgb(214,40,40)" }}>red</b> more overlap than chance, <b style={{ color: "rgb(43,74,224)" }}>blue</b> less; deeper = smaller q. The smallest possible two-sided p is 2 / (permutations + 1). Hover a cell
          for counts, z and p. Uses the Minimum overlap setting above.
        </p>
      )}

      <div className="plotactions">
        <button className="iconbtn" title="Export SVG" onClick={() => ref.current && downloadSvg(ref.current, "achi-pairwise.svg")}>
          SVG
        </button>
        <button
          className="iconbtn"
          title="Export PNG"
          onClick={() => ref.current && void downloadPng(ref.current, "achi-pairwise.png")}
        >
          PNG
        </button>
      </div>
    </div>
  );
}
