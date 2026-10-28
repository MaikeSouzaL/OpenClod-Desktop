/**
 * Which bundled logo a connector shows. Pure and offline: the images were collected at development time by
 * scripts/connector-icons.mjs and ship inside the app (src/renderer/public/connector-icons/), so the screen never
 * asks a third party for a logo and works without a network. The lookup table is the generated connector-icon-index.ts.
 *
 * Order: the connector's own id → the domain of its directory entry → (connectors added by hand only) the host of its
 * endpoint → a well-known brand word in its name or host. No match means "no logo": the caller draws the initials.
 */
import { CONNECTOR_ICON_INDEX, type ConnectorIconIndex } from './connector-icon-index'

/** Folder of the images, relative to index.html (the build copies src/renderer/public/ next to it). */
export const CONNECTOR_ICON_BASE = 'connector-icons/'

export interface ConnectorIconTarget {
  /** Directory id, or the server name of a connector added by hand. */
  id: string
  name: string
  custom?: boolean
  /** Address shown for the connector (origin and path, no query). */
  endpoint?: string
  entry?: { iconDomain?: string }
}

/** Own keys only: an id such as "constructor" must not find something on Object.prototype. */
function lookup(table: Readonly<Record<string, string>>, key: string): string | null {
  return key && Object.hasOwn(table, key) ? table[key] : null
}

/** Lower-case host without `www.`, port or path; '' when the text is not a domain. */
export function normalizeIconDomain(raw: string | undefined): string {
  let text = String(raw ?? '').trim().toLowerCase()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      text = new URL(text).hostname
    } catch {
      return ''
    }
  } else {
    text = (text.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '')
  }
  text = text.replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(text) && text.includes('.') ? text : ''
}

/** Labels that say what a host is for, not whose it is: `mcp.mercadopago.com` belongs to mercadopago.com. */
const SERVICE_LABELS = new Set(['mcp', 'api', 'www', 'app', 'apps', 'server', 'remote', 'ai', 'gateway', 'backend', 'sse', 'beta', 'dev', 'prod'])

/** The host itself, then the host without its leading service labels (`mcp.`, `api.`...), while two labels remain. */
export function hostCandidates(endpoint: string | undefined): string[] {
  const host = normalizeIconDomain(endpoint)
  if (!host) return []
  const labels = host.split('.')
  const out = [host]
  while (labels.length > 2 && SERVICE_LABELS.has(labels[0])) {
    labels.shift()
    out.push(labels.join('.'))
  }
  return out
}

function foldWord(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Words of a connector's name (and the labels of its host) a brand could be written as: the whole name squashed
 * ("mercado-pago" → "mercadopago"), each word, each pair of neighbouring words ("google drive" → "googledrive"), then
 * the host labels. The first one the index knows wins, so the name outranks the host.
 */
export function brandWords(name: string, endpoint?: string): string[] {
  const words = foldWord(name).split(/[^a-z0-9]+/).filter(Boolean)
  const out = [words.join('')]
  out.push(...words)
  for (let index = 0; index + 1 < words.length; index++) out.push(words[index] + words[index + 1])
  const host = normalizeIconDomain(endpoint)
  if (host) {
    const labels = host.split('.').slice(0, -1).filter((label) => !SERVICE_LABELS.has(label))
    out.push(...labels.map((label) => label.replace(/[^a-z0-9]+/g, '')))
  }
  return [...new Set(out.filter(Boolean))]
}

/** File name (inside connector-icons/) of the logo of this connector, or null when there is none. */
export function connectorIconFile(target: ConnectorIconTarget, index: ConnectorIconIndex = CONNECTOR_ICON_INDEX): string | null {
  const own = lookup(index.byId, target.id)
  if (own) return own
  const domain = normalizeIconDomain(target.entry?.iconDomain)
  const byDomain = domain ? lookup(index.byDomain, domain) : null
  if (byDomain) return byDomain
  if (!target.custom && target.entry) return null
  for (const host of hostCandidates(target.endpoint)) {
    const found = lookup(index.byDomain, host)
    if (found) return found
  }
  for (const word of brandWords(target.name, target.endpoint)) {
    const found = lookup(index.byBrand, word)
    if (found) return found
  }
  return null
}

/** Relative URL of the logo (resolved by the browser against the page), or null. */
export function connectorIconUrl(target: ConnectorIconTarget, index: ConnectorIconIndex = CONNECTOR_ICON_INDEX): string | null {
  const file = connectorIconFile(target, index)
  return file ? `${CONNECTOR_ICON_BASE}${encodeURIComponent(file)}` : null
}

export type ConnectorIconView = { kind: 'image'; src: string } | { kind: 'initials' }

/**
 * What to draw: the logo, or the initials when there is no logo or this very image already failed to load
 * (`failedSrc`). A failure of an image the row no longer uses does not count, so a recycled row tries its new logo.
 */
export function connectorIconView(target: ConnectorIconTarget, failedSrc: string | null, index: ConnectorIconIndex = CONNECTOR_ICON_INDEX): ConnectorIconView {
  const src = connectorIconUrl(target, index)
  return src && src !== failedSrc ? { kind: 'image', src } : { kind: 'initials' }
}
