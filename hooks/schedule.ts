// Чиста логіка svitlo: розбір графіків, київський час, фази попереджень.
// Без `$`, тому тестується напряму.

export const NEW_API = 'https://dtek-api.svitlo-proxy.workers.dev/'
export const OLD_API = 'https://svitlo-proxy.svitlo-proxy.workers.dev'

const MIN = 60_000
const SLOT = 30 * MIN

// Старий фід пише частину областей іншою транслітерацією.
const OLD_TO_NEW: Record<string, string> = {
  'harkivska-oblast': 'kharkivska-oblast',
  'hmelnitska-oblast': 'khmelnytska-oblast',
  'chernigivska-oblast': 'chernihivska-oblast',
  'jitomirska-oblast': 'zhytomyrska-oblast',
}

export type Slots = Record<string, number>
export type FeedRegion = {
  cpu: string
  name_ua?: string
  emergency?: boolean
  schedule?: Record<string, Record<string, Slots>> | null
}
export type Feed = { date_today?: string; date_tomorrow?: string; regions?: FeedRegion[] }

export type Interval = { start: number; end: number }
export type Plan = {
  region: string
  regionName: string
  queue: string
  emergency: boolean
  outages: Interval[]
  // Кінець останньої опублікованої доби (UTC ms) або null, якщо графіка немає.
  knownUntil: number | null
  days: string[]
}

export type Thresholds = { lead: number; final: number; hard: number; grace: number }
export const DEFAULT_THRESHOLDS: Thresholds = { lead: 20, final: 5, hard: 2, grace: 5 }

export type Phase = 'unknown' | 'none' | 'ahead' | 'warn' | 'final' | 'hard' | 'outage'
export type Status = {
  phase: Phase
  // Найближче відключення (поточне для 'outage' і 'hard' після початку).
  outage?: Interval
  minutesLeft?: number
}

export function normalizeSlug(slug: string): string {
  return OLD_TO_NEW[slug] ?? slug
}

export function parseFeed(text: string): Feed {
  const raw = JSON.parse(text) as Feed & { body?: unknown }
  if (typeof raw.body === 'string') return JSON.parse(raw.body) as Feed
  return raw
}

