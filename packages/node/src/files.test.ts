import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { localTwoBitSource, readInputFile } from "./files";

/** Input files from disk, as the web app reads uploads: gzip by name, the same size limits, cleaned to BED. Real ENCODE fixture. */
const FIXTURE = join(__dirname, "../../../tests/fixtures/encode/heart_h3k27ac_ENCFF059ERB.subsample.bed");
const dir = mkdtempSync(join(tmpdir(), "achi-files-"));

describe("readInputFile", () => {
  it("reads a region file, cleaned, named after the file", async () => {
    const r = await readInputFile(FIXTURE);
    expect(r).toMatchObject({ ok: true, name: "heart_h3k27ac_ENCFF059ERB.subsample", code: "HEA", fileName: "heart_h3k27ac_ENCFF059ERB.subsample.bed", warnings: [] });
    if (r.ok) expect(await r.file.text()).toBe(readFileSync(FIXTURE, "utf8"));
  });
  it("decompresses .gz files, as the web app does", async () => {
    const gz = join(dir, "heart.bed.gz");
    writeFileSync(gz, gzipSync(readFileSync(FIXTURE)));
    const r = await readInputFile(gz);
    expect(r).toMatchObject({ ok: true, name: "heart", fileName: "heart.bed.gz" });
    if (r.ok) expect(await r.file.text()).toBe(readFileSync(FIXTURE, "utf8"));
    writeFileSync(join(dir, "fake.bed.gz"), "not gzip");
    expect(await readInputFile(join(dir, "fake.bed.gz"))).toEqual({ ok: false, message: "fake.bed.gz could not be read — is it really gzip-compressed?" });
  });
  it("says why a file cannot be used", async () => {
    writeFileSync(join(dir, "words.bed"), "hello world\n");
    expect(await readInputFile(join(dir, "words.bed"))).toMatchObject({ ok: false, message: expect.stringMatching(/^words\.bed /) });
    expect(await readInputFile(join(dir, "missing.bed"))).toMatchObject({ ok: false, message: expect.stringMatching(/^missing\.bed could not be read/) });
  });
});

describe("localTwoBitSource", () => {
  it("reads windows from a .2bit on disk, labelled as the web app labels a local .2bit", async () => {
    const src = localTwoBitSource(join(__dirname, "../../../tests/fixtures/twobit/mini.2bit"));
    expect(src.label).toBe("local .2bit mini.2bit");
    const fasta = readFileSync(join(__dirname, "../../../tests/fixtures/twobit/mini.fa"), "utf8");
    const chr22 = fasta.split(">").find((b) => b.startsWith("chr22"))!.split("\n").slice(1).join("");
    expect((await src.read([{ chrom: "chr22", start: 100, end: 300 }]))[0]).toBe(chr22.slice(100, 300));
  });
});
