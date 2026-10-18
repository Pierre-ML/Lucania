// Navigateur de modèles Hugging Face (fenêtre « Ajouter un modèle ») : recherche, fichiers GGUF, téléchargements.
// Le jeton se règle dans Paramètres › Hugging Face (hf-settings.js).
import { confirmDialog } from './dialog.js';
import { engineAvailable, useModel } from './engine.js';
import {
  cancelDownload,
  errorMessage,
  listDownloads,
  listRepoFiles,
  onDownload,
  onDownloadRemoved,
  pauseDownload,
  resumeDownload,
  searchRepos,
  startDownload,
} from './hf.js';
import { getLang, t } from './i18n.js';

/** @typedef {import('./hf.js').DownloadInfo} DownloadInfo */
/** @typedef {import('./hf.js').HfFile} HfFile */
/** @typedef {import('./hf.js').HfRepo} HfRepo */
/** @typedef {{ id: string, repo: string, files: string[], installed: boolean, el: HTMLElement }} FileActionRef */

/** Erreurs qui ressemblent à un refus d'accès : on renvoie vers le réglage du jeton. */
const AUTH_ERROR = /\b(401|403|token|jeton|gated|unauthori[sz]ed|forbidden|restreint|restricted)\b/i;
const SETTINGS_HF_URL = '/parametres#huggingface';

const smallBtn = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border px-3 text-xs font-medium text-fg transition-[background-color,transform] duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';

// ---------- Formats ----------

