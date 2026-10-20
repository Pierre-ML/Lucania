// Page /emails : connexion guidée à la boîte mail et tri des e-mails non lus par un modèle local (moteur llama.cpp embarqué).
import { engineAvailable, generateText, getEngineStatus, listModels, loadModel, stopGeneration } from './engine.js';
import { getLang, t } from './i18n.js';

const SYSTEM_PROMPT =
  'Tu es un assistant qui trie des e-mails. Pour chaque e-mail, décide s’il est important ' +
  '(personnel, professionnel, urgent, administratif, facture, sécurité, rendez-vous) ou non ' +
  '(publicité, newsletter, notification automatique, réseaux sociaux). ' +
  'Réponds UNIQUEMENT par un objet JSON, sans autre texte : {"important":true ou false,"raison":"une phrase courte"}.';
const MAX_SNIPPET = 600;
const MAX_TOKENS = 120;
const MAX_ACCOUNTS = 10;

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
 * @typedef {'important'|'normal'|'uncertain'} Verdict
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

/**
 * Lit la réponse du modèle : premier objet {...}, sinon true/false isolé.
 * @param {string} text
 * @returns {{ verdict: Verdict, reason: string }}
 */
export function parseVerdict(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.indexOf('}', start + 1);
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      if (obj && typeof obj === 'object') {
        const flag = obj.important;
        const reason = String(obj.raison ?? obj.reason ?? '').trim();
        if (flag === true || flag === 'true') return { verdict: 'important', reason };
        if (flag === false || flag === 'false') return { verdict: 'normal', reason };
      }
    } catch {
      // JSON invalide : on cherche true/false dans le texte.
    }
  }
  const m = /"?important"?\s*:\s*"?(true|false)\b/i.exec(raw) || /\b(true|false)\b/i.exec(raw);
  if (m) {
    const reasonMatch = /"?(?:raison|reason)"?\s*:\s*"([^"]*)/i.exec(raw);
    return { verdict: m[1].toLowerCase() === 'true' ? 'important' : 'normal', reason: reasonMatch ? reasonMatch[1].trim() : '' };
  }
  return { verdict: 'uncertain', reason: t('mail.results.uncertainReason') };
}

/** @param {MailItem} mail */
function buildMessages(mail) {
  const snippet = String(mail.snippet || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET);
  const content =
    `Expéditeur : ${mail.from || ''}\nObjet : ${mail.subject || ''}\nDate : ${mail.date || ''}\nExtrait : ${snippet}`;
  return [
    { role: /** @type {'system'} */ ('system'), content: SYSTEM_PROMPT },
    { role: /** @type {'user'} */ ('user'), content },
  ];
}

/** Icône d'ampoule statique (SVG). */
function reasonIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'mt-0.5 size-3.5 shrink-0');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z');
  svg.append(path);
  return svg;
}

/** @param {MailItem} mail @param {string} reason @param {Verdict} verdict @param {string} accountUser adresse du compte d'origine ('' = masquée) */
function buildCard(mail, reason, verdict, accountUser) {
  const li = document.createElement('li');
  const base =
    'flex gap-3.5 rounded-2xl border p-4 opacity-0 translate-y-1 transition-[opacity,transform] duration-300 ease-out motion-reduce:translate-y-0 motion-reduce:transition-none';
  li.className = verdict === 'important' ? `${base} border-border border-l-2 border-l-fg bg-fg/[0.03]` : `${base} border-border`;

  const name = senderName(mail.from) || t('mail.results.unknownSender');

  const badge = document.createElement('span');
  badge.className = 'flex size-10 shrink-0 items-center justify-center rounded-full bg-fg/10 text-sm font-medium';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = initialOf(name);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'min-w-0 flex-1';

  const top = document.createElement('div');
  top.className = 'flex items-baseline justify-between gap-3';
  const from = document.createElement('p');
  from.className = 'truncate text-sm text-muted';
  from.textContent = name;
  const date = document.createElement('p');
  date.className = 'shrink-0 text-xs text-muted';
  date.textContent = formatDate(mail.date);
  top.append(from, date);

  const subject = document.createElement('p');
  subject.className = 'mt-0.5 font-medium [overflow-wrap:anywhere]';
  subject.textContent = mail.subject || t('mail.results.noSubject');

  bodyEl.append(top, subject);

  const snippet = String(mail.snippet || '').replace(/\s+/g, ' ').trim();
  if (snippet) {
    const sn = document.createElement('p');
    sn.className = 'mt-1 line-clamp-2 text-sm text-muted [overflow-wrap:anywhere]';
    sn.textContent = snippet;
    bodyEl.append(sn);
  }

  const why = document.createElement('p');
  why.className = 'mt-3 flex gap-2 rounded-lg bg-fg/5 px-3 py-2 text-xs text-muted';
  const whyText = document.createElement('span');
  whyText.textContent = reason || t('mail.results.noReason');
  why.append(reasonIcon(), whyText);
  bodyEl.append(why);

  if (accountUser) {
    const acc = document.createElement('p');
    acc.className = 'mt-2 truncate text-xs text-muted/70';
    acc.textContent = accountUser;
    bodyEl.append(acc);
  }

  li.append(badge, bodyEl);
  requestAnimationFrame(() => requestAnimationFrame(() => li.classList.remove('opacity-0', 'translate-y-1')));
  return li;
}

