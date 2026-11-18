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
