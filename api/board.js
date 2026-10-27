const MADRID = "Europe/Madrid";
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function madridParts(date) {
  const bag = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: MADRID,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date)) {
    bag[part.type] = part.value;
  }
  return bag;
}

function madridStamp(date) {
  const bag = madridParts(date);
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    minutes: Number(bag.hour) * 60 + Number(bag.minute),
    hour: bag.hour,
    minute: bag.minute
  };
}

function weekdayIndex(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const name = new Intl.DateTimeFormat("en-US", { timeZone: MADRID, weekday: "short" }).format(noon);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return next.toISOString().slice(0, 10);
}

function fmtDay(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

function niceName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (name && name === name.toUpperCase()) {
    return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (match, sep, letter) => sep + letter.toUpperCase());
  }
  return name;
}

async function holded(apiKey, path) {
  const response = await fetch("https://api.holded.com" + path, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`Holded respondió ${response.status}`);
  }
  return response.json();
}

async function paginate(apiKey, path, extra = {}, maxPages = 30) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ ...extra, limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const data = await holded(apiKey, `${path}?${params.toString()}`);
    items.push(...(data.items || []));
    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }
  return items;
}

function absenceSpan(record) {
  if (!record.start_date) return null;
  const start = String(record.start_date).slice(0, 10);
  if (record.end_date) {
    const end = String(record.end_date).slice(0, 10);
    return end < start ? null : { start, end };
  }
  const days = Number(record.days);
  if (!Number.isFinite(days) || days <= 0) return null;
  const length = Math.max(1, Math.ceil(days));
  return { start, end: addDays(start, length - 1) };
}

function aggregate(entries) {
  if (!entries.length) return null;
  const ordered = entries.slice().sort((a, b) => a.start - b.start);
  const inn = madridStamp(ordered[0].start);
  const clockIn = `${String(inn.hour).padStart(2, "0")}:${String(inn.minute).padStart(2, "0")}`;
  if (ordered.some((entry) => entry.running)) return { inn: clockIn, out: null };
  const ends = ordered.filter((entry) => entry.end);
  if (!ends.length) return { inn: clockIn, out: null };
  const last = ends.reduce((max, entry) => (entry.end > max.end ? entry : max));
  const out = madridStamp(last.end);
  return { inn: clockIn, out: `${String(out.hour).padStart(2, "0")}:${String(out.minute).padStart(2, "0")}` };
}