// "черга 3.1", "3,1", "GPV3.1" → "3.1"; "3" лишається "3".
export function normalizeQueue(input: string): string | null {
  const m = /(\d+)(?:\s*[.,\-\s]\s*(\d+))?/.exec(String(input))
  if (!m?.[1]) return null
  return m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`
}

// ---------- київський час ----------

function lastSundayUtc(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0))
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1)
}

function euRuleOffset(utcMs: number): number {
  const year = new Date(utcMs).getUTCFullYear()
  return utcMs >= lastSundayUtc(year, 2) && utcMs < lastSundayUtc(year, 9) ? 180 : 120
}

let kyivFormat: Intl.DateTimeFormat | null | undefined

function getKyivFormat(): Intl.DateTimeFormat | null {
  if (kyivFormat !== undefined) return kyivFormat
  kyivFormat = null
  for (const timeZone of ['Europe/Kyiv', 'Europe/Kiev']) {
    try {
      kyivFormat = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      break
    } catch {
      // наступна назва зони або правило ЄС нижче
    }
  }
  return kyivFormat
}

// Зсув київського часу від UTC у хвилинах (120 або 180).
export function kyivOffsetMin(utcMs: number): number {
  const format = getKyivFormat()
  if (!format) return euRuleOffset(utcMs)
  try {
    const parts: Record<string, string> = {}
    for (const part of format.formatToParts(new Date(utcMs))) parts[part.type] = part.value
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute))
    return Math.round((asUtc - Math.floor(utcMs / MIN) * MIN) / MIN)
  } catch {
    return euRuleOffset(utcMs)
  }
}

// "2026-10-08" + "14:30" за Києвом → UTC ms.
export function kyivToUtc(date: string, hhmm: string): number {
  const [y = 1970, mo = 1, d = 1] = date.split('-').map(Number)
  const [h = 0, mi = 0] = hhmm.split(':').map(Number)
  const naive = Date.UTC(y, mo - 1, d, h, mi)
  const first = naive - kyivOffsetMin(naive - 2 * 60 * MIN) * MIN
  const second = naive - kyivOffsetMin(first) * MIN
  return second
}

export function kyivParts(utcMs: number): { date: string; time: string } {
  const shifted = new Date(utcMs + kyivOffsetMin(utcMs) * MIN)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  }
}

// ---------- графік → інтервали ----------

const SLOT_LABELS: string[] = []
for (let h = 0; h < 24; h++) for (const m of [0, 30]) SLOT_LABELS.push(`${String(h).padStart(2, '0')}:${m === 0 ? '00' : '30'}`)

export function findRegion(feed: Feed | undefined, region: string): FeedRegion | undefined {
  const wanted = normalizeSlug(region)
  return feed?.regions?.find(r => normalizeSlug(r.cpu) === wanted)
}

// Повертає план для черги або null, якщо регіону/черги у фіді немає.
export function planFrom(feed: Feed | undefined, region: string, queue: string): Plan | null {
  const found = findRegion(feed, region)
  if (!found) return null
  const byDay = found.schedule?.[queue]
  const base: Plan = {
    region: normalizeSlug(found.cpu),
    regionName: found.name_ua ?? found.cpu,
    queue,
    emergency: found.emergency === true,
    outages: [],
    knownUntil: null,
    days: [],
  }
  if (!byDay) return found.schedule ? null : base

  // Беремо лише «сьогодні» і «завтра» фіда: старі дні (застряглий парсер) — не графік.
  const wantedDays = [feed?.date_today, feed?.date_tomorrow].filter((d): d is string => !!d)
  const candidates = wantedDays.length ? wantedDays : Object.keys(byDay).sort()
  const days = candidates.filter(day => {
    const slots = byDay[day]
    return slots !== undefined && SLOT_LABELS.some(label => Number(slots[label] ?? 0) !== 0)
  })

  const outages: Interval[] = []
  for (const day of days) {
    for (const label of SLOT_LABELS) {
      if (Number(byDay[day]?.[label] ?? 0) !== 2) continue
      const start = kyivToUtc(day, label)
      const last = outages[outages.length - 1]
      if (last && last.end === start) last.end = start + SLOT
      else outages.push({ start, end: start + SLOT })
    }
  }

  const lastDay = days[days.length - 1]
  return {
    ...base,
    outages,
    knownUntil: lastDay ? kyivToUtc(lastDay, '23:30') + SLOT : null,
    days,
  }
}

function hasToday(plan: Plan | null, feed: Feed | undefined): boolean {
  if (!plan || plan.days.length === 0) return false
  return feed?.date_today ? plan.days.includes(feed.date_today) : true
}

// Новий фід пріоритетний; старий — запасний, коли в новому немає актуального дня.
export function choosePlan(fresh: { plan: Plan | null; feed?: Feed }, fallback?: { plan: Plan | null; feed?: Feed }): Plan | null {
  const emergency = !!fresh.plan?.emergency || !!fallback?.plan?.emergency
  const pick =
    hasToday(fresh.plan, fresh.feed) ? fresh.plan
    : hasToday(fallback?.plan ?? null, fallback?.feed) ? fallback!.plan
    : fresh.plan ?? fallback?.plan ?? null
  return pick ? { ...pick, emergency } : null
}

export type CatalogEntry = { id: string; name: string; queues: string[] }

export function catalog(newFeed?: Feed, oldFeed?: Feed): CatalogEntry[] {
  const merged = new Map<string, CatalogEntry>()
  for (const feed of [newFeed, oldFeed]) {
    for (const r of feed?.regions ?? []) {
      const id = normalizeSlug(r.cpu)
      if (!r.schedule || merged.has(id)) continue
      const queues = Object.keys(r.schedule)
      if (queues.length === 0) continue
      merged.set(id, { id, name: r.name_ua ?? id, queues })
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'uk'))
}

export function resolveRegion(entries: CatalogEntry[], input: string): CatalogEntry | undefined {
  const wanted = input.trim().toLowerCase()
  const slug = normalizeSlug(wanted)
  return (
    entries.find(e => e.id === slug) ??
    entries.find(e => e.name.toLowerCase() === wanted) ??
    entries.find(e => e.name.toLowerCase().startsWith(wanted))
  )
}

// ---------- фази ----------

export function statusAt(plan: Plan | null, now: number, t: Thresholds = DEFAULT_THRESHOLDS): Status {
  if (!plan || plan.knownUntil === null) return { phase: 'unknown' }
  const current = plan.outages.find(o => o.start <= now && now < o.end)
  if (current) {
    return { phase: now < current.start + t.grace * MIN ? 'hard' : 'outage', outage: current, minutesLeft: 0 }
  }
  const next = plan.outages.find(o => o.start > now)
  if (!next) return { phase: now >= plan.knownUntil ? 'unknown' : 'none' }
  const minutesLeft = Math.ceil((next.start - now) / MIN)
  const phase: Phase =
    minutesLeft <= t.hard ? 'hard'
    : minutesLeft <= t.final ? 'final'
    : minutesLeft <= t.lead ? 'warn'
    : 'ahead'
  return { phase, outage: next, minutesLeft }
}

// Додає симульоване відключення (для /svitlo test) поверх реального плану.
export function withSimulated(plan: Plan | null, simulated: Interval | null): Plan | null {
  if (!simulated) return plan
  const base: Plan = plan ?? {
    region: 'test',
    regionName: 'симуляція',
    queue: '—',
    emergency: false,
    outages: [],
    knownUntil: null,
    days: [],
  }
  const outages = [...base.outages, simulated].sort((a, b) => a.start - b.start)
  return { ...base, outages, knownUntil: Math.max(base.knownUntil ?? 0, simulated.end) }
}

// ---------- форматування ----------

export function fmtDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} хв`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} год ${rest} хв` : `${h} год`
}

// "14:00" або "завтра о 06:00" відносно now.
export function fmtWhen(utcMs: number, now: number): string {
  const at = kyivParts(utcMs)
  const today = kyivParts(now).date
  if (at.date === today) return at.time
  const tomorrow = kyivParts(now + 24 * 60 * MIN).date
  return at.date === tomorrow ? `завтра о ${at.time}` : `${at.date.slice(8, 10)}.${at.date.slice(5, 7)} о ${at.time}`
}

export function fmtRange(o: Interval): string {
  const end = kyivParts(o.end).time
  return `${kyivParts(o.start).time}–${end === '00:00' ? '24:00' : end}`
}

export function fmtDay(date: string): string {
  return `${date.slice(8, 10)}.${date.slice(5, 7)}`
}
