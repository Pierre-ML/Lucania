// État de la page /connexion partagé entre ses modules : l'assistant en cours et les erreurs de rôle.
import { t } from './i18n.js';

/** Posé (sessionStorage) quand l'assistant a dépassé l'étape 1, retiré au clic sur Terminer ou à la suppression d'un rôle. */
export const WIZARD_KEY = 'lucania.connect.wizard';
export const STEP_KEY = 'lucania.connect.step';
/** Carte choisie à l'étape 1 tant que la machine n'a pas de rôle côté moteur. */
export const PICK_KEY = 'lucania.connect.pick';
/** Ancienne clé de rôle (localStorage) : le rôle vient maintenant du moteur, la clé est seulement nettoyée. */
const LEGACY_ROLE_KEY = 'lucania.connect.role';

/** Événements entre remote-settings.js et connexion-page.js. */
export const EVENT_ROLE = 'lucania:role';
export const EVENT_SERVER_KEY = 'lucania:server-key';

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
