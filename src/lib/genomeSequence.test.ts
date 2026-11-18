import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { centreWindow, exactTwoBitSource, privateTwoBitSource, twoBitBlobSource, type SeqWindow } from "./genomeSequence";

/**
 * Genome sequence for motif scanning, read in the page. A real .2bit of hg38
 * slices (tests/fixtures/twobit: an N gap, soft-masked repeats, and a
 * non-canonical sequence), checked against the same sequences as FASTA.
 * The remote sources are served from the fixture by a fake fetch that
 * records every request.
 */
const DIR = join(__dirname, "..", "..", "tests", "fixtures", "twobit");
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

/** A fetch that serves the fixture (Range and HEAD) and records what was asked. */
function fakeFetch() {
  const log: string[] = [];
  const f = async (_url: string, init?: RequestInit) => {
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
    if (init?.method === "HEAD") {
      log.push("HEAD");
      return new Response(null, { status: 200, headers: { "Content-Length": String(BYTES.length) } });
    }
    const range = new Headers(init?.headers).get("Range")!;
    const [, a, b] = range.match(/bytes=(\d+)-(\d+)/)!;
    log.push(`${a}-${b}`);
    return new Response(BYTES.slice(Number(a), Math.min(BYTES.length, Number(b) + 1)), { status: 206 });
  };
  return { fetch: f as unknown as typeof fetch, log };
}

const WINDOWS_A: SeqWindow[] = [
  { chrom: "chr21", start: 9_900, end: 10_100 }, // across the end of the N gap
  { chrom: "chr21", start: 30_000, end: 30_200 },
  { chrom: "chr22", start: 100, end: 300 },
];
const WINDOWS_B: SeqWindow[] = [{ chrom: "chr22", start: 25_000, end: 25_200 }];

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

describe("privateTwoBitSource (whole chromosomes from a public .2bit)", () => {
  it("reads the same windows as the file itself", async () => {
    const { fetch } = fakeFetch();
    const got = await privateTwoBitSource("https://example.org/mini.2bit", { fetch }).read(WINDOWS_A);
    WINDOWS_A.forEach((w, i) => expect(got[i]!.toUpperCase()).toBe(truth(w)));
  });

  it("requests the same bytes whatever the regions: the index and every canonical chromosome in full, never the others", async () => {
    const a = fakeFetch();
    const b = fakeFetch();
    await privateTwoBitSource("https://example.org/mini.2bit", { fetch: a.fetch }).read(WINDOWS_A);
    await privateTwoBitSource("https://example.org/mini.2bit", { fetch: b.fetch }).read(WINDOWS_B);
    expect(a.log).toEqual(b.log);
    // HEAD (file size), the header and index, then chr21 and chr22 whole; chrUn_test (the last record) never.
    const ranges = a.log.filter((x) => x !== "HEAD").map((r) => r.split("-").map(Number));
    const lastRecordStart = BYTES.length - (8 + 4 + 12 * 8 + 4 + Math.ceil(5000 / 4)); // chrUn_test: 12 mask blocks, no N blocks
    expect(ranges.every(([, end]) => end < lastRecordStart)).toBe(true);
  });

  it("gives null for windows on chromosomes it does not download", async () => {
    const { fetch } = fakeFetch();
    const got = await privateTwoBitSource("https://example.org/mini.2bit", { fetch }).read([{ chrom: "chrUn_test", start: 0, end: 10 }, ...WINDOWS_B]);
    expect(got[0]).toBeNull();
    expect(got[1]!.toUpperCase()).toBe(truth(WINDOWS_B[0]));
  });

  it("keeps downloaded chromosomes in the store it is given, and reads them from there next time", async () => {
    const saved = new Map<string, Blob>();
    const store = { get: async (k: string) => saved.get(k) ?? null, put: async (k: string, bytes: Uint8Array) => (saved.set(k, new Blob([bytes as BlobPart])), saved.get(k)!) };
    const first = fakeFetch();
    await privateTwoBitSource("https://example.org/mini.2bit", { fetch: first.fetch, store }).read(WINDOWS_A);
    expect(saved.size).toBe(2);
    const second = fakeFetch();
    const got = await privateTwoBitSource("https://example.org/mini.2bit", { fetch: second.fetch, store }).read(WINDOWS_B);
    expect(got[0]!.toUpperCase()).toBe(truth(WINDOWS_B[0]));
    // Only the size and the index again; no chromosome.
    expect(second.log.length).toBeLessThan(first.log.length);
  });
});

describe("exactTwoBitSource (range requests per region)", () => {
  it("reads the same sequence, with fewer bytes, but which bytes depends on the regions", async () => {
    const a = fakeFetch();
    const b = fakeFetch();
    const got = await exactTwoBitSource("https://example.org/mini.2bit", { fetch: a.fetch }).read(WINDOWS_A);
    WINDOWS_A.forEach((w, i) => expect(got[i]!.toUpperCase()).toBe(truth(w)));
    await exactTwoBitSource("https://example.org/mini.2bit", { fetch: b.fetch }).read(WINDOWS_B);
    expect(a.log).not.toEqual(b.log);
  });
});

describe("exactTwoBitSource: what it downloads", () => {
  /** Byte ranges of each record's soft-mask table in the fixture (start, end), from the .2bit layout. */
  function maskTables(): [number, number][] {
    const v = new DataView(BYTES.buffer, BYTES.byteOffset, BYTES.byteLength);
    const count = v.getUint32(8, true);
    const out: [number, number][] = [];
    let pos = 16;
    for (let k = 0; k < count; k++) {
      const nameLen = BYTES[pos];
      const offset = v.getUint32(pos + 1 + nameLen, true);
      pos += 1 + nameLen + 4;
      const nBlocks = v.getUint32(offset + 4, true);
      const maskAt = offset + 8 + nBlocks * 8;
      const maskCount = v.getUint32(maskAt, true);
      if (maskCount) out.push([maskAt + 4, maskAt + 4 + maskCount * 8]);
    }
    return out;
  }
  it("never downloads the soft-mask tables (case is not needed) and reads each window's bytes once", async () => {
    const a = fakeFetch();
    const many = Array.from({ length: 40 }, (_, k) => ({ chrom: "chr21", start: 12_000 + k * 500, end: 12_200 + k * 500 }));
    const got = await exactTwoBitSource("https://example.org/mini.2bit", { fetch: a.fetch }).read(many);
    many.forEach((w, i) => expect(got[i]).toBe(truth(w)));
    // The index read starts at byte 16 and is at least 4 KB (twobit), which in this 19 KB fixture runs into
    // the first record; on hg38 the index alone is ~10 KB. Every other read must miss the mask tables.
    const ranges = a.log.filter((x) => x !== "HEAD").map((r) => r.split("-").map(Number)).filter(([s]) => s > 16);
    for (const [ms, me] of maskTables()) expect(ranges.some(([s, e]) => s < me && e >= ms)).toBe(false);
    // Index, chr21's header and N table, then one request per window.
    expect(ranges.length).toBeLessThanOrEqual(many.length + 4);
  });
});
