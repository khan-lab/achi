"""
Builds the JASPAR 2026 matrices for the motif enrichment card, one JSON per
collection in public/refdata/jaspar/:

  jaspar2026_core_vertebrates_nr.json         CORE, vertebrates, non-redundant (the default)
  jaspar2026_core_vertebrates_redundant.json  CORE, vertebrates, every profile version
  jaspar2026_unvalidated_vertebrates_nr.json  UNVALIDATED, non-redundant, vertebrate profiles only

(UNVALIDATED is published for all taxa together; only its vertebrate
profiles are kept, the assemblies here being human and mouse.) Each
profile's TF name, class, family and taxon come from the JASPAR REST API.

JASPAR is CC BY 4.0 (https://jaspar.elixir.no/about/). Cite: Ovek Baydar D et al.,
JASPAR 2026, Nucleic Acids Res. 2026;54(D1):D184-D193, doi:10.1093/nar/gkaf1209.

Usage, from the repository root:
    python -I public/refdata/build_jaspar.py
Standard library only. Stops on any failed download (no substitute source).
Metadata already in an existing output file is reused, not fetched again.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

RELEASE = "2026"
BASE = f"https://jaspar.elixir.no/download/data/{RELEASE}"
API = "https://jaspar.elixir.no/api/v1/matrix/{}/?format=json"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jaspar")
COLLECTIONS = [
    {"file": "jaspar2026_core_vertebrates_nr.json", "collection": "CORE", "taxon": "vertebrates", "nonRedundant": True, "source": f"{BASE}/CORE/JASPAR{RELEASE}_CORE_vertebrates_non-redundant_pfms_jaspar.txt"},
    {"file": "jaspar2026_core_vertebrates_redundant.json", "collection": "CORE", "taxon": "vertebrates", "nonRedundant": False, "source": f"{BASE}/CORE/JASPAR{RELEASE}_CORE_vertebrates_redundant_pfms_jaspar.txt"},
    {"file": "jaspar2026_unvalidated_vertebrates_nr.json", "collection": "UNVALIDATED", "taxon": "vertebrates", "nonRedundant": True, "filterTaxon": True, "source": f"{BASE}/collections/JASPAR{RELEASE}_UNVALIDATED_non-redundant_pfms_jaspar.txt"},
]


def get(url, tries=5):
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "achi-build-jaspar/1.0 (+https://github.com/khan-lab/achi)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - report and retry, then stop
            if attempt == tries:
                sys.exit(f"Download failed: {url}: {e}")
            time.sleep(2 * attempt)


def parse_pfms(text):
    """JASPAR's own PFM format: '>ID\tname' then four rows 'A  [ c c c ]'."""
    out = []
    lines = [l for l in text.splitlines() if l.strip()]
    for i in range(0, len(lines), 5):
        m = re.match(r"^>(\S+)\s+(.*)$", lines[i])
        if not m:
            sys.exit(f"Unexpected PFM header: {lines[i]!r}")
        rows = {}
        for row in lines[i + 1 : i + 5]:
            r = re.match(r"^([ACGT])\s*\[\s*([\d.\s]+)\]\s*$", row)
            if not r:
                sys.exit(f"Unexpected PFM row in {m.group(1)}: {row!r}")
            rows[r.group(1)] = [float(x) for x in r.group(2).split()]
        lens = {len(v) for v in rows.values()}
        if len(rows) != 4 or len(lens) != 1:
            sys.exit(f"Malformed matrix {m.group(1)}")
        out.append({"id": m.group(1), "name": m.group(2).strip(), "pfm": [[rows[b][j] for b in "ACGT"] for j in range(lens.pop())]})
    return out


def known_metadata():
    """Metadata already fetched, from existing output files (id -> fields)."""
    known = {}
    for c in COLLECTIONS:
        path = os.path.join(OUT, c["file"])
        if os.path.exists(path):
            for m in json.load(open(path))["motifs"]:
                if "taxon" in m:
                    known[m["id"]] = {k: m[k] for k in ("name", "class", "family", "taxon")}
    return known


def main():
    os.makedirs(OUT, exist_ok=True)
    known = known_metadata()
    for c in COLLECTIONS:
        raw = get(c["source"])
        md5 = hashlib.md5(raw).hexdigest()
        motifs = parse_pfms(raw.decode())
        for k, mo in enumerate(motifs):
            if mo["id"] not in known:
                meta = json.loads(get(API.format(mo["id"])))
                known[mo["id"]] = {"name": meta.get("name") or mo["name"], "class": meta.get("class") or [], "family": meta.get("family") or [], "taxon": meta.get("tax_group") or ""}
                time.sleep(0.05)
            mo.update(known[mo["id"]])
            if k % 200 == 0:
                print(f"{c['file']}: {k}/{len(motifs)} {mo['id']} {mo['name']}", file=sys.stderr)
        n_all = len(motifs)
        if c.get("filterTaxon"):
            motifs = [m for m in motifs if m["taxon"] == c["taxon"]]
        doc = {
            "release": f"JASPAR {RELEASE}",
            "collection": c["collection"],
            "taxon": c["taxon"],
            "nonRedundant": c["nonRedundant"],
            "source": c["source"],
            "sourceMd5": md5,
            "sourceMatrices": n_all,
            "licence": "CC BY 4.0",
            "citation": "Ovek Baydar D et al. JASPAR 2026. Nucleic Acids Res. 2026;54(D1):D184-D193. doi:10.1093/nar/gkaf1209",
            "motifs": [{"id": m["id"], "name": m["name"], "class": m["class"], "family": m["family"], "taxon": m["taxon"], "pfm": [[round(x, 3) for x in col] for col in m["pfm"]]} for m in motifs],
        }
        path = os.path.join(OUT, c["file"])
        with open(path, "w") as f:
            json.dump(doc, f, separators=(",", ":"))
        print(f"{c['file']}: {len(motifs)} of {n_all} matrices ({os.path.getsize(path)} bytes); source md5 {md5}", file=sys.stderr)


if __name__ == "__main__":
    main()
