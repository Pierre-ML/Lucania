// Construit le serveur Astro autonome et prépare les ressources Tauri.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const appDir = path.join(tauri, 'resources', 'app');
const nodeDest = path.join(tauri, 'binaries', 'node-x86_64-pc-windows-msvc.exe');
const log = (m) => console.log(`[build-desktop] ${m}`);
const fail = (m) => { console.error(`[build-desktop] ERREUR : ${m}`); process.exit(1); };

// a. Build Astro
log('1/4 Compilation Astro (dépendances serveur embarquées)...');
const astroBin = path.join(root, 'node_modules', 'astro', 'bin', 'astro.mjs');
const build = spawnSync(process.execPath, [astroBin, 'build'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, LUCANIA_DESKTOP: '1' },
});
if (build.status !== 0) fail('astro build a échoué.');

// b. Ressources
log('2/4 Préparation de src-tauri/resources/app ...');
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(path.join(root, 'dist', 'server'), path.join(appDir, 'server'), { recursive: true });
fs.cpSync(path.join(root, 'dist', 'client'), path.join(appDir, 'client'), { recursive: true });

// b1. Astro inscrit dans le manifeste des chemins absolus de la machine de build (dont le nom
// d'utilisateur Windows). On les remplace par un chemin neutre, de façon cohérente (les chemins
// relatifs serveur/client restent valides), avant le scan anti-fuite.
log('2a/4 Neutralisation des chemins absolus de la machine de build...');
{
  // Regex insensibles à la casse (Windows) : chaque séparateur du chemin racine devient une classe.
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = root.split(/[\\/]+/).filter(Boolean);
  const mk = (sep, prefix) => new RegExp(prefix + parts.map(esc).join(sep), 'gi');
  const rules = [
    [mk('(?:\\\\\\\\|\\\\|/)', 'file:///'), 'file:///C:/lucania-build'],
    [mk('\\\\\\\\', ''), 'C:\\\\lucania-build'],
    [mk('\\\\(?!\\\\)', ''), 'C:\\lucania-build'],
    [mk('/', ''), 'C:/lucania-build'],
  ];
  // Filet : tout préfixe de dossier utilisateur restant
  const userRe = /[A-Za-z]:(\\\\|\\|\/)Users(\\\\|\\|\/)[^\\/"'`\s:*?<>|]+/gi;
  const userRepl = (m, sep) => 'C:' + sep + 'lucania-build';
  let safety = 0;
  const walkAll = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkAll(path.join(d, e.name)) : [path.join(d, e.name)]);
  let n = 0;
  for (const f of walkAll(appDir)) {
    if (!/\.(mjs|js|cjs|json|html|map)$/i.test(f)) continue;
    let s = fs.readFileSync(f, 'utf8');
    const before = s;
    for (const [re, rep] of rules) s = s.replace(re, () => rep);
    s = s.replace(userRe, (m, sep) => { safety++; return userRepl(m, sep); });
    if (s !== before) { fs.writeFileSync(f, s); n++; }
  }
  log(`  ${n} fichier(s) nettoyé(s).`);
  log(`  filet de sécurité (dossier utilisateur résiduel) : ${safety} remplacement(s).`);
}

// b2. Scan anti-fuite : l'app distribuée ne doit contenir aucune donnée personnelle
log('2b/4 Scan anti-fuite (.env, IP, chemins utilisateur)...');
{
  for (const bad of ['data', '.env', '.env.production']) {
    if (fs.existsSync(path.join(appDir, bad))) fail(`"${bad}" ne doit jamais être copié dans resources/app.`);
  }
  const GENERIC = new Set(['GET', 'POST', 'http://localhost:11434', 'true', 'false', 'localhost', '127.0.0.1']);
  const needles = []; // { label, buf }
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
      if (v.length >= 4 && !GENERIC.has(v)) needles.push({ label: `valeur de ${m[1]} (.env)`, buf: Buffer.from(v) });
    }
  }
  needles.push({ label: 'adresse 10.66.66.*', buf: Buffer.from('10.66.66.') });
  const userPathRe = /[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)/i;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const leaks = [];
  for (const f of walk(appDir)) {
    const data = fs.readFileSync(f);
    for (const n of needles) if (data.includes(n.buf)) leaks.push(`${path.relative(appDir, f)} -> ${n.label}`);
    if (userPathRe.test(data.toString('latin1'))) leaks.push(`${path.relative(appDir, f)} -> chemin utilisateur Windows (X:\\Users\\)`);
  }
  if (leaks.length) fail('fuite potentielle de données personnelles (valeurs non affichées) :\n  ' + leaks.join('\n  '));
  log(`  OK : ${needles.length} motifs recherchés, aucun trouvé.`);
}

// c. Sidecar node
log('3/4 Copie de node.exe (sidecar)...');
fs.mkdirSync(path.dirname(nodeDest), { recursive: true });
const same = fs.existsSync(nodeDest) && fs.statSync(nodeDest).size === fs.statSync(process.execPath).size
  && fs.readFileSync(nodeDest).equals(fs.readFileSync(process.execPath));
if (!same) fs.copyFileSync(process.execPath, nodeDest);

// d. Auto-test hors du projet (sans node_modules)
log('4/4 Auto-test autonome...');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucania-selftest-'));
const tmpApp = path.join(tmp, 'app');
const tmpCwd = path.join(tmp, 'cwd');
fs.cpSync(appDir, tmpApp, { recursive: true });
fs.mkdirSync(tmpCwd);
const PORT = 4799;
let output = '';
const child = spawn(nodeDest, [path.join(tmpApp, 'server', 'entry.mjs')], {
  cwd: tmpCwd, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LUCANIA_DESKTOP: '1', LUCANIA_DATA_DIR: path.join(tmp, 'data') },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
let exited = null;
child.on('exit', (c) => (exited = c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(p) {
  try { return (await fetch(`http://127.0.0.1:${PORT}${p}`)).status; } catch { return 0; }
}
let ok = true;
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && exited === null && (await get('/')) !== 200) await sleep(300);
  for (const p of ['/', '/parametres', '/api/status', '/api/connections', '/api/system']) {
    const s = await get(p);
    log(`  GET ${p} -> ${s}`);
    if (s !== 200) ok = false;
  }
  if (exited !== null) { ok = false; log(`  le serveur s'est arrêté (code ${exited})`); }
} finally {
  if (exited === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore' });
    child.kill();
  }
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}
if (!ok) { console.error(output); fail('auto-test échoué.'); }
log('Auto-test réussi : le serveur est autonome. Terminé.');
