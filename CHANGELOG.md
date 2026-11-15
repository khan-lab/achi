# Changelog

## Added: reference sets as context rows in the genome-wide view (2026-11-15)

- The "Genome-wide location of selected subsets" card can add any bundled
  reference set of the assembly (ENCODE cCREs, FANTOM5 / VISTA enhancers,
  CpG islands, ClinVar, GWAS Catalog, fine-mapping regions, ENCODE
  problematic regions) as context rows ("Ref: …", one neutral colour),
  below the subsets. The Shift + drag interval counts include them, e.g.
  how many ClinVar variants fall where a subset clusters. Files come from
  the app's own refdata/ when first ticked (ClinVar, 12 MB, takes about
  10 s once); nothing is sent.
- `referenceOptions()` (lib/browserTracks.ts, tested) now lists the bundled
  reference sets for both the genome browser and this card.
- Skipped, by decision: a Manhattan-style variant view (no p-values in VCF
  or peak input; the card, enrichment tests and browser cover the rest).
- **Interaction change (for design/reference.html):** a collapsible
  "Reference sets as context rows" checklist in the genome-wide card.

## Changed: the genome view is a card for the selected subsets, not a tab (2026-11-15)

- The GenomeSpy view moved from its own "Genome" tab to a card, "Genome-wide
  location of selected subsets", right below "Summary of selected subsets
  (bedtools summary)". It follows the selection made in UpSet, Venn or
  Table, like the other selected-subset cards.
- The subset chips are gone (the card uses the main selection). New
  checkbox "Show the input sets for context" (on by default) adds the input
  sets as context rows; off shows only the selected subsets.
- GenomeSpy and the gene models load only when the card scrolls into view.
- Offline: GenomeSpy's font atlas (`.webp`) is now cached with the app.
- **Interaction changes (for design/reference.html):** view tabs back to
  six (no "Genome"); new card in the selected-subset section with the
  input-set checkbox, locus box, Go, Whole genome, plot, interval summary
  and SVG/PNG; no subset chips.

## Added: Genome view, linked to the subset selection (2026-11-15)

- New **Genome** view tab (GenomeSpy 1.3.0, MIT, pinned; loaded only when
  the tab is first opened, about 300 kB gzipped; minimal entry with the
  WebGL2, Canvas2D-fallback and SVG renderers only). Where each included set
  and each selected subset lies along the whole genome:
  - a chromosome strip; a density strip per track (regions per 1 Mb by
    midpoint, opacity relative to the track's densest Mb); one row of
    regions per track (tracks over 500,000 regions: density only);
  - zoom (Ctrl/⌘ + scroll) and pan from the whole genome to single regions;
    a locus/chromosome/gene box and "Whole genome";
  - Shift + drag selects an interval: per-track region counts, "zoom here",
    and "open in genome browser" for a single-chromosome interval;
  - click a region to open it in the Browser tab; click a density bin to
    zoom to it; SVG/PNG export named after the view.
- **Linked to the UpSet selection:** the subset chips above the plot toggle
  the same selection as UpSet, Venn and Table, and the view follows it.
- Privacy: inline assembly, data set from memory, no URL in the spec (tests
  in `genomeView.test.ts`); a recorded session made no outside request.
- Shared gene-model loader (`lib/geneModelsLoader.ts`) for gene search in
  both the Genome and Browser views. GenomeSpy's embed API is typed locally
  (`src/types/genomespy/`, mapped in `tsconfig.app.json`) because the
  package ships `.ts` sources that do not compile under this project's
  settings.
- **Interaction changes (for design/reference.html):** a seventh view tab
  "Genome" (between Set Summary and Browser): subset chips (8 largest plus
  selected, "all N subsets"), locus box, Go, Whole genome, the plot, an
  interval summary box after Shift + drag, SVG/PNG buttons; the Selection
  card mentions the chips when the Genome tab is open.

## Added: export the genome browser view as SVG or PNG (2026-11-15)

- SVG and PNG buttons under the genome browser, like the other plots. They
  save the current view as igv.js draws it (`browser.toSVG()`: ideogram,
  ruler, genes, sets, subsets, reference and public tracks), named after
  the locus, e.g. `intervene-browser_chr12_6520000-6560000.svg`. PNG is
  rasterised from the same SVG at 2×. Made in the page; nothing is sent.
- `lib/exportImage.ts`: `downloadSvgText`, `downloadPngFromSvgText` and
  `svgDimensions` (tested) for exporting SVG markup, not only on-page SVG
  elements.
- **Interaction change (for design/reference.html):** SVG / PNG buttons
  below the genome browser.

## Added: more public tracks; chromosome bands in the genome browser (2026-11-15)

- **Chromosome bands:** the ideogram above the browser was an empty outline
  (igv had no band data). UCSC cytobands are now bundled per assembly
  (`refdata/<asm>/cytoband.txt`, 14–31 kB, `build_cytobands.py`), so bands
  show with no outside request; cached for offline use.
- **New public tracks** (opt-in, same consent):
  - phyloP conservation from UCSC: hg38 100 vertebrates and 241 mammals
    (Zoonomia), hg19 100 vertebrates, mm10 60 vertebrates;
  - JASPAR 2024 predicted TF binding sites (UCSC track file; hg38, hg19,
    mm10), drawn below 20 kb, shaded by score and stacked;
  - each example cell line's cell-type-specific ENCODE cCREs (hg38 V4,
    hg19 V1), as a fifth column of the cell line × assay table.
- The consent notice now also names hgdownload.soe.ucsc.edu.
- **Interaction changes (for design/reference.html):** the ideogram shows
  bands; the public-tracks section has "Conservation (UCSC)" and "TF binding
  sites (JASPAR 2024, UCSC)" groups and a "cCREs" column in the cell-line
  table; the consent notice lists four hosts.

## Added: genome browser, phase 2: public tracks, opt-in (2026-11-15)

- **Public tracks** in the Browser tab, off until the user agrees. The
  notice names the hosts (www.encodeproject.org, encode-public.s3.
  amazonaws.com, downloads.wenglab.org) and says they will see the regions
  viewed; agreement lasts for the page session only (memory, not stored).
