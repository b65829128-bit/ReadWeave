import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = new URL('../', import.meta.url)
const folder = new URL('integrations/astrbot/astrbot_plugin_readweave/', root)
const metadata = await readFile(new URL('metadata.yaml', folder), 'utf8')
const version = /^version: v(\d+\.\d+\.\d+)\r?$/m.exec(metadata)?.[1]
if (!version) throw new Error('Plugin metadata requires a fixed version')
const entries = {}
for (const name of ['__init__.py', 'main.py', 'bridge.py', 'metadata.yaml', 'README.md']) {
  entries[`astrbot_plugin_readweave/${name}`] = [
    new Uint8Array(await readFile(new URL(name, folder))),
    { mtime: new Date('2026-10-17T00:00:00Z') },
  ]
}
for (const [name, source] of [
  ['reading-tools.json', 'src/core/reading-tools.json'],
  ['LICENSE', 'LICENSE'],
]) {
  entries[`astrbot_plugin_readweave/${name}`] = [
    new Uint8Array(await readFile(new URL(source, root))),
    { mtime: new Date('2026-10-17T00:00:00Z') },
  ]
}
const bytes = zipSync(entries, { level: 9 })
const filename = `astrbot_plugin_readweave-${version}`
const output = new URL(`.local/astrbot/${filename}.zip`, root)
await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, bytes)
const digest = createHash('sha256').update(bytes).digest('hex')
await writeFile(new URL(`${filename}.sha256`, output), `${digest}  ${filename}.zip\n`)
console.log(`Plugin: ${fileURLToPath(output)}\nSHA256: ${digest}`)
