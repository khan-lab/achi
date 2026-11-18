/**
 * A bigWig on the user's computer, for signal profiles (lib/signalMatrix.ts).
 * @gmod/bbi (MIT) reads it through a BlobFile (generic-filehandle2, MIT):
 * only the index and the byte ranges of the regions asked for are read, in the
 * page, so a file of any size works and nothing is uploaded or fetched.
 */
import { BigWig } from "@gmod/bbi";
import { BlobFile } from "generic-filehandle2";
import type { SignalInterval } from "./signalMatrix";

export interface BigWigSource {
  /** Chromosome name -> length, as named in the file. */
  chroms: Map<string, number>;
  /** Intervals with data overlapping [start, end) on `chrom` (either naming style: chr1 or 1); [] if the file has no such chromosome. */
  read: (chrom: string, start: number, end: number) => Promise<SignalInterval[]>;
}

const BIGWIG = 0x888ffc26;
const BIGBED = 0x8789f2eb;

async function magic(file: Blob): Promise<number[]> {
  const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (b.length < 4) return [];
  return [(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0];
}

/** The file's name for `name`: the same, or the other naming style (chr1 <-> 1, chrM <-> MT); null if it has neither. */
export function chromAlias(name: string, chroms: Map<string, number>): string | null {
  const candidates = [name, name.startsWith("chr") ? name.slice(3) : `chr${name}`];
  if (name === "chrM") candidates.push("MT");
  if (name === "MT" || name === "M") candidates.push("chrM");
  return candidates.find((c) => chroms.has(c)) ?? null;
}

export async function openBigWig(file: Blob & { name?: string }): Promise<BigWigSource> {
  const name = file.name ?? "This file";
  const m = await magic(file);
  if (m.includes(BIGBED)) throw new Error(`${name} is a bigBed (regions), not a bigWig (signal).`);
  if (!m.includes(BIGWIG)) throw new Error(`${name} is not a bigWig: it does not start with the bigWig signature.`);
  return sourceFromBigWig(new BigWig({ filehandle: new BlobFile(file) }));
}

/** Chromosomes and a range reader at base resolution, for any opened BigWig (local, or remote in exact mode). */
export async function sourceFromBigWig(bw: BigWig): Promise<BigWigSource> {
  const header = await bw.getHeader();
  const chroms = new Map<string, number>();
  for (const [chrom, info] of Object.entries(header.refsByName)) chroms.set(chrom, header.refsByNumber[info]?.length ?? 0);
  const read = async (chrom: string, start: number, end: number): Promise<SignalInterval[]> => {
    const c = chromAlias(chrom, chroms);
    if (!c || end <= 0) return [];
    const features = await bw.getFeatures(c, Math.max(0, start), end);
    return features.filter((f) => f.score !== undefined && !Number.isNaN(f.score)).map((f) => ({ start: f.start, end: f.end, score: f.score as number }));
  };
  return { chroms, read };
}

const opened = new WeakMap<Blob, Promise<BigWigSource>>();

/** openBigWig, once per file for the page session (the header and index are read once). */
export function bigWigFor(file: Blob & { name?: string }): Promise<BigWigSource> {
  let p = opened.get(file);
  if (!p) {
    p = openBigWig(file);
    opened.set(file, p);
    p.catch(() => opened.delete(file));
  }
  return p;
}
