import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/orchestrator/vitest.config.ts',
  'apps/api/vitest.config.ts'
]);
