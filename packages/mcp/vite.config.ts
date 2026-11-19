import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * The achi-mcp server as one ES module file for Node >= 20.19 (dist/achi-mcp.js):
 * @achi/core, @achi/node, the CLI's analysis, the MCP SDK and zod bundled in, Node's own
 * modules left as imports.
 */
export default defineConfig({
  build: {
    ssr: 'src/bin.ts',
    target: 'node20',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      external: [...builtinModules, /^node:/],
      output: { entryFileNames: 'achi-mcp.js', format: 'es' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
})
