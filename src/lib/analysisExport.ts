/**
 * Analysis export and settings restore (pure parts; the ZIP is assembled in
 * state/store.ts). A settings file records how an analysis was made, never
 * the data: each input's name, file name, size and SHA-256 checksum, the
 * mode, assembly, overlap rule and display settings, and the selected
 * subsets by their sets' names. Loading it with the same files restores the
 * analysis; the checksums say whether the files are the same.
 *
 * methodsText() writes a methods paragraph from the settings, plus one
 * paragraph per further analysis that was run (enrichment, GO), each with
 * its references.
 */
import type { ProfileParams } from "./signalMatrix";
import type { OverlapPreset } from "./bedtoolsOptions";
import { setKey } from "./selection";

export type InputMode = "regions" | "lists";

export interface SavedSet {
  name: string;
  fileName: string;
  code: string;
  color: string;
  included: boolean;
  /** Regions, or names in list mode. */
  n: number;
  /** Base pairs covered (0 in list mode). */
  bp: number;
  /** SHA-256 of the file as loaded (hex). */
  sha256: string;
}

export interface SavedSubset {
  label: string;
  /** Names of the sets in this subset. */
  memberNames: string[];
  n: number;
  /** A whole set selected as a group (lib/selection.ts): memberNames holds its one name. */
  whole?: boolean;
}

export interface AnalysisSettings {
  format: "intervene-secure-settings";
  version: 1;
  app: { name: "Intervene Secure"; url: string; commit: string; buildDate: string };
  created: string;
  mode: InputMode;
  assembly: string;
  overlap: { preset: OverlapPreset; advanced: string; flags: string };
  blacklistFilter: boolean;
  upset: { sort: "size" | "degree"; minSize: number };
  pairwiseStat: "jaccard" | "fisher" | "reldist";
  view: string;
  sets: SavedSet[];
  selected: SavedSubset[];
}

export interface SettingsInput {
  build: { commit: string; date: string };
  created: string;
  mode: InputMode;
  assembly: string;
  overlapPreset: OverlapPreset;
  advancedBedtoolsOptions: string;
  overlapFlags: string;
  blacklistFilter: boolean;
  upsetSort: "size" | "degree";
  upsetMinSize: number;
  pairwiseStat: "jaccard" | "fisher" | "reldist";
  view: string;
  sets: SavedSet[];
  selected: SavedSubset[];
}

export const APP_URL = "https://khan-lab.github.io/intervene-secure/";
const PRESETS: OverlapPreset[] = ["1bp", "fraction50", "reciprocal50"];

export function buildSettings(i: SettingsInput): AnalysisSettings {
  return {
    format: "intervene-secure-settings",
    version: 1,
    app: { name: "Intervene Secure", url: APP_URL, commit: i.build.commit, buildDate: i.build.date },
    created: i.created,
    mode: i.mode,
    assembly: i.assembly,
    overlap: { preset: i.overlapPreset, advanced: i.advancedBedtoolsOptions, flags: i.overlapFlags },
    blacklistFilter: i.blacklistFilter,
    upset: { sort: i.upsetSort, minSize: i.upsetMinSize },
    pairwiseStat: i.pairwiseStat,
    view: i.view,
    sets: i.sets,
    selected: i.selected,
  };
}

/** Reads a settings file, or says why it cannot. */
export function parseSettings(text: string): AnalysisSettings | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: "This is not a settings file: it is not JSON." };
  }
  const s = v as Partial<AnalysisSettings>;
  if (!s || typeof s !== "object" || s.format !== "intervene-secure-settings") return { error: "This is not an Intervene Secure settings file." };
  if (typeof s.version !== "number" || s.version > 1) return { error: "This settings file comes from a newer version of Intervene Secure; reload the page to update." };
  if (s.mode !== "regions" && s.mode !== "lists") return { error: "The settings file names an unknown input mode." };
  if (!s.overlap || !PRESETS.includes(s.overlap.preset)) return { error: "The settings file names an unknown overlap rule." };
  if (!Array.isArray(s.sets) || !Array.isArray(s.selected)) return { error: "The settings file has no list of input sets." };
  return s as AnalysisSettings;
}

/**
 * The saved selection as subset masks of the loaded sets: bit i is the i-th
 * included set (lib/intervals.ts), matched by set name, so the loading order
 * does not matter. A saved whole set becomes its set key (lib/selection.ts). Subsets whose sets are not all loaded are listed.
 */
