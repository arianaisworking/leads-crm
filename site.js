// site.js — shared chrome for truckersandtrokeros.com.
//
// Each page supplies its own `T = { en:{...}, es:{...} }` and calls paintPage().
// This file owns the header, the nav, the footer and the language rules.
//
// Language, most explicit signal first:
//   1. the path      — /es/drivers is a link someone deliberately shared
//   2. localStorage  — they've toggled before on this device
//   3. the browser
// The toggle rewrites the path so what someone copies is what they were
// reading, which is the whole reason /es exists rather than a cookie.

const LOGO = '<span class="mark">Truckers <span class="amp">&amp;</span> Trokeros</span>';

// One nav, defined once. `base` is the language-neutral path; site.js adds the
// /es prefix. Order is the order a driver needs them in.
// Three languages. Punjabi is here because a large share of owner-operators in
// the US run their business in Punjabi, and a site that only speaks English and
// Spanish is closed to them.
//
// English is the fallback for every key, per key, not per language: a page that
// hasn't been translated yet shows English text rather than an empty element.
// That's what lets Punjabi be added a page at a time instead of all at once.
const LANGS = ['en', 'es', 'pa'];
const LANG_LABEL = { en: 'EN', es: 'ES', pa: 'ਪੰਜਾਬੀ' };

const NAV = [
  { base: '/', en: 'Home', es: 'Inicio', pa: 'ਹੋਮ' },
  { base: '/drivers', en: 'For drivers', es: 'Para choferes', pa: 'ਡਰਾਈਵਰਾਂ ਲਈ' },
  { base: '/carriers', en: 'For carriers', es: 'Para compañías', pa: 'ਕੰਪਨੀਆਂ ਲਈ' },
  { base: '/about', en: 'About', es: 'Nosotros', pa: 'ਸਾਡੇ ਬਾਰੇ' },
];

// /contact.js, if the page loaded it. Everything below degrades to nothing
// when there's no number, rather than rendering a link that dials nowhere.
function contact() {
  const c = (typeof window !== 'undefined' && window.CONTACT) || {};
  const phone = String(c.phone || '').replace(/[^\d+]/g, '');
  const wa = String(c.whatsapp || '').replace(/\D/g, '');
  return { phone, wa, display: c.display || c.phone || '' };
}

const CHROME = {
  en: {
    nav_cta: 'Apply now', ft_tag: 'Owner-operator placement, nationwide',
    ft_apply: 'Apply to drive', ft_privacy: 'Privacy', ft_terms: 'Terms',
    strip_a: 'Owner-operators wanted', strip_b: 'English · Español · ਪੰਜਾਬੀ',
    menu: 'Menu', call: 'Contact', call_aria: 'Contact us', lang_label: 'Language',
  },
  es: {
    nav_cta: 'Aplica ya', ft_tag: 'Colocación de dueños de troca en todo el país',
    ft_apply: 'Aplica para manejar', ft_privacy: 'Privacidad', ft_terms: 'Términos',
    strip_a: 'Buscamos dueños de troca', strip_b: 'English · Español · ਪੰਜਾਬੀ',
    menu: 'Menú', call: 'Contacto', call_aria: 'Contáctanos', lang_label: 'Idioma',
  },
  pa: {
    nav_cta: 'ਹੁਣੇ ਅਪਲਾਈ ਕਰੋ', ft_tag: 'ਪੂਰੇ ਦੇਸ਼ ਵਿੱਚ ਓਨਰ-ਓਪਰੇਟਰ ਪਲੇਸਮੈਂਟ',
    ft_apply: 'ਡਰਾਈਵ ਕਰਨ ਲਈ ਅਪਲਾਈ ਕਰੋ', ft_privacy: 'ਪਰਾਈਵੇਸੀ', ft_terms: 'ਸ਼ਰਤਾਂ',
    strip_a: 'ਓਨਰ-ਓਪਰੇਟਰ ਚਾਹੀਦੇ ਹਨ', strip_b: 'English · Español · ਪੰਜਾਬੀ',
    menu: 'ਮੀਨੂ', call: 'ਸੰਪਰਕ', call_aria: 'ਸਾਡੇ ਨਾਲ ਸੰਪਰਕ ਕਰੋ', lang_label: 'ਭਾਸ਼ਾ',
  },
};

// Strip a leading /es so a page can work out what it is regardless of language.
function basePath() {
  const p = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  return p.replace(/^\/(es|pa)(?=\/|$)/, '').replace(/^\/drive$/, '/') || '/';
}

