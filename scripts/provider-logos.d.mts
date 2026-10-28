// Tipos de scripts/provider-logos.mjs (para os testes em TypeScript).
export interface BuiltMark {
  viewBox: string
  path: string
  fillRule?: 'evenodd'
  color?: string
  from: string
}
export const FROM_SIMPLE_ICONS: Record<string, { slug: string; colored?: boolean }>
export const OPENAI_PATH: string
export function buildMarks(): { marks: Record<string, BuiltMark>; version: string }
export function render(built: { marks: Record<string, BuiltMark>; version: string }): string
