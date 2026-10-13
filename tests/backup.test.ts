import { beforeEach, describe, expect, it, vi } from 'vitest'
import { backupSchema, parseBackup, restoreBackup } from '../src/core/backup'
import { defaultModel, defaultPreferences } from '../src/core/types'
import { defaultPack } from '../src/core/plugins'
import { sha256, storage } from '../src/core/storage'

vi.mock('../src/core/storage', () => ({
  sha256: vi.fn(async () => 'a'.repeat(64)),
  storage: { putBlob: vi.fn(), merge: vi.fn() },
}))
const book = {
  id: 'a'.repeat(64),
  version: `sha256:${'a'.repeat(64)}`,
  title: '书',
  author: '作者',
  language: 'zh',
  fileName: 'test.epub',
  addedAt: '2026-10-13T00:00:00.000Z',
  coverTone: 0,
}
const valid = () => ({
  format: 'readweave-backup',
  schemaVersion: 1,
  exportedAt: '2026-10-13T00:00:00.000Z',
  books: [book],
  annotations: [],
  conversations: [],
  packs: [
    {
      id: defaultPack.id,
      manifest: defaultPack,
      enabled: true,
      installedAt: '2026-10-13T00:00:00.000Z',
    },
  ],
  preferences: defaultPreferences,
  model: defaultModel,
})

describe('versioned backups', () => {
  beforeEach(() => vi.clearAllMocks())
  it('rejects unknown credentials fields, unrecognized formats and inconsistent book hashes', () => {
    expect(parseBackup(JSON.stringify(valid())).books).toHaveLength(1)
    for (const backup of [
      { ...valid(), apiKey: 'secret' },
      { ...valid(), schemaVersion: 2 },
      { ...valid(), model: { ...defaultModel, apiKey: 'secret' } },
      { ...valid(), books: [{ ...book, version: `sha256:${'b'.repeat(64)}` }] },
    ])
      expect(() => parseBackup(JSON.stringify(backup))).toThrow()
  })
  it('rejects duplicates and an action-pack identity mismatch before any writes', () => {
    expect(backupSchema.safeParse({ ...valid(), books: [book, book] }).success).toBe(false)
    const invalid = { ...valid(), packs: [{ ...valid().packs[0], id: 'another.pack' }] }
    expect(backupSchema.safeParse(invalid).success).toBe(false)
    expect(storage.merge).not.toHaveBeenCalled()
  })
  it('checks every original book hash before modifying existing records', async () => {
    vi.mocked(sha256).mockResolvedValueOnce('b'.repeat(64))
    const backup = backupSchema.parse({ ...valid(), originals: { [book.id]: btoa('book') } })
    await expect(restoreBackup(backup)).rejects.toThrow(/哈希/)
    expect(storage.putBlob).not.toHaveBeenCalled()
    expect(storage.merge).not.toHaveBeenCalled()
  })
  it('merges all records atomically and restores no credential fields', async () => {
    await restoreBackup(backupSchema.parse(valid()))
    expect(storage.merge).toHaveBeenCalledOnce()
    const merged = vi.mocked(storage.merge).mock.calls[0][0]
    expect(merged.some((record) => record.collection === 'books')).toBe(true)
    expect(JSON.stringify(merged)).not.toContain('apiKey')
  })
})
