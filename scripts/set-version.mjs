// Met à jour la version dans les 4 fichiers qui la portent.
// Usage : npm run version:set 0.1.5
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
  console.error('Usage : npm run version:set X.Y.Z   (ex. 0.1.5, chiffres seulement)');
  process.exit(1);
}

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(root, f), s);

// Remplace la première correspondance de `re` ; le groupe 1 est conservé, le groupe 2 est l'ancienne version.
const replaceOnce = (file, text, re) => {
  const m = text.match(re);
  if (!m) { console.error(`ERREUR : champ de version introuvable dans ${file}`); process.exit(1); }
  return { out: text.replace(re, (_, a, old, b) => `${a}${next}${b}`), old: m[2] };
};

const edits = [
  // tauri.conf.json : premier "version" (racine)
  ['src-tauri/tauri.conf.json', [/^(\s*"version"\s*:\s*")([^"]+)(")/m]],
  // package.json : premier "version" (racine)
  ['package.json', [/^(\s*"version"\s*:\s*")([^"]+)(")/m]],
  // package-lock.json : version racine, puis packages[""].version
  ['package-lock.json', [
    /^(\s*"version"\s*:\s*")([^"]+)(")/m,
    /("packages"\s*:\s*\{\s*""\s*:\s*\{[^{}]*?"version"\s*:\s*")([^"]+)(")/,
  ]],
  // Cargo.toml : ligne version de la section [package] seulement
  ['src-tauri/Cargo.toml', [/(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m]],
];

let previous = null;
for (const [file, regexes] of edits) {
  let text = read(file);
  for (const re of regexes) {
    const r = replaceOnce(file, text, re);
    text = r.out;
    previous ??= r.old;
  }
  write(file, text);
  console.log(`  ${file}`);
}

console.log(`Version : ${previous} -> ${next}`);
console.log('Rappel : Cargo.lock se mettra à jour au prochain build.');
