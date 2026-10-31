#!/usr/bin/env node
/* ============================================================
   FI MINING BOT v7.1 — настоящий Telegram-бот (без зависимостей)
   Чистый Node.js (v18+). Ничего устанавливать не нужно.
   Запуск:  node bot.js   (или start-fi-bot.bat)
   Настройка: config.json (токен, пароль консоли, майнеры)
   Все игровые параметры и «тема» меняются прямо из STAFF-консоли.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

/* ------------------------- РЕЖИМ ОБЛАКА (Deno Deploy) -------------------------
   FI_CLOUD=1 → состояние игры живёт в GitHub-зеркале (как и на ПК),
   сервер Telegram работает по WEBHOOK (бесконечный опрос не нужен),
   тики рынка «догоняются» от state.lastTick при каждом входящем запросе. */
/* обёртки (bot-worker.js / bot-cloud.js) передают окружение через globalThis.FI_ENV:
   в Cloudflare Workers process.env доступен только на чтение, записи в него теряются */
const envGet = k => {
    const E = (typeof globalThis !== 'undefined' && globalThis.FI_ENV) || (typeof process !== 'undefined' && process.env) || {};
    const v = E[k];
    return String(v === undefined || v === null ? '' : v);
};
const CLOUD = envGet('FI_CLOUD') === '1';
const TG_WEBHOOK_SECRET = envGet('TG_WEBHOOK_SECRET');
let CATCHING_UP = false;

/* ------------------------- КОНФИГ-ФАЙЛ ------------------------- */
const CFG_PATH = path.join(__dirname, 'config.json');
const DATA_PATH = path.join(__dirname, 'data', 'state.json');

const DEFAULT_MINERS = [
    { id: 'usb', name: '⛏ FI Mini USB', hash: 0.5,  price: 120,   desc: 'Нормальная рампа для старта.' },
    { id: 's9',  name: '⛏ FI Rig S9',   hash: 14,   price: 850,   desc: 'Классический ASIC начального уровня.' },
    { id: 'm50', name: '⛏ FI Miner M50',hash: 114,  price: 4200,  desc: 'Промышленно-эффективный пенал.' },
    { id: 'avx', name: '⛏ FI Avalon X', hash: 250,  price: 11500, desc: 'Серьёзный вагон.' },
    { id: 'hyd', name: '⛏ FI Hydro H1', hash: 600,  price: 29000, desc: 'Турбинный поезд.' },
    { id: 'imm', name: '⛏ FI Immersion DC', hash: 1500, price: 75000, desc: 'Иммерсионный дата-центр.' }
];

function loadConfig() {
    const defaults = {
        token: 'ВСТАВЬ_СЮДА_ТОКЕН_ОТ_@BotFather',
        staffPassword: 'FI-ADMIN-2026',
        ownerOnlyBans: false,          // true = банить может только владелец
        minerPriceGrowth: 1.18,        // рост цены майнера за каждый купленный (+18%)
        game: {
            title: 'FI Mining Bot',
            coinName: 'FI',
            coinEmoji: '🪙',
            welcome: 'Добро пожаловать в мир FI Coin!\nДобывай, торгуй, становись крипто-олигархом.',
            startUsd: 1000,
            startFi: 0,
            startPrice: 2.40,
            fiPerThHour: 1.26,         // FI за 1 TH/s за час
            volatilityPct: 8,          // полупрожилок случайного хода за тик, %
            eventChancePct: 4,         // шанс случайной новости за тик, %
            workIntervalMin: 40,
            workPayMin: 200,
            workPayMax: 500,
            bonusDailyUsd: 500,
            bonusDailyFi: 5,
            buySpreadPct: 2,           // покупка: цена +2%
            sellSpreadPct: 2           // продажа: цена -2%
        },
        miners: DEFAULT_MINERS
    };
    let cfg;
    try {
        const disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
        cfg = Object.assign({}, defaults, disk);
        cfg.game = Object.assign({}, defaults.game, disk.game || {});
        if (!Array.isArray(cfg.miners) || !cfg.miners.length) cfg.miners = defaults.miners;
    } catch (e) {
        /* конфига нет (облако/fresh) — работаем на дефолтах; в облаке на диск не пишем */
        try { if (!CLOUD) fs.writeFileSync(CFG_PATH, JSON.stringify(defaults, null, 2), 'utf8'); } catch (_) { }
        cfg = defaults;
    }
    /* окружение имеет приоритет (Cloudflare Workers / Deno Deploy / Render): config.json не обязателен */
    const envV = k => envGet(k).trim();
    if (envV('BOT_TOKEN')) cfg.token = envV('BOT_TOKEN');
    if (envV('GH_TOKEN')) cfg.ghToken = envV('GH_TOKEN');
    if (envV('PUBLIC_URL')) cfg.publicUrl = envV('PUBLIC_URL');
    if (typeof cfg.token !== 'string') cfg.token = String(cfg.token || '');
    return cfg;
}
const CFG = loadConfig();

/* ------------------------- СОСТОЯНИЕ ------------------------- */
let state = null;

function freshState() {
    return {
        players: {}, market: null, staffIds: [], ownerId: 0,
        log: [], dialogs: {}, lastTick: 0,
        settings: Object.assign({}, CFG.game)
    };
}
function freshMarket() {
    const p0 = S('startPrice');
    return { price: p0, trend: p0, frozen: false, hist: [{ t: Date.now(), p: p0 }] };
}
function loadState() {
    state = freshState();
    try {
        const disk = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        Object.assign(state, disk);
    } catch (e) { /* новая игра */ }
    if (!state.players || typeof state.players !== 'object' || Array.isArray(state.players)) state.players = {};
    if (!state.market || typeof state.market !== 'object') state.market = freshMarket();
    state.settings = Object.assign({}, CFG.game, state.settings || {});
    if (!Array.isArray(state.staffIds)) state.staffIds = [];
    if (!Number.isFinite(state.ownerId)) state.ownerId = 0;
    if (!Array.isArray(state.customRoles)) state.customRoles = [];
    if (!state.playerRoles || typeof state.playerRoles !== 'object' || Array.isArray(state.playerRoles)) state.playerRoles = {};
    if (!Array.isArray(state.log)) state.log = [];
    if (!Array.isArray(state.duels)) state.duels = [];
    if (!Array.isArray(state.friendReqs)) state.friendReqs = [];
    if (!state.deviceVault || typeof state.deviceVault !== 'object' || Array.isArray(state.deviceVault)) state.deviceVault = {};
    if (!Array.isArray(state.linkCodes)) state.linkCodes = [];
    if (!Array.isArray(state.loginSessions)) state.loginSessions = [];
    if (!state.loginSpam || typeof state.loginSpam !== 'object') state.loginSpam = {};
    if (!state.dialogs || typeof state.dialogs !== 'object') state.dialogs = {};
    if (!Number.isFinite(state.savedAt)) state.savedAt = 0;
    if (!Number.isFinite(state.lastTick)) state.lastTick = 0;
    for (const p of Object.values(state.players)) {
        if (!p.lab || typeof p.lab !== 'object' || Array.isArray(p.lab)) p.lab = {};
        if (!p.upg || typeof p.upg !== 'object' || Array.isArray(p.upg)) p.upg = {};
        if (!p.friends || typeof p.friends !== 'object' || Array.isArray(p.friends)) p.friends = {};
        if (p.day && typeof p.day === 'object' && !Array.isArray(p.day)) { delete p.day.claimedArr; }
        dayOf(p);
    }
}
function saveState() {
    state.savedAt = Date.now();
    if (CLOUD) {
        /* облако: зеркало в GitHub — значит всё состояние надёжно сохранено */
        saveStateToGitHub(false);
        return;
    }
    try {
        fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
        /* страховка: раз в минуту копия предыдущего состояния (откат после рестартов) */
        const now = Date.now();
        if (now - lastRotate > 60000 && fs.existsSync(DATA_PATH)) {
            try { fs.copyFileSync(DATA_PATH, path.join(__dirname, 'data', 'state.prev.json')); lastRotate = now; } catch (_) { }
        }
        state.savedAt = now;
        const tmp = DATA_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, DATA_PATH);
    } catch (e) { console.error('[save]', e.message); }
}
/* быстрый доступ к настройкам */
const S = key => state.settings[key];
let lastRotate = 0;

/* ------------------------- ЛОГ ------------------------- */
function logLine(str) {
    state.log.unshift({ t: Date.now(), s: str });
    if (state.log.length > 40) state.log.length = 40;
}

/* ------------------------- ПОМОЩЬ ------------------------- */
const rng = (a, b) => a + Math.random() * (b - a);
const fmtInt = n => Math.floor(Math.abs(n)).toLocaleString('ru-RU').replace(/,/g, ' ') + (n < 0 && Math.floor(n) === 0 ? '-' : '');
function fmt(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1000) {
        const a = Math.abs(n);
        const base = fmtInt(a);
        const cents = Math.round((a - Math.floor(a)) * 100);
        return (n < 0 ? '-' : '') + base + (cents ? '.' + String(cents).padStart(2, '0') : '');
    }
    if (Math.abs(n) < 1 && n !== 0) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return n.toFixed(2);
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fname = p => esc(p && (p.nick || p.first_name || p.name) || 'Игрок'); /* nick — кастомный ник владельца, перекрывает имя из Telegram */
/* монета с текущей темой: "🪙 12.5 FI" */
const CI = amt => `${S('coinEmoji') || '🪙'} <b>${fmt(amt)}</b> ${S('coinName') || 'FI'}`;
const CIn = amt => `${S('coinEmoji') || '🪙'} ${fmt(amt)} ${S('coinName') || 'FI'}`;

const MINERS = CFG.miners;
const miner = id => MINERS.find(m => m.id === id);
const minerCost = (m, n) => Math.ceil(m.price * Math.pow(CFG.minerPriceGrowth, n));

/* ------------------------- API TELEGRAM ------------------------- */
const API = 'https://api.telegram.org/bot' + CFG.token;
const PAGES_URL = 'https://pta757f-cloud.github.io/fi-mining-bot/';

async function tg(method, params = {}) {
    for (let a = 1; a <= 3; a++) {
        try {
            const res = await fetch(API + '/' + method, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(params),
                signal: AbortSignal.timeout(65000)
            });
            const data = await res.json().catch(() => null);
            if (data && data.ok) return data.result;
            const errCode = data && data.error_code;
            if (errCode === 429) {
                const retry = (data.parameters && data.parameters.retry_after) || 3;
                await sleep((retry + 1) * 1000);
                continue;
            }
            if (errCode === 400 && data.description && data.description.includes('query is too old')) return null;
            console.error('[tg]', method, data ? data.description : 'нет ответа');
            return null;
        } catch (e) {
            console.error('[tg]', method, e.message, `(попытка ${a})`);
            if (a < 3) await sleep(3000 * a);
        }
    }
    return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(chatId, text, kb) {
    return tg('sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: kb ? { inline_keyboard: kb } : undefined
    });
}
async function edit(chatId, msgId, text, kb) {
    const ok = await tg('editMessageText', {
        chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: kb ? { inline_keyboard: kb } : undefined
    });
    return ok;
}
function answer(q, text) { return tg('answerCallbackQuery', { callback_query_id: q.id, text: text || '' }); }

/* ------------------------- ИГРОК ------------------------- */
function newPlayer(user) {
    return {
        id: user.id,
        first_name: (user.first_name || 'Игрок').slice(0, 24),
        username: (user.username || '').toLowerCase(),
        usd: S('startUsd'), fi: S('startFi'),
        miners: {}, joined: Date.now(),
        totalMined: 0, bought: 0, sold: 0, bonusDay: '', workAt: 0,
        banned: false, banReason: '', bannedAt: 0
    };
}
function findPlayer(user) {
    if (user.id && state.players[user.id]) return state.players[user.id];
    const u = (user.username || '').toLowerCase();
    if (!u) return null;
    return Object.values(state.players).find(p => p.username === u) || null;
}
function findPlayerByNameOrId(str) {
    const raw = String(str).replace(/^@/, '').trim();
    if (raw && state.players[raw]) return state.players[raw]; // точный ID (и телефонный uid тоже)
    const s = raw.toLowerCase();
    if (!s) return null;
    if (/^\d+$/.test(s)) return state.players[s] || null;
    return Object.values(state.players).find(p => (p.username || '') === s || (p.first_name || '').toLowerCase() === s) || null;
}
function ensurePlayer(user) {
    let p = findPlayer(user);
    if (!p) { p = newPlayer(user); state.players[p.id] = p; logLine(`🆕 Новый игрок: ${fname(p)}`); saveState(); }
    else if (user.first_name && p.first_name !== (user.first_name || '').slice(0, 24)) {
        p.first_name = (user.first_name || 'Игрок').slice(0, 24); saveState();
    }
    return p;
}
const totalHash = p => { let h = 0; if (p.miners) for (const id in p.miners) { const m = miner(id); if (m) h += m.hash * p.miners[id]; } return h; };
const supply = () => Object.values(state.players).reduce((a, p) => a + (p.fi || 0), 0);
const bannedOnline = () => Object.values(state.players).filter(p => p.banned);

/* ------------------------- ИГРОВЫЕ УЛУЧШЕНИЯ (v6-механики на сервере) ------------------------- */
const LAB_ITEMS = {
    chips1: { name: 'Эффективность чипов I', ico: '🔬', max: 5, base: 500, mult: 2.1, desc: '+10% хешрейт за уровень' },
    chips2: { name: 'Эффективность чипов II', ico: '🧪', max: 3, base: 3000, mult: 2.4, desc: '+15% хешрейт за уровень' },
    cryo: { name: 'Крио-паста', ico: '❄️', max: 3, base: 800, mult: 2.0, desc: '+5% хешрейт за уровень' },
    broker: { name: 'Биржевой брокер', ico: '📉', max: 1, base: 1200, mult: 1, desc: 'Комиссия биржи 1% → 0.5%' },
    algo: { name: 'Алгоритм FI-XX', ico: '📐', max: 1, base: 8000, mult: 1, desc: '+20% хешрейта' },
    transfer: { name: 'P2P протокол', ico: '📤', max: 1, base: 2500, mult: 1, desc: 'Разблокирует переводы FI' }
};
const UPG_ITEMS = {
    cool: { name: 'Система охлаждения', ico: '❄', max: 8, base: 400, mult: 2.1, pct: 3, desc: l => `+${l * 3}% хешрейта` },
    power: { name: 'Низкий тариф', ico: '⚡', max: 6, base: 600, mult: 2.4, pct: 2, desc: l => `+${l * 2}% хешрейта` },
    oc: { name: 'Оверклокинг чипов', ico: '🔥', max: 5, base: 1500, mult: 2.6, pct: 12, desc: l => `+${l * 12}% хешрейта` }
};
const SPIN_COST_FI = 50;
const SPIN_SEGS = [
    { w: 22, t: 'мимо', color: '#2a3a4e' },
    { w: 14, k: 'fi', m: 2, t: '+2× FI', color: '#17dd62' },
    { w: 18, t: 'мимо', color: '#1e2c3a' },
    { w: 12, k: 'usd', a: 50, t: '+$50', color: '#2fd46a' },
    { w: 16, t: 'мимо', color: '#243447' },
    { w: 8, k: 'fi', m: 5, t: '+5× FI', color: '#f7b32b' },
    { w: 7, k: 'usd', a: 200, t: '+$200', color: '#37c8ee' },
    { w: 2, k: 'usd', a: 1000, t: '💰 ДЖЕКПОТ', color: '#a855f7' },
    { w: 1, k: 'usd', a: 2500, t: '💎 МЕГА-ДЖЕКПОТ', color: '#ec4899' }
];
const QUEST_DEFS = [
    { k: 'sell', t: 25, ico: '💱', d: 'Продай 25 FI на бирже', r: { usd: 150 } },
    { k: 'buy', t: 40, ico: '🟢', d: 'Купи 40 FI на бирже', r: { fi: 8 } },
    { k: 'mine', t: 60, ico: '⛏', d: 'Добудь 60 FI майнингом', r: { usd: 200 } }
];
const todayStr = () => new Date().toDateString();
function dayOf(p) {
    if (!p.day || p.day.date !== todayStr()) p.day = { date: todayStr(), sell: 0, buy: 0, mine: 0, claimed: {} };
    return p.day;
}
function labCost(it, lvl) { return Math.ceil(it.base * Math.pow(it.mult, lvl)); }
function labHashMult(p) {
    const l = p.lab || {}, u = p.upg || {};
    return (1 + 0.10 * (l.chips1 || 0) + 0.15 * (l.chips2 || 0)) *
        (l.algo ? 1.2 : 1) * (1 + 0.05 * (l.cryo || 0)) *
        (1 + 0.03 * (u.cool || 0) + 0.02 * (u.power || 0) + 0.12 * (u.oc || 0));
}

/* ------------------------- РОЛИ ------------------------- */
const isStaff = user => user && state.staffIds.includes(user.id);
const isOwner = user => user && state.ownerId === user.id;
const canBan = user => isOwner(user) || (isStaff(user) && !CFG.ownerOnlyBans);

/* ------------------------- КЛАВИАТУРЫ ------------------------- */
function kbMain() {
    return [
        [{ text: '👤 Профиль', callback_data: 'tab:profile' }, { text: '📈 Рынок', callback_data: 'tab:market' }],
        [{ text: '🏭 Магазин', callback_data: 'tab:shop' }, { text: '🏆 Топ', callback_data: 'tab:top' }],
        [{ text: '🎁 Бонус', callback_data: 'act:bonus' }, { text: '💼 Работа', callback_data: 'act:work' }],
        [{ text: '📱 Код для приложения', callback_data: 'act:lcode' }],
        [{ text: '🛠 STAFF', callback_data: 'tab:staff' }]
    ];
}
/* ОДИН ряд с кнопкой «Меню» – вставлять внутри другой клавиатуры только с расширением «...» */
const kbHomeRow = () => [{ text: '🏠 Меню', callback_data: 'tab:main' }];
const kbHome = () => [kbHomeRow()];
const kbCancel = () => [[{ text: '❌ Отмена', callback_data: 'dlg:cancel' }]];

