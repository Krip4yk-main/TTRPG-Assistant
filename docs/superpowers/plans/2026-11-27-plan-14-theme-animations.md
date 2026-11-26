# НРІ Асистент — План 14: фірмові анімації дизайнів

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Кожен дизайн має рівно одну фірмову анімацію. Дошка (відрив) і магіпанк (конверт) — вже мають; додаємо ★-вибір для решти 8 (затверджено власником 2026-11-27).

**Architecture:** Розширити `ThemeEffectName` у `frontend/src/app/theming/theme.registry.ts` новими моментами і ліниво завантажувати ефект дизайну (як `applicationSent` у магіпанку: `preloadEffect` / `playEffect`). Моменти: `applicationSent` (діалог заявки), `gameOpened` (перехід картка → сторінка гри), `acceptedNotice` (поява сповіщення «вас прийнято» у списку сповіщень).

**Spec:** `.media/animation-ideas/ideas.md` (★-пункти) + розкадровки `<id>.png` там же (локально).

## Global Constraints

- ≤ 1.6 с; запуск після успіху дії, навігація не чекає довше за анімацію; лише CSS/WAAPI, без нових залежностей; без hover-ефектів.
- Вимикається `prefers-reduced-motion` і налаштуванням вигляду: одне спільне `sendAnimation` перейменувати в UI на «Фірмові анімації дизайну» (поле в БД лишається; без міграції).
- LiveAnnouncer оголошує результат дії однаково з анімацією й без неї; анімація `aria-hidden`.
- Перевірка швів і на 375 px; жодних текстур з видимими склейками (див. правило фільтр-регіону SVG).
- Тексти — `uk.json`. Тести/typecheck/lint/build зелені; медіа лише в `.media/`.

## Tasks

### Task 1: Інфраструктура моментів `gameOpened`, `acceptedNotice` + перейменування налаштування
### Task 2: neon-signs — «Вивіска запалюється» (applicationSent)
### Task 3: holo-market — «Згортання в проєктор» (gameOpened)
### Task 4: night-city — «Імпульс по шині» (applicationSent)
### Task 5: dungeon — «Підйом ґрат» (gameOpened)
### Task 6: gothic-gloom — «Сургучний вердикт» (acceptedNotice)
### Task 7: brass-steam — «Телеграфна стрічка» (applicationSent)
### Task 8: solar-garden — «Паросток» (applicationSent)
### Task 9: painted-city — «Тег пензлем» (applicationSent)
### Task 10: Запис коротких відео в `.media/`, QA-features, фінальна перевірка
