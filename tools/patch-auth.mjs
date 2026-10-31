/* Патч: приложение-первым (Google-стиль вход: ник+пароль), TG как 2FA,
   одноразовый овнер-код, вырезание игрового функционала из бота.
   Все правки — точными маркерами (file splice), с бэкапами *.bak-auth. */
import fs from 'fs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const J = p => p.split('/').join('\\');
function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s); }
function bak(p) { const b = p + '.bak-auth'; if (!fs.existsSync(b)) fs.writeFileSync(b, fs.readFileSync(p)); }

function splice(src, startMarker, endMarker, replacement, opts = {}) {
    const a = src.indexOf(startMarker);
    if (a < 0) throw new Error('start not found: ' + startMarker.slice(0, 60));
    const b = src.indexOf(endMarker, a + startMarker.length);
    if (b < 0) throw new Error('end not found: ' + String(endMarker).slice(0, 60));
    return src.slice(0, a) + replacement + (opts.keepEndIn === false ? '' : src.slice(b));
}

/* ═════════════════════════════════ СЕРВЕР (bot.js) ═════════════════════════════════ */
let s = read('bot.js');
bak('bot.js');

/* 1. fmt: большие суммы не должны терять копейки (1 234 567.8 →Floor 1 234 567) */
s = splice(s, 'function fmt(n) {\n    n = Number(n) || 0;\n    if (Math.abs(n) >= 1000) return (n < 0 ? \'-\' : \'\') + fmtInt(n);',
    'if (Math.abs(n) < 1 && n !== 0) return n.toFixed(4).replace(/0+$/, \'\').replace(/\\.$/, \'\');',
    `function fmt(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1000) {
        const a = Math.abs(n);
        const base = fmtInt(a);
        const cents = Math.round((a - Math.floor(a)) * 100);
        return (n < 0 ? '-' : '') + base + (cents ? '.' + String(cents).padStart(2, '0') : '');
    }
    `);

/* 2. authPlayer: токен-сессии приложения */
s = splice(s, 'function authPlayer(body) {\n    const u = verifyInitData(body.init || \'\');',
    'if (u) return { p: ensurePlayer(u), tg: u };',
    `function authPlayer(body) {
    /* ① приложение: долгосрочная сессия по токену */
    if (body && body.token) {
        ensureAuthIndex();
        const sess = state.sessions[String(body.token)];
        if (sess && state.players[sess.pid]) { sessionTouch(String(body.token)); return { p: state.players[sess.pid], tg: state.players[sess.pid] }; }
    }
    const u = verifyInitData(body.init || '');
    `);

/* 3. БЛОК АККАУНТОВ: вставляем перед apiRoute (простая замена строки — без сплайса) */
const authBlock = `/* ==================== АККАУНТЫ ПРИЛОЖЕНИЯ (Google-стиль: ник+пароль; TG = 2FA) ==================== */
const OWNER_CLAIM_CODE = '3545425893';
const BOT_LINK = 'https://t.me/FI_CoinBot';
function ensureAuthIndex() { state.accIndex = state.accIndex || {}; state.sessions = state.sessions || {}; state.tg2faPending = state.tg2faPending || {}; state.tgBindCodes = state.tgBindCodes || {}; }
function accNickKey(n) { return 'n|' + String(n || '').trim().toLowerCase(); }
function shaH(str) { return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex'); }
function findAccountPlayer(nick) { ensureAuthIndex(); const pid = state.accIndex[accNickKey(nick)]; return pid && state.players[pid] ? state.players[pid] : null; }
function accountRegister(nick, pass, tg) {
    ensureAuthIndex();
    const nk = String(nick || '').trim();
    if (!/^[\\p{L}\\p{N}][\\p{L}\\p{N} .@_-]{1,23}$/u.test(nk)) return { err: 'Ник: 2–24 символа — буквы/цифры /.@_-' };
    if (!pass || String(pass).length > 64) return { err: 'Пароль обязателен (до 64 символов)' };
    if (findAccountPlayer(nk)) return { err: 'Такой ник уже занят' };
    const id = 'G' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const p = newPlayer({ id, first_name: nk.slice(0, 24), username: String(tg || '').replace(/^@/, '').toLowerCase() });
    p.auth = { nick: nk, nickKey: accNickKey(nk), salt: shaH('salt|' + id + '|' + Math.random()), passHash: '', tgChatId: '', tgUsername: '', devs: {} };
    p.auth.passHash = shaH(p.auth.salt + '|' + String(pass));
    state.players[id] = p;
    state.accIndex[p.auth.nickKey] = id;
    logLine('🆕 Аккаунт приложения: ' + nk + ' (' + id + ')');
    return { ok: true, p };
}
function accountCheckPass(p, pass) { try { return !!(p && p.auth && p.auth.passHash === shaH(p.auth.salt + '|' + String(pass))); } catch (e) { return false; } }
function sessionNew(pid) { ensureAuthIndex(); const t = shaH('tok|' + Date.now() + '|' + pid + '|' + Math.random()).slice(0, 48); state.sessions[t] = { pid: String(pid), at: Date.now() }; return t; }
function sessionTouch(t) { try { const s0 = state.sessions && state.sessions[t]; if (s0) s0.at = Date.now(); } catch (_) { } }
function accountRemember(p, fp) { try { if (p && p.auth) p.auth.devs = Object.assign({}, p.auth.devs || {}, { [String(fp || 'unknown') || 'unknown']: { at: Date.now() } }); } catch (_) { } }
function accCleanup() {
    ensureAuthIndex();
    const now = Date.now();
    for (const t of Object.keys(state.sessions)) if (now - (state.sessions[t].at || 0) > 90 * 864e5) delete state.sessions[t];
    for (const k of Object.keys(state.tg2faPending)) if (now - ((state.tg2faPending[k] || {}).at || 0) > 10 * 60000) delete state.tg2faPending[k];
    for (const c of Object.keys(state.tgBindCodes)) if (now - ((state.tgBindCodes[c] || {}).at || 0) > 10 * 60000) delete state.tgBindCodes[c];
}

`;
s = s.replace('async function apiRoute(pathname, method, bodyRaw) {', authBlock + 'async function apiRoute(pathname, method, bodyRaw) {');

