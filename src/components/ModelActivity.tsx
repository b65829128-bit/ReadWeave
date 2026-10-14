import { Brain, Check, CircleAlert, LoaderCircle, Wrench } from 'lucide-react'
import type { Message } from '../core/types'

function pretty(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function ModelActivity({ message }: { message: Message }) {
  return (
    <div className="model-activity">
      {message.reasoning && (
        <details className="reasoning-block" open={!message.status && !message.content}>
          <summary>
            <Brain size={14} />
            <span>思考过程</span>
            <small>
              {!message.status ? '生成中' : message.status === 'done' ? '已完成' : '未完成'}
            </small>
          </summary>
          <p className="reasoning-content">{message.reasoning}</p>
        </details>
      )}
      {!!message.tools?.length && (
        <div className="tool-timeline" aria-label="工具调用记录">
          {message.tools.map((tool) => (
            <details key={tool.id} className={`tool-execution tool-${tool.status}`}>
              <summary>
                <Wrench size={13} />
                <span>
                  {tool.name === 'book_search'
                    ? '搜索书内原文'
                    : tool.name === 'book_read_passage'
                      ? '读取附近段落'
                      : tool.name || '准备工具调用'}
                  <small>
                    {tool.summary ??
                      (tool.status === 'preparing'
                        ? '准备参数…'
                        : tool.status === 'running'
                          ? '执行中…'
                          : '已停止')}
                  </small>
                </span>
                {tool.status === 'succeeded' ? (
                  <Check size={14} />
                ) : tool.status === 'error' ? (
                  <CircleAlert size={14} />
                ) : tool.status === 'preparing' || tool.status === 'running' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : null}
              </summary>
              <div className="tool-detail">
                <code>{tool.name}</code>
                <strong>调用参数</strong>
                <pre>{pretty(tool.arguments)}</pre>
                {tool.result && (
                  <>
                    <strong>返回结果</strong>
                    <pre>{pretty(tool.result)}</pre>
                  </>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
