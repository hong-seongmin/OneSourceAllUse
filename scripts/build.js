import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = ['apps/web/server.js', 'apps/worker/index.js', 'migrations/001_initial.sql', 'docker-compose.yml', 'Dockerfile'];
for (const file of required) await access(join(process.cwd(), file));
const modules = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'public') await walk(path);
    else if (entry.name.endsWith('.js') && !path.endsWith('/index.js')) modules.push(path);
  }
}
await walk(join(process.cwd(), 'apps'));
for (const module of modules) await import(module);
console.log(`build: PASS (${modules.length} runtime modules checked)`);
