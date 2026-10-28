import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { runDev } from '../src/dev-command.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const canary = 'DO_NOT_PRINT_OLD_SHARED_SECRET';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'env-dev-command-'));
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'home/.config/vibepaper-dev'), { recursive: true });
  await writeFile(path.join(root, 'home/.config/vibepaper-dev/kubeconfig'), 'fixture-only');
  const dbPort = await freePort();
  const configPort = await freePort();
  const profile = {
    environment: 'production', region: 'region-a', production: true,
    context: 'dev-access-region-a-prod', namespace: 'dev-access-prod', pod: 'database-access',
    dbPort, configPort, databaseAlias: 'shared_app',
  };
  const config = { dev: {
    project: 'fixture-project', profiles: { 'fixture-prod': profile },
    defaults: { NODE_ENV: 'development', JOB_RUNTIME_ID: '{runtimeId}', JOB_RUNTIME_ENV: '{runtimeId}' },
    allowedBootstrapEnv: ['LOG_LEVEL', 'JOB_RUNTIME_ENV'],
    database: { url: ['DATABASE_URL'], host: ['DB_HOST'], port: ['DB_PORT'],
      user: ['DB_USER'], password: ['DB_PASSWORD'], name: ['DB_NAME'] },
    ephemeralSecretGroups: [['JWT_SECRET', 'CANVAS_AUTH_SECRET'], ['SESSION_SECRET']],
    commands: ['api', 'room'].map((name): { name: string; argv: string[]; manual?: boolean } => ({ name, argv: [process.execPath, 'app.mjs', name] })),
  } };
  const scenario: Record<string, unknown> = { payload: {
    profile: 'fixture-prod', project: 'fixture-project', environment: 'production', region: 'region-a',
    production: true, authorization: 'kubernetes-rbac', env: { LOG_LEVEL: 'debug', JOB_RUNTIME_ENV: 'test' },
    database: { alias: 'shared_app', user: 'developer',
      transport: 'kubectl-port-forward', localPort: dbPort },
  } };
  const persist = async () => {
    await writeFile(path.join(root, 'local-env.config.json'), JSON.stringify(config));
    await writeFile(path.join(root, 'scenario.json'), JSON.stringify(scenario));
  };
  await persist();
  await writeFile(path.join(root, '.env'), 'VIBEPAPER_DEV_PROFILE=fixture-prod\n');
  await writeFile(path.join(root, 'bin/kubectl'), `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const root = path.dirname(path.dirname(process.argv[1]));
const scenario = JSON.parse(fs.readFileSync(path.join(root, 'scenario.json'), 'utf8'));
fs.writeFileSync(path.join(root, 'forward.json'), JSON.stringify({argv:process.argv.slice(2),env:process.env}));
if (scenario.denied) { console.error('${canary}'); process.exit(1); }
const ports = process.argv.filter(a => /^\\d+:\\d+$/.test(a));
const servers = ports.map(mapping => {
  const [local, remote] = mapping.split(':').map(Number);
  const server = remote === 8443 ? http.createServer((req,res) => {
    fs.writeFileSync(path.join(root, 'request.txt'), req.url);
    if (scenario.redirect) {res.writeHead(302,{location:'http://127.0.0.1:1/private'});res.end();return;}
    res.writeHead(scenario.status || 200, {'content-type':'application/json'});
    if (scenario.hangBody) {res.flushHeaders();fs.writeFileSync(path.join(root,'body.pending'),'yes');return;}
    res.end(JSON.stringify(scenario.payload));
  }) : net.createServer(socket => socket.end());
  server.listen(local,'127.0.0.1',()=>{
    if(remote===8443 && scenario.oneReady){setTimeout(()=>process.exit(1),300);return;}
    console.log('Forwarding from 127.0.0.1:'+local+' -> '+remote);
  });
  return server;
});
process.on('SIGTERM', () => {fs.writeFileSync(path.join(root,'forward.stopped'),'yes');process.exit(0);});
setInterval(() => {if(fs.existsSync(path.join(root,'disconnect')))process.exit(1);},20);
`);
  await chmod(path.join(root, 'bin/kubectl'), 0o700);
  await writeFile(path.join(root, 'app.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const name=process.argv[2],root=process.cwd();
fs.writeFileSync(path.join(root,name+'.json'),JSON.stringify(process.env));
if (name==='api' && JSON.parse(fs.readFileSync('scenario.json','utf8')).grandchild) {
  spawn(process.execPath,['worker.mjs'],{stdio:'ignore'});
}
process.on('SIGTERM',()=>{fs.writeFileSync(path.join(root,name+'.stopped'),'yes');process.exit(0);});
setInterval(()=>{if(fs.existsSync(path.join(root,name+'.exit')))process.exit(0);},20);
`);
  await writeFile(path.join(root,'worker.mjs'), `
import fs from 'node:fs';
fs.writeFileSync('worker.started','yes');
fs.writeFileSync('worker.pid',String(process.pid));
const ignoreTerm=JSON.parse(fs.readFileSync('scenario.json','utf8')).ignoreTerm;
process.on('SIGTERM',()=>{if(!ignoreTerm){fs.writeFileSync('worker.stopped','yes');process.exit(0);}});
setInterval(()=>{},100);
`);
  const launch = (args: string[] = []) => {
    const child = spawn(process.execPath, ['--import', loader, cli, 'dev', ...args], {
      cwd: root,
      env: { PATH: `${path.join(root, 'bin')}${path.delimiter}${path.dirname(process.execPath)}`,
        HOME: path.join(root, 'home'), TMPDIR: root,
        OLD_SHARED_SECRET: canary, DATABASE_URL: `postgres://root:${canary}@private/db`,
        INFISICAL_TOKEN: canary, NODE_OPTIONS: '--no-warnings', KUBECONFIG: '/admin/forbidden' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, output }));
    });
    return { child, done };
  };
  return { root, config, profile, scenario, persist, launch };
}

