"""
Fixture for src/lib/genomeSequence.test.ts: a small .2bit file of real hg38
sequence, written to the UCSC .2bit specification and checked by reading it
back with py2bit (MIT; an independent reader).

Usage (from the repository root, with py2bit installed):
    python -I tests/fixtures/twobit/build_fixture.py <hg38.2bit>

Sequences (renamed slices of hg38, soft-masked as in hg38.2bit):
  chr21      = hg38 chr21:5,000,000-5,040,000  (starts in an N gap)
  chr22      = hg38 chr22:15,400,000-15,430,000
  chrUn_test = hg38 chr1:1,000,000-1,005,000  (not a canonical chromosome)
Writes mini.2bit, mini.fa (the same sequences, soft-masked) and slices.json.
"""
import json
import os
import struct
import sys

import py2bit

HERE = os.path.dirname(os.path.abspath(__file__))
SLICES = [("chr21", "chr21", 5_000_000, 5_040_000), ("chr22", "chr22", 15_400_000, 15_430_000), ("chrUn_test", "chr1", 1_000_000, 1_005_000)]
CODE = {"T": 0, "C": 1, "A": 2, "G": 3}


def blocks(seq, pred):
    out, start = [], None
    for i, ch in enumerate(seq):
        if pred(ch):
            if start is None:
                start = i
        elif start is not None:
            out.append((start, i - start))
            start = None
    if start is not None:
        out.append((start, len(seq) - start))
    return out


def record(seq):
    n = blocks(seq, lambda c: c in "Nn")
    mask = blocks(seq, lambda c: c.islower())
    packed = bytearray()
    up = seq.upper()
    for i in range(0, len(up), 4):
        b = 0
        for j in range(4):
            ch = up[i + j] if i + j < len(up) else "T"
            b = (b << 2) | CODE.get(ch, 0)  # N is stored as T and restored from the N blocks
        packed.append(b)
    out = struct.pack("<II", len(seq), len(n))
    out += b"".join(struct.pack("<I", s) for s, _ in n) + b"".join(struct.pack("<I", z) for _, z in n)
    out += struct.pack("<I", len(mask))
    out += b"".join(struct.pack("<I", s) for s, _ in mask) + b"".join(struct.pack("<I", z) for _, z in mask)
    out += struct.pack("<I", 0) + bytes(packed)
    return out


def main(src):
    tb = py2bit.open(src)
    seqs = [(name, tb.sequence(chrom, s, e)) for name, chrom, s, e in SLICES]
    # Soft-masking as in hg38.2bit (py2bit gives upper case; re-read with the mask).
    tbm = py2bit.open(src, True)
    seqs = [(name, tbm.sequence(chrom, s, e)) for name, chrom, s, e in SLICES]
    header = struct.pack("<IIII", 0x1A412743, 0, len(seqs), 0)
    index_len = sum(1 + len(n) + 4 for n, _ in seqs)
    offset = 16 + index_len
    index, recs = b"", b""
    for name, seq in seqs:
        r = record(seq)
        index += struct.pack("<B", len(name)) + name.encode() + struct.pack("<I", offset + len(recs))
        recs += r
    path = os.path.join(HERE, "mini.2bit")
    with open(path, "wb") as f:
        f.write(header + index + recs)
    back = py2bit.open(path, True)
    for name, seq in seqs:
        got = back.sequence(name, 0, len(seq))
        if got != seq:
            sys.exit(f"py2bit reads {name} differently from what was written")
    with open(os.path.join(HERE, "mini.fa"), "w") as f:
        for name, seq in seqs:
            f.write(f">{name}\n" + "\n".join(seq[i : i + 60] for i in range(0, len(seq), 60)) + "\n")
    with open(os.path.join(HERE, "slices.json"), "w") as f:
        json.dump([{"name": n, "source": f"hg38 {c}:{s}-{e}", "length": e - s, "nBlocks": len(blocks(q, lambda x: x in 'Nn')), "maskBlocks": len(blocks(q, lambda x: x.islower()))} for (n, c, s, e), (_, q) in zip(SLICES, seqs)], f, indent=1)
    print(open(os.path.join(HERE, "slices.json")).read(), file=sys.stderr)
    print(f"{path}: {os.path.getsize(path)} bytes, read back identically by py2bit", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1])
