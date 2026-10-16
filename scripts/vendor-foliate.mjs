import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const commit = '78914aef4466eb960965702401634c2cb348e9b1'
const source = '.local/foliate-source'
const destination = 'src/vendor/foliate'
const actual = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (actual !== commit) throw new Error(`Expected foliate-js ${commit}, received ${actual}`)
await mkdir(destination, { recursive: true })
for (const file of [
  'view.js',
  'epub.js',
  'epubcfi.js',
  'progress.js',
  'overlayer.js',
  'text-walker.js',
  'paginator.js',
  'fixed-layout.js',
  'search.js',
  'tts.js',
  'LICENSE',
]) {
  await copyFile(`${source}/${file}`, `${destination}/${file}`)
}
const viewPath = `${destination}/view.js`
let view = await readFile(viewPath, 'utf8')
view =
  view.slice(0, view.indexOf('const isZip =')) +
  `// ReadWeave accepts only host-validated EPUB objects. See VENDOR.md.
export const makeBook = async () => { throw new Error('Use the ReadWeave EPUB importer') }

` +
  view.slice(view.indexOf('class CursorAutohider'))
const locationBefore = 'this.lastLocation = { ...progress, tocItem, pageItem, cfi, range }'
if (!view.includes(locationBefore)) throw new Error('Relocation reason patch no longer applies')
view = view.replace(
  locationBefore,
  'this.lastLocation = { ...progress, tocItem, pageItem, cfi, range, reason }',
)
await writeFile(viewPath, view)
const paginatorPath = `${destination}/paginator.js`
let paginator = (await readFile(paginatorPath, 'utf8')).replaceAll('\r\n', '\n')
if (!paginator.includes("'allow-same-origin allow-scripts'"))
  throw new Error('Sandbox patch no longer applies')
paginator = paginator.replace("'allow-same-origin allow-scripts'", "'allow-same-origin'")
const replacements = [
  [
    '#observer = new ResizeObserver(() => this.expand())',
    '#resizeFrame = 0\n    #observer = new ResizeObserver(() => {\n        cancelAnimationFrame(this.#resizeFrame)\n        this.#resizeFrame = requestAnimationFrame(() => { if (this.document?.body) this.expand() })\n    })',
  ],
  [
    '#observer = new ResizeObserver(() => this.render())',
    '#resizeFrame = 0\n    #observer = new ResizeObserver(() => {\n        cancelAnimationFrame(this.#resizeFrame)\n        this.#resizeFrame = requestAnimationFrame(() => { if (this.#view?.document) this.render() })\n    })',
  ],
  [
    'if (this.document) this.#observer.unobserve(this.document.body)',
    'this.#observer.disconnect()\n        cancelAnimationFrame(this.#resizeFrame)',
  ],
  [
    'this.#observer.unobserve(this)',
    'this.#observer.disconnect()\n        cancelAnimationFrame(this.#resizeFrame)',
  ],
  [
    'this.#view.destroy()\n        this.#view = null',
    'this.#view?.destroy()\n        this.#view = null',
  ],
  ['if (!this.#view) return', 'if (!this.#view?.document) return'],
  [
    'requestAnimationFrame(() =>\n            this.#background.style.background = getBackground(this.#view.document))',
    'requestAnimationFrame(() => {\n            if (this.#view?.document) this.#background.style.background = getBackground(this.#view.document)\n        })',
  ],
  [
    'this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())',
    'this.#view?.document?.fonts?.ready?.then(() => this.#view?.document && this.#view.expand())',
  ],
  [
    'const checkPointerSelection = debounce((range, sel) => {',
    "const checkPointerSelection = debounce((range, sel) => {\n            if (this.hasAttribute('host-controls-input')) return",
  ],
  ...['#onTouchStart(e)', '#onTouchMove(e)', '#onTouchEnd()'].map((method) => [
    `${method} {`,
    `${method} {\n        if (this.hasAttribute('host-controls-input')) return`,
  ]),
]
for (const [before, after] of replacements) {
  if (!paginator.includes(before)) throw new Error(`Lifecycle patch no longer applies: ${before}`)
  paginator = paginator.replaceAll(before, after)
}
await writeFile(paginatorPath, paginator)
const cfiPath = `${destination}/epubcfi.js`
let cfi = (await readFile(cfiPath, 'utf8')).replaceAll('\r\n', '\n')
const cfiReplacements = [
  [
    'const nodeToParts = (node, offset, filter) => {',
    'const nodeToParts = (node, offset, filter, cache) => {',
  ],
  [
    '    const indexed = indexChildNodes(parentNode, filter)',
    '    const indexed = cache?.get(parentNode) ?? indexChildNodes(parentNode, filter)\n    cache?.set(parentNode, indexed)',
  ],
  [
    'nodeToParts(parentNode, null, filter).concat(part)',
    'nodeToParts(parentNode, null, filter, cache).concat(part)',
  ],
  [
    'export const fromRange = (range, filter) => {',
    'export const fromRange = (range, filter, cache) => {',
  ],
  [
    'nodeToParts(startContainer, startOffset, filter)',
    'nodeToParts(startContainer, startOffset, filter, cache)',
  ],
  [
    'nodeToParts(endContainer, endOffset, filter)',
    'nodeToParts(endContainer, endOffset, filter, cache)',
  ],
]
for (const [before, after] of cfiReplacements) {
  if (!cfi.includes(before)) throw new Error(`CFI cache patch no longer applies: ${before}`)
  cfi = cfi.replace(before, after)
}
await writeFile(cfiPath, cfi)
console.log(`Vendored foliate-js ${commit} with five documented patch groups.`)
