import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SvitloBand } from '../types'
import {
  DEFAULT_THRESHOLDS,
  NEW_API,
  OLD_API,
  catalog,
  choosePlan,
  fmtWhen,
  kyivParts,
  normalizeQueue,
  parseFeed,
  planFrom,
  resolveRegion,
  statusAt,
  withSimulated,
} from './schedule'
import type { Feed, Interval, Plan, Status } from './schedule'
import {
  NOT_CONFIGURED,
  aheadNote,
  finalWarning,
  hardDeny,
  statusLine,
  summary,
  warnForMain,
  warnForSubagent,
} from './texts'

type $ = EngineInterface

type Config = { region: string; regionName: string; queue: string; lead: number }
type Cache = { key: string; fetchedAt: number; plan: Plan | null; error?: string; failedAt?: number }
type SessionRecord = { id: string; cwd: string; outageStart: number; outageEnd: number; recordedAt: number }

const MIN = 60_000
const FRESH_MS = 15 * MIN
const RETRY_MS = 2 * MIN
const STALE_MS = 45 * MIN
const SNAPSHOT_MS = MIN
const KEEP_SESSIONS_MS = 36 * 60 * MIN
const AHEAD_NOTE_MIN = 90
const MAX_FEED_CHARS = 5_000_000
const USER_AGENT = 'svitlo-guard/0.1 (Claude Code plugin)'

const bandRef = atom({ plugin: 'svitlo', key: 'band' } as const, null)
const hiddenRef = atom({ plugin: 'svitlo', key: 'bandHidden' } as const, '')

const keyOf = (c: Config) => `${c.region}|${c.queue}`
const sameDir = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
// У статус і до моделі йдуть лише наші власні тексти помилок.
const KNOWN_ERRORS = /^(HTTP \d{3}|мережа недоступна|завелика відповідь|відповідь не у форматі JSON)$/
const errText = (err: unknown) => (err instanceof Error && KNOWN_ERRORS.test(err.message) ? err.message : 'не вдалося оновити')
const isUrgent = (s: Status) => s.phase === 'warn' || s.phase === 'final' || s.phase === 'hard'

// Помилки — лише власні фіксовані тексти: вони потрапляють у статус і до моделі.
async function fetchFeed($: $, url: string): Promise<Feed> {
  let res: Awaited<ReturnType<typeof $.http.fetch>>
  try {
    res = await $.http.fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
  } catch {
    throw new Error('мережа недоступна')
  }
  if (!res.ok) throw new Error(`HTTP ${Number(res.status)}`)
  if (res.text.length > MAX_FEED_CHARS) throw new Error('завелика відповідь')
  return parseFeed(res.text)
}

async function fetchBoth($: $): Promise<{ fresh?: Feed; old?: Feed }> {
  const [fresh, old] = await Promise.all([
    fetchFeed($, NEW_API).catch(() => undefined),
    fetchFeed($, OLD_API).catch(() => undefined),
  ])
  return { fresh, old }
}

// Новий фід; старий — лише коли в новому немає графіка на сьогодні.
async function fetchPlan($: $, region: string, queue: string): Promise<Plan | null> {
  let freshError: unknown
  const fresh = await fetchFeed($, NEW_API).then(
    feed => ({ feed, plan: planFrom(feed, region, queue) }),
    err => {
      freshError = err
      return { feed: undefined, plan: null }
    },
  )
  const today = fresh.feed?.date_today
  const freshOk = !!fresh.plan && fresh.plan.days.length > 0 && (!today || fresh.plan.days.includes(today))
  if (freshOk) return choosePlan(fresh)
  try {
    const feed = await fetchFeed($, OLD_API)
    return choosePlan(fresh, { feed, plan: planFrom(feed, region, queue) })
  } catch (err) {
    if (!fresh.feed) throw freshError ?? err
    return choosePlan(fresh)
  }
}

type Snapshot = {
  at: number
  cfg: Config | null
  cache: Cache | null
  pausedUntil: number
}

let simulated: Interval | null = null
let snapshot: Snapshot | null = null
let refreshing: Promise<void> | null = null
let resumeBand: SvitloBand | null = null
// `${початок}:${агент}` → 1 (попередження) або 2 (останнє), щоб не повторювати.
const warned = new Map<string, number>()
const toasted = new Set<string>()

