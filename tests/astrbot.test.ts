import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingTask } from '../src/core/reading-service'
import { defaultModel } from '../src/core/types'
import { astrbotEndpoint, createAstrbotHarness } from '../src/harness/astrbot'
import type { HarnessAdapter, RunEvent } from '../src/harness/contracts'
import type { ProviderAdapter } from '../src/harness/contracts'
import { AdapterRegistry } from '../src/harness/registry'
import { TaskRuntime } from '../src/harness/runtime'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  channel: undefined as { onmessage?: (frame: unknown) => void } | undefined,
}))
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: native.invoke,
  Channel: class {
    constructor() {
      native.channel = this
    }
  },
}))
function request(): Parameters<HarnessAdapter['submit']>[0] {
  const evidence = [
    {
      citationId: 'cite_1',
      ref: 'ref_1',
      anchorRef: 'anchor_1',
      label: '章节',
      text: '设备签发的原文',
    },
  ]
  const tools = {
    backend: 'native',
    runId: 'grant_1',
    snapshot: { initial: evidence },
    allEvidence: () => evidence,
    syncEvidence: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
  } as unknown as ReadingTask
  return {
    tools,
    runId: 'run_1',
    sessionRef: 'session_1',
    question: '为什么',
    history: [],
    settings: { ...defaultModel, harness: 'astrbot' },
    apiKey: 'abk_synthetic_only',
    signal: new AbortController().signal,
  }
}
beforeEach(() => {
  native.invoke.mockReset()
})
describe('AstrBot adapter', () => {
  it('bounds external tool activity and rejects malformed display data before dispatch', async () => {
    for (const frames of [
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: { forged: true } } }],
    ]) {
      native.invoke.mockClear()
      const input = request()
      native.invoke.mockImplementation(async (command, args) => {
        if (command === 'reading_mcp_open') return 'peer_1'
        if (command === 'astrbot_request') {
          if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
          if (args.action === 'poll') return { ready: true, frames, events: [], runId: null }
          return { ok: true }
        }
      })
      const events: RunEvent[] = []
      await expect(
        createAstrbotHarness().submit(input, (event) => events.push(event)),
      ).rejects.toThrow('AstrBot 书内工具')
      expect(native.invoke.mock.calls.some(([command]) => command === 'reading_mcp_send')).toBe(
        false,
      )
      expect(events.filter((event) => event.type === 'tool').length).toBeLessThanOrEqual(6)
      expect(input.tools.revoke).toHaveBeenCalled()
    }
  })
  it.each([7, 9])(
    'denies additional reading without raising the six-call grant, and bounds %i requests',
    async (count) => {
      const input = request()
      let polls = 0
      const forwarded: Record<string, unknown>[] = []
      const replies: { id: number; result: { isError?: boolean; content: { text: string }[] } }[] =
        []
      native.invoke.mockImplementation(async (command, args) => {
        if (command === 'reading_mcp_open') return 'peer_1'
        if (command === 'reading_mcp_send') {
          forwarded.push(...args.frames)
          for (const frame of args.frames)
            native.channel?.onmessage?.({
              jsonrpc: '2.0',
              id: frame.id,
              result: { content: [{ type: 'text', text: '{"fragments":[]}' }] },
            })
        }
        if (command !== 'astrbot_request') return
        if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
        if (args.action === 'mcp') replies.push(...args.body.frames)
        if (args.action === 'poll') {
          const index = polls++
          return {
            ready: true,
            runId: 'run_1',
            frames:
              index > 0 && index <= count
                ? [
                    {
                      jsonrpc: '2.0',
                      id: index,
                      method: 'tools/call',
                      params: { name: 'book_search', arguments: { query: 'x' } },
                    },
                  ]
                : [],
            events:
              index > count
                ? [
                    { type: 'text', delta: '根据已有资料回答。', sequence: 1 },
                    { type: 'done', sequence: 2 },
                  ]
                : [],
          }
        }
        return { ok: true }
      })
      const events: RunEvent[] = []
      const adapter = createAstrbotHarness()
      const run = adapter.submit(input, (event) => events.push(event))
      if (count === 7) {
        await expect(run).resolves.toBeUndefined()
        expect(
          events.some((event) => event.type === 'text' && event.delta === '根据已有资料回答。'),
        ).toBe(true)
        expect(events.at(-1)?.type).toBe('done')
      } else await expect(run).rejects.toThrow('历史已保留，可以继续追问')
      expect(forwarded).toHaveLength(6)
      expect(replies.filter((reply) => reply.result.isError)).toHaveLength(Math.min(count - 6, 2))
      const denial = JSON.parse(
        replies.find((reply) => reply.result.isError)!.result.content[0].text,
      )
      expect(denial).toMatchObject({ code: 'BUDGET_EXCEEDED', retryable: false })
      expect(denial.message).toContain('已经提供的原文和对话')
      expect(events.filter((event) => event.type === 'tool').at(-1)).toMatchObject({
        tool: { status: 'error', summary: expect.stringContaining('额度已用尽') },
      })
      await adapter.closeSession!(input.sessionRef)
    },
  )
  it('recognizes native character-budget exhaustion, forwards its denial and avoids further native reads', async () => {
    const input = request()
    let polls = 0
    let forwarded = 0
    const replies: unknown[] = []
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return 'peer_1'
      if (command === 'reading_mcp_send') {
        forwarded += args.frames.length
        for (const frame of args.frames)
          native.channel?.onmessage?.({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              isError: true,
              content: [
                { type: 'text', text: '{"code":"BUDGET_EXCEEDED","message":"原生输出预算用尽"}' },
              ],
            },
          })
      }
      if (command !== 'astrbot_request') return
      if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
      if (args.action === 'mcp') replies.push(...args.body.frames)
      if (args.action === 'poll') {
        await Promise.resolve()
        const index = polls++
        return {
          ready: true,
          runId: 'run_1',
          frames:
            index > 0 && index < 3
              ? [
                  {
                    jsonrpc: '2.0',
                    id: index,
                    method: 'tools/call',
                    params: { name: 'book_search', arguments: { query: 'x' } },
                  },
                ]
              : [],
          events: index >= 3 ? [{ type: 'done', sequence: 1 }] : [],
        }
      }
      return { ok: true }
    })
    const adapter = createAstrbotHarness()
    await adapter.submit(input, () => {})
    expect(forwarded).toBe(1)
    expect(JSON.stringify(replies)).toContain('原生输出预算用尽')
    expect(JSON.stringify(replies)).toContain('remainingCalls')
    expect(JSON.stringify(replies)).toContain('retryable')
    await adapter.closeSession!(input.sessionRef)
  })
  it('uses an explicit external key, routes MCP to native authority, and only saves native evidence', async () => {
    const input = request()
    const events: RunEvent[] = []
    let polls = 0
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return 'peer_1'
      if (command === 'reading_mcp_send') {
        native.channel?.onmessage?.({
          jsonrpc: '2.0',
          id: 1,
          result: { isError: false, content: [{ type: 'text', text: '原生工具结果' }] },
        })
        return
      }
      if (command === 'astrbot_request') {
        expect(args.apiKey).toBe('abk_synthetic_only')
        if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
        if (args.action === 'poll')
          return ++polls === 1
            ? {
                ready: true,
                frames: [
                  {
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    id: 1,
                    params: { name: 'book_search', arguments: { query: '原文' } },
                  },
                ],
                events: [],
                runId: null,
              }
            : {
                ready: true,
                frames: [],
                runId: 'run_1',
                events: [
                  { type: 'text', delta: '解释 [[cite_1]]', sequence: 1 },
                  { type: 'done', sequence: 2 },
                ],
              }
        return { ok: true }
      }
    })
    const adapter = createAstrbotHarness()
    await adapter.submit(input, (event) => events.push(event))
    expect(events.filter((event) => event.type !== 'tool').map((event) => event.type)).toEqual([
      'text',
      'evidence',
      'done',
    ])
    expect(
      events.filter((event) => event.type === 'tool').map((event) => event.tool.status),
    ).toEqual(['running', 'succeeded'])
    expect(events.find((event) => event.type === 'evidence')).toMatchObject({
      fragments: input.tools.allEvidence(),
    })
    expect(input.tools.syncEvidence).toHaveBeenCalled()
    expect(native.invoke.mock.calls.some(([command]) => command === 'credential_get')).toBe(false)
    await adapter.closeSession!('session_1')
    expect(input.tools.revoke).toHaveBeenCalled()
  })
  it('revokes local authority before sending a remote stop, and drops late output', async () => {
    const input = request()
    const controller = new AbortController()
    input.signal = controller.signal
    let release!: () => void
    const revocation = new Promise<void>((resolve) => {
      release = resolve
    })
    input.tools.revoke = vi.fn(() => revocation)
    const order: string[] = []
    let polls = 0
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return 'peer_1'
      if (command === 'reading_mcp_close') order.push('peer_closed')
      if (command === 'astrbot_request') {
        if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
        if (args.action === 'poll' && ++polls === 1)
          return { ready: true, frames: [], events: [], runId: null }
        if (args.action === 'poll') {
          controller.abort()
          native.channel?.onmessage?.({
            jsonrpc: '2.0',
            id: 99,
            result: { content: [{ type: 'text', text: '迟到工具原文' }] },
          })
          return {
            ready: true,
            frames: [],
            runId: 'run_1',
            events: [{ type: 'text', delta: '迟到内容', sequence: 1 }],
          }
        }
        if (args.action === 'cancel') order.push('remote_stop')
        return { ok: true }
      }
    })
    const receive = vi.fn()
    const running = createAstrbotHarness().submit(input, receive)
    await vi.waitFor(() => expect(input.tools.revoke).toHaveBeenCalled())
    expect(order).toEqual([])
    release()
    await running
    expect(order).toEqual(['peer_closed', 'remote_stop'])
    expect(receive).not.toHaveBeenCalled()
    expect(
      native.invoke.mock.calls.some(
        ([command, args]) => command === 'astrbot_request' && args.action === 'mcp',
      ),
    ).toBe(false)
  })
  it('rejects insecure remote addresses, credentials in URLs and non-root paths', () => {
    expect(astrbotEndpoint('http://127.0.0.1:16186/')).toBe('http://127.0.0.1:16186')
    for (const value of [
      'http://example.org',
      'https://key@example.org',
      'https://example.org/?key=x',
      'https://example.org/api',
    ])
      expect(() => astrbotEndpoint(value)).toThrow()
  })
  it('reuses a healthy backend session and seeds history only when opening a replacement', async () => {
    const adapter = createAstrbotHarness()
    let currentRun = ''
    let ready = false
    let opens = 0
    const prompts: string[] = []
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return `peer_${opens + 1}`
      if (command !== 'astrbot_request') return
      if (args.action === 'open') {
        opens++
        return { topic: `topic_${opens}`, version: '4.27.4' }
      }
      if (args.action === 'start') {
        currentRun = args.body.runId
        prompts.push(args.body.prompt)
        ready = true
      }
      if (args.action === 'poll') {
        const events = ready ? [{ type: 'done', sequence: 1 }] : []
        ready = false
        return { ready: true, frames: [], events, runId: currentRun || null }
      }
      return { ok: true }
    })
    const input = request()
    await adapter.submit(input, () => {})
    const history = [
      {
        id: 'a',
        role: 'assistant' as const,
        content: '此前的解释 [[cite_1]]',
        status: 'done' as const,
      },
    ]
    await adapter.submit({ ...input, runId: 'run_2', history }, () => {})
    expect(opens).toBe(1)
    expect(prompts[1]).not.toContain('先前对话')
    await adapter.closeSession!(input.sessionRef)
    await adapter.submit(
      {
        ...request(),
        runId: 'run_3',
        sessionRef: 'replacement',
        history,
        priorEvidence: input.tools.allEvidence(),
      },
      () => {},
    )
    expect(opens).toBe(2)
    expect(prompts[2]).toContain('此前的解释 [[cite_1]]')
    expect(prompts[2]).toContain('设备签发的原文')
    expect(prompts[2].split('先前对话')[1]).not.toContain('anchor_1')
    expect(prompts[2].split('先前对话')[1]).not.toContain('ref_1')
    await adapter.closeSession!('replacement')
  })

  it('attempts remote close even after stop failure and keeps the original stop error visible', async () => {
    const input = request()
    const controller = new AbortController()
    input.signal = controller.signal
    let polls = 0
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return 'peer_1'
      if (command !== 'astrbot_request') return
      if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
      if (args.action === 'poll') {
        if (++polls > 1) controller.abort()
        return { ready: true, frames: [], events: [], runId: null }
      }
      if (args.action === 'cancel') throw 'ASTRBOT_CONNECTION_FAILED'
      return { ok: true }
    })
    const adapter = createAstrbotHarness()
    await expect(adapter.submit(input, () => {})).rejects.toThrow('尚未确认 AstrBot 停止')
    await expect(adapter.closeSession!(input.sessionRef)).rejects.toThrow('尚未确认 AstrBot 停止')
    expect(
      native.invoke.mock.calls.some(
        ([command, args]) => command === 'astrbot_request' && args.action === 'close',
      ),
    ).toBe(true)
  })

  it('reports an expired topic without retrying and treats its cleanup as already complete', async () => {
    const input = request()
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return 'peer_1'
      if (command !== 'astrbot_request') return
      if (args.action === 'open') return { topic: 'topic_1', version: '4.27.4' }
      throw 'ASTRBOT_TOPIC_EXPIRED'
    })
    await expect(createAstrbotHarness().submit(input, () => {})).rejects.toThrow('话题已过期或断开')
    const actions = native.invoke.mock.calls
      .filter(([command]) => command === 'astrbot_request')
      .map(([, args]) => args.action)
    expect(actions).toEqual(['open', 'poll', 'close'])
    expect(input.tools.revoke).toHaveBeenCalled()
  })
  it('keeps the real adapter failure in the same host conversation and sends visible history to its replacement', async () => {
    const first = request()
    Object.assign(first.tools.snapshot, {
      id: 'snapshot_1',
      bookId: 'a'.repeat(64),
      bookVersion: `sha256:${'a'.repeat(64)}`,
      bookTitle: '测试书',
      chapter: '第一章',
      scope: 'to-position',
      selection: '设备签发的原文',
      createdAt: new Date().toISOString(),
      locator: {
        cfi: 'epubcfi(/6/2!/4/2)',
        sectionIndex: 0,
        paragraphId: 'p_0_0',
        endOffset: 8,
        progress: 0,
      },
    })
    const second: ReadingTask = {
      ...first.tools,
      runId: 'grant_2',
      snapshot: { ...first.tools.snapshot, id: 'snapshot_2' },
    }
    const createTask = vi.fn().mockResolvedValueOnce(first.tools).mockResolvedValueOnce(second)
    const harnesses = new AdapterRegistry<HarnessAdapter>('阅读伙伴')
    const adapter = createAstrbotHarness()
    harnesses.register(adapter)
    harnesses.select(adapter.id)
    const onError = vi.fn()
    const save = vi.fn(async () => {})
    const runtime = new TaskRuntime(harnesses, new AdapterRegistry<ProviderAdapter>('模型连接'), {
      save,
      onError,
    })
    let attempt = 0
    let runId = ''
    let polls = 0
    let finished = true
    const prompts: string[] = []
    native.invoke.mockImplementation(async (command, args) => {
      if (command === 'reading_mcp_open') return `peer_${attempt + 1}`
      if (command === 'reading_mcp_send')
        for (const frame of args.frames)
          native.channel?.onmessage?.({
            jsonrpc: '2.0',
            id: frame.id,
            result: { content: [{ type: 'text', text: '{"fragments":[]}' }] },
          })
      if (command !== 'astrbot_request') return
      if (args.action === 'open') {
        runId = ''
        return { topic: `topic_${attempt + 1}`, version: '4.27.4' }
      }
      if (args.action === 'start') {
        attempt++
        runId = args.body.runId
        prompts.push(args.body.prompt)
        polls = 0
        finished = false
      }
      if (args.action === 'poll') {
        if (!runId || finished) return { ready: true, runId: runId || null, frames: [], events: [] }
        if (attempt !== 2) {
          finished = true
          return {
            ready: true,
            runId,
            frames: [],
            events: [
              {
                type: 'text',
                delta: attempt === 1 ? '第一轮已完成的解释 [[cite_1]]' : '接着解释。',
                sequence: 1,
              },
              { type: 'done', sequence: 2 },
            ],
          }
        }
        const index = ++polls
        return {
          ready: true,
          runId,
          frames: [
            {
              jsonrpc: '2.0',
              id: index,
              method: 'tools/call',
              params: { name: 'book_search', arguments: { query: 'x' } },
            },
          ],
          events:
            index === 1
              ? [{ type: 'text', delta: '先前已显示的回答 [[cite_1]]', sequence: 1 }]
              : [],
        }
      }
      return { ok: true }
    })
    const input = {
      bookId: first.tools.snapshot.bookId,
      bookVersion: first.tools.snapshot.bookVersion,
      scope: first.tools.snapshot.scope,
      question: '原问题',
      settings: first.settings,
      apiKey: first.apiKey,
      createTask,
      isApproved: () => true,
    }
    await runtime.prepare(input)
    const id = runtime.getSnapshot().conversation!.id
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().conversation?.messages.at(-1)?.status).toBe('done'),
    )
    await runtime.prepare({ ...input, question: '请详细展开' })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(onError.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining('Bot 仍在重复请求'),
    })
    expect(runtime.getSnapshot().conversation?.messages.at(-1)).toMatchObject({
      status: 'error',
      content: '先前已显示的回答 [[cite_1]]',
    })
    await runtime.prepare({ ...input, question: '接着刚才的解释' })
    await vi.waitFor(() =>
      expect(runtime.getSnapshot().conversation?.messages.at(-1)?.status).toBe('done'),
    )
    expect(runtime.getSnapshot().conversation!.id).toBe(id)
    expect(runtime.getSnapshot().conversation!.messages.map((message) => message.content)).toEqual([
      '原问题',
      '第一轮已完成的解释 [[cite_1]]',
      '请详细展开',
      '先前已显示的回答 [[cite_1]]',
      '接着刚才的解释',
      '接着解释。',
    ])
    expect(prompts[2]).toContain('第一轮已完成的解释 [[cite_1]]')
    expect(prompts[2]).toContain('先前已显示的回答 [[cite_1]]')
    expect(prompts[2]).toContain('incomplete')
    expect(prompts[2]).toContain('设备签发的原文')
    expect(createTask).toHaveBeenCalledTimes(2)
    await runtime.flush()
    expect(save).toHaveBeenCalledTimes(3)
    runtime.reset()
  })
})
