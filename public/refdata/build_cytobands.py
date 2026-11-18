#!/usr/bin/env python3
"""
Bundle UCSC chromosome bands for the genome browser's ideogram
(src/lib/browserTracks.ts::igvGenome), so igv draws the bands without any
outside request: public/refdata/<assembly>/cytoband.txt.

Source: UCSC Genome Browser, cytoBandIdeo.txt.gz per assembly:
  https://hgdownload.soe.ucsc.edu/goldenPath/<assembly>/database/cytoBandIdeo.txt.gz
Kept as published (chrom, start, end, band, stain), only rows on
chromosomes in <assembly>.chrom.sizes; sorted as in chrom.sizes.

Usage (from the repo root): python3 public/refdata/build_cytobands.py <scratch_dir>
"""
import gzip
import hashlib
import os
import sys
import urllib.request

REFDATA = os.path.join("public", "refdata")
URL = "https://hgdownload.soe.ucsc.edu/goldenPath/{asm}/database/cytoBandIdeo.txt.gz"


def main():
    scratch = sys.argv[1]
    os.makedirs(scratch, exist_ok=True)
    for asm in ["hg38", "hg19", "mm10", "mm9"]:
        path = os.path.join(scratch, f"{asm}.cytoBandIdeo.txt.gz")
        if not os.path.exists(path):
            req = urllib.request.Request(URL.format(asm=asm), headers={"User-Agent": "achi-build-cytobands/1.0 (+https://github.com/khan-lab/achi)"})
            with urllib.request.urlopen(req) as r, open(path, "wb") as out:
                out.write(r.read())
        digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
        with open(os.path.join(REFDATA, asm, f"{asm}.chrom.sizes")) as f:
            order = {line.split()[0]: i for i, line in enumerate(f)}
        rows = []
        with gzip.open(path, "rt") as f:
            for line in f:
                col = line.rstrip("\n").split("\t")
                if len(col) == 5 and col[0] in order:
                    rows.append(col)
        rows.sort(key=lambda c: (order[c[0]], int(c[1])))
        out = os.path.join(REFDATA, asm, "cytoband.txt")
        with open(out, "w") as f:
            f.writelines("\t".join(c) + "\n" for c in rows)
        print(f"{asm}: {len(rows)} bands on {len({c[0] for c in rows})} chromosomes; download sha256 {digest}; output sha256 {hashlib.sha256(open(out, 'rb').read()).hexdigest()}")


if __name__ == "__main__":
    main()
