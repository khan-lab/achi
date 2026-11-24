import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeRefData, type SiteManifest } from "./refdata";

/**
 * Reference data for the CLI and MCP server: files downloaded from the Achi
 * site, checked against its offline-manifest.json (sha256, first 16 hex, as
 * vite.config.ts writes it) and cached. The "site" here is a stand-in fetch
 * serving this repository's public/ files, with a manifest computed from them.
 */
const PUBLIC = join(__dirname, "../../../public");
const BASE = "https://example.org/achi/";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const FILES = ["refdata/hg38/hg38.chrom.sizes", "refdata/hg38/genes_tss.bed", "refdata/jaspar/jaspar2026_core_vertebrates_nr.json"];
const manifest: SiteManifest = {
  version: "test",
  shell: { "refdata/hg38/hg38.chrom.sizes": hash(readFileSync(join(PUBLIC, FILES[0]))), "refdata/jaspar/jaspar2026_core_vertebrates_nr.json": hash(readFileSync(join(PUBLIC, FILES[2]))) },
  data: { "refdata/hg38/genes_tss.bed": { hash: hash(readFileSync(join(PUBLIC, FILES[1]))), bytes: readFileSync(join(PUBLIC, FILES[1])).length, assembly: "hg38" } },
};

function site(o: { tamper?: string; manifest?: SiteManifest } = {}) {
  const asked: string[] = [];
  const fetch = async (url: string | URL) => {
    const u = String(url);
    asked.push(u.slice(BASE.length));
    if (!u.startsWith(BASE)) return new Response("no", { status: 404 });
    const path = u.slice(BASE.length);
    if (path === "offline-manifest.json") return new Response(JSON.stringify(o.manifest ?? manifest));
    if (path === o.tamper) return new Response("chr1\t1\n");
    try {
      return new Response(readFileSync(join(PUBLIC, path)));
    } catch {
      return new Response("missing", { status: 404 });
    }
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, asked };
}
const cache = () => mkdtempSync(join(tmpdir(), "achi-cache-"));

describe("nodeRefData", () => {
  it("downloads a file once, checks it against the manifest and reads it from the cache after that", async () => {
    const s = site();
    const dir = cache();
    const rd = nodeRefData({ baseUrl: BASE, cacheDir: dir, fetch: s.fetch });
    const text = await rd.text(FILES[0]);
    expect(text).toBe(readFileSync(join(PUBLIC, FILES[0]), "utf8"));
    expect(await rd.text(FILES[0])).toBe(text);
    expect(s.asked).toEqual(["offline-manifest.json", FILES[0]]);

    // Another process with the same cache needs no network at all.
    const offline = nodeRefData({ baseUrl: BASE, cacheDir: dir, fetch: (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch });
    expect(await offline.text(FILES[0])).toBe(text);
  });

  it("refuses a file whose content does not match the manifest, and caches nothing", async () => {
    const s = site({ tamper: FILES[1] });
    const dir = cache();
    const rd = nodeRefData({ baseUrl: BASE, cacheDir: dir, fetch: s.fetch });
    await expect(rd.text(FILES[1])).rejects.toThrow(/refdata\/hg38\/genes_tss\.bed from https:\/\/example\.org\/achi\/ does not match its checksum/);
    const saved = existsSync(join(dir, "files")) ? readdirSync(join(dir, "files")) : [];
    expect(saved).toEqual([]);
  });

  it("refuses a file the site does not list, and a failed download, without trying anywhere else", async () => {
    const s = site();
    const rd = nodeRefData({ baseUrl: BASE, cacheDir: cache(), fetch: s.fetch });
    await expect(rd.text("refdata/hg38/not-there.bed")).rejects.toThrow("refdata/hg38/not-there.bed is not in the reference-data manifest of https://example.org/achi/");
    const broken = { ...manifest, shell: { ...manifest.shell, "refdata/hg38/gone.txt": "0000000000000000" } };
    const rd2 = nodeRefData({ baseUrl: BASE, cacheDir: cache(), fetch: site({ manifest: broken }).fetch });
    await expect(rd2.text("refdata/hg38/gone.txt")).rejects.toThrow("Could not download refdata/hg38/gone.txt from https://example.org/achi/ (HTTP 404)");
  });

  it("reads a local copy of the site's files directly when given one (no download, no manifest)", async () => {
    const rd = nodeRefData({ localDir: PUBLIC, fetch: (async () => Promise.reject(new Error("no network"))) as unknown as typeof fetch });
    expect(await rd.text(FILES[2])).toBe(readFileSync(join(PUBLIC, FILES[2]), "utf8"));
    await expect(rd.text("../package.json")).rejects.toThrow("Not a reference-data path");
  });

  it("fetches every file of an assembly (and the JASPAR matrices) for offline use", async () => {
    const s = site();
    const dir = cache();
    const rd = nodeRefData({ baseUrl: BASE, cacheDir: dir, fetch: s.fetch });
    const got = await rd.fetchAssembly("hg38");
    expect(got.files.sort()).toEqual([...FILES].sort());
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });
});
