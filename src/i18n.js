// =============================================================================
// i18n.js — tiny dictionary-based i18n runtime. IMPLEMENTED in Stage A (it is the
// "i18n loader" deliverable). DOM-aware only via the opt-in `applyTo` helper;
// the core (t / setLocale / subscribe) is pure and Node-testable.
//
// Design: dictionaries are FLAT { "key.path": "text" } maps injected at creation
// (see locales/en.js, locales/fr.js). Default locale is English. Missing keys
// fall back to the fallback locale, then to the key itself (visible, not blank).
// =============================================================================

/**
 * @typedef {Record<string,string>} Dictionary
 * @typedef {object} I18n
 * @property {(key:string, params?:Record<string,string|number>) => string} t
 * @property {(locale:string) => void} setLocale
 * @property {() => string} getLocale
 * @property {() => string[]} locales
 * @property {(key:string) => boolean} has
 * @property {(handler:(locale:string)=>void) => (()=>void)} subscribe
 * @property {(root?:ParentNode) => void} applyTo
 */

/**
 * Interpolate {name} placeholders from `params`.
 * @param {string} template @param {Record<string,string|number>} [params]
 */
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
  );
}

/**
 * Create an i18n instance.
 * @param {{ dictionaries:Record<string,Dictionary>, locale?:string, fallbackLocale?:string }} cfg
 * @returns {I18n}
 */
export function createI18n(cfg) {
  const dictionaries = cfg.dictionaries || {};
  const fallbackLocale = cfg.fallbackLocale || "en";
  let locale = cfg.locale && dictionaries[cfg.locale] ? cfg.locale : fallbackLocale;
  /** @type {Set<(locale:string)=>void>} */
  const subscribers = new Set();

  function lookup(key) {
    const primary = dictionaries[locale];
    if (primary && key in primary) return primary[key];
    const fb = dictionaries[fallbackLocale];
    if (fb && key in fb) return fb[key];
    return null;
  }

  /** @type {I18n['t']} */
  function t(key, params) {
    const raw = lookup(key);
    return raw == null ? key : interpolate(raw, params);
  }

  /** @type {I18n['setLocale']} */
  function setLocale(next) {
    if (!dictionaries[next] || next === locale) return;
    locale = next;
    subscribers.forEach((h) => h(locale));
  }

  const getLocale = () => locale;
  const locales = () => Object.keys(dictionaries);
  const has = (key) => lookup(key) != null;

  /** @type {I18n['subscribe']} */
  function subscribe(handler) {
    subscribers.add(handler);
    return () => subscribers.delete(handler);
  }

  /**
   * Translate a DOM subtree in place. Conventions:
   *   data-i18n="key"                 -> element.textContent
   *   data-i18n-html="key"            -> element.innerHTML (value assumed trusted locale copy)
   *   data-i18n-placeholder="key"     -> element.placeholder
   *   data-i18n-title="key"           -> element.title
   *   data-i18n-aria-label="key"      -> aria-label attribute
   * @type {I18n['applyTo']}
   */
  function applyTo(root) {
    const scope = root || (typeof document !== "undefined" ? document : null);
    if (!scope) return;
    scope.querySelectorAll("[data-i18n]").forEach((elem) => {
      elem.textContent = t(elem.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((elem) => {
      elem.innerHTML = t(elem.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((elem) => {
      elem.setAttribute("placeholder", t(elem.getAttribute("data-i18n-placeholder")));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((elem) => {
      elem.setAttribute("title", t(elem.getAttribute("data-i18n-title")));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((elem) => {
      elem.setAttribute("aria-label", t(elem.getAttribute("data-i18n-aria-label")));
    });
  }

  return { t, setLocale, getLocale, locales, has, subscribe, applyTo };
}
