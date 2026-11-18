import { create } from "zustand";
import { useMemo } from "react";
import * as intervals from "@achi/core/intervals";
import { computeSubsetsViaBedtools, forgetSet, subsetToBedText, type PipelineProgress } from "../lib/pipeline";
import { resolveOverlapFlags, type OverlapPreset } from "@achi/core/bedtoolsOptions";
import { MAX_SETS, PALETTE, type Interval, type RegionSet, type Subset } from "../types";
import type { ExternalAnnotation } from "@achi/core/externalAnnotations";
import { blacklistHits, hasBlacklist, mountBlacklist, splitByBlacklistHits } from "../lib/blacklist";
import { LIST_EXTENSION, computeListSubsets, listSetName, parseListText } from "@achi/core/lists";
import {
  buildSettings,
  compareInputs,
  methodsText,
  parseSettings,
  selectionFromSettings,
  setsTsv,
  sha256Hex,
  subsetFilePath,
  subsetsTsv,
  type AnalysisSettings,
  type InputMode,
  type SavedSubset,
} from "@achi/core/analysisExport";
import { collectExports } from "../lib/exportRegistry";
import { bigWigFor } from "@achi/core/bigwigSource";
import { fetchFailureMessage, matchGzipName, type LinkSettings, type ParsedLink } from "../lib/shareLink";
import { svgToStandaloneString } from "../lib/exportImage";
import { chosenGroups, remapSelection, validSelection } from "@achi/core/selection";
import {
  InputValidationError,
  SUPPORTED_ASSEMBLIES,
  MAX_FILE_BYTES,
  checkFileSize,
  normalizeRegionText,
  parseChromSizes,
  type ChromSizes,
  type InputFormat,
} from "@achi/core/inputValidation";

export type View = "upset" | "venn" | "pairwise" | "table" | "summary" | "browser" | "help";

/** Where the genome browser should go next: a locus ("chr1:1,001-2,000") or gene symbol, optionally with margin. `n` makes repeated jumps to the same place distinct. */
export interface BrowserTarget {
  query: string;
  pad: boolean;
  n: number;
}
export type ComputeStatus = "idle" | "loading-worker" | "running" | "done" | "error";
/** Matches the Intervene CLI's own `intervene pairwise --compute {jaccard,fisher,reldist}`. */
export type PairwiseStat = "jaccard" | "fisher" | "reldist";

export interface LoadedSet extends RegionSet {
  /**
   * What every analysis reads: the checked, cleaned upload
   * (lib/inputValidation.ts; tab-separated BED, VCF already converted), or,
   * with the ENCODE blacklist filter on, that minus its blacklisted
   * regions. Never the raw upload.
   */
  file: File;
  /** The checked, cleaned upload, unfiltered — `file` when the blacklist filter is off. */
  cleanFile: File;
  /** Identifies `file`'s content for result caches: the set id, or `${id}~bl-${assembly}` when filtered. */
  contentKey: string;
  /** Regions of `cleanFile` overlapping the selected assembly's ENCODE blacklist (≥ 1 bp); null when that assembly has none or the check failed. */
  blacklistHits: number | null;
  format: InputFormat | "list";
  /** SHA-256 of the file as the user gave it (hex): recorded in exported settings, compared on restore. */
  sha256: string;
  /** Max end coordinate per chromosome, for the assembly check. */
  extents: Record<string, number>;
  /** Non-fatal problems found while checking the file (skipped lines, conversions). */
  warnings: string[];
  /** The public https address it was downloaded from, when it came from an "Open in" link (lib/shareLink.ts); never set for files from the user's computer. */
  sourceUrl?: string;
}

/** A bigWig for signal profiles (components/SignalProfilePanel.tsx): read in the page, never uploaded. */
export interface SignalTrack {
  id: string;
  name: string;
  /** A file on the user's computer (or the bundled example). */
  file?: File;
  /** A public https bigWig (lib/remoteSignal.ts): read privately (summary layer) or exactly. */
  url?: string;
  source: "local" | "example" | "public";
}

interface StoreState {
  /** Genomic regions (bedtools) or lists of names (lib/lists.ts, exact match). Switching clears the loaded sets. */
  inputMode: InputMode;
  /** Subsets to select once the matching sets are loaded (from a restored settings file). */
  pendingSelection: SavedSubset[] | null;
  /** Files named by the link this page was opened with, waiting for the user to agree to download them (components/LinkDialog.tsx). */
  linkRequest: ParsedLink | null;
  /** bigWigs for signal profiles, kept for the page session. */
  signalTracks: SignalTrack[];
  sets: LoadedSet[];
  subsets: Subset[];
  selected: Set<number>;
  view: View;
  /** Pending jump for the genome browser (set by "view" links); null once there or never set. */
  browserTarget: BrowserTarget | null;
  status: ComputeStatus;
  error: string | null;
  /** What the app is doing right now, for the progress indicator; null when idle. `total` is 0 for steps without a count (reading a file). */
  progress: PipelineProgress | null;
  /** Non-fatal messages from the last load — files rejected, sets over the 6-set cap. */
  notices: string[];
  /** Vendored chrom.sizes per supported assembly, fetched once on first load (a few KB each). */
  chromSizes: Record<string, ChromSizes>;
  /** True if the last computation fell back to the pure-TS path because the WASM worker failed. */
  usedFallback: boolean;
  /** True if the fallback ran while a non-default overlap mode was requested — the TS fallback only supports the 1bp default. */
  fallbackOverlapUnsupported: boolean;

