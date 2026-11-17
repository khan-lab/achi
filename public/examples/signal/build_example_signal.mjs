/**
 * Builds the example signal for the signal-profile card, step 1 of 2: ENCODE
 * H3K27ac fold change for the four example cell lines, cut to the example
 * regions and averaged in 200 bp bins, written as bedGraph. Step 2
 * (bedgraph_to_bigwig.py) writes the bigWigs and provenance.json.
 *
 *   node public/examples/signal/build_example_signal.mjs <work dir>
 *   python public/examples/signal/bedgraph_to_bigwig.py <work dir>
 *
 * Run from the repository root. Reads the ENCODE files by range requests with
 * @gmod/bbi (the reader the app uses; neighbouring blocks merged into one
 * request), retrying failed requests and stopping on any that keep failing,
 * so no bin is silently lost.
 *
 * Windows: every region of the four example sets
 * (public/examples/hg38_ses/{MCF7,GM12878,K562,HepG2}.bed) +- 10 kb, merged,
 * on a 200 bp grid. Each bin is the mean of the ENCODE signal over its bases
 * with data; bins without data are left out. Derived, lower-resolution
 * copies for demonstration: use the original ENCODE files for analysis.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { BigWig } from "@gmod/bbi";
import { RemoteFile } from "generic-filehandle2";

const ROOT = process.cwd();
const WORK = process.argv[2];
if (!WORK) throw new Error("usage: node build_example_signal.mjs <work dir>");
mkdirSync(WORK, { recursive: true });
const SETS = ["MCF7", "GM12878", "K562", "HepG2"];
// The H3K27ac files already curated for the genome browser (public/refdata/hg38/remote/tracks.json).
const TRACK_NAMES = { MCF7: "MCF-7 H3K27ac", GM12878: "GM12878 H3K27ac", K562: "K562 H3K27ac", HepG2: "HepG2 H3K27ac" };
const PAD = 10000;
const BIN = 200;

const tracks = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, "public/refdata/hg38/remote/tracks.json"), "utf8")).tracks.map((t) => [t.name, t]));
const sizeLines = readFileSync(join(ROOT, "public/refdata/hg38/hg38.chrom.sizes"), "utf8").trim().split("\n").map((l) => l.split("\t"));
const sizes = Object.fromEntries(sizeLines.map(([c, n]) => [c, Number(n)]));
const order = Object.fromEntries(sizeLines.map(([c], i) => [c, i]));

const windows = [];
for (const s of SETS)
  for (const line of readFileSync(join(ROOT, "public/examples/hg38_ses", `${s}.bed`), "utf8").trim().split("\n")) {
    const f = line.split("\t");
    windows.push([f[0], Math.max(0, Math.floor((Number(f[1]) - PAD) / BIN) * BIN), Math.min(sizes[f[0]], Math.ceil((Number(f[2]) + PAD) / BIN) * BIN)]);
  }
windows.sort((a, b) => order[a[0]] - order[b[0]] || a[1] - b[1]);
const merged = [];
for (const [c, a, b] of windows) {
  const last = merged.at(-1);
  if (last && last[0] === c && a <= last[2]) last[2] = Math.max(last[2], b);
  else merged.push([c, a, b]);
}
console.error(`${merged.length} windows, ${merged.reduce((t, [, a, b]) => t + b - a, 0)} bp`);

/** fetch, retried (whole response, body included) on network errors and 5xx, up to 6 tries; then it throws. */
async function retryingFetch(input, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(input, init);
      if (res.status >= 500 && attempt < 6) throw new Error(`HTTP ${res.status}`);
      const body = await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (err) {
      if (attempt >= 6) throw err;
      console.error(`  retry ${attempt} after: ${err.cause?.code ?? err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const meta = [];
for (const s of SETS) {
  const t = tracks[TRACK_NAMES[s]];
  const acc = t.url.split("/").pop().split(".")[0];
  const enc = await (await retryingFetch(`https://www.encodeproject.org/files/${acc}/?format=json`, { headers: { Accept: "application/json" } })).json();
  const entry = { set: s, bedGraph: `${s}.bedGraph`, source: { accession: acc, url: t.url, md5: enc.md5sum, bytes: enc.file_size, experiment: enc.dataset.split("/").filter(Boolean).pop(), output_type: enc.output_type, replicates: enc.biological_replicates } };
  // Resumable: a finished bedGraph is kept; a partial one is redone.
  if (existsSync(join(WORK, `${s}.bedGraph`))) {
    console.error(`${s}: already built, kept`);
    meta.push(entry);
    continue;
  }
  const bw = new BigWig({ filehandle: new RemoteFile(t.url, { fetch: retryingFetch }) });
  await bw.getHeader();
  const out = createWriteStream(join(WORK, `${s}.bedGraph.partial`));
  let nBins = 0;
  const t0 = Date.now();
  const chroms = [...new Set(merged.map((w) => w[0]))];
  for (const c of chroms) {
    const ws = merged.filter((w) => w[0] === c);
    for (let i = 0; i < ws.length; i += 100) {
      const batch = ws.slice(i, i + 100);
      const r = await bw.getFeaturesAsArraysMulti(batch.map(([refName, start, end]) => ({ refName, start, end })));
      batch.forEach(([, a, b], k) => {
        const lo = r.regionOffsets[k];
        const hi = r.regionOffsets[k + 1];
        const n = (b - a) / BIN;
        const sum = new Float64Array(n);
        const cov = new Float64Array(n);
        for (let j = lo; j < hi; j++) {
          const s0 = Math.max(a, r.starts[j]);
          const e0 = Math.min(b, r.ends[j]);
          for (let bin = Math.floor((s0 - a) / BIN); bin < n && a + bin * BIN < e0; bin++) {
            const w = Math.min(e0, a + (bin + 1) * BIN) - Math.max(s0, a + bin * BIN);
            if (w > 0) {
              sum[bin] += r.scores[j] * w;
              cov[bin] += w;
            }
          }
        }
        let text = "";
        for (let bin = 0; bin < n; bin++)
          if (cov[bin] > 0) {
            text += `${c}\t${a + bin * BIN}\t${a + (bin + 1) * BIN}\t${+(sum[bin] / cov[bin]).toPrecision(7)}\n`;
            nBins++;
          }
        out.write(text);
      });
    }
  }
  await new Promise((r) => out.end(r));
  renameSync(join(WORK, `${s}.bedGraph.partial`), join(WORK, `${s}.bedGraph`));
  console.error(`${s}: ${nBins} bins in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  meta.push(entry);
}
writeFileSync(join(WORK, "meta.json"), JSON.stringify({ bin: BIN, pad: PAD, assembly: "hg38", chroms: [...new Set(merged.map((w) => w[0]))].map((c) => [c, sizes[c]]), files: meta }, null, 1));
