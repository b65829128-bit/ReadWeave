import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const sections = [
  'ReadWeave — Third-party notices\n\nSelf-authored code: Apache-2.0 (see LICENSE).\nOriginal sample books: CC0 1.0.\n\nThis file includes licenses available in the locked npm production dependency tree and locally installed locked Rust crate sources. Platform and build dependencies may also appear. Regenerate after dependency changes with npm run notices.\n',
]
async function addPackage(directory, label, fallback = '') {
  const names = (await readdir(directory))
    .filter(
      (name) => /^(licen[cs]e|copying|notice|ofl)([._-]|$)/i.test(name) && !name.endsWith('.spdx'),
    )
    .sort()
  const texts = []
  for (const name of names) {
    try {
      texts.push(`${name}\n${await readFile(join(directory, name), 'utf8')}`)
    } catch {
      /* Some crates use a licenses directory. */
    }
  }
  sections.push(
    `\n${'='.repeat(78)}\n${label}\n${fallback}\n\n${texts.join('\n\n') || 'See the upstream package license declaration.'}\n`,
  )
}
await addPackage(
  'src/vendor/foliate',
  'foliate-js — 78914aef4466eb960965702401634c2cb348e9b1',
  'https://github.com/johnfactotum/foliate-js — MIT',
)
if (!process.env.npm_execpath) throw new Error('Run via npm run notices')
const directories = execFileSync(
  process.execPath,
  [process.env.npm_execpath, 'ls', '--omit=dev', '--all', '--parseable'],
  { encoding: 'utf8' },
)
  .trim()
  .split(/\r?\n/)
  .slice(1)
for (const directory of [...new Set(directories)].sort()) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  await addPackage(
    directory,
    `${metadata.name} ${metadata.version}`,
    `${typeof metadata.repository === 'object' ? metadata.repository.url : (metadata.repository ?? '')} — ${metadata.license ?? 'See upstream license'}`,
  )
}
const registry = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'registry', 'src')
const registries = await readdir(registry)
const lock = await readFile('src-tauri/Cargo.lock', 'utf8')
for (const block of lock.split('[[package]]').slice(1)) {
  const name = /^name = "([^"]+)"/m.exec(block)?.[1]
  const version = /^version = "([^"]+)"/m.exec(block)?.[1]
  if (!name || !version || !block.includes('registry+')) continue
  for (const registryDirectory of registries) {
    const directory = join(registry, registryDirectory, `${name}-${version}`)
    try {
      await readdir(directory)
      await addPackage(
        directory,
        `Rust: ${name} ${version}`,
        `https://crates.io/crates/${name}/${version}`,
      )
      break
    } catch {
      /* Unused target-platform sources need not be installed on this host. */
    }
  }
}
await writeFile('THIRD_PARTY_NOTICES.txt', sections.join('\n'))
console.log(`Generated ${sections.length - 1} dependency notices.`)
