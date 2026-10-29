/**
 * Public shapes of the Git service. Plain data only, so the IPC layer can pass
 * them straight to the renderer (structured clone).
 */

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechange'

export interface GitFileEntry {
  /** Relative to the repository root, forward slashes. */
  path: string
  /** Previous path for renamed/copied entries. */
  oldPath?: string
  status: GitFileState
  /** Has changes in the index (will be part of the next commit). */
  staged: boolean
  /** Has changes in the working tree that are not staged (includes untracked). */
  unstaged: boolean
  /** Lines added, staged + unstaged combined. Unknown for untracked files. */
  additions?: number
  /** Lines removed, staged + unstaged combined. Unknown for untracked files. */
  deletions?: number
  binary?: boolean
}

export interface GitStatus {
  isRepo: boolean
  /** Absolute repository root (native separators). */
  root?: string
  /** Current branch; undefined while detached. */
  branch?: string
  detached?: boolean
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileEntry[]
  /** The status output was cut because it was too large; `files` is partial. */
  truncated?: boolean
  /** Set when `isRepo` is false for a reason other than "not a repository". */
  error?: string
}

export interface GitFileDiffOptions {
  /** Diff the index against HEAD instead of the working tree against the index. */
  staged?: boolean
  /** Previous path of a renamed file, so a staged rename is shown as a rename. */
  oldPath?: string
}

export interface GitFileDiff {
  /** Path relative to the repository root, forward slashes. */
  path: string
  staged: boolean
  /** The file is not tracked and was diffed against /dev/null as a new file. */
  untracked: boolean
  /** Unified diff text; empty when there are no differences. */
  diff: string
  /** The diff exceeded the size cap and was cut at a line boundary. */
  truncated: boolean
  binary: boolean
}

export interface WorktreeInfo {
  /** Absolute path (native separators). */
  path: string
  /** HEAD commit id. */
  head?: string
  /** Short branch name; undefined when detached or bare. */
  branch?: string
  bare: boolean
  detached: boolean
  locked: boolean
  lockReason?: string
  /** The checkout directory is gone and `git worktree prune` would drop it. */
  prunable: boolean
  prunableReason?: string
  /** The repository's main worktree (the first entry git lists). */
  isMain: boolean
}

export interface CreateWorktreeOptions {
  /** New branch to create and check out in the worktree. */
  branch: string
  /** Commit-ish the new branch starts from. Defaults to HEAD. */
  baseRef?: string
  /**
   * Where to create the worktree. Relative paths resolve against the main
   * worktree. Defaults to `<repoRoot>/.openclod/worktrees/<safe-branch-name>`.
   */
  dir?: string
}

export interface RemoveWorktreeOptions {
  /** Remove even when the worktree has uncommitted changes. */
  force?: boolean
}
