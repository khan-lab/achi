"""
Fixture for src/lib/pwm.test.ts: real hg38 sequence and real JASPAR 2026
matrices, with MOODS 1.9.4 (GPLv3 / Biopython licence; used here only, never
shipped) as the reference scanner.

Usage (from the repository root, with MOODS-python and py2bit installed):
    python -I tests/fixtures/motifs/build_fixture.py <hg38.2bit> <JASPAR2026 PFM file>

- sequences.fa: ±100 bp around the centres of the first 150 regions of
  public/examples/hg38_ses/K562.bed and HepG2.bed (300 sequences, 200 bp),
  read from UCSC hg38.2bit with py2bit.
- expected_moods.json: the strand-symmetric background of those sequences;
  for 26 matrices, MOODS log_odds (pseudocount 0.8), threshold_from_p
  (p = 1e-4) and every site from scan_dna on both strands.
"""
import json
import os
import re
import sys

import MOODS.scan
import MOODS.tools
import py2bit

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PS = 0.8
P = 1e-4
NAMES = ["Arnt", "CTCF", "GATA1", "GATA2", "HNF4A", "FOXA2", "Spi1", "FOS::JUN", "CEBPB", "NFE2", "Runx1", "ETS1", "KLF1", "Yy1", "Nrf1", "SP1", "REST", "TP53", "HNF1A", "ELF1", "MAX", "USF1", "NFYA", "ZNF143", "ESR1", "FOXA1"]


def parse_pfms(text):
    out = {}
    lines = [l for l in text.splitlines() if l.strip()]
    for i in range(0, len(lines), 5):
        mid, name = re.match(r"^>(\S+)\s+(.*)$", lines[i]).groups()
        rows = [[float(x) for x in re.search(r"\[(.*)\]", l).group(1).split()] for l in lines[i + 1 : i + 5]]
        out.setdefault(name.strip(), (mid, rows))
    return out


def main(twobit, pfm_path):
    tb = py2bit.open(twobit)
    seqs = []
    for cell in ("K562", "HepG2"):
        with open(os.path.join(ROOT, "public/examples/hg38_ses", f"{cell}.bed")) as f:
            rows = [l.split("\t") for l in f if l.strip() and not l.startswith(("#", "track", "browser"))][:150]
        for c in rows:
            mid = (int(c[1]) + int(c[2])) // 2
            seqs.append((f"{c[0]}:{mid - 100}-{mid + 100}", tb.sequence(c[0], mid - 100, mid + 100)))
    with open(os.path.join(HERE, "sequences.fa"), "w") as f:
        for name, s in seqs:
            f.write(f">{name}\n{s}\n")
    n = [0, 0, 0, 0]
    for _, s in seqs:
        for ch in s.upper():
            if ch in "ACGT":
                n["ACGT".index(ch)] += 1
    tot = sum(n)
    at, cg = (n[0] + n[3]) / 2 / tot, (n[1] + n[2]) / 2 / tot
    bg = [at, cg, cg, at]
    pfms = parse_pfms(open(pfm_path).read())
    motifs = []
    for name in NAMES:
        if name not in pfms:
            sys.exit(f"{name} is not in {pfm_path}")
        mid, rows = pfms[name]
        lo = MOODS.tools.log_odds(rows, bg, PS)
        rc = MOODS.tools.reverse_complement(lo)
        t = MOODS.tools.threshold_from_p(lo, bg, P)
        hits = []
        for i, (_, s) in enumerate(seqs):
            res = MOODS.scan.scan_dna(s.upper(), [lo, rc], bg, [t, t], 7)
            hits += [[i, m.pos, 0] for m in res[0]] + [[i, m.pos, 1] for m in res[1]]
        motifs.append({"id": mid, "name": name, "pfm": [[rows[b][j] for b in range(4)] for j in range(len(rows[0]))], "logOdds": [[lo[b][j] for b in range(4)] for j in range(len(lo[0]))], "threshold": t, "hits": sorted(hits)})
        print(f"{mid} {name}: L={len(rows[0])} t={t:.3f} sites={len(hits)}", file=sys.stderr)
    with open(os.path.join(HERE, "expected_moods.json"), "w") as f:
        json.dump({"pseudocount": PS, "p": P, "background": bg, "motifs": motifs}, f)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
