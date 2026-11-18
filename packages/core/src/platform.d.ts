/**
 * The web-platform globals that core may use: each exists in browsers, in
 * Web Workers and in Node >= 20 (CLAUDE.md, "Core, CLI and MCP"). Anything
 * else from a browser or from Node (window, document, fetch, Worker, OPFS,
 * node:fs, ...) is unavailable here on purpose: it reaches core through the
 * runtime interfaces instead. Declared minimally, only what core uses.
 */

interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
}
declare var Blob: {
  prototype: Blob;
  new (parts?: (ArrayBuffer | ArrayBufferView | Blob | string)[], options?: { type?: string }): Blob;
};

declare var performance: { now(): number };

declare var crypto: {
  subtle: { digest(algorithm: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> };
};

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** Only `aborted` is read: a cancelled run stops at the next check. */
interface AbortSignal {
  readonly aborted: boolean;
}

/** Used only to yield to the event loop during long loops (setTimeout(resolve, 0)). */
declare function setTimeout(handler: (...args: never[]) => void, timeout?: number): unknown;

/** For AbortError ("Cancelled"), as browsers and Node >= 17 throw it. */
declare class DOMException extends Error {
  constructor(message?: string, name?: string);
}
