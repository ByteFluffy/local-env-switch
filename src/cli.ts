#!/usr/bin/env node
import {
  assertGuard,
  getStatus,
  resolveConfig,
  useEnvironment as switchEnvironment,
} from './api.js';
import { runDev } from './dev-command.js';

function usage(): string {
  return `Usage:
  local-env-switch use <environment> [--shared-redis] [--yes]
  local-env-switch status
  local-env-switch guard [--runner]
  local-env-switch dev [--check] [--service name] [--kubeconfig path]

Examples:
  local-env-switch use development
  local-env-switch use production --yes
  local-env-switch use staging --shared-redis
  local-env-switch status
  local-env-switch guard --runner
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  try {
    if (!cmd || cmd === '-h' || cmd === '--help') {
      process.stdout.write(usage());
      return;
    }

    if (cmd === 'dev') {
      let check = false;
      let service: string | undefined;
      let kubeconfig: string | undefined;
      for (let index = 1; index < argv.length; index++) {
        const option = argv[index];
        if (option === '--check' && !check) check = true;
        else if (option === '--service' && service === undefined && argv[index + 1] && !argv[index + 1].startsWith('-')) service = argv[++index];
        else if (option === '--kubeconfig' && kubeconfig === undefined && argv[index + 1] && !argv[index + 1].startsWith('-')) kubeconfig = argv[++index];
        else throw new Error('INVALID_DEV_CONFIG');
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try { await runDev({ check, service, kubeconfig, signal: controller.signal }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
      return;
    }

    if (cmd === 'status') {
      if (argv.length > 1) throw new Error(usage());
      const status = await getStatus();
      console.log(`Environment: ${status.environment}`);
      console.log(`Redis: ${status.localRedis ? 'local' : 'shared'}`);
      if (status.protectedLocalKeys.length > 0) {
        console.error(`Protected keys in .env.local: ${status.protectedLocalKeys.join(', ')}`);
      }
      if (status.inheritedConflictKeys.length > 0) {
        console.error(`Conflicting inherited keys: ${status.inheritedConflictKeys.join(', ')}`);
      }
      if (status.generatedPolicyKeys.length > 0) {
        console.error(`Generated policy violations: ${status.generatedPolicyKeys.join(', ')}`);
      }
      if (
        status.protectedLocalKeys.length > 0
        || status.inheritedConflictKeys.length > 0
        || status.generatedPolicyKeys.length > 0
      ) {
        process.exitCode = 1;
      }
      return;
    }

    if (cmd === 'guard') {
      let runner = false;
      for (const opt of argv.slice(1)) {
        if (opt === '--runner') {
          if (runner) throw new Error('Duplicate option: --runner');
          runner = true;
        } else {
          throw new Error(`Unknown option: ${opt}`);
        }
      }
      await assertGuard({ runner });
      return;
    }

    if (cmd === 'use') {
      const environment = argv[1];
      if (!environment) throw new Error(usage());
      let sharedRedis = false;
      let yes = false;
      for (const opt of argv.slice(2)) {
        if (opt === '--shared-redis') {
          if (sharedRedis) throw new Error('Duplicate option: --shared-redis');
          sharedRedis = true;
        } else if (opt === '--yes') {
          if (yes) throw new Error('Duplicate option: --yes');
          yes = true;
        } else {
          throw new Error(`Unknown option: ${opt}`);
        }
      }

      const config = resolveConfig();
      if (config.warnEnvironments.includes(environment)) {
        console.warn(`Warning: switching local configuration to ${environment}.`);
      }

      const result = await switchEnvironment({
        environment,
        sharedRedis,
        yes,
        config,
      });
      console.log(
        `Environment switched to ${result.environment} (${result.localRedis ? 'local Redis' : 'shared Redis'}).`,
      );
      return;
    }

    throw new Error(usage());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown local-env failure';
    console.error(`local-env-switch: ${message}`);
    process.exitCode = 1;
  }
}

await main();