  overlapPreset: OverlapPreset;
  advancedBedtoolsOptions: string;
  /** hg38 (default), hg19, mm10, or mm9 — see docs/provenance.md for vendored chrom.sizes. Used by the Pairwise Fisher/Reldist toggle only; the overlap pipeline itself doesn't need a genome. */
  assembly: string;
  pairwiseStat: PairwiseStat;
  /** Drop regions overlapping the ENCODE blacklist from every set before analysis. Off by default, to match the CLI. */
  blacklistFilter: boolean;
  /** UpSet chart sort key — pure client-side reordering of already-computed subsets, no recompute involved. */
  upsetSort: "size" | "degree";
  /** UpSet chart minimum subset size — bars below this are hidden. */
  upsetMinSize: number;

  /** `meta[i]`, when given, overrides the name/code derived from `files[i]`'s file name (used for built-in annotation sets). */
  addFiles: (files: File[], meta?: ({ name?: string; code?: string; sourceUrl?: string } | undefined)[]) => Promise<void>;
  loadChromSizes: () => Promise<void>;
  dismissNotices: () => void;
  removeSet: (id: string) => void;
  renameSet: (id: string, name: string) => void;
  setColor: (id: string, color: string) => void;
  resetColor: (id: string) => void;
  toggleIncluded: (id: string) => void;
  toggleSelected: (mask: number) => void;
  clearSelected: () => void;
  setView: (view: View) => void;
  /** Open the genome browser at a locus or gene symbol (from a region row or gene list). */
  showInBrowser: (query: string, pad?: boolean) => void;
  loadExample: () => Promise<void>;
  addExternalAnnotation: (annotation: ExternalAnnotation) => Promise<void>;
  exportSelectedBedZip: () => Promise<void>;
  exportSubsetBed: (mask: number) => void;
  setOverlapPreset: (preset: OverlapPreset) => void;
  setAdvancedBedtoolsOptions: (value: string) => void;
  setAssembly: (assembly: string) => void;
  setPairwiseStat: (stat: PairwiseStat) => void;
  setBlacklistFilter: (on: boolean) => void;
  setUpsetSort: (sort: "size" | "degree") => void;
  setUpsetMinSize: (size: number) => void;
  setInputMode: (mode: InputMode) => void;
  loadExampleLists: () => Promise<void>;
  /** One ZIP: subsets, tables, figures on screen, methods text, settings (lib/analysisExport.ts). */
  exportAnalysis: () => Promise<void>;
  /** Restore an exported settings file: parameters now, the selection once its sets are loaded. */
  applySettings: (text: string) => Promise<void>;
  /** Select the pending subsets that exist now (called when subsets change). */
  applyPendingSelection: () => void;
  /** Settings from the page's link: applied at once (nothing is downloaded for them). */
  applyLinkSettings: (settings: Partial<LinkSettings>) => void;
  /** Ask the user about the link's files (sets linkRequest). */
  requestLink: (link: ParsedLink) => void;
  /** The user agreed: download the link's files and compare them. */
  acceptLink: () => Promise<void>;
  declineLink: () => void;
  /** Checks each file is a bigWig and adds it for signal profiles (names the ones that are not). */
  addSignalFiles: (files: File[], source?: "local" | "example", names?: string[]) => Promise<void>;
  removeSignalTrack: (id: string) => void;
  /** Public bigWigs by URL (the genome browser's catalogue, or pasted); nothing is fetched until a profile is computed. */
  addPublicSignal: (tracks: { name: string; url: string }[]) => void;
  /** The example H3K27ac signal for the example cell lines (public/examples/signal). */
  loadExampleSignal: () => Promise<void>;
}

function labelSubsets(raw: { mask: number; memberIds: string[]; regions: Interval[]; nRegions: number; nBp: number; items?: string[] }[], sets: LoadedSet[]): Subset[] {
  const byId = new Map(sets.map((s) => [s.id, s]));
  return raw.map((s) => {
    const members = s.memberIds.map((id) => byId.get(id)).filter((s): s is LoadedSet => Boolean(s));
    return {
      mask: s.mask,
      memberIds: s.memberIds,
      label: members.length === 1 ? `${members[0].name} only` : members.map((m) => m.name).join(" ∩ "),
      code: members.map((m) => m.code).join("·"),
      degree: members.length,
      regions: s.regions,
      nRegions: s.nRegions,
      nBp: s.nBp,
      ...(s.items ? { items: s.items } : {}),
    };
  });
}

/** A subset's file content: BED text, or one name per line in list mode. */
export function subsetFileText(s: Subset): string {
  return s.items ? s.items.join("\n") + (s.items.length ? "\n" : "") : subsetToBedText(s);
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Fill region counts for sets that have none yet (excluded sets, or sets whose content just changed). */
function withCounts(sets: LoadedSet[]): Promise<LoadedSet[]> {
  return Promise.all(
    sets.map(async (s) => {
      if (s.items) return { ...s, nRegions: s.items.length, nBp: 0 };
      if (s.nRegions > 0 || s.regions.length > 0) return s;
      const regions = intervals.sortIntervals(intervals.parseBed(await s.file.text()));
      return { ...s, regions, nRegions: regions.length, nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0) };
    })
  );
}

// ---- ENCODE blacklist (lib/blacklist.ts) ----

/** Per (set id, assembly): the blacklist hit flags of the set's clean file. */
const blacklistCache = new Map<string, Uint8Array | null>();
/** Per (set id, assembly): the filtered file, built on first use. */
const filteredFileCache = new Map<string, File>();
const blKey = (id: string, assembly: string) => `${id}~bl-${assembly}`;

function forgetBlacklist(id: string): void {
  for (const m of [blacklistCache, filteredFileCache]) for (const k of m.keys()) if (k.startsWith(`${id}~`)) m.delete(k);
}

