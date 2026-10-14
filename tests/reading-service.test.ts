import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readingService } from '../src/core/reading-service'
import contract from '../src/core/reading-contract.json'
import type { BookRecord, Fragment, Paragraph, ReadingPoint, Snapshot } from '../src/core/types'
import type { ToolResult } from '../src/core/tools'

const bridge = vi.hoisted(() => ({ native: true, invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => bridge.native, invoke: bridge.invoke }))

const book: BookRecord = {
  id: 'a'.repeat(64),
  version: `sha256:${'a'.repeat(64)}`,
  title: '测试书',
  author: '测试',
  language: 'zh',
  fileName: 'test.epub',
  addedAt: '2026-10-14T00:00:00Z',
  coverTone: 0,
}
const blocks = (): Paragraph[] => [
  {
    id: 'p_0_0',
    ordinal: 0,
    sectionIndex: 0,
    text: '中文😀 原文。未读内容。',
    chapter: '第一章',
    cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:14)',
  },
]
const point: ReadingPoint = {
  text: '中文😀',
  isSelection: true,
  locator: {
    cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:4)',
    paragraphId: 'p_0_0',
    sectionIndex: 0,
    endOffset: 4,
    progress: 0.2,
  },
}
const fragment = (suffix = '1'): Fragment => ({
  citationId: `cite_${suffix}`,
  ref: `passage_${suffix}`,
  anchorRef: `anchor_${suffix}`,
  text: '中文😀',
  label: '第一章',
})
const index = {
  bookId: book.id,
  bookVersion: book.version,
  transformVersion: contract.transformVersion,
  contentHash: 'b'.repeat(64),
  paragraphs: 1,
  characters: blocks()[0].text.length,
  indexStatus: 'scan',
}
function handle() {
  const snapshot: Snapshot = {
    id: 'snap_1',
    bookId: book.id,
    bookVersion: book.version,
    bookTitle: book.title,
    transformVersion: index.transformVersion,
    contentHash: index.contentHash,
    chapter: '第一章',
    createdAt: '2026-10-14T00:00:00Z',
    scope: 'to-position',
    locator: structuredClone(point.locator),
    selection: point.text,
    initial: [fragment()],
  }
  return { runId: 'run_1', snapshot }
}
function result(): ToolResult {
  return {
    schemaVersion: 1,
    snapshotId: 'snap_1',
    bookVersion: book.version,
    fragments: [fragment('2')],
    truncated: false,
    nextCursor: null,
    indexStatus: 'scan',
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const invoked = (command: string) => bridge.invoke.mock.calls.filter((call) => call[0] === command)

describe('asynchronous native reading bridge', () => {
  beforeEach(() => {
    bridge.native = true
    bridge.invoke.mockReset()
    bridge.invoke.mockImplementation(async (command: string) => {
      if (command === 'reading_register_book') return { ...index }
      if (command === 'reading_create_task') return handle()
      if (command === 'reading_search' || command === 'reading_read') return result()
      if (command === 'reading_resolve_anchor') return structuredClone(point.locator)
      if (command === 'reading_revoke_task') return
      throw new Error(`Unexpected command: ${command}`)
    })
  })

  it('registers once, freezes through the native service, and binds tool calls outside model arguments', async () => {
    const paragraphs = blocks()
    await readingService.register(book, paragraphs)
    const task = await readingService.create(book, paragraphs, point, 'to-position')
    expect(task.backend).toBe('native')
    expect(invoked('reading_register_book')).toHaveLength(1)
    expect(invoked('reading_create_task')[0][1]).toEqual({
      request: {
        bookId: book.id,
        bookVersion: book.version,
        transformVersion: contract.transformVersion,
        contentHash: index.contentHash,
        point,
        scope: 'to-position',
      },
    })
    await task.search({ query: '中文' })
    await task.read({ ref: 'passage_2' })
    expect(invoked('reading_search')[0][1]).toEqual({ runId: 'run_1', input: { query: '中文' } })
    expect(invoked('reading_read')[0][1]).toEqual({ runId: 'run_1', input: { ref: 'passage_2' } })
    const evidence = task.allEvidence()
    expect(evidence).toHaveLength(3)
    evidence[0].text = 'mutated'
    expect(task.allEvidence()[0].text).toBe('中文😀')
  })

  it('forwards native permission errors without stripping an attempted boundary override', async () => {
    const task = await readingService.create(book, blocks(), point, 'to-position')
    bridge.invoke.mockRejectedValueOnce({ code: 'INVALID_ARGUMENT', message: '书内服务参数无效。' })
    await expect(
      task.search({ query: '中文', runId: 'other', bookId: 'other' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(invoked('reading_search')[0][1]).toEqual({
      runId: 'run_1',
      input: { query: '中文', runId: 'other', bookId: 'other' },
    })
    expect(task.allEvidence()).toHaveLength(1)
  })

  it('revokes immediately and ignores a result that finishes after cancellation', async () => {
    const task = await readingService.create(book, blocks(), point, 'to-position')
    const pending = deferred<ToolResult>()
    bridge.invoke.mockReturnValueOnce(pending.promise)
    const search = task.search({ query: '中文' })
    const rejection = expect(search).rejects.toMatchObject({ code: 'RUN_REVOKED' })
    await task.revoke()
    await task.revoke()
    pending.resolve(result())
    await rejection
    await expect(task.read({ ref: 'passage_1' })).rejects.toMatchObject({ code: 'RUN_REVOKED' })
    expect(invoked('reading_revoke_task')).toHaveLength(1)
    expect(invoked('reading_read')).toHaveLength(0)
    expect(task.allEvidence()).toHaveLength(1)
  })

  it('does not create a grant if cancellation happens while registration is pending', async () => {
    const pending = deferred<typeof index>()
    bridge.invoke.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const creation = readingService.create(book, blocks(), point, 'to-position', controller.signal)
    const rejection = expect(creation).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    pending.resolve(index)
    await rejection
    expect(invoked('reading_create_task')).toHaveLength(0)
  })
  it('captures the book and position before asynchronous registration finishes', async () => {
    const pending = deferred<typeof index>()
    bridge.invoke.mockReturnValueOnce(pending.promise)
    const sourceBook = structuredClone(book)
    const location = structuredClone(point)
    const creation = readingService.create(sourceBook, blocks(), location, 'to-position')
    sourceBook.id = 'c'.repeat(64)
    sourceBook.version = `sha256:${sourceBook.id}`
    location.locator.endOffset = 100
    location.text = 'later page'
    pending.resolve(index)
    const task = await creation
    expect(task.snapshot.bookId).toBe(book.id)
    expect(invoked('reading_create_task')[0][1].request).toMatchObject({
      bookId: book.id,
      bookVersion: book.version,
      point,
    })
  })

  it('revokes a grant that arrives after the preparation was cancelled', async () => {
    const pending = deferred<ReturnType<typeof handle>>()
    bridge.invoke.mockImplementation(async (command: string) =>
      command === 'reading_register_book'
        ? index
        : command === 'reading_create_task'
          ? pending.promise
          : undefined,
    )
    const controller = new AbortController()
    const creation = readingService.create(book, blocks(), point, 'to-position', controller.signal)
    const rejection = expect(creation).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(invoked('reading_create_task')).toHaveLength(1))
    controller.abort()
    pending.resolve(handle())
    await rejection
    expect(invoked('reading_revoke_task')[0][1]).toEqual({ runId: 'run_1' })
  })

  it('retries a failed registration instead of keeping a rejected cache entry', async () => {
    const paragraphs = blocks()
    bridge.invoke.mockRejectedValueOnce({ code: 'STORAGE_FAILED', message: '保存失败。' })
    await expect(readingService.register(book, paragraphs)).rejects.toMatchObject({
      code: 'STORAGE_FAILED',
    })
    const task = await readingService.create(book, paragraphs, point, 'to-position')
    expect(task.backend).toBe('native')
    expect(invoked('reading_register_book')).toHaveLength(2)
  })

  it('rejects a mismatched registration or task without exposing it as current evidence', async () => {
    bridge.invoke.mockResolvedValueOnce({ ...index, bookId: 'c'.repeat(64) })
    await expect(readingService.create(book, blocks(), point, 'to-position')).rejects.toThrow(
      '正文登记结果',
    )
    expect(invoked('reading_create_task')).toHaveLength(0)
    bridge.invoke
      .mockResolvedValueOnce(index)
      .mockResolvedValueOnce({ ...handle(), snapshot: { ...handle().snapshot, scope: 'book' } })
    await expect(readingService.create(book, blocks(), point, 'to-position')).rejects.toThrow(
      '授权范围',
    )
    expect(invoked('reading_revoke_task')).toHaveLength(1)
  })

  it('rejects tool results from another snapshot', async () => {
    const task = await readingService.create(book, blocks(), point, 'to-position')
    bridge.invoke.mockResolvedValueOnce({ ...result(), snapshotId: 'foreign_snapshot' })
    await expect(task.search({ query: '中文' })).rejects.toThrow('不属于本次任务')
    expect(task.allEvidence()).toHaveLength(1)
  })

  it('resolves saved native anchors without recreating a reading grant', async () => {
    expect(await readingService.resolveAnchor(book.id, book.version, 'anchor_1')).toEqual(
      point.locator,
    )
    expect(invoked('reading_resolve_anchor')[0][1]).toEqual({
      bookId: book.id,
      bookVersion: book.version,
      anchorRef: 'anchor_1',
    })
    expect(invoked('reading_create_task')).toHaveLength(0)
    bridge.invoke.mockRejectedValueOnce({ code: 'ANCHOR_STALE', message: '旧定位' })
    expect(await readingService.resolveAnchor(book.id, book.version, 'old_anchor')).toBeNull()
    bridge.invoke.mockRejectedValueOnce({ code: 'CALLER_MISMATCH', message: '错误身份' })
    await expect(
      readingService.resolveAnchor(book.id, book.version, 'foreign'),
    ).rejects.toMatchObject({ code: 'CALLER_MISMATCH' })
  })

  it('uses the same asynchronous task interface for browser development preview', async () => {
    bridge.native = false
    const task = await readingService.create(book, blocks(), point, 'to-position')
    expect(task.backend).toBe('preview')
    expect((await task.search({ query: '未读' })).fragments).toHaveLength(0)
    expect((await task.read({ ref: task.snapshot.initial[0].ref })).fragments[0].text).toBe(
      '中文😀',
    )
    expect(await task.resolveAnchor(task.snapshot.initial[0].anchorRef)).toMatchObject({
      paragraphId: 'p_0_0',
    })
    await task.revoke()
    await expect(task.search({ query: '中' })).rejects.toMatchObject({ code: 'RUN_REVOKED' })
    expect(bridge.invoke).not.toHaveBeenCalled()
  })
})
