// Logique pure (sans DOM) du tri des e-mails par un petit modèle local.

/** @typedef {'personnel'|'pro'|'notification'|'pub'|'indesirable'} MailCategory */
/** @typedef {MailCategory|'incertain'} MailVerdict */
/** @typedef {{ from: string, subject: string, date: string, snippet?: string }} MailInput */
/** @typedef {{ sender: string, subject: string, aiCategory: string, userCategory: string|null, rating: number }} MailExample */
/** @typedef {{ name: string, file: string, sizeGb: number, repo: string, best: boolean }} MailModel */
/** @typedef {{ tier: 'light'|'medium'|'strong', ramGb: number, vramGb: number, models: MailModel[] }} MailRecommendation */

/** @type {MailCategory[]} */
export const MAIL_CATEGORIES = ['personnel', 'pro', 'notification', 'pub', 'indesirable'];

export const MAIL_MAX_TOKENS = 80;

export const DEFAULT_SYSTEM_PROMPT = [
  "Tu es un trieur d'e-mails. D'après l'expéditeur, l'objet et un court extrait, classe le message dans UNE catégorie. Ne résume jamais le message et ne le recopie pas.",
  '',
  'Catégories :',
  '- personnel : écrit à la main par une vraie personne (famille, ami, collègue, contact), adresse de particulier, ton personnel.',
  "- pro : entreprise ou administration avec une info utile ou une action : facture, commande, livraison, banque, impôts, rendez-vous, sécurité du compte, code de connexion.",
  "- notification : message automatique sans action (réseaux sociaux, alertes, confirmations, rappels d'app).",
  '- pub : publicité, promotion, soldes, newsletter, marketing, adresses noreply commerciales.',
  '- indesirable : spam, arnaque, hameçonnage, gain improbable, urgence suspecte, expéditeur incohérent.',
  '',
  'En cas de doute entre pub et notification, choisis pub si le message cherche à vendre.',
  "Les règles apprises de l'utilisateur sont PRIORITAIRES sur tout le reste.",
  '',
  'Réponds UNIQUEMENT avec ce JSON, sans aucun texte autour :',
  '{"categorie":"<personnel|pro|notification|pub|indesirable>","raison":"<8 mots max>"}',
  '/no_think',
].join('\n');

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {MailInput} mail
 * @param {{ systemPrompt?: string, memory?: string[], examples?: MailExample[] }} [ctx]
 * @returns {{ role: 'system'|'user', content: string }[]}
 */
