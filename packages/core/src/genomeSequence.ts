/**
 * Genome sequence for motif scanning (pwm.ts): where the bases of each
 * window come from. A SequenceSource returns the bases of each window, or
 * null when it has no such chromosome. Core provides the source for a .2bit
 * held locally (a file on the user's computer, or in the CLI's cache); the
 * web app adds sources that read public .2bit files over the network
 * (src/lib/genomeSequence.ts).
 *
 * The .2bit decoding is @gmod/twobit (MIT).
 */
import { TwoBitFile } from "@gmod/twobit";
import { BlobFile } from "generic-filehandle2";
import { chromAlias } from "./bigwigSource";
import { abortIfCancelled } from "./runtime";

export interface SeqWindow {
  chrom: string;
  start: number;
  end: number;
}

/** Bases each side of a region's centre that are scanned. */
export const WINDOW_HALF = 100;

/** ±half around the region's centre (floor((start + end) / 2)), clamped at 0. */
export function centreWindow(r: { chrom: string; start: number; end: number }, half = WINDOW_HALF): SeqWindow {
  const c = Math.floor((r.start + r.end) / 2);
  return { chrom: r.chrom, start: Math.max(0, c - half), end: c + half };
}

export interface ReadOptions {
  onProgress?: (p: { done: number; total: number; label: string; unit?: string }) => void;
  signal?: AbortSignal;
}

export interface SequenceSource {
  /** For the methods text and the note under the result. */
  label: string;
  read(windows: SeqWindow[], o?: ReadOptions): Promise<(string | null)[]>;
}

/** Sequences of the canonical chromosomes, the only ones the private source downloads. */
export const CANONICAL = /^chr([1-9]|1[0-9]|2[0-2]|X|Y|M)$/;

/** Windows read through a TwoBitFile, `concurrency` at a time, names matched in either style (chr1 / 1). */
async function readWindows(tb: TwoBitFile, windows: SeqWindow[], o: ReadOptions & { concurrency?: number; label?: string } = {}): Promise<(string | null)[]> {
  const names = new Map((await tb.getSequenceNames()).map((n) => [n, 0]));
  const out: (string | null)[] = new Array(windows.length).fill(null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < windows.length) {
      abortIfCancelled(o.signal);
      const i = next++;
      const w = windows[i];
      const name = chromAlias(w.chrom, names);
      if (name) out[i] = (await tb.getSequence(name, w.start, w.end)) ?? null;
      if (++done % 200 === 0) o.onProgress?.({ done, total: windows.length, label: o.label ?? "Reading sequence", unit: "regions" });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 1) }, worker));
  return out;
}

/** A .2bit on the user's computer. */
export function twoBitBlobSource(blob: Blob, name: string): SequenceSource {
  const tb = new TwoBitFile({ filehandle: new BlobFile(blob) });
  return { label: `local .2bit ${name}`, read: (windows, o) => readWindows(tb, windows, o) };
}