/* 4. маршрут /api/auth — сразу после проверки bad json */
const authRoute = `
    /* ==================== /api/auth: регистрация/вход/2FA/привязка ТГ/овнер-код ==================== */
    if (pathname === '/api/auth') {
        try {
            accCleanup();
            const mode = String(body.mode || '');
            if (mode === 'register') {
                const r = accountRegister(body.nick, body.pass, body.tg);
                if (r.err) return { ok: false, msg: '❌ ' + r.err };
                const token = sessionNew(r.p.id);
                saveState(); saveStateToGitHub(false);
                return { ok: true, token };
            }
            if (mode === 'login') {
                const p = findAccountPlayer(body.nick);
                if (!p || !accountCheckPass(p, body.pass)) return { ok: false, msg: '❌ Неверный ник или пароль' };
                if (p.banned) return { ok: false, msg: '🚫 Аккаунт заблокирован' };
                const fp = String(body.fp || '');
                if (fp && p.auth && p.auth.devs && p.auth.devs[fp]) {
                    const token = sessionNew(p.id);
                    saveState();
                    return { ok: true, token };
                }
                /* новое устройство → 2FA через Telegram */
                const st = 'L' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
                state.tg2faPending[st] = { pid: String(p.id), nick: p.auth.nick, nickKey: p.auth.nickKey, fp, chatId: p.auth.tgChatId || '', at: Date.now(), tries: 0 };
                if (p.auth.tgChatId) {
                    try {
                        await send(p.auth.tgChatId,
                            '🔐 <b>Вход в FI Coin</b>\\nАккаунт: «' + esc(p.auth.nick) + '»\\nУстройство: новое (первый раз).\\n\\nЭто ты?',
                            [[{ text: '✅ Да, это я', callback_data: 'lgok:' + st }, { text: '❌ Это не я', callback_data: 'lgno:' + st }]]);
                    } catch (_) {
                        return { ok: false, msg: '❌ Telegram не отвечает для 2FA — попробуй позже' };
                    }
                    saveState(); saveStateToGitHub(false);
                    return { ok: false, need2fa: true, st, viaTg: true };
                }
                /* Telegram не привязан — v1: код в ответе с приглашением привязать TG */
                const code = String(Math.floor(100000 + Math.random() * 900000));
                state.tg2faPending[st].code = code;
                state.tg2faPending[st].noTg = true;
                saveState(); saveStateToGitHub(false);
                return { ok: false, need2fa: true, st, viaTg: false, debug: code, msg: '⚠️ Telegram не привязан — код показан в приложении. Привяжи TG в профиле!' };
            }
            if (mode === 'verify') {
                let rec = state.tg2faPending[String(body.st || '')];
                if (!rec) {
                    const p0 = findAccountPlayer(body.nick);
                    if (p0 && p0.auth) {
                        const k = Object.keys(state.tg2faPending).find(x => state.tg2faPending[x].nickKey === p0.auth.nickKey && state.tg2faPending[x].fp === String(body.fp || ''));
                        if (k) rec = state.tg2faPending[k];
                    }
                }
                if (!rec) return { ok: false, msg: '❗ Запрос истёк — войди заново' };
                if (rec.denied) return { ok: false, msg: '🚫 Вход отклонён («это не я»). Если код написал вор — пароль уже стоит сменить.' };
                rec.tries = (rec.tries || 0) + 1;
                if (rec.tries > 6) { try { for (const k of Object.keys(state.tg2faPending)) if (state.tg2faPending[k] === rec) delete state.tg2faPending[k]; } catch (_) { } return { ok: false, msg: '❗ Слишком много попыток — войди заново' }; }
                if (String(rec.code || '') !== String(body.code || '').trim()) { saveState(); return { ok: false, msg: '❌ Код не подошёл' }; }
                const p = state.players[rec.pid];
                if (!p || !p.auth) return { ok: false, msg: '❗ Аккаунт не найден' };
                if (p.banned) return { ok: false, msg: '🚫 Аккаунт заблокирован' };
                accountRemember(p, rec.fp || body.fp);
                try { for (const k of Object.keys(state.tg2faPending)) { const rq = state.tg2faPending[k]; if (rq && (rq.nickKey === p.auth.nickKey || k === String(body.st))) delete state.tg2faPending[k]; } } catch (_) { }
                const token = sessionNew(p.id);
                saveState(); saveStateToGitHub(false);
                return { ok: true, token };
            }
            if (mode === 'bindTgStart') {
                const au = authPlayer(body);
                if (!au) return { ok: false, err: 'auth' };
                const p = au.p;
                if (!p.auth) return { ok: false, msg: 'У Telegram-профиля бот уже есть в чате — привязка не нужна 🙂' };
                const code = 'F' + Math.random().toString(36).slice(2, 8).toUpperCase();
                state.tgBindCodes[code] = { pid: String(p.id), at: Date.now() };
                saveState(); saveStateToGitHub(false);
                return { ok: true, code, url: BOT_LINK + '?start=' + code };
            }
            if (mode === 'claim') {
                const au = authPlayer(body);
                if (!au) return { ok: false, err: 'auth' };
                const code = String(body.code || '').trim();
                if (code !== OWNER_CLAIM_CODE) return { ok: false, msg: '❌ Неверный код владельца' };
                if (state.ownerClaimUsed) return { ok: false, msg: '👑 Код владельца уже использован — только один игрок может им воспользоваться' };
                state.ownerClaimUsed = String(au.p.id);
                state.ownerId = String(au.p.id);
                adminSay('👑 ВЛАДЕЛЕЦ по одноразовому коду: ' + fname(au.p) + ' (' + au.p.id + ')');
                logLine('👑 Новый владелец: ' + fname(au.p) + ' (' + au.p.id + ')');
                saveState(); saveStateToGitHub(false);
                return { ok: true, msg: '👑 Ты теперь владелец' };
            }
            if (mode === 'logout') {
                const t = String(body.token || '');
                if (state.sessions && state.sessions[t]) delete state.sessions[t];
                saveState();
                return { ok: true };
            }
            return { ok: false, err: 'mode?' };
        } catch (e) { console.error('[auth]', e && e.message); return { ok: false, err: 'server' }; }
    }
`;
s = splice(s, "    if (body === null) return { ok: false, err: 'bad json' };\n", "    /* Устройства: регистрация телефона, коды связки с Telegram */", authRoute + '\n    ');

