<p align="left">
  <img src="public/achi-logo.svg" alt="Achi logo" width="260">
</p>

> ### A browser-based framework for comparing, annotating and interpreting genomic intervals

[![Deploy](https://github.com/khan-lab/achi/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/khan-lab/achi/actions/workflows/deploy.yml)
[![Web app](https://img.shields.io/website?url=https%3A%2F%2Fkhan-lab.github.io%2Fachi%2F&label=web%20app&up_message=online&down_message=offline)](https://khan-lab.github.io/achi/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![bedtools 2.31 (WebAssembly)](https://img.shields.io/badge/bedtools-2.31%20%C2%B7%20WebAssembly-654ff0.svg)](https://bedtools.readthedocs.io/)
[![No data upload](https://img.shields.io/badge/data-never%20uploaded-success.svg)](#built-for-patient-and-sensitive-data)
[![Cite: BMC Bioinformatics 2017](https://img.shields.io/badge/cite-10.1186%2Fs12859--017--1708--7-informational.svg)](https://doi.org/10.1186/s12859-017-1708-7)

**Available: <https://khan-lab.github.io/achi/>**

**Achi** (pronounced “AH-chee”) is a browser-based framework for comparing, annotating and interpreting genomic intervals. It performs genomic interval intersections, annotation and enrichment analysis entirely in your browser. It supports 2–8 input files in BED, narrowPeak or VCF format and uses bedtools compiled to WebAssembly to compute intersections. Both the input sets and their intersection subsets can be annotated and tested for enrichment. All processing happens locally within your browser tab, with no files uploaded to a server, helping keep sensitive genomic data under your control.

Achi grows out of [Intervene](https://github.com/asntech/intervene) (Khan and Mathelier, 2017). It computes the same intersections as the Intervene command-line tool and adds annotation, enrichment, motif and signal analyses on top.

## Built for patient and sensitive data

- **Files are never uploaded.** The site is static files; there is no
  application server to receive them.
- **No login, no account, no server-side storage.**
- **Works offline** once the app (6 MB) and an assembly's reference data
  (33–86 MB) are cached.


## Features

**Intersection**
- UpSet plot, Venn diagram (2–4 sets), pairwise heatmap (Jaccard, Fisher,
  reldist, or a seeded permutation test of overlap against shuffled regions)
  and a subset table.
- Overlap of 1 bp, 50 %, reciprocal 50 %, or any bedtools options.
- Optional removal of ENCODE problematic regions.

**Annotation** (each input set, and any subset you select)
- Per-chromosome counts and lengths (`bedtools summary`).
- Genomic features (promoter, UTR, exon, intron, intergenic) and distance
  to the nearest TSS, from GENCODE.
- Closest genes, ready to copy or download.

**Lists of names**
- Gene lists, SNP IDs or any identifiers (one per line), intersected by
  exact match, with the same UpSet, Venn, Table, selection and exports.

**Export and restore**
- One ZIP per analysis: a generated methods paragraph with references,
  every subset, tables, results, the plots on screen, and a settings file
  (no data; file checksums) that restores the analysis.
- Links that open public files (ENCODE, a lab server, a paper's
  supplement) with settings, view and selection: the page lists the files
  and downloads nothing until you agree. "Copy link" shares an analysis of
  public files; files from your computer never go into a link.

**Enrichment** (selected subsets)
- Bundled reference sets (ENCODE cCREs, FANTOM5 and VISTA enhancers, CpG
  islands, ClinVar, GWAS Catalog): Fisher or length-stratified CMH test.
- Gene Ontology with two methods, each reimplemented to run in the browser
  with editable settings:
  - **GREAT-like:** regulatory domains; genome or input-set background;
  - **Cistrome-GO-like:** regulatory-potential ranking and XL-mHG test.
  - With several subsets selected, a terms × subsets dot plot compares
    them (colour −log10 q, size fold), with similar terms optionally
    grouped by Metascape's kappa clustering.

**Motif enrichment** (selected sets/subsets)
- JASPAR 2026 vertebrate motifs, bundled: CORE non-redundant (1,019, the
  default), every CORE version, UNVALIDATED, or CORE + UNVALIDATED; scanned in the page
  around each region's centre; each group against the other regions of the
  analysis, Cochran–Mantel–Haenszel over GC × CpG strata, BH-adjusted.
- Genome from your own FASTA or .2bit, or from UCSC as whole chromosomes
  (private, kept for later runs) or by range requests (exact, asked each
  run). Heatmap with sequence logos, one motif per TF family.

**Expression near the regions** (selected sets/subsets)
- Your differential-expression table (DESeq2, edgeR, limma), read in the
  page: BETA-like tests of whether up or down genes have higher regulatory
  potential from each group's regions, BETA's cumulative plot and ranked
  target genes, and the log2 fold changes of the regions' nearest genes
  against all other genes. Example: HepG2 vs K562 (ENCODE RNA-seq, DESeq2).

**Signal profiles** (selected sets/subsets)
- Profiles (mean ± SE) and heatmaps of any bigWig from your computer over
  and around each subset's regions: scale-regions or reference-point, sorting, k-means clusters, click a row
  to open it in the genome browser.
- Each region's mean signal per subset as box plots, with Mann–Whitney

**Genome-wide overview** of selected subsets (GenomeSpy, Genome Browser tab)
- Where each selected subset lies along the whole genome, with the input
  sets and reference sets as optional context: density per Mb and every
  region, zoomable from genome to region; follows the UpSet selection.
- Linked to the genome browser below it: click a region or Shift + drag
  within a chromosome to show it there; its locus is marked in the overview.
  Shift + drag also counts each row's regions in an interval.

**Genome browser** (igv.js)
- Input sets, selected subsets, GENCODE genes and any bundled reference set
  as tracks; go to a locus or gene, or jump from a region or gene list.
- Uses only your files and bundled data: no request leaves the page.
- Local tracks from your disk, for viewing: bigWig and bigBed of any size,
  BED, narrowPeak, bedGraph, VCF, BAM and CRAM (with the reference FASTA);
  read in the page, never uploaded.
- Optional public tracks, only after you agree: SCREEN merged signal, the
  ENCODE cCRE registry, ENCODE signal and cell-type cCREs for the example
  cell lines, phyloP conservation, JASPAR 2024 binding sites, ENCODE search
  or accession, or any bigWig/bigBed URL.

**Downloads:** subsets as BED or ZIP, gene lists, every plot as SVG/PNG,
and enrichment results as TSV.

Assemblies: hg38, hg19, mm10, mm9. Limits: 8 sets, 100 MB and 2,000,000
regions per file. 

## How intersections are computed

For each combination of sets, Achi keeps the regions of the first set
that overlap every other member (`bedtools intersect -u`) and no non-member
(`bedtools intersect -v`), the same definition as the Intervene CLI. In the browser,
each ordered pair of sets is compared once with `bedtools intersect -c`
(56 runs instead of 1,785 for eight sets), with identical results.

## Command line and AI assistants

The same analyses run outside the browser, with native bedtools, through
two companion tools built on the same code:

- **`achi`**, a command-line tool for pipelines and large files:
  `achi run a.bed b.bed c.bed --enrich --go great --out results` writes the
  same files as the web app's "Export analysis", and `--settings` reruns an
  analysis exported from the web app. See [packages/cli](packages/cli/README.md).
- **`achi-mcp`**, an MCP server that lets an AI assistant run analyses on
  files on your computer. Tool results reach the model's provider, so it
  returns summaries by default. See [packages/mcp](packages/mcp/README.md).

Both need Node.js 20.19+ and bedtools 2.31+. Build them with
`npm run build:cli` and `npm run build:mcp`.

## Running it locally

Requires [Node.js](https://nodejs.org/) 20.19+ or 22.12+.

```sh
git clone https://github.com/khan-lab/achi.git
cd achi
npm ci
npm run dev        # http://localhost:5173/achi/
```

`npm test` runs the test suite (differential tests need a native `bedtools`
2.31 on your `PATH`), `npm run lint` lints, and `npm run build` writes the
static site to `dist/`, deployable on any static host. Pushes to `main`
deploy to GitHub Pages.

## Use of AI assistance

Most of the code has been written with the assistance of AI tools, mostly Claude Code and Copilot. The initial architecture and the overall design of this platform is non-AI. The overlap output are reproduced by the published version of the Intervene CLI.

## Citation

Achi builds on Intervene. If you use Achi for your work, please cite:

> Khan A, Mathelier A. Intervene: a tool for intersection and visualization of
> multiple gene or genomic region sets. *BMC Bioinformatics*. 2017;18:287.
> [doi:10.1186/s12859-017-1708-7](https://doi.org/10.1186/s12859-017-1708-7)

Intersections are computed with BEDTools:

> Quinlan AR, Hall IM. BEDTools: a flexible suite of utilities for comparing
> genomic features. *Bioinformatics*. 2010;26(6):841–842.
> [doi:10.1093/bioinformatics/btq033](https://doi.org/10.1093/bioinformatics/btq033)

For GO enrichment, please also cite the method you ran:

> McLean CY, Bristor D, Hiller M, et al. GREAT improves functional
> interpretation of cis-regulatory regions. *Nat Biotechnol*.
> 2010;28:495–501.
> [doi:10.1038/nbt.1630](https://doi.org/10.1038/nbt.1630)

> Li S, Wan C, Zheng R, Fan J, Dong X, Meyer CA, Liu XS. Cistrome-GO: a web
> server for functional enrichment analysis of transcription factor ChIP-seq
> peaks. *Nucleic Acids Res*. 2019;47(W1):W206–W211.
> [doi:10.1093/nar/gkz332](https://doi.org/10.1093/nar/gkz332)

When similar GO terms are grouped in the comparison across subsets, please
also cite:

> Zhou Y, Zhou B, Pache L, Chang M, Khodabakhshi AH, Tanaseichuk O,
> Benner C, Chanda SK. Metascape provides a biologist-oriented resource for
> the analysis of systems-level datasets. *Nat Commun*. 2019;10:1523.
> [doi:10.1038/s41467-019-09234-6](https://doi.org/10.1038/s41467-019-09234-6)

For the pairwise permutation test, please also cite:

> Gel B, Díez-Villanueva A, Serra E, Buschbeck M, Peinado MA, Malinverni R.
> regioneR: an R/Bioconductor package for the association analysis of
> genomic regions based on permutation tests. *Bioinformatics*.
> 2016;32(2):289–291.
> [doi:10.1093/bioinformatics/btv562](https://doi.org/10.1093/bioinformatics/btv562)

> Phipson B, Smyth GK. Permutation P-values should never be zero: calculating
> exact P-values when permutations are randomly drawn. *Stat Appl Genet Mol
> Biol*. 2010;9:Article39.
> [doi:10.2202/1544-6115.1585](https://doi.org/10.2202/1544-6115.1585)

For the BETA-like expression test, please also cite:

> Wang S, Sun H, Ma J, Zang C, Wang C, Wang J, Tang Q, Meyer CA, Zhang Y,
> Liu XS. Target analysis by integration of transcriptome and ChIP-seq data
> with BETA. *Nat Protoc*. 2013;8(12):2502–2515.
> [doi:10.1038/nprot.2013.150](https://doi.org/10.1038/nprot.2013.150)

The genome-wide location view is GenomeSpy:

> Lavikka K, Oikkonen J, Li Y, et al. Deciphering cancer genomes with
> GenomeSpy: a grammar-based visualization toolkit. *GigaScience*.
> 2024;13:giae040.
> [doi:10.1093/gigascience/giae040](https://doi.org/10.1093/gigascience/giae040)

The genome browser is igv.js:

> Robinson JT, Thorvaldsdóttir H, Turner D, Mesirov JP. igv.js: an embeddable
> JavaScript implementation of the Integrative Genomics Viewer (IGV).
> *Bioinformatics*. 2023;39(1):btac830.
> [doi:10.1093/bioinformatics/btac830](https://doi.org/10.1093/bioinformatics/btac830)


> Achi is developed and maintained by the [CBCRG Lab](https://khanlab.bio).
