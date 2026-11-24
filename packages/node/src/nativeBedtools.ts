/**
 * Native bedtools for the CLI and MCP server (@achi/core/runtime's
 * Bedtools): files are mounted in a private temporary directory and each
 * command runs as the bedtools binary with its arguments, no shell. Needs
 * bedtools >= 2.31 on PATH (the web app runs 2.31.0 compiled to
 * WebAssembly; differential.test.ts compares the two).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bedtools, BedtoolsResult } from "@achi/core/runtime";

export const MIN_BEDTOOLS: [number, number, number] = [2, 31, 0];

export type NativeBedtools = Bedtools & {
  /** The binary's version, e.g. [2, 31, 1]. */
  version: [number, number, number];
  /** Removes the mount directory. */
  close(): Promise<void>;
};

/** [major, minor, patch] from `bedtools --version` output ("bedtools v2.31.1"), or null. */
export function parseBedtoolsVersion(text: string): [number, number, number] | null {
  const m = text.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const older = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function run(binary: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

const INSTALL = "Install bedtools 2.31 or newer, e.g. `conda install -c bioconda bedtools`, and make sure it is on PATH.";

export async function nativeBedtools(o: { binary?: string; tmpRoot?: string } = {}): Promise<NativeBedtools> {
  const binary = o.binary ?? "bedtools";
  let probe: Awaited<ReturnType<typeof run>>;
  try {
    probe = await run(binary, ["--version"]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`bedtools was not found (${binary}). ${INSTALL}`);
    throw err;
  }
  const version = parseBedtoolsVersion(probe.stdout + probe.stderr);
  if (!version) throw new Error(`Could not read the version of ${binary}: "${(probe.stdout + probe.stderr).trim()}". ${INSTALL}`);
  if (older(version, MIN_BEDTOOLS) < 0) throw new Error(`Achi needs bedtools ${MIN_BEDTOOLS.slice(0, 2).join(".")} or newer; ${binary} is ${version.join(".")}. ${INSTALL}`);

  const dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), "achi-bedtools-"));
  if (/\s/.test(dir)) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`The temporary directory ${dir} has a space in its path, which bedtools commands cannot take here. Set TMPDIR to a path without spaces.`);
  }
  const plain = (name: string) => {
    if (!/^[^/\\\s]+$/.test(name) || name === "." || name === "..") throw new Error(`Not a plain file name: ${name}`);
    return join(dir, name);
  };

  return {
    dir,
    version,
    async mount(files) {
      for (const f of files) await writeFile(plain(f.name), f.data);
    },
    async unmount(names) {
      for (const n of names) await unlink(plain(n)).catch(() => {});
    },
    async exec(command): Promise<BedtoolsResult> {
      const [tool, ...args] = command.trim().split(/\s+/);
      if (tool !== "bedtools") throw new Error(`Only bedtools commands run here, not: ${command}`);
      const r = await run(binary, args);
      if (r.code !== 0) throw new Error(`bedtools ${args[0] ?? ""} failed (exit code ${r.code}): ${r.stderr.trim().split("\n")[0] ?? ""}`);
      return { stdout: r.stdout, stderr: r.stderr };
    },
    async reset() {},
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
