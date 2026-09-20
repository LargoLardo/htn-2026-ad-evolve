import { loadEnvFile } from 'node:process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const filename of ['.env', '.env.cloudflare']) {
  try { loadEnvFile(resolve(root, filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const mode = process.argv[2] || 'check';
if (!['check', 'provision', 'deploy'].includes(mode)) throw new Error('Use check, provision or deploy.');
const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', ...(mode === 'deploy' ? ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'] : [])];
const missing = required.filter(key => !process.env[key]);
if (missing.length) { console.error(`Add ${missing.join(', ')} to .env.cloudflare. Values are never printed.`); process.exit(1); }
if (!/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID)) throw new Error('Invalid Cloudflare account ID.');
const base = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(`Cloudflare ${method} ${path} returned HTTP ${response.status} (codes: ${(data.errors || []).map(e => e.code).join(',')}). Check token permissions and product activation.`);
  return data.result;
}
const databases = await api('/d1/database?per_page=100');
if (mode === 'check') {
  console.log('Cloudflare credentials can access D1 in the selected account.');
  for (const key of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADVOLVE_HOSTNAME']) console.log(`${key}: ${process.env[key] ? 'set' : 'not set'}`);
  process.exit(0);
}
const database = databases.find(db => db.name === 'advolve-index') || await api('/d1/database', 'POST', { name: 'advolve-index' });
const buckets = await api('/r2/buckets');
if (!buckets.buckets.some(bucket => bucket.name === 'advolve-assets')) await api('/r2/buckets', 'POST', { name: 'advolve-assets' });
const queues = await api('/queues?per_page=100');
if (!queues.some(queue => queue.queue_name === 'advolve-neural')) await api('/queues', 'POST', { queue_name: 'advolve-neural' });
const config = JSON.parse(await readFile(resolve(root, 'cloudflare/wrangler.jsonc'), 'utf8'));
config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
config.d1_databases[0].database_id = database.uuid;
const apiConfig = resolve(root, 'cloudflare/wrangler.deploy.json');
await writeFile(apiConfig, JSON.stringify(config, null, 2) + '\n');
const wrangler = resolve(root, 'cloudflare/node_modules/wrangler/bin/wrangler.js');
async function command(args, { cwd = root, input } = {}) {
  await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', no); child.on('exit', code => code === 0 ? yes() : no(new Error(`Command failed (${code}).`)));
    child.stdin.end(input);
  });
}
await command([wrangler, 'd1', 'migrations', 'apply', 'advolve-index', '--remote', '--config', apiConfig]);
console.log('R2, D1, Queue and account-scoped schema are ready.');
if (mode === 'provision') process.exit(0);
if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(process.env.ACCESS_TEAM_DOMAIN)) throw new Error('ACCESS_TEAM_DOMAIN must be your-team.cloudflareaccess.com.');
await command([wrangler, 'deploy', '--config', apiConfig]);
const names = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_IMAGE_MODEL', 'OPENAI_SCREEN_MODEL', 'PIKA_API_KEY', 'BASETEN_API_KEY', 'BASETEN_TRIBE_ENDPOINT', 'TRIBE_SCORE_URL', 'TRIBE_SCORE_TOKEN', 'MEDIA_SERVICE_URL', 'MEDIA_SERVICE_TOKEN'];
const secrets = Object.fromEntries(names.filter(key => process.env[key]).map(key => [key, process.env[key]]));
await command([wrangler, 'secret', 'bulk', '--config', apiConfig], { input: JSON.stringify(secrets) });
const web = JSON.parse(await readFile(resolve(root, 'web/wrangler.jsonc'), 'utf8'));
web.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
if (process.env.ADVOLVE_HOSTNAME) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(process.env.ADVOLVE_HOSTNAME)) throw new Error('Use a hostname without https:// or a path.');
  web.routes = [{ pattern: process.env.ADVOLVE_HOSTNAME, custom_domain: true }]; web.workers_dev = false;
}
const webConfig = resolve(root, 'web/wrangler.deploy.json');
await writeFile(webConfig, JSON.stringify(web, null, 2) + '\n');
await command([resolve(root, 'web/node_modules/@opennextjs/cloudflare/dist/cli/index.js'), 'build'], { cwd: resolve(root, 'web') });
await command([wrangler, 'deploy', '--config', webConfig], { cwd: resolve(root, 'web') });
console.log('Deployed. Finish/verify the Cloudflare Access allow policy for the frontend hostname, then sign in and test /api/config. Baseten scaling was not changed.');