export function selectionFromSettings(s: AnalysisSettings, includedNames: string[]): { masks: number[]; missing: string[] } {
  const masks: number[] = [];
  const missing: string[] = [];
  for (const sub of s.selected) {
    const bits = sub.memberNames.map((n) => includedNames.indexOf(n));
    if (bits.some((b) => b < 0)) missing.push(sub.label);
    else masks.push(sub.whole ? setKey(bits[0]) : bits.reduce((m, b) => m | (1 << b), 0));
  }
  return { masks, missing };
}

/** Differences between the saved inputs and the loaded ones (matched by file name, compared by checksum). */
export function compareInputs(s: AnalysisSettings, loaded: { name: string; fileName: string; sha256: string }[]): string[] {
  const notes: string[] = [];
  const byFile = new Map(loaded.map((l) => [l.fileName, l]));
  for (const saved of s.sets) {
    const l = byFile.get(saved.fileName);
    if (!l) notes.push(`${saved.fileName} is not loaded.`);
    else if (l.sha256 !== saved.sha256) notes.push(`${saved.fileName} differs from the saved analysis (checksum).`);
  }
  const savedFiles = new Set(s.sets.map((x) => x.fileName));
  for (const l of loaded) if (!savedFiles.has(l.fileName)) notes.push(`${l.fileName} was not part of the saved analysis.`);
  return notes;
}

/** SHA-256 of a file's bytes, as hex (Web Crypto; nothing leaves the page). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- methods text ----------

export interface MethodsExtra {
  /** A paragraph for the methods, in the same voice. */
  methods: string;
  references: string[];
}

const REF = {
  deeptools: "Ramírez F, Ryan DP, Grüning B, Bhardwaj V, Kilpert F, Richter AS, Heyne S, Dündar F, Manke T. deepTools2: a next generation web server for deep-sequencing data analysis. Nucleic Acids Res. 2016;44(W1):W160–W165. doi:10.1093/nar/gkw257",
  intervene: "Khan A, Mathelier A. Intervene: a tool for intersection and visualization of multiple gene or genomic region sets. BMC Bioinformatics. 2017;18:287. doi:10.1186/s12859-017-1708-7",
  bedtools: "Quinlan AR, Hall IM. BEDTools: a flexible suite of utilities for comparing genomic features. Bioinformatics. 2010;26(6):841–842. doi:10.1093/bioinformatics/btq033",
  blacklist: "Amemiya HM, Kundaje A, Boyle AP. The ENCODE Blacklist: identification of problematic regions of the genome. Sci Rep. 2019;9:9354. doi:10.1038/s41598-019-45839-z",
  jaspar2026: "Ovek Baydar D, Rauluseviciute I, Aronsen DR, et al. JASPAR 2026: expansion of transcription factor binding profiles and integration of deep learning models. Nucleic Acids Res. 2026;54(D1):D184–D193. doi:10.1093/nar/gkaf1209",
};

const fmt = (n: number) => n.toLocaleString("en-US");

function overlapRule(s: AnalysisSettings): string {
  if (s.overlap.advanced.trim()) return `the bedtools intersect options ${s.overlap.advanced.trim()}`;
  switch (s.overlap.preset) {
    case "1bp":
      return "an overlap of at least 1 bp (bedtools intersect defaults)";
    case "fraction50":
      return `an overlap covering at least 50% of the region (bedtools intersect ${s.overlap.flags || "-f 0.50"})`;
    case "reciprocal50":
      return `a reciprocal overlap of at least 50% of both regions (bedtools intersect ${s.overlap.flags || "-f 0.50 -r"})`;
  }
}

