# Intervene web server — implementation brief for Claude Code

## 1. What we are building

A free, no-login web server that takes 2–6 sets of genomic regions (BED / narrowPeak / VCF), computes every combinatorial intersection subset, and runs functional characterisation **on user-selected subsets**, presenting results as a comparison across subsets rather than one report per set.

The scientific claim of the tool — and the thing to protect in every design decision — is this: **the unit of analysis is the intersection subset**, and enrichment is computed against a background that is aware of how that subset was selected. Existing servers (GREAT, LOLAweb, ChIP-Atlas, Enrichr) take one flat region set. We take a combinatorially-defined one and compare several side by side.

Non-goals for v1: user accounts, persistent projects, multi-species beyond the reference bundle in §6, differential analysis between conditions.

---

## 2. Stack decisions — confirm these with me before writing code

**Decision A — where interval arithmetic runs. All of it runs in the browser.**

bedtools 2.31.0 is available as WebAssembly from the biowasm v3 CDN, driven by Aioli, which runs tools in a WebWorker over a shared PROXYFS filesystem and mounts local files through WORKERFS without reading them into memory. So:

- **All interval arithmetic is client-side, using real bedtools.** Validation, `sort`, `merge`, `multiinter`, `intersect`, `jaccard`, `shuffle`, and per-subset BED extraction all run in the user's browser. Not a reimplementation — the same binary as command-line Intervene, which means the web server and the CLI agree by construction. Say this in the docs and in the paper.
- **User region sets are never uploaded.** Only derived, user-approved artefacts go to the server, and only when an enrichment module needs reference data too large to ship to a browser. Surface this in the UI ("your files stay on this machine") and state it on the help page — it is a genuine differentiator for anyone working with patient-derived regions.
- **Self-host the wasm assets.** Pin `bedtools/2.31.0` and vendor `bedtools.js`, `bedtools.wasm`, `bedtools.data`, and `aioli.js` into `frontend/public/wasm/`, then set `urlPrefix` to point there. We have to promise NAR five years of availability and we cannot promise that on someone else's CDN. Record the upstream URL and checksum in `docs/provenance.md`.
- **The TypeScript sweep in `design/reference.html` becomes a fallback, not the primary path.** Port it to `src/lib/intervals.ts` anyway and keep it for browsers where WASM init fails, and as the oracle in a differential test against bedtools on every fixture. If they disagree, bedtools wins and the test tells us the fallback is broken.

**Known limits to measure in Phase 1, not assume.** WASM is single-threaded and roughly 1.5–3× slower than native, and wasm32 caps the heap at 4 GB — bedtools loads intervals into memory even though WORKERFS doesn't load the file. Benchmark real peak files at 10k / 100k / 1M / 5M regions, record wall time and peak heap in `docs/benchmarks.md`, and pick a threshold above which the UI warns the user and offers the server path. Build the server-side bedtools route as an escape hatch from the start, but expect it to be rarely used.

**Decision B — services.**
- Frontend: Vite + React 18 + TypeScript. D3 for plots (no chart library — the UpSet and dot matrix are custom). No CSS framework; port the CSS custom properties from `design/reference.html` verbatim into `src/styles/tokens.css`.
- Backend: Python 3.11 + FastAPI. Jobs via RQ + Redis. `pybedtools` for interval work, plus direct `subprocess` calls to `bedtools` where pybedtools is slower.
- Storage: filesystem per session under `DATA_DIR/sessions/{session_id}/`, TTL 30 days, swept by a cron job. SQLite for job metadata. No user table.
- Everything runs under Docker Compose: `web`, `api`, `worker`, `redis`. One `make dev`, one `make refdata`.

**Decision C — what "FIMO" means here.** FIMO is a *scanner*, not an enrichment method: it reports motif occurrences with no null model. Motif *enrichment* needs foreground vs control. Implement the default motif module as our own PWM scan (JASPAR 2024 CORE, CC-BY) plus Fisher's exact test against the matched background from §5. Expose MEME Suite `sea` as an optional alternate engine behind a config flag, and record in the docs that MEME's licence is non-commercial — we cannot make it the default and satisfy "free and open to all users."

Flag any of A–C you disagree with before starting.

---

## 3. Repository layout

