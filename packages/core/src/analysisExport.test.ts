import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSettings,
  compareInputs,
  enrichmentMethods,
  annotationMethods,
  geneListMethods,
  goMethods,
  methodsText,
  pairwiseMethods,
  signalMethods,
  motifMethods,
  parseSettings,
  selectionFromSettings,
  setsTsv,
  sha256Hex,
  subsetsTsv,
  summaryMethods,
  type SettingsInput,
} from "./analysisExport";
import { computeListSubsets, parseListText } from "./lists";

/**
 * Analysis export (one ZIP: subsets, tables, figures, methods, settings)
 * and settings restore. Settings never hold data: names, file names, sizes
 * and SHA-256 checksums of the inputs, and the parameters. Real data: the
 * example region files and example gene lists.
 */

const ROOT = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(ROOT, p));
const CELLS = ["MCF7", "GM12878", "K562", "HepG2"];
const sha = (p: string) => createHash("sha256").update(read(p)).digest("hex");

const input = (over: Partial<SettingsInput> = {}): SettingsInput => ({
  build: { commit: "abc1234", date: "2026-11-17" },
  created: "2026-11-17T10:00:00.000Z",
  mode: "regions",
  assembly: "hg38",
  overlapPreset: "1bp",
  advancedBedtoolsOptions: "",
  overlapFlags: "",
  blacklistFilter: false,
  upsetSort: "size",
  upsetMinSize: 0,
  pairwiseStat: "jaccard",
  view: "upset",
  sets: CELLS.map((c, i) => ({
    name: c,
    fileName: `${c}.bed`,
    code: c.slice(0, 3).toUpperCase(),
    color: ["#2B6FE0", "#A97416", "#049F80", "#6C1BB9"][i],
    included: true,
    n: [639, 877, 1003, 1273][i],
    bp: [27_300_000, 28_400_000, 25_600_000, 32_300_000][i],
    sha256: sha(`public/examples/hg38_ses/${c}.bed`),
  })),
  selected: [
    { label: "HepG2 only", memberNames: ["HepG2"], n: 929 },
    { label: "K562 ∩ HepG2", memberNames: ["K562", "HepG2"], n: 105 },
  ],
  ...over,
});

describe("sha256Hex", () => {
  it("gives the file's SHA-256, as sha256sum does", async () => {
    const bytes = read("public/examples/hg38_ses/HepG2.bed");
    expect(await sha256Hex(new Blob([new Uint8Array(bytes)]))).toBe(sha("public/examples/hg38_ses/HepG2.bed"));
  });
});

describe("settings file", () => {
  it("round-trips through JSON, and is marked so it can be recognised", () => {
    const s = buildSettings(input());
    expect(s).toMatchObject({ format: "achi-settings", version: 1, mode: "regions", assembly: "hg38" });
    expect(parseSettings(JSON.stringify(s))).toEqual(s);
  });
  it("still reads a settings file saved before the rename to Achi", () => {
    const old = { ...buildSettings(input()), format: "achi-settings" };
    expect(parseSettings(JSON.stringify(old))).toMatchObject({ format: "achi-settings", mode: "regions" });
  });
  it("holds no regions or names from the data, only file names, sizes and checksums", () => {
    const text = JSON.stringify(buildSettings(input()));
    expect(text).not.toMatch(/chr\d+\t/);
    expect(text.length).toBeLessThan(4000);
  });
  it("refuses what is not a settings file it can read", () => {
    expect(parseSettings("not json")).toEqual({ error: expect.stringMatching(/not a settings file/) });
    expect(parseSettings(JSON.stringify({ format: "other" }))).toEqual({ error: expect.stringMatching(/not an Achi settings file/) });
    expect(parseSettings(JSON.stringify({ ...buildSettings(input()), version: 9 }))).toEqual({ error: expect.stringMatching(/newer version/) });
    expect(parseSettings(JSON.stringify({ ...buildSettings(input()), mode: "x" }))).toHaveProperty("error");
    expect(parseSettings(JSON.stringify({ ...buildSettings(input()), overlap: { preset: "2bp" } }))).toHaveProperty("error");
  });
});