async function loadSnapshot($: $, now: number): Promise<Snapshot> {
  const [cfg, cache, pausedUntil] = await Promise.all([
    $.store.get('config'),
    $.store.get('cache'),
    $.store.get('pausedUntil'),
  ])
  snapshot = {
    at: now,
    cfg: (cfg as Config | undefined) ?? null,
    cache: (cache as Cache | undefined) ?? null,
    pausedUntil: Number(pausedUntil ?? 0),
  }
  return snapshot
}

async function view($: $, fresh = false) {
  const now = await $.clock.now()
  const snap = !fresh && snapshot && now - snapshot.at < SNAPSHOT_MS ? snapshot : await loadSnapshot($, now)
  const { cfg, cache } = snap
  const real = cfg && cache && cache.key === keyOf(cfg) ? cache.plan : null
  const plan = withSimulated(real, simulated)
  const lead = cfg?.lead ?? DEFAULT_THRESHOLDS.lead
  const status = statusAt(plan, now, { ...DEFAULT_THRESHOLDS, lead })
  return {
    now,
    cfg,
    cache,
    plan,
    lead,
    status,
    paused: snap.pausedUntil > now,
    pausedUntil: snap.pausedUntil,
    stale: cache && cache.fetchedAt > 0 && now - cache.fetchedAt > STALE_MS ? cache.fetchedAt : undefined,
  }
}

async function doRefresh($: $, force: boolean): Promise<void> {
  const cfg = (await $.store.get('config')) as Config | undefined
  if (!cfg) return
  const now = await $.clock.now()
  const cache = (await $.store.get('cache')) as Cache | undefined
  const same = cache?.key === keyOf(cfg) ? cache : undefined
  if (!force && same) {
    if (now - same.fetchedAt < FRESH_MS) return
    if (same.failedAt && now - same.failedAt < RETRY_MS) return
  }
  // Кілька відкритих сесій ділять один кеш: качає та, що перша взяла замок.
  const lock = Number((await $.store.get('fetchLock')) ?? 0)
  if (!force && lock > now) return
  await $.store.set('fetchLock', now + 30_000)
  try {
    const plan = await fetchPlan($, cfg.region, cfg.queue)
    await $.store.set('cache', { key: keyOf(cfg), fetchedAt: now, plan } satisfies Cache)
  } catch (err) {
    await $.store.set('cache', {
      key: keyOf(cfg),
      fetchedAt: same?.fetchedAt ?? 0,
      plan: same?.plan ?? null,
      error: errText(err),
      failedAt: now,
    } satisfies Cache)
  } finally {
    await $.store.delete('fetchLock')
    snapshot = null
  }
}

