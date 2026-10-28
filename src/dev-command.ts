import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { findConfigPath } from './config.js';
import { isPortableEnvironmentKey } from './dotenv.js';
import { getOrCreateRuntimeId } from './files.js';
import { parseDevProfile, validateDevBootstrap } from './dev-profile.js';

export type DevProfileConfig = {
  environment: string; region: string; production: boolean;
  context: string; namespace: string; pod: string;
  dbPort: number; configPort: number; databaseAlias: string;
};
export type DevConfigFile = {
  project: string;
  profiles: Record<string, DevProfileConfig>;
  defaults?: Record<string, string>;
  allowedBootstrapEnv?: string[];
  database: Partial<Record<'url' | 'host' | 'port' | 'user' | 'password' | 'name', string[]>>;
  ephemeralSecretGroups?: string[][];
  commands: Array<{ name: string; argv: string[]; cwd?: string; manual?: boolean }>;
};
export type RunDevInput = {
  projectRoot?: string; check?: boolean; service?: string; kubeconfig?: string; signal?: AbortSignal;
};

const OS_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'];
const SECRET_NAME = /SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|PKEY|ENCRYPTION_KEY|SIGNING_KEY/i;
const SIGNING_KEYS = ['JWT_SECRET', 'JWT_SECRET_KEY', 'CANVAS_AUTH_SECRET', 'SESSION_SECRET',
  'AUTH_SECRET', 'CONSOLE_JWT_SECRET', 'BETTER_AUTH_SECRET', 'CATALOG_QUOTE_SIGNING_SECRET',
  'VOICE_DESIGN_SIGNING_SECRET'];
const CONTROL_NAME = /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|BASH_ENV|ENV|KUBECONFIG|VIBEPAPER_DEV_.*)$/;
const SAFE_ERRORS = new Set(['INVALID_DEV_CONFIG', 'ENV_FILE_MUST_CONTAIN_ONLY_PROFILE',
  'DEV_PROFILE_NOT_CONFIGURED', 'DEV_LOCAL_PORT_BUSY', 'DEV_TUNNEL_FAILED',
  'INVALID_DEV_BOOTSTRAP', 'DEV_APPLICATION_FAILED', 'DEV_INTERRUPTED']);
const requireValid: (value: unknown) => asserts value = (value) => {
  if (!value) throw new Error('INVALID_DEV_CONFIG');
};

