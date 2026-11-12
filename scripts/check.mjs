import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

for (const path of [
  'server.mjs',
  ...['api', 'lib', 'public', 'scripts', 'tests'].flatMap(files),
].filter(path => ['.js', '.mjs'].includes(extname(path)))) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
if (manifest.name !== 'Tu Agendando' ||
    !vercel.rewrites.some(route => route.source === '/config.js' && route.destination === '/api/config') ||
    !vercel.rewrites.some(route => route.source === '/oauth/callback' &&
      route.destination === '/api/oauth-callback')) {
  throw new Error('Configuração da hospedagem incompleta.');
}
for (const path of [
  'public/index.html', 'public/app.js', 'public/supabase.js', 'public/calendar-utils.js', 'public/style.css',
  'public/sw.js', 'public/brand-logo.png', 'api/config.js', 'api/google/status.js',
  'api/oauth-callback.js', 'lib/google-api.js',
]) {
  if (!existsSync(path)) throw new Error('Arquivo necessário ausente: ' + path);
}
console.log('Arquivos, sintaxe e configuração da Vercel verificados.');