function refresh($: $, force = false): Promise<void> {
  if (!refreshing) {
    refreshing = doRefresh($, force).finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

async function setBand($: $, band: SvitloBand | null) {
  const current = await read($, bandRef)
  if (JSON.stringify(current ?? null) !== JSON.stringify(band)) await update($, bandRef, () => band)
}

async function sessions($: $): Promise<SessionRecord[]> {
  return ((await $.store.get('sessions')) as SessionRecord[] | undefined) ?? []
}

async function recordSession($: $, outage: Interval, now: number) {
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const rest = (await sessions($)).filter(r => r.id !== id && now - r.recordedAt < KEEP_SESSIONS_MS)
  rest.push({ id, cwd, outageStart: outage.start, outageEnd: outage.end, recordedAt: now })
  await $.store.set('sessions', rest)
}

async function forgetSession($: $) {
  const id = await $.session.id()
  const list = await sessions($)
  if (list.some(r => r.id === id)) await $.store.set('sessions', list.filter(r => r.id !== id))
}

async function tick($: $) {
  await refresh($).catch(() => undefined)
  const v = await view($)
  if (!v.cfg && !simulated) {
    $.ui.status('⚡ svitlo: не налаштовано — /svitlo:setup')
    await setBand($, resumeBand)
    return
  }
  $.ui.status(
    statusLine(v.plan, v.status, v.now, {
      stale: v.stale,
      pausedUntil: v.paused ? v.pausedUntil : undefined,
      error: !!v.cache?.error,
    }),
  )
  const s = v.status
  const isSimulated = !!simulated && s.outage?.start === simulated.start
  if (!s.outage || !isUrgent(s) || v.paused) {
    // Сесія пережила відключення (ДБЖ, графік змінили) — запис для відновлення не потрібен.
    if (!isSimulated) await forgetSession($)
    await setBand($, resumeBand)
    return
  }
  const id = await $.session.id()
  const command = `claude --resume ${id}`
  const marker = `${s.outage.start}:${s.phase}`
  if (!toasted.has(marker)) {
    toasted.add(marker)
    const when = fmtWhen(s.outage.start, v.now)
    $.ui.toast(
      s.phase === 'warn'
        ? `⚡ Відключення світла о ${when} — через ${s.minutesLeft} хв. Агенти завершують роботу. Відновити потім: ${command}`
        : s.phase === 'final'
          ? `⚡ До відключення світла ${s.minutesLeft} хв. Відновити потім: ${command}`
          : `⚡ Відключення світла о ${when}: інструменти агентів заблоковано. /svitlo pause — зняти блок`,
      { timeoutMs: 15_000 },
    )
    if (!isSimulated) await recordSession($, s.outage, v.now)
  }
  await setBand($, {
    id: `warn:${s.outage.start}`,
    tone: 'warn',
    text: `⚡ Відключення світла о ${fmtWhen(s.outage.start, v.now)}${s.minutesLeft ? ` — через ${s.minutesLeft} хв` : ''}. Агенти доводять роботу до точки відновлення.`,
    command,
  })
}

// Примітка для моделі про найближче відключення, раз на рівень для кожного агента; null — нічого казати.
async function noteFor($: $, loop: string, isSubagent: boolean, allowAhead: boolean): Promise<string | null> {
  const v = await view($)
  const s = v.status
  if (v.paused || !s.outage) return null
  if (s.phase === 'ahead') {
    return allowAhead && s.minutesLeft! <= AHEAD_NOTE_MIN ? aheadNote(s.outage, s.minutesLeft!, v.now, v.lead) : null
  }
  if (!isUrgent(s)) return null
  const level = s.phase === 'hard' ? 3 : s.phase === 'final' ? 2 : 1
  const key = `${s.outage.start}:${loop}`
  if ((warned.get(key) ?? 0) >= level) return null
  warned.set(key, level)
  if (level === 3) return hardDeny(s, v.now)
  if (level === 2) return finalWarning(s.outage, s.minutesLeft!, v.now)
  if (isSubagent) return warnForSubagent(s.outage, s.minutesLeft!, v.now)
  return warnForMain(s.outage, s.minutesLeft!, v.now, v.plan!, await $.session.id())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'svitlo',
      description: 'Графік відключень світла: статус, pause, on, test, sessions, refresh',
      argumentHint: '[pause|on|test [хв]|sessions|refresh]',
      immediate: true,
    })
    await $.tool.register({
      name: 'regions',
      description:
        'svitlo: список областей / операторів і їхніх черг (груп) графіків відключень світла в Україні. Потрібен під час налаштування svitlo.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'configure',
      description:
        'svitlo: зберегти регіон і чергу користувача. region — id з mcp__svitlo__regions (наприклад "kyiv", "lvivska-oblast"); queue — черга й підчерга, наприклад "3.1" (або "3", де підчерг немає); leadMinutes — за скільки хвилин до відключення агенти завершують роботу (5–120, за замовчуванням 20).',
      inputSchema: {
        type: 'object',
        properties: {
          region: { type: 'string' },
          queue: { type: 'string' },
          leadMinutes: { type: 'number', minimum: 5, maximum: 120 },
        },
        required: ['region', 'queue'],
      },
    })
    await $.tool.register({
      name: 'schedule',
      description: 'svitlo: поточний стан і графік відключень світла користувача на сьогодні й завтра.',
      inputSchema: { type: 'object', properties: {} },
    })

    const now = await $.clock.now()
    const simulate = Number(await $.env.get('SVITLO_SIMULATE_MIN'))
    if (Number.isFinite(simulate) && simulate > 0) simulated = { start: now + simulate * MIN, end: now + (simulate + 30) * MIN }

    // Сесії, яких, схоже, не стало під час відключення, у цій же теці.
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    const list = await sessions($)
    const interrupted = list.filter(r => r.id !== id && sameDir(r.cwd, cwd) && r.outageStart <= now)
    if (list.some(r => r.id === id)) await $.store.set('sessions', list.filter(r => r.id !== id))
    const last = interrupted.sort((a, b) => b.outageStart - a.outageStart)[0]
    if (last) {
      resumeBand = {
        id: `resume:${last.id}`,
        tone: 'resume',
        text: `🔌 Сесію в цій теці, схоже, перервало відключення світла о ${kyivParts(last.outageStart).time}.${interrupted.length > 1 ? ` Усього таких: ${interrupted.length}, список — /svitlo sessions.` : ''}`,
        command: `claude --resume ${last.id}`,
      }
      $.ui.toast(`🔌 Перервана відключенням сесія: claude --resume ${last.id}`, { timeoutMs: 15_000 })
    }

    if (!(await $.store.get('config')) && !simulated) {
      const nagged = Number((await $.store.get('naggedAt')) ?? 0)
      if (now - nagged > 24 * 60 * MIN) {
        await $.store.set('naggedAt', now)
        $.ui.toast(NOT_CONFIGURED, { timeoutMs: 12_000 })
      }
    }

    $.clock.after(1, () => void tick($))
    $.clock.every(MIN, () => void tick($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await forgetSession($).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const note = await noteFor($, 'main', false, true)
    return note ? next({ ...e, context: [...(e.context ?? []), note] }) : next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool).startsWith('mcp__svitlo__')) return next(e)
    const v = await view($)
    if (!v.paused && v.status.phase === 'hard') return { deny: hardDeny(v.status, v.now) }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    // Фазу дивимось після виконання: довга збірка могла перетнути межу попередження.
    const note = await noteFor($, e.agentId ?? 'main', e.agentId !== undefined, false)
    return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
  })

  on('tool.call', { tool: 'mcp__svitlo__regions' }, async $ => {
    const { fresh, old } = await fetchBoth($)
    const list = catalog(fresh, old)
    if (list.length === 0) return { result: 'Не вдалося отримати список регіонів: svitlo.live недоступний. Спробуй трохи згодом.' }
    return {
      result: [
        ...list.map(r => `${r.id} — ${r.name} — черги: ${r.queues.join(', ')}`),
        '',
        'kyiv — місто Київ; kiivska-oblast — Київська область. dnipro-dnem і dnipro-cek — місто Дніпро (оператори ДнЕМ і ЦЕК); dnipropetrovska-oblast — решта області.',
      ].join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__svitlo__configure' }, async ($, e) => {
    const input = e as unknown as { region?: unknown; queue?: unknown; leadMinutes?: unknown }
    const regionInput = String(input.region ?? '').trim()
    const queueInput = String(input.queue ?? '').trim()
    const leadRaw = Math.round(Number(input.leadMinutes ?? DEFAULT_THRESHOLDS.lead))
    const lead = Number.isFinite(leadRaw) ? Math.min(120, Math.max(5, leadRaw)) : DEFAULT_THRESHOLDS.lead

    const { fresh, old } = await fetchBoth($)
    const list = catalog(fresh, old)
    if (list.length === 0) return { result: 'Помилка: svitlo.live недоступний, налаштування не збережено. Спробуй трохи згодом.' }
    const entry = resolveRegion(list, regionInput)
    if (!entry) return { result: `Помилка: регіон "${regionInput}" не знайдено. Доступні id: ${list.map(r => r.id).join(', ')}` }
    const queue = normalizeQueue(queueInput)
    if (!queue || !entry.queues.includes(queue)) {
      return { result: `Помилка: черги "${queueInput}" немає для «${entry.name}». Доступні: ${entry.queues.join(', ')}` }
    }

    const cfg: Config = { region: entry.id, regionName: entry.name, queue, lead }
    const now = await $.clock.now()
    const plan = choosePlan({ feed: fresh, plan: planFrom(fresh, entry.id, queue) }, { feed: old, plan: planFrom(old, entry.id, queue) })
    await $.store.set('config', cfg)
    await $.store.set('cache', { key: keyOf(cfg), fetchedAt: now, plan } satisfies Cache)
    snapshot = null
    await tick($).catch(() => undefined)
    const v = await view($, true)
    return {
      result: `Збережено: ${entry.name}, черга ${queue}, агенти завершують роботу за ${lead} хв до відключення.\n\n${summary(v.plan, v.status, v.now, { lead, fetchedAt: now })}`,
    }
  })

  on('tool.call', { tool: 'mcp__svitlo__schedule' }, async $ => {
    await refresh($).catch(() => undefined)
    const v = await view($, true)
    if (!v.cfg && !simulated) return { result: NOT_CONFIGURED }
    return {
      result: summary(v.plan, v.status, v.now, {
        lead: v.lead,
        fetchedAt: v.cache?.fetchedAt || undefined,
        error: v.cache?.error,
        pausedUntil: v.paused ? v.pausedUntil : undefined,
        simulated,
      }),
    }
  })

  on('command.run', { command: 'svitlo' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().split(/\s+/)
    switch (sub.toLowerCase()) {
      case 'pause': {
        const v = await view($, true)
        const until = v.status.outage ? v.status.outage.end : v.now + 4 * 60 * MIN
        await $.store.set('pausedUntil', until)
        snapshot = null
        await tick($)
        return { text: `⏸ svitlo на паузі до ${fmtWhen(until, v.now)}: агентів не попереджатиму й не блокуватиму. Увімкнути: /svitlo on` }
      }
      case 'on': {
        await $.store.delete('pausedUntil')
        snapshot = null
        await tick($)
        return { text: '▶ svitlo знову стежить за графіком.' }
      }
      case 'test': {
        if (arg === 'off') {
          simulated = null
          snapshot = null
          await tick($)
          return { text: '🧪 Симуляцію вимкнено.' }
        }
        const v = await view($, true)
        const minutes = Number(arg) > 0 ? Number(arg) : Math.max(1, v.lead - 1)
        simulated = { start: v.now + minutes * MIN, end: v.now + (minutes + 30) * MIN }
        warned.clear()
        toasted.clear()
        await tick($)
        return {
          text: `🧪 Симуляція: відключення о ${fmtWhen(simulated.start, v.now)} (через ${minutes} хв) лише для цієї сесії. Попередження агентам — за ${v.lead} хв, блок інструментів — за ${DEFAULT_THRESHOLDS.hard} хв. Вимкнути: /svitlo test off`,
        }
      }
      case 'sessions': {
        const now = await $.clock.now()
        const list = (await sessions($)).filter(r => r.outageStart <= now)
        if (list.length === 0) return { text: 'Сесій, перерваних відключенням, не знайдено.' }
        return {
          text: [
            'Сесії, які, схоже, перервало відключення світла:',
            ...list.map(r => `• ${kyivParts(r.outageStart).date} ${kyivParts(r.outageStart).time} · ${r.cwd}\n  claude --resume ${r.id}`),
          ].join('\n'),
        }
      }
      case 'reset': {
        await Promise.all(['config', 'cache', 'pausedUntil', 'naggedAt'].map(key => $.store.delete(key)))
        simulated = null
        snapshot = null
        await tick($)
        return { text: 'svitlo забув регіон і чергу. Налаштувати знову: /svitlo:setup' }
      }
      case 'refresh':
      case '': {
        await refresh($, sub === 'refresh').catch(() => undefined)
        const v = await view($, true)
        if (!v.cfg && !simulated) return { text: NOT_CONFIGURED }
        return {
          text: summary(v.plan, v.status, v.now, {
            lead: v.lead,
            fetchedAt: v.cache?.fetchedAt || undefined,
            error: v.cache?.error,
            pausedUntil: v.paused ? v.pausedUntil : undefined,
            simulated,
          }),
        }
      }
      default:
        return { text: 'Використання: /svitlo [pause | on | test [хв] | test off | sessions | refresh | reset]. Налаштування: /svitlo:setup' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const band = await read($, bandRef)
    const hidden = await read($, hiddenRef)
    if (!band || hidden === band.id || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const command = band.command
    return (
      <Box flexDirection="column">
        <Text color={band.tone === 'warn' ? 'warning' : 'suggestion'} bold>
          {band.text}
        </Text>
        <Box>
          {command !== undefined && <Text>Відновити: </Text>}
          {command !== undefined && <Text bold>{command}</Text>}
        </Box>
        <Box>
          {command !== undefined && (
            <Button key="copy" label="Копіювати команду" onPress={press => void $.ui.copy({ text: command, surface: press.surface })} />
          )}
          <Button key="hide" label="Сховати" onPress={() => update($, hiddenRef, () => band.id)} />
        </Box>
      </Box>
    )
  })
}
