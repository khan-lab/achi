"""
Builds the signal-profile test fixture (tests/fixtures/deeptools/) from real
data, and deepTools' own matrices for the parity tests (src/lib/signalMatrix.test.ts).

  python build_fixture.py <repo root> <out dir>

Needs pyBigWig 0.3.30 and deepTools 4.0.0 (both MIT), used only here, in a
throwaway environment; neither ships with the app.

Inputs (all real):
  - ENCODE ENCFF381NDD: K562 H3K27ac ChIP-seq fold change over control,
    GRCh38, experiment ENCSR000AKP (md5 f4d6c7f5a2940fddc57929ca8d71d84d,
    1,511,112,441 bytes). Read by range requests from
    https://encode-public.s3.amazonaws.com/2022/06/14/a3a5887a-bfe4-4c51-856e-986d8d40cfe2/ENCFF381NDD.bigWig
    Only the windows below are copied, at full resolution.
  - The 10 K562 super-enhancers on chr21 of the app's example data
    (public/examples/hg38_ses/K562.bed): scale-regions tests.
  - 30 GENCODE v50 TSSs on chr21 (public/refdata/hg38/genes_tss.bed),
    both strands: reference-point tests.
"""
import os
import subprocess
import sys

import pyBigWig

ROOT, OUT = sys.argv[1], sys.argv[2]
URL = "https://encode-public.s3.amazonaws.com/2022/06/14/a3a5887a-bfe4-4c51-856e-986d8d40cfe2/ENCFF381NDD.bigWig"
CHR21 = 46709983
SE_PAD, TSS_PAD = 12000, 4000

ses = [l.rstrip("\n").split("\t")[:6] for l in open(os.path.join(ROOT, "public/examples/hg38_ses/K562.bed")) if l.startswith("chr21\t")]
tss = []
for l in open(os.path.join(ROOT, "public/refdata/hg38/genes_tss.bed")):
    f = l.rstrip("\n").split("\t")
    if f[0] == "chr21" and 30_000_000 <= int(f[1]) < 46_000_000:
        tss.append(f)
tss = tss[::max(1, len(tss) // 30)][:30]

windows = [(int(s[1]) - SE_PAD, int(s[2]) + SE_PAD) for s in ses] + [(int(t[1]) - TSS_PAD, int(t[2]) + TSS_PAD) for t in tss]
windows.sort()
merged = []
for s, e in windows:
    if merged and s <= merged[-1][1]:
        merged[-1][1] = max(merged[-1][1], e)
    else:
        merged.append([max(0, s), min(CHR21, e)])

bw = os.path.join(OUT, "k562_h3k27ac_ENCFF381NDD.chr21_windows.bw")
starts, ends, values = [], [], []
src = None if os.path.exists(bw) else pyBigWig.open(URL)
if src:
    assert src.chroms("chr21") == CHR21
for s, e in (merged if src else []):
    for a, b, v in src.intervals("chr21", s, e) or []:
        a, b = max(a, s), min(b, e)
        if b > a:
            starts.append(a); ends.append(b); values.append(v)
if src:
    src.close()
if starts:
    out = pyBigWig.open(bw, "w")
    out.addHeader([("chr21", CHR21)])
    out.addEntries(["chr21"] * len(starts), starts, ends=ends, values=values)
    out.close()

with open(os.path.join(OUT, "k562_chr21_super_enhancers.bed"), "w") as f:
    for s in ses:
        f.write("\t".join(s) + "\n")
with open(os.path.join(OUT, "chr21_tss.bed"), "w") as f:
    for t in tss:
        f.write("\t".join([t[0], t[1], t[2], t[3].split("|")[0], "0", t[5]]) + "\n")

def compute(name, args):
    gz = os.path.join(OUT, name + ".matrix.gz")
    tab = os.path.join(OUT, name + ".tab")
    subprocess.run(["computeMatrix", *args, "-S", bw, "--outFileName", gz, "--outFileNameMatrix", tab, "-p", "1"], check=True)
    os.remove(gz)

se_bed = os.path.join(OUT, "k562_chr21_super_enhancers.bed")
tss_bed = os.path.join(OUT, "chr21_tss.bed")
# Scale-regions: 5 kb body, 10 kb flanks, 200 bp bins; missing data as NaN and as zero.
compute("scale_se", ["scale-regions", "-R", se_bed, "--regionBodyLength", "5000", "-b", "10000", "-a", "10000", "--binSize", "200", "--sortRegions", "keep"])
compute("scale_se_zero", ["scale-regions", "-R", se_bed, "--regionBodyLength", "5000", "-b", "10000", "-a", "10000", "--binSize", "200", "--sortRegions", "keep", "--missingDataAsZero"])
# Reference-point at the TSS (strand-aware), +-3 kb, 50 bp bins; and centre of the super-enhancers.
compute("refpoint_tss", ["reference-point", "-R", tss_bed, "--referencePoint", "TSS", "-b", "3000", "-a", "3000", "--binSize", "50", "--sortRegions", "keep"])
compute("refpoint_se_center", ["reference-point", "-R", se_bed, "--referencePoint", "center", "-b", "10000", "-a", "10000", "--binSize", "500", "--sortRegions", "keep"])
print(os.path.getsize(bw), "bytes")

# Per-region summary: mean signal over each region (bases with data), and a
# two-sided Mann-Whitney U test (SciPy, normal approximation with tie and
# continuity correction) between the super-enhancers and the TSS +-1 kb.
import json
import numpy as np
from scipy.stats import mannwhitneyu

b = pyBigWig.open(bw)
se_means = [b.stats("chr21", int(s[1]), int(s[2]), exact=True)[0] for s in ses]
tss_regions = [(int(t[1]) - 1000, int(t[1]) + 1000) for t in tss]
tss_means = [b.stats("chr21", a, z, exact=True)[0] for a, z in tss_regions]
res = mannwhitneyu(se_means, tss_means, alternative="two-sided", method="asymptotic", use_continuity=True)
# A second pair with ties, to check the tie correction: values rounded to one decimal.
r1, r2 = list(np.round(se_means, 1)), list(np.round(tss_means, 1))
res_ties = mannwhitneyu(r1, r2, alternative="two-sided", method="asymptotic", use_continuity=True)
with open(os.path.join(OUT, "expected_summary.json"), "w") as f:
    json.dump({
        "note": "pyBigWig 0.3.30 stats(exact=True) means; scipy.stats.mannwhitneyu two-sided, asymptotic, use_continuity=True",
        "se_means": se_means,
        "tss_regions": tss_regions,
        "tss_means": tss_means,
        "mwu": {"U": float(res.statistic), "p": float(res.pvalue)},
        "ties": {"x": [float(v) for v in r1], "y": [float(v) for v in r2], "U": float(res_ties.statistic), "p": float(res_ties.pvalue)},
    }, f, indent=1)
print("summary:", res, res_ties)
