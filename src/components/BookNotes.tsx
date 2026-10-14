import { Highlighter, NotebookPen, Trash2, X } from 'lucide-react'
import type { Annotation, ReadingPoint } from '../core/types'

export function BookNotes({
  annotations,
  onLocate,
  onClose,
}: {
  annotations: Annotation[]
  onLocate(annotation: Annotation): void
  onClose(): void
}) {
  return (
    <aside className="book-notes-panel" aria-label="本书标注">
      <div className="book-notes-heading">
        <h2>
          本书标注 <small>{annotations.length}</small>
        </h2>
        <button className="icon-button" aria-label="收起本书标注" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <p className="muted small">点击标注回到原文，在书中查看或修改。</p>
      <div className="book-notes-list">
        {[...annotations]
          .sort(
            (a, b) =>
              a.locator.sectionIndex - b.locator.sectionIndex ||
              a.locator.endOffset - b.locator.endOffset,
          )
          .map((annotation) => (
            <button key={annotation.id} onClick={() => onLocate(annotation)}>
              <span>
                {annotation.kind === 'note'
                  ? '笔记'
                  : annotation.kind === 'highlight'
                    ? '高亮'
                    : '书签'}{' '}
                · {annotation.chapter}
              </span>
              <blockquote>{annotation.text.slice(0, 180)}</blockquote>
              {annotation.note && <p>{annotation.note.slice(0, 180)}</p>}
            </button>
          ))}
        {!annotations.length && <p className="muted">选中原文即可高亮或记笔记。</p>}
      </div>
    </aside>
  )
}

export function PassageNotes({
  point,
  annotations,
  onHighlight,
  onEdit,
  onRemove,
  onClose,
}: {
  point: ReadingPoint
  annotations: Annotation[]
  onHighlight(): void
  onEdit(annotation?: Annotation): void
  onRemove(annotation: Annotation): void
  onClose(): void
}) {
  const highlights = annotations.filter((item) => item.kind === 'highlight')
  const notes = annotations.filter((item) => item.kind === 'note')
  return (
    <aside className="passage-notes" aria-label="原文标注">
      <div className="book-notes-heading">
        <h2>原文标注</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭原文标注">
          <X size={17} />
        </button>
      </div>
      <blockquote>{point.text.slice(0, 300)}</blockquote>
      {notes.map((note) => (
        <div className="passage-note" key={note.id}>
          <p>{note.note}</p>
          <div>
            <button className="text-button" onClick={() => onEdit(note)}>
              编辑笔记
            </button>
            <button className="text-button" onClick={() => onRemove(note)}>
              <Trash2 size={13} />
              删除笔记
            </button>
          </div>
        </div>
      ))}
      <div className="passage-actions">
        <button className="button" onClick={onHighlight}>
          <Highlighter size={15} />
          {highlights.length ? '取消高亮' : '高亮'}
        </button>
        <button className="button" onClick={() => onEdit(notes[0])}>
          <NotebookPen size={15} />
          {notes.length ? '修改笔记' : '写笔记'}
        </button>
      </div>
    </aside>
  )
}
