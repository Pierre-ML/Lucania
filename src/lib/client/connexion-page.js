// Page /connexion : une machine n'a qu'UN rôle, serveur (tour) ou récepteur, lu côté moteur.
// Sans rôle : assistant guidé ou mode avancé (3 sections libres). Avec un rôle (et hors assistant) : vue de gestion, onglets du mode avancé.
// Étapes de l'assistant selon le rôle : tour = Rôle, Extinction, Récapitulatif ; récepteur = Rôle, Liaison, Extinction, Récapitulatif.
// Les sections (Accès distant, Connexions, Extinction) ne sont rendues qu'une fois ; ce module les montre ou les masque.
// Leur comportement reste dans remote-settings.js, connections-settings.js et shutdown-settings.js.
import {
  AUTOSKIP_KEY,
  clearWizardState,
  errorText,
  EVENT_ROLE,
  EVENT_SERVER_KEY,
  PICK_KEY,
  readSession,
  STEP_KEY,
  stepsFor,
  WIZARD_KEY,
  writeSession,
} from './connect-state.js';
import { listConnections } from './connections.js';
import { engineAvailable } from './engine.js';
import { t } from './i18n.js';
import { initNewKeyView } from './new-key.js';
import { initReceiverShutdown } from './receiver-shutdown.js';
import {
  generateServerKey,
  getRemoteConfig,
  getRemoteState,
  getServerConfig,
  getServerShutdown,
  onRemoteState,
  roleOf,
  testRemote,
} from './remote.js';
import { initTowerShutdown } from './tower-shutdown.js';

const MODE_KEY = 'lucania.connect.mode';

