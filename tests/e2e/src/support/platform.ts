/**
 * Shared E2E plumbing: platform boot/teardown (extracted mechanically from
 * exit-scenario.test.ts) and agent registration. Each test file owns its
 * boot/teardown; vitest runs the files serially (fileParallelism: false)
 * because the platform binds fixed ports.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';
import { expect } from 'vitest';

export const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

export const TOKEN_URL = 'http://localhost:7101';
export const GATEWAY_URL = 'http://localhost:7100';
export const REGISTRY_URL = 'http://localhost:7102';
export const AUDIT_URL = 'http://localhost:7104';
export const KNOWLEDGE_URL = 'http://localhost:7105';
export const LLM_GATEWAY_URL = 'http://localhost:7107';
export const JAEGER_URL = 'http://localhost:16686';

/** Boots the platform against the dev stack and resolves once it is ready. */
export async function startPlatform(): Promise<ChildProcess> {
  // Fail fast with an actionable message if the substrate isn't up.
  try {
    await fetch('http://localhost:8222/healthz');
  } catch {
    throw new Error('dev stack is not running — start it with `make dev` first');
  }

  const platform = spawn('node', [join(repoRoot, 'scripts', 'run-platform.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('platform never became ready'));
    }, 180_000);
    platform.stdout.on('data', (d: Buffer) => {
      process.stdout.write(d);
      if (d.toString().includes('PLATFORM_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    platform.on('exit', (code) => {
      reject(new Error(`platform exited early: ${code}`));
    });
  });
  return platform;
}

export function stopPlatform(platform: ChildProcess | undefined): void {
  // A beforeAll boot failure leaves no process; a teardown throw here would
  // mask the real error with "reading 'pid'".
  if (platform === undefined) return;
  if (process.platform === 'win32' && platform.pid !== undefined) {
    // TerminateProcess does not cascade; take down the whole service tree.
    spawn('taskkill', ['/pid', String(platform.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    platform.kill();
  }
}

/** Registers a manifest at version 0.1.0 and promotes the agent to active. */
export async function registerAndActivate(
  manifestPath: string,
  agentId: string,
  writeToken: string,
  reason: string,
): Promise<void> {
  const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;

  const register = await fetch(`${REGISTRY_URL}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
    body: JSON.stringify({ manifest, version: '0.1.0' }),
  });
  // 201 on a fresh registration; 200 when the SAME (id,version,manifest) is
  // re-registered — idempotent, so multiple E2E files sharing an agent in one
  // CI run (same manifest, persistent volume) do not collide.
  expect([200, 201], await register.clone().text()).toContain(register.status);
  const card = (await register.json()) as { lifecycle_state: string; card_signature: string };
  expect(card.card_signature).toBeTruthy();

  const activate = await fetch(`${REGISTRY_URL}/v1/agents/${agentId}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
    body: JSON.stringify({ state: 'active', reason }),
  });
  // 200 on the transition; 409 when it is already active (a prior file activated
  // it) — either leaves the agent active, which is all this helper guarantees.
  expect([200, 409], await activate.clone().text()).toContain(activate.status);
}
