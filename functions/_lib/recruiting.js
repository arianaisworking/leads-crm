// functions/_lib/recruiting.js
// Shared driver-recruiting workflow pieces used by both the team API
// (/api/dr) and the public driver-facing API (/api/apply).

import { open as vaultOpen } from './vault.js';
import { esc } from './email.js';

export const rid = (p) => p + '_' + [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('');
export function secret() {
  return [...crypto.getRandomValues(new Uint8Array(18))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Build (or top up) a driver's document checklist from their carrier's template.
// Conditional items — the title and 2290 the plate program needs — only appear
// for drivers who actually elected that program.
export async function seedDocs(db, driver, carrier) {
  let list = [];
  try { list = carrier && carrier.doc_checklist ? JSON.parse(carrier.doc_checklist) : []; } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return 0;
  const existing = await db.prepare('SELECT kind FROM driver_docs WHERE driver_id=?').bind(driver.id).all();
  const have = new Set((existing.results || []).map((r) => r.kind));
  let n = 0;
  for (const item of list) {
    // `if` — only when the driver opted in (e.g. the carrier's plate program).
    if (item.if && !driver[item.if]) continue;
    // `if_no` — only when they explicitly answered no. An unanswered question
    // must not conjure a document demand out of nothing.
    if (item.if_no && driver[item.if_no] !== 0) continue;
    if (have.has(item.kind)) continue;
    await db.prepare('INSERT INTO driver_docs (id, driver_id, kind, label, status) VALUES (?,?,?,?,?)')
      .bind(rid('dd'), driver.id, item.kind, item.label || item.kind, 'needed').run();
    n++;
  }
  return n;
}

// Open the placement for a driver+carrier and write the revenue split rows.
// The split is snapshotted here so raising the fee later never rewrites what
// was already earned.
export async function ensurePlacement(db, driver, carrier, trigger, override = {}) {
  const existing = await db.prepare('SELECT id FROM placements WHERE driver_id=? AND carrier_id=?').bind(driver.id, carrier.id).first();
  if (existing) return existing.id;
  const pid = rid('pl');
  const feeType = override.fee_type || carrier.fee_type || 'flat';
  const fee = override.fee_amount != null ? Number(override.fee_amount)
    : (carrier.fee_amount != null ? Number(carrier.fee_amount) : null);
  await db.prepare(`INSERT INTO placements (id, driver_id, carrier_id, fee_type, fee_amount, status, trigger_met, seated_at, notes)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(
    pid, driver.id, carrier.id, feeType, fee, override.status || 'pending', trigger,
    override.seated_at || null, override.notes || null).run();
  await writeSplits(db, pid, fee);
  return pid;
}

// Split the fee across the active recruiters by their shares. With Ariana and
// Mystica at 50/50 and a $1,000 fee that's $500 each.
export async function writeSplits(db, placementId, fee) {
  const { results } = await db.prepare('SELECT * FROM recruiters WHERE active=1 ORDER BY name').all();
  const people = results || [];
  if (!people.length) return 0;
  const total = people.reduce((a, r) => a + (Number(r.share_pct) || 0), 0) || 100;
  for (const r of people) {
    const pct = Number(r.share_pct) || 0;
    const amt = fee != null ? Math.round((fee * (pct / total)) * 100) / 100 : null;
    await db.prepare('INSERT INTO placement_splits (id, placement_id, recruiter_id, share_pct, amount) VALUES (?,?,?,?,?)')
      .bind(rid('ps'), placementId, r.id, pct, amt).run();
  }
  return people.length;
}

// ---- The completed Lease Info form, rendered for the carrier.
// Mirrors the carrier's own paper form field-for-field so their office can read
// it without translating anything. `secureObj` is the decrypted vault payload
// and is ONLY ever passed in when building the packet the carrier receives.
export function leasePacketHtml(d, leaseRow, secureObj, carrier) {
  const S = secureObj || {};
  const X = leaseRow || {};
  let L = {};
  try { L = X.lease_info ? JSON.parse(X.lease_info) : {}; } catch { L = {}; }
  const row = (k, v) => (v || v === 0)
    ? `<tr><td style="padding:5px 14px 5px 0;color:#5b6472;white-space:nowrap;font-size:13px">${esc(k)}</td><td style="padding:5px 0;font-weight:600;font-size:13px">${esc(v)}</td></tr>` : '';
  const yn = (v) => (v === 1 || v === true ? 'Yes' : v === 0 || v === false ? 'No' : '');
  const sec = (title, body) => body.replace(/\s/g, '') ? `<div style="margin:0 0 18px">
      <div style="font-weight:800;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#2f6fed;border-bottom:1px solid #e3e8ef;padding-bottom:5px;margin-bottom:8px">${esc(title)}</div>
      <table style="width:100%">${body}</table></div>` : '';

  return `
    <div style="border:1px solid #e3e8ef;border-radius:12px;padding:18px 20px;background:#fff">
      <div style="font-weight:800;font-size:15px;margin-bottom:2px">Lease Information</div>
      <div style="color:#5b6472;font-size:12.5px;margin-bottom:16px">${esc(carrier ? carrier.name : '')}${carrier && carrier.terminal ? ' · ' + esc(carrier.terminal) : ''}${d.lease_info_at ? ' · completed ' + esc(String(d.lease_info_at).slice(0, 10)) : ''}</div>

      ${sec('Driver / Owner', `
        ${row('Name', d.name)}${row('Gender', X.gender)}
        ${row('Address', d.address)}
        ${row('City / State / Zip', [d.city, d.state, X.postcode || L.postcode].filter(Boolean).join(', '))}
        ${row('Cell', d.phone)}${row('Home', X.home_phone)}
        ${row('Email', d.email)}
        ${row('SSN', S.ssn)}
        ${row("Driver's licence", S.dl_number ? `${S.dl_number}${d.cdl_state ? ' (' + d.cdl_state + ')' : ''}${d.cdl_expires ? ' exp ' + d.cdl_expires : ''}` : '')}
        ${row('Date of birth', d.dob)}
        ${row('U.S. citizen', yn(d.us_citizen))}
        ${row('Authorised to work in the U.S.', yn(d.work_authorized))}`)}

      ${sec('Truck', `
        ${row('Year / Make / Color', [d.truck_year, d.truck_make, d.truck_color].filter(Boolean).join(' '))}
        ${row('Plate / State', [d.truck_plate, d.truck_plate_state].filter(Boolean).join(' · '))}
        ${row('VIN', d.truck_vin)}${row('Unit #', X.truck_unit_no)}
        ${row('Lienholder', d.lienholder)}${row('Value', X.truck_value != null ? '$' + Number(X.truck_value).toLocaleString('en-US') : '')}
        ${row('Lienholder address', X.lienholder_address)}
        ${row('Lienholder phone', X.lienholder_phone)}${row('Lienholder email', X.lienholder_email)}`)}

      ${sec('Programs', `
        ${row('Carrier plates', yn(d.wants_carrier_plates))}
        ${row('IFTA', yn(d.wants_ifta))}
        ${row('Maintenance escrow', X.wants_maintenance ? `Yes${X.maintenance_weekly ? ' · $' + X.maintenance_weekly + '/week' : ''}${X.maintenance_max ? ' · max $' + X.maintenance_max : ''}` : yn(X.wants_maintenance))}`)}

      ${sec('Direct deposit', `
        ${row('Bank', S.bank_name)}${row('Account name', S.account_name)}
        ${row('Routing #', S.routing)}${row('Account #', S.account)}`)}

      ${d.has_business ? sec('Business (lease in the company name)', `
        ${row('Business name', d.business_name)}${row('Fed ID #', X.business_ein || S.ein)}
        ${row('Business owner', X.business_owner)}
        ${row('Address', X.business_address)}
        ${row('Phone', X.business_phone)}${row('Email', X.business_email)}`) : ''}
    </div>`;
}

// The driver's lease row, or null if they haven't returned the form yet.
export async function leaseRow(db, driverId) {
  return await db.prepare('SELECT * FROM driver_lease WHERE driver_id=?').bind(driverId).first();
}

// Decrypt the sealed fields for exactly one purpose: building the carrier packet.
export async function openSecure(env, leaseRowOrNull) {
  return await vaultOpen(env, leaseRowOrNull && leaseRowOrNull.lease_secure);
}

// ---- The carrier's own application (e.g. Evans' Tenstreet IntelliApp).
//
// The stored apply_url carries the carrier's parameters, including the one that
// pins the terminal (Tenstreet: cq_<id>=DAL). Those are left exactly as the
// carrier gave them — routing a driver to the wrong terminal's queue is a real
// cost. The ONLY thing rewritten is the source-attribution value, and only when
// the recruiter has been issued a tag of their own.
export function carrierApplyUrl(carrier, recruiter) {
  if (!carrier || !carrier.apply_url) return null;
  const tag = recruiter && recruiter.source_tag;
  if (!tag) return carrier.apply_url;
  try {
    const u = new URL(carrier.apply_url);
    u.searchParams.set(carrier.apply_source_param || 'uri_b', tag);
    return u.toString();
  } catch {
    return carrier.apply_url;      // malformed URL: hand it over untouched
  }
}

// Look up the recruiter who owns a driver, for attribution.
export async function recruiterFor(db, driver) {
  if (!driver || !driver.recruiter_id) return null;
  return await db.prepare('SELECT * FROM recruiters WHERE id=?').bind(driver.recruiter_id).first();
}
