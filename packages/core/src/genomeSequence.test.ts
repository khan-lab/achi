import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { centreWindow, twoBitBlobSource, type SeqWindow } from "./genomeSequence";

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
