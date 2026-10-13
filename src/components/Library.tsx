import { ArrowUpRight, BookOpen, Plus, Search, Sparkles, Upload } from 'lucide-react'
import { useState } from 'react'
import type { BookRecord } from '../core/types'

export function BookCover({ book, large = false }: { book: BookRecord; large?: boolean }) {
  return (
    <div
      className={`book-cover cover-${book.coverTone} ${large ? 'cover-large' : ''}`}
      aria-hidden="true"
    >
      <span className="cover-edition">READWEAVE EDITIONS</span>
      <span className="cover-title">{book.title}</span>
      <span className="cover-line" />
      <span className="cover-author">{book.author}</span>
      <div className="cover-orbit orbit-one" />
      <div className="cover-orbit orbit-two" />
      <span className="cover-symbol">rw.</span>
    </div>
  )
}

export function Library({
  books,
  loading,
  onOpen,
  onImport,
}: {
  books: BookRecord[]
  loading: string
  onOpen(book: BookRecord): void
  onImport(): void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'reading'>('all')
  const sorted = [...books].sort((a, b) =>
    (b.lastOpenedAt ?? b.addedAt).localeCompare(a.lastOpenedAt ?? a.addedAt),
  )
  const recent =
    sorted.find((book) => book.lastOpenedAt) ??
    sorted.find((book) => book.fileName === 'understanding.epub') ??
    sorted[0]
  const visible = sorted.filter(
    (book) =>
      (!query || `${book.title} ${book.author}`.toLowerCase().includes(query.toLowerCase())) &&
      (filter === 'all' || book.lastOpenedAt),
  )
  return (
    <div className="library-page">
      <div className="page-eyebrow">
        <span className="tiny-dot" /> 你的私人阅读空间
      </div>
      <div className="page-title-row">
        <div>
          <h1>让好奇心，留在书页之间。</h1>
          <p className="page-description">读到不懂的地方，停一下。理解之后，继续向前。</p>
        </div>
        <button className="button primary" onClick={onImport}>
          <Plus size={18} /> 导入书籍
        </button>
      </div>
      {recent && (
        <section className="continue-card" aria-label="继续阅读">
          <div className="continue-copy">
            <span className="section-eyebrow">
              {recent.lastOpenedAt ? '接着上次的思绪' : '从这里，翻开第一页'}
            </span>
            <h2>{recent.title}</h2>
            <p>
              {recent.author} <span className="separator">/</span>{' '}
              {recent.isSample ? '原创示例 · 离线可读' : '你的 EPUB 藏书'}
            </p>
            <div className="continue-progress">
              <span style={{ width: `${Math.max(2, (recent.position?.progress ?? 0) * 100)}%` }} />
            </div>
            <span className="progress-caption">
              {recent.position
                ? `已读 ${Math.round(recent.position.progress * 100)}% · 阅读位置已保存`
                : '一本书，一个问题，一条理解的线索'}
            </span>
            <button className="button primary" onClick={() => onOpen(recent)}>
              <BookOpen size={17} />
              {recent.lastOpenedAt ? '继续阅读' : '开始阅读'}
              <ArrowUpRight size={16} />
            </button>
          </div>
          <div className="continue-art">
            <span className="art-caption">
              A LITTLE CURIOSITY,
              <br />A DEEPER UNDERSTANDING.
            </span>
            <BookCover book={recent} large />
            <div className="art-circle" />
          </div>
        </section>
      )}
      <div className="shelf-toolbar">
        <div className="shelf-tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            全部书籍 <span>{books.length}</span>
          </button>
          <button
            className={filter === 'reading' ? 'active' : ''}
            onClick={() => setFilter('reading')}
          >
            正在阅读 <span>{books.filter((book) => book.lastOpenedAt).length}</span>
          </button>
        </div>
        <label className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索书架"
            placeholder="搜索书名、作者"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {loading ? (
        <div className="loading-state" role="status">
          <span className="spinner" />
          {loading}
        </div>
      ) : (
        <div className="book-grid">
          {visible.map((book) => (
            <button className="book-card" key={book.id} onClick={() => onOpen(book)}>
              <BookCover book={book} />
              <div className="book-card-info">
                <h3>{book.title}</h3>
                <p>{book.author}</p>
                <div className="book-meta">
                  <span>{book.isSample ? '示例书' : 'EPUB'}</span>
                  <span>
                    {book.position
                      ? `已读 ${Math.round(book.position.progress * 100)}%`
                      : '尚未开始'}
                  </span>
                </div>
              </div>
            </button>
          ))}
          {!query && filter === 'all' && (
            <button className="import-card" onClick={onImport}>
              <span>
                <Upload size={25} />
              </span>
              <strong>下一本想读的书</strong>
              <p>
                导入你的 EPUB
                <br />
                让新的理解从这里开始
              </p>
              <small>无 DRM · 可重排 · 最大 32 MB</small>
            </button>
          )}
        </div>
      )}
      {!visible.length && !loading && (
        <div className="empty-state">
          <Search size={26} />
          <h3>{query ? '还没有找到这本书' : '还没有正在读的书'}</h3>
          <p>{query ? '试试别的书名或作者。' : '从书架上选一本，开始阅读吧。'}</p>
        </div>
      )}
      <aside className="quiet-tip">
        <span className="tip-icon">
          <Sparkles size={20} />
        </span>
        <div>
          <strong>理解，不必离开阅读。</strong>
          <p>选中原文，再问一个问题。解释、依据与笔记，都留在你正在读的书旁。</p>
        </div>
        <span className="tip-label">由你发起 · 按需展开</span>
      </aside>
    </div>
  )
}
