import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIntersections } from "@achi/core/intersections";
import { scanMotifsInline } from "@achi/core/motifScan";
import { forgetSet } from "@achi/core/pipeline";
import { memoryBedtools } from "@achi/core/testkit";
import { nativeBedtools, parseBedtoolsVersion } from "./nativeBedtools";

/** Native bedtools for the CLI and MCP server. Real ENCODE fixtures; the tests that run bedtools are skipped without it on PATH. */
const hasBedtools = (() => {
  try {
    execFileSync("bedtools", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const describeIfBedtools = hasBedtools ? describe : describe.skip;
const ROOT = join(__dirname, "../../..");
const fixtures = ["heart_h3k27ac_ENCFF059ERB.subsample.bed", "liver_h3k27ac_ENCFF805YRQ.subsample.bed", "lung_h3k27ac_ENCFF314QTE.subsample.bed"].map((f) => readFileSync(join(ROOT, "tests/fixtures/encode", f), "utf8"));

/** A stand-in bedtools binary that only prints a version, for the version check. */
function fakeBinary(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "achi-fake-bedtools-"));
  const path = join(dir, "bedtools");
  writeFileSync(path, `#!/bin/sh\necho "bedtools ${version}"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("parseBedtoolsVersion", () => {
  it("reads 'bedtools v2.31.1' as [2, 31, 1]", () => {
    expect(parseBedtoolsVersion("bedtools v2.31.1\n")).toEqual([2, 31, 1]);
    expect(parseBedtoolsVersion("bedtools 2.30.0")).toEqual([2, 30, 0]);
    expect(parseBedtoolsVersion("hello")).toBeNull();
  });
});

describe("nativeBedtools: finding it", () => {
  it("says how to install it when it is not on PATH", async () => {
    await expect(nativeBedtools({ binary: "/nonexistent/bedtools" })).rejects.toThrow(/bedtools was not found .*bioconda/);
  });
  it("refuses a version older than 2.31", async () => {
    await expect(nativeBedtools({ binary: fakeBinary("v2.30.0") })).rejects.toThrow("Achi needs bedtools 2.31 or newer; /");
  });
});

describeIfBedtools("nativeBedtools: running it", () => {
  it("mounts files in its own directory, runs commands without a shell, and removes the directory on close", async () => {
    const bt = await nativeBedtools();
    expect(bt.version[0]).toBe(2);
    expect(bt.dir).not.toMatch(/\s/);
    await bt.mount([{ name: "a.bed", data: "chr1\t10\t20\nchr1\t30\t40\n" }, { name: "b.bed", data: "chr1\t15\t16\n" }]);
    const res = await bt.exec(`bedtools intersect -a ${bt.dir}/a.bed -b ${bt.dir}/b.bed -c`);
    expect(res.stdout).toBe("chr1\t10\t20\t1\nchr1\t30\t40\t0\n");
    await bt.unmount(["b.bed", "never-mounted.bed"]);
    expect(existsSync(join(bt.dir, "b.bed"))).toBe(false);
    await expect(bt.exec(`bedtools intersect -a ${bt.dir}/a.bed -b ${bt.dir}/b.bed`)).rejects.toThrow(/bedtools intersect failed/);
    await expect(bt.exec("rm -rf /")).rejects.toThrow("Only bedtools commands run here");
    await expect(bt.mount([{ name: "../escape.bed", data: "" }])).rejects.toThrow("Not a plain file name");
    const dir = bt.dir;
    await bt.close();
    expect(existsSync(dir)).toBe(false);
  });

  it("gives the same intersections as the 1 bp algorithm on real ENCODE peaks", async () => {
    const bt = await nativeBedtools();
    const rt = (bedtools: typeof bt | ReturnType<typeof memoryBedtools>) => ({ bedtools, refdata: { text: async () => "" }, scanMotifs: scanMotifsInline });
    const sets = (p: string) => fixtures.map((t, i) => ({ id: `${p}${i}`, name: `S${i}`, file: new Blob([t]) }));
    const native = await runIntersections(rt(bt), { sets: sets("n"), overlapFlags: "" }, { fallback: false });
    const memory = await runIntersections(rt(memoryBedtools()), { sets: sets("m"), overlapFlags: "" });
    const strip = (r: typeof native) => r.subsets.map((s) => [s.mask, s.nRegions, s.nBp, s.regions]).sort((a, b) => (a[0] as number) - (b[0] as number));
    expect(strip(native)).toEqual(strip(memory));
    ["n", "m"].forEach((p) => fixtures.forEach((_, i) => forgetSet(`${p}${i}`)));
    await bt.close();
  });
});
