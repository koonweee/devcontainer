import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runCheck(mode: 'reuse' | 'migration'): string {
  return execFileSync('npx', ['tsx', 'src/testing/sqlite-repositories-check.ts', mode], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

describe('SQLite repositories schema behavior', () => {
  it('allows reusing a box name after removal', () => {
    const output = runCheck('reuse');
    expect(output).toContain('ok');
  });

  it('migrates legacy global-unique name schema to active-only uniqueness', () => {
    const output = runCheck('migration');
    expect(output).toContain('ok');
  });
});
