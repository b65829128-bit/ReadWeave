import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const androidRoot = resolve(root, 'src-tauri/gen/android/app/src/main')
const manifestPath = resolve(androidRoot, 'AndroidManifest.xml')

let manifest
try {
  manifest = await readFile(manifestPath, 'utf8')
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0)
  throw error
}

const application = manifest.match(/<application\b[^>]*>/s)?.[0]
if (!application) throw new Error('Android application manifest has no application element.')

const setAttribute = (element, name, value) => {
  const attribute = new RegExp(`\\s+${name}="[^"]*"`)
  return attribute.test(element)
    ? element.replace(attribute, ` ${name}="${value}"`)
    : element.replace(/>$/, ` ${name}="${value}">`)
}

let patchedApplication = setAttribute(
  application,
  'android:fullBackupContent',
  '@xml/readweave_backup_rules',
)
patchedApplication = setAttribute(
  patchedApplication,
  'android:dataExtractionRules',
  '@xml/readweave_data_extraction_rules',
)
manifest = manifest.replace(application, patchedApplication)

const xmlRoot = resolve(androidRoot, 'res/xml')
await mkdir(xmlRoot, { recursive: true })
await writeFile(
  resolve(xmlRoot, 'readweave_backup_rules.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>\n    <exclude domain="sharedpref" path="keyring-default.xml" />\n</full-backup-content>\n`,
)
await writeFile(
  resolve(xmlRoot, 'readweave_data_extraction_rules.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n    <cloud-backup>\n        <exclude domain="sharedpref" path="keyring-default.xml" />\n    </cloud-backup>\n    <device-transfer>\n        <exclude domain="sharedpref" path="keyring-default.xml" />\n    </device-transfer>\n</data-extraction-rules>\n`,
)
await writeFile(manifestPath, manifest)
