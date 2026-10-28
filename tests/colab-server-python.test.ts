import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPython, runPython } from './support/colab-python'

/**
 * The notebook's server module is Python (resources/colab/openclod_llm_server.py, standard library only) and has its own
 * suite (tests/colab/test_openclod_llm_server.py, `unittest`): the auth and routes, SSE with early headers and pings when the
 * engine is slow, an error that arrives after the stream opened, the user pressing "stop", images and tools in the self-test,
 * the VRAM table, the downloader with resume and SHA-256, the connection code. This wrapper runs it with the rest of the suite.
 */
const python = findPython()

describe.skipIf(!python)('notebook server module (Python)', () => {
  it('passes its own test suite', () => {
    const result = runPython([path.join(__dirname, 'colab', 'test_openclod_llm_server.py')], { timeoutMs: 170_000 })
    const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n')
    expect(result.status, tail).toBe(0)
    expect(result.stderr).toMatch(/Ran \d+ tests/)
    expect(result.stderr).toMatch(/OK\s*$/)
  }, 180_000)
})
