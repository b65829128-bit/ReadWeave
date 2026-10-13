import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Fragment } from '../core/types'
import { verifiedCitations } from '../core/tools'

export default function RenderedAnswer({
  text,
  evidence,
  onCitation,
}: {
  text: string
  evidence: Fragment[]
  onCitation(fragment: Fragment): void
}) {
  return (
    <div className="answer-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [
            rehypeKatex,
            { trust: false, maxExpand: 100, maxSize: 10, throwOnError: false, strict: 'error' },
          ],
        ]}
        urlTransform={(url) => (url.startsWith('readweave:') ? url : defaultUrlTransform(url))}
        components={{
          img: () => <span className="muted">[远程图片未加载]</span>,
          a: ({ href, children }) => {
            if (href?.startsWith('readweave:')) {
              const citation = evidence.find((fragment) => fragment.citationId === href.slice(10))
              return citation ? (
                <button className="citation" onClick={() => onCitation(citation)}>
                  {children}
                </button>
              ) : (
                <span className="muted">[引用未核验]</span>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            )
          },
        }}
      >
        {verifiedCitations(text, evidence)}
      </Markdown>
    </div>
  )
}