// A page can declare itself single-language with `const PAGE_LANG = 'en'`.
// The carriers page is English by choice — its body copy has no Spanish twin —
// so /es/carriers must not paint a Spanish header over an English page, or
// claim /es/carriers as its canonical URL.
function onlyLang() {
  return (typeof PAGE_LANG !== 'undefined' && PAGE_LANG) || null;
}

function pickLang() {
  const fixed = onlyLang();
  if (fixed) return fixed;
  const nav = (navigator.language || 'en').toLowerCase();
  let l = nav.startsWith('es') ? 'es' : nav.startsWith('pa') ? 'pa' : 'en';
  try { const s = localStorage.getItem('tt_lang'); if (LANGS.includes(s)) l = s; } catch (e) {}
  const m = location.pathname.match(/^\/(es|pa)(\/|$)/);
  if (m) l = m[1];
  return l;
}

let lang = pickLang();

// A language-neutral path, prefixed for the current language.
function L(base, l) {
  const lg = l || lang;
  if (lg === 'en') return base;
  return base === '/' ? '/' + lg : '/' + lg + base;
}
function langPath(l) { return L(basePath(), l); }

function chrome(t) {
  const here = basePath();
  const ct = contact();
  const link = (n) => `<a href="${L(n.base)}"${n.base === here ? ' class="on"' : ''}>${n[lang]}</a>`;
  // Two halves either side of the wordmark on desktop; one sheet on a phone.
  const navLeft = NAV.slice(0, 2).map(link).join('');
  const navRight = NAV.slice(2).map(link).join('');
  const navAll = NAV.map(link).join('');

  // PAGE_CTA: an object overrides the default, `false` drops the button —
  // which is what the application page wants, since it *is* the destination.
  const hasCta = typeof PAGE_CTA === 'undefined' || PAGE_CTA !== false;
  const cta = (typeof PAGE_CTA !== 'undefined' && PAGE_CTA)
    ? PAGE_CTA : { label: t.nav_cta, href: L('/drivers') };

  const strip = document.getElementById('strip');
  if (strip) strip.innerHTML =
    `<b>${t.strip_a}</b><span class="dot">&#9679;</span><span>${t.strip_b}</span>`;

  document.getElementById('hdr').innerHTML =
    `<div class="wrap hd">
       <nav class="nav navL">${navLeft}</nav>
       <a class="logo" href="${L('/')}">${LOGO}</a>
       <div class="hdr-right">
         <nav class="nav navR">${navRight}${ct.phone
           ? `<a class="tel" href="tel:${ct.phone}" aria-label="${t.call_aria}">${t.call}</a>` : ''}</nav>
         ${onlyLang() ? '' : `<label class="lang"><span class="vh">${t.lang_label}</span><select id="langsel">${LANGS
           .map((l) => `<option value="${l}"${l === lang ? ' selected' : ''}>${LANG_LABEL[l]}</option>`)
           .join('')}</select></label>`}
         ${hasCta ? `<a class="cta" href="${cta.href}">${cta.label}</a>` : ''}
         <button class="navtoggle" id="navtoggle" aria-label="${t.menu}" aria-expanded="false">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
         </button>
       </div>
       <nav class="navsheet" id="navsheet">${navAll}${ct.phone
         ? `<a href="tel:${ct.phone}">${t.call} &middot; ${ct.display}</a>` : ''}</nav>
     </div>`;

  document.getElementById('ftr').innerHTML =
    `<div class="wrap ft">
       <div>© ${new Date().getFullYear()} Truckers &amp; Trokeros · ${t.ft_tag}</div>
       <div class="ftlinks">
         ${ct.phone ? `<a class="ftnum" href="tel:${ct.phone}">${ct.display}</a>` : ''}
         ${NAV.map((n) => `<a href="${L(n.base)}">${n[lang]}</a>`).join('')}
         <a href="${L('/privacy')}">${t.ft_privacy}</a>
         <a href="${L('/terms')}">${t.ft_terms}</a>
       </div>
     </div>`;

  const sel = document.getElementById('langsel');
  if (sel) sel.onchange = () => { lang = sel.value; paintPage(); };

  // A driver stuck halfway through the form should be one thumb from a call.
  const bar = document.getElementById('callbar');
  if (bar) {
    if (ct.phone) {
      bar.innerHTML =
        `<a class="call" href="tel:${ct.phone}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .3 1.9.6 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.5 2.8.6a2 2 0 0 1 1.7 2Z"/></svg><span>${t.call}</span></a>` +
        (ct.wa ? `<a class="wa" href="https://wa.me/${ct.wa}" target="_blank" rel="noopener">WhatsApp</a>` : '');
      bar.hidden = false;
    } else { bar.hidden = true; }
  }

  const tog = document.getElementById('navtoggle'), sheet = document.getElementById('navsheet');
  if (tog && sheet) tog.onclick = () => {
    const open = sheet.classList.toggle('open');
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
}

// Attribution. A link shared as /?r=mystica or /pa/drivers?utm_source=fb has to
// survive every hop, because the form that finally reads the tag may be two
// pages away. Every internal link on the page carries the tags forward; nothing
// else is carried, so a stray query string can't ride along into the CRM.
const CARRY = ['r', 'src', 'carrier', 'utm_source', 'utm_medium', 'utm_campaign'];
function carryQuery() {
  const from = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  for (const k of CARRY) { const v = from.get(k); if (v) keep.set(k, v); }
  const q = keep.toString();
  if (!q) return;
  document.querySelectorAll('a[href]').forEach((a) => {
    const raw = a.getAttribute('href');
    if (!raw || /^(tel:|mailto:|https?:|#)/i.test(raw)) return;
    const hash = raw.includes('#') ? raw.slice(raw.indexOf('#')) : '';
    const path = raw.split('#')[0].split('?')[0];
    a.setAttribute('href', path + '?' + q + hash);
  });
}

function paintPage() {
  // `lang` was picked when this file loaded, before the page's own PAGE_LANG
  // existed. A single-language page overrides it here, on every paint — a
  // reader whose stored choice is Spanish must not get a Spanish header
  // bolted onto an English page.
  const fixed = onlyLang();
  if (fixed) lang = fixed;
  // English underneath, the chosen language on top, key by key — an untranslated
  // string falls back to readable English instead of painting nothing.
  const t = Object.assign({}, CHROME.en, CHROME[lang],
    (typeof T !== 'undefined' && T.en) || {}, (typeof T !== 'undefined' && T[lang]) || {});
  document.documentElement.lang = lang;
  chrome(t);

  document.querySelectorAll('[data-t]').forEach((el) => {
    const v = t[el.dataset.t];
    if (v == null) return;
    // Entities count as markup too. "Truckers &amp; Trokeros" carries no tag,
    // and textContent would print the &amp; literally.
    if (/<\/?[a-z]|&[a-z]+;|&#\d+;/i.test(v)) el.innerHTML = v; else el.textContent = v;
  });
  // Lists: [data-list="key"], rows of a string or [label, rest].
  document.querySelectorAll('[data-list]').forEach((el) => {
    const rows = t[el.dataset.list];
    if (!Array.isArray(rows)) return;
    el.innerHTML = rows.map((r) => (Array.isArray(r)
      ? `<li><strong>${r[0]}</strong> ${r[1]}</li>` : `<li>${r}</li>`)).join('');
  });
  // Links that need the language prefix: <a data-href="/drivers">. Written once
  // here so no page has to reimplement /es prefixing for its own buttons.
  document.querySelectorAll('[data-href]').forEach((el) => { el.href = L(el.dataset.href); });
  // Two-column tables: [data-rows="key"], rows of [label, value].
  document.querySelectorAll('[data-rows]').forEach((el) => {
    const rows = t[el.dataset.rows];
    if (!Array.isArray(rows)) return;
    const head = t[el.dataset.rows + '_head'] || ['', ''];
    el.innerHTML =
      `<thead><tr><th>${head[0]}</th><th>${head[1]}</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${r[0]}</td><td data-l="${head[1]}">${r[1]}</td></tr>`).join('') +
      '</tbody>';
  });

  if (t.title) document.title = t.title;
  const desc = document.querySelector('meta[name=description]');
  if (desc && t.desc) desc.content = t.desc;

  // Only a page that actually has both languages gets to move the address bar,
  // rewrite its canonical, or remember the reader's choice.
  carryQuery();

  if (onlyLang()) return;
  try { localStorage.setItem('tt_lang', lang); } catch (e) {}
  const want = langPath(lang);
  if (history.replaceState && !location.pathname.endsWith('.html') && location.pathname !== want) {
    history.replaceState(null, '', want + location.search + location.hash);
  }
  const canon = document.querySelector('link[rel=canonical]');
  if (canon) canon.href = 'https://truckersandtrokeros.com' + want;
}
