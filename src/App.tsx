import { useCallback, useEffect, useRef, useState } from "react";
import { SetRail } from "./components/SetRail";
import { UpSetPlot } from "./components/UpSetPlot";
import { VennPlot } from "./components/VennPlot";
import { PairwiseHeatmap } from "./components/PairwiseHeatmap";
import { SubsetTable } from "./components/SubsetTable";
import { SummaryPlot, type SummaryItem } from "./components/SummaryPlot";
import { RegionAnnotationPlot } from "./components/RegionAnnotationPlot";
import { useNearestGenes } from "./components/nearestGenes";
import { SelectedGroupCard } from "./components/SelectedGroupCard";
import { MotifEnrichmentPanel } from "./components/MotifEnrichmentPanel";
import { SubsetEnrichmentPanel } from "./components/SubsetEnrichmentPanel";
import { GoEnrichmentPanel } from "./components/GoEnrichmentPanel";
import { SignalProfilePanel } from "./components/SignalProfilePanel";
import { OfflineBadge } from "./components/OfflineStatus";
import { SubsetChips } from "./components/SubsetChips";
import { HelpPage } from "./components/HelpPage";
import { GenomeBrowser } from "./components/GenomeBrowser";
import { ComputeStatus } from "./components/ComputeStatus";
import { LinkDialog } from "./components/LinkDialog";
import { buildLink, parseLink } from "./lib/shareLink";
import { COPYRIGHT_YEAR, LAB_NAME, LAB_URL, LICENSE_URL, SOURCE_CODE_URL } from "./siteLinks";
import { useChosenGroups, useStore, type View } from "./state/store";
import { validSelection } from "@achi/core/selection";
import { subsetToBedText } from "@achi/core/pipeline";
import { PALETTE } from "./types";
import "./styles/tokens.css";
import "./App.css";
import { Icon } from "./components/Icon";
import { CollapseAllButton, CollapsiblePanel } from "./components/CollapsiblePanel";
import { ExpressionPanel } from "./components/ExpressionPanel";

/** Views that work on lists of names (list mode): the rest need genomic regions. */
const LIST_VIEWS: View[] = ["upset", "venn", "table"];
const VIEWS: { id: View; label: string }[] = [
  { id: "upset", label: "UpSet" },
  { id: "venn", label: "Venn" },
  { id: "pairwise", label: "Pairwise" },
  { id: "table", label: "Table" },
   { id: "browser", label: "Genome Browser" },
  { id: "summary", label: "Set Summary" },
];


const isView = (v: string | undefined): v is View => v === "help" || VIEWS.some((x) => x.id === v);

/** The collapsible analysis panels below the selection (components/CollapsiblePanel.tsx). */
const ANALYSIS_PANELS = ["summary", "annotation", "signal", "enrichment", "motifs", "go", "expression"];

