import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { scanMotifsInline } from "@achi/core/motifScan";
import { encodeSequence, packSequences, type Background } from "@achi/core/pwm";
import { defaultThreads, threadedMotifScanner } from "./motifThreads";

/**
 * The motif scan on Node worker threads must give exactly what the
 * one-thread scan gives (itself checked against MOODS in core). Real data:
 * hg38 sequence around example super-enhancers and the JASPAR matrices of
 * tests/fixtures/motifs. Worker threads run JavaScript, so the test first
 * bundles a worker entry the way the CLI's build does.
 */
const DIR = join(__dirname, "..", "..", "..", "tests", "fixtures", "motifs");
const expected: { background: Background; p: number; motifs: { pfm: number[][] }[] } = JSON.parse(readFileSync(join(DIR, "expected_moods.json"), "utf8"));
const packed = packSequences(
  readFileSync(join(DIR, "sequences.fa"), "utf8")
    .split(">")
    .filter(Boolean)
    .map((b) => encodeSequence(b.split("\n").slice(1).join("").trim()))
);
const pfms = expected.motifs.map((m) => m.pfm);
let entry = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "achi-motif-worker-"));
  const src = join(dir, "entry.ts");
  writeFileSync(src, `import { isMotifWorker, runMotifWorker } from ${JSON.stringify(join(__dirname, "motifThreads.ts"))};\nif (isMotifWorker()) runMotifWorker();\n`);
  await build({
    configFile: false,
    logLevel: "silent",
    build: { ssr: src, target: "node20", outDir: join(dir, "dist"), minify: false, rollupOptions: { external: [...builtinModules, /^node:/], output: { entryFileNames: "worker.js", format: "es" } } },
    ssr: { noExternal: true, target: "node" },
  });
  entry = join(dir, "dist", "worker.js");
}, 60_000);

describe("threadedMotifScanner", () => {
  it("gives exactly the one-thread result, motif by motif, and reports progress to the end", async () => {
    const inline = await scanMotifsInline(packed, pfms, expected.background, expected.p);
    const progress: number[] = [];
    const r = await threadedMotifScanner({ entry, threads: 3 })(packed, pfms, expected.background, expected.p, { onProgress: (d, t) => progress.push(d / t) });
    expect(Array.from(r.thresholds)).toEqual(Array.from(inline.thresholds));
    expect(r.hits.map((h) => Array.from(h))).toEqual(inline.hits.map((h) => Array.from(h)));
    expect(progress).toHaveLength(pfms.length);
    expect(progress.at(-1)).toBe(1);
  });

  it("scans on this thread with one thread, or more threads than motifs", async () => {
    const inline = await scanMotifsInline(packed, pfms.slice(0, 1), expected.background, expected.p);
    const r = await threadedMotifScanner({ entry: "/nonexistent/worker.js", threads: 1 })(packed, pfms.slice(0, 1), expected.background, expected.p);
    expect(Array.from(r.hits[0])).toEqual(Array.from(inline.hits[0]));
    const r2 = await threadedMotifScanner({ entry: "/nonexistent/worker.js", threads: 4 })(packed, pfms.slice(0, 1), expected.background, expected.p);
    expect(Array.from(r2.hits[0])).toEqual(Array.from(inline.hits[0]));
  });

  it("stops with an AbortError when cancelled, before or during the scan", async () => {
    const scan = threadedMotifScanner({ entry, threads: 2 });
    await expect(scan(packed, pfms, expected.background, expected.p, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    const ac = new AbortController();
    const running = scan(packed, pfms, expected.background, expected.p, { signal: ac.signal, onProgress: (d) => d === 1 && ac.abort() });
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails with a clear message when a thread cannot start", async () => {
    await expect(threadedMotifScanner({ entry: "/nonexistent/worker.js", threads: 2 })(packed, pfms, expected.background, expected.p)).rejects.toThrow(/motif scan/i);
  });

  it("uses one thread fewer than the computer has, from 1 to 8", () => {
    expect(defaultThreads()).toBeGreaterThanOrEqual(1);
    expect(defaultThreads()).toBeLessThanOrEqual(8);
  });
});
