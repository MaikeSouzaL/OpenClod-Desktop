import { useMemo, type ReactElement } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ gfm: true, breaks: true })

interface MarkdownProps {
  text: string
  className?: string
}

/**
 * Model output is untrusted. `marked` produces HTML and DOMPurify strips
 * scripts, event handlers and dangerous URLs before it touches the DOM.
 */
export function Markdown({ text, className }: MarkdownProps): ReactElement {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false })
    return DOMPurify.sanitize(rendered as string, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload']
    })
  }, [text])

  return <div className={`markdown ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
