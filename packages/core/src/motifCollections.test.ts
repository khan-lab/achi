import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_COLLECTION, MOTIF_COLLECTIONS, collectionById, mergeCollections, type JasparFile } from "./motifCollections";

/** The JASPAR 2026 collections offered by the motif card, checked against the built files (public/refdata/jaspar). */
const DIR = join(__dirname, "..", "..", "..", "public", "refdata", "jaspar");
const load = (f: string): JasparFile => JSON.parse(readFileSync(join(DIR, f), "utf8"));

describe("MOTIF_COLLECTIONS", () => {
  it("keeps JASPAR 2026 CORE vertebrates, non-redundant, as the default", () => {
    const d = collectionById(DEFAULT_COLLECTION);
    expect(d.files).toEqual(["jaspar2026_core_vertebrates_nr.json"]);
    expect(d.methods).toBe("CORE collection, vertebrates, non-redundant");
    expect(MOTIF_COLLECTIONS[0].id).toBe(DEFAULT_COLLECTION);
    expect(collectionById("no-such")).toBe(d);
  });

  it("has a built file for every collection, of the stated collection and taxon", () => {
    for (const c of MOTIF_COLLECTIONS)
      for (const f of c.files) {
        const doc = load(f);
        expect(doc.release).toBe("JASPAR 2026");
        expect(doc.licence).toBe("CC BY 4.0");
        expect(doc.motifs.length).toBeGreaterThan(500);
        expect(doc.motifs.every((m) => m.taxon === "vertebrates")).toBe(true);
        expect(doc.motifs.every((m) => m.id.startsWith(doc.collection === "CORE" ? "MA" : "UN"))).toBe(true);
      }
    const nr = load("jaspar2026_core_vertebrates_nr.json");
    const all = load("jaspar2026_core_vertebrates_redundant.json");
    expect(nr.nonRedundant).toBe(true);
    expect(all.nonRedundant).toBe(false);
    // Every non-redundant profile is one of the versions in the redundant file.
    const ids = new Set(all.motifs.map((m) => m.id));
    expect(nr.motifs.every((m) => ids.has(m.id))).toBe(true);
    expect(all.motifs.length).toBeGreaterThan(nr.motifs.length);
    // UNVALIDATED: only its vertebrate profiles were kept.
    const un = load("jaspar2026_unvalidated_vertebrates_nr.json");
    expect(un.sourceMatrices).toBeGreaterThan(un.motifs.length);
  });
});

describe("mergeCollections", () => {
  it("joins files in order, each matrix once", () => {
    const core = load("jaspar2026_core_vertebrates_nr.json");
    const un = load("jaspar2026_unvalidated_vertebrates_nr.json");
    const merged = mergeCollections([core, un]);
    expect(merged.length).toBe(core.motifs.length + un.motifs.length);
    expect(merged[0].id).toBe(core.motifs[0].id);
    expect(mergeCollections([core, core]).length).toBe(core.motifs.length);
  });
});
