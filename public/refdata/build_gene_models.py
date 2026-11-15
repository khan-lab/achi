#!/usr/bin/env python3
"""
Build the gene-model track of the genome browser (src/lib/browserTracks.ts,
src/components/GenomeBrowser.tsx): one transcript per gene, as BED12, under
public/refdata/<assembly>/genes/gene_models.bed.

Source: the same vendored GENCODE GTFs as build_peak_annotation.py
(hg38 v50, hg19 v19, mm10 vM25, mm9 vM1; URLs and checksums in
docs/provenance.md). Every gene in the GTF, all biotypes, reference
chromosomes only (those in <assembly>.chrom.sizes).

One transcript per gene, by the first rule that applies:
  1. the transcript GENCODE tags "Ensembl_canonical" (the tag exists from
     GENCODE 38 / M27 on: every hg38 v50 gene has exactly one; the hg19 v19,
     mm10 vM25 and mm9 vM1 releases have none);
  2. with --canonical-from <newer GTF> (used for hg19, with hg38 v50):
     the transcript whose stable ID, without version, is Ensembl_canonical
     in that GTF (Ensembl IDs are shared across assemblies; covers 87% of
     hg19 v19 protein-coding genes). If several qualify, rule 3 among them;
  3. the first by: tagged "basic"; best APPRIS principal level
     (appris_principal_1 < _2 < ... < none); best transcript support level
     (1 < 2 < ... < none); tagged "CCDS"; longest coding sequence; longest
     spliced length; smallest transcript_id. Fields a release lacks (TSL in
     v19 and vM1, APPRIS in vM1) count as "none" for every transcript.
     On hg38 v50, where the answer is known, rule 3 alone picks the
     Ensembl_canonical transcript for 78.3% of protein-coding genes (81.1%
     of all genes); "basic, CCDS, longest CDS" alone gets 21.3%.

BED12 columns: chrom, transcript start, end, name, 0, strand, coding start,
coding end (= start, start for non-coding), 0, exon count, exon sizes, exon
starts. Coding range = CDS plus start/stop codons (GENCODE's CDS excludes
the stop codon). Name = "gene_name|gene_id|gene_type", the gene_name|gene_id
convention of genes_tss.bed plus the biotype.

One-time preprocessing, not run by the app.
Usage (from the repo root):
  python3 public/refdata/build_gene_models.py <assembly> <gencode.gtf.gz> [--canonical-from <newer.gtf.gz>]
  hg19: --canonical-from public/refdata/hg38/gencode.v50.annotation.gtf.gz
"""
import gzip
import os
import re
import sys
from collections import defaultdict

REFDATA = os.path.join("public", "refdata")
ATTR = re.compile(r'(\S+) "?([^";]*)"?;')


def canonical_ids(gtf):
    """Unversioned transcript IDs tagged Ensembl_canonical in a GTF."""
    ids = set()
    with gzip.open(gtf, "rt") as f:
        for line in f:
            if line.startswith("#"):
                continue
            col = line.split("\t", 9)
            if col[2] == "transcript" and 'tag "Ensembl_canonical"' in col[8]:
                ids.add(re.search(r'transcript_id "([^".]+)', col[8]).group(1))
    return ids


def level(tags, attrs):
    """(APPRIS principal level, transcript support level): lower is better, 9 = none."""
    appris = [t.rsplit("_", 1)[-1] for t in tags if t.startswith("appris_principal")]
    ap = min([int(a) if a.isdigit() else 6 for a in appris] or [9])
    tsl = attrs.get("transcript_support_level", "NA")
    return ap, int(tsl) if tsl.isdigit() else 9


def main():
    assembly, gtf = sys.argv[1], sys.argv[2]
    other = canonical_ids(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[3] == "--canonical-from" else None
    sizes = {}
    with open(os.path.join(REFDATA, assembly, f"{assembly}.chrom.sizes")) as f:
        for line in f:
            c, n = line.split()
            sizes[c] = int(n)

    tx = {}
    by_gene = defaultdict(list)
    with gzip.open(gtf, "rt") as f:
        for line in f:
            if line.startswith("#"):
                continue
            col = line.rstrip("\n").split("\t")
            feature = col[2]
            if feature not in ("transcript", "exon", "CDS", "start_codon", "stop_codon") or col[0] not in sizes:
                continue
            pairs = ATTR.findall(col[8])
            attrs = {}
            tags = set()
            for k, v in pairs:
                if k == "tag":
                    tags.add(v)
                elif k not in attrs:
                    attrs[k] = v
            tid = attrs["transcript_id"]
            start, end = int(col[3]) - 1, int(col[4])
            if feature == "transcript":
                tx[tid] = {
                    "chrom": col[0], "start": start, "end": end, "strand": col[6],
                    "gene_id": attrs["gene_id"], "gene_name": attrs.get("gene_name", attrs["gene_id"]),
                    "gene_type": attrs.get("gene_type", "unknown"), "tags": tags, "level": level(tags, attrs),
                    "exons": [], "cds_len": 0, "thick": None,
                }
                by_gene[attrs["gene_id"]].append(tid)
                continue
            t = tx[tid]  # GTF lists the transcript row before its parts; KeyError = malformed file, stop
            if feature == "exon":
                t["exons"].append((start, end))
            else:
                if feature == "CDS":
                    t["cds_len"] += end - start
                lo, hi = t["thick"] or (start, end)
                t["thick"] = (min(lo, start), max(hi, end))

    def rank(t):
        r = tx[t]
        spliced = sum(e - s for s, e in r["exons"])
        return (-("basic" in r["tags"]), *r["level"], -("CCDS" in r["tags"]), -r["cds_len"], -spliced, t)

    rows = []
    by_rule = [0, 0, 0]
    for gid, tids in by_gene.items():
        canon = [t for t in tids if "Ensembl_canonical" in tx[t]["tags"]]
        if len(canon) > 1:
            raise SystemExit(f"{gid}: {len(canon)} Ensembl_canonical transcripts")
        mapped = [t for t in tids if other is not None and t.split(".")[0] in other]
        if canon:
            by_rule[0] += 1
            best = canon[0]
        elif mapped:
            by_rule[1] += 1
            best = min(mapped, key=rank)
        else:
            by_rule[2] += 1
            best = min(tids, key=rank)
        r = tx[best]
        exons = sorted(r["exons"])
        if not exons:
            raise SystemExit(f"{best}: no exons")
        assert exons[0][0] == r["start"] and exons[-1][1] == r["end"], best
        assert r["end"] <= sizes[r["chrom"]], best
        ts, te = r["thick"] or (r["start"], r["start"])
        rows.append((
            r["chrom"], r["start"], r["end"], f'{r["gene_name"]}|{r["gene_id"]}|{r["gene_type"]}', 0, r["strand"],
            ts, te, 0, len(exons),
            "".join(f"{e - s}," for s, e in exons),
            "".join(f"{s - r['start']}," for s, _ in exons),
        ))

    order = {c: i for i, c in enumerate(sizes)}
    rows.sort(key=lambda x: (order[x[0]], x[1], x[2], x[3]))
    out_dir = os.path.join(REFDATA, assembly, "genes")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "gene_models.bed")
    with open(out, "w") as f:
        for row in rows:
            f.write("\t".join(map(str, row)) + "\n")
    print(f"{assembly}: {len(rows):,} genes (rule 1 tag {by_rule[0]:,}, rule 2 newer GTF {by_rule[1]:,}, rule 3 ranking {by_rule[2]:,}) -> {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
