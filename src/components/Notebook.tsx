import { Bookmark, Download, Highlighter, MessageSquare, NotebookPen, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Annotation, BookRecord, Conversation } from '../core/types'

export function Notebook({
  annotations,
  conversations,
  books,
  onLocate,
  onRemove,
  onConversation,
  onExport,
}: {
  annotations: Annotation[]
  conversations: Conversation[]
  books: BookRecord[]
  onLocate(annotation: Annotation): void
  onRemove(annotation: Annotation): void
  onConversation(conversation: Conversation): void
  onExport(): void
}) {
  const [tab, setTab] = useState<'notes' | 'conversations'>('notes')
  return (
    <div className="content-page">
      <div className="page-eyebrow">
        <span className="tiny-dot" /> 留下理解发生的地方
      </div>
      <div className="page-title-row">
        <div>
          <h1>阅读笔记</h1>
          <p className="page-description">那些值得再看一眼的句子，和你自己的思考。</p>
        </div>
        <button className="button" onClick={onExport}>
          <Download size={17} />
          导出 Markdown
        </button>
      </div>
      <div className="shelf-tabs notebook-tabs">
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          标注与笔记 <span>{annotations.length}</span>
        </button>
        <button
          className={tab === 'conversations' ? 'active' : ''}
          onClick={() => setTab('conversations')}
        >
          阅读问答 <span>{conversations.length}</span>
        </button>
      </div>
      {tab === 'notes' && (
        <div className="note-list">
          {[...annotations]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((annotation) => (
              <article className="note-card" key={annotation.id}>
                <div className="note-card-meta">
                  <span>
                    {annotation.kind === 'bookmark' ? (
                      <Bookmark size={16} />
                    ) : annotation.kind === 'highlight' ? (
                      <Highlighter size={16} />
                    ) : (
                      <NotebookPen size={16} />
                    )}
                    {books.find((book) => book.id === annotation.bookId)?.title ?? '未导入的书籍'}{' '}
                    <span className="separator">/</span> {annotation.chapter}
                  </span>
                  <button
                    className="icon-button"
                    onClick={() => onRemove(annotation)}
                    aria-label="删除这条标注"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <blockquote>{annotation.text}</blockquote>
                {annotation.note && <p className="note-body">{annotation.note}</p>}
                <button className="text-button" onClick={() => onLocate(annotation)}>
                  回到原文 <span>↗</span>
                </button>
              </article>
            ))}
        </div>
      )}
      {tab === 'conversations' && (
        <div className="note-list">
          {[...conversations]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((conversation) => (
              <button
                className="conversation-card"
                key={conversation.id}
                onClick={() => onConversation(conversation)}
              >
                <MessageSquare size={20} />
                <div>
                  <span className="small muted">
                    {conversation.snapshot.bookTitle} · {conversation.snapshot.chapter}
                  </span>
                  <h3>
                    {conversation.messages.find((m) => m.role === 'user')?.content ?? '阅读问答'}
                  </h3>
                  <p>
                    {conversation.messages
                      .find((m) => m.role === 'assistant')
                      ?.content.slice(0, 130)}
                  </p>
                </div>
                <span>↗</span>
              </button>
            ))}
        </div>
      )}
      {!(tab === 'notes' ? annotations.length : conversations.length) && (
        <div className="empty-state">
          <NotebookPen size={30} />
          <h3>{tab === 'notes' ? '把值得留下的，记在这里' : '从一个小问题开始'}</h3>
          <p>
            {tab === 'notes'
              ? '阅读时选中文字，即可高亮或写下自己的笔记。'
              : '在书页旁提问，问答会自动保存在本机。'}
          </p>
        </div>
      )}
    </div>
  )
}
