// Page /emails : connexion guidée à la boîte mail et tri des e-mails non lus par un modèle local (moteur llama.cpp embarqué).
import { engineAvailable, generateText, getEngineStatus, listModels, loadModel, stopGeneration } from './engine.js';
import { getLang, t } from './i18n.js';
import { MAIL_CATEGORIES, MAIL_MAX_TOKENS, buildMailMessages, parseMailVerdict } from './mail-ai.js';

const MAX_ACCOUNTS = 10;
const FEEDBACK_LIMIT = 10;
/** Ordre d'affichage : les catégories, puis « À vérifier ». */
const ORDER = /** @type {string[]} */ ([...MAIL_CATEGORIES, 'incertain']);
/**
 * Pastilles neutres par catégorie (classes écrites en entier).
 * @type {Record<string, string>}
 */
const DOTS = {
  personnel: 'bg-fg',
  pro: 'bg-fg/70',
  notification: 'bg-fg/45',
  pub: 'bg-fg/30',
  indesirable: 'bg-fg/15',
  incertain: 'border border-dashed border-fg/60',
};
const RATE_BTN =
  'flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted transition-[background-color,color,transform] duration-150 hover:bg-fg/5 hover:text-fg focus-visible:outline-2 focus-visible:outline-fg/40 active:scale-90 aria-pressed:bg-fg/10 aria-pressed:text-fg disabled:cursor-default disabled:aria-[pressed=false]:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100';
const PICK_BTN =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-xs transition-[background-color,transform] duration-150 hover:bg-fg/5 focus-visible:outline-2 focus-visible:outline-fg/40 active:scale-[0.97] disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100';
const THUMB_UP = [
  'M7 10v12',
  'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
];
const THUMB_DOWN = [
  'M17 14V2',
  'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
];

/** Fournisseurs connus : serveur IMAP en SSL (993) et domaines reconnus dans l'adresse. */
const PROVIDERS = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, name: 'Gmail', domains: /^(gmail|googlemail)\.com$/i },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true, name: 'Outlook', domains: /^(outlook|hotmail|live|msn)\.[a-z.]+$/i },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true, name: 'Yahoo', domains: /^(yahoo|ymail)\.[a-z.]+$/i },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true, name: 'iCloud', domains: /^(icloud|me|mac)\.com$/i },
  other: { host: '', port: 993, secure: true, name: '', domains: /$^/ },
};

/**
 * @typedef {{ id: number, host: string, port: number, secure: boolean, user: string, hasPassword: boolean, mailbox: string, maxEmails: number }} MailAccount
 * @typedef {{ uid: number, from: string, subject: string, date: string, snippet: string }} MailItem
 * @typedef {import('./mail-ai.js').MailCategory} MailCategory
 * @typedef {import('./mail-ai.js').MailVerdict} MailVerdict
 * @typedef {{ mail: MailItem, accountUser: string, aiCategory: MailVerdict, category: MailVerdict, reason: string, rated: boolean, ts: number, el: HTMLElement, chip: HTMLElement }} Entry
 */

/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement[]} */
const $$ = (sel, root = document) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]);
/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement|null} */
const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));

/**
 * Appel JSON vers l'API ; lève une Error portant le message du serveur.
 * @param {string} url @param {RequestInit} [init]
 */
async function api(url, init) {
  const res = await fetch(url, init);
  /** @type {any} */
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
  return data;
}

/** @param {unknown} e */
function messageOf(e) {
  if (e instanceof Error && e.message) return e.message;
  return typeof e === 'string' ? e : t('mail.analyze.error');
}

