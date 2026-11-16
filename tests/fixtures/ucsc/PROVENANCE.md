# Fixture provenance: UCSC example bigBed and bigWig

Real files from the UCSC Genome Browser's own documentation examples
(bigBed and bigWig format help pages), used to test local genome-browser
tracks (`src/lib/localTracks.test.ts`): format detection and the check of
each file's signature bytes. Downloaded 2026-11-17. UCSC example data is
published for unrestricted use with the format documentation; no entry is
needed in docs/licences.md.

| Fixture | Source | Original | Taken | sha256 |
|---|---|---|---|---|
| `bigBedExample.bb` | https://genome.ucsc.edu/goldenPath/help/examples/bigBedExample.bb | 419,735 bytes, Last-Modified 2010-06-14 | whole file | `47b8da19da786561a4b10dcd35604c203dda453f26647f3e811f1312ceb566e1` |
| `bigWigExample.first64k.bw` | https://genome.ucsc.edu/goldenPath/help/examples/bigWigExample.bw | 81,596,201 bytes, Last-Modified 2010-06-14 | first 65,536 bytes (`curl -r 0-65535`): the header, not a complete file | `50681d01947829abcf0219fcb2791fb362c2fd391fe09df943f9cfe52b4d76b9` |

Both are hg19 (chr21). The bigWig is cut because the full file is 82 MB;
the tests read only its first bytes (signature 0x888FFC26). The full file
was used for the in-browser check of the genome browser, not committed.

## hg38 chrM reference sequence (FASTA + .fai)

For the reference-FASTA checks of local CRAM tracks.

| Fixture | Source | Taken | sha256 |
|---|---|---|---|
| `hg38_chrM.fa` | https://hgdownload.soe.ucsc.edu/goldenPath/hg38/chromosomes/chrM.fa.gz (5,549 bytes, Last-Modified 2014-01-24) | whole file, gunzipped (16,907 bytes; 16,569 bp, the hg38 chrM length) | `03a7248a919bf68ed2bd9e779e064501d15b8e83f53cc456d529aa4edc3cd3ac` |
| `hg38_chrM.fa.fai` | computed from `hg38_chrM.fa` in the samtools faidx format (name, length, offset, line bases, line width): `chrM	16569	6	50	51` | | |

UCSC genome sequence downloads are free for any use.
