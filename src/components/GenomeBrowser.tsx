import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Browser } from "igv";
import { useStore } from "../state/store";
import {
  browserConfig,
  exportFileName,
  formatLocus,
  fromIgvLocus,
  geneTrack,
  padLocus,
  parseLocus,
  referenceOptions,
  referenceTrack,
  regionTrack,
  subsetTrackColor,
  type IgvTrack,
  type Locus,
} from "../lib/browserTracks";
import { remoteTrackConfig, type RemoteTrack } from "../lib/remoteTracks";
import { loadGeneModels as loadGeneModelsFor, type GeneModels } from "../lib/geneModelsLoader";
import { downloadPngFromSvgText, downloadSvgText, svgDimensions } from "../lib/exportImage";
import { PublicTracksPanel } from "./PublicTracksPanel";
import { GenomeView } from "./GenomeView";

/**
 * The Browser tab: a genome-wide overview (GenomeView, GenomeSpy) above a
 * genome browser (igv.js, MIT; loaded only when this tab is first opened).
 * Both show the user's sets (optional), the selected subsets and the ticked
 * bundled reference sets, from one set of controls; igv adds GENCODE gene
 * models and, after consent, public tracks. Clicking or brushing in the
 * overview moves igv; igv's locus is marked in the overview. Nothing leaves
 * the page without consent: see lib/browserTracks.ts for how the igv
 * configuration is kept to the app's own data, and the tests that enforce it.
 */

const BASE = `${window.location.origin}${import.meta.env.BASE_URL}`;

const loadGeneModels = (assembly: string) => loadGeneModelsFor(assembly, BASE);

let igvModule: Promise<typeof import("igv")> | null = null;
const loadIgv = () => (igvModule ??= import("igv"));

/** Kept across tab switches (page session only): what is shown, where the browser was, and whether the overview is open. */
const saved: { refs: Set<string>; locus: Record<string, string>; remote: Record<string, RemoteTrack[]>; showSets: boolean; overview: boolean } = {
  refs: new Set(),
  locus: {},
  remote: {},
  showSets: true,
  overview: true,
};

interface TrackSpec {
  key: string;
  sig: string;
  config: () => IgvTrack;
}