/** Date courte et relative (« il y a 2 h », « hier »), repli sur la date. @param {string} iso */
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  const lang = getLang();
  try {
    const diffSec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(diffSec);
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
    if (abs < 60) return rtf.format(0, 'second');
    if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
    if (abs < 7 * 86400) return rtf.format(Math.round(diffSec / 86400), 'day');
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: abs > 300 * 86400 ? 'numeric' : undefined }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/** « Nom <adresse> » devient le nom seul s'il existe. @param {string} from */
function senderName(from) {
  const raw = String(from || '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(raw);
  if (m) return m[1].trim() || m[2].trim();
  return raw;
}

/** @param {string} name */
function initialOf(name) {
  const m = /[\p{L}\p{N}]/u.exec(name);
  return m ? m[0].toUpperCase() : '?';
}

/** Icône SVG statique (chemins constants). @param {string[]} paths @param {string} cls */
function svgIcon(paths, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Adresse seule d'un « Nom <adresse> ». @param {string} from */
function senderAddress(from) {
  const raw = String(from || '').trim();
  const m = /<([^>]*)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

/** Puce de catégorie : pastille neutre + libellé. @param {string} cat */
function buildChip(cat) {
  const chip = document.createElement('span');
  chip.className = 'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border px-2 text-xs';
  const dot = document.createElement('span');
  dot.className = `size-1.5 shrink-0 rounded-full ${DOTS[cat] || DOTS.incertain}`;
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = t(`mail.category.${cat}`);
  chip.append(dot, label);
  return chip;
}

export function initEmailsPage() {
  const page = $('[data-mail-page]');
  if (!page) return;

  const form = /** @type {HTMLFormElement} */ ($('[data-mail-form]'));
  const dialog = /** @type {HTMLDialogElement|null} */ ($('[data-mail-dialog]'));
  const ctaBox = $('[data-mail-cta]');
  const connectBtn = $('[data-mail-connect]');
  const welcome = $('[data-mail-welcome]');
  const tilesBox = $('[data-mail-tiles]');
  const setupTitle = $('[data-mail-setup-title]');
  const accountsBox = $('[data-mail-accounts]');
  const accountList = $('[data-mail-account-list]');
  const accountsStatus = $('[data-mail-accounts-status]');
  const addBtn = /** @type {HTMLButtonElement|null} */ ($('[data-mail-add]'));
  const cancelBtn = $('[data-mail-cancel]');
  const advanced = /** @type {HTMLDetailsElement|null} */ ($('[data-mail-advanced]'));
  const helpEl = $('[data-mail-help]');
  const field = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ ($(`[data-mail-field="${name}"]`));
  const modelSel = /** @type {HTMLSelectElement} */ ($('[data-mail-model]'));
  const modelRow = $('[data-mail-model-row]');
  const modelStatus = $('[data-mail-model-status]');
  const settingsStatus = $('[data-mail-settings-status]');
  const saveBtn = /** @type {HTMLButtonElement} */ ($('[data-mail-save]'));
  const markSeenBox = /** @type {HTMLInputElement} */ ($('[data-mail-markseen]'));
  const markSeenStatus = $('[data-mail-markseen-status]');
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let markSeenTimer;
  const analyzeBtn = /** @type {HTMLButtonElement} */ ($('[data-mail-analyze]'));
  const stopBtn = /** @type {HTMLButtonElement} */ ($('[data-mail-stop]'));
  const hint = $('[data-mail-hint]');
  const progressBox = $('[data-mail-progress]');
  const live = $('[data-mail-progress-live]');
  const bar = /** @type {HTMLProgressElement} */ ($('[data-mail-bar]'));
  const statusEl = $('[data-mail-status]');
  const errorsBox = $('[data-mail-errors]');
  const errorList = $('[data-mail-error-list]');
  const results = $('[data-mail-results]');
  const summary = $('[data-mail-summary]');
  const none = $('[data-mail-none]');
  const board = $('[data-mail-board]');
  if (!form || !modelSel || !saveBtn || !analyzeBtn || !stopBtn || !bar || !markSeenBox) return;

  const available = engineAvailable();
  /** @type {AbortController|null} */
  let controller = null;
  let running = false;
  /** @type {MailAccount[]} */
  let accounts = [];
  /** @type {number|null} compte en cours de modification (null = ajout) */
  let editingId = null;
  let savedModel = '';
  let modelCount = 0;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let modelTimer;
  let hasPassword = false;
  /** @type {string} */
  let provider = '';
  let providerPicked = false;
  let filter = 'all';
  let totalCount = 0;

  /** @param {HTMLElement|null} el @param {string} text @param {boolean} [error] */
  function say(el, text, error = false) {
    if (!el) return;
    el.textContent = text;
    el.dataset.error = String(error);
  }

  // ---- Fournisseur ----

  /** @param {string} id @param {boolean} fromUser */
  function setProvider(id, fromUser) {
    provider = id;
    if (fromUser) providerPicked = true;
    for (const b of $$('[data-mail-provider]')) b.setAttribute('aria-pressed', String(b.dataset.mailProvider === id));
    const p = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (id)];
    if (!p) return;
    if (id !== 'other') {
      field('host').value = p.host;
      field('port').value = String(p.port);
      field('secure').checked = p.secure;
    } else if (advanced) {
      advanced.open = true;
    }
    if (helpEl) {
      helpEl.hidden = false;
      helpEl.textContent = id === 'other' ? t('mail.setup.helpOther') : t('mail.setup.helpApp', { provider: p.name });
    }
  }

  /** @param {string} host */
  function providerOfHost(host) {
    const h = host.trim().toLowerCase();
    if (!h) return '';
    for (const [id, p] of Object.entries(PROVIDERS)) if (p.host && p.host === h) return id;
    return 'other';
  }

  field('user').addEventListener('input', () => {
    if (providerPicked) return;
    const domain = field('user').value.split('@')[1]?.trim() ?? '';
    if (!domain) return;
    for (const [id, p] of Object.entries(PROVIDERS)) {
      if (id !== 'other' && p.domains.test(domain)) {
        if (provider !== id) setProvider(id, false);
        return;
      }
    }
  });
  for (const b of $$('[data-mail-provider]')) {
    b.addEventListener('click', () => setProvider(b.dataset.mailProvider || 'other', true));
  }

  // ---- Formulaire de compte ----

  function resetForm() {
    provider = '';
    providerPicked = false;
    for (const b of $$('[data-mail-provider]')) b.setAttribute('aria-pressed', 'false');
    field('host').value = '';
    field('port').value = '';
    field('secure').checked = true;
    field('user').value = '';
    field('password').value = '';
    field('password').placeholder = '';
    field('mailbox').value = '';
    field('maxEmails').value = '30';
    hasPassword = false;
    if (helpEl) helpEl.hidden = true;
    if (advanced) advanced.open = false;
  }

  /** @param {MailAccount} a */
  function fillForm(a) {
    resetForm();
    field('user').value = a.user || '';
    hasPassword = Boolean(a.hasPassword);
    field('password').placeholder = hasPassword ? t('mail.setup.passwordSaved') : '';
    field('mailbox').value = a.mailbox || '';
    const maxSel = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (field('maxEmails')));
    const maxValue = String(Number.isFinite(a.maxEmails) && a.maxEmails >= 0 ? a.maxEmails : 30);
    for (const o of [...maxSel.options]) if (o.dataset.temp) o.remove();
    if (![...maxSel.options].some((o) => o.value === maxValue)) {
      // Valeur hors liste (ancien compte) : option ajoutée temporairement.
      const opt = document.createElement('option');
      opt.value = maxValue;
      opt.textContent = maxValue;
      opt.dataset.temp = 'true';
      maxSel.append(opt);
    }
    maxSel.value = maxValue;
    const id = providerOfHost(a.host || '');
    if (id) {
      providerPicked = true;
      setProvider(id, true);
    }
    field('host').value = a.host || '';
    field('port').value = a.port ? String(a.port) : '';
    field('secure').checked = Boolean(a.secure);
  }

  /** Ouvre ou ferme la fenêtre du formulaire de compte. @param {boolean} showForm */
  function showSetup(showForm) {
    if (!dialog) return;
    if (showForm && !dialog.open) dialog.showModal();
    else if (!showForm && dialog.open) dialog.close();
  }

  // Échap ou « Annuler » : on oublie le compte en cours de modification.
  dialog?.addEventListener('close', () => {
    editingId = null;
    say(settingsStatus, '');
  });

  /** L'invite centrale n'est visible que tant qu'aucun résultat n'est affiché. */
  function syncWelcome() {
    if (welcome && results) welcome.hidden = !results.hidden;
  }

  /** @param {boolean} on */
  function showResults(on) {
    if (results) results.hidden = !on;
    syncWelcome();
  }

  /** @param {boolean} on */
  function showBoard(on) {
    if (board) board.hidden = !on;
    if (tilesBox) tilesBox.hidden = !on;
  }

  /** @param {MailAccount|null} account */
  function openForm(account) {
    editingId = account ? account.id : null;
    say(settingsStatus, '');
    if (account) fillForm(account);
    else resetForm();
    if (setupTitle) {
      setupTitle.textContent = account
        ? t('mail.setup.editTitle')
        : accounts.length === 0
          ? t('mail.setup.title')
          : t('mail.setup.addTitle');
    }
    showSetup(true);
    field('user').focus();
  }

  addBtn?.addEventListener('click', () => openForm(null));
  connectBtn?.addEventListener('click', () => openForm(null));
  cancelBtn?.addEventListener('click', () => showSetup(false));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const user = field('user').value.trim();
    const host = field('host').value.trim();
    if (!provider && !host) {
      say(settingsStatus, t('mail.setup.pickProvider'), true);
      return;
    }
    if (!user) {
      say(settingsStatus, t('mail.setup.needEmail'), true);
      return;
    }
    if (!host) {
      if (advanced) advanced.open = true;
      say(settingsStatus, t('mail.setup.needHost'), true);
      return;
    }
    if (!hasPassword && !field('password').value) {
      say(settingsStatus, t('mail.setup.needPassword'), true);
      return;
    }
    saveBtn.disabled = true;
    say(settingsStatus, t('mail.setup.saving'));
    try {
      const body = {
        host,
        port: Number(field('port').value) || 993,
        secure: field('secure').checked,
        user,
        password: field('password').value,
        mailbox: field('mailbox').value.trim(),
        // 0 = illimité.
        maxEmails: Number(field('maxEmails').value),
      };
      const editing = editingId !== null;
      await api(editing ? `/api/mail/accounts/${editingId}` : '/api/mail/accounts', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      editingId = null;
      await loadAccounts();
      say(settingsStatus, '');
      showSetup(false);
    } catch (e) {
      say(settingsStatus, messageOf(e), true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---- Liste des comptes ----

  /** @param {string} text @param {string} extra */
  function accountButton(text, extra) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mailAccountAction = '';
    b.disabled = running;
    b.className = `h-8 shrink-0 cursor-pointer rounded-lg px-2 text-xs transition-colors duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${extra}`;
    b.textContent = text;
    return b;
  }

  /** @param {MailAccount} a */
  function buildAccountCard(a) {
    const li = document.createElement('li');
    li.className = 'flex flex-wrap items-center gap-2 rounded-xl border border-border bg-bg/50 py-1.5 pl-2.5 pr-1.5';

    const badge = document.createElement('span');
    badge.className = 'flex size-7 shrink-0 items-center justify-center rounded-full bg-fg/10 text-sm font-medium';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = initialOf(a.user);

    const name = document.createElement('p');
    name.className = 'min-w-24 flex-1 text-sm font-medium wrap-anywhere';
    name.textContent = a.user;
    const limit = document.createElement('span');
    limit.className = 'block text-xs font-normal text-muted';
    limit.textContent = a.maxEmails > 0 ? t('mail.account.limit', { n: a.maxEmails }) : t('mail.account.unlimited');

    const actions = document.createElement('div');
    actions.className = 'flex shrink-0 items-center gap-1';

    function showNormal() {
      const edit = accountButton(t('mail.account.edit'), 'text-muted hover:text-fg');
      edit.setAttribute('aria-label', t('mail.account.editLabel', { user: a.user }));
      edit.addEventListener('click', () => openForm(a));
      const del = accountButton(t('mail.account.delete'), 'text-muted hover:text-fg');
      del.setAttribute('aria-label', t('mail.account.deleteLabel', { user: a.user }));
      del.addEventListener('click', showConfirm);
      name.replaceChildren(document.createTextNode(a.user), limit);
      actions.replaceChildren(edit, del);
    }

    function showConfirm() {
      name.textContent = t('mail.account.deleteAsk', { user: a.user });
      const cancel = accountButton(t('mail.setup.cancel'), 'text-muted hover:text-fg');
      cancel.addEventListener('click', showNormal);
      const confirmBtn = accountButton(t('mail.account.deleteConfirm'), 'font-medium text-danger');
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        say(accountsStatus, '');
        try {
          await api(`/api/mail/accounts/${a.id}`, { method: 'DELETE' });
          await loadAccounts();
        } catch (e) {
          say(accountsStatus, messageOf(e), true);
          showNormal();
        }
      });
      actions.replaceChildren(cancel, confirmBtn);
      cancel.focus();
    }

    showNormal();
    li.append(badge, name, actions);
    return li;
  }

  function renderAccounts() {
    accountList?.replaceChildren(...accounts.map(buildAccountCard));
    if (addBtn) addBtn.hidden = accounts.length >= MAX_ACCOUNTS;
    if (accountsBox) accountsBox.hidden = accounts.length === 0;
    if (ctaBox) ctaBox.hidden = accounts.length > 0;
    refreshRun();
  }

  async function loadAccounts() {
    const data = await api('/api/mail/accounts');
    accounts = Array.isArray(data?.accounts) ? data.accounts : [];
    renderAccounts();
  }

  // ---- Modèle ----

  function refreshModelDisabled() {
    modelSel.disabled = running || modelCount === 0;
  }

  async function fillModels() {
    modelSel.replaceChildren();
    modelCount = 0;
    if (!available) {
      if (modelRow) modelRow.hidden = true;
      return;
    }
    try {
      const models = await listModels();
      modelCount = models.length;
      const first = document.createElement('option');
      first.value = '';
      first.textContent = models.length ? t('mail.model.choose') : t('mail.model.none');
      modelSel.append(first);
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        modelSel.append(opt);
      }
    } catch (e) {
      say(modelStatus, messageOf(e), true);
    }
    refreshModelDisabled();
  }

  /** @param {string} value */
  async function persistModel(value) {
    clearTimeout(modelTimer);
    say(modelStatus, '');
    try {
      const s = await api('/api/mail/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: value }),
      });
      savedModel = typeof s?.model === 'string' ? s.model : value;
      say(modelStatus, t('mail.model.saved'));
      modelTimer = setTimeout(() => say(modelStatus, ''), 2500);
    } catch (e) {
      say(modelStatus, messageOf(e), true);
    }
  }

  /** Sélectionne le modèle enregistré ; sinon, le premier si demandé (ou s'il est seul). @param {string} keep @param {boolean} pickFirst */
  async function applyModelSelection(keep, pickFirst) {
    const wanted = keep || savedModel;
    if (wanted && ![...modelSel.options].some((o) => o.value === wanted)) {
      const opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = wanted;
      modelSel.append(opt);
    }
    const real = [...modelSel.options].filter((o) => o.value);
    if (wanted) modelSel.value = wanted;
    else if (real.length > 0 && (pickFirst || real.length === 1)) {
      // Aucun modèle choisi : le premier disponible est choisi et enregistré d'office.
      modelSel.value = real[0].value;
      await persistModel(real[0].value);
    }
    refreshRun();
  }

  async function loadModelSetting() {
    await fillModels();
    try {
      const s = await api('/api/mail/settings');
      savedModel = typeof s?.model === 'string' ? s.model : '';
      markSeenBox.checked = Boolean(s?.markSeen);
    } catch (e) {
      say(modelStatus, messageOf(e), true);
    }
    await applyModelSelection('', false);
  }

  // Un modèle vient d'être téléchargé : on recharge la liste en gardant la sélection.
  window.addEventListener('lucania:models-changed', async () => {
    if (running) return;
    const keep = modelSel.value;
    await fillModels();
    await applyModelSelection(keep, true);
  });

  // ---- Marquer comme lus ----

  markSeenBox.addEventListener('change', async () => {
    const wanted = markSeenBox.checked;
    markSeenBox.disabled = true;
    say(markSeenStatus, '');
    try {
      const s = await api('/api/mail/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markSeen: wanted }),
      });
      markSeenBox.checked = typeof s?.markSeen === 'boolean' ? s.markSeen : wanted;
      say(markSeenStatus, t('mail.markSeen.saved'));
      clearTimeout(markSeenTimer);
      markSeenTimer = setTimeout(() => say(markSeenStatus, ''), 2500);
    } catch (e) {
      markSeenBox.checked = !wanted;
      say(markSeenStatus, messageOf(e), true);
    } finally {
      markSeenBox.disabled = running;
    }
  });

  modelSel.addEventListener('change', () => {
    refreshRun();
    if (modelSel.value) persistModel(modelSel.value);
  });

  function currentModel() {
    return modelSel.value || savedModel;
  }

  function refreshRun() {
    let reason = '';
    if (!available) reason = t('chat.engine.unavailable');
    else if (accounts.length === 0) reason = t('mail.run.needSetup');
    else if (!currentModel()) reason = t('mail.run.needModel');
    analyzeBtn.disabled = running || reason !== '';
    if (!running) say(hint, reason);
  }

  // ---- Résultats ----

  const list = $('[data-mail-list]');
  const emptyFilter = $('[data-mail-empty]');
  /** @type {Entry[]} */
  const entries = [];

  function refreshResults() {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const c of ORDER) counts[c] = 0;
    for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
    const total = entries.length;
    if (filter !== 'all' && !counts[filter]) filter = 'all';
    for (const id of ['all', ...ORDER]) {
      const n = id === 'all' ? total : counts[id];
      const count = $(`[data-mail-count="${id}"]`);
      if (count) count.textContent = String(n);
      const fill = $(`[data-mail-fill="${id}"]`);
      if (fill) fill.style.transform = `scaleX(${total ? n / total : 0})`;
      const btn = $(`[data-mail-filter="${id}"]`);
      if (btn) btn.setAttribute('aria-pressed', String(id === filter));
    }
    const tileWrap = $('[data-mail-tile="incertain"]');
    if (tileWrap) tileWrap.hidden = counts.incertain === 0;
    let visible = 0;
    for (const e of entries) {
      const show = filter === 'all' || e.category === filter;
      e.el.hidden = !show;
      if (show) visible += 1;
    }
    if (emptyFilter) emptyFilter.hidden = visible > 0 || total === 0;
    if (summary) {
      summary.textContent =
        total === 0
          ? totalCount > 0
            ? t('mail.results.summaryWait', { total: totalCount })
            : ''
          : t(total === 1 ? 'mail.results.summaryOne' : 'mail.results.summaryMany', {
              n: total,
              people: counts.personnel,
              pro: counts.pro,
            });
    }
  }

  function resetResults() {
    entries.length = 0;
    list?.replaceChildren();
    totalCount = 0;
    filter = 'all';
    refreshResults();
  }

  for (const btn of $$('[data-mail-filter]')) {
    btn.addEventListener('click', () => {
      filter = btn.dataset.mailFilter || 'all';
      refreshResults();
    });
  }

  /** @param {HTMLElement} root @param {boolean} on */
  function setButtonsDisabled(root, on) {
    for (const b of $$('button', root)) /** @type {HTMLButtonElement} */ (b).disabled = on;
  }

  /**
   * Envoie la note à l'IA ; en cas de mauvaise note, reclasse la ligne.
   * @param {Entry} entry @param {1|-1} rating @param {MailCategory|null} userCategory
   * @param {{ up: HTMLButtonElement|null, down: HTMLButtonElement, picker: HTMLElement, note: HTMLElement }} ui
   */
  async function rate(entry, rating, userCategory, ui) {
    if (entry.rated) return;
    entry.rated = true;
    say(ui.note, '');
    setButtonsDisabled(entry.el, true);
    try {
      await api('/api/mail/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: senderAddress(entry.mail.from),
          subject: entry.mail.subject || '',
          aiCategory: entry.aiCategory,
          rating,
          userCategory,
        }),
      });
    } catch {
      entry.rated = false;
      setButtonsDisabled(entry.el, false);
      say(ui.note, t('mail.rate.error'), true);
      return;
    }
    (rating === 1 ? ui.up : ui.down)?.setAttribute('aria-pressed', 'true');
    ui.picker.hidden = true;
    ui.down.setAttribute('aria-expanded', 'false');
    if (rating === -1 && userCategory) {
      entry.category = userCategory;
      const chip = buildChip(userCategory);
      entry.chip.replaceWith(chip);
      entry.chip = chip;
    }
    say(ui.note, t('mail.rate.saved'));
    refreshResults();
    // La ligne peut sortir du filtre actif : on annonce aussi la note ailleurs.
    if (entry.el.hidden) say(statusEl, t('mail.rate.saved'));
  }

  /** @param {Entry} entry @param {boolean} multi */
  function buildRow(entry, multi) {
    const { mail } = entry;
    const li = document.createElement('li');
    li.className = 'px-3 py-2 opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none';
    const name = senderName(mail.from) || t('mail.results.unknownSender');
    const subjectText = mail.subject || t('mail.results.noSubject');
    const reasonText = entry.reason || t('mail.results.noReason');

    const line = document.createElement('div');
    line.className = 'flex items-start gap-3';
    const badge = document.createElement('span');
    badge.className = 'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-fg/10 text-xs font-medium';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = initialOf(name);

    const body = document.createElement('div');
    body.className = 'min-w-0 flex-1';
    const top = document.createElement('div');
    top.className = 'flex items-baseline justify-between gap-3';
    const subject = document.createElement('p');
    subject.className = 'min-w-0 truncate text-sm font-medium';
    subject.title = subjectText;
    subject.textContent = subjectText;
    const date = document.createElement('p');
    date.className = 'shrink-0 text-xs tabular-nums text-muted';
    date.textContent = formatDate(mail.date);
    top.append(subject, date);

    const meta = document.createElement('div');
    meta.className = 'mt-1 flex items-center gap-2';
    const sender = document.createElement('span');
    sender.className = 'max-w-[35%] shrink-0 truncate text-xs font-medium text-muted sm:max-w-56';
    sender.title = senderAddress(mail.from) || name;
    sender.textContent = name;
    const reason = document.createElement('span');
    reason.className = 'min-w-0 flex-1 truncate text-xs text-muted';
    reason.title = reasonText;
    reason.textContent = reasonText;
    meta.append(entry.chip, sender);
    if (multi && entry.accountUser) {
      const acc = document.createElement('span');
      acc.className = 'hidden max-w-40 shrink-0 truncate text-xs text-muted sm:inline';
      acc.textContent = entry.accountUser;
      meta.append(acc);
    }
    meta.append(reason);

    const actions = document.createElement('div');
    actions.className = 'flex shrink-0 items-center';
    /** @type {HTMLButtonElement|null} */
    let up = null;
    if (entry.aiCategory !== 'incertain') {
      up = document.createElement('button');
      up.type = 'button';
      up.className = RATE_BTN;
      up.setAttribute('aria-pressed', 'false');
      up.setAttribute('aria-label', t('mail.rate.up', { subject: subjectText }));
      up.append(svgIcon(THUMB_UP, 'size-4'));
      actions.append(up);
    }
    const down = document.createElement('button');
    down.type = 'button';
    down.className = RATE_BTN;
    down.setAttribute('aria-pressed', 'false');
    down.setAttribute('aria-expanded', 'false');
    down.setAttribute('aria-label', t('mail.rate.down', { subject: subjectText }));
    down.append(svgIcon(THUMB_DOWN, 'size-4'));
    actions.append(down);
    meta.append(actions);

    const picker = document.createElement('div');
    picker.hidden = true;
    const pickerRow = document.createElement('div');
    pickerRow.className = 'mt-1 flex flex-wrap items-center gap-2';
    picker.append(pickerRow);
    const note = document.createElement('p');
    note.className = 'text-xs text-muted empty:hidden data-[error=true]:text-danger';
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');

    const ui = { up, down, picker, note };
    up?.addEventListener('click', () => rate(entry, 1, null, ui));
    down.addEventListener('click', () => {
      if (entry.rated) return;
      const open = picker.hidden;
      picker.hidden = !open;
      down.setAttribute('aria-expanded', String(open));
      if (!open) return;
      const label = document.createElement('span');
      label.className = 'text-xs text-muted';
      label.textContent = t('mail.rate.pick');
      const chips = MAIL_CATEGORIES.filter((c) => c !== entry.category).map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = PICK_BTN;
        b.setAttribute('aria-label', t('mail.rate.pickChoice', { category: t(`mail.category.${c}`) }));
        const dot = document.createElement('span');
        dot.className = `size-1.5 shrink-0 rounded-full ${DOTS[c]}`;
        dot.setAttribute('aria-hidden', 'true');
        const txt = document.createElement('span');
        txt.textContent = t(`mail.category.${c}`);
        b.append(dot, txt);
        b.addEventListener('click', () => rate(entry, -1, c, ui));
        return b;
      });
      pickerRow.replaceChildren(label, ...chips);
    });

    body.append(top, meta, picker, note);
    line.append(badge, body);
    li.append(line);
    return li;
  }

  /** @param {MailItem} mail @param {{ category: string, reason: string }} res @param {string} accountUser '' = masqué */
  function addResult(mail, res, accountUser) {
    const category = /** @type {MailVerdict} */ (ORDER.includes(res.category) ? res.category : 'incertain');
    const ts = Date.parse(mail.date);
    /** @type {Entry} */
    const entry = {
      mail,
      accountUser,
      aiCategory: category,
      category,
      reason: res.reason,
      rated: false,
      ts: Number.isNaN(ts) ? 0 : ts,
      chip: buildChip(category),
      el: document.createElement('li'),
    };
    entry.el = buildRow(entry, Boolean(accountUser));
    entries.push(entry);
    // Le dernier e-mail traité apparaît tout en haut.
    list?.prepend(entry.el);
    refreshResults();
    requestAnimationFrame(() => requestAnimationFrame(() => entry.el.classList.remove('opacity-0')));
  }

  /** @param {{ user: string, message: string }[]} errors */
  function renderErrors(errors) {
    if (!errorsBox || !errorList) return;
    errorsBox.hidden = errors.length === 0;
    errorList.replaceChildren(
      ...errors.map((er) => {
        const li = document.createElement('li');
        li.className = 'text-sm';
        const who = document.createElement('p');
        who.className = 'font-medium';
        who.textContent = er.user;
        const msg = document.createElement('p');
        msg.className = 'text-danger';
        msg.textContent = er.message;
        li.append(who, msg);
        return li;
      }),
    );
  }

  // ---- Analyse ----

  /** @param {string} id @param {string} text */
  function setLabel(id, text) {
    const el = $(`[data-mail-step-label="${id}"]`);
    if (el) el.textContent = text;
    if (live) live.textContent = text;
  }

  /** @param {'fetch'|'model'|'read'|null} current */
  function setStep(current) {
    const order = ['fetch', 'model', 'read'];
    const idx = current ? order.indexOf(current) : -1;
    order.forEach((id, i) => {
      const li = $(`[data-mail-step="${id}"]`);
      if (li) li.dataset.state = i < idx ? 'done' : i === idx ? 'active' : 'todo';
    });
    const label = (/** @type {string} */ id, /** @type {string} */ text) => {
      const el = $(`[data-mail-step-label="${id}"]`);
      if (el) el.textContent = text;
    };
    label('fetch', t('mail.run.step.fetch'));
    label('model', t('mail.run.step.model'));
    label('read', t('mail.run.step.read'));
  }

  /** @param {boolean} on */
  function setRunning(on) {
    running = on;
    analyzeBtn.hidden = on;
    stopBtn.disabled = false;
    stopBtn.textContent = t('mail.run.stop');
    if (progressBox) progressBox.hidden = !on;
    saveBtn.disabled = on;
    if (addBtn) addBtn.disabled = on;
    for (const b of $$('[data-mail-account-action]')) /** @type {HTMLButtonElement} */ (b).disabled = on;
    markSeenBox.disabled = on;
    refreshModelDisabled();
    refreshRun();
  }

  stopBtn.addEventListener('click', () => {
    if (!controller) return;
    stopBtn.disabled = true;
    stopBtn.textContent = t('mail.run.stopping');
    controller.abort();
    stopGeneration().catch(() => {});
  });

  async function analyze() {
    const model = currentModel();
    say(statusEl, '');
    if (!available) {
      say(statusEl, t('chat.engine.unavailable'), true);
      return;
    }
    if (!model) {
      say(statusEl, t('mail.analyze.noModel'), true);
      return;
    }
    if (accounts.length === 0) return;

    const ctl = new AbortController();
    controller = ctl;
    const checkAbort = () => {
      if (ctl.signal.aborted) throw new DOMException('abort', 'AbortError');
    };
    resetResults();
    renderErrors([]);
    showResults(false);
    if (none) none.hidden = true;
    showBoard(false);
    setRunning(true);

    const queue = accounts.slice();
    const n = queue.length;
    /** @type {{ user: string, message: string }[]} */
    const errors = [];
    let modelReady = false;
    let done = 0;
    let total = 0;
    const doMarkSeen = markSeenBox.checked;
    /** @type {MailAccount|null} */
    let seenAcc = null;
    /** @type {number[]} uid traités du compte en cours */
    let seenUids = [];
    /** Marque comme lus les e-mails traités du compte en cours ; une erreur est notée sans arrêter le tri. */
    const flushSeen = async () => {
      const acc = seenAcc;
      const uids = seenUids;
      seenUids = [];
      if (!doMarkSeen || !acc || uids.length === 0) return;
      try {
        await api('/api/mail/seen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account: acc.id, uids }),
        });
      } catch (e) {
        errors.push({ user: acc.user, message: messageOf(e) });
      }
    };
    try {
      // Contexte d'apprentissage : réglages, mémoire, derniers avis. Sans eux, le tri continue.
      const [settings, memory, feedback] = await Promise.all([
        api('/api/mail/settings').catch(() => null),
        api('/api/mail/memory').catch(() => null),
        api(`/api/mail/feedback?limit=${FEEDBACK_LIMIT}`).catch(() => null),
      ]);
      checkAbort();
      const systemPrompt =
        typeof settings?.systemPrompt === 'string' && settings.systemPrompt.trim() ? settings.systemPrompt : undefined;
      /** @type {string[]} */
      const memoryList = Array.isArray(memory?.entries)
        ? memory.entries.map((/** @type {any} */ e) => String(e?.content ?? '').trim()).filter(Boolean)
        : [];
      const examples = Array.isArray(feedback?.items) ? feedback.items : [];
      for (let idx = 0; idx < n; idx += 1) {
        const acc = queue[idx];
        seenAcc = acc;
        seenUids = [];
        checkAbort();
        const i = idx + 1;
        setStep('fetch');
        bar.removeAttribute('value');
        setLabel('read', t('mail.run.step.read'));
        setLabel('fetch', n > 1 ? t('mail.run.step.fetchAccount', { i, n, user: acc.user }) : t('mail.run.step.fetch'));

        /** @type {MailItem[]} */
        let emails;
        try {
          const data = await api(`/api/mail/unread?account=${acc.id}`);
          emails = Array.isArray(data?.emails) ? data.emails : [];
        } catch (e) {
          checkAbort();
          errors.push({ user: acc.user, message: messageOf(e) });
          continue;
        }
        checkAbort();
        if (emails.length === 0) continue;

        total += emails.length;
        totalCount = total;
        showResults(true);
        showBoard(true);
        refreshResults();

        if (!modelReady) {
          setStep('model');
          setLabel('model', t('mail.run.step.model'));
          const status = await getEngineStatus().catch(() => null);
          if (!status || status.loadedModel !== model) await loadModel(model);
          modelReady = true;
          checkAbort();
        }

        setStep('read');
        const count = emails.length;
        const progress = (/** @type {number} */ k) => {
          bar.max = Math.max(count, 1);
          bar.value = k;
          setLabel(
            'read',
            n > 1
              ? t('mail.run.step.readAccount', { i, n, user: acc.user, done: k, total: count })
              : t('mail.run.step.readCount', { done: k, total: count }),
          );
        };
        progress(0);
        let k = 0;
        for (const mail of emails) {
          checkAbort();
          /** @type {{ category: string, reason: string }} */
          let res;
          try {
            const text = await generateText({
              model,
              messages: buildMailMessages(mail, { systemPrompt, memory: memoryList, examples }),
              maxTokens: MAIL_MAX_TOKENS,
            });
            checkAbort();
            res = parseMailVerdict(text);
          } catch (e) {
            if (ctl.signal.aborted) throw e;
            res = { category: 'incertain', reason: t('mail.results.uncertainReason') };
          }
          addResult(mail, res, n > 1 ? acc.user : '');
          seenUids.push(mail.uid);
          done += 1;
          k += 1;
          progress(k);
        }
        await flushSeen();
      }
      if (total === 0 && errors.length === 0) {
        showResults(true);
        if (summary) summary.textContent = '';
        if (none) none.hidden = false;
        showBoard(false);
      }
      say(statusEl, t('mail.analyze.done'));
    } catch (e) {
      await flushSeen();
      if (ctl.signal.aborted) say(statusEl, t('mail.analyze.stopped', { done, total }));
      else say(statusEl, messageOf(e), true);
    } finally {
      renderErrors(errors);
      controller = null;
      setRunning(false);
    }
  }

  analyzeBtn.addEventListener('click', analyze);

  resetResults();
  setStep(null);
  refreshRun();
  (async () => {
    await loadModelSetting();
    try {
      await loadAccounts();
      if (accounts.length === 0) openForm(null);
    } catch (e) {
      showSetup(true);
      say(settingsStatus, messageOf(e) || t('mail.setup.loadError'), true);
    }
    refreshRun();
  })();
}
