import { invoke, isTauri } from '@tauri-apps/api/core'
import contract from './reading-contract.json'
import { ReadingToolError, ReadingTools, type ToolResult, type ToolErrorCode } from './tools'
import type {
  BookRecord,
  Fragment,
  Locator,
  Paragraph,
  ReadingPoint,
  ReadScope,
  Snapshot,
} from './types'

export interface ReadingTask {
  readonly runId: string
  readonly snapshot: Snapshot
  readonly backend: 'native' | 'preview'
  search(input: unknown): Promise<ToolResult>
  read(input: unknown): Promise<ToolResult>
  revoke(): Promise<void>
  allEvidence(): Fragment[]
  resolveAnchor(fragment: Fragment): Promise<Locator | null>
}
export interface BookIndex {
  bookId: string
  bookVersion: string
  transformVersion: string
  contentHash: string
  paragraphs: number
  characters: number
  indexStatus: 'scan'
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
}
async function nativeCall<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      'message' in error &&
      typeof error.code === 'string' &&
      typeof error.message === 'string'
    )
      throw new ReadingToolError(error.code as ToolErrorCode, error.message)
    throw new Error('原生阅读服务暂不可用，请重新打开书籍。', { cause: error })
  }
}
export class PreviewReadingTask implements ReadingTask {
  readonly backend = 'preview'
  readonly runId: string
  readonly snapshot: Snapshot
  constructor(private tools: ReadingTools) {
    this.runId = tools.runId
    this.snapshot = tools.snapshot
  }
  async search(input: unknown) {
    return this.tools.search(input)
  }
  async read(input: unknown) {
    return this.tools.read(input)
  }
  async revoke() {
    this.tools.revoke()
  }
  allEvidence() {
    return this.tools.allEvidence()
  }
  async resolveAnchor(fragment: Fragment) {
    return this.tools.resolveAnchor(fragment)
  }
}
class NativeReadingTask implements ReadingTask {
  readonly backend = 'native'
  readonly snapshot: Snapshot
  readonly runId: string
  private revoked = false
  private evidence: Fragment[]
  constructor(handle: { runId: string; snapshot: Snapshot }) {
    this.runId = handle.runId
    this.snapshot = structuredClone(handle.snapshot)
    this.evidence = structuredClone(handle.snapshot.initial)
  }
  private async execute(command: string, input: unknown) {
    if (this.revoked) throw new ReadingToolError('RUN_REVOKED', '本次任务已取消，读取授权已撤销。')
    const result = await nativeCall<ToolResult>(command, { runId: this.runId, input })
    if (this.revoked) throw new ReadingToolError('RUN_REVOKED', '本次任务已取消，读取授权已撤销。')
    if (
      result.schemaVersion !== contract.schemaVersion ||
      result.snapshotId !== this.snapshot.id ||
      result.bookVersion !== this.snapshot.bookVersion
    )
      throw new Error('书内服务返回了不属于本次任务的结果。')
    this.evidence.push(...structuredClone(result.fragments))
    return result
  }
  search(input: unknown) {
    return this.execute('reading_search', input)
  }
  read(input: unknown) {
    return this.execute('reading_read', input)
  }
  async revoke() {
    if (this.revoked) return
    this.revoked = true
    await nativeCall('reading_revoke_task', { runId: this.runId })
  }
  allEvidence() {
    return structuredClone(this.evidence)
  }
  resolveAnchor(fragment: Fragment) {
    return readingService.resolveAnchor(this.snapshot.bookId, this.snapshot.bookVersion, fragment)
  }
}

const registrations = new WeakMap<readonly Paragraph[], Promise<BookIndex | null>>()
export const readingService = {
  register(book: BookRecord, paragraphs: readonly Paragraph[]): Promise<BookIndex | null> {
    if (!isTauri()) return Promise.resolve(null)
    const previous = registrations.get(paragraphs)
    if (previous) return previous
    const registration = nativeCall<BookIndex>('reading_register_book', {
      request: {
        bookId: book.id,
        bookVersion: book.version,
        transformVersion: contract.transformVersion,
        paragraphs,
      },
    })
      .then((index) => {
        if (
          index.bookId !== book.id ||
          index.bookVersion !== book.version ||
          index.transformVersion !== contract.transformVersion ||
          !/^[a-f0-9]{64}$/.test(index.contentHash) ||
          index.paragraphs !== paragraphs.length ||
          index.indexStatus !== 'scan'
        )
          throw new Error('正文登记结果与当前书籍不一致。')
        return index
      })
      .catch((error) => {
        registrations.delete(paragraphs)
        throw error
      })
    registrations.set(paragraphs, registration)
    return registration
  },
  async create(
    book: BookRecord,
    paragraphs: readonly Paragraph[],
    point: ReadingPoint,
    scope: ReadScope,
    signal?: AbortSignal,
  ): Promise<ReadingTask> {
    abortIfNeeded(signal)
    const frozenPoint = structuredClone(point)
    const frozenBook = { ...book }
    if (!isTauri()) return new PreviewReadingTask(new ReadingTools(book, paragraphs, point, scope))
    const index = await this.register(frozenBook, paragraphs)
    abortIfNeeded(signal)
    if (!index || index.bookId !== frozenBook.id || index.bookVersion !== frozenBook.version)
      throw new Error('正文登记结果与当前书籍不一致。')
    const handle = await nativeCall<{ runId: string; snapshot: Snapshot }>('reading_create_task', {
      request: {
        bookId: frozenBook.id,
        bookVersion: frozenBook.version,
        transformVersion: index.transformVersion,
        contentHash: index.contentHash,
        point: frozenPoint,
        scope,
      },
    })
    const task = new NativeReadingTask(handle)
    if (signal?.aborted) {
      await task.revoke()
      abortIfNeeded(signal)
    }
    if (
      task.snapshot.bookId !== frozenBook.id ||
      task.snapshot.bookVersion !== frozenBook.version ||
      task.snapshot.transformVersion !== index.transformVersion ||
      task.snapshot.contentHash !== index.contentHash ||
      task.snapshot.scope !== scope
    ) {
      await task.revoke()
      throw new Error('阅读任务与当前书籍或授权范围不一致。')
    }
    return task
  },
  async resolveAnchor(
    bookId: string,
    bookVersion: string,
    fragment: Fragment,
  ): Promise<Locator | null> {
    if (!isTauri()) return null
    try {
      return await nativeCall<Locator | null>('reading_resolve_anchor', {
        bookId,
        bookVersion,
        fragment,
      })
    } catch (error) {
      if (error instanceof ReadingToolError && error.code === 'ANCHOR_STALE') return null
      throw error
    }
  },
}
