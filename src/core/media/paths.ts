import path from 'node:path'
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from './ingest.js'

/**
 * Audio and video files named in what the USER typed or attached (the attachment block writes each path between
 * backticks). Nothing here reads tool output or web pages: a path a page mentions is not a request to process it.
 */
const EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].map((extension) => extension.slice(1)).join('|')
const WRAPPED = new RegExp(String.raw`(?:\x60([^\x60\r\n]+)\x60|"([^"\r\n]+)"|'([^'\r\n]+)')`, 'g')
// The drive letter must stand alone: "https://x/a.mp4" has an "s:/" in it that is not a drive.
const BARE = new RegExp(String.raw`(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^"'\x60<>|*?\r\n]*?\.(?:${EXTENSIONS})(?=$|[\s"'\x60),;:!?]|\.(?:\s|$))`, 'gi')

function isMediaPath(candidate: string): boolean {
  const trimmed = candidate.trim()
  if (!/^[A-Za-z]:[\\/]/.test(trimmed)) return false
  const extension = path.extname(trimmed).toLowerCase()
  return VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension)
}

/** Absolute Windows paths of audio/video files mentioned in `text`, in order, without duplicates (no existence check). */
export function findMediaPaths(text: string, limit = 3): string[] {
  const found: string[] = []
  const add = (candidate: string): void => {
    const value = candidate.trim().replace(/[.,;:!?]+$/, '')
    if (!isMediaPath(value)) return
    if (!found.some((item) => item.toLowerCase() === value.toLowerCase())) found.push(value)
  }
  for (const match of text.matchAll(WRAPPED)) add(match[1] ?? match[2] ?? match[3] ?? '')
  for (const match of text.matchAll(BARE)) {
    // A bare path that is already inside backticks or quotes was taken above.
    if (!found.some((item) => match[0].toLowerCase().includes(item.toLowerCase()))) add(match[0])
  }
  return found.slice(0, limit)
}
