import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

function runCheck(mode: 'reuse' | 'migration-empty' | 'migration-gate'): string {
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

  it('rebuilds an empty legacy boxes table into the grouped-resource schema', () => {
    const output = runCheck('migration-empty');
    expect(output).toContain('ok');
  });

  it('fails startup when legacy box rows still exist during upgrade', () => {
    const output = runCheck('migration-gate');
    expect(output).toContain('ok');
  });
});
