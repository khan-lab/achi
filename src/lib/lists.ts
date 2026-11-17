/**
 * List mode: Intervene's "list" input type. Each set is a list of names
 * (gene symbols, SNP IDs, any identifiers) and sets are intersected by exact
 * match of those names, in the page (no bedtools). The subsets have the same
 * shape as region subsets, so the UpSet plot, Venn diagram, table, selection
 * and exports work unchanged; a subset's `items` replace its regions.
 */
import type { Interval } from "../types";
import { InputValidationError } from "./inputValidation";

/** Most names read from one list. */
export const MAX_LIST_ITEMS = 2_000_000;

/** File names accepted in list mode. */
export const LIST_EXTENSION = /\.(txt|tsv|csv|lst|list)(\.gz)?$/i;

export interface ParsedList {
  /** Unique names, in the order they first appear. */
  items: string[];
  /** Lines repeating a name already read. */
  nDuplicates: number;
  /** Blank lines and lines starting with #. */
  nSkipped: number;
}

/**
 * One name per line: the first column of a tab-, comma- or
 * semicolon-separated line, trimmed, surrounding quotes removed. Lines that
 * are blank or start with # are skipped. Names are compared exactly
 * (case-sensitive), as in the Intervene command-line tool.
 */
export function parseListText(text: string): ParsedList {
  const items: string[] = [];
  const seen = new Set<string>();
  let nDuplicates = 0;
  let nSkipped = 0;
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop(); // the file's final newline
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      nSkipped++;
      continue;
    }
    const name = line.split(/[\t,;]/)[0].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
    if (!name) {
      nSkipped++;
      continue;
    }
    if (seen.has(name)) {
      nDuplicates++;
      continue;
    }
    if (items.length >= MAX_LIST_ITEMS) throw new InputValidationError(`has more than ${MAX_LIST_ITEMS.toLocaleString("en-US")} names, the browser limit.`);
    seen.add(name);
    items.push(name);
  }
  if (!items.length) throw new InputValidationError("has no names: expected one name per line.");
  return { items, nDuplicates, nSkipped };
}

/** Set name from a list's file name: the extension (and .gz) dropped. */
export function listSetName(fileName: string): string {
  return fileName.replace(/\.gz$/i, "").replace(/\.(txt|tsv|csv|lst|list)$/i, "");
}

export interface ListSubset {
  mask: number;
  memberIds: string[];
  items: string[];
  regions: Interval[];
  nRegions: number;
  nBp: number;
}

/**
 * Every combination of lists that shares at least one name: bit i of the
 * mask is the i-th list (as for region subsets, lib/intervals.ts). Each name
 * belongs to exactly one subset, the one for exactly the lists containing
 * it. Sorted by size, largest first; `nRegions` holds the number of names.
 */
export function computeListSubsets(sets: { id: string; items: string[] }[]): ListSubset[] {
  if (sets.length < 2) return [];
  const maskOf = new Map<string, number>();
  sets.forEach((s, i) => {
    for (const item of s.items) maskOf.set(item, (maskOf.get(item) ?? 0) | (1 << i));
  });
  const byMask = new Map<number, string[]>();
  for (const [item, mask] of maskOf) {
    let list = byMask.get(mask);
    if (!list) byMask.set(mask, (list = []));
    list.push(item);
  }
  return [...byMask.entries()]
    .map(([mask, items]) => ({
      mask,
      memberIds: sets.filter((_, i) => mask & (1 << i)).map((s) => s.id),
      items,
      regions: [],
      nRegions: items.length,
      nBp: 0,
    }))
    .sort((a, b) => b.nRegions - a.nRegions || a.mask - b.mask);
}
