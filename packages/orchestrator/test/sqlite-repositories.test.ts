import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runCheck(mode: 'reuse' | 'schema'): string {
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

  it('creates the single-container boxes schema without grouped runtime columns', () => {
    const output = runCheck('schema');
    expect(output).toContain('ok');
  });
});
