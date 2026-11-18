/**
 * The JASPAR 2026 matrix collections the motif card offers (files built by
 * public/refdata/build_jaspar.py). CORE vertebrates, non-redundant, is the
 * default. The assemblies here are human and mouse, so only vertebrate
 * profiles are offered (UNVALIDATED is published for all taxa together;
 * its vertebrate profiles were kept).
 */

export interface JasparMotif {
  id: string;
  name: string;
  class: string[];
  family: string[];
  taxon: string;
  pfm: number[][];
}

export interface JasparFile {
  release: string;
  collection: string;
  taxon: string;
  nonRedundant: boolean;
  source: string;
  sourceMd5: string;
  sourceMatrices: number;
  licence: string;
  citation: string;
  motifs: JasparMotif[];
}

export interface MotifCollection {
  id: string;
  /** For the settings menu (all are vertebrate profiles). */
  label: string;
  /** Files under refdata/jaspar/, merged in this order. */
  files: string[];
  /** How the methods text names it ("… of JASPAR 2026 (<methods>)"). */
  methods: string;
  /** For the menu's tooltip. */
  help: string;
}

export const DEFAULT_COLLECTION = "core-vert-nr";

export const MOTIF_COLLECTIONS: MotifCollection[] = [
  {
    id: DEFAULT_COLLECTION,
    label: "CORE, non-redundant",
    files: ["jaspar2026_core_vertebrates_nr.json"],
    methods: "CORE collection, vertebrates, non-redundant",
    help: "Curated profiles with experimental support, the latest version of each (the default).",
  },
  {
    id: "core-vert-all",
    label: "CORE, all versions",
    files: ["jaspar2026_core_vertebrates_redundant.json"],
    methods: "CORE collection, vertebrates, every profile version (redundant)",
    help: "Every version of each curated profile: more tests, so a stricter correction, and near-duplicate rows.",
  },
  {
    id: "unval-vert-nr",
    label: "UNVALIDATED",
    files: ["jaspar2026_unvalidated_vertebrates_nr.json"],
    methods: "UNVALIDATED collection, vertebrate profiles, non-redundant",
    help: "Profiles from high-throughput data without orthogonal support in the literature yet; vertebrate profiles only.",
  },
  {
    id: "core-unval-vert-nr",
    label: "CORE + UNVALIDATED",
    files: ["jaspar2026_core_vertebrates_nr.json", "jaspar2026_unvalidated_vertebrates_nr.json"],
    methods: "CORE and UNVALIDATED collections, vertebrates, non-redundant",
    help: "Both, tested together (one Benjamini–Hochberg family).",
  },
];

export function collectionById(id: string): MotifCollection {
  return MOTIF_COLLECTIONS.find((c) => c.id === id) ?? MOTIF_COLLECTIONS[0];
}

/** The files' matrices in order, each matrix ID once. */
export function mergeCollections(docs: JasparFile[]): JasparMotif[] {
  const seen = new Set<string>();
  const out: JasparMotif[] = [];
  for (const d of docs)
    for (const m of d.motifs)
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
  return out;
}
