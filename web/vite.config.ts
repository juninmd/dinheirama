import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** Gera .br e .gz ao lado de cada asset de texto: o backend (serveStatic precompressed) serve sem comprimir em runtime. */
function precompress(): Plugin {
  const compressible = /\.(js|css|html|svg|json|map|txt|webmanifest)$/
  let outDir = 'dist'
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : [full]
    })
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      for (const file of walk(outDir).filter(f => compressible.test(f))) {
        const source = readFileSync(file)
        if (source.length < 1024) continue
        const br = brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } })
        if (br.length < source.length) writeFileSync(`${file}.br`, br)
        const gz = gzipSync(source, { level: 9 })
        if (gz.length < source.length) writeFileSync(`${file}.gz`, gz)
      }
    },
  }
}

export default defineConfig({
  plugins: [precompress()],
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})
