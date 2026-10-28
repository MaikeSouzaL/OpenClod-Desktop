import fs from 'node:fs'
import { resourcePath } from '../util/resources.js'
import { normalizeServerSource, serverSourceHash } from './notebook.js'

/** The notebook's server module as shipped with the app (`resources/colab/`, copied into the installer by extraResources). */
export function colabServerPath(): string | null {
  return resourcePath('colab', 'openclod_llm_server.py')
}

export function readColabServerSource(): string {
  const file = colabServerPath()
  if (!file) throw new Error('o servidor do notebook do Colab não está nos recursos do app (resources/colab/openclod_llm_server.py)')
  return normalizeServerSource(fs.readFileSync(file, 'utf8'))
}

/** The `sh` a notebook made by this build puts in its connection codes. */
export function colabServerHash(): string | null {
  try {
    return serverSourceHash(readColabServerSource())
  } catch {
    return null
  }
}