- Curated lists (`refdata/<asm>/remote/tracks.json`, built by
  `build_remote_tracks.py`; sources and pins in docs/provenance.md):
  - SCREEN merged signal, DNase, ATAC, H3K4me3, H3K27ac, CTCF (hg38, mm10);
  - ENCODE cCRE registry bigBed (hg38 V4, mm10 V4, hg19 V1);
  - ENCODE signal for the example cell lines (GM12878, HepG2, K562, MCF-7,
    H1 × DNase, H3K27ac, H3K4me3, CTCF; hg38, hg19).
- One box to search ENCODE (released bigWig/bigBed on the current
  assembly), add an ENCFF accession (wrong assembly is refused with the
  reason), or paste a bigWig/bigBed URL; a URL on a host not yet agreed to
  asks first.
- Fix: the Browser tab now also starts when no files are loaded.
- **Interaction changes (for design/reference.html):**
  - Browser tab: "Add public tracks (ENCODE, SCREEN)…" button -> consent
    notice (Allow for this session / Cancel);
  - after consent, a "Public tracks" section: checkboxes for SCREEN signal
    and the cCRE registry, a cell line × assay checkbox table, the
    search/accession/URL box with results (add), an "Added" list (remove),
    and "Stop public tracks" (removes all and withdraws consent);
  - the note under the browser names the hosts in use while public tracks
    are shown.

## Added: genome browser, phase 1 (local data only) (2026-11-15)

- New **Browser** view (igv.js 3.8.10, MIT, pinned; loaded only when the tab
  is first opened, 438 kB gzipped): one track per input set (set colour),
  one per selected subset (set colour for single-set subsets, UpSet grey
  for shared ones), GENCODE gene models, and any bundled reference set or
  the ENCODE problematic regions on request.
- **Nothing leaves the page:** genome = bundled chrom.sizes (no sequence),
  igv's genome list and search service off, locus and gene search resolved
  in the page, sets passed in memory. `browserTracks.test.ts` checks the
  configuration; a recorded browser session made no outside request.
- New data: `refdata/<asm>/genes/gene_models.bed` (one transcript per gene,
  all biotypes; 5.6–10.4 MB, built by `build_gene_models.py`; rule and
  checksums in docs/provenance.md), cached for offline use. Offline app
  shell 4.4 -> 6.0 MB (includes igv.js).
- **Interaction changes (for design/reference.html):**
  - sixth view tab **Browser**, with a locus/gene box, Go, zoom − / +, and a
    collapsible "Reference sets" checklist;
  - each row of a selected subset's region table has a **view** link that
    opens the Browser there (with 20% margin);
  - genes in the "Nearest gene" lists are clickable and open the Browser on
    that gene;
  - the Browser keeps its locus and reference-set choices across tab
    switches; the Selection card says subsets are selected in UpSet, Venn or
    Table when the Browser tab is open.
- Phase 2 (opt-in public ENCODE tracks, URL/accession entry, ENCODE search)
  is planned, not built.

## Changed: the app lives at the repository root (2026-11-15)

- Everything that was under `frontend/` (`src/`, `public/`, `index.html`,
  `package.json`, Vite/TypeScript/vitest/oxlint configs) moved up to the
  repository root. `npm ci`, `npm run dev`, `npm test`, `npm run build`
  now run from the root; the build is in `dist/`.
- Updated paths: test fixtures (`../../tests/fixtures`), the refdata build
  scripts (`REFDATA = public/refdata`, run from the repo root), the deploy
  workflow (no `working-directory`, uploads `dist`), `.gitignore` (merged
  with the old `frontend/.gitignore`), README, package name
  `intervene-secure`, and file paths in comments and docs.
- Earlier entries below keep their original `frontend/...` paths.
- No change to the app or its behaviour.

## Added: page metadata, home-screen icon, installable app (2026-11-15)

- `index.html`: description, canonical URL, Open Graph / Twitter link
  previews, schema.org `WebApplication` data with the Intervene citation,
  `referrer: no-referrer`, iOS phone-number detection off.
- Home-screen icon from `intervene-icon-mobile.svg/.png`:
  `apple-touch-icon.png` (180 px) and `intervene-icon-maskable.png`
  (512 px, Android) are white-background, padded renders of it, because
  iOS fills transparency with black and Android crops icons to a shape.
- `manifest.webmanifest` (name, icons, `display: standalone`); icons and
  manifest are cached with the app shell for offline use.
- **Interaction change (for design/reference.html):** "Add to Home Screen"
  (iPhone) or "Install app" (Android, desktop Chrome/Edge) now opens
  Intervene in its own window, without the browser's address bar.

## Changed: the empty Selection card explains how to select (2026-11-14)

- **Interaction change (for design/reference.html):** with nothing
  selected, the Selection card now says what selecting is for and how to do
  it in each view: UpSet (click a bar or its column of dots), Venn (click a
  number), Table (click a row). The current view's way is listed first and
  highlighted. On Pairwise it says to switch view, since the heatmap
  compares whole sets. Before any data is loaded it asks for files or the
  example data. The "Selected subsets" placeholder on the right uses the
  same wording.

## Changed: works on phones (2026-11-13)

- **Interaction change (for design/reference.html):**
  - below 1180 px (one column) the page no longer widens to ~700 px: the
    single column can shrink, and wide plots and tables scroll sideways
    inside their own card;
  - **External annotations** in the left rail is now collapsible (caret,
    count of available sets). Open by default on wide screens, closed by
    default below 1180 px so the plots follow the uploaded sets;
  - below 760 px: the header shows the logo, Help and Cite only (the
    tagline is hidden); the view tabs scroll sideways and **Export
    selected subsets** takes its own full-width line; columns use 12 px
    padding.
- Checked at 360, 390, 768, 1024, 1280 and 1500 px: no horizontal page
  scroll; loading the example, tapping an UpSet bar, GO enrichment and Help
  work by touch at 390 px. Desktop layout unchanged.

## Changed: tagline names annotation and enrichment; shorter README (2026-11-13)

- **Interaction change (for design/reference.html):** the header tagline is
  now "A secure platform for in-browser genomic intersections, annotation
  and enrichment without data upload", and the browser tab title "Intervene —
  A secure tool for genomic intersections, annotation and enrichment in the
  browser". The tagline stays on one line from 1280 px; at 1024 px it wraps
  to two lines.
- README shortened to an overview (intersection, annotation, enrichment);
  the details live in the Help page, docs/methods.md and docs/provenance.md.