async function untilFile(root: string, name: string): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt++) {
    try { return await readFile(path.join(root, name), 'utf8'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fixture file was not created: ${name}`);
}

test('exports a dev entry point without requiring legacy Infisical config', () => {
  assert.equal(typeof runDev, 'function');
});

test('--check forwards only explicit personal kubeconfig and target, then cleans up', async (t) => {
  const f = await fixture(t);
  const result = await f.launch(['--check']).done;
  assert.equal(result.code, 0, result.output);
  const forward = JSON.parse(await untilFile(f.root, 'forward.json'));
  assert.deepEqual(forward.argv, ['--kubeconfig', path.join(f.root,'home/.config/vibepaper-dev/kubeconfig'),
    '--context', 'dev-access-region-a-prod', '--namespace', 'dev-access-prod',
    'port-forward', '--address=127.0.0.1', 'pod/database-access',
    `${f.profile.dbPort}:6432`, `${f.profile.configPort}:8443`]);
  assert.equal(forward.env.INFISICAL_TOKEN, undefined);
  assert.equal(forward.env.KUBECONFIG, undefined);
  assert.equal(await untilFile(f.root,'request.txt'), '/bootstrap?profile=fixture-prod');
  assert.equal(await untilFile(f.root,'forward.stopped'), 'yes');
  await assert.rejects(readFile(path.join(f.root,'.env.runtime-id')), {code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.root,'api.json')), {code:'ENOENT'});
});

test('production profiles can use a shared gateway with an explicit production bootstrap', async (t) => {
  const f = await fixture(t);
  Object.assign(f.profile, {context: 'dev-access-region-a', namespace: 'dev-access-test'});
  await f.persist();
  const result = await f.launch(['--check']).done;
  assert.equal(result.code, 0, result.output);
  const forward = JSON.parse(await untilFile(f.root,'forward.json'));
  assert.equal(forward.argv[forward.argv.indexOf('--context') + 1], 'dev-access-region-a');
  assert.equal(forward.argv[forward.argv.indexOf('--namespace') + 1], 'dev-access-test');
  assert.equal(await untilFile(f.root,'request.txt'), '/bootstrap?profile=fixture-prod');
  assert.equal(await untilFile(f.root,'forward.stopped'), 'yes');
});

test('a shared gateway still rejects a missing or mismatched production bootstrap before app startup', async (t) => {
  for (const production of [undefined, false]) {
    const f = await fixture(t);
    Object.assign(f.profile, {context: 'dev-access-region-a', namespace: 'dev-access-test'});
    Object.assign(f.scenario.payload as object, {production});
    await f.persist();
    const result = await f.launch().done;
    assert.equal(result.code, 1);
    assert.equal(await untilFile(f.root,'request.txt'), '/bootstrap?profile=fixture-prod');
    await assert.rejects(readFile(path.join(f.root,'api.json')), {code:'ENOENT'});
  }
});

test('app environment drops inherited secrets, maps password-free DB, and isolates ephemeral groups', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root,'.env.local'),`OLD_DOTENV_SECRET=${canary}\n`);
  const first = f.launch(['--service','api']);
  const env = JSON.parse(await untilFile(f.root,'api.json'));
  assert.equal(env.OLD_SHARED_SECRET, undefined);
  assert.equal(env.OLD_DOTENV_SECRET, undefined);
  assert.equal(env.INFISICAL_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.KUBECONFIG, undefined);
  assert.equal(env.DATABASE_URL, `postgresql://developer@127.0.0.1:${f.profile.dbPort}/shared_app`);
  assert.equal(env.DB_PASSWORD, '');
  assert.equal(env.DB_HOST, '127.0.0.1');
  assert.equal(env.DB_USER, 'developer');
  assert.equal(env.DB_NAME, 'shared_app');
  assert.equal(env.VIBEPAPER_DEV_ENV_READY, '1');
  assert.equal(env.VIBEPAPER_DEV_PROFILE, 'fixture-prod');
  assert.equal(env.LOG_LEVEL, 'debug');
  assert.match(env.JOB_RUNTIME_ID, /^local-[a-f0-9]{16,}$/);
  assert.equal(env.JOB_RUNTIME_ENV, env.JOB_RUNTIME_ID);
  assert.equal(env.JWT_SECRET, env.CANVAS_AUTH_SECRET);
  assert.notEqual(env.JWT_SECRET, env.SESSION_SECRET);
  await assert.rejects(readFile(path.join(f.root,'room.json')), {code:'ENOENT'});
  await writeFile(path.join(f.root,'api.exit'),'yes');
  assert.equal((await first.done).code, 0);
  await rm(path.join(f.root,'api.json'));
  await rm(path.join(f.root,'api.exit'));
  const second = f.launch(['--service','api']);
  const secondEnv = JSON.parse(await untilFile(f.root,'api.json'));
  assert.notEqual(secondEnv.JWT_SECRET, env.JWT_SECRET);
  assert.equal(secondEnv.JOB_RUNTIME_ID, env.JOB_RUNTIME_ID);
  await writeFile(path.join(f.root,'api.exit'),'yes');
  assert.equal((await second.done).code, 0);
  assert.equal(await readFile(path.join(f.root,'.env'),'utf8'), 'VIBEPAPER_DEV_PROFILE=fixture-prod\n');
});

test('bootstrap failures and unauthorized profiles never start apps or reveal payloads', async (t) => {
  for (const failure of ['denied','profile','project','environment','region','production','database','localPort','redirect']) {
    const f = await fixture(t);
    const payload = f.scenario.payload as Record<string, unknown>;
    if (failure === 'denied' || failure === 'redirect') f.scenario[failure] = true;
    else if (failure === 'production') payload.production = false;
    else if (failure === 'database') payload.database = {...payload.database as object, alias: 'other_db'};
    else if (failure === 'localPort') payload.database = {...payload.database as object, localPort: f.profile.configPort};
    else payload[failure] = canary;
    await f.persist();
    const result = await f.launch().done;
    assert.equal(result.code, 1, failure);
    assert.ok(!result.output.includes(canary), failure);
    await assert.rejects(readFile(path.join(f.root,'api.json')), {code:'ENOENT'});
  }
});

test('legacy env canary, secret defaults, shared encryption roots and escaping cwd fail before kubectl', async (t) => {
  for (const failure of ['env','defaults','root','cwd','unknown-profile','production-type']) {
    const f = await fixture(t);
    if (failure === 'env') await writeFile(path.join(f.root,'.env'),`VIBEPAPER_DEV_PROFILE=fixture-prod\nJWT_SECRET=${canary}\n`);
    if (failure === 'defaults') Object.assign(f.config.dev.defaults, {JWT_SECRET:canary});
    if (failure === 'root') f.config.dev.ephemeralSecretGroups.push(['CHANNEL_SECRET_ENCRYPTION_KEY']);
    if (failure === 'cwd') Object.assign(f.config.dev.commands[0], {cwd:'..'});
    if (failure === 'unknown-profile') await writeFile(path.join(f.root,'.env'),'VIBEPAPER_DEV_PROFILE=unauthorized\n');
    if (failure === 'production-type') Object.assign(f.profile, {production: 'true'});
    await f.persist();
    const result = await f.launch().done;
    assert.equal(result.code, 1, failure);
    assert.ok(!result.output.includes(canary), failure);
    await assert.rejects(readFile(path.join(f.root,'forward.json')), {code:'ENOENT'});
  }
});

test('busy local port fails before kubectl starts', async (t) => {
  const f = await fixture(t);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(f.profile.dbPort,'127.0.0.1',resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const result = await f.launch().done;
  assert.equal(result.code, 1);
  await assert.rejects(readFile(path.join(f.root,'forward.json')), {code:'ENOENT'});
});

test('one ready forwarding port cannot authorize bootstrap or application startup', async (t) => {
  const f = await fixture(t);
  f.scenario.oneReady = true;
  await f.persist();
  assert.equal((await f.launch().done).code, 1);
  await assert.rejects(readFile(path.join(f.root,'request.txt')), {code:'ENOENT'});
  await assert.rejects(readFile(path.join(f.root,'api.json')), {code:'ENOENT'});
});

test('disconnect stops all running services and reports a safe error', async (t) => {
  const f = await fixture(t);
  const running = f.launch();
  await Promise.all(['api.json','room.json'].map((file) => untilFile(f.root,file)));
  await writeFile(path.join(f.root,'disconnect'),'yes');
  const result = await running.done;
  assert.equal(result.code, 1, result.output);
  assert.ok(!result.output.includes(canary));
  await Promise.all(['api.stopped','room.stopped'].map((file) => untilFile(f.root,file)));
});

test('application spawn failure stops siblings and tunnel', async (t) => {
  const f = await fixture(t);
  f.config.dev.commands[1].argv = ['missing-fixture-executable'];
  await f.persist();
  const result = await f.launch().done;
  assert.equal(result.code, 1, result.output);
  assert.ok(!result.output.includes('missing-fixture-executable'));
  assert.equal(await untilFile(f.root,'forward.stopped'),'yes');
});

test('normal service exit stops siblings and descendants even after their parent exits', async (t) => {
  const f = await fixture(t);
  f.scenario.grandchild = true;
  await f.persist();
  const running = f.launch();
  await Promise.all(['api.json','room.json','worker.started'].map((file) => untilFile(f.root,file)));
  await writeFile(path.join(f.root,'api.exit'),'yes');
  assert.equal((await running.done).code, 0);
  await Promise.all(['room.stopped','worker.stopped','forward.stopped'].map((file) => untilFile(f.root,file)));
});

test('command argv accepts repeated arguments without using a shell', async (t) => {
  const f = await fixture(t);
  f.config.dev.commands[0].argv.push('repeat','repeat');
  await f.persist();
  const running = f.launch(['--service','api']);
  await untilFile(f.root,'api.json');
  await writeFile(path.join(f.root,'api.exit'),'yes');
  assert.equal((await running.done).code, 0);
});

test('cleanup kills descendants that ignore SIGTERM after the parent exits', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix process-group cleanup');
  const f = await fixture(t);
  Object.assign(f.scenario, {grandchild:true, ignoreTerm:true});
  await f.persist();
  const running = f.launch(['--service','api']);
  const workerPid = Number(await untilFile(f.root,'worker.pid'));
  t.after(() => {try {process.kill(workerPid,'SIGKILL');} catch {}});
  await writeFile(path.join(f.root,'api.exit'),'yes');
  assert.equal((await running.done).code, 0);
  assert.throws(() => process.kill(workerPid,0), {code:'ESRCH'});
});

test('interruption cancels a pending bootstrap body before application startup', async (t) => {
  const f = await fixture(t);
  f.scenario.hangBody = true;
  await f.persist();
  const running = f.launch();
  await untilFile(f.root,'body.pending');
  const started = Date.now();
  running.child.kill('SIGTERM');
  const result = await running.done;
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 2000, 'Body cancellation must not wait for the fetch timeout');
  await assert.rejects(readFile(path.join(f.root,'api.json')), {code:'ENOENT'});
  assert.equal(await untilFile(f.root,'forward.stopped'),'yes');
});