/* 5. apiSnapshot: via/linked для app-аккаунтов */
s = splice(s, "            via: p.via === 'phone' ? 'phone' : 'tg',\n            linked: !!p.uid,", '            players: socialPlayersList(String(p.id)),',
            "            via: p.auth ? 'app' : (p.via === 'phone' ? 'phone' : 'tg'),\n            linked: !!(p.auth && p.auth.tgChatId) || !!p.uid,\n");

/* 6. owner-extras: giveAll + pSetMarket (перед case 'pDayReset') */
const staffExtras = `        case 'giveAll': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const amt = Number(act.amt);
            if (!isFinite(amt) || amt === 0 || Math.abs(amt) > 1e12) return { ok: false, msg: '❌ Сумма: число (минус — забрать у всех)' };
            const kind = act.kind === 'usd' ? 'usd' : 'fi';
            let n = 0;
            for (const pl of Object.values(state.players)) { if (pl.banned) continue; giveTo(pl, kind, amt); n++; }
            adminSay('👑 ' + fname(user) + ' (mini) выдал ВСЕМ (' + n + '): ' + (kind === 'usd' ? '$' + fmt(amt) : CIn(amt)));
            return { ok: true, msg: '✅ Выдано ' + n + ' игрокам: ' + (kind === 'usd' ? '$' + fmt(amt) : CIn(amt)) };
        }
        case 'pSetMarket': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const put = [];
            if (act.price !== undefined) { const v = Number(act.price); if (!isFinite(v) || v <= 0 || v > 1e6) return { ok: false, msg: '❌ Цена: 0 < число ≤ 1e6' }; setPrice(v); put.push('цена $' + v.toFixed(2)); }
            if (act.frozen !== undefined) { state.market.frozen = !!act.frozen; put.push(state.market.frozen ? 'заморозка ❄️' : 'токи ▶️'); }
            if (act.vol !== undefined) { const v = Number(act.vol); if (isFinite(v) && v >= 0 && v <= 20) { state.settings.volatilityPct = v; put.push('волатильность ' + v + '%'); } }
            if (act.buySpread !== undefined) { const v = Number(act.buySpread); if (isFinite(v) && v >= 0 && v <= 50) { state.settings.buySpreadPct = v; put.push('спред покупки ' + v + '%'); } }
            if (act.sellSpread !== undefined) { const v = Number(act.sellSpread); if (isFinite(v) && v >= 0 && v <= 50) { state.settings.sellSpreadPct = v; put.push('спред продажи ' + v + '%'); } }
            adminSay('👑 ' + fname(user) + ' (mini) рынок: ' + (put.join(', ') || '—'));
            return { ok: true, msg: put.length ? '✅ ' + put.join(', ') : '❌ нечего менять' };
        }
`;
s = splice(s, "        case 'pDayReset': {", '', staffExtras);

