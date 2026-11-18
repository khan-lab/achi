/**
 * Genome sequence for motif scanning, the sources only the web app has
 * (the interface, and the source for a local .2bit, are in
 * @achi/core/genomeSequence). Each returns the bases of each window, or null
 * when the source has no such chromosome:
 *
 * - a reference FASTA + .fai on the user's computer (lib/localTracks.ts);
 * - private: a public .2bit (UCSC), downloaded as whole chromosomes — the
 *   index and every canonical chromosome (chr1–22, X, Y, M) in full, in
 *   file order, whatever the regions — so the server learns nothing about
 *   them. Kept in a store (the browser's private file system) for next time;
 *   regions on other sequences are not scanned;
 * - exact: a public .2bit read by range requests per region: little data,
 *   but the requests show roughly where the regions are (asked every time).
 *
 * The .2bit decoding is @gmod/twobit (MIT); its only file access is
 * `read(length, position)`, which the private source serves from whole
 * downloaded chromosomes and nothing else.
 */
import { TwoBitFile } from "@gmod/twobit";
import { BlobFile, RemoteFile } from "generic-filehandle2";
import { chromAlias } from "@achi/core/bigwigSource";
import { CANONICAL, type SequenceSource } from "@achi/core/genomeSequence";
import { abortIfCancelled } from "@achi/core/runtime";
import { readReferenceSequence, type LocalReference } from "./localTracks";

const NO_COOKIES = { credentials: "omit", referrerPolicy: "no-referrer" } as const;

/** A reference FASTA with its .fai on the user's computer. */
export function fastaSource(ref: LocalReference): SequenceSource {
  return {
    label: `local FASTA ${ref.name}`,
    async read(windows, o = {}) {
      const out: (string | null)[] = [];
      for (const [i, w] of windows.entries()) {
        abortIfCancelled(o.signal);
        out.push(await readReferenceSequence(ref, w.chrom, w.start, w.end));
        if ((i + 1) % 200 === 0) o.onProgress?.({ done: i + 1, total: windows.length, label: "Reading sequence", unit: "regions" });
      }
      return out;
    },
  };
}

/** Bases of 2-bit codes in a .2bit's packed DNA (T C A G = 0 1 2 3). */
const TCAG = "TCAG";

/**
 * A public .2bit, read by range requests per region (the server sees
 * roughly where the regions are). Reads the index, then for each
 * chromosome only its size and N-gap table, then each window's packed
 * bytes; the soft-mask tables (several MB per chromosome, only for
 * lower case) are skipped. Bases come back in upper case.
 */
export function exactTwoBitSource(url: string, o: { fetch?: typeof fetch; concurrency?: number } = {}): SequenceSource {
  const fh = new RemoteFile(url, { overrides: NO_COOKIES, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const tb = new TwoBitFile({ filehandle: fh });
  const meta = new Map<string, Promise<{ size: number; nStarts: Uint32Array; nSizes: Uint32Array; dna: number }>>();
  const recordOf = (name: string, offset: number) => {
    let m = meta.get(name);
    if (!m) {
      m = (async () => {
        const h = await fh.read(8, offset);
        const hv = new DataView(h.buffer, h.byteOffset, 8);
        const size = hv.getUint32(0, true);
        const nCount = hv.getUint32(4, true);
        const nb = await fh.read(nCount * 8 + 4, offset + 8);
        const nv = new DataView(nb.buffer, nb.byteOffset, nb.byteLength);
        const nStarts = new Uint32Array(nCount);
        const nSizes = new Uint32Array(nCount);
        for (let k = 0; k < nCount; k++) {
          nStarts[k] = nv.getUint32(k * 4, true);
          nSizes[k] = nv.getUint32(nCount * 4 + k * 4, true);
        }
        const maskCount = nv.getUint32(nCount * 8, true);
        return { size, nStarts, nSizes, dna: offset + 8 + nCount * 8 + 4 + maskCount * 8 + 4 };
      })();
      meta.set(name, m);
    }
    return m;
  };
  return {
    label: `${new URL(url).host}, exact (range requests per region)`,
    async read(windows, ro = {}) {
      const index = await tb.getIndex();
      const names = new Map(Object.keys(index).map((n) => [n, 0]));
      const out: (string | null)[] = new Array(windows.length).fill(null);
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < windows.length) {
          abortIfCancelled(ro.signal);
          const i = next++;
          const w = windows[i];
          const name = chromAlias(w.chrom, names);
          if (name) {
            const r = await recordOf(name, index[name]);
            const s = Math.max(0, w.start);
            const e = Math.min(r.size, w.end);
            if (e > s) {
              const first = Math.floor(s / 4);
              const bytes = await fh.read(Math.floor((e - 1) / 4) - first + 1, r.dna + first);
              const chars = new Array<string>(e - s);
              for (let p = s; p < e; p++) chars[p - s] = TCAG[(bytes[Math.floor(p / 4) - first] >> (6 - 2 * (p % 4))) & 3];
              for (let k = 0; k < r.nStarts.length; k++) {
                const a = Math.max(s, r.nStarts[k]);
                const b = Math.min(e, r.nStarts[k] + r.nSizes[k]);
                for (let p = a; p < b; p++) chars[p - s] = "N";
              }
              out[i] = chars.join("");
            } else out[i] = "";
          }
          if (++done % 200 === 0) ro.onProgress?.({ done, total: windows.length, label: "Reading sequence", unit: "regions" });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 6) }, worker));
      return out;
    },
  };
}

