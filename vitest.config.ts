import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // The suite starts local HTTP servers and one short-lived stdio child
    // process; running files serially keeps ports/PIDs deterministic.
    fileParallelism: false
  }
})
