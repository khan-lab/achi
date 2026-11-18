import { useEffect, useRef, useState } from "react";
import { color as d3color, interpolateLab } from "d3";
import { useChosenGroups, useStore } from "../state/store";
import { chosenGroups } from "@achi/core/selection";
import { buildUniverse } from "@achi/core/subsetEnrichment";
import { centreWindow, twoBitBlobSource, type SequenceSource } from "@achi/core/genomeSequence";
import { exactTwoBitSource, fastaSource, opfsStore, privateTwoBitSource } from "../lib/genomeSequence";
import { prepareLocalReference } from "../lib/localTracks";
import { backgroundOf, encodeSequence, packSequences } from "@achi/core/pwm";
import { compositionStrata, cpgRatio, gcPerMille, motifEnrichment, scanPlan, MAX_POOL, type MotifCell } from "@achi/core/motifEnrichment";
import { scanMotifs } from "../lib/motifScan";
import { registerExport } from "../lib/exportRegistry";
import { DEFAULT_COLLECTION, MOTIF_COLLECTIONS, collectionById, mergeCollections, type JasparFile, type JasparMotif, type MotifCollection } from "@achi/core/motifCollections";
import { motifMethods } from "@achi/core/analysisExport";
import { downloadPng, downloadSvg } from "../lib/exportImage";
import { estimateTextWidth, truncateToWidth } from "../lib/textMeasure";
import { ComputeOverlay, type ComputeProgress } from "./ComputeStatus";
import { SettingsShell } from "./GoEnrichmentPanel";
import { Icon } from "./Icon";
import { TopRowsInput } from "./TopRowsInput";
import { DEFAULT_TOP_ROWS, rankRows } from "@achi/core/heatmapRows";

/**
 * Motif enrichment of the selected subsets and sets: JASPAR 2026 CORE
 * vertebrate matrices scanned in the page over a window around each
 * region's centre, each group against the other regions of the analysis
 * (lib/motifEnrichment.ts; null model in docs/methods.md). The genome
 * sequence comes from the user's own FASTA or .2bit, or from UCSC either as
 * whole chromosomes (private) or by range requests (exact, asked each run).
 */

const jasparFiles = new Map<string, Promise<JasparFile>>();
/** One collection file (refdata/jaspar), once per page session. */
function loadJasparFile(file: string): Promise<JasparFile> {
  let p = jasparFiles.get(file);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}refdata/jaspar/${file}`).then((r) => (r.ok ? (r.json() as Promise<JasparFile>) : Promise.reject(new Error(`Could not load the JASPAR matrices (${file}).`))));
    jasparFiles.set(file, p);
    p.catch(() => jasparFiles.delete(file));
  }
  return p;
}

/** UCSC's .2bit for the assembly (checked: CORS and range requests allowed for all four). */
const ucscTwoBit = (assembly: string) => `https://hgdownload.soe.ucsc.edu/goldenPath/${assembly}/bigZips/${assembly}.2bit`;
const UCSC_HOST = "hgdownload.soe.ucsc.edu";
/** Canonical chromosomes of each .2bit, about (MB), for the private download note. */
const CANONICAL_MB: Record<string, number> = { hg38: 775, hg19: 780, mm10: 680, mm9: 670 };
const EXACT_MAX = 2_000;

type SourceMode = "local" | "private" | "exact";
// Agreed hosts and the chosen source, for the page session.
const agreedPrivate = new Set<string>();
let lastUi = { mode: "local" as SourceMode, half: 100, p: 1e-4, perFamily: true, collection: DEFAULT_COLLECTION, top: DEFAULT_TOP_ROWS };
let lastResult: RunResult | null = null;
let localSource: { source: SequenceSource; name: string; assembly: string } | null = null;

interface RunResult {
  key: string;
  release: string;
  collection: MotifCollection;
  motifs: JasparMotif[];
  keys: number[];
  cells: MotifCell[];
  half: number;
  p: number;
  nScanned: number;
  nUniverse: number;
  nNoSequence: number;
  source: string;
  assembly: string;
}

