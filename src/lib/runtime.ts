/**
 * The browser's implementation of core's runtime (@achi/core/runtime):
 * bedtools compiled to WebAssembly, and reference data read from the site
 * that served the page (answered from the offline cache when there is no
 * network; see public/sw.js).
 */
import type { RefData, Runtime } from "@achi/core/runtime";
import { webBedtools } from "./bedtools";

/** Address of a file under the site root, e.g. siteUrl("refdata/hg38/hg38.chrom.sizes"). */
export const siteUrl = (path: string) => `${window.location.origin}${import.meta.env.BASE_URL}${path}`;

export const webRefData: RefData = {
  async text(path) {
    const res = await fetch(siteUrl(path));
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return res.text();
  },
};

export const webRuntime: Runtime = { bedtools: webBedtools, refdata: webRefData };
