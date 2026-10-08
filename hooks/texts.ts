// Тексти svitlo: що читає модель і що бачить користувач.

import type { Interval, Plan, Status } from './schedule'
import { fmtDay, fmtDuration, fmtRange, fmtWhen, kyivParts } from './schedule'

export type Where = { regionName: string; queue: string }

function place(w: Where): string {
  return `${w.regionName}, черга ${w.queue}`
}

function resumeHint(sessionId: string | undefined): string {
  return sessionId ? `\`claude --resume ${sessionId}\`` : '`claude --resume`'
}

export function warnForMain(o: Interval, minutesLeft: number, now: number, w: Where, sessionId?: string): string {
  return [
    `⚡ svitlo: за графіком відключення світла о ${fmtWhen(o.start, now)} (через ${fmtDuration(minutesLeft)}; ${place(w)}). Комп'ютер може вимкнутися раптово, тому сесію треба довести до точки, з якої її легко відновити.`,
    'Зараз:',
    '1. Не починай нових довгих кроків: великих змін, довгих збірок і тестів, нових субагентів.',
    '2. Доведи поточну зміну до цілісного стану: жоден файл не має лишитися відредагованим наполовину.',
    '3. Фонові процеси й субагентів, яких ти запустив, зупини або дочекайся їхнього результату.',
    `4. Заверши хід коротким підсумком: що зроблено, що лишилось і наступний крок. Після ${resumeHint(sessionId)} роботу продовжать саме з нього.`,
    'Не комітити й не пушити, якщо користувач або правила проєкту цього не просили.',
  ].join('\n')
}

export function warnForSubagent(o: Interval, minutesLeft: number, now: number): string {
  return `⚡ svitlo: за графіком відключення світла о ${fmtWhen(o.start, now)} (через ${fmtDuration(minutesLeft)}). Ти субагент: не починай нових кроків. Доведи поточний крок до цілісного стану й одразу поверни результат із чітким статусом: що зроблено, чого не зроблено і що робити далі.`
}

export function finalWarning(o: Interval, minutesLeft: number, now: number): string {
  return `⚡ svitlo: до відключення світла лишилося ${fmtDuration(minutesLeft)} (о ${fmtWhen(o.start, now)}). Заверши хід зараз: жодних нових змін, лише короткий підсумок стану для відновлення.`
}

export function hardDeny(s: Status, now: number): string {
  const o = s.outage!
  const when =
    o.start <= now
      ? `відключення світла за графіком почалося о ${kyivParts(o.start).time}`
      : `до відключення світла о ${kyivParts(o.start).time} лишилося ${fmtDuration(s.minutesLeft ?? 0)}`
  return `⚡ svitlo: ${when}. Інструменти заблоковано, щоб робота не обірвалася посередині. Напиши короткий підсумок (що зроблено, що лишилось, наступний крок) і заверши хід. Зняти блок користувач може командою /svitlo pause.`
}

export function aheadNote(o: Interval, minutesLeft: number, now: number, lead: number): string {
  const checkpoint = fmtWhen(o.start - lead * 60_000, now)
  return `ℹ svitlo: за графіком відключення світла о ${fmtWhen(o.start, now)} (через ${fmtDuration(minutesLeft)}). Якщо задача довга, плануй її етапами, щоб до ${checkpoint} дійти до стабільної точки. За ${lead} хв до відключення svitlo нагадає ще раз.`
}

// ---------- рядок статусу ----------

export function statusLine(
  plan: Plan | null,
  s: Status,
  now: number,
  extra: { stale?: number; pausedUntil?: number; error?: boolean },
): string {
  const head = plan ? `Світло (${plan.queue})` : 'Світло'
  let body: string
  switch (s.phase) {
    case 'unknown':
      body = extra.error ? 'немає даних графіка (мережа?)' : 'графік ще не опубліковано'
      break
    case 'none':
      body = 'відключень за графіком немає'
      break
    case 'ahead':
      body = `відключення о ${fmtWhen(s.outage!.start, now)}, через ${fmtDuration(s.minutesLeft!)}`
      break
    case 'warn':
    case 'final':
      body = `ВІДКЛЮЧЕННЯ о ${fmtWhen(s.outage!.start, now)}, через ${fmtDuration(s.minutesLeft!)}! Агенти завершують роботу`
      break
    case 'hard':
      body = s.outage!.start <= now ? 'відключення почалося за графіком' : `відключення за ${fmtDuration(s.minutesLeft!)}: інструменти заблоковано`
      break
    case 'outage':
      body = `за графіком без світла до ${fmtWhen(s.outage!.end, now)}`
      break
  }
  const icon = s.phase === 'warn' || s.phase === 'final' || s.phase === 'hard' ? '⚡' : s.phase === 'outage' ? '🔌' : '💡'
  const tail: string[] = []
  if (plan?.emergency) tail.push('⚠ діють аварійні відключення')
  if (extra.pausedUntil && extra.pausedUntil > now) tail.push(`пауза до ${fmtWhen(extra.pausedUntil, now)}`)
  if (extra.stale) tail.push(`дані від ${fmtWhen(extra.stale, now)}`)
  return [`${icon} ${head}: ${body}`, ...tail].join(' · ')
}

// ---------- зведення для /svitlo і інструмента schedule ----------

export function summary(
  plan: Plan | null,
  s: Status,
  now: number,
  info: { lead: number; fetchedAt?: number; error?: string; pausedUntil?: number; simulated?: Interval | null },
): string {
  if (!plan) {
    return [
      '⚡ svitlo — графік відключень світла',
      info.error ? `Дані не отримано: ${info.error}` : 'Дані ще не завантажено.',
    ].join('\n')
  }
  const lines = [
    '⚡ svitlo — графік відключень світла',
    `Регіон: ${plan.regionName} · черга ${plan.queue} · попередження за ${info.lead} хв`,
    `Зараз: ${statusLine(plan, s, now, { pausedUntil: info.pausedUntil })}`,
  ]
  if (plan.emergency) lines.push('⚠ У регіоні оголошено аварійні відключення: світло можуть вимкнути й поза графіком.')
  for (const day of plan.days) {
    const ranges = plan.outages.filter(o => kyivParts(o.start).date === day).map(fmtRange)
    lines.push(`${fmtDay(day)}: ${ranges.length ? ranges.join(', ') : 'без відключень'}`)
  }
  if (plan.region !== 'test') {
    if (plan.days.length === 0) lines.push('Графік на сьогодні ще не опубліковано.')
    else if (plan.days.length === 1) lines.push('Графік на завтра ще не опубліковано.')
  }
  if (info.simulated) lines.push(`🧪 Симуляція: відключення ${fmtRange(info.simulated)} (тільки ця сесія; /svitlo test off — вимкнути)`)
  if (info.fetchedAt) lines.push(`Дані оновлено о ${fmtWhen(info.fetchedAt, now)} (svitlo.live)${info.error ? `; остання спроба невдала: ${info.error}` : ''}`)
  lines.push('Команди: /svitlo pause · /svitlo on · /svitlo test [хв] · /svitlo sessions · /svitlo refresh · налаштування: /svitlo:setup')
  return lines.join('\n')
}

export const NOT_CONFIGURED =
  '⚡ svitlo ще не налаштовано. Набери /svitlo:setup: агент спитає область, населений пункт і чергу.'
