import { useEffect, useMemo, useRef, useState } from "react";
import type { EmbedResult } from "@genome-spy/core/minimal";
import { useStore } from "../state/store";
import { formatLocus, parseLocus, referenceOptions, type Locus } from "../lib/browserTracks";
import { normalizeRegionText } from "../lib/inputValidation";
import { parseBed, sortIntervals } from "../lib/intervals";
import type { Interval } from "../types";
import { loadGeneModels, type GeneModels } from "../lib/geneModelsLoader";
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
 * Genome-wide location of the selected subsets, with the input sets as
 * optional context rows (GenomeSpy, MIT). A card in the selected-subset
 * section: it follows the selection made in UpSet, Venn or Table, and loads
 * GenomeSpy and the gene models only once the card scrolls into view.
 * Shift + drag selects an interval (counts per track, open in the genome
 * browser); clicking a region opens it in the genome browser, clicking a
 * density bin zooms to it. All data is passed from memory: lib/genomeView.ts.
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
/** Kept while the card is hidden and shown again: where the view was (per assembly), and the input-set toggle. */
const savedDomain: Record<string, Domain | undefined> = {};
const saved = { showSets: true, refs: new Set<string>() };

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

export function GenomeView() {
  const sets = useStore((s) => s.sets);
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const assembly = useStore((s) => s.assembly);
  const sizes = useStore((s) => s.chromSizes[s.assembly]);
  const loadChromSizes = useStore((s) => s.loadChromSizes);
  const showInBrowser = useStore((s) => s.showInBrowser);

  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const apiRef = useRef<EmbedResult | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brush, setBrush] = useState<Locus[] | null>(null);
  const [query, setQuery] = useState("");
  const [genes, setGenes] = useState<GeneModels | null>(null);
  const [showSets, setShowSets] = useState(saved.showSets);
  const [refIds, setRefIds] = useState<Set<string>>(() => new Set(saved.refs));
  const [refData, setRefData] = useState<Record<string, Interval[]>>({});
  const [refLoading, setRefLoading] = useState(false);
  const refOptions = useMemo(() => referenceOptions(assembly), [assembly]);
  // Nothing is loaded until the card is on screen (it sits below several other cards).
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setInView(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!sizes) void loadChromSizes();
  }, [sizes, loadChromSizes]);
  useEffect(() => {
    if (!inView) return;
    setGenes(null);
    void loadGeneModels(assembly, BASE).then(setGenes, () => setGenes(null));
  }, [assembly, inView]);

  // Load the ticked reference sets (own origin only); tracks wait until all are in.
  useEffect(() => {
    if (!inView) return;
    const want = refOptions.filter((r) => refIds.has(r.id) && !refData[r.path]);
    if (!want.length) return;
    let cancelled = false;
    setRefLoading(true);
    void Promise.all(want.map((r) => loadReference(r.path).then((regions) => [r.path, regions] as const)))
      .then((loaded) => !cancelled && setRefData((d) => ({ ...d, ...Object.fromEntries(loaded) })))
      .catch((e: unknown) => !cancelled && setError(`A reference set could not be loaded: ${(e as Error).message}`))
      .finally(() => !cancelled && setRefLoading(false));
    return () => {
      cancelled = true;
    };
  }, [inView, refIds, refOptions, refData]);

  const refs = useMemo(
    () => refOptions.filter((r) => refIds.has(r.id) && refData[r.path]).map((r) => ({ key: r.id, name: r.name, regions: refData[r.path] })),
    [refOptions, refIds, refData],
  );
  const tracks = useMemo(() => genomeTracks(sets, subsets, selected, { includeSets: showSets, refs }), [sets, subsets, selected, showSets, refs]);

  function toggleRef(id: string) {
    const next = new Set(refIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saved.refs = next;
    setRefIds(next);
  }
  const contigs = useMemo<Contig[]>(() => (sizes ? contigsFromSizes(sizes) : []), [sizes]);
  const data = useMemo(() => {
    if (!sizes) return null;
    const { rows, densityOnly } = regionRows(tracks);
    return { density: densityRows(tracks, sizes), regions: rows, densityOnly };
  }, [tracks, sizes]);

  // (Re)build the view when the tracks change, keeping the zoomed region.
  useEffect(() => {
    if (!inView || !host.current || !data || !contigs.length || !tracks.length) return;
    let cancelled = false;
    const div = host.current;
    setReady(false);
    setError(null);
    setBrush(null);
    const previous = apiRef.current;
    if (previous) {
      try {
        const d = previous.getScaleResolutionByName("genome")?.getComplexDomain();
        if (d && d.length === 2 && typeof d[0] === "object") savedDomain[assembly] = d as Domain;
      } catch {
        /* keep the last saved domain */
      }
      previous.finalize();
      apiRef.current = null;
    }
    void loadGenomeSpy()
      .then(async (gs) => {
        if (cancelled) return;
        const api = await gs.embed(div, genomeSpec({ contigs, tracks }), { renderer: "auto", wheelBehavior: "cooperative" });
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
        if (sel.type === "interval")
          sel.subscribe(
            (v) => {
              const x = v.complexIntervals.x as Domain | null | undefined;
              setBrush(v.active && x ? brushLoci(x, contigs) : null);
            },
            { delivery: "commit" },
          );
        api.addEventListener("click", (e) => {
          const r = e.datum as { chrom?: string; start?: number; end?: number; count?: number } | undefined;
          if (!r?.chrom || r.start === undefined || r.end === undefined) return;
          if (r.count !== undefined) void zoomTo({ chrom: r.chrom, start: r.start, end: r.end });
          else {
            const locus = formatLocus({ chrom: r.chrom, start: r.start, end: r.end });
            // Let GenomeSpy finish handling the click (its tooltip) before the tab switch removes the view.
            window.setTimeout(() => showInBrowser(locus), 0);
          }
        });
        setReady(true);
      })
      .catch((e: unknown) => !cancelled && setError(`The genome view could not start: ${(e as Error).message}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, contigs, tracks, assembly, inView]);

  // Release GenomeSpy when the tab closes.
  useEffect(
    () => () => {
      const api = apiRef.current;
      if (api) {
        try {
          const d = api.getScaleResolutionByName("genome")?.getComplexDomain();
          if (d && d.length === 2 && typeof d[0] === "object") savedDomain[assembly] = d as Domain;
        } catch {
          /* ignore */
        }
        api.finalize();
        apiRef.current = null;
      }
    },
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
  }

  async function wholeGenome() {
    const scale = apiRef.current?.getScaleResolutionByName("genome");
    if (scale && contigs.length) {
      const last = contigs[contigs.length - 1];
      await scale.zoomTo([{ chrom: contigs[0].name, pos: 0 }, { chrom: last.name, pos: last.size - 1 }], 500);
    }
  }

  function go() {
    if (!sizes) return;
    const l = parseLocus(query, sizes, genes?.index);
    if ("error" in l) setError(l.error);
    else {
      setError(null);
      void zoomTo(l);
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
    <div className="genomeview" ref={root}>
      <label className="gb-ref gv-toggle">
        <input
          type="checkbox"
          checked={showSets}
          onChange={(e) => {
            saved.showSets = e.target.checked;
            setShowSets(e.target.checked);
          }}
        />{" "}
        Show the input sets for context
      </label>

      {refOptions.length > 0 && (
        <details className="gb-refs">
          <summary>
            Reference sets as context rows{" "}
            <span className="railcount">{refIds.size ? `${refIds.size} shown` : `${refOptions.length} available`}</span>
            {refLoading && <span className="hint"> loading…</span>}
          </summary>
          <div className="gb-refgrid">
            {refOptions.map((r) => (
              <label key={r.id} className="gb-ref">
                <input type="checkbox" checked={refIds.has(r.id)} onChange={() => toggleRef(r.id)} /> {r.name}
              </label>
            ))}
          </div>
        </details>
      )}

      <form
        className="gb-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <input
          className="gb-locus mono"
          aria-label="Locus, chromosome or gene"
          placeholder="chr7, chr1:1-50,000,000 or a gene, e.g. GAPDH"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!ready}
        />
        <button className="ghost" type="submit" disabled={!ready}>
          Go
        </button>
        <button className="ghost" type="button" disabled={!ready} onClick={() => void wholeGenome()}>
          Whole genome
        </button>
      </form>

      {error && <div className="hint error">{error}</div>}
      {!tracks.length && <div className="hint">Select subsets in the UpSet plot, Venn diagram or Table to see where they lie.</div>}
      {tracks.length > 0 && !ready && !error && <div className="hint">{inView ? "Drawing the genome view…" : "The genome view is drawn when this card is on screen."}</div>}
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
            {brush.length === 1 && (
              <button className="linkbtn" onClick={() => showInBrowser(formatLocus(brush[0]), false)}>
                open in genome browser
              </button>
            )}
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
        Density strip: regions per Mb, opacity relative to each track's densest Mb. Ctrl (or ⌘) + scroll to zoom, drag to pan,
        Shift + drag to select an interval; click a region to open it in the genome browser, a density bin to zoom to it. Drawn
        in this page from your files; nothing is sent.
      </div>
    </div>
  );
}
