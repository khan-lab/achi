"""
Builds the example signal, step 2 of 2 (step 1: build_example_signal.mjs):
writes public/examples/signal/<SET>_H3K27ac.example.bw from the bedGraphs
and provenance.json. Needs pyBigWig 0.3.30 (MIT); used only here.

  python public/examples/signal/bedgraph_to_bigwig.py <work dir>
"""
import hashlib
import json
import os
import sys

import pyBigWig

WORK = sys.argv[1]
OUT = os.path.join(os.getcwd(), "public", "examples", "signal")
meta = json.load(open(os.path.join(WORK, "meta.json")))
files = []
for m in meta["files"]:
    path = os.path.join(OUT, f"{m['set']}_H3K27ac.example.bw")
    bw = pyBigWig.open(path, "w")
    bw.addHeader([(c, n) for c, n in meta["chroms"]])
    chroms, starts, ends, values = [], [], [], []
    for line in open(os.path.join(WORK, m["bedGraph"])):
        c, s, e, v = line.split("\t")
        chroms.append(c); starts.append(int(s)); ends.append(int(e)); values.append(float(v))
    bw.addEntries(chroms, starts, ends=ends, values=values)
    bw.close()
    files.append({"set": m["set"], "file": os.path.basename(path), "bytes": os.path.getsize(path),
                  "md5": hashlib.md5(open(path, "rb").read()).hexdigest(), "bins": len(values), "source": m["source"]})
    print(m["set"], files[-1]["bytes"], "bytes", file=sys.stderr)
json.dump({"bin": meta["bin"], "pad": meta["pad"], "assembly": meta["assembly"],
           "built_with": "build_example_signal.mjs (@gmod/bbi 9.3.3) + bedgraph_to_bigwig.py (pyBigWig 0.3.30)", "files": files},
          open(os.path.join(OUT, "provenance.json"), "w"), indent=1)
