import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BigWig } from "@gmod/bbi";
import { BlobFile } from "generic-filehandle2";
import { EXACT_MAX_REGIONS, estimateExact, layerChoices, layerReader, readSummaryLayer } from "./remoteSignal";
import { computeSignalMatrix, type ProfileParams, type ProfileRegion } from "@achi/core/signalMatrix";

/**
 * Public bigWigs for signal profiles. Private mode downloads a whole summary
 * (zoom) layer of the file, the same bytes whatever the regions, so the
 * server learns nothing about them. Tested on the real fixture
 * (tests/fixtures/deeptools: ENCODE K562 H3K27ac on chr21, zoom layers 64,
 * 256 and 1,024 bp), read through a counting file handle.
 */
const ROOT = join(__dirname, "..", "..");
const BYTES = new Uint8Array(readFileSync(join(ROOT, "tests/fixtures/deeptools/k562_h3k27ac_ENCFF381NDD.chr21_windows.bw")));

/** A BigWig over the fixture that records every byte range read. */
function countingBigWig() {
  const ranges: string[] = [];
  const blob = new Blob([BYTES]);
  const fh = new BlobFile(blob);
  const read = fh.read.bind(fh);
  fh.read = (length: number, position: number, opts?: object) => {
    ranges.push(`${position}+${length}`);
    return read(length, position, opts);
  };
  return { bw: new BigWig({ filehandle: fh }), ranges };
}

const SE: ProfileRegion[] = readFileSync(join(ROOT, "tests/fixtures/deeptools/k562_chr21_super_enhancers.bed"), "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split("\t"))
  .map((c) => ({ chrom: c[0], start: Number(c[1]), end: Number(c[2]) }));
const params: ProfileParams = { mode: "scale", referencePoint: "center", upstream: 10000, downstream: 10000, body: 5000, binSize: 1000, missingAsZero: false };

describe("layerChoices", () => {
  it("offers the file's layers between 100 bp and 20 kb, the default nearest 3 kb", () => {
    expect(layerChoices([40, 192, 768, 3072, 12288, 49152])).toEqual({ levels: [192, 768, 3072, 12288], preferred: 3072 });
    expect(layerChoices([64, 256, 1024])).toEqual({ levels: [256, 1024], preferred: 1024 });
    expect(layerChoices([10, 50_000])).toEqual({ levels: [], preferred: null });
  });
});

describe("readSummaryLayer", () => {
  it("reads one summary layer of every chromosome in full, and answers ranges from it", async () => {
    const { bw } = countingBigWig();
    const layer = await readSummaryLayer(bw, 1024);
    expect(layer.level).toBe(1024);
    const direct = await bw.getFeatures("chr21", 14_700_000, 14_800_000, { basesPerSpan: 512 });
    const got = await layer.read("chr21", 14_700_000, 14_800_000);
    expect(got.length).toBe(direct.length);
    got.forEach((x, i) => {
      expect(x.start).toBe(direct[i].start);
      expect(x.end).toBe(direct[i].end);
      expect(x.score).toBeCloseTo(direct[i].score!, 6);
    });
    // chr1 style or 21 style both answer
    expect((await layer.read("21", 14_700_000, 14_800_000)).length).toBe(direct.length);
  });

  it("reads the same bytes whatever the regions are: the regions never reach the file's server", async () => {
    const a = countingBigWig();
    const la = await readSummaryLayer(a.bw, 1024);
    await computeSignalMatrix(SE.slice(0, 3), la.read, params);
    const b = countingBigWig();
    const lb = await readSummaryLayer(b.bw, 1024);
    await computeSignalMatrix(SE.slice(5), lb.read, params);
    expect(a.ranges.length).toBeGreaterThan(0);
    expect(a.ranges).toEqual(b.ranges);
  });

  it("refuses a file without summary layers in range", async () => {
    const stub = { getHeader: async () => ({ zoomLevels: [], refsByName: {}, refsByNumber: {} }) } as unknown as BigWig;
    await expect(readSummaryLayer(stub, 3072)).rejects.toThrow(/no summary layer/i);
  });
});

describe("layerReader", () => {
  it("returns the items overlapping a range, by binary search", async () => {
    const read = layerReader(
      new Map([["chr1", { starts: Int32Array.from([0, 100, 200, 300]), ends: Int32Array.from([100, 200, 300, 400]), scores: Float32Array.from([1, 2, 3, 4]) }]])
    );
    expect((await read("chr1", 150, 301)).map((x) => x.score)).toEqual([2, 3, 4]);
    expect(await read("chr1", 400, 500)).toEqual([]);
    expect(await read("chr2", 0, 10)).toEqual([]);
  });
});

describe("computeSignalMatrix with concurrent reads", () => {
  it("gives the same matrix reading several regions at a time", async () => {
    const { bw } = countingBigWig();
    const read = async (c: string, s: number, e: number) => (await bw.getFeatures(c, s, e)).map((f) => ({ start: f.start, end: f.end, score: f.score! }));
    const one = await computeSignalMatrix(SE, read, params);
    const many = await computeSignalMatrix(SE, read, params, { concurrency: 4 });
    expect(Array.from(many.values)).toEqual(Array.from(one.values));
  });
});

describe("estimateExact", () => {
  it("scales with the file's bytes per base and the regions read, from the measured ENCODE rate", () => {
    // Measured on ENCFF381NDD (1.51 GB): 200 super-enhancer windows of ~34 kb read 11.8 MB in 27 s, 6 at a time.
    const e = estimateExact({ fileBytes: 1_511_112_441, genomeBp: 3_100_000_000, regionBp: 6_800_000, nRegions: 200 });
    expect(e.bytes).toBeGreaterThan(8e6);
    expect(e.bytes).toBeLessThan(16e6);
    expect(e.seconds).toBeGreaterThan(15);
    expect(e.seconds).toBeLessThan(40);
    expect(EXACT_MAX_REGIONS).toBe(2000);
  });
});
