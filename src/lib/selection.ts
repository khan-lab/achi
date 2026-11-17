/**
 * What the analyses run on: the selected subsets and, next to them, whole
 * sets. A subset is keyed by its membership mask (always positive; bit i is
 * the i-th included set, lib/pipeline.ts). A whole set is keyed by the
 * negative of its bit (-1 the first included set, -2 the second, -4 the
 * third...), so both live in the one `selected` collection, links and
 * settings files without colliding.
 *
 * A whole set is the set's own regions as loaded (after the blacklist
 * filter when that is on), or its names in list mode — not its subsets put
 * back together. Where a test needs every locus once (the input-sets
 * background of subset and GO enrichment), the set is the subsets it is a
 * member of (`inGroup`). Sets overlap each other and their own subsets, so
 * tests between two selected groups are skipped where they share regions
 * (`sharesRegions`).
 */
import type { RegionSet, Subset } from "../types";

/** The selection key of the included set at subset bit `bit`. */
export function setKey(bit: number): number {
  return -(1 << bit);
}

/** The subset bit of a set key, or null if `key` is not one (subset masks are positive). */
export function setBitOf(key: number): number | null {
  if (key >= 0 || !Number.isInteger(key)) return null;
  const m = -key;
  if (m & (m - 1)) return null;
  const bit = Math.log2(m);
  return bit < 8 ? bit : null;
}

export const isSetKey = (key: number): boolean => setBitOf(key) !== null;

/** A whole set as a selectable group: the set's own regions (or names), labelled "<name> (all)". */
export function setGroup(set: RegionSet, bit: number): Subset {
  return {
    mask: setKey(bit),
    memberIds: [set.id],
    label: `${set.name} (all)`,
    code: `${set.code}-all`,
    degree: 1,
    regions: set.regions,
    nRegions: set.items ? set.items.length : set.nRegions,
    nBp: set.items ? 0 : set.nBp,
    whole: true,
    ...(set.items ? { items: set.items } : {}),
  };
}

/** The selected groups, in selection order: subsets by mask, whole sets by set key. Keys with nothing behind them are skipped. */
export function chosenGroups(selected: Iterable<number>, subsets: Subset[], included: RegionSet[]): Subset[] {
  const out: Subset[] = [];
  for (const key of selected) {
    const bit = setBitOf(key);
    if (bit !== null) {
      if (bit < included.length) out.push(setGroup(included[bit], bit));
    } else {
      const s = subsets.find((x) => x.mask === key);
      if (s) out.push(s);
    }
  }
  return out;
}

/** The keys of `selected` that still have a subset or an included set behind them. */
export function validSelection(selected: Iterable<number>, subsets: { mask: number }[], included: unknown[]): Set<number> {
  return new Set(
    [...selected].filter((key) => {
      const bit = setBitOf(key);
      return bit !== null ? bit < included.length : subsets.some((s) => s.mask === key);
    })
  );
}

/** Whether a universe region owned by subset `owner` belongs to the group `key`: that subset, or for a whole set every subset it is a member of. */
export function inGroup(owner: number, key: number): boolean {
  const bit = setBitOf(key);
  return bit === null ? owner === key : (owner & (1 << bit)) !== 0;
}

/**
 * Whether two selected groups can hold the same loci: a group with itself;
 * a whole set with any subset it is a member of; two whole sets when some
 * non-empty subset is in both. Two different subsets never do: they
 * partition the input.
 */
export function sharesRegions(a: number, b: number, subsets: { mask: number; nRegions: number }[]): boolean {
  if (a === b) return true;
  const ba = setBitOf(a);
  const bb = setBitOf(b);
  if (ba === null && bb === null) return false;
  if (ba !== null && bb !== null) return subsets.some((s) => s.nRegions > 0 && (s.mask & (1 << ba)) !== 0 && (s.mask & (1 << bb)) !== 0);
  const [bit, mask] = ba !== null ? [ba, b] : [bb!, a];
  return (mask & (1 << bit)) !== 0;
}

/**
 * The selection after the included sets change (one removed, left out, or
 * added): each subset and whole set follows its sets, by id, to their new
 * bits; anything involving a set that is no longer included is dropped.
 * Selection order is kept.
 */
export function remapSelection(selected: Iterable<number>, before: { id: string }[], after: { id: string }[]): number[] {
  const newBit = before.map((s) => after.findIndex((a) => a.id === s.id));
  const out: number[] = [];
  for (const key of selected) {
    const bit = setBitOf(key);
    if (bit !== null) {
      const nb = newBit[bit] ?? -1;
      if (nb >= 0) out.push(setKey(nb));
      continue;
    }
    let mask = 0;
    let ok = key > 0;
    for (let b = 0; b < before.length && ok; b++) {
      if (!(key & (1 << b))) continue;
      if (newBit[b] < 0) ok = false;
      else mask |= 1 << newBit[b];
    }
    if (ok && mask) out.push(mask);
  }
  return out;
}