/** A methods paragraph for the analysis, then one per further analysis, then the references. */
export function methodsText(s: AnalysisSettings, extras: MethodsExtra[]): string {
  const lists = s.mode === "lists";
  const unit = lists ? "names" : "regions";
  const included = s.sets.filter((x) => x.included);
  const excluded = s.sets.filter((x) => !x.included);
  const describe = (x: SavedSet) => `${x.name} (${x.fileName}, ${fmt(x.n)} ${unit})`;
  const tool = `Intervene Secure (build ${s.app.commit}, ${s.app.buildDate}; ${s.app.url}), a browser version of Intervene (Khan and Mathelier, 2017)`;

  const p: string[] = [];
  if (lists) {
    p.push(
      `Lists of names were compared with ${tool}. All computation ran in the web browser; no data were uploaded. ` +
        `The inputs were ${included.length} lists: ${included.map(describe).join("; ")}. ` +
        `Names were read one per line (first column), trimmed, and matched exactly (case-sensitive); repeated names within a list were counted once. ` +
        `Each name was assigned to the subset for exactly the combination of lists containing it.`,
    );
  } else {
    p.push(
      `Genomic region sets were compared with ${tool}, which runs BEDTools v2.31.0 (Quinlan and Hall, 2010) compiled to WebAssembly in the web browser; no data were uploaded. ` +
        `The inputs were ${included.length} sets on the ${s.assembly} assembly: ${included.map(describe).join("; ")}. ` +
        `Overlap was defined as ${overlapRule(s)}. ` +
        (s.blacklistFilter
          ? `Regions overlapping the ENCODE problematic regions v2 (Amemiya et al., 2019) for ${s.assembly} by at least 1 bp were removed from every set before intersecting. `
          : "") +
        `For each combination of sets, the subset holds the regions of the combination's first set that overlap every other set in the combination and no set outside it, as in the Intervene command-line tool.`,
    );
  }
  if (excluded.length) p[0] += ` ${excluded.length === 1 ? "One further input was" : `${excluded.length} further inputs were`} loaded but left out of the comparison: ${excluded.map((x) => x.name).join(", ")}.`;
  if (s.selected.length)
    p.push(
      `The ${s.selected.some((x) => x.whole) ? "subsets and whole sets" : "subsets"} selected for further analysis were ${s.selected.map((x) => `${x.whole ? `all of ${x.memberNames[0]}` : x.label} (${fmt(x.n)} ${unit})`).join(", ")}.`
    );
  for (const e of extras) p.push(e.methods);

  const refs = [REF.intervene, ...(lists ? [] : [REF.bedtools]), ...(!lists && s.blacklistFilter ? [REF.blacklist] : []), ...extras.flatMap((e) => e.references)];
  const unique = [...new Set(refs)];
  return `# Methods\n\n${p.join("\n\n")}\n\n## References\n\n${unique.map((r) => `- ${r}`).join("\n")}\n`;
}

// ---------- tables ----------

const safe = (t: string) => t.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "subset";

/** Path of a subset's file inside the export: subsets/<code>.bed (or .txt in list mode). */
export function subsetFilePath(s: { code: string; mask: number }, mode: InputMode): string {
  return `subsets/${safe(s.code || String(s.mask))}.${mode === "lists" ? "txt" : "bed"}`;
}

export function subsetsTsv(
  subsets: { mask: number; code: string; label: string; memberIds: string[]; degree: number; nRegions: number; nBp: number }[],
  sets: { id: string; name: string }[],
  mode: InputMode,
  selected: ReadonlySet<number>,
): string {
  const names = new Map(sets.map((s) => [s.id, s.name]));
  const lists = mode === "lists";
  const head = ["subset", "code", "members", "degree", lists ? "names" : "regions", ...(lists ? [] : ["bp"]), "selected", "file"];
  const rows = subsets.map((s) =>
    [
      s.label,
      s.code,
      s.memberIds.map((id) => names.get(id) ?? id).join(", "),
      s.degree,
      s.nRegions,
      ...(lists ? [] : [s.nBp]),
      selected.has(s.mask) ? "yes" : "no",
      subsetFilePath(s, mode),
    ].join("\t"),
  );
  return [head.join("\t"), ...rows].join("\n") + "\n";
}

export function setsTsv(s: AnalysisSettings): string {
  const lists = s.mode === "lists";
  const head = ["set", "file", "included", lists ? "names" : "regions", ...(lists ? [] : ["bp"]), "sha256"];
  const rows = s.sets.map((x) => [x.name, x.fileName, x.included ? "yes" : "no", x.n, ...(lists ? [] : [x.bp]), x.sha256].join("\t"));
  return [head.join("\t"), ...rows].join("\n") + "\n";
}

// ---------- methods paragraphs of further analyses ----------

const GREAT_REF = "McLean CY, Bristor D, Hiller M, et al. GREAT improves functional interpretation of cis-regulatory regions. Nat Biotechnol. 2010;28:495–501. doi:10.1038/nbt.1630";
const CISTROMEGO_REF = "Li S, Wan C, Zheng R, Fan J, Dong X, Meyer CA, Liu XS. Cistrome-GO: a web server for functional enrichment analysis of transcription factor ChIP-seq peaks. Nucleic Acids Res. 2019;47(W1):W206–W211. doi:10.1093/nar/gkz332";
const kb = (bp: number) => `${(bp / 1000).toLocaleString("en-US")} kb`;

