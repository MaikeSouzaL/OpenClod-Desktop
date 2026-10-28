export interface Slide {
  id: string
  title: string
  body: string
  accent: string
  background: string
  x: number
  y: number
  width: number
  height: number
}

export interface SlideDocument {
  version: 1
  title: string
  slides: Slide[]
}

const SLIDE_WIDTH = 960
const SLIDE_HEIGHT = 540

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

export function newSlide(index = 1): Slide {
  return {
    id: `slide-${Date.now().toString(36)}-${index}`,
    title: 'Novo slide',
    body: 'Clique e edite o conteúdo.',
    accent: '#d8b36e',
    background: '#17191e',
    x: 64,
    y: 92,
    width: 640,
    height: 300
  }
}

export function createSlideDocument(): SlideDocument {
  return { version: 1, title: 'Nova apresentação', slides: [newSlide()] }
}

export function parseSlideDocument(source: string): SlideDocument | null {
  try {
    const parsed = JSON.parse(source) as { version?: unknown; title?: unknown; slides?: unknown }
    if (parsed?.version !== 1 || !Array.isArray(parsed.slides)) return null
    const slides = (parsed.slides as unknown[])
      .filter((slide): slide is Partial<Slide> => Boolean(slide) && typeof slide === 'object')
      .map((slide, index) => ({
        id: typeof slide.id === 'string' && slide.id ? slide.id : `slide-${index + 1}`,
        title: typeof slide.title === 'string' ? slide.title : 'Sem título',
        body: typeof slide.body === 'string' ? slide.body : '',
        accent: color(slide.accent, '#d8b36e'),
        background: color(slide.background, '#17191e'),
        x: clamp(slide.x, 0, SLIDE_WIDTH - 40, 64),
        y: clamp(slide.y, 0, SLIDE_HEIGHT - 40, 92),
        width: clamp(slide.width, 40, SLIDE_WIDTH, 640),
        height: clamp(slide.height, 40, SLIDE_HEIGHT, 300)
      }))
    return {
      version: 1,
      title: typeof parsed.title === 'string' ? parsed.title : 'Apresentação',
      slides
    }
  } catch {
    return null
  }
}

export function updateSlide(document: SlideDocument, index: number, patch: Partial<Slide>): SlideDocument {
  if (!document.slides[index]) return document
  return {
    ...document,
    slides: document.slides.map((slide, current) => (current === index ? { ...slide, ...patch, id: slide.id } : slide))
  }
}

export function duplicateSlide(document: SlideDocument, index: number): { document: SlideDocument; index: number } {
  const slide = document.slides[index]
  if (!slide) return { document, index }
  const copy = {
    ...slide,
    id: `${slide.id}-copy-${Date.now().toString(36)}`,
    title: `${slide.title} (cópia)`,
    x: Math.min(SLIDE_WIDTH - slide.width, slide.x + 24),
    y: Math.min(SLIDE_HEIGHT - slide.height, slide.y + 24)
  }
  const slides = [...document.slides]
  slides.splice(index + 1, 0, copy)
  return { document: { ...document, slides }, index: index + 1 }
}

export function moveSlide(document: SlideDocument, index: number, delta: number): { document: SlideDocument; index: number } {
  const target = index + delta
  if (!document.slides[index] || target < 0 || target >= document.slides.length) return { document, index }
  const slides = [...document.slides]
  const [slide] = slides.splice(index, 1)
  slides.splice(target, 0, slide!)
  return { document: { ...document, slides }, index: target }
}

export function removeSlide(document: SlideDocument, index: number): { document: SlideDocument; index: number } {
  if (document.slides.length <= 1 || !document.slides[index]) return { document, index }
  return {
    document: { ...document, slides: document.slides.filter((_, current) => current !== index) },
    index: Math.max(0, Math.min(index, document.slides.length - 2))
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Standalone presentation. Text is escaped; no user text is interpreted as HTML. */
export function slidesToHtml(document: SlideDocument): string {
  const slides = document.slides
    .map(
      (slide, index) => `<section class="slide ${index === 0 ? 'active' : ''}" style="--accent:${slide.accent};--bg:${slide.background}">
  <div class="object" style="left:${(slide.x / SLIDE_WIDTH) * 100}%;top:${(slide.y / SLIDE_HEIGHT) * 100}%;width:${(slide.width / SLIDE_WIDTH) * 100}%;height:${(slide.height / SLIDE_HEIGHT) * 100}%">
    <h1>${escapeHtml(slide.title)}</h1><div class="body">${escapeHtml(slide.body).replace(/\n/g, '<br>')}</div>
  </div>
</section>`
    )
    .join('\n')
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(document.title)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0c0e;color:#f5f1e8;font:16px system-ui,sans-serif}
main{position:relative;width:100%;height:100%}.slide{position:absolute;inset:0;display:none;background:var(--bg);overflow:hidden}.slide.active{display:block}
.object{position:absolute;padding:24px 28px;border-left:5px solid var(--accent);display:flex;flex-direction:column;justify-content:center;gap:18px}
.object h1{margin:0;font:600 clamp(28px,4.2vw,64px)/1.05 Georgia,serif;color:#fff}.body{font-size:clamp(15px,1.7vw,26px);line-height:1.45;color:#d7d1c5;white-space:normal}
nav{position:fixed;right:18px;bottom:16px;display:flex;gap:8px;align-items:center;background:#111b;padding:8px 10px;border-radius:999px;z-index:2}button{border:0;border-radius:8px;padding:8px 12px;background:#fff2;color:#fff;cursor:pointer}#count{min-width:56px;text-align:center;opacity:.7}
</style></head><body><main>${slides}</main><nav><button data-step="-1" aria-label="Anterior">←</button><span id="count">1 / ${document.slides.length}</span><button data-step="1" aria-label="Próximo">→</button></nav>
<script>const s=[...document.querySelectorAll('.slide')];let i=0;const show=n=>{i=(n+s.length)%s.length;s.forEach((x,j)=>x.classList.toggle('active',j===i));document.querySelector('#count').textContent=(i+1)+' / '+s.length};document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>show(i+Number(b.dataset.step)));addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1)});</script>
</body></html>`
}
