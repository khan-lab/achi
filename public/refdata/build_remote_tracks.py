#!/usr/bin/env python3
"""
Build the curated list of public tracks the genome browser can add after
the user agrees to contact outside servers (src/lib/remoteTracks.ts,
src/components/GenomeBrowser.tsx). Writes, per assembly with any entry:

  public/refdata/<assembly>/remote/tracks.json

Nothing in it is downloaded by the app ahead of time: each entry is a URL
igv.js reads in byte ranges, only after consent. This script only records
where the files are, so no URL is typed by hand.

Entries:
  1. SCREEN aggregate signal (hg38, mm10): DNase, ATAC, H3K4me3, H3K27ac and
     CTCF signal merged across ENCODE experiments, as shown in SCREEN's own
     genome browser. The file names are copied from SCREEN's source code,
     weng-lab/SCREEN2.0 commit 4782951a696df57552e6d1bfaa3661e5cfeea939,
     screen2.0/src/app/search/_gbview/SearchBrowserView.tsx. They are too
     large to hash (1-22 GB); each is pinned by size and Last-Modified,
     checked here with a range request.
  2. ENCODE cCRE registry (SCREEN), cell-type agnostic, as bigBed from the
     ENCODE portal: GRCh38 V4 ENCSR800VNX, mm10 V4 ENCSR412JPD, hg19 V1
     ENCSR911QEI (accession, md5, size, cloud URL from the API).
  3. ENCODE signal for the example data's cell lines (GM12878, HepG2, K562,
     MCF-7, H1; hg38 and hg19): DNase-seq "read-depth normalized signal";
     H3K27ac, H3K4me3 (Histone ChIP-seq) and CTCF (TF ChIP-seq) "fold change
     over control". Released bigWig files only; one file per cell line and
     assay, the first by: ENCODE preferred_default; most biological
     replicates pooled; newest date_created; smallest accession.
     Plus each cell line's cell-type-specific cCREs (bigBed): hg38 ENCODE v4,
     hg19 ENCODE v1; untreated; on hg19 the combined file, not the "high
     DNase/H3K4me3/H3K27ac/CTCF" subsets; if several remain, the smallest
     annotation accession.
  4. Conservation from UCSC (phyloP bigWig): hg38 100 vertebrates and 241
     mammals (Zoonomia, Cactus alignment), hg19 100 vertebrates, mm10 60
     vertebrates. Pinned by size and Last-Modified, and by the md5 in the
     directory's md5sum.txt where it lists the served file name.
  5. JASPAR 2024 predicted TF binding sites, the UCSC Genome Browser track
     file (gbdb/<asm>/jaspar/JASPAR2024.bb; hg38, hg19, mm10). 147-177 GB:
     igv reads only the region on screen, draws it below 20 kb, and shades
     each site by its score (most matches are weak).

ENCODE files are read from their public S3 address (cloud_metadata.url),
not www.encodeproject.org/files/.../@@download, which redirects every range
request. Both hosts send Access-Control-Allow-Origin: * and answer range
requests (checked 2026-11-15).

Usage (from the repo root): python3 public/refdata/build_remote_tracks.py
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

REFDATA = os.path.join("public", "refdata")
ENCODE = "https://www.encodeproject.org"
SCREEN = "https://downloads.wenglab.org"
SCREEN_SOURCE = "https://github.com/weng-lab/SCREEN2.0/blob/4782951a696df57552e6d1bfaa3661e5cfeea939/screen2.0/src/app/search/_gbview/SearchBrowserView.tsx"
UA = {"User-Agent": "intervene-build-remote-tracks/1.0 (+https://github.com/khan-lab/intervene-secure)", "Accept": "application/json"}

SCREEN_SIGNAL = {
    "hg38": [
        ("DNase", "DNAse_All_ENCODE_MAR20_2024_merged.bw", 1121650396, "Mon, 01 Apr 2024 15:22:34 GMT"),
        ("ATAC", "ATAC_All_ENCODE_MAR20_2024_merged.bw", 20948100786, "Mon, 01 Apr 2024 14:59:04 GMT"),
        ("H3K4me3", "H3K4me3_All_ENCODE_MAR20_2024_merged.bw", 21805914152, "Mon, 01 Apr 2024 15:27:07 GMT"),
        ("H3K27ac", "H3K27ac_All_ENCODE_MAR20_2024_merged.bw", 21904151394, "Mon, 01 Apr 2024 15:24:59 GMT"),
        ("CTCF", "CTCF_All_ENCODE_MAR20_2024_merged.bw", 21714486505, "Mon, 01 Apr 2024 15:21:41 GMT"),
    ],
    "mm10": [
        ("DNase", "DNase_MM10_ENCODE_DEC2024_merged_nanrm.bigWig", 7821237375, "Mon, 13 Apr 2026 16:40:12 GMT"),
        ("ATAC", "ATAC_MM10_ENCODE_DEC2024_merged_nanrm.bigWig", 14623728671, "Mon, 13 Apr 2026 16:37:51 GMT"),
        ("H3K4me3", "H3K4me3_MM10_ENCODE_DEC2024_merged_nanrm.bigWig", 15512099594, "Mon, 13 Apr 2026 16:43:18 GMT"),
        ("H3K27ac", "H3K27ac_MM10_ENCODE_DEC2024_merged_nanrm.bigWig", 15543482255, "Mon, 13 Apr 2026 16:42:11 GMT"),
        ("CTCF", "CTCF_MM10_ENCODE_DEC2024_merged_nanrm.bigWig", 12812939131, "Mon, 13 Apr 2026 16:39:04 GMT"),
    ],
}
UCSC = "https://hgdownload.soe.ucsc.edu"
CONSERVATION = {
    "hg38": [
        ("phyloP, 100 vertebrates", "goldenPath/hg38/phyloP100way/hg38.phyloP100way.bw", 9870053206, "Fri, 08 May 2015 22:37:42 GMT"),
        # md5sum.txt in cactus241way/ lists "hg38.cactus241way.phyloP.bw", which is not served; no md5 recorded.
        ("phyloP, 241 mammals (Zoonomia)", "goldenPath/hg38/cactus241way/cactus241way.phyloP.bw", 9644660543, "Mon, 10 May 2021 19:28:33 GMT"),
    ],
    "hg19": [("phyloP, 100 vertebrates", "goldenPath/hg19/phyloP100way/hg19.100way.phyloP100way.bw", 9558040733, "Tue, 11 Feb 2014 18:16:46 GMT")],
    "mm10": [("phyloP, 60 vertebrates", "goldenPath/mm10/phyloP60way/mm10.60way.phyloP60way.bw", 5928108111, "Fri, 18 Apr 2014 17:54:35 GMT")],
}
JASPAR = {
    "hg38": (177319645521, "Fri, 09 Feb 2024 08:30:31 GMT"),
    "hg19": (169831646264, "Fri, 09 Feb 2024 07:56:05 GMT"),
    "mm10": (146985923955, "Fri, 09 Feb 2024 09:50:01 GMT"),
}
CCRE_REGISTRY = {"hg38": ("ENCSR800VNX", "V4"), "mm10": ("ENCSR412JPD", "V4"), "hg19": ("ENCSR911QEI", "V1")}
ENCODE_ASSEMBLY = {"hg38": "GRCh38", "hg19": "hg19", "mm10": "mm10"}
CELL_LINES = ["GM12878", "HepG2", "K562", "MCF-7", "H1"]
ASSAYS = [
    ("DNase", "DNase-seq", None, "read-depth normalized signal"),
    ("H3K27ac", "Histone ChIP-seq", "H3K27ac", "fold change over control"),
    ("H3K4me3", "Histone ChIP-seq", "H3K4me3", "fold change over control"),
    ("CTCF", "TF ChIP-seq", "CTCF", "fold change over control"),
]
FILE_FIELDS = ["accession", "dataset", "file_format", "output_type", "assembly", "status", "md5sum", "file_size",
               "cloud_metadata.url", "preferred_default", "biological_replicates", "date_created", "lab.title"]


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return json.load(r)


def search(params):
    url = f"{ENCODE}/search/?" + urllib.parse.urlencode({**params, "format": "json", "limit": "all", "field": FILE_FIELDS}, doseq=True)
    try:
        return get_json(url)["@graph"]
    except urllib.error.HTTPError as e:
        if e.code == 404:  # ENCODE answers an empty search with 404
            return []
        raise


def check_remote(url, size, last_modified):
    req = urllib.request.Request(url, headers={"Range": "bytes=0-3", "Origin": "https://khan-lab.github.io", "User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=60) as r:
        got_size = int(r.headers["Content-Range"].split("/")[1])
        problems = []
        if r.status != 206:
            problems.append(f"status {r.status}")
        if r.headers.get("Access-Control-Allow-Origin") != "*":
            problems.append("no CORS")
        if got_size != size or r.headers.get("Last-Modified") != last_modified:
            problems.append(f"changed: {got_size} bytes, {r.headers.get('Last-Modified')}")
        if problems:
            raise SystemExit(f"{url}: {'; '.join(problems)} -- stop and check the source before updating the pin")


def ucsc_md5(path):
    """md5 of a UCSC file from its directory's md5sum.txt, or None if not listed under that name."""
    d, name = path.rsplit("/", 1)
    with urllib.request.urlopen(urllib.request.Request(f"{UCSC}/{d}/md5sum.txt", headers={"User-Agent": UA["User-Agent"]}), timeout=60) as r:
        for line in r.read().decode().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] == name:
                return parts[0]
    return None