/** Subset enrichment for reference region sets (components/SubsetEnrichmentPanel.tsx), as run. */
export function enrichmentMethods(r: { adjust: boolean; referenceNames: string[] }): MethodsExtra {
  const test = r.adjust
    ? "the Cochran–Mantel–Haenszel test over five region-length strata (quintiles of region length), with continuity correction"
    : "the two-sided Fisher's exact test";
  return {
    methods:
      `Each selected subset was tested for enrichment or depletion of ${r.referenceNames.length} reference region sets (${r.referenceNames.join(", ")}) ` +
      `against all other regions of the analysis (every region assigned to a subset), with ${test}. ` +
      `A region counted as hitting a reference set if it overlapped at least one of its regions by at least 1 bp; ` +
      `the effect is reported as an odds ratio, and p-values were adjusted with the Benjamini–Hochberg method across all tests of the run (q < 0.05 significant).`,
    references: [],
  };
}

/** Signal profiles over the selected subsets (components/SignalProfilePanel.tsx), as run. */
export function signalMethods(r: {
  params: ProfileParams;
  nRegions: number;
  tracks: string[];
  sort: "desc" | "asc" | "keep";
  k: number;
  nGroups: number;
  /** Public bigWigs: `level` when read privately from a summary layer, absent when read exactly. */
  public?: { name: string; host: string; level?: number }[];
}): MethodsExtra {
  const p = r.params;
  const kb = (n: number) => (n >= 1000 ? `${+(n / 1000).toFixed(2)} kb` : `${n} bp`);
  const point = { start: "start", center: "centre", end: "end" }[p.referencePoint];
  const layout =
    p.mode === "scale"
      ? `in scale-regions mode (each region scaled to ${kb(p.body)}, with ${kb(p.upstream)} upstream and ${kb(p.downstream)} downstream, in ${p.binSize} bp bins)`
      : `in reference-point mode, ${kb(p.upstream)} upstream and ${kb(p.downstream)} downstream of each region's ${point}, in ${p.binSize} bp bins`;
  const sort = r.sort === "keep" ? "Rows are in file order." : `Rows were sorted by mean signal, ${r.sort === "desc" ? "highest" : "lowest"} mean signal first.`;
  const kmeans = r.k > 1 ? ` Rows were clustered by k-means (k = ${r.k}; Euclidean distance over all tracks' bins, bins without data as 0; k-means++ initialisation with a fixed seed; Lloyd's iterations).` : "";
  const test =
    r.nGroups > 1
      ? ` For each track, the mean signal over each region's own bases was compared between subsets with the two-sided Mann–Whitney U test (normal approximation with tie and continuity correction)${r.nGroups > 2 ? ", for every pair of subsets, with Benjamini–Hochberg adjustment across the pairs of each track" : ""}.`
      : "";
  const pub = (r.public ?? [])
    .map((t) =>
      t.level
        ? ` ${t.name} was read from its ${t.level.toLocaleString("en-US")} bp summary (zoom) layer, downloaded for the whole genome from ${t.host} (no region-specific requests), each layer interval weighted by its length; its bins are therefore at ${t.level.toLocaleString("en-US")} bp resolution.`
        : ` ${t.name} was read at base resolution by HTTP range requests to ${t.host}.`
    )
    .join("");
  return {
    methods:
      `Signal profiles of ${r.nRegions.toLocaleString("en-US")} regions of the selected subsets were computed in the browser from the bigWig files ${r.tracks.join(", ")}, ` +
      `with Intervene Secure's reimplementation of deepTools computeMatrix (Ramírez et al., 2016; checked against deepTools 4.0.0) ${layout}. ` +
      `Each bin is the mean signal over its bases with data; bins without data were ${p.missingAsZero ? "counted as 0" : "treated as missing and left out of the averages"}. ` +
      `Profiles show the mean ± standard error per bin for each subset.${pub} ${sort}${kmeans}${test}`,
    references: [REF.deeptools],
  };
}

export interface GoMethodsInput {
  method: "great" | "cistromego";
  background: "genome" | "inputs";
  namespace: string;
  great?: { upstream: number; downstream: number; maxExtension: number; minGenes: number; maxGenes: number; qThreshold: number; minFold: number };
  cgo?: { decay: "auto" | number; topPeaks: number | "all"; minGenes: number; maxGenes: number; maxL: number; dedup: boolean; qThreshold: number };
}

