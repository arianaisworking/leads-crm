// contact.js — how to reach us, in one place.
//
// Every page reads this: the home page's header call link, the "rather just
// talk to someone?" band, the sticky bar on a phone, and the footer on the
// shared pages. One file so the number can never differ between two pages,
// which is the kind of thing nobody notices until a driver calls a dead line.
//
// phone    — E.164, what tel: dials.
// display  — how it's written on the page.
// whatsapp — digits only, no +. Leave empty unless the number is actually on
//            WhatsApp: wa.me for a number that isn't opens an error page,
//            which is worse than not offering it.
window.CONTACT = {
  phone: '+12149406359',
  display: '(214) 940-6359',
  whatsapp: '',
};
