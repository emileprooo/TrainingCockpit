// PRO Training-cockpit — data-API (Supabase Edge Function)
// proj-2026-003. Aggregeert Whoop-recovery + intervals.icu CTL/ATL/Form +
// geplande workouts tot één JSON voor de gehoste index.html (Coolify).
// Service-role server-side (auto-injected env), nooit in de client.
// Deploy met verify_jwt = false (publieke read-only data achter obscure URL).
//
// v2026.3 — Beschikbaarheid (availability).
//   * GET ?data=1   : availability-rijen today..today+30 toegevoegd aan JSON.
//   * POST ?save=1  : upsert beschikbaarheid {changes:[{date,minutes}]}.
//                     minutes = null (niet ingevuld) of 0..300 (stap 15).
//                     needs_replan => true voor near-term dagen (today..today+9).
//   * POST ?confirm=1 : clear needs_replan voor near-term (na n8n-replan).
//
// v2026.2 — Hardening tegen intermittente 401's vanuit PostgREST:
//   * q() retryt op transiente fouten (401/429/5xx) met backoff.
//   * Mislukte query => expliciete fout in `errors[]`, NOOIT stil als lege data.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TZ = "Europe/Brussels";

const AVAIL_HORIZON_DAYS = 30;   // tot een maand op voorhand
const NEAR_TERM_DAYS = 9;        // today..today+9 => 10 dagen => triggert replan

const sbHeaders = {
  "apikey": SVC,
  "Authorization": `Bearer ${SVC}`,
  "Content-Type": "application/json",
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function localDate(d: Date): string {
  // YYYY-MM-DD in Europe/Brussels, ongeacht server-UTC.
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

type QResult = { ok: boolean; status: number; data: any[] };

// Robuuste query: retryt op transiente fouten (401/429/5xx). De service-role-key
// wordt door de gateway soms sporadisch geweigerd (key/JWT-rotatie); een korte
// retry vangt dat op. Geeft {ok:false} terug i.p.v. de fout te verbergen als [].
async function q(path: string, tries = 4): Promise<QResult> {
  let status = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders });
      status = r.status;
      if (r.ok) {
        const data = await r.json().catch(() => []);
        return { ok: true, status, data: Array.isArray(data) ? data : [] };
      }
      if (status === 401 || status === 408 || status === 429 || status >= 500) {
        await sleep(180 * (i + 1));
        continue;
      }
      break;
    } catch (_e) {
      status = 0;
      await sleep(180 * (i + 1));
    }
  }
  return { ok: false, status, data: [] };
}

