// Page /connexion : assistant guidé (4 étapes) ou mode avancé (3 sections libres).
// Les sections (Accès distant, Connexions, Extinction) ne sont rendues qu'une fois ; ce module les montre ou les masque.
// Leur comportement reste dans remote-settings.js, connections-settings.js et shutdown-settings.js.
import { listConnections } from './connections.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import { getRemoteConfig, getRemoteState, getServerConfig } from './remote.js';

const MODE_KEY = 'lucania.connect.mode';
const ROLE_KEY = 'lucania.connect.role';
const STEP_KEY = 'lucania.connect.step';

const STEP_COUNT = 4;
const STEP_REMOTE = 2;
const STEP_SHUTDOWN = 3;
const STEP_RECAP = 4;

/** Onglet (hash d'URL) vers la section affichée. */
const TAB_SECTIONS = /** @type {Record<string, string>} */ ({
  'acces-distant': 'remote',
  connexions: 'connections',
  extinction: 'shutdown',
});
const DEFAULT_TAB = 'acces-distant';

/** Carte de la section « Accès distant » à garder pour chaque rôle (mode guidé). */
const ROLE_CARD = /** @type {Record<string, string>} */ ({ tower: 'server', laptop: 'client' });

/** @param {'local'|'session'} area @param {string} key */
function readStore(area, key) {
  try {
    return (area === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

/** @param {'local'|'session'} area @param {string} key @param {string} value */
function writeStore(area, key, value) {
  try {
    (area === 'local' ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    // Stockage indisponible : le choix n'est pas mémorisé.
  }
}

/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement[]} */
const $$ = (sel, root = document) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);
/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement|null} */
const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));

/** @param {unknown} e */
function messageOf(e) {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return t('settings.server.errors.generic');
}

