/**
 * Text assembly for dictation. Keeps the user's own text apart from the
 * dictated text, so a partial result can be replaced as the recognizer
 * improves without touching what the user typed.
 *
 * Pure TypeScript (no DOM, no Electron), so it can be tested in Node.
 */
export class Dictation {
  private base = ''
  private finals = ''
  private partial = ''

  /** `current` is the composer text when dictation begins. */
  constructor(current: string) {
    this.base = current
  }

  private join(left: string, right: string): string {
    if (!left) return right
    if (!right) return left
    return /\s$/.test(left) ? `${left}${right}` : `${left} ${right}`
  }

  /** The text the composer should show right now. */
  get text(): string {
    return this.join(this.join(this.base, this.finals), this.partial)
  }

  setPartial(text: string): string {
    this.partial = text.trim()
    return this.text
  }

  addFinal(text: string): string {
    const clean = text.trim()
    this.partial = ''
    if (clean) this.finals = this.join(this.finals, clean)
    return this.text
  }

  /** The user edited the box by hand: what is there now becomes the new base. */
  rebase(current: string): void {
    this.base = current
    this.finals = ''
    this.partial = ''
  }

  /** True when `current` is not what dictation last wrote (the user typed or deleted). */
  diverged(current: string): boolean {
    return current !== this.text
  }
}
