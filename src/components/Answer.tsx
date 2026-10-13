import { lazy, Suspense } from 'react'
import type { Fragment } from '../core/types'

const RenderedAnswer = lazy(() => import('./RenderedAnswer'))

export function Answer(props: {
  text: string
  evidence: Fragment[]
  onCitation(fragment: Fragment): void
}) {
  return (
    <Suspense fallback={<div className="answer-markdown">{props.text}</div>}>
      <RenderedAnswer {...props} />
    </Suspense>
  )
}
