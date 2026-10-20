// Petits helpers partagés par les réglages (interrupteurs et URL).

/** @param {Element} sw */
export const isOn = (sw) => sw.getAttribute('aria-checked') === 'true';

/** @param {Element} sw @param {boolean} on */
export const setOn = (sw, on) => sw.setAttribute('aria-checked', on ? 'true' : 'false');

/** @param {string} value */
export function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}