function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const sets = useStore((s) => s.sets);
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const toggleSelected = useStore((s) => s.toggleSelected);
  const exportSelectedBedZip = useStore((s) => s.exportSelectedBedZip);
  const exportAnalysis = useStore((s) => s.exportAnalysis);
  const listMode = useStore((s) => s.inputMode === "lists");
  const applyPendingSelection = useStore((s) => s.applyPendingSelection);
  // A restored settings file's selection is applied once its sets are loaded.
  useEffect(() => applyPendingSelection(), [subsets, applyPendingSelection]);
  const status = useStore((s) => s.status);
  const busy = status === "loading-worker" || status === "running";

  const appliedInitialSelection = useRef(false);
  // Where "Back to workspace" returns to from the help page.
  const lastWorkspaceView = useRef<View>("upset");
  if (view !== "help") lastWorkspaceView.current = view;
  // The "Selected subsets" column can be folded to a thin strip to give the
  // middle column its width. Kept for the page session (in memory only).
  const [asideOpen, setAsideOpen] = useState(true);
  const [railOpen, setRailOpen] = useState(true);

  // Restore view, settings and selection from the address (lib/shareLink.ts).
  // Sets are never uploaded or persisted: a link can name public files, which
  // are downloaded only after the user agrees (LinkDialog); otherwise reload
  // the same files (or "Load example") to see the analysis populated again.
  useEffect(() => {
    const open = (onLoad: boolean) => {
      const link = parseLink(window.location.hash, { ownOrigin: window.location.origin });
      // Later address changes (a link clicked or pasted in this tab) matter only when they name files.
      if (!onLoad && !link.files.length) return;
      const st = useStore.getState();
      st.applyLinkSettings(link.settings);
      if (isView(link.view)) setView(link.view);
      if (link.sel.length) {
        // Applied once subsets exist — see the effect below.
        (window as unknown as { __pendingSel?: number[] }).__pendingSel = link.sel;
        appliedInitialSelection.current = false;
      }
      if (link.files.length) st.requestLink(link);
      else if (link.problems.length) useStore.setState({ notices: link.problems });
    };
    open(true);
    const onHash = () => open(false);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (appliedInitialSelection.current || !subsets.length) return;
    const pending = (window as unknown as { __pendingSel?: number[] }).__pendingSel;
    if (pending?.length) {
      // Subset masks, and whole sets by their negative key (lib/selection.ts).
      for (const mask of validSelection(pending, subsets, useStore.getState().sets.filter((s) => s.included))) toggleSelected(mask);
    }
    appliedInitialSelection.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsets]);

  // Keep the address in step with the analysis. Files go into it only when
  // every included set came from a public link: a file from the user's
  // computer never does. Left alone while a link waits for the user's answer.
  const inputMode = useStore((s) => s.inputMode);
  const linkRequest = useStore((s) => s.linkRequest);
  const assembly = useStore((s) => s.assembly);
  const overlapPreset = useStore((s) => s.overlapPreset);
  const advanced = useStore((s) => s.advancedBedtoolsOptions);
  const blacklistFilter = useStore((s) => s.blacklistFilter);
  const upsetSort = useStore((s) => s.upsetSort);
  const upsetMinSize = useStore((s) => s.upsetMinSize);
  const pairwiseStat = useStore((s) => s.pairwiseStat);
  const includedSets = sets.filter((s) => s.included);
  const linkable = includedSets.length > 0 && includedSets.every((s) => s.sourceUrl);
  const linkHash = buildLink({
    mode: inputMode,
    files: linkable ? includedSets.map((s) => ({ url: s.sourceUrl!, name: s.name })) : [],
    settings: { assembly, overlapPreset, advanced, blacklistFilter, upsetSort, upsetMinSize, pairwiseStat },
    view,
    sel: [...selected],
  });
  useEffect(() => {
    // Read from the store, not this render: the link is requested by the
    // effect above in this same commit, after this render's value was taken.
    if (linkRequest || useStore.getState().linkRequest) return;
    window.history.replaceState(null, "", `#${linkHash}`);
  }, [linkHash, linkRequest]);
  const [linkCopied, setLinkCopied] = useState(false);
  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}#${linkHash}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }, [linkHash]);

  const selectedSubsets = useChosenGroups();

  const setSummaryItems: SummaryItem[] = sets
    .filter((s) => s.included)
    // version = contentKey: the filtered and unfiltered versions of a set are cached separately.
    .map((s) => ({ id: s.id, version: s.contentKey, name: s.name, color: s.color, getRawText: () => s.file.text() }));

  // Subsets (unlike sets) get recomputed under a new mask -> content
  // mapping whenever the overlap setting changes, so the cache key needs
  // more than the mask to stay correct (see SummaryItem.version's doc).
  // Colors come from the shared PALETTE by selection order, not from any
  // one member set's color — a subset can span multiple sets.
  const selectedSubsetSummaryItems: SummaryItem[] = selectedSubsets.map((s, i) => ({
    id: String(s.mask),
    version: `${s.mask}:${s.nRegions}:${s.nBp}`,
    name: s.label,
    color: PALETTE[i % PALETTE.length],
    getRawText: () => Promise.resolve(subsetToBedText(s)),
  }));

  // Nearest genes of each selected subset or set, for its card's Genes tab (and Export analysis).
  const nearest = useNearestGenes(listMode ? [] : selectedSubsetSummaryItems);

  return (
    <div className="shell">
      <LinkDialog />
      <header className="top">
        <div className="brand">
          <h1><img src="achi-logo.svg" width="125" alt="Achi" /></h1>
          <span className="eyebrow">a browser-based framework for comparing, annotating, and interpreting genomic intervals</span>
        </div>
        <nav className="topnav" aria-label="Site">
          <OfflineBadge
            onOpenHelp={() => {
              setView("help");
              requestAnimationFrame(() => document.getElementById("offline")?.scrollIntoView());
            }}
          />
          <button className="ghost" aria-pressed={view === "help"} onClick={() => setView(view === "help" ? lastWorkspaceView.current : "help")}>
            Help
          </button>
          <a
            className="ghost"
            href="#view=help"
            onClick={(e) => {
              e.preventDefault();
              setView("help");
              requestAnimationFrame(() => document.getElementById("cite")?.scrollIntoView());
            }}
          >
            Cite
          </a>
        </nav>
      </header>

      {view === "help" ? (
        <HelpPage onBack={() => setView(lastWorkspaceView.current)} />
      ) : (
      <main className={`work${railOpen ? "" : " rail-closed"}${asideOpen ? "" : " aside-closed"}`}>
        {!railOpen && (
          <section className="col asidestrip railstrip" aria-label="Data and parameters (hidden)">
            <button
              className="asidetab"
              onClick={() => setRailOpen(true)}
              aria-expanded={false}
              aria-controls="set-rail"
              title="Show the data and parameters column"
            >
              <Icon name="railOpen" />
              <span className="asidetab-label">{listMode ? "Lists" : "Region sets"}, settings and annotations</span>
              {sets.length > 0 && <span className="asidetab-count">{sets.length}</span>}
            </button>
          </section>
        )}
        <SetRail hidden={!railOpen} onHide={() => setRailOpen(false)} />

        <section className="col mid" aria-label="Intersections">
          <div className="rowsplit">
            <div className="tabs" role="tablist">
              {VIEWS.filter((v) => !listMode || LIST_VIEWS.includes(v.id)).map((v) => (
                <button
                  key={v.id}
                  className="tab"
                  role="tab"
                  aria-selected={view === v.id}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="rowsplit-actions">
              <button className="ghost" disabled={!selected.size} onClick={() => void exportSelectedBedZip()}>
                Export selected
              </button>
              <button
                className="ghost"
                disabled={!sets.length || busy}
                title="One ZIP: every subset, tables, the plots on screen, a methods paragraph and a settings file to restore this analysis"
                onClick={() => void exportAnalysis()}
              >
                Export analysis
              </button>
              <button
                className="ghost"
                disabled={!linkable || busy}
                title={
                  linkable
                    ? "Copy a link that opens these public files with the same settings, view and selection"
                    : "Only for sets opened from public web links: a file from your computer is never put in a link"
                }
                onClick={() => void copyLink()}
              >
                {linkCopied ? "Link copied" : "Copy link"}
              </button>
            </div>
          </div>

          <div className={`card plotcard${busy ? " busy" : ""}`} aria-busy={busy}>
            <ComputeStatus />
            <div className="hd">
              <div className="eyebrow">
                {view === "summary"
                  ? "Summary — per-set interval statistics (bedtools summary)"
                  : view === "browser"
                    ? "Genome Browser — genome-wide overview (GenomeSpy) linked to igv.js"
                    : "Intersections — click a bar to select a subset"}
              </div>
            </div>
            {view === "upset" && <UpSetPlot />}
            {view === "venn" && <VennPlot />}
            {view === "pairwise" && <PairwiseHeatmap />}
            {view === "table" && <SubsetTable />}
            {view === "summary" && <SummaryPlot items={setSummaryItems} />}
            {view === "browser" && <GenomeBrowser />}
          </div>

          {view === "summary" && (
            <div className="card">
              <div className="hd">
                <div className="eyebrow">Region annotation — bedtools intersect/closest vs. GENCODE</div>
              </div>
              <RegionAnnotationPlot items={setSummaryItems} />
            </div>
          )}

          {/* Selection is about intersection subsets: not shown with the per-set Summary. */}
          {view !== "summary" && (
            <div className="card">
              <div className="bd">
                <div className="selhd">
                  <div className="eyebrow">Selection</div>
                  {!listMode && sets.length > 0 && <CollapseAllButton ids={ANALYSIS_PANELS} waiting={!selectedSubsets.length} />}
                </div>
                <SubsetChips view={view} />
              </div>
            </div>
          )}

          {/* Shown once regions are loaded: before a selection they wait folded, as a list of what can be run. */}
          {!listMode && view !== "summary" && sets.length > 0 && (
            <>
              {/* Grouped by the question each panel answers: annotate → region enrichment → function. */}
              <h2 className="panelgroup">Annotate regions</h2>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="summary" title="Summary of selected subsets and sets (bedtools summary)">
                <SummaryPlot items={selectedSubsetSummaryItems} />
              </CollapsiblePanel>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="annotation" title="Region annotation of selected subsets and sets — bedtools intersect/closest vs. GENCODE">
                <RegionAnnotationPlot items={selectedSubsetSummaryItems} />
              </CollapsiblePanel>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="signal" title="Signal at the selected subsets and sets — profiles and heatmaps (bigWig)">
                <div className="bd">
                  <SignalProfilePanel />
                </div>
              </CollapsiblePanel>

              <h2 className="panelgroup">Region enrichment</h2>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="enrichment" title="Enrichment of selected subsets and sets — reference region sets">
                <div className="bd">
                  <SubsetEnrichmentPanel />
                </div>
              </CollapsiblePanel>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="motifs" title="Motif enrichment of selected subsets and sets — JASPAR 2026">
                <div className="bd">
                  <MotifEnrichmentPanel />
                </div>
              </CollapsiblePanel>

              <h2 className="panelgroup">Functional analysis</h2>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="go" title="GO analysis of selected subsets and sets — GREAT-like or Cistrome-GO-like">
                <div className="bd">
                  <GoEnrichmentPanel />
                </div>
              </CollapsiblePanel>
              <CollapsiblePanel waiting={!selectedSubsets.length} id="expression" title="Expression near the selected subsets and sets — BETA-like and nearest gene">
                <div className="bd">
                  <ExpressionPanel />
                </div>
              </CollapsiblePanel>
            </>
          )}
        </section>

        {!asideOpen ? (
          <section className="col asidestrip" aria-label="Selected subset and set details (hidden)">
            <button
              className="asidetab"
              onClick={() => setAsideOpen(true)}
              aria-expanded={false}
              aria-controls="selected-subsets"
              title="Show the selected subsets and sets column"
            >
              <Icon name="panelOpen" />
              <span className="asidetab-label">Selected subsets and sets</span>
              {selectedSubsets.length > 0 && <span className="asidetab-count">{selectedSubsets.length}</span>}
            </button>
          </section>
        ) : (
        <section className="col" id="selected-subsets" aria-label="Selected subset and set details">
          <div className="asidehd">
            <div className="eyebrow">Selected subsets and sets</div>
            <button
              className="iconbtn"
              onClick={() => setAsideOpen(false)}
              aria-expanded={true}
              aria-controls="selected-subsets"
              aria-label="Hide the selected subsets and sets column"
              title="Hide this column (widens the middle column)"
            >
              <Icon name="panelClose" />
            </button>
          </div>
          {!selectedSubsets.length && (
            <div className="placeholder">
              <div className="big">Nothing selected</div>
              <div className="sm">
                Click a bar or dot column in the UpSet plot, a number in the Venn diagram, or a row in the Table to see a subset's {listMode ? "names" : "regions"} here.
              </div>
            </div>
          )}
          {selectedSubsets.map((s, i) => (
            <SelectedGroupCard key={s.mask} group={s} genes={listMode ? undefined : nearest.genesOf(selectedSubsetSummaryItems[i])} genesError={nearest.error} />
          ))}
        </section>
        )}
      </main>
      )}

      <footer className="bot">
        <div className="foot-notes">
          <span className="free">
            <span className="dot" aria-hidden="true" />
            Achi is open to all without any login.
          </span>
          <span className="foot-private">Your files never leave your browser.</span>
        </div>
        <nav className="foot-links" aria-label="About this site">
          <a
            href="#view=help"
            onClick={(e) => {
              e.preventDefault();
              setView("help");
              requestAnimationFrame(() => document.getElementById("cite")?.scrollIntoView());
            }}
          >
            How to cite
          </a>
          <a href={SOURCE_CODE_URL} target="_blank" rel="noreferrer">
          Source code
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noreferrer">
          MIT licence
          </a>
          <span>
            © {COPYRIGHT_YEAR}{" "}
            <a href={LAB_URL} target="_blank" rel="noreferrer">
            {LAB_NAME}
            </a>
          </span>
        </nav>
      </footer>
    </div>
  );
}

export default App;