/* ------------------------- ЭКРАНЫ ------------------------- */
function priceHeader() {
    const M = state.market;
    const h = M.hist;
    const old = h.length > 48 ? h[h.length - 48].p : h[0].p;
    const d24 = old ? ((M.price - old) / old) * 100 : 0;
    const arrow = d24 > 0.05 ? '📈' : d24 < -0.05 ? '📉' : '〰️';
    const frozen = M.frozen ? ' ❄️заморожено' : '';
    return `${arrow} ${CIn(1)}: <b>$${fmt(M.price)}</b> (${d24 > 0 ? '+' : ''}${d24.toFixed(1)}% за 24 т)${frozen}\n`;
}

function screenMain() {
    return {
        text: `🏠 <b>${esc(S('title'))}</b>\n\n${S('welcome')}\n\n` +
            `📱 Есть приложение на телефон — тот же баланс, что и тут.\n` +
            `👉 Код для привязки: <code>/linkcode</code> или кнопка «📱 Код для приложения» (ниже и в 👤 Профиле).`,
        kb: kbMain()
    };
}

function screenProfile(p) {
    const h = totalHash(p);
    const perHour = h * S('fiPerThHour');
    const banBlock = p.banned ? `\n\n🚫 <b>Аккаунт заблокирован.</b>\nПричина: ${esc(p.banReason || 'не указана')}` : '';
    const appLine = p.uid
        ? `\n📱 <b>Приложение на телефоне привязано</b> · ID <code>${esc(p.uid)}</code>`
        : `\n📱 <b>Приложение на телефоне:</b> не привязано — жми кнопку ниже`;
    return {
        text: `${priceHeader()}👤 <b>Профиль ${fname(p)}</b>\n\n` +
            `💵 USD: <b>${fmt(p.usd)}</b>\n` +
            `${CI(p.fi)} (~$${fmt(p.fi * state.market.price)})\n` +
            `⚡ Мощность: <b>${fmt(h)} TH/s</b> → ${CIn(perHour)}/час\n` +
            `⛏ Добыто всего: ${CIn(p.totalMined)}\n` +
            `🛒 Куплено ${CIn(p.bought)} | 📉 Продано ${CIn(p.sold)}\n` +
            `📅 В игре с: ${new Date(p.joined).toLocaleDateString('ru-RU')}${appLine}${banBlock}`,
        kb: [
            [{ text: '💼 Работа', callback_data: 'act:work' }, { text: '🎁 Бонус', callback_data: 'act:bonus' }],
            [{ text: '📱 Код для приложения', callback_data: 'act:lcode' }],
            kbHomeRow()
        ]
    };
}

function screenMarket(p) {
    return {
        text: `${priceHeader()}📈 <b>Рынок ${S('coinName')}</b>\n\n💵 USD: <b>${fmt(p.usd)}</b>\n${CI(p.fi)}\n\n` +
            `🟢 Покупка: $${fmt(state.market.price * (1 + S('buySpreadPct') / 100))} за монету\n` +
            `🔴 Продажа: $${fmt(state.market.price * (1 - S('sellSpreadPct') / 100))} за монету`,
        kb: [
            [{ text: '🟢 Купить', callback_data: 'mk:buy' }, { text: '🔴 Продать', callback_data: 'mk:sell' }],
            kbHomeRow()
        ]
    };
}

function screenShop(p) {
    const rows = MINERS.map(m => [{
        text: `${m.name} · ${fmt(m.hash)} TH/s · $${fmt(minerCost(m, (p.miners[m.id] || 0)))} (${p.miners[m.id] || 0})`,
        callback_data: 'shop:buy:' + m.id
    }]);
    return {
        text: `${priceHeader()}🏭 <b>Магазин майнеров</b>\n💵 USD: <b>${fmt(p.usd)}</b>\n⚡ Мощность: <b>${fmt(totalHash(p))} TH/s</b>\n\nКаждый следующий такой же майнер дороже на ${Math.round((CFG.minerPriceGrowth - 1) * 100)}%.`,
        kb: [...rows, kbHomeRow()]
    };
}

function screenTop() {
    const list = Object.values(state.players)
        .filter(p => !p.banned)
        .sort((a, b) => (b.fi * state.market.price + b.usd) - (a.fi * state.market.price + a.usd))
        .slice(0, 10);
    const lines = list.map((p, i) =>
        `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.'} ${fname(p)} — ${CIn(p.fi)} + $${fmt(p.usd)}`);
    return { text: `${priceHeader()}🏆 <b>Топ игроков</b>\n\n${lines.join('\n') || 'Пока никого.'}`, kb: kbHome() };
}

/* --- STAFF --- */
function screenStaff() {
    const players = Object.values(state.players);
    const badge = isOwnerNice();
    return {
        text: `🛠 <b>STAFF CONSOLE</b>\n\n` +
            `${CIn(1)}: <b>$${fmt(state.market.price)}</b>\n` +
            `🎯 Тренд: <b>$${fmt(state.market.trend)}</b>\n` +
            `❄️ Заморозка: <b>${state.market.frozen ? 'ВКЛ' : 'выкл'}</b>\n` +
            `👥 Игроков: <b>${players.length}</b> (🚫 банов: ${bannedOnline().length})\n` +
            `🏦 Всего ${S('coinName')} в игре: ${CIn(supply())}\n` +
            `👤 Ты: ${badge}`,
        kb: [
            [{ text: '🪙 Выдать монеты', callback_data: 'st:give:fi' }, { text: '💵 Выдать USD', callback_data: 'st:give:usd' }],
            [{ text: `🪙 Всем +100`, callback_data: 'st:allfi:100' }, { text: '💵 Всем +$1000', callback_data: 'st:allusd:1000' }],
            [{ text: '📈 Цена ↑', callback_data: 'st:price:up' }, { text: '📉 Цена ↓', callback_data: 'st:price:down' }],
            [{ text: '🎯 Цена X', callback_data: 'dlg:price' }, { text: state.market.frozen ? '▶️ Отпустить' : '❄️ Заморозить', callback_data: 'st:freeze' }],
            [{ text: '🤖 Авто-рынок — вернуть живой курс', callback_data: 'st:auto' }],
            [{ text: '👥 Игроки', callback_data: 'st:players' }, { text: '🚫 Баны', callback_data: 'st:banlist' }],
            [{ text: '⚙️ Настройки', callback_data: 'st:settings' }, { text: '📢 Всем сообщение', callback_data: 'dlg:broadcast' }],
            [{ text: '📜 Журнал', callback_data: 'st:log' }, { text: '🏠 Закрыть', callback_data: 'tab:main' }]
        ]
    };
}
function isOwnerNice() { return 'OWNER 👑'; } // экран доступен только staff; владелец первый

function screenPlayers() {
    const rows = Object.values(state.players)
        .sort((a, b) => a.first_name.localeCompare(b.first_name))
        .slice(0, 30)
        .map(p => [{
            text: `${p.banned ? '🚫' : '👤'} ${p.first_name}${p.username ? ' (@' + p.username + ')' : ''} · ID ${p.id}`,
            callback_data: 'st:player:' + p.id
        }]);
    return {
        text: `👥 <b>Игроки (${Object.keys(state.players).length})</b>\n\nНажми на игрока для действий.\n🪪 ID показан у каждого — его можно использовать в выдаче монет: <code>ID сумма</code>.`,
        kb: [...rows, [{ text: '⬅️ Назад', callback_data: 'tab:staff' }]]
    };
}

function screenPlayerCard(pid, viewerIsOwner) {
    const p = state.players[pid];
    if (!p) return { text: '❌ Игрок не найден.', kb: [[{ text: '⬅️ Назад', callback_data: 'st:players' }]] };
    const banBtn = p.banned
        ? [{ text: '✅ Разбанить', callback_data: 'st:unban:' + p.id }]
        : [{ text: '🚫 Забанить', callback_data: 'st:ban:' + p.id }];
    const banNote = p.banned ? `\n\n🚫 <b>Забанен</b>${p.banReason ? ': ' + esc(p.banReason) : ''} (${p.bannedAt ? new Date(p.bannedAt).toLocaleString('ru-RU') : ''})` : '';
    return {
        text: `👤 <b>${fname(p)}</b> (@${esc(p.username || '—')}, ID <code>${p.id}</code>)\n` +
            `${CI(p.fi)} | 💵 $${fmt(p.usd)}\n⚡ ${fmt(totalHash(p))} TH/s${banNote}`,
        kb: [
            [{ text: '🪙 +FI', callback_data: 'dlg:pgivefi:' + p.id }, { text: '💵 +USD', callback_data: 'dlg:pgiveusd:' + p.id }],
            [{ text: '🪙 −FI', callback_data: 'dlg:pgivefi-:' + p.id }, { text: '💵 −USD', callback_data: 'dlg:pgiveusd-:' + p.id }],
            banBtn,
            [{ text: '🗑 Обнулить', callback_data: 'st:zero:' + p.id }, { text: '⬅️ К игрокам', callback_data: 'st:players' }]
        ]
    };
}

function screenBans() {
    const list = bannedOnline();
    const rows = list.map(p => [{ text: `🚫 ${p.first_name}${p.username ? ' (@' + p.username + ')' : ''} · ID ${p.id}`, callback_data: 'st:player:' + p.id }]);
    return {
        text: `🚫 <b>Забаненные (список бана)</b>\n\n${list.map(p => `• ${fname(p)} (ID <code>${p.id}</code>) — ${esc(p.banReason || '—')}`).join('\n') || 'Банов нет. Тишина и порядок.'}`,
        kb: [...rows, [{ text: '⬅️ Назад', callback_data: 'tab:staff' }]]
    };
}

/* --- Настройки (тема + экономика) --- */
function screenSettings(isOwnerUser) {
    const s = state.settings;
    const text =
        `⚙️ <b>Настройки бота</b>\n\n` +
        `🎨 <b>Тема</b>\n` +
        `🏅 Название монеты: <b>${esc(s.coinName)}</b>\n` +
        `🪪 Эмодзи монеты: <b>${esc(s.coinEmoji)}</b>\n` +
        `🏷 Заголовок бота: <b>${esc(s.title)}</b>\n` +
        `💬 Приветствие: <i>${esc(s.welcome.slice(0, 60))}${s.welcome.length > 60 ? '…' : ''}</i>\n\n` +
        `📊 <b>Рынок</b>\n` +
        `Стартовая цена: <b>$${fmt(s.startPrice)}</b>\n` +
        `Волатильность: <b>${s.volatilityPct}%</b>/тик · События: <b>${s.eventChancePct}%</b>/тик\n` +
        `Спред покупки: <b>+${s.buySpreadPct}%</b> · продажи: <b>−${s.sellSpreadPct}%</b>\n\n` +
        `💰 <b>Экономика</b>\n` +
        `Старт: $${fmt(s.startUsd)} + ${CIn(s.startFi).replace(/<[^>]+>/g, '')}\n` +
        `Майнинг: <b>${s.fiPerThHour} ${s.coinName}</b> / TH/час\n` +
        `Работа: каждые <b>${s.workIntervalMin} мин</b>, $${s.workPayMin}–${s.workPayMax}\n` +
        `Бонус дня: $${s.bonusDailyUsd} + ${CIn(s.bonusDailyFi).replace(/<[^>]+>/g, '')}`;
    const kb = [
        [{ text: '🏅 Имя монеты', callback_data: 'dlg:set:coinName' }, { text: '🪪 Эмодзи', callback_data: 'dlg:set:coinEmoji' }],
        [{ text: '🏷 Заголовок', callback_data: 'dlg:set:title' }, { text: '💬 Приветствие', callback_data: 'dlg:set:welcome' }],
        [{ text: '📊 Рынок $ / %', callback_data: 'st:settings:num:market' }],
        [{ text: '💰 Деньги / майнинг', callback_data: 'st:settings:num:econ' }],
        isOwnerUser ? [{ text: '➕ Staff', callback_data: 'dlg:staffadd' }, { text: '➖ Staff', callback_data: 'st:staffrm' }] : null,
        isOwnerUser ? [{ text: '🧯 Сбросы', callback_data: 'st:resets' }] : null,
        [{ text: '⬅️ Назад', callback_data: 'tab:staff' }]
    ].filter(Boolean);
    return { text, kb };
}

const NUM_FIELDS = {
    market: [
        { key: 'startPrice', label: 'стартовую цену FI, $' },
        { key: 'volatilityPct', label: 'волатильность, % за тик' },
        { key: 'eventChancePct', label: 'шанс события, % за тик' },
        { key: 'buySpreadPct', label: 'спред покупки, %' },
        { key: 'sellSpreadPct', label: 'спред продажи, %' }
    ],
    econ: [
        { key: 'startUsd', label: 'стартовые USD' },
        { key: 'startFi', label: 'стартовые монеты' },
        { key: 'fiPerThHour', label: 'FI за 1 TH за час' },
        { key: 'workIntervalMin', label: 'интервал работы, мин' },
        { key: 'workPayMin', label: 'мин. оплата работы, $' },
        { key: 'workPayMax', label: 'макс. оплата, $' },
        { key: 'bonusDailyUsd', label: 'дневной бонус USD' },
        { key: 'bonusDailyFi', label: 'дневной бонус монет' }
    ]
};
const TEXT_FIELDS = {
    coinName: { label: 'название монеты (например FI)', max: 12 },
    coinEmoji: { label: 'эмодзи монеты (1 значок)', max: 4 },
    title: { label: 'заголовок бота', max: 40 },
    welcome: { label: 'приветствие в /start (любой текст)', max: 500 }
};

function screenNumFields(group) {
    const s = state.settings;
    const defs = NUM_FIELDS[group];
    const rows = defs.map(d => [{
        text: `${d.key}: ${s[d.key]}`,
        callback_data: 'dlg:num:' + d.key
    }]);
    return { text: `🔢 <b>Числовые параметры</b>\n\nНажми параметр и пришли новое число:`, kb: [...rows, [{ text: '⬅️ Назад', callback_data: 'st:settings' }]] };
}

function screenResets() {
    return {
        text: `🧯 <b>Сбросы</b>\n\n⚠️ Действия необратимы.\n• «Сбросить балансы» — обнулит USD и монеты у всех, игроки останутся.\n• «Удалить всё» — удалит всех игроков и историю.\n• «Сбросить рынок» — цена вернётся к старту, история очистится.`,
        kb: [
            [{ text: '📉 Сбросить рынок', callback_data: 'st:reset:market' }],
            [{ text: '🧯 Сбросить балансы', callback_data: 'st:reset:balances' }],
            [{ text: '💥 Удалить всё', callback_data: 'st:reset:nuke' }],
            [{ text: '⬅️ Назад', callback_data: 'st:settings' }]
        ]
    };
}

function screenStaffRm() {
    const rows = state.staffIds.map(id => {
        const p = state.players[id];
        return [{ text: `➖ ${p ? p.first_name : id}`, callback_data: 'st:staffdel:' + id }];
    });
    return {
        text: `👮 <b>Staff (${state.staffIds.length})</b>\n\nВладелец: ${state.ownerId ? fname(state.players[state.ownerId] || {}) + ` <code>${state.ownerId}</code>` : 'не назначен'}\n\nНажми, чтобы снять права:`,
        kb: [...rows, [{ text: '⬅️ Назад', callback_data: 'st:settings' }]]
    };
}

/* ------------------------- ЦЕНА ------------------------- */
function pushHist() {
    state.market.hist.push({ t: Date.now(), p: state.market.price });
    if (state.market.hist.length > 200) state.market.hist.shift();
}
function pumpDump(kind, pct) {
    if (kind === 'pump') state.market.price *= (1 + pct / 100);
    else if (kind === 'dump') state.market.price *= Math.max(0.0001, 1 - pct / 100);
    else if (kind === 'x2') state.market.price *= 2;
    else if (kind === 'half') state.market.price = Math.max(0.0001, state.market.price / 2);
    state.market.trend = state.market.price;
    pushHist();
    adminSay(`манипуляция <${kind}:${pct}> → $${fmt(state.market.price)}`);
    return state.market.price;
}
function setPrice(v) {
    state.market.price = Math.max(0.0001, v);
    state.market.trend = state.market.price;
    pushHist();
    adminSay(`задал цену $${fmt(state.market.price)}`);
    return state.market.price;
}
function adminSay(s) { logLine(`🛠 ${s}`); } // лог без имени (имя добавляем на месте вызова, где есть user)

/* ------------------------- ВЫДАЧА ------------------------- */
function giveTo(p, kind, amt) {
    if (!p) return false;
    if (kind === 'fi') p.fi = Math.max(0, (p.fi || 0) + amt);
    else p.usd = Math.max(0, (p.usd || 0) + amt);
    return true;
}
function giveAll(kind, amt, byWho) {
    let n = 0;
    for (const p of Object.values(state.players)) {
        if (p.banned) continue;
        giveTo(p, kind, amt); n++;
    }
    adminSay(`${esc(byWho)} выдал всем +${fmt(amt)} ${kind === 'fi' ? S('coinName') : 'USD'} (${n} игроков)`);
    return n;
}

