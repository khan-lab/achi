/**
 * One Achi analysis on the local computer, written as the web app's
 * "Export analysis" ZIP is laid out (settings.json, methods.md,
 * tables/, subsets/, genes/), so a web analysis and a command-line run can
 * be compared file by file. Everything is computed by @achi/core with the
 * Node runtime (@achi/node); this module only reads the inputs, resolves the
 * selected groups and writes files. Used by the achi CLI and the achi-mcp
 * server.
 */
import { createHash } from "node:crypto";
import { existsSync, openAsBlob } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  annotationMethods,
  buildSettings,
  enrichmentMethods,
  geneListMethods,
  goMethods,
  methodsText,
  motifMethods,
  pairwiseMethods,
  parseSettings,
  selectionFromSettings,
  setsTsv,
  signalMethods,
  subsetFilePath,
  subsetsTsv,
  summaryMethods,
  type AnalysisSettings,
  type MethodsExtra,
} from "@achi/core/analysisExport";
import { openBigWig } from "@achi/core/bigwigSource";
import { hasBlacklist, splitByBlacklistHits } from "@achi/core/blacklist";
import { resolveOverlapFlags, type OverlapPreset } from "@achi/core/bedtoolsOptions";
import { CISTROMEGO_DEFAULTS, GREAT_RUN_DEFAULTS, goFileStem, goNamespaceLabel, goTsv, runGoEnrichment, type GoBackground, type GoMethod } from "@achi/core/goEnrichment";
import { runNearestGenes, uniqueGeneNames } from "@achi/core/geneList";
import type { GoNamespace } from "@achi/core/great";
import { SUPPORTED_ASSEMBLIES, defaultSetCode } from "@achi/core/inputValidation";
import { labelSubsets, runBlacklistCheck, runIntersections, subsetFileText } from "@achi/core/intersections";
import { MOTIF_COLLECTIONS } from "@achi/core/motifCollections";
import { pairwiseTsv, reldistBinsTsv, runPairwise, type FisherResult, type JaccardResult, type PairwiseStat, type ReldistResult } from "@achi/core/pairwiseStats";
import { ANNO_CATEGORIES, annotationStepTotal, annotationTsv, distanceToTssTsv, hasAnnotationReferences, runRegionAnnotation } from "@achi/core/peakAnnotation";
import { motifTsv, runMotifEnrichment } from "@achi/core/motifRun";
import { chosenGroups, setKey, sharesRegions } from "@achi/core/selection";
import type { ProfileParams } from "@achi/core/signalMatrix";
import { MAX_SIGNAL_ROWS, runSignalProfiles, signalMatrixTsv, signalRegionMeansTsv, signalStatsTsv, type SignalSort } from "@achi/core/signalRun";
import { getAggregateRow, runSetSummary, summaryTsv } from "@achi/core/summaryStats";
import { referenceSetTsv, runReferenceSetEnrichment, testableAnnotations } from "@achi/core/subsetEnrichment";
import { MAX_SETS, type RegionSet, type Subset } from "@achi/core/types";
import { localTwoBitSource, readInputFile, type InputFile } from "@achi/node/files";
import type { NodeRuntime } from "@achi/node/runtime";

export interface AnalysisOptions {
  files: string[];
  /** Set names, in file order (default: file names without the region-file extension). */
  names?: string[];
  assembly: string;
  out: string;
  /** Write into a non-empty output directory. */
  force?: boolean;
  overlapPreset: OverlapPreset;
  /** As Intervene's --bedtools-options ("f=0.5,r=true"); overrides overlapPreset. */
  bedtoolsOptions: string;
  /** Remove regions overlapping the ENCODE blacklist before anything is computed. */
  blacklist: boolean;
  /** Groups for the analyses: set names ("K562", "K562 (all)"), subset labels ("HepG2 only"), "sets" or "subsets". Default: every set. */
  select: string[];
  /** A web export's settings.json: its assembly, overlap rule, blacklist filter and selection are used. */
  settings?: string;
  genes?: boolean;
  /** Pairwise statistics between the input sets (as the Pairwise view). */
  pairwise?: PairwiseStat[];
  /** Region annotation of each group (GENCODE categories and distance to the nearest TSS). */
  annotate?: boolean;
  /** bedtools summary of each group, per chromosome. */
  summary?: boolean;
  enrich?: { adjust: boolean };
  go?: { method: GoMethod; ns: GoNamespace; background: GoBackground };
  motifs?: { genome: string; half: number; p: number; collection: string };
  signal?: { files: string[]; params: ProfileParams; sort: SignalSort; k: number };
  /** The CLI's version, for settings.json and methods.md. */
  version: string;
}

