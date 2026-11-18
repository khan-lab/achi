/**
 * Data shapes shared by every layer (web app, CLI, MCP server): intervals,
 * input sets and the intersection subsets computed from them.
 */

export interface Interval {
  chrom: string;
  start: number;
  end: number;
}

/** One user-loaded region set (a dropped BED/narrowPeak file). */
export interface RegionSet {
  id: string;
  name: string;
  /** 3-char label used in plots — set identity, carried everywhere. */
  code: string;
  color: string;
  /** The originally auto-assigned palette color, kept so a user-picked color can be reset. */
  defaultColor: string;
  fileName: string;
  fileSizeBytes: number;
  /** Sorted (not merged) regions for this set alone — taken as given. */
  regions: Interval[];
  nRegions: number;
  nBp: number;
  /** Whether this set is included in the current subset computation. */
  included: boolean;
  /** List mode (lib/lists.ts): the list's names, unique, in file order; `regions` stays empty and `nRegions` counts names. */
  items?: string[];
}

/** One combinatorial intersection subset, keyed by membership bitmask. */
export interface Subset {
  /** Bitmask over `RegionSet.id` order at computation time. */
  mask: number;
  memberIds: string[];
  label: string;
  code: string;
  degree: number;
  regions: Interval[];
  nRegions: number;
  nBp: number;
  /** List mode: the names in this subset (instead of regions). */
  items?: string[];
  /** A whole input set selected as a group (lib/selection.ts): its own regions or names, keyed by a negative mask. */
  whole?: boolean;
}

/** Most region sets that can be compared at once. */
export const MAX_SETS = 8;
