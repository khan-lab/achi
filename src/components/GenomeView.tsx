import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EmbedResult, IntervalSelectionApi } from "@genome-spy/core/minimal";
import { useChosenGroups, useStore } from "../state/store";
import { formatLocus, referenceOptions, type Locus } from "../lib/browserTracks";
import { normalizeRegionText } from "@achi/core/inputValidation";
import { parseBed, sortIntervals } from "@achi/core/intervals";
import type { Interval } from "../types";
import {
  brushLoci,
  contigsFromSizes,
  countInLocus,
  densityRows,
  genomeExportName,
  genomeSpec,
  genomeTracks,
  regionRows,
  type Contig,
} from "../lib/genomeView";

/**
 * Genome-wide overview (GenomeSpy, MIT), shown above igv in the Browser tab:
 * every input set (optional), selected subset and ticked reference set as a
 * row along the whole genome. It is the overview for the genome browser
 * below it: clicking a region or a density bin, or Shift + dragging within
 * one chromosome, moves igv there; igv's current locus is marked in the
 * chromosome strip. Shift + drag also counts the regions of each row in
 * the interval. All data is passed from memory: lib/genomeView.ts.
 */

const BASE = `${window.location.origin}${import.meta.env.BASE_URL}`;

let gsModule: Promise<typeof import("@genome-spy/core/minimal")> | null = null;
function loadGenomeSpy() {
  // Minimal entry: renderers only (WebGL2, Canvas2D fallback for machines without WebGL, SVG for export); no file loaders.
  return (gsModule ??= Promise.all([
    import("@genome-spy/core/minimal"),
    import("@genome-spy/core/rendering/webgl.js"),
    import("@genome-spy/core/rendering/canvas.js"),
    import("@genome-spy/core/rendering/svg.js"),
  ]).then(([m]) => m));
}

type Domain = [{ chrom: string; pos: number }, { chrom: string; pos: number }];
/** Kept while the view is hidden and shown again (page session only): where the view was, per assembly. */
const savedDomain: Record<string, Domain | undefined> = {};