/* ------------------------- БАН ------------------------- */
function banPlayer(p, byWho, reason) {
    if (!p) return false;
    p.banned = true;
    p.banReason = String(reason || '').slice(0, 200);
    p.bannedAt = Date.now();
    adminSay(`### БАН ${fname(p)} (@${p.username || '—'}) — ${esc(byWho)}${p.banReason ? ' — ' + esc(p.banReason) : ''}`);
    return true;
}
function unbanPlayer(p, byWho) {
    if (!p) return false;
    p.banned = false;
    p.banReason = '';
    p.bannedAt = 0;
    adminSay(`### РАЗБАН ${fname(p)} — ${esc(byWho)}`);
    return true;
}

/* ------------------------- ТИК РЫНКА ------------------------- */
function marketTick() {
    const now = Date.now();
    const dt = state.lastTick ? Math.min(now - state.lastTick, 5 * 60 * 1000) : 1000;
    state.lastTick = now;
    const M = state.market;
    if (!M.frozen) {
        const drift = (M.trend - M.price) * 0.02;
        const vol = M.price * (Math.random() - 0.5) * (S('volatilityPct') / 100) * (dt / 30000);
        M.price = Math.max(0.01, M.price + drift + vol);
        if (Math.random() * 100 < S('eventChancePct')) {
            const sign = Math.random() < 0.5 ? -1 : 1;
            M.price = Math.max(0.01, M.price * (1 + sign * rng(0.02, 0.08)));
            M.trend = M.price;
        }
        pushHist();
    }
    for (const p of Object.values(state.players)) {
        if (p.banned) continue;
        const h = totalHash(p);
        if (h > 0) {
            const gain = h * (S('fiPerThHour') / 3600) * (dt / 1000) * labHashMult(p);
            p.fi += gain;
            p.totalMined += gain;
            dayOf(p).mine += gain;
        }
    }
    saveState();
    if (!CATCHING_UP) saveStateToGitHub(false);
}

/* 📈 живая цена: под-квантовый тик на каждый запрос — не чаще раза в minGapMs (обычно 5 с).
   В отличие от catchup двигает цену микро-шагами между 30-секундными догонами. */
function subTick(minGapMs) {
    const now = Date.now();
    if (now - (state.lastTick || 0) < (minGapMs || 5000)) return false;
    try {
        CATCHING_UP = true; /* без зеркального пуша на каждый под-тик — экономим квоту GitHub */
        marketTick();
    } catch (e) { console.error('[subtick]', e && e.message); }
    finally { CATCHING_UP = false; }
    return true;
}

/* «Догоняем» пропущенные тики (облако спит без трафика): шаг 30 с, максимум ~200 часов простоя */
function catchupTicks(maxTicks) {
    let n = 0;
    try {
        CATCHING_UP = true;
        while (Date.now() - (state.lastTick || 0) > 30000 && n < (maxTicks || 400)) { marketTick(); n++; }
    } catch (e) { console.error('[catchup]', e && e.message); }
    finally {
        CATCHING_UP = false;
        if (n > 0) { try { saveState(); saveStateToGitHub(false); } catch (_) { } }
    }
}

