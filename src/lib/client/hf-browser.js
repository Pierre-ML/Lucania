// Navigateur de modèles Hugging Face (fenêtre « Ajouter un modèle ») : recherche, fichiers GGUF, téléchargements.
// Le jeton se règle dans Paramètres › Hugging Face (hf-settings.js).
import { confirmDialog } from './dialog.js';
import { engineAvailable, useModel } from './engine.js';
import {
  buildFitBadge,
  describeProfile,
  estimateFit,
  estimateFitAsync,
  formatBytes,
  getHardwareProfile,
  onHardwareChange,
} from './hardware.js';
import {
  cancelDownload,
  checkFile,
  errorMessage,
  getAvatars,
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
/** @typedef {import('./hf.js').HfFileCheck} HfFileCheck */
/** @typedef {import('./hardware.js').HardwareProfile} HardwareProfile */
/**
 * Un fichier affiché : zone d'action + éléments mis à jour par la vérification et le profil matériel.
 * @typedef {{
 *   id: string, repo: string, files: string[], installed: boolean, sizeBytes: number, annexHint: boolean,
 *   li: HTMLElement, el: HTMLElement, detailEl: HTMLElement, fitEl: HTMLElement, annexEl: HTMLElement, errorEl: HTMLElement,
 *   state: 'idle'|'queued'|'running'|'done'|'failed', result: HfFileCheck|null,
 *   fit: import('./hardware.js').Fit|null
 * }} FileActionRef
 */
/** @typedef {{ ul: HTMLElement, note: HTMLElement, repoBadge: HTMLElement, refs: FileActionRef[] }} FileGroup */

/** Erreurs qui ressemblent à un refus d'accès : on renvoie vers le réglage du jeton. */
const AUTH_ERROR = /\b(401|403|token|jeton|gated|unauthori[sz]ed|forbidden|restreint|restricted)\b/i;
const SETTINGS_HF_URL = '/parametres#huggingface';

/** Familles de modèles proposées en puces : org = auteur Hugging Face (avatar), query = recherche lancée au clic. */
const FAMILIES = [
  { name: 'Qwen', org: 'Qwen', query: 'qwen' },
  { name: 'Llama', org: 'meta-llama', query: 'llama' },
  { name: 'Mistral', org: 'mistralai', query: 'mistral' },
  { name: 'Gemma', org: 'google', query: 'gemma' },
  { name: 'Phi', org: 'microsoft', query: 'phi' },
  { name: 'DeepSeek', org: 'deepseek-ai', query: 'deepseek' },
  { name: 'GPT-OSS', org: 'openai', query: 'gpt-oss' },
];

const HIDE_TOO_BIG_KEY = 'hideTooBigModels';
const AVATAR_BATCH = 30;
const CHECK_PARALLEL = 2;

// ---------- Avatars (cache de session partagé entre les ouvertures de la fenêtre) ----------

/** Nom d'auteur -> data URL, ou null si pas d'avatar. @type {Map<string, string|null>} */
const avatarCache = new Map();
/** Noms déjà demandés (en cours ou terminés). @type {Set<string>} */
const avatarAsked = new Set();
/** Pastilles en attente d'une image. @type {Map<string, Set<HTMLElement>>} */
const avatarSlots = new Map();

/** @param {HTMLElement} slot @param {string|null|undefined} url */
function fillAvatar(slot, url) {
  if (!url || !url.startsWith('data:image/')) return;
  const img = document.createElement('img');
  img.alt = '';
  img.src = url;
  img.className = 'size-full object-cover';
  slot.replaceChildren(img);
}

/**
 * Pastille ronde : initiale en attendant (ou à défaut) de l'avatar.
 * @param {string} name auteur / organisation
 * @param {boolean} big 28 px au lieu de 20 px
 */
function buildAvatar(name, big) {
  const slot = document.createElement('span');
  slot.setAttribute('aria-hidden', 'true');
  slot.className = big
    ? 'flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-fg/10 text-xs font-medium uppercase text-muted'
    : 'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-fg/10 text-[10px] font-medium uppercase text-muted';
  slot.textContent = (name.trim()[0] || '?').toUpperCase();
  if (avatarCache.has(name)) {
    fillAvatar(slot, avatarCache.get(name));
  } else {
    let set = avatarSlots.get(name);
    if (!set) avatarSlots.set(name, (set = new Set()));
    set.add(slot);
  }
  return slot;
}

/** Demande par lots les avatars pas encore connus ; les pastilles se remplissent à l'arrivée. @param {string[]} names */
async function requestAvatars(names) {
  const todo = [...new Set(names)].filter((n) => n && !avatarAsked.has(n));
  for (const n of todo) avatarAsked.add(n);
  for (let i = 0; i < todo.length; i += AVATAR_BATCH) {
    const batch = todo.slice(i, i + AVATAR_BATCH);
    getAvatars(batch)
      .then((map) => {
        for (const n of batch) {
          const url = typeof map[n] === 'string' ? map[n] : null;
          avatarCache.set(n, url);
          const slots = avatarSlots.get(n);
          if (slots) for (const s of slots) fillAvatar(s, url);
          avatarSlots.delete(n);
        }
      })
      .catch(() => {
        for (const n of batch) avatarAsked.delete(n); // réseau : on réessaiera à la prochaine recherche
      });
  }
}

const smallBtn = 'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border px-3 text-xs font-medium text-fg transition-[background-color,transform] duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';

// ---------- Formats ----------

/** Compte compact (1,2 M). @param {number} n */
function formatCount(n) {
  return new Intl.NumberFormat(getLang(), { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
}

/** Temps restant lisible (« ~2 min 30 s restantes »), ou '' si inconnu. @param {DownloadInfo} info */
function formatEta(info) {
  const total = info.totalBytes;
  if (typeof total !== 'number' || total <= 0 || !(info.speedBps > 0)) return '';
  const left = Math.max(0, total - info.downloadedBytes);
  const secs = Math.max(1, Math.round(left / info.speedBps));
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    return t('chat.addModel.downloads.etaHours', { h, m });
  }
  if (secs >= 60) return t('chat.addModel.downloads.etaMinutes', { m: Math.floor(secs / 60), s: secs % 60 });
  return t('chat.addModel.downloads.etaSeconds', { s: secs });
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
function mountHfBrowser(root, { onChange } = {}) {
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
  const familiesEl = q('families');
  const profileTextEl = q('profile-text');
  const hideTooBigEl = /** @type {HTMLInputElement|null} */ (q('hide-toobig'));

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

    let bytes = formatBytes(info.downloadedBytes);
    if (typeof total === 'number' && total > 0) {
      const pct = Math.min(100, Math.floor((info.downloadedBytes / total) * 100));
      bytes = `${bytes} / ${formatBytes(total)} (${pct} %)`;
    }
    $('[data-dl-bytes]', li).textContent = bytes;

    let state = '';
    if (info.state === 'downloading') {
      state = info.speedBps > 0 ? `${formatBytes(info.speedBps)}/s` : t('chat.addModel.downloads.state.downloading');
      const eta = formatEta(info);
      if (eta) state += ` · ${eta}`;
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
      ref.errorEl.hidden = true;
      let text = t('chat.addModel.downloads.state.error');
      if (dl.state === 'downloading' || dl.state === 'paused') {
        // Vraie barre de progression + pourcentage + vitesse + temps restant, sans remonter à la section des téléchargements.
        const known = typeof dl.totalBytes === 'number' && dl.totalBytes > 0;
        const wrap = document.createElement('div');
        wrap.className = 'flex w-44 flex-col gap-1';
        const bar = document.createElement('progress');
        bar.className = 'progress h-1.5 w-full text-fg';
        if (known) {
          bar.max = /** @type {number} */ (dl.totalBytes);
          bar.setAttribute('value', String(Math.min(dl.downloadedBytes, /** @type {number} */ (dl.totalBytes))));
        }
        const pct = known ? `${Math.min(100, Math.floor((dl.downloadedBytes / /** @type {number} */ (dl.totalBytes)) * 100))} %` : '';
        const bits = [];
        if (dl.state === 'paused') bits.push(t('chat.addModel.downloads.state.paused'));
        if (pct) bits.push(pct);
        if (dl.state === 'downloading') {
          if (dl.speedBps > 0) bits.push(`${formatBytes(dl.speedBps)}/s`);
          else if (!pct) bits.push(t('chat.addModel.downloads.state.downloading'));
        }
        wrap.append(bar, span(bits.join(' · '), 'text-xs text-muted'));
        if (dl.state === 'downloading') {
          const eta = formatEta(dl);
          if (eta) wrap.append(span(eta, 'text-[11px] text-muted'));
        }
        ref.el.replaceChildren(wrap);
        return;
      }
      ref.el.replaceChildren(span(text, 'text-xs text-muted'));
      return;
    }
    if (ref.result && !ref.result.standalone) {
      ref.el.replaceChildren(span(t('chat.addModel.files.notStandalone'), 'text-xs text-muted'));
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = smallBtn;
    if (ref.fit === 'too-big') {
      btn.textContent = t('chat.addModel.files.downloadTooBig');
      btn.title = t('chat.addModel.files.downloadTooBigHint');
    } else {
      btn.textContent = t('chat.addModel.files.download');
    }
    btn.addEventListener('click', async () => {
      // L'erreur (ex. fichier non autonome refusé par le serveur) s'affiche dans la ligne du fichier.
      ref.errorEl.hidden = true;
      btn.disabled = true;
      try {
        await startDownload(ref.repo, ref.files);
        try {
          for (const d of await listDownloads()) upsertDownload(d);
        } catch {
          /* les événements prendront le relais */
        }
      } catch (e) {
        ref.errorEl.textContent = errorMessage(e);
        ref.errorEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });
    ref.el.replaceChildren(btn);
  }

  // ---------- Vérification des fichiers annexes (file d'attente, 2 à la fois) ----------

  /** Résultats déjà obtenus (clé = id du fichier). @type {Map<string, HfFileCheck>} */
  const checkCache = new Map();
  /** @type {FileActionRef[]} */
  let checkQueue = [];
  let checkRunning = 0;

  /** Ligne de détail sous la taille : « Vérification… », raison du refus, ou paramètres / contexte. @param {FileActionRef} ref */
  function renderDetail(ref) {
    const res = ref.result;
    let text = '';
    if (ref.state === 'queued' || ref.state === 'running') {
      text = t('chat.addModel.files.checking');
    } else if (res && !res.standalone) {
      text = res.reason || '';
    } else if (res) {
      const nf = new Intl.NumberFormat(getLang(), { maximumFractionDigits: 1 });
      const bits = [];
      if (typeof res.paramCount === 'number' && res.paramCount > 0) {
        const p = res.paramCount;
        bits.push(p >= 1e9 ? `${nf.format(p / 1e9)} B` : `${nf.format(p / 1e6)} M`);
      }
      if (typeof res.contextLength === 'number' && res.contextLength > 0) {
        bits.push(t('chat.addModel.files.contextTokens', { n: new Intl.NumberFormat(getLang()).format(res.contextLength) }));
      }
      text = bits.join(' · ');
    }
    ref.detailEl.textContent = text;
    ref.detailEl.hidden = !text;
    // Le badge « Annexe probable » ne sert que tant que la vérification n'a pas tranché.
    ref.annexEl.hidden = !ref.annexHint || ref.result !== null;
    updateDim(ref);
  }

  /** Ligne atténuée : fichier non autonome ou trop gros pour cette machine. @param {FileActionRef} ref */
  function updateDim(ref) {
    ref.li.classList.toggle('opacity-60', Boolean((ref.result && !ref.result.standalone) || ref.fit === 'too-big'));
  }

  /** @param {FileActionRef} ref */
  async function runCheck(ref) {
    checkRunning++;
    ref.state = 'running';
    renderDetail(ref);
    try {
      const res = await checkFile(ref.repo, ref.files);
      if (res && typeof res.standalone === 'boolean') {
        ref.result = res;
        ref.state = 'done';
        checkCache.set(ref.id, res);
      } else {
        ref.state = 'failed';
      }
    } catch {
      ref.state = 'failed'; // réseau : le bouton reste actif, le serveur revérifiera au téléchargement
    } finally {
      checkRunning--;
      renderDetail(ref);
      renderFileAction(ref);
      if (ref.result) applyFit(ref); // la méta d'architecture affine le badge
      pumpChecks();
    }
  }

  function pumpChecks() {
    while (checkRunning < CHECK_PARALLEL && checkQueue.length > 0) {
      const ref = /** @type {FileActionRef} */ (checkQueue.shift());
      if (!ref.li.isConnected || ref.li.hidden) {
        ref.state = 'idle'; // masqué ou disparu : sera relancé s'il redevient visible
        renderDetail(ref);
        continue;
      }
      runCheck(ref);
    }
  }

  /** Met en file les fichiers pas encore vérifiés, ceux qui ont un indice d'annexe d'abord. @param {FileActionRef[]} refs */
  function enqueueChecks(refs) {
    const todo = refs.filter((r) => r.state === 'idle' && !r.li.hidden && !r.installed);
    todo.sort((a, b) => Number(b.annexHint) - Number(a.annexHint));
    for (const r of todo) {
      r.state = 'queued';
      renderDetail(r);
    }
    checkQueue.push(...todo);
    pumpChecks();
  }

  // ---------- Compatibilité avec le matériel ----------

  /** @type {HardwareProfile|null} */
  let profile = null;
  let hideTooBig = false;
  try {
    hideTooBig = localStorage.getItem(HIDE_TOO_BIG_KEY) === '1';
  } catch {
    /* stockage indisponible */
  }
  if (hideTooBigEl) hideTooBigEl.checked = hideTooBig;

  /** Groupes de fichiers affichés (un par dépôt déplié). @type {Set<FileGroup>} */
  const groups = new Set();

  function renderProfile() {
    if (!profileTextEl) return;
    profileTextEl.textContent = t('chat.addModel.profile.label', {
      profile: profile ? describeProfile(profile) : t('common.hardware.detecting'),
    });
  }

  /** Jeton par fichier : seule la dernière demande d'estimation a le droit d'écrire le badge. @type {WeakMap<FileActionRef, number>} */
  const fitTokens = new WeakMap();

  /** Affiche le badge et masque éventuellement le fichier. @param {FileActionRef} ref @param {import('./hardware.js').Fit} fit */
  function showFit(ref, fit) {
    const before = ref.fit;
    ref.fit = fit;
    const badge = buildFitBadge(fit);
    if (fit === 'too-big') {
      // Bien visible : pastille danger pleine taille, avec icône.
      badge.className = 'inline-flex shrink-0 items-center gap-1 rounded-full border border-danger bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger';
      badge.textContent = `⚠ ${t('chat.addModel.files.tooBigBadge')}`;
    }
    ref.fitEl.replaceChildren(badge);
    const dl = downloads.get(ref.id);
    const keep = ref.installed || (dl && dl.state === 'completed');
    ref.li.hidden = hideTooBig && fit === 'too-big' && !keep;
    updateDim(ref);
    if (before !== fit) {
      renderFileAction(ref); // libellé du bouton Télécharger
      const g = [...groups].find((x) => x.refs.includes(ref));
      if (g) updateGroup(g);
    }
  }

  /** Avertissement « tous trop gros » sur le dépôt et note « tout masqué ». @param {FileGroup} g */
  function updateGroup(g) {
    g.note.hidden = !g.refs.every((r) => r.li.hidden);
    g.repoBadge.hidden = !g.refs.every((r) => r.fit === 'too-big');
  }

  /**
   * Badge de compatibilité + masquage éventuel des fichiers trop gros.
   * Estimation grossière tout de suite, puis précise (méta de la vérification) quand elle arrive.
   * @param {FileActionRef} ref
   */
  function applyFit(ref) {
    const token = (fitTokens.get(ref) || 0) + 1;
    fitTokens.set(ref, token);
    const current = profile;
    if (!current || !current.known) {
      ref.fitEl.replaceChildren();
      ref.li.hidden = false;
      ref.fit = null;
      updateDim(ref);
      const g0 = [...groups].find((x) => x.refs.includes(ref));
      if (g0) updateGroup(g0);
      return;
    }
    showFit(ref, estimateFit(ref.sizeBytes, current));
    const meta = /** @type {any} */ (ref.result)?.meta || undefined;
    if (!meta) return; // sans méta, l'estimation grossière est la seule disponible
    estimateFitAsync({ sizeBytes: ref.sizeBytes, meta }, current).then((fit) => {
      if (fitTokens.get(ref) !== token || profile !== current) return; // réponse périmée
      showFit(ref, fit);
      const g = [...groups].find((x) => x.refs.includes(ref));
      if (g) updateGroup(g);
    });
  }

  function applyAllFits() {
    for (const g of groups) {
      if (!g.ul.isConnected) {
        groups.delete(g);
        continue;
      }
      for (const ref of g.refs) applyFit(ref);
      updateGroup(g);
      enqueueChecks(g.refs); // les fichiers redevenus visibles sont vérifiés à leur tour
    }
  }

  onHardwareChange(async () => {
    profile = await getHardwareProfile();
    renderProfile();
    applyAllFits();
  });

  hideTooBigEl?.addEventListener('change', () => {
    hideTooBig = hideTooBigEl.checked;
    try {
      localStorage.setItem(HIDE_TOO_BIG_KEY, hideTooBig ? '1' : '0');
    } catch {
      /* stockage indisponible : le choix vaut pour cette session */
    }
    applyAllFits();
  });

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
    const fitEl = document.createElement('span');
    fitEl.className = 'flex shrink-0 items-center';
    const annexEl = span(t('chat.addModel.files.annex'), 'shrink-0 rounded-full border border-amber-500/40 px-2 py-0.5 text-[11px] font-medium text-amber-500');
    annexEl.title = t('chat.addModel.files.annexHint');
    annexEl.hidden = !file.annexHint;
    head.append(annexEl, fitEl);
    const files = Array.isArray(file.files) ? file.files : [];
    const meta = files.length > 1 ? `${formatBytes(file.sizeBytes)} · ${partsText(files)}` : formatBytes(file.sizeBytes);
    const detailEl = span('', 'mt-0.5 block text-[11px] text-muted');
    detailEl.hidden = true;
    info.append(head, span(meta, 'mt-0.5 block text-[11px] text-muted'), detailEl);

    const action = document.createElement('div');
    action.className = 'flex shrink-0 items-center';
    const errorEl = document.createElement('p');
    errorEl.hidden = true;
    errorEl.setAttribute('role', 'alert');
    errorEl.className = 'basis-full text-xs text-danger';
    li.append(info, action, errorEl);
    const id = `${repo}/${files[0]}`;
    const cached = checkCache.get(id) || null;
    /** @type {FileActionRef} */
    const ref = {
      id,
      repo,
      files,
      installed: file.installed,
      sizeBytes: file.sizeBytes,
      annexHint: Boolean(file.annexHint),
      li,
      el: action,
      detailEl,
      fitEl,
      annexEl,
      errorEl,
      state: cached ? 'done' : 'idle',
      result: cached,
      fit: null,
    };
    fileActions.add(ref);
    applyFit(ref);
    renderDetail(ref);
    renderFileAction(ref);
    return ref;
  }

  /** @param {HfRepo} repo @param {HTMLElement} panel @param {HTMLElement} repoBadge */
  async function loadFiles(repo, panel, repoBadge) {
    setPanelMessage(panel, t('chat.addModel.files.loading'));
    try {
      const list = await listRepoFiles(repo.id);
      if (list.length === 0) {
        setPanelMessage(panel, t('chat.addModel.files.empty'));
        return true;
      }
      const ul = document.createElement('ul');
      ul.className = 'divide-y divide-border';
      const refs = list.map((f) => buildFileItem(repo.id, f));
      ul.append(...refs.map((r) => r.li));
      const note = document.createElement('p');
      note.className = 'px-4 py-3 text-xs text-muted';
      note.textContent = t('chat.addModel.files.allHidden');
      note.hidden = !refs.every((r) => r.li.hidden);
      panel.replaceChildren(ul, note);
      /** @type {FileGroup} */
      const group = { ul, note, repoBadge, refs };
      groups.add(group);
      updateGroup(group);
      enqueueChecks(refs);
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
    const author = repo.author || repo.id.split('/')[0] || '';
    const info = document.createElement('span');
    info.className = 'min-w-0 flex-1';
    info.append(
      span(repo.id, 'block truncate font-mono text-sm'),
      span(
        t('chat.addModel.search.stats', { downloads: formatCount(repo.downloads), likes: formatCount(repo.likes) }),
        'mt-0.5 block text-xs text-muted',
      ),
    );
    head.append(buildAvatar(author, true), info);
    // Visible dès que les fichiers sont connus et tous trop gros (les tailles ne viennent qu'avec les fichiers).
    const repoBadge = span(`⚠ ${t('chat.addModel.files.tooBigRepo')}`, 'shrink-0 rounded-full border border-danger bg-danger/10 px-2.5 py-1 text-xs font-semibold text-danger');
    repoBadge.title = t('chat.addModel.files.tooBigRepoHint');
    repoBadge.hidden = true;
    head.append(repoBadge);
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
        loaded = await loadFiles(repo, panel, repoBadge);
        loading = false;
      }
    });
    li.append(head, panel);
    return li;
  }

  let searchSeq = 0;

  /** @type {HTMLButtonElement[]} */
  const chips = [];

  /** Marque la puce de famille active (ou aucune). @param {HTMLButtonElement|null} active */
  function setActiveChip(active) {
    for (const c of chips) c.setAttribute('aria-pressed', c === active ? 'true' : 'false');
  }

  function buildChips() {
    if (!familiesEl) return;
    for (const fam of FAMILIES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', 'false');
      btn.className = 'inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border pl-1.5 pr-3 text-xs font-medium text-fg transition-[background-color,transform] duration-150 hover:bg-fg/5 aria-pressed:border-fg aria-pressed:bg-fg/10 focus-visible:outline-fg/40 active:scale-[0.97] motion-reduce:transition-none';
      btn.append(buildAvatar(fam.org, false), span(fam.name, ''));
      btn.addEventListener('click', () => {
        const wasActive = btn.getAttribute('aria-pressed') === 'true';
        setActiveChip(wasActive ? null : btn);
        const query = wasActive ? '' : fam.query;
        if (searchInput) searchInput.value = query;
        runSearch(query);
      });
      chips.push(btn);
      familiesEl.append(btn);
    }
    requestAvatars(FAMILIES.map((f) => f.org));
  }

  searchInput?.addEventListener('input', () => setActiveChip(null));

  /** @param {string} query */
  async function runSearch(query) {
    if (!searchBtn || !searchInput || !resultsEl || !resultsEmptyEl || !searchStatusEl) return;
    const seq = ++searchSeq; // une recherche plus récente remplace la précédente
    showError('');
    searchBtn.disabled = true;
    searchInput.setAttribute('aria-busy', 'true');
    searchStatusEl.textContent = t('chat.addModel.search.loading');
    try {
      const list = await searchRepos(query);
      if (seq !== searchSeq) return;
      fileActions.clear();
      groups.clear();
      resultsEl.replaceChildren(...list.map(buildResult));
      resultsEl.hidden = list.length === 0;
      resultsEmptyEl.hidden = list.length > 0;
      searchStatusEl.textContent = query ? '' : t('chat.addModel.search.popular');
      requestAvatars(list.map((r) => r.author || r.id.split('/')[0] || ''));
    } catch (e) {
      if (seq !== searchSeq) return;
      searchStatusEl.textContent = '';
      showError(errorMessage(e));
    } finally {
      if (seq === searchSeq) {
        searchBtn.disabled = false;
        searchInput.removeAttribute('aria-busy');
      }
    }
  }

  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    setActiveChip(null);
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
    buildChips();
    renderProfile();
    // La détection peut prendre un moment : la recherche ne l'attend pas, les badges arrivent ensuite.
    getHardwareProfile()
      .then((p) => {
        profile = p;
        renderProfile();
        applyAllFits();
      })
      .catch(() => {});
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
