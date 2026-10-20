// Page /connexion : une machine n'a qu'UN rôle, serveur (tour) ou récepteur, lu côté moteur.
// Sans rôle : assistant guidé (4 étapes) ou mode avancé (3 sections libres). Avec un rôle (et hors assistant) : vue de gestion, onglets du mode avancé.
// Les sections (Accès distant, Connexions, Extinction) ne sont rendues qu'une fois ; ce module les montre ou les masque.
// Leur comportement reste dans remote-settings.js, connections-settings.js et shutdown-settings.js.
import {
  clearWizardState,
  errorText,
  EVENT_ROLE,
  EVENT_SERVER_KEY,
  PICK_KEY,
  readSession,
  STEP_KEY,
  WIZARD_KEY,
  writeSession,
} from './connect-state.js';
import { listConnections } from './connections.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import { initNewKeyView } from './new-key.js';
import { generateServerKey, getRemoteConfig, getRemoteState, getServerConfig, roleOf } from './remote.js';

const MODE_KEY = 'lucania.connect.mode';

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

/** Carte de la section « Accès distant » qui correspond à chaque rôle. */
const ROLE_CARD = /** @type {Record<string, string>} */ ({ tower: 'server', laptop: 'client' });

/** @param {string} key */
function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Stockage indisponible : le choix n'est pas mémorisé.
  }
}

/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement[]} */
const $$ = (sel, root = document) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);
/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement|null} */
const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));

/** @param {unknown} e */
const messageOf = errorText;

