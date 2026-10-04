import { defineConfig } from 'vitest/config'

// The Harness seam packages resolve from node_modules, pinned to the dsh
// release this plugin targets (see `package.json`). Tests therefore exercise
// the same published API surface the host actually loads — no local
// deepseek-harness checkout required.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