const INK = "#101826";
const INK_3 = "#8b97a9";
/** The heatmap frame (as the signal heatmaps). */
const AXIS = "#3a4250";
const PAPER = "#ffffff";
const NA_FILL = "#f4f5f7";
const DEPLETED = "#2a78d6";
const NEUTRAL = "#f0efec";
const ENRICHED = "#e34948";
const LOGO = ["#109648", "#255C99", "#F7B32B", "#D62839"]; // A C G T
const LOG2_CLIP = 3;
const CELL_W = 40;
const CELL_H = 26;
const PAD = 10;

function cellColor(or: number): string {
  if (Number.isNaN(or)) return NA_FILL;
  const v = Math.max(-LOG2_CLIP, Math.min(LOG2_CLIP, Math.log2(or))) / LOG2_CLIP;
  return v < 0 ? interpolateLab(NEUTRAL, DEPLETED)(-v) : interpolateLab(NEUTRAL, ENRICHED)(v);
}
function textOn(fill: string): string {
  const c = d3color(fill)?.rgb();
  if (!c) return INK;
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 140 ? "#ffffff" : INK;
}
const stars = (q: number) => (q < 0.001 ? "***" : q < 0.01 ? "**" : q < 0.05 ? "*" : "");
const fmtOr = (or: number) => (Number.isNaN(or) ? "n/a" : or === Infinity ? "∞" : or >= 10 ? or.toFixed(0) : or >= 1 ? or.toFixed(1) : or.toFixed(2));
const fmtP = (p: number) => (p === 0 ? "<1e-300" : p < 0.001 ? p.toExponential(1) : p.toPrecision(2));
const pct = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(1)}%` : "–");
const familyOf = (m: JasparMotif) => (m.family.length ? m.family.join(" / ") : m.name);

/** A sequence logo (information content, bits) drawn in SVG, letters stacked smallest first. */
function MotifLogo({ pfm, x, y, w, h }: { pfm: number[][]; x: number; y: number; w: number; h: number }) {
  const colW = w / pfm.length;
  return (
    <g>
      {pfm.map((col, j) => {
        const n = col[0] + col[1] + col[2] + col[3];
        const p = col.map((c) => (c + 0.2) / (n + 0.8));
        const ic = Math.max(0, 2 + p.reduce((a, v) => a + v * Math.log2(v), 0));
        let top = y + h;
        return [0, 1, 2, 3]
          .sort((a, b) => p[a] - p[b])
          .map((b) => {
            const lh = (p[b] * ic * h) / 2;
            top -= lh;
            if (lh < 0.6) return null;
            // A bold sans capital is about 0.72 em tall and 0.68 em wide.
            const fs = lh / 0.72;
            return (
              <text
                key={b}
                x={0}
                y={0}
                fontSize={fs}
                fontWeight={700}
                fontFamily="Arial, Helvetica, sans-serif"
                fill={LOGO[b]}
                transform={`translate(${x + j * colW} ${top + lh}) scale(${colW / (fs * 0.68)} 1)`}
              >
                {"ACGT"[b]}
              </text>
            );
          });
      })}
    </g>
  );
}

export function MotifEnrichmentPanel() {
  const subsets = useStore((s) => s.subsets);
  const sets = useStore((s) => s.sets);
  const assembly = useStore((s) => s.assembly);
  const chromSizes = useStore((s) => s.chromSizes);
  const mainStatus = useStore((s) => s.status);
  const chosen = useChosenGroups();
  const [mode, setModeState] = useState<SourceMode>(lastUi.mode);
  const [half, setHalfState] = useState(lastUi.half);
  const [p, setPState] = useState(lastUi.p);
  const [perFamily, setPerFamilyState] = useState(lastUi.perFamily);
  const setMode = (m: SourceMode) => ((lastUi = { ...lastUi, mode: m }), setModeState(m));
  const setHalf = (v: number) => ((lastUi = { ...lastUi, half: v }), setHalfState(v));
  const setP = (v: number) => ((lastUi = { ...lastUi, p: v }), setPState(v));
  const setPerFamily = (v: boolean) => ((lastUi = { ...lastUi, perFamily: v }), setPerFamilyState(v));
  const [top, setTopState] = useState(lastUi.top);
  const setTop = (v: number) => ((lastUi = { ...lastUi, top: v }), setTopState(v));
  const [collectionId, setCollectionState] = useState(lastUi.collection);
  const setCollection = (v: string) => ((lastUi = { ...lastUi, collection: v }), setCollectionState(v));
  const collection = collectionById(collectionId);
  const [local, setLocal] = useState(localSource);
  const [ask, setAsk] = useState<null | "private" | "exact">(null);
  const [result, setResult] = useState<RunResult | null>(lastResult);
  const [progress, setProgress] = useState<ComputeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const busy = progress !== null;

  const included = sets.filter((s) => s.included);
  const universeSig = subsets.map((s) => `${s.mask}:${s.nRegions}:${s.nBp}`).join(",");
  const localOk = local && local.assembly === assembly;
  const sourceLabel = mode === "local" ? (localOk ? local!.source.label : null) : mode === "private" ? `${UCSC_HOST}, private (whole chromosomes)` : `${UCSC_HOST}, exact (range requests per region)`;
  const key = JSON.stringify([assembly, chosen.map((c) => c.mask), universeSig, half, p, sourceLabel, collection.id]);
  const stale = result !== null && result.key !== key;
  const nUniverse = subsets.reduce((a, s) => a + s.regions.length, 0);
  const listMode = sets.some((s) => s.items);

  const addLocal = async (all: File[]) => {
    if (!all.length) return;
    setError(null);
    const twoBit = all.find((f) => /\.2bit$/i.test(f.name));
    if (twoBit) {
      localSource = { source: twoBitBlobSource(twoBit, twoBit.name), name: twoBit.name, assembly };
      setLocal(localSource);
      return;
    }
    const fasta = all.find((f) => /\.(fa|fasta|fna)$/i.test(f.name));
    const fai = all.find((f) => /\.fai$/i.test(f.name));
    if (!fasta || !fai) {
      setError("Choose a .2bit file, or a FASTA (.fa) together with its index (.fai). Compressed FASTA is not supported.");
      return;
    }
    const ref = await prepareLocalReference(fasta, fai, chromSizes[assembly], `motif-ref`);
    if ("error" in ref) {
      setError(ref.error);
      return;
    }
    localSource = { source: fastaSource(ref), name: fasta.name, assembly };
    setLocal(localSource);
  };

  const run = async (agreed = false) => {
    if (!chosen.length || busy) return;
    if (mode === "local" && !localOk) {
      setError(`Choose the ${assembly} genome on this computer first (a .2bit, or a FASTA with its .fai).`);
      return;
    }
    if (!agreed && ((mode === "private" && !agreedPrivate.has(assembly)) || mode === "exact")) {
      setAsk(mode);
      return;
    }
    setAsk(null);
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      setProgress({ done: 0, total: 0, label: "Loading JASPAR matrices" });
      const docs = await Promise.all(collection.files.map(loadJasparFile));
      const jaspar = { release: docs[0].release, motifs: mergeCollections(docs) };
      const universe = buildUniverse(subsets);
      const regions = subsets.flatMap((s) => s.regions);
      const keys = chosen.map((c) => c.mask);
      let plan = scanPlan(universe.owner, keys);
      if (mode === "exact" && plan.scan.length > EXACT_MAX) plan = scanPlan(universe.owner, keys, { maxPool: EXACT_MAX / 2, maxGroup: Math.max(100, Math.floor(EXACT_MAX / 2 / keys.length)) });
      const windows = Array.from(plan.scan, (i) => centreWindow(regions[i], half));
      const source =
        mode === "local"
          ? local!.source
          : mode === "private"
            ? privateTwoBitSource(ucscTwoBit(assembly), { store: await opfsStore(`achi-genome-${assembly}`) })
            : exactTwoBitSource(ucscTwoBit(assembly));
      setProgress({ done: 0, total: windows.length, label: "Reading sequence", unit: "regions" });
      const seqs = await source.read(windows, {
        signal: ac.signal,
        onProgress: (pr) =>
          setProgress({ done: pr.unit === "bytes" ? pr.done / 1e6 : pr.done, total: pr.unit === "bytes" ? pr.total / 1e6 : pr.total, label: pr.label, unit: pr.unit === "bytes" ? "MB" : pr.unit }),
      });
      const codes = seqs.map((s) => (s ? encodeSequence(s) : new Uint8Array(0)));
      const gc = Int32Array.from(codes, gcPerMille);
      const valid = Uint8Array.from(gc, (g) => (g >= 0 ? 1 : 0));
      const nNoSequence = valid.length - valid.reduce((a, v) => a + v, 0);
      if (nNoSequence === valid.length) throw new Error(`No sequence was found for these regions in ${source.label}: is it the ${assembly} genome?`);
      const bg = backgroundOf(codes.filter((_, i) => valid[i]));
      const packed = packSequences(codes);
      setProgress({ done: 0, total: jaspar.motifs.length, label: `Scanning ${jaspar.motifs.length.toLocaleString("en-US")} JASPAR motifs`, unit: "motifs" });
      const scan = await scanMotifs(
        packed,
        jaspar.motifs.map((m) => m.pfm),
        bg,
        p,
        { signal: ac.signal, onProgress: (d, t) => setProgress({ done: d, total: t, label: `Scanning ${t.toLocaleString("en-US")} JASPAR motifs`, unit: "motifs" }) },
      );
      const owner = Int32Array.from(plan.scan, (i) => universe.owner[i]);
      const cells = motifEnrichment({ owner, pool: plan.pool, valid, strata: compositionStrata(gc, Float64Array.from(codes, cpgRatio)), hits: scan.hits, keys });
      if (mode === "private") agreedPrivate.add(assembly);
      const r: RunResult = {
        key,
        release: jaspar.release,
        collection,
        motifs: jaspar.motifs,
        keys,
        cells,
        half,
        p,
        nScanned: plan.scan.length,
        nUniverse: universe.owner.length,
        nNoSequence,
        source: source.label,
        assembly,
      };
      lastResult = r;
      setResult(r);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  };

  const groupOf = (k: number) => chosenGroups([k], subsets, included)[0];
  const tsvText = (r: RunResult) => {
    const head = ["group", "matrix_id", "collection", "tf", "class", "family", "group_with_site", "group_regions", "rest_with_site", "rest_regions", "odds_ratio", "p", "q", "test"];
    const rows = r.cells.map((c) => {
      const m = r.motifs[c.motif];
      const t = c.table;
      return [groupOf(c.key)?.label ?? c.key, m.id, m.id.startsWith("UN") ? "UNVALIDATED" : "CORE", m.name, m.class.join("; "), m.family.join("; "), t[0], t[0] + t[1], t[2], t[2] + t[3], c.oddsRatio, c.p, c.q, "CMH, 15 strata (GC quintile x CpG o/e tertile)"].join("\t");
    });
    return [head.join("\t"), ...rows].join("\n") + "\n";
  };
  const tsvRef = useRef(tsvText);
  useEffect(() => {
    tsvRef.current = tsvText;
  });
  useEffect(
    () =>
      registerExport("motifs", () =>
        lastResult
          ? {
              files: [{ path: "tables/motif_enrichment_jaspar.tsv", content: tsvRef.current(lastResult) }],
              methods: motifMethods({
                release: lastResult.release,
                collection: lastResult.collection.methods,
                nMotifs: lastResult.motifs.length,
                half: lastResult.half,
                p: lastResult.p,
                nScanned: lastResult.nScanned,
                nUniverse: lastResult.nUniverse,
                source: lastResult.source,
                assembly: lastResult.assembly,
              }),
            }
          : null,
      ),
    [],
  );
  const save = (text: string, name: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/tab-separated-values" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (listMode) return null;

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

      <div className="rowsplit" style={{ marginBottom: 8, gap: 10, flexWrap: "wrap" }}>
        <div className="tabs" role="tablist" aria-label="Genome sequence">
          <button className="tab" role="tab" aria-selected={mode === "local"} onClick={() => setMode("local")} title="Your own genome file: nothing is downloaded">
            This computer
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={mode === "private"}
            onClick={() => setMode("private")}
            title={`Whole chromosomes from ${UCSC_HOST}, the same download whatever your regions; kept in this browser for later runs`}
          >
            Private download
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={mode === "exact"}
            onClick={() => setMode("exact")}
            title={`Only the sequence of your regions, by range requests to ${UCSC_HOST}: the server sees roughly where they are`}
          >
            Exact
          </button>
        </div>
        <button className="ghost" disabled={busy || mainStatus === "running" || !chosen.length} onClick={() => void run()}>
          {result ? "Run again" : "Run motif enrichment"}
        </button>
      </div>

      {mode === "local" && (
        <div className="sp-tracks" style={{ marginBottom: 8 }}>
          {localOk ? (
            <span className="sp-track">
              <span className="sp-track-name">{local!.name}</span>
              <button className="iconbtn" aria-label="Remove the genome file" onClick={() => ((localSource = null), setLocal(null))}>
                <Icon name="close" size={12} />
              </button>
            </span>
          ) : null}
          <label className="ghost" style={{ cursor: "pointer" }}>
            {localOk ? "Change genome…" : `Choose the ${assembly} genome…`}
            <input
              type="file"
              multiple
              accept=".2bit,.fa,.fasta,.fna,.fai"
              aria-label="Genome sequence files"
              style={{ display: "none" }}
              onChange={(e) => {
                const files = e.target.files ? [...e.target.files] : [];
                e.target.value = "";
                void addLocal(files);
              }}
            />
          </label>
          <span className="setinfo">A .2bit, or a FASTA (.fa) with its index (.fai). Read here; nothing is uploaded or downloaded.</span>
        </div>
      )}
      {mode === "private" && (
        <div className="setinfo" style={{ marginBottom: 8 }}>
          Downloads the {assembly} chromosomes (chr1–22, X, Y, M; about {CANONICAL_MB[assembly] ?? 700} MB) from {UCSC_HOST} once and keeps them in this browser for later runs. The download is the
          same whatever your regions, so the server learns nothing about them.
        </div>
      )}
      {mode === "exact" && (
        <div className="setinfo" style={{ marginBottom: 8 }}>
          Reads only your regions' sequence from {UCSC_HOST} (a few MB), so the server sees roughly where they are; asked every run. Up to {EXACT_MAX.toLocaleString("en-US")} regions.
        </div>
      )}

      {ask && (
        <div className="sp-exact" role="dialog" aria-label="Confirm the genome download">
          {ask === "private" ? (
            <p>
              Download the {assembly} genome (about {CANONICAL_MB[assembly] ?? 700} MB) from <strong>{UCSC_HOST}</strong>? Only once: it is kept in this browser. The server sees the same download
              whatever your regions.
            </p>
          ) : (
            <p>
              Read the sequence of up to {Math.min(EXACT_MAX, nUniverse).toLocaleString("en-US")} of your regions from <strong>{UCSC_HOST}</strong> by range requests? The requests show the server
              roughly where these regions are.
            </p>
          )}
          <div className="gb-consent-actions">
            <button className="ghost primary" onClick={() => void run(true)}>
              {ask === "private" ? "Download and run" : "Read and run"}
            </button>
            <button className="ghost" onClick={() => setAsk(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <SettingsShell
        nChanged={[half !== 100, p !== 1e-4, collection.id !== DEFAULT_COLLECTION].filter(Boolean).length}
        onReset={() => {
          setHalf(100);
          setP(1e-4);
          setCollection(DEFAULT_COLLECTION);
        }}
      >
        <label className="param" title={collection.help}>
          <span className="k">Motif collection{collection.id !== DEFAULT_COLLECTION && <span className="changed"> · default CORE, non-redundant</span>}</span>
          <select value={collection.id} onChange={(e) => setCollection(e.target.value)} aria-label="JASPAR collection" style={{ flex: "none", maxWidth: 200 }}>
            {MOTIF_COLLECTIONS.map((c) => (
              <option key={c.id} value={c.id} title={c.help}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="param" title="The window scanned around each region's centre. Long regions (super-enhancers) are represented by their centre only.">
          <span className="k">Window{half !== 100 && <span className="changed"> · default ±100 bp</span>}</span>
          <select value={half} onChange={(e) => setHalf(Number(e.target.value))}>
            <option value={50}>±50 bp</option>
            <option value={100}>±100 bp</option>
            <option value={250}>±250 bp</option>
            <option value={500}>±500 bp</option>
          </select>
        </label>
        <label className="param" title="A site is a match scoring at or above the threshold for this p-value (per position, exact for each matrix).">
          <span className="k">Site p-value{p !== 1e-4 && <span className="changed"> · default 1e-4</span>}</span>
          <select value={p} onChange={(e) => setP(Number(e.target.value))}>
            <option value={1e-3}>1e-3</option>
            <option value={1e-4}>1e-4</option>
            <option value={1e-5}>1e-5</option>
          </select>
        </label>
      </SettingsShell>

      <div className="hint" style={{ margin: "0 0 10px" }}>
        Which JASPAR 2026 vertebrate motifs ({collection.label}) are more common at the centre of each selected subset's or set's regions than in the other regions of this analysis, compared within like GC and CpG content. Scanned in the page.{nUniverse > MAX_POOL ? ` More than ${MAX_POOL.toLocaleString("en-US")} regions: a fixed random sample is the background.` : ""}
      </div>
      {error && <div className="hint error">{error}</div>}
      {stale && !busy && (
        <div className="setinfo" style={{ marginBottom: 8 }}>
          Settings, genome or selection changed since this result. Press Run again to update it.
        </div>
      )}

      {result && (
        <div className={stale ? "stale" : undefined}>
          <MotifHeatmap result={result} perFamily={perFamily} top={top} groupOf={groupOf} svgRef={svgRef} />
          <div className="plotactions">
            <TopRowsInput value={top} max={result.motifs.length} noun="motifs" onChange={setTop} />
            <label
              className="checkrow"
              style={{ marginRight: "auto", marginLeft: 12 }}
              title="Show only the best motif of each TF family (JASPAR's families) in the heatmap; the table and download keep them all."
            >
              <input type="checkbox" checked={perFamily} onChange={(e) => setPerFamily(e.target.checked)} />
              <span className="k">One motif per family</span>
            </label>
            <button
              className="iconbtn"
              title="Download all results as TSV"
              aria-label="Download motif enrichment results as TSV"
              onClick={() => save(tsvText(result), "achi-motif-enrichment.tsv")}
            >
              <Icon name="download" />
            </button>
            <button className="iconbtn" title="Export SVG" onClick={() => svgRef.current && downloadSvg(svgRef.current, "achi-motif-enrichment.svg")}>
              SVG
            </button>
            <button className="iconbtn" title="Export PNG" onClick={() => svgRef.current && void downloadPng(svgRef.current, "achi-motif-enrichment.png")}>
              PNG
            </button>
          </div>
          <MotifTable result={result} groupOf={groupOf} />
          <div className="setinfo" style={{ marginTop: 6 }}>
            {`${result.release} vertebrates, ${result.collection.label}, ${result.motifs.length.toLocaleString("en-US")} matrices · ±${result.half} bp around each centre · sites at p < ${result.p.toExponential(0)} · ${result.nScanned.toLocaleString("en-US")} of ${result.nUniverse.toLocaleString("en-US")} regions scanned · sequence: ${result.source}`}
            {result.nNoSequence > 0 && ` · ${result.nNoSequence.toLocaleString("en-US")} regions without sequence (other chromosomes, or all N) left out`}. JASPAR is CC BY 4.0.
          </div>
        </div>
      )}
    </div>
  );
}

/** Rows: the `top` motifs with the smallest q among cells with odds ratio > 1 (best per family when asked); `nSignificant` counts those with q < 0.05. */
function heatmapRows(r: RunResult, perFamily: boolean, top: number): { motifs: number[]; nSignificant: number } {
  let ranked = rankRows(r.cells, (c) => c.motif, (c) => c.oddsRatio > 1);
  if (perFamily) {
    const seen = new Set<string>();
    ranked = ranked.filter(({ row }) => {
      const f = familyOf(r.motifs[row]);
      if (seen.has(f)) return false;
      seen.add(f);
      return true;
    });
  }
  return { motifs: ranked.slice(0, top).map((x) => x.row), nSignificant: ranked.filter((x) => x.q < 0.05).length };
}

function MotifHeatmap({
  result,
  perFamily,
  top,
  groupOf,
  svgRef,
}: {
  result: RunResult;
  perFamily: boolean;
  top: number;
  groupOf: (k: number) => { label: string } | undefined;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const { motifs: rows, nSignificant } = heatmapRows(result, perFamily, top);
  const cols = result.keys;
  const cell = new Map(result.cells.map((c) => [`${c.key}:${c.motif}`, c]));
  const LOGO_W = 70;
  const labelW = Math.min(150, Math.max(60, ...rows.map((m) => estimateTextWidth(`${result.motifs[m].name} ${result.motifs[m].id}`, 11))));
  const colLabels = cols.map((k) => truncateToWidth(groupOf(k)?.label ?? String(k), 150, 11.5));
  const colLabelH = Math.min(150, Math.max(...colLabels.map((l) => estimateTextWidth(l, 11.5)))) * Math.SQRT1_2 + 14;
  const gridX = PAD + labelW + 8 + LOGO_W + 8;
  const gridY = PAD + colLabelH;
  const legendY = gridY + rows.length * CELL_H + 22;
  const legendNote = "* q < 0.05 · ** q < 0.01 · *** q < 0.001 · vs the other regions, CMH over GC × CpG strata";
  const width = Math.max(gridX + cols.length * CELL_W + colLabelH * 0.7, gridX + 190, PAD + estimateTextWidth(legendNote, 10) + 10) + PAD;
  const height = legendY + 56;
  return (
    <div className="heatwrap">
      <div className="setinfo">
        {nSignificant === 0
          ? `No motif reaches q < 0.05 in any group; the ${rows.length} with the smallest q ${rows.length === 1 ? "is" : "are"} shown.`
          : `${nSignificant.toLocaleString("en-US")} ${perFamily ? "famil" + (nSignificant === 1 ? "y" : "ies") : "motif" + (nSignificant === 1 ? "" : "s")} enriched at q < 0.05 in at least one group; showing the top ${rows.length}, most significant first.`}
      </div>
      <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Motif enrichment heatmap">
        <defs>
          <linearGradient id="motif-grad" x1="0" x2="1" y1="0" y2="0">
            {[-3, -2, -1, 0, 1, 2, 3].map((v) => (
              <stop key={v} offset={`${((v + 3) / 6) * 100}%`} stopColor={cellColor(2 ** v)} />
            ))}
          </linearGradient>
        </defs>
        <rect width={width} height={height} fill={PAPER} />
        {cols.map((k, j) => {
          const x = gridX + j * CELL_W + CELL_W / 2;
          return (
            <text key={k} x={x} y={gridY - 6} fontSize={11.5} fill={INK} transform={`rotate(-45 ${x} ${gridY - 6})`}>
              <title>{groupOf(k)?.label}</title>
              {colLabels[j]}
            </text>
          );
        })}
        {rows.map((m, i) => {
          const mo = result.motifs[m];
          const y = gridY + i * CELL_H;
          return (
            <g key={m}>
              <text x={PAD + labelW} y={y + CELL_H / 2 + 4} textAnchor="end" fontSize={11} fill={INK}>
                <title>{`${mo.name} (${mo.id}) · ${mo.class.join("; ")} · ${mo.family.join("; ")}`}</title>
                {truncateToWidth(mo.name, labelW - 6, 11)}
              </text>
              <MotifLogo pfm={mo.pfm} x={PAD + labelW + 8} y={y + 3} w={Math.min(LOGO_W, mo.pfm.length * 6)} h={CELL_H - 6} />
              {cols.map((k, j) => {
                const c = cell.get(`${k}:${m}`);
                if (!c) return null;
                const fill = cellColor(c.oddsRatio);
                const t = c.table;
                return (
                  <g key={k}>
                    <title>{`${groupOf(k)?.label} × ${mo.name} (${mo.id})\nodds ratio ${fmtOr(c.oddsRatio)} · p ${fmtP(c.p)} · q ${fmtP(c.q)}\nsite in ${pct(t[0], t[0] + t[1])} of the group's regions (${t[0].toLocaleString()} of ${(t[0] + t[1]).toLocaleString()}) vs ${pct(t[2], t[2] + t[3])} of the others`}</title>
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
        {rows.length > 0 && <rect x={gridX} y={gridY} width={cols.length * CELL_W} height={rows.length * CELL_H} fill="none" stroke={AXIS} shapeRendering="crispEdges" />}
        <text x={gridX} y={legendY - 6} fontSize={10} fill={INK_3}>
          Odds ratio (colour: log₂, clipped at ±3)
        </text>
        <rect x={gridX} y={legendY} width={180} height={10} fill="url(#motif-grad)" stroke={AXIS} shapeRendering="crispEdges" />
        {[0.125, 0.5, 1, 2, 8].map((v) => (
          <text key={v} x={gridX + ((Math.log2(v) + 3) / 6) * 180} y={legendY + 24} textAnchor="middle" fontSize={9.5} fontFamily="monospace" fill={INK_3}>
            {v < 1 ? `1/${1 / v}` : v}
          </text>
        ))}
        <text x={PAD} y={legendY + 42} fontSize={10} fill={INK_3}>
          {legendNote}
        </text>
      </svg>
    </div>
  );
}

