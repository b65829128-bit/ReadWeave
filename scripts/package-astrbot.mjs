import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = new URL('../', import.meta.url)
const folder = new URL('integrations/astrbot/astrbot_plugin_readweave/', root)
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
const output = new URL('.local/astrbot/astrbot_plugin_readweave-0.1.0.zip', root)
await mkdir(new URL('.', output), { recursive: true })
await writeFile(output, bytes)
const digest = createHash('sha256').update(bytes).digest('hex')
await writeFile(
  new URL('astrbot_plugin_readweave-0.1.0.sha256', output),
  `${digest}  astrbot_plugin_readweave-0.1.0.zip\n`,
)
console.log(`Plugin: ${fileURLToPath(output)}\nSHA256: ${digest}`)
