# achi: the command-line tool

Achi (pronounced "AH-chee") compares, annotates and interprets genomic
intervals. This is its command-line tool: the same analyses as the
[Achi web app](https://khan-lab.github.io/achi/), run on your own computer
with native bedtools, for pipelines and large files. It builds on
[Intervene](https://github.com/asntech/intervene).

## Requirements

- Node.js 20.19 or newer
- bedtools 2.31 or newer on `PATH` (`conda install -c bioconda bedtools`)

## Run an analysis

```sh
achi run heart.bed liver.bed lung.bed.gz \
  --select "Heart only" --select Liver \
  --enrich --go great --genes \
  --out results
```

`achi run` intersects 1–8 region files (BED, narrowPeak or VCF, gzipped or
not) and runs the analyses you ask for on the groups you select:

| Option | Analysis |
|---|---|
| `--pairwise jaccard,fisher,reldist` | statistics between every ordered pair of input sets (`all` for the three), as the web app's Pairwise view |
| `--summary` | regions, base pairs and region lengths of each group, per chromosome (`bedtools summary`) |
| `--annotate` | each group's regions by GENCODE category (promoter, UTR, exon, intron, downstream, distal intergenic) and their distance to the nearest TSS |
| `--genes` | the nearest protein-coding gene (by TSS) of each region |
| `--enrich` | enrichment for the bundled reference region sets (ENCODE cCREs, VISTA enhancers, CpG islands, FANTOM5, ClinVar, GWAS Catalog, fine-mapping), CMH over region-length strata (`--no-length-adjust` for Fisher's exact test) |
| `--go great` / `--go cistromego` | GO enrichment, GREAT-like (against the genome, or `--go-background inputs`) or Cistrome-GO-like; `--go-namespace BP\|MF\|CC` |
| `--motifs --genome hg38.2bit` | JASPAR 2026 motif enrichment around region centres (`--motif-window`, `--motif-p`, `--motif-collection`); the scan runs on one thread fewer than the computer has, at most 8 (`--threads`) |
| `--signal a.bw [--signal b.bw]` | bigWig signal profiles and heatmap matrices, with Mann–Whitney tests between groups |

A group (`--select`, repeatable, in order) is a set's name for the whole set
("Liver", or "Liver (all)" as the web app labels it), a subset's label
("Heart only", "Heart ∩ Liver"), `sets` (every set, the default) or
`subsets` (every non-empty subset).

Overlaps follow the Intervene command-line tool: `--overlap 1bp`
(default), `fraction50`, `reciprocal50`, or `--bedtools-options
"f=0.5,r=true"`. `--blacklist` removes regions overlapping the ENCODE
blacklist first. `--assembly` is hg38 (default), hg19, mm10 or mm9.

On a terminal, `achi run` shows one live line per stage (what it is doing,
a progress bar, time elapsed and left) and ticks each stage off when it
finishes; the summary at the end is in colour. When output goes to a file,
a pipe or a log, it prints one plain line per step instead. `-q` prints
nothing but the summary; `--no-color` (or `NO_COLOR=1`) turns colour off
and `FORCE_COLOR=1` turns it on.

## Output

The folder (`--out`, default `achi-results`) has the layout of the web
app's "Export analysis": `methods.md` (a methods paragraph with
references), `settings.json`, `tables/` (sets, subsets and each analysis),
`subsets/` (every subset as BED) and `genes/`. The pairwise, summary and
annotation tables (`tables/pairwise_*.tsv`, `summary.tsv`,
`annotation.tsv`, `distance_to_tss.tsv`) hold the numbers the web app's
charts show, which the web app itself does not offer as tables.

`achi run --settings settings.json files...` reruns an analysis exported
from the web app (assembly, overlap rule, blacklist and selection). On the
same inputs the command-line tool and the web app give the same results;
this is tested on the web app's example analysis.

## Reference data

Annotation, reference sets, GO and JASPAR data are downloaded from the Achi
site on first use, checked against the site's manifest of checksums, and
kept in `~/.cache/achi`. After that no network is needed. `achi data get
hg38` downloads an assembly in advance; `achi data info` shows where data
comes from. `--refdata-dir` reads a local copy of the site's files instead.

Your region files are never uploaded: only Achi's own reference files are
downloaded.

## Cite

Until Achi has its own paper, please cite Intervene: Khan A, Mathelier A.
Intervene: a tool for intersection and visualization of multiple gene or
genomic region sets. *BMC Bioinformatics*. 2017;18:287.
doi:10.1186/s12859-017-1708-7