function MotifTable({ result, groupOf }: { result: RunResult; groupOf: (k: number) => { label: string } | undefined }) {
  const rows = [...result.cells]
    .filter((c) => c.oddsRatio > 1)
    .sort((a, b) => a.q - b.q || a.p - b.p)
    .slice(0, 100);
  return (
    <div className="regions-scroll" style={{ maxHeight: 300, marginTop: 10 }}>
      <table className="subtable" aria-label="Enriched motifs, most significant first">
        <thead>
          <tr>
            <th>Motif</th>
            <th aria-label="Logo" />
            <th>Family</th>
            <th>Group</th>
            <th title="Share of the group's regions with at least one site">With site</th>
            <th title="Share of the other regions of the analysis with at least one site">Others with site</th>
            <th>Odds ratio</th>
            <th>q</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const m = result.motifs[c.motif];
            const t = c.table;
            const w = Math.min(84, m.pfm.length * 6);
            return (
              <tr key={`${c.key}:${c.motif}`}>
                <td>
                  {m.name}{" "}
                  <a
                    className="mono"
                    style={{ fontSize: 11 }}
                    href={`https://jaspar.elixir.no/matrix/${m.id}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`${m.id} on JASPAR (opens a new tab)`}
                  >
                    {m.id}
                  </a>
                </td>
                <td>
                  <svg width={w} height={22} viewBox={`0 0 ${w} 22`} role="img" aria-label={`${m.name} logo`}>
                    <MotifLogo pfm={m.pfm} x={0} y={1} w={w} h={20} />
                  </svg>
                </td>
                <td style={{ fontSize: 12 }}>{m.family.join("; ") || "–"}</td>
                <td>{groupOf(c.key)?.label ?? c.key}</td>
                <td className="mono">{pct(t[0], t[0] + t[1])}</td>
                <td className="mono">{pct(t[2], t[2] + t[3])}</td>
                <td className="mono">{fmtOr(c.oddsRatio)}</td>
                <td className="mono">{fmtP(c.q)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