export interface AnalysisSummary {
  out: string;
  assembly: string;
  overlapFlags: string;
  sets: { name: string; file: string; regions: number; bp: number; blacklistRemoved?: number; warnings: string[] }[];
  subsets: { label: string; regions: number }[];
  groups: string[];
  /** The most significant results of each test run (q < 0.05, at most 10 each); full tables are in the files. */
  findings: Record<string, string[]>;
  /** Descriptive results (pairwise statistics, annotation, summary), a few lines each; full tables are in the files. */
  overview: Record<string, string[]>;
  files: string[];
}

/** Where a run reports to: the CLI (plain lines, or a live line on a terminal) and the MCP server (stderr). */
export interface Reporter {
  /** A message worth keeping; "warn" for something the user should check. */
  note(line: string, kind?: "warn"): void;
  /** The current stage and step, with done/total when known. Without it, each new step is a note. */
  progress?(p: { section: string; label: string; done?: number; total?: number; unit?: string }): void;
  /** A stage named in progress() finished. */
  stageDone?(section: string): void;
}

const SAFE = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
const sha256File = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

/** Resolve --select tokens to group keys, in the order given. */
export function resolveSelection(tokens: string[], sets: { name: string }[], subsets: Subset[]): number[] {
  const keys: number[] = [];
  const add = (k: number) => !keys.includes(k) && keys.push(k);
  for (const raw of tokens.length ? tokens : ["sets"]) {
    const t = raw.trim();
    if (t === "sets") sets.forEach((_, i) => add(setKey(i)));
    else if (t === "subsets") subsets.filter((s) => s.nRegions > 0).forEach((s) => add(s.mask));
    else {
      const bySet = sets.findIndex((s) => s.name === t || `${s.name} (all)` === t);
      const bySubset = subsets.find((s) => s.label === t || s.code === t);
      if (bySet >= 0) add(setKey(bySet));
      else if (bySubset) add(bySubset.mask);
      else
        throw new Error(
          `No set or subset called "${t}". Sets: ${sets.map((s) => s.name).join(", ")}. Subsets: ${subsets
            .filter((s) => s.nRegions > 0)
            .map((s) => s.label)
            .join(", ")}.`
        );
    }
  }
  return keys;
}

