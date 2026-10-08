import { marked } from 'marked';
import DOMPurify from 'dompurify';

let hookRegistered = false;

function registerHook() {
  if (hookRegistered) return;
  hookRegistered = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Convertit du Markdown en HTML sanitizé.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdown(text) {
  registerHook();
  const html = /** @type {string} */ (marked.parse(text || '', { gfm: true, breaks: true, async: false }));
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}