describe("selectionFromSettings", () => {
  const s = buildSettings(input());
  it("finds the saved subsets by their sets' names, whatever the loading order", () => {
    expect(selectionFromSettings(s, CELLS)).toEqual({ masks: [8, 12], missing: [] });
    // Loaded in another order: HepG2 is bit 0, K562 bit 1.
    expect(selectionFromSettings(s, ["HepG2", "K562", "MCF7", "GM12878"])).toEqual({ masks: [1, 3], missing: [] });
  });
  it("finds saved whole sets as set keys (the negative of the set's bit), next to subsets", () => {
    const w = buildSettings(input({ selected: [{ label: "K562 (all)", memberNames: ["K562"], n: 1003, whole: true }, { label: "HepG2 only", memberNames: ["HepG2"], n: 929 }] }));
    expect(selectionFromSettings(w, CELLS)).toEqual({ masks: [-4, 8], missing: [] });
    expect(selectionFromSettings(w, ["K562", "HepG2"])).toEqual({ masks: [-1, 2], missing: [] });
    expect(methodsText(w, [])).toMatch(/The subsets and whole sets selected for further analysis were all of K562 \(1,003 regions\), HepG2 only \(929 regions\)\./);
  });
  it("lists the saved subsets whose sets are not loaded", () => {
    // HepG2 is the third loaded set here: bit 2.
    expect(selectionFromSettings(s, ["MCF7", "GM12878", "HepG2"])).toEqual({ masks: [4], missing: ["K562 ∩ HepG2"] });
  });
});

describe("compareInputs", () => {
  const s = buildSettings(input());
  const loaded = CELLS.map((c) => ({ name: c, fileName: `${c}.bed`, sha256: sha(`public/examples/hg38_ses/${c}.bed`) }));
  it("is silent when the same files are loaded", () => {
    expect(compareInputs(s, loaded)).toEqual([]);
  });
  it("says which files differ, are missing, or were not in the saved analysis", () => {
    const changed = [...loaded.slice(0, 2), { ...loaded[2], sha256: sha("public/examples/hg38_ses/H1.bed") }, { name: "H1", fileName: "H1.bed", sha256: "x" }];
    const notes = compareInputs(s, changed).join(" | ");
    expect(notes).toMatch(/K562\.bed differs from the saved analysis/);
    expect(notes).toMatch(/HepG2\.bed is not loaded/);
    expect(notes).toMatch(/H1\.bed was not part of the saved analysis/);
  });
});

