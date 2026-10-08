// Orchestration de l'interface de chat.
import { streamChat } from './ollama.js';
import { getStatus, listModels } from './connections.js';
import {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveConversation,
  setConversationThink,
  setConversationPinned,
} from './conversations.js';
import { renderMarkdown } from './markdown.js';
import { initShutdown } from './shutdown.js';
import { initSidebar, closeSidebarMobile } from './sidebar.js';
import { initModelPicker, syncModelPicker, setModelPickerData, parseModelRef, makeModelRef } from './model-picker.js';
import { confirmDialog } from './dialog.js';
import { t, getLang } from './i18n.js';

/**
 * @typedef {import('./conversations.js').Conversation} Conversation
 * @typedef {import('./conversations.js').ConversationSummary} ConversationSummary
 * @typedef {import('./conversations.js').Message} Message
 */

/** Phrases de réflexion de la langue courante (tableau `chat.thinking.phrases`). */
function thinkingWords() {
  const words = [];
  for (let i = 0; i < 200; i++) {
    const key = `chat.thinking.phrases.${i}`;
    const w = t(key);
    if (w === key) break;
    words.push(w);
  }
  return words.length ? words : [t('chat.messages.thinkingLabel')];
}
const THINKING_WORD_INTERVAL_MS = 3200;
const THINKING_FADE_MS = 300;

/**
 * Fait tourner les mots de l'indicateur de réflexion. Retourne une fonction d'arrêt.
 * @param {Element} root
 * @returns {() => void}
 */
function startThinkingWords(root) {
  const wordEl = root.querySelector('[data-role="thinking-word"]');
  if (!wordEl) return () => {};
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const words = thinkingWords();
  let last = words[Math.floor(Math.random() * words.length)];
  wordEl.textContent = last;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let fadeTimer;
  /** @type {ReturnType<typeof setInterval>|undefined} */
  let timer;
  const stop = () => {
    clearInterval(timer);
    clearTimeout(fadeTimer);
  };
  timer = setInterval(() => {
    if (!wordEl.isConnected) return stop();
    let next = last;
    while (next === last && words.length > 1) next = words[Math.floor(Math.random() * words.length)];
    last = next;
    if (reduce) {
      wordEl.textContent = next;
      return;
    }
    wordEl.classList.add('opacity-0');
    fadeTimer = setTimeout(() => {
      if (!wordEl.isConnected) return stop();
      wordEl.textContent = next;
      wordEl.classList.remove('opacity-0');
    }, THINKING_FADE_MS);
  }, THINKING_WORD_INTERVAL_MS);
  return stop;
}

const $ = (id) => document.getElementById(id);
const newChatBtn = $('new-chat-btn');
const newFolderBtn = $('new-folder-btn');
const listEl = $('conversation-list');
const chatTitle = $('chat-title');
const select = /** @type {HTMLSelectElement} */ ($('model-select'));
const statusDot = $('status-dot');
const statusLabel = $('status-label');
const statusIndicator = $('status-indicator');
const statusLink = $('status-settings-link');
const scrollEl = $('messages-scroll');
const messagesEl = $('messages');
const emptyState = $('empty-state');
const form = /** @type {HTMLFormElement} */ ($('composer-form'));
const input = /** @type {HTMLTextAreaElement} */ ($('composer-input'));
const sendBtn = /** @type {HTMLButtonElement} */ ($('send-btn'));
const stopBtn = /** @type {HTMLButtonElement} */ ($('stop-btn'));
const thinkToggle = /** @type {HTMLButtonElement|null} */ ($('think-toggle'));

const defaultTitle = () => t('chat.header.defaultTitle');
const defaultFolderName = () => t('chat.list.defaultFolderName');

/** @type {string|null} */
let currentId = null;
/** @type {Conversation|null} */
let current = null;
/** @type {ConversationSummary[]} */
let conversations = [];
/** @type {import('./conversations.js').Folder[]} */
let folders = [];
/** @type {Set<string>} */
const collapsed = loadCollapsed();
let streaming = false;
/** @type {AbortController|null} */
let abortController = null;
let ignoreHash = false;
let loadToken = 0;
/** @type {{ online: boolean, connections: Array<{ id: string, name: string, kind: string, online: boolean, latencyMs?: number|null }> }} */
let lastStatus = { online: false, connections: [] };
let statusLoaded = false;
/** @type {Array<{ connectionId: string, connectionName: string, kind: 'local'|'remote', name: string, source?: string, available: boolean }>} */
let modelList = [];
let modelsLoaded = false;

const SVG_CHEVRON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const SVG_FOLDER =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const SVG_MOVE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M8.5 13h7M13 10.5l2.5 2.5-2.5 2.5"/></svg>';
const SVG_EDIT =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const SVG_PIN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 6.5 3.5 3.5V15h-11v-2L10 9.5Z"/></svg>';
const SVG_PIN_SMALL =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 6.5 3.5 3.5V15h-11v-2L10 9.5Z"/></svg>';
const SVG_TRASH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4h8v2"/></svg>';

/* ---------- Classes Tailwind (noms complets et statiques, scannés comme du texte) ---------- */

const DROP =
  'data-[drop=true]:bg-accent/10 data-[drop=true]:text-fg data-[drop=true]:ring-1 data-[drop=true]:ring-inset data-[drop=true]:ring-accent/45';

