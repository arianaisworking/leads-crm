// functions/_lib/calendar.js
// Real availability from the CLIENT's own Google Calendar, then write the
// appointment back to it. The model never invents a time - it picks from these.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL = 'https://www.googleapis.com/calendar/v3';

async function accessToken(env, client) {
  if (!client.google_refresh_token) throw new Error('client has no google_refresh_token');
  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: client.google_refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error_description || 'google token refresh failed');
  return data.access_token;
}

// Returns e.g. [{ id:'s1', startISO, endISO, label:'Thursday at 2:00 PM' }, ...]
export async function openSlots(env, client, opts = {}) {
  const tz = client.timezone || 'America/Chicago';
  const durationMin = client.appointment_minutes || 30;
  const days = Math.min(client.booking_window_days || 14, 30);
  const max = opts.max || 3;

  const now = new Date();
  const timeMin = new Date(now.getTime() + 2 * 60 * 60 * 1000); // never offer < 2h out
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const token = await accessToken(env, client);
  const res = await fetch(`${CAL}/freeBusy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: tz,
      items: [{ id: client.calendar_id }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'freebusy failed');

  const busy = (data.calendars?.[client.calendar_id]?.busy || []).map((b) => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  }));

  const brain = safeParse(client.business_brain) || {};
  const openHour = brain.booking_hours?.start ?? 9;
  const closeHour = brain.booking_hours?.end ?? 17;
  const openDays = brain.booking_days ?? [1, 2, 3, 4, 5]; // Mon-Fri

  const slots = [];
  const stepMs = durationMin * 60 * 1000;
  let cursor = ceilTo(timeMin.getTime(), stepMs);

  while (cursor < timeMax.getTime() && slots.length < max) {
    const parts = tzParts(cursor, tz);
    const fits =
      openDays.includes(parts.weekdayIndex) &&
      parts.hour >= openHour &&
      parts.hour < closeHour;

    const clashes = busy.some((b) => cursor < b.end && cursor + stepMs > b.start);

    if (fits && !clashes) {
      slots.push({
        id: 's' + (slots.length + 1),
        startISO: new Date(cursor).toISOString(),
        endISO: new Date(cursor + stepMs).toISOString(),
        label: humanLabel(cursor, tz),
      });
      cursor += 4 * 60 * 60 * 1000; // spread offers out across the week
    } else {
      cursor += stepMs;
    }
  }
  return slots;
}

export async function bookSlot(env, client, slot, lead) {
  const token = await accessToken(env, client);
  const attendees = [];
  if (client.notify_email) attendees.push({ email: client.notify_email });

  const body = {
    summary: `${lead.name || 'New appointment'} - ${lead.service || 'consultation'}`,
    description: [
      `Booked by Cold Case Revival (reactivated lead)`,
      `Name: ${lead.name || 'unknown'}`,
      `Phone: ${lead.phone}`,
      `Service: ${lead.service || 'not specified'}`,
      `Original lead date: ${lead.original_date || 'unknown'}`,
      ``,
      `Context: ${lead.context_note || ''}`,
    ].join('\n'),
    start: { dateTime: slot.startISO, timeZone: client.timezone },
    end: { dateTime: slot.endISO, timeZone: client.timezone },
    attendees,
    reminders: { useDefault: true },
  };

  const res = await fetch(
    `${CAL}/calendars/${encodeURIComponent(client.calendar_id)}/events?sendUpdates=all`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'calendar insert failed');
  return { eventId: data.id, htmlLink: data.htmlLink };
}

// --- small helpers --------------------------------------------------------

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function ceilTo(ms, step) { return Math.ceil(ms / step) * step; }

function tzParts(ms, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekdayIndex: idx[parts.weekday] ?? 1, hour: parseInt(parts.hour, 10) };
}

function humanLabel(ms, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}