/**
 * Count each set's regions in the assembly's blacklist (one bedtools
 * intersect -c per set not yet checked for this assembly). Never blocks
 * loading: if the check fails, the set just shows no count.
 */
async function checkBlacklist(sets: LoadedSet[], assembly: string, onProgress?: (p: PipelineProgress) => void): Promise<LoadedSet[]> {
  if (!hasBlacklist(assembly)) return sets.map((s) => ({ ...s, blacklistHits: null }));
  const todo = sets.filter((s) => !blacklistCache.has(blKey(s.id, assembly)));
  let done = 0;
  for (const s of todo) {
    onProgress?.({ done, total: todo.length, label: `Checking ${s.name} against ENCODE problematic regions` });
    try {
      const path = await mountBlacklist(assembly);
      blacklistCache.set(blKey(s.id, assembly), await blacklistHits(s.id, await s.cleanFile.text(), path));
    } catch (err) {
      console.warn(`ENCODE problematic-regions check failed for ${s.name}`, err);
      blacklistCache.set(blKey(s.id, assembly), null);
    }
    done++;
  }
  return sets.map((s) => {
    const hits = blacklistCache.get(blKey(s.id, assembly));
    return { ...s, blacklistHits: hits ? hits.reduce((n, h) => n + h, 0) : null };
  });
}

/**
 * Point each set's `file` at its filtered or clean version. A set whose
 * content changes loses its stale region counts (recompute refills them).
 */
async function applyBlacklistFilter(sets: LoadedSet[], on: boolean, assembly: string): Promise<LoadedSet[]> {
  return Promise.all(
    sets.map(async (s) => {
      const key = blKey(s.id, assembly);
      const hits = on ? blacklistCache.get(key) : null;
      let file = s.cleanFile;
      let contentKey = s.id;
      if (hits) {
        let filtered = filteredFileCache.get(key);
        if (!filtered) {
          filtered = new File([splitByBlacklistHits(await s.cleanFile.text(), hits).keptText], s.cleanFile.name, { type: "text/plain" });
          filteredFileCache.set(key, filtered);
        }
        file = filtered;
        contentKey = key;
      }
      if (contentKey === s.contentKey) return s;
      return { ...s, file, contentKey, regions: [], nRegions: 0, nBp: 0 };
    })
  );
}

async function recompute(
  sets: LoadedSet[],
  overlapFlags: string,
  onProgress?: (p: PipelineProgress) => void
): Promise<{ sets: LoadedSet[]; subsets: Subset[]; usedFallback: boolean; fallbackOverlapUnsupported: boolean }> {
  const included = sets.filter((s) => s.included);

  // List mode: exact name matching in the page (lib/lists.ts), no bedtools.
  if (sets.some((s) => s.items)) {
    const counted = await withCounts(sets);
    const raw = computeListSubsets(included.map((s) => ({ id: s.id, items: s.items ?? [] })));
    return { sets: counted, subsets: labelSubsets(raw, counted), usedFallback: false, fallbackOverlapUnsupported: false };
  }

  if (included.length < 2) {
    // Still need per-set counts for the rail even with 0-1 active sets.
    return { sets: await withCounts(sets), subsets: [], usedFallback: false, fallbackOverlapUnsupported: false };
  }

  try {
    const result = await computeSubsetsViaBedtools(
      included.map((s) => ({ id: s.id, name: s.name, file: s.file, key: s.contentKey })),
      overlapFlags,
      onProgress
    );
    const byId = new Map(result.sets.map((r) => [r.id, r]));
    const updatedSets = await withCounts(
      sets.map((s) => {
        const r = byId.get(s.id);
        return r ? { ...s, regions: r.regions, nRegions: r.nRegions, nBp: r.nBp } : s;
      })
    );
    return {
      sets: updatedSets,
      subsets: labelSubsets(result.subsets, updatedSets),
      usedFallback: false,
      fallbackOverlapUnsupported: false,
    };
  } catch (err) {
    console.warn("bedtools WASM pipeline failed, falling back to pure-TS lib/intervals.ts", err);
    const withRegions = await Promise.all(
      included.map(async (s) => {
        const regions = intervals.sortIntervals(intervals.parseBed(await s.file.text()));
        return { ...s, regions, nRegions: regions.length, nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0) };
      })
    );
    const updatedSets = sets.map((s) => withRegions.find((r) => r.id === s.id) ?? s);
    // The TS fallback only implements the 1bp default (no -f/-r/-F equivalent).
    const raw = intervals.computeSubsets(withRegions.map((s) => ({ id: s.id, regions: s.regions })));
    return {
      sets: updatedSets,
      subsets: labelSubsets(raw, updatedSets),
      usedFallback: true,
      fallbackOverlapUnsupported: overlapFlags !== "",
    };
  }
}

const EXTENSION = /\.(bed|txt|vcf|narrowPeak|broadPeak|bedGraph)(\.gz)?$/i;