const CLS = {
  // Messages
  msg: 'flex flex-col gap-2',
  msgUser: 'items-end',
  msgAssistant: 'w-full items-start font-serif',
  contentUser:
    'max-w-[85%] whitespace-pre-wrap rounded-2xl bg-bubble px-4 py-2.5 font-sans [overflow-wrap:anywhere]',
  contentAssistant:
    'prose prose-ia w-full max-w-none font-serif text-[1.0625rem] leading-[1.75] [overflow-wrap:anywhere] empty:hidden ' +
    'prose-a:text-accent-hover prose-strong:text-fg ' +
    'prose-pre:rounded-[0.625rem] prose-pre:border prose-pre:border-border prose-pre:bg-code ' +
    'prose-code:rounded prose-code:bg-code prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none ' +
    '[&_pre_code]:rounded-none [&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
    'prose-th:border prose-th:border-border prose-th:bg-surface prose-th:px-3 prose-th:py-1.5 prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5',
  msgMeta: 'font-sans text-[0.7rem] text-muted',
  msgError:
    'rounded-[0.625rem] border border-danger/35 bg-danger/7 px-3.5 py-2 font-sans text-[0.9rem] text-[#ffb3b4]',
  // Bloc Réflexion (<details>)
  thinking:
    'group mb-3 w-full border-l-2 border-border py-0.5 pl-3 font-sans text-[0.8125rem] leading-normal text-muted',
  thinkingSummary:
    'flex w-fit cursor-pointer list-none items-center gap-1.5 select-none text-muted transition-colors hover:text-fg focus-visible:rounded focus-visible:outline-border [&::-webkit-details-marker]:hidden',
  thinkingChevron:
    'ml-0.5 size-[0.4rem] flex-none -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current transition-transform duration-150 group-open:rotate-45 motion-reduce:transition-none',
  thinkingBody:
    'mt-1.5 max-h-56 overflow-y-auto pr-2 font-sans text-[0.8125rem] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]',
  // Liste
  emptyList: 'px-3 py-2 text-sm text-muted',
  convGroup: `cursor-default list-none px-3 pt-4 pb-1 text-xs leading-4 font-medium text-muted select-none first:pt-1 ${DROP}`,
  convItem:
    'group relative flex cursor-pointer items-center gap-1 rounded-lg py-1.5 pr-2 pl-3 text-sm text-muted transition-colors hover:bg-white/4 hover:text-fg data-[active=true]:bg-accent/8 data-[active=true]:text-fg data-[dragging=true]:opacity-50',
  convBar:
    'pointer-events-none absolute inset-y-2 left-0 hidden w-0.5 rounded-full bg-accent group-data-[active=true]:block',
  convTitle: 'min-w-0 flex-1 truncate',
  convPin: 'inline-flex flex-none text-muted [&>svg]:size-3',
  convActions: 'hidden gap-0.5 group-hover:flex group-focus-within:flex group-data-[active=true]:flex',
  folderActions: 'hidden gap-0.5 group-hover:flex group-focus-within:flex',
  iconBtn:
    'inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-fg [&>svg]:size-4',
  renameInput:
    'min-w-0 flex-1 rounded-md border border-accent bg-code px-1.5 py-0.5 text-sm text-fg outline-none',
  // Dossiers
  folder: 'group/folder list-none',
  folderHeader: `peer group flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors select-none hover:bg-white/4 hover:text-fg motion-reduce:transition-none ${DROP}`,
  folderChevron:
    'inline-flex size-3.5 flex-none items-center justify-center transition-transform duration-200 group-aria-expanded:rotate-90 motion-reduce:transition-none [&>svg]:size-3',
  folderIcon:
    'inline-flex flex-none text-muted transition-colors group-data-[has-active=true]/folder:text-accent/75 [&>svg]:size-[17px]',
  folderName: 'min-w-0 flex-1 truncate text-sm',
  folderCount:
    'flex-none text-xs leading-4 text-muted tabular-nums group-hover:hidden group-focus-within:hidden',
  folderChildren:
    'mt-0.5 mb-1 ml-3 hidden list-none flex-col gap-0.5 border-l border-border pl-1 peer-aria-expanded:flex',
  folderEmpty: 'cursor-default list-none px-3 py-1.5 text-xs leading-4 text-muted italic select-none',
  // Menu « Déplacer »
  moveMenu:
    'fixed z-50 max-h-[min(20rem,calc(100vh_-_16px))] max-w-[min(18rem,calc(100vw_-_16px))] min-w-48 origin-top-left animate-pop-in overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-[0_12px_32px_rgb(0_0_0/0.55),0_2px_8px_rgb(0_0_0/0.4)] motion-reduce:animate-none',
  moveItem:
    'relative block w-full cursor-pointer truncate rounded-md py-1.5 pr-7 pl-2.5 text-left text-sm leading-5 text-fg transition-colors hover:bg-white/6 focus-visible:bg-white/6 focus-visible:outline-none after:absolute after:top-1/2 after:right-2.5 after:-translate-y-1/2 after:text-accent-hover data-[checked=true]:after:content-["✓"]',
  moveSep: 'mx-0.5 my-1 h-px border-0 bg-border',
};

const ROLE_CONV_ITEM = '[data-role="conv-item"]';
const ROLE_CONV_GROUP = '[data-role="conv-group"]';
const ROLE_FOLDER = '[data-role="folder"]';
const ROLE_FOLDER_HEADER = '[data-role="folder-header"]';

/* ---------- Utilitaires ---------- */

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem('collapsedFolders') || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function hashId() {
  const m = /^#\/c\/(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function setHash(id) {
  const url = id ? `#/c/${encodeURIComponent(id)}` : location.pathname + location.search;
  history.replaceState(null, '', url);
}

function nearBottom() {
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
}

function scrollToBottom() {
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

function formatMeta(message, withModel) {
  const d = new Date(message.createdAt);
  if (isNaN(d.getTime())) return withModel ? message.model : '';
  const time = d.toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' });
  let when = time;
  if (d.toDateString() !== new Date().toDateString()) {
    when = `${d.toLocaleDateString(getLang(), { day: '2-digit', month: '2-digit' })} ${time}`;
  }
  return withModel ? `${message.model} · ${when}` : when;
}

function autoTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 50 ? t.slice(0, 50) + '…' : t;
}

/** Erreur de configuration avec lien vers les Paramètres. @param {string} text */
function showSettingsError(text) {
  messagesEl.querySelectorAll('[data-role="msg-error"][data-kind="settings"]').forEach((n) => n.remove());
  const div = document.createElement('div');
  div.className = CLS.msgError;
  div.dataset.role = 'msg-error';
  div.dataset.kind = 'settings';
  div.append(`${text} `);
  const a = document.createElement('a');
  a.href = '/parametres';
  a.className = 'underline underline-offset-2 hover:opacity-80';
  a.textContent = t('chat.messages.openSettings');
  div.appendChild(a);
  messagesEl.appendChild(div);
  scrollToBottom();
}

