import { beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinHarness } from '../src/harness/builtin'
import { compatibleProvider } from '../src/harness/provider'
import { ReadingTools } from '../src/core/tools'
import { PreviewReadingTask } from '../src/core/reading-service'
import { defaultModel, type CompletionMessage, type Message } from '../src/core/types'
import type { ProviderDelta, RunEvent } from '../src/harness/contracts'

vi.mock('../src/harness/provider', () => ({ compatibleProvider: { complete: vi.fn() } }))
const complete = vi.mocked(compatibleProvider.complete)
const runContext = () => ({
  provider: compatibleProvider,
  runId: crypto.randomUUID(),
  sessionRef: 'session_1',
})
function tools() {
  const locator = {
    cfi: 'epubcfi(/6/2!/4/2)',
    sectionIndex: 0,
    paragraphId: 'p_0_0',
    endOffset: 8,
    progress: 0.1,
  }
  const book = {
    id: 'a'.repeat(64),
    version: `sha256:${'a'.repeat(64)}`,
    title: '阅读',
    author: '作者',
    language: 'zh',
    fileName: 'test.epub',
    addedAt: '',
    coverTone: 0,
  }
  return new PreviewReadingTask(
    new ReadingTools(
      book,
      [
        {
          id: 'p_0_0',
          sectionIndex: 0,
          ordinal: 0,
          text: '理解从一个问题开始。',
          cfi: locator.cfi,
          chapter: '第一章',
        },
      ],
      { locator, text: '理解从一个问题开', isSelection: true },
      'to-position',
    ),
  )
}
const stream = (deltas: ProviderDelta[]) =>
  complete.mockImplementationOnce(async (_body, _config, _signal, onDelta) => {
    for (const delta of deltas) onDelta(delta)
  })
const tool = {
  index: 0,
  id: 'search_1',
  type: 'function',
  function: { name: 'book_search', arguments: '{"query":"理解"}' },
}

describe('DeepSeek thinking and visible tool exchanges', () => {
  beforeEach(() => vi.clearAllMocks())
  it('replays full reasoning and tool exchanges both within a run and on a follow-up', async () => {
    const readingTools = tools()
    stream([{ reasoning_content: '先找原文。' }, { tool_calls: [tool] }])
    stream([{ reasoning_content: '依据已经找到。' }, { content: '理解从问题开始。' }])
    const events: RunEvent[] = []
    await builtinHarness.submit(
      {
        ...runContext(),
        tools: readingTools,
        question: '为什么？',
        history: [],
        settings: { ...defaultModel, reasoningEffort: 'max', maxTokens: 16384 },
        apiKey: '',
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    )
    expect(complete.mock.calls[0][0]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      max_tokens: 16384,
    })
    const system = (complete.mock.calls[0][0].messages as { content: string }[])[0].content
    expect(system).toContain(`[[${readingTools.snapshot.initial[0].citationId}]]`)
    expect(system).toContain('逐字复制')
    const second = complete.mock.calls[1][0].messages as CompletionMessage[]
    expect(second.find((message) => message.role === 'assistant')).toMatchObject({
      reasoning_content: '先找原文。',
      tool_calls: [{ id: 'search_1' }],
    })
    expect(events.filter((event) => event.type === 'tool').at(-1)).toMatchObject({
      tool: { status: 'succeeded', name: 'book_search', summary: '找到 1 段原文' },
    })
    const protocolEvent = events.filter((event) => event.type === 'protocol').at(-1)!
    const history: Message[] = [
      { id: 'question', role: 'user', content: '为什么？' },
      {
        id: 'answer',
        role: 'assistant',
        content: '理解从问题开始。',
        status: 'done',
        protocol: protocolEvent.messages,
      },
    ]
    stream([{ reasoning_content: '继续解释。' }, { content: '追问的回答。' }])
    await builtinHarness.submit(
      {
        ...runContext(),
        tools: readingTools,
        question: '再说说。',
        history,
        settings: defaultModel,
        apiKey: '',
        signal: new AbortController().signal,
      },
      () => {},
    )
    const followup = complete.mock.calls[2][0].messages as CompletionMessage[]
    expect(
      followup
        .filter((message) => message.role === 'assistant')
        .map((message) => message.reasoning_content),
    ).toEqual(['先找原文。', '依据已经找到。'])
    expect(followup.some((message) => message.role === 'tool')).toBe(true)
  })
  it('does not send DeepSeek-only controls to other compatible providers', async () => {
    stream([{ content: '直接回答。' }])
    await builtinHarness.submit(
      {
        ...runContext(),
        tools: tools(),
        question: '问题',
        history: [],
        settings: { ...defaultModel, provider: 'compatible' },
        apiKey: '',
        signal: new AbortController().signal,
      },
      () => {},
    )
    expect(complete.mock.calls[0][0]).not.toHaveProperty('thinking')
    expect(complete.mock.calls[0][0]).not.toHaveProperty('reasoning_effort')
  })
  it('stops the tool loop if cancellation happens while an asynchronous reading tool is pending', async () => {
    const task = tools()
    let finish!: (value: Awaited<ReturnType<typeof task.search>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof task.search>>>((resolve) => {
      finish = resolve
    })
    const search = vi.spyOn(task, 'search').mockReturnValue(pending)
    const controller = new AbortController()
    stream([{ tool_calls: [tool] }])
    const events: RunEvent[] = []
    const run = builtinHarness.submit(
      {
        ...runContext(),
        tools: task,
        question: '问题',
        history: [],
        settings: defaultModel,
        apiKey: '',
        signal: controller.signal,
      },
      (event) => events.push(event),
    )
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce())
    controller.abort()
    await task.revoke()
    finish({
      schemaVersion: 1,
      snapshotId: task.snapshot.id,
      bookVersion: task.snapshot.bookVersion,
      fragments: [],
      truncated: false,
      nextCursor: null,
      indexStatus: 'scan',
    })
    await rejection
    expect(complete).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === 'tool').at(-1)).toMatchObject({
      tool: { status: 'running' },
    })
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })
  it('reports invalid tool arguments visibly without granting access or losing reasoning', async () => {
    stream([
      { reasoning_content: '尝试查询。' },
      {
        tool_calls: [
          {
            ...tool,
            function: { name: 'book_search', arguments: '{"query":"理解","bookId":"other"}' },
          },
        ],
      },
    ])
    stream([{ content: '无法使用这个参数。' }])
    const events: RunEvent[] = []
    await builtinHarness.submit(
      {
        ...runContext(),
        tools: tools(),
        question: '问题',
        history: [],
        settings: { ...defaultModel, thinking: 'disabled' },
        apiKey: '',
        signal: new AbortController().signal,
      },
      (event) => events.push(event),
    )
    expect(complete.mock.calls[0][0]).toMatchObject({
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
    })
    expect(events.filter((event) => event.type === 'tool').at(-1)).toMatchObject({
      tool: { status: 'error', summary: '搜索参数无效。' },
    })
  })
})
