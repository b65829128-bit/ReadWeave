import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronLeft,
  MessageSquarePlus,
  NotebookPen,
  Send,
  Settings2,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Conversation, Fragment, Message, ReadingPoint } from '../core/types'
import type { ReadingAction } from '../core/plugins'
import { Answer } from './Answer'
import { ModelActivity } from './ModelActivity'

interface Props {
  selection: ReadingPoint | null
  conversation: Conversation | null
  actions: ReadingAction[]
  draft: string
  running: boolean
  status: string
  configured: boolean
  onDraft(value: string): void
  onSubmit(question: string): void
  onAction(action: ReadingAction): void
  onCancel(): void
  onNew(): void
  onClose(): void
  onSettings(): void
  onOrigin(): void
  onCitation(fragment: Fragment): void
  onSave(message: Message): void
  onResize(height: number): void
}

export function AssistantPanel(props: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight
  }, [props.conversation, props.status])
  const conversation = props.conversation
  return (
    <aside className="assistant-panel" aria-label="阅读伙伴">
      <div
        className="panel-resize"
        role="separator"
        aria-label="调整回答面板高度"
        aria-orientation="horizontal"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') props.onResize(65)
          if (event.key === 'ArrowDown') props.onResize(40)
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            props.onResize(
              Math.max(
                30,
                Math.min(80, ((window.innerHeight - event.clientY) / window.innerHeight) * 100),
              ),
            )
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      >
        <span />
      </div>
      <div className="assistant-heading">
        <span className="assistant-symbol">
          <Sparkles size={19} />
        </span>
        <div>
          <strong>阅读伙伴</strong>
          <span>
            <i /> 让理解发生在原文旁
          </span>
        </div>
        <button
          className="icon-button"
          onClick={props.onSettings}
          title="模型设置"
          aria-label="模型设置"
        >
          <Settings2 size={17} />
        </button>
        <button
          className="icon-button"
          onClick={props.onNew}
          title="开始新话题"
          aria-label="开始新话题"
          disabled={props.running}
        >
          <MessageSquarePlus size={18} />
        </button>
        <button className="icon-button" onClick={props.onClose} aria-label="收起阅读伙伴">
          <X size={18} />
        </button>
      </div>
      <div
        className="assistant-content"
        ref={scroller}
        onScroll={() => {
          const element = scroller.current
          if (element)
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
        }}
      >
        {conversation ? (
          <>
            <button className="origin-button" onClick={props.onOrigin}>
              <ChevronLeft size={15} />
              回到提问位置 <span>{conversation.snapshot.chapter}</span>
            </button>
            {conversation.snapshot.selection && (
              <div className="context-quote">
                <span>当时的选文</span>
                <blockquote>{conversation.snapshot.selection.slice(0, 500)}</blockquote>
              </div>
            )}
            <div className="messages">
              {conversation.messages.map((message) => (
                <div key={message.id} className={`message message-${message.role}`}>
                  {message.role === 'user' ? (
                    <p>{message.content}</p>
                  ) : (
                    <>
                      <div className="response-label">
                        <Sparkles size={14} />
                        一起理解
                      </div>
                      <ModelActivity message={message} />
                      {message.content && (
                        <Answer
                          text={message.content}
                          evidence={conversation.evidence}
                          onCitation={props.onCitation}
                        />
                      )}
                      {message.status === 'cancelled' && (
                        <p className="small muted">已停止，以上内容可能不完整。</p>
                      )}
                      {message.status === 'error' && (
                        <p className="small form-error">
                          此次回答未完成，已有内容已保留。可以继续追问。
                        </p>
                      )}
                      {message.content && message.status && (
                        <button
                          className="text-button save-answer"
                          onClick={() => props.onSave(message)}
                        >
                          <NotebookPen size={14} />
                          保存为笔记
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            {props.running && (
              <div className="run-status" role="status">
                <span className="spinner" />
                {props.status}
              </div>
            )}
            {!!conversation.evidence.length && (
              <details className="evidence-list">
                <summary>
                  <BookOpen size={14} />
                  查看已提供的原文依据 <span>{conversation.evidence.length}</span>
                </summary>
                {conversation.evidence.map((fragment) => (
                  <button key={fragment.citationId} onClick={() => props.onCitation(fragment)}>
                    <strong>{fragment.label}</strong>
                    <p>{fragment.text.slice(0, 180)}</p>
                  </button>
                ))}
                <small>原文可核验不代表解释一定正确。</small>
              </details>
            )}
          </>
        ) : (
          <div className="assistant-welcome">
            <div className="welcome-mark">
              <Sparkles size={30} />
              <span className="welcome-dot" />
            </div>
            <h2>
              读到这里，
              <br />
              有什么想弄明白？
            </h2>
            <p>
              选一句有疑惑的原文，
              <br />
              或者直接问问当前这页。
            </p>
            <div className="welcome-example">
              <span>一个小问题，也很好</span>
              <p>
                “为什么这里要这样做？”
                <br />
                “可以换个例子解释吗？”
              </p>
            </div>
            {!props.configured && (
              <button className="button" onClick={props.onSettings}>
                <Settings2 size={16} />
                连接我的模型
              </button>
            )}
            <div className="welcome-privacy">
              <Check size={14} />
              由你发问时，才会发送内容
            </div>
          </div>
        )}
      </div>
      <div className="assistant-composer">
        {!conversation && props.selection && (
          <div className="selection-preview">
            <span>已选原文</span>
            <p>{props.selection.text.slice(0, 110)}</p>
          </div>
        )}
        <div className="quick-actions">
          {props.actions
            .filter((action) =>
              action.appliesTo.includes(props.selection ? 'selection' : 'viewport'),
            )
            .slice(0, 6)
            .map((action) => (
              <button
                key={action.id}
                onClick={() => props.onAction(action)}
                disabled={props.running}
              >
                {action.label}
              </button>
            ))}
        </div>
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            if (props.draft.trim() && !props.running) {
              follow.current = true
              props.onSubmit(props.draft.trim())
            }
          }}
        >
          <textarea
            aria-label="向阅读伙伴提问"
            placeholder={conversation ? '继续追问，让理解再近一步…' : '关于这段内容，我想问…'}
            rows={2}
            maxLength={4000}
            value={props.draft}
            onChange={(event) => props.onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (props.draft.trim() && !props.running) {
                  follow.current = true
                  props.onSubmit(props.draft.trim())
                }
              }
            }}
          />
          <div className="composer-footer">
            <span>
              <BookOpen size={13} />
              {conversation
                ? '围绕原问题继续'
                : props.selection
                  ? '围绕选中原文'
                  : '围绕当前阅读区域'}
            </span>
            {props.running ? (
              <button
                type="button"
                className="send-button stop-button"
                onClick={props.onCancel}
                aria-label="停止回答"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={!props.draft.trim()}
                aria-label="发送问题"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        </form>
        <p className="composer-disclaimer">解释供理解参考，重要信息请回到原文核对。</p>
      </div>
      <div className="mobile-panel-size">
        <ArrowUp size={12} />
        <button onClick={() => props.onResize(65)}>展开</button>
        <button onClick={() => props.onResize(40)}>缩小</button>
        <ArrowDown size={12} />
      </div>
    </aside>
  )
}