/** Affiche une erreur non bloquante dans le fil. */
function showError(text) {
  console.error(text);
  const div = document.createElement('div');
  div.className = CLS.msgError;
  div.dataset.role = 'msg-error';
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

/* ---------- Statut des serveurs ---------- */

const kindLabel = (kind) => (kind === 'local' || kind === 'remote' ? t(`chat.status.${kind}`) : kind);

/** Description d'une connexion pour l'infobulle. @param {{ name: string, kind: string, online: boolean, latencyMs?: number|null }} c */
function describeConnection(c) {
  const kind = kindLabel(c.kind);
  const state = c.online
    ? typeof c.latencyMs === 'number'
      ? t('chat.status.onlineLatency', { ms: Math.round(c.latencyMs) })
      : t('chat.status.online')
    : t('chat.status.offline');
  return t('chat.status.connection', { name: c.name, kind, state });
}

function renderStatus() {
  if (!statusLoaded) return;
  const conns = lastStatus.connections;
  statusLink.dataset.show = String(conns.length === 0);
  if (conns.length === 0) {
    statusDot.dataset.status = 'none';
    statusLabel.textContent = t('chat.status.none');
    statusIndicator.title = '';
    return;
  }
  const up = conns.filter((c) => c.online);
  statusDot.dataset.status = up.length > 0 ? 'online' : 'offline';
  statusIndicator.title = conns.map(describeConnection).join('\n');
  const meta = modelMeta.get(select.value);
  const selectedConn = meta ? conns.find((c) => c.id === meta.connectionId) : null;
  if (meta && !meta.available && selectedConn && selectedConn.online) {
    statusLabel.textContent = t('chat.status.modelUnavailable', { name: meta.connectionName });
  } else if (conns.length === 1) {
    statusLabel.textContent = up.length ? t('chat.status.connected', { name: conns[0].name }) : t('chat.status.unreachable', { name: conns[0].name });
  } else {
    statusLabel.textContent = t('chat.status.serversConnected', { up: up.length, total: conns.length });
  }
}

async function refreshStatus() {
  const [status, models] = await Promise.all([getStatus(), listModels().catch(() => null)]);
  lastStatus = status;
  statusLoaded = true;
  if (models) modelList = models;
  modelsLoaded = true;
  updateModelSelect(); // reconstruit les options puis renderStatus()
}

/* ---------- Modèle ---------- */

/** @type {Map<string, { connectionId: string, connectionName: string, kind: 'local'|'remote', online: boolean|null, available: boolean }>} */
let modelMeta = new Map();

const connInfo = (id) => lastStatus.connections.find((c) => c.id === id) || null;

/** Référence (valeur composite) du modèle de la conversation courante, ou null. */
function currentRef() {
  if (!current || !current.model) return null;
  let connectionId = current.connectionId || '';
  if (!connectionId) {
    const m = modelList.find((x) => x.name === current.model); // anciennes conversations sans connexion
    if (m) connectionId = m.connectionId;
  }
  return makeModelRef(connectionId, current.model);
}

function selectDefaultModel() {
  let last = null;
  try {
    last = localStorage.getItem('lastModel');
  } catch {
    /* ignore */
  }
  const values = Array.from(select.options).map((o) => o.value);
  if (last && values.includes(last)) select.value = last;
  else if (values.length) select.value = values.find((v) => modelMeta.get(v)?.available !== false) || values[0];
}

/** Reconstruit les options du <select> à partir de la liste des modèles (groupés par connexion). */
function rebuildModelOptions() {
  const prev = select.value;
  /** @type {Map<string, typeof modelList>} */
  const groups = new Map();
  for (const m of modelList) {
    if (!groups.has(m.connectionId)) groups.set(m.connectionId, []);
    groups.get(m.connectionId).push(m);
  }
  const meta = new Map();
  const options = [];
  const add = (value, text, info) => {
    if (meta.has(value)) return;
    meta.set(value, info);
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    options.push(opt);
  };
  for (const [connectionId, models] of groups) {
    const ci = connInfo(connectionId);
    for (const m of models) {
      add(makeModelRef(connectionId, m.name), m.name, {
        connectionId,
        connectionName: m.connectionName,
        kind: m.kind,
        online: ci ? !!ci.online : null,
        available: m.available !== false,
      });
    }
  }
  const ref = currentRef();
  if (ref && !meta.has(ref)) {
    const { connectionId } = parseModelRef(ref);
    const ci = connInfo(connectionId);
    add(ref, t('chat.picker.unavailableOption', { model: current.model }), {
      connectionId,
      connectionName: ci ? ci.name : connectionId ? t('chat.picker.deletedConnection') : t('chat.picker.unknownConnection'),
      kind: ci && ci.kind === 'remote' ? 'remote' : 'local',
      online: ci ? !!ci.online : null,
      available: false,
    });
  }
  modelMeta = meta;
  select.replaceChildren(...options);
  if (prev && meta.has(prev)) select.value = prev;
  else selectDefaultModel();
  setModelPickerData(meta, modelsLoaded);
}

function updateModelSelect() {
  rebuildModelOptions();
  if (current && current.messages.length > 0) {
    const ref = currentRef();
    if (ref) select.value = ref;
    select.disabled = true;
    select.title = t('chat.picker.lockedShort');
  } else {
    select.disabled = false;
    select.title = '';
    if (!current) selectDefaultModel();
  }
  syncModelPicker();
  renderStatus();
}

select.addEventListener('change', () => {
  if (select.value && !select.disabled) {
    try {
      localStorage.setItem('lastModel', select.value);
    } catch {
      /* ignore */
    }
  }
  renderStatus();
});

/* ---------- Réflexion (think) ---------- */

function loadLastThink() {
  try {
    return localStorage.getItem('lastThink') !== '0';
  } catch {
    return true;
  }
}

let thinkEnabled = loadLastThink();

function renderThinkToggle() {
  if (!thinkToggle) return;
  thinkToggle.setAttribute('aria-pressed', String(thinkEnabled));
  thinkToggle.title = thinkEnabled
    ? t('chat.composer.thinkOn')
    : t('chat.composer.thinkOff');
}

if (thinkToggle) {
  thinkToggle.addEventListener('click', async () => {
    const previous = thinkEnabled;
    thinkEnabled = !previous;
    try {
      localStorage.setItem('lastThink', thinkEnabled ? '1' : '0');
    } catch {
      /* ignore */
    }
    renderThinkToggle();
    const conv = current;
    if (!conv) return;
    conv.think = thinkEnabled;
    try {
      await setConversationThink(conv.id, thinkEnabled);
      const summary = conversations.find((c) => c.id === conv.id);
      if (summary) summary.think = thinkEnabled;
    } catch (err) {
      conv.think = previous;
      if (current === conv) {
        thinkEnabled = previous;
        renderThinkToggle();
      }
      showError(t('chat.composer.thinkError', { message: err.message }));
    }
  });
}

/* ---------- Liste des conversations ---------- */

/** Libellé de groupe (heure locale) pour une date de mise à jour. */
function groupLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return t('chat.list.older');
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n) => new Date(startToday.getFullYear(), startToday.getMonth(), startToday.getDate() - n).getTime();
  const ts = d.getTime();
  if (ts >= startToday.getTime()) return t('chat.list.today');
  if (ts >= daysAgo(1)) return t('chat.list.yesterday');
  if (ts >= daysAgo(7)) return t('chat.list.last7');
  if (ts >= daysAgo(30)) return t('chat.list.last30');
  const m = d.toLocaleDateString(getLang(), { month: 'long', year: 'numeric' });
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** @returns {string|null} */
function folderOf(c) {
  return c.folderId ?? null;
}