describe("methodsText", () => {
  it("states the tool, version, inputs, assembly and overlap rule for regions, with references", () => {
    const m = methodsText(buildSettings(input()), []);
    expect(m).toMatch(/Achi \(build abc1234, 2026-11-17/);
    expect(m).toMatch(/BEDTools v2\.31\.0/);
    expect(m).toMatch(/compiled to WebAssembly/);
    expect(m).toMatch(/MCF7 \(MCF7\.bed, 639 regions\)/);
    expect(m).toMatch(/hg38/);
    expect(m).toMatch(/at least 1 bp/);
    expect(m).toMatch(/first set that overlap every other set in the combination and no set outside it/);
    expect(m).toMatch(/HepG2 only \(929 regions\)/);
    expect(m).not.toMatch(/ENCODE problematic regions/);
    expect(m).toMatch(/doi:10\.1186\/s12859-017-1708-7/);
    expect(m).toMatch(/doi:10\.1093\/bioinformatics\/btq033/);
  });
  it("words each overlap rule with its bedtools flags, and the problematic-regions filter when on", () => {
    const f = methodsText(buildSettings(input({ overlapPreset: "reciprocal50", overlapFlags: "-f 0.50 -r", blacklistFilter: true })), []);
    expect(f).toMatch(/reciprocal overlap of at least 50% of both regions \(bedtools intersect -f 0\.50 -r\)/);
    expect(f).toMatch(/ENCODE problematic regions v2 \(Amemiya et al\., 2019\)/);
    expect(f).toMatch(/Sci Rep/);
    const adv = methodsText(buildSettings(input({ advancedBedtoolsOptions: "-f 0.3 -s", overlapFlags: "-f 0.3 -s" })), []);
    expect(adv).toMatch(/bedtools intersect options -f 0\.3 -s/);
  });
  it("describes list mode as exact name matching, without BEDTools", () => {
    const m = methodsText(buildSettings(input({ mode: "lists", sets: input().sets.map((x) => ({ ...x, fileName: `${x.name}_genes.txt`, bp: 0 })) })), []);
    expect(m).toMatch(/lists of names/i);
    expect(m).toMatch(/matched exactly \(case-sensitive\)/);
    expect(m).toMatch(/MCF7 \(MCF7_genes\.txt, 639 names\)/);
    expect(m).not.toMatch(/BEDTools/);
  });
  it("adds the paragraphs and references of the analyses that were run, once each", () => {
    const m = methodsText(buildSettings(input()), [
      { methods: "GO enrichment used a GREAT-like test.", references: ["McLean CY, et al. Nat Biotechnol. 2010;28:495–501. doi:10.1038/nbt.1630"] },
      { methods: "Second.", references: ["McLean CY, et al. Nat Biotechnol. 2010;28:495–501. doi:10.1038/nbt.1630"] },
    ]);
    expect(m).toMatch(/GO enrichment used a GREAT-like test\.\n\nSecond\./);
    expect(m.match(/doi:10\.1038\/nbt\.1630/g)).toHaveLength(1);
  });
});

describe("tables", () => {
  it("lists every subset with its members and size; regions also in bp", () => {
    const t = subsetsTsv(
      [{ mask: 8, code: "HEP", label: "HepG2 only", memberIds: ["d"], degree: 1, nRegions: 929, nBp: 21_900_000 }],
      [{ id: "d", name: "HepG2" }],
      "regions",
      new Set([8]),
    ).split("\n");
    expect(t[0]).toBe("subset\tcode\tmembers\tdegree\tregions\tbp\tselected\tfile");
    expect(t[1]).toBe("HepG2 only\tHEP\tHepG2\t1\t929\t21900000\tyes\tsubsets/HEP.bed");
  });
  it("in list mode counts names and points at .txt files (real example lists)", () => {
    const sets = CELLS.map((c) => ({ id: c, name: c, items: parseListText(read(`public/examples/lists/${c}_genes.txt`).toString()).items }));
    const subs = computeListSubsets(sets).map((s) => ({ ...s, code: s.memberIds.join("·"), label: s.memberIds.join(" ∩ "), degree: s.memberIds.length }));
    const rows = subsetsTsv(subs, sets, "lists", new Set()).trim().split("\n");
    expect(rows[0]).toBe("subset\tcode\tmembers\tdegree\tnames\tselected\tfile");
    expect(rows).toHaveLength(subs.length + 1);
    expect(rows[1].split("\t")[6]).toMatch(/^subsets\/.+\.txt$/);
  });
  it("lists the inputs with their checksums", () => {
    const t = setsTsv(buildSettings(input())).split("\n");
    expect(t[0]).toBe("set\tfile\tincluded\tregions\tbp\tsha256");
    expect(t[1].startsWith(`MCF7\tMCF7.bed\tyes\t639\t27300000\t${sha("public/examples/hg38_ses/MCF7.bed")}`)).toBe(true);
  });
});

describe("methods paragraphs of further analyses", () => {
  it("enrichment: reference sets, background, test and correction, as run", () => {
    const e = enrichmentMethods({ adjust: true, referenceNames: ["VISTA enhancers", "ClinVar pathogenic variants"] });
    expect(e.methods).toMatch(/2 reference region sets \(VISTA enhancers, ClinVar pathogenic variants\)/);
    expect(e.methods).toMatch(/all other regions of the analysis/);
    expect(e.methods).toMatch(/at least 1 bp/);
    expect(e.methods).toMatch(/Cochran–Mantel–Haenszel test over five region-length strata/);
    expect(e.methods).toMatch(/Benjamini–Hochberg/);
    expect(enrichmentMethods({ adjust: false, referenceNames: ["x"] }).methods).toMatch(/two-sided Fisher's exact test/);
  });
  it("signal profiles: layout, bins, missing data, tracks, sorting, clustering and the test, citing deepTools", () => {
    const scale = signalMethods({
      params: { mode: "scale", referencePoint: "center", upstream: 5000, downstream: 5000, body: 5000, binSize: 200, missingAsZero: false },
      nRegions: 1234,
      tracks: ["K562 H3K27ac", "HepG2 H3K27ac"],
      sort: "desc",
      k: 3,
      nGroups: 2,
    });
    expect(scale.methods).toMatch(/scale-regions mode/);
    expect(scale.methods).toMatch(/scaled to 5 kb, with 5 kb upstream and 5 kb downstream, in 200 bp bins/);
    expect(scale.methods).toMatch(/1,234 regions/);
    expect(scale.methods).toMatch(/K562 H3K27ac, HepG2 H3K27ac/);
    expect(scale.methods).toMatch(/treated as missing/);
    expect(scale.methods).toMatch(/highest mean signal first/);
    expect(scale.methods).toMatch(/k-means \(k = 3/);
    expect(scale.methods).toMatch(/two-sided Mann–Whitney U test/);
    expect(scale.methods).not.toMatch(/Benjamini/); // one pair of subsets
    expect(scale.references.join(" ")).toMatch(/deepTools2/);
    const ref = signalMethods({
      params: { mode: "reference", referencePoint: "center", upstream: 2000, downstream: 1000, body: 0, binSize: 50, missingAsZero: true },
      nRegions: 10,
      tracks: ["x"],
      sort: "keep",
      k: 0,
      nGroups: 3,
    });
    expect(ref.methods).toMatch(/reference-point mode, 2 kb upstream and 1 kb downstream of each region's centre, in 50 bp bins/);
    expect(ref.methods).toMatch(/counted as 0/);
    expect(ref.methods).not.toMatch(/k-means/);
    expect(ref.methods).toMatch(/Benjamini–Hochberg/);
  });
  it("signal profiles: says how public tracks were read (private summary layer, or exact range requests)", () => {
    const m = signalMethods({
      params: { mode: "scale", referencePoint: "center", upstream: 5000, downstream: 5000, body: 5000, binSize: 1000, missingAsZero: false },
      nRegions: 50,
      tracks: ["SCREEN DNase (merged)", "K562 H3K27ac"],
      sort: "desc",
      k: 0,
      nGroups: 1,
      public: [
        { name: "SCREEN DNase (merged)", host: "downloads.wenglab.org", level: 3072 },
        { name: "K562 H3K27ac", host: "encode-public.s3.amazonaws.com" },
      ],
    }).methods;
    expect(m).toMatch(/SCREEN DNase \(merged\) was read from its 3,072 bp summary \(zoom\) layer, downloaded for the whole genome from downloads.wenglab.org/);
    expect(m).toMatch(/K562 H3K27ac was read at base resolution by HTTP range requests to encode-public.s3.amazonaws.com/);
  });
  it("GO: method, background, domain rule or decay, term sizes and thresholds, with the method's reference", () => {
    const great = goMethods({
      method: "great",
      background: "genome",
      namespace: "Biological process",
      great: { upstream: 5000, downstream: 1000, maxExtension: 1_000_000, minGenes: 5, maxGenes: 1000, qThreshold: 0.05, minFold: 2 },
    });
    expect(great.methods).toMatch(/GREAT-like/);
    expect(great.methods).toMatch(/5 kb upstream and 1 kb downstream of the TSS, extended up to 1,000 kb/);
    expect(great.methods).toMatch(/binomial test over regions and hypergeometric test over genes/);
    expect(great.methods).toMatch(/5–1,000 genes/);
    expect(great.methods).toMatch(/q < 0\.05 in both tests and a binomial fold enrichment of at least 2/);
    expect(great.references.join(" ")).toMatch(/doi:10\.1038\/nbt\.1630/);
    const inputs = goMethods({ method: "great", background: "inputs", namespace: "Molecular function", great: { upstream: 5000, downstream: 1000, maxExtension: 1_000_000, minGenes: 5, maxGenes: 1000, qThreshold: 0.05, minFold: 2 } });
    expect(inputs.methods).toMatch(/all other regions of the analysis/);
    expect(inputs.methods).toMatch(/two-sided Fisher's exact test/);
    const cgo = goMethods({ method: "cistromego", background: "genome", namespace: "Biological process", cgo: { decay: "auto", topPeaks: 10000, minGenes: 11, maxGenes: 1999, maxL: 2000, dedup: true, qThreshold: 0.2 } });
    expect(cgo.methods).toMatch(/Cistrome-GO-like/);
    expect(cgo.methods).toMatch(/half-decay distance chosen automatically \(1 or 10 kb\)/);
    expect(cgo.methods).toMatch(/XL-mHG test/);
    expect(cgo.methods).toMatch(/q < 0\.2/);
    expect(cgo.references.join(" ")).toMatch(/doi:10\.1093\/nar\/gkz332/);
  });
});

describe("geneListMethods", () => {
  it("states the nearest-TSS rule and the GENCODE release of the assembly", () => {
    const m = geneListMethods("hg38").methods;
    expect(m).toMatch(/nearest protein-coding gene TSS/);
    expect(m).toMatch(/bedtools closest -d -t all/);
    expect(m).toMatch(/GENCODE v50/);
    expect(m).toMatch(/no distance cutoff/);
    expect(geneListMethods("mm10").methods).toMatch(/GENCODE vM25/);
  });
});

describe("motifMethods", () => {
  it("states the collection, window, threshold, background, test and sequence source", () => {
    const m = motifMethods({ release: "JASPAR 2026", collection: "CORE collection, vertebrates, non-redundant", nMotifs: 1019, half: 100, p: 1e-4, nScanned: 3792, nUniverse: 3792, source: "hgdownload.soe.ucsc.edu, private (whole chromosomes)", assembly: "hg38" });
    expect(m.methods).toMatch(/1,019 position frequency matrices of JASPAR 2026 \(CORE collection, vertebrates, non-redundant\)/);
    expect(m.methods).toMatch(/200 bp window centred on each region/);
    expect(m.methods).toMatch(/p < 1e-4/);
    expect(m.methods).toMatch(/Cochran–Mantel–Haenszel test over 15 strata of base composition \(quintiles of the windows' G\+C crossed with tertiles of their observed\/expected CpG\)/);
    expect(m.methods).toMatch(/scanned on both strands in the browser/);
    expect(m.methods).toMatch(/Benjamini–Hochberg/);
    expect(m.methods).toMatch(/hg38 sequence \(hgdownload\.soe\.ucsc\.edu, private \(whole chromosomes\)\)/);
    expect(m.methods).not.toMatch(/sample/);
    expect(m.references.join(" ")).toMatch(/JASPAR 2026/);
    const sampled = motifMethods({ release: "JASPAR 2026", collection: "CORE collection, vertebrates, non-redundant", nMotifs: 1019, half: 250, p: 1e-4, nScanned: 15000, nUniverse: 80000, source: "local FASTA hg38.fa", assembly: "hg38" });
    expect(sampled.methods).toMatch(/500 bp window/);
    expect(sampled.methods).toMatch(/random sample of 10,000 regions of the analysis/);
    const cli = motifMethods({ release: "JASPAR 2026", collection: "x", nMotifs: 1, half: 100, p: 1e-4, nScanned: 1, nUniverse: 1, source: "local .2bit hg38.2bit", assembly: "hg38", where: "on the local computer" });
    expect(cli.methods).toMatch(/scanned on both strands on the local computer/);
  });
});

describe("methods text from the command-line tool", () => {
  it("says it ran native BEDTools on the local computer, with the tool's version", () => {
    const s = buildSettings(input({ runner: { kind: "cli", version: "0.1.0", bedtools: "2.31.1" } }));
    expect(s.runner).toEqual({ kind: "cli", version: "0.1.0", bedtools: "2.31.1" });
    const m = methodsText(s, []);
    expect(m).toMatch(/with the Achi command-line tool \(version 0\.1\.0; https:\/\/khan-lab\.github\.io\/achi\/\), which builds on Intervene \(Khan and Mathelier, 2017\)/);
    expect(m).toMatch(/runs native BEDTools v2\.31\.1 \(Quinlan and Hall, 2010\) on the local computer/);
    expect(m).not.toMatch(/browser|WebAssembly/);
    expect(buildSettings(input()).runner).toBeUndefined(); // web exports are unchanged
  });
  it("signal profiles say where they were computed", () => {
    const params = { mode: "scale" as const, referencePoint: "center" as const, upstream: 5000, downstream: 5000, body: 5000, binSize: 200, missingAsZero: false };
    expect(signalMethods({ params, nRegions: 10, tracks: ["a"], sort: "desc", k: 0, nGroups: 2, where: "on the local computer" }).methods).toMatch(/were computed on the local computer from/);
    expect(signalMethods({ params, nRegions: 10, tracks: ["a"], sort: "desc", k: 0, nGroups: 2 }).methods).toMatch(/were computed in the browser from/);
  });
});

describe("methods paragraphs of the pairwise, annotation and summary analyses", () => {
  it("pairwise: names each statistic run, its bedtools call, the overlap options and that p-values are not corrected", () => {
    const all = pairwiseMethods({ stats: ["jaccard", "fisher", "reldist"], assembly: "hg38", overlapFlags: "-f 0.50 -r" }).methods;
    expect(all).toMatch(/Every ordered pair of input sets/);
    expect(all).toMatch(/bedtools jaccard -f 0\.50 -r/);
    expect(all).toMatch(/bedtools fisher -f 0\.50 -r against the hg38 genome file/);
    expect(all).toMatch(/two-tailed/);
    expect(all).toMatch(/not corrected for multiple testing/);
    expect(all).toMatch(/bedtools reldist/);
    expect(all).toMatch(/uniform distribution on \[0, 0\.5\)/);
    expect(all).toMatch(/Kolmogorov–Smirnov/);
    const j = pairwiseMethods({ stats: ["jaccard"], assembly: "hg38", overlapFlags: "" }).methods;
    expect(j).toMatch(/bedtools jaccard, after bedtools sort/);
    expect(j).not.toMatch(/fisher|reldist/);
  });

  it("annotation: the 11 categories in priority order, the GENCODE release, and the distance to the nearest TSS", () => {
    const m = annotationMethods("hg38").methods;
    expect(m).toMatch(/GENCODE v50 protein-coding transcripts \(hg38\)/);
    expect(m).toMatch(/TSS, core promoter \(within 1 kb of a TSS\), promoter-proximal \(1–3 kb\), 5′ UTR, first coding exon, other coding exon, 3′ UTR, first intron, other intron, immediate downstream \(within 3 kb past the transcript end\) and distal intergenic/);
    expect(m).toMatch(/bedtools closest -D b -t first/);
    expect(annotationMethods("mm10").methods).toMatch(/GENCODE vM25/);
  });

  it("summary: bedtools summary against the assembly's chromosome sizes, descriptive only", () => {
    const m = summaryMethods("mm10").methods;
    expect(m).toMatch(/bedtools summary/);
    expect(m).toMatch(/mm10 chromosome sizes/);
    expect(m).not.toMatch(/p-value|test/);
  });
});
