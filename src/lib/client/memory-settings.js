// Page Paramètres, onglet « Mémoire » : réglages et faits mémorisés, par modèle.
import { listModels } from './connections.js';
import { listMemoryModels, getMemory, addFact, updateFact, deleteFact, setMemorySettings } from './memory.js';
import { t } from './i18n.js';
import { svgIcon } from './icons.js';
import chevronRaw from '../../assets/icons/chevron-down.svg?raw';
import checkRaw from '../../assets/icons/check.svg?raw';

/** @typedef {import('./memory.js').Fact} Fact */

const STORAGE_KEY = 'lucania.memory.model';
const MAX_LEN = 500;

/** @param {string} id */
const byId = (id) => document.getElementById(id);

const loadingEl = byId('memory-loading');
const emptyEl = byId('memory-empty');
const errorEl = byId('memory-error');
const mainEl = byId('memory-main');
const btnEl = /** @type {HTMLButtonElement|null} */ (byId('memory-model-btn'));
const menuEl = byId('memory-model-menu');
const pickerEl = byId('memory-model-picker');
const nameEl = byId('memory-model-name');
const countEl = byId('memory-model-count');
const chevronEl = byId('memory-model-chevron');
const enabledSw = byId('memory-enabled');
const autoSw = byId('memory-auto');
const autoRow = byId('memory-auto-row');
const addForm = /** @type {HTMLFormElement|null} */ (byId('memory-add-form'));
const addInput = /** @type {HTMLInputElement|null} */ (byId('memory-add-input'));
const listEl = byId('memory-facts');
const factsEmptyEl = byId('memory-facts-empty');
const tpl = /** @type {HTMLTemplateElement|null} */ (byId('tpl-fact'));

if (loadingEl && emptyEl && errorEl && mainEl && btnEl && menuEl && pickerEl && nameEl && countEl && chevronEl && enabledSw && autoSw && autoRow && addForm && addInput && listEl && factsEmptyEl && tpl) {
  init(loadingEl, emptyEl, errorEl, mainEl, btnEl, menuEl, pickerEl, nameEl, countEl, chevronEl, enabledSw, autoSw, autoRow, addForm, addInput, listEl, factsEmptyEl, tpl);
}

/**
 * @param {HTMLElement} loadingEl @param {HTMLElement} emptyEl @param {HTMLElement} errorEl @param {HTMLElement} mainEl
 * @param {HTMLButtonElement} btnEl @param {HTMLElement} menuEl @param {HTMLElement} pickerEl
 * @param {HTMLElement} nameEl @param {HTMLElement} countEl @param {HTMLElement} chevronEl
 * @param {HTMLElement} enabledSw @param {HTMLElement} autoSw @param {HTMLElement} autoRow
 * @param {HTMLFormElement} addForm @param {HTMLInputElement} addInput @param {HTMLElement} listEl
 * @param {HTMLElement} factsEmptyEl @param {HTMLTemplateElement} tpl
 */
