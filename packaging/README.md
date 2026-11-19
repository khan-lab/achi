# Packaging the command-line tool and MCP server

Nothing here is published automatically. Steps for a release, in order:

1. **Deploy the site** under its final address (`https://khan-lab.github.io/achi/`).
   The CLI and MCP server download reference data from it and check each file
   against its `offline-manifest.json`, so the site must be live first.
2. **Tag** the release (`git tag v0.1.0`) once `main` passes the Test workflow.
3. **npm**: in `packages/cli` and `packages/mcp`, remove `"private": true`,
   then `npm publish` in each (`prepack` copies the root LICENSE in and builds
   `dist/`). Both names were free on npm when checked (2026-11-18).
4. **bioconda**: fill the two sha256 values in `bioconda/achi/meta.yaml` from the
   published tarballs and the maintainer's GitHub handle, then open a pull
   request to bioconda-recipes. It depends on bioconda's bedtools (>= 2.31) and
   conda-forge's nodejs (>= 20.19), both MIT.
5. **Container**: `docker build -f packaging/docker/Dockerfile -t achi .` from the
   repository root (micromamba base with bioconda bedtools 2.31.1 and Node.js 22).
   Not yet built or tested: no Docker daemon was available when it was written.

Both tools are single bundled files (`npm run build:cli`, `npm run build:mcp`)
with no runtime dependencies beyond Node.js and bedtools.
