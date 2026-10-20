// État de la page /connexion partagé entre ses modules : l'assistant en cours et les erreurs de rôle.
import { t } from './i18n.js';

/** Posé (sessionStorage) quand l'assistant a dépassé l'étape 1, retiré au clic sur Terminer ou à la suppression d'un rôle. */
export const WIZARD_KEY = 'lucania.connect.wizard';
/** Identifiant de l'étape courante (« role », « link », « shutdown », « recap »). */
export const STEP_KEY = 'lucania.connect.step';
/** Carte choisie à l'étape 1 tant que la machine n'a pas de rôle côté moteur. */
export const PICK_KEY = 'lucania.connect.pick';
/** « 1 » quand le récepteur a sauté l'étape d'extinction parce que la tour n'en propose pas (le retour depuis le récapitulatif va alors à la liaison). */
export const AUTOSKIP_KEY = 'lucania.connect.autoskip';
/** Ancienne clé de rôle (localStorage) : le rôle vient maintenant du moteur, la clé est seulement nettoyée. */
const LEGACY_ROLE_KEY = 'lucania.connect.role';

/** Événements entre remote-settings.js et connexion-page.js. */
export const EVENT_ROLE = 'lucania:role';
export const EVENT_SERVER_KEY = 'lucania:server-key';
/** Événement partagé avec connections-settings.js et shutdown-settings.js (détail : { source }). */
export const EVENT_CONNECTIONS = 'lucania:connections-changed';

/**
 * Étapes de l'assistant selon le rôle choisi.
 * La tour n'a pas d'étape de liaison ; sans rôle, une version neutre (« setup » n'est jamais une vraie étape).
 */
const STEPS = /** @type {Record<string, string[]>} */ ({
  tower: ['role', 'shutdown', 'recap'],
  laptop: ['role', 'link', 'shutdown', 'recap'],
  none: ['role', 'setup', 'recap'],
});

/** @param {string|null|undefined} role @returns {string[]} */
export function stepsFor(role) {
  return STEPS[role === 'tower' || role === 'laptop' ? role : 'none'];
}

/** @param {string} key */
export function readSession(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string|null} value null = effacer */
export function writeSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Stockage indisponible : le choix n'est pas mémorisé.
  }
}

/** Oublie l'assistant (après la suppression d'un rôle ou au clic sur Terminer). */
export function clearWizardState() {
  writeSession(WIZARD_KEY, null);
  writeSession(STEP_KEY, null);
  writeSession(PICK_KEY, null);
  writeSession(AUTOSKIP_KEY, null);
  try {
    localStorage.removeItem(LEGACY_ROLE_KEY);
  } catch {
    // Stockage indisponible : rien à nettoyer.
  }
}

/**
 * Message affiché pour une erreur de commande (chaîne Rust ou Error).
 * @param {unknown} e
 */
export function errorText(e) {
  const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
  if (msg === 'role_conflict') return t('settings.remote.roleConflict');
  return msg || t('settings.server.errors.generic');
}
