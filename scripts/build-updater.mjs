// Compile l'exe de MISE À JOUR (Lucania_<version>_x64-update.exe) après `tauri build`.
//
// tauri build rend notre template NSIS (src-tauri/windows/installer.nsi) dans
// src-tauri/target/release/nsis/x64/installer.nsi (avec utils.nsh, les fichiers de langue, etc.)
// et en tire le SETUP. Ce script recompile ce même script rendu avec /DLUCANIA_UPDATER : le template
// produit alors l'exe de mise à jour (pages Installation et Fin seulement, refus si Lucania n'est pas
// installé ou si une version plus récente l'est).
//
// Variables d'environnement facultatives (le comportement par défaut ne change pas sans elles) :
//   LUCANIA_NSIS_DIR        dossier contenant le installer.nsi rendu (défaut : target/release/nsis/x64)
//   LUCANIA_UPDATE_OUT_DIR  dossier de sortie de l'exe (défaut : target/release/bundle/nsis)
//   LUCANIA_MAKENSIS        chemin de makensis.exe (défaut : celui téléchargé par Tauri)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tauri = path.join(root, 'src-tauri');
const log = (m) => console.log(`[build-updater] ${m}`);
const fail = (m) => { console.error(`[build-updater] ERREUR : ${m}`); process.exit(1); };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// 1. Version et nom du produit (source unique : tauri.conf.json)
log('1/4 Lecture de la version (src-tauri/tauri.conf.json)...');
let conf;
try {
  conf = JSON.parse(fs.readFileSync(path.join(tauri, 'tauri.conf.json'), 'utf8'));
} catch (e) {
  fail(`lecture de src-tauri/tauri.conf.json impossible (${e.message}).`);
}
const version = conf.version;
const productName = conf.productName;
if (!version || !productName) fail('"version" ou "productName" absent de src-tauri/tauri.conf.json.');
log(`  ${productName} ${version}`);

// 2. Script NSIS rendu par tauri build
log('2/4 Vérification du script NSIS rendu par tauri build...');
const targetDir = process.env.CARGO_TARGET_DIR && path.isAbsolute(process.env.CARGO_TARGET_DIR)
  ? process.env.CARGO_TARGET_DIR
  : path.join(tauri, 'target');
const nsisDir = path.resolve(process.env.LUCANIA_NSIS_DIR || path.join(targetDir, 'release', 'nsis', 'x64'));
const outDir = path.resolve(process.env.LUCANIA_UPDATE_OUT_DIR || path.join(targetDir, 'release', 'bundle', 'nsis'));
const script = path.join(nsisDir, 'installer.nsi');
if (!isFile(script)) {
  fail(`script NSIS rendu introuvable : ${script}\n  Lancez d'abord « npm run tauri build » (ou « npm run desktop:build », qui enchaîne les deux).`);
}
const rendered = fs.readFileSync(script, 'utf8');
// Rendu issu du template Lucania à jour (sinon l'exe produit serait un simple setup)
if (!rendered.includes('LUCANIA_UPDATER')) {
  fail('le script rendu ne gère pas LUCANIA_UPDATER : il ne vient pas du template src-tauri/windows/installer.nsi à jour.\n  Relancez « npm run tauri build ».');
}
// Rendu de la bonne version (sinon on emballerait d'anciens fichiers sous un nouveau nom)
const renderedVersion = (/^!define VERSION "([^"]*)"/m.exec(rendered) || [])[1];
if (renderedVersion !== version) {
  fail(`le script rendu est en version ${renderedVersion ?? '(introuvable)'} alors que tauri.conf.json indique ${version} : rendu périmé.\n  Relancez « npm run tauri build ».`);
}
log(`  OK : ${script}`);

// 3. makensis.exe (téléchargé par Tauri dans %LOCALAPPDATA%\tauri\NSIS)
log('3/4 Recherche de makensis.exe...');
const localAppData = process.env.LOCALAPPDATA
  || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
const candidates = [];
if (process.env.LUCANIA_MAKENSIS) candidates.push(path.resolve(process.env.LUCANIA_MAKENSIS));
if (localAppData) {
  candidates.push(path.join(localAppData, 'tauri', 'NSIS', 'makensis.exe'));
  candidates.push(path.join(localAppData, 'tauri', 'NSIS', 'Bin', 'makensis.exe'));
}
const makensis = candidates.find(isFile);
if (!makensis) {
  fail(`makensis.exe introuvable. Chemins essayés :\n  ${candidates.join('\n  ') || '(LOCALAPPDATA non défini)'}\n  Il est téléchargé par « npm run tauri build » ; sinon, indiquez son chemin dans LUCANIA_MAKENSIS.`);
}
log(`  ${makensis}`);

// 4. Compilation (mêmes options que tauri-bundler, plus les deux defines Lucania)
const outFile = path.join(outDir, `${productName}_${version}_x64-update.exe`);
log(`4/4 Compilation de ${path.basename(outFile)}...`);
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(outFile, { force: true });
const env = { ...process.env };
delete env.NSISDIR;
delete env.NSISCONFDIR;
const run = spawnSync(makensis, [
  '/INPUTCHARSET', 'UTF8',
  '/OUTPUTCHARSET', 'UTF8',
  '/V2',
  '/DLUCANIA_UPDATER',
  `/DLUCANIA_UPDATE_OUT=${outFile}`,
  'installer.nsi',
], { cwd: nsisDir, stdio: 'inherit', env, windowsHide: true });
if (run.error) fail(`lancement de makensis impossible (${run.error.message}).`);
if (run.status !== 0) fail(`makensis a échoué (code ${run.status}).`);
if (!isFile(outFile)) fail(`makensis n'a pas produit ${outFile}.`);
const size = fs.statSync(outFile).size;
if (size === 0) fail(`${outFile} est vide.`);
log(`Terminé : ${outFile} (${(size / 1024 / 1024).toFixed(1)} Mo).`);
