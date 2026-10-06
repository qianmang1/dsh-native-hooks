import { builtinModules } from 'node:module'
import { defineConfig, type Plugin } from 'tsdown'

// The dsh runtime packages this plugin imports are provided by the user's dsh
// install at load time. A published bundle must resolve them through Node's
// upward search from its own installed location (profile node_modules for
// registry installs), so each bare @deepseek-ai/* import becomes a dynamic
// import of the same id — always the ESM entry, never the CJS dual export.
// `js-yaml` is deliberately NOT external: it is bundled so the published
// package keeps zero runtime dependencies (the host also ships js-yaml, but
// bundling keeps that an implementation detail of the host).
const DSH_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
]

/** Rewrite every bare @deepseek-ai/* static import into an awaited dynamic import. */
function bundleDshExternals(): Plugin {
  return {
    name: 'bundle-dsh-externals',
    renderChunk(code: string): string | null {
      const rewritten = code.replace(
        /import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+["'](@deepseek-ai\/[^"']+)["'];?/g,
        (_match, def: string | undefined, named: string | undefined, id: string) => {
          const spec = `await import(${JSON.stringify(id)})`
          if (def !== undefined) return `const ${def} = (${spec}).default ?? (${spec})`
          const bindings = (named as string)
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .map((entry) => {
              const parts = entry.split(/\s+as\s+/)
              return parts.length === 2 ? `${parts[0].trim()}: ${parts[1].trim()}` : entry
            })
            .join(', ')
          return `const { ${bindings} } = ${spec}`
        },
      )
      if (rewritten === code) return null
      return rewritten
    },
  }
}

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...DSH_EXTERNALS],
  plugins: [bundleDshExternals()],
})
