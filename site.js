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
const NAV = [
  { base: '/', en: 'Home', es: 'Inicio' },
  { base: '/drivers', en: 'For drivers', es: 'Para choferes' },
  { base: '/carriers', en: 'For carriers', es: 'Para compañías' },
  { base: '/about', en: 'About', es: 'Nosotros' },
];

const CHROME = {
  en: {
    nav_cta: 'Apply now', ft_tag: 'Owner-operator placement · Dallas–Fort Worth',
    ft_apply: 'Apply to drive', ft_privacy: 'Privacy', ft_terms: 'Terms',
    strip_a: 'Owner-operators wanted', strip_b: 'English & Español',
    menu: 'Menu',
  },
  es: {
    nav_cta: 'Aplica ya', ft_tag: 'Colocación de dueños de troca · Dallas–Fort Worth',
    ft_apply: 'Aplica para manejar', ft_privacy: 'Privacidad', ft_terms: 'Términos',
    strip_a: 'Buscamos dueños de troca', strip_b: 'English & Español',
    menu: 'Menú',
  },
};

// Strip a leading /es so a page can work out what it is regardless of language.
function basePath() {
  const p = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  return p.replace(/^\/es(?=\/|$)/, '') || '/';
}

function pickLang() {
  let l = (navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  try { const s = localStorage.getItem('tt_lang'); if (s) l = s; } catch (e) {}
  if (/^\/es(\/|$)/.test(location.pathname)) l = 'es';
  return l;
}

let lang = pickLang();

// A language-neutral path, prefixed for the current language.
function L(base, l) {
  const lg = l || lang;
  if (lg !== 'es') return base;
  return base === '/' ? '/es' : '/es' + base;
}
function langPath(l) { return L(basePath(), l); }

function chrome(t) {
  const here = basePath();
  const navHtml = NAV.map((n) =>
    `<a href="${L(n.base)}"${n.base === here ? ' class="on"' : ''}>${n[lang]}</a>`).join('');

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
       <a class="logo" href="${L('/')}">${LOGO}</a>
       <nav class="nav" id="nav">${navHtml}</nav>
       <div class="hdr-right">
         <div class="lang"><button data-lang="en">EN</button><button data-lang="es">ES</button></div>
         ${hasCta ? `<a class="cta" href="${cta.href}">${cta.label}</a>` : ''}
         <button class="navtoggle" id="navtoggle" aria-label="${t.menu}" aria-expanded="false">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
         </button>
       </div>
     </div>`;

  document.getElementById('ftr').innerHTML =
    `<div class="wrap ft">
       <div>© ${new Date().getFullYear()} Truckers &amp; Trokeros · ${t.ft_tag}</div>
       <div class="ftlinks">
         ${NAV.map((n) => `<a href="${L(n.base)}">${n[lang]}</a>`).join('')}
         <a href="${L('/privacy')}">${t.ft_privacy}</a>
         <a href="${L('/terms')}">${t.ft_terms}</a>
       </div>
     </div>`;

  document.querySelectorAll('.lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.onclick = () => { lang = b.dataset.lang; paintPage(); };
  });

  const tog = document.getElementById('navtoggle'), nav = document.getElementById('nav');
  if (tog && nav) tog.onclick = () => {
    const open = nav.classList.toggle('open');
    tog.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
}

function paintPage() {
  const t = Object.assign({}, CHROME[lang], (typeof T !== 'undefined' && T[lang]) || {});
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

  try { localStorage.setItem('tt_lang', lang); } catch (e) {}
  const want = langPath(lang);
  if (history.replaceState && !location.pathname.endsWith('.html') && location.pathname !== want) {
    history.replaceState(null, '', want + location.search + location.hash);
  }
  const canon = document.querySelector('link[rel=canonical]');
  if (canon) canon.href = 'https://truckersandtrokeros.com' + want;
}
