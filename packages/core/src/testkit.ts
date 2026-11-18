/**
 * For tests: a bedtools stand-in that keeps mounted files in memory and
 * answers the two commands the set-level code relies on most, with 1 bp
 * overlaps and no other options:
 *   bedtools sort -i A            -> A as mounted
 *   bedtools intersect -a A -b B -c -> each A line plus its count of B regions overlapping it
 * Anything else throws, so a test notices a command it did not expect.
 * Native bedtools is checked against the real thing in differential.test.ts.
 */
import type { Bedtools } from "./runtime";

export function memoryBedtools(dir = "/data"): Bedtools & { files: Map<string, string>; calls: string[] } {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const rows = (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`not mounted: ${path}`);
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
  };
  return {
    dir,
    files,
    calls,
    reset: async () => {},
    mount: async (fs) => {
      for (const f of fs) files.set(`${dir}/${f.name}`, f.data);
    },
    unmount: async (names) => {
      for (const n of names) files.delete(`${dir}/${n}`);
    },
    exec: async (cmd) => {
      calls.push(cmd);
      const sort = cmd.match(/^bedtools sort -i (\S+)$/);
      if (sort) return { stdout: files.get(sort[1]) ?? "", stderr: "" };
      const inter = cmd.match(/^bedtools intersect -a (\S+) -b (\S+) -c$/);
      if (!inter) throw new Error(`memoryBedtools does not run: ${cmd}`);
      const b = rows(inter[2]);
      const out = rows(inter[1]).map((r) => [...r, b.filter((q) => q[0] === r[0] && +q[1] < +r[2] && +r[1] < +q[2]).length].join("\t"));
      return { stdout: out.length ? out.join("\n") + "\n" : "", stderr: "" };
    },
  };
}
