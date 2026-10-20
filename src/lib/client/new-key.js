// Bloc « code de la tour affiché une seule fois » (NewKeyNotice.astro) : code complet, bouton Copier, avertissement.
import { t } from './i18n.js';

/**
 * @param {ParentNode} root conteneur du bloc (plusieurs blocs peuvent exister dans la page)
 * @returns {{ show: (key: string) => void, hide: () => void }}
 */
export function initNewKeyView(root) {
  const block = /** @type {HTMLElement|null} */ (root.querySelector('[data-newkey-block]'));
  const input = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-newkey-input]'));
  const copyBtn = /** @type {HTMLButtonElement|null} */ (root.querySelector('[data-newkey-copy]'));
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let copyTimer;

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
      // Presse-papiers refusé : le code est sélectionné pour un copier manuel.
      input.select();
    }
  });

  return {
    /** @param {string} key */
    show(key) {
      if (!block || !input) return;
      input.value = key;
      block.hidden = false;
    },
    hide() {
      if (!block || !input) return;
      input.value = '';
      block.hidden = true;
    },
  };
}