function saveCollapsed() {
  try {
    localStorage.setItem('collapsedFolders', JSON.stringify([...collapsed]));
  } catch {
    /* ignore */
  }
}

/** Ouvre un dossier (le retire de la liste des repliés). */
function expandFolder(id) {
  if (id && collapsed.delete(id)) saveCollapsed();
}

/** Le dossier contenant la conversation active doit être ouvert. */
function ensureActiveFolderOpen() {
  if (!currentId) return;
  const summary = conversations.find((c) => c.id === currentId);
  const fid = summary ? folderOf(summary) : current ? current.folderId ?? null : null;
  expandFolder(fid);
}

function createConvItem(c) {
  const li = document.createElement('li');
  li.className = CLS.convItem;
  li.dataset.role = 'conv-item';
  if (c.id === currentId) li.dataset.active = 'true';
  li.dataset.id = c.id;
  li.draggable = true;
  const bar = document.createElement('span');
  bar.className = CLS.convBar;
  bar.setAttribute('aria-hidden', 'true');
  let pinIcon = null;
  if (c.pinned) {
    pinIcon = document.createElement('span');
    pinIcon.className = CLS.convPin;
    pinIcon.dataset.role = 'conv-pin';
    pinIcon.setAttribute('aria-hidden', 'true');
    pinIcon.innerHTML = SVG_PIN_SMALL;
  }
  const title = document.createElement('span');
  title.className = CLS.convTitle;
  title.dataset.role = 'conv-title';
  title.textContent = c.title;
  const actions = document.createElement('div');
  actions.className = CLS.convActions;
  const pinLabel = c.pinned ? t('chat.list.unpin') : t('chat.list.pin');
  const moveLabel = t('chat.list.moveToFolder');
  const renameLabel = t('chat.list.rename');
  const deleteLabel = t('chat.list.delete');
  actions.innerHTML =
    `<button type="button" class="${CLS.iconBtn}" data-action="pin" title="${pinLabel}" aria-label="${pinLabel}" aria-pressed="${c.pinned ? 'true' : 'false'}">${SVG_PIN}</button>` +
    `<button type="button" class="${CLS.iconBtn}" data-action="move" title="${moveLabel}" aria-label="${moveLabel}" aria-haspopup="menu">${SVG_MOVE}</button>` +
    `<button type="button" class="${CLS.iconBtn}" data-action="rename" title="${renameLabel}" aria-label="${renameLabel}">${SVG_EDIT}</button>` +
    `<button type="button" class="${CLS.iconBtn}" data-action="delete" title="${deleteLabel}" aria-label="${deleteLabel}">${SVG_TRASH}</button>`;
  if (pinIcon) li.append(bar, pinIcon, title, actions);
  else li.append(bar, title, actions);
  return li;
}

function createFolderEl(f, items) {
  const open = !collapsed.has(f.id);
  const li = document.createElement('li');
  li.className = CLS.folder;
  li.dataset.role = 'folder';
  if (items.some((c) => c.id === currentId)) li.dataset.hasActive = 'true';
  li.dataset.folderId = f.id;

  const header = document.createElement('div');
  header.className = CLS.folderHeader;
  header.dataset.role = 'folder-header';
  header.setAttribute('role', 'button');
  header.tabIndex = 0;
  header.setAttribute('aria-expanded', String(open));
  const chevron = document.createElement('span');
  chevron.className = CLS.folderChevron;
  chevron.innerHTML = SVG_CHEVRON;
  const icon = document.createElement('span');
  icon.className = CLS.folderIcon;
  icon.innerHTML = SVG_FOLDER;
  const name = document.createElement('span');
  name.className = CLS.folderName;
  name.dataset.role = 'folder-name';
  name.textContent = f.name;
  name.title = f.name;
  const renameFolderLabel = t('chat.list.renameFolder');
  const deleteFolderLabel = t('chat.list.deleteFolder');
  const count = document.createElement('span');
  count.className = CLS.folderCount;
  count.textContent = String(items.length);
  const actions = document.createElement('div');
  actions.className = CLS.folderActions;
  actions.innerHTML =
    `<button type="button" class="${CLS.iconBtn}" data-action="rename-folder" title="${renameFolderLabel}" aria-label="${renameFolderLabel}">${SVG_EDIT}</button>` +
    `<button type="button" class="${CLS.iconBtn}" data-action="delete-folder" title="${deleteFolderLabel}" aria-label="${deleteFolderLabel}">${SVG_TRASH}</button>`;
  header.append(chevron, icon, name, count, actions);

  const children = document.createElement('ul');
  children.className = CLS.folderChildren;
  children.dataset.role = 'folder-children';
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = CLS.folderEmpty;
    empty.dataset.role = 'folder-empty';
    empty.setAttribute('role', 'presentation');
    empty.textContent = t('chat.list.folderEmpty');
    children.appendChild(empty);
  } else {
    for (const c of items) children.appendChild(createConvItem(c));
  }
  li.append(header, children);
  return li;
}