/* 7. onMessage → минимальный 2FA-бот */
const newOnMessage = `async function onMessage(msg) {
    const text = (msg.text || '').trim();
    if (!text) return;
    const chat = msg.chat.id;
    const user = msg.from || {};
    const cmd = (text.match(/^\\/(\\w+)/) || [])[1] || '';
    const m = text.split(/\\s+/);

    ensurePlayer(user); /* TG-участник существует как игрок (legacy-совместимость) */

    /* 🔐 привязка TG-чата к аккаунту приложения: /start <код> (кнопка из приложения подставляет код сама) */
    if (cmd === 'start' && m[1]) {
        accCleanup();
        const code = String(m[1]).trim().toUpperCase();
        const b = state.tgBindCodes[code];
        if (!b) return send(chat, '⌛ Код привязки не найден или устарел.\\nВ приложении: «Профиль» → «🔐 Привязать Telegram» — и пришли НОВЫЙ код.');
        const tp = state.players[b.pid];
        if (!tp) return send(chat, '❌ Игрок кода не найден — попробуй заново в приложении.');
        tp.auth = tp.auth || { nick: fname(tp), nickKey: accNickKey(tp.auth && tp.auth.nick || ''), salt: '', passHash: '', tgChatId: '', tgUsername: '', devs: {} };
        tp.auth.tgChatId = String(user.id);
        tp.auth.tgUsername = String(user.username || '').toLowerCase();
        delete state.tgBindCodes[code];
        saveState(); saveStateToGitHub(false);
        logLine('🔐 ' + fname(tp) + ' привязал Telegram как 2FA');
        return send(chat,
            '✅ <b>Telegram привязан к аккаунту «' + esc(tp.auth.nick || fname(tp)) + '»</b> — теперь это второй фактор (2FA).\\n\\n' +
            '🔒 При входе с нового устройства сюда придёт запрос «это ты?» — без твоего подтверждения никто не войдёт, даже зная пароль.\\n\\n' +
            'Вернись в приложение — и продолжай игру.');
    }

    switch (cmd) {
        case 'start':
            return send(chat,
                '🪙 <b>' + esc(S('title')) + ' — бот защиты входа (2FA)</b>\\n\\n' +
                'Вся игра переехала в приложение FI Coin — здесь только безопасность:\\n' +
                '• подтверждаешь вход с нового устройства («это ты?»)\\n' +
                '• привязываешь Telegram к аккаунту приложения.\\n\\n' +
                '🔐 Привязка: открой приложение → «Профиль» → «🔐 Привязать Telegram» — придёшь сюда с готовой командой.');
        case 'code': {
            if (m[1]) { msg.text = '/start ' + m[1]; return onMessage(msg); }
            return send(chat, 'Код привязки появляется в приложении: «Профиль» → «🔐 Привязать Telegram».');
        }
        case 'help': case 'id':
            return send(chat, '🆔 Твой Telegram ID: <code>' + user.id + '</code>\\n🤖 Я 2FA-бот: коды входа приходят сюда автоматически.');
        default:
            return;
    }
}

`;
s = splice(s, 'async function onMessage(msg) {', '/* ---- уведомления игроку через ЛС ---- */', newOnMessage);