export async function runAnalysis(rt: NodeRuntime, o: AnalysisOptions, report: Reporter | ((line: string) => void) = () => {}): Promise<AnalysisSummary> {
  const rep: Reporter = typeof report === "function" ? { note: report } : report;
  const log = (line: string) => rep.note(line);
  const warn = (line: string) => rep.note(line, "warn");
  let lastStep = "";
  /** A progress callback for one stage (core's onProgress shape). */
  const stage =
    (section: string) =>
    (p: { label: string; done?: number; total?: number; unit?: string }): void => {
      if (rep.progress) return rep.progress({ section, ...p });
      const line = p.label === section ? section : `${section}: ${p.label}`;
      if (line !== lastStep) rep.note((lastStep = line));
    };
  const stageDone = (section: string) => rep.stageDone?.(section);
  /** A stage starts (its clock and live line begin before its first step reports). */
  const begin = (section: string) => stage(section)({ label: section });
  // ---- settings from a web export ----
  let saved: AnalysisSettings | null = null;
  if (o.settings) {
    const parsed = parseSettings(await readFile(o.settings, "utf8"));
    if ("error" in parsed) throw new Error(`${o.settings}: ${parsed.error}`);
    saved = parsed;
    if (saved.mode !== "regions") throw new Error(`${o.settings} is a list-mode analysis; the command-line tool runs region sets.`);
  }
  const assembly = saved?.assembly ?? o.assembly;
  if (!(SUPPORTED_ASSEMBLIES as readonly string[]).includes(assembly)) throw new Error(`Unknown assembly ${assembly}; choose one of ${SUPPORTED_ASSEMBLIES.join(", ")}.`);
  const overlapPreset = saved?.overlap.preset ?? o.overlapPreset;
  const advanced = saved?.overlap.advanced ?? o.bedtoolsOptions;
  const overlapFlags = resolveOverlapFlags(overlapPreset, advanced);
  const blacklist = saved?.blacklistFilter ?? o.blacklist;
  if (blacklist && !hasBlacklist(assembly)) throw new Error(`There is no ENCODE blacklist for ${assembly}.`);

  // ---- output directory ----
  if (existsSync(o.out) && (await readdir(o.out)).length && !o.force) throw new Error(`${o.out} is not empty; choose another --out, or use --force to write into it.`);
  const written: string[] = [];
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(o.out, path)), { recursive: true });
    await writeFile(join(o.out, path), content);
    written.push(path);
  };

  // ---- inputs ----
  if (!o.files.length) throw new Error("No input files.");
  if (o.files.length > MAX_SETS) throw new Error(`Achi compares up to ${MAX_SETS} sets; ${o.files.length} files were given.`);
  if (o.names && o.names.length !== o.files.length) throw new Error(`--names has ${o.names.length} names for ${o.files.length} files.`);
  const inputs: (Extract<InputFile, { ok: true }> & { id: string; path: string; sha256: string; text: string })[] = [];
  for (const [i, path] of o.files.entries()) {
    const r = await readInputFile(path);
    if (!r.ok) throw new Error(r.message);
    r.warnings.forEach((w) => warn(`${r.fileName}: ${w}`));
    const name = o.names?.[i] ?? r.name;
    inputs.push({ ...r, id: `set-${i + 1}`, name, code: o.names ? defaultSetCode(name) : r.code, path, sha256: await sha256File(path), text: await r.file.text() });
  }
  const dup = inputs.find((s, i) => inputs.findIndex((x) => x.name === s.name) !== i);
  if (dup) throw new Error(`Two sets are called ${dup.name}; give them distinct names with --names.`);

  // ---- ENCODE blacklist ----
  const removed = new Map<string, number>();
  const files = new Map(inputs.map((s) => [s.id, { file: s.file, text: s.text, key: s.id }]));
  if (blacklist) {
    begin("ENCODE blacklist");
    const checked = await runBlacklistCheck(rt, assembly, inputs, { onProgress: stage("ENCODE blacklist") });
    stageDone("ENCODE blacklist");
    for (const c of checked) {
      if (!c.hits) throw new Error(`The ENCODE blacklist check failed for ${inputs.find((s) => s.id === c.id)!.name}.`);
      const s = files.get(c.id)!;
      const split = splitByBlacklistHits(s.text, c.hits);
      removed.set(c.id, split.nHits);
      files.set(c.id, { file: new Blob([split.keptText]), text: split.keptText, key: `${c.id}~bl-${assembly}` });
    }
  }

  // ---- intersections ----
  begin("Intersections");
  const result = await runIntersections(
    rt,
    { sets: inputs.map((s) => ({ id: s.id, name: s.name, file: files.get(s.id)!.file, key: files.get(s.id)!.key })), overlapFlags },
    { fallback: false, onProgress: stage("Intersections") }
  );
  stageDone("Intersections");
  const byId = new Map(result.sets.map((r) => [r.id, r]));
  const sets: RegionSet[] = inputs.map((s) => {
    const r = byId.get(s.id)!;
    return { id: s.id, name: s.name, code: s.code, color: "", defaultColor: "", fileName: s.fileName, fileSizeBytes: 0, regions: r.regions, nRegions: r.nRegions, nBp: r.nBp, included: true };
  });
  const subsets = labelSubsets(result.subsets, sets);

  // ---- groups ----
  let keys: number[];
  if (saved && !o.select.length) {
    const sel = selectionFromSettings(saved, sets.map((s) => s.name));
    sel.missing.forEach((m) => warn(`The saved selection "${m}" has no set or subset here; left out.`));
    keys = sel.masks;
  } else keys = resolveSelection(o.select, sets, subsets);
  const groups = chosenGroups(keys, subsets, sets);
  const groupOf = (k: number) => chosenGroups([k], subsets, sets)[0];
  const extras: MethodsExtra[] = [];
  const findings: Record<string, string[]> = {};
  const fmt = (x: number) => (x === 0 ? "<1e-300" : x < 0.001 ? x.toExponential(1) : x.toPrecision(2));
  /** A descriptive value (not a p-value): bedtools' inf and nan as Inf and NA. */
  const val = (x: number) => (Number.isNaN(x) ? "NA" : !Number.isFinite(x) ? "Inf" : x === 0 ? "0" : Math.abs(x) < 0.001 ? x.toExponential(1) : x.toPrecision(2));

  for (const s of subsets) await write(subsetFilePath(s, "regions"), subsetFileText(s));

  // ---- nearest genes ----
  if (o.genes) {
    const items = groups.map((g) => ({ id: `group${g.mask}`, version: "1", name: g.label, color: "", getRawText: async () => subsetFileText(g) }));
    const genesStage = stage("Nearest genes");
    let nGenes = 0;
    genesStage({ label: items[0]?.name ?? "", done: 0, total: items.length, unit: "groups" });
    const all = await runNearestGenes(rt, assembly, items, { onResult: (_a, item) => genesStage({ label: item.name, done: ++nGenes, total: items.length, unit: "groups" }) });
    stageDone("Nearest genes");
    for (const [i, a] of all.entries()) {
      const genes = uniqueGeneNames(a);
      await write(`genes/${SAFE(items[i].name)}.genes.txt`, genes.join("\n") + (genes.length ? "\n" : ""));
    }
    extras.push(geneListMethods(assembly));
  }

  // ---- per-group summary and annotation, pairwise statistics between the sets ----
  const groupItems = groups.map((g) => ({ id: `group${g.mask}`, version: "1", name: g.label, color: "", getRawText: async () => subsetFileText(g) }));
  const overview: Record<string, string[]> = {};
  const pct = (n: number, total: number) => `${total ? Math.round((100 * n) / total) : 0}%`;
  if (o.summary) {
    const summaryStage = stage("Summary");
    let nSummary = 0;
    summaryStage({ label: groupItems[0]?.name ?? "", done: 0, total: groupItems.length, unit: "groups" });
    const rows = await runSetSummary(rt, assembly, groupItems, { onResult: (_r, item) => summaryStage({ label: item.name, done: ++nSummary, total: groupItems.length, unit: "groups" }) });
    stageDone("Summary");
    await write("tables/summary.tsv", summaryTsv(groupItems, rows));
    extras.push(summaryMethods(assembly));
    overview.summary = groupItems.map((g, i) => {
      const all = getAggregateRow(rows[i]);
      return all && all.numIvls > 0
        ? `${g.name}: ${all.numIvls.toLocaleString("en-US")} regions, ${all.totalIvlBp.toLocaleString("en-US")} bp, mean length ${Math.round(all.mean).toLocaleString("en-US")} bp (${all.min.toLocaleString("en-US")}–${all.max.toLocaleString("en-US")})`
        : `${g.name}: no regions`;
    });
  }
  if (o.annotate) {
    begin("Region annotation");
    const annoStage = stage("Region annotation");
    const annoTotal = annotationStepTotal(groupItems.length, hasAnnotationReferences(rt, assembly));
    let annoSteps = 0;
    // Steps are "<group>: <category>" once the references are loaded; show the group.
    const annos = await runRegionAnnotation(rt, assembly, groupItems, {
      onStep: (l) => annoStage({ label: groupItems.some((g) => l.startsWith(`${g.name}: `)) ? l.slice(0, l.indexOf(": ")) : "Loading GENCODE categories", done: ++annoSteps, total: annoTotal, unit: "steps" }),
    });
    stageDone("Region annotation");
    await write("tables/annotation.tsv", annotationTsv(annos));
    await write("tables/distance_to_tss.tsv", distanceToTssTsv(annos));
    extras.push(annotationMethods(assembly));
    overview.annotation = annos.map(
      (a) =>
        `${a.name}: ${
          ANNO_CATEGORIES.map((c) => ({ label: c.label, n: a.categoryCounts[c.key] ?? 0 }))
            .filter((c) => c.n > 0)
            .sort((x, y) => y.n - x.n)
            .slice(0, 3)
            .map((c) => `${c.label} ${pct(c.n, a.total)}`)
            .join(", ") || "no regions"
        }`
    );
  }
  if (o.pairwise?.length) {
    if (inputs.length < 2) warn("Pairwise statistics need two or more sets; skipped.");
    else {
      const pairSets = inputs.map((s) => ({ id: files.get(s.id)!.key, name: s.name, file: files.get(s.id)!.file }));
      const nameOf = (id: string) => pairSets.find((s) => s.id === id)?.name ?? id;
      for (const stat of o.pairwise) {
        const pairStage = stage(`Pairwise ${stat}`);
        const nPairs = pairSets.length * (pairSets.length - 1);
        let donePairs = 0;
        pairStage({ label: `${pairSets[0].name} → ${pairSets[1].name}`, done: 0, total: nPairs, unit: "pairs" });
        const results = await runPairwise(rt, { stat, assembly, sets: pairSets, overlapFlags }, { onResult: (a, b) => pairStage({ label: `${nameOf(a)} → ${nameOf(b)}`, done: ++donePairs, total: nPairs, unit: "pairs" }) });
        stageDone(`Pairwise ${stat}`);
        await write(`tables/pairwise_${stat}.tsv`, pairwiseTsv(stat, pairSets, results));
        if (stat === "reldist") await write("tables/pairwise_reldist_bins.tsv", reldistBinsTsv(pairSets, results));
        const pair = (r: { a: string; b: string }) => `${nameOf(r.a)} → ${nameOf(r.b)}`;
        overview[`pairwise ${stat}`] =
          stat === "jaccard"
            ? [...results].sort((x, y) => (y.result as JaccardResult).jaccard - (x.result as JaccardResult).jaccard).slice(0, 10).map((r) => `${pair(r)}: Jaccard ${val((r.result as JaccardResult).jaccard)}`)
            : stat === "fisher"
              ? [...results].sort((x, y) => (x.result as FisherResult).twoTailP - (y.result as FisherResult).twoTailP).slice(0, 10).map((r) => `${pair(r)}: odds ratio ${val((r.result as FisherResult).ratio)}, p ${fmt((r.result as FisherResult).twoTailP)}`)
              : [...results].sort((x, y) => (x.result as ReldistResult).ksP - (y.result as ReldistResult).ksP).slice(0, 10).map((r) => `${pair(r)}: median relative distance ${val((r.result as ReldistResult).median)}, KS p ${fmt((r.result as ReldistResult).ksP)}`);
      }
      extras.push(pairwiseMethods({ stats: o.pairwise, assembly, overlapFlags }));
    }
  }

  // ---- reference-set enrichment ----
  if (o.enrich) {
    const annotations = testableAnnotations(assembly, sets);
    if (!annotations.length) warn(`No reference sets to test for ${assembly}.`);
    else {
      begin("Reference sets");
      const cells = await runReferenceSetEnrichment(rt, { subsets, groups: keys, annotations, adjust: o.enrich.adjust }, {
        onStep: (() => {
          const refStage = stage("Reference sets");
          let done = 0;
          return (l: string) => refStage({ label: l, done: ++done, total: annotations.length, unit: "reference sets" });
        })(),
      });
      stageDone("Reference sets");
      await write("tables/enrichment_reference_sets.tsv", referenceSetTsv({ adjust: o.enrich.adjust, cells, annotations }, groupOf));
      extras.push(enrichmentMethods({ adjust: o.enrich.adjust, referenceNames: annotations.map((a) => a.name) }));
      findings.enrichment = cells
        .filter((c) => c.q < 0.05)
        .sort((a, b) => a.q - b.q)
        .slice(0, 10)
        .map((c) => `${groupOf(c.mask)?.label}: ${annotations.find((a) => a.id === c.annotationId)?.name} (odds ratio ${fmt(c.oddsRatio)}, q ${fmt(c.q)})`);
    }
  }

  // ---- GO ----
  if (o.go) {
    const great = { ...GREAT_RUN_DEFAULTS, background: o.go.background };
    const goGroups = groups.map((g) => ({ mask: g.mask, label: g.label, regions: g.regions, whole: g.whole, scoreSource: o.go!.method === "cistromego" ? files.get(g.memberIds[0])?.text : undefined }));
    begin("GO enrichment");
    const run = await runGoEnrichment(rt, { method: o.go.method, ns: o.go.ns, assembly, groups: goGroups, allSubsets: subsets, great, cgo: CISTROMEGO_DEFAULTS }, { onProgress: stage("GO enrichment") });
    stageDone("GO enrichment");
    await write(`tables/${goFileStem(run)}.tsv`, goTsv(run));
    extras.push(goMethods({ method: run.method, background: run.background, namespace: goNamespaceLabel(run.ns), ...(run.method === "great" ? { great } : { cgo: CISTROMEGO_DEFAULTS }) }));
    findings.go = run.groups.flatMap((g) => g.rows.filter((r) => r.significant).slice(0, 3).map((r) => `${g.label}: ${r.id} ${r.name} (q ${fmt(r.q)})`)).slice(0, 10);
  }

  // ---- motifs ----
  if (o.motifs) {
    const collection = MOTIF_COLLECTIONS.find((c) => c.id === o.motifs!.collection);
    if (!collection) throw new Error(`Unknown motif collection ${o.motifs.collection}; choose one of ${MOTIF_COLLECTIONS.map((c) => c.id).join(", ")}.`);
    const source = localTwoBitSource(o.motifs.genome);
    begin("Motif enrichment");
    const run = await runMotifEnrichment(
      rt,
      { assembly, collection, subsets, groups: keys, half: o.motifs.half, p: o.motifs.p, source },
      { onProgress: stage("Motif enrichment") }
    );
    stageDone("Motif enrichment");
    if (run.nNoSequence) warn(`${run.nNoSequence} regions had no sequence in ${basename(o.motifs.genome)} and were left out.`);
    await write("tables/motif_enrichment_jaspar.tsv", motifTsv(run, (k) => groupOf(k)?.label ?? String(k)));
    extras.push(motifMethods({ release: run.release, collection: collection.methods, nMotifs: run.motifs.length, half: run.half, p: run.p, nScanned: run.nScanned, nUniverse: run.nUniverse, source: run.source, assembly, where: "on the local computer" }));
    findings.motifs = run.cells
      .filter((c) => c.q < 0.05 && c.oddsRatio > 1)
      .sort((a, b) => a.q - b.q)
      .slice(0, 10)
      .map((c) => `${groupOf(c.key)?.label}: ${run.motifs[c.motif].id} ${run.motifs[c.motif].name} (odds ratio ${fmt(c.oddsRatio)}, q ${fmt(c.q)})`);
  }

  // ---- signal ----
  if (o.signal) {
    const tracks = o.signal.files.map((path) => {
      const name = basename(path).replace(/\.(bw|bigwig)$/i, "");
      return {
        id: name,
        name,
        how: "file on this computer",
        open: async () => openBigWig(Object.assign(await openAsBlob(path), { name: basename(path) })),
      };
    });
    begin("Signal profiles");
    const run = await runSignalProfiles(
      {
        assembly,
        params: o.signal.params,
        sort: o.signal.sort,
        k: o.signal.k,
        groups: groups.map((g) => ({ mask: g.mask, label: g.label, regions: g.regions })),
        overlaps: groups.map((a) => groups.map((b) => sharesRegions(a.mask, b.mask, subsets))),
        tracks,
        cap: MAX_SIGNAL_ROWS,
      },
      { onProgress: stage("Signal profiles") }
    );
    stageDone("Signal profiles");
    if (run.sampledFrom) log(`Signal: a fixed sample of ${run.regions.length} of ${run.sampledFrom} regions.`);
    for (const [i, t] of run.tracks.entries()) await write(`tables/signal_matrix_${SAFE(t.name)}.tsv`, signalMatrixTsv(run, i));
    await write("tables/signal_region_means.tsv", signalRegionMeansTsv(run));
    if (run.stats.length) await write("tables/signal_tests.tsv", signalStatsTsv(run));
    extras.push(signalMethods({ params: run.params, nRegions: run.regions.length, tracks: run.tracks.map((t) => t.name), sort: run.sort, k: run.k, nGroups: run.groups.length, where: "on the local computer" }));
    findings.signal = run.stats.filter((s) => s.q < 0.05).map((s) => `${s.track}: ${run.groups[s.a].label} vs ${run.groups[s.b].label} (median ${fmt(s.medianA)} vs ${fmt(s.medianB)}, q ${fmt(s.q)})`).slice(0, 10);
  }

  // ---- settings, methods, tables, README ----
  const settings = buildSettings({
    build: { commit: o.version, date: new Date().toISOString().slice(0, 10) },
    created: new Date().toISOString(),
    mode: "regions",
    assembly,
    overlapPreset,
    advancedBedtoolsOptions: advanced,
    overlapFlags,
    blacklistFilter: blacklist,
    upsetSort: "size",
    upsetMinSize: 0,
    pairwiseStat: "jaccard",
    view: "cli",
    sets: inputs.map((s) => ({ name: s.name, fileName: s.fileName, code: s.code, color: "", included: true, n: byId.get(s.id)!.nRegions, bp: byId.get(s.id)!.nBp, sha256: s.sha256 })),
    selected: groups.map((g) => ({ label: g.label, memberNames: g.memberIds.map((id) => sets.find((s) => s.id === id)!.name), n: g.nRegions, ...(g.whole ? { whole: true } : {}) })),
    runner: { kind: "cli", version: o.version, bedtools: rt.bedtools.version.join(".") },
  });
  await write("settings.json", JSON.stringify(settings, null, 2) + "\n");
  await write("methods.md", methodsText(settings, extras));
  await write("tables/sets.tsv", setsTsv(settings));
  await write("tables/subsets.tsv", subsetsTsv(subsets, sets, "regions", new Set(keys)));
  const readme = [
    "# Achi analysis",
    "",
    `Run ${settings.created} with the Achi command-line tool ${o.version} (native bedtools ${rt.bedtools.version.join(".")}), ${assembly}.`,
    "Everything was computed on this computer; no data were uploaded.",
    "",
    "- methods.md: a methods paragraph for this analysis, with references.",
    "- settings.json: the parameters and the inputs' names, file names and SHA-256 checksums (no data).",
    "  It can be loaded in the Achi web app with \"Restore settings…\", or rerun with `achi run --settings settings.json`.",
    ...written.filter((f) => !["settings.json", "methods.md"].includes(f) && !f.startsWith("subsets/")).map((f) => `- ${f}`),
    `- subsets/: every subset (${subsets.length}) as .bed.`,
    "",
  ].join("\n");
  await write("README.md", readme);

  return {
    out: o.out,
    assembly,
    overlapFlags,
    sets: inputs.map((s) => ({ name: s.name, file: s.fileName, regions: byId.get(s.id)!.nRegions, bp: byId.get(s.id)!.nBp, ...(removed.has(s.id) ? { blacklistRemoved: removed.get(s.id) } : {}), warnings: s.warnings })),
    subsets: subsets.filter((s) => s.nRegions > 0).map((s) => ({ label: s.label, regions: s.nRegions })),
    groups: groups.map((g) => g.label),
    findings,
    overview,
    files: written,
  };
}