/** GO enrichment of selected subsets (components/GoEnrichmentPanel.tsx), as run. */
export function goMethods(g: GoMethodsInput): MethodsExtra {
  if (g.method === "great" && g.great) {
    const s = g.great;
    const domains =
      `each GENCODE protein-coding gene was given GREAT's basal-plus-extension regulatory domain (${kb(s.upstream)} upstream and ${kb(s.downstream)} downstream of the TSS, extended up to ${kb(s.maxExtension)})`;
    const test =
      g.background === "genome"
        ? `subset regions were tested against the whole genome (assembly gaps excluded) with GREAT's binomial test over regions and hypergeometric test over genes; a term was called significant with q < ${s.qThreshold} in both tests and a binomial fold enrichment of at least ${s.minFold}`
        : `regions selecting a term's genes were compared between the subset and all other regions of the analysis with the two-sided Fisher's exact test (odds ratio); a term was called significant with q < ${s.qThreshold}`;
    return {
      methods:
        `Gene Ontology (${g.namespace}) enrichment of the selected subsets used a GREAT-like test (McLean et al., 2010) reimplemented in Intervene Secure: ${domains}, and ${test}. ` +
        `Terms with ${s.minGenes}–${fmt(s.maxGenes)} genes were tested, and p-values were adjusted with the Benjamini–Hochberg method per subset and namespace.`,
      references: [GREAT_REF],
    };
  }
  const c = g.cgo!;
  const decay = c.decay === "auto" ? "half-decay distance chosen automatically (1 or 10 kb)" : `half-decay distance ${kb(c.decay)}`;
  return {
    methods:
      `Gene Ontology (${g.namespace}) enrichment of the selected subsets used a Cistrome-GO-like test (Li et al., 2019; solo mode) reimplemented in Intervene Secure: ` +
      `genes were ranked by the regulatory potential of the subset's regions (${c.topPeaks === "all" ? "all regions" : `top ${fmt(c.topPeaks)} regions by score when scores were present`}; ${decay}; background-adjusted with the package's Cistrome DB medians), ` +
      `and terms with ${c.minGenes}–${fmt(c.maxGenes)} ranked genes${c.dedup ? " (after the package's redundancy filter)" : ""} were tested with the XL-mHG test (cutoffs up to ${fmt(c.maxL)}); ` +
      `p-values were adjusted with the Benjamini–Hochberg method and terms with q < ${c.qThreshold} were called significant.`,
    references: [CISTROMEGO_REF],
  };
}

/** GENCODE release of the bundled gene annotation, per assembly (docs/provenance.md). */
const GENCODE: Record<string, string> = { hg38: "v50", hg19: "v19", mm10: "vM25", mm9: "vM1" };

/** Nearest genes of the selected subsets and sets (components/nearestGenes.ts, the Genes tab of each card in the right-hand column). */
export function geneListMethods(assembly: string): MethodsExtra {
  return {
    methods:
      `For each selected subset, the genes near its regions were listed as the nearest protein-coding gene TSS of each region ` +
      `(bedtools closest -d -t all against GENCODE ${GENCODE[assembly] ?? ""} protein-coding TSSs, ${assembly}; all equally nearest genes kept, no distance cutoff).`.replace("GENCODE  ", "GENCODE "),
    references: [],
  };
}

/** Motif enrichment (components/MotifEnrichmentPanel.tsx, lib/motifEnrichment.ts), as run. */
export function motifMethods(r: { release: string; collection: string; nMotifs: number; half: number; p: number; nScanned: number; nUniverse: number; source: string; assembly: string }): MethodsExtra {
  const sampled = r.nScanned < r.nUniverse;
  return {
    methods:
      `Motif enrichment used the ${fmt(r.nMotifs)} position frequency matrices of ${r.release} (${r.collection}). ` +
      `For each region of the analysis, the ${2 * r.half} bp window centred on each region (${r.half} bp either side of the midpoint) was taken from the ${r.assembly} sequence (${r.source}) and scanned on both strands in the browser: ` +
      `matrices were converted to log-odds scores (natural log; pseudocount 0.8 distributed by the background) against the strand-symmetric base composition of the scanned windows, and a site was a window scoring at or above the exact threshold for p < ${r.p.toExponential(0)} under that background (score distribution by dynamic programming on scores rounded to 0.01 nat). ` +
      `For each selected subset or whole set and each motif, the regions with at least one site were compared with ${sampled ? `the other regions of a random sample of ${fmt(10_000)} regions of the analysis (each selected group scanned in full, up to 5,000 regions)` : "all other regions of the analysis"} by the Cochran–Mantel–Haenszel test over five strata of GC content (quintiles of the windows' G+C), with continuity correction; ` +
      `the effect is reported as a common odds ratio, and p-values were adjusted with the Benjamini–Hochberg method across all tests of the run.`,
    references: [REF.jaspar2026],
  };
}
