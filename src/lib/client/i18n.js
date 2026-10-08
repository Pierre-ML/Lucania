// i18n côté client. Mêmes dictionnaires et mêmes règles que src/i18n/index.ts.
const modules = import.meta.glob('../../i18n/*/*.json', { eager: true, import: 'default' });

const LANGS = ['fr', 'en'];
const DEFAULT_LANG = 'fr';

// dictionaries[lang][namespace]
const dictionaries = {};
for (const [path, content] of Object.entries(modules)) {
	const m = /\/([^/]+)\/([^/]+)\.json$/.exec(path);
	if (!m) continue;
	(dictionaries[m[1]] ??= {})[m[2]] = content;
}

export function getLang() {
	const l = (document.documentElement.lang || '').toLowerCase().split('-')[0];
	return LANGS.includes(l) ? l : DEFAULT_LANG;
}

function lookup(lang, key) {
	const [ns, ...path] = key.split('.');
	let node = dictionaries[lang]?.[ns];
	for (const part of path) {
		if (node === undefined || typeof node === 'string') return undefined;
		node = node[part];
	}
	return node;
}

function resolve(lang, value, params) {
	if (typeof value === 'string') return value;
	if (!value || typeof value.other !== 'string') return undefined;
	const count = Number(params?.count);
	if (params?.count === undefined || Number.isNaN(count)) return value.other;
	let form;
	if (count === 0 && typeof value.zero === 'string') form = 'zero';
	else form = new Intl.PluralRules(lang).select(count) === 'one' ? 'one' : 'other';
	return typeof value[form] === 'string' ? value[form] : value.other;
}

export function t(key, params) {
	const lang = getLang();
	for (const l of lang === DEFAULT_LANG ? [lang] : [lang, DEFAULT_LANG]) {
		const value = lookup(l, key);
		if (value === undefined) continue;
		const text = resolve(l, value, params);
		if (text !== undefined) return text.replace(/\{(\w+)\}/g, (all, name) => (params && name in params ? String(params[name]) : all));
	}
	return key;
}

export function setLang(lang) {
	if (!LANGS.includes(lang)) return;
	document.cookie = `lang=${lang}; path=/; max-age=31536000; SameSite=Lax`;
	location.reload();
}

export function formatTime(date) {
	return new Intl.DateTimeFormat(getLang(), { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

export function formatDate(date) {
	return new Intl.DateTimeFormat(getLang(), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(date));
}
