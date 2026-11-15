/**
 * The part of the GenomeSpy (@genome-spy/core 1.3.0, MIT) embed API that
 * components/GenomeView.tsx uses. Declared here (mapped by tsconfig.app.json "paths"; type-checking only, the bundler still loads the package) because the package ships
 * TypeScript sources inside dist/ that do not compile under this project's
 * `verbatimModuleSyntax`; these signatures follow its
 * dist/src/types/embedApi.d.ts and scaleResolutionApi.d.ts.
 */
export interface LocusEndpoint {
  chrom: string;
  pos: number;
}
export interface IntervalSnapshot {
  type: "interval";
  active: boolean;
  complexIntervals: { x?: readonly [LocusEndpoint, LocusEndpoint] | null };
}
export interface IntervalSelectionApi {
  type: "interval";
  getValue(): IntervalSnapshot;
  subscribe(listener: (value: IntervalSnapshot) => void, options?: { delivery?: "change" | "commit" }): () => void;
  clear(): void;
}
export interface ScaleResolutionApi {
  getComplexDomain(): unknown[];
  zoomTo(domain: LocusEndpoint[] | number[], duration?: boolean | number): Promise<void>;
}
export interface EmbedResult {
  finalize(): void;
  datasets: { set<T = unknown>(name: string, data: T[]): void };
  getScaleResolutionByName(name: string): ScaleResolutionApi | undefined;
  views: { get(address: { scope: string[]; view: string }): { params: { getSelection(name: string): IntervalSelectionApi | { type: "point" } } } };
  addEventListener(type: "click", listener: (event: { datum?: Record<string, unknown> }) => void): void;
  imageExport: {
    raster(options?: { pixelRatio?: number; logicalWidth?: number; logicalHeight?: number }): Promise<{ blob: Blob }>;
    svg(options?: { logicalWidth?: number; logicalHeight?: number }): Promise<{ blob: Blob; warnings: string[] }>;
  };
}
export interface EmbedOptions {
  renderer?: "auto" | "webgl" | "canvas";
  wheelBehavior?: "default" | "cooperative";
}
export declare function embed(el: HTMLElement, spec: object, options?: EmbedOptions): Promise<EmbedResult>;