export function initConnexionPage() {
  const page = $('[data-connect-page]');
  if (!page) return;

  /**
   * backendRole : rôle lu côté moteur (serveur si une clé existe, sinon récepteur si connecté à une tour).
   * pick : carte choisie à l'étape 1 tant que le moteur n'a pas de rôle.
   * wizard : l'assistant a dépassé l'étape 1 et n'est pas terminé (la page ne passe pas en vue de gestion).
   * fullKey : code complet de la tour, gardé en mémoire seulement pour l'afficher une fois.
   * @type {{ mode: 'guided'|'advanced', step: number, pick: 'tower'|'laptop'|null, backendRole: 'tower'|'laptop'|null, wizard: boolean, tab: string, fullKey: string|null, keyPrefix: string|null }}
   */
  const state = {
    mode: readLocal(MODE_KEY) === 'advanced' ? 'advanced' : 'guided',
    step: 1,
    pick: null,
    backendRole: null,
    wizard: readSession(WIZARD_KEY) === 'active',
    tab: DEFAULT_TAB,
    fullKey: null,
    keyPrefix: null,
  };
  const storedPick = readSession(PICK_KEY);
  if (storedPick === 'tower' || storedPick === 'laptop') state.pick = storedPick;

  /** Rôle montré par l'assistant : celui du moteur s'il existe, sinon la carte choisie. */
  const wizardRole = () => state.backendRole ?? state.pick;
  /** Rôle défini et assistant non actif : vue de gestion. */
  const isManaged = () => state.backendRole !== null && !state.wizard;

  const recapKey = initNewKeyView($('[data-step="4"]') ?? document);

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
    const managed = isManaged();
    const guided = !managed && state.mode === 'guided';
    const role = wizardRole();

    for (const el of $$('[data-view="guided"]')) el.hidden = !guided;
    for (const el of $$('[data-view="advanced"]')) el.hidden = guided;
    for (const btn of $$('[data-mode-btn]')) btn.setAttribute('aria-checked', String(btn.dataset.modeBtn === state.mode));

    // Vue de gestion : plus de choix entre guidé et avancé
    for (const el of $$('[data-mode-switch]')) el.hidden = managed;

    // Sections visibles
    /** @type {Set<string>} */
    const visible = new Set();
    if (guided) {
      if (state.step === STEP_REMOTE && role === 'laptop') visible.add('remote');
      if (state.step === STEP_SHUTDOWN) {
        visible.add('connections');
        visible.add('shutdown');
      }
    } else {
      visible.add(TAB_SECTIONS[state.tab]);
    }
    for (const el of $$('[data-sec]')) el.hidden = !visible.has(el.dataset.sec ?? '');

    // Accès distant : en guidé, seulement la carte récepteur (la tour n'a rien à régler pendant l'assistant ; ni titre de section, ni guide WireGuard).
    // En avancé, seulement la carte du rôle (et le guide) une fois le rôle défini, les deux cartes sinon.
    for (const el of $$('[data-remote-card]')) {
      const kind = el.dataset.remoteCard;
      if (guided) el.hidden = kind !== 'client';
      else if (state.backendRole) el.hidden = kind !== 'guide' && kind !== ROLE_CARD[state.backendRole];
      else el.hidden = false;
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
    for (const el of $$('[data-role-btn]')) {
      const card = /** @type {HTMLButtonElement} */ (el);
      card.setAttribute('aria-checked', String(card.dataset.roleBtn === role));
      // Une machine n'a qu'un rôle : l'autre carte est grisée tant que celui-ci existe
      card.disabled = state.backendRole !== null && card.dataset.roleBtn !== state.backendRole;
    }
    for (const el of $$('[data-role-show]')) el.hidden = el.dataset.roleShow !== role;
    for (const el of $$('[data-laptop-connected]')) el.hidden = state.backendRole !== 'laptop';

    const prev = $('[data-wiz="prev"]');
    const skip = $('[data-wiz="skip"]');
    const next = /** @type {HTMLButtonElement|null} */ ($('[data-wiz="next"]'));
    const finish = $('[data-wiz="finish"]');
    if (prev) prev.hidden = state.step === 1;
    if (skip) skip.hidden = state.step !== STEP_SHUTDOWN;
    if (next) {
      next.hidden = state.step === STEP_RECAP;
      next.disabled = state.step === 1 && !role;
    }
    if (finish) finish.hidden = state.step !== STEP_RECAP;

    page.dataset.ready = 'true';
  }

  // ---- Navigation ----

  /** @param {number} n @param {boolean} [focus] */
  function goStep(n, focus = true) {
    let step = Math.min(Math.max(n, 1), STEP_COUNT);
    if (step > 1 && !wizardRole()) step = 1;
    state.step = step;
    writeSession(STEP_KEY, String(step));
    if (step > 1) {
      state.wizard = true;
      writeSession(WIZARD_KEY, 'active');
    }
    render();
    if (step === STEP_RECAP) refreshRecap();
    if (focus) $$(`[data-step="${step}"] [data-step-heading]`).find((h) => !h.closest('[hidden]'))?.focus();
  }

  /** @param {'guided'|'advanced'} mode */
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    writeLocal(MODE_KEY, mode);
    if (mode === 'advanced') state.tab = tabFromHash() ?? state.tab;
    render();
    if (mode === 'guided' && state.step === STEP_RECAP) refreshRecap();
  }

  /** @param {'tower'|'laptop'} role */
  function setRole(role) {
    if (state.backendRole && state.backendRole !== role) return;
    state.pick = role;
    writeSession(PICK_KEY, role);
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
  // Terminer : l'assistant est fini, la prochaine visite montre la vue de gestion.
  $('[data-wiz="finish"]')?.addEventListener('click', () => clearWizardState());

  // Rôle créé depuis la section Accès distant : la vue suit.
  document.addEventListener(EVENT_ROLE, (e) => {
    const role = /** @type {CustomEvent<unknown>} */ (e).detail;
    state.backendRole = role === 'tower' || role === 'laptop' ? role : null;
    render();
  });

  window.addEventListener('hashchange', () => {
    const id = tabFromHash();
    if (!id) return;
    state.tab = id;
    if (state.mode === 'advanced' || isManaged()) render();
  });

  // Mode guidé : un lien interne (#connexions…) fait défiler jusqu'à la section si elle est affichée.
  document.addEventListener('click', (e) => {
    if (isManaged() || state.mode !== 'guided' || !(e.target instanceof Element)) return;
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
  /** @type {Promise<void>|null} */
  let keyTask = null;

  /** @param {string} name @param {string} text @param {boolean} [bad] */
  function setRecap(name, text, bad = false) {
    const el = $(`[data-recap="${name}"]`);
    if (!el) return;
    el.textContent = text;
    el.dataset.bad = String(bad);
  }

  /**
   * Rôle serveur : le code est créé en arrivant au récapitulatif, une seule fois (puis gardé en mémoire).
   * Si une clé existe déjà sans qu'on l'ait en mémoire, le code complet n'est plus récupérable : seul le préfixe reste.
   * @returns {Promise<void>}
   */
  function ensureTowerKey() {
    if (state.fullKey) return Promise.resolve();
    keyTask ??= (async () => {
      const cfg = await getServerConfig();
      if (cfg.hasKey) {
        state.keyPrefix = cfg.keyPrefix;
        state.backendRole = 'tower';
        return;
      }
      const key = await generateServerKey();
      state.fullKey = key;
      state.keyPrefix = key.slice(0, 4);
      state.backendRole = 'tower';
      // La section Accès distant garde le code visible jusqu'au rechargement.
      document.dispatchEvent(new CustomEvent(EVENT_SERVER_KEY, { detail: key }));
    })().finally(() => {
      keyTask = null;
    });
    return keyTask;
  }

  /** Bloc du code : complet si on l'a en mémoire, sinon seulement le préfixe. @param {boolean} tower */
  function renderRecapKey(tower) {
    const keyline = $('[data-recap="keyline"]');
    const hiddenNote = $('[data-recap="codeHidden"]');
    if (state.fullKey && tower) {
      recapKey.show(state.fullKey);
    } else {
      recapKey.hide();
    }
    const prefixOnly = tower && !state.fullKey && !!state.keyPrefix;
    if (keyline) {
      keyline.hidden = !prefixOnly;
      keyline.textContent = prefixOnly ? t('settings.server.key.prefix', { prefix: state.keyPrefix ?? '' }) : '';
    }
    if (hiddenNote) hiddenNote.hidden = !prefixOnly;
  }

  async function refreshRecap() {
    const token = ++recapToken;
    const live = () => token === recapToken;
    const available = engineAvailable();
    const role = wizardRole();
    const showServer = role !== 'laptop';
    const showClient = role !== 'tower';

    const serverRow = $('[data-recap-row="server"]');
    const clientRow = $('[data-recap-row="client"]');
    const note = $('[data-recap="unavailable"]');
    if (serverRow) serverRow.hidden = !available || !showServer;
    if (clientRow) clientRow.hidden = !available || !showClient;
    if (note) {
      note.hidden = available;
      note.textContent = available ? '' : t('chat.engine.unavailable');
    }
    renderRecapKey(false);

    const loading = t('connect.recap.loading');
    setRecap('role', role ? t(`connect.recap.role.${role}`) : t('connect.recap.role.none'));
    setRecap('server', loading);
    setRecap('client', loading);
    setRecap('shutdown', loading);

    /** @type {Promise<void>[]} */
    const tasks = [];

    if (available && role === 'tower') {
      tasks.push(
        ensureTowerKey().then(
          () => {
            render();
            if (!live()) return;
            setRecap('server', t('connect.recap.server.created'));
            renderRecapKey(true);
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

  /** Rôle lu côté moteur avant le premier affichage : évite de montrer l'assistant puis de basculer vers la gestion. */
  async function boot() {
    if (engineAvailable()) {
      try {
        const [server, remote] = await Promise.all([getServerConfig(), getRemoteConfig()]);
        state.backendRole = roleOf(server, remote);
        state.keyPrefix = server.keyPrefix;
      } catch {
        // Aucune indication : l'assistant s'affiche, l'utilisateur choisit lui-même.
      }
    }
    const storedStep = Number(readSession(STEP_KEY));
    if (Number.isInteger(storedStep) && storedStep >= 1 && storedStep <= STEP_COUNT && wizardRole()) state.step = storedStep;
    render();
    if (state.step === STEP_RECAP && !isManaged()) refreshRecap();
  }

  boot();
}
