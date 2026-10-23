import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { FileChange } from '../../shared/types.js'
import type { Tracker } from '../tools/types.js'

function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

export class FileTracker implements Tracker {
  private readonly readSet = new Set<string>()
  private readonly changeMap = new Map<string, FileChange>()
  private readonly base: string

  constructor(base: string) {
    this.base = base
  }

  markRead(file: string): void {
    this.readSet.add(path.resolve(file).toLowerCase())
  }

  hasRead(file: string): boolean {
    return this.readSet.has(path.resolve(file).toLowerCase())
  }

  recordChange(file: string, before: string | null, after: string | null): void {
    const absolute = path.resolve(file)
    const relative = path.relative(this.base, absolute).replace(/\\/g, '/') || path.basename(absolute)
    const oldText = before ?? ''
    const newText = after ?? ''
    const patch = createTwoFilesPatch(
      `a/${relative}`,
      `b/${relative}`,
      before === null ? '' : oldText,
      after === null ? '' : newText,
      '',
      '',
      { context: 3 }
    )
    const { additions, deletions } = countLines(patch)
    this.changeMap.set(relative, {
      path: relative,
      status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
      additions,
      deletions,
      diff: patch
    })
  }

  changes(): FileChange[] {
    return [...this.changeMap.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Restores the change list from a persisted session (after app restart). */
  restore(changes: FileChange[]): void {
    for (const change of changes) {
      if (change?.path) this.changeMap.set(change.path, change)
    }
  }

  readFiles(): string[] {
    return [...this.readSet]
  }
}