export async function buildBoard(apiKey) {
  const now = new Date();
  const today = madridStamp(now);
  const todayDate = today.date;
  const historyStart = addDays(todayDate, -30);
  const historyEnd = addDays(todayDate, -1);

  const employees = await paginate(apiKey, "/api/v2/employees");
  const active = employees
    .filter((employee) => !employee.terminated && (employee.full_name || employee.name))
    .map((employee) => ({
      id: employee.id,
      name: niceName(employee.full_name || `${employee.name || ""} ${employee.last_name || ""}`)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const activeIds = new Set(active.map((person) => person.id));

  const offs = await paginate(apiKey, "/api/v2/employees/time-offs", {
    start_date_from: `${addDays(todayDate, -45)}T00:00:00Z`,
    start_date_to: `${addDays(todayDate, 200)}T00:00:00Z`
  });

  const absences = [];
  const coverRanges = new Map(active.map((person) => [person.id, []]));
  for (const record of offs) {
    if (!activeIds.has(record.employee_id)) continue;
    if (record.status === "cancelled" || record.time_off_type_name === "[no usar]") continue;
    const span = absenceSpan(record);
    if (!span) continue;
    if (span.end < addDays(todayDate, -40) || span.start > addDays(todayDate, 200)) continue;
    const days = Number(record.days);
    let type = record.time_off_type_name || "Ausencia";
    if (days > 0 && days < 1) type += " · media jornada";
    let covers = record.status === "accepted" && record.time_off_type_name !== "Falta injustificada";
    let status = record.status === "accepted" ? "Aprobada" : record.status === "pending" ? "Pendiente" : record.status;
    if (record.time_off_type_name === "Falta injustificada") {
      covers = false;
      status = "Registrada";
    }
    if (record.status === "pending") covers = false;
    absences.push({
      person: record.employee_id,
      type,
      from: span.start,
      to: span.end,
      status,
      covers
    });
    if (covers) coverRanges.get(record.employee_id).push(span);
  }

  const times = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const data = await holded(apiKey, `/api/v2/employee-times?${params.toString()}`);
    const batch = data.items || [];
    times.push(...batch);
    const oldest = batch.length ? madridStamp(new Date(batch[batch.length - 1].start_at || batch[batch.length - 1].date)).date : todayDate;
    if (!batch.length || !data.has_more || oldest < addDays(todayDate, -45)) break;
    cursor = data.cursor;
  }

  const byPersonDay = new Map();
  for (const record of times) {
    if (!activeIds.has(record.employee_id) || !record.start_at) continue;
    const start = new Date(record.start_at);
    const end = record.end_at ? new Date(record.end_at) : null;
    const day = madridStamp(start).date;
    const key = `${record.employee_id}|${day}`;
    if (!byPersonDay.has(key)) byPersonDay.set(key, []);
    byPersonDay.get(key).push({
      start,
      end,
      running: record.status === "running" || !end
    });
  }

  const morningCut = 9 * 60 + 15;
  const snaps = { "09:15": {}, ahora: {} };
  for (const person of active) {
    const todayEntries = byPersonDay.get(`${person.id}|${todayDate}`) || [];
    const morning = todayEntries.filter((entry) => madridStamp(entry.start).minutes <= morningCut);
    const atMorning = aggregate(morning);
    const atNow = aggregate(todayEntries);
    if (atMorning) snaps["09:15"][person.id] = atMorning;
    if (atNow) snaps.ahora[person.id] = atNow;
  }

  function covered(personId, day) {
    return (coverRanges.get(personId) || []).some((span) => span.start <= day && day <= span.end);
  }

  const history = {};
  const weekCounts = new Map();
  for (let day = historyStart; day <= historyEnd; day = addDays(day, 1)) {
    const weekday = weekdayIndex(day);
    if (weekday === 0 || weekday === 6) continue;
    const monday = addDays(day, -(weekday === 0 ? 6 : weekday - 1));
    if (!weekCounts.has(monday)) weekCounts.set(monday, 0);
    for (const person of active) {
      const hasClock = byPersonDay.has(`${person.id}|${day}`);
      if (hasClock || covered(person.id, day)) continue;
      const current = history[person.id] || { n: 0, last: day };
      current.n += 1;
      if (day > current.last) current.last = day;
      history[person.id] = current;
      weekCounts.set(monday, weekCounts.get(monday) + 1);
    }
  }

  const weeks = [...weekCounts.keys()].sort().map((monday) => ({
    label: fmtDay(monday),
    value: weekCounts.get(monday)
  }));
  const hora = `${String(today.hour).padStart(2, "0")}:${String(today.minute).padStart(2, "0")}`;
  const weekdayName = WEEKDAYS[weekdayIndex(todayDate)];

  return {
    today: todayDate,
    meta: {
      product: "Holded",
      eyebrow: `Salesdose · Control horario · ${weekdayName} ${fmtDay(todayDate)} ${todayDate.slice(0, 4)} · hora de Madrid · tu cuenta`,
      eyebrowHist: `Histórico · ${fmtDay(historyStart)} – ${fmtDay(historyEnd)} ${historyEnd.slice(0, 4)} · días laborables`,
      caption: `Solo personal en alta. Leído de Holded el ${fmtDay(todayDate)} a las ${hora} (Madrid). La lectura de las 9:15 se reconstruye con la hora de entrada. La segunda lectura es la de este momento.`,
      footer: `Lectura de Holded, ${fmtDay(todayDate)} a las ${hora}, hora de Madrid. La clave de la API se queda en el servidor.`,
      histCaption: `Días laborables del ${fmtDay(historyStart)} al ${fmtDay(historyEnd)}, descontando vacaciones y bajas aceptadas. Fuente: Holded.`,
      historyFrom: historyStart,
      historyTo: historyEnd,
      historyEndLabel: fmtDay(historyEnd)
    },
    readings: [
      { id: "09:15", button: "Lectura 9:15", hora: "9:15" },
      { id: "ahora", button: `Ahora · ${hora}`, hora }
    ],
    people: active.map((person) => ({ id: person.id, name: person.name, team: "" })),
    absences,
    history,
    snaps,
    weeks
  };
}

export default async function handler(req, res) {
  const apiKey = process.env.HOLDED_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Falta HOLDED_API_KEY en el servidor." });
    return;
  }
  try {
    const board = await buildBoard(apiKey);
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
    res.status(200).json(board);
  } catch (error) {
    res.status(502).json({ error: error.message || "No se ha podido leer Holded." });
  }
}
