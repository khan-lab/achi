import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobFile } from "generic-filehandle2";
import { centreWindow, twoBitBlobSource, twoBitHandleSource, type SeqWindow } from "./genomeSequence";

/**
 * Genome sequence for motif scanning, from a .2bit on the user's computer.
 * A real .2bit of hg38 slices (tests/fixtures/twobit: an N gap, soft-masked
 * repeats, and a non-canonical sequence), checked against the same
 * sequences as FASTA. The network sources are tested in the web app
 * (src/lib/genomeSequence.test.ts).
 */
const DIR = join(__dirname, "..", "..", "..", "tests", "fixtures", "twobit");
const BYTES = new Uint8Array(readFileSync(join(DIR, "mini.2bit")));
const FASTA = new Map(
  readFileSync(join(DIR, "mini.fa"), "utf8")
    .split(">")
    .filter(Boolean)
    .map((b) => {
      const [head, ...rest] = b.split("\n");
      return [head.trim(), rest.join("")] as const;
    })
);
const truth = (w: SeqWindow) => FASTA.get(w.chrom)!.slice(w.start, w.end).toUpperCase();

const WINDOWS_A: SeqWindow[] = [
  { chrom: "chr21", start: 9_900, end: 10_100 }, // across the end of the N gap
  { chrom: "chr21", start: 30_000, end: 30_200 },
  { chrom: "chr22", start: 100, end: 300 },
];

describe("centreWindow", () => {
  it("is ±half around the region's centre (floor), clamped at 0", () => {
    expect(centreWindow({ chrom: "chr1", start: 1000, end: 1501 }, 100)).toEqual({ chrom: "chr1", start: 1150, end: 1350 });
    expect(centreWindow({ chrom: "chr1", start: 0, end: 20 }, 100)).toEqual({ chrom: "chr1", start: 0, end: 110 });
  });
});

describe("twoBitBlobSource (a .2bit on the user's computer)", () => {
  it("reads the windows, N gap included, in either naming style", async () => {
    const src = twoBitBlobSource(new Blob([BYTES]), "mini.2bit");
    const got = await src.read([...WINDOWS_A, { chrom: "21", start: 30_000, end: 30_200 }, { chrom: "chr9", start: 0, end: 10 }]);
    WINDOWS_A.forEach((w, i) => expect(got[i]!.toUpperCase()).toBe(truth(w)));
    expect(got[0]!.slice(0, 100)).toBe("N".repeat(100));
    expect(got[3]!.toUpperCase()).toBe(truth(WINDOWS_A[1]));
    expect(got[4]).toBeNull();
  });
});

describe("twoBitHandleSource (a .2bit through any file handle: the CLI's file on disk)", () => {
  it("reads the same windows as the Blob source, several at a time, in order, with progress, under the label given", async () => {
    const windows = Array.from({ length: 450 }, (_, i) => WINDOWS_A[i % 3]);
    const progress: number[] = [];
    const src = twoBitHandleSource(new BlobFile(new Blob([BYTES])), "local .2bit mini.2bit", { concurrency: 8 });
    expect(src.label).toBe("local .2bit mini.2bit");
    const got = await src.read(windows, { onProgress: (p) => progress.push(p.done) });
    windows.forEach((w, i) => expect(got[i]!.toUpperCase()).toBe(truth(w)));
    expect(progress).toEqual([200, 400]);
    expect(twoBitBlobSource(new Blob([BYTES]), "mini.2bit").label).toBe(src.label);
  });
});