/** Bundled reference sets, fetched from the app's own refdata/ when first ticked, parsed once. */
const refCache = new Map<string, Promise<Interval[]>>();
function loadReference(path: string): Promise<Interval[]> {
  let p = refCache.get(path);
  if (!p) {
    p = fetch(`${BASE}${path}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => sortIntervals(parseBed(normalizeRegionText(text).bedText)));
    p.catch(() => refCache.delete(path));
    refCache.set(path, p);
  }
  return p;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export interface GenomeViewProps {
  /** Show the input sets as context rows. */
  showSets: boolean;
  /** Bundled reference sets (ids from referenceOptions) to show as context rows. */
  refIds: ReadonlySet<string>;
  /** Local interval files added in the genome browser (lib/localTracks.ts), as context rows. */
  locals?: { key: string; name: string; regions: Interval[] }[];
  /** The genome browser's current locus, marked in the chromosome strip. */
  locus: Locus | null;
  /** Move the genome browser (pad: add context around a single region). */
  onNavigate: (l: Locus, pad: boolean) => void;
}

const NO_LOCALS: NonNullable<GenomeViewProps["locals"]> = [];

export function GenomeView({ showSets, refIds, locals = NO_LOCALS, locus, onNavigate }: GenomeViewProps) {
  const sets = useStore((s) => s.sets);
  const chosen = useChosenGroups();
  const assembly = useStore((s) => s.assembly);
  const sizes = useStore((s) => s.chromSizes[s.assembly]);

  const host = useRef<HTMLDivElement>(null);
  const apiRef = useRef<EmbedResult | null>(null);
  // GenomeSpy's handlers are attached once per embed; they call the latest callback.
  const navigate = useRef(onNavigate);
  useEffect(() => {
    navigate.current = onNavigate;
  }, [onNavigate]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brush, setBrush] = useState<Locus[] | null>(null);
  const [refData, setRefData] = useState<Record<string, Interval[]>>({});
  const [refLoading, setRefLoading] = useState(false);
  const refOptions = useMemo(() => referenceOptions(assembly), [assembly]);

  // Load the ticked reference sets (own origin only); tracks wait until all are in.
  useEffect(() => {
    const want = refOptions.filter((r) => refIds.has(r.id) && !refData[r.path]);
    if (!want.length) return;
    let cancelled = false;
    setRefLoading(true);
    void Promise.all(want.map((r) => loadReference(r.path).then((regions) => [r.path, regions] as const)))
      // The flag is cleared together with the data: setting the data re-runs this effect, which
      // would cancel a later step before it ran.
      .then((loaded) => {
        if (cancelled) return;
        setRefData((d) => ({ ...d, ...Object.fromEntries(loaded) }));
        setRefLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(`A reference set could not be loaded: ${(e as Error).message}`);
        setRefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refIds, refOptions, refData]);

  const refs = useMemo(
    () => refOptions.filter((r) => refIds.has(r.id) && refData[r.path]).map((r) => ({ key: r.id, name: r.name, regions: refData[r.path] })),
    [refOptions, refIds, refData],
  );
  const tracks = useMemo(() => genomeTracks(sets, chosen, new Set(chosen.map((c) => c.mask)), { includeSets: showSets, refs, locals }), [sets, chosen, showSets, refs, locals]);

  const contigs = useMemo<Contig[]>(() => (sizes ? contigsFromSizes(sizes) : []), [sizes]);
  const data = useMemo(() => {
    if (!sizes) return null;
    const { rows, densityOnly } = regionRows(tracks);
    return { density: densityRows(tracks, sizes), regions: rows, densityOnly };
  }, [tracks, sizes]);

  /** Finalize the current GenomeSpy instance, remembering where it was. */
  function release() {
    const api = apiRef.current;
    if (!api) return;
    try {
      const d = api.getScaleResolutionByName("genome")?.getComplexDomain();
      if (d && d.length === 2 && typeof d[0] === "object") savedDomain[assembly] = d as Domain;
    } catch {
      /* keep the last saved domain */
    }
    api.finalize();
    apiRef.current = null;
  }

  // Embeds run one after another: a new one starts only once the previous one
  // has finished (and been finalized), never two into the same element.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const brushSel = useRef<IntervalSelectionApi | null>(null);
  /** Set while the app clears the brush itself, so its counts stay listed. */
  const keepCounts = useRef(false);

  // (Re)build the view when the tracks change, keeping the zoomed region.
  useEffect(() => {
    if (!host.current || !data || !contigs.length || !tracks.length) return;
    let cancelled = false;
    const div = host.current;
    setReady(false);
    setError(null);
    setBrush(null);
    const run = queue.current.then(async () => {
      if (cancelled) return;
      release();
      const gs = await loadGenomeSpy();
      if (cancelled) return;
      const api = await gs.embed(div, genomeSpec({ contigs, tracks, rowHeight: 14 }), { renderer: "auto", wheelBehavior: "cooperative" });
      if (cancelled) {
        api.finalize();
        return;
      }
      api.datasets.set("density", data.density);
      api.datasets.set("regions", data.regions);
      apiRef.current = api;
      const d = savedDomain[assembly];
      if (d) await api.getScaleResolutionByName("genome")?.zoomTo(d, false);
      const sel = api.views.get({ scope: [], view: "regions" }).params.getSelection("brush");
      brushSel.current = sel.type === "interval" ? sel : null;
      if (sel.type === "interval")
        sel.subscribe(
          (v) => {
            if (!v.active && keepCounts.current) {
              keepCounts.current = false;
              return;
            }
            const x = v.complexIntervals.x as Domain | null | undefined;
            const loci = v.active && x ? brushLoci(x, contigs) : null;
            setBrush(loci);
            // Within one chromosome the genome browser follows; across several, only the counts are shown.
            if (loci?.length === 1) navigate.current(loci[0], false);
          },
          { delivery: "commit" },
        );
      api.addEventListener("click", (e) => {
        const r = e.datum as { chrom?: string; start?: number; end?: number; count?: number } | undefined;
        if (!r?.chrom || r.start === undefined || r.end === undefined) return;
        const l = { chrom: r.chrom, start: r.start, end: r.end };
        // A density bin (1 Mb): zoom the overview to it as well. A region: show it with some context.
        if (r.count !== undefined) void zoomTo(l);
        // Let GenomeSpy finish handling the click (its tooltip) first.
        window.setTimeout(() => navigate.current(l, r.count === undefined), 0);
      });
      setReady(true);
    });
    queue.current = run.catch((e: unknown) => {
      if (!cancelled) setError(`The genome view could not start: ${(e as Error).message}`);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, contigs, tracks, assembly]);

  // Mark where the genome browser is.
  useEffect(() => {
    if (ready) apiRef.current?.datasets.set("viewport", locus ? [locus] : []);
  }, [ready, locus]);

  // Release GenomeSpy when the view closes. A layout effect: its cleanup runs
  // before React removes the host element, so GenomeSpy's own resize and
  // theme observers never fire on a detached element.
  // (On an assembly change it runs with the old assembly, saving the domain under it.)
  useLayoutEffect(
    () => () => release(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assembly],
  );

  async function zoomTo(l: Locus) {
    const scale = apiRef.current?.getScaleResolutionByName("genome");
    // GenomeSpy's locus zoomTo takes a zero-based inclusive upper endpoint.
    if (scale) await scale.zoomTo([{ chrom: l.chrom, pos: l.start }, { chrom: l.chrom, pos: Math.max(l.start, l.end - 1) }], 500);
  }

  /** Zoom to the span of one or more consecutive loci (a brush can cross chromosomes). */
  async function zoomToSpan(loci: Locus[]) {
    const scale = apiRef.current?.getScaleResolutionByName("genome");
    const a = loci[0];
    const b = loci[loci.length - 1];
    if (scale && a && b) await scale.zoomTo([{ chrom: a.chrom, pos: a.start }, { chrom: b.chrom, pos: Math.max(0, b.end - 1) }], 500);
    // The brush would now cover the whole view and catch every click; clear it, keeping the counts listed.
    if (brushSel.current?.getValue().active) {
      keepCounts.current = true;
      brushSel.current.clear();
    }
  }

  async function wholeGenome() {
    const scale = apiRef.current?.getScaleResolutionByName("genome");
    if (scale && contigs.length) {
      const last = contigs[contigs.length - 1];
      await scale.zoomTo([{ chrom: contigs[0].name, pos: 0 }, { chrom: last.name, pos: last.size - 1 }], 500);
    }
  }

  async function exportView(ext: "svg" | "png") {
    const api = apiRef.current;
    if (!api) return;
    try {
      const scale = api.getScaleResolutionByName("genome");
      const d = scale?.getComplexDomain() as Domain | undefined;
      // GenomeSpy's locus domain has an inclusive upper end; brushLoci takes half-open.
      const loci = d && typeof d[0] === "object" ? brushLoci([d[0], { chrom: d[1].chrom, pos: d[1].pos + 1 }], contigs) : [];
      const { blob } = ext === "svg" ? await api.imageExport.svg() : await api.imageExport.raster({ pixelRatio: 2 });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = genomeExportName(loci, contigs, ext);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    }
  }

  const brushCounts = brush?.length ? tracks.map((t) => ({ name: t.name, color: t.color, n: brush.reduce((s, l) => s + countInLocus(t.regions, l), 0) })) : null;

  return (
    <div className="genomeview">
      <div className="gb-toolbar">
        <span className="hint gv-lead">
          {refLoading ? "Loading reference sets…" : "Click a region or Shift + drag within a chromosome to show it in the genome browser below."}
        </span>
        <button className="ghost" type="button" disabled={!ready} onClick={() => void wholeGenome()}>
          Whole genome
        </button>
      </div>

      {error && <div className="hint error">{error}</div>}
      {!tracks.length && <div className="hint">Nothing to show: load files, tick "Show the input sets", or select subsets in the UpSet plot, Venn diagram or Table.</div>}
      {tracks.length > 0 && !ready && !error && <div className="hint">Drawing the genome-wide view…</div>}
      {data && data.densityOnly.length > 0 && (
        <div className="hint">
          Shown by density only (more than 500,000 regions): {data.densityOnly.join(", ")}.
        </div>
      )}

      <div ref={host} className="gv-host" />

      {brushCounts && brush && (
        <div className="gv-brush">
          <div className="gv-brush-hd">
            <span className="mono">
              {brush.length === 1 ? formatLocus(brush[0]) : `${formatLocus(brush[0])} … ${formatLocus(brush[brush.length - 1])} (${brush.length} chromosomes)`}
            </span>
            <button className="linkbtn" onClick={() => void zoomToSpan(brush)}>
              zoom here
            </button>
          </div>
          <table className="gb-matrix">
            <tbody>
              {brushCounts.map((c) => (
                <tr key={c.name}>
                  <th scope="row">
                    <span className="swatch" style={{ background: c.color }} /> {c.name}
                  </th>
                  <td className="mono">{fmt(c.n)} regions</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="plotactions">
        <button className="iconbtn" title="Export the current view as SVG" disabled={!ready} onClick={() => void exportView("svg")}>
          SVG
        </button>
        <button className="iconbtn" title="Export the current view as PNG" disabled={!ready} onClick={() => void exportView("png")}>
          PNG
        </button>
      </div>
      <div className="hint">
        Density strip: regions per Mb, opacity relative to each row's densest Mb. The red box in the chromosome strip is where
        the genome browser is. Ctrl (or ⌘) + scroll to zoom, drag to pan, Shift + drag to count regions in an interval; click a
        density bin to zoom to it. Public tracks appear in the genome browser only.
      </div>
    </div>
  );
}
