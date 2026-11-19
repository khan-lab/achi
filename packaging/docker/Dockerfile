# The achi command-line tool and the achi-mcp server, with native bedtools.
#
# Build from the repository root:
#   docker build -f packaging/docker/Dockerfile -t achi .
# Run an analysis on files in the current folder. Reference data is
# downloaded on first use, checked, and kept in the achi-cache volume:
#   docker run --rm -v "$PWD":/data -v achi-cache:/cache achi run a.bed b.bed --enrich --out results
# Run the MCP server (stdio) for an MCP client:
#   docker run --rm -i -v "$PWD":/data -v achi-cache:/cache --entrypoint /usr/local/bin/_entrypoint.sh achi achi-mcp

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm run build -w achi && npm run build -w achi-mcp

FROM mambaorg/micromamba:2.10.0-ubuntu24.04
# bedtools 2.31.1 (bioconda, MIT) and Node.js 22 (conda-forge, MIT).
RUN micromamba install -y -n base -c conda-forge -c bioconda "bedtools=2.31.1" "nodejs>=22,<23" && micromamba clean --all --yes
COPY --from=build /src/packages/cli/dist/achi.js /opt/achi/achi.js
COPY --from=build /src/packages/mcp/dist/achi-mcp.js /opt/achi/achi-mcp.js
USER root
RUN printf '#!/bin/sh\nexec node /opt/achi/achi.js "$@"\n' > /usr/local/bin/achi \
 && printf '#!/bin/sh\nexec node /opt/achi/achi-mcp.js "$@"\n' > /usr/local/bin/achi-mcp \
 && chmod 755 /usr/local/bin/achi /usr/local/bin/achi-mcp \
 && mkdir -p /cache /data && chown "$MAMBA_USER" /cache /data
USER $MAMBA_USER
ENV ACHI_CACHE_DIR=/cache
VOLUME /cache
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/_entrypoint.sh", "achi"]
CMD ["--help"]