## Changed: no Selection card on the Set Summary tab (2026-11-13)

- **Interaction change (for design/reference.html):** the "Selection" card
  (selected-subset chips) no longer appears below "Region annotation —
  bedtools intersect/closest vs. GENCODE" on the Set Summary tab. Set
  Summary describes whole input sets, and the selection is about
  intersection subsets; the card still shows on UpSet, Venn, Pairwise and
  Table, and the selection itself is kept when switching tabs.

## Added: Cistrome-GO-like method, GO settings, per-subset result tabs, AmiGO links (2026-11-13)

- **Interaction change (for design/reference.html):** the GO enrichment
  card (now titled "GO enrichment of selected subsets — GREAT-like or
  Cistrome-GO-like") changes:
  - a new first tab group, **GREAT-like | Cistrome-GO-like**, picks the
    method. The "-like" names say each follows a published approach,
    reimplemented in the browser, not a copy of the tool;
  - GREAT's background tabs (vs. input sets | vs. genome (GREAT)) are gone:
    the background is now the first GREAT-like setting, a select with
    **Genome** (new default, was input sets) and **Input sets**;
  - a collapsible **Settings** box under the description lists the chosen
    method's parameters with their defaults. A changed value shows
    "· default X" in accent colour, the summary line counts the changes,
    and **Reset to defaults** restores them. GREAT: background, basal upstream /
    downstream, maximum extension, smallest / largest term, q threshold,
    minimum fold (genome only). Cistrome-GO: half-decay distance (auto,
    0.5–500 kb), peaks used (top N or all), smallest / largest term, XL-mHG
    L, q threshold, remove redundant terms;
  - results are now **one tab per selected subset** (swatch, label and the
    count of significant terms), replacing the stacked per-subset blocks.
    Each tab has a one-line summary, its own bar chart (top 15 terms,
    titled with subset, namespace and method), a table of the first 100
    terms, and downloads: TSV for this subset, **TSV (all)**, SVG, PNG;
  - GO ids in the tables are **links to the term's AmiGO page**, opening in
    a new tab without a referrer;
  - Cistrome-GO rows list the term's leading genes;
  - the progress overlay counts terms tested during Cistrome-GO runs, and
    the page stays responsive meanwhile.
- **Cistrome-GO** (solo mode) ported from the package
  (github.com/changxinw/Cistrome-GO, commit 6b7f003, MIT): peak selection
  by score, promoter fraction and automatic half-decay distance,
  regulatory potential, Cistrome DB background adjustment, ranking, XL-mHG
  test (ported from xlmhg, BSD 3-clause), BH. Null model in
  docs/methods.md ("GO enrichment of selected subsets — Cistrome-GO-like").
- Checked against the package's own Python code on three real ENCODE
  fixtures and three settings: the same promoter fractions, decay, RP,
  adjusted RP (to 1e-12) and ranking, once its end-of-chrX bookkeeping slip
  is reproduced in a brute-force oracle. XL-mHG checked against xlmhg's
  mhg.py, exact BigInt path counting and full enumeration.
- Deliberate differences from the package, documented in methods:
  - downstream peaks at the end of the last chromosome are counted;
  - correct 0-based rank positions (the package's off-by-one changes
    p-values by up to 2× and the q < 0.2 call of 4–6% of called terms on
    the example data);
  - the current GO release with the redundancy filter applied at run time;
  - no p-value underflow for large terms.
- GREAT's distances, term-size limits and significance cut-offs are now
  parameters (`GreatSettings`, defaults unchanged); results at the
  defaults are unchanged.
- Data:
  - `refdata/<assembly>/cistromego/rp_model.json` (0.6 MB compressed), built
    by `refdata/build_cistromego.py` from the package's files at the
    pinned commit, added to the offline allow-list;
  - `go.json` rebuilt from the same GO downloads with terms of up to 2,000
    genes (was 1,000), for Cistrome-GO's defaults; terms up to 1,000 genes
    are byte-for-byte unchanged; about 2 MB compressed (was 1.5 MB).
- Test reference values: `tests/fixtures/cistromego/` (script, Python 3
  syntax diff and provenance).
- The progress overlay takes an optional unit (it said "bedtools steps" for
  GO runs, which use no bedtools).

## Added: GO enrichment of selected subsets, GREAT-style (2026-11-13)

- **Interaction change (for design/reference.html):** a new card, "GO
  enrichment of selected subsets — GREAT regulatory domains", appears below
  the reference-set enrichment card when subsets are selected. It has:
  - tabs for Biological process / Molecular function / Cellular component
    and for **vs. input sets** (default) / **vs. genome (GREAT)**;
  - a **Run GO enrichment** button, which becomes **Run again**, with the
    progress overlay;
  - a bar chart of the top 10 enriched terms per subset: bars show
    −log₁₀ q, a dashed line marks q = 0.05, labels give fold or odds ratio,
    and non-significant bars are faded;
  - SVG/PNG/TSV downloads and a scrolling table per subset;
  - a "Run again" note when the settings or selection change.
- Method (docs/methods.md, "GO enrichment of selected subsets"):
  - GREAT basal-plus-extension domains; regions counted at their
    left-median base;
  - genome background: GREAT's binomial (non-gap genome) and
    hypergeometric tests, significant when both q < 0.05 and fold ≥ 2;
  - input-sets background: Fisher's exact test;
  - Benjamini–Hochberg over all terms with 5–1,000 genes.
- Checked against native bedtools (domains vs an O(n²) reading of the
  rule, region assignment, term genome fractions) and R (`pbinom`,
  `phyper`). **Not yet compared with rGREAT** (PLAN.md asks for rank
  correlation > 0.95); see docs/provenance.md.
- Data: `refdata/<assembly>/go/go.json` (1.5 MB compressed) and
  `gaps.bed`, built by `refdata/build_go.py` from go-basic.obo
  (2026-07-26), GOA human / MGI GAFs (2026-05-21) and UCSC gap tables.
  Added to the offline allow-list.

## Added: offline mode (2026-11-13)

- **Interaction changes (for design/reference.html):**
  - The header shows a small "Works offline" badge once the app is cached,
    or "Offline" when there is no connection. Clicking it opens Help →
    Offline use.
  - Help has a new **Offline use** section listing each assembly's cached
    reference data (e.g. "65 MB of 65 MB") with a **Make available
    offline** button.
- How it works: a service worker (`public/sw.js`, production builds only)
  caches:
  - the app, bedtools WebAssembly, examples and chromosome sizes (~5 MB) on
    the first visit;
  - reference data per assembly when first used, or on request.

  A build plugin in `vite.config.ts` writes `offline-manifest.json` with
  content hashes and stamps its version into `sw.js`, so each deploy
  updates the cache. Which files are cached is an allow-list in
  `src/lib/offlineManifest.ts`; GTFs and scripts are never cached.
  Navigations are network-first, so online users always get the latest
  version.
- Verified in Chromium: with the server stopped, a reload restores the
  app, and the example, UpSet, region annotation and enrichment all work.
  A redeploy replaces the cached app and deletes the old copy.
- **Fixed (privacy):** fonts came from Google Fonts, so every page load
  sent the visitor's IP address to Google. They are now bundled
  (Fontsource, SIL OFL 1.1; new dependencies `@fontsource/inter-tight` and
  `@fontsource/jetbrains-mono`, pinned). `src/styles/tokens.css` no longer
  has the `@import`; please mirror this in design/reference.html.

## Added: enrichment of selected subsets (2026-11-13)

- **Interaction change (for design/reference.html):** a new card,
  "Enrichment of selected subsets — reference region sets", appears below
  "Region annotation of selected subsets" when subsets are selected. It has:
  - an **Adjust for region length** checkbox (on by default) and a **Run
    enrichment** button, which becomes **Run again** after the first run;
  - the progress overlay while running;
  - a heatmap: rows are reference sets, columns are the selected subsets,
    each cell shows the odds ratio, coloured blue (depleted), grey (none) or
    red (enriched), with significance stars;
  - SVG/PNG/TSV downloads and a results table sorted by q;
  - a dimmed result and a "Run again" note when the selection or settings
    change.
- Statistics (docs/methods.md, "Subset enrichment for reference region
  sets"):
  - background: every region of the analysis;
  - test: Fisher's exact, or Cochran–Mantel–Haenszel over 5 length strata;
  - multiple testing: Benjamini–Hochberg.

  New `lib/stats.ts` matches R's `fisher.test`, `mantelhaen.test` and
  `p.adjust` (tests check against R, and against native bedtools on the
  ENCODE fixtures).
- **Fixed:** Pairwise → Fisher no longer fails when `bedtools fisher`
  prints `-nan` or `inf`, for example with GWAS added to the example. Pairs
  it cannot estimate show "n/a" with an explanation. bedtools' interval
  model breaks down for very different region sizes, which is also why
  enrichment has no whole-genome background.

## Added: ENCODE problematic regions count and filter (2026-11-13)

- **Interaction changes (for design/reference.html):**
  - Each set card has a new grey line: "N regions (x%) overlap ENCODE
    problematic regions". With the filter on, it reads "Removed N regions
    (x%) overlapping ENCODE problematic regions". It is hidden on mm9, which
    has no v2 list.
  - BEDTools Parameters has a new checkbox, **Exclude ENCODE problematic
    regions**, off by default, with a status line underneath ("Off: regions
    are used as given…" / "On: N regions removed across all sets…"). It is
    disabled on mm9.
  - Switching assembly now re-runs the problematic-region count (and the subsets, if
    the filter is on), with the usual progress overlay.
- Filter = `bedtools intersect -v` against the problematic regions with 1 bp overlap,
  applied to every set before subsets, Pairwise, Set Summary, annotation
  and nearest genes. The export ZIP's README states when it was on.
- Data: ENCODE problematic regions v2 (published as the ENCODE Blacklist,
  Amemiya et al. 2019) for hg38/hg19/mm10 vendored under
  `frontend/public/refdata/<assembly>/blacklist/` (GPL-3.0; provenance and
  checksums in docs/provenance.md). Built by
  `build_external_annotations.py <scratch> blacklist`, which can now build
  selected sets only.
- Subset and Pairwise caches are now keyed by set content, so switching the
  filter on and off reuses earlier results.
- Naming: the app, help page, README and docs say "ENCODE problematic
  regions", never "blacklist". The original name appears only where it
  identifies the source (paper title, Boyle-Lab/Blacklist repository,
  provenance). Code identifiers and file paths (`lib/blacklist.ts`,
  `refdata/<assembly>/blacklist/`) are unchanged.

## Changed: progress overlay on region annotation (2026-11-13)

- **Interaction change (for design/reference.html):** the Region annotation
  card (on Summary, and "of selected subsets" under the UpSet/Venn/Pairwise
  views) now shows the same overlay as the main plot while it works:
  spinner, the current step (e.g. "HepG2 only: Promoter-proximal"), and a
  bar of finished bedtools steps. Both charts (category composition and
  distance to nearest TSS) are dimmed underneath until the result lands.
  It replaces the small "annotating regions…" text.
- Steps: one per GENCODE reference file (first use per assembly only),
  then 21 per subset (an `intersect -u` and `-v` per category, then one
  `closest`).
- **Fixed:** selecting another subset while one was still being annotated
  ran two classification chains through the same temporary files, which
  could give wrong category counts. Each run now uses its own files and
  removes them when done.

## Changed: scrolling annotation groups (2026-11-13)

- **Interaction change (for design/reference.html):** in the External
  annotations card, a category with more than 3 entries (e.g. Regulatory
  elements, 5 for hg38/mm10) now shows exactly its first 3 rows and scrolls
  the rest inside the group. The header shows the entry count, a fade marks
  the cut-off, and a "Scroll for N more" cue disappears once the end is
  reached. Tabbing to a hidden Add button scrolls it into view. Groups with
  3 or fewer entries are unchanged.

## Fixed: Pairwise Jaccard (2026-11-13)

- **Bug:** the Pairwise view derived Jaccard from the UpSet subsets'
  base pairs ("intersection = bp of subsets containing both sets"). That was
  right while subsets were bp-precise `multiinter` fragments, but since
  commit 78a9ab6 subsets hold whole regions of each combination's first
  set, so a large region touching a tiny one counted entirely as shared.
  Values were wrong for every pair, and impossible (> 1) with very
  different region sizes — e.g. 15.60 for MCF7 super-enhancers vs GWAS
  variants; the true value is 0.000233.
- **Fix:** each ordered pair now runs real `bedtools jaccard` with the
  user's overlap options, as the CLI's `intervene pairwise --compute
  jaccard` does (`lib/pairwiseStats.ts::computeJaccard`), cached per pair.
  Sets are sorted with plain `bedtools sort` (no genome file), so it works
  for any assembly. The CLI's `u=True` flag was checked: bedtools jaccard
  ignores it. Cells show small values in exponent form (2.3e-4) instead of
  "0.00"; tooltips give shared and total bp.
- Tests first: `parseJaccardOutput` against real captured output; native
  bedtools tests for range and intersection/union, self-Jaccard = 1 on a set
  with internally overlapping regions (ClinVar), and a regression on the
  real MCF7 vs GWAS pair confirming the old formula exceeded 1. Verified in
  the browser: all 30 cells for 6 sets match native bedtools jaccard.
- `docs/methods.md`: new Jaccard entry.

**Interaction changes for `design/reference.html`:** Jaccard cells now fill
in progressively ("…" while computing) like Fisher/Reldist; legend text
under the Jaccard heatmap.


## UpSet shows every subset, scrolls sideways (2026-11-13)

- Removed the 14-bar cap and its "Showing the 14 largest of N" note: the
  UpSet plot draws every subset at or above *Min size* (the only filter).
  When that's wider than the card, the plot scrolls sideways inside
  `.upset-scroll`; the Size/Degree and Min size toolbar and the SVG/PNG
  buttons stay in place.
- The left block (y-axis, set-size bars, set names) is pinned while the
  bars scroll — a second copy in a `position: sticky` overlay — so every
  dot row stays labelled. It blocks clicks, so a hidden bar underneath can't
  be toggled through it, and `scroll-padding-left` keeps a keyboard-focused
  bar clear of it. Exports are unchanged: one SVG with every bar (137 in
  the 8-set test) and the labels.

**Interaction changes for `design/reference.html`:** UpSet has no bar cap;
horizontal scroll with pinned set labels and y-axis.


## Centred icon buttons (2026-11-13)

- Icon buttons (set include/exclude, remove, reset colour; subset copy,
  download, close; gene-list copy/download; subset-chip download/close)
  used text glyphs (⬇ ◉ ○ ⧉ ✕ ↺ ✓), each sitting on its font's baseline
  with its own side bearings, so none were centred. Replaced with inline
  SVG icons on one 16×16 grid (`components/Icon.tsx`); `.iconbtn` and
  `.chip .x` now centre with flexbox. Measured in the browser: all 15 icon
  buttons 0 px off centre.
- `.iconbtn` / `.chip .x` were also showing the browser's default bevelled
  button border; now flat (transparent, no border) with the existing hover
  background, as the stylesheet intended. Export SVG/PNG buttons unchanged.

**Interaction changes for `design/reference.html`:** icon buttons use line
icons instead of text glyphs; flat icon-button style.


## Up to 8 sets, all-pairs colour-blind-checked palette (2026-11-13)

- `MAX_SETS` raised from 6 to 8 (now in `types.ts`, used by the store, the
  rail, the drop zone and the help page). A 9th file is refused with a
  notice; Add buttons say why they're disabled.
- **New 8-colour palette** (`types.ts`, rationale in the comment). Chosen by
  search and checked with the dataviz skill's `validate_palette.js` with
  `--pairs all` (every set's colour sits side by side in the UpSet matrix,
  so every pair matters, not just neighbours): worst pair under
  protan/deutan simulation ΔE 8.8 (target ≥ 8), worst normal-vision pair
  ΔE 17.5 (floor 15), all ≥ 3:1 on the plot background, all checks PASS.
  The old 6-colour palette failed this check (olive #5F7A14 vs orange
  #C2611A ΔE 1.3 under protanopia). Slot 1 blue unchanged; the rest keep
  similar families (ochre, teal, purple, coral, green) plus mauve and lilac.
  `types.test.ts` guards that colours are never cycled.
- UpSet: with up to 255 combinations, the plot now says when it shows only
  the 14 largest ("Showing the 14 largest of 137 subsets…"). Bar counts that
  don't fit their bar use a compact form (`lib/textMeasure.ts::fitCount`,
  tested: 1.2k, 298k, 1.5M; full numbers stay in tooltips, accessible labels
  and the Table), and the set-size column widens to fit 7-digit counts
  (previously "332,526" was clipped to "2,526").
- Fixed a registry edit that placed the VISTA entries inside the cCRE
  `flatMap`, listing VISTA twice per assembly; VISTA stays first in the
  Regulatory elements group.
- Measured (production build, headless Chromium): 4-set example + VISTA,
  CpG islands, FANTOM5, GWAS Catalog = 8 sets, 137 non-empty subsets; adding
  GWAS as the 8th set 16–18 s; no bedtools aborts.

**Known bug, not fixed here:** the Pairwise view's Jaccard can exceed 1. It
derives intersection bp from subset sizes, which has been wrong since
subsets became whole anchor-set regions (commit 78a9ab6) — visible now with
1-bp GWAS variants against large super-enhancers (values up to 213).

**Interaction changes for `design/reference.html`:** up to 8 sets and the
new set colours; UpSet "showing N largest" note and compact bar counts.


## Footer, source code link, MIT licence (2026-11-13)

- `LICENSE` (new): MIT, copyright 2026 Khan Lab. Notes that bundled
  third-party code (bedtools/Aioli via biowasm, npm dependencies) and the
  reference/example data under `frontend/public/` keep their own licences
  and terms, with `docs/provenance.md` as the record. `frontend/package.json`
  declares `"license": "MIT"`.
- Footer redesigned: the required free-access statement (wording unchanged)
  and the privacy note on the left; How to cite · Source code
  (github.com/khan-lab/intervene-secure) · MIT licence · © 2026 Khan Lab
  (khanlab.bio) on the right. Wraps into stacked lines on narrow screens.
  Links live in `src/siteLinks.ts`.
- Help page: new "Source code and licence" section.

**Interaction changes for `design/reference.html`:** footer layout and
links.


## Built-in reference sets, 10× fewer bedtools runs, progress indicator (2026-11-13)

- **Faster subset engine** (`lib/pipeline.ts`). Same subsets as the CLI,
  computed with one `bedtools intersect -c` per ordered pair of sets instead
  of the CLI's per-combination `-u`/`-v` chain: n(n−1) bedtools runs instead
  of (2ⁿ−1)(n−1), i.e. 30 instead of 315 for six sets. Per-pair results are
  cached, so adding a set only compares the new one and including/excluding
  a set is instant. Tests first: unit tests in `pipeline.test.ts`, and
  `differential.test.ts` shows identical masks and identical regions against
  the CLI chain with native bedtools on the ENCODE fixtures (3 sets) and the
  hg38 example (5 sets) under 1 bp, `-f 0.50` and `-f 0.50 -r`. Measured:
  adding GWAS to the example 31.6 s → 9.8 s; a 6th set 42 s → 4.9 s
  (`docs/benchmarks.md`). Method text in `docs/methods.md`.
- **Fixed: silently wrong subsets with large sets.** bedtools' WASM heap
  only grows across calls in one worker; a 6-set run including a ~330k-region
  set exhausted it, aborted calls returned empty output, and the plot showed
  partial results with no error. Now: fresh worker per computation
  (`bedtools.reset()`), intermediate files freed (`bedtools.unmount()`), and
  every `-c` output must have exactly one line per input region or it is
  retried on a fresh worker, then reported as an error.
- **Progress indicator** (`components/ComputeStatus.tsx`): the plot card
  dims and shows a spinner, the current step ("Downloading GWAS Catalog",
  "Sorting …", "Comparing MCF7 with GWAS Catalog") and a progress bar with
  "n of N bedtools steps"; the rail status line mirrors it.
- **Built-in reference sets**, grouped by category in the rail with a
  source link and an Added/disabled state: CpG islands (hg38, hg19, mm10,
  mm9); ENCODE V4 cCREs — promoter-like, proximal enhancer-like, CTCF-bound
  (hg38, mm10; distal enhancer-like left out at 1.47M regions); FANTOM5
  enhancers (all four); ClinVar pathogenic/likely pathogenic, ≥1 star (hg38,
  hg19); GWAS Catalog genome-wide-significant variants (hg38). Each has a
  distinct 3-letter code and short plot name. Built from official downloads
  by `build_external_annotations.py`; sources, licences, filters and
  checksums in `docs/provenance.md`. `externalAnnotations.test.ts` keeps the
  registry and the vendored files one-to-one and checks each file parses
  cleanly, fits its assembly and matches its stated count. Registry supports
  placeholder entries (listed, not addable); none are in use.
- Help page: reference data and citations, the faster method, and expected
  times for large sets.

**Interaction changes for `design/reference.html`:** progress overlay on the
plot card (dimmed plot, spinner, step label, progress bar); External
annotations grouped by category with source links, "Added" state and
"Coming soon" placeholders.


## Browser-only essentials: input checks, keyboard access, help and citation (2026-11-13)

Work on `main` (the static, browser-only app deployed to GitHub Pages).

- **`lib/inputValidation.ts`** (new, tests first in `inputValidation.test.ts`,
  17 tests on the real ENCODE fixtures and vendored chrom.sizes). Every
  upload is checked and replaced with cleaned BED text before anything
  reads it. Malformed lines are skipped and reported with line numbers;
  space-separated lines become tab-separated; `.gz` files are decompressed
  in the browser (`DecompressionStream`, no new dependency); files over
  100 MB or 2,000,000 regions are rejected with a message pointing to the
  CLI. Null-model row added to `docs/methods.md`.
- **Fixed: VCF input produced zero regions.** `bedtools sort` passes VCF
  lines through unchanged, and `lib/pipeline.ts` then read the ID column as
  the end coordinate, so every record was silently dropped. VCF is now
  converted to BED4 on load using bedtools' own interval convention (checked
  against native bedtools on SNV, deletion and `<DEL>` records).
- **Assembly check.** Chromosome names and maximum coordinates are compared
  with the selected assembly's chrom.sizes (all four fetched once, a few KB
  each). Set cards warn about unknown chromosomes, Ensembl-style names and
  coordinates past a chromosome end. When every set fits one other
  assembly, the rail offers a one-click switch. Previously a wrong assembly
  silently produced wrong Fisher/Reldist p-values.
- Files beyond the 6-set cap were silently dropped; they are now listed in a
  dismissible notice, together with any rejected files.
- **Keyboard access.** UpSet bars, Venn counts and table rows are focusable
  (`role="button"` / `tabIndex`), toggle with Enter or Space, and expose
  `aria-pressed`/`aria-selected` and a text label with the counts. Focus is
  drawn on the mark itself, since SVG outlines are unreliable. Set names
  (rename), drop zone and icon buttons got keyboard handling or
  `aria-label`s.
- **Help page** (`components/HelpPage.tsx`, `#view=help`): quick-start
  tutorial, input formats and limits, assembly check, how intersections are
  computed, views, keyboard use, privacy, reference data, and a citation
  block (Intervene, BMC Bioinformatics 2017; BEDTools, Bioinformatics 2010)
  with copy-citation and copy-BibTeX buttons. Reached from new Help / Cite
  buttons in the header and a "How to cite" footer link.
- Removed stale text: the right panel's "Enrichment modules … land here in
  Phase 4" (that work lives on `dev`), the "Load example data from dbSUPER"
  label and the store comment describing the old mm9 example set.
- Verified in a headless browser against the production build: example
  load, keyboard selection, uploads of plain/gzip/Ensembl-named/VCF/broken
  files, the hg19 mismatch warning and switch, help deep link, no console
  errors.

**Interaction changes for `design/reference.html`:** header Help/Cite
buttons and help page; set-card warning lines; rejected-file notice under
the drop zone; "switch assembly" prompt under the assembly picker; keyboard
focus/selection on UpSet bars, Venn counts and table rows.

## Fix: don't merge a set's own overlapping regions (2026-07-29)

Caught after the previous entry: `lib/pipeline.ts` and `lib/intervals.ts`
ran `bedtools merge` (WASM path) / a merge sweep (TS fallback) on each
uploaded set before computing combinations — collapsing a set's own
overlapping/book-ended regions into one. Re-checking
`asntech/intervene/modules/upset/upset.py::genomic_upset()` directly:
it loads every input as `BedTool(input_files[i])` completely raw — no
`.sort()`, no `.merge()`. Merging was never part of the original tool;
we added it. Fixed to take regions as given, sorting only (sorting is
harmless and matches bedtools' own recommended practice for `intersect`
performance, but isn't required for correctness and isn't in the CLI
either — kept for `bedtools sort`'s speed benefit, not semantics).

- `lib/pipeline.ts`: `sortAndMergeOne` → `sortOne`, drops the
  `bedtools merge` call. `PipelineSetResult.mergedPath` → `sortedPath`.
- `lib/intervals.ts`: `mergeIntervals` removed, replaced with
  `sortIntervals` (ordering only). `computeSubsets`'s overlap check
  (`overlapsAny`) was rewritten — the old binary search assumed
  pre-merged, non-overlapping input per chromosome, which no longer
  holds. Replaced with a sort + prefix-max-end index
  (`buildChromOverlapIndex`), which correctly answers "does this region
  overlap anything in this set" even when the set's own regions overlap
  each other.
- `state/store.ts`: both call sites updated to `sortIntervals`.
- Real-data verification (heart/lung/liver ENCODE fixtures) shows
  *identical* UpSet counts before and after this fix — expected, per
  `docs/benchmarks.md`'s existing note that these particular fixture
  files have no internal overlaps to begin with (ENCODE peak calls are
  already non-overlapping upstream), so merging was a no-op on them. The
  actual behavioral difference is covered by a new
  `lib/intervals.test.ts` case with two deliberately-overlapping regions
  in one set, showing each is now evaluated independently against other
  sets rather than being pre-merged into one.
- `differential.test.ts` updated to match: native ground truth now sorts
  only (no `bedtools merge` step) before running the pairwise-chain
  algorithm, so it accurately reflects what the real pipeline does.

## Branch split + real bedtools arguments (2026-07-28)

This repo now has two branches: `main` (this one) carries classical
Intervene-style overlap computation + plotting only, no server/statistics
work. `dev` (renamed from the old `main`) keeps that plus the background
null-model engine and picks up the enrichment modules (GREAT, motif,
UniBind, ReMap) planned next. Pure branch split via `git branch -m` +
`git checkout -b <commit>`, no rebase/reset — both branches share the same
Phase 1/2 history.

Alongside the split: `design/reference.html`'s "Minimum overlap" dropdown
(1 bp / 50% of region / reciprocal 50%) was stubbed but never wired to an
actual bedtools call. Making it real turned up a bigger finding: the
actual `asntech/intervene` CLI (same author, same tool this app is modeled
on) doesn't use `bedtools multiinter` for genomic UpSet/Venn computation —
which is what `lib/pipeline.ts` did. Its own `genomic_upset()` builds a
truth-table over all `2^N-1` non-empty set combinations and chains
pairwise `bedtools intersect -u` (must overlap, for every included set)
/ `-v` (must not overlap, for every excluded set), with
`--bedtools-options` (`-f`/`-r`/`-F`/...) passed straight through to every
pairwise call. `multiinter` has no such fraction-overlap concept at all —
this is why "minimum overlap" was hard to reconcile with it: the CLI never
used it for this.

- **`frontend/src/lib/pipeline.ts`**: subset engine replaced —
  `bedtools multiinter` → the CLI's own truth-table + pairwise
  `intersect -u/-v` chain (`generateTruthTable`, pure and unit-tested in
  `pipeline.test.ts`; the bedtools chaining itself validated against real
  native bedtools in `differential.test.ts`). This makes the web tool and
  CLI agree on the *algorithm*, not just the binary.
- **`frontend/src/lib/bedtoolsOptions.ts`** (new): mirrors
  `intervene/helpers.py::map_bedtools_options()` — parses a
  comma-separated `key=value` string into bedtools flags, plus the three
  UI presets (`1bp` → no flags, `fraction50` → `-f 0.50`,
  `reciprocal50` → `-f 0.50 -r`). Unit-tested in `bedtoolsOptions.test.ts`.
- **`frontend/src/lib/intervals.ts`**: the pure-TS fallback's
  `computeSubsets` rewritten to the same anchor-set truth-table algorithm
  (binary-search overlap check instead of bedtools calls), so the WASM
  primary path and the no-WASM fallback agree at the 1bp default — the
  fallback still only supports 1bp (no TS equivalent of `-f`/`-r`/`-F`);
  a non-default overlap mode selected while on the fallback now shows an
  explicit warning instead of silently ignoring the setting.
- **Behavioural note** (real, not a regression to hide): subset regions
  are no longer bp-precise fragments. A combination's regions are drawn
  *unfragmented* from its lowest-indexed included set's own merged
  regions — matching the CLI exactly, but meaning e.g. one huge merged
  region spanning several smaller peaks from other sets gets excluded
  from "this set only" entirely (any overlap disqualifies the whole
  region), rather than being clipped into overlapping/non-overlapping
  pieces the old `multiinter`-based partition would have produced. See
  `lib/intervals.test.ts`'s "excludes an anchor region entirely..." test
  for a worked example.
- **UI**: `SetRail.tsx` gained a Parameters section — the Minimum overlap
  dropdown, and an Advanced bedtools options text field (same
  `key=value,key=value` syntax as the CLI's `--bedtools-options`;
  overrides the dropdown when non-empty, committed on blur/Enter rather
  than per keystroke to avoid a bedtools recompute on every character).
- **`docs/benchmarks.md`**: call count for the pairwise-chain algorithm is
  exactly `(2^n-1) * (n-1)` for `n` sets (verified against measurements at
  n=2/n=3 on the real ENCODE fixtures); n=4-6 wall time left unmeasured
  since the repo only has 3 real, distinct fixture sets and CLAUDE.md
  forbids synthetic ones to fill the gap.
- Verified end-to-end in a real browser (Playwright + headless Chromium):
  loading the heart/lung/liver example and switching Minimum overlap
  produces directionally-correct, sensible changes — e.g. reciprocal 50%
  makes single-set "only" masks *more* inclusive (1,955→1,976: a pure
  `-v`-chain mask gets easier to satisfy at a stricter threshold) while
  shrinking pairwise masks (30→15: dominated by the stricter `-u` step)
  and eliminating the triple-overlap mask entirely (a pure `-u` chain, so
  strictly monotonic) — no console errors.

## Phase 2 polish — proportional Venn, 4-set support, exports (2026-07-28)

- `frontend/src/lib/venn.ts` (new): pure geometry module, independently
  unit-tested in `venn.test.ts` (14/14 passing) before any UI wiring, per
  the "test before implementation" rule. 2- and 3-set Venn diagrams are
  now area-proportional — circle radius is proportional to set size, and
  circle center distance is solved numerically (bisection on the standard
  circle-lens-intersection-area formula) so pairwise overlap area matches
  the real region count. The 3-set triple-overlap area is a triangulated
  approximation (no general exact solution exists for arbitrary 3-circle
  sizes), which is documented in code and in the UI hint. 4-set Venn is
  now supported (previously capped at 3) via a fixed, numerically-verified
  4-ellipse arrangement — all 15 non-empty region combinations are proven
  present by grid-sampling in the test suite; the UI explicitly labels
  this layout as schematic/non-proportional, since no 4-convex-shape
  arrangement can be exactly proportional for every combination. 5–6 sets
  still show the "not available" placeholder.
- `frontend/src/lib/exportImage.ts` (new): shared SVG-to-file and
  SVG-to-PNG (2× scale, white background) export helpers, using the same
  Blob + temporary-anchor download pattern as the existing subset zip
  export.
- `UpSetPlot.tsx` and `PairwiseHeatmap.tsx` rewritten from HTML/CSS
  (styled divs / a table) to pure SVG so they share the same export path
  as the Venn view. Each of the three intersection views (UpSet, Venn,
  Pairwise) now has "SVG" / "PNG" export buttons; verified in-browser
  that all six buttons produce correctly sized, non-blank files.
- Added per-subset `.bed` download (`exportSubsetBed` in `store.ts`, next
  to the existing multi-subset zip export) with a download button in the
  Table view, the subset-selection chips, and the selected-subset detail
  cards — verified to produce well-formed, correctly named single BED
  files.
- Fixed a label-placement bug found during manual verification: Venn
  set-code labels (e.g. "LIV") were placed at a fixed `cy - r` offset,
  which landed on top of overlap-count labels when circles were similarly
  sized with small overlaps. Labels are now pushed outward along the
  vector from the diagram's centroid through each shape's center.

## Phase 2 — subsets and views (2026-07-28)

- `frontend/src/lib/intervals.ts`: pure-TypeScript BED parser, interval
  merge, and coordinate-sweep subset (bitmask) computation — the fallback
  used when WASM init fails, and the differential-test oracle target.
- `frontend/src/lib/pipeline.ts`: primary subset computation path, chaining
  real WASM `bedtools sort` → `merge` → `multiinter -names` per included
  set; `parseMultiinterOutput` is a pure function so it (and the sweep
  fallback) can be unit- and differential-tested under Node.
- `frontend/src/lib/differential.test.ts`: validates both the pure-TS sweep
  and the multiinter parser against real native bedtools (brew-installed,
  test-only) on the real ENCODE fixtures from Phase 1 — 8/8 tests passing.
  If they ever disagree, bedtools' output is ground truth.
- `frontend/src/state/store.ts`: zustand store wiring file loading,
  WASM-primary/TS-fallback subset computation, selection, view state, and
  per-subset BED zip export (via `jszip`, MIT-licensed — see
  `docs/provenance.md`) together.
- New UI: `SetRail`, `UpSetPlot`, `SubsetChips`, `PairwiseHeatmap` (bp-based
  Jaccard derived from the same subset partition, no extra bedtools call),
  `SubsetTable`, `VennPlot` (schematic 2–3 set layouts; 4–6 sets show an
  explicit "not available" placeholder rather than a misleading diagram —
  deferred to Phase 5 polish), assembled into a 3-column workspace in
  `App.tsx` with `#view=...&sel=...` URL hash sync (view + selection only;
  files are never uploaded or persisted, by design).
- Verified in-browser end to end: loading the three real example BED files
  produces a correct UpSet plot (7 subsets, counts cross-checked against
  the Table/Venn/Pairwise views), zero network requests after page load
  (aside from same-origin static assets), and the exported zip contains a
  valid, sorted, tab-separated per-subset BED file.
- Fixed a zustand+React infinite-render bug: filtering `sets` inside a
  store selector (`useStore((s) => s.sets.filter(...))`) returns a new
  array reference every call, which `useSyncExternalStore` treats as a
  perpetual change. Selectors now return the raw array; filtering happens
  in the component body instead.

Not yet done (tracked for later phases): background engine (shuffle/GC/
mappability/matching), enrichment modules, backend/API, Docker Compose.
Phase 2's done-when criteria (three BED files → correct UpSet plot with no
network request after load, export zip loads as valid BED) are met.

## Phase 1 — bedtools in the browser (2026-07-28)

- Vendored bedtools 2.31.0 + Aioli 3.2.3 (biowasm CDN v3) into
  `frontend/public/wasm/`; provenance and checksums in `docs/provenance.md`.
- `frontend/src/lib/bedtools.ts`: Aioli wrapper (init/mount/exec/teardown).
  Two integration gotchas fixed and documented: Aioli's Worker needs
  absolute (not root-relative) asset URLs, and mounted files land at
  `/shared/data/<name>`, not `/`.
- `frontend/src/App.tsx`: drop-zone UI that mounts a dropped BED/narrowPeak
  file, runs real `bedtools sort` → `bedtools merge`, and reports region
  counts, wall time, and JS heap in use.
- Ported design tokens from `design/reference.html` into
  `frontend/src/styles/tokens.css`.
- Added real, subsampled ENCODE H3K27ac (heart/lung/liver, GRCh38) fixtures
  under `tests/fixtures/encode/`, with provenance and ENCODE's data-use
  policy recorded in `tests/fixtures/encode/PROVENANCE.md`.
- `docs/benchmarks.md`: measured wall time / JS heap at ~2k / ~10k / ~100k
  real regions. No 1M/5M row — real ENCODE peak calls don't reach that
  scale, and CLAUDE.md forbids synthetic fixtures, so the "where the
  browser stops coping" threshold above ~100k regions is explicitly left
  unmeasured rather than guessed.

Not yet done (tracked for later phases): server-side bedtools escape hatch,
`lib/intervals.ts` TS fallback/oracle, subset computation, backend/API,
Docker Compose. Phase 1's done-when criteria (drop a BED file, see accurate
counts, real benchmark measurement) are met for the frontend path.