/* ==================== ☁ ОБЛАКО: GitHub-хранилище состояния ==================== */
const ENV = k => envGet(k).trim();
const GH = {
    token: ENV('GH_TOKEN') || CFG.ghToken || '',
    repo: ENV('GH_REPO') || CFG.ghRepo || 'pta757f-cloud/fi-mining-bot',
    branch: ENV('GH_BRANCH') || 'main'
};
async function ghApi(method, url, body) {
    if (!GH.token) return null;
    try {
        const res = await fetch('https://api.github.com/repos/' + GH.repo + url, {
            method,
            headers: {
                'Authorization': 'Bearer ' + GH.token,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'fi-bot-server'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        if (!res.ok) { console.error('[gh]', method, url, res.status); return null; }
        return await res.json();
    } catch (e) { console.error('[gh]', e.message); return null; }
}
async function loadStateFromGitHub() {
    if (!GH.token) return false;
    const j = await ghApi('GET', '/contents/data/state.json?ref=' + GH.branch + '&r=' + Math.random().toString(36).slice(2));
    if (!j || !j.content) { console.log('☁️ GitHub: state.json не найден — начинаем с пустого.'); return false; }
    try {
        const obj = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
        /* защита от отката: если локальная копия на диске СВЕЖЕЕ облачной — играем её */
        const diskAt = (() => { try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).savedAt || 0; } catch (_) { return 0; } })();
        const cloudAt = obj.savedAt || 0;
        if (diskAt > cloudAt + 5000) {
            state._gitSha = j.sha; /* следующий пуш просто обновит облачный файл */
            console.log(`☁️ GitHub отстаёт (облако ${new Date(cloudAt).toLocaleString('ru-RU')} < диск ${new Date(diskAt).toLocaleString('ru-RU')}) — играем локальную копию.`);
            return true;
        }
        Object.assign(state, obj);
        state._gitSha = j.sha;
        console.log(`☁️ Состояние загружено из GitHub (${Object.keys(state.players || {}).length} игроков, цена $${fmt(state.market ? state.market.price : 0)})`);
        return true;
    } catch (e) { console.error('[gh] parse', e.message); return false; }
}

/* Публикуем адрес облачного API в репозиторий, чтобы Pages-мини-приложение всегда знало, куда стучаться */
async function pushApiJson() {
    const url = (ENV('PUBLIC_URL') || CFG.publicUrl || '').replace(/\/+$/, '');
    if (!url || !GH.token) return;
    try {
        for (let i = 0; i < 2; i++) {
            const j = await ghApi('GET', '/contents/api.json?ref=' + GH.branch + '&r=' + Math.random().toString(36).slice(2));
            /* адрес уже правильный — не создаём лишний коммит (и меньше шансов на гонку изолятов) */
            if (j && j.content) {
                try {
                    const curApi = (JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')).api || '').replace(/\/+$/, '');
                    if (curApi === url) { console.log('📡 api.json уже указывает на ' + url); return; }
                } catch (_) { }
            }
            const body = {
                message: 'chore: api url',
                content: Buffer.from(JSON.stringify({ api: url, t: Date.now() })).toString('base64'),
                branch: GH.branch
            };
            if (j && j.sha) body.sha = j.sha;
            const r = await ghApi('PUT', '/contents/api.json', body);
            if (r) { console.log('📡 api.json обновлён в GitHub → ' + url); return; }
            if (i === 0) await new Promise(s => setTimeout(s, 700)); /* 409 — гонка изолятов: перечитываем свежий sha */
            else console.error('[gh] api.json: PUT не прошёл (SHA-гонка изолятов, не критично)');
        }
    } catch (e) { console.error('[gh] api.json', e.message); }
}
let gitSaving = false, gitLastSave = 0;
function saveStateToGitHub(force) {
    if (!GH.token) return Promise.resolve(false);
    const now = Date.now();
    const cooldown = CLOUD ? 20000 : 140000; /* облако: зеркало = единственное хранилище, реже нельзя */
    if (!force && (gitSaving || now - gitLastSave < cooldown)) return Promise.resolve(false);
    gitSaving = true; gitLastSave = now;
    return (async () => {
        try {
            /* приватное в публичное зеркало не уезжает: коды привязки (кража с GitHub = захват игры
               по связке) и контексты кнопок (чат-ID). В памяти бота они остаются включая использование */
            const remote = Object.assign({}, state, { linkCodes: [], dialogs: {}, loginSessions: [], loginSpam: {} });
            const body = {
                message: 'chore: bot state sync',
                content: Buffer.from(JSON.stringify(remote)).toString('base64'),
                branch: GH.branch
            };
            if (state._gitSha) body.sha = state._gitSha;
            const j = await ghApi('PUT', '/contents/data/state.json', body);
            if (j && j.content && j.content.sha) { state._gitSha = j.content.sha; return true; }
            /* sha разъехался (два инстанса) — перечитываем, следующий пуш пройдёт */
            const g = await ghApi('GET', '/contents/data/state.json?ref=' + GH.branch + '&r=' + Math.random().toString(36).slice(2));
            if (g && g.sha) state._gitSha = g.sha;
            return false;
        } catch (e) { console.error('[gh] save', e.message); return false; }
        finally { gitSaving = false; }
    })();
}

/* ==================== 🎮 Мини-приложение: HTTP API ==================== */
/* Ключи/роли берём ТОЛЬКО из config.json или env — в HTML и репозитории их нет. */
const API_PORT = Number(ENV('PORT') || CFG.httpPort || 8787);
const API_OWNER_ID = String(CFG.ownerId || '');
const API_OWNER_USER = String(CFG.ownerUsername || 'timofey_u').toLowerCase();
const API_ALL_PERMS = ['give', 'market', 'bans', 'players', 'log', 'config'];
const API_SET_KEYS = {
    title: ['s', 40], welcome: ['s', 300], coinName: ['s', 12], coinEmoji: ['s', 4],
    startUsd: ['n', 0, 1e9], startPrice: ['n', 0.01, 1e9], fiPerThHour: ['n', 0, 1e6],
    volatilityPct: ['n', 0, 50], eventChancePct: ['n', 0, 50], buySpreadPct: ['n', 0, 50],
    sellSpreadPct: ['n', 0, 50], bonusDailyUsd: ['n', 0, 1e9], bonusDailyFi: ['n', 0, 1e6],
    workPayMin: ['n', 0, 1e9], workPayMax: ['n', 0, 1e9], workIntervalMin: ['n', 0, 1440]
};

/* Верификация initData из Telegram (подпись HMAC-SHA256 секретным ключом бота).
   Клиент не может подделать чужой id — сервер сам знает, кто пришёл. */
function verifyInitData(raw) {
    try {
        if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
        const params = new URLSearchParams(raw);
        const hash = (params.get('hash') || '').toLowerCase();
        if (!hash) return null;
        const pairs = [];
        for (const [k, v] of params.entries()) if (k !== 'hash') pairs.push([k, v]);
        pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const secret = crypto.createHmac('sha256', 'WebAppData').update(String(CFG.token), 'utf8').digest();
        const calc = crypto.createHmac('sha256', secret).update(pairs.map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8').digest('hex');
        if (calc !== hash) return null;
        let u = null; try { u = JSON.parse(params.get('user') || 'null'); } catch (_) { }
        if (!u || !Number.isFinite(u.id)) return null;
        return { id: u.id, first_name: (u.first_name || 'Игрок').slice(0, 24), username: (u.username || '') };
    } catch (e) { return null; }
}

/* ------------------------- ТЕЛЕФОНЫ (PWA-приложение) -------------------------
   Устройство = uid 'W' + 13 цифр (14 символов — длиннее Telegram-ID, перепутать нельзя)
   + секрет в памяти телефона (localStorage). Вместе они играют тем же профилем,
   что и Telegram (через одноразовый код связки). Секреты лежат в state.deviceVault
   ЗАШИФРОВАННО (ключ из BOT_TOKEN) — в публичном зеркале state.json они бесполезны. */
let DEV_CACHE = null;
function devKey() { return crypto.createHash('sha256').update(String(CFG.token) + '|fi-device-vault', 'utf8').digest(); }
function devicesMap() {
    if (DEV_CACHE) return DEV_CACHE;
    DEV_CACHE = {};
    try {
        for (const [uid, blob] of Object.entries(state.deviceVault || {})) {
            const raw = Buffer.from(blob, 'base64');
            if (raw.length < 29) continue;
            try {
                const iv = raw.slice(0, 12), tag = raw.slice(12, 28), ct = raw.slice(28);
                const dc = crypto.createDecipheriv('aes-256-gcm', devKey(), iv);
                dc.setAuthTag(tag);
                const j = JSON.parse(Buffer.concat([dc.update(ct), dc.final()]).toString());
                if (j && j.s && j.p) DEV_CACHE[uid] = j;
            } catch (_) { }
        }
    } catch (_) { }
    return DEV_CACHE;
}
function putDevice(uid, rec) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', devKey(), iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(rec), 'utf8')), c.final()]);
    state.deviceVault = state.deviceVault || {};
    state.deviceVault[uid] = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    devicesMap()[uid] = rec;
    saveState();
}

/* 🔐 СБРОС устройства/устройств игрока — с защитой от SHA-гонки изолятов:
   свежий deviceVault тянем из зеркала, чистим, форс-пушим; на неудачу — повторяем. */
async function wipePlayerDevices(p, reason) {
    if (!p) return 0;
    try {
        for (let i = 0; i < 3; i++) {
            if (CLOUD && GH.token) {
                const j = await ghApi('GET', '/contents/data/state.json?ref=' + GH.branch + '&r=' + Math.random().toString(36).slice(2));
                if (j && j.content) {
                    try {
                        const obj = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
                        if (obj && obj.deviceVault && typeof obj.deviceVault === 'object') { state.deviceVault = obj.deviceVault; if (j.sha) state._gitSha = j.sha; }
                    } catch (_) { }
                }
            }
            const was = state.deviceVault || (state.deviceVault = {});
            DEV_CACHE = null; /* кэш расшифровки перестроится на свежем vault */
            const dm = devicesMap();
            const killed = [];
            for (const k of Object.keys(was)) {
                const rec = dm[k];
                if (rec && String(rec.p) === String(p.id)) { killed.push(k); delete was[k]; }
            }
            if (!killed.length) { DEV_CACHE = null; saveState(); return 0; }
            DEV_CACHE = null; saveState();
            const pushed = await saveStateToGitHub(true);
            if (!CLOUD || pushed) {
                try { send(p.id, '🛡 <b>Привязки телефона сброшены</b>\n' + esc(reason)); } catch (_) { }
                return killed.length;
            }
            /* 409/гонка — перечитали выше, следующий круг */
        }
        console.error('[vault wipe] push не прошёл 3 раза');
    } catch (e) { console.error('[vault wipe]', e && e.message); }
    return 0;
}
function genUid() { let s = 'W'; for (let i = 0; i < 13; i++) s += Math.floor(Math.random() * 10); return s; }
const LINK_CODE_AB = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
    let s = '';
    for (let i = 0; i < 8; i++) s += LINK_CODE_AB[Math.floor(Math.random() * LINK_CODE_AB.length)];
    return s.slice(0, 4) + '-' + s.slice(4);
}
/* одноразовый код привязки телефона (TTL 10 мин) — общий для Telegram и HTTP API */
function createLinkCode(p) {
    state.linkCodes = state.linkCodes || [];
    state.linkCodes = state.linkCodes.filter(c => c.to !== String(p.id) && Date.now() - c.at < 10 * 60000);
    const code = genCode();
    state.linkCodes.push({ code, to: String(p.id), at: Date.now() });
    saveState();
    return code;
}
/* аутентификация запроса: Telegram initData (приоритет) ЛИБО подпись устройства */
function deviceVerify(body) {
    try {
        const a = body.device || {};
        const uid = String(a.uid || ''), ts = Number(a.ts), sig = String(a.sig || '');
        if (!/^W\d{13}$/.test(uid) || !isFinite(ts) || !/^[0-9a-f]{64}$/.test(sig.toLowerCase())) return null;
        if (Math.abs(Date.now() - ts) > 10 * 60000) return null;
        const rec = devicesMap()[uid];
        if (!rec) return null;
        const calc = crypto.createHmac('sha256', String(rec.s)).update(uid + ':' + ts, 'utf8').digest('hex');
        return calc === sig.toLowerCase() ? (state.players[rec.p] || null) : null;
    } catch (_) { return null; }
}
function authPlayer(body) {
    /* ① приложение: долгосрочная сессия по токену */
    if (body && body.token) {
        ensureAuthIndex();
        const sess = state.sessions[String(body.token)];
        if (sess && state.players[sess.pid]) { sessionTouch(String(body.token)); return { p: state.players[sess.pid], tg: state.players[sess.pid] }; }
    }
    const u = verifyInitData(body.init || '');
    if (u) return { p: ensurePlayer(u), tg: u };
    const p = deviceVerify(body);
    if (p) return { p, tg: p };
    return null;
}
/* ------------------------- СОЦИАЛКА: друзья и онлайн ------------------------- */
const ONLINE_MS = 120000;              /* 🟢 = заходил в игру последние 2 минуты */
const FRIENDS_MAX = 50;

function socialRow(x) {
    return { id: String(x.id), name: fname(x), online: (Date.now() - (x.lastSeen || 0)) < ONLINE_MS, usd: Math.floor(x.usd || 0) };
}
function socialPlayersList(selfId) {
    const isOn = x => (Date.now() - (x.lastSeen || 0)) < ONLINE_MS ? 1 : 0;
    return Object.values(state.players)
        .filter(x => !x.banned && String(x.id) !== String(selfId))
        .sort((a, b) => isOn(b) - isOn(a) || (b.usd || 0) - (a.usd || 0))
        .slice(0, 300)
        .map(socialRow);
}
function friendsOf(p) {
    const f = p.friends || {};
    return Object.keys(f).map(k => { const x = state.players[k]; return x ? Object.assign(socialRow(x), { since: f[k] }) : null; }).filter(Boolean);
}
function reqInFor(p) {
    return (state.friendReqs || []).filter(r => String(r.t) === String(p.id))
        .map(r => { const x = state.players[r.f]; return x ? { id: String(x.id), name: fname(x), online: (Date.now() - (x.lastSeen || 0)) < ONLINE_MS, at: r.at } : null; })
        .filter(Boolean);
}
function reqOutFor(p) {
    return (state.friendReqs || []).filter(r => String(r.f) === String(p.id)).map(r => String(r.t));
}

function apiSnapshot(p) {
    const M = state.market;
    const price = M.price;
    const h = M.hist || [];
    const old = h.length > 48 ? h[h.length - 48].p : (h[0] ? h[0].p : price);
    const d24 = old ? ((price - old) / old) * 100 : 0;
    const top = Object.values(state.players)
        .sort((a, b) => (b.fi * price + b.usd) - (a.fi * price + a.usd))
        .slice(0, 10)
        .map(x => { const th = totalHash(x); const rd = roleDefOf(x.id); return { n: fname(x), fi: x.fi, usd: x.usd, h: th, role: rd ? { name: rd.name, color: rd.color } : null }; });
    const now = Date.now();
    const hash = p ? totalHash(p) : 0;
    const myRole = roleDefOf(p ? p.id : '');
    const netHash = Object.values(state.players).reduce((a, x) => a + totalHash(x), 0);
    return {
        t: now,
        netHash,
        skin: { title: S('title'), coin: S('coinName'), emoji: S('coinEmoji'), welcome: S('welcome') },
        me: p ? {
            id: p.id, name: fname(p),
            usd: p.usd, fi: p.fi,
            hash, perHour: hash * S('fiPerThHour'),
            totalMined: p.totalMined, bought: p.bought, sold: p.sold, joined: p.joined,
            banned: !!p.banned, banReason: p.banReason || '',
            bonusReady: p.bonusDay !== new Date().toDateString(),
            workReady: now >= p.workAt + S('workIntervalMin') * 60000,
            workLeftMin: Math.max(0, Math.ceil((p.workAt + S('workIntervalMin') * 60000 - now) / 60000)),
            owned: p.miners || {},
            lab: Object.assign({}, p.lab || {}),
            upg: Object.assign({}, p.upg || {}),
            fee: (p.lab && p.lab.broker) ? 0.5 : 1,
            cap: p.usd + p.fi * price,
            quests: QUEST_DEFS.map((q, i) => {
                const d = p.day && p.day.date === new Date().toDateString() ? p.day : { sell: 0, buy: 0, mine: 0, claimed: {} };
                const v = q.k === 'sell' ? d.sell : q.k === 'buy' ? d.buy : d.mine;
                return { i, ico: q.ico, d: q.d, t: q.t, v: Math.round(v * 100) / 100, r: q.r, claimed: !!(d.claimed || {})[i], done: v >= q.t };
            }),
            via: p.auth ? 'app' : (p.via === 'phone' ? 'phone' : 'tg'),
            linked: !!(p.auth && p.auth.tgChatId) || !!p.uid,
            players: socialPlayersList(String(p.id)),
            friends: friendsOf(p),
            reqIn: reqInFor(p),
            reqOut: reqOutFor(p),
            stats: {
                transfersSent: p.transfersSent || 0, duelWins: p.duelWins || 0,
                spins: p.spinDone || 0, spinBest: p.spinBest || 0, questsDone: p.questsDone || 0
            },
            duels: {
                incoming: (state.duels || []).filter(d => String(d.toId) === String(p.id)).map(d => ({ id: d.id, from: d.fromName, amount: d.amount, leftMin: Math.max(0, Math.ceil((d.at + DUEL_TTL_MS - now) / 60000)) })),
                outgoing: (state.duels || []).filter(d => String(d.fromId) === String(p.id)).map(d => ({ id: d.id, to: d.toName, amount: d.amount, leftMin: Math.max(0, Math.ceil((d.at + DUEL_TTL_MS - now) / 60000)) }))
            },
            role: myRole ? { name: myRole.name, color: myRole.color } : null
        } : null,
        market: {
            price, d24,
            frozen: !!M.frozen,
            buy: price * (1 + S('buySpreadPct') / 100),
            sell: price * (1 - S('sellSpreadPct') / 100),
            hist: h.slice(-48).map(x => [x.t, Math.round(x.p * 10000) / 10000])
        },
        miners: MINERS.map(m => ({ id: m.id, name: m.name, desc: m.desc, hash: m.hash, cost: p ? minerCost(m, (p.miners || {})[m.id] || 0) : m.price })),
        cfg: Object.fromEntries(Object.keys(API_SET_KEYS).map(k => [k, state.settings[k]])),
        top, supply: supply(), playersN: Object.keys(state.players).length
    };
}

/* ------------------------- ДУЭЛИ ПО ВЫЗОВУ ------------------------- */
const DUEL_TTL_MS = 5 * 60000;
function cleanupDuels() {
    const now = Date.now();
    const st = Array.isArray(state.duels) ? state.duels : [];
    const keep = [];
    for (const d of st) {
        if (now - d.at > DUEL_TTL_MS) {
            const fp = state.players[d.fromId];
            if (fp) fp.usd += d.amount;
            adminSay(`⌛ Вызов ${d.fromName} → ${d.toName} ($${fmt(d.amount)}) истёк — ставка возвращена`);
        } else keep.push(d);
    }
    state.duels = keep;
}
async function notifyDuelIn(d) {
    const kb = [
        [{ text: '⚔️ Принять вызов', callback_data: `dacc:${d.id}` }],
        [{ text: '✖️ Отклонить', callback_data: `ddeny:${d.id}` }]
    ];
    try {
        await send(d.toId, `⚔️ <b>${esc(d.fromName)} вызывает тебя на дуэль!</b>\nСтавка: <b>$${fmt(d.amount)}</b>\n🏆 Победитель забирает $${fmt(d.amount * 2)}\n⏳ На ответ — 5 минут\n\nМини-игра → вкладка «Соц»: вызов ждёт и там.`, kb);
    } catch (_) { }
}

/* Действия игрока (та же механика, что и кнопки в чате) */
function apiRunAction(p, act) {
    const a = act && act.a;
    if (p.banned) return { ok: false, msg: '🚫 Забанен — действия закрыты' };
    switch (a) {
        case 'noop': return { ok: true };
        case 'bonus': {
            const today = new Date().toDateString();
            if (p.bonusDay === today) return { ok: false, msg: '❄️ Бонус уже получен сегодня' };
            p.bonusDay = today;
            giveTo(p, 'usd', S('bonusDailyUsd'));
            giveTo(p, 'fi', S('bonusDailyFi'));
            adminSay(`🎁 ${fname(p)} получил дневной бонус (mini app)`);
            return { ok: true, msg: `🎁 +$${fmt(S('bonusDailyUsd'))} и +${fmt(S('bonusDailyFi'))} ${S('coinName')}` };
        }
        case 'work': {
            const need = S('workIntervalMin') * 60000;
            if (Date.now() < p.workAt + need) return { ok: false, msg: `💼 Смена будет через ${Math.ceil((p.workAt + need - Date.now()) / 60000)} мин` };
            const pay = Math.round(rng(S('workPayMin'), S('workPayMax')));
            p.usd += pay; p.workAt = Date.now();
            adminSay(`💼 ${fname(p)} отработал смену +$${fmt(pay)} (mini app)`);
            return { ok: true, msg: `💼 +$${fmt(pay)}` };
        }
        case 'buy': {
            const M = state.market;
            const bp = S('buySpreadPct') * ((p.lab && p.lab.broker) ? 0.5 : 1);
            let amt = Number(act.fi);
            if (act.all) amt = p.usd / (M.price * (1 + bp / 100));
            if (!isFinite(amt) || amt <= 0) return { ok: false, msg: '❌ Сколько монет купить?' };
            const cost = amt * M.price * (1 + bp / 100);
            if (cost > p.usd + 1e-9) return { ok: false, msg: `❌ Хватает на ${fmt(p.usd / (M.price * (1 + bp / 100)))} монет — жми «ВСЁ»` };
            p.usd -= cost; p.fi += amt; p.bought += amt; dayOf(p).buy += amt;
            adminSay(`🟢 ${fname(p)} купил ${fmt(amt)} ${S('coinName')} за $${fmt(cost)} (mini app)`);
            return { ok: true, msg: `🟢 Куплено ${fmt(amt)} ${S('coinName')} за $${fmt(cost)}` };
        }
        case 'sell': {
            const M = state.market;
            const sp = S('sellSpreadPct') * ((p.lab && p.lab.broker) ? 0.5 : 1);
            let amt = Number(act.fi);
            if (act.all) amt = p.fi;
            if (!isFinite(amt) || amt <= 0) return { ok: false, msg: '❌ Сколько монет продать?' };
            if (amt > p.fi) return { ok: false, msg: `❌ У тебя только ${fmt(p.fi)} ${S('coinName')}` };
            const usd = amt * M.price * (1 - sp / 100);
            p.fi -= amt; p.usd += usd; p.sold += amt; dayOf(p).sell += amt;
            adminSay(`🔴 ${fname(p)} продал ${fmt(amt)} ${S('coinName')} за $${fmt(usd)} (mini app)`);
            return { ok: true, msg: `🔴 Продано ${fmt(amt)} ${S('coinName')} за $${fmt(usd)}` };
        }
        case 'buyminer': {
            const m = miner(String(act.id || ''));
            if (!m) return { ok: false, msg: '❌ Нет в наличии' };
            const cost = minerCost(m, (p.miners || {})[m.id] || 0);
            if (p.usd < cost) return { ok: false, msg: `❌ Не хватает $${fmt(cost - p.usd)}` };
            p.usd -= cost;
            p.miners = p.miners || {};
            p.miners[m.id] = (p.miners[m.id] || 0) + 1;
            adminSay(`🏭 ${fname(p)} купил ${m.name} за $${fmt(cost)} (mini app)`);
            return { ok: true, msg: `✅ ${m.name}: +${fmt(m.hash)} TH/s` };
        }
        default: return { ok: false, msg: '❌ Неизвестное действие' };
        /* --- механики v6, живущие на сервере --- */
        case 'labBuy': {
            const it = LAB_ITEMS[String(act.id || '')];
            if (!it) return { ok: false, msg: '❌ Нет такого исследования' };
            p.lab = p.lab || {};
            const lvl = p.lab[act.id] || 0;
            if (lvl >= it.max) return { ok: false, msg: `✅ Уже максимум (${it.max}/${it.max})` };
            const cost = labCost(it, lvl);
            if (p.usd < cost) return { ok: false, msg: `❌ Не хватает $${fmt(cost - p.usd)}` };
            p.usd -= cost; p.lab[act.id] = lvl + 1;
            adminSay(`🔬 ${fname(p)} (mini) исследовал «${it.name}» ур.${lvl + 1} за $${fmt(cost)}`);
            return { ok: true, msg: `${it.ico} ${it.name} — уровень ${lvl + 1}` };
        }
        case 'upgBuy': {
            const it = UPG_ITEMS[String(act.id || '')];
            if (!it) return { ok: false, msg: '❌ Нет такого апгрейда' };
            p.upg = p.upg || {};
            const lvl = p.upg[act.id] || 0;
            if (lvl >= it.max) return { ok: false, msg: `✅ Уже максимум (${it.max}/${it.max})` };
            const cost = labCost(it, lvl);
            if (p.usd < cost) return { ok: false, msg: `❌ Не хватает $${fmt(cost - p.usd)}` };
            p.usd -= cost; p.upg[act.id] = lvl + 1;
            adminSay(`🔧 ${fname(p)} (mini) улучшил «${it.name}» ур.${lvl + 1} за $${fmt(cost)}`);
            return { ok: true, msg: `${it.ico} ${it.name} — уровень ${lvl + 1}` };
        }
        case 'spin': {
            if ((p.fi || 0) < SPIN_COST_FI) return { ok: false, msg: `❌ Нужно ${fmt(SPIN_COST_FI)} FI на спин` };
            const r = Math.random() * 100;
            let acc = 0, idx = SPIN_SEGS.length - 1;
            for (let i = 0; i < SPIN_SEGS.length; i++) { acc += SPIN_SEGS[i].w; if (r < acc) { idx = i; break; } }
            const seg = SPIN_SEGS[idx];
            p.fi -= SPIN_COST_FI;
            let win = 0, kind = '';
            if (seg.k === 'fi') { win = SPIN_COST_FI * seg.m; p.fi += win; kind = 'fi'; }
            else if (seg.k === 'usd') { win = seg.a; p.usd += win; kind = 'usd'; }
            p.spinDone = (p.spinDone || 0) + 1;
            if (win > (p.spinBest || 0)) p.spinBest = win;
            adminSay(`🎰 ${fname(p)} (mini) крутанул колесо → ${seg.t}`);
            return { ok: true, seg: idx, win, kind, msg: `🎰 Выигрыш: ${seg.t}` };
        }
        case 'questClaim': {
            const d = dayOf(p);
            const i = Number(act.i) || 0;
            const q = QUEST_DEFS[i];
            if (!q) return { ok: false, msg: '❌ Нет такого задания' };
            const v = q.k === 'sell' ? d.sell : q.k === 'buy' ? d.buy : d.mine;
            if (v < q.t) return { ok: false, msg: `⏳ Прогресс ${fmt(v)} / ${fmt(q.t)}` };
            d.claimed = d.claimed || {};
            if (d.claimed[i]) return { ok: false, msg: '✅ Награда уже получена' };
            d.claimed[i] = 1;
            p.questsDone = (p.questsDone || 0) + 1;
            if (q.r.usd) p.usd += q.r.usd;
            if (q.r.fi) p.fi += q.r.fi;
            adminSay(`📋 ${fname(p)} (mini) выполнил задание «${q.d}»`);
            return { ok: true, msg: `✅ Награда: ${q.r.usd ? '+$' + fmt(q.r.usd) : '+' + fmt(q.r.fi) + ' ' + S('coinName')}` };
        }
        case 'transfer': {
            const l = p.lab || {};
            if (!l.transfer) return { ok: false, msg: '🔒 Нужно исследование «P2P протокол»' };
            const amt = Number(act.fi);
            if (!isFinite(amt) || amt <= 0 || amt > p.fi + 1e-9) return { ok: false, msg: `❌ У тебя только ${fmt(p.fi)} FI` };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp || String(tp.id) === String(p.id)) return { ok: false, msg: '❌ Игрок не найден' };
            p.fi -= amt; tp.fi = (tp.fi || 0) + amt;
            p.transfersSent = (p.transfersSent || 0) + 1;
            adminSay(`📤 ${fname(p)} (mini) отправил ${fmt(amt)} ${S('coinName')} → ${fname(tp)}`);
            return { ok: true, msg: `✅ ${fname(tp)} получил ${fmt(amt)} ${S('coinName')}` };
        }
        case 'duel': {
            const amt = Math.round(Number(act.amount) * 100) / 100;
            if (!isFinite(amt) || amt < 10 || amt > 1e6) return { ok: false, msg: '❌ Ставка: от $10 до $1M' };
            if (p.usd < amt) return { ok: false, msg: '❌ Не хватает денег на ставку' };
            if ((state.duels || []).some(d => String(d.fromId) === String(p.id))) return { ok: false, msg: '⚔️ У тебя уже есть активный вызов — отмени его или дождись ответа' };
            let tp = null;
            if (act.to) {
                tp = findPlayerByNameOrId(String(act.to).replace(/^@/, ''));
                if (!tp || String(tp.id) === String(p.id)) return { ok: false, msg: '❌ Соперник не найден' };
                if (tp.banned) return { ok: false, msg: '🚫 Этот игрок забанен' };
            } else {
                const pool = Object.values(state.players).filter(x => !x.banned && String(x.id) !== String(p.id) && (x.usd || 0) >= amt);
                if (!pool.length) return { ok: false, msg: '❌ Соперники с такой ставкой не найдены — снижай ставку' };
                tp = pool[Math.floor(Math.random() * pool.length)];
            }
            if ((tp.usd || 0) < amt) return { ok: false, msg: `❌ У ${fname(tp)} слишком мало денег для этой ставки` };
            p.usd -= amt;
            const d = { id: 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), fromId: String(p.id), fromName: fname(p), toId: String(tp.id), toName: fname(tp), amount: amt, at: Date.now() };
            state.duels = state.duels || []; state.duels.push(d);
            adminSay(`⚔️ ${fname(p)} (mini) вызвал ${fname(tp)} на дуэль — $${fmt(amt)}`);
            try { notifyDuelIn(d); } catch (_) { }
            return { ok: true, msg: `⚔️ Вызов отправлен ${fname(tp)} — ставка $${fmt(amt)} в кассе, ждём ответ (5 мин)` };
        }
        case 'duelAccept':
        case 'duelDecline': {
            const d = (state.duels || []).find(x => x.id === String(act.id || '') && String(x.toId) === String(p.id));
            if (!d) return { ok: false, msg: '❌ Вызов не найден — возможно, истёк (5 минут)' };
            const fp = state.players[d.fromId];
            state.duels = state.duels.filter(x => x.id !== d.id);
            if (a === 'duelDecline' || !fp) {
                if (fp) fp.usd += d.amount;
                adminSay(`✖️ ${fname(p)} (mini) отклонил вызов ${fname(fp)} — $${fmt(d.amount)} возвращено`);
                try { if (fp) send(fp.id, `✖️ <b>${esc(fname(p))}</b> отклонил твой вызов. Ставка $${fmt(d.amount)} вернулась.`); } catch (_) { }
                return { ok: true, msg: '✖️ Отклонено — ставка вернётся сопернику' };
            }
            if ((p.usd || 0) < d.amount) {
                fp.usd += d.amount;
                try { send(fp.id, `❗ ${esc(fname(p))} не смог оплатить ставку — вызов отменён, деньги возвращены.`); } catch (_) { }
                return { ok: false, msg: `❌ Не хватает $${fmt(d.amount - p.usd)} на ставку — вызов отменён` };
            }
            p.usd -= d.amount;
            const pot = d.amount * 2;
            const accWins = Math.random() < 0.5;
            const winner = accWins ? p : fp;
            winner.usd += pot;
            winner.duelWins = (winner.duelWins || 0) + 1;
            adminSay(`⚔️ Дуэль (mini): ${fname(winner)} победил ${fname(accWins ? fp : p)} — банк $${fmt(pot)}`);
            try { send(winner.id, `⚔️ <b>Дуэль с ${esc(fname(accWins ? fp : p))}</b>\n🏆 Победа! Приз $${fmt(pot)}`); } catch (_) { }
            try { send(accWins ? fp.id : p.id, `⚔️ <b>Дуэль с ${esc(fname(winner))}</b>\n💀 Поражение. −$${fmt(d.amount)}`); } catch (_) { }
            return { ok: true, msg: accWins ? `🏆 Победа в дуэли! +$${fmt(d.amount)}` : `💀 ${fname(fp)} сильнее — −$${fmt(d.amount)}` };
        }
        case 'duelCancel': {
            const d = (state.duels || []).find(x => x.id === String(act.id || '') && String(x.fromId) === String(p.id));
            if (!d) return { ok: false, msg: '❌ Твой вызов не найден' };
            state.duels = state.duels.filter(x => x.id !== d.id);
            p.usd += d.amount;
            adminSay(`✖️ ${fname(p)} (mini) отменил вызов к ${d.toName} — ставка возвращена`);
            try { const tpx = state.players[d.toId]; if (tpx) send(tpx.id, `✖️ ${esc(fname(p))} отменил вызов на дуэль.`); } catch (_) { }
            return { ok: true, msg: `✅ Вызов отменён — +$${fmt(d.amount)} вернулись` };
        }
        case 'roulette': {
            const c = String(act.color || '');
            if (!['red', 'black', 'green'].includes(c)) return { ok: false, msg: '❌ Ставь на красное, чёрное или зелёное' };
            const amt = Number(act.amount);
            if (!isFinite(amt) || amt < 10 || amt > 1e6) return { ok: false, msg: '❌ Ставка: от $10' };
            if (p.usd < amt) return { ok: false, msg: '❌ Не хватает денег' };
            const r37 = Math.random();
            let win = 0, label = '';
            if (r37 < 1 / 37) { if (c === 'green') { win = amt * 14; } label = '🟢 ЗЕРО'; }
            else if (r37 < 19 / 37) { if (c === 'red') { win = amt * 2; } label = '🔴 Красное'; }
            else { if (c === 'black') { win = amt * 2; } label = '⚫ Чёрное'; }
            p.usd += win - amt;
            if (win > (p.spinBest || 0)) p.spinBest = win;
            adminSay(`🎰 Рулетка (mini): ${fname(p)} → ${label}, ставка $${fmt(amt)}, выигрыш $${fmt(win)}`);
            return { ok: true, msg: win > 0 ? `${label}! +$${fmt(win)}` : `${label}… −$${fmt(amt)}` };
        }
        /* ---------- друзья ---------- */
        case 'friendAdd': {
            const q = String(act.q || '').replace(/^@/, '').trim();
            if (!q) return { ok: false, msg: '❌ Ник или ID игрока?' };
            const tp = findPlayerByNameOrId(q);
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            if (String(tp.id) === String(p.id)) return { ok: false, msg: '🤨 Это ты сам' };
            if (tp.banned) return { ok: false, msg: '🚫 Игрок заблокирован' };
            p.friends = p.friends || {};
            tp.friends = tp.friends || {};
            if (p.friends[String(tp.id)]) return { ok: false, msg: '✅ Вы уже друзья' };
            /* встречная заявка = мгновенная дружба (он мне уже отправлял) */
            state.friendReqs = state.friendReqs || [];
            const back = state.friendReqs.find(r => String(r.f) === String(tp.id) && String(r.t) === String(p.id));
            if (back) {
                p.friends[String(tp.id)] = Date.now();
                tp.friends[String(p.id)] = Date.now();
                state.friendReqs = state.friendReqs.filter(r => r !== back && Date.now() - r.at < 7 * 86400000);
                adminSay(`❤️ ${fname(p)} и ${fname(tp)} теперь друзья (встречная)`);
                try { send(tp.id, `❤️ <b>${fname(p)}</b> тоже добавил тебя — вы друзья!`); } catch (_) { }
                return { ok: true, msg: `❤️ ${fname(tp)} теперь у тебя в друзьях` };
            }
            if (state.friendReqs.some(r => String(r.f) === String(p.id) && String(r.t) === String(tp.id))) return { ok: false, msg: '⏳ Заявка уже отправлена' };
            if (Object.keys(tp.friends).length >= FRIENDS_MAX) return { ok: false, msg: '❌ У игрока уже максимум друзей' };
            state.friendReqs.push({ f: String(p.id), t: String(tp.id), at: Date.now() });
            adminSay(`👥 ${fname(p)} отправил заявку в друзья → ${fname(tp)}`);
            try { send(tp.id, `👥 <b>${fname(p)}</b> хочет добавить тебя в друзья.\nОткрой мини-игру → ❤️ Друзья → заявки.`); } catch (_) { }
            return { ok: true, msg: `📨 Заявка отправлена: ${fname(tp)}` };
        }
        case 'friendYes': {
            state.friendReqs = state.friendReqs || [];
            const i = state.friendReqs.findIndex(r => String(r.t) === String(p.id) && String(r.f) === String(act.q || ''));
            if (i < 0) return { ok: false, msg: '❌ Заявка не найдена (или устарела)' };
            const req = state.friendReqs[i];
            const rp = state.players[req.f];
            p.friends = p.friends || {};
            p.friends[req.f] = Date.now();
            if (rp) {
                rp.friends = rp.friends || {};
                rp.friends[String(p.id)] = Date.now();
                try { send(rp.id, `❤️ <b>${fname(p)}</b> принял заявку — вы теперь друзья!`); } catch (_) { }
            }
            state.friendReqs.splice(i, 1);
            adminSay(`❤️ ${fname(p)} принял дружбу: ${rp ? fname(rp) : req.f}`);
            return { ok: true, msg: `❤️ Теперь вы друзья` };
        }
        case 'friendNo': {
            const before = (state.friendReqs || []).length;
            state.friendReqs = (state.friendReqs || []).filter(r => !(String(r.t) === String(p.id) && String(r.f) === String(act.q || '')));
            return before === state.friendReqs.length ? { ok: false, msg: '❌ Заявка не найдена' } : { ok: true, msg: '🚮 Заявка отклонена' };
        }
        case 'friendDel': {
            const k = String(act.q || '');
            p.friends = p.friends || {};
            if (!p.friends[k]) return { ok: false, msg: '❌ Этого игрока нет в друзьях' };
            delete p.friends[k];
            const tp = state.players[k];
            if (tp && tp.friends) delete tp.friends[String(p.id)];
            state.friendReqs = (state.friendReqs || []).filter(r => !((String(r.f) === k && String(r.t) === String(p.id)) || (String(r.t) === k && String(r.f) === String(p.id))));
            adminSay(`💔 ${fname(p)} удалил из друзей: ${tp ? fname(tp) : k}`);
            return { ok: true, msg: '💔 Удалено из друзей' };
        }
    }
}