/** Where downloaded chromosomes are kept between runs (OPFS in the page; anything with this shape in tests). */
export interface RecordStore {
  get(key: string): Promise<Blob | null>;
  put(key: string, bytes: Uint8Array): Promise<Blob>;
}

/** The browser's origin private file system, or null where it is missing (private windows of some browsers). */
export async function opfsStore(folder: string): Promise<RecordStore | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(folder, { create: true });
    const safe = (k: string) => k.replace(/[^A-Za-z0-9._-]+/g, "_");
    return {
      async get(key) {
        try {
          return await (await dir.getFileHandle(safe(key))).getFile();
        } catch {
          return null;
        }
      },
      async put(key, bytes) {
        const h = await dir.getFileHandle(safe(key), { create: true });
        const w = await h.createWritable();
        await w.write(bytes as unknown as BufferSource);
        await w.close();
        return h.getFile();
      },
    };
  } catch {
    return null;
  }
}

interface Record2bit {
  name: string;
  start: number;
  end: number;
}

/**
 * A public .2bit read privately: the header and index, then each canonical
 * chromosome whole (from the store when it is there), one at a time; the
 * windows on it are read from those bytes only.
 */
export function privateTwoBitSource(url: string, o: { fetch?: typeof fetch; store?: RecordStore | null; canonical?: RegExp } = {}): SequenceSource {
  const doFetch = o.fetch ?? fetch.bind(globalThis);
  const canonical = o.canonical ?? CANONICAL;
  const get = async (start: number, end: number) => {
    const res = await doFetch(url, { ...NO_COOKIES, headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} for ${url}`);
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length !== end - start) throw new Error(`${new URL(url).host} sent ${b.length} bytes instead of ${end - start}`);
    return b;
  };

  return {
    label: `${new URL(url).host}, private (whole chromosomes)`,
    async read(windows, ro = {}) {
      const head = await doFetch(url, { ...NO_COOKIES, method: "HEAD" });
      const size = Number(head.headers.get("Content-Length"));
      if (!head.ok || !Number.isFinite(size) || size <= 0) throw new Error(`Could not get the size of ${url}`);

      // The header and index: read through twobit, served from a plain range reader (the same bytes whatever the regions).
      let index: Uint8Array = new Uint8Array(0);
      const indexReader = new TwoBitFile({
        filehandle: {
          async read(length: number, position: number) {
            const b = await get(position, Math.min(size, position + length));
            if (position + b.length > index.length) {
              const grown = new Uint8Array(position + b.length);
              grown.set(index);
              grown.set(b, position);
              index = grown;
            }
            return b;
          },
        } as unknown as BlobFile,
      });
      const offsets = Object.entries(await indexReader.getIndex()).sort((a, b) => a[1] - b[1]);
      const records: Record2bit[] = offsets.map(([name, start], k) => ({ name, start, end: k + 1 < offsets.length ? offsets[k + 1][1] : size }));
      const wanted = records.filter((r) => canonical.test(r.name));
      const total = wanted.reduce((a, r) => a + r.end - r.start, 0);

      // Reads go to the index bytes or to the chromosome loaded now; anything else is refused.
      let current: { rec: Record2bit; blob: Blob } | null = null;
      const tb = new TwoBitFile({
        filehandle: {
          async read(length: number, position: number) {
            if (position + length <= index.length) return index.slice(position, position + length);
            if (current && position >= current.rec.start && position + length <= current.rec.end) return new Uint8Array(await current.blob.slice(position - current.rec.start, position - current.rec.start + length).arrayBuffer());
            throw new Error("Private sequence read outside the downloaded chromosome");
          },
        } as unknown as BlobFile,
      });
      const names = new Map(records.map((r) => [r.name, 0]));
      const byRecord = new Map<string, number[]>();
      windows.forEach((w, i) => {
        const n = chromAlias(w.chrom, names);
        if (n && canonical.test(n)) byRecord.set(n, [...(byRecord.get(n) ?? []), i]);
      });
      const out: (string | null)[] = new Array(windows.length).fill(null);
      let got = 0;
      for (const rec of wanted) {
        abortIfCancelled(ro.signal);
        const key = `${url}#${rec.name}`;
        let blob = (await o.store?.get(key)) ?? null;
        if (!blob || blob.size !== rec.end - rec.start) {
          ro.onProgress?.({ done: got, total, label: `Downloading ${rec.name} (${((rec.end - rec.start) / 1e6).toFixed(0)} MB)`, unit: "bytes" });
          const bytes = await get(rec.start, rec.end);
          blob = o.store ? await o.store.put(key, bytes) : new Blob([bytes as unknown as BlobPart]);
        }
        got += rec.end - rec.start;
        current = { rec, blob };
        for (const i of byRecord.get(rec.name) ?? []) {
          const w = windows[i];
          out[i] = (await tb.getSequence(rec.name, w.start, w.end)) ?? null;
        }
        current = null;
        ro.onProgress?.({ done: got, total, label: `Read ${rec.name}`, unit: "bytes" });
      }
      return out;
    },
  };
}
