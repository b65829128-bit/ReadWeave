import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingTask } from '../src/core/reading-service'
import { defaultModel } from '../src/core/types'
import { astrbotEndpoint, createAstrbotHarness } from '../src/harness/astrbot'
import type { HarnessAdapter, RunEvent } from '../src/harness/contracts'

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
      Array.from({ length: 7 }, (_, index) => ({
        jsonrpc: '2.0',
        id: index,
        method: 'tools/call',
        params: { name: 'book_search', arguments: { query: 'x' } },
      })),
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
})