/* Роли без ключей: OWNER — по Telegram ID/username (initData подписан Telegram, подделать нельзя).
   Остальные — кастомные роли, которые создаёт и раздаёт владелец. Чат-стафф → базовый ADMIN. */
const OWNER_DEF = () => ({ kind: 'owner', name: 'OWNER', color: '#f7b32b', perms: API_ALL_PERMS.slice() });
const CHAT_ADMIN_DEF = () => ({ kind: 'chat', name: 'ADMIN', color: '#3390ec', perms: ['give', 'market', 'bans', 'players', 'log'] });
/* Ролка для отображения (значок в топе/списках): по id игрока */
function roleDefOf(pid) {
    pid = String(pid);
    if (state.ownerId && pid === String(state.ownerId)) return { name: 'OWNER', color: '#f7b32b' };
    if (API_OWNER_ID && pid === API_OWNER_ID) return { name: 'OWNER', color: '#f7b32b' };
    const rid = (state.playerRoles || {})[pid];
    if (rid) {
        const d = (state.customRoles || []).find(x => x && x.id === rid);
        if (d) return { name: String(d.name || 'ROLE').slice(0, 16), color: '#' + String(d.color || '3dff8b').replace(/^#/, '') };
    }
    if (state.staffIds && state.staffIds.includes(Number(pid))) return { name: 'ADMIN', color: '#3390ec' };
    return null;
}
function apiRole(u) {
    if (state.ownerId && String(u.id) === String(state.ownerId)) return OWNER_DEF();
    if (API_OWNER_ID && String(u.id) === API_OWNER_ID) return OWNER_DEF();
    if (API_OWNER_USER && String(u.username || '').toLowerCase() === API_OWNER_USER) return OWNER_DEF();
    const rid = (state.playerRoles || {})[String(u.id)];
    if (rid) {
        const d = (state.customRoles || []).find(x => x && x.id === rid);
        if (d) return {
            kind: 'custom', id: d.id,
            name: String(d.name || 'ROLE').slice(0, 16),
            color: '#' + String(d.color || '3dff8b').replace(/^#/, ''),
            perms: (d.perms || []).filter(x => API_ALL_PERMS.includes(x))
        };
    }
    if (state.staffIds && state.staffIds.includes(u.id)) return CHAT_ADMIN_DEF();
    return null;
}

/* Действия персонала. role — объект роли (см. apiRole); владельцу можно всё. */
async function apiRunStaff(user, role, act) {
    const a = act && act.a;
    const isOwnerRole = role && (role.kind === 'owner');
    const need = perm => role && (isOwnerRole || role.perms.includes(perm));
    if (a === 'who') return { ok: true, msg: '🔑 Роль: ' + (role.name || '—'), role };
    switch (a) {
        /* --- управление ролями (только владелец) --- */
        case 'roles': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            return { ok: true, roles: (state.customRoles || []).map(r => ({ id: r.id, name: r.name, color: r.color, perms: r.perms || [] })), assigned: state.playerRoles || {} };
        }
        case 'roleAdd': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const name = String(act.name || '').trim().slice(0, 16);
            if (!name) return { ok: false, msg: '❌ Название роли?' };
            let color = '#' + String(act.color || '').replace(/^#/, '');
            if (!/^#[0-9a-f]{6}$/i.test(color)) color = '#3dff8b';
            const perms = (Array.isArray(act.perms) ? act.perms : []).filter(x => API_ALL_PERMS.includes(x));
            state.customRoles = state.customRoles || [];
            const id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 999).toString(36);
            state.customRoles.push({ id, name, color, perms });
            adminSay(`👑 ${fname(user)} (mini) создал роль «${esc(name)}» ${color} [${perms.join(',') || 'без прав'}]`);
            return { ok: true, msg: `✅ Роль «${name}» создана` };
        }
        case 'roleUpd': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const d = (state.customRoles || []).find(x => x.id === act.id);
            if (!d) return { ok: false, msg: '❌ Роль не найдена' };
            if (act.name != null) { const n = String(act.name).trim().slice(0, 16); if (n) d.name = n; }
            if (act.color != null) { const c = '#' + String(act.color).replace(/^#/, ''); if (/^#[0-9a-f]{6}$/i.test(c)) d.color = c; }
            if (Array.isArray(act.perms)) d.perms = act.perms.filter(x => API_ALL_PERMS.includes(x));
            adminSay(`👑 ${fname(user)} (mini) изменил роль «${esc(d.name)}»`);
            return { ok: true, msg: `✅ Роль «${d.name}» обновлена` };
        }
        case 'roleDel': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const d = (state.customRoles || []).find(x => x.id === act.id);
            if (!d) return { ok: false, msg: '❌ Роль не найдена' };
            state.customRoles = state.customRoles.filter(x => x.id !== act.id);
            for (const pid of Object.keys(state.playerRoles || {})) if (state.playerRoles[pid] === act.id) delete state.playerRoles[pid];
            adminSay(`👑 ${fname(user)} (mini) удалил роль «${esc(d.name)}»`);
            return { ok: true, msg: `✅ Роль «${d.name}» удалена` };
        }
        case 'assign': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            state.playerRoles = state.playerRoles || {};
            const empty = !act.roleId;
            if (empty) {
                if (state.playerRoles[String(tp.id)]) { delete state.playerRoles[String(tp.id)]; adminSay(`👑 ${fname(user)} (mini) снял кастомную роль с ${fname(tp)}`); return { ok: true, msg: `✅ У ${fname(tp)} роль снята` }; }
                return { ok: false, msg: '❌ У игрока нет кастомной роли' };
            }
            const d = (state.customRoles || []).find(x => x.id === act.roleId);
            if (!d) return { ok: false, msg: '❌ Роль не найдена' };
            state.playerRoles[String(tp.id)] = d.id;
            adminSay(`👑 ${fname(user)} (mini) выдал роль «${esc(d.name)}» → ${fname(tp)}`);
            return { ok: true, msg: `✅ ${fname(tp)} → «${d.name}»` };
        }
        case 'give': {
            if (!need('give')) return { ok: false, msg: '🔒 Недостаточно прав' };
            const kind = act.kind === 'usd' ? 'usd' : 'fi';
            const amt = Number(act.amount);
            if (!isFinite(amt) || amt === 0 || Math.abs(amt) > 1e12) return { ok: false, msg: '❌ Сумма: положительное число (отрицательное — забрать)' };
            const t = String(act.to || '').trim();
            if (t === '*' || t.toLowerCase() === 'все' || t.toLowerCase() === 'all') {
                const n = giveAll(kind, amt, fname(user) + ' (mini)');
                return { ok: true, msg: `✅ Выдано ${n} игрокам: ${kind === 'usd' ? '$' + fmt(amt) : fmt(amt) + ' ' + S('coinName')}` };
            }
            const tp = findPlayerByNameOrId(t.replace(/^@/, ''));
            if (!tp) return { ok: false, msg: `❌ Игрок «${t}» не найден (пусть нажмёт /start)` };
            giveTo(tp, kind, amt);
            adminSay(`🤝 ${fname(user)} (mini) выдал ${fname(tp)}: ${kind === 'usd' ? '$' + fmt(amt) : fmt(amt) + ' ' + S('coinName')}`);
            try { notifyGift(tp, amt, kind); } catch (_) { }
            return { ok: true, msg: `✅ ${fname(tp)}: ${kind === 'usd' ? '$' + fmt(tp.usd) : fmt(tp.fi) + ' ' + S('coinName')}` };
        }
        case 'price': {
            if (!need('market')) return { ok: false, msg: '🔒 Недостаточно прав' };
            const op = String(act.op || '');
            if (op === 'pump' || op === 'dump') {
                const pct = Math.min(95, Math.max(0, Number(act.pct) || 0));
                pumpDump(op, pct);
            } else if (op === 'x2' || op === 'half') pumpDump(op, 0);
            else if (op === 'set') { const v = Number(act.v); if (!(isFinite(v) && v > 0 && v <= 1e9)) return { ok: false, msg: '❌ Некорректная цена' }; setPrice(v); }
            else if (op === 'freeze') state.market.frozen = true;
            else if (op === 'unfreeze') state.market.frozen = false;
            else if (op === 'auto') state.market = freshMarket();
            else return { ok: false, msg: '❌ Неизвестная операция' };
            adminSay(`📈 ${fname(user)} (mini): ${op} → $${fmt(state.market.price)}${state.market.frozen ? ' ❄️' : ''}`);
            return { ok: true, msg: `✅ Цена: $${fmt(state.market.price)}${state.market.frozen ? ' (❄️ заморожена)' : ''}` };
        }
        case 'ban': case 'unban': {
            if (!need('bans')) return { ok: false, msg: '🔒 Недостаточно прав' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            if (isOwner({ id: tp.id })) return { ok: false, msg: '❌ Владельца банить нельзя' };
            if (a === 'ban') {
                tp.banned = true;
                tp.banReason = String(act.reason || 'не указана').slice(0, 100);
                tp.bannedAt = Date.now();
                adminSay(`🚫 ${fname(user)} (mini) забанил ${fname(tp)} — ${esc(tp.banReason)}`);
                return { ok: true, msg: `🚫 ${fname(tp)} забанен` };
            }
            tp.banned = false; tp.banReason = '';
            adminSay(`✅ ${fname(user)} (mini) разбанил ${fname(tp)}`);
            return { ok: true, msg: `✅ ${fname(tp)} разбанен` };
        }
        case 'players': {
            if (!need('players')) return { ok: false, msg: '🔒 Недостаточно прав' };
            const list = Object.values(state.players)
                .sort((x, y) => (y.fi * state.market.price + y.usd) - (x.fi * state.market.price + x.usd))
                .slice(0, 40)
                .map(x => {
                    const rd = roleDefOf(x.id);
                    return { id: x.id, n: fname(x), fi: x.fi, usd: x.usd, h: totalHash(x), b: !!x.banned, r: x.banReason || '', ls: x.lastSeen || 0, role: rd ? { name: rd.name, color: rd.color } : null };
                });
            return { ok: true, players: list };
        }
        case 'log': {
            if (!need('log')) return { ok: false, msg: '🔒 Недостаточно прав' };
            return { ok: true, log: state.log.slice(0, 20).map(l => [l.t, l.s]) };
        }
        case 'set': {
            if (!need('config')) return { ok: false, msg: '🔒 Недостаточно прав' };
            const key = String(act.key || '');
            const rule = API_SET_KEYS[key];
            if (!rule) return { ok: false, msg: '❌ Такую настройку менять нельзя' };
            let v = act.v;
            if (rule[0] === 's') {
                v = String(v == null ? '' : v).slice(0, rule[1]);
                if (!v) return { ok: false, msg: '❌ Пусто' };
            } else {
                v = Number(String(v == null ? '' : v).replace(',', '.'));
                if (!isFinite(v) || v < rule[1] || v > rule[2]) return { ok: false, msg: `❌ Число от ${rule[1]} до ${rule[2]}` };
            }
            state.settings[key] = v;
            adminSay(`⚙️ ${fname(user)} (mini): ${key} = ${JSON.stringify(v)}`);
            return { ok: true, msg: `✅ ${key} = ${String(v)}` };
        }
        case 'reset': {
            if (!isOwnerRole) return { ok: false, msg: '🏛 Только владелец' };
            const what = String(act.what || '');
            if (what === 'market') { state.market = freshMarket(); adminSay(`📉 ${fname(user)} (mini) сбросил рынок → $${fmt(state.market.price)}`); return { ok: true, msg: '✅ Рынок сброшен' }; }
            if (what === 'balances') {
                for (const pX of Object.values(state.players)) {
                    if (state.staffIds.includes(pX.id)) continue;
                    pX.usd = 0; pX.fi = 0;
                }
                adminSay(`🧯 ${fname(user)} (mini) обнулил балансы`);
                return { ok: true, msg: '✅ Балансы обнулены' };
            }
            if (what === 'nuke') {
                const keep = state.players[state.ownerId];
                state.players = {};
                if (keep) state.players[keep.id] = Object.assign({}, keep, { miners: {}, fi: S('startFi'), usd: S('startUsd'), banned: false });
                state.market = freshMarket();
                adminSay(`💥 ${fname(user)} (mini) удалил всё (nuke)`);
                return { ok: true, msg: '💥 Всё удалено, ты остался' };
            }
            return { ok: false, msg: '❌ Что сбросить?' };
        }
        /* --- 👑 owner-редактор: полный контроль профиля, вплоть до ника --- */
        case 'pGet': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            const dm = devicesMap();
            const devLinks = Object.keys(state.deviceVault || {}).filter(k => { const r0 = dm[k]; return r0 && String(r0.p) === String(tp.id); });
            const rd = roleDefOf(tp.id);
            return {
                ok: true,
                pl: {
                    id: String(tp.id), nick: tp.nick || '', first: tp.first_name || '', username: tp.username || '',
                    usd: tp.usd || 0, fi: tp.fi || 0, totalMined: tp.totalMined || 0, bought: tp.bought || 0, sold: tp.sold || 0,
                    hash: totalHash(tp),
                    miners: tp.miners || {}, lab: tp.lab || {}, upg: tp.upg || {},
                    banned: !!tp.banned, banReason: tp.banReason || '',
                    day: tp.day ? { sell: tp.day.sell || 0, buy: tp.day.buy || 0, mine: tp.day.mine || 0 } : null,
                    spinDone: tp.spinDone || 0, questsDone: tp.questsDone || 0,
                    joined: tp.joined || 0, lastSeen: tp.lastSeen || 0, workAt: tp.workAt || 0,
                    linkUid: tp.uid || '', devices: devLinks.length,
                    role: rd ? { id: rd.id, name: rd.name } : null
                }
            };
        }
        case 'pEdit': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            const put = [];
            if (act.nick !== undefined) {
                const n = String(act.nick || '').trim().slice(0, 24);
                tp.nick = n; /* пустая строка → вернётся имя из Telegram */
                put.push('ник ' + (n ? '→ «' + n + '»' : '— сброшен (из Telegram)'));
            }
            if (act.usd !== undefined) { const v = Number(act.usd); if (!isFinite(v) || v < 0 || v > 1e12) return { ok: false, msg: '❌ USD: число от 0 до 1e12' }; tp.usd = v; put.push('USD=' + fmt(v)); }
            if (act.fi !== undefined) { const v = Number(act.fi); if (!isFinite(v) || v < 0 || v > 1e12) return { ok: false, msg: '❌ FI: число от 0 до 1e12' }; tp.fi = v; put.push('FI=' + fmt(v)); }
            if (act.totalMined !== undefined) { const v = Number(act.totalMined); if (!isFinite(v) || v < 0) return { ok: false, msg: '❌ totalMined ≥ 0' }; tp.totalMined = v; put.push('totalMined=' + fmt(v)); }
            if (act.banReason !== undefined) { tp.banReason = String(act.banReason || '').slice(0, 100); put.push('причина бана'); }
            adminSay(`👑 ${fname(user)} (mini) отредактировал ${fname(tp)}: ${put.join(', ') || '—'}`);
            if (put.length) { try { await send(tp.id, '✏️ Профиль обновлён администрацией.'); } catch (_) { } }
            return { ok: true, msg: '✅ ' + (put.join(', ') || 'нечего менять') };
        }
        case 'pGrant': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            const amt = Math.round(Number(act.amt));
            if (!isFinite(amt) || amt === 0) return { ok: false, msg: '❌ Количество: целое (минус — забрать)' };
            const what = String(act.what || 'miner');
            if (what === 'miner') {
                const m = miner(String(act.key || ''));
                if (!m) return { ok: false, msg: '❌ Нет такого рига: ' + String(act.key) };
                tp.miners = tp.miners || {};
                const now = Math.max(0, (tp.miners[m.id] || 0) + amt);
                tp.miners[m.id] = now;
                adminSay(`👑 ${fname(user)} (mini): ${fname(tp)} · ${m.name} ×${now}`);
                return { ok: true, msg: `✅ ${m.name}: ×${now}` };
            }
            const def = what === 'lab' ? LAB_ITEMS[String(act.key || '')] : UPG_ITEMS[String(act.key || '')];
            if (!def) return { ok: false, msg: '❌ Нет такого ключа: ' + String(act.key) };
            tp[what] = tp[what] || {};
            const now = Math.max(0, Math.min(99, (tp[what][act.key] || 0) + amt));
            tp[what][act.key] = now;
            adminSay(`👑 ${fname(user)} (mini): ${fname(tp)} · ${def.name || act.key} → ур. ${now}`);
            return { ok: true, msg: `✅ ${def.name || act.key}: ур. ${now}` };
        }
        case 'giveAll': {
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
        case 'pDayReset': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            tp.day = { date: todayStr(), sell: 0, buy: 0, mine: 0, claimed: {} };
            tp.bonusDay = ''; tp.workAt = 0;
            adminSay(`👑 ${fname(user)} (mini) сбросил день игрока ${fname(tp)}`);
            return { ok: true, msg: '✅ Квесты, бонус и работа доступны заново' };
        }
        case 'pWipeDev': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок не найден' };
            const n = await wipePlayerDevices(tp, 'Администратор отключил все телефонные привязки твоего профиля.');
            return { ok: true, msg: n ? `✅ Сброшено привязок: ${n}` : '📱 Активных привязок и так не было' };
        }
        case 'pDelete': {
            if (!isOwnerRole) return { ok: false, msg: '👑 Только владелец' };
            const tp = findPlayerByNameOrId(String(act.to || '').replace(/^@/, ''));
            if (!tp) return { ok: false, msg: '❌ Игрок уже удалён' };
            if (isOwner({ id: tp.id })) return { ok: false, msg: '❌ Себя удалять нельзя' };
            const nm = fname(tp), pid = String(tp.id), wasUid = tp.uid || '';
            delete state.players[pid];
            if (state.playerRoles) for (const k of Object.keys(state.playerRoles)) if (String(k) === pid) delete state.playerRoles[k];
            try {
                const vault = state.deviceVault || (state.deviceVault = {});
                DEV_CACHE = null;
                const dm = devicesMap();
                let dk = 0;
                for (const k of Object.keys(vault)) { const r0 = dm[k]; if (r0 && String(r0.p) === pid && k !== wasUid) { delete vault[k]; dk++; } }
                if (wasUid && vault[wasUid]) { delete vault[wasUid]; dk++; }
                if (dk) { DEV_CACHE = null; saveState(); }
            } catch (_) { }
            adminSay(`💥 ${fname(user)} (mini) удалил игрока ${nm} (${pid})`);
            return { ok: true, msg: `💥 ${nm} удалён из игры` };
        }
        default: return { ok: false, msg: '❌ Неизвестное действие' };
    }
}

