# Fixture provenance: igv.js test alignments (BAM, CRAM)

Real alignment files from the igv.js repository's own test data
(`test/data/cram/`), used to test local BAM/CRAM tracks
(`src/lib/localTracks.test.ts`): file pairing and the signature checks of
each file and its index. igv.js is MIT-licensed (the app already ships
igv.js 3.8.10 under that licence; see LICENSE). Downloaded 2026-11-17 from
commit `1662b737a14bc3021af09e0e1e7a0039de1bca8d`; the files were last
changed in commit `1ad601d8c60e44cb99582655cf519372a4ab0205` (2018-12-11).

| Fixture | Bytes | sha256 |
|---|---|---|
| `hg00096_hg38.bam` | 1,495 | `b11cd3e4b98c9932ef53024f97973cbd99d952996656d01b1e483a4077542884` |
| `hg00096_hg38.bam.bai` | 62,960 | `81ab9a171ce84653d1a029f64781d6139f136e80d5810135ac94e8efbb60c2f2` |
| `hg00096_hg38.cram` | 2,274 | `0f4012756d78e9b0d01c0a4c2852b670ab88423e0f89a929d5d1772bc22ccd1c` |
| `hg00096_hg38.cram.crai` | 50 | `ff0d4e9756d04a3e49cf1891fddf909bfb8eae5c915f307d639a729da5b94d88` |

Contents: reads of 1000 Genomes sample HG00096 (read groups SRR062634,
SRR062635, SRR062641) on GRCh38 chr8 around 128.74–128.76 Mb (the MYC
locus). Source URLs:
`https://raw.githubusercontent.com/igvteam/igv.js/<commit>/test/data/cram/<file>`.
