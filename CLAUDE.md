# svitlo-guard

North Star: агенти Claude Code встигають дійти до точки відновлення перед відключенням світла за графіком, а сесія відновлюється однією командою.
Поточна фаза: v0.1.0 опубліковано — https://github.com/kirilpolishchukdev-art/svitlo-guard (реліз v0.1.0, main захищена від force-push). Локально встановлено з цієї теки (/reload-plugins після правок). Коміти — від kirilpolishchukdev-art з noreply-поштою (git config репо). Пушити: gh auth switch -u kirilpolishchukdev-art, потім повернути netkuluoko-png (2026-10-08).

## Мапа репо
- `hooks/register.tsx` — хуки мода (function hooks, Claude Code ≥ 2.1.293): таймер, `tool.call`, `prompt.submit`, `/svitlo`, інструменти `mcp__svitlo__*`, плашка `AbovePrompt`.
- `hooks/schedule.ts` — чиста логіка: фіди, київський час, фази. `hooks/texts.ts` — усі тексти.
- `hooks/*.test.ts(x)` — тести `claude plugin test`.
- `skills/setup/SKILL.md` — `/svitlo:setup`. `types/index.d.ts` — контракт `$.state`.
- `.claude-plugin/` — маніфест і marketplace; `.claude-plugin/types/` і `tsconfig.json` генерує рушій, тому `types/` у gitignore.
- `tools/` — допоміжні скрипти (див. `tools/README.md`).

## Інваріанти
- `$` передається лише у функції, оголошені на верхньому рівні модуля (інакше `claude plugin validate` відмовить).
- Збій хука не блокує роботу: хуки `tool.call` і `prompt.submit` без `.catch`, тобто при помилці вони пропускаються.
- svitlo нічого не комітить і не пушить. Агентам він лише радить, блок інструментів діє тільки в вікні від −2 до +5 хв відносно початку відключення, і `/svitlo pause` його знімає.
- Час графіка — Europe/Kyiv, у коді все зберігається в UTC ms. Перехід на літній і зимовий час покритий тестом.
- Дні фіда беруться лише з `date_today`/`date_tomorrow`: застряглі старі дні не вважаються графіком.
- Мережа — лише через `$.http.fetch`, бережливо: 15 хв поблизу відключення (≤ 3 год), інакше 60 хв, старий фід ≤ раз на 30 хв; кеш у `$.store` спільний для всіх сесій.
- Рядки з API йдуть до моделі лише після білого списку (`sanitizeFeed`), помилки — фіксовані тексти.

## Перед кодом
Перевір `tools/README.md` і `.claude/skills/`, щоб не переписувати наявне. Типи API рушія лежать у `.claude-plugin/types/claude-code/index.d.ts` (після `claude --plugin-dir .`).

## Поверхня → перевірка
| поверхня | команда | пройдено |
|---|---|---|
| маніфест і модуль | `claude plugin validate .` | `✔ Validation passed` |
| типи | `tsc -p .` (після одного `claude --plugin-dir .`) | exit 0 |
| логіка й хуки | `claude plugin test .` | 0 fail |
| живий агент | `SVITLO_SIMULATE_MIN=19 claude --plugin-dir . --model haiku -p "…"` | попередження svitlo видно в контексті; за `=1` інструменти заблоковано |
| дані API | `python tools/feed_report.py <регіон> <черга>` | регіон знайдено, дні — сьогодні/завтра |

У Git Bash slash-команди в `-p` передавай з `MSYS_NO_PATHCONV=1`.

## Звіт
Що / де / як перевірено / ризик. Непройдене — першим рядком.
