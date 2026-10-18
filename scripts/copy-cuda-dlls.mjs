// Copie les DLL d'exécution CUDA dans src-tauri/cuda-dlls (ignoré par git) avant
// `tauri build --features cuda --config src-tauri/tauri.cuda.conf.json`.
//
// Cette surcouche déclare src-tauri/cuda-dlls/*.dll en `bundle.resources` vers la racine
// d'installation : les DLL se retrouvent à côté de lucania.exe, qui les charge au démarrage
// (llama-cpp-sys-2 lie cudart, cublas et cublasLt en dynamique sous Windows).
//
// Dossier source : $CUDA_PATH/bin/x64 (CUDA 13+), sinon $CUDA_PATH/bin (CUDA 12).
// Variables d'environnement :
//   CUDA_PATH  dossier du CUDA Toolkit (défini par son installateur)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'src-tauri', 'cuda-dlls');
const log = (m) => console.log(`[copy-cuda-dlls] ${m}`);
const fail = (m) => { console.error(`[copy-cuda-dlls] ERREUR : ${m}`); process.exit(1); };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const cudaPath = process.env.CUDA_PATH;
if (!cudaPath || !isDir(cudaPath)) {
  fail('CUDA_PATH non défini ou introuvable : installez le CUDA Toolkit (12.8 ou plus récent).');
}
const binDirs = [path.join(cudaPath, 'bin', 'x64'), path.join(cudaPath, 'bin')].filter(isDir);

// cudart64_13.dll, cublas64_13.dll, cublasLt64_13.dll (le numéro suit la version majeure de CUDA)
const wanted = [/^cudart64_\d+\.dll$/i, /^cublas64_\d+\.dll$/i, /^cublasLt64_\d+\.dll$/i];
const found = [];
for (const re of wanted) {
  let hit = null;
  for (const dir of binDirs) {
    const name = fs.readdirSync(dir).find((f) => re.test(f));
    if (name) { hit = path.join(dir, name); break; }
  }
  if (!hit) fail(`DLL ${re.source} introuvable dans :\n  ${binDirs.join('\n  ') || path.join(cudaPath, 'bin')}`);
  found.push(hit);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
let total = 0;
for (const src of found) {
  const to = path.join(dest, path.basename(src));
  fs.copyFileSync(src, to);
  const size = fs.statSync(to).size;
  total += size;
  log(`${path.basename(src)} (${(size / 1024 / 1024).toFixed(1)} Mo)`);
}
log(`Terminé : ${found.length} DLL dans src-tauri/cuda-dlls (${(total / 1024 / 1024).toFixed(0)} Mo).`);
