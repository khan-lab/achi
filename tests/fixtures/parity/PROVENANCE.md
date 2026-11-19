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
