/**
 * Fetch (once per assembly) and parse the bundled gene models,
 * refdata/<asm>/genes/gene_models.bed: the app's own file, no outside request.
 * Shared by the genome browser (gene track, gene search) and the genome view
 * (gene search). Parsing and its tests: browserTracks.ts.
 */
import { geneModelsUrl, parseGeneModels, type GeneFeature, type GeneIndex } from "./browserTracks";

export type GeneModels = { features: GeneFeature[]; index: GeneIndex };

const cache = new Map<string, Promise<GeneModels>>();

export function loadGeneModels(assembly: string, base: string): Promise<GeneModels> {
  let p = cache.get(assembly);
  if (!p) {
    p = fetch(geneModelsUrl(assembly, base))
      .then((r) => {
        if (!r.ok) throw new Error(`gene models: HTTP ${r.status}`);
        return r.text();
      })
      .then(parseGeneModels);
    p.catch(() => cache.delete(assembly));
    cache.set(assembly, p);
  }
  return p;
}
