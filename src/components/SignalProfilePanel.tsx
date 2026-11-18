import { useEffect, useMemo, useRef, useState } from "react";
import { interpolateLab, scaleLinear, scaleSymlog } from "d3";
import { useChosenGroups, useStore } from "../state/store";
import { sharesRegions } from "@achi/core/selection";
import { PALETTE } from "../types";
import { bigWigFor, sourceFromBigWig, type BigWigSource } from "@achi/core/bigwigSource";
import { EXACT_MAX_REGIONS, estimateExact, layerChoices, openRemoteBigWig, readSummaryLayer, type SummaryLayer } from "../lib/remoteSignal";
import { hostOf } from "../lib/remoteTracks";
import { PublicSignalPicker } from "./PublicSignalPicker";
import { binWindows, binCounts, profileStats, validateProfileParams, type ProfileParams, type ProfileRegion } from "@achi/core/signalMatrix";
import {
  MAX_SIGNAL_ROWS,
  median,
  quantile,
  runSignalProfiles,
  sample,
  signalClustersBed,
  signalMatrixTsv,
  signalRegionMeansTsv,
  signalStatsTsv,
  type PairStat,
  type SignalGroup,
  type SignalRun,
  type SignalTrack,
} from "@achi/core/signalRun";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { registerExport } from "../lib/exportRegistry";
import { signalMethods } from "@achi/core/analysisExport";
import { formatLocus } from "../lib/browserTracks";
import { truncateToWidth } from "../lib/textMeasure";
import { ComputeOverlay, type ComputeProgress } from "./ComputeStatus";
import { NumField, SettingsShell } from "./GoEnrichmentPanel";
import { Icon } from "./Icon";

/**
 * Signal profiles and heatmaps of bigWig signal over the selected subsets,
 * deepTools-style (lib/signalMatrix.ts, checked against deepTools 4.0.0).
 * The bigWigs are read in the page, in byte ranges: nothing is uploaded.
 */

const INK = "#101826";
const INK_2 = "#475467";
const INK_3 = "#8b97a9";
/** Axis lines, tick marks and the heatmap frame. */
const AXIS = "#3a4250";
const PAPER = "#ffffff";
const NA_FILL = "#eceef1";
// Sequential, one hue light -> dark (dataviz reference palette, blue 100-700).
const SEQ = ["#f7f9fd", "#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"];
const seq = scaleLinear<string>()
  .domain(SEQ.map((_, i) => i / (SEQ.length - 1)))
  .range(SEQ)
  .interpolate(interpolateLab)
  .clamp(true);

const MAX_ROWS = MAX_SIGNAL_ROWS;
const COL_W = 176;
const COL_GAP = 26;
const PROFILE_H = 120;
const LABEL_W = 132;

type Sort = "desc" | "asc" | "keep";

/** A group as shown, with its colour. */
interface Group extends SignalGroup {
  color: string;
}

/** A run as shown: core's SignalRun, the settings key it was run for, and each group with its colour. */
interface Run extends SignalRun {
  key: string;
  groups: Group[];
}

type PublicMode = "private" | "exact";

interface ExactAsk {
  n: number;
  sampledFrom: number | null;
  rows: { name: string; host: string; bytes: number; seconds: number }[];
}

// Opened remote files and downloaded summary layers, for the page session.
const remotes = new Map<string, ReturnType<typeof openRemoteBigWig>>();
const layers = new Map<string, Promise<SummaryLayer>>();
const exactSources = new Map<string, Promise<BigWigSource>>();
const remote = (url: string) => {
  let r = remotes.get(url);
  if (!r) remotes.set(url, (r = openRemoteBigWig(url)));
  return r;
};
let lastPublic: { mode: PublicMode; target: number } = { mode: "private", target: 3000 };

const SCALE_DEFAULTS = { upstream: 5000, downstream: 5000, body: 5000, binSize: 200 };
const REF_DEFAULTS = { upstream: 2000, downstream: 2000, body: 5000, binSize: 50 };

// Survive the card unmounting when the selection is cleared and re-made.
let lastRun: Run | null = null;
let lastUi: { params: ProfileParams; sort: Sort; k: number } | null = null;

function fmtV(v: number): string {
  if (Number.isNaN(v)) return "no data";
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 0.1 ? v.toFixed(2) : v.toPrecision(2);
}
function fmtP(p: number): string {
  if (Number.isNaN(p)) return "–";
  if (p === 0) return "<1e-300";
  return p < 0.001 ? p.toExponential(1) : p.toPrecision(2);
}
/** Significance stars, the common convention: ns > 0.05, * ≤ 0.05, ** ≤ 0.01, *** ≤ 0.001, **** ≤ 0.0001. */
function pStars(p: number): string {
  return p <= 1e-4 ? "****" : p <= 1e-3 ? "***" : p <= 0.01 ? "**" : p <= 0.05 ? "*" : "ns";
}

