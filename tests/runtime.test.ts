import { describe, expect, it, vi } from 'vitest'
import type { ReadingTask } from '../src/core/reading-service'
import { defaultModel, type Conversation, type Snapshot } from '../src/core/types'
import type { HarnessAdapter, ProviderAdapter, RunEvent } from '../src/harness/contracts'
import { AdapterRegistry } from '../src/harness/registry'
import { TaskRuntime, type PrepareRun } from '../src/harness/runtime'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function task(book = 'a'): ReadingTask {
  const snapshot: Snapshot = {
    id: crypto.randomUUID(),
    bookId: book.repeat(64),
    bookVersion: `sha256:${book.repeat(64)}`,
    bookTitle: '测试书',
    chapter: '第一章',
    createdAt: new Date().toISOString(),
    scope: 'to-position',
    selection: '原文',
    locator: {
      cfi: 'epubcfi(/6/2!/4/2)',
      sectionIndex: 0,
      paragraphId: 'p_0_0',
      endOffset: 2,
      progress: 0,
    },
    initial: [
      { citationId: 'cite_1', ref: 'ref_1', anchorRef: 'anchor_1', text: '原文', label: '第一章' },
    ],
  }
  return {
    runId: crypto.randomUUID(),
    snapshot,
    backend: 'preview',
    revoke: vi.fn(async () => {}),
    allEvidence: () => structuredClone(snapshot.initial),
    resolveAnchor: async () => null,
    search: vi.fn(),
    read: vi.fn(),
  }
}
type Payload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'runId' | 'sessionRef' | 'eventId' | 'sequence'>
    : never
  : never
type Request = Parameters<HarnessAdapter['submit']>[0]
function harness(id = 'test-harness') {
  const runs: {
    request: Request
    receive: (event: RunEvent) => void
    emit: (payload: Payload) => RunEvent
    finished: ReturnType<typeof deferred<void>>
  }[] = []
  const adapter: HarnessAdapter = {
    id,
    capabilities: { tools: true, cancel: true, external: false },
    submit: vi.fn((request, receive) => {
      let sequence = 0
      const finished = deferred()
      runs.push({
        request,
        receive,
        finished,
        emit(payload) {
          const event = {
            ...payload,
            runId: request.runId,
            sessionRef: request.sessionRef,
            sequence: ++sequence,
            eventId: `${request.runId}_${sequence}`,
          } as RunEvent
          receive(event)
          return event
        },
      })
      return finished.promise
    }),
  }
  return { adapter, runs }
}
const provider = (id = 'test-provider'): ProviderAdapter => ({
  id,
  capabilities: { streaming: true, tools: true, cancel: true },
  complete: vi.fn(),
})
function fixture(saveOverride?: (item: Conversation) => Promise<void>) {
  const harnesses = new AdapterRegistry<HarnessAdapter>('阅读伙伴')
  const providers = new AdapterRegistry<ProviderAdapter>('模型连接')
  const backend = harness()
  const model = provider()
  harnesses.register(backend.adapter)
  providers.register(model)
  harnesses.select(backend.adapter.id)
  providers.select(model.id)
  const saved: Conversation[] = []
  const onError = vi.fn()
  const save = vi.fn(
    saveOverride ??
      (async (item: Conversation) => {
        saved.push(item)
      }),
  )
  const runtime = new TaskRuntime(harnesses, providers, { save, onError })
  return { runtime, harnesses, providers, backend, model, saved, save, onError }
}
function request(tools: ReadingTask, overrides: Partial<PrepareRun> = {}): PrepareRun {
  return {
    bookId: tools.snapshot.bookId,
    bookVersion: tools.snapshot.bookVersion,
    scope: tools.snapshot.scope,
    question: '为什么？',
    settings: { ...defaultModel },
    apiKey: 'synthetic-memory-only',
    createTask: vi.fn(async () => tools),
    isApproved: () => true,
    ...overrides,
  }
}

