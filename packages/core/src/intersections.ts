/**
 * Intersections of region sets, as the web app, CLI and MCP server run
 * them: every combination's subset with bedtools (pipeline.ts, the
 * Intervene command-line tool's definition), each set's regions, and the
 * subsets' names; plus the ENCODE blacklist check applied before it when
 * asked. List mode (names instead of regions) is lists.ts.
 */
import { blacklistHits, hasBlacklist, mountBlacklist } from "./blacklist";
import * as intervals from "./intervals";
import { computeSubsetsViaBedtools, subsetToBedText, type PipelineProgress, type PipelineSetInput, type PipelineSetResult } from "./pipeline";
import type { Runtime } from "./runtime";
import type { Interval, Subset } from "./types";

export interface IntersectionResult {
  /** Each input set, sorted (not merged), with its counts. */
  sets: PipelineSetResult[];
  /** Every non-empty combination, by membership mask. */
  subsets: intervals.SweepSubset[];
  /** bedtools failed and the pure-TypeScript algorithm (1 bp overlaps only) was used. */
  usedFallback: boolean;
  /** The fallback was used although overlap options were set, which it cannot apply. */
  fallbackOverlapUnsupported: boolean;
}

/**
 * Subsets of the given sets under `overlapFlags` (bedtoolsOptions.ts
 * resolveOverlapFlags). With `fallback` (the default, as in the web app), a
 * bedtools failure falls back to intervals.ts, which supports only the 1 bp
 * default; the CLI and MCP server pass `fallback: false` and report the
 * failure instead.
 */
export async function runIntersections(
  rt: Runtime,
  req: { sets: PipelineSetInput[]; overlapFlags: string },
  o: { onProgress?: (p: PipelineProgress) => void; fallback?: boolean } = {}
): Promise<IntersectionResult> {
  try {
    const result = await computeSubsetsViaBedtools(rt.bedtools, req.sets, req.overlapFlags, o.onProgress);
    return { ...result, usedFallback: false, fallbackOverlapUnsupported: false };
  } catch (err) {
    if (o.fallback === false) throw err;
    console.warn("bedtools failed, falling back to the TypeScript algorithm (intervals.ts)", err);
    const sets = await Promise.all(
      req.sets.map(async (s) => {
        const regions = intervals.sortIntervals(intervals.parseBed(await s.file.text()));
        return { id: s.id, regions, nRegions: regions.length, nBp: regions.reduce((bp, r) => bp + (r.end - r.start), 0) };
      })
    );
    const subsets = sets.length < 2 ? [] : intervals.computeSubsets(sets.map((s) => ({ id: s.id, regions: s.regions })));
    return { sets, subsets, usedFallback: true, fallbackOverlapUnsupported: req.overlapFlags !== "" };
  }
}

/** Subsets named by their sets: "Heart only", "Heart ∩ Liver", with the sets' codes joined ("HRT·LIV"). */
export function labelSubsets(
  raw: { mask: number; memberIds: string[]; regions: Interval[]; nRegions: number; nBp: number; items?: string[] }[],
  sets: { id: string; name: string; code: string }[]
): Subset[] {
  const byId = new Map(sets.map((s) => [s.id, s]));
  return raw.map((s) => {
    const members = s.memberIds.map((id) => byId.get(id)).filter((m): m is { id: string; name: string; code: string } => Boolean(m));
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
export function subsetFileText(s: Pick<Subset, "regions" | "items"> & { mask: number; memberIds: string[]; nRegions: number; nBp: number }): string {
  return s.items ? s.items.join("\n") + (s.items.length ? "\n" : "") : subsetToBedText(s);
}

/**
 * Each set's regions overlapping the assembly's ENCODE blacklist (v2) by
 * at least 1 bp: one 0/1 flag per line of its text. A set that cannot be
 * checked gets null (and `onFailure`), so loading never fails on it.
 * Assemblies without a blacklist give null for every set.
 */
export async function runBlacklistCheck(
  rt: Runtime,
  assembly: string,
  sets: { id: string; name: string; text: string }[],
  o: { onProgress?: (p: PipelineProgress) => void; onFailure?: (set: { id: string; name: string }, err: unknown) => void } = {}
): Promise<{ id: string; hits: Uint8Array | null }[]> {
  if (!hasBlacklist(assembly)) return sets.map((s) => ({ id: s.id, hits: null }));
  const out: { id: string; hits: Uint8Array | null }[] = [];
  for (const [done, s] of sets.entries()) {
    o.onProgress?.({ done, total: sets.length, label: `Checking ${s.name} against ENCODE problematic regions` });
    try {
      const path = await mountBlacklist(rt, assembly);
      out.push({ id: s.id, hits: await blacklistHits(rt.bedtools, s.id, s.text, path) });
    } catch (err) {
      o.onFailure?.(s, err);
      out.push({ id: s.id, hits: null });
    }
  }
  return out;
}