export function GenomeBrowser() {
  const sets = useStore((s) => s.sets);
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const assembly = useStore((s) => s.assembly);
  const sizes = useStore((s) => s.chromSizes[s.assembly]);
  const target = useStore((s) => s.browserTarget);
  const loadChromSizes = useStore((s) => s.loadChromSizes);
  // Chromosome sizes are otherwise fetched when files load; the browser also works with none loaded.
  useEffect(() => {
    if (!sizes) void loadChromSizes();
  }, [sizes, loadChromSizes]);

  const host = useRef<HTMLDivElement>(null);
  const browserRef = useRef<Browser | null>(null);
  const loaded = useRef(new Map<string, { sig: string; name: string }>());
  const [genes, setGenes] = useState<GeneModels | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refs, setRefs] = useState<Set<string>>(() => new Set(saved.refs));
  const [showSets, setShowSets] = useState(saved.showSets);
  const [overview, setOverview] = useState(saved.overview);
  const [locus, setLocus] = useState<Locus | null>(null);
  const [remote, setRemote] = useState<RemoteTrack[]>(() => saved.remote[assembly] ?? []);
  useEffect(() => setRemote(saved.remote[assembly] ?? []), [assembly]);
  const changeRemote = (tracks: RemoteTrack[]) => {
    saved.remote[assembly] = tracks;
    setRemote(tracks);
  };
  const lastTarget = useRef(0);

  const included = useMemo(() => sets.filter((s) => s.included), [sets]);
  const chosen = useMemo(() => subsets.filter((s) => selected.has(s.mask)), [subsets, selected]);
  const refOptions = useMemo(() => referenceOptions(assembly), [assembly]);

  // The tracks the browser should show now, keyed so only changes are reloaded.
  const specs = useMemo<TrackSpec[]>(() => {
    const out: TrackSpec[] = [];
    if (genes) out.push({ key: "genes", sig: assembly, config: () => ({ ...geneTrack(genes.features), order: 0 }) });
    if (showSets)
      included.forEach((s, i) =>
        out.push({
          key: `set:${s.id}`,
          sig: `${s.name}|${s.color}|${s.nRegions}|${s.regions.length}`,
          config: () => ({ ...regionTrack(s.name, s.color, s.regions), order: 10 + i }),
        }),
      );
    chosen.forEach((s, i) => {
      const color = subsetTrackColor(s, sets);
      out.push({
        key: `subset:${s.mask}`,
        sig: `${s.label}|${color}|${s.nRegions}`,
        config: () => ({ ...regionTrack(`Subset: ${s.label}`, color, s.regions), order: 100 + i }),
      });
    });
    refOptions
      .filter((r) => refs.has(r.id))
      .forEach((r, i) => out.push({ key: `ref:${r.id}`, sig: r.path, config: () => ({ ...referenceTrack(r, BASE), order: 200 + i }) }));
    // Public tracks: only ever present after the user agreed (PublicTracksPanel).
    remote.forEach((t, i) => out.push({ key: `remote:${t.id}`, sig: t.url, config: () => ({ ...remoteTrackConfig(t), order: 300 + i }) }));
    return out;
  }, [genes, assembly, included, chosen, sets, refOptions, refs, remote, showSets]);

  // Create the browser for this assembly (genome = bundled chrom.sizes).
  useEffect(() => {
    if (!sizes || !host.current) return;
    let cancelled = false;
    const div = host.current;
    setReady(false);
    setGenes(null);
    setError(null);
    loaded.current = new Map();
    const start = saved.locus[assembly] ?? firstLocus();
    void Promise.all([loadIgv(), loadGeneModels(assembly).catch((e: unknown) => (setError(`Gene models could not be loaded (${(e as Error).message}); sets are still shown.`), null))])
      .then(async ([mod, models]) => {
        if (cancelled) return;
        const igv = mod.default;
        const locus = parseLocus(start, sizes, models?.index);
        const at: Locus = "error" in locus ? { chrom: Object.keys(sizes)[0], start: 0, end: 1_000_000 } : locus;
        const browser = await igv.createBrowser(div, browserConfig({ assembly, base: BASE, locus: at, tracks: [] }) as never);
        if (cancelled) {
          igv.removeBrowser(browser);
          return;
        }
        browserRef.current = browser;
        browser.on("locuschange", () => {
          const l = currentLocus(browser);
          if (l) {
            saved.locus[assembly] = formatLocus(l);
            setQuery(formatLocus(l));
            setLocus(l);
          }
        });
        setQuery(formatLocus(at));
        setLocus(at);
        setGenes(models);
        setReady(true);
      })
      .catch((e: unknown) => !cancelled && setError(`The genome browser could not start: ${(e as Error).message}`));
    return () => {
      cancelled = true;
      const b = browserRef.current;
      browserRef.current = null;
      if (b) void loadIgv().then((m) => m.default.removeBrowser(b));
    };
    // The first locus is read once per browser; later changes navigate instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly, sizes]);

  // igv only re-lays out on window resize; the middle column also changes
  // width when the "Selected subsets" column is hidden or shown.
  useEffect(() => {
    const div = host.current;
    if (!ready || !div) return;
    let width = div.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (div.clientWidth === width) return;
      width = div.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void browserRef.current?.visibilityChange());
    });
    ro.observe(div);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready]);

  // Keep igv's tracks in step with sets, selection and reference toggles.
  useEffect(() => {
    const browser = browserRef.current;
    if (!ready || !browser) return;
    const want = new Map(specs.map((s) => [s.key, s]));
    for (const [key, have] of loaded.current) {
      const w = want.get(key);
      if (!w || w.sig !== have.sig) {
        browser.removeTrackByName(have.name);
        loaded.current.delete(key);
      }
    }
    for (const spec of specs) {
      if (loaded.current.has(spec.key)) continue;
      const config = spec.config();
      loaded.current.set(spec.key, { sig: spec.sig, name: config.name });
      void browser.loadTrack(config as never).catch((e: unknown) => setError(`${config.name}: ${(e as Error).message}`));
    }
  }, [ready, specs]);

  // Jumps from "view" links (region rows, gene list).
  useEffect(() => {
    if (!ready || !target || target.n === lastTarget.current || !sizes) return;
    lastTarget.current = target.n;
    go(target.query, target.pad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, target, genes]);

  function firstLocus(): string {
    const r = chosen[0]?.regions[0] ?? included[0]?.regions[0];
    if (r && sizes) return formatLocus(padLocus(r, sizes));
    return "GAPDH";
  }

  /** From the overview: move igv to a region (padded for a single region) and bring it into view. */
  const navigate = useCallback(
    (l: Locus, pad: boolean) => {
      const browser = browserRef.current;
      if (!browser || !sizes) return;
      const at = pad ? padLocus(l, sizes) : l;
      setError(null);
      browser.search(`${at.chrom}:${at.start + 1}-${at.end}`);
      host.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [sizes],
  );

  function go(q: string, pad: boolean) {
    const browser = browserRef.current;
    if (!browser || !sizes) return;
    const l = parseLocus(q, sizes, genes?.index);
    if ("error" in l) {
      setError(l.error);
      return;
    }
    setError(null);
    const at = pad ? padLocus(l, sizes) : l;
    // Always coordinates: igv never sees a name it would send to its search service.
    browser.search(`${at.chrom}:${at.start + 1}-${at.end}`);
  }

  /** The view as igv draws it (ideogram, ruler, every track, public ones included) via igv's own toSVG. */
  async function exportView(ext: "svg" | "png") {
    const browser = browserRef.current;
    if (!browser) return;
    try {
      const loci = browser.currentLoci();
      const at = fromIgvLocus(Array.isArray(loci) ? loci[0] : loci) ?? { chrom: "view", start: 0, end: 0 };
      const svg = browser.toSVG();
      const name = exportFileName(at, ext);
      if (ext === "svg") downloadSvgText(svg, name);
      else {
        const size = svgDimensions(svg);
        if (!size) throw new Error("the drawing has no size");
        await downloadPngFromSvgText(svg, size.width, size.height, name);
      }
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    }
  }

  function toggleRef(id: string) {
    const next = new Set(refs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    saved.refs = next;
    setRefs(next);
  }

  return (
    <div className="genomebrowser">
      <div className="gb-shared">
        <label className="gb-ref gv-toggle">
          <input
            type="checkbox"
            checked={showSets}
            onChange={(e) => {
              saved.showSets = e.target.checked;
              setShowSets(e.target.checked);
            }}
          />{" "}
          Show the input sets
        </label>
        {refOptions.length > 0 && (
          <details className="gb-refs">
            <summary>
              Reference sets <span className="railcount">{refs.size ? `${refs.size} shown` : `${refOptions.length} available`}</span>
            </summary>
            <div className="gb-refgrid">
              {refOptions.map((r) => (
                <label key={r.id} className="gb-ref">
                  <input type="checkbox" checked={refs.has(r.id)} onChange={() => toggleRef(r.id)} /> {r.name}
                </label>
              ))}
            </div>
          </details>
        )}
        <PublicTracksPanel assembly={assembly} chosen={remote} onChange={changeRemote} />
      </div>

      {/* A button, not <details>: GenomeSpy watches attribute changes on its ancestors and would
          read styles from the hidden content before React removes it. */}
      <div className="gb-overview">
        <button
          type="button"
          className="gb-overview-hd"
          aria-expanded={overview}
          onClick={() => {
            saved.overview = !overview;
            setOverview(!overview);
          }}
        >
          <span className="caret" aria-hidden="true">
            {overview ? "▾" : "▸"}
          </span>
          <span className="gb-sub">Genome-wide overview</span>
          <span className="hint">GenomeSpy · every row along the whole genome</span>
        </button>
        {overview && <GenomeView showSets={showSets} refIds={refs} locus={locus} onNavigate={navigate} />}
      </div>

      <div className="gb-sub gb-sub-igv">
        Genome browser <span className="hint">igv.js · genes, your rows and public tracks at base-pair resolution</span>
      </div>
      <form
        className="gb-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          go(query, false);
        }}
      >
        <input
          className="gb-locus mono"
          aria-label="Locus or gene"
          placeholder="chr1:1,000,000-1,100,000 or a gene, e.g. GAPDH"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!ready}
        />
        <button className="ghost" type="submit" disabled={!ready}>
          Go
        </button>
        <button className="ghost" type="button" aria-label="Zoom out" title="Zoom out" disabled={!ready} onClick={() => browserRef.current?.zoomOut()}>
          −
        </button>
        <button className="ghost" type="button" aria-label="Zoom in" title="Zoom in" disabled={!ready} onClick={() => browserRef.current?.zoomIn()}>
          +
        </button>
      </form>

      {error && <div className="hint error">{error}</div>}
      {!sets.length && <div className="hint">Load your files or the example data to see them here. Genes are shown already.</div>}
      {!ready && !error && <div className="hint">Starting the genome browser…</div>}

      <div ref={host} className="gb-host" />

      <div className="plotactions">
        <button className="iconbtn" title="Export the current view as SVG" disabled={!ready} onClick={() => void exportView("svg")}>
          SVG
        </button>
        <button className="iconbtn" title="Export the current view as PNG" disabled={!ready} onClick={() => void exportView("png")}>
          PNG
        </button>
      </div>

      <div className="hint">
        {remote.length
          ? `Your files and bundled data stay in this page. Public tracks are read from ${[...new Set(remote.map((t) => new URL(t.url).hostname))].join(", ")}, which see the regions you view.`
          : "Shown from your files and data bundled with Intervene; nothing is sent to other servers."}{" "}
        Sets with more than 50,000 regions are drawn when zoomed in.
      </div>
    </div>
  );
}

function currentLocus(browser: Browser): Locus | null {
  const loci = browser.currentLoci();
  const l = Array.isArray(loci) ? loci[0] : loci;
  return l ? fromIgvLocus(l) : null;
}
