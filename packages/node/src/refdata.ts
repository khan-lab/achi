/**
 * Reference data for the CLI and MCP server (@achi/core/runtime's RefData).
 *
 * Files come from the deployed Achi site, the same files the web app reads,
 * and are checked against the site's offline-manifest.json (the sha256 of
 * each file, first 16 hex digits, written by vite.config.ts at build time).
 * A file that does not match is refused and nothing is saved; there is no
 * other source to fall back on (CLAUDE.md). Verified files are kept in a
 * cache (~/.cache/achi, or $XDG_CACHE_HOME/achi), so after the first use no
 * network is needed.
 *
 * With `localDir` (a copy of the site's files, e.g. this repository's
 * public/ or a built dist/), files are read from there instead, unchecked.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_URL } from "@achi/core/analysisExport";
import type { RefData } from "@achi/core/runtime";

/** The site's offline-manifest.json (src/lib/offlineManifest.ts in the web app). */
export interface SiteManifest {
  version: string;
  shell: Record<string, string>;
  data: Record<string, { hash: string; bytes: number; assembly: string }>;
}

export interface NodeRefDataOptions {
  /** The Achi site the files come from; default the deployed site. */
  baseUrl?: string;
  /** Where verified files are kept; default ~/.cache/achi. */
  cacheDir?: string;
  /** Read files from this copy of the site's files instead (no download, no checksum). */
  localDir?: string;
  fetch?: typeof globalThis.fetch;
  /** Called for each file downloaded (not for cache hits). */
  onDownload?: (path: string, bytes: number) => void;
}

export type NodeRefData = RefData & {
  readonly baseUrl: string;
  readonly cacheDir: string;
  /** The site's manifest: from the cache, or downloaded (always downloaded with `refresh`). */
  manifest(refresh?: boolean): Promise<SiteManifest>;
  /** Download (or find in the cache) every file of an assembly, and the JASPAR matrices, for offline use. */
  fetchAssembly(assembly: string, onFile?: (path: string, i: number, n: number) => void): Promise<{ files: string[]; bytes: number }>;
};

export const DEFAULT_SITE = APP_URL;

export function defaultCacheDir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "achi");
}

const sha16 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);

function checkPath(path: string): string {
  if (!/^refdata\/[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some((p) => p === ".." || p === "." || p === "")) throw new Error(`Not a reference-data path: ${path}`);
  return path;
}

export function nodeRefData(o: NodeRefDataOptions = {}): NodeRefData {
  const baseUrl = (o.baseUrl ?? DEFAULT_SITE).replace(/\/?$/, "/");
  const cacheDir = o.cacheDir ?? defaultCacheDir();
  const doFetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  let current: { m: SiteManifest; fresh: boolean } | null = null;

  const download = async (path: string): Promise<Buffer> => {
    let res: Response;
    try {
      res = await doFetch(baseUrl + path, { redirect: "follow" });
    } catch (err) {
      throw new Error(`Could not download ${path} from ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res.ok) throw new Error(`Could not download ${path} from ${baseUrl} (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  };

  const manifest = async (refresh = false): Promise<SiteManifest> => {
    if (current && (!refresh || current.fresh)) return current.m;
    const saved = join(cacheDir, "manifest.json");
    if (!refresh && existsSync(saved)) {
      current = { m: JSON.parse(await readFile(saved, "utf8")) as SiteManifest, fresh: false };
      return current.m;
    }
    const m = JSON.parse((await download("offline-manifest.json")).toString("utf8")) as SiteManifest;
    if (!m || typeof m !== "object" || !m.shell || !m.data) throw new Error(`${baseUrl}offline-manifest.json is not an Achi reference-data manifest.`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(saved, JSON.stringify(m));
    current = { m, fresh: true };
    return m;
  };

  const hashIn = (m: SiteManifest, path: string) => m.shell[path] ?? m.data[path]?.hash;
  const cachedPath = (path: string, hash: string) => join(cacheDir, "files", `${hash}-${path.replaceAll("/", "_")}`);

  /** The verified bytes of a file: from the cache, or downloaded and checked. A stale saved manifest is refreshed once. */
  const ensure = async (path: string): Promise<Buffer> => {
    let m = await manifest();
    let hash = hashIn(m, path);
    if (!hash && current && !current.fresh) hash = hashIn((m = await manifest(true)), path);
    if (!hash) throw new Error(`${path} is not in the reference-data manifest of ${baseUrl}`);
    const at = cachedPath(path, hash);
    if (existsSync(at)) return readFile(at);
    let bytes = await download(path);
    if (sha16(bytes) !== hash && current && !current.fresh) {
      // The site may have been updated since the manifest was saved.
      hash = hashIn(await manifest(true), path);
      if (hash) bytes = await download(path);
    }
    if (!hash || sha16(bytes) !== hash)
      throw new Error(`${path} from ${baseUrl} does not match its checksum in the site's manifest (expected ${hash}, got ${sha16(bytes)}). Nothing was saved; try again later, or report it if it persists.`);
    const final = cachedPath(path, hash);
    await mkdir(join(cacheDir, "files"), { recursive: true });
    const tmp = `${final}.${process.pid}.part`;
    await writeFile(tmp, bytes);
    await rename(tmp, final);
    o.onDownload?.(path, bytes.length);
    return bytes;
  };

  return {
    baseUrl,
    cacheDir,
    manifest,
    async text(path) {
      checkPath(path);
      if (o.localDir) return readFile(join(o.localDir, path), "utf8");
      return (await ensure(path)).toString("utf8");
    },
    async fetchAssembly(assembly, onFile) {
      const m = await manifest(true);
      const files = [...Object.keys(m.shell), ...Object.keys(m.data)].filter((p) => p.startsWith(`refdata/${assembly}/`) || p.startsWith("refdata/jaspar/"));
      let bytes = 0;
      for (const [i, p] of files.entries()) {
        onFile?.(p, i, files.length);
        bytes += (await ensure(p)).length;
      }
      return { files, bytes };
    },
  };
}
