/**
 * Deletion protection for shell commands. Cowork asks before permanently deleting files in every mode; `delete_path` is
 * `destructive` and already asks, but a model can also delete with the shell (`del`, `rm`, `Remove-Item`, a Python one-liner).
 * Those commands are classified as destructive too, so the automatic and accept-edits modes ask for them like for delete_path.
 *
 * A heuristic on the command text, not a parser: it favours asking (a false positive costs one click) and cannot see a
 * deletion hidden in a script file the command merely runs. The unrestricted mode, which the user chooses explicitly,
 * is not affected.
 */

// A deleting verb used as a command word: at the start, or after whitespace, a separator or a quote.
const VERB = /(?:^|[\s;&|(`"'])(?:del|erase|rd|rmdir|rm|unlink|shred|remove-item|ri)(?=$|[\s;&|)`"'])/i

const PATTERNS: RegExp[] = [
  VERB,
  /\bgit\s+clean\b/i,
  // Python and Node one-liners.
  /\bshutil\s*\.\s*rmtree\b/i,
  /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\b/i,
  /\.(?:unlink|rmSync|unlinkSync|rmdirSync)\s*\(/i,
  /\bfs\s*\.\s*(?:promises\s*\.\s*)?(?:rm|unlink|rmdir)\s*\(/i,
  /\brimraf\b/i,
  /\bsend2trash\b/i,
  // PowerShell / .NET (including the Recycle Bin routes) and mirror copies that purge the destination.
  /\]\s*::\s*Delete(?:File|Directory)?\b/i,
  /\bFileSystem\s*\.\s*Delete(?:File|Directory)\b/i,
  /\bSendToRecycleBin\b/i,
  /\.InvokeVerb\s*\(\s*['"]delete['"]/i,
  /\bSHFileOperation\b/i,
  /\brobocopy\b[^\n]*\s\/(?:mir|purge)\b/i
]

export function commandDeletesFiles(command: string): boolean {
  if (!command) return false
  return PATTERNS.some((pattern) => pattern.test(command))
}