function renderList() {
  listEl.replaceChildren();
  if (conversations.length === 0 && folders.length === 0) {
    const li = document.createElement('li');
    li.className = CLS.emptyList;
    li.textContent = t('chat.list.empty');
    listEl.appendChild(li);
    return;
  }
  const byUpdated = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
  const known = new Set(folders.map((f) => f.id));
  const pinned = conversations.filter((c) => c.pinned).sort(byUpdated);
  if (pinned.length > 0) {
    const pl = document.createElement('li');
    pl.className = CLS.convGroup;
    pl.dataset.role = 'pin-group';
    pl.setAttribute('role', 'presentation');
    pl.textContent = t('chat.list.pinned');
    listEl.appendChild(pl);
    for (const c of pinned) listEl.appendChild(createConvItem(c));
  }
  for (const f of folders) {
    const items = conversations.filter((c) => !c.pinned && folderOf(c) === f.id).sort(byUpdated);
    listEl.appendChild(createFolderEl(f, items));
  }
  // Conversations sans dossier (ou dont le dossier est inconnu).
  const rootItems = conversations.filter((c) => !c.pinned && !known.has(folderOf(c))).sort(byUpdated);
  if (rootItems.length > 0 && folders.length > 0) {
    const label = document.createElement('li');
    label.className = CLS.convGroup;
    label.dataset.role = 'conv-group';
    label.setAttribute('role', 'presentation');
    label.textContent = t('chat.list.conversations');
    listEl.appendChild(label);
  }
  let lastGroup = null;
  for (const c of rootItems) {
    const group = groupLabel(c.updatedAt);
    if (group !== lastGroup) {
      lastGroup = group;
      const gli = document.createElement('li');
      gli.className = CLS.convGroup;
      gli.dataset.role = 'conv-group';
      gli.setAttribute('role', 'presentation');
      gli.textContent = group;
      listEl.appendChild(gli);
    }
    listEl.appendChild(createConvItem(c));
  }
}

async function refreshList() {
  const [convs, flds] = await Promise.all([
    listConversations().catch((err) => {
      console.error(err);
      return null;
    }),
    listFolders().catch((err) => {
      console.error(err);
      return null;
    }),
  ]);
  if (convs) conversations = convs;
  if (flds) folders = flds;
  renderList();
}

/** Renommage inline générique : remplace `span` par un input ; `onSave(value)` est appelé si la valeur change. */
function inlineRename(span, initial, onSave) {
  const field = document.createElement('input');
  field.className = CLS.renameInput;
  field.dataset.role = 'rename-input';
  field.type = 'text';
  field.value = initial;
  span.replaceWith(field);
  field.focus();
  field.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = field.value.trim();
    if (save && value && value !== initial) await onSave(value);
    renderList();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  field.addEventListener('blur', () => finish(true));
}

function startRename(li) {
  const id = li.dataset.id;
  const summary = conversations.find((c) => c.id === id);
  const span = li.querySelector('[data-role="conv-title"]');
  if (!summary || !span) return;
  inlineRename(span, summary.title, async (value) => {
    try {
      const updated = await updateConversation(summary.id, { title: value });
      summary.title = updated.title;
      if (current && current.id === summary.id) {
        current.title = updated.title;
        chatTitle.textContent = updated.title;
      }
    } catch (err) {
      console.error(err);
      showError(t('chat.errors.rename', { message: err.message }));
    }
  });
}

/* ---------- Dossiers ---------- */

function findFolderEl(id) {
  return /** @type {HTMLElement|null} */ (
    Array.from(listEl.querySelectorAll(ROLE_FOLDER)).find((el) => /** @type {HTMLElement} */ (el).dataset.folderId === id) || null
  );
}

function startFolderRename(id) {
  const folder = folders.find((f) => f.id === id);
  const el = findFolderEl(id);
  const span = el && el.querySelector('[data-role="folder-name"]');
  if (!folder || !span) return;
  inlineRename(span, folder.name, async (value) => {
    try {
      const updated = await renameFolder(folder.id, value);
      folder.name = updated.name;
    } catch (err) {
      console.error(err);
      showError(t('chat.errors.renameFolder', { message: err.message }));
    }
  });
}

/** Crée un dossier « Nouveau dossier » ; renvoie le dossier ou null en cas d'erreur. */
async function makeFolder() {
  try {
    const f = await createFolder(defaultFolderName());
    folders.push(f);
    return f;
  } catch (err) {
    console.error(err);
    showError(t('chat.errors.createFolder', { message: err.message }));
    return null;
  }
}

async function newFolder() {
  const f = await makeFolder();
  if (!f) return;
  renderList();
  const el = findFolderEl(f.id);
  if (el) el.scrollIntoView({ block: 'nearest' });
  startFolderRename(f.id);
}

async function removeFolder(id) {
  const folder = folders.find((f) => f.id === id);
  if (!folder) return;
  const ok = await confirmDialog({
    title: t('chat.dialogs.deleteFolderTitle'),
    message: t('chat.dialogs.deleteFolderMessage', { name: folder.name }),
    confirmLabel: t('common.delete'),
  });
  if (!ok) return;
  try {
    await deleteFolder(folder.id);
    if (collapsed.delete(folder.id)) saveCollapsed();
  } catch (err) {
    console.error(err);
    showError(t('chat.errors.deleteFolder', { message: err.message }));
  }
  await refreshList();
}

function toggleFolder(header) {
  const li = header.closest(ROLE_FOLDER);
  const id = li && /** @type {HTMLElement} */ (li).dataset.folderId;
  if (!id) return;
  const open = header.getAttribute('aria-expanded') !== 'true';
  header.setAttribute('aria-expanded', String(open));
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  saveCollapsed();
}

/** Déplace une conversation vers un dossier (ou null) puis rafraîchit. */
async function applyMove(convId, folderId) {
  const summary = conversations.find((c) => c.id === convId);
  if (!summary || folderOf(summary) === folderId) return true;
  try {
    await moveConversation(convId, folderId);
    summary.folderId = folderId;
    if (current && current.id === convId) current.folderId = folderId;
    if (folderId && convId === currentId) expandFolder(folderId);
    await refreshList();
    return true;
  } catch (err) {
    console.error(err);
    showError(t('chat.errors.move', { message: err.message }));
    return false;
  }
}

async function togglePin(id) {
  const summary = conversations.find((c) => c.id === id);
  if (!summary) return;
  const next = !summary.pinned;
  try {
    await setConversationPinned(summary.id, next);
    summary.pinned = next;
    if (current && current.id === summary.id) current.pinned = next;
    renderList();
  } catch (err) {
    console.error(err);
    showError(t('chat.errors.pin', { message: err.message }));
  }
}

/* Menu flottant « Déplacer vers un dossier » */

/** @type {{ el: HTMLElement, convId: string, btn: HTMLElement, cleanup: () => void }|null} */
let moveMenu = null;

function closeMoveMenu(restoreFocus = false) {
  if (!moveMenu) return;
  const { el, btn, cleanup } = moveMenu;
  moveMenu = null;
  cleanup();
  el.remove();
  if (restoreFocus && btn.isConnected) btn.focus();
}