def cell_ccre(asm, cell):
    version = "ENCODE v4" if asm == "hg38" else "ENCODE v1"
    url = f"{ENCODE}/search/?" + urllib.parse.urlencode({
        "type": "Annotation", "annotation_type": "candidate Cis-Regulatory Elements", "biosample_ontology.term_name": cell,
        "assembly": ENCODE_ASSEMBLY[asm], "encyclopedia_version": version, "status": "released",
        "field": ["accession", "description"], "format": "json", "limit": "all"}, doseq=True)
    anns = [a for a in get_json(url)["@graph"] if "treated" not in a.get("description", "") and not a.get("description", "").startswith("high ")]
    if not anns:
        return None, version
    ann = min(anns, key=lambda a: a["accession"])
    bb = search({"type": "File", "dataset": f"/annotations/{ann['accession']}/", "file_format": "bigBed", "status": "released"})
    if len(bb) != 1:
        raise SystemExit(f"{ann['accession']}: expected one released bigBed, found {len(bb)}")
    return (bb[0], ann), version


def encode_entry(f, group, name, description):
    assert f["status"] == "released" and f["cloud_metadata"]["url"].startswith("https://encode-public.s3.amazonaws.com/"), f["accession"]
    return {
        "id": f["accession"],
        "group": group,
        "name": name,
        "kind": "bigwig" if f["file_format"] == "bigWig" else "bigbed",
        "url": f["cloud_metadata"]["url"],
        "size": f["file_size"],
        "md5": f["md5sum"],
        "source": f"{ENCODE}/files/{f['accession']}/",
        "description": description,
    }