/** Test results on the box plots: significant pairs' p (or q), every pair's, stars for every pair, or none. */
/** A fixed pseudo-random number in [0, 1) for an integer (point jitter that is the same on every draw and export). */
function jitter(n: number): number {
  let t = (n + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Box-plot y axis: symmetric log (sign(x)·log(1 + |x|), so 0 and negative values work), or linear. */
type BoxScale = "log" | "linear";
let lastBoxScale: BoxScale = "log";

/**
 * Ticks for a symmetric-log axis: 0, then ±10^k, then ±2 and ±5 × 10^k,
 * each kept only if it is at least `gap` pixels from every tick already kept.
 */
function symlogTicks(y: (v: number) => number, lo: number, hi: number, gap = 18): number[] {
  const tiers: number[][] = [[0], [], []];
  for (let k = -2; k <= 9; k++)
    for (const [m, tier] of [
      [1, 1],
      [2, 2],
      [5, 2],
    ] as const) {
      const v = m * 10 ** k;
      tiers[tier].push(v, -v);
    }
  const kept: number[] = [];
  for (const tier of tiers) for (const v of tier) if (v >= lo && v <= hi && kept.every((k) => Math.abs(y(k) - y(v)) >= gap)) kept.push(v);
  return kept.sort((a, b) => a - b);
}

type PMark = "sig" | "value" | "stars" | "off";
let lastPMark: PMark = "sig";
/** Significance level for "sig": pairs with p (two subsets) or BH q (more) at or below it get a bracket. */
const ALPHA = 0.05;
/** Points drawn per subset and track in the box plots; above it, an even sample in value order. */
const MAX_POINTS = 1500;
/** Most brackets drawn over one track's box plots; with more pairs, the smallest adjusted p are drawn and the table has them all. */
const MAX_BRACKETS = 6;

/**
 * The pairs to draw as brackets over one track's boxes, each with its stack
 * level (0 is lowest): every (significant) pair when there are at most MAX_BRACKETS,
 * otherwise those with the smallest adjusted p. Narrow brackets sit below
 * wide ones; brackets that do not overlap share a level.
 */
function bracketsFor(stats: PairStat[], nGroups: number, onlySignificant: boolean): { s: PairStat; level: number }[] {
  const adj = (x: PairStat) => (nGroups > 2 ? x.q : x.p);
  stats = stats.filter((x) => !Number.isNaN(x.p) && (!onlySignificant || adj(x) <= ALPHA));
  const chosen = stats.length <= MAX_BRACKETS ? stats : [...stats].sort((x, y) => adj(x) - adj(y)).slice(0, MAX_BRACKETS);
  const placed: { s: PairStat; level: number }[] = [];
  for (const st of [...chosen].sort((x, y) => x.b - x.a - (y.b - y.a) || x.a - y.a)) {
    let level = 0;
    while (placed.some((o) => o.level === level && o.s.a <= st.b && st.a <= o.s.b)) level++;
    placed.push({ s: st, level });
  }
  return placed;
}

const kb = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(1)} kb` : `${n} bp`);
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_|_$/g, "") || "track";

/** x-axis labels of a profile, at bin positions. */
function axisTicks(p: ProfileParams): { at: number; label: string }[] {
  const { up, body, total } = binCounts(p);
  if (p.mode === "scale") return [{ at: 0, label: p.upstream ? `−${kb(p.upstream)}` : "start" }, ...(p.upstream ? [{ at: up, label: "start" }] : []), ...(p.downstream ? [{ at: up + body, label: "end" }] : []), { at: total, label: p.downstream ? `+${kb(p.downstream)}` : "end" }];
  const point = { start: "start", center: "centre", end: "end" }[p.referencePoint];
  return [
    { at: 0, label: `−${kb(p.upstream)}` },
    { at: up, label: point },
    { at: total, label: `+${kb(p.downstream)}` },
  ];
}

export function SignalProfilePanel() {
  const subsets = useStore((s) => s.subsets);
  const assembly = useStore((s) => s.assembly);
  const mainStatus = useStore((s) => s.status);
  const tracks = useStore((s) => s.signalTracks);
  const addSignalFiles = useStore((s) => s.addSignalFiles);
  const removeSignalTrack = useStore((s) => s.removeSignalTrack);
  const loadExampleSignal = useStore((s) => s.loadExampleSignal);
  const showInBrowser = useStore((s) => s.showInBrowser);

  const chosen = useChosenGroups();
  const medianLen = useMemo(() => median(chosen.flatMap((s) => s.regions.slice(0, 5000).map((r) => r.end - r.start))), [chosen]);

  const [params, setParams] = useState<ProfileParams>(() => lastUi?.params ?? (medianLen > 3000 ? { mode: "scale", referencePoint: "center", missingAsZero: false, ...SCALE_DEFAULTS } : { mode: "reference", referencePoint: "center", missingAsZero: false, ...REF_DEFAULTS }));
  const [sort, setSort] = useState<Sort>(lastUi?.sort ?? "desc");
  const [k, setK] = useState(lastUi?.k ?? 0);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [publicMode, setPublicMode] = useState<PublicMode>(lastPublic.mode);
  const [target, setTarget] = useState(lastPublic.target);
  const [picker, setPicker] = useState(false);
  const [exactAsk, setExactAsk] = useState<ExactAsk | null>(null);
  const chromSizes = useStore((s) => s.chromSizes);
  const [run, setRun] = useState<Run | null>(lastRun);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const figRef = useRef<SVGSVGElement | null>(null);
  const boxRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    lastUi = { params, sort, k };
    lastPublic = { mode: publicMode, target };
  }, [params, sort, k, publicMode, target]);

  const active = tracks.filter((t) => !off.has(t.id));
  const problem = validateProfileParams(params);
  const nRegions = chosen.reduce((a, s) => a + s.regions.length, 0);
  const publicActive = active.filter((t) => t.url);
  const key = JSON.stringify([params, sort, k, active.map((t) => t.id), chosen.map((s) => `${s.mask}:${s.nRegions}`), publicActive.length ? [publicMode, target] : null]);
  const stale = run !== null && run.key !== key;
  const busy = progress !== null;
  const hasExampleSignal = tracks.some((t) => t.source === "example");

  const setMode = (mode: ProfileParams["mode"]) => setParams((p) => (p.mode === mode ? p : { ...p, mode, ...(mode === "scale" ? SCALE_DEFAULTS : REF_DEFAULTS) }));

  const exact = publicMode === "exact" && publicActive.length > 0;
  const allRegions = () => chosen.flatMap((s, g) => s.regions.map((r) => ({ chrom: r.chrom, start: r.start, end: r.end, group: g })));

  /** Exact mode: what each public file would cost, from its size alone (asks the server for nothing but the size). */
  const askExact = async () => {
    setError(null);
    const all = allRegions();
    const n = Math.min(all.length, EXACT_MAX_REGIONS);
    const used = all.length > n ? sample(all, n) : all;
    const regionBp = used.reduce((a, r) => {
      const w = binWindows(r, params);
      return a + (Math.max(...w.map((x) => x[1])) - Math.min(...w.map((x) => x[0])));
    }, 0);
    const sizes = chromSizes[assembly];
    const genomeBp = sizes ? Object.values(sizes).reduce((a, b) => a + b, 0) : 3.1e9;
    setProgress({ done: 0, total: 0, label: "Checking the files' sizes" });
    try {
      const rows = await Promise.all(
        publicActive.map(async (t) => {
          // A server that hides Content-Range gives size 0: assume ENCODE's typical ~0.5 byte per base.
          const fileBytes = (await remote(t.url!).size()) || genomeBp * 0.5;
          const e = estimateExact({ fileBytes, genomeBp, regionBp, nRegions: n });
          return { name: t.name, host: hostOf(t.url!), ...e };
        }),
      );
      setExactAsk({ n, sampledFrom: all.length > n ? all.length : null, rows });
    } catch (err) {
      setError(`Could not read the size of a public file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProgress(null);
    }
  };

  const compute = async () => {
    if (!chosen.length || !active.length || problem) return;
    setError(null);
    setExactAsk(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const cap = exact ? EXACT_MAX_REGIONS : MAX_ROWS;
    try {
      const tracks: SignalTrack[] = active.map((t): SignalTrack => {
        if (t.file) {
          const f = t.file;
          return { id: t.id, name: t.name, how: t.source === "example" ? "example extract, 200 bp bins" : "file on this computer", open: () => bigWigFor(f) };
        }
        const url = t.url!;
        if (exact)
          return {
            id: t.id,
            name: t.name,
            how: `public, exact: range requests to ${hostOf(url)}`,
            host: hostOf(url),
            exact: true,
            concurrency: 6,
            open: () => {
              let p = exactSources.get(url);
              if (!p) exactSources.set(url, (p = sourceFromBigWig(remote(url).bw)));
              return p.catch((e) => (exactSources.delete(url), Promise.reject(e)));
            },
          };
        return {
          id: t.id,
          name: t.name,
          host: hostOf(url),
          open: async () => {
            const { bw } = remote(url);
            const header = await bw.getHeader();
            const { preferred } = layerChoices(
              header.zoomLevels.map((z) => z.reductionLevel),
              target,
            );
            if (preferred === null) throw new Error(`${t.name} has no summary layer between 100 bp and 20 kb. Use Exact for it.`);
            const lkey = `${url}|${preferred}`;
            let p = layers.get(lkey);
            if (!p) {
              p = readSummaryLayer(bw, preferred, {
                signal: ac.signal,
                onProgress: (d, n) =>
                  setProgress({
                    done: d,
                    total: n,
                    label: `Downloading the ${preferred.toLocaleString("en-US")} bp summary of ${t.name}`,
                    unit: "chromosomes",
                  }),
              });
              layers.set(lkey, p);
            }
            const src = await p.catch((e) => (layers.delete(lkey), Promise.reject(e)));
            return { chroms: src.chroms, read: src.read, how: `public, private: whole-genome ${preferred.toLocaleString("en-US")} bp summary from ${hostOf(url)}`, level: preferred };
          },
        };
      });
      const overlaps = chosen.map((ga) => chosen.map((gb) => sharesRegions(ga.mask, gb.mask, subsets)));
      const out = await runSignalProfiles(
        { assembly, params, sort, k, groups: chosen.map((g) => ({ mask: g.mask, label: g.label, regions: g.regions })), overlaps, tracks, cap },
        { signal: ac.signal, onProgress: setProgress },
      );
      setRun({ ...out, key, groups: out.groups.map((g, i) => ({ ...g, color: PALETTE[i % PALETTE.length] })) });
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  useEffect(() => {
    lastRun = run;
  }, [run]);

  // Contributes the last run to "Export analysis" while this card is shown.
  useEffect(
    () =>
      registerExport("signal", () => {
        const r = lastRun;
        if (!r) return null;
        return {
          files: [
            ...r.tracks.map((t, i) => ({
              path: `tables/signal_matrix_${slug(t.name)}.tsv`,
              content: matrixTsv(r, i),
            })),
            { path: "tables/signal_region_means.tsv", content: regionMeansTsv(r) },
            ...(r.stats.length ? [{ path: "tables/signal_tests.tsv", content: statsTsv(r) }] : []),
          ],
          methods: signalMethods({
            params: r.params,
            nRegions: r.regions.length,
            tracks: r.tracks.map((t) => t.name),
            sort: r.sort,
            k: r.k,
            nGroups: r.groups.length,
            public: r.tracks.filter((t) => t.host).map((t) => ({ name: t.name, host: t.host!, level: t.level })),
          }),
        };
      }),
    [],
  );

  const save = (text: string, name: string, type = "text/tab-separated-values") => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`annowrap${busy ? " busy" : ""}`} aria-busy={busy} style={{ minHeight: 120 }}>
      {busy && (
        <div className="sp-overlay">
          <ComputeOverlay label={progress.label} progress={progress} />
          <button className="ghost sp-cancel" onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        </div>
      )}

      <div className="sp-tracks" aria-label="Signal tracks">
        {tracks.map((t) => (
          <label key={t.id} className="sp-track" title={t.file ? `${t.file.name} · ${(t.file.size / 1048576).toFixed(1)} MB${t.source === "example" ? " · example signal, 200 bp bins" : ""}` : `Public · ${hostOf(t.url!)} · ${t.url}`}>
            <input
              type="checkbox"
              checked={!off.has(t.id)}
              onChange={() =>
                setOff((o) => {
                  const n = new Set(o);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  return n;
                })
              }
            />
            <span className="sp-track-name">{t.name}</span>
            {t.source === "public" && <span className="sp-track-tag">public</span>}
            <button className="iconbtn" aria-label={`Remove ${t.name}`} title="Remove" onClick={(e) => (e.preventDefault(), removeSignalTrack(t.id))}>
              <Icon name="close" />
            </button>
          </label>
        ))}
        <button className="ghost" onClick={() => fileInput.current?.click()}>
          Add bigWig…
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".bw,.bigwig,.bigWig"
          aria-label="bigWig files"
          onChange={(e) => {
            void addSignalFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button className="ghost" aria-expanded={picker} onClick={() => setPicker((v) => !v)} title="ENCODE, SCREEN and UCSC bigWigs, as in the genome browser, or a pasted URL">
          Public tracks…
        </button>
        {assembly === "hg38" && !hasExampleSignal && (
          <button className="ghost" onClick={() => void loadExampleSignal()} title="ENCODE H3K27ac fold change for MCF-7, GM12878, K562 and HepG2, cut to the example regions ± 10 kb and averaged in 200 bp bins (about 10 MB, from this site)">
            Load example signal
          </button>
        )}
      </div>

      {picker && <PublicSignalPicker onClose={() => setPicker(false)} />}

      {publicActive.length > 0 && (
        <div className="rowsplit sp-public" style={{ marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
          <div className="tabs" role="tablist" aria-label="Reading public tracks">
            <button className="tab" role="tab" aria-selected={publicMode === "private"} onClick={() => setPublicMode("private")} title="Download a whole-genome summary layer of each public file: the server learns nothing about your regions">
              Private (summary)
            </button>
            <button className="tab" role="tab" aria-selected={publicMode === "exact"} onClick={() => setPublicMode("exact")} title="Read each region at full resolution by range requests: the server learns roughly where your regions are">
              Exact
            </button>
          </div>
          {publicMode === "private" ? (
            <label className="checkrow" title="The file's summary layer nearest this resolution is downloaded for the whole genome. Sizes are for an ENCODE signal file; they vary by file.">
              <span className="k">Resolution</span>
              <select value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Summary resolution">
                <option value={800}>~800 bp · ~55 MB per file</option>
                <option value={3000}>~3 kb · ~14 MB per file</option>
                <option value={12000}>~12 kb · ~3 MB per file</option>
              </select>
            </label>
          ) : (
            <span className="setinfo">At most {EXACT_MAX_REGIONS.toLocaleString("en-US")} regions; asks before reading.</span>
          )}
        </div>
      )}

      {exactAsk && (
        <div className="gb-consent sp-exact" role="dialog" aria-label="Exact reading of public tracks">
          <p>
            <strong>Exact reading tells these servers roughly where your regions are.</strong> To read {exactAsk.n.toLocaleString("en-US")} regions
            {exactAsk.sampledFrom ? ` (a fixed sample of ${exactAsk.sampledFrom.toLocaleString("en-US")})` : ""} at full resolution, the browser requests the parts of each file around them, and the server's logs record which parts. Your files are not sent.
          </p>
          <ul>
            {exactAsk.rows.map((r) => (
              <li key={r.name}>
                {r.name} — {r.host}: about {r.bytes >= 1e9 ? `${(r.bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(r.bytes / 1e6))} MB`}, about {r.seconds >= 90 ? `${Math.round(r.seconds / 60)} min` : `${Math.max(5, Math.round(r.seconds))} s`}
              </li>
            ))}
          </ul>
          <div className="gb-consent-actions">
            <button className="ghost primary" onClick={() => void compute()}>
              Read exactly
            </button>
            <button className="ghost" onClick={() => setExactAsk(null)}>
              Cancel
            </button>
            <button className="ghost" onClick={() => (setExactAsk(null), setPublicMode("private"))}>
              Use private instead
            </button>
          </div>
        </div>
      )}

      <div className="rowsplit" style={{ marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
        <div className="tabs" role="tablist" aria-label="Layout">
          <button className="tab" role="tab" aria-selected={params.mode === "scale"} onClick={() => setMode("scale")} title="Every region stretched to the same length, with flanks: for broad regions (super-enhancers, genes)">
            Scale regions
          </button>
          <button className="tab" role="tab" aria-selected={params.mode === "reference"} onClick={() => setMode("reference")} title="A window around one point of each region: for peaks and TSSs">
            Reference point
          </button>
        </div>
        <button className="ghost" disabled={busy || mainStatus === "running" || !chosen.length || !active.length || !!problem} onClick={() => void (exact ? askExact() : compute())}>
          {run ? "Compute again" : "Compute profiles"}
        </button>
      </div>

      <SettingsShell
        nChanged={(() => {
          const d = params.mode === "scale" ? SCALE_DEFAULTS : REF_DEFAULTS;
          const sizes = (["upstream", "downstream", "binSize", ...(params.mode === "scale" ? ["body" as const] : [])] as const).filter((f) => params[f] !== d[f]).length;
          return sizes + [sort !== "desc", k !== 0, params.missingAsZero, params.mode === "reference" && params.referencePoint !== "center"].filter(Boolean).length;
        })()}
        onReset={() => {
          setParams((p) => ({
            ...p,
            missingAsZero: false,
            referencePoint: "center",
            ...(p.mode === "scale" ? SCALE_DEFAULTS : REF_DEFAULTS),
          }));
          setSort("desc");
          setK(0);
        }}
      >
        {params.mode === "reference" && (
          <label className="param" title="The point of each region the window is centred on. Regions from BED files carry no strand here, so start is the left end.">
            <span className="k">Reference point</span>
            <select
              value={params.referencePoint}
              onChange={(e) =>
                setParams({
                  ...params,
                  referencePoint: e.target.value as ProfileParams["referencePoint"],
                })
              }
            >
              <option value="center">Centre</option>
              <option value="start">Start</option>
              <option value="end">End</option>
            </select>
          </label>
        )}
        <NumField label="Upstream" unit="kb" scale={1000} step={0.5} value={params.upstream} def={(params.mode === "scale" ? SCALE_DEFAULTS : REF_DEFAULTS).upstream} min={0} max={100_000} onChange={(v) => setParams({ ...params, upstream: Math.round(v) })} help="Flank before the region (or the reference point)." />
        {params.mode === "scale" && <NumField label="Region body" unit="kb" scale={1000} step={0.5} value={params.body} def={SCALE_DEFAULTS.body} min={0} max={100_000} onChange={(v) => setParams({ ...params, body: Math.round(v) })} help="Every region is stretched or shrunk to this length." />}
        <NumField label="Downstream" unit="kb" scale={1000} step={0.5} value={params.downstream} def={(params.mode === "scale" ? SCALE_DEFAULTS : REF_DEFAULTS).downstream} min={0} max={100_000} onChange={(v) => setParams({ ...params, downstream: Math.round(v) })} help="Flank after the region (or the reference point)." />
        <NumField label="Bin size" unit="bp" value={params.binSize} def={(params.mode === "scale" ? SCALE_DEFAULTS : REF_DEFAULTS).binSize} min={1} max={100_000} onChange={(v) => setParams({ ...params, binSize: Math.round(v) })} help="Each bin is the mean signal over its bases with data. Flanks and body must be multiples of it." />
        <label className="param" title="Bins without data: left out of the averages (deepTools' default), or counted as 0 (--missingDataAsZero).">
          <span className="k">Missing data{params.missingAsZero && <span className="changed"> · default left out</span>}</span>
          <select value={params.missingAsZero ? "zero" : "nan"} onChange={(e) => setParams({ ...params, missingAsZero: e.target.value === "zero" })}>
            <option value="nan">Left out</option>
            <option value="zero">Counted as 0</option>
          </select>
        </label>
        <label className="param" title="Heatmap row order within each group, by the row's mean signal across the tracks.">
          <span className="k">Sort rows{sort !== "desc" && <span className="changed"> · default highest first</span>}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="desc">Highest mean first</option>
            <option value="asc">Lowest mean first</option>
            <option value="keep">File order</option>
          </select>
        </label>
        <label className="param" title="Split the rows into k clusters by their signal across all tracks (k-means, fixed seed): the heatmap is then grouped by cluster instead of subset.">
          <span className="k">Clusters (k-means){k !== 0 && <span className="changed"> · default off</span>}</span>
          <select value={k} onChange={(e) => setK(Number(e.target.value))}>
            <option value={0}>Off</option>
            {[2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                k = {n}
              </option>
            ))}
          </select>
        </label>
      </SettingsShell>

      <div className="hint" style={{ margin: "0 0 10px" }}>
        Signal of each bigWig over the {nRegions.toLocaleString("en-US")} regions of the selected subsets and sets
        {Number.isFinite(medianLen) ? ` (median length ${kb(Math.round(medianLen))})` : ""}, as deepTools computeMatrix does it. The bigWigs are read here, in the page, only where needed: nothing is uploaded.
        {nRegions > MAX_ROWS ? ` More than ${MAX_ROWS.toLocaleString("en-US")} regions: a fixed random sample of ${MAX_ROWS.toLocaleString("en-US")} is used.` : ""}
        {!tracks.length && " Add a bigWig from your computer to start."}
      </div>
      {problem && <div className="hint error">{problem}</div>}
      {error && <div className="hint error">{error}</div>}
      {stale && !busy && (
        <div className="setinfo" style={{ marginBottom: 8 }}>
          Settings, tracks or selection changed since this result. Press Compute again to update it.
        </div>
      )}

      {run && (
        <div className={stale ? "stale" : undefined}>
          <ProfileFigure run={run} svgRef={figRef} onRegion={(r) => showInBrowser(formatLocus(r))} />
          <div className="setinfo" style={{ marginTop: 4 }}>
            {run.tracks.map((t) => `${t.name}: ${t.how}`).join(" · ")}.{run.tracks.some((t) => t.level && t.level > run.params.binSize) && ` Bins of ${run.params.binSize} bp are finer than the public summary layer, so neighbouring bins repeat its values: use bins of at least the layer's size, or Exact.`}
          </div>
          <div className="plotactions">
            <button className="iconbtn" title="Download the matrices (one TSV per track, as rows of bins)" aria-label="Download signal matrices as TSV" onClick={() => run.tracks.forEach((t, i) => save(matrixTsv(run, i), `achi-signal-matrix-${slug(t.name)}.tsv`))}>
              <Icon name="download" />
            </button>
            {run.clusters && (
              <button className="iconbtn" title="Download the regions with their cluster as BED" onClick={() => save(clustersBed(run), "achi-signal-clusters.bed", "text/plain")}>
                BED
              </button>
            )}
            <button className="iconbtn" title="Export SVG" onClick={() => figRef.current && downloadSvg(figRef.current, "achi-signal-profiles.svg")}>
              SVG
            </button>
            <button className="iconbtn" title="Export PNG" onClick={() => figRef.current && void downloadPng(figRef.current, "achi-signal-profiles.png")}>
              PNG
            </button>
          </div>
          <RegionSummary run={run} svgRef={boxRef} />
          <div className="plotactions">
            <button className="iconbtn" title="Download each region's mean signal per track, and the tests, as TSV" aria-label="Download region means and tests as TSV" onClick={() => (save(regionMeansTsv(run), "achi-signal-region-means.tsv"), run.stats.length && save(statsTsv(run), "achi-signal-tests.tsv"))}>
              <Icon name="download" />
            </button>
            <button className="iconbtn" title="Export SVG" onClick={() => boxRef.current && downloadSvg(boxRef.current, "achi-signal-region-means.svg")}>
              SVG
            </button>
            <button className="iconbtn" title="Export PNG" onClick={() => boxRef.current && void downloadPng(boxRef.current, "achi-signal-region-means.png")}>
              PNG
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function bandLabel(run: Run, b: number): string {
  return run.clusters ? `Cluster ${b + 1}` : run.groups[b].label;
}
function bandColor(run: Run, b: number): string {
  return run.clusters ? PALETTE[b % PALETTE.length] : run.groups[b].color;
}

const matrixTsv = signalMatrixTsv;
const regionMeansTsv = signalRegionMeansTsv;
const statsTsv = signalStatsTsv;
const clustersBed = signalClustersBed;

/** The heatmap of one track as a PNG data URL: one pixel per bin, one row per region (or a mean of several when there are many). */
function heatmapImage(run: Run, ti: number, height: number): string {
  const m = run.matrices[ti];
  const rows = run.order.length;
  const h = Math.min(rows, Math.max(1, Math.round(height * 2)));
  const canvas = document.createElement("canvas");
  canvas.width = m.nBins;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(m.nBins, h);
  const [lo, hi] = run.ranges[ti];
  const rgb = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const na = rgb(NA_FILL);
  for (let y = 0; y < h; y++) {
    const r0 = Math.floor((y * rows) / h);
    const r1 = Math.max(r0 + 1, Math.floor(((y + 1) * rows) / h));
    for (let b = 0; b < m.nBins; b++) {
      let sum = 0;
      let k = 0;
      for (let r = r0; r < r1; r++) {
        const v = m.values[run.order[r] * m.nBins + b];
        if (!Number.isNaN(v)) {
          sum += v;
          k++;
        }
      }
      const c = k ? rgb(colorHex((sum / k - lo) / (hi - lo))) : na;
      const o = (y * m.nBins + b) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function colorHex(t: number): string {
  const c = seq(t);
  if (c.startsWith("#")) return c;
  const [r, g, b] = c.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function ProfileFigure({ run, svgRef, onRegion }: { run: Run; svgRef: React.RefObject<SVGSVGElement | null>; onRegion: (r: ProfileRegion) => void }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const nT = run.tracks.length;
  const nBands = run.clusters ? Math.max(...run.clusters) + 1 : run.groups.length;
  const rows = run.order.length;
  const heatH = Math.max(160, Math.min(520, rows * 3));
  // Legend entries wrap within the plotting width.
  const perRow = Math.max(1, Math.floor((nT * COL_W + (nT - 1) * COL_GAP) / 190));
  const legendRows = Math.ceil(nBands / perRow);
  const top = 12 + legendRows * 18 + 8;
  const profY = top + 22;
  const heatY = profY + PROFILE_H + 30;
  const x0 = 12 + LABEL_W;
  const width = x0 + nT * COL_W + (nT - 1) * COL_GAP + 14;
  const height = heatY + heatH + 58 + (run.sampledFrom ? 16 : 0);
  const nBins = run.matrices[0].nBins;
  const ticks = axisTicks(run.params);
  const bandRows = Array.from({ length: nBands }, (_, b) => run.order.filter((i) => run.band[i] === b));
  const images = useMemo(() => run.tracks.map((_, ti) => heatmapImage(run, ti, heatH)), [run, heatH]);

  // Band boundaries along the heatmap.
  let acc = 0;
  const bands = bandRows.map((r, b) => {
    const y = heatY + (acc / rows) * heatH;
    acc += r.length;
    return { b, y, h: (r.length / rows) * heatH, n: r.length };
  });

  return (
    <div className="heatwrap" style={{ position: "relative" }}>
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Signal profiles and heatmaps">
        <rect width={width} height={height} fill={PAPER} />
        {/* legend: one entry per subset (or cluster) */}
        {Array.from({ length: nBands }, (_, b) => {
          const lx = x0 + (b % perRow) * 190;
          const ly = 12 + Math.floor(b / perRow) * 18;
          return (
            <g key={b}>
              <rect x={lx} y={ly + 3} width={14} height={4} rx={2} fill={bandColor(run, b)} />
              <text x={lx + 20} y={ly + 9} fontSize={11} fill={INK}>
                {truncateToWidth(`${bandLabel(run, b)} (${bandRows[b].length.toLocaleString("en-US")})`, 168, 11)}
              </text>
            </g>
          );
        })}
        {run.tracks.map((t, ti) => {
          const cx = x0 + ti * (COL_W + COL_GAP);
          const stats = bandRows.map((r) => profileStats(run.matrices[ti].values, nBins, r));
          let lo = Infinity;
          let hi = -Infinity;
          for (const s of stats)
            for (let b = 0; b < nBins; b++)
              if (!Number.isNaN(s.mean[b])) {
                lo = Math.min(lo, s.mean[b] - s.se[b]);
                hi = Math.max(hi, s.mean[b] + s.se[b]);
              }
          if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
          lo = Math.min(0, lo);
          const y = scaleLinear()
            .domain([lo, hi])
            .nice(3)
            .range([profY + PROFILE_H, profY]);
          const x = (b: number) => cx + (b / nBins) * COL_W;
          const line = (f: (b: number) => number) => {
            let d = "";
            let pen = false;
            for (let b = 0; b < nBins; b++) {
              const v = f(b);
              if (Number.isNaN(v)) {
                pen = false;
                continue;
              }
              d += `${pen ? "L" : "M"}${(x(b) + x(b + 1)) / 2},${y(v)}`;
              pen = true;
            }
            return d;
          };
          const [rlo, rhi] = run.ranges[ti];
          return (
            <g key={t.id}>
              <text x={cx} y={profY - 10} fontSize={12} fontWeight={600} fill={INK}>
                {truncateToWidth(t.name, COL_W, 12)}
              </text>
              {y.ticks(3).map((v) => (
                <g key={v}>
                  <line x1={cx - 4} x2={cx} y1={y(v)} y2={y(v)} stroke={AXIS} />
                  <text x={cx - 7} y={y(v) + 3} fontSize={9.5} textAnchor="end" fill={INK_2}>
                    {fmtV(v)}
                  </text>
                </g>
              ))}
              <path d={`M${cx},${profY}V${profY + PROFILE_H}H${cx + COL_W}`} fill="none" stroke={AXIS} shapeRendering="crispEdges" />
              {ticks.map((tk) => (
                <g key={tk.label + tk.at}>
                  <line x1={x(tk.at)} x2={x(tk.at)} y1={profY + PROFILE_H} y2={profY + PROFILE_H + 4} stroke={AXIS} />
                  <text x={x(tk.at)} y={profY + PROFILE_H + 15} fontSize={9.5} textAnchor={tk.at === 0 ? "start" : tk.at === nBins ? "end" : "middle"} fill={INK_2}>
                    {tk.label}
                  </text>
                </g>
              ))}
              {stats.map((s, b) => {
                let band = "";
                const up: string[] = [];
                const dn: string[] = [];
                for (let i = 0; i < nBins; i++) {
                  if (Number.isNaN(s.mean[i])) continue;
                  const px = (x(i) + x(i + 1)) / 2;
                  up.push(`${px},${y(s.mean[i] + s.se[i])}`);
                  dn.unshift(`${px},${y(s.mean[i] - s.se[i])}`);
                }
                if (up.length) band = `M${up.join("L")}L${dn.join("L")}Z`;
                return (
                  <g key={b}>
                    {band && <path d={band} fill={bandColor(run, b)} opacity={0.18} />}
                    <path d={line((i) => s.mean[i])} fill="none" stroke={bandColor(run, b)} strokeWidth={2} strokeLinejoin="round" />
                  </g>
                );
              })}
              {/* hover targets: one per bin, listing each line's value */}
              {Array.from({ length: nBins }, (_, i) => (
                <rect key={i} x={x(i)} y={profY} width={Math.max(1, x(i + 1) - x(i))} height={PROFILE_H} fill="transparent">
                  <title>{`${t.name} · bin ${i + 1} of ${nBins}\n` + stats.map((s, b) => `${bandLabel(run, b)}: ${fmtV(s.mean[i])} ± ${fmtV(s.se[i])}`).join("\n")}</title>
                </rect>
              ))}
              {/* heatmap */}
              <image href={images[ti]} x={cx} y={heatY} width={COL_W} height={heatH} preserveAspectRatio="none" style={{ imageRendering: "pixelated" }} />
              {bands.slice(1).map((bd) => (
                <line key={bd.b} x1={cx} x2={cx + COL_W} y1={bd.y} y2={bd.y} stroke={PAPER} strokeWidth={2} />
              ))}
              <rect x={cx} y={heatY} width={COL_W} height={heatH} fill="none" stroke={AXIS} shapeRendering="crispEdges" />
              <rect
                x={cx}
                y={heatY}
                width={COL_W}
                height={heatH}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onMouseMove={(e) => {
                  const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                  const fy = (e.clientY - box.top) / box.height;
                  const fx = (e.clientX - box.left) / box.width;
                  const row = run.order[Math.min(rows - 1, Math.max(0, Math.floor(fy * rows)))];
                  const bin = Math.min(nBins - 1, Math.max(0, Math.floor(fx * nBins)));
                  const r = run.regions[row];
                  const v = run.matrices[ti].values[row * nBins + bin];
                  const wrapEl = e.currentTarget.ownerSVGElement?.parentElement;
                  if (!wrapEl) return;
                  const wrap = wrapEl.getBoundingClientRect();
                  setHover({
                    x: e.clientX - wrap.left + 12,
                    y: e.clientY - wrap.top + 12,
                    text: `${formatLocus(r)} · ${run.groups[r.group].label}${run.clusters ? ` · cluster ${run.clusters[row] + 1}` : ""}\n${t.name}: bin ${bin + 1} ${fmtV(v)} · region mean ${fmtV(run.matrices[ti].regionMeans![row])}\nClick to show it in the genome browser`,
                  });
                }}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                  const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                  const row = run.order[Math.min(rows - 1, Math.max(0, Math.floor(((e.clientY - box.top) / box.height) * rows)))];
                  onRegion(run.regions[row]);
                }}
              />
              {/* colour scale */}
              <defs>
                <linearGradient id={`sp-grad-${ti}`} x1="0" x2="1" y1="0" y2="0">
                  {SEQ.map((c, i) => (
                    <stop key={c} offset={`${(i / (SEQ.length - 1)) * 100}%`} stopColor={c} />
                  ))}
                </linearGradient>
              </defs>
              <rect x={cx} y={heatY + heatH + 14} width={COL_W} height={9} rx={2} fill={`url(#sp-grad-${ti})`} />
              <text x={cx} y={heatY + heatH + 36} fontSize={9.5} fill={INK_3}>
                {fmtV(rlo)}
              </text>
              <text x={cx + COL_W} y={heatY + heatH + 36} fontSize={9.5} textAnchor="end" fill={INK_3}>
                {fmtV(rhi)}+
              </text>
              <text x={cx + COL_W / 2} y={heatY + heatH + 36} fontSize={9.5} textAnchor="middle" fill={INK_3}>
                signal (grey: no data)
              </text>
            </g>
          );
        })}
        {/* band labels at the left of the heatmaps */}
        {bands.map((bd) => (
          <g key={bd.b}>
            <rect x={x0 - 8} y={bd.y + 1} width={4} height={Math.max(1, bd.h - 2)} rx={2} fill={bandColor(run, bd.b)} />
            {bd.h >= 14 && (
              <text x={x0 - 14} y={bd.y + Math.min(bd.h / 2, 14) + 4} fontSize={10.5} textAnchor="end" fill={INK}>
                {truncateToWidth(bandLabel(run, bd.b), LABEL_W - 18, 10.5)}
              </text>
            )}
          </g>
        ))}
        <text x={12} y={profY + PROFILE_H / 2} fontSize={10} fill={INK_3}>
          mean ± SE
        </text>
        {run.sampledFrom && (
          <text x={x0} y={height - 8} fontSize={10} fill={INK_3}>
            {`A fixed random sample of ${rows.toLocaleString("en-US")} of ${run.sampledFrom.toLocaleString("en-US")} regions.`}
          </text>
        )}
      </svg>
      {hover && (
        <div className="sp-tip" style={{ left: hover.x, top: hover.y }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}

/** Each region's mean signal per subset and track (box plots), and the Mann–Whitney tests between subsets. */
function RegionSummary({ run, svgRef }: { run: Run; svgRef: React.RefObject<SVGSVGElement | null> }) {
  const nT = run.tracks.length;
  const nG = run.groups.length;
  // Wider than the profile columns: a slot of at least 64 px per subset.
  const BOX_COL = Math.max(240, 24 + nG * 64);
  const slot = (BOX_COL - 20) / nG;
  const boxW = Math.max(20, Math.min(48, Math.floor(slot) - 16));
  const [pMark, setPMarkState] = useState<PMark>(lastPMark);
  const [scale, setScaleState] = useState<BoxScale>(lastBoxScale);
  const setScale = (m: BoxScale) => {
    lastBoxScale = m;
    setScaleState(m);
  };
  const setPMark = (m: PMark) => {
    lastPMark = m;
    setPMarkState(m);
  };
  const brackets = run.tracks.map((_, ti) =>
    pMark === "off"
      ? []
      : bracketsFor(
          run.stats.filter((st) => st.ti === ti),
          nG,
          pMark === "sig",
        ),
  );
  const levels = Math.max(0, ...brackets.flat().map((b) => b.level + 1));
  const BR = 15;
  const panelH = 210;
  const top = 34 + levels * BR;
  const x0 = 12 + 40;
  const width = x0 + nT * BOX_COL + (nT - 1) * COL_GAP + 14;
  // Legend entries wrap within the plotting width.
  const perRow = Math.max(1, Math.floor((width - x0 - 8) / 170));
  const legendRows = Math.ceil(nG / perRow);
  const height = top + panelH + 22 + legendRows * 16;
  return (
    <>
      <div className="heatwrap" style={{ marginTop: 14 }}>
        <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Mean signal per region by subset">
          <rect width={width} height={height} fill={PAPER} />
          <text x={12} y={16} fontSize={11.5} fontWeight={600} fill={INK}>
            Mean signal per region
          </text>
          {run.tracks.map((t, ti) => {
            const cx = x0 + ti * (BOX_COL + COL_GAP);
            const vals = run.groups.map((_, g) =>
              run.regions
                .map((r, i) => (r.group === g ? run.matrices[ti].regionMeans![i] : NaN))
                .filter((v) => !Number.isNaN(v))
                .sort((a, b) => a - b),
            );
            // From 0 (or the smallest value) up to the largest: every point is drawn where it is.
            let lo = 0;
            let hi = -Infinity;
            for (const v of vals) if (v.length) [lo, hi] = [Math.min(lo, v[0]), Math.max(hi, v[v.length - 1])];
            if (!Number.isFinite(hi)) hi = 1;
            const y =
              scale === "log"
                ? scaleSymlog()
                    .domain([lo, hi > lo ? hi : lo + 1])
                    .range([top + panelH, top + 10])
                : scaleLinear()
                    .domain([lo, hi > lo ? hi : lo + 1])
                    .nice(4)
                    .range([top + panelH, top + 10]);
            const [, yMax] = y.domain();
            const yTicks = scale === "log" ? symlogTicks(y, ...(y.domain() as [number, number])) : y.ticks(4);
            const boxMid = (g: number) => cx + 10 + g * slot + slot / 2;
            return (
              <g key={t.id}>
                <text x={cx} y={34} fontSize={11} fill={INK_2}>
                  {truncateToWidth(t.name, BOX_COL, 11)}
                </text>
                {yTicks.map((v) => (
                  <g key={v}>
                    <line x1={cx - 4} x2={cx} y1={y(v)} y2={y(v)} stroke={AXIS} />
                    <text x={cx - 7} y={y(v) + 3} fontSize={9.5} textAnchor="end" fill={INK_2}>
                      {fmtV(v)}
                    </text>
                  </g>
                ))}
                <path d={`M${cx},${top + 10}V${top + panelH}H${cx + BOX_COL}`} fill="none" stroke={AXIS} shapeRendering="crispEdges" />
                {brackets[ti].map(({ s, level }) => {
                  const by = top + 4 - level * BR;
                  const xa = boxMid(s.a) + 2;
                  const xb = boxMid(s.b) - 2;
                  const p = nG > 2 ? s.q : s.p;
                  return (
                    <g key={`${s.a}-${s.b}`}>
                      <title>{`${run.groups[s.a].label} vs ${run.groups[s.b].label} · ${t.name}\nMann–Whitney U two-sided p ${fmtP(s.p)}${nG > 2 ? ` · BH q ${fmtP(s.q)}` : ""}`}</title>
                      <path d={`M${xa},${by + 4}V${by}H${xb}V${by + 4}`} fill="none" stroke={AXIS} />
                      <text x={(xa + xb) / 2} y={by - 3} fontSize={9.5} textAnchor="middle" fill={INK}>
                        {pMark === "stars" ? pStars(p) : `${nG > 2 ? "q" : "p"} = ${fmtP(p)}`}
                      </text>
                    </g>
                  );
                })}
                {vals.map((v, g) => {
                  if (!v.length) return null;
                  const q1 = quantile(v, 0.25);
                  const q2 = quantile(v, 0.5);
                  const q3 = quantile(v, 0.75);
                  const iqr = q3 - q1;
                  const wlo = v.find((z) => z >= q1 - 1.5 * iqr) ?? q1;
                  const whi = [...v].reverse().find((z) => z <= q3 + 1.5 * iqr) ?? q3;
                  const bx = boxMid(g) - boxW / 2;
                  const mid = boxMid(g);
                  // Every region as a point, jittered across the box (an even sample above MAX_POINTS), under the box outline.
                  const step = Math.max(1, v.length / MAX_POINTS);
                  const shown: number[] = [];
                  for (let i = 0; i < v.length; i += step) shown.push(v[Math.floor(i)]);
                  const color = run.groups[g].color;
                  const cy = (z: number) => y(Math.min(z, yMax));
                  const cap = boxW * 0.3;
                  return (
                    <g key={g}>
                      <title>{`${run.groups[g].label} · ${t.name}\nn ${v.length.toLocaleString("en-US")} · median ${fmtV(q2)} · quartiles ${fmtV(q1)}–${fmtV(q3)}`}</title>
                      {shown.map((z, i) => (
                        <circle key={i} cx={mid + (jitter(i * 7919 + g * 104729 + ti) - 0.5) * boxW * 0.9} cy={cy(z)} r={1.8} fill={color} fillOpacity={0.5} />
                      ))}
                      <path d={`M${mid},${cy(wlo)}V${cy(q1)}M${mid},${cy(q3)}V${cy(whi)}M${mid - cap},${cy(wlo)}H${mid + cap}M${mid - cap},${cy(whi)}H${mid + cap}`} fill="none" stroke={AXIS} strokeWidth={1.25} />
                      <rect x={bx} y={cy(q3)} width={boxW} height={Math.max(1, cy(q1) - cy(q3))} fill="none" stroke={AXIS} strokeWidth={1.25} />
                      <line x1={bx} x2={bx + boxW} y1={cy(q2)} y2={cy(q2)} stroke={AXIS} strokeWidth={2.25} />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {run.groups.map((g, i) => (
            <g key={g.mask}>
              <circle cx={x0 + (i % perRow) * 170 + 5} cy={top + panelH + 16 + Math.floor(i / perRow) * 16} r={4} fill={g.color} />
              <text x={x0 + (i % perRow) * 170 + 20} y={top + panelH + 20 + Math.floor(i / perRow) * 16} fontSize={10.5} fill={INK}>
                {truncateToWidth(g.label, 145, 10.5)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="sp-pmark">
        <label className="param">
          <span className="k">Y axis</span>
          <select value={scale} onChange={(e) => setScale(e.target.value as BoxScale)} aria-label="Box plot y axis">
            <option value="log">Log (symmetric)</option>
            <option value="linear">Linear</option>
          </select>
        </label>
        {run.stats.length > 0 && (
          <label className="param">
            <span className="k">On the box plots</span>
            <select value={pMark} onChange={(e) => setPMark(e.target.value as PMark)} aria-label="Test results on the box plots">
              <option value="sig">{`Significant ${nG > 2 ? "q" : "p"}-values (≤ ${ALPHA})`}</option>
              <option value="value">{`All ${nG > 2 ? "q" : "p"}-values`}</option>
              <option value="stars">Significance stars, all pairs</option>
              <option value="off">Nothing</option>
            </select>
          </label>
        )}
        {pMark !== "off" && run.stats.length / nT > MAX_BRACKETS && <span className="setinfo">{`${run.stats.length / nT} pairs per track: at most ${MAX_BRACKETS}, those with the smallest q, are drawn; all are in the table.`}</span>}
        {pMark === "sig" && run.tracks.every((_, ti) => !brackets[ti].length) && <span className="setinfo">{`No pair has ${nG > 2 ? "q" : "p"} ≤ ${ALPHA}.`}</span>}
        {run.stats.some((st) => st.untested === "overlap") && <span className="setinfo">– : the two share regions (a whole set and its own subsets, or overlapping sets), so they are not independent and are not tested.</span>}
        {run.stats.some((st) => st.untested === "nodata") && <span className="setinfo">– : one of the two has no signal at any of its regions, so they are not tested.</span>}
      </div>
      {run.stats.length > 0 && (
        <div className="regions-scroll" style={{ maxHeight: 220, marginTop: 8 }}>
          <table className="subtable" aria-label="Mann–Whitney tests of mean signal per region between subsets">
            <thead>
              <tr>
                <th>Track</th>
                <th>Subset A</th>
                <th>Subset B</th>
                <th title="Median of the regions' mean signal">Median A</th>
                <th>Median B</th>
                <th title="Two-sided Mann–Whitney U test">p</th>
                {run.groups.length > 2 && <th title="Benjamini–Hochberg across the pairs of this track">q</th>}
              </tr>
            </thead>
            <tbody>
              {run.stats.map((s, i) => (
                <tr key={i}>
                  <td>{s.track}</td>
                  <td>{run.groups[s.a].label}</td>
                  <td>{run.groups[s.b].label}</td>
                  <td className="mono">{`${fmtV(s.medianA)} (n ${s.nA.toLocaleString("en-US")})`}</td>
                  <td className="mono">{`${fmtV(s.medianB)} (n ${s.nB.toLocaleString("en-US")})`}</td>
                  <td className="mono">{fmtP(s.p)}</td>
                  {run.groups.length > 2 && <td className="mono">{fmtP(s.q)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="setinfo" style={{ marginTop: 6 }}>
        {scale === "log" ? "Y axis: symmetric log, sign(x)·ln(1 + |x|). " : ""}Points: each region's mean signal, coloured by subset and spread sideways at random (at most {MAX_POINTS.toLocaleString("en-US")} per subset, an even sample above that). Box: quartiles and median; whiskers: 1.5 × IQR.
        {pMark === "sig" ? ` Brackets: pairs with ${run.groups.length > 2 ? "q" : "p"} ≤ ${ALPHA}.` : ""} Tests compare subsets, two-sided Mann–Whitney U on each region's mean signal
        {run.groups.length > 2 ? ", Benjamini–Hochberg across the pairs of each track" : ""}.{pMark === "stars" ? ` Stars on the plot: ns > 0.05, * ≤ 0.05, ** ≤ 0.01, *** ≤ 0.001, **** ≤ 0.0001 (${run.groups.length > 2 ? "q" : "p"}).` : ""}
        {run.clusters ? " Clusters are not tested: they are made from the signal itself." : ""}
      </div>
    </>
  );
}