async function readUploadText(file: File): Promise<string> {
  if (!/\.gz$/i.test(file.name)) return file.text();
  // Browser-native gzip, no dependency: ENCODE and most pipelines ship .bed.gz.
  const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Check one upload and replace it with the cleaned BED text
 * (lib/inputValidation.ts). Returns a rejection message instead when the
 * file can't be used at all.
 */
async function prepareUpload(
  file: File
): Promise<{ ok: true; file: File; format: InputFormat; extents: Record<string, number>; warnings: string[] } | { ok: false; message: string }> {
  const tooBig = checkFileSize(file.size);
  if (tooBig) return { ok: false, message: `${file.name} ${tooBig}` };
  let text: string;
  try {
    text = await readUploadText(file);
  } catch {
    return { ok: false, message: `${file.name} could not be read${/\.gz$/i.test(file.name) ? " — is it really gzip-compressed?" : "."}` };
  }
  const tooBigUnzipped = checkFileSize(text.length);
  if (tooBigUnzipped) return { ok: false, message: `${file.name} (uncompressed) ${tooBigUnzipped}` };

  try {
    const n = normalizeRegionText(text, { fileName: file.name });
    const warnings: string[] = [];
    if (n.format === "vcf") warnings.push(`VCF converted to BED: ${plural(n.nRegions, "record")}, 0-based, spanning REF (or INFO END for symbolic alleles).`);
    if (n.nSkipped) {
      const ex = n.skippedExamples[0];
      warnings.push(`Skipped ${plural(n.nSkipped, "malformed line")} — e.g. line ${ex.line}: ${ex.reason}.`);
    }
    if (n.nWhitespaceConverted) warnings.push(`${plural(n.nWhitespaceConverted, "space-separated line")} converted to tabs.`);
    if (n.nZeroLength) warnings.push(`${plural(n.nZeroLength, "zero-length interval")} (start = end) kept as-is.`);
    const cleaned = new File([n.bedText], file.name.replace(/\.gz$/i, ""), { type: "text/plain" });
    return { ok: true, file: cleaned, format: n.format, extents: n.extents, warnings };
  } catch (err) {
    if (err instanceof InputValidationError) return { ok: false, message: `${file.name} ${err.message}` };
    throw err;
  }
}

/** List mode: read one name per line (lib/lists.ts). */
async function prepareListUpload(
  file: File
): Promise<{ ok: true; file: File; format: "list"; items: string[]; extents: Record<string, number>; warnings: string[] } | { ok: false; message: string }> {
  const tooBig = checkFileSize(file.size);
  if (tooBig) return { ok: false, message: `${file.name} ${tooBig}` };
  if (!LIST_EXTENSION.test(file.name)) return { ok: false, message: `${file.name}: list mode reads .txt, .tsv, .csv, .lst or .list files (one name per line).` };
  let text: string;
  try {
    text = await readUploadText(file);
  } catch {
    return { ok: false, message: `${file.name} could not be read${/\.gz$/i.test(file.name) ? " — is it really gzip-compressed?" : "."}` };
  }
  try {
    const p = parseListText(text);
    const warnings: string[] = [];
    if (p.nDuplicates) warnings.push(`${plural(p.nDuplicates, "repeated name")} counted once.`);
    return { ok: true, file, format: "list", items: p.items, extents: {}, warnings };
  } catch (err) {
    if (err instanceof InputValidationError) return { ok: false, message: `${file.name} ${err.message}` };
    throw err;
  }
}

let nextId = 0;

export const useStore = create<StoreState>((set, get) => {
  /** Recompute subsets for `sets` and keep only selections that still exist. */
  /** The selection after a recompute: subsets and whole sets follow their sets, by id, from `before`'s included sets to `sets`' (lib/selection.ts). */
  const keepSelection = (before: RegionSet[], sets: RegionSet[], subsets: Subset[]) => {
    const after = sets.filter((s) => s.included);
    return validSelection(remapSelection(get().selected, before.filter((s) => s.included), after), subsets, after);
  };

  const rerunWith = async (sets: LoadedSet[]) => {
    const before = get().sets;
    try {
      set({ sets, status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const result = await recompute(sets, flags, (p) => set({ progress: p }));
      const stillValid = keepSelection(before, result.sets, result.subsets);
      set({ ...result, selected: stillValid, status: "done", progress: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  };

  return {
  inputMode: "regions",
  pendingSelection: null,
  linkRequest: null,
  signalTracks: [],
  sets: [],
  subsets: [],
  selected: new Set(),
  view: "upset",
  browserTarget: null,
  status: "idle",
  error: null,
  progress: null,
  notices: [],
  chromSizes: {},
  usedFallback: false,
  fallbackOverlapUnsupported: false,
  overlapPreset: "1bp",
  advancedBedtoolsOptions: "",
  assembly: "hg38",
  pairwiseStat: "jaccard",
  blacklistFilter: false,
  upsetSort: "size",
  upsetMinSize: 0,

  addFiles: async (files, meta) => {
    if (!files.length) return;
    set({ status: "loading-worker", error: null, notices: [] });
    void get().loadChromSizes();
    const existing = get().sets;
    const room = Math.max(0, MAX_SETS - existing.length);
    const notices: string[] = [];
    if (files.length > room) {
      notices.push(
        `Achi compares up to ${MAX_SETS} sets; ${plural(files.length - room, "file")} not added (${files
          .slice(room)
          .map((f) => f.name)
          .join(", ")}).`
      );
    }

    const newSets: LoadedSet[] = [];
    const lists = get().inputMode === "lists";
    for (const [i, file] of files.slice(0, room).entries()) {
      set({ progress: { done: 0, total: 0, label: `Checking ${file.name}` } });
      const prepared = lists ? await prepareListUpload(file) : await prepareUpload(file);
      if (!prepared.ok) {
        notices.push(prepared.message);
        continue;
      }
      const sha256 = await sha256Hex(file).catch(() => "");
      const cleanName = meta?.[i]?.name ?? (lists ? listSetName(file.name) : file.name.replace(EXTENSION, ""));
      const defaultColor = PALETTE[(existing.length + newSets.length) % PALETTE.length];
      const id = `set-${nextId++}`;
      newSets.push({
        id,
        name: cleanName,
        code: meta?.[i]?.code ?? cleanName.slice(0, 3).toUpperCase(),
        color: defaultColor,
        defaultColor,
        fileName: file.name,
        fileSizeBytes: file.size,
        regions: [],
        nRegions: 0,
        nBp: 0,
        included: true,
        file: prepared.file,
        cleanFile: prepared.file,
        contentKey: id,
        blacklistHits: null,
        format: prepared.format,
        sha256,
        extents: prepared.extents,
        warnings: prepared.warnings,
        ...("items" in prepared ? { items: prepared.items } : {}),
        ...(meta?.[i]?.sourceUrl ? { sourceUrl: meta[i].sourceUrl } : {}),
      });
    }

    if (!newSets.length) {
      set({ notices, status: existing.length ? "done" : "idle", progress: null });
      return;
    }
    try {
      set({ status: "running", notices });
      const { assembly, blacklistFilter } = get();
      const merged = lists
        ? [...existing, ...newSets]
        : [...existing, ...(await applyBlacklistFilter(await checkBlacklist(newSets, assembly, (p) => set({ progress: p })), blacklistFilter, assembly))];
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(merged, flags, (p) => set({ progress: p }));
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, status: "done", progress: null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  loadChromSizes: async () => {
    const missing = SUPPORTED_ASSEMBLIES.filter((a) => !get().chromSizes[a]);
    if (!missing.length) return;
    const loaded = await Promise.all(
      missing.map(async (a) => {
        try {
          const res = await fetch(`${window.location.origin}${import.meta.env.BASE_URL}refdata/${a}/${a}.chrom.sizes`);
          return res.ok ? ([a, parseChromSizes(await res.text())] as const) : null;
        } catch {
          return null; // the assembly check is advisory — never block loading on it
        }
      })
    );
    const add = Object.fromEntries(loaded.filter((x) => x !== null));
    set({ chromSizes: { ...get().chromSizes, ...add } });
  },

  dismissNotices: () => set({ notices: [] }),

  removeSet: (id) => {
    void (async () => {
      const before = get().sets;
      const remaining = before.filter((s) => s.id !== id);
      forgetSet(id);
      forgetBlacklist(id);
      set({ status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(remaining, flags, (p) => set({ progress: p }));
      const stillValid = keepSelection(before, sets, subsets);
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  renameSet: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const sets = state.sets.map((s) => (s.id === id ? { ...s, name: trimmed } : s));
      // Cheap relabel, no bedtools recompute: mask/regions/memberIds are
      // unchanged, only the display name feeding subset labels/codes.
      const subsets = labelSubsets(state.subsets, sets);
      return { sets, subsets };
    });
  },

  setColor: (id, color) => {
    // No relabel needed (unlike renameSet) — Subset carries a code/label
    // derived from names, never a color; every consumer (UpSetPlot,
    // VennPlot) looks up sets.find(...)?.color live off this array.
    set((state) => ({ sets: state.sets.map((s) => (s.id === id ? { ...s, color } : s)) }));
  },

  resetColor: (id) => {
    set((state) => ({ sets: state.sets.map((s) => (s.id === id ? { ...s, color: s.defaultColor } : s)) }));
  },

  toggleIncluded: (id) => {
    void (async () => {
      const before = get().sets;
      const toggled = before.map((s) => (s.id === id ? { ...s, included: !s.included } : s));
      set({ sets: toggled, status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(toggled, flags, (p) => set({ progress: p }));
      const stillValid = keepSelection(before, sets, subsets);
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  setOverlapPreset: (preset) => {
    set({ overlapPreset: preset });
    void (async () => {
      const before = get().sets;
      set({ status: "running" });
      const flags = resolveOverlapFlags(preset, get().advancedBedtoolsOptions);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(get().sets, flags, (p) => set({ progress: p }));
      const stillValid = keepSelection(before, sets, subsets);
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  setAdvancedBedtoolsOptions: (value) => {
    set({ advancedBedtoolsOptions: value });
    void (async () => {
      const before = get().sets;
      set({ status: "running" });
      const flags = resolveOverlapFlags(get().overlapPreset, value);
      const { sets, subsets, usedFallback, fallbackOverlapUnsupported } = await recompute(get().sets, flags, (p) => set({ progress: p }));
      const stillValid = keepSelection(before, sets, subsets);
      set({ sets, subsets, usedFallback, fallbackOverlapUnsupported, selected: stillValid, status: "done", progress: null });
    })();
  },

  setAssembly: (assembly) => {
    set({ assembly });
    void (async () => {
      if (!get().sets.length) return;
      set({ status: "running", error: null });
      const checked = await checkBlacklist(get().sets, assembly, (p) => set({ progress: p }));
      if (!get().blacklistFilter) {
        // Counts only — the sets' content, and so every result, is unchanged.
        set({ sets: checked, status: "done", progress: null });
        return;
      }
      await rerunWith(await applyBlacklistFilter(checked, true, assembly));
    })();
  },

  setPairwiseStat: (stat) => set({ pairwiseStat: stat }),

  setBlacklistFilter: (on) => {
    set({ blacklistFilter: on });
    void (async () => {
      if (!get().sets.length) return;
      set({ status: "running", error: null });
      const { assembly } = get();
      const checked = await checkBlacklist(get().sets, assembly, (p) => set({ progress: p }));
      await rerunWith(await applyBlacklistFilter(checked, on, assembly));
    })();
  },

  setUpsetSort: (sort) => set({ upsetSort: sort }),

  setUpsetMinSize: (size) => set({ upsetMinSize: Math.max(0, size) }),

  toggleSelected: (mask) => {
    const selected = new Set(get().selected);
    if (selected.has(mask)) selected.delete(mask);
    else selected.add(mask);
    set({ selected });
  },

  clearSelected: () => set({ selected: new Set() }),

  setView: (view) => set({ view }),
  showInBrowser: (query, pad = true) => set((state) => ({ view: "browser", browserTarget: { query, pad, n: (state.browserTarget?.n ?? 0) + 1 } })),

  loadExample: async () => {
    set({ status: "loading-worker", error: null });
    try {
      const base = `${window.location.origin}${import.meta.env.BASE_URL}examples/hg38_ses`;
      const files = await Promise.all(
        ["MCF7.bed", "GM12878.bed", "K562.bed", "HepG2.bed"].map(async (name) => {
          const res = await fetch(`${base}/${name}`);
          if (!res.ok) throw new Error(`Could not load example file ${name}`);
          const blob = await res.blob();
          return new File([blob], name, { type: "text/plain" });
        })
      );
      // The example sets are hg38. Set the assembly explicitly so a user
      // who had switched to another one doesn't run Fisher/Reldist,
      // Summary or annotation against the wrong genome file.
      set({ sets: [], subsets: [], selected: new Set(), assembly: "hg38" });
      await get().addFiles(files);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  addExternalAnnotation: async (annotation) => {
    if (!annotation.path) return; // placeholder entry — nothing to load
    set({ status: "loading-worker", error: null, progress: { done: 0, total: 0, label: `Downloading ${annotation.name}` } });
    try {
      const url = `${window.location.origin}${import.meta.env.BASE_URL}${annotation.path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not load ${annotation.name}`);
      const blob = await res.blob();
      const file = new File([blob], `${annotation.id}.bed`, { type: "text/plain" });
      // addFiles() is additive (appends to the existing set list) and
      // already enforces the 6-set cap — same as any drag-and-dropped
      // file, no separate capacity logic needed here.
      await get().addFiles([file], [{ name: annotation.setName, code: annotation.code }]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  exportSelectedBedZip: async () => {
    const { subsets, selected, sets } = get();
    const chosen = chosenGroups(selected, subsets, sets.filter((s) => s.included));
    if (!chosen.length) return;
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const byId = new Map(sets.map((s) => [s.id, s]));
    const ext = get().inputMode === "lists" ? "txt" : "bed";
    for (const s of chosen) {
      zip.file(`${s.code || s.mask}.${ext}`, subsetFileText(s));
    }
    const memberNames = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? id).join(", ");
    const readme = [
      "# Achi subset export",
      "",
      ...(get().inputMode === "lists"
        ? ["Each .txt file is one combinatorial intersection subset of the lists (one name per line),", "computed in the browser by exact name matching. No data left this browser."]
        : ["Each .bed file is one combinatorial intersection subset, computed client-side", "with bedtools 2.31.0 (WASM) — see docs/provenance.md. No data left this browser."]),
      ...(get().blacklistFilter && hasBlacklist(get().assembly)
        ? [
            "",
            `ENCODE problematic-regions filter ON: regions overlapping the ENCODE problematic regions v2 (${get().assembly}) by at least 1 bp`,
            "were removed from every input set before intersecting (bedtools intersect -v).",
          ]
        : []),
      ...(chosen.some((s) => s.whole) ? ["", `Files ending in -all.${ext} hold a whole input set, as loaded${get().blacklistFilter && hasBlacklist(get().assembly) ? " and filtered" : ""}, not a subset.`] : []),
      "",
      ...chosen.map((s) =>
        get().inputMode === "lists"
          ? `- ${s.code || s.mask}.${ext} — ${s.label} (${memberNames(s.memberIds)}): ${s.nRegions} names`
          : `- ${s.code || s.mask}.${ext} — ${s.label} (${memberNames(s.memberIds)}): ${s.nRegions} regions, ${s.nBp} bp`
      ),
      "",
    ].join("\n");
    zip.file("README.md", readme);
    download(await zip.generateAsync({ type: "blob" }), "achi-subsets.zip");
  },

  exportSubsetBed: (mask) => {
    const s = chosenGroups([mask], get().subsets, get().sets.filter((x) => x.included))[0];
    if (!s) return;
    download(new Blob([subsetFileText(s)], { type: "text/plain" }), `${s.code || s.mask}.${s.items ? "txt" : "bed"}`);
  },

  setInputMode: (mode) => {
    if (mode === get().inputMode) return;
    for (const s of get().sets) {
      forgetSet(s.id);
      forgetBlacklist(s.id);
    }
    const view = get().view;
    const keepView = mode === "regions" || view === "upset" || view === "venn" || view === "table" || view === "help";
    set({ inputMode: mode, sets: [], subsets: [], selected: new Set(), notices: [], status: "idle", error: null, view: keepView ? view : "upset" });
  },

  loadExampleLists: async () => {
    set({ status: "loading-worker", error: null });
    try {
      const base = `${window.location.origin}${import.meta.env.BASE_URL}examples/lists`;
      const files = await Promise.all(
        ["MCF7_genes.txt", "GM12878_genes.txt", "K562_genes.txt", "HepG2_genes.txt"].map(async (name) => {
          const res = await fetch(`${base}/${name}`);
          if (!res.ok) throw new Error(`Could not load example file ${name}`);
          return new File([await res.blob()], name, { type: "text/plain" });
        })
      );
      get().setInputMode("lists");
      set({ sets: [], subsets: [], selected: new Set() });
      // Named by cell line, like the region example they come from.
      await get().addFiles(files, ["MCF7", "GM12878", "K562", "HepG2"].map((name) => ({ name, code: name.slice(0, 3).toUpperCase() })));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), status: "error", progress: null });
    }
  },

  exportAnalysis: async () => {
    const st = get();
    if (!st.sets.length) return;
    set({ progress: { done: 0, total: 0, label: "Preparing the analysis export" } });
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      const mode = st.inputMode;
      const byId = new Map(st.sets.map((x) => [x.id, x]));
      const chosen = chosenGroups(st.selected, st.subsets, st.sets.filter((x) => x.included));
      const settings = buildSettings({
        build: __APP_BUILD__,
        created: new Date().toISOString(),
        mode,
        assembly: st.assembly,
        overlapPreset: st.overlapPreset,
        advancedBedtoolsOptions: st.advancedBedtoolsOptions,
        overlapFlags: resolveOverlapFlags(st.overlapPreset, st.advancedBedtoolsOptions),
        blacklistFilter: st.blacklistFilter && hasBlacklist(st.assembly),
        upsetSort: st.upsetSort,
        upsetMinSize: st.upsetMinSize,
        pairwiseStat: st.pairwiseStat,
        view: st.view,
        sets: st.sets.map((x) => ({ name: x.name, fileName: x.fileName, code: x.code, color: x.color, included: x.included, n: x.nRegions, bp: x.nBp, sha256: x.sha256 })),
        selected: chosen.map((x) => ({ label: x.label, memberNames: x.memberIds.map((id) => byId.get(id)?.name ?? id), n: x.nRegions, ...(x.whole ? { whole: true } : {}) })),
      });
      const extras = collectExports();
      zip.file("settings.json", JSON.stringify(settings, null, 2) + "\n");
      zip.file("methods.md", methodsText(settings, extras.flatMap((e) => (e.methods ? [e.methods] : []))));
      zip.file("tables/sets.tsv", setsTsv(settings));
      zip.file("tables/subsets.tsv", subsetsTsv(st.subsets, st.sets, mode, st.selected));
      for (const x of st.subsets) zip.file(subsetFilePath(x, mode), subsetFileText(x));
      for (const e of extras) for (const f of e.files) zip.file(f.path, f.content);
      // Figures as drawn on screen now (the open view and the cards below it).
      const figures: string[] = [];
      const used = new Set<string>();
      document.querySelectorAll<SVGSVGElement>(".col.mid svg[role='img'][aria-label]").forEach((svg) => {
        const base = (svg.getAttribute("aria-label") ?? "figure").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "figure";
        let name = base;
        for (let k = 2; used.has(name); k++) name = `${base}-${k}`;
        used.add(name);
        zip.file(`figures/${name}.svg`, svgToStandaloneString(svg));
        figures.push(`figures/${name}.svg`);
      });
      const unit = mode === "lists" ? "names" : "regions";
      const readme = [
        "# Achi analysis export",
        "",
        `Exported ${settings.created} from ${settings.app.url} (build ${settings.app.commit}, ${settings.app.buildDate}).`,
        "Everything was computed in the browser; no data were uploaded.",
        "",
        "- methods.md: a methods paragraph for this analysis, with references.",
        "- settings.json: the parameters and the inputs' names, file names and SHA-256 checksums (no data).",
        "  Load it with \"Restore settings…\" in Achi, then load the same files, to restore the analysis.",
        "- tables/sets.tsv: the inputs.",
        `- tables/subsets.tsv: every subset (${st.subsets.length}), its members, size in ${unit}, and whether it was selected.`,
        `- subsets/: every subset as ${mode === "lists" ? ".txt (one name per line)" : ".bed"}.`,
        ...extras.flatMap((e) => e.files.map((f) => `- ${f.path}`)),
        ...(figures.length ? ["- figures/: the plots on screen at export time, as SVG:", ...figures.map((f) => `  - ${f}`)] : []),
        "",
      ].join("\n");
      zip.file("README.md", readme);
      download(await zip.generateAsync({ type: "blob" }), `achi-analysis-${settings.created.slice(0, 10)}.zip`);
    } finally {
      set({ progress: null });
    }
  },

  applySettings: async (text) => {
    const parsed = parseSettings(text);
    if ("error" in parsed) {
      set({ notices: [parsed.error] });
      return;
    }
    const s: AnalysisSettings = parsed;
    if (s.mode !== get().inputMode) get().setInputMode(s.mode);
    const notices = [`Settings restored from the analysis of ${s.created.slice(0, 10)}.`];
    if (get().sets.length) notices.push(...compareInputs(s, get().sets));
    else notices.push(`Now load the same files: ${s.sets.map((x) => x.fileName).join(", ")}.`);
    const flagsChanged = s.overlap.preset !== get().overlapPreset || s.overlap.advanced !== get().advancedBedtoolsOptions;
    const genomeChanged = s.assembly !== get().assembly || s.blacklistFilter !== get().blacklistFilter;
    set({
      overlapPreset: s.overlap.preset,
      advancedBedtoolsOptions: s.overlap.advanced,
      upsetSort: s.upset.sort,
      upsetMinSize: s.upset.minSize,
      pairwiseStat: s.pairwiseStat,
      view: (["upset", "venn", "pairwise", "table", "summary", "browser"] as View[]).includes(s.view as View) ? (s.view as View) : get().view,
      pendingSelection: s.selected,
      notices,
    });
    if (s.mode === "regions" && genomeChanged) {
      set({ assembly: s.assembly, blacklistFilter: s.blacklistFilter });
      if (get().sets.length) {
        const checked = await checkBlacklist(get().sets, s.assembly, (p) => set({ progress: p }));
        await rerunWith(await applyBlacklistFilter(checked, s.blacklistFilter, s.assembly));
      }
    } else if (flagsChanged && get().sets.length) await rerunWith(get().sets);
    get().applyPendingSelection();
  },

  applyPendingSelection: () => {
    const pending = get().pendingSelection;
    const included = get().sets.filter((x) => x.included);
    if (!pending || included.length < 2 || !get().subsets.length) return;
    // Matched by set names (lib/analysisExport.ts); re-applied as more files load, until every saved subset is found.
    const { masks, missing } = selectionFromSettings({ selected: pending } as AnalysisSettings, included.map((x) => x.name));
    const found = [...validSelection(masks, get().subsets, included)];
    set({ selected: new Set(found), pendingSelection: missing.length ? pending : null });
  },

  applyLinkSettings: (s) => {
    // Only called on page load, before any set exists, so nothing needs recomputing.
    set({
      ...(s.assembly !== undefined ? { assembly: s.assembly } : {}),
      ...(s.overlapPreset !== undefined ? { overlapPreset: s.overlapPreset } : {}),
      ...(s.advanced !== undefined ? { advancedBedtoolsOptions: s.advanced } : {}),
      ...(s.blacklistFilter !== undefined ? { blacklistFilter: s.blacklistFilter } : {}),
      ...(s.upsetSort !== undefined ? { upsetSort: s.upsetSort } : {}),
      ...(s.upsetMinSize !== undefined ? { upsetMinSize: s.upsetMinSize } : {}),
      ...(s.pairwiseStat !== undefined ? { pairwiseStat: s.pairwiseStat } : {}),
    });
  },

  addSignalFiles: async (files, source = "local", names) => {
    const added: SignalTrack[] = [];
    const problems: string[] = [];
    for (const [i, file] of files.entries()) {
      if (get().signalTracks.some((t) => t.file && t.file.name === file.name && t.file.size === file.size)) continue;
      try {
        await bigWigFor(file);
        added.push({ id: `signal-${nextId++}`, name: names?.[i] ?? file.name.replace(/\.(bw|bigwig)$/i, ""), file, source });
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
    set({ signalTracks: [...get().signalTracks, ...added], ...(problems.length ? { notices: [...get().notices, ...problems] } : {}) });
  },

  removeSignalTrack: (id) => set({ signalTracks: get().signalTracks.filter((t) => t.id !== id) }),

  addPublicSignal: (tracks) => {
    const have = new Set(get().signalTracks.map((t) => t.url));
    const added = tracks.filter((t) => !have.has(t.url)).map((t): SignalTrack => ({ id: `signal-${nextId++}`, name: t.name, url: t.url, source: "public" }));
    set({ signalTracks: [...get().signalTracks, ...added] });
  },

  loadExampleSignal: async () => {
    const base = `${window.location.origin}${import.meta.env.BASE_URL}examples/signal`;
    const cells = ["MCF7", "GM12878", "K562", "HepG2"];
    try {
      const files = await Promise.all(
        cells.map(async (c) => {
          const res = await fetch(`${base}/${c}_H3K27ac.example.bw`);
          if (!res.ok) throw new Error(`Could not load the example signal for ${c}.`);
          return new File([await res.blob()], `${c}_H3K27ac.example.bw`);
        })
      );
      await get().addSignalFiles(files, "example", cells.map((c) => `${c} H3K27ac`));
    } catch (err) {
      set({ notices: [...get().notices, err instanceof Error ? err.message : String(err)] });
    }
  },

  requestLink: (link) => set({ linkRequest: link.files.length ? link : null }),

  declineLink: () => set({ linkRequest: null }),

  acceptLink: async () => {
    const link = get().linkRequest;
    set({ linkRequest: null });
    if (!link?.files.length || !link.mode) return;
    // A link describes the whole analysis: its files replace any loaded now (the dialog says so).
    if (link.mode !== get().inputMode) get().setInputMode(link.mode);
    for (const s of get().sets) {
      forgetSet(s.id);
      forgetBlacklist(s.id);
    }
    set({ sets: [], subsets: [], selected: new Set(), status: "loading-worker", error: null });
    const files: File[] = [];
    const meta: { name?: string; sourceUrl: string }[] = [];
    const failed: string[] = [];
    for (const [i, f] of link.files.entries()) {
      set({ progress: { done: i, total: link.files.length, label: `Downloading ${f.name ?? f.fileName} from ${f.host}` } });
      try {
        // No cookies and no referrer: the file's server learns only that this browser downloaded the file.
        const res = await fetch(f.url, { credentials: "omit", referrerPolicy: "no-referrer" });
        if (!res.ok) {
          failed.push(fetchFailureMessage(f.url, { status: res.status }));
          continue;
        }
        const declared = Number(res.headers.get("content-length") ?? "");
        if (declared > MAX_FILE_BYTES) {
          failed.push(fetchFailureMessage(f.url, { tooLarge: declared }));
          continue;
        }
        const blob = await res.blob();
        if (blob.size > MAX_FILE_BYTES) {
          failed.push(fetchFailureMessage(f.url, { tooLarge: blob.size }));
          continue;
        }
        const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
        files.push(new File([blob], matchGzipName(f.fileName, head), { type: "text/plain" }));
        meta.push({ ...(f.name ? { name: f.name } : {}), sourceUrl: f.url });
      } catch (err) {
        failed.push(fetchFailureMessage(f.url, { error: err }));
      }
    }
    if (files.length) await get().addFiles(files, meta);
    else set({ status: get().sets.length ? "done" : "idle", progress: null });
    if (failed.length) set({ notices: [...get().notices, ...failed] });
  },
  };
});

/** The selected subsets and whole sets, in selection order (lib/selection.ts), for components. */
export function useChosenGroups(): Subset[] {
  const subsets = useStore((s) => s.subsets);
  const selected = useStore((s) => s.selected);
  const sets = useStore((s) => s.sets);
  return useMemo(() => chosenGroups(selected, subsets, sets.filter((s) => s.included)), [selected, subsets, sets]);
}