function object(value: unknown): Record<string, unknown> {
  requireValid(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function keys(value: object, allowed: string[]): void {
  requireValid(Object.keys(value).every((key) => allowed.includes(key)));
}
function strings(value: unknown, unique = true): string[] {
  requireValid(Array.isArray(value) && value.every((item) => typeof item === 'string' && item && !item.includes('\0')));
  requireValid(!unique || new Set(value).size === value.length);
  return value;
}
function envKey(key: string): void {
  requireValid(isPortableEnvironmentKey(key) && !CONTROL_NAME.test(key) && !OS_KEYS.includes(key));
}
function ordinaryKey(key: string): void { envKey(key); requireValid(!SECRET_NAME.test(key)); }
function inside(root: string, target: string): string {
  const resolved = path.resolve(root, target);
  const relative = path.relative(root, resolved);
  requireValid(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return resolved;
}
async function existingInside(root: string, target: string): Promise<string> {
  return inside(root, await realpath(inside(root, target)));
}

async function loadDev(root: string) {
  const configPath = findConfigPath(root);
  requireValid(configPath);
  const file = object(JSON.parse(await readFile(configPath, 'utf8')));
  const dev = object(file.dev) as unknown as DevConfigFile;
  keys(dev, ['project', 'profiles', 'defaults', 'allowedBootstrapEnv', 'database', 'ephemeralSecretGroups', 'commands']);
  requireValid(typeof dev.project === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(dev.project));
  object(dev.profiles);
  for (const [name, profile] of Object.entries(dev.profiles)) {
    requireValid(/^[a-z0-9-]+$/.test(name)); object(profile);
    keys(profile, ['environment', 'region', 'production', 'context', 'namespace', 'pod', 'dbPort', 'configPort', 'databaseAlias']);
    for (const field of ['environment', 'region', 'context', 'namespace', 'pod'] as const) {
      requireValid(typeof profile[field] === 'string' && /^[a-z0-9][a-z0-9.-]*$/.test(profile[field]));
    }
    requireValid(typeof profile.production === 'boolean');
    requireValid(!profile.production || (/^dev-access-.+-prod$/.test(profile.context) && /(?:^|-)prod$/.test(profile.namespace)));
    requireValid(typeof profile.databaseAlias === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(profile.databaseAlias));
    for (const port of [profile.dbPort, profile.configPort]) requireValid(Number.isInteger(port) && port >= 1024 && port <= 65535);
    requireValid(profile.dbPort !== profile.configPort);
  }
  const defaults = object(dev.defaults ?? {}) as Record<string, string>;
  for (const [key, value] of Object.entries(defaults)) {
    ordinaryKey(key); requireValid(typeof value === 'string' && !value.includes('\0'));
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const url = new URL(value); requireValid(!url.username && !url.password);
    }
  }
  const allowed = strings(dev.allowedBootstrapEnv ?? []); allowed.forEach(ordinaryKey);
  const used = new Set([...Object.keys(defaults), ...allowed]);
  const database = object(dev.database);
  keys(database, ['url', 'host', 'port', 'user', 'password', 'name']);
  for (const names of Object.values(database)) for (const key of strings(names)) {
    envKey(key); requireValid(!used.has(key)); used.add(key);
  }
  requireValid(Object.values(database).some((names) => (names as string[]).length > 0));
  requireValid(Array.isArray(dev.ephemeralSecretGroups ?? []));
  for (const group of dev.ephemeralSecretGroups ?? []) {
    requireValid(strings(group).length > 0);
    for (const key of group) { requireValid(SIGNING_KEYS.includes(key) && !used.has(key)); used.add(key); }
  }
  requireValid(Array.isArray(dev.commands));
  const commandNames = new Set<string>();
  for (const command of dev.commands) {
    object(command); keys(command, ['name', 'argv', 'cwd', 'manual']);
    requireValid(command.manual === undefined || typeof command.manual === 'boolean');
    requireValid(typeof command.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(command.name) && !commandNames.has(command.name));
    commandNames.add(command.name); requireValid(strings(command.argv, false).length > 0);
    requireValid(command.cwd === undefined || typeof command.cwd === 'string');
    command.cwd = await existingInside(root, command.cwd ?? '.');
  }
  const runtimeIdPath = inside(root, (object(file.paths ?? {}).runtimeId ?? '.env.runtime-id') as string);
  try { await existingInside(root, runtimeIdPath); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await existingInside(root, path.dirname(runtimeIdPath));
  }
  return { dev, defaults, allowed, runtimeIdPath };
}

async function assertFreePort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('DEV_LOCAL_PORT_BUSY')));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}
function minimalEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(OS_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}
function tracked(child: ChildProcess, error: string, tunnel = false): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error(error)));
    child.once('exit', (code) => {
      if (tunnel || code !== 0) reject(new Error(error)); else resolve();
    });
  });
  void result.catch(() => {});
  return result;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const target = process.platform === 'win32' ? child.pid : -child.pid;
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(target, signal); } catch {}
  };
  const alive = () => { try { process.kill(target, 0); return true; } catch { return false; } };
  kill('SIGTERM');
  if (!alive()) return;
  await new Promise<void>((resolve) => {
    let reaping: ReturnType<typeof setTimeout> | undefined;
    const finish = () => { clearInterval(poll); clearTimeout(timer); clearTimeout(reaping); resolve(); };
    const poll = setInterval(() => { if (!alive()) finish(); }, 20);
    const timer = setTimeout(() => { kill('SIGKILL'); reaping = setTimeout(finish, 100); }, 1000);
  });
}