```
intervene/
  PLAN.md                 this file
  CLAUDE.md               working agreements (see §10)
  docker-compose.yml
  Makefile                dev, test, refdata, lint
  design/reference.html   UI source of truth — read, do not import
  frontend/
    public/wasm/          vendored aioli.js + bedtools 2.31.0 assets
    src/
      styles/tokens.css   ported CSS variables, light + dark
      lib/bedtools.ts     Aioli wrapper: init, mount, exec, teardown
      lib/pipeline.ts     subset computation as a bedtools command chain
      lib/intervals.ts    pure-TS fallback + differential-test oracle
      lib/api.ts          typed API client
      components/         SetRail, UpSetPlot, VennPlot, PairwiseHeatmap,
                          SubsetChips, ModulePicker, EnrichmentMatrix,
                          JobTray, DetailPanel
      state/store.ts      zustand
  backend/
    app/
      main.py             FastAPI
      routes/             upload, subsets, enrich, jobs, export
      core/
        bed.py            validation, normalisation, merge
        subsets.py        bedtools multiinter -> subsets
        background.py     §5
        stats.py          Fisher, binomial, BH, permutation
      modules/
        base.py           EnrichmentModule ABC
        great.py  motif.py  unibind.py  remap.py
      schemas.py          pydantic models mirrored in frontend types
    tests/
  refdata/                downloaded, gitignored
    Makefile              fetch + index every reference file
```

---

## 4. Core data contracts

Define once in `backend/app/schemas.py`, generate TypeScript with `datamodel-code-generator` or hand-mirror in `frontend/src/types.ts`. Every module returns the same record shape — this is what lets the matrix render four different tools in one grid.

```python
class RegionSet(BaseModel):
    id: str; name: str; code: str        # code = 3-char label used in plots
    color: str
    n_regions: int; n_bp: int
    assembly: str
    included: bool

class Subset(BaseModel):
    id: str                              # stable hash of mask + set ids
    mask: int                            # bitmask over included sets
    members: list[str]                   # RegionSet ids
    label: str                           # "Heart ∩ Lung"
    degree: int
    n_regions: int; n_bp: int
    median_length: int; gc_mean: float   # needed for background matching

class EnrichmentRecord(BaseModel):
    subset_id: str
    module: Literal["great","motif","unibind","remap"]
    term_id: str                         # GO:0007507 | MA0482.2 | TF+cell id
    term_label: str
    fold_enrichment: float
    p_value: float
    q_value: float
    n_fg_hit: int; n_fg_total: int
    n_bg_hit: int; n_bg_total: int
    background: BackgroundSpec           # echoed back, never implicit
    extra: dict = {}                     # module-specific fields
```

`background` is part of every record deliberately. A fold enrichment with no stated null is not a result, and reviewers will ask.

---

## 5. Background models — build this before any module

Split across `frontend/src/lib/background.ts` and `backend/app/core/background.py`. The shuffle step runs in the browser — `chrom.sizes` is a few kilobytes and the ENCODE blacklist about a megabyte, so `bedtools shuffle -incl -excl -noOverlapping -seed` is entirely browser-viable and keeps the user's regions local. GC content and mappability are not: they need the genome FASTA and a mappability bigWig, so those covariates are computed server-side on the *candidate coordinates only*, which are shuffled decoys rather than user data. Document that boundary precisely in `docs/privacy.md`.

Three modes, selectable per run, echoed into every record.

1. **`union`** — background is the union of all included input sets minus the foreground subset. Cheap, honest about "what distinguishes this subset from the rest of the experiment," and the sensible default for GO.
2. **`matched`** — the important one. Sample background regions matched to the foreground on length, GC, and mappability:
   - Candidate pool = `bedtools shuffle` of the foreground over the assembly, `-incl` mappable regions, `-excl` ENCODE blacklist + assembly gaps, `-noOverlapping`, `-seed` recorded in the job record for reproducibility.
   - Compute GC with `bedtools nuc`, mappability from the Umap/Bismap bigWig via `bigWigAverageOverBed`.
   - Bin candidates on (length decile × GC decile × mappability tercile); draw `k × n_fg` matched regions (default k = 10) by stratified sampling from the same bins as the foreground.
   - Return the matched set plus a QC payload: foreground vs background distributions for all three covariates. **Render this QC in the UI** — a small three-panel density comparison in the detail panel. It is the visible evidence that the null is doing its job.
