// Champ « code de la tour » (ServerKeyField.astro) : masqué par défaut, boutons Afficher / Masquer et Copier.
import { t } from './i18n.js';

/**
 * @param {ParentNode} [root]
 * @returns {{ setKey: (key: string|null) => void }}
 */
export function initServerKeyField(root = document) {
  const block = /** @type {HTMLElement|null} */ (root.querySelector('[data-key-block]'));
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-key-input]'));
  const toggleBtn = /** @type {HTMLButtonElement|null} */ (root.querySelector('[data-key-toggle]'));
  const copyBtn = /** @type {HTMLButtonElement|null} */ (root.querySelector('[data-key-copy]'));
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let copyTimer;

  function renderToggle() {
    if (toggleBtn && input) toggleBtn.textContent = input.type === 'password' ? t('settings.server.key.show') : t('settings.server.key.hide');
  }

  toggleBtn?.addEventListener('click', () => {
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    renderToggle();
  });

  copyBtn?.addEventListener('click', async () => {
    if (!input || !copyBtn) return;
    try {
      await navigator.clipboard.writeText(input.value);
      copyBtn.textContent = t('settings.server.key.copied');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyBtn.textContent = t('settings.server.key.copy');
      }, 2000);
    } catch {
      // Presse-papiers refusé : on affiche le code pour un copier manuel.
      input.type = 'text';
      input.select();
      renderToggle();
    }
  });

  return {
    /** @param {string|null} key */
    setKey(key) {
      if (!block || !input) return;
      input.value = key ?? '';
      input.type = 'password';
      renderToggle();
      block.hidden = !key;
    },
  };
}
