// Vendors pagedjs's browser ESM build into public/ so the resume preview
// iframe can load it same-origin (no external CDN at runtime), staying in
// sync with the pinned dependency version automatically instead of being a
// manually-copied file that silently drifts.
//
// Wired to predev/prebuild, NOT postinstall — both Dockerfiles here install
// dependencies with only package.json present, before the real source tree
// exists (a deliberate layer-caching optimization: apps/web/Dockerfile.dev
// never COPYs source at all, relying on a runtime volume mount; the
// production apps/web/Dockerfile's builder stage installs deps in one layer
// then COPY . . in a later one). A postinstall hook fires during that
// deps-only install step, when this very script doesn't exist in the image
// yet (MODULE_NOT_FOUND). predev/prebuild fire immediately before `next
// dev`/`next build`, by which point the full source is guaranteed to be
// present in every environment — bare local dev, the Docker dev volume
// mount, and the Docker production build alike.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// require.resolve-style lookup via node_modules directly (not a relative
// ../../../node_modules guess) — pnpm always symlinks a package's own direct
// dependencies into ITS OWN node_modules regardless of hoisting, so this
// resolves correctly whether pagedjs ends up physically stored under the
// workspace root's .pnpm store or anywhere else pnpm decides to put it.
const src = join(__dirname, '..', 'node_modules', 'pagedjs', 'dist', 'paged.esm.js')
const destDir = join(__dirname, '..', 'public', 'vendor', 'pagedjs')
const dest = join(destDir, 'paged.esm.js')

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
console.log(`Vendored pagedjs: ${src} -> ${dest}`)
