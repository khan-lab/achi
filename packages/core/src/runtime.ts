/**
 * What core needs from the environment it runs in. The web app, the CLI and
 * the MCP server each implement these (CLAUDE.md, "Core, CLI and MCP"), and
 * core reaches the outside world only through them: no fetch, no file
 * system, no workers of its own.
 *
 *   web:      bedtools 2.31.0 compiled to WebAssembly; reference data read
 *             from the site that served the page (and its offline cache).
 *   CLI, MCP: native bedtools >= 2.31 from PATH; reference data from the
 *             local cache, downloaded from the deployed site and checked
 *             against checksums.
 */

import type { MotifScanner } from "./motifScan";

export interface BedtoolsResult {
  stdout: string;
  stderr: string;
}

/**
 * bedtools, run on files mounted under one directory. Commands are written
 * in full, e.g. `bedtools intersect -a ${bt.dir}/a.bed -b ${bt.dir}/b.bed -c`;
 * mount names never contain spaces, so a command splits into arguments on
 * whitespace with no shell involved.
 */
export interface Bedtools {
  /** Directory where mounted files appear, as used in commands (no trailing slash). */
  readonly dir: string;
  /** Write files under `dir`, replacing any with the same name. */
  mount(files: { name: string; data: string }[]): Promise<void>;
  /** Remove mounted files by name; names that are not mounted are ignored. */
  unmount(names: string[]): Promise<void>;
  /** Run one bedtools command and return its output. */
  exec(command: string): Promise<BedtoolsResult>;
  /**
   * Start the next batch of work from a clean state, keeping what is
   * mounted. The WebAssembly build needs this (its heap only grows); for
   * native bedtools it does nothing.
   */
  reset(): Promise<void>;
}

/**
 * Reference data bundled with Achi (public/ in this repository), by path
 * relative to the site root, e.g. "refdata/hg38/hg38.chrom.sizes".
 */
export interface RefData {
  /** The file's text; rejects if it cannot be read (missing, failed download or checksum). */
  text(path: string): Promise<string>;
}

export interface Runtime {
  bedtools: Bedtools;
  refdata: RefData;
  /** Motif scanning, spread over the environment's threads (motifScan.ts; scanMotifsInline on one thread). */
  scanMotifs: MotifScanner;
}

/** Throws an AbortError ("Cancelled") if the run was cancelled. */
export function abortIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

/** `rt.refdata.text(path)`, rejecting with "Could not load <what>" (the underlying error as its cause). */
export async function loadRefText(rt: Pick<Runtime, "refdata">, path: string, what: string): Promise<string> {
  try {
    return await rt.refdata.text(path);
  } catch (cause) {
    throw new Error(`Could not load ${what}`, { cause });
  }
}

/** Work done once per owner (a bedtools, a reference-data source), by key. */
const onceDone = new WeakMap<object, Map<string, { value: Promise<unknown>; done: boolean }>>();

/**
 * `load()` once per owner and key; later and concurrent callers share the
 * same result. A failed load is forgotten, so the next call tries again.
 * Keyed on the runtime part the work belongs to: a reference file mounted
 * in a bedtools (owner rt.bedtools), or data read and prepared from
 * reference data (owner rt.refdata).
 */
export function onceFor<T>(owner: object, key: string, load: () => Promise<T>): Promise<T> {
  let byKey = onceDone.get(owner);
  if (!byKey) onceDone.set(owner, (byKey = new Map()));
  const cached = byKey.get(key);
  if (cached) return cached.value as Promise<T>;
  const entry = { value: load() as Promise<unknown>, done: false };
  byKey.set(key, entry);
  entry.value.then(
    () => (entry.done = true),
    () => byKey.delete(key)
  );
  return entry.value as Promise<T>;
}

/** Whether `onceFor(owner, key, …)` has finished successfully. */
export function isDoneFor(owner: object, key: string): boolean {
  return onceDone.get(owner)?.get(key)?.done ?? false;
}

/** Lets other work (a page repaint, a progress message) run during a long computation. */
export const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
