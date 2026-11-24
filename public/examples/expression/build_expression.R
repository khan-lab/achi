#!/usr/bin/env Rscript
# The example differential-expression table (Expression panel; core
# expression.ts; its tests): HepG2 vs K562 by DESeq2, from ENCODE total
# RNA-seq gene quantifications of the same lab and protocol (Lécuyer lab,
# IRCM, "Initial total fractions ... Long Total", two biological replicates
# each), GRCh38, GENCODE V29, ENCODE processing pipeline (RSEM).
#
#   K562  ENCSR885DVH  rep 1 ENCFF713BHS  rep 2 ENCFF366SYN
#   HepG2 ENCSR181ZGR  rep 1 ENCFF103FSL  rep 2 ENCFF692QVJ
#
# Counts: RSEM expected_count, rounded to integers (DESeq2 takes integer
# counts); genes with a GENCODE (ENSG) id only. Model ~ cell, contrast
# HepG2 vs K562 (positive log2FoldChange = higher in HepG2), Wald test,
# default independent filtering (alpha 0.05), no fold-change shrinkage.
# Symbols: gene_name of the gene record in the app's GENCODE v50 GTF
# (public/refdata/hg38/gencode.v50.annotation.gtf.gz), matched by the ENSG
# id without its version; empty when v50 has no such gene.
# Rows with baseMean 0 are left out; numbers to 4 significant digits.
#
# DESeq2 (LGPL >= 3) is used here only, to build this file; it is not part
# of the app.
#
# Usage (from the repo root):
#   Rscript public/examples/expression/build_expression.R <dir with the four ENCFF*.tsv> [R library]
# The four files are https://www.encodeproject.org/files/<ENCFF>/@@download/<ENCFF>.tsv;
# their md5 sums are checked against ENCODE's.

args <- commandArgs(trailingOnly = TRUE)
dir <- args[1]
if (length(args) > 1) .libPaths(c(args[2], .libPaths()))
suppressPackageStartupMessages(library(DESeq2))

files <- data.frame(
  accession = c("ENCFF713BHS", "ENCFF366SYN", "ENCFF103FSL", "ENCFF692QVJ"),
  md5 = c("072c8876b23d565f9e4c51097aa6ceaa", "59eecc0d45a9b180ff2a6c218b41be0a", "8d360229bd909521cace2c8c5737d59e", "518a6b0308ba2bca90ba032448949c90"),
  experiment = c("ENCSR885DVH", "ENCSR885DVH", "ENCSR181ZGR", "ENCSR181ZGR"),
  cell = c("K562", "K562", "HepG2", "HepG2"),
  replicate = c(1, 2, 1, 2)
)

counts <- NULL
for (i in seq_len(nrow(files))) {
  path <- file.path(dir, paste0(files$accession[i], ".tsv"))
  md5 <- unname(tools::md5sum(path))
  if (md5 != files$md5[i]) stop(sprintf("%s: md5 %s, ENCODE says %s", path, md5, files$md5[i]))
  q <- read.delim(path, stringsAsFactors = FALSE)
  q <- q[grepl("^ENSG", q$gene_id), c("gene_id", "expected_count")]
  col <- setNames(round(q$expected_count), q$gene_id)
  counts <- if (is.null(counts)) cbind(col) else cbind(counts, col[rownames(counts)])
}
colnames(counts) <- paste(files$cell, files$replicate, sep = "_")
storage.mode(counts) <- "integer"

coldata <- data.frame(cell = factor(files$cell, levels = c("K562", "HepG2")), row.names = colnames(counts))
dds <- DESeqDataSetFromMatrix(counts, coldata, design = ~cell)
dds <- DESeq(dds, quiet = TRUE)
res <- results(dds, contrast = c("cell", "HepG2", "K562"), alpha = 0.05)

# Symbols from the app's GENCODE v50 (gene records).
gtf <- file.path("public", "refdata", "hg38", "gencode.v50.annotation.gtf.gz")
genes <- grep("\tgene\t", readLines(gzfile(gtf)), value = TRUE, fixed = TRUE)
ids <- sub("\\..*", "", sub('.*gene_id "([^"]+)".*', "\\1", genes))
names <- sub('.*gene_name "([^"]+)".*', "\\1", genes)
symbol <- setNames(names, ids)

id <- sub("\\..*", "", rownames(res))
out <- data.frame(
  gene_id = id,
  gene_name = ifelse(is.na(symbol[id]), "", symbol[id]),
  baseMean = signif(res$baseMean, 4),
  log2FoldChange = signif(res$log2FoldChange, 4),
  lfcSE = signif(res$lfcSE, 4),
  pvalue = signif(res$pvalue, 4),
  padj = signif(res$padj, 4)
)
out <- out[res$baseMean > 0, ]
out <- out[order(out$padj, -abs(out$log2FoldChange), na.last = TRUE), ]
write.table(out, file.path("public", "examples", "expression", "HepG2_vs_K562.deseq2.tsv"), sep = "\t", quote = FALSE, row.names = FALSE, na = "NA")
cat(sprintf("%d genes; padj < 0.05: %d (|log2FC| >= 1: %d up in HepG2, %d down)\n", nrow(out), sum(out$padj < 0.05, na.rm = TRUE),
            sum(out$padj < 0.05 & out$log2FoldChange >= 1, na.rm = TRUE), sum(out$padj < 0.05 & out$log2FoldChange <= -1, na.rm = TRUE)))
cat("DESeq2", as.character(packageVersion("DESeq2")), "on", R.version.string, "\n")