/* ------------------------- ВХОД ПО 2FA (APK → Telegram) -------------------------
   Схема: APK просит session по юзернейму → бот пишет игроку «это ты?» →
   «🔑 хочу войти» → на месте рождается 30-значный код, живёт 45 СЕКУНД, потом
   стирается и забывается (сессия мертва). Ввод кода в APK вместе с st = двойной
   фактор: у кого нет чата, тот не увидит код; у кого видит — нет st. */
const LOGIN_CODE_DIGITS = 30;
const LOGIN_CODE_TTL = 120000; /* 2 минуты: 30 цифр надо успеть вбить/вставить */
function loginSessions() {
    if (!Array.isArray(state.loginSessions)) state.loginSessions = [];
    return state.loginSessions;
}
function loginCleanup() {
    const S = loginSessions();
    const keep = S.filter(x => {
        const ttl = x.phase === 'code' ? LOGIN_CODE_TTL : 5 * 60000;
        return Date.now() - (x.codeAt || x.at) < ttl;
    });
    if (keep.length !== S.length) state.loginSessions = keep;
    return state.loginSessions;
}

/* ═══ CLOUD: 2FA-сессии между изолятами — data/logins.json в зеркале GitHub ═══
   В Workers соседний запрос может обслужить ДРУГОЙ изолят с пустой памятью
   («Сессия не найдена» при нажатии ✅). Файл — источник правды для логинов,
   память — кэш. На ПК (CLOUD=0) всё работает по-старому, в памяти. */
