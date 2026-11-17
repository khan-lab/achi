# Signal-profile fixtures (deepTools parity)

Used by `src/lib/signalMatrix.test.ts` and `src/lib/stats.test.ts`. Built with
`build_fixture.py` (in this folder) on 2026-11-17:

```
python build_fixture.py <repo root> tests/fixtures/deeptools
```

with pyBigWig 0.3.30 (MIT), deepTools 4.0.0 (MIT), SciPy 1.18.1 and NumPy
2.5.5 in a throwaway virtual environment. None of these ship with the app.

## Data

| File | What | Source |
|---|---|---|
| `k562_h3k27ac_ENCFF381NDD.chr21_windows.bw` | K562 H3K27ac ChIP-seq fold change over control, chr21 only, copied at full resolution inside the windows below (no data elsewhere). md5 `07376e46ed6db983be6975479e294c38` | ENCODE file ENCFF381NDD (experiment ENCSR000AKP, GRCh38, replicates 1–3; portal md5 `f4d6c7f5a2940fddc57929ca8d71d84d`, 1,511,112,441 bytes), read by range requests from `https://encode-public.s3.amazonaws.com/2022/06/14/a3a5887a-bfe4-4c51-856e-986d8d40cfe2/ENCFF381NDD.bigWig`. ENCODE data-use policy: free use, citation requested. |
| `k562_chr21_super_enhancers.bed` | The 10 K562 super-enhancers on chr21 | `public/examples/hg38_ses/K562.bed` (dbSUPER, see docs/provenance.md) |
| `chr21_tss.bed` | 30 GENCODE v50 TSSs on chr21 (30–46 Mb), both strands, 1 bp each | `public/refdata/hg38/genes_tss.bed` |

Windows: each super-enhancer ± 12 kb and each TSS ± 4 kb, merged.

## Expected results (deepTools / SciPy output)

| File | Command |
|---|---|
| `scale_se.tab` | `computeMatrix scale-regions -R k562_chr21_super_enhancers.bed --regionBodyLength 5000 -b 10000 -a 10000 --binSize 200 --sortRegions keep` |
| `scale_se_zero.tab` | the same with `--missingDataAsZero` |
| `refpoint_tss.tab` | `computeMatrix reference-point -R chr21_tss.bed --referencePoint TSS -b 3000 -a 3000 --binSize 50 --sortRegions keep` |
| `refpoint_se_center.tab` | `computeMatrix reference-point -R k562_chr21_super_enhancers.bed --referencePoint center -b 10000 -a 10000 --binSize 500 --sortRegions keep` |
| `expected_summary.json` | mean signal over each region (`pyBigWig stats(exact=True)`), and `scipy.stats.mannwhitneyu(alternative="two-sided", method="asymptotic", use_continuity=True)` between the super-enhancers and the TSSs ± 1 kb, plus a tied (rounded) pair |

The `.tab` files are deepTools' `--outFileNameMatrix` output: three header
lines, then one row per region (in BED order) and one column per bin, values
to 6 decimals.

What these pinned down about deepTools 4.0.0 (checked against pyBigWig
directly before writing the tests):

- each bin is the mean over the bases in the bin that have data (no data → NaN);
- reference point: `TSS` is the start on + and the end on −, `center` is
  `floor((start + end) / 2)`; on − the window is reversed;
- scale-regions: body bin k covers `start + floor(k·L/n)` to `start + floor((k+1)·L/n)`.