3. **`genome`** — whole-genome expectation, offered only for parity with GREAT's binomial model. Mark it in the UI as not recommended for subset analysis.

Write a test asserting that under `matched`, a foreground drawn at random from the background pool yields a uniform p-value distribution across the term set. If that test fails, the statistics are wrong and no amount of UI polish saves the paper.

---

## 6. Reference data bundle

`refdata/Makefile` must fetch and index everything, print sizes, verify checksums, and be re-runnable. Per assembly (start with hg38, then hg19, mm39, mm10):

| Item | Source | Used by |
|---|---|---|
| Genome FASTA + `.fai` | UCSC / Ensembl | sequence extraction |
| `chrom.sizes`, assembly gaps | UCSC | shuffle |
| ENCODE blacklist v2 | Boyle lab | shuffle |
| Umap/Bismap k36 multi-read mappability | Hoffman lab | matching |
| GENCODE basic — canonical TSS | GENCODE | GREAT domains |
| GO OBO + GOA gene associations | Gene Ontology | GREAT terms |
| JASPAR 2024 CORE vertebrates PFMs | JASPAR | motif module |
| UniBind robust TFBS collection | UniBind | TFBS module |
| ReMap 2022 non-redundant peaks | ReMap | ChIP peak module |

Convert UniBind and ReMap collections to **bgzipped + tabix-indexed** per-dataset BEDs at build time, with a manifest JSON (`dataset_id, tf, cell_type, biotype, n_peaks, path`). Querying 1000+ raw BEDs per request will not meet the response-time target.

---

## 7. Enrichment modules

`modules/base.py` defines:

```python
class EnrichmentModule(ABC):
    id: str; label: str; source: str; requires_sequence: bool
    def supported_assemblies(self) -> list[str]: ...
    def run(self, fg: Path, bg: BackgroundResult, ctx: RunContext) -> list[EnrichmentRecord]: ...
```

Each module runs in its own RQ job so one failure never blocks the matrix. Return partial results with a per-module error string rather than failing the whole run.

**`great.py` — GO enrichment.** Reimplement the published GREAT regulatory-domain rules locally rather than calling `great.stanford.edu`; the web service has usage terms and rate limits we cannot build a public server on, and a local implementation is testable. Basal domain = 5 kb upstream / 1 kb downstream of canonical TSS, extended to the nearest neighbouring basal domain up to 1 Mb. Assign regions to genes by domain overlap, then binomial test on genome fraction *and* hypergeometric test on gene counts; report both, order by the more conservative. Validate against `rGREAT` local mode on three fixture sets and assert rank correlation > 0.95 — put that comparison in the docs, reviewers will want it. we can use pyGREAT https://github.com/khan-lab/pyGREAT for this

**`motif.py` — motif enrichment.** `bedtools getfasta` on foreground and matched background → PWM scan with MOODS (or a vectorised numpy scan) using JASPAR 2024 CORE at p < 1e-4 → per-motif Fisher's exact on sequences-with-hit → BH. Report fold, q, and the hit fraction in both sets. Cache scans by (subset hash, motif version, background seed).

**`unibind.py` — TFBS enrichment.** `bedtools intersect -u` foreground against each tabix-indexed UniBind dataset, same against background, Fisher per dataset, BH across datasets. Group results by TF in the UI so 400 cell-type-specific datasets collapse to a readable row per TF with a drill-down.

**`remap.py` — ChIP peak enrichment.** Same shape as UniBind against ReMap 2022 non-redundant. Offer a permutation null as an alternative to Fisher (n = 1000 shuffles, `-incl`/`-excl` as in §5) since ReMap peak density is strongly non-uniform; report empirical p when permutation is chosen.

---

## 8. API surface

Region sets are not uploaded. Sets and subsets live in the browser; the client posts a **single named subset's coordinates** only when the user runs a module that needs server-side reference data, and the UI says so before the first such request.