const STEP_ROLE = 'role';
const STEP_LINK = 'link';
const STEP_SHUTDOWN = 'shutdown';
const STEP_RECAP = 'recap';

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
   * step : identifiant de l'étape courante (role, link, shutdown, recap).
   * backendRole : rôle lu côté moteur (serveur si une clé existe, sinon récepteur si connecté à une tour).
   * pick : carte choisie à l'étape 1 tant que le moteur n'a pas de rôle.
   * wizard : l'assistant a dépassé l'étape 1 et n'est pas terminé (la page ne passe pas en vue de gestion).
   * fullKey : code complet de la tour, gardé en mémoire seulement pour l'afficher une fois.
   * link : liaison du récepteur avec la tour (idle = pas encore de liaison enregistrée, ok = testée avec succès).
   * shutdownSync : avancement de la récupération de l'extinction côté récepteur (voir receiver-shutdown.js).
   * autoSkipped : l'étape d'extinction du récepteur a été sautée car la tour n'en propose pas.
   * saving : l'étape d'extinction de la tour est en cours d'enregistrement.
   * @type {{ mode: 'guided'|'advanced', step: string, pick: 'tower'|'laptop'|null, backendRole: 'tower'|'laptop'|null, wizard: boolean, tab: string, fullKey: string|null, keyPrefix: string|null, link: 'idle'|'checking'|'ok'|'error', shutdownSync: import('./receiver-shutdown.js').SyncState, autoSkipped: boolean, saving: boolean }}
   */
  const state = {
    mode: readLocal(MODE_KEY) === 'advanced' ? 'advanced' : 'guided',
    step: STEP_ROLE,
    pick: null,
    backendRole: null,
    wizard: readSession(WIZARD_KEY) === 'active',
    tab: DEFAULT_TAB,
    fullKey: null,
    keyPrefix: null,
    link: 'idle',
    shutdownSync: 'idle',
    autoSkipped: readSession(AUTOSKIP_KEY) === '1',
    saving: false,
  };
  const storedPick = readSession(PICK_KEY);
  if (storedPick === 'tower' || storedPick === 'laptop') state.pick = storedPick;

  /** Rôle montré par l'assistant : celui du moteur s'il existe, sinon la carte choisie. */
  const wizardRole = () => state.backendRole ?? state.pick;
  /** Rôle défini et assistant non actif : vue de gestion. */
  const isManaged = () => state.backendRole !== null && !state.wizard;
  /** L'assistant est à l'écran (et non la vue de gestion ou le mode avancé). */
  const isGuided = () => !isManaged() && state.mode === 'guided';

  const recapKey = initNewKeyView($('[data-step="recap"]') ?? document);

  // Formulaires de l'étape « Extinction » (un par rôle)
  const towerShutdownRoot = $('[data-step="shutdown"] [data-tshut]');
  const towerShutdown = towerShutdownRoot ? initTowerShutdown(towerShutdownRoot) : null;
  const receiverShutdownRoot = $('[data-step="shutdown"] [data-rshut]');
  const receiverShutdown = receiverShutdownRoot ? initReceiverShutdown(receiverShutdownRoot) : null;

  const linkStatusEl = $('[data-link-status]');
  const linkRetryBtn = $('[data-link-retry]');

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

  /** Indicateur d'étapes : les étapes, leurs libellés et le compteur suivent le rôle. @param {string} role */
  function renderSteps(role) {
    const seq = stepsFor(role);
    const index = Math.max(0, seq.indexOf(state.step));
    for (const el of $$('[data-step-item]')) {
      const n = Number(el.dataset.stepItem) - 1;
      const id = seq[n];
      el.hidden = !id;
      if (!id) continue;
      const label = $('[data-step-label]', el);
      if (label) label.textContent = t(`connect.steps.${id}`);
      if (n === index) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
      el.dataset.done = String(n < index);
      el.dataset.last = String(n === seq.length - 1);
    }
    const counter = $('[data-step-counter]');
    if (counter) counter.textContent = t('connect.steps.counter', { current: index + 1, total: seq.length });
  }

  /** Suivant est-il utilisable à l'étape courante ? @param {string|null} role */
  function nextEnabled(role) {
    if (state.step === STEP_ROLE) return !!role;
    if (state.step === STEP_LINK) return state.link === 'ok';
    if (state.step === STEP_SHUTDOWN) return role === 'tower' ? !state.saving : state.shutdownSync === 'done';
    return true;
  }

  function render() {
    const managed = isManaged();
    const guided = !managed && state.mode === 'guided';
    const role = wizardRole();

    for (const el of $$('[data-view="guided"]')) el.hidden = !guided;
    for (const el of $$('[data-view="advanced"]')) el.hidden = guided;
    for (const btn of $$('[data-mode-btn]')) btn.setAttribute('aria-checked', String(btn.dataset.modeBtn === state.mode));

    // Vue de gestion : plus de choix entre guidé et avancé
    for (const el of $$('[data-mode-switch]')) el.hidden = managed;

    // Sections visibles : l'assistant ne montre que l'Accès distant (étape Liaison du récepteur)
    /** @type {Set<string>} */
    const visible = new Set();
    if (guided) {
      if (state.step === STEP_LINK && role === 'laptop') visible.add('remote');
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
    // Blocs réservés à la vue de gestion (l'assistant fait la même chose à sa façon)
    for (const el of $$('[data-managed-only]')) el.hidden = guided;

    // Mode avancé : onglet courant
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === state.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }

    // Mode guidé : étapes, rôle, boutons
    for (const el of $$('[data-step]')) el.hidden = el.dataset.step !== state.step;
    renderSteps(role ?? '');
    for (const el of $$('[data-role-btn]')) {
      const card = /** @type {HTMLButtonElement} */ (el);
      card.setAttribute('aria-checked', String(card.dataset.roleBtn === role));
      // Une machine n'a qu'un rôle : l'autre carte est grisée tant que celui-ci existe
      card.disabled = state.backendRole !== null && card.dataset.roleBtn !== state.backendRole;
    }
    for (const el of $$('[data-role-show]')) el.hidden = el.dataset.roleShow !== role;

    const prev = $('[data-wiz="prev"]');
    const skip = $('[data-wiz="skip"]');
    const next = /** @type {HTMLButtonElement|null} */ ($('[data-wiz="next"]'));
    const finish = $('[data-wiz="finish"]');
    if (prev) prev.hidden = state.step === STEP_ROLE;
    // Récepteur : on peut passer l'extinction (tour injoignable, jeton inconnu…) tant qu'elle n'est pas configurée
    if (skip) skip.hidden = !(state.step === STEP_SHUTDOWN && role === 'laptop' && state.shutdownSync !== 'done');
    if (next) {
      next.hidden = state.step === STEP_RECAP;
      next.disabled = !nextEnabled(role);
    }
    if (finish) finish.hidden = state.step !== STEP_RECAP;

    page.dataset.ready = 'true';
  }

  // ---- Liaison du récepteur ----

  let linkRun = 0;

  /** @param {'idle'|'checking'|'ok'|'error'} status @param {string} [text] */
  function setLink(status, text = '') {
    state.link = status;
    if (linkStatusEl) {
      linkStatusEl.textContent = text;
      linkStatusEl.dataset.bad = String(status === 'error');
    }
    if (linkRetryBtn) linkRetryBtn.hidden = status !== 'error';
    render();
  }

  /**
   * Teste la liaison enregistrée avec la tour (clé enregistrée) : Suivant n'est possible qu'une fois ce test réussi.
   * Appelé en arrivant sur l'étape, y compris après le rechargement qui suit l'enregistrement du récepteur.
   */
  async function verifyLink() {
    const id = ++linkRun;
    if (!engineAvailable()) {
      setLink('error', t('connect.link.failed', { error: t('chat.engine.unavailable') }));
      return;
    }
    setLink('checking', t('connect.link.checking'));
    try {
      const cfg = await getRemoteConfig();
      if (id !== linkRun) return;
      if (cfg.mode !== 'remote' || !cfg.url) {
        setLink('idle', t('connect.link.pending'));
        return;
      }
      await testRemote({ url: cfg.url, key: null });
      if (id !== linkRun) return;
      setLink('ok', t('connect.link.ok', { url: cfg.url }));
    } catch (e) {
      if (id === linkRun) setLink('error', t('connect.link.failed', { error: messageOf(e) }));
    }
  }

  linkRetryBtn?.addEventListener('click', () => {
    verifyLink();
  });

  // La liaison vient de s'établir après un échec : on reteste.
  if (engineAvailable()) {
    onRemoteState((s) => {
      if (s.connected && isGuided() && state.step === STEP_LINK && state.link === 'error') verifyLink();
    }).catch(() => {});
  }

  // ---- Extinction ----

  receiverShutdown?.onChange((syncState) => {
    state.shutdownSync = syncState;
    // La tour ne propose pas l'extinction : on saute l'étape (Précédent depuis le récapitulatif revient à la liaison).
    if (syncState === 'none' && isGuided() && state.step === STEP_SHUTDOWN && wizardRole() === 'laptop') {
      state.autoSkipped = true;
      writeSession(AUTOSKIP_KEY, '1');
      goStep(STEP_RECAP);
      return;
    }
    render();
  });

  // ---- Navigation ----

  /** @param {string} step @param {number} delta */
  function stepAt(step, delta) {
    const seq = stepsFor(wizardRole());
    const i = seq.indexOf(step);
    return seq[Math.min(Math.max(i + delta, 0), seq.length - 1)];
  }

  /** @param {string} step */
  function previousStep(step) {
    if (step === STEP_RECAP && wizardRole() === 'laptop' && state.autoSkipped) return STEP_LINK;
    return stepAt(step, -1);
  }

  /** Ce que fait l'assistant en arrivant sur une étape. @param {string} step */
  function enterStep(step) {
    if (step === STEP_LINK) {
      if (state.backendRole === 'laptop') verifyLink();
      else setLink('idle', t('connect.link.pending'));
    } else if (step === STEP_SHUTDOWN) {
      if (wizardRole() === 'tower') {
        towerShutdown?.load();
      } else if (wizardRole() === 'laptop' && receiverShutdown) {
        state.autoSkipped = false;
        writeSession(AUTOSKIP_KEY, null);
        state.shutdownSync = 'loading';
        render();
        receiverShutdown.run();
      }
    } else if (step === STEP_RECAP) {
      refreshRecap();
    }
  }

  /** @param {string} id @param {boolean} [focus] */
  function goStep(id, focus = true) {
    const seq = stepsFor(wizardRole());
    let step = seq.includes(id) && id !== 'setup' ? id : STEP_ROLE;
    if (step !== STEP_ROLE && !wizardRole()) step = STEP_ROLE;
    state.step = step;
    writeSession(STEP_KEY, step);
    if (step !== STEP_ROLE) {
      state.wizard = true;
      writeSession(WIZARD_KEY, 'active');
    }
    render();
    enterStep(step);
    if (focus) $$(`[data-step="${step}"] [data-step-heading]`).find((h) => !h.closest('[hidden]'))?.focus();
  }

  /** Suivant : à l'étape d'extinction de la tour, enregistre d'abord (on ne passe pas en cas d'erreur). */
  async function goNext() {
    if (state.step === STEP_SHUTDOWN && wizardRole() === 'tower' && towerShutdown) {
      if (state.saving) return;
      state.saving = true;
      render();
      const ok = await towerShutdown.save();
      state.saving = false;
      if (!ok) {
        render();
        return;
      }
    }
    goStep(stepAt(state.step, 1));
  }

  /** @param {'guided'|'advanced'} mode */
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    writeLocal(MODE_KEY, mode);
    if (mode === 'advanced') state.tab = tabFromHash() ?? state.tab;
    render();
    if (mode === 'guided' && isGuided()) enterStep(state.step);
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
  $('[data-wiz="prev"]')?.addEventListener('click', () => goStep(previousStep(state.step)));
  $('[data-wiz="next"]')?.addEventListener('click', () => {
    goNext();
  });
  $('[data-wiz="skip"]')?.addEventListener('click', () => goStep(STEP_RECAP));
  $('[data-wiz="advanced"]')?.addEventListener('click', () => setMode('advanced'));
  // Terminer : l'assistant est fini, la prochaine visite montre la vue de gestion.
  $('[data-wiz="finish"]')?.addEventListener('click', () => clearWizardState());

  // Rôle créé ou supprimé depuis la section Accès distant : la vue suit.
  document.addEventListener(EVENT_ROLE, (e) => {
    const role = /** @type {CustomEvent<unknown>} */ (e).detail;
    state.backendRole = role === 'tower' || role === 'laptop' ? role : null;
    render();
    if (isGuided() && state.step === STEP_LINK && state.backendRole === 'laptop') verifyLink();
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
            // L'état de la liaison peut ne pas être établi juste après l'enregistrement : le test fait foi.
            let remote = await getRemoteState().catch(() => null);
            if (!remote?.connected) {
              try {
                await testRemote({ url, key: null });
                remote = { mode: 'remote', connected: true, error: null };
              } catch (e) {
                remote = { mode: 'remote', connected: false, error: messageOf(e) };
              }
            }
            if (!live()) return;
            if (remote.connected) setRecap('client', t('connect.recap.client.connected', { url }));
            else if (remote.error) setRecap('client', t('connect.recap.client.unreachableError', { url, error: remote.error }), true);
            else setRecap('client', t('connect.recap.client.unreachable', { url }), true);
          })
          .catch((e) => {
            if (live()) setRecap('client', messageOf(e), true);
          }),
      );
    }

    // Extinction à distance : celle de cette tour, ou celle de la tour utilisée par ce récepteur
    if (!available) {
      setRecap('shutdown', t('connect.recap.unavailable'));
    } else if (role === 'tower') {
      tasks.push(
        getServerShutdown().then(
          (info) => {
            if (!live()) return;
            setRecap(
              'shutdown',
              info.enabled ? t('connect.recap.shutdown.tower.enabled', { method: info.method, url: info.url }) : t('connect.recap.shutdown.tower.disabled'),
            );
          },
          (e) => {
            if (live()) setRecap('shutdown', messageOf(e), true);
          },
        ),
      );
    } else if (state.autoSkipped) {
      setRecap('shutdown', t('connect.recap.shutdown.laptop.none'));
    } else {
      tasks.push(
        listConnections().then(
          (list) => {
            if (!live()) return;
            const configured = list.some((c) => c.shutdown?.enabled);
            setRecap('shutdown', configured ? t('connect.recap.shutdown.laptop.configured') : t('connect.recap.shutdown.laptop.notConfigured'));
          },
          () => {
            if (live()) setRecap('shutdown', t('connect.recap.shutdown.error'), true);
          },
        ),
      );
    }

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
    // Étape retenue avant un rechargement (par exemple celui qui suit l'enregistrement du récepteur) ; une ancienne valeur numérique est ignorée.
    const storedStep = readSession(STEP_KEY);
    if (storedStep && storedStep !== 'setup' && wizardRole() && stepsFor(wizardRole()).includes(storedStep)) state.step = storedStep;
    render();
    if (isGuided()) enterStep(state.step);
  }

  boot();
}