export function initConnexionPage() {
  const page = $('[data-connect-page]');
  if (!page) return;

  /** @type {{ mode: 'guided'|'advanced', step: number, role: 'tower'|'laptop'|null, tab: string }} */
  const state = {
    mode: readStore('local', MODE_KEY) === 'advanced' ? 'advanced' : 'guided',
    step: 1,
    role: null,
    tab: DEFAULT_TAB,
  };
  const storedRole = readStore('local', ROLE_KEY);
  if (storedRole === 'tower' || storedRole === 'laptop') state.role = storedRole;
  const storedStep = Number(readStore('session', STEP_KEY));
  if (Number.isInteger(storedStep) && storedStep >= 1 && storedStep <= STEP_COUNT) state.step = storedStep;
  if (!state.role) state.step = 1;

  function tabFromHash() {
    let id = '';
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      id = '';
    }
    return Object.hasOwn(TAB_SECTIONS, id) ? id : null;
  }
  state.tab = tabFromHash() ?? DEFAULT_TAB;

  // ---- Affichage ----

  function render() {
    const guided = state.mode === 'guided';

    for (const el of $$('[data-view="guided"]')) el.hidden = !guided;
    for (const el of $$('[data-view="advanced"]')) el.hidden = guided;
    for (const btn of $$('[data-mode-btn]')) btn.setAttribute('aria-checked', String(btn.dataset.modeBtn === state.mode));

    // Pendant la configuration du serveur, le choix de mode est masqué
    for (const el of $$('[data-mode-switch]')) el.hidden = state.mode === 'guided' && state.step === STEP_REMOTE && state.role === 'tower';

    // Sections visibles
    /** @type {Set<string>} */
    const visible = new Set();
    if (guided) {
      if (state.step === STEP_REMOTE) visible.add('remote');
      if (state.step === STEP_SHUTDOWN) {
        visible.add('connections');
        visible.add('shutdown');
      }
    } else {
      visible.add(TAB_SECTIONS[state.tab]);
    }
    for (const el of $$('[data-sec]')) el.hidden = !visible.has(el.dataset.sec ?? '');

    // Accès distant : en guidé, seulement la carte du rôle choisi (ni guide WireGuard, ni titre de section)
    const keepCard = state.role ? ROLE_CARD[state.role] : null;
    for (const el of $$('[data-remote-card]')) {
      const kind = el.dataset.remoteCard;
      el.hidden = guided && (kind === 'guide' || (keepCard !== null && kind !== keepCard));
    }
    for (const el of $$('[data-remote-head]')) el.hidden = guided;

    // Mode avancé : onglet courant
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === state.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }

    // Mode guidé : étapes, rôle, boutons
    for (const el of $$('[data-step]')) el.hidden = Number(el.dataset.step) !== state.step;
    for (const el of $$('[data-step-item]')) {
      const n = Number(el.dataset.stepItem);
      if (n === state.step) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
      el.dataset.done = String(n < state.step);
    }
    const counter = $('[data-step-counter]');
    if (counter) counter.textContent = t('connect.steps.counter', { current: state.step, total: STEP_COUNT });
    for (const btn of $$('[data-role-btn]')) btn.setAttribute('aria-checked', String(btn.dataset.roleBtn === state.role));
    for (const el of $$('[data-role-show]')) el.hidden = el.dataset.roleShow !== state.role;

    const prev = $('[data-wiz="prev"]');
    const skip = $('[data-wiz="skip"]');
    const next = /** @type {HTMLButtonElement|null} */ ($('[data-wiz="next"]'));
    const finish = $('[data-wiz="finish"]');
    if (prev) prev.hidden = state.step === 1;
    if (skip) skip.hidden = state.step !== STEP_SHUTDOWN;
    if (next) {
      next.hidden = state.step === STEP_RECAP;
      next.disabled = state.step === 1 && !state.role;
    }
    if (finish) finish.hidden = state.step !== STEP_RECAP;

    page.dataset.ready = 'true';
  }

  // ---- Navigation ----

  /** @param {number} n @param {boolean} [focus] */
  function goStep(n, focus = true) {
    let step = Math.min(Math.max(n, 1), STEP_COUNT);
    if (step > 1 && !state.role) step = 1;
    state.step = step;
    writeStore('session', STEP_KEY, String(step));
    render();
    if (step === STEP_RECAP) refreshRecap();
    if (focus) $$(`[data-step="${step}"] [data-step-heading]`).find((h) => !h.closest('[hidden]'))?.focus();
  }

  /** @param {'guided'|'advanced'} mode */
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    writeStore('local', MODE_KEY, mode);
    if (mode === 'advanced') state.tab = tabFromHash() ?? state.tab;
    render();
    if (mode === 'guided' && state.step === STEP_RECAP) refreshRecap();
  }

  /** @param {'tower'|'laptop'} role */
  function setRole(role) {
    state.role = role;
    writeStore('local', ROLE_KEY, role);
    render();
  }

  for (const btn of $$('[data-mode-btn]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.modeBtn === 'advanced' ? 'advanced' : 'guided'));
  }
  for (const btn of $$('[data-role-btn]')) {
    btn.addEventListener('click', () => setRole(btn.dataset.roleBtn === 'tower' ? 'tower' : 'laptop'));
  }
  $('[data-wiz="prev"]')?.addEventListener('click', () => goStep(state.step - 1));
  $('[data-wiz="next"]')?.addEventListener('click', () => goStep(state.step + 1));
  $('[data-wiz="skip"]')?.addEventListener('click', () => goStep(STEP_RECAP));
  $('[data-wiz="advanced"]')?.addEventListener('click', () => setMode('advanced'));
  $('[data-wiz="finish"]')?.addEventListener('click', () => writeStore('session', STEP_KEY, '1'));

  window.addEventListener('hashchange', () => {
    const id = tabFromHash();
    if (!id) return;
    state.tab = id;
    if (state.mode === 'advanced') render();
  });

  // Mode guidé : un lien interne (#connexions…) fait défiler jusqu'à la section si elle est affichée.
  document.addEventListener('click', (e) => {
    if (state.mode !== 'guided' || !(e.target instanceof Element)) return;
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const id = link.getAttribute('href')?.slice(1) ?? '';
    if (!Object.hasOwn(TAB_SECTIONS, id)) return;
    const section = TAB_SECTIONS[id];
    e.preventDefault();
    const target = $(`[data-sec="${section}"]`);
    if (target && !target.hidden) target.scrollIntoView();
  });

  // ---- Récapitulatif ----

  let recapToken = 0;

  /** @param {string} name @param {string} text @param {boolean} [bad] */
  function setRecap(name, text, bad = false) {
    const el = $(`[data-recap="${name}"]`);
    if (!el) return;
    el.textContent = text;
    el.dataset.bad = String(bad);
  }

  async function refreshRecap() {
    const token = ++recapToken;
    const live = () => token === recapToken;
    const available = engineAvailable();
    const showServer = state.role !== 'laptop';
    const showClient = state.role !== 'tower';

    const serverRow = $('[data-recap-row="server"]');
    const clientRow = $('[data-recap-row="client"]');
    const note = $('[data-recap="unavailable"]');
    if (serverRow) serverRow.hidden = !available || !showServer;
    if (clientRow) clientRow.hidden = !available || !showClient;
    if (note) {
      note.hidden = available;
      note.textContent = available ? '' : t('chat.engine.unavailable');
    }

    const loading = t('connect.recap.loading');
    setRecap('role', state.role ? t(`connect.recap.role.${state.role}`) : t('connect.recap.role.none'));
    setRecap('server', loading);
    setRecap('client', loading);
    setRecap('shutdown', loading);

    /** @type {Promise<void>[]} */
    const tasks = [];

    if (available && showServer) {
      tasks.push(
        getServerConfig().then(
          (cfg) => {
            if (!live()) return;
            if (cfg.running) setRecap('server', t('connect.recap.server.running', { address: cfg.address ?? '' }));
            else if (cfg.error) setRecap('server', t('connect.recap.server.error', { error: cfg.error }), true);
            else setRecap('server', t('connect.recap.server.off'));
          },
          (e) => {
            if (live()) setRecap('server', messageOf(e), true);
          },
        ),
      );
    }

    if (available && showClient) {
      tasks.push(
        getRemoteConfig()
          .then(async (cfg) => {
            if (cfg.mode !== 'remote') {
              if (live()) setRecap('client', t('connect.recap.client.none'));
              return;
            }
            const url = cfg.url || '';
            const remote = await getRemoteState().catch(() => null);
            if (!live()) return;
            if (remote?.connected) setRecap('client', t('connect.recap.client.connected', { url }));
            else if (remote?.error) setRecap('client', t('connect.recap.client.unreachableError', { url, error: remote.error }), true);
            else setRecap('client', t('connect.recap.client.unreachable', { url }), true);
          })
          .catch((e) => {
            if (live()) setRecap('client', messageOf(e), true);
          }),
      );
    }

    tasks.push(
      listConnections().then(
        (list) => {
          if (!live()) return;
          const count = list.filter((c) => c.shutdown?.enabled).length;
          setRecap('shutdown', t('connect.recap.shutdown.count', { count }));
        },
        () => {
          if (live()) setRecap('shutdown', t('connect.recap.shutdown.error'), true);
        },
      ),
    );

    await Promise.all(tasks);
  }

  // ---- Démarrage ----

  render();
  if (state.step === STEP_RECAP) refreshRecap();

  // Rôle encore inconnu : on le déduit de la configuration existante (tour active ou tour utilisée).
  if (!state.role && engineAvailable()) {
    (async () => {
      try {
        const server = await getServerConfig();
        if (state.role) return;
        if (server.active || server.running) {
          state.role = 'tower';
        } else {
          const remote = await getRemoteConfig();
          if (state.role) return;
          if (remote.mode === 'remote') state.role = 'laptop';
        }
        if (state.role) render();
      } catch {
        // Aucune indication : l'utilisateur choisit lui-même.
      }
    })();
  }
}
