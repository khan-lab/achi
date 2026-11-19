import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

/**
 * The achi command as one ES module file for Node >= 20.19 (dist/achi.js):
 * @achi/core, @achi/node and their dependencies bundled in, Node's own
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
      output: { entryFileNames: 'achi.js', format: 'es' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
})
