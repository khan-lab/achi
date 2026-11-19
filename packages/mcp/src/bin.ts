#!/usr/bin/env node
/**
 * achi-mcp: Achi as an MCP server over stdio. Add it to an MCP client
 * (Claude Desktop, Claude Code, ...) as the command `achi-mcp`. Progress
 * goes to stderr; stdout carries the protocol.
 */
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_SITE } from "@achi/node/refdata";
import { VERSION, createServer } from "./server";

const HELP = `achi-mcp ${VERSION}: Achi as an MCP server (stdio).

Lets an AI assistant run Achi analyses on files on this computer with
native bedtools (2.31 or newer on PATH). What the tools return enters the
conversation, and so reaches the model's provider: by default that is
summaries only (sizes, group names, top results with q-values); full
results are written to disk.

Options:
  --allow-regions        also return region-level files (subset BEDs, signal
                         matrices, gene lists) when asked to read them
  --out-root <dir>       where results go by default (default ~/achi-results)
  --refdata-url <url>    the Achi site reference data comes from (default ${DEFAULT_SITE})
  --refdata-dir <dir>    read reference data from a local copy of the site's files
  --cache-dir <dir>      where downloaded reference data is kept (default ~/.cache/achi)
  --bedtools <path>      the bedtools binary (default: bedtools on PATH)
  --version, --help
Environment: ACHI_REFDATA_URL, ACHI_REFDATA_DIR, ACHI_CACHE_DIR, ACHI_BEDTOOLS.
`;

const { values: v } = parseArgs({
  options: {
    "allow-regions": { type: "boolean" },
    "out-root": { type: "string" },
    "refdata-url": { type: "string" },
    "refdata-dir": { type: "string" },
    "cache-dir": { type: "string" },
    bedtools: { type: "string" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (v.version) process.stdout.write(`achi-mcp ${VERSION}\n`);
else if (v.help) process.stdout.write(HELP);
else {
  const env = process.env;
  const server = createServer({
    allowRegions: v["allow-regions"] ?? false,
    outRoot: v["out-root"],
    bedtools: v.bedtools ?? env.ACHI_BEDTOOLS,
    refdata: { baseUrl: v["refdata-url"] ?? env.ACHI_REFDATA_URL, localDir: v["refdata-dir"] ?? env.ACHI_REFDATA_DIR, cacheDir: v["cache-dir"] ?? env.ACHI_CACHE_DIR },
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await server.connect(new StdioServerTransport());
}
