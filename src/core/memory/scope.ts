import type { SessionMeta } from '../../shared/types.js'

/**
 * The key that scopes a session's long-term memory (the per-project json, the markdown wiki folder and the AI-Memory
 * sidecar all hang off it).
 *
 * Code and cowork sessions share the PROJECT's memory: every session working in a real project folder sees the same
 * wiki, which is the whole point of project memory. Chat sessions on Início have no project of their own — they fall
 * back to a shared default project, which made unrelated chats bleed into each other. So each chat gets its OWN memory,
 * keyed by its session id: isolated from every other chat and stable across resumes of that same chat.
 */
export function memoryScopeId(meta: Pick<SessionMeta, 'surface' | 'projectId' | 'id'>): string {
  return meta.surface === 'chat' ? `chat-${meta.id}` : meta.projectId
}
