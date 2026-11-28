// Локальна перевірка сокета сайту з термінала (лише для розробки).
// Входить через dev-вхід (працює тільки з localhost), підключається до Socket.IO бекенду
// й друкує всі події, що приходять.
//
// Запуск з кореня репозиторію (бекенд на :3000):
//   node scripts/dev/ws-test.mjs                 — як dice_tm
//   node scripts/dev/ws-test.mjs <нікнейм>       — як інший тестовий користувач
//   node scripts/dev/ws-test.mjs <нікнейм> 908   — і стежити за грою 908 (події game.changed)
// Вихід — Ctrl+C.
import { createRequire } from 'node:module';

const require = createRequire(process.cwd() + '/');
const { io } = require('socket.io-client');

const API = process.env.API ?? 'http://localhost:3000';
const NICK = process.argv[2] || 'dice_tm';
const GAME = process.argv[3];

const jar = {};
const keep = (r) =>
  (r.headers.getSetCookie?.() ?? []).forEach((c) => {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[kv.slice(0, i)] = kv.slice(i + 1);
  });
const cookie = () =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

keep(await fetch(`${API}/api/me`));
const login = await fetch(`${API}/api/auth/dev-login`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-csrf-token': decodeURIComponent(jar.nri_csrf ?? ''),
    cookie: cookie(),
  },
  body: JSON.stringify({ nickname: NICK }),
});
keep(login);
console.log('login:', login.status);

const s = io(API, { transports: ['websocket'], extraHeaders: { cookie: cookie() } });
s.on('connect', () => {
  console.log('connected, id', s.id);
  if (GAME) {
    s.emit('game.watch', { gameId: Number(GAME) }, (ack) => console.log('watch', GAME, ack));
  }
});
s.on('connect_error', (e) => console.log('connect_error:', e.message));
s.onAny((ev, ...args) => console.log('event:', ev, JSON.stringify(args)));