function openMoveMenu(btn, convId) {
  closeMoveMenu();
  const summary = conversations.find((c) => c.id === convId);
  if (!summary) return;
  const currentFolder = folderOf(summary);

  const menu = document.createElement('div');
  menu.className = CLS.moveMenu;
  menu.dataset.role = 'move-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('chat.list.moveToFolder'));

  const addItem = (label, checked, onSelect) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = CLS.moveItem;
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.textContent = label;
    if (checked) b.dataset.checked = 'true';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMoveMenu();
      onSelect();
    });
    menu.appendChild(b);
  };
  if (currentFolder) addItem(t('chat.list.noFolder'), false, () => applyMove(convId, null));
  for (const f of folders) addItem(f.name, f.id === currentFolder, () => applyMove(convId, f.id));
  if (menu.children.length > 0) {
    const sep = document.createElement('div');
    sep.className = CLS.moveSep;
    sep.setAttribute('role', 'separator');
    menu.appendChild(sep);
  }
  addItem(t('chat.list.newFolderEllipsis'), false, async () => {
    const f = await makeFolder();
    if (!f) return;
    const ok = await applyMove(convId, f.id);
    if (!ok) await refreshList();
    expandFolder(f.id);
    renderList();
    startFolderRename(f.id);
  });

  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const pad = 8;
  let left = r.right - w;
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - pad) top = r.top - h - 4;
  top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';

  const items = () => /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitem"]')));
  const onPointerDown = (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (menu.contains(t) || t.closest('[data-action="move"]')) return;
    closeMoveMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMoveMenu(true);
      return;
    }
    if (e.key === 'Tab') {
      closeMoveMenu();
      return;
    }
    const list = items();
    const idx = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    let next = -1;
    if (e.key === 'ArrowDown') next = (idx + 1) % list.length;
    else if (e.key === 'ArrowUp') next = idx <= 0 ? list.length - 1 : idx - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next >= 0) {
      e.preventDefault();
      list[next].focus();
    }
  };
  const onDismiss = () => closeMoveMenu();
  const scroller = listEl.closest('nav') || listEl;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKey, true);
  scroller.addEventListener('scroll', onDismiss);
  window.addEventListener('resize', onDismiss);
  moveMenu = {
    el: menu,
    convId,
    btn,
    cleanup() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      scroller.removeEventListener('scroll', onDismiss);
      window.removeEventListener('resize', onDismiss);
    },
  };
  const first = items().find((i) => i.dataset.checked === 'true') || items()[0];
  if (first) first.focus();
}

/* ---------- Événements de la liste ---------- */

listEl.addEventListener('click', async (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.closest('[data-role="rename-input"]')) return;

  const header = /** @type {HTMLElement|null} */ (target.closest(ROLE_FOLDER_HEADER));
  if (header) {
    const folderId = /** @type {HTMLElement} */ (header.closest(ROLE_FOLDER)).dataset.folderId;
    const btn = target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      if (action === 'rename-folder') startFolderRename(folderId);
      else if (action === 'delete-folder') await removeFolder(folderId);
    } else {
      toggleFolder(header);
    }
    return;
  }

  const li = /** @type {HTMLElement|null} */ (target.closest(ROLE_CONV_ITEM));
  if (!li) return;
  const id = li.dataset.id;
  const actionBtn = target.closest('[data-action]');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.getAttribute('data-action');
    if (action === 'move') {
      if (moveMenu && moveMenu.convId === id) closeMoveMenu();
      else openMoveMenu(/** @type {HTMLElement} */ (actionBtn), id);
    } else if (action === 'pin') await togglePin(id);
    else if (action === 'rename') startRename(li);
    else if (action === 'delete') {
      const summary = conversations.find((c) => c.id === id);
      if (!summary) return;
      const ok = await confirmDialog({
        title: t('chat.dialogs.deleteConversationTitle'),
        message: t('chat.dialogs.deleteConversationMessage', { title: summary.title }),
        confirmLabel: t('common.delete'),
      });
      if (!ok) return;
      try {
        await deleteConversation(summary.id);
        if (currentId === summary.id) newConversation();
        await refreshList();
      } catch (err) {
        showError(t('chat.errors.delete', { message: err.message }));
      }
    }
    return;
  }
  if (id) {
    location.hash = `#/c/${encodeURIComponent(id)}`;
    closeSidebarMobile();
  }
});

listEl.addEventListener('keydown', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.dataset.role !== 'folder-header') return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleFolder(target);
  }
});

listEl.addEventListener('dblclick', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.dataset.role === 'folder-name') {
    const fl = target.closest(ROLE_FOLDER);
    if (fl) startFolderRename(/** @type {HTMLElement} */ (fl).dataset.folderId);
    return;
  }
  if (target.dataset.role !== 'conv-title') return;
  const li = target.closest(ROLE_CONV_ITEM);
  if (li) startRename(/** @type {HTMLElement} */ (li));
});

/* Glisser-déposer (desktop) */

/** @type {string|null} */
let draggingId = null;

function clearDropTargets() {
  for (const el of listEl.querySelectorAll('[data-drop]')) el.removeAttribute('data-drop');
}

/** Résout la zone de dépôt : { folderId, el } ou null si non valide. */
function dropZone(target) {
  const fl = target.closest(ROLE_FOLDER);
  if (fl) return { folderId: /** @type {HTMLElement} */ (fl).dataset.folderId, el: fl.querySelector(ROLE_FOLDER_HEADER) };
  const root = target.closest(`${ROLE_CONV_GROUP}, ${ROLE_CONV_ITEM}`);
  if (root) return { folderId: null, el: /** @type {HTMLElement} */ (root).dataset.role === 'conv-group' ? root : null };
  if (target === listEl) return { folderId: null, el: null };
  return null;
}

listEl.addEventListener('dragstart', (e) => {
  const li = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.(ROLE_CONV_ITEM));
  if (!li || !e.dataTransfer) return;
  draggingId = li.dataset.id;
  e.dataTransfer.setData('text/plain', draggingId);
  e.dataTransfer.effectAllowed = 'move';
  li.dataset.dragging = 'true';
});

listEl.addEventListener('dragend', () => {
  draggingId = null;
  clearDropTargets();
  for (const el of listEl.querySelectorAll('[data-dragging]')) el.removeAttribute('data-dragging');
});