```
POST   /api/session                          -> {session_id}
POST   /api/session/{sid}/enrich             {subset_bed, subset_meta, modules[],
                                              background_spec, shuffled_bg_bed?} -> {job_ids[]}
GET    /api/jobs/{job_id}                    -> {state, progress, error}
GET    /api/jobs/stream?ids=...              SSE
GET    /api/session/{sid}/results            ?subset_ids=&modules= -> EnrichmentRecord[]
GET    /api/session/{sid}/export/subsets.zip BED per subset + README
GET    /api/session/{sid}/export/results.tsv
GET    /r/{session_id}                       shareable read-only results URL
```

`/r/{session_id}` matters for the NAR submission — reviewers must be able to bookmark a result and return to it. No login, so the session id must be a 128-bit unguessable token, and the page must state the 30-day expiry.

**Validation and safety.** Reject files over 100 MB or 2M regions with a clear message. Validate chromosome names against `chrom.sizes` and report unmatched contigs as a warning, not a silent drop — the single most common user error is an hg19 file on an hg38 assembly, so detect it heuristically (chromosome length overflow) and say so. Never interpolate user-supplied strings into a shell; use `subprocess` arg lists. Strip and regenerate all filenames.

---

## 9. Frontend

Port the three-column workspace exactly as in `design/reference.html`: rail (sets + parameters), centre (plot + selection + module picker), right (comparison matrix). Rules to preserve:

- Set identity = colour + 3-letter code, carried through set card, UpSet bar, membership dot, chip, and matrix column header. Never re-order or re-colour on re-render.
- Bar click selects; shift-click range-selects; selection state lives in one store and drives everything downstream.
- Enrichment results render as one matrix per module, terms as rows, **selected subsets as columns**. Dot area = fold enrichment, colour = −log10 q. Click a dot for the detail panel: counts, background spec, covariate QC, links out to the source database.
- Every number is set in JetBrains Mono. Headings and labels in Inter Tight, sentence case.
- Views: UpSet (3+ sets), Venn (2–6 sets, area-proportional up to 3, schematic above), pairwise Jaccard heatmap, and a table view. Venn must use the same subset objects as the UpSet — one computation, four renderings.
- Client preview state must be visually distinguishable from server-confirmed state (a subtle "preview" tag on the plot header that clears when the server result lands).
- Accessibility floor: keyboard-reachable bars and dots, visible focus, `prefers-reduced-motion` respected, all colour-encoded information also available in text on hover or in the table view.
- Also required for submission: a "Load example" button (heart/lung/liver H3K27ac, real data, shipped in the repo), the free-access statement in the footer, help and tutorial pages, and a citation block.

---

## 10. Phases

Work one phase at a time. At the end of each, run the full test suite, update `CHANGELOG.md`, and commit. Do not start the next phase until I confirm.

**Phase 1 — bedtools in the browser.** Vendor the biowasm assets, wrap Aioli in `lib/bedtools.ts`, mount dropped files, run `sort | merge` and report region counts. Benchmark at 10k / 100k / 1M / 5M regions and write `docs/benchmarks.md`. *Done when:* I can drop a BED file, see accurate counts, and read a real measurement of where the browser stops coping.

**Phase 2 — subsets and views.** `multiinter`-based subset computation as a command chain in `lib/pipeline.ts`, differential test against the TS fallback and against native bedtools on the same fixtures, per-subset BED extraction and zip export, UpSet + Venn + pairwise Jaccard all driven from one subset computation, shareable session URL. *Done when:* three BED files produce a correct UpSet plot with no network request after page load, and the export zip loads in IGV.

**Phase 3 — background engine.** Browser-side `shuffle` with blacklist and gaps, server-side GC and mappability on shuffled candidates, stratified matching, the uniform-p-value calibration test from §5, QC rendering in the detail panel. *Done when:* the calibration test passes and the QC panel shows matched distributions.

**Phase 4 — modules.** GREAT first (using pyGREAT), then motif, UniBind, ReMap. Job queue, SSE progress, job tray, partial-failure handling. *Done when:* four modules run on three selected subsets and populate one matrix.

**Phase 5 — comparison matrix and polish.** Matrix rendering, detail panel, TSV/SVG export, example data, help and tutorial content, error and empty states, mobile fallback (read-only results view is enough).

**Phase 6 — hardening.** Load test with 6 sets × 500k regions, response-time budget (subset computation under 10 s, each module under 60 s), rate limiting, session sweeper, uptime monitoring, and a `docs/deployment.md` covering the 5-year maintenance commitment we have to make in the paper.