async function buildData() {
  const today = localDate(new Date());
  const from360 = addDays(today, -360);
  const upcomingTo = addDays(today, 21);
  const availTo = addDays(today, AVAIL_HORIZON_DAYS);

  const [whoop, wellnessLatest, ctlSeries, todayW, upcomingW, avail] = await Promise.all([
    q(`whoop_daily?select=date,recovery_score,sleep_score,strain_score,hrv,rhr&order=date.desc&limit=1`),
    q(`intervals_wellness?select=date,ctl,atl,form,ramp_rate&order=date.desc&limit=1`),
    q(`intervals_wellness?select=date,ctl,atl,form&date=gte.${from360}&order=date.asc`),
    q(`planned_workout?select=external_id,date,start_date_local,name,type,description,planned_load,planned_duration_sec,workout_doc&date=eq.${today}&order=start_date_local.asc`),
    q(`planned_workout?select=date,start_date_local,name,type,planned_load,planned_duration_sec&date=gt.${today}&date=lte.${upcomingTo}&order=date.asc,start_date_local.asc`),
    q(`availability?select=date,minutes,needs_replan&date=gte.${today}&date=lte.${availTo}&order=date.asc`),
  ]);

  const errors: { source: string; status: number }[] = [];
  const take = (res: QResult, source: string): any[] => {
    if (!res.ok) errors.push({ source, status: res.status });
    return res.data;
  };

  const whoopRows = take(whoop, "whoop_daily");
  const wellnessRows = take(wellnessLatest, "intervals_wellness_latest");
  const ctlRows = take(ctlSeries, "intervals_wellness_series");
  const todayRows = take(todayW, "planned_workout_today");
  const upcomingRows = take(upcomingW, "planned_workout_upcoming");
  const availRows = take(avail, "availability");

  const w = whoopRows[0] || null;
  const wl = wellnessRows[0] || null;

  return {
    generated_at: new Date().toISOString(),
    today,
    ok: errors.length === 0,
    errors,
    metrics: {
      recovery: w ? w.recovery_score : null,
      sleep_score: w ? w.sleep_score : null,
      hrv: w ? w.hrv : null,
      rhr: w ? w.rhr : null,
      whoop_date: w ? w.date : null,
      ctl: wl ? wl.ctl : null,
      atl: wl ? wl.atl : null,
      form: wl ? wl.form : null,
      ramp_rate: wl ? wl.ramp_rate : null,
      wellness_date: wl ? wl.date : null,
    },
    ctl_series: ctlRows,
    today_workouts: todayRows,
    today_error: !todayW.ok,
    upcoming_workouts: upcomingRows,
    availability: availRows,            // [{date, minutes, needs_replan}]
    availability_horizon_days: AVAIL_HORIZON_DAYS,
    availability_error: !avail.ok,
    near_term_days: NEAR_TERM_DAYS,
  };
}

// ---------- writes ----------
function validMinutes(v: any): boolean {
  return v === null || (typeof v === "number" && v >= 0 && v <= 300 && v % 15 === 0);
}

async function saveAvailability(body: any) {
  const today = localDate(new Date());
  const nearTo = addDays(today, NEAR_TERM_DAYS);
  const horizonTo = addDays(today, AVAIL_HORIZON_DAYS);
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  const rows: any[] = [];
  for (const c of changes) {
    const date = String(c?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < today || date > horizonTo) continue;             // nooit verleden, max 1 maand
    const minutes = c?.minutes === null || c?.minutes === undefined ? null : Number(c.minutes);
    if (!validMinutes(minutes)) continue;
    const nearTerm = date >= today && date <= nearTo;
    rows.push({
      date,
      minutes,
      needs_replan: nearTerm,           // near-term wijziging => replan nodig
      updated_at: new Date().toISOString(),
    });
  }
  if (!rows.length) return { ok: false, saved: 0, reason: "no valid changes" };

  const r = await fetch(`${SB_URL}/rest/v1/availability?on_conflict=date`, {
    method: "POST",
    headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
  const data = await r.json().catch(() => []);
  return { ok: r.ok, status: r.status, saved: r.ok ? rows.length : 0, rows: data };
}

async function confirmReplan() {
  const today = localDate(new Date());
  const nearTo = addDays(today, NEAR_TERM_DAYS);
  const r = await fetch(
    `${SB_URL}/rest/v1/availability?needs_replan=eq.true&date=gte.${today}&date=lte.${nearTo}`,
    {
      method: "PATCH",
      headers: { ...sbHeaders, "Prefer": "return=representation" },
      body: JSON.stringify({ needs_replan: false }),
    },
  );
  const data = await r.json().catch(() => []);
  return { ok: r.ok, status: r.status, cleared: Array.isArray(data) ? data.length : 0 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    let result: any;
    if (url.searchParams.has("confirm")) result = await confirmReplan();
    else if (url.searchParams.has("save")) result = await saveAvailability(body);
    else result = { ok: false, reason: "unknown action; gebruik ?save=1 of ?confirm=1" };
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (url.searchParams.has("data")) {
    const data = await buildData();
    return new Response(JSON.stringify(data), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  return new Response(
    "PRO Training-cockpit data-API. GET ?data=1 voor JSON. POST ?save=1 / ?confirm=1 voor beschikbaarheid.",
    { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } },
  );
});
