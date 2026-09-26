import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Tests must not inherit a deployed .env through the shared clients' fallback
// paths, nor accidentally use credentials inherited from an operator's shell.
const env = { ...process.env, MONITOR_TEST_NO_ENV: '1' };
const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
for (const [, key] of template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) delete env[key];
for (const key of Object.keys(env)) if (/^(FEISHU_|FLAP_|FOURMEME_|OPENFOUR_|BSC_|GITHUB_|ETHERSCAN_|BSCSCAN_)/.test(key)) delete env[key];
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
