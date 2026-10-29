import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PolicyConfig } from '../src/shared/types'

export async function makeTempDir(prefix = 'openclod-test-'): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

export function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    mode: 'ask',
    blockedCommands: [],
    allowedRoots: [],
    allowNetwork: true,
    allowComputerControl: false,
    shellTimeoutSec: 30,
    ...overrides
  }
}
