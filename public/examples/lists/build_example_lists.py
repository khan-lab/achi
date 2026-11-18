"""
Example gene lists for Achi's list mode, derived from the app's
own example data (no download): for each ENCODE cell line in
public/examples/hg38_ses/, the protein-coding genes whose TSS is nearest to
at least one of its peaks.

Same rule as the app's "Genes near the selected subsets" panel
(src/lib/geneList.ts): every equally nearest protein-coding TSS
(bedtools closest -d -t all), distance 0 when the TSS lies inside the peak,
otherwise the gap in bp. TSSs come from the bundled GENCODE gene models
(public/refdata/hg38/genes/gene_models.bed, one transcript per gene):
the 5' end, start on + strand, end - 1 on - strand.

Run from the repository root:
    python3 public/examples/lists/build_example_lists.py
Writes public/examples/lists/<cell line>_genes.txt, one symbol per line,
sorted.
"""
import bisect
import os
from collections import defaultdict

ROOT = os.getcwd()
GENES = os.path.join(ROOT, "public", "refdata", "hg38", "genes", "gene_models.bed")
PEAKS = os.path.join(ROOT, "public", "examples", "hg38_ses")
OUT = os.path.join(ROOT, "public", "examples", "lists")
CELL_LINES = ["MCF7", "GM12878", "K562", "HepG2"]

tss = defaultdict(list)  # chrom -> [(pos, symbol)]
with open(GENES) as f:
    for line in f:
        c = line.rstrip("\n").split("\t")
        symbol, _gene_id, gene_type = c[3].split("|")
        if gene_type != "protein_coding":
            continue
        pos = int(c[1]) if c[5] == "+" else int(c[2]) - 1
        tss[c[0]].append((pos, symbol))
for chrom in tss:
    tss[chrom].sort()
positions = {chrom: [p for p, _ in v] for chrom, v in tss.items()}


def nearest(chrom, start, end):
    """Symbols of every equally nearest TSS to [start, end)."""
    if chrom not in tss:
        return set()
    pos, entries = positions[chrom], tss[chrom]
    i = bisect.bisect_left(pos, start)
    j = bisect.bisect_left(pos, end)
    if i < j:  # TSSs inside the peak: distance 0
        return {s for _, s in entries[i:j]}
    best, out = None, set()
    for k in (i - 1, i):
        if 0 <= k < len(entries):
            p = entries[k][0]
            d = start - p if p < start else p - end + 1
            if best is None or d < best:
                best, out = d, set()
            if d == best:
                out |= {s for q, s in entries if q == p}
    return out


for cell in CELL_LINES:
    genes = set()
    with open(os.path.join(PEAKS, f"{cell}.bed")) as f:
        for line in f:
            if not line.strip() or line.startswith(("#", "track", "browser")):
                continue
            c = line.split("\t")
            genes |= nearest(c[0], int(c[1]), int(c[2]))
    path = os.path.join(OUT, f"{cell}_genes.txt")
    with open(path, "w") as f:
        f.write("\n".join(sorted(genes)) + "\n")
    print(f"{cell}: {len(genes)} genes -> {os.path.relpath(path, ROOT)}")
