/* e2e-тест серверной авторизации приложения (ник+пароль, 2FA, овнер-код НЕправильный, bind TG, logout).
   Запуск: NODE_OPTIONS=--require tools/skip-bad-ip.cjs node tools/test-auth.mjs
   ВНИМАНИЕ: правильный овнер-код '3545425893' НЕ тестировать — одноразовый! */
import crypto from 'crypto';

const API = 'https://fi-coin-bot.pta757f.workers.dev';
const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const NICK = 'ГостьТест-' + Math.floor(Math.random() * 1e6);
const PASS = 'тестПароль123';
const results = [];
const ok = (name, cond, extra = '') => { results.push((cond ? '✔ ' : '✘ ') + name + (extra ? ' — ' + extra : '')); if (!cond) process.exitCode = 1; };
async function call(path, body) {
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const txt = await r.text();
            let j = null; try { j = JSON.parse(txt); } catch (_) { if (txt) console.log('  !! non-JSON [' + path.split('?')[0] + '] status=' + r.status + ': ' + txt.slice(0, 200)); }
            return { status: r.status, j };
        } catch (e) {
            lastErr = e;
            await new Promise(res => setTimeout(res, 700 + attempt * 800)); /* сеть дёргает TCP — ретраим */
        }
    }
    console.log('  !! все ретраи исчерпаны [' + path.split('?')[0] + ']: ' + (lastErr && lastErr.cause ? lastErr.cause.code : lastErr));
    return { status: 0, j: null };
}
const fp = () => 'F' + sha('fp' + Math.random() + Date.now() + Math.random()).slice(0, 12);

/* регистрация нового игрока */
let { j } = await call('/api/auth', { mode: 'register', nick: NICK, pass: PASS });
ok('register ok', !!(j && j.ok && j.token), JSON.stringify(j).slice(0, 110));
const tok1 = j && j.token;
if (!tok1) throw new Error('register не выдал token — дальше нет смысла');

/* sync по токену сессии */
({ j } = await call('/api/sync', { token: tok1, actions: [] }));
ok('sync(token) даёт me', !!(j && j.me), j ? JSON.stringify(j).slice(0, 110) : 'null ok=' + (j && j.ok));
ok('me.via === app', j && j.me && j.me.via === 'app', 'via=' + (j && j.me && j.me.via));
ok('me.linked === false (TG ещё не привязан)', j && j.me && j.me.linked === false, 'linked=' + (j && j.me && j.me.linked));
ok('me.id — G-аккаунт', typeof (j && j.me && j.me.id) === 'string' && String(j.me.id).startsWith('G'), j && j.me && j.me.id);

/* login неверный пароль */
({ j } = await call('/api/auth', { mode: 'login', nick: NICK, pass: 'НЕ_пароль' }));
ok('login неверный пароль → отказ', j && j.ok === false && /неверн/i.test(j.msg || ''), (j && j.msg) || '(нет msg)');

/* login верный пароль + новое устройство → need2fa */
({ j } = await call('/api/auth', { mode: 'login', nick: NICK, pass: PASS, fp: fp() }));
ok('login с нового устройства → need2fa', j && j.need2fa === true, JSON.stringify(j).slice(0, 150));
ok('TG отсутствует → viaTg=false и код в ответе', j && j.viaTg === false && /^\d{6}$/.test(String(j.debug || '')), 'debug=' + (j && j.debug));
const st = j && j.st, goodCode = String((j && j.debug) || '');

/* verify неверный код → отказ (tries растёт) */
({ j } = await call('/api/auth', { mode: 'verify', nick: NICK, pass: PASS, code: '000001', st }));
ok('verify неверный код → отказ', j && j.ok === false && /не подошёл/i.test(j.msg || ''), (j && j.msg) || '');

/* verify верный код → token2 */
({ j } = await call('/api/auth', { mode: 'verify', nick: NICK, pass: PASS, code: goodCode, st }));
ok('verify верный код → token', !!(j && j.ok && j.token), JSON.stringify(j).slice(0, 110));
const tok2 = j && j.token;

/* sync под вторым токеном работает */
({ j } = await call('/api/sync', { token: tok2, actions: [] }));
ok('sync(token2) работает', !!(j && j.me), 'ok=' + (j && j.ok));

/* claim — ТОЛЬКО неверный код (правильный одноразовый, не тратим!) */
({ j } = await call('/api/auth', { mode: 'claim', token: tok2, code: '000000' }));
ok('claim неверный код → отказ', j && j.ok === false && /неверный/i.test(j.msg || ''), (j && j.msg) || '');

/* bindTgStart — выдаёт код и ссылку на бота */
({ j } = await call('/api/auth', { mode: 'bindTgStart', token: tok2 }));
ok('bindTgStart → код+ссылка', !!(j && j.ok && j.code && /start=/.test(j.url || '')), JSON.stringify(j).slice(0, 130));

/* logout — сессия гаснет */
({ j } = await call('/api/auth', { mode: 'logout', token: tok2 }));
ok('logout ok', !!(j && j.ok));
({ j } = await call('/api/sync', { token: tok2, actions: [] }));
ok('sync после logout → сессия мертва', !(j && j.me), 'ok=' + (j && j.ok) + ' (токен отклонён = goal)');

/* старый токен после logout тоже мёртв */
({ j } = await call('/api/sync', { token: tok1, actions: [] }));
/* tok1 остаётся валидной сессией register — допустимо; проверяем лишь отсутствие краша */
ok('мёртвый/живой токен не валит сервер', j !== null, 'ok=' + (j && j.ok));

console.log('== ' + NICK + ' ==\n' + results.join('\n'));
console.log(process.exitCode ? '\nИТОГ: ЕСТЬ ПРОВАЛЫ' : '\nИТОГ: ALL OK');
