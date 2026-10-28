import { memo, useMemo, useRef, type MouseEvent, type ReactElement } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { DrawingBlock } from './DrawingBlock'
import { splitDrawings } from '../lib/drawings'

marked.setOptions({ gfm: true, breaks: true })

const renderer = new marked.Renderer()

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// A fenced code block is often a ready-to-send message (e.g. a reply drafted
// for a client). Wrap it so every block gets its own copy button.
renderer.code = ({ text, lang }) => {
  const language = (lang ?? '')
    .trim()
    .split(/\s+/)[0]
    .replace(/[^\w+#.-]/g, '')
  const cls = language ? ` class="language-${language}"` : ''
  return (
    `<div class="code-block"><pre><code${cls}>${escapeHtml(text)}</code></pre>` +
    '<button type="button" class="code-copy" aria-label="Copiar este bloco">Copiar</button></div>'
  )
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

interface MarkdownProps {
  text: string
  className?: string
}

/**
 * Model output is untrusted. `marked` produces HTML and DOMPurify strips
 * scripts, event handlers and dangerous URLs before it touches the DOM.
 */
const MarkdownText = memo(function MarkdownText({ text, className }: MarkdownProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false, renderer })
    return DOMPurify.sanitize(rendered as string, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload']
    })
  }, [text])

  const onCopy = async (event: MouseEvent<HTMLDivElement>): Promise<void> => {
    const target = event.target as HTMLElement | null
    const button = target?.closest('.code-copy') as HTMLButtonElement | null
    if (!button || !ref.current?.contains(button)) return
    const code = button.closest('.code-block')?.querySelector('pre code')?.textContent ?? ''
    if (!code || !(await copyText(code))) return
    const label = button.textContent
    button.textContent = 'Copiado'
    button.classList.add('is-copied')
    setTimeout(() => {
      button.textContent = label ?? 'Copiar'
      button.classList.remove('is-copied')
    }, 1600)
  }

  return (
    <div
      ref={ref}
      className={`markdown ${className ?? ''}`}
      onClick={(event) => void onCopy(event)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})

/**
 * Prose is rendered as markdown; an SVG (or an HTML/canvas page) that the model wrote in a closed fenced block,
 * or bare in the text, is drawn on screen as a picture with a Code tab. Parts that did not change keep their DOM,
 * so a drawing does not flicker or restart while the rest of the answer is still streaming.
 */
export function Markdown({ text, className }: MarkdownProps): ReactElement {
  const segments = useMemo(() => (text.includes('<svg') || /```|~~~/.test(text) ? splitDrawings(text) : null), [text])
  if (!segments || !segments.some((segment) => segment.type === 'drawing')) return <MarkdownText text={text} className={className} />
  let prose = 0
  return (
    <div className={`markdown-with-drawings ${className ?? ''}`}>
      {segments.map((segment) =>
        segment.type === 'drawing' ? (
          <DrawingBlock key={`drawing-${segment.ordinal}`} kind={segment.kind} source={segment.source} />
        ) : (
          <MarkdownText key={`prose-${prose++}`} text={segment.text} className={className} />
        )
      )}
    </div>
  )
}
