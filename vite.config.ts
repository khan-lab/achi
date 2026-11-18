import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { execSync } from 'node:child_process'
import { classifyOfflineFile, dataAssembly, type OfflineManifest } from './src/lib/offlineManifest.ts'

/**
 * Offline mode: after the build, list every file the service worker
 * (public/sw.js) may cache, with a content hash, in dist/offline-manifest.json.
 * The shell cache is named after `version`, so any change to the app ships a
 * fresh cache; data files are cached per hash, so unchanged reference data
 * is never downloaded twice. No dependency — see src/lib/offlineManifest.ts.
 */
function offlineManifest(): Plugin {
  let outDir = 'dist'
  return {
    name: 'achi-offline-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = join(dir, f)
          return statSync(p).isDirectory() ? walk(p) : [relative(outDir, p).split(sep).join('/')]
        })
      const hash = (path: string) => createHash('sha256').update(readFileSync(join(outDir, path))).digest('hex').slice(0, 16)
      const manifest: OfflineManifest = { version: '', shell: {}, data: {} }
      for (const path of walk(outDir).sort()) {
        const kind = classifyOfflineFile(path)
        if (kind === 'shell') manifest.shell[path] = hash(path)
        else if (kind === 'data') {
          manifest.data[path] = { hash: hash(path), bytes: statSync(join(outDir, path)).size, assembly: dataAssembly(path)! }
        }
      }
      manifest.version = createHash('sha256').update(JSON.stringify([manifest.shell, manifest.data])).digest('hex').slice(0, 12)
      writeFileSync(join(outDir, 'offline-manifest.json'), JSON.stringify(manifest))
      // Stamp the version into the service worker so each deploy is a byte change browsers pick up.
      const sw = join(outDir, 'sw.js')
      writeFileSync(sw, readFileSync(sw, 'utf8').replace('__OFFLINE_VERSION__', manifest.version))
    },
  }
}

/** Which build this is, for the methods text and settings of an exported analysis: the commit (GitHub Actions' GITHUB_SHA, else git) and the build date. */
function buildInfo(): { commit: string; date: string } {
  let commit = process.env.GITHUB_SHA?.slice(0, 7) ?? ''
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    } catch {
      commit = 'unknown'
    }
  }
  return { commit, date: new Date().toISOString().slice(0, 10) }
}

// https://vite.dev/config/
export default defineConfig({
  define: { __APP_BUILD__: JSON.stringify(buildInfo()) },
  plugins: [react(), offlineManifest()],
  // Served at https://khan-lab.github.io/achi/ — see
  // docs/deploy-github-pages.md. Every runtime asset fetch already goes
  // through import.meta.env.BASE_URL, so this is the only config needed
  // for a GitHub Pages project-site deployment.
  base: '/achi/',
  // igv.js (genome browser) is one 1.5 MB chunk, loaded only when the
  // Browser tab opens; the main bundle stays ~400 kB.
  build: { chunkSizeWarningLimit: 1600 },
})