test('manual commands are excluded from default startup while manual false remains automatic', async (t) => {
  const f = await fixture(t);
  f.config.dev.commands[0].manual = false;
  f.config.dev.commands.push({ name: 'migrate', argv: [process.execPath, 'app.mjs', 'migrate'], manual: true });
  await f.persist();
  const running = f.launch();
  await Promise.all(['api.json', 'room.json'].map((file) => untilFile(f.root, file)));
  await assert.rejects(readFile(path.join(f.root, 'migrate.json')), { code: 'ENOENT' });
  await writeFile(path.join(f.root, 'api.exit'), 'yes');
  assert.equal((await running.done).code, 0);
});

test('manual commands run only when selected and receive the prepared proxy environment', async (t) => {
  const f = await fixture(t);
  f.config.dev.commands.push({ name: 'migrate', argv: [process.execPath, 'app.mjs', 'migrate'], manual: true });
  await f.persist();
  const running = f.launch(['--service', 'migrate']);
  const env = JSON.parse(await untilFile(f.root, 'migrate.json'));
  assert.equal(env.DATABASE_URL, `postgresql://developer@127.0.0.1:${f.profile.dbPort}/shared_app`);
  assert.equal(env.DB_PASSWORD, '');
  assert.equal(env.VIBEPAPER_DEV_ENV_READY, '1');
  assert.equal(env.VIBEPAPER_DEV_PROFILE, 'fixture-prod');
  assert.equal(env.OLD_SHARED_SECRET, undefined);
  await Promise.all(['api.json', 'room.json'].map((file) => assert.rejects(readFile(path.join(f.root, file)), { code: 'ENOENT' })));
  await writeFile(path.join(f.root, 'migrate.exit'), 'yes');
  assert.equal((await running.done).code, 0);
});

test('manual flag rejects non-boolean values before opening a tunnel', async (t) => {
  const f = await fixture(t);
  Object.assign(f.config.dev.commands[0], { manual: 'true' });
  await f.persist();
  assert.equal((await f.launch().done).code, 1);
  await assert.rejects(readFile(path.join(f.root, 'forward.json')), { code: 'ENOENT' });
});