listEl.addEventListener('dragover', (e) => {
  if (!draggingId) return;
  const zone = dropZone(/** @type {HTMLElement} */ (e.target));
  clearDropTargets();
  if (!zone) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (zone.el) /** @type {HTMLElement} */ (zone.el).dataset.drop = 'true';
});

listEl.addEventListener('dragleave', (e) => {
  const to = /** @type {Node|null} */ (e.relatedTarget);
  if (!to || !listEl.contains(to)) clearDropTargets();
});

listEl.addEventListener('drop', async (e) => {
  if (!draggingId) return;
  const zone = dropZone(/** @type {HTMLElement} */ (e.target));
  const id = e.dataTransfer?.getData('text/plain') || draggingId;
  clearDropTargets();
  draggingId = null;
  if (!zone || !id) return;
  e.preventDefault();
  for (const el of listEl.querySelectorAll('[data-dragging]')) el.removeAttribute('data-dragging');
  await applyMove(id, zone.folderId);
});

if (newFolderBtn) newFolderBtn.addEventListener('click', newFolder);

/* ---------- Rendu des messages ---------- */

function updateEmptyState() {
  const has = !!current && current.messages.length > 0;
  emptyState.classList.toggle('hidden', has || messagesEl.children.length > 0);
}

/**
 * @param {Message} m
 * @param {number} [thinkSecs] durée de réflexion mesurée pendant le stream (optionnelle)
 */
function createMessageEl(m, thinkSecs) {
  const wrap = document.createElement('div');
  wrap.className = `${CLS.msg} ${m.role === 'user' ? CLS.msgUser : CLS.msgAssistant}`;
  wrap.dataset.role = 'msg';
  if (m.role === 'assistant' && m.thinking) {
    const d = createThinkingEl(m.thinking, false);
    if (thinkSecs) setThinkingSummary(d, thinkSecs);
    wrap.appendChild(d);
  }
  const content = document.createElement('div');
  content.className = m.role === 'user' ? CLS.contentUser : CLS.contentAssistant;
  content.dataset.role = 'msg-content';
  if (m.role === 'user') content.textContent = m.content;
  else content.innerHTML = renderMarkdown(m.content);
  const meta = document.createElement('div');
  meta.className = CLS.msgMeta;
  meta.dataset.role = 'msg-meta';
  meta.textContent = formatMeta(m, m.role === 'assistant');
  wrap.append(content, meta);
  return wrap;
}

function createThinkingEl(text, open) {
  const details = document.createElement('details');
  details.className = CLS.thinking;
  details.dataset.role = 'thinking';
  details.open = open;
  const summary = document.createElement('summary');
  summary.className = CLS.thinkingSummary;
  const chevron = document.createElement('span');
  chevron.className = CLS.thinkingChevron;
  chevron.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.dataset.role = 'thinking-label';
  label.textContent = t('chat.messages.thinkingLabel');
  summary.append(label, chevron);
  const body = document.createElement('div');
  body.className = CLS.thinkingBody;
  body.dataset.role = 'thinking-body';
  body.textContent = text;
  details.append(summary, body);
  return details;
}

/** Libellé final du résumé ; `secs` > 0 ajoute la durée. */
function setThinkingSummary(details, secs) {
  const summary = details.querySelector('[data-role="thinking-label"]');
  if (summary) summary.textContent = secs > 0 ? t('chat.messages.thinkingDuration', { secs }) : t('chat.messages.thinkingLabel');
}

function renderMessages() {
  messagesEl.replaceChildren();
  if (current) for (const m of current.messages) messagesEl.appendChild(createMessageEl(m));
  updateEmptyState();
}

/* ---------- Chargement / nouvelle conversation ---------- */

function setStreamingUi(on) {
  streaming = on;
  stopBtn.classList.toggle('hidden', !on);
  sendBtn.classList.toggle('hidden', on);
  updateSendBtn();
}

function abortStream() {
  if (abortController) abortController.abort();
}

function newConversation() {
  loadToken++;
  abortStream();
  current = null;
  currentId = null;
  if (location.hash) {
    ignoreHash = true;
    history.pushState(null, '', location.pathname + location.search);
    ignoreHash = false;
  }
  messagesEl.replaceChildren();
  updateEmptyState();
  chatTitle.textContent = defaultTitle();
  thinkEnabled = loadLastThink();
  renderThinkToggle();
  updateModelSelect();
  renderList();
  input.focus();
}

async function loadConversation(id) {
  const token = ++loadToken;
  abortStream();
  try {
    const conv = await getConversation(id);
    if (token !== loadToken) return;
    current = conv;
    currentId = conv.id;
    chatTitle.textContent = conv.title || defaultTitle();
    thinkEnabled = conv.think !== false;
    renderThinkToggle();
    renderMessages();
    updateModelSelect();
    ensureActiveFolderOpen();
    renderList();
    scrollToBottom();
  } catch (err) {
    if (token !== loadToken) return;
    console.error(err);
    current = null;
    currentId = null;
    setHash(null);
    messagesEl.replaceChildren();
    chatTitle.textContent = defaultTitle();
    updateModelSelect();
    renderList();
    updateEmptyState();
    showError(t('chat.errors.notFound', { message: err.message }));
  }
}

window.addEventListener('hashchange', () => {
  if (ignoreHash) {
    ignoreHash = false;
    return;
  }
  const id = hashId();
  if (id) {
    if (id !== currentId) loadConversation(id);
  } else if (currentId) {
    newConversation();
  }
});

newChatBtn.addEventListener('click', () => {
  newConversation();
  closeSidebarMobile();
});

/* ---------- Envoi ---------- */

