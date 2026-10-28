/**
 * "Is this answer the tunnel (or the gateway in front of it) telling us nobody is home?" A Cloudflare quick tunnel that
 * lost its notebook does not answer with JSON: it answers an HTML page. Measured on the real service (cloudflared 2026.10.5):
 *
 *   tunnel process gone ......... HTTP 530, "Cloudflare Tunnel error" / "Error 1033" (stays like this; it never recovers)
 *   tunnel up, server stopped ... HTTP 502, "trycloudflare.com | 502: Bad gateway" / "Error code 502"
 *   name that never existed ..... no HTTP at all: DNS says ENOTFOUND
 *
 * To the reserve all of them mean the same: this provider cannot answer, move on (kind `network`, account level, so every
 * model of the provider is skipped, not just the one that failed).
 */

const HTML = /<!doctype html|<html[\s>]/i
const TUNNEL_PAGE = /cloudflare tunnel error|error 1033|argo tunnel/i

export function isTunnelDownResponse(status: number | undefined, body: string): boolean {
  // 530 is Cloudflare's own status for "the origin behind this tunnel cannot be reached".
  if (status === 530) return true
  if (!body || !HTML.test(body)) return false
  if (TUNNEL_PAGE.test(body)) return true
  // A gateway page of the quick-tunnel domain (origin stopped: 502; also 404/5xx variants Cloudflare uses).
  return /trycloudflare\.com/i.test(body) && (status === undefined || status === 404 || status >= 500)
}

/** Words for the user when a request ended in a tunnel-down page. */
export const TUNNEL_DOWN_MESSAGE =
  'O túnel do Google Colab não respondeu: a sessão do Colab provavelmente terminou (ou o notebook parou). Rode o notebook de novo e cole o novo código de conexão.'