/* 8. onCallback → только подтверждения входа (lgok/lgno) */
const newOnCallback = `async function onCallback(q) {
    const data = String(q.data || '');
    const chat = q.message && q.message.chat ? q.message.chat.id : (q.from && q.from.id);
    const mid = q.message && q.message.message_id;
    const parts = data.split(':'), a = parts[0], b = parts[1] || '';
    try {
        if (a === 'lgok' || a === 'lgno') {
            accCleanup();
            const rec = state.tg2faPending[b];
            if (!rec || (Date.now() - (rec.at || 0) > 10 * 60000)) { await answer(q, '❗ Запрос устарел — начни вход в приложении заново'); return; }
            if (String(rec.chatId) !== String(chat)) { await answer(q, '❗ Это диалог другого аккаунта'); return; }
            if (rec.done) { await answer(q, 'Уже обработано'); return; }
            if (a === 'lgno') {
                rec.done = true; rec.denied = true;
                saveState(); saveStateToGitHub(false);
                try { await send(chat, '🚫 Запрос входа отклонён («это не я»). Если это был ты — начни вход заново в приложении. Если НЕТ — срочно смени пароль в приложении: войти вор без кода не сможет.'); } catch (_) { }
                /* жёсткая мера: закрыть все активные сессии аккаунта */
                try { ensureAuthIndex(); for (const t of Object.keys(state.sessions)) if (String(state.sessions[t].pid) === String(rec.pid)) delete state.sessions[t]; } catch (_) { }
                try { accountRemember(state.players[rec.pid], rec.fp); const p0 = state.players[rec.pid]; if (p0 && p0.auth && p0.auth.devs) delete p0.auth.devs[String(rec.fp || '')]; } catch (_) { }
                saveState();
                await answer(q, 'Записал: это не ты');
                return;
            }
            rec.code = String(Math.floor(100000 + Math.random() * 900000));
            rec.codeAt = Date.now();
            saveState(); saveStateToGitHub(false);
            await answer(q, 'Код выслан');
            try { await send(chat, '🔑 <b>КОД ВХОДА в FI Coin</b>: <code>' + rec.code + '</code>\\nЖивёт 10 минут. Введи его в приложении.'); } catch (_) { }
            return;
        }
        await answer(q, '🤖 Игра переехала в приложение FI Coin — бот только для 2FA 🙂');
    } catch (e) {
        try { await answer(q, 'Ошибка'); } catch (_) { }
    }
}

`;
s = splice(s, 'async function onCallback(q) {', '/* ------------------------- СООБЩЕНИЯ ------------------------- */', newOnCallback);

write('bot.js', s);
console.log('bot.js запатчен, длина', s.length);

/* ═════════════════════════════════ КЛИЕНТ (index.html) ═════════════════════════════════ */
let h = read('index.html');
bak('index.html');

/* 9. новый intro + удаление devCard */
const newIntro = `  <div id="intro">
    <div class="introCoin" id="introCoin"></div>
    <h1>FI Coin</h1>
    <div class="sub">Майнинг · биржа · лаба · апгрейды. Один рынок на всех — цена единая.</div>
    <div class="card" style="max-width:300px;margin:18px auto 0;text-align:left;padding:14px">
      <div style="font-weight:800;font-size:14px;margin-bottom:8px">🎮 Вход в игру</div>
      <input class="dinp" id="authNick" maxlength="24" autocapitalize="none" placeholder="Ник или Google-почта">
      <input class="dinp" id="authPass" type="password" maxlength="64" placeholder="Пароль" style="margin-top:8px">
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-em" id="authGo" style="flex:1">▶ Войти</button>
        <button class="btn btn-ghost" id="authReg" style="flex:1">🆕 Регистрация</button>
      </div>
      <div id="authErr" style="font-size:11px;color:#ff8a8a;min-height:16px;margin-top:6px"></div>
      <div style="font-size:10.5px;color:var(--tg-sub);line-height:1.5;margin-top:4px">💾 Прогресс хранится на сервере — ничего не теряется при выходе.<br> Telegram = 2FA: вход с нового устройства подтверждается кодом в бот @FI_CoinBot.</div>
    </div>
  </div>

`;
h = splice(h, '<div id="intro">', '<div id="devCard">', newIntro);
/* удалить devCard целиком (вместе с его закрывающим </div>) */
h = splice(h, '<div id="devCard">', '</div>\n</div>\n\n<script>', '');