export function buildMailMessages(mail, ctx = {}) {
  const custom = typeof ctx.systemPrompt === 'string' ? ctx.systemPrompt.trim() : '';
  let system = custom || DEFAULT_SYSTEM_PROMPT;

  const memory = (ctx.memory ?? []).map((m) => clean(m, 300)).filter(Boolean).slice(-30);
  if (memory.length) {
    system += "\n\nRègles apprises de l'utilisateur (prioritaires) :\n" + memory.map((m) => `- ${m}`).join('\n');
  }

  const examples = (ctx.examples ?? []).slice(0, 10);
  if (examples.length) {
    const lines = examples.map((e) => {
      const cat = e.userCategory || (e.rating === 1 ? e.aiCategory : '') || e.aiCategory;
      return `- De : ${clean(e.sender, 120)} | Objet : ${clean(e.subject, 120)} → ${cat}`;
    });
    system += "\n\nCorrections passées de l'utilisateur :\n" + lines.join('\n');
  }

  const user = `Expéditeur : ${clean(mail.from, 200)}\nObjet : ${clean(mail.subject, 200)}\nExtrait : ${clean(mail.snippet, 300)}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** @type {[MailCategory, RegExp][]} */
const SYNONYMS = [
  ['indesirable', /\b(indesirables?|spam|arnaque|phishing|junk)\b/],
  ['notification', /\b(notifications?|notif|automatiques?|auto)\b/],
  ['pub', /\b(pub|publicites?|promos?|promotions?|newsletters?|marketing|ads?)\b/],
  ['personnel', /\b(personnel|personnelle|personal|personne)\b/],
  ['pro', /\b(pro|professionnel|professionnelle|entreprise|work|business|important)\b/],
];

/**
 * @param {string} s
 * @returns {string}
 */
function norm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
function firstJsonObject(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return /** @type {Record<string, unknown>} */ (obj);
        } catch {
          // essaie l'accolade suivante
        }
        break;
      }
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {{ category: MailVerdict, reason: string }}
 */
export function parseMailVerdict(text) {
  const raw = String(text ?? '');
  let reason = '';
  const obj = firstJsonObject(raw);
  if (obj) {
    for (const [key, val] of Object.entries(obj)) {
      const k = norm(key);
      if (typeof val !== 'string') continue;
      if (k === 'raison' || k === 'reason') reason = val.trim().slice(0, 160);
    }
    for (const [key, val] of Object.entries(obj)) {
      const k = norm(key);
      if ((k === 'categorie' || k === 'category') && typeof val === 'string') {
        const v = norm(val);
        if (/** @type {string[]} */ (MAIL_CATEGORIES).includes(v)) {
          return { category: /** @type {MailCategory} */ (v), reason };
        }
        for (const [cat, re] of SYNONYMS) if (re.test(v)) return { category: cat, reason };
      }
    }
  }

  // Repli : premier mot-clé trouvé dans le texte.
  const n = norm(raw);
  /** @type {MailCategory|null} */
  let best = null;
  let bestIdx = Infinity;
  for (const [cat, re] of SYNONYMS) {
    const m = re.exec(n);
    if (m && m.index < bestIdx) {
      best = cat;
      bestIdx = m.index;
    }
  }
  return { category: best ?? 'incertain', reason };
}

/** @type {Record<'light'|'medium'|'strong', MailModel[]>} */
const MODELS = {
  light: [
    { name: 'Qwen3 1.7B', file: 'Qwen3-1.7B-Q4_K_M.gguf', sizeGb: 1.1, repo: 'unsloth/Qwen3-1.7B-GGUF', best: true },
    { name: 'Llama 3.2 3B Instruct', file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', sizeGb: 2.0, repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', best: false },
    { name: 'Gemma 3 1B it', file: 'gemma-3-1b-it-Q4_K_M.gguf', sizeGb: 0.8, repo: 'unsloth/gemma-3-1b-it-GGUF', best: false },
  ],
  medium: [
    { name: 'Qwen3 4B', file: 'Qwen3-4B-Q4_K_M.gguf', sizeGb: 2.5, repo: 'unsloth/Qwen3-4B-GGUF', best: true },
    { name: 'Gemma 3 4B it', file: 'gemma-3-4b-it-Q4_K_M.gguf', sizeGb: 2.5, repo: 'unsloth/gemma-3-4b-it-GGUF', best: false },
    { name: 'Phi-4 mini instruct', file: 'Phi-4-mini-instruct-Q4_K_M.gguf', sizeGb: 2.5, repo: 'unsloth/Phi-4-mini-instruct-GGUF', best: false },
  ],
  strong: [
    { name: 'Qwen3 8B', file: 'Qwen3-8B-Q4_K_M.gguf', sizeGb: 5.0, repo: 'unsloth/Qwen3-8B-GGUF', best: true },
    { name: 'Llama 3.1 8B Instruct', file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', sizeGb: 4.9, repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', best: false },
    { name: 'Qwen3 4B (rapide)', file: 'Qwen3-4B-Q4_K_M.gguf', sizeGb: 2.5, repo: 'unsloth/Qwen3-4B-GGUF', best: false },
  ],
};

const GB = 1024 ** 3;

/**
 * @param {number} bytes
 * @returns {number}
 */
function toGb(bytes) {
  return Math.round((Number(bytes) || 0) / GB * 10) / 10;
}

/**
 * @param {{ ramTotalBytes: number, ramAvailableBytes: number, gpus: { name?: string, vramTotalBytes?: number, vramBytes?: number }[] }|null} hw
 * @returns {MailRecommendation}
 */
export function recommendMailModels(hw) {
  const ramGb = hw ? toGb(hw.ramTotalBytes) : 0;
  const vramGb = hw ? toGb(Math.max(0, ...(hw.gpus ?? []).map((g) => g.vramTotalBytes ?? g.vramBytes ?? 0))) : 0;
  /** @type {'light'|'medium'|'strong'} */
  let tier = 'light';
  if (vramGb >= 10 || (vramGb < 4 && ramGb >= 32)) tier = 'strong';
  else if (vramGb >= 5 || ramGb >= 16) tier = 'medium';
  return { tier, ramGb, vramGb, models: MODELS[tier].map((m) => ({ ...m })) };
}