function updateSendBtn() {
  sendBtn.disabled = streaming || input.value.trim() === '';
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

input.addEventListener('input', () => {
  resizeInput();
  updateSendBtn();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

stopBtn.addEventListener('click', abortStream);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

async function send() {
  const text = input.value.trim();
  if (!text || streaming) return;
  const { connectionId, model } = parseModelRef(select.value);
  if (!connectionId || !model) {
    showSettingsError(t('chat.messages.noModelSelected'));
    return;
  }
  streaming = true; // verrou immédiat pendant la création

  // 1) Conversation
  if (!current) {
    try {
      const conv = await createConversation({ connectionId, model, title: autoTitle(text), think: thinkEnabled });
      current = conv;
      currentId = conv.id;
      chatTitle.textContent = conv.title;
      ignoreHash = true;
      setHash(conv.id); // replaceState ne déclenche pas hashchange
      ignoreHash = false;
    } catch (err) {
      streaming = false;
      showError(t('chat.errors.create', { message: err.message }));
      return;
    }
  }
  if (!current.connectionId) {
    // Ancienne conversation sans connexion : on la rattache à celle du modèle sélectionné.
    try {
      await updateConversation(current.id, { connectionId });
      current.connectionId = connectionId;
    } catch {
      /* non bloquant */
    }
  }
  const conv = current;
  const thinkForMessage = thinkEnabled;

  // 2) Message utilisateur
  /** @type {Message} */
  const userMsg = { role: 'user', content: text, model, createdAt: new Date().toISOString() };
  conv.messages.push(userMsg);
  messagesEl.appendChild(createMessageEl(userMsg));
  updateEmptyState();
  input.value = '';
  resizeInput();
  updateModelSelect();
  scrollToBottom();
  try {
    await updateConversation(conv.id, { messages: conv.messages });
  } catch (err) {
    showError(t('chat.errors.save', { message: err.message }));
  }
  refreshList();

  // 3) Élément assistant en streaming
  const el = document.createElement('div');
  el.className = `${CLS.msg} ${CLS.msgAssistant}`;
  el.dataset.role = 'msg';
  el.dataset.streaming = 'true';
  const contentEl = document.createElement('div');
  contentEl.className = CLS.contentAssistant;
  contentEl.dataset.role = 'msg-content';
  // Un seul indicateur (loup + phrase), déplacé selon la phase : attente -> réflexion -> réponse (compact).
  const logoTpl = /** @type {HTMLTemplateElement|null} */ (document.getElementById('thinking-logo-template'));
  const logoEl = /** @type {HTMLElement|null} */ (
    logoTpl && logoTpl.content.firstElementChild ? logoTpl.content.firstElementChild.cloneNode(true) : null
  );
  const stopWords = logoEl ? startThinkingWords(logoEl) : () => {};
  if (logoEl) el.appendChild(logoEl);
  messagesEl.appendChild(el);
  scrollToBottom();
  setStreamingUi(true);
  abortController = new AbortController();
  const controller = abortController;

  let latest = { content: '', thinking: '' };
  let frame = 0;
  /** @type {'wait'|'think'|'answer'} */
  let phase = 'wait';
  /** @type {HTMLDetailsElement|null} */
  let detailsEl = null;
  /** @type {Element|null} */
  let thinkBody = null;
  /** @type {Element|null} */
  let labelEl = null;
  let thinkStart = 0;
  let thinkSecs = 0;

  const enterThinking = () => {
    phase = 'think';
    const d = /** @type {HTMLDetailsElement} */ (createThinkingEl('', false));
    detailsEl = d;
    thinkBody = d.querySelector('[data-role="thinking-body"]');
    labelEl = d.querySelector('[data-role="thinking-label"]');
    d.addEventListener('toggle', () => {
      if (d.open && thinkBody) thinkBody.scrollTop = thinkBody.scrollHeight;
    });
    if (logoEl && labelEl) labelEl.replaceWith(logoEl);
    el.prepend(d);
    thinkStart = Date.now();
  };
  const enterAnswer = () => {
    const wasThinking = phase === 'think';
    phase = 'answer';
    stopWords();
    if (logoEl) logoEl.remove();
    if (detailsEl && wasThinking) {
      thinkSecs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
      const summary = detailsEl.querySelector('summary');
      if (summary && labelEl) summary.prepend(labelEl);
      setThinkingSummary(detailsEl, thinkSecs);
    }
    el.appendChild(contentEl);
    if (logoEl) {
      logoEl.dataset.compact = 'true';
      el.appendChild(logoEl);
    }
  };
  const paint = () => {
    frame = 0;
    const stick = nearBottom();
    if (latest.thinking && phase === 'wait') enterThinking();
    if (detailsEl && thinkBody && thinkBody.textContent !== latest.thinking) {
      const bodyBottom = thinkBody.scrollHeight - thinkBody.scrollTop - thinkBody.clientHeight < 24;
      thinkBody.textContent = latest.thinking;
      if (detailsEl.open && bodyBottom) thinkBody.scrollTop = thinkBody.scrollHeight;
    }
    if (latest.content && phase !== 'answer') enterAnswer();
    if (phase === 'answer') contentEl.innerHTML = renderMarkdown(latest.content);
    if (stick) scrollToBottom();
  };

  let finalResult = null;
  let failure = null;
  try {
    finalResult = await streamChat({
      connectionId,
      model,
      messages: conv.messages.map((m) => ({ role: m.role, content: m.content })),
      signal: controller.signal,
      think: thinkForMessage,
      onUpdate: (r) => {
        latest = r;
        if (!frame) frame = requestAnimationFrame(paint);
      },
    });
  } catch (err) {
    if (!(err && err.name === 'AbortError')) failure = err;
  }
  if (frame) cancelAnimationFrame(frame);
  const result = finalResult || latest;
  if (thinkStart && !thinkSecs) thinkSecs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));

  // 5) Fin
  delete el.dataset.streaming;
  stopWords();
  if (logoEl) logoEl.remove();
  const visible = current === conv;
  if (failure) {
    console.error(failure);
    if (visible) {
      const errEl = document.createElement('div');
      errEl.className = CLS.msgError;
      errEl.dataset.role = 'msg-error';
      errEl.textContent = failure.message || String(failure);
      el.after(errEl);
    }
  }
  if (result.content || result.thinking) {
    /** @type {Message} */
    const aMsg = { role: 'assistant', content: result.content, model, createdAt: new Date().toISOString() };
    if (result.thinking) aMsg.thinking = result.thinking;
    conv.messages.push(aMsg);
    if (visible) {
      const final = createMessageEl(aMsg, thinkSecs);
      el.replaceWith(final);
    }
    try {
      await updateConversation(conv.id, { messages: conv.messages });
    } catch (err) {
      if (visible) showError(t('chat.errors.save', { message: err.message }));
    }
  } else {
    el.remove();
  }

  abortController = null;
  setStreamingUi(false);
  refreshList();
  if (visible) {
    input.focus();
  }
}

/* ---------- Démarrage ---------- */

initShutdown();
initSidebar();
initModelPicker();
renderThinkToggle();
updateModelSelect();
updateSendBtn();
updateEmptyState();

(async () => {
  refreshStatus();
  setInterval(refreshStatus, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshStatus();
  });
  await refreshList();
  const id = hashId();
  if (id) await loadConversation(id);
})();