function init(loadingEl, emptyEl, errorEl, mainEl, btnEl, menuEl, pickerEl, nameEl, countEl, chevronEl, enabledSw, autoSw, autoRow, addForm, addInput, listEl, factsEmptyEl, tpl) {
  /** @type {Map<string, number>} nom du modèle -> nombre de faits */
  const counts = new Map();
  /** @type {string[]} */
  let names = [];
  /** @type {{ title: string, models: string[] }[]} groupes affichés dans le menu (titre vide = sans en-tête) */
  let groups = [];
  let current = '';
  let loadSeq = 0;
  let activeIndex = -1;
  let typed = '';
  let typedTimer = 0;
  /** @type {Fact[]} */
  let facts = [];

  const CLS = {
    group: 'px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted first:pt-1',
    item: 'group flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-fg/5 data-[active=true]:bg-fg/5',
    name: 'min-w-0 flex-1 truncate text-sm text-fg',
    right: 'flex shrink-0 items-center gap-2',
    count: 'shrink-0 text-xs text-muted',
    check: 'hidden size-4 shrink-0 text-fg group-aria-selected:block',
  };

  chevronEl.replaceChildren(svgIcon(chevronRaw, '', 14));

  /** @param {Element} sw */
  const isOn = (sw) => sw.getAttribute('aria-checked') === 'true';
  /** @param {Element} sw @param {boolean} on */
  const setOn = (sw, on) => sw.setAttribute('aria-checked', on ? 'true' : 'false');

  /** @param {string} msg */
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  const isOpen = () => !menuEl.classList.contains('hidden');
  const items = () => /** @type {HTMLElement[]} */ (Array.from(menuEl.querySelectorAll('li[role="option"]')));

  function renderTrigger() {
    nameEl.textContent = current || nameEl.dataset.placeholder || '';
    const n = counts.get(current) || 0;
    countEl.textContent = n > 0 ? String(n) : '';
  }

  function renderOptions() {
    menuEl.replaceChildren();
    let idx = 0;
    for (const g of groups) {
      if (g.title) {
        const h = document.createElement('li');
        h.setAttribute('role', 'presentation');
        h.className = CLS.group;
        h.textContent = g.title;
        menuEl.append(h);
      }
      for (const name of g.models) {
        const li = document.createElement('li');
        li.id = `memory-model-opt-${idx++}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(name === current));
        li.dataset.value = name;
        li.className = CLS.item;
        const label = document.createElement('span');
        label.className = CLS.name;
        label.textContent = name;
        const right = document.createElement('span');
        right.className = CLS.right;
        const n = counts.get(name) || 0;
        const count = document.createElement('span');
        count.className = CLS.count;
        count.dataset.count = '';
        count.textContent = n > 0 ? String(n) : '';
        const check = document.createElement('span');
        check.className = CLS.check;
        const icon = svgIcon(checkRaw, '', 16);
        icon.setAttribute('stroke-width', '2.2');
        check.append(icon);
        right.append(count, check);
        li.append(label, right);
        menuEl.append(li);
      }
    }
    renderTrigger();
  }

  /** @param {number} index @param {boolean} [scroll] */
  function setActive(index, scroll = true) {
    const list = items();
    list.forEach((li) => li.removeAttribute('data-active'));
    activeIndex = list.length ? Math.max(0, Math.min(index, list.length - 1)) : -1;
    if (activeIndex < 0) {
      menuEl.removeAttribute('aria-activedescendant');
      return;
    }
    const li = list[activeIndex];
    li.setAttribute('data-active', 'true');
    menuEl.setAttribute('aria-activedescendant', li.id);
    if (scroll) li.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    if (isOpen() || items().length === 0) return;
    menuEl.classList.remove('hidden');
    btnEl.setAttribute('aria-expanded', 'true');
    const sel = items().findIndex((li) => li.dataset.value === current);
    setActive(sel >= 0 ? sel : 0);
    menuEl.focus({ preventScroll: true });
  }

  /** @param {boolean} [refocus] */
  function close(refocus = false) {
    if (!isOpen()) return;
    menuEl.classList.add('hidden');
    btnEl.setAttribute('aria-expanded', 'false');
    menuEl.removeAttribute('aria-activedescendant');
    if (refocus) btnEl.focus();
  }

  /** @param {number} index */
  function choose(index) {
    const li = items()[index];
    if (!li) return;
    const value = li.dataset.value || '';
    close(true);
    if (value && value !== current) selectModel(value);
  }

  function syncCount() {
    counts.set(current, facts.length);
    renderTrigger();
    for (const li of items()) {
      if (li.dataset.value !== current) continue;
      const c = li.querySelector('[data-count]');
      if (c) c.textContent = facts.length > 0 ? String(facts.length) : '';
    }
  }

  /** @param {boolean} enabled @param {boolean} autoExtract */
  function applySettings(enabled, autoExtract) {
    setOn(enabledSw, enabled);
    setOn(autoSw, autoExtract);
    /** @type {HTMLButtonElement} */ (autoSw).disabled = !enabled;
    autoRow.classList.toggle('opacity-50', !enabled);
  }

  function renderFacts() {
    listEl.replaceChildren();
    listEl.hidden = facts.length === 0;
    factsEmptyEl.hidden = facts.length > 0;
    for (const fact of facts) listEl.append(buildFact(fact));
  }

  /** @param {Fact} fact */
  function buildFact(fact) {
    const frag = /** @type {DocumentFragment} */ (tpl.content.cloneNode(true));
    const li = /** @type {HTMLElement} */ (frag.querySelector('[data-fact]'));
    const text = /** @type {HTMLButtonElement} */ (li.querySelector('[data-fact-text]'));
    const field = /** @type {HTMLInputElement} */ (li.querySelector('[data-fact-input]'));
    const editBtn = /** @type {HTMLButtonElement} */ (li.querySelector('[data-fact-edit]'));
    const delBtn = /** @type {HTMLButtonElement} */ (li.querySelector('[data-fact-delete]'));
    text.textContent = fact.content;
    editBtn.setAttribute('aria-label', t('settings.memory.edit'));
    delBtn.setAttribute('aria-label', t('settings.memory.delete'));
    field.setAttribute('aria-label', t('settings.memory.editLabel'));

    let finished = true;

    function startEdit() {
      if (!finished) return;
      finished = false;
      field.value = fact.content;
      text.hidden = true;
      editBtn.hidden = true;
      field.hidden = false;
      field.focus();
      field.select();
    }

    /** @param {boolean} save */
    async function endEdit(save) {
      if (finished) return;
      finished = true;
      const value = field.value.trim();
      field.hidden = true;
      text.hidden = false;
      editBtn.hidden = false;
      if (!save || value === fact.content) return;
      if (!value) {
        showError(t('settings.memory.emptyContent'));
        return;
      }
      showError('');
      try {
        const updated = await updateFact(fact.id, value);
        fact.content = updated.content;
        text.textContent = updated.content;
      } catch (e) {
        showError(e.message);
      }
    }

    text.addEventListener('click', startEdit);
    editBtn.addEventListener('click', startEdit);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        endEdit(true);
        text.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endEdit(false);
        text.focus();
      }
    });
    field.addEventListener('blur', () => endEdit(true));

    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      showError('');
      try {
        await deleteFact(fact.id);
        facts = facts.filter((f) => f.id !== fact.id);
        syncCount();
        renderFacts();
      } catch (e) {
        showError(e.message);
        delBtn.disabled = false;
      }
    });
    return li;
  }

  /** @param {string} name */
  async function selectModel(name) {
    current = name;
    for (const li of items()) li.setAttribute('aria-selected', String(li.dataset.value === name));
    renderTrigger();
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      /* stockage indisponible */
    }
    const seq = ++loadSeq;
    showError('');
    try {
      const mem = await getMemory(name);
      if (seq !== loadSeq) return;
      facts = mem.facts;
      applySettings(mem.enabled, mem.autoExtract);
      syncCount();
      renderFacts();
    } catch (e) {
      if (seq !== loadSeq) return;
      facts = [];
      renderFacts();
      showError(e.message);
    }
  }

  async function start() {
    /** @type {string[]} */
    let serverModels = [];
    /** @type {Map<string, { title: string, models: Set<string> }>} */
    const byConn = new Map();
    try {
      for (const m of await listModels()) {
        serverModels.push(m.name);
        const g = byConn.get(m.connectionId) || { title: m.connectionName, models: new Set() };
        g.models.add(m.name);
        byConn.set(m.connectionId, g);
      }
    } catch {
      /* serveurs injoignables : on garde les modèles qui ont déjà des faits */
    }
    /** @type {string[]} */
    const memoryModels = [];
    try {
      for (const m of await listMemoryModels()) {
        counts.set(m.model, m.count);
        memoryModels.push(m.model);
      }
    } catch (e) {
      showError(e.message);
    }
    const sort = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b);
    const onServer = new Set(serverModels);
    names = [...new Set([...serverModels, ...memoryModels])].sort(sort);

    // Groupes : un par serveur (en-têtes seulement s'il y en a plusieurs), puis les modèles avec mémoire absents des serveurs.
    groups = [...byConn.values()].map((g) => ({
      title: byConn.size > 1 ? g.title : '',
      models: [...g.models].sort(sort),
    }));
    const others = [...new Set(memoryModels.filter((m) => !onServer.has(m)))].sort(sort);
    if (others.length) groups.push({ title: groups.length ? t('settings.memory.otherModels') : '', models: others });

    loadingEl.hidden = true;
    if (names.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    let saved = '';
    try {
      saved = localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      saved = '';
    }
    current = names.includes(saved) ? saved : names[0];
    renderOptions();
    mainEl.hidden = false;
    selectModel(current);
  }

  // Sélecteur personnalisé
  btnEl.addEventListener('click', () => (isOpen() ? close() : open()));

  btnEl.addEventListener('keydown', (e) => {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });

  menuEl.addEventListener('keydown', (e) => {
    const n = items().length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive(activeIndex + 1 >= n ? 0 : activeIndex + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive(activeIndex <= 0 ? n - 1 : activeIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(n - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        choose(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typed += e.key.toLowerCase();
          clearTimeout(typedTimer);
          typedTimer = window.setTimeout(() => (typed = ''), 600);
          const list = items();
          const from = typed.length === 1 ? activeIndex + 1 : activeIndex;
          const order = [...list.slice(from), ...list.slice(0, from)];
          const hit = order.find((li) => (li.dataset.value || '').toLowerCase().startsWith(typed));
          if (hit) setActive(list.indexOf(hit));
        }
    }
  });

  menuEl.addEventListener('mousemove', (e) => {
    const li = /** @type {HTMLElement} */ (e.target).closest('li[role="option"]');
    if (li) {
      const idx = items().indexOf(/** @type {HTMLElement} */ (li));
      if (idx !== activeIndex) setActive(idx, false);
    }
  });

  menuEl.addEventListener('click', (e) => {
    const li = /** @type {HTMLElement} */ (e.target).closest('li[role="option"]');
    if (li) choose(items().indexOf(/** @type {HTMLElement} */ (li)));
  });

  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !pickerEl.contains(/** @type {Node} */ (e.target))) close();
  });

  menuEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (isOpen() && !pickerEl.contains(document.activeElement)) close();
    }, 0);
  });

  /** @param {HTMLElement} sw @param {'enabled'|'autoExtract'} key */
  function bindSwitch(sw, key) {
    sw.addEventListener('click', async () => {
      const next = !isOn(sw);
      const model = current;
      const prevEnabled = isOn(enabledSw);
      const prevAuto = isOn(autoSw);
      if (key === 'enabled') applySettings(next, prevAuto);
      else applySettings(prevEnabled, next);
      showError('');
      try {
        const s = await setMemorySettings(model, { [key]: next });
        if (model === current) applySettings(s.enabled, s.autoExtract);
      } catch (e) {
        if (model === current) applySettings(prevEnabled, prevAuto);
        showError(e.message);
      }
    });
  }
  bindSwitch(enabledSw, 'enabled');
  bindSwitch(autoSw, 'autoExtract');

  addInput.maxLength = MAX_LEN;
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = addInput.value.trim();
    if (!content || !current) return;
    if (content.length > MAX_LEN) {
      showError(t('settings.memory.tooLong', { max: MAX_LEN }));
      return;
    }
    const btn = /** @type {HTMLButtonElement} */ (byId('memory-add-btn'));
    btn.disabled = true;
    showError('');
    try {
      const fact = await addFact(current, content);
      facts.push(fact);
      addInput.value = '';
      syncCount();
      renderFacts();
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
      addInput.focus();
    }
  });

  start();
}