export function initEmailsPage() {
  const page = $('[data-mail-page]');
  if (!page) return;

  const form = /** @type {HTMLFormElement} */ ($('[data-mail-form]'));
  const setupBox = $('[data-mail-setup]');
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
  if (!form || !modelSel || !saveBtn || !analyzeBtn || !stopBtn || !bar) return;

  const available = engineAvailable();
  const verdicts = /** @type {Verdict[]} */ (['important', 'normal', 'uncertain']);
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
  let activeTab = /** @type {Verdict} */ ('important');
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
    field('maxEmails').value = '';
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
    field('maxEmails').value = a.maxEmails ? String(a.maxEmails) : '';
    const id = providerOfHost(a.host || '');
    if (id) {
      providerPicked = true;
      setProvider(id, true);
    }
    field('host').value = a.host || '';
    field('port').value = a.port ? String(a.port) : '';
    field('secure').checked = Boolean(a.secure);
  }

  /** @param {boolean} showForm */
  function showSetup(showForm) {
    if (setupBox) setupBox.hidden = !showForm;
    if (accountsBox) accountsBox.hidden = showForm || accounts.length === 0;
    if (cancelBtn) cancelBtn.hidden = accounts.length === 0;
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
  cancelBtn?.addEventListener('click', () => {
    say(settingsStatus, '');
    editingId = null;
    showSetup(false);
  });

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
        // Champ vide : on laisse le serveur garder sa valeur (30 par défaut).
        maxEmails: Number(field('maxEmails').value) || undefined,
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
      showSetup(accounts.length === 0);
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
    b.className = `h-9 shrink-0 cursor-pointer rounded-lg px-3 text-sm transition-colors duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${extra}`;
    b.textContent = text;
    return b;
  }

  /** @param {MailAccount} a */
  function buildAccountCard(a) {
    const li = document.createElement('li');
    li.className = 'flex items-center gap-3 rounded-2xl border border-border bg-surface/50 px-4 py-3';

    const badge = document.createElement('span');
    badge.className = 'flex size-10 shrink-0 items-center justify-center rounded-full bg-fg/10 text-sm font-medium';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = initialOf(a.user);

    const name = document.createElement('p');
    name.className = 'min-w-0 flex-1 truncate text-sm font-medium';
    name.textContent = a.user;

    const actions = document.createElement('div');
    actions.className = 'flex shrink-0 items-center gap-1';

    function showNormal() {
      const edit = accountButton(t('mail.account.edit'), 'text-muted hover:text-fg');
      edit.setAttribute('aria-label', t('mail.account.editLabel', { user: a.user }));
      edit.addEventListener('click', () => openForm(a));
      const del = accountButton(t('mail.account.delete'), 'text-muted hover:text-fg');
      del.setAttribute('aria-label', t('mail.account.deleteLabel', { user: a.user }));
      del.addEventListener('click', showConfirm);
      name.textContent = a.user;
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
          if (accounts.length === 0) openForm(null);
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
    if (accountsBox) accountsBox.hidden = accounts.length === 0 || (setupBox ? !setupBox.hidden : false);
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

  async function loadModelSetting() {
    await fillModels();
    try {
      const s = await api('/api/mail/settings');
      savedModel = typeof s?.model === 'string' ? s.model : '';
    } catch (e) {
      say(modelStatus, messageOf(e), true);
    }
    if (savedModel && ![...modelSel.options].some((o) => o.value === savedModel)) {
      const opt = document.createElement('option');
      opt.value = savedModel;
      opt.textContent = savedModel;
      modelSel.append(opt);
    }
    const real = [...modelSel.options].filter((o) => o.value);
    if (savedModel) modelSel.value = savedModel;
    else if (real.length === 1) {
      // Un seul modèle installé : choisi et enregistré d'office.
      modelSel.value = real[0].value;
      await persistModel(real[0].value);
    }
  }

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

  /** @param {Verdict} v */
  const list = (v) => $(`[data-mail-list="${v}"]`);
  const countOf = (/** @type {Verdict} */ v) => list(v)?.children.length ?? 0;

  /** @param {Verdict} v */
  function selectTab(v) {
    activeTab = v;
    for (const id of verdicts) {
      const tab = $(`[data-mail-tab="${id}"]`);
      const panel = $(`[data-mail-panel="${id}"]`);
      const on = id === v;
      tab?.setAttribute('aria-selected', String(on));
      tab?.setAttribute('tabindex', on ? '0' : '-1');
      if (panel) panel.hidden = !on;
    }
  }

  function refreshResults() {
    for (const v of verdicts) {
      const n = countOf(v);
      const count = $(`[data-mail-count="${v}"]`);
      if (count) count.textContent = String(n);
      const empty = $(`[data-mail-empty="${v}"]`);
      if (empty) empty.hidden = n > 0;
      const tab = $(`[data-mail-tab="${v}"]`);
      if (tab && v === 'uncertain') tab.hidden = n === 0;
    }
    if (activeTab === 'uncertain' && countOf('uncertain') === 0) selectTab('important');
    const n = countOf('important');
    if (summary) {
      summary.textContent =
        n === 0
          ? t('mail.results.summaryNone', { total: totalCount })
          : t(n === 1 ? 'mail.results.summaryOne' : 'mail.results.summaryMany', { n, total: totalCount });
    }
  }

  function resetResults() {
    for (const v of verdicts) list(v)?.replaceChildren();
    totalCount = 0;
    selectTab('important');
    refreshResults();
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

  /** @param {KeyboardEvent} ev */
  function onTabKey(ev) {
    const visible = $$('[data-mail-tab]').filter((b) => !b.hidden);
    const i = visible.findIndex((b) => b.dataset.mailTab === activeTab);
    let next = -1;
    if (ev.key === 'ArrowRight') next = (i + 1) % visible.length;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + visible.length) % visible.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = visible.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const target = visible[next];
    selectTab(/** @type {Verdict} */ (target.dataset.mailTab));
    target.focus();
  }
  for (const tab of $$('[data-mail-tab]')) {
    tab.addEventListener('click', () => selectTab(/** @type {Verdict} */ (tab.dataset.mailTab)));
    tab.addEventListener('keydown', onTabKey);
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
    if (results) results.hidden = true;
    if (none) none.hidden = true;
    if (board) board.hidden = true;
    setRunning(true);

    const queue = accounts.slice();
    const n = queue.length;
    /** @type {{ user: string, message: string }[]} */
    const errors = [];
    let modelReady = false;
    let done = 0;
    let total = 0;
    try {
      for (let idx = 0; idx < n; idx += 1) {
        const acc = queue[idx];
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
        if (results) results.hidden = false;
        if (board) board.hidden = false;
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
          /** @type {{ verdict: Verdict, reason: string }} */
          let res;
          try {
            const text = await generateText({ model, messages: buildMessages(mail), maxTokens: MAX_TOKENS });
            checkAbort();
            res = parseVerdict(text);
          } catch (e) {
            if (ctl.signal.aborted) throw e;
            res = { verdict: 'uncertain', reason: t('mail.results.uncertainReason') };
          }
          list(res.verdict)?.append(buildCard(mail, res.reason, res.verdict, n > 1 ? acc.user : ''));
          refreshResults();
          done += 1;
          k += 1;
          progress(k);
        }
      }
      if (total === 0 && errors.length === 0) {
        if (results) results.hidden = false;
        if (summary) summary.textContent = '';
        if (none) none.hidden = false;
        if (board) board.hidden = true;
      }
      say(statusEl, t('mail.analyze.done'));
    } catch (e) {
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
      else showSetup(false);
    } catch (e) {
      showSetup(true);
      say(settingsStatus, messageOf(e) || t('mail.setup.loadError'), true);
    }
    refreshRun();
  })();
}