function loginLive(x) {
    return !x.code && x.phase !== 'done' && x.phase !== 'denied';
}
const LOGIN_PHASE_RANK = { check: 0, ask: 1, code: 2, expired: 3, denied: 3, done: 4 };
function loginsMerge(obj) {
    if (!obj) return;
    const mem = loginSessions();
    for (const rs of (Array.isArray(obj.sessions) ? obj.sessions : [])) {
        if (!rs || !rs.st) continue;
        const m = mem.find(x => String(x.st) === String(rs.st));
        if (!m) { mem.push(rs); continue; }
        /* фаза чужой копии свежее — значит сосед-изолят уже продвинул шаг: перенимаем */
        if ((LOGIN_PHASE_RANK[String(rs.phase || 'check')] || 0) > (LOGIN_PHASE_RANK[String(m.phase || 'check')] || 0)) {
            m.phase = rs.phase; m.code = rs.code; m.codeAt = rs.codeAt; m.tries = rs.tries; m.msgDel = rs.msgDel;
        }
    }
    state.loginSpam = state.loginSpam || {};
    for (const k of Object.keys(obj.spam || {})) state.loginSpam[k] = Math.max(state.loginSpam[k] || 0, Number(obj.spam[k]) || 0);
    loginCleanup();
}
async function loginsPull() {
    if (!CLOUD || !GH.token) return;
    try {
        const j = await ghApi('GET', '/contents/data/logins.json?ref=' + GH.branch + '&r=' + Math.random().toString(36).slice(2));
        if (!j || !j.content) return;
        let obj = null;
        try { obj = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch (_) { return; }
        loginsMerge(obj);
    } catch (_) { /* сеть дрогнула — работаем на памяти */ }
}
async function loginsPush() {
    if (!CLOUD || !GH.token) return;
    try {
        for (let i = 0; i < 3; i++) {
            const j = await ghApi('GET', '/contents/data/logins.json?ref=' + GH.branch + '&r=' + Math.random().toString(36).slice(2));
            if (j && j.content) {
                try { loginsMerge(JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'))); } catch (_) { }
            }
            const body = {
                message: 'chore: logins',
                content: Buffer.from(JSON.stringify({ sessions: loginSessions(), spam: state.loginSpam || {}, t: Date.now() })).toString('base64'),
                branch: GH.branch
            };
            if (j && j.sha) body.sha = j.sha;
            const r = await ghApi('PUT', '/contents/data/logins.json', body);
            if (r) return true;
            await new Promise(s => setTimeout(s, 600)); /* SHA-гонка изолятов — перечитали sha и снова */
        }
        console.error('[logins] push не прошёл (SHA-гонка), не критично');
    } catch (e) { console.error('[logins]', e && e.message); }
}
function randDigits(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
    return s;
}
/* карта устройства на Telegram-профиль: отдельный телефонный профиль вливается в основной */
function linkDeviceToPlayer(uid, secret, tp) {
    const old = state.players[uid];
    if (old && String(old.id) !== String(tp.id)) {
        tp.usd = (tp.usd || 0) + (old.usd || 0);
        tp.fi = (tp.fi || 0) + (old.fi || 0);
        tp.totalMined = (tp.totalMined || 0) + (old.totalMined || 0);
        tp.bought = (tp.bought || 0) + (old.bought || 0);
        tp.sold = (tp.sold || 0) + (old.sold || 0);
        tp.duelWins = (tp.duelWins || 0) + (old.duelWins || 0);
        tp.transfersSent = (tp.transfersSent || 0) + (old.transfersSent || 0);
        tp.lab = tp.lab || {}; tp.upg = tp.upg || {};
        for (const k of Object.keys(old.lab || {})) tp.lab[k] = Math.max(tp.lab[k] || 0, old.lab[k]);
        for (const k of Object.keys(old.upg || {})) tp.upg[k] = Math.max(tp.upg[k] || 0, old.upg[k]);
        for (const k of Object.keys(old.miners || {})) tp.miners[k] = (tp.miners[k] || 0) + (old.miners[k] || 0);
        delete state.players[uid];
        adminSay(`🔗 ${fname(tp)} привязал телефон: отдельный профиль (${uid}) переехал в основной`);
    }
    /* 🔐 правило одной привязки: новейший 2FA-логин гасит все прежние устройства профиля.
       Украденный/потерянный телефон мгновенно теряет доступ — новый вход = единственный вход. */
    try {
        const dm = devicesMap();
        const vault = state.deviceVault || (state.deviceVault = {});
        let killedOld = 0;
        for (const k of Object.keys(vault)) {
            if (k === uid) continue;
            const rec = dm[k];
            if (rec && String(rec.p) === String(tp.id)) { delete vault[k]; killedOld++; }
        }
        if (killedOld) { DEV_CACHE = null; adminSay(`🛡 ${fname(tp)}: прежних привязок отключено ${killedOld} — телефон теперь единственная точка входа`); }
    } catch (_) { }
    tp.uid = uid;
    putDevice(uid, { s: secret, p: String(tp.id) });
    saveState();
}

/* ==================== АККАУНТЫ ПРИЛОЖЕНИЯ (Google-стиль: ник+пароль; TG = 2FA) ==================== */
const OWNER_CLAIM_CODE = '3545425893';
const BOT_LINK = 'https://t.me/FI_CoinBot';
function ensureAuthIndex() { state.accIndex = state.accIndex || {}; state.sessions = state.sessions || {}; state.tg2faPending = state.tg2faPending || {}; state.tgBindCodes = state.tgBindCodes || {}; }
function accNickKey(n) { return 'n|' + String(n || '').trim().toLowerCase(); }
function shaH(str) { return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex'); }
function findAccountPlayer(nick) { ensureAuthIndex(); const pid = state.accIndex[accNickKey(nick)]; return pid && state.players[pid] ? state.players[pid] : null; }
function accountRegister(nick, pass, tg) {
    ensureAuthIndex();
    const nk = String(nick || '').trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .@_-]{1,23}$/u.test(nk)) return { err: 'Ник: 2–24 символа — буквы/цифры /.@_-' };
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

async function apiRoute(pathname, method, bodyRaw) {
    if (method === 'GET') {
        if (pathname === '/health') return { ok: true, name: S('title'), price: state.market.price, t: Date.now() };
        return { ok: false, err: 'not found' };
    }
    let body;
    try { body = JSON.parse(bodyRaw || '{}'); } catch (e) { body = null; }

    /* телеграм-вебхук (облачный режим): все кнопки/сообщения бота прилетают сюда */
    if (pathname === '/tg/webhook' && method === 'POST') {
        const u = body;
        try {
            if (u && u.callback_query) await onCallback(u.callback_query);
            else if (u && u.message) await onMessage(u.message);
            else if (u && u.my_chat_member) { /* добавление/бан бота — игнорируем */ }
        } catch (e) { console.error('[webhook]', e && e.message); }
        saveState();
        return { ok: true };
    }

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
                            '🔐 <b>Вход в FI Coin</b>\nАккаунт: «' + esc(p.auth.nick) + '»\nУстройство: новое (первый раз).\n\nЭто ты?',
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

        /* Устройства: регистрация телефона, коды связки с Telegram */
    if (pathname === '/api/device') {
        try {
            const mode = String(body.mode || '');
            /* мини-игра (Telegram) делает код привязки */
            if (mode === 'linkcode') {
                const u = verifyInitData(body.init || '');
                if (!u) return { ok: false, err: 'auth' };
                const p = ensurePlayer(u);
                const code = createLinkCode(p);
                return { ok: true, code, msg: 'Код живёт 10 минут' };
            }
            /* APK просит код подтверждения входа (покажем игроку в приложении) */
            if (mode === 'pair') {
                const uid = String(body.uid || ''), secret = String(body.secret || '');
                if (!/^W\d{13}$/.test(uid) || !/^[0-9a-f]{64}$/.test(secret)) return { ok: false, msg: '❌ Некорректные данные устройства' };
                state.linkCodes = state.linkCodes || [];
                state.linkCodes = state.linkCodes.filter(c => Date.now() - c.at < 10 * 60000);
                state.linkCodes = state.linkCodes.filter(c => !(c.uid === uid && c.kind === 'pair'));
                const code = genCode();
                state.linkCodes.push({ kind: 'pair', code, uid, at: Date.now() });
                saveState();
                return { ok: true, code };
            }
            /* подтверждение входа устройства ПРЯМО из мини-игры (кнопка, без кода) */
            if (mode === 'bind') {
                const u = verifyInitData(body.init || '');
                if (!u) return { ok: false, err: 'auth' };
                const uid = String(body.uid || '');
                if (!/^W\d{13}$/.test(uid)) return { ok: false, msg: '❌ Некорректный UID устройства' };
                const p = ensurePlayer(u);
                state.linkCodes = state.linkCodes || [];
                state.linkCodes = state.linkCodes.filter(c => c.uid !== uid && Date.now() - c.at < 10 * 60000);
                state.linkCodes.push({ uid, to: String(p.id), at: Date.now() });
                saveState();
                adminSay(`🌐 ${fname(p)} подтвердил вход устройства …${uid.slice(-4)}`);
                return { ok: true, msg: `✅ Готово! Открой FI Coin на телефоне — войдёшь как ты.` };
            }
            /* подтверждение входа по коду: игрок вводит код из APK в мини-игре (2FA-вход) */
            if (mode === 'bindConfirm') {
                const u = verifyInitData(body.init || '');
                if (!u) return { ok: false, err: 'auth' };
                const code = String(body.code || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { ok: false, msg: '❌ Формат кода: ABCD-1234' };
                state.linkCodes = state.linkCodes || [];
                state.linkCodes = state.linkCodes.filter(c => Date.now() - c.at < 10 * 60000);
                const e = state.linkCodes.find(c => c.code === code && c.kind === 'pair');
                if (!e) return { ok: false, msg: '❌ Код не найден или истёк (10 минут) — возьми новый в приложении' };
                const uid = e.uid;
                if (!/^W\d{13}$/.test(uid || '')) return { ok: false, msg: '❌ Код без устройства — возьми новый в приложении' };
                const p = ensurePlayer(u);
                state.linkCodes = state.linkCodes.filter(c => c.uid !== uid);
                state.linkCodes.push({ uid, to: String(p.id), at: Date.now() });
                saveState();
                adminSay(`🔐 ${fname(p)} подтвердил вход устройства …${uid.slice(-4)} (по коду)`);
                try { send(p.id, `🔐 <b>Вход в FI Coin подтверждён</b>\nУстройство <code>…${uid.slice(-4)}</code> теперь играет твоим профилем.\nЕсли это был не ты — дай знать владельцу.`); } catch (_) { }
                return { ok: true, msg: '✅ Готово! Открой FI Coin на телефоне — войдёшь как ты.' };
            }
            /* 2FA-вход, шаг 1: APK просит сессию по юзернейму */
            if (mode === 'loginStart') {
                const uname = String(body.username || '').replace(/^@/, '').trim().toLowerCase();
                if (!/^[a-z0-9_]{4,32}$/.test(uname)) return { ok: false, msg: '❌ Юзернейм: латиница/цифры/_, 4–32 символа' };
                if (CLOUD) await loginsPull(); /* чужие сессии/спам-штампы должны быть видны */
                loginCleanup();
                state.loginSpam = state.loginSpam || {};
                if (Date.now() - (state.loginSpam[uname] || 0) < 60000) return { ok: false, msg: '⏳ Только что высылали — проверь чат @FI_CoinBot в Telegram' };
                const tp = Object.values(state.players).find(x => (x.username || '').toLowerCase() === uname);
                if (!tp) return { ok: false, msg: `❌ @${uname} не регался в мини-игре. Открой @FI_CoinBot в Telegram и жми «Играть 🪙»` };
                if (tp.banned) return { ok: false, msg: '🚫 Профиль заблокирован' };
                if (!tp.username) return { ok: false, msg: '❌ У профиля нет @username — задай его в настройках Telegram' };
                const live = loginSessions().find(x => String(x.to) === String(tp.id) && loginLive(x));
                if (live) return { ok: false, msg: '⏳ Подтверждение уже выслано — открой чат @FI_CoinBot' };
                const st = crypto.randomBytes(12).toString('hex');
                const msg = await send(tp.id,
                    `🔐 <b>Вход в приложение FI Coin</b>\nКто-то на телефоне просит войти как <b>${fname(tp)}</b> (${uname}).\n\n<b>Это ты?</b>`,
                    [[{ text: '✅ Да, это я', callback_data: 'lgok:' + st }, { text: '❌ Это не я', callback_data: 'lgno:' + st }]]);
                if (!msg) return { ok: false, msg: '❌ Telegram недоступен — попробуй через минуту' };
                state.loginSpam[uname] = Date.now();
                loginSessions().push({ st, to: String(tp.id), chatId: tp.id, msgId: msg.message_id, at: Date.now(), phase: 'check' });
                saveState();
                adminSay(`📱 ${fname(tp)} (@${uname}) запросил 2FA-вход в приложение`);
                if (CLOUD) await loginsPush(); /* сессия переживёт и соседний изолят */
                return { ok: true, st };
            }
            /* 2FA-вход, шаг 2: APK поллит состояние сессии */
            if (mode === 'loginPoll') {
                loginCleanup();
                let sess = loginSessions().find(x => x.st === String(body.st || ''));
                if (!sess && CLOUD) { await loginsPull(); sess = loginSessions().find(x => x.st === String(body.st || '')); }
                if (!sess) return { ok: true, phase: 'gone' };
                /* переходные фазы (check/ask) сосед мог уже продвинуть — сверяемся с файлом, иначе APK повиснет */
                if (CLOUD && (sess.phase === 'check' || sess.phase === 'ask')) {
                    await loginsPull();
                    sess = loginSessions().find(x => x.st === String(body.st || '')) || sess;
                }
                let phase = sess.phase;
                if (phase === 'code' && Date.now() - (sess.codeAt || 0) > LOGIN_CODE_TTL) {
                    sess.code = null; sess.phase = 'expired'; phase = 'expired';
                    /* код протух — удаляем сообщение из чата (облако может пересоздаться,
                       setTimeout не гарантирован: чистим лениво при первом же опросе) */
                    if (!sess.msgDel) {
                        sess.msgDel = 1;
                        try { tg('deleteMessage', { chat_id: sess.chatId, message_id: sess.msgId }).catch(() => { }); } catch (_) { }
                    }
                    if (CLOUD) await loginsPush();
                }
                return { ok: true, phase, left: phase === 'code' ? Math.max(0, Math.ceil((sess.codeAt + LOGIN_CODE_TTL - Date.now()) / 1000)) : 0 };
            }
            /* 2FA-вход, шаг 3: APK вводит 30-значный код (двойной фактор) */
            if (mode === 'loginRedeem') {
                let sess = loginSessions().find(x => x.st === String(body.st || ''));
                if (!sess && CLOUD) { await loginsPull(); sess = loginSessions().find(x => x.st === String(body.st || '')); }
                if (!sess) return { ok: false, msg: '❌ Сессия истекла — начни вход заново' };
                if (sess.phase !== 'code' || !sess.code) return { ok: false, msg: '❌ Кода нет — нажми «🔑 Да, я хочу зайти» в чате заново' };
                if (Date.now() - (sess.codeAt || 0) > LOGIN_CODE_TTL) { sess.code = null; sess.phase = 'expired'; saveState(); if (CLOUD) await loginsPush(); return { ok: false, msg: '⏰ Код прожил свои 2 минуты — начни заново' }; }
                sess.tries = (sess.tries || 0) + 1;
                const code = String(body.code || '').replace(/\D/g, '');
                if (code !== sess.code) {
                    if (sess.tries >= 5) { sess.code = null; sess.phase = 'expired'; saveState(); if (CLOUD) await loginsPush(); return { ok: false, msg: '🚫 5 неверных кодов — сессия закрыта, начни заново' }; }
                    saveState();
                    if (CLOUD) await loginsPush();
                    return { ok: false, msg: `❌ Код не подошёл (осталось попыток: ${5 - sess.tries})` };
                }
                const tp = state.players[sess.to];
                if (!tp) return { ok: false, msg: '❌ Профиль не найден' };
                const uid = String(body.uid || ''), secret = String(body.secret || '');
                if (!/^W\d{13}$/.test(uid) || !/^[0-9a-f]{64}$/.test(secret)) return { ok: false, msg: '❌ Данные устройства некорректны' };
                linkDeviceToPlayer(uid, secret, tp);
                sess.phase = 'done'; sess.code = null;
                try { send(tp.id, `✅ <b>Вход выполнен</b>\nОткрывай приложение FI Coin — играешь своим профилем (${fname(tp)}).`); } catch (_) { }
                adminSay(`🔑 ${fname(tp)} вошёл в приложение по 2FA-коду (…${uid.slice(-4)})`);
                saveState();
                if (CLOUD) await loginsPush();
                return { ok: true };
            }
            /* телефон: отдельный профиль (нужен ник) */
            if (mode === 'register') {
                const uid = String(body.uid || ''), secret = String(body.secret || ''), nick = String(body.nick || '').trim();
                if (!/^W\d{13}$/.test(uid)) return { ok: false, msg: '❌ Некорректный UID устройства' };
                if (!/^[0-9a-f]{64}$/.test(secret)) return { ok: false, msg: '❌ Некорректный секрет устройства' };
                if (devicesMap()[uid]) return { ok: false, msg: '💭 Это устройство уже зарегистрировано — просто открой игру' };
                if (!/^[-A-Za-zА-Яа-яЁё0-9_ ]{2,16}$/.test(nick)) return { ok: false, msg: '❌ Ник: 2–16 символов (буквы, цифры, пробел, _)' };
                const nl = nick.toLowerCase();
                const taken = Object.values(state.players).some(x =>
                    (x.username || '').toLowerCase() === nl || (x.first_name || '').toLowerCase() === nl);
                if (taken) return { ok: false, msg: `❌ Ник «${nick}» уже занят — придумай другой` };
                const p = newPlayer({ id: uid, first_name: nick.slice(0, 16), username: '' });
                p.via = 'phone';
                state.players[uid] = p;
                state.linkCodes = (state.linkCodes || []).filter(c => c.uid !== uid); /* отозванные подтверждения не прилетят задним числом */
                putDevice(uid, { s: secret, p: uid });
                adminSay(`📱 Новый телефонный игрок «${fname(p)}» (${uid})`);
                return { ok: true, msg: '✅ Профиль создан', nick: fname(p) };
            }
            /* телефон + код из мини-игры (или кнопка-подтверждение) → играем тем же профилем, что в Telegram */
            if (mode === 'link') {
                const uid = String(body.uid || ''), secret = String(body.secret || '');
                const code = String(body.code || '').trim().toUpperCase();
                if (!/^W\d{13}$/.test(uid) || !/^[0-9a-f]{64}$/.test(secret)) return { ok: false, msg: '❌ Некорректные данные устройства' };
                state.linkCodes = state.linkCodes || [];
                state.linkCodes = state.linkCodes.filter(c => Date.now() - c.at < 10 * 60000);
                /* авто-вход: игрок подтвердил привязку этого uid в мини-игре уже (kind==='pair' — НЕ подтверждение!) */
                let lc = state.linkCodes.find(c => c.uid === uid && !c.kind);
                if (!lc) lc = state.linkCodes.find(c => c.code === code);
                if (!lc) {
                    if (!code) return { ok: false, wait: true, msg: '⏳ Жду подтверждения в Telegram…' };
                    return { ok: false, msg: '❌ Код не найден или истёк (10 минут) — возьми новый в мини-игре' };
                }
                const tp = state.players[lc.to];
                if (!tp) return { ok: false, msg: '❌ Профиль Telegram не найден' };
                linkDeviceToPlayer(uid, secret, tp);
                state.linkCodes = state.linkCodes.filter(c => c.code !== code && c.uid !== uid);
                adminSay(`🔗 ${fname(tp)} привязал телефон (${uid})`);
                try { send(tp.id, `📱 <b>Телефон привязан!</b>\nОткрой приложение на телефоне — тот же баланс и та же ферма, что и здесь.`); } catch (_) { }
                return { ok: true, msg: '✅ Связано! Открывай игру на телефоне' };
            }
            return { ok: false, msg: '❌ Неизвестный режим' };
        } catch (e) { return { ok: false, msg: '❌ Ошибка: ' + e.message }; }
    }

    if (pathname === '/api/sync') {
        const au = authPlayer(body);
        if (!au) return { ok: false, err: 'auth' };
        const p = au.p;
        p.lastSeen = Date.now(); /* 🟢 онлайн = заходил в игру последние 2 минуты */
        let msg = '';
        let oneRes = null;
        cleanupDuels();
        const actions = Array.isArray(body.actions) ? body.actions.slice(0, 10) : [];
        for (const act of actions) {
            const r = apiRunAction(p, act);
            if (r && r.msg) msg = r.msg;
            if (actions.length === 1) oneRes = r || null;
            if (r && r.ok === false) break;
        }
        saveState();
        saveStateToGitHub(false);
        const snap = apiSnapshot(p);
        snap.msg = msg;
        /* Результат одиночного действия отдаём в ответе целиком (ok/seg/win и т.п.) — иначе клиент не отличает успех от проигрыша */
        if (actions.length === 1 && oneRes && typeof oneRes === 'object') {
            const { msg: _m, ...rest } = oneRes;
            snap.ok = oneRes.ok !== false;
            Object.assign(snap, rest);
        }
        return snap;
    }

    if (pathname === '/api/staff') {
        const au = authPlayer(body);
        if (!au) return { ok: false, err: 'auth' };
        const role = apiRole(au.tg);
        if (!role) return { ok: false, err: 'forbidden' };
        const p = au.p;
        const r = await apiRunStaff(au.tg, role, body.action || {});
        if (r && r.ok !== false) { saveState(); saveStateToGitHub(false); }
        const out = Object.assign({ role: { kind: role.kind, name: role.name, color: role.color, perms: role.perms } }, r);
        if (!/^(players|log|who|roles)$/.test(String((body.action || {}).a))) out.snap = apiSnapshot(p);
        return out;
    }

    return { ok: false, err: 'not found' };
}

function startApiServer() {
    const srv = http.createServer(async (req, res) => {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '600'
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        let bodyRaw = '';
        req.on('data', d => { bodyRaw += d; if (bodyRaw.length > 65536) req.destroy(); });
        req.on('end', async () => {
            try {
                const out = await apiRoute(String(req.url || '/').replace(/\?.*$/, ''), req.method, bodyRaw);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
                res.end(JSON.stringify(out));
            } catch (e) {
                console.error('[api]', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
                res.end(JSON.stringify({ ok: false, err: 'server' }));
            }
        });
    });
    srv.on('error', e => console.error('[api] порт занят?', e.message));
    srv.listen(API_PORT, '0.0.0.0', () => console.log(`🌐 API онлайн: http://127.0.0.1:${API_PORT} (health: /health)`));
}

/* ------------------------- ЦИКЛ ОПРОСА ------------------------- */
let offset = 0;
async function pollLoop() {
    while (true) {
        const upd = await tg('getUpdates', {
            timeout: 30, offset,
            allowed_updates: ['message', 'callback_query']
        });
        if (!upd) { await sleep(5000); continue; }
        for (const u of upd) {
            offset = u.update_id + 1;
            try {
                if (u.callback_query) await onCallback(u.callback_query);
                else if (u.message) await onMessage(u.message);
            } catch (e) { console.error('[update]', e.message, e.stack && e.stack.split('\n')[1]); saveState(); }
        }
    }
}

/* ------------------------- CALLBACK ------------------------- */
async function onCallback(q) {
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
            try { await send(chat, '🔑 <b>КОД ВХОДА в FI Coin</b>: <code>' + rec.code + '</code>\nЖивёт 10 минут. Введи его в приложении.'); } catch (_) { }
            return;
        }
        await answer(q, '🤖 Игра переехала в приложение FI Coin — бот только для 2FA 🙂');
    } catch (e) {
        try { await answer(q, 'Ошибка'); } catch (_) { }
    }
}

/* ------------------------- СООБЩЕНИЯ ------------------------- */
const BANNED_ALLOWED = new Set(['start', 'id', 'cancel', 'help']);

async function onMessage(msg) {
    const text = (msg.text || '').trim();
    if (!text) return;
    const chat = msg.chat.id;
    const user = msg.from || {};
    const cmd = (text.match(/^\/(\w+)/) || [])[1] || '';
    const m = text.split(/\s+/);

    ensurePlayer(user); /* TG-участник существует как игрок (legacy-совместимость) */

    /* 🔐 привязка TG-чата к аккаунту приложения: /start <код> (кнопка из приложения подставляет код сама) */
    if (cmd === 'start' && m[1]) {
        accCleanup();
        const code = String(m[1]).trim().toUpperCase();
        const b = state.tgBindCodes[code];
        if (!b) return send(chat, '⌛ Код привязки не найден или устарел.\nВ приложении: «Профиль» → «🔐 Привязать Telegram» — и пришли НОВЫЙ код.');
        const tp = state.players[b.pid];
        if (!tp) return send(chat, '❌ Игрок кода не найден — попробуй заново в приложении.');
        tp.auth = tp.auth || { nick: fname(tp), nickKey: accNickKey(tp.auth && tp.auth.nick || ''), salt: '', passHash: '', tgChatId: '', tgUsername: '', devs: {} };
        tp.auth.tgChatId = String(user.id);
        tp.auth.tgUsername = String(user.username || '').toLowerCase();
        delete state.tgBindCodes[code];
        saveState(); saveStateToGitHub(false);
        logLine('🔐 ' + fname(tp) + ' привязал Telegram как 2FA');
        return send(chat,
            '✅ <b>Telegram привязан к аккаунту «' + esc(tp.auth.nick || fname(tp)) + '»</b> — теперь это второй фактор (2FA).\n\n' +
            '🔒 При входе с нового устройства сюда придёт запрос «это ты?» — без твоего подтверждения никто не войдёт, даже зная пароль.\n\n' +
            'Вернись в приложение — и продолжай игру.');
    }

    switch (cmd) {
        case 'start':
            return send(chat,
                '🪙 <b>' + esc(S('title')) + ' — бот защиты входа (2FA)</b>\n\n' +
                'Вся игра переехала в приложение FI Coin — здесь только безопасность:\n' +
                '• подтверждаешь вход с нового устройства («это ты?»)\n' +
                '• привязываешь Telegram к аккаунту приложения.\n\n' +
                '🔐 Привязка: открой приложение → «Профиль» → «🔐 Привязать Telegram» — придёшь сюда с готовой командой.');
        case 'code': {
            if (m[1]) { msg.text = '/start ' + m[1]; return onMessage(msg); }
            return send(chat, 'Код привязки появляется в приложении: «Профиль» → «🔐 Привязать Telegram».');
        }
        case 'help': case 'id':
            return send(chat, '🆔 Твой Telegram ID: <code>' + user.id + '</code>\n🤖 Я 2FA-бот: коды входа приходят сюда автоматически.');
        default:
            return;
    }
}

/* ---- уведомления игроку через ЛС ---- */
async function notifyBan(tp, reason) {
    try {
        await tg('sendMessage', { chat_id: tp.id, parse_mode: 'HTML', text: `🚫 <b>Тебя забанили в ${esc(S('title'))}.</b>\nПричина: ${esc(reason || 'не указана')}\n\nСпор — у администрации.` });
    } catch (_) { }
}
async function notifyGift(tp, amount, kind) {
    try {
        await tg('sendMessage', { chat_id: tp.id, parse_mode: 'HTML', text: `🎁 Тебе выдали <b>${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}</b>!` });
    } catch (_) { }
}
async function broadcastAll(text, byWho) {
    let ok = 0, fail = 0;
    for (const p of Object.values(state.players)) {
        if (p.banned) continue;
        const r = await tg('sendMessage', {
            chat_id: p.id, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
            text: `📢 <b>${esc(S('title'))} — объявление</b>\n\n${text}`
        });
        if (r) ok++; else fail++;
        await sleep(60);
    }
    adminSay(`📢 ${esc(byWho)} рассылка → ${ok} delivered${fail ? `, ${fail} failed` : ''}`);
    return { ok, fail };
}

/* ------------------------- DIALOG ВВОД ------------------------- */
async function onDialogInput(user, chat, dlg, text) {
    const answerNow = async (t, kb) => { delete state.dialogs[user.id]; return send(chat, t, kb); };

    /* --- вход staff --- */
    if (dlg.type === 'auth') {
        if (text.trim() === String(CFG.staffPassword)) {
            delete state.dialogs[user.id];
            let first = !state.ownerId;
            if (first) { state.ownerId = user.id; adminSay(`👑 Владелец назначен: ${fname(user)} (${user.id})`); }
            if (!state.staffIds.includes(user.id)) { state.staffIds.push(user.id); adminSay(`🔓 ${fname(user)} staff-доступ (пароль)`); }
            saveState();
            const s = screenStaff();
            await send(chat, `✅ Доступ открыт${first ? ' — <b>ты владелец 👑</b>' : ''}.`, s.kb);
            return true;
        }
        return answerNow('❌ Неверный пароль. Введи /staff заново.');
    }

    /* --- подтверждения сбросов --- */
    if (dlg.type === 'confirm_reset_balances' || dlg.type === 'confirm_nuke' ) {
        if (!/^да$/i.test(text.trim())) return answerNow('🚫 Сброс отменён.');
        delete state.dialogs[user.id];
        if (dlg.type === 'confirm_nuke') {
            const keep = state.players[state.ownerId];
            state.players = {};
            if (keep) state.players[keep.id] = Object.assign({}, keep, { miners: {}, fi: S('startFi'), usd: S('startUsd'), banned: false });
            state.market = freshMarket();
            adminSay(`💥 ${fname(user)} удалил всё (nuke)`);
        } else {
            for (const p of Object.values(state.players)) {
                if (state.staffIds.includes(p.id)) continue;
                p.usd = 0; p.fi = 0;
            }
            adminSay(`🧯 ${fname(user)} обнулил балансы`);
        }
        saveState();
        await send(chat, '✅ Готово.');
        const s = screenStaff();
        return (await send(chat, s.text, s.kb), true);
    }

    /* --- выдача монет/USD --- */
    if (dlg.type === 'give_fi' || dlg.type === 'give_usd') {
        const kind = dlg.type === 'give_fi' ? 'fi' : 'usd';
        const parts = text.trim().split(/\s+/);
        const amount = parseFloat((parts[parts.length - 1] || '').replace(',', '.'));
        const target = parts.slice(0, -1).join(' ').replace(/^@/, '').toLowerCase();
        if (!isFinite(amount) || !target) return answerNow('❌ Формат: <code>ник сумма</code> (например <code>steve 500</code> или <code>* 100</code>)', kbHome());
        if (target === '*' || target === 'все' || target === 'all') {
            const n = giveAll(kind, amount, fname(user));
            saveState();
            return answerNow(`✅ Выдал ${n} игрокам: ${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}`, kbHome());
        }
        const tp = findPlayerByNameOrId(target);
        if (!tp) return answerNow(`❌ Игрок «${esc(target)}» не найден. Пусть откроет бота и нажмёт /start.`, kbHome());
        giveTo(tp, kind, amount);
        adminSay(`🤝 ${fname(user)} выдал ${fname(tp)}: ${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}`);
        saveState();
        notifyGift(tp, amount, kind);
        return answerNow(`✅ <b>${fname(tp)}</b> получает ${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}\n(сообщение отправлено игроку в ЛС)`, kbHome());
    }

    /* --- выдать/забрать карточке игрока --- */
    if (dlg.type === 'pgive') {
        const tp = state.players[dlg.target];
        const amount = parseFloat(text.replace(',', '.'));
        if (!tp) return answerNow('❌ Игрок не найден.');
        if (!(isFinite(amount) && amount > 0)) return answerNow('❌ Пришли положительное число.');
        giveTo(tp, dlg.kind, amount * dlg.sign);
        adminSay(`🔧 ${fname(user)}: ${dlg.sign > 0 ? '+' : '−'}${fmt(amount)} ${dlg.kind === 'usd' ? 'USD' : S('coinName')} → ${fname(tp)}`);
        saveState();
        return answerNow(`✅ ${fname(tp)}: ${dlg.kind === 'usd' ? '💵 $' + fmt(tp.usd) : CI(tp.fi)}`, kbHome());
    }

    /* --- установить цену --- */
    if (dlg.type === 'setprice') {
        const v = parseFloat(text.replace(',', '.'));
        if (!(isFinite(v) && v > 0)) return answerNow('❌ Некорректная цена.');
        setPrice(v);
        saveState();
        return answerNow(`🎯 Цена ${esc(S('coinName'))}: <b>$${fmt(state.market.price)}</b>`, kbHome());
    }

    /* --- торговля --- */
    if (dlg.type === 'trade_buy' || dlg.type === 'trade_sell') {
        const M = state.market;
        const p = findPlayer(user);
        if (!p) return answerNow('❌ Сначала /start');
        if (p.banned) return answerNow('🚫 Забанен — рынок закрыт.');
        let amt;
        if (/^(все|all)$/i.test(text)) amt = dlg.type === 'trade_sell' ? p.fi : p.usd / (M.price * (1 + S('buySpreadPct') / 100));
        else amt = parseFloat(text.replace(',', '.'));
        if (!isFinite(amt) || amt <= 0) return answerNow('❌ Пришли положительное число или «все».');
        if (dlg.type === 'trade_buy') {
            const cost = amt * M.price * (1 + S('buySpreadPct') / 100);
            if (cost > p.usd) return answerNow(`❌ Хватает только на ${fmt(p.usd / (M.price * (1 + S('buySpreadPct') / 100)))} монет. Пришли меньше или «все».`);
            p.usd -= cost; p.fi += amt; p.bought += amt; dayOf(p).buy += amt;
            adminSay(`🟢 ${fname(p)} купил ${CIn(amt).replace(/<[^>]+>/g, '')} за $${fmt(cost)}`);
            return answerNow(`🟢 Куплено ${CIn(amt)}\n💵 Осталось: $${fmt(p.usd)}\n🪙 Теперь: ${CIn(p.fi)}`, kbHome());
        }
        if (amt > p.fi) return answerNow(`❌ У тебя только ${CIn(p.fi)}`);
        const usd = amt * M.price * (1 - S('sellSpreadPct') / 100);
        p.fi -= amt; p.usd += usd; p.sold += amt;
        adminSay(`🔴 ${fname(p)} продал ${CIn(amt).replace(/<[^>]+>/g, '')} за $${fmt(usd)}`);
        return answerNow(`🔴 Продано ${CIn(amt)}\n💵 Получено: $${fmt(usd)}\n🪙 Осталось: ${CIn(p.fi)}`, kbHome());
    }

    /* --- рассылка --- */
    if (dlg.type === 'broadcast') {
        delete state.dialogs[user.id];
        adminSay(`📢 ${fname(user)} запустил рассылку`);
        await send(chat, '⏳ Рассылка...');
        const res = await broadcastAll(text.slice(0, 3500), fname(user));
        saveState();
        return send(chat, `✅ Доставлено: <b>${res.ok}</b>${res.fail ? `\n⚠️ Не доставлено: ${res.fail}` : ''}`);
    }

    /* --- текстовые настройки --- */
    if (dlg.type === 'settext') {
        const f = TEXT_FIELDS[dlg.field];
        if (!f) return answerNow('❓');
        if (text.trim().length > f.max) return answerNow(`❌ Максимум ${f.max} симв.`);
        const oldValue = state.settings[dlg.field];
        state.settings[dlg.field] = text.trim();
        adminSay(`✍️ ${fname(user)}: ${dlg.field} «${String(oldValue).slice(0, 30)}» → «${text.trim().slice(0, 30)}»`);
        saveState();
        return answerNow(`✅ <b>${esc(f.label)}</b> обновлено:\n«${esc(text.trim().slice(0, 300))}»`, kbHome());
    }

    /* --- числовые настройки --- */
    if (dlg.type === 'setnum') {
        const defs = [...NUM_FIELDS.market, ...NUM_FIELDS.econ];
        const f = defs.find(x => x.key === dlg.field);
        if (!f) return answerNow('❓');
        const v = parseFloat(text.replace(',', '.'));
        if (!isFinite(v)) return answerNow('❌ Пришли число (можно дробное, точкой или запятой).');
        const min = { volatilityPct: 0.1, eventChancePct: 0, buySpreadPct: 0, sellSpreadPct: 0, workIntervalMin: 1 }[dlg.field] ?? 0;
        if (v < min) return answerNow(`❌ Минимально: ${min}`);
        const old = state.settings[dlg.field];
        state.settings[dlg.field] = v;
        adminSay(`🔢 ${fname(user)}: ${dlg.field} ${old} → ${v}`);
        /* новый старт-баланс касается только новых игроков — ретроактивно не пересчитываем */
        saveState();
        return answerNow(`✅ <b>${esc(f.label)}</b>\n${old} → <b>${v}</b>`, kbHome());
    }

    /* --- добавить staff --- */
    if (dlg.type === 'staffadd') {
        const tp = findPlayerByNameOrId(text.trim());
        if (!tp) return answerNow('❌ Игрок не найден. Он должен открыть бота (/start).');
        if (state.staffIds.includes(tp.id)) return answerNow('ℹ️ Уже staff.');
        state.staffIds.push(tp.id);
        adminSay(`➕ ${fname(user)} назначил staff: ${fname(tp)}`);
        saveState();
        return answerNow(`✅ ${fname(tp)} теперь staff 🔧`, kbHome());
    }

    return false;
}

/* ------------------------- HELP ------------------------- */
function helpCmd(chat) {
    return send(chat,
        `🤖 <b>${esc(S('title'))} v7.1</b>\n\n${esc(S('welcome'))}\n\n` +
        `🏠 Меню — кнопкой или /start\n` +
        `👤 /profile · 📈 /market · 🏭 /shop · 🏆 /top\n` +
        `🎁 Бонус раз в день · 💼 Работа каждые ${S('workIntervalMin')} мин\n` +
        `📱 /linkcode — код для приложения на телефон\n` +
        `📱 /devices — моя привязка телефона · 🔐 /logout — сбросить все\n` +
        `📲 APK: ${PAGES_URL}apk/FI-Coin.apk\n` +
        `ℹ️ /price · 🆔 /id\n\n` +
        `<b>STAFF (для админов):</b>\n` +
        `🛠 /staff — открыть консоль (вход по паролю)\n` +
        `🪙 /give ник 100 fi|usd — выдать монеты (ник «*» — всем)\n` +
        `📈 /pump 10 · 📉 /dump 10 — движ цены на %\n` +
        `🎯 (в консоли: установить точно, заморозить)\n` +
        `🚫 /ban @ник причина · ✅ /unban @ник · 📋 /banlist\n` +
        `⚙️ Настройки темы и экономики — в консоли`,
        kbHome());
}

/* ------------------------- СТАРТ ------------------------- */
(async () => {
    /* доступ из облачной обёртки bot-cloud.js — в самом начале, до всех awaitов
       (мутируем существующий объект exports, чтобы ссылка из require не протухала) */
    try {
        module.exports.apiRoute = apiRoute;
        module.exports.onMessage = onMessage;
        module.exports.onCallback = onCallback;
        module.exports.catchupTicks = catchupTicks;
module.exports.subTick = subTick;
        module.exports.saveState = saveState;
        module.exports.CLOUD = CLOUD;
        /* для Cloudflare Workers (bot-worker.js читает глобал, exports из бандла может протухнуть) */
        globalThis.FI_BOT = { apiRoute, onMessage, onCallback, catchupTicks, subTick, saveState, CLOUD };
    } catch (e) { console.error('[exports]', e && e.message); }

    if (!CFG.token || CFG.token.includes('@BotFather')) {
        console.error('\n❌ В config.json не указан токен бота.\n' +
            '1) Открой @BotFather в Telegram\n' +
            '2) /newbot → имя и username\n' +
            '3) Скопируй токен (1234567:AA-...) в config.json → "token"\n' +
            '4) Запусти снова: node bot.js\n');
        process.exit(1);
    }
    loadState();
    if (!CLOUD) saveState();

    /* ☁ если есть GH_TOKEN — состояние игры живёт в GitHub (работает даже с выключенным ПК) */
    if (GH.token) await loadStateFromGitHub();
    if (CLOUD) saveState(); /* теперь состояние актуально + _gitSha свежий, пуши пройдут с первого раза */
    if (!CLOUD) startApiServer();
    /* на облаке GH-публикацию адреса тоже делаем — ЖДЁМ: в Workers незавершённые
       промисы убиваются вместе с ответом запроса, поэтому fire-and-forget не доживает */
    await pushApiJson().catch(e => { const s = (e && e.stack ? e.stack.split('\n')[0] : null) || (e && e.message); console.error('[api.json push]', s || 'no message'); });

    /* расписание тиков рынка: перечитываем эту переменную каждый раз */
    if (!CLOUD) {
        let tickTimer = null;
        const startTicker = () => {
            if (tickTimer) clearInterval(tickTimer);
            tickTimer = setInterval(marketTick, 30000);
        };
        startTicker();
        marketTick();
    }

    const me = await tg('getMe');
    if (!me) { console.error('❌ Telegram не отвечает / неверный токен.'); process.exit(1); }
    console.log(`✅ ${S('title')} (@${me.username}) — запущен.`);
    console.log(`👥 Игроков в базе: ${Object.keys(state.players).length}. Стафф: ${state.staffIds.length}. Цена FI: $${fmt(state.market.price)}`);
    console.log(`🛠 Пароль staff: ${CFG.staffPassword} (config.json)`);

    try { process.on('SIGINT', () => { saveState(); saveStateToGitHub(true); console.log('💾 Сохранено. Выход.'); process.exit(0); }); } catch (_) { }
    try { process.on('uncaughtException', e => console.error('[x]', e.message)); } catch (_) { }
    try { process.on('unhandledRejection', e => console.error('[x]', e && e.message)); } catch (_) { }

    /* облачный режим: включаем webhook и ждём входящие обновления от Telegram */
    if (CLOUD) {
        const PUBLISH = (ENV('PUBLIC_URL') || CFG.publicUrl || '').replace(/\/+$/, '');
        if (PUBLISH) {
            /* секрет вебхука: в облаке делаем его СТАБИЛЬНЫМ (выводим из токена) —
               иначе каждый бут нового изолята меняет секрет, и апдейты начнут
               отбрасываться 403-ми в старых изолятах (Workers может держать несколько) */
            const secret = CLOUD
                ? crypto.createHash('sha256').update(String(CFG.token) + '|fi-coin-webhook', 'utf8').digest('hex').slice(0, 32)
                : crypto.randomBytes(16).toString('hex');
            try { if (typeof globalThis !== 'undefined' && globalThis.FI_ENV) globalThis.FI_ENV.TG_WEBHOOK_SECRET = secret; } catch (_) { }
            try { process.env.TG_WEBHOOK_SECRET = secret; } catch (_) { }
            const ok = await tg('setWebhook', {
                url: PUBLISH + '/tg/webhook', secret_token: secret,
                allowed_updates: ['message', 'callback_query'], drop_pending_updates: false
            });
            console.log(ok ? `🔗 Webhook → ${PUBLISH}/tg/webhook` : '⚠️ setWebhook не удался (проверь PUBLIC_URL)');
        } else {
            console.log('⚠️ PUBLIC_URL не задан — Telegram-вебхук не включён (кнопки бота не сработают).');
        }
        console.log('🌐 Облачный режим: жду webhook от Telegram.');
        globalThis.FI_READY = true; /* обёртка (workers/deno) ждёт этот флаг — состояние прогружено */
        return; /* не запускаем бесконечный опрос */
    }

    await pollLoop();
})();

