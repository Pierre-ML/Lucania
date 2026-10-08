// Thèmes daisyUI : cookie `theme` + attribut data-theme sur <html>.
export const THEMES = [
	{ id: 'lucania', label: { fr: 'Lucania', en: 'Lucania' }, dark: true },
	{ id: 'system', label: { fr: 'Système', en: 'System' } },
	{ id: 'light', label: { fr: 'Clair', en: 'Light' }, dark: false },
	{ id: 'dark', label: { fr: 'Sombre', en: 'Dark' }, dark: true },
	{ id: 'dim', label: { fr: 'Dim', en: 'Dim' }, dark: true },
	{ id: 'night', label: { fr: 'Nuit', en: 'Night' }, dark: true },
	{ id: 'nord', label: { fr: 'Nord', en: 'Nord' }, dark: false },
	{ id: 'dracula', label: { fr: 'Dracula', en: 'Dracula' }, dark: true },
	{ id: 'cupcake', label: { fr: 'Cupcake', en: 'Cupcake' }, dark: false },
	{ id: 'business', label: { fr: 'Business', en: 'Business' }, dark: true },
	{ id: 'coffee', label: { fr: 'Café', en: 'Coffee' }, dark: true },
	{ id: 'sunset', label: { fr: 'Coucher de soleil', en: 'Sunset' }, dark: true },
	{ id: 'emerald', label: { fr: 'Émeraude', en: 'Emerald' }, dark: false },
];

const DEFAULT_THEME = 'lucania';
const isTheme = (id) => THEMES.some((t) => t.id === id);

export function getTheme() {
	const m = /(?:^|;\s*)theme=([^;]*)/.exec(typeof document === 'undefined' ? '' : document.cookie);
	const id = m ? decodeURIComponent(m[1]) : DEFAULT_THEME;
	return isTheme(id) ? id : DEFAULT_THEME;
}

/** Thème réellement appliqué : 'system' devient 'light' ou 'dark'. */
export function resolveTheme(id) {
	if (id === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
	return isTheme(id) ? id : DEFAULT_THEME;
}

let systemQuery = null;
const onSystemChange = () => {
	document.documentElement.dataset.theme = resolveTheme('system');
};

export function setTheme(id) {
	if (!isTheme(id)) id = DEFAULT_THEME;
	document.cookie = `theme=${id}; path=/; max-age=31536000; SameSite=Lax`;
	if (!systemQuery) systemQuery = window.matchMedia('(prefers-color-scheme: light)');
	systemQuery.removeEventListener('change', onSystemChange);
	if (id === 'system') systemQuery.addEventListener('change', onSystemChange);
	document.documentElement.dataset.theme = resolveTheme(id);
}

// Thème « système » déjà actif au chargement : suivre les changements de préférence.
if (typeof document !== 'undefined' && getTheme() === 'system') {
	systemQuery = window.matchMedia('(prefers-color-scheme: light)');
	systemQuery.addEventListener('change', onSystemChange);
}
