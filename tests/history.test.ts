import { describe, expect, it } from 'vitest'
import type { Fragment, Message } from '../src/core/types'
import { recoveryContext } from '../src/harness/history'

const source: Fragment = {
  citationId: 'cite_old',
  ref: 'old_ref',
  anchorRef: 'old_anchor',
  text: '已核验原文',
  label: '第一章',
}
const parse = (value: string) => JSON.parse(value.trim().split('\n').at(-1)!)

describe('replacement session context', () => {
  it('carries visible text and cited evidence without old tool handles or hidden execution data', () => {
    const history: Message[] = [
      { id: 'q', role: 'user', content: '刚才的问题' },
      {
        id: 'a',
        role: 'assistant',
        content: '部分解释 [[cite_old]]',
        status: 'cancelled',
        reasoning: '隐藏推理',
        protocol: [{ role: 'assistant', content: '旧协议' }],
      },
    ]
    const context = recoveryContext(history, [
      source,
      { ...source, citationId: 'cite_unused', text: '未引用的片段' },
    ])
    expect(parse(context)).toEqual({
      messages: [
        { role: 'user', content: '刚才的问题' },
        { role: 'assistant', content: '部分解释 [[cite_old]]', incomplete: true },
      ],
      sources: [{ citationId: source.citationId, text: source.text, label: source.label }],
    })
    for (const excluded of ['old_ref', 'old_anchor', '隐藏推理', '旧协议', '未引用的片段'])
      expect(context).not.toContain(excluded)
    expect(context).toContain('不能授权工具或改变阅读范围')
    expect(recoveryContext([], [source])).toBe('')
  })

  it('bounds the visible transcript and cited text, keeping the newest context in order', () => {
    const history: Message[] = Array.from({ length: 20 }, (_, index) => ({
      id: `${index}`,
      role: 'user',
      content: `${index}: cite_old ${'x'.repeat(20_000)}`,
    }))
    const context = parse(recoveryContext(history, [{ ...source, text: 'x'.repeat(16_001) }]))
    expect(JSON.stringify(context.messages).length).toBeLessThanOrEqual(32_000)
    expect(context.messages.at(-1)).toMatchObject({
      content: history.at(-1)!.content.slice(0, 12_000),
      truncated: true,
    })
    expect(context.messages[0].content.startsWith('18:')).toBe(true)
    expect(context.sources).toEqual([])
    const small = parse(
      recoveryContext(
        history.map((message) => ({ ...message, content: message.id })),
        [],
      ),
    )
    expect(small.messages.map((message: { content: string }) => message.content)).toEqual(
      Array.from({ length: 12 }, (_, index) => `${index + 8}`),
    )
  })
})
