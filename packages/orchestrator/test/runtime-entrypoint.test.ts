import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));

function makeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o755 });
}

function prepareWorkspaceEntrypointHarness(): {
  root: string;
  scriptPath: string;
  logsDir: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devbox-workspace-entrypoint-'));
  const binDir = path.join(root, 'bin');
  const logsDir = path.join(root, 'logs');
  const sshdRunDir = path.join(root, 'run', 'sshd');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  makeExecutable(path.join(binDir, 'id'), '#!/bin/sh\nexit 0\n');
  makeExecutable(
    path.join(binDir, 'sshd'),
    `#!/bin/sh\necho "$@" >> "${path.join(logsDir, 'sshd.log')}"\nexit 0\n`
  );

  const source = readFileSync(path.resolve(testDir, '../../../docker/runtime/dev-entrypoint.sh'), 'utf8');
  const scriptPath = path.join(root, 'dev-entrypoint.sh');
  const rewritten = source
    .replace('/var/run/sshd', sshdRunDir)
    .replace('exec /usr/sbin/sshd -D -e', 'exec sshd -D -e');
  writeFileSync(scriptPath, rewritten, { mode: 0o755 });

  return {
    root,
    scriptPath,
    logsDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      DEV_USER: 'dev'
    }
  };
}

function prepareSidecarEntrypointHarness(): {
  root: string;
  scriptPath: string;
  logsDir: string;
  stateFile: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'devbox-sidecar-entrypoint-'));
  const binDir = path.join(root, 'bin');
  const logsDir = path.join(root, 'logs');
  const runDir = path.join(root, 'run');
  const stateDir = path.join(root, 'state');
  const stateFile = path.join(stateDir, 'tailscaled.state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  makeExecutable(
    path.join(binDir, 'iptables'),
    `#!/bin/sh\necho "$@" >> "${path.join(logsDir, 'iptables.log')}"\nexit 0\n`
  );
  makeExecutable(
    path.join(binDir, 'tailscale'),
    `#!/bin/sh\necho "$@" >> "${path.join(logsDir, 'tailscale.log')}"\nexit 0\n`
  );
  makeExecutable(
    path.join(binDir, 'tailscaled'),
    [
      '#!/bin/sh',
      'socket=""',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    --socket=*) socket="${arg#--socket=}" ;;',
      '  esac',
      'done',
      'node -e "const fs=require(\'node:fs\'); const net=require(\'node:net\'); const path=require(\'node:path\'); const socket=process.argv[1]; fs.mkdirSync(path.dirname(socket), { recursive: true }); const server=net.createServer(); server.listen(socket, () => setTimeout(() => server.close(() => process.exit(0)), 1500)); const shutdown=()=>server.close(()=>process.exit(0)); process.on(\'SIGTERM\', shutdown); process.on(\'SIGINT\', shutdown);" "$socket"'
    ].join('\n')
  );

  const source = readFileSync(path.resolve(testDir, '../../../docker/tailscale-sidecar/entrypoint.sh'), 'utf8');
  const scriptPath = path.join(root, 'entrypoint.sh');
  const rewritten = source
    .replaceAll('/var/lib/tailscale', stateDir)
    .replaceAll('/var/run/tailscale', runDir)
    .replace(
      'wait "$TAILSCALED_PID"',
      'kill "$TAILSCALED_PID" 2>/dev/null || true\nwait "$TAILSCALED_PID" 2>/dev/null || true'
    );
  writeFileSync(scriptPath, rewritten, { mode: 0o755 });

  return {
    root,
    scriptPath,
    logsDir,
    stateFile,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`
    }
  };
}

describe('runtime entrypoints', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('workspace entrypoint only launches sshd', () => {
    const harness = prepareWorkspaceEntrypointHarness();
    roots.push(harness.root);

    const result = spawnSync('sh', [harness.scriptPath], {
      env: harness.env,
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    const sshdLog = readFileSync(path.join(harness.logsDir, 'sshd.log'), 'utf8');
    expect(sshdLog).toContain('-D -e');
    expect(result.stderr).not.toContain('DEVBOX_TAILSCALE_AUTHKEY');
    expect(result.stderr).not.toContain('tailscale');
  });

  it('sidecar fails fast when neither auth key nor persisted state exists', () => {
    const harness = prepareSidecarEntrypointHarness();
    roots.push(harness.root);

    const result = spawnSync('sh', [harness.scriptPath], {
      env: harness.env,
      encoding: 'utf8'
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DEVBOX_TAILSCALE_AUTHKEY or persisted state');
  });

  it('sidecar starts tailscale with auth key and applies firewall rules', () => {
    const harness = prepareSidecarEntrypointHarness();
    roots.push(harness.root);

    const result = spawnSync('sh', [harness.scriptPath], {
      env: {
        ...harness.env,
        DEVBOX_TAILSCALE_AUTHKEY: 'tskey-auth-test',
        DEVBOX_TAILSCALE_HOSTNAME: 'devbox-auth'
      },
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    const tailscaleLog = readFileSync(path.join(harness.logsDir, 'tailscale.log'), 'utf8');
    const iptablesLog = readFileSync(path.join(harness.logsDir, 'iptables.log'), 'utf8');
    expect(tailscaleLog).toContain('--authkey=tskey-auth-test');
    expect(tailscaleLog).toContain('--hostname=devbox-auth');
    expect(tailscaleLog).toContain('--ssh');
    expect(iptablesLog).toContain('-F INPUT');
    expect(iptablesLog).toContain('-A INPUT -i tailscale0 -j ACCEPT');
    expect(iptablesLog).toContain('-A INPUT -j DROP');
  });

  it('sidecar resumes from persisted state without requiring an auth key', () => {
    const harness = prepareSidecarEntrypointHarness();
    roots.push(harness.root);
    writeFileSync(harness.stateFile, '{"_profiles":{"default":{}}}');

    const result = spawnSync('sh', [harness.scriptPath], {
      env: {
        ...harness.env,
        DEVBOX_TAILSCALE_HOSTNAME: 'devbox-stateful'
      },
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    const tailscaleLog = readFileSync(path.join(harness.logsDir, 'tailscale.log'), 'utf8');
    expect(tailscaleLog).not.toContain('--authkey=');
    expect(tailscaleLog).toContain('--hostname=devbox-stateful');
    expect(tailscaleLog).toContain('--ssh');
  });
});