def main():
    today = datetime.date.today().isoformat()
    for asm in ["hg38", "hg19", "mm10"]:
        tracks = []
        for label, fname, size, lm in SCREEN_SIGNAL.get(asm, []):
            url = f"{SCREEN}/{fname}"
            check_remote(url, size, lm)
            tracks.append({
                "id": f"screen-{asm}-{label.lower()}",
                "group": "SCREEN aggregate signal (all ENCODE experiments)",
                "name": f"SCREEN {label} (merged)",
                "kind": "bigwig",
                "url": url,
                "size": size,
                "lastModified": lm,
                "source": SCREEN_SOURCE,
                "description": f"{label} signal merged across ENCODE experiments, as shown in SCREEN's genome browser.",
            })
        acc, version = CCRE_REGISTRY[asm]
        ann = get_json(f"{ENCODE}/annotations/{acc}/?format=json&frame=object")
        bb = [f for f in search({"type": "File", "dataset": f"/annotations/{acc}/", "file_format": "bigBed", "status": "released"})]
        if len(bb) != 1:
            raise SystemExit(f"{acc}: expected one released bigBed, found {len(bb)}")
        tracks.append(encode_entry(bb[0], "ENCODE cCRE registry (SCREEN)", f"ENCODE cCREs {version}, all cell types",
                                   f"{ann.get('description', 'cCREs')} ({acc})."))
        for name, path, size, lm in CONSERVATION.get(asm, []):
            url = f"{UCSC}/{path}"
            check_remote(url, size, lm)
            entry = {"id": f"ucsc-{asm}-{path.rsplit('/', 1)[1]}", "group": "Conservation (UCSC)", "name": name, "kind": "bigwig",
                     "url": url, "size": size, "lastModified": lm, "source": f"{UCSC}/{path.rsplit('/', 1)[0]}/",
                     "description": f"Conservation scores ({name}), UCSC Genome Browser."}
            md5 = ucsc_md5(path)
            if md5:
                entry["md5"] = md5
            tracks.append(entry)
        if asm in JASPAR:
            size, lm = JASPAR[asm]
            url = f"{UCSC}/gbdb/{asm}/jaspar/JASPAR2024.bb"
            check_remote(url, size, lm)
            tracks.append({"id": f"jaspar2024-{asm}", "group": "TF binding sites (JASPAR 2024, UCSC)", "name": "JASPAR 2024 TFBS", "kind": "bigbed",
                           "url": url, "size": size, "lastModified": lm, "visibilityWindow": 20_000, "scored": True,
                           "source": f"https://genome.ucsc.edu/cgi-bin/hgTrackUi?db={asm}&g=jaspar",
                           "description": "JASPAR 2024 predicted transcription factor binding sites, the UCSC Genome Browser track file (JASPAR data: CC BY 4.0). Drawn below 20 kb."})
        if asm in ("hg38", "hg19"):
            for cell in CELL_LINES:
                for label, assay, target, output in ASSAYS:
                    p = {"type": "File", "file_format": "bigWig", "assembly": ENCODE_ASSEMBLY[asm], "status": "released",
                         "biosample_ontology.term_name": cell, "assay_title": assay, "output_type": output}
                    if target:
                        p["target.label"] = target
                    files = search(p)
                    if not files:
                        print(f"  {asm} {cell} {label}: none", file=sys.stderr)
                        continue
                    best = min(files, key=lambda f: (not f.get("preferred_default", False), -len(f.get("biological_replicates", [])),
                                                     "".join(chr(0x10FFFF - ord(c)) for c in f["date_created"]), f["accession"]))
                    exp = best["dataset"].strip("/").split("/")[-1]
                    tracks.append(encode_entry(best, f"ENCODE: {cell}", f"{cell} {label}",
                                               f"{assay} {output}, experiment {exp}, replicates {best.get('biological_replicates')}."))
                found, version = cell_ccre(asm, cell)
                if found:
                    f, ann = found
                    tracks.append(encode_entry(f, f"ENCODE: {cell}", f"{cell} cCREs",
                                               f"Cell-type-specific cCREs ({version}), annotation {ann['accession']}: {ann.get('description', '')}."))
                else:
                    print(f"  {asm} {cell} cCREs: none", file=sys.stderr)
        doc = {"built": today, "assembly": asm, "hosts": sorted({urllib.parse.urlparse(t["url"]).hostname for t in tracks}), "tracks": tracks}
        out_dir = os.path.join(REFDATA, asm, "remote")
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "tracks.json"), "w") as out:
            json.dump(doc, out, indent=1)
        print(f"{asm}: {len(tracks)} tracks, hosts {doc['hosts']}")


if __name__ == "__main__":
    main()
