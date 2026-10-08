import { t } from './i18n.js';
// Sélecteur de modèle personnalisé, synchronisé avec le <select id="model-select"> (source de vérité).
// Valeur d'une option : `${connectionId}::${model}`. Le menu groupe les modèles par connexion.

const SVG_CHECK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const CLS = {
  group: 'flex items-center gap-2 px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-composer-muted first:pt-1',
  groupName: 'min-w-0 truncate',
  badge: 'shrink-0 rounded-full border border-composer-border px-1.5 py-px text-[10px] font-normal normal-case tracking-normal',
  dot: 'size-1.5 shrink-0 rounded-full bg-composer-muted data-[online=true]:bg-emerald-500 data-[online=false]:bg-danger',
  empty: 'px-3 py-2 text-sm text-composer-muted',
  item: 'group flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-white/6 data-[active=true]:bg-white/6 data-[available=false]:opacity-50',
  text: 'min-w-0',
  name: 'truncate text-sm text-composer-fg',
  full: 'truncate text-xs text-composer-muted',
  check: 'hidden shrink-0 text-composer-accent group-aria-selected:block',
};

/**
 * @typedef {{ connectionId: string, connectionName: string, kind: 'local'|'remote', online: boolean|null, available: boolean }} ModelMeta
 */

/** @type {HTMLSelectElement|null} */ let select = null;
/** @type {HTMLButtonElement|null} */ let btn = null;
/** @type {HTMLElement|null} */ let label = null;
/** @type {HTMLElement|null} */ let menu = null;
let renderedKey = '';
let activeIndex = -1;
/** @type {Map<string, ModelMeta>} */
let metaMap = new Map();
let loaded = false;

/** Sépare `connectionId::model` au PREMIER `::`. @param {string} v */
export function parseModelRef(v) {
  const s = String(v || '');
  const i = s.indexOf('::');
  if (i === -1) return { connectionId: '', model: s };
  return { connectionId: s.slice(0, i), model: s.slice(i + 2) };
}

/** @param {string} connectionId @param {string} model */
export function makeModelRef(connectionId, model) {
  return `${connectionId}::${model}`;
}

/** Fournit au sélecteur les métadonnées (groupes, disponibilité). @param {Map<string, ModelMeta>} meta @param {boolean} isLoaded */
export function setModelPickerData(meta, isLoaded) {
  metaMap = meta;
  loaded = isLoaded;
  syncModelPicker();
}

/** Nom lisible générique d'un identifiant de modèle. */
export function prettyModelName(id) {
  let s = String(id || '');
  s = s.slice(s.lastIndexOf('/') + 1);
  let tag = '';
  const i = s.indexOf(':');
  if (i !== -1) {
    tag = s.slice(i + 1);
    s = s.slice(0, i);
  }
  s = s.replace(/[-_]+/g, ' ').trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (tag && tag.toLowerCase() !== 'latest') s += ` · ${tag.toUpperCase()}`;
  return s;
}

const isOpen = () => !!menu && !menu.classList.contains('hidden');
const items = () => (menu ? Array.from(menu.querySelectorAll('li[role="option"]')) : []);

/** @param {ModelMeta} m */
function groupHeader(m) {
  const li = document.createElement('li');
  li.setAttribute('role', 'presentation');
  li.className = CLS.group;
  const dot = document.createElement('span');
  dot.className = CLS.dot;
  dot.dataset.online = m.online === null ? 'unknown' : String(m.online);
  const name = document.createElement('span');
  name.className = CLS.groupName;
  name.textContent = m.connectionName;
  const badge = document.createElement('span');
  badge.className = CLS.badge;
  badge.textContent = m.kind === 'remote' ? t('chat.status.remote') : t('chat.status.local');
  li.append(dot, name, badge);
  return li;
}