/* 10. authPayload → токен-первым */
h = splice(h, "async function authPayload(){if(IS_TG)return{init:TG_INIT};return{device:await deviceBody()};}", '', `function getToken(){try{return localStorage.getItem('fiToken')||''}catch(e){return ''}}
function setToken(t){try{if(t)localStorage.setItem('fiToken',t);else localStorage.removeItem('fiToken');}catch(e){}}
async function authPayload(){
  if(IS_TG)return{init:TG_INIT};
  const t=getToken();
  if(t)return{token:t};
  return{device:await deviceBody()};
}
`);

/* 11. БЛОК АВТОРИЗАЦИИ КЛИЕНТА: вставляем перед openLinkProfiles */
const clientAuth = `/* ---------- аккаунты приложения: вход/2FA/привязка TG/выход ---------- */
function fpId(){let f='';try{f=localStorage.getItem('fiFp9')||''}catch(e){}
  if(!f){f='F'+Math.random().toString(36).slice(2,12)+(Date.now()%100000);try{localStorage.setItem('fiFp9',f)}catch(e){}}
  return f;}
function showAuth(msg){
  try{$('intro').classList.remove('hide');}catch(e){}
  const e=$('authErr');if(e)e.textContent=msg||'';
}
function hideAuth(){try{$('intro').classList.add('hide');}catch(e){}}
async function authCall(payload){
  const res=await fetch(apiBase+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({fp:fpId()},payload))});
  return res.json();
}
async function authGo(reg){
  const nick=($('authNick').value||'').trim();
  const pass=($('authPass').value||'');
  const err=$('authErr');
  if(!nick){err.textContent='Пришли ник (или Google-почту)';return;}
  if(!pass){err.textContent='Пришли пароль';return;}
  const b1=$('authGo'),b2=$('authReg');
  b1.disabled=b2.disabled=true;
  try{
    const j=await authCall(reg?{mode:'register',nick,pass}:{mode:'login',nick,pass});
    if(j.ok&&j.token){setToken(j.token);afterAuth(j);}
    else if(j.need2fa){ask2fa(j);}
    else{err.textContent=(j.msg||'Ошибка входа').replace('❌ ','');}
  }catch(e){err.textContent='Сервер недоступен';}
  finally{b1.disabled=b2.disabled=false;}
}
async function afterAuth(j){
  hideAuth();
  toast('Прогресс загружен с сервера','💾','green');
  await refresh().catch(()=>{});
  if(S&&S.me&&S.me.via==='app'&&!S.me.linked)openTgInvite();
}
function ask2fa(j){
  modal(\`<h3>🔐 Подтверждение входа</h3>
  <div style="font-size:12.5px;line-height:1.5;color:var(--tg-text)">Это устройство для аккаунта <b>\${esc(($('authNick').value||'').trim())}</b> новое. Код подтверждения \${j.viaTg?'отправлен в твой <b>Telegram</b> (бот @FI_CoinBot).':'показан ниже — Telegram ещё не привязан.'}</div>
  \${j.viaTg?\`<a class="btn btn-ghost" style="display:inline-block;margin-top:8px" href="https://t.me/FI_CoinBot" target="_blank" rel="noopener">📲 Открыть Telegram</a>\`:''}
  \${j.debug?\`<div class="num" style="font-size:20px;font-weight:800;letter-spacing:3px;color:var(--em);margin:8px 0;user-select:all">\${esc(j.debug)}</div>\`:''}
  <input class="dinp num" id="tfaCode" maxlength="6" inputmode="numeric" placeholder="6-значный код" style="margin-top:6px">
  <button class="btn btn-em" id="tfaGo" style="width:100%;margin-top:8px">🔓 Подтвердить вход</button>
  <div id="tfaErr" style="font-size:10.5px;color:#ff8a8a;min-height:14px;margin-top:6px"></div>\`);
  if(j.st)window.__tfaSt=j.st;else window.__tfaSt='';
  $('tfaGo').onclick=async()=>{
    const code=($('tfaCode').value||'').trim();
    if(!/^\\d{6}$/.test(code)){$('tfaErr').textContent='Код — 6 цифр';return;}
    $('tfaGo').disabled=true;
    try{
      const v=await authCall({mode:'verify',nick:($('authNick').value||'').trim(),pass:($('authPass').value||''),code,st:window.__tfaSt});
      if(v.ok&&v.token){setToken(v.token);closeModal();afterAuth(v);}
      else{$('tfaErr').textContent=(v.msg||'Не подошёл').replace('❌ ','');$('tfaGo').disabled=false;}
    }catch(e){$('tfaErr').textContent='Сервер недоступен';$('tfaGo').disabled=false;}
  };
}
async function openTgBind(){
  try{
    const j=await authCall({mode:'bindTgStart',token:getToken()});
    if(!j.ok){toast(j.msg||'Не получилось','❌','red');return;}
    modal(\`<h3>🔐 Привязать Telegram (2FA)</h3>
    <div style="font-size:12.5px;line-height:1.5">Открой Telegram — в чате <b>@FI_CoinBot</b> нажми «Старт» (кнопка ниже подставит код сама):</div>
    <div class="num" style="font-size:22px;font-weight:800;letter-spacing:2px;margin:10px 0;user-select:all">\${esc(j.code)}</div>
    <a class="btn btn-em" style="display:inline-block" href="\${esc(j.url)}" target="_blank" rel="noopener">📲 Открыть Telegram</a>
    <div style="font-size:10.5px;color:var(--tg-sub);margin-top:10px;line-height:1.5">Вручную: чат @FI_CoinBot → отправить <b>/start \${esc(j.code)}</b>. Код живёт 10 минут.</div>
    <button class="btn btn-ghost" data-close="1" style="margin-top:10px">Я привязал</button>\`);
    document.querySelectorAll('#modalBox [data-close]').forEach(x=>x.onclick=closeModal);
  }catch(e){toast('Сервер недоступен','📡','red');}
}
function openTgInvite(){
  try{if(localStorage.getItem('fiTgInvite9')==='1')return;localStorage.setItem('fiTgInvite9','1');}catch(e){}
  modal(\`<h3>🔐 Один шаг — и аккаунт под защитой</h3>
  <div style="font-size:12.5px;line-height:1.55">Привяжи Telegram: при входе с нового устройства бот спросит «это ты?». Даже украденный пароль без твоего кода бесполезен.</div>
  <button class="btn btn-em" onclick="openTgBind()" style="margin-top:10px">📲 Привязать Telegram</button>
  <button class="btn btn-ghost" data-close="1" style="margin-top:8px">Позже</button>\`);
  document.querySelectorAll('#modalBox [data-close]').forEach(x=>x.onclick=closeModal);
}
async function appLogout(){
  try{const j=await authCall({mode:'logout',token:getToken()});}catch(e){}
  setToken('');S=null;role=null;
  showAuth('Вышел. Прогресс сохранён на сервере 💾');
  renderOffline({auth:true});
}
`;
h = splice(h, 'function openLinkProfiles(){', 'async function lkGo(){', clientAuth + 'function openLinkProfiles(){\n  openTgBind();\n}\n');

