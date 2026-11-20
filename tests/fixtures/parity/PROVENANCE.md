# Parity fixtures: what the web app downloads

These are the tables the Achi web app wrote, in a browser, for one example
analysis. The command-line tool must write the same bytes for the same
analysis (packages/cli/src/cli.test.ts), which shows that the web app
(bedtools compiled to WebAssembly) and the CLI (native bedtools) give the
same results through the same core code.

How they were made (2026-11-19):

- App: the web app at commit e957170 (mcp-cli branch, phase 0: the analysis
  code is unchanged from main at 4040b4f), served by Vite, driven by
  headless Chromium (Playwright). Downloads saved as they came.
- Inputs: "Load example data": public/examples/hg38_ses/MCF7.bed,
  GM12878.bed, K562.bed, HepG2.bed (ENCODE super-enhancers, hg38; see
  public/examples/). Assembly hg38, overlap 1 bp, no blacklist filter.
- Selected groups, in order: K562 (all), HepG2 only, K562 only
  (address #sel=-4,8,4).
- web_reference_sets.tsv: "Enrichment of selected subsets" with the
  length adjustment on (default), every bundled hg38 reference set.
- web_go_BP_greatlike_genome.tsv.gz: GO enrichment, GREAT-like against the
  genome, biological process, default settings ("Download all terms for
  every subset as one TSV").
- web_motifs_jaspar.tsv.gz: motif enrichment, JASPAR 2026 CORE vertebrates
  non-redundant, window ±500 bp, p < 1e-4, sequence from UCSC's hg38.2bit
  read locally (https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.2bit).
  The CLI test for this one runs only when ACHI_TEST_HG38_2BIT names that
  file.

gzip -9 -n; the tests compare the decompressed bytes.

## Pairwise statistics, summary and annotation (added later the same day)

The web app shows these as charts and has no table download for them, so
these tables were made in the app's page instead: the same example analysis
and selection loaded in the app (mcp-cli branch, after phase 5, with the
bedtools wrapper fix below), then, in the page, the core calls its views
make with the app's own runtime (bedtools in WebAssembly), written with
@achi/core's table writers:

- web_summary.tsv: runSetSummary on the three selected groups, as the
  "Summary of selected subsets and sets" card (summaryTsv).
- web_annotation.tsv, web_distance_to_tss.tsv: runRegionAnnotation on the
  same groups, as the "Region annotation of selected subsets and sets" card
  (annotationTsv, distanceToTssTsv).
- web_pairwise_{jaccard,fisher,reldist}.tsv, web_pairwise_reldist_bins.tsv:
  runPairwise on the four input sets, as the Pairwise view (pairwiseTsv,
  reldistBinsTsv).

Making these found two cases where the WebAssembly bedtools gave different
output from native bedtools because one instance runs every command, and
some commands leave state behind: a second `bedtools closest -D b` skipped
overlapping TSSs (wrong distance-to-TSS chart), and `bedtools summary` left
the print precision at 9 digits (Jaccard printed as 0.053218491 instead of
0.0532185). src/lib/bedtools.ts now runs such commands in a fresh instance;
with that, all seven tables are byte-identical to the CLI's.

## Permutation test (added 2026-11-20)

- web_pairwise_permutation.tsv: the Pairwise view's Permutation tab, Run
  with the default settings (1,000 permutations, seed 1, same chromosome,
  ENCODE blacklist excluded), on the four example sets (overlap 1 bp, no
  blacklist filter), downloaded from Export analysis
  (tables/pairwise_permutation.tsv) in headless Chromium, mcp-cli branch
  working tree after 2a7e49e. The shuffles come from core's seeded
  generator (packages/core/src/permutation.ts), so the CLI must write the
  same bytes.

## Expression (added 2026-11-20)

- web_expression_{beta,nearest}.tsv, web_expression_targets.tsv.gz: the
  Expression panel with "Use example table"
  (public/examples/expression/HepG2_vs_K562.deseq2.tsv, ENCODE HepG2 vs
  K562 by DESeq2; see its provenance.json) and default settings (adjusted
  p < 0.05, |log2FC| ≥ 1, 100 kb), on the same three selected groups,
  downloaded from Export analysis in headless Chromium, mcp-cli working
  tree. Compared as the reference-set and GO tables are (same rows and
  text, decimals to 1e-9), since the KS and Mann–Whitney p-values go
  through exp/log.