export async function runDev(input: RunDevInput = {}): Promise<void> {
  const children: ChildProcess[] = [];
  let interrupt: (() => void) | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const root = await realpath(input.projectRoot ?? process.cwd());
    const { dev, defaults, allowed, runtimeIdPath } = await loadDev(root);
    const profileName = parseDevProfile(await readFile(path.join(root, '.env'), 'utf8'));
    if (!Object.hasOwn(dev.profiles, profileName)) throw new Error('DEV_PROFILE_NOT_CONFIGURED');
    const profile = dev.profiles[profileName];
    const commands = dev.commands.filter((command) => input.service === undefined
      ? command.manual !== true : command.name === input.service);
    requireValid(input.service === undefined || commands.length === 1);
    requireValid(input.check || commands.length > 0);
    const kubeconfig = path.resolve(input.kubeconfig ?? path.join(homedir(), '.config/vibepaper-dev/kubeconfig'));
    requireValid((await stat(kubeconfig)).isFile());
    await Promise.all([assertFreePort(profile.dbPort), assertFreePort(profile.configPort)]);
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = () => reject(new Error('DEV_INTERRUPTED'));
      input.signal?.addEventListener('abort', interrupt, { once: true });
      if (input.signal?.aborted) interrupt();
    });
    void interrupted.catch(() => {});
    const forward = spawn('kubectl', ['--kubeconfig', kubeconfig, '--context', profile.context,
      '--namespace', profile.namespace, 'port-forward', '--address=127.0.0.1', `pod/${profile.pod}`,
      `${profile.dbPort}:6432`, `${profile.configPort}:8443`], {
      cwd: root, env: minimalEnv(), shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(forward);
    const disconnected = tracked(forward, 'DEV_TUNNEL_FAILED', true);
    const ready = new Promise<void>((resolve, reject) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16384);
        if ([`${profile.dbPort} -> 6432`, `${profile.configPort} -> 8443`]
          .every((mapping) => output.includes(`Forwarding from 127.0.0.1:${mapping}`))) resolve();
      };
      forward.stdout?.on('data', onData); forward.stderr?.on('data', onData);
      readyTimer = setTimeout(() => reject(new Error('DEV_TUNNEL_FAILED')), 15000);
    });
    await Promise.race([ready, disconnected, interrupted]); clearTimeout(readyTimer);
    const fetchController = new AbortController();
    const fetchTimer = setTimeout(() => fetchController.abort(), 10000);
    let body: unknown;
    try {
      const response = await Promise.race([fetch(`http://127.0.0.1:${profile.configPort}/bootstrap?profile=${encodeURIComponent(profileName)}`,
        { redirect: 'error', signal: fetchController.signal }), disconnected, interrupted]);
      if (!(response instanceof Response) || !response.ok) throw new Error('INVALID_DEV_BOOTSTRAP');
      const text = await Promise.race([response.text(), disconnected, interrupted]);
      if (typeof text !== 'string' || text.length > 65536) throw new Error('INVALID_DEV_BOOTSTRAP');
      body = JSON.parse(text);
    } catch (error) {
      if (error instanceof Error && ['DEV_TUNNEL_FAILED', 'DEV_INTERRUPTED'].includes(error.message)) throw error;
      throw new Error('INVALID_DEV_BOOTSTRAP');
    }
    finally { clearTimeout(fetchTimer); fetchController.abort(); }
    const bootstrap = validateDevBootstrap({ ...profile, profile: profileName, project: dev.project, allowedEnv: allowed }, body);
    if (bootstrap.database.alias !== profile.databaseAlias || bootstrap.database.localPort !== profile.dbPort) throw new Error('INVALID_DEV_BOOTSTRAP');
    await Promise.race([disconnected, interrupted, Promise.resolve()]);
    if (forward.exitCode !== null || forward.signalCode !== null) throw new Error('DEV_TUNNEL_FAILED');
    if (input.check) return;
    const runtimeId = await getOrCreateRuntimeId(runtimeIdPath, () => `local-${randomBytes(12).toString('hex')}`);
    const env: NodeJS.ProcessEnv = { ...minimalEnv(), ...bootstrap.env,
      ...Object.fromEntries(Object.entries(defaults)
        .map(([key, value]) => [key, value.replaceAll('{runtimeId}', runtimeId)])) };
    const database = { url: `postgresql://developer@127.0.0.1:${profile.dbPort}/${profile.databaseAlias}`,
      host: '127.0.0.1', port: String(profile.dbPort), user: 'developer', password: '', name: profile.databaseAlias };
    for (const [kind, names] of Object.entries(dev.database)) for (const key of names) env[key] = database[kind as keyof typeof database];
    for (const group of dev.ephemeralSecretGroups ?? []) {
      const secret = randomBytes(32).toString('hex'); for (const key of group) env[key] = secret;
    }
    env.VIBEPAPER_DEV_ENV_READY = '1';
    env.VIBEPAPER_DEV_PROFILE = profileName;
    await Promise.race([disconnected, interrupted, Promise.resolve()]);
    if (forward.exitCode !== null || forward.signalCode !== null) throw new Error('DEV_TUNNEL_FAILED');
    const applications = commands.map((command) => {
      const child = spawn(command.argv[0], command.argv.slice(1), { cwd: command.cwd, env,
        shell: false, detached: process.platform !== 'win32', stdio: 'inherit' });
      children.push(child); return tracked(child, 'DEV_APPLICATION_FAILED');
    });
    await Promise.race([disconnected, interrupted, ...applications]);
  } catch (error) {
    const message = error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'INVALID_DEV_CONFIG';
    throw new Error(message);
  } finally {
    clearTimeout(readyTimer);
    if (interrupt) input.signal?.removeEventListener('abort', interrupt);
    await Promise.all(children.map(stop));
  }
}
