import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isPortableEnvironmentKey } from './dotenv.js';
import type { LocalEnvConfig } from './types.js';

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<string>;

const defaultRunner: CommandRunner = (command, args, options) => (
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        encoding: 'utf8',
        env: { ...process.env, ...options.env },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  })
);

function readOptionalText(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function resolveToken(config: LocalEnvConfig): string | undefined {
  if (process.env.INFISICAL_TOKEN?.trim()) return process.env.INFISICAL_TOKEN.trim();
  if (config.tokenFile) {
    const t = readOptionalText(config.tokenFile);
    if (t) return t;
  }
  const home = process.env.HOME;
  if (!home) return undefined;
  return readOptionalText(path.join(home, '.config', 'infisical-jwt.token')) ?? undefined;
}

/**
 * Export secrets from Infisical via CLI (`infisical export --format=json`).
 * Compatible with Infisical CLI 0.31.x + self-hosted servers that use v3 secrets API.
 */
export async function exportInfisicalSecrets(input: {
  config: LocalEnvConfig;
  environment: string;
  runner?: CommandRunner;
}): Promise<Record<string, string>> {
  const { config, environment } = input;
  const runner = input.runner ?? defaultRunner;
  const domain = config.infisicalDomain;
  const args = [
    'export',
    `--env=${environment}`,
    '--format=json',
    `--domain=${domain}`,
  ];
  if (config.projectId) args.push(`--projectId=${config.projectId}`);
  const token = resolveToken(config);
  const runnerEnv: Record<string, string> = {
    INFISICAL_DISABLE_UPDATE_CHECK: 'true',
    INFISICAL_API_URL: domain,
  };
  if (token) runnerEnv.INFISICAL_TOKEN = token;

  let output: string;
  try {
    output = await runner('infisical', args, {
      cwd: config.projectRoot,
      env: runnerEnv,
    });
  } catch {
    throw new Error(
      'Infisical export failed. Verify login/token, projectId, domain, and CLI/server compatibility.',
    );
  }

  if (!output.trim()) {
    throw new Error('Infisical returned no secrets; the existing .env was not changed.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error('Infisical returned invalid JSON; the existing .env was not changed.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Infisical JSON must be an array of key/value entries.');
  }
  if (parsed.length === 0) {
    throw new Error('Infisical returned no secrets; the existing .env was not changed.');
  }

  const secretEntries: Array<[string, string]> = [];
  const seenKeys = new Set<string>();
  for (const entry of parsed) {
    if (
      entry === null
      || typeof entry !== 'object'
      || typeof (entry as { key?: unknown }).key !== 'string'
      || typeof (entry as { value?: unknown }).value !== 'string'
    ) {
      throw new Error('Infisical JSON must be an array of key/value entries.');
    }
    const key = (entry as { key: string }).key;
    const value = (entry as { value: string }).value;
    if (!isPortableEnvironmentKey(key)) {
      throw new Error(`Infisical returned an invalid secret key: ${key}`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`Infisical returned a duplicate secret key: ${key}`);
    }
    seenKeys.add(key);
    secretEntries.push([key, value]);
  }
  return Object.fromEntries(secretEntries);
}
