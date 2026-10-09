// Donne aux installateurs un NOM FIXE, quelle que soit la version, après `tauri build` et build-updater.mjs.
//
//   Lucania_<version>_x64-setup.exe   ->  Lucania-Setup.exe
//   Lucania_<version>_x64-update.exe  ->  Lucania-Update.exe
//
// Les copies vont dans un dossier dédié (target/release/bundle/release), vidé puis recréé à chaque fois :
// c'est lui que le workflow GitHub publie. Nom stable = une seule exception antivirus et lien de
// téléchargement direct stable (releases/latest/download/Lucania-Setup.exe).
//
// Variables d'environnement facultatives (le comportement par défaut ne change pas sans elles) :
//   LUCANIA_BUNDLE_DIR  dossier contenant les exe versionnés (défaut : target/release/bundle/nsis)
//   CARGO_TARGET_DIR    dossier target de Cargo, s'il est absolu (défaut : src-tauri/target)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const log = (m) => console.log(`[name-installers] ${m}`);
const fail = (m) => { console.error(`[name-installers] ERREUR : ${m}`); process.exit(1); };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// 1. Version et nom du produit (source unique : tauri.conf.json)
let conf;
try {
  conf = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8'));
} catch (e) {
  fail(`lecture de src-tauri/tauri.conf.json impossible (${e.message}).`);
}
const version = conf.version;
const productName = conf.productName;
if (!version || !productName) fail('"version" ou "productName" absent de src-tauri/tauri.conf.json.');
log(`${productName} ${version}`);

// 2. Dossiers
const targetDir = process.env.CARGO_TARGET_DIR && path.isAbsolute(process.env.CARGO_TARGET_DIR)
  ? process.env.CARGO_TARGET_DIR
  : path.join(tauri, 'target');
const bundleDir = path.resolve(process.env.LUCANIA_BUNDLE_DIR || path.join(targetDir, 'release', 'bundle', 'nsis'));
const outDir = path.join(path.dirname(bundleDir), 'release');

// 3. Fichiers source : les deux doivent exister
const pairs = [
  [`${productName}_${version}_x64-setup.exe`, 'Lucania-Setup.exe'],
  [`${productName}_${version}_x64-update.exe`, 'Lucania-Update.exe'],
];
const missing = pairs.map(([src]) => path.join(bundleDir, src)).filter((p) => !isFile(p));
if (missing.length) {
  fail(`fichier(s) source introuvable(s) :\n  ${missing.join('\n  ')}\n  Lancez d'abord « npm run desktop:build ».`);
}

// 4. Dossier de sortie vidé puis recréé, copies sous les noms fixes
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const [src, dest] of pairs) {
  const to = path.join(outDir, dest);
  fs.copyFileSync(path.join(bundleDir, src), to);
  const size = fs.statSync(to).size;
  if (size === 0) fail(`${to} est vide.`);
  log(`${src} -> ${to} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
}
log('Terminé.');
