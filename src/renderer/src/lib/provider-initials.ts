/** "Google Colab" -> "GC", "Anthropic" -> "A", "LM Studio (local)" -> "LS": as iniciais de quem ainda não tem marca no app. */
export function providerInitials(label: string): string {
  const words = label
    .replace(/\(.*?\)/g, ' ')
    .split(/[\s/_-]+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [words[0]?.[0] ?? '?']
  return letters.join('').toUpperCase()
}