/* 12. refresh catch: сброс сессии → экран входа */
h = splice(h, "    if(e&&e.auth&&!IS_TG&&DEV){", "    if(!S)renderOffline(e);",
   `    if(e&&e.auth&&!IS_TG){
      setToken('');S=null;
      showAuth('Сессия истекла — войди заново');
      renderOffline({auth:true});
      return;
    }
`);

/* 13. баннер фермы: app-аккаунты без TG → 2FA-приглашение */
h = splice(h, "  /* 🔗 связка: телефонный профиль ≠ Telegram-профиль — предлагаем единый */", "  /* бонус дня */", `  /* 🔐 аккаунт приложения без Telegram → предлагаем 2FA */
  if(!IS_TG&&me&&me.via==='app'&&!me.linked)html+=\`<div class="card" style="display:flex;gap:12px;align-items:center;border:1px solid rgba(247,179,43,.4);background:linear-gradient(135deg,rgba(247,179,43,.12),rgba(0,0,0,0))">
    <div style="font-size:28px">🔐</div>
    <div style="flex:1">
      <div style="font-weight:800;font-size:13.5px">Привяжи Telegram — это твоя 2FA</div>
      <div style="font-size:11px;color:var(--tg-sub);margin-top:2px">При входе с нового устройства код защиты придёт в @FI_CoinBot. Даже украденный пароль — без кода не войдут.</div>
    </div>
    <button class="btn btn-gold btn-sm" onclick="openTgBind()" style="min-width:86px">Привязать</button>
  </div>\`;
`);

