# achi-mcp: Achi as an MCP server

Lets an AI assistant (Claude Desktop, Claude Code or any MCP client) run
[Achi](https://khan-lab.github.io/achi/) analyses on region files on your
computer: intersections, pairwise statistics between the sets, per-chromosome
summaries, region annotation, nearest genes, reference-set, GO and motif
enrichment, and signal profiles, computed with native bedtools by the same
code as the web app and the `achi` command-line tool.

## What reaches the assistant

Your files are read and analysed on your computer. But whatever a tool
returns becomes part of the conversation, and so is sent to the model's
provider. So by default the tools return **summaries**: set and subset
sizes, group names, and the top results with odds ratios and q-values. Full
results are written to a folder on disk (`~/achi-results` by default).

`read_result_file` reads files from those folders only, and refuses
region-level files (subset BED files, gene lists, signal matrices and
per-region means) unless the server was started with `--allow-regions`.
Input files are never returned. Use `--allow-regions` only when the data
may be shared with the model's provider.

## Requirements

- Node.js 20.19 or newer
- bedtools 2.31 or newer on `PATH`

## Add it to a client

Claude Code:

```sh
claude mcp add achi -- achi-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "achi": { "command": "achi-mcp" }
  }
}
```

## Tools

| Tool | Does |
|---|---|
| `run_analysis` | intersect 1–8 region files and run the chosen analyses on chosen groups; returns a summary and the results folder |
| `read_result_file` | read a table or `methods.md` from a results folder (region-level files only with `--allow-regions`) |
| `list_reference_data` | the reference region sets, GO namespaces and JASPAR collections for an assembly |
| `fetch_reference_data` | download an assembly's reference data in advance (no user data sent) |

Options: `--allow-regions`, `--out-root <dir>`, `--refdata-url`,
`--refdata-dir`, `--cache-dir`, `--bedtools` (see `achi-mcp --help`).
