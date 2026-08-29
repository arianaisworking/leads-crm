// site.js — shared chrome for the content pages on truckersandtrokeros.com.
//
// Each page supplies its own `T = { en:{...}, es:{...} }` and calls paintPage().
// This file owns everything the pages have in common: the header and footer
// markup, the language toggle, and the URL rules that keep /es meaningful.
//
// Language, most explicit signal first:
//   1. the path      — /es/privacy is a link someone deliberately shared
//   2. localStorage  — they've toggled before on this device
//   3. the browser
// The toggle rewrites the path so what someone copies is what they were
// reading, which is the whole reason /es exists rather than a cookie.

const LOGO_SVG = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#e8590c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16V6.5h11.5V16"/><path d="M13.5 10H18l3.2 3.9V16"/><circle cx="7" cy="17.6" r="2.1"/><circle cx="17.5" cy="17.6" r="2.1"/></svg>';

// Chrome strings live here so a new page doesn't have to restate them.
const CHROME = {
  en: {
    nav_cta: 'Apply now', ft_tag: 'Owner-operator placement · Dallas–Fort Worth',
    ft_apply: 'Apply to drive', ft_privacy: 'Privacy', ft_terms: 'Terms', ft_home: 'Home',
  },
  es: {
    nav_cta: 'Aplica ya', ft_tag: 'Colocación de dueños de troca · Dallas–Fort Worth',
    ft_apply: 'Aplica para manejar', ft_privacy: 'Privacidad', ft_terms: 'Términos', ft_home: 'Inicio',
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

function langPath(l) {
  const b = basePath();
  return l === 'es' ? (b === '/' ? '/es' : '/es' + b) : b;
}

function chrome(t) {
  const home = langPath(lang) === '/' ? '/' : (lang === 'es' ? '/es' : '/');
  document.getElementById('hdr').innerHTML =
    `<div class="wrap hd">
       <a class="logo" href="${home}">${LOGO_SVG}<span>Truckers <span style="color:#ff8f4d">&amp;</span> Trokeros</span></a>
       <div style="display:flex;align-items:center;gap:12px">
         <div class="lang"><button data-lang="en">EN</button><button data-lang="es">ES</button></div>
         <a class="cta" href="${home}#apply">${t.nav_cta}</a>
       </div>
     </div>`;
  document.getElementById('ftr').innerHTML =
    `<div class="wrap ft">
       <div>© ${new Date().getFullYear()} Truckers &amp; Trokeros · ${t.ft_tag}</div>
       <div class="ftlinks">
         <a href="${home}">${t.ft_home}</a>
         <a href="${lang === 'es' ? '/es/privacy' : '/privacy'}">${t.ft_privacy}</a>
         <a href="${lang === 'es' ? '/es/terms' : '/terms'}">${t.ft_terms}</a>
         <a href="${home}#apply">${t.ft_apply}</a>
       </div>
     </div>`;
  document.querySelectorAll('.lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
    b.onclick = () => { lang = b.dataset.lang; paintPage(); };
  });
}

function paintPage() {
  const t = Object.assign({}, CHROME[lang], (typeof T !== 'undefined' && T[lang]) || {});
  document.documentElement.lang = lang;
  chrome(t);
  document.querySelectorAll('[data-t]').forEach((el) => {
    const v = t[el.dataset.t];
    if (v == null) return;
    if (/<\/?[a-z]/i.test(v)) el.innerHTML = v; else el.textContent = v;
  });
  // Sections that are lists rather than single strings: [data-list="key"].
  document.querySelectorAll('[data-list]').forEach((el) => {
    const rows = t[el.dataset.list];
    if (!Array.isArray(rows)) return;
    el.innerHTML = rows.map((r) => (Array.isArray(r)
      ? `<li><strong>${r[0]}</strong> ${r[1]}</li>` : `<li>${r}</li>`)).join('');
  });
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
  if (document.title && t.title) document.title = t.title;
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
