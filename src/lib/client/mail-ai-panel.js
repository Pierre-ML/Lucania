// Panneau « Réglages de l'IA du tri » (page /emails) : modèles conseillés, prompt système, mémoire du tri.
import { engineAvailable, getSystemHardware, listModels } from './engine.js';
import { t } from './i18n.js';
import { DEFAULT_SYSTEM_PROMPT, recommendMailModels } from './mail-ai.js';

const MAX_NOTE = 500;
const GIB = 1024 ** 3;

/**
 * @typedef {{ id: number, content: string, source: 'user'|'feedback', sender?: string, createdAt?: string, updatedAt?: string }} MemoryEntry
 * @typedef {'light'|'medium'|'strong'} Tier
 */

/** @param {string} sel @param {ParentNode} [root] @returns {HTMLElement|null} */
const $ = (sel, root = document) => /** @type {HTMLElement|null} */ (root.querySelector(sel));

/** Appel JSON vers l'API ; lève une Error portant le message du serveur. @param {string} url @param {RequestInit} [init] */
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

/** @param {string} method @param {unknown} [body] @returns {RequestInit} */
function jsonInit(method, body) {
  return body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** @param {unknown} e */
function messageOf(e) {
  return e instanceof Error && e.message ? e.message : typeof e === 'string' ? e : '';
}

/** @param {HTMLElement|null} el @param {string} text @param {boolean} [error] */
function say(el, text, error = false) {
  if (!el) return;
  el.textContent = text;
  el.dataset.error = String(error);
}

/** @param {number} n */
function fmtGb(n) {
  return String(Math.round(n * 10) / 10);
}

const smallBtn =
  'h-9 shrink-0 cursor-pointer rounded-lg px-3 text-sm transition-[background-color,color,transform] duration-150 hover:bg-fg/5 focus-visible:outline-fg/40 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';

/** @param {string} text @param {string} extra */
function button(text, extra) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${smallBtn} ${extra}`;
  b.textContent = text;
  return b;
}

export function initMailAiPanel() {
  const root = $('[data-mail-ai]');
  if (!root) return;

  // ---- 1. Modèles conseillés ----

  const hwEl = $('[data-mail-ai-hw]', root);
  const tierEl = $('[data-mail-ai-tier]', root);
  const noteEl = $('[data-mail-ai-note]', root);
  const modelList = $('[data-mail-ai-model-list]', root);

  /** Identifiants et noms des modèles installés, en minuscules. @returns {Promise<string[]>} */
  async function installedNames() {
    try {
      const models = await listModels();
      return models.flatMap((/** @type {{ id?: string, name?: string }} */ m) => [m.id, m.name]).filter(Boolean).map((s) => String(s).toLowerCase());
    } catch {
      return [];
    }
  }

  /** @param {{ name: string, file: string, sizeGb: number, repo: string, best?: boolean }} m @param {string[]} installed */
  function buildModel(m, installed) {
    const stem = String(m.file || '').replace(/\.gguf$/i, '').replace(/\.[^.]+$/, '').toLowerCase();
    const isInstalled = stem !== '' && installed.some((n) => n.includes(stem));

    const li = document.createElement('li');
    li.className = 'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border px-3 py-2';

    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    const nameRow = document.createElement('p');
    nameRow.className = 'flex flex-wrap items-center gap-2 text-sm';
    const name = document.createElement('span');
    name.className = 'font-medium [overflow-wrap:anywhere]';
    name.textContent = m.name;
    nameRow.append(name);
    if (m.best) {
      const best = document.createElement('span');
      best.className = 'rounded-full bg-fg px-2 py-0.5 text-xs font-medium text-bg';
      best.textContent = t('mailai.models.best');
      nameRow.append(best);
    }
    if (isInstalled) {
      const ok = document.createElement('span');
      ok.className = 'rounded-full border border-border px-2 py-0.5 text-xs text-muted';
      ok.textContent = t('mailai.models.installed');
      nameRow.append(ok);
    }
    const size = document.createElement('p');
    size.className = 'mt-0.5 text-xs text-muted';
    size.textContent = t('mailai.models.size', { size: fmtGb(m.sizeGb) });
    info.append(nameRow, size);

    const link = document.createElement('a');
    link.href = `https://huggingface.co/${m.repo}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className =
      'inline-flex h-8 shrink-0 items-center rounded-lg px-2 text-xs text-muted underline underline-offset-4 transition-colors duration-150 hover:bg-fg/5 hover:text-fg focus-visible:outline-fg/40 motion-reduce:transition-none';
    link.textContent = t('mailai.models.repo');
    link.setAttribute('aria-label', t('mailai.models.repoLabel', { name: m.name }));

    li.append(info, link);
    return li;
  }

  /** @param {{ models: { name: string, file: string, sizeGb: number, repo: string, best?: boolean }[] }} rec @param {string[]} installed @param {string} [heading] */
  function buildGroup(rec, installed, heading) {
    const wrap = document.createElement('div');
    if (heading) {
      const h = document.createElement('p');
      h.className = 'mb-2 text-xs font-medium uppercase tracking-wide text-muted';
      h.textContent = heading;
      wrap.append(h);
    }
    const ul = document.createElement('ul');
    ul.className = 'flex flex-col gap-2';
    if (rec.models.length === 0) {
      const none = document.createElement('li');
      none.className = 'text-sm text-muted';
      none.textContent = t('mailai.models.none');
      ul.append(none);
    }
    for (const m of rec.models) ul.append(buildModel(m, installed));
    wrap.append(ul);
    return wrap;
  }

  async function loadModels() {
    if (!modelList) return;
    if (engineAvailable()) {
      try {
        const hw = await getSystemHardware();
        const rec = recommendMailModels(hw);
        const installed = await installedNames();
        if (hwEl) {
          hwEl.dataset.error = 'false';
          hwEl.textContent =
            rec.vramGb > 0
              ? t('mailai.models.hw', { ram: fmtGb(rec.ramGb), vram: fmtGb(rec.vramGb) })
              : t('mailai.models.hwNoGpu', { ram: fmtGb(rec.ramGb) });
        }
        if (tierEl) {
          tierEl.hidden = false;
          const strong = document.createElement('strong');
          strong.className = 'font-medium';
          strong.textContent = `${t('mailai.models.tierLabel')} ${t(`mailai.models.tier.${rec.tier}`)}`;
          tierEl.replaceChildren(strong, document.createTextNode(` — ${t(`mailai.models.tierText.${rec.tier}`)}`));
        }
        modelList.replaceChildren(buildGroup(rec, installed));
        return;
      } catch {
        say(hwEl, t('mailai.models.hwError'), true);
      }
    } else if (hwEl) {
      hwEl.textContent = '';
    }
    // Sans moteur (navigateur) ou lecture impossible : les trois paliers génériques.
    if (noteEl) {
      noteEl.hidden = false;
      noteEl.textContent = t('mailai.models.genericNote');
    }
    /** @type {[Tier, ReturnType<typeof recommendMailModels>][]} */
    const tiers = [
      ['light', recommendMailModels(null)],
      ['medium', recommendMailModels({ ramTotalBytes: 16 * GIB, ramAvailableBytes: 12 * GIB, gpus: [] })],
      ['strong', recommendMailModels({ ramTotalBytes: 32 * GIB, ramAvailableBytes: 24 * GIB, gpus: [] })],
    ];
    const installed = engineAvailable() ? await installedNames() : [];
    modelList.replaceChildren(
      ...tiers.map(([tier, rec]) => buildGroup(rec, installed, t('mailai.models.genericTier', { tier: t(`mailai.models.tier.${tier}`) }))),
    );
  }

  // ---- 2. Prompt système ----

  const promptEl = /** @type {HTMLTextAreaElement|null} */ ($('[data-mail-ai-prompt]', root));
  const promptSave = /** @type {HTMLButtonElement|null} */ ($('[data-mail-ai-prompt-save]', root));
  const promptReset = /** @type {HTMLButtonElement|null} */ ($('[data-mail-ai-prompt-reset]', root));
  const promptStatus = $('[data-mail-ai-prompt-status]', root);
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let promptTimer;

  /** @param {boolean} on */
  function promptBusy(on) {
    if (promptSave) promptSave.disabled = on;
    if (promptReset) promptReset.disabled = on;
  }

  /** @param {string} value texte à enregistrer ('' = défaut) @param {string} okText */
  async function savePrompt(value, okText) {
    clearTimeout(promptTimer);
    promptBusy(true);
    say(promptStatus, t('mailai.prompt.saving'));
    try {
      const s = await api('/api/mail/settings', jsonInit('PUT', { systemPrompt: value }));
      const saved = typeof s?.systemPrompt === 'string' ? s.systemPrompt : value;
      if (promptEl) promptEl.value = saved || DEFAULT_SYSTEM_PROMPT;
      say(promptStatus, okText);
      promptTimer = setTimeout(() => say(promptStatus, ''), 3000);
    } catch (e) {
      say(promptStatus, messageOf(e) || t('mailai.prompt.loadError'), true);
    } finally {
      promptBusy(false);
    }
  }

  promptSave?.addEventListener('click', () => {
    if (!promptEl) return;
    const text = promptEl.value.trim();
    savePrompt(text === DEFAULT_SYSTEM_PROMPT.trim() ? '' : promptEl.value, t('mailai.prompt.saved'));
  });
  promptReset?.addEventListener('click', () => {
    if (promptEl) promptEl.value = DEFAULT_SYSTEM_PROMPT;
    savePrompt('', t('mailai.prompt.resetDone'));
  });

  async function loadPrompt() {
    if (!promptEl) return;
    promptEl.value = DEFAULT_SYSTEM_PROMPT;
    try {
      const s = await api('/api/mail/settings');
      if (typeof s?.systemPrompt === 'string' && s.systemPrompt) promptEl.value = s.systemPrompt;
    } catch (e) {
      say(promptStatus, messageOf(e) || t('mailai.prompt.loadError'), true);
    }
  }

  // ---- 3. Mémoire du tri ----

  const memList = $('[data-mail-ai-memory-list]', root);
  const memEmpty = $('[data-mail-ai-memory-empty]', root);
  const memForm = $('[data-mail-ai-memory-form]', root);
  const memInput = /** @type {HTMLInputElement|null} */ ($('[data-mail-ai-memory-input]', root));
  const memAdd = /** @type {HTMLButtonElement|null} */ ($('[data-mail-ai-memory-add]', root));
  const memStatus = $('[data-mail-ai-memory-status]', root);
  /** @type {MemoryEntry[]} */
  let entries = [];
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let memTimer;

  /** @param {string} text @param {boolean} [error] */
  function memSay(text, error = false) {
    clearTimeout(memTimer);
    say(memStatus, text, error);
    if (text && !error) memTimer = setTimeout(() => say(memStatus, ''), 3000);
  }

  /** @param {string} s */
  function short(s) {
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  }

  /** @param {MemoryEntry} entry */
  function buildEntry(entry) {
    const li = document.createElement('li');
    li.className = 'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface/50 px-3 py-2';
    const body = document.createElement('div');
    body.className = 'min-w-0 flex-1';
    const actions = document.createElement('div');
    actions.className = 'flex shrink-0 items-center gap-1';
    li.append(body, actions);

    function showNormal() {
      const text = document.createElement('p');
      text.className = 'text-sm [overflow-wrap:anywhere]';
      text.textContent = entry.content;
      body.replaceChildren(text);
      if (entry.source === 'feedback') {
        const tag = document.createElement('span');
        tag.className = 'mt-1 inline-block rounded-full border border-border px-2 py-0.5 text-xs text-muted';
        tag.textContent = t('mailai.memory.fromFeedback');
        body.append(tag);
      }
      const edit = button(t('mailai.memory.edit'), 'text-muted hover:text-fg');
      edit.setAttribute('aria-label', t('mailai.memory.editLabel', { content: short(entry.content) }));
      edit.addEventListener('click', showEdit);
      const del = button(t('mailai.memory.delete'), 'text-muted hover:text-fg');
      del.setAttribute('aria-label', t('mailai.memory.deleteLabel', { content: short(entry.content) }));
      del.addEventListener('click', showConfirm);
      actions.replaceChildren(edit, del);
    }

    function showEdit() {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = MAX_NOTE;
      input.value = entry.content;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', t('mailai.memory.editInput'));
      input.className =
        'h-9 w-full min-w-0 rounded-lg border border-border bg-transparent px-3 text-sm text-fg focus-visible:outline-fg/40';
      body.replaceChildren(input);
      const save = button(t('mailai.memory.save'), 'font-medium text-fg');
      const cancel = button(t('mailai.memory.cancel'), 'text-muted hover:text-fg');
      cancel.addEventListener('click', showNormal);
      async function commit() {
        const content = input.value.trim();
        if (!content) {
          memSay(t('mailai.memory.needText'), true);
          input.focus();
          return;
        }
        if (content === entry.content) {
          showNormal();
          return;
        }
        save.disabled = true;
        try {
          const updated = await api(`/api/mail/memory/${entry.id}`, jsonInit('PUT', { content }));
          if (updated && typeof updated.content === 'string') Object.assign(entry, updated);
          else entry.content = content;
          memSay(t('mailai.memory.updated'));
          showNormal();
        } catch (e) {
          memSay(messageOf(e), true);
          save.disabled = false;
        }
      }
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          showNormal();
        }
      });
      actions.replaceChildren(save, cancel);
      input.focus();
      input.select();
    }

    function showConfirm() {
      const ask = document.createElement('p');
      ask.className = 'text-sm';
      ask.textContent = t('mailai.memory.deleteAsk');
      body.replaceChildren(ask);
      const cancel = button(t('mailai.memory.cancel'), 'text-muted hover:text-fg');
      cancel.addEventListener('click', showNormal);
      const confirmBtn = button(t('mailai.memory.deleteConfirm'), 'font-medium text-danger');
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        try {
          await api(`/api/mail/memory/${entry.id}`, jsonInit('DELETE'));
          entries = entries.filter((e) => e.id !== entry.id);
          renderMemory();
          memSay(t('mailai.memory.deleted'));
        } catch (e) {
          memSay(messageOf(e), true);
          showNormal();
        }
      });
      actions.replaceChildren(cancel, confirmBtn);
      cancel.focus();
    }

    showNormal();
    return li;
  }

  function renderMemory() {
    memList?.replaceChildren(...entries.map(buildEntry));
    if (memEmpty) memEmpty.hidden = entries.length > 0;
  }

  async function loadMemory() {
    try {
      const data = await api('/api/mail/memory');
      entries = Array.isArray(data?.entries) ? data.entries : [];
      renderMemory();
    } catch (e) {
      memSay(messageOf(e) || t('mailai.memory.loadError'), true);
    }
  }

  memForm?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!memInput) return;
    const content = memInput.value.trim();
    if (!content) {
      memSay(t('mailai.memory.needText'), true);
      memInput.focus();
      return;
    }
    if (memAdd) memAdd.disabled = true;
    try {
      const entry = await api('/api/mail/memory', jsonInit('POST', { content }));
      if (entry && typeof entry.id === 'number') entries = [...entries, entry];
      else await loadMemory();
      memInput.value = '';
      renderMemory();
      memSay(t('mailai.memory.added'));
    } catch (e) {
      memSay(messageOf(e), true);
    } finally {
      if (memAdd) memAdd.disabled = false;
    }
  });

  loadModels();
  loadPrompt();
  loadMemory();
}