function buildMenu() {
  const values = Array.from(select.options).map((o) => o.value);
  const key = JSON.stringify([values, values.map((v) => metaMap.get(v) || null)]);
  if (key === renderedKey) return;
  renderedKey = key;
  menu.replaceChildren();
  if (!values.length) {
    const li = document.createElement('li');
    li.setAttribute('role', 'presentation');
    li.className = CLS.empty;
    li.textContent = t('chat.picker.none');
    menu.appendChild(li);
    return;
  }
  let lastGroup = null;
  values.forEach((v, i) => {
    const ref = parseModelRef(v);
    const m = metaMap.get(v);
    if (m && lastGroup !== ref.connectionId) {
      lastGroup = ref.connectionId;
      menu.appendChild(groupHeader(m));
    }
    const li = document.createElement('li');
    li.id = `model-picker-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.dataset.value = v;
    li.dataset.available = String(!m || m.available);
    li.className = CLS.item;
    const text = document.createElement('div');
    text.className = CLS.text;
    const name = document.createElement('div');
    name.className = CLS.name;
    name.textContent = prettyModelName(ref.model);
    const full = document.createElement('div');
    full.className = CLS.full;
    full.textContent = m && !m.available ? t('chat.picker.unavailable', { model: ref.model }) : ref.model;
    text.append(name, full);
    const check = document.createElement('span');
    check.className = CLS.check;
    check.innerHTML = SVG_CHECK; // SVG statique
    li.append(text, check);
    menu.appendChild(li);
  });
}

function setActive(index, scroll = true) {
  const list = items();
  list.forEach((li) => li.removeAttribute('data-active'));
  activeIndex = list.length ? Math.max(0, Math.min(index, list.length - 1)) : -1;
  if (activeIndex < 0) {
    menu.removeAttribute('aria-activedescendant');
    return;
  }
  const li = list[activeIndex];
  li.setAttribute('data-active', 'true');
  menu.setAttribute('aria-activedescendant', li.id);
  if (scroll) li.scrollIntoView({ block: 'nearest' });
}

function open() {
  if (select.disabled || isOpen()) return;
  syncModelPicker();
  menu.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  const sel = items().findIndex((li) => li.dataset.value === select.value);
  setActive(sel >= 0 ? sel : 0);
  menu.focus({ preventScroll: true });
}

function close(refocus = false) {
  if (!isOpen()) return;
  menu.classList.add('hidden');
  btn.setAttribute('aria-expanded', 'false');
  menu.removeAttribute('aria-activedescendant');
  if (refocus) btn.focus();
}

function choose(index) {
  const li = items()[index];
  if (!li) return;
  const v = li.dataset.value;
  if (select.value !== v) {
    select.value = v;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  close(true);
}

export function syncModelPicker() {
  if (!select || !btn || !menu) return;
  buildMenu();
  const hasModels = select.options.length > 0;
  const ref = parseModelRef(select.value);
  const meta = metaMap.get(select.value);
  const where = meta ? ` — ${meta.connectionName}` : '';
  btn.dataset.empty = String(!hasModels);
  if (!hasModels) {
    label.textContent = loaded ? t('chat.picker.configure') : t('chat.picker.loading');
    btn.title = loaded ? t('chat.picker.configureHint') : '';
  } else {
    label.textContent = prettyModelName(ref.model);
    btn.title = select.disabled
      ? t('chat.picker.locked', { model: ref.model, where })
      : `${ref.model}${where}`;
  }
  btn.dataset.locked = String(!!select.disabled);
  btn.setAttribute('aria-disabled', String(!!select.disabled));
  for (const li of items()) li.setAttribute('aria-selected', String(li.dataset.value === select.value));
  if (select.disabled || !hasModels) close();
  else if (isOpen()) setActive(activeIndex < 0 ? 0 : activeIndex, false);
}

export function initModelPicker() {
  select = /** @type {HTMLSelectElement|null} */ (document.getElementById('model-select'));
  btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('model-picker-btn'));
  label = document.getElementById('model-picker-label');
  menu = document.getElementById('model-picker-menu');
  if (!select || !btn || !label || !menu) return;

  btn.addEventListener('click', () => {
    if (!select.options.length) {
      if (loaded) location.href = '/parametres';
      return;
    }
    if (select.disabled) return;
    if (isOpen()) close();
    else open();
  });

  btn.addEventListener('keydown', (e) => {
    if (select.disabled || !select.options.length) return;
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });

  menu.addEventListener('keydown', (e) => {
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
    }
  });

  menu.addEventListener('mousemove', (e) => {
    const li = /** @type {HTMLElement} */ (e.target).closest('li');
    if (li) {
      const idx = items().indexOf(li);
      if (idx !== activeIndex) setActive(idx, false);
    }
  });

  menu.addEventListener('click', (e) => {
    const li = /** @type {HTMLElement} */ (e.target).closest('li');
    if (li) choose(items().indexOf(li));
  });

  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !document.getElementById('model-picker').contains(/** @type {Node} */ (e.target))) close();
  });

  menu.addEventListener('blur', () => {
    // Fermeture si le focus quitte le menu vers l'extérieur du sélecteur.
    setTimeout(() => {
      const picker = document.getElementById('model-picker');
      if (isOpen() && picker && !picker.contains(document.activeElement)) close();
    }, 0);
  });

  select.addEventListener('change', syncModelPicker);
  syncModelPicker();
}