/** Taille lisible (Mo / Go) selon la langue courante. @param {number} bytes */
function formatSize(bytes) {
  const nf = (/** @type {number} */ n) =>
    new Intl.NumberFormat(getLang(), { maximumFractionDigits: n >= 100 ? 0 : 1 }).format(n);
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${nf(gb)} ${t('settings.engine.unitGb')}`;
  return `${nf(bytes / 1024 ** 2)} ${t('settings.engine.unitMb')}`;
}

/** Compte compact (1,2 M). @param {number} n */
function formatCount(n) {
  return new Intl.NumberFormat(getLang(), { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
}

/** @param {string} path */
function baseName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** @param {string[]} files */
function partsText(files) {
  return t('chat.addModel.parts', { count: files.length });
}

/** @param {string} text @param {string} cls */
function span(text, cls) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** Lien vers Paramètres › Hugging Face (jeton). */
function buildTokenLink() {
  const a = document.createElement('a');
  a.href = SETTINGS_HF_URL;
  a.className = 'underline underline-offset-2 hover:opacity-80';
  a.textContent = t('chat.addModel.tokenLink');
  return a;
}

/** @param {HTMLElement} panel @param {string} text @param {boolean} [isError] @param {boolean} [hint] */
function setPanelMessage(panel, text, isError = false, hint = false) {
  const p = document.createElement('p');
  p.className = isError ? 'px-4 py-3 text-xs text-danger' : 'px-4 py-3 text-xs text-muted';
  p.textContent = text;
  if (hint) p.append(' ', buildTokenLink());
  panel.replaceChildren(p);
}

/**
 * Monte le navigateur de modèles dans un conteneur (marquage : AddModelDialog.astro, attributs data-hf).
 * @param {HTMLElement} root
 * @param {{ onChange?: () => void }} [opts] onChange : un modèle vient d'être installé ou chargé
 * @returns {{ open: () => void }}
 */
export function mountHfBrowser(root, { onChange } = {}) {
  /** @param {string} name */
  const q = (name) => /** @type {HTMLElement|null} */ (root.querySelector(`[data-hf="${name}"]`));
  /** @param {string} sel @param {ParentNode} from */
  const $ = (sel, from) => /** @type {HTMLElement} */ (from.querySelector(sel));

  const unavailableEl = q('unavailable');
  const errorEl = q('error');
  const errorTextEl = q('error-text');
  const errorHintEl = q('token-hint');
  const mainEl = q('main');
  const downloadsWrap = q('downloads-wrap');
  const downloadsEl = q('downloads');
  const tplDownload = /** @type {HTMLTemplateElement|null} */ (root.querySelector('template[data-hf="tpl-download"]'));
  const searchForm = q('search-form');
  const searchInput = /** @type {HTMLInputElement|null} */ (q('search-input'));
  const searchBtn = /** @type {HTMLButtonElement|null} */ (q('search-btn'));
  const searchStatusEl = q('search-status');
  const resultsEl = q('results');
  const resultsEmptyEl = q('results-empty');

  /** @param {string} msg @param {boolean} [hint] forcer l'affichage du lien vers le jeton */
  function showError(msg, hint = false) {
    if (!errorEl || !errorTextEl) return;
    errorTextEl.textContent = msg;
    errorEl.hidden = !msg;
    if (errorHintEl) errorHintEl.hidden = !msg || !(hint || AUTH_ERROR.test(msg));
  }

  /** Exécute une action en désactivant son bouton ; l'erreur va dans la zone d'erreur.
   * @param {HTMLButtonElement} btn @param {() => Promise<unknown>} fn */
  async function guarded(btn, fn) {
    showError('');
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      showError(errorMessage(e));
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Téléchargements ----------

  /** @type {Map<string, DownloadInfo>} */
  const downloads = new Map();
  /** @type {Map<string, HTMLElement>} */
  const rows = new Map();
  /** Zones d'action des fichiers affichés (mises à jour selon les téléchargements). @type {Set<FileActionRef>} */
  const fileActions = new Set();

  /** @param {HTMLElement} li @param {DownloadInfo} info */
  function updateRow(li, info) {
    const files = Array.isArray(info.files) ? info.files : [];
    const first = files[0] ? baseName(files[0]) : info.modelId;
    $('[data-dl-name]', li).textContent = files.length > 1 ? `${first} (${partsText(files)})` : first;
    $('[data-dl-repo]', li).textContent = info.repo;

    const bar = /** @type {HTMLProgressElement} */ ($('[data-dl-bar]', li));
    const total = info.totalBytes;
    const done = info.state === 'completed';
    if (typeof total === 'number' && total > 0) {
      bar.max = total;
      bar.setAttribute('value', String(done ? total : Math.min(info.downloadedBytes, total)));
    } else if (done) {
      bar.max = 1;
      bar.setAttribute('value', '1');
    } else {
      bar.removeAttribute('value');
    }

    let bytes = formatSize(info.downloadedBytes);
    if (typeof total === 'number' && total > 0) {
      const pct = Math.min(100, Math.floor((info.downloadedBytes / total) * 100));
      bytes = `${bytes} / ${formatSize(total)} (${pct} %)`;
    }
    $('[data-dl-bytes]', li).textContent = bytes;

    let state = '';
    if (info.state === 'downloading') {
      state = info.speedBps > 0 ? `${formatSize(info.speedBps)}/s` : t('chat.addModel.downloads.state.downloading');
    } else if (info.state === 'paused') state = t('chat.addModel.downloads.state.paused');
    else if (info.state === 'completed') state = t('chat.addModel.downloads.state.completed');
    else state = t('chat.addModel.downloads.state.error');
    $('[data-dl-state]', li).textContent = state;

    const errEl = $('[data-dl-error]', li);
    errEl.textContent = info.state === 'error' ? info.error || t('chat.addModel.downloads.state.error') : '';
    errEl.hidden = info.state !== 'error';

    $('[data-dl-use]', li).hidden = info.state !== 'completed';
    $('[data-dl-pause]', li).hidden = info.state !== 'downloading';
    $('[data-dl-resume]', li).hidden = info.state !== 'paused' && info.state !== 'error';
    $('[data-dl-cancel]', li).hidden = info.state === 'completed';
  }

  /** @param {string} id */
  function buildRow(id) {
    const frag = /** @type {DocumentFragment} */ (/** @type {HTMLTemplateElement} */ (tplDownload).content.cloneNode(true));
    const li = $('[data-dl]', frag);
    li.dataset.id = id;
    const pauseBtn = /** @type {HTMLButtonElement} */ ($('[data-dl-pause]', li));
    const resumeBtn = /** @type {HTMLButtonElement} */ ($('[data-dl-resume]', li));
    const cancelBtn = /** @type {HTMLButtonElement} */ ($('[data-dl-cancel]', li));
    const useBtn = /** @type {HTMLButtonElement} */ ($('[data-dl-use]', li));

    pauseBtn.addEventListener('click', () => guarded(pauseBtn, () => pauseDownload(id)));
    resumeBtn.addEventListener('click', () => guarded(resumeBtn, () => resumeDownload(id)));
    cancelBtn.addEventListener('click', async () => {
      const info = downloads.get(id);
      const ok = await confirmDialog({
        title: t('chat.addModel.downloads.cancelTitle'),
        message: t('chat.addModel.downloads.cancelMessage', { name: info && info.files[0] ? baseName(info.files[0]) : id }),
        confirmLabel: t('chat.addModel.downloads.cancel'),
        cancelLabel: t('chat.addModel.downloads.keep'),
      });
      if (!ok) return;
      await guarded(cancelBtn, async () => {
        await cancelDownload(id);
        removeDownload(id);
      });
    });
    useBtn.addEventListener('click', () => {
      const info = downloads.get(id);
      if (!info) return;
      const label = useBtn.textContent;
      useBtn.textContent = t('settings.engine.loading');
      guarded(useBtn, async () => {
        await useModel(info.modelId);
        if (onChange) onChange();
      }).finally(() => {
        useBtn.textContent = label;
      });
    });
    return li;
  }

  /** @param {DownloadInfo} info */
  function upsertDownload(info) {
    if (!downloadsEl || !downloadsWrap || !tplDownload || !info || typeof info.id !== 'string') return;
    const previous = downloads.get(info.id);
    downloads.set(info.id, info);
    let li = rows.get(info.id);
    if (!li) {
      li = buildRow(info.id);
      rows.set(info.id, li);
      downloadsEl.append(li);
    }
    updateRow(li, info);
    downloadsWrap.hidden = rows.size === 0;
    refreshFileActions();
    if (info.state === 'completed' && (!previous || previous.state !== 'completed') && onChange) onChange();
  }

  /** @param {string} id */
  function removeDownload(id) {
    downloads.delete(id);
    const li = rows.get(id);
    if (li) li.remove();
    rows.delete(id);
    if (downloadsWrap) downloadsWrap.hidden = rows.size === 0;
    refreshFileActions();
  }

  // ---------- Fichiers d'un dépôt ----------

  /** @param {FileActionRef} ref */
  function renderFileAction(ref) {
    const dl = downloads.get(ref.id);
    if (ref.installed || (dl && dl.state === 'completed')) {
      ref.el.replaceChildren(span(t('chat.addModel.files.installed'), 'rounded-full bg-fg/10 px-2 py-0.5 text-[11px] font-medium text-fg'));
      return;
    }
    if (dl) {
      let text = t('chat.addModel.downloads.state.error');
      if (dl.state === 'downloading') {
        text =
          typeof dl.totalBytes === 'number' && dl.totalBytes > 0
            ? `${Math.min(100, Math.floor((dl.downloadedBytes / dl.totalBytes) * 100))} %`
            : t('chat.addModel.downloads.state.downloading');
      } else if (dl.state === 'paused') text = t('chat.addModel.downloads.state.paused');
      ref.el.replaceChildren(span(text, 'text-xs text-muted'));
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = smallBtn;
    btn.textContent = t('chat.addModel.files.download');
    btn.addEventListener('click', () =>
      guarded(btn, async () => {
        await startDownload(ref.repo, ref.files);
        try {
          for (const d of await listDownloads()) upsertDownload(d);
        } catch {
          /* les événements prendront le relais */
        }
      }),
    );
    ref.el.replaceChildren(btn);
  }

  function refreshFileActions() {
    for (const ref of fileActions) {
      if (!ref.el.isConnected) {
        fileActions.delete(ref);
        continue;
      }
      renderFileAction(ref);
    }
  }

  /** @param {string} repo @param {HfFile} file */
  function buildFileItem(repo, file) {
    const li = document.createElement('li');
    li.className = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5';
    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    const head = document.createElement('div');
    head.className = 'flex min-w-0 items-center gap-2';
    head.append(span(file.name, 'min-w-0 truncate font-mono text-xs'));
    if (file.quant) head.append(span(file.quant, 'shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted'));
    const files = Array.isArray(file.files) ? file.files : [];
    const meta = files.length > 1 ? `${formatSize(file.sizeBytes)} · ${partsText(files)}` : formatSize(file.sizeBytes);
    info.append(head, span(meta, 'mt-0.5 block text-[11px] text-muted'));

    const action = document.createElement('div');
    action.className = 'flex shrink-0 items-center';
    li.append(info, action);
    /** @type {FileActionRef} */
    const ref = { id: `${repo}/${files[0]}`, repo, files, installed: file.installed, el: action };
    fileActions.add(ref);
    renderFileAction(ref);
    return li;
  }

  /** @param {HfRepo} repo @param {HTMLElement} panel */
  async function loadFiles(repo, panel) {
    setPanelMessage(panel, t('chat.addModel.files.loading'));
    try {
      const list = await listRepoFiles(repo.id);
      if (list.length === 0) {
        setPanelMessage(panel, t('chat.addModel.files.empty'));
        return true;
      }
      const ul = document.createElement('ul');
      ul.className = 'divide-y divide-border';
      ul.append(...list.map((f) => buildFileItem(repo.id, f)));
      panel.replaceChildren(ul);
      return true;
    } catch (e) {
      const msg = errorMessage(e);
      setPanelMessage(panel, msg, true, repo.gated || AUTH_ERROR.test(msg));
      return false;
    }
  }

  // ---------- Recherche ----------

  /** @param {HfRepo} repo */
  function buildResult(repo) {
    const li = document.createElement('li');
    const head = document.createElement('button');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.className = 'flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 aria-expanded:bg-fg/5 motion-reduce:transition-none';
    const info = document.createElement('span');
    info.className = 'min-w-0 flex-1';
    info.append(
      span(repo.id, 'block truncate font-mono text-sm'),
      span(
        t('chat.addModel.search.stats', { downloads: formatCount(repo.downloads), likes: formatCount(repo.likes) }),
        'mt-0.5 block text-xs text-muted',
      ),
    );
    head.append(info);
    if (repo.gated) head.append(span(t('chat.addModel.search.gated'), 'shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted'));

    const panel = document.createElement('div');
    panel.hidden = true;
    panel.className = 'border-t border-border';
    let loaded = false;
    let loading = false;
    head.addEventListener('click', async () => {
      const open = head.getAttribute('aria-expanded') !== 'true';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.hidden = !open;
      if (open && !loaded && !loading) {
        loading = true;
        loaded = await loadFiles(repo, panel);
        loading = false;
      }
    });
    li.append(head, panel);
    return li;
  }

  let searching = false;
  let searchSeq = 0;

  /** @param {string} query */
  async function runSearch(query) {
    if (!searchBtn || !searchInput || !resultsEl || !resultsEmptyEl || !searchStatusEl) return;
    if (searching) return;
    searching = true;
    const seq = ++searchSeq;
    showError('');
    searchBtn.disabled = true;
    searchInput.setAttribute('aria-busy', 'true');
    searchStatusEl.textContent = t('chat.addModel.search.loading');
    try {
      const list = await searchRepos(query);
      if (seq !== searchSeq) return;
      fileActions.clear();
      resultsEl.replaceChildren(...list.map(buildResult));
      resultsEl.hidden = list.length === 0;
      resultsEmptyEl.hidden = list.length > 0;
      searchStatusEl.textContent = query ? '' : t('chat.addModel.search.popular');
    } catch (e) {
      searchStatusEl.textContent = '';
      showError(errorMessage(e));
    } finally {
      searching = false;
      searchBtn.disabled = false;
      searchInput.removeAttribute('aria-busy');
    }
  }

  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(searchInput ? searchInput.value.trim() : '');
  });

  // ---------- Démarrage ----------

  let started = false;

  async function loadDownloads() {
    try {
      for (const d of await listDownloads()) upsertDownload(d);
    } catch (e) {
      showError(errorMessage(e));
    }
  }

  async function start() {
    started = true;
    if (!mainEl || !unavailableEl) return;
    if (!engineAvailable()) {
      unavailableEl.textContent = t('chat.engine.unavailable');
      unavailableEl.hidden = false;
      return;
    }
    mainEl.hidden = false;
    try {
      await onDownload(upsertDownload);
      await onDownloadRemoved((p) => {
        if (p && typeof p.id === 'string') removeDownload(p.id);
      });
    } catch (e) {
      showError(errorMessage(e));
    }
    await loadDownloads();
    runSearch('');
  }

  return {
    /** À appeler à chaque ouverture de la fenêtre : démarre la première fois, resynchronise ensuite. */
    open() {
      if (!started) {
        start();
        return;
      }
      if (engineAvailable()) loadDownloads();
    },
  };
}

/**
 * Branche le bouton « Ajouter un modèle » (data-action="add-model") sur la fenêtre #add-model-dialog.
 * @param {{ onChange?: () => void }} [opts] onChange : un modèle vient d'être installé ou chargé
 */
export function initAddModel({ onChange } = {}) {
  const dialog = /** @type {HTMLDialogElement|null} */ (document.getElementById('add-model-dialog'));
  const root = dialog && /** @type {HTMLElement|null} */ (dialog.querySelector('[data-hf="root"]'));
  const closeBtn = dialog && dialog.querySelector('[data-action="add-model-close"]');
  if (!dialog || !root) return;
  /** @type {{ open: () => void }|null} */
  let browser = null;

  for (const btn of document.querySelectorAll('[data-action="add-model"]')) {
    btn.addEventListener('click', () => {
      if (!browser) browser = mountHfBrowser(root, { onChange });
      dialog.showModal();
      browser.open();
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}
