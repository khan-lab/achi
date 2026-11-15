# ENCODE API responses

Real responses of the ENCODE portal search API, saved 2026-11-15 for
`src/lib/remoteTracks.test.ts` (parsing search results and accession
lookups for the genome browser's public tracks). Only `@graph` and `total`
are kept.

- `search_GRCh38_HepG2_CTCF.json`:
  `https://www.encodeproject.org/search/?type=File&status=released&file_format=bigWig&file_format=bigBed&assembly=GRCh38&searchTerm=HepG2+CTCF&limit=5&format=json&field=...`
- `accessions_ENCFF469WVA_ENCFF901GZH.json`:
  `https://www.encodeproject.org/search/?type=File&accession=ENCFF469WVA&accession=ENCFF901GZH&format=json&field=...`
  (one GRCh38 and one hg19 file)

Fields requested: accession, file_format, output_type, assembly, status,
file_size, md5sum, cloud_metadata.url, biosample_ontology.term_name,
target.label, assay_title, dataset.