describe('host task runtime', () => {
  it('waits for consent, captures model settings, and saves only task-issued evidence', async () => {
    const f = fixture()
    const tools = task()
    const input = request(tools, { isApproved: () => false })
    await f.runtime.prepare(input)
    expect(f.runtime.getSnapshot()).toMatchObject({
      phase: 'preview',
      pending: { question: input.question },
    })
    expect(f.backend.runs).toHaveLength(0)
    input.settings.model = 'changed-after-preview'
    f.runtime.confirm()
    const run = f.backend.runs[0]
    expect(run.request.settings.model).toBe(defaultModel.model)
    expect(run.request.runId).not.toBe(tools.runId)
    run.emit({ type: 'text', delta: '回答。' })
    run.emit({ type: 'evidence', fragments: [{ ...tools.snapshot.initial[0], text: '伪造原文' }] })
    run.emit({ type: 'done' })
    await f.runtime.flush()
    expect(f.saved[0].evidence).toEqual(tools.allEvidence())
    expect(f.saved[0].messages.at(-1)).toMatchObject({
      content: '回答。',
      status: 'done',
      run: { sequence: 3 },
    })
    expect(JSON.stringify(f.saved)).not.toContain('synthetic-memory-only')
  })

  it('keeps follow-ups in one session and frozen scope, with a fresh execution id per turn', async () => {
    const f = fixture()
    const tools = task()
    await f.runtime.prepare(request(tools))
    const first = f.backend.runs[0]
    first.emit({ type: 'text', delta: '第一轮。' })
    first.emit({
      type: 'protocol',
      messages: [{ role: 'assistant', content: '第一轮。', reasoning_content: '依据。' }],
    })
    first.emit({ type: 'done' })
    const followup = request(tools, { question: '继续。' })
    await f.runtime.prepare(followup)
    const second = f.backend.runs[1]
    expect(followup.createTask).not.toHaveBeenCalled()
    expect(second.request.tools).toBe(tools)
    expect(second.request.sessionRef).toBe(first.request.sessionRef)
    expect(second.request.runId).not.toBe(first.request.runId)
    expect(second.request.history.at(-1)?.protocol).toEqual([
      { role: 'assistant', content: '第一轮。', reasoning_content: '依据。' },
    ])
    first.emit({ type: 'text', delta: '旧轮次迟到内容' })
    second.emit({ type: 'text', delta: '第二轮。' })
    second.emit({ type: 'done' })
    await f.runtime.flush()
    expect(
      f.saved
        .at(-1)
        ?.messages.filter((m) => m.role === 'assistant')
        .map((m) => m.content),
    ).toEqual(['第一轮。', '第二轮。'])
  })

  it('cancels and persists immediately even when an adapter never settles, without later overwrites', async () => {
    const f = fixture()
    const firstTask = task()
    await f.runtime.prepare(request(firstTask))
    const first = f.backend.runs[0]
    first.emit({ type: 'text', delta: '未完成。' })
    first.emit({
      type: 'tool',
      tool: { id: 'trace_1', name: 'book_search', arguments: '{}', status: 'running' },
    })
    f.runtime.cancel()
    await f.runtime.flush()
    expect(first.request.signal.aborted).toBe(true)
    expect(firstTask.revoke).toHaveBeenCalledOnce()
    expect(f.saved[0].messages.at(-1)).toMatchObject({
      status: 'cancelled',
      tools: [{ status: 'cancelled' }],
    })
    f.runtime.reset()
    const secondTask = task('b')
    await f.runtime.prepare(request(secondTask))
    first.emit({ type: 'text', delta: '不应进入另一本书' })
    first.emit({ type: 'done' })
    first.finished.resolve()
    const second = f.backend.runs[1]
    second.emit({ type: 'text', delta: '另一本书的回答。' })
    second.emit({ type: 'done' })
    await f.runtime.flush()
    expect(f.save).toHaveBeenCalledTimes(2)
    expect(f.runtime.getSnapshot().conversation).toMatchObject({
      bookId: 'b'.repeat(64),
      messages: [{ content: '为什么？' }, { content: '另一本书的回答。' }],
    })
    expect(f.saved[0].messages.at(-1)?.content).toBe('未完成。')
  })

  it('revokes a late preparation after switching books and releases a dismissed preview', async () => {
    const f = fixture()
    const late = deferred<ReadingTask>()
    const old = task()
    const preparing = f.runtime.prepare(request(old, { createTask: () => late.promise }))
    expect(f.runtime.getSnapshot().phase).toBe('preparing')
    f.runtime.cancel()
    const next = task('b')
    await f.runtime.prepare(request(next, { isApproved: () => false }))
    late.resolve(old)
    await preparing
    expect(old.revoke).toHaveBeenCalledOnce()
    expect(f.runtime.getSnapshot().pending?.snapshot.bookId).toBe(next.snapshot.bookId)
    f.runtime.cancel()
    expect(next.revoke).toHaveBeenCalledOnce()
    expect(f.backend.runs).toHaveLength(0)
    expect(f.save).not.toHaveBeenCalled()
  })

  it('rejects mismatched book versions before any backend invocation', async () => {
    const f = fixture()
    const wrong = task('b')
    await f.runtime.prepare(request(task(), { createTask: async () => wrong }))
    expect(wrong.revoke).toHaveBeenCalledOnce()
    expect(f.backend.runs).toHaveLength(0)
    expect(f.runtime.getSnapshot().phase).toBe('idle')
    expect(f.onError).toHaveBeenCalledOnce()
  })

  it('starts a new frozen context and safe history when narrowing scope, rejecting overbroad prepared tasks', async () => {
    const f = fixture()
    const broad = task()
    broad.snapshot.scope = 'book'
    await f.runtime.prepare(request(broad))
    f.backend.runs[0].emit({ type: 'text', delta: '来自全书范围。' })
    f.backend.runs[0].emit({ type: 'done' })
    const narrow = task()
    const input = request(narrow)
    await f.runtime.prepare(input)
    expect(input.createTask).toHaveBeenCalledOnce()
    expect(broad.revoke).toHaveBeenCalledOnce()
    expect(f.backend.runs[1].request.history).toEqual([])
    expect(f.backend.runs[1].request.tools.snapshot.scope).toBe('to-position')
    f.backend.runs[1].emit({ type: 'done' })
    f.runtime.reset()
    await f.runtime.prepare(request(broad, { scope: 'to-position' }))
    expect(f.backend.runs).toHaveLength(2)
    expect(f.onError).toHaveBeenCalledOnce()
    await f.runtime.flush()
  })

  it('routes through the selected provider and harness, cancelling and revoking on switch or disable', async () => {
    const f = fixture()
    const firstTask = task()
    await f.runtime.prepare(request(firstTask))
    const first = f.backend.runs[0]
    first.emit({ type: 'done' })
    const secondProvider = provider('second-provider')
    f.providers.register(secondProvider)
    f.providers.select(secondProvider.id)
    expect(firstTask.revoke).toHaveBeenCalledOnce()
    const secondTask = task()
    await f.runtime.prepare(request(secondTask))
    const second = f.backend.runs[1]
    expect(second.request.provider).toBe(secondProvider)
    expect(second.request.history).toEqual([])
    expect(second.request.sessionRef).not.toBe(first.request.sessionRef)
    const other = harness('second-harness')
    f.harnesses.register(other.adapter)
    f.harnesses.select(other.adapter.id)
    expect(second.request.signal.aborted).toBe(true)
    expect(secondTask.revoke).toHaveBeenCalledOnce()
    await f.runtime.prepare(request(task()))
    expect(other.runs).toHaveLength(1)
    f.runtime.setEnabled(false)
    expect(other.runs[0].request.signal.aborted).toBe(true)
    const disabled = request(task())
    await f.runtime.prepare(disabled)
    expect(disabled.createTask).not.toHaveBeenCalled()
    expect(other.runs).toHaveLength(1)
    f.runtime.setEnabled(true)
    await f.runtime.prepare(request(task()))
    expect(other.runs).toHaveLength(2)
    f.runtime.cancel()
    await f.runtime.flush()
  })

  it('deduplicates events, rejects crossed identities, and fails visibly on a sequence gap', async () => {
    const f = fixture()
    const tools = task()
    await f.runtime.prepare(request(tools))
    const run = f.backend.runs[0]
    const identity = { runId: run.request.runId, sessionRef: run.request.sessionRef }
    run.receive({
      ...identity,
      runId: 'wrong-run',
      eventId: 'wrong_1',
      sequence: 1,
      type: 'text',
      delta: '错轮次',
    })
    run.receive({
      ...identity,
      sessionRef: 'wrong-session',
      eventId: 'wrong_2',
      sequence: 1,
      type: 'text',
      delta: '错会话',
    })
    const event = run.emit({ type: 'text', delta: '唯一内容。' })
    run.receive(event)
    run.receive({ ...identity, eventId: 'gap', sequence: 3, type: 'text', delta: '缺失的事件' })
    await f.runtime.flush()
    expect(f.saved[0].messages.at(-1)).toMatchObject({ content: '唯一内容。', status: 'error' })
    expect(run.request.signal.aborted).toBe(true)
    expect(tools.revoke).toHaveBeenCalledOnce()
    expect(f.onError).toHaveBeenCalledOnce()
  })

  it('marks an adapter that resolves without a completion event as incomplete', async () => {
    const f = fixture()
    await f.runtime.prepare(request(task()))
    f.backend.runs[0].emit({ type: 'text', delta: '只有部分内容。' })
    f.backend.runs[0].finished.resolve()
    await vi.waitFor(() => expect(f.runtime.getSnapshot().phase).toBe('idle'))
    await f.runtime.flush()
    expect(f.saved[0].messages.at(-1)).toMatchObject({ status: 'error', content: '只有部分内容。' })
  })

  it('serializes immutable conversation saves so a slow older turn cannot overwrite a follow-up', async () => {
    const pending = deferred()
    const save = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(undefined)
    const f = fixture(save)
    const tools = task()
    await f.runtime.prepare(request(tools))
    f.backend.runs[0].emit({ type: 'done' })
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    await f.runtime.prepare(request(tools, { question: '追问' }))
    f.backend.runs[1].emit({ type: 'text', delta: '新的回答' })
    f.backend.runs[1].emit({ type: 'done' })
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0][0].messages).toHaveLength(2)
    pending.resolve()
    await f.runtime.flush()
    expect(save.mock.calls[1][0].messages).toHaveLength(4)
    expect(save.mock.calls[1][0].messages.at(-1).content).toBe('新的回答')
  })

  it('reports failed persistence and allows a later successful turn to save the full conversation', async () => {
    const failure = new Error('synthetic storage failure')
    const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const f = fixture(save)
    const tools = task()
    await f.runtime.prepare(request(tools))
    f.backend.runs[0].emit({ type: 'done' })
    await expect(f.runtime.flush()).rejects.toBe(failure)
    expect(f.onError).toHaveBeenCalledWith(failure)
    await f.runtime.prepare(request(tools))
    f.backend.runs[1].emit({ type: 'done' })
    await expect(f.runtime.flush()).resolves.toBeUndefined()
    expect(save.mock.calls[1][0].messages).toHaveLength(4)
  })

  it('can retry a cancelled conversation after a temporary write failure before restoring a backup', async () => {
    const failure = new Error('temporary storage failure')
    const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const f = fixture(save)
    await f.runtime.prepare(request(task()))
    f.backend.runs[0].emit({ type: 'text', delta: '应当保留的部分回答。' })
    f.runtime.cancel()
    await expect(f.runtime.flush()).rejects.toBe(failure)
    await expect(f.runtime.flush()).resolves.toBeUndefined()
    expect(save.mock.calls[1][0].messages.at(-1)).toMatchObject({
      content: '应当保留的部分回答。',
      status: 'cancelled',
    })
  })
})

describe('bundled adapter registry', () => {
  it('rejects duplicate registration, preserves capabilities, and never silently falls back from a disabled selection', async () => {
    const f = fixture()
    expect(() => f.providers.register(provider())).toThrow('已经注册')
    const missingTools = {
      ...provider('limited'),
      capabilities: { streaming: true, tools: false, cancel: true },
    }
    f.providers.register(missingTools)
    f.providers.select(missingTools.id)
    const input = request(task())
    await f.runtime.prepare(input)
    expect(input.createTask).not.toHaveBeenCalled()
    expect(f.providers.list().find((entry) => entry.id === 'limited')).toMatchObject({
      selected: true,
      capabilities: { tools: false },
    })
    f.providers.setEnabled('limited', false)
    expect(f.providers.current()).toBeNull()
    expect(() => f.providers.select('limited')).toThrow('已停用')
    f.providers.unregister('limited')
    expect(f.providers.selectedId).toBeNull()
    expect(f.backend.runs).toHaveLength(0)
  })
})
