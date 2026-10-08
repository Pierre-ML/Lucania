// i18n côté serveur. Clé complète = `<namespace>.<chemin>` (ex. `chat.composer.placeholder`).
export const LANGS = ['fr', 'en'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'fr';

type Value = string | { [k: string]: Value };
type Params = Record<string, string | number>;

const modules = import.meta.glob('./*/*.json', { eager: true, import: 'default' }) as Record<string, Record<string, Value>>;

// dictionaries[lang][namespace]
const dictionaries: Record<string, Record<string, Record<string, Value>>> = {};
for (const [path, content] of Object.entries(modules)) {
	const m = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path);
	if (!m) continue;
	(dictionaries[m[1]] ??= {})[m[2]] = content;
}

export function isLang(value: unknown): value is Lang {
	return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

/** Langue de la requête : cookie `lang`, sinon Accept-Language, sinon 'fr'. */
export function getLang(astro: { cookies: { get(name: string): { value: string } | undefined }; request: Request }): Lang {
	const cookie = astro.cookies.get('lang')?.value;
	if (isLang(cookie)) return cookie;
	const header = astro.request.headers.get('accept-language') ?? '';
	const tags = header
		.split(',')
		.map((part, i) => {
			const [tag, ...rest] = part.trim().split(';');
			const q = /q=([\d.]+)/.exec(rest.join(';'));
			return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q[1]) : 1, i };
		})
		.filter((x) => x.lang && x.q > 0)
		.sort((a, b) => b.q - a.q || a.i - b.i);
	for (const tag of tags) if (isLang(tag.lang)) return tag.lang;
	return DEFAULT_LANG;
}

function lookup(lang: string, key: string): Value | undefined {
	const [ns, ...path] = key.split('.');
	let node: Value | undefined = dictionaries[lang]?.[ns];
	for (const part of path) {
		if (node === undefined || typeof node === 'string') return undefined;
		node = node[part];
	}
	return node;
}

function resolve(lang: string, value: Value, params?: Params): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value.other !== 'string') return undefined; // branche, pas une feuille
	const count = Number(params?.count);
	if (params?.count === undefined || Number.isNaN(count)) return value.other;
	let form: string;
	if (count === 0 && typeof value.zero === 'string') form = 'zero';
	else form = new Intl.PluralRules(lang).select(count) === 'one' ? 'one' : 'other';
	const picked = value[form];
	return typeof picked === 'string' ? picked : value.other;
}

export function t(lang: Lang, key: string, params?: Params): string {
	for (const l of lang === DEFAULT_LANG ? [lang] : [lang, DEFAULT_LANG]) {
		const value = lookup(l, key);
		if (value === undefined) continue;
		const text = resolve(l, value, params);
		if (text !== undefined) return text.replace(/\{(\w+)\}/g, (all, name) => (params && name in params ? String(params[name]) : all));
	}
	return key;
}
