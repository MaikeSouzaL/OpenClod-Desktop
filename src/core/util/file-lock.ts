import path from 'node:path'

/**
 * Serializes read-modify-write cycles on the same file. Sessions, sub-agents and
 * parallel tool calls all run in one process, so a plain promise chain per path
 * is enough: without it two `edit_file` calls on one file both read the old text
 * and the second write silently drops the first edit.
 */
const tails = new Map<string, Promise<void>>()

function keyOf(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = keyOf(file)
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  tails.set(key, tail)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