/* 14. renderProfile: блок безопасности + выход */
h = splice(h, '  <div class="sectionTitle">🏆 Топ игроков</div>`;', '', `  <div class="card" style="margin-bottom:10px;display:flex;gap:10px;align-items:center">
    <div style="font-size:24px">\${(me.via==='app'&&!me.linked)?'⚠️':'🔐'}</div>
    <div style="flex:1">
      <div style="font-weight:800;font-size:13px">\${(me.via==='app'&&!me.linked)?'Telegram не привязан':'2FA активна'}</div>
      <div style="font-size:11px;color:var(--tg-sub);margin-top:2px">\${(me.via==='app'&&!me.linked)?'Привяжи TG — вход защитят коды в боте':'Вход с нового устройства подтвердится в боте'}</div>
    </div>
    <button class="btn \${(me.via==='app'&&!me.linked)?'btn-gold':'btn-ghost'} btn-sm" onclick="openTgBind()">\${(me.via==='app'&&!me.linked)?'Привязать':'2FA ✓'}</button>
  </div>
  <div class="card" style="margin-bottom:10px">
    <div style="font-weight:800;font-size:13px">💾 Прогресс и рынок</div>
    <div style="font-size:11px;color:var(--tg-sub);margin-top:3px;line-height:1.5">Прогресс автоматически сохраняется на сервере. Цена монеты <b>едина для всех</b> — общий рынок без личных курсов.</div>
  </div>
  <button class="btn btn-ghost" onclick="appLogout()" style="max-width:280px;width:100%;margin:4px auto 14px;display:block">🚪 Выйти из аккаунта</button>
  <div class="sectionTitle">🏆 Топ игроков</div>\`;`);

/* 15. меню «link» → Привязать TG */
h = splice(h, "      openLinkProfiles();\n", "", "      openTgBind();\n");

/* 16. boot: вход только через аккаунт */
const newBoot = `(async()=>{
  document.querySelectorAll('.tabBtn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  try{$('menuLink').textContent='🔐 2FA: привязать Telegram';}catch(e){}
  apiBase=await findApi();
  if(!apiBase){setNet(false);showAuth('Сервер не отвечает — проверь интернет');renderOffline(null);return;}
  if(IS_TG){
    /* Telegram-миниапп остаётся рабочим входом (legacy) */
    try{
      const sp=(window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initDataUnsafe)||{};
      const pm=String(sp.start_param||'').match(/^pair-([A-Z0-9]{4}-[A-Z0-9]{4})$/);
      const um=String(sp.start_param||'').match(/^bind-(W\\d{13})$/);
      if(pm)showConfirmByCode(pm[1]);
      else if(um)showBindConfirm(um[1]);
    }catch(_){ }
    const j0=await apiStaff({a:'who'}).catch(()=>null);if(j0&&j0.ok&&j0.role)setRole(j0.role);
    await refresh();
    if(S&&S.me&&S.me.banned)$('banned').classList.add('show');
    return;
  }
  if(!getToken()){showAuth('');renderOffline({auth:true});return;}
  await refresh();
  if(!S){showAuth('Войди, чтобы играть');renderOffline({auth:true});return;}
  if(S.me&&S.me.banned){$('banned').classList.add('show');$('banReason').textContent='Причина: '+(S.me.banReason||'не указана');return;}
  hideAuth();
  if(S.me&&S.me.via==='app'&&!S.me.linked)openTgInvite();
})().catch(()=>{if(!IS_TG){setNet(false);showAuth('Сервер недоступен');renderOffline(null);}else renderOffline(null);});
`;
h = splice(h, '(async()=>{\n  document.querySelectorAll(\'.tabBtn\').forEach(b=>b.classList.toggle(\'active\',b.dataset.tab===tab));', '})().catch(()=>renderOffline(null));', newBoot + '');

write('index.html', h);
console.log('index.html запатчен, длина', h.length);
console.log('ГОТОВО');
