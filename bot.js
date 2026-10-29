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
    try {
        const disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
        const cfg = Object.assign({}, defaults, disk);
        cfg.game = Object.assign({}, defaults.game, disk.game || {});
        if (!Array.isArray(cfg.miners) || !cfg.miners.length) cfg.miners = defaults.miners;
        return cfg;
    } catch (e) {
        try { fs.writeFileSync(CFG_PATH, JSON.stringify(defaults, null, 2), 'utf8'); } catch (_) { }
        return defaults;
    }
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
    if (Math.abs(n) >= 1000) return (n < 0 ? '-' : '') + fmtInt(n);
    if (Math.abs(n) < 1 && n !== 0) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return n.toFixed(2);
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fname = p => esc(p && (p.first_name || p.name) || 'Игрок');
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
    saveStateToGitHub(false);
}

/* ==================== ☁ ОБЛАКО: GitHub-хранилище состояния ==================== */
const ENV = k => String(process.env[k] || '').trim();
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
    const j = await ghApi('GET', '/contents/data/state.json?ref=' + GH.branch);
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
    const url = ENV('PUBLIC_URL') || CFG.publicUrl || '';
    if (!url || !GH.token) return;
    try {
        const j = await ghApi('GET', '/contents/api.json?ref=' + GH.branch);
        const body = {
            message: 'chore: api url',
            content: Buffer.from(JSON.stringify({ api: url.replace(/\/+$/, ''), t: Date.now() })).toString('base64'),
            branch: GH.branch
        };
        if (j && j.sha) body.sha = j.sha;
        const r = await ghApi('PUT', '/contents/api.json', body);
        if (r) console.log('📡 api.json обновлён в GitHub → ' + url);
    } catch (e) { console.error('[gh] api.json', e.message); }
}
let gitSaving = false, gitLastSave = 0;
function saveStateToGitHub(force) {
    if (!GH.token) return Promise.resolve(false);
    const now = Date.now();
    if (!force && (gitSaving || now - gitLastSave < 140000)) return Promise.resolve(false);
    gitSaving = true; gitLastSave = now;
    return (async () => {
        try {
            /* приватное в публичное зеркало не уезжает: коды привязки (кража с GitHub = захват игры
               по связке) и контексты кнопок (чат-ID). В памяти бота они остаются включая использование */
            const remote = Object.assign({}, state, { linkCodes: [], dialogs: {} });
            const body = {
                message: 'chore: bot state sync',
                content: Buffer.from(JSON.stringify(remote)).toString('base64'),
                branch: GH.branch
            };
            if (state._gitSha) body.sha = state._gitSha;
            const j = await ghApi('PUT', '/contents/data/state.json', body);
            if (j && j.content && j.content.sha) { state._gitSha = j.content.sha; return true; }
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
        const secret = crypto.createHmac('sha256', 'WebAppData').update(CFG.token).digest();
        const calc = crypto.createHmac('sha256', secret).update(pairs.map(([k, v]) => `${k}=${v}`).join('\n')).digest('hex');
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
function devKey() { return crypto.createHash('sha256').update(CFG.token + '|fi-device-vault').digest(); }
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
    const ct = Buffer.concat([c.update(JSON.stringify(rec)), c.final()]);
    state.deviceVault = state.deviceVault || {};
    state.deviceVault[uid] = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    devicesMap()[uid] = rec;
    saveState();
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
        const calc = crypto.createHmac('sha256', String(rec.s)).update(uid + ':' + ts).digest('hex');
        return calc === sig.toLowerCase() ? (state.players[rec.p] || null) : null;
    } catch (_) { return null; }
}
function authPlayer(body) {
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
    return {
        t: now,
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
                return { i, ico: q.ico, d: q.d, t: q.t, v: Math.round(v * 100) / 100, claimed: !!(d.claimed || {})[i], done: v >= q.t };
            }),
            via: p.via === 'phone' ? 'phone' : 'tg',
            linked: !!p.uid,
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
function apiRunStaff(user, role, act) {
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
                    return { id: x.id, n: fname(x), fi: x.fi, usd: x.usd, h: totalHash(x), b: !!x.banned, r: x.banReason || '', role: rd ? { name: rd.name, color: rd.color } : null };
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
        default: return { ok: false, msg: '❌ Неизвестное действие' };
    }
}

async function apiRoute(pathname, method, bodyRaw) {
    if (method === 'GET') {
        if (pathname === '/health') return { ok: true, name: S('title'), price: state.market.price, t: Date.now() };
        return { ok: false, err: 'not found' };
    }
    let body;
    try { body = JSON.parse(bodyRaw || '{}'); } catch (e) { return { ok: false, err: 'bad json' }; }

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
                /* если телефон раньше играл отдельно — переносим его прогресс в Telegram-профиль */
                const old = state.players[uid];
                if (old) {
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
                tp.uid = uid;
                putDevice(uid, { s: secret, p: String(tp.id) });
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
        const r = apiRunStaff(au.tg, role, body.action || {});
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
    const msg = q.message;
    if (!msg) { return answer(q); }
    const chat = msg.chat.id, mid = msg.message_id;
    const user = q.from;
    const parts = q.data.split(':');
    const [a, b, c, d] = parts;

    try {
        /* выход в меню / экраны (доступны и забаненным для просмотра запроса) */
        if (a === 'tab') {
            const p = ensurePlayer(user);
            if (p.banned && b !== 'profile') return answer(q, '🚫 Забанен — посмотри /profile');
            let screen;
            if (b === 'main') screen = screenMain();
            else if (b === 'profile') screen = screenProfile(p);
            else if (b === 'market') screen = screenMarket(p);
            else if (b === 'shop') screen = screenShop(p);
            else if (b === 'top') screen = screenTop();
            else if (b === 'staff') {
                if (!isStaff(user)) { return answer(q, '🔒 Нет доступа: введи /staff'); }
                screen = screenStaff();
            } else screen = screenMain();
            const ok = await edit(chat, mid, screen.text, screen.kb);
            if (!ok) await send(chat, screen.text, screen.kb);
            return answer(q);
        }

        /* отмена диалога */
        if (a === 'dlg' && b === 'cancel') {
            delete state.dialogs[user.id];
            await answer(q, 'Отменено');
            return send(chat, '🆗 Отменено.');
        }

        /* дуэли: кнопки «Принять/Отклонить» в уведомлении — только тому, кому адресован вызов */
        if (a === 'dacc' || a === 'ddeny') {
            const p = ensurePlayer(user);
            if (p.banned) { saveState(); return answer(q, '🚫 Забанен'); }
            const d = (state.duels || []).find(x => x.id === b && String(x.toId) === String(p.id));
            if (!d) { saveState(); return answer(q, '❗ Вызов уже неактуален'); }
            state.duels = (state.duels || []).filter(x => x.id !== d.id);
            const fp = state.players[d.fromId];
            if (a === 'ddeny' || !fp) {
                if (fp) fp.usd += d.amount;
                if (fp) { try { send(fp.id, `✖️ <b>${esc(fname(p))}</b> отклонил твой вызов. Ставка $${fmt(d.amount)} вернулась.`); } catch (_) { } }
                try { await edit(chat, mid, `✖️ ${esc(d.fromName)} → ${esc(fname(p))}: вызов отклонён, ставка возвращена.`); } catch (_) { }
                adminSay(`✖️ ${fname(p)} (tg) отклонил вызов ${d.fromName} — $${fmt(d.amount)} возвращено`);
                saveState();
                return answer(q, 'Отклонено — ставка вернулась сопернику');
            }
            if ((p.usd || 0) < d.amount) {
                fp.usd += d.amount;
                try { send(fp.id, `❗ ${esc(fname(p))} не смог оплатить ставку — вызов отменён, деньги возвращены.`); } catch (_) { }
                try { await edit(chat, mid, `❗ Ставку не оплатить — вызов отменён, ставка возвращена ${esc(fname(fp))}.`); } catch (_) { }
                saveState();
                return answer(q, 'Не хватило на ставку — вызов отменён');
            }
            p.usd -= d.amount;
            const pot = d.amount * 2;
            const accWins = Math.random() < 0.5;
            const winner = accWins ? p : fp;
            winner.usd += pot;
            winner.duelWins = (winner.duelWins || 0) + 1;
            adminSay(`⚔️ Дуэль (tg): ${fname(winner)} победил ${fname(accWins ? fp : p)} — банк $${fmt(pot)}`);
            try { send(winner.id, `⚔️ <b>Дуэль с ${esc(fname(accWins ? fp : p))}</b>\n🏆 Победа! Приз $${fmt(pot)}`); } catch (_) { }
            try { send((accWins ? fp : p).id, `⚔️ <b>Дуэль с ${esc(fname(winner))}</b>\n💀 Поражение. −$${fmt(d.amount)}`); } catch (_) { }
            try { await edit(chat, mid, `⚔️ Дуэль ${esc(d.fromName)} vs ${esc(fname(p))}: <b>${esc(fname(winner))}</b> победил! Банк $${fmt(pot)}.`); } catch (_) { }
            saveState();
            return answer(q, accWins ? `🏆 Победа! +$${fmt(pot)}` : `💀 Проиграл −$${fmt(d.amount)}`);
        }

        const p = ensurePlayer(user);

        if (a === 'act') {
            if (p.banned) return answer(q, '🚫 Забанен — действия закрыты');
            if (b === 'bonus') {
                const today = new Date().toDateString();
                if (p.bonusDay === today) return answer(q, '❄️ Бонус уже получен сегодня');
                p.bonusDay = today;
                giveTo(p, 'usd', S('bonusDailyUsd'));
                giveTo(p, 'fi', S('bonusDailyFi'));
                adminSay(`🎁 ${fname(p)} получил дневной бонус`);
                await answer(q, `🎁 +$${fmt(S('bonusDailyUsd'))} и ${CIn(S('bonusDailyFi')).replace(/<[^>]+>/g, '')}`);
            } else if (b === 'work') {
                const need = S('workIntervalMin') * 60000;
                const left = p.workAt + need - Date.now();
                if (left > 0) return answer(q, `💼 Смена будет через ${Math.ceil(left / 60000)} мин`);
                const pay = Math.round(rng(S('workPayMin'), S('workPayMax')));
                p.usd += pay;
                p.workAt = Date.now();
                adminSay(`💼 ${fname(p)} отработал смену +$${pay}`);
                await answer(q, `💼 Смена отработана! +$${fmt(pay)}`);
            } else if (b === 'lcode') {
                if (p.uid) {
                    await answer(q, '📱 Приложение уже привязано');
                    return send(chat, `📱 Приложение уже привязано к этому профилю (ID <code>${esc(p.uid)}</code>).\nОткрой игру на телефоне — баланс общий.`);
                }
                const code = createLinkCode(p);
                adminSay(`📱 ${fname(p)} получил код для приложения`);
                await answer(q, '📱 Код на 10 минут');
                await send(chat,
                    `📱 <b>Код для приложения на телефон</b>\n\n` +
                    `<b><code>${code}</code></b>\n\n` +
                    `1) Открой игру на телефоне (APK или сайт)\n` +
                    `2) Введи код в поле «Код привязки (ABCD-1234)»\n` +
                    `3) Баланс станет общим — и тут, и в приложении ✅\n\n` +
                    `⏳ Код живёт 10 минут и работает один раз.`);
            }
            saveState();
            const sp = screenProfile(p);
            const ok = await edit(chat, mid, sp.text, sp.kb);
            if (!ok) await send(chat, sp.text, sp.kb);
            return;
        }

        if (a === 'mk') {
            if (p.banned) return answer(q, '🚫 Забанен — рынок закрыт');
            if (b === 'buy' || b === 'sell') {
                state.dialogs[user.id] = { type: b === 'buy' ? 'trade_buy' : 'trade_sell', t: Date.now() };
                await answer(q);
                return send(chat, `${b === 'buy' ? '🟢 <b>Покупка</b>' : '🔴 <b>Продажа</b>'} ${esc(S('coinName'))}\n\n` +
                    `Курс: <b>$${fmt(state.market.price * (b === 'buy' ? 1 + S('buySpreadPct') / 100 : 1 - S('sellSpreadPct') / 100))}</b> за монету\n` +
                    (b === 'buy' ? `У тебя: $${fmt(p.usd)}` : `У тебя: ${CIn(p.fi).replace(/<[^>]+>/g, '')}`) +
                    `\n\nПришли количество монет (или слово «все»):`, kbCancel());
            }
        }

        if (a === 'shop' && b === 'buy') {
            if (p.banned) return answer(q, '🚫 Забанен');
            const m = miner(c);
            if (!m) return answer(q, '❌ Нет в наличии');
            const cost = minerCost(m, p.miners[m.id] || 0);
            if (p.usd < cost) return answer(q, `❌ Не хватает $${fmt(cost - p.usd)}`);
            p.usd -= cost;
            p.miners[m.id] = (p.miners[m.id] || 0) + 1;
            adminSay(`🏭 ${fname(p)} купил ${m.name} за $${fmt(cost)}`);
            saveState();
            await answer(q, `✅ ${m.name}: +${fmt(m.hash)} TH/s`);
            const ss = screenShop(p);
            const ok = await edit(chat, mid, ss.text, ss.kb);
            if (!ok) await send(chat, ss.text, ss.kb);
            return;
        }

        /* ---- STAFF-зоны (только staff) ---- */
        if (a === 'st' || (a === 'dlg' && ['price', 'broadcast', 'pgivefi', 'pgiveusd', 'pgivefi-', 'pgiveusd-', 'set', 'num'].includes(b))) {
            if (!isStaff(user)) return answer(q, '🔒 Нет доступа');
        }

        if (a === 'st') {
            /* цена вверх/вниз: панель процентов */
            if (b === 'price' && (c === 'up' || c === 'down')) {
                const kind = c === 'up' ? 'pump' : 'dump';
                const pctps = [1, 5, 10, 25].map(pc => ({ text: `${c === 'up' ? '📈+' : '📉−'}${pc}%`, callback_data: `st:${kind}:${pc}` }));
                const kb = [
                    pctps,
                    [{ text: c === 'up' ? '📈✖2' : '📉÷2', callback_data: `st:${c === 'up' ? 'x2' : 'half'}:0` },
                     { text: '🎯 Установить цену', callback_data: 'dlg:price' },
                     { text: state.market.frozen ? '▶️ Отпустить' : '❄️ Заморозить', callback_data: 'st:freeze' }],
                    [{ text: '🤖 Авто-рынок', callback_data: 'st:auto' }, { text: '⬅️ Назад', callback_data: 'tab:staff' }],
                ];
                await answer(q);
                const screen = {
                    text: `${c === 'up' ? '📈 <b>Подъём цены</b>' : '📉 <b>Спуск цены</b>'}\n\n${CIn(1).replace(/<[^>]+>/g, '')}: <b>$${fmt(state.market.price)}</b>\nТренд: <b>$${fmt(state.market.trend)}</b>\n${state.market.frozen ? '❄️ заморожено' : '🏃 плавает'}`,
                    kb
                };
                const ok = await edit(chat, mid, screen.text, screen.kb);
                if (!ok) await send(chat, screen.text, screen.kb);
                return;
            }
            if (b === 'pump' || b === 'dump' || b === 'x2' || b === 'half') {
                const pct = Number(c) || 0;
                pumpDump(b, pct);
                adminSay(`📈/📉 ${fname(user)}: ${b} ${pct} → $${fmt(state.market.price)}`);
                saveState();
                await answer(q, `✅ Цена: $${fmt(state.market.price)}`);
                return reOpenStaff(chat, mid);
            }
            if (b === 'freeze') {
                state.market.frozen = !state.market.frozen;
                adminSay(`${state.market.frozen ? '❄️' : '▶️'} ${fname(user)} ${state.market.frozen ? 'заморозил' : 'отпустил'} цену`);
                saveState();
                await answer(q, state.market.frozen ? '❄️ Цена заморожена' : '▶️ Цена плавает');
                return reOpenStaff(chat, mid);
            }
            if (b === 'auto') {
                /* 🤖 вернуть рынок в авто-режим: стартовая цена, тренд сброшен, заморозка снята */
                state.market = freshMarket();
                adminSay(`🤖 ${fname(user)} вернул рынок на АВТО — цена $${fmt(state.market.price)}, курс сам плавает`);
                saveState();
                await answer(q, `🤖 Авто-рынок: $${fmt(state.market.price)}`);
                return reOpenStaff(chat, mid);
            }
            if (b === 'give') {
                state.dialogs[user.id] = { type: 'give_' + (c === 'usd' ? 'usd' : 'fi'), t: Date.now() };
                await answer(q);
                return send(chat, `🪙 <b>Выдача ${c === 'usd' ? 'USD' : esc(S('coinName'))} игроку</b>\n\nПришли сообщение в формате:\n<code>ник сумма</code>\nПример: <code>@steve 500</code>\n\nВыдать всем: <code>* 100</code>`, kbCancel());
            }
            if (b === 'allfi' || b === 'allusd') {
                const amt = Number(c) || 0;
                const n = giveAll(b === 'allfi' ? 'fi' : 'usd', amt, fname(user));
                saveState();
                await answer(q, `🎁 Выдано всем (${n}): ${b === 'allfi' ? CIn(amt).replace(/<[^>]+>/g, '') : '$' + fmt(amt)}`);
                return reOpenStaff(chat, mid);
            }
            if (b === 'players') {
                const s = screenPlayers();
                await answer(q);
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'banlist') {
                const s = screenBans();
                await answer(q);
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'player') {
                const s = screenPlayerCard(c, isOwner(user));
                await answer(q);
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'ban') {
                if (!canBan(user)) { await answer(q, '🔒 Забанить может только владелец'); return; }
                const tp = state.players[c];
                if (!tp) return answer(q, '❌ Нет игрока');
                banPlayer(tp, fname(user));
                saveState();
                await answer(q, `🚫 ${tp.first_name} забанен`);
                const s = screenPlayerCard(c, isOwner(user));
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'unban') {
                if (!canBan(user)) { await answer(q, '🔒 Разбанить может только владелец'); return; }
                const tp = state.players[c];
                if (!tp) return answer(q, '❌ Нет игрока');
                unbanPlayer(tp, fname(user));
                saveState();
                await answer(q, `✅ ${tp.first_name} разбанен`);
                const s = screenPlayerCard(c, isOwner(user));
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'zero') {
                const tp = state.players[c];
                if (!tp) return answer(q, '❌ Нет игрока');
                tp.usd = 0; tp.fi = 0;
                adminSay(`🗑 ${fname(user)} обнулил ${fname(tp)}`);
                saveState();
                await answer(q, '🗑 Баланс обнулён');
                const s = screenPlayerCard(c, isOwner(user));
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'settings') {
                const group = c; // пусто | 'num'
                if (group === 'num') {
                    const s = screenNumFields(c && parts[3] || '');
                    await answer(q);
                    const ok = await edit(chat, mid, s.text, s.kb);
                    if (!ok) await send(chat, s.text, s.kb);
                    return;
                }
                const s = screenSettings(isOwner(user));
                await answer(q);
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'resets') {
                if (!isOwner(user)) { await answer(q, '🏛 Сбросы доступны только владельцу'); return; }
                const s = screenResets();
                await answer(q);
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'reset') {
                if (!isOwner(user)) { await answer(q, '🏛 Только владелец'); return; }
                if (c === 'market') {
                    state.market = freshMarket();
                    for (const pp of Object.values(state.players)) { pp.fi = S('startFi'); }
                    adminSay(`📉 ${fname(user)} сбросил рынок`);
                    saveState();
                    await answer(q, '✅ Рынок сброшен');
                    return reOpenStaff(chat, mid);
                }
                if (c === 'balances') { /* подтверждение через диалог */ state.dialogs[user.id] = { type: 'confirm_reset_balances', t: Date.now() }; await answer(q); return send(chat, '🧯 Подтверди: пришли слово <code>да</code> — обнуляю балансы всем (кроме staff).', kbCancel()); }
                if (c === 'nuke') { state.dialogs[user.id] = { type: 'confirm_nuke', t: Date.now() }; await answer(q); return send(chat, '💥 Подтверди: пришли слово <code>да</code> — удалю ВСЕХ игроков и всю историю (ты остаёшься).', kbCancel()); }
            }
            if (b === 'staffrm') {
                if (!isOwner(user)) return answer(q, '🏛 Только владелец');
                const s = screenStaffRm();
                await answer(q);
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'staffdel') {
                if (!isOwner(user)) { await answer(q, '🏛 Только владелец'); return; }
                if (c === String(state.ownerId)) return answer(q, '❌ Владельца снять нельзя');
                state.staffIds = state.staffIds.filter(x => x !== c);
                adminSay(`➖ ${fname(user)} снял staff с <code>${c}</code>`);
                saveState();
                const s = screenStaffRm();
                await answer(q, '✅ Снял права');
                const ok = await edit(chat, mid, s.text, s.kb);
                if (!ok) await send(chat, s.text, s.kb);
                return;
            }
            if (b === 'log') {
                const lines = state.log.slice(0, 20).map(l => `• ${new Date(l.t).toLocaleTimeString('ru-RU')} — ${esc(l.s)}`);
                await answer(q);
                return send(chat, `📜 <b>Журнал</b>\n\n${lines.join('\n') || '—'}`);
            }
        }

        /* ---- диалоги-переходы из staff-кнопок ---- */
        if (a === 'dlg') {
            if (b === 'price') { state.dialogs[user.id] = { type: 'setprice', t: Date.now() }; await answer(q, 'Пришли новую цену $'); return send(chat, '🎯 Пришли новую цену монеты числом (например <code>3.50</code>):', kbCancel()); }
            if (b === 'broadcast') { state.dialogs[user.id] = { type: 'broadcast', t: Date.now() }; await answer(q); return send(chat, '📢 Пришли текст рассылки всем игрокам:', kbCancel()); }
            if (b === 'pgivefi' || b === 'pgiveusd' || b === 'pgivefi-' || b === 'pgiveusd-') {
                const kind = (b.endsWith('-') ? b.slice(0, -1) : b).replace('pgive', '');
                const sign = b.endsWith('-') ? -1 : 1;
                state.dialogs[user.id] = { type: 'pgive', kind, sign, target: d, t: Date.now() };
                const tp = state.players[d];
                await answer(q);
                return send(chat, `${sign > 0 ? 'Выдать' : 'Забрать'} ${kind === 'usd' ? 'USD' : esc(S('coinName'))} у/для <b>${fname(tp || {})}</b>\n\nПришли положительное число:`, kbCancel());
            }
            if (b === 'set' && c) {
                const f = TEXT_FIELDS[c];
                if (!f) return answer(q, '❓');
                state.dialogs[user.id] = { type: 'settext', field: c, t: Date.now() };
                await answer(q);
                return send(chat, `✍️ Пришли новое значение — <b>${esc(f.label)}</b>:` + (f.max < 500 ? `\n(до ${f.max} символов)` : ''), kbCancel());
            }
            if (b === 'num' && c) {
                const defs = [...NUM_FIELDS.market, ...NUM_FIELDS.econ];
                const f = defs.find(x => x.key === c);
                if (!f) return answer(q, '❓');
                state.dialogs[user.id] = { type: 'setnum', field: c, t: Date.now() };
                await answer(q, `Сейчас: ${state.settings[c]}`);
                return send(chat, `🔢 <b>${esc(c)}</b> — ${esc(f.label)}\n\nСейчас: <b>${state.settings[c]}</b>\nПришли новое число:`, kbCancel());
            }
            if (b === 'staffadd') {
                if (!isOwner(user)) { await answer(q, '🏛 Только владелец'); return; }
                state.dialogs[user.id] = { type: 'staffadd', t: Date.now() };
                await answer(q);
                return send(chat, '👮 Пришли ник игрока (@ник) или его ID, чтобы выдать staff-права:', kbCancel());
            }
        }

        await answer(q);
    } catch (e) {
        console.error('[cb]', q.data, e.message);
        try { await answer(q, '⚠️ Ошибка'); } catch (_) { }
    }
}
async function reOpenStaff(chat, mid) {
    const s = screenStaff();
    const ok = await edit(chat, mid, s.text, s.kb);
    if (!ok) await send(chat, s.text, s.kb);
}

/* ------------------------- СООБЩЕНИЯ ------------------------- */
const BANNED_ALLOWED = new Set(['start', 'id', 'cancel', 'help']);

async function onMessage(msg) {
    const text = (msg.text || '').trim();
    if (!text) return;
    const chat = msg.chat.id;
    const user = msg.from || {};
    const cmd = (text.match(/^\/(\w+)/) || [])[1] || '';

    /* --- активные диалоги --- */
    const dlg = state.dialogs[user.id];
    if (dlg && !cmd && Date.now() - dlg.t < 10 * 60 * 1000) {
        const handled = await onDialogInput(user, chat, dlg, text);
        if (handled) saveState();
        return;
    }

    /* --- бан-фильтр (кроме некоторых команд) --- */
    if (BANNED_ALLOWED.has(cmd)) {
        if (cmd === 'start') {
            const p = ensurePlayer(user);
            if (p.banned) return send(chat, `🚫 <b>Аккаунт заблокирован.</b>\nПричина: ${esc(p.banReason || 'не указана')}\n\nОбратись к администрации.`);
            logLine(`🆕 ${fname(p)} в игре`);
            return send(chat, screenMain().text, screenMain().kb);
        }
        if (cmd === 'id') return send(chat, `🆔 Твой ID: <code>${user.id}</code>`);
        if (cmd === 'help') return helpCmd(chat);
        if (cmd === 'cancel') { delete state.dialogs[user.id]; return send(chat, '🆗 Ок.'); }
        return;
    }
    const myP = findPlayer(user);
    if (myP && myP.banned) {
        return send(chat, `🚫 <b>Аккаунт заблокирован.</b>\nПричина: ${esc(myP.banReason || 'не указана')}`);
    }

    switch (cmd) {
        case 'help': return helpCmd(chat);
        case 'linkcode': case 'app': {
            const p = ensurePlayer(user);
            if (p.banned) return send(chat, '🚫 Забанен — связка недоступна');
            if (p.uid) return send(chat, `📱 Приложение уже привязано (ID <code>${esc(p.uid)}</code>).\nОткрой игру на телефоне — баланс общий.`);
            const code = createLinkCode(p);
            adminSay(`📱 ${fname(p)} получил код для приложения (/linkcode)`);
            return send(chat,
                `📱 <b>Код для приложения на телефон</b>\n\n` +
                `<b><code>${code}</code></b>\n\n` +
                `1) Открой игру на телефоне (APK: ${PAGES_URL}apk/FI-Coin.apk)\n` +
                `2) Введи код в поле «Код привязки (ABCD-1234)»\n` +
                `3) Баланс станет общим ✅\n\n` +
                `⏳ Код живёт 10 минут и работает один раз.`);
        }
        case 'profile': case 'bal': { const p = ensurePlayer(user); const s = screenProfile(p); return send(chat, s.text, s.kb); }
        case 'market': { const p = ensurePlayer(user); const s = screenMarket(p); return send(chat, s.text, s.kb); }
        case 'shop': { const p = ensurePlayer(user); const s = screenShop(p); return send(chat, s.text, s.kb); }
        case 'top': { const s = screenTop(); return send(chat, s.text, s.kb); }
        case 'price': return send(chat, priceHeader() + `Всего в игре: ${CIn(supply()).replace(/<[^>]+>/g, '')}\n${state.market.frozen ? '❄️ Курс заморожен' : '🏃 Курс движется'}`);
        case 'staff': {
            if (isStaff(user)) { const s = screenStaff(); return send(chat, s.text, s.kb); }
            state.dialogs[user.id] = { type: 'auth', t: Date.now() };
            return send(chat, '🔒 <b>Вход в STAFF-консоль</b>\n\nПришли пароль (config.json → staffPassword).\n<b>Первый вошедший становится владельцем</b> (👑 безлимит).', kbCancel());
        }
        /* ---------- команды банов ---------- */
        case 'ban': {
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            if (!canBan(user)) return send(chat, '🏛 Банить может только владелец (👑)');
            const m = text.split(/\s+/);
            const target = m[1];
            if (!target) return send(chat, 'Формат: <code>/ban @ник причина…</code>');
            const tp = findPlayerByNameOrId(target);
            if (!tp) return send(chat, `❌ Не нашёл игрока «${esc(target)}».`);
            if (isOwner({ id: tp.id }) ) return send(chat, '❌ Владельца забанить нельзя.');
            const reason = m.slice(2).join(' ');
            banPlayer(tp, fname(user), reason);
            saveState();
            notifyBan(tp, reason);
            return send(chat, `🚫 <b>${fname(tp)}</b> забанен.\nПричина: ${esc(reason || '—')}`);
        }
        case 'unban': {
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            if (!canBan(user)) return send(chat, '🏛 Разбанить может только владелец (👑)');
            const target = text.split(/\s+/)[1];
            if (!target) return send(chat, 'Формат: <code>/unban @ник</code>');
            const tp = findPlayerByNameOrId(target);
            if (!tp) return send(chat, `❌ Не нашёл игрока «${esc(target)}».`);
            unbanPlayer(tp, fname(user));
            saveState();
            return send(chat, `✅ <b>${fname(tp)}</b> разбанен. Баланс: ${CIn(tp.fi).replace(/<[^>]+>/g, '')} / $${fmt(tp.usd)}`);
        }
        case 'banlist': {
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            const s = screenBans();
            return send(chat, s.text, s.kb);
        }

        /* ---------- staff-управление из текста ---------- */
        case 'give': { /* /give @nick 100 [fi|usd] */
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            const m = text.split(/\s+/);
            if (m.length < 3) return send(chat, 'Формат: <code>/give ник 100 fi</code> или <code>usd</code>, «*» — всем');
            const amount = parseFloat((m[2] || '').replace(',', '.'));
            if (!isFinite(amount)) return send(chat, '❌ Некорректная сумма');
            const kind = (m[3] || 'fi').toLowerCase() === 'usd' ? 'usd' : 'fi';
            if (m[1] === '*') {
                const n = giveAll(kind, amount, fname(user));
                saveState();
                return send(chat, `✅ Выдал ${n} игрокам: ${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}`);
            }
            const tp = findPlayerByNameOrId(m[1]);
            if (!tp) return send(chat, `❌ Не нашёл игрока «${esc(m[1])}».`);
            giveTo(tp, kind, amount);
            adminSay(`🪙 ${fname(user)} выдал ${fname(tp)}: ${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}`);
            saveState();
            notifyGift(tp, amount, kind);
            return send(chat, `✅ ${fname(tp)} получает ${kind === 'usd' ? '$' + fmt(amount) : CIn(amount)}`);
        }
        case 'pump': { /* /pump 10 */
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            const pct = parseFloat(text.split(/\s+/)[1] || '');
            if (!isFinite(pct)) return send(chat, 'Формат: <code>/pump 10</code>');
            setPrice(pumpDump('pump', pct));
            saveState();
            return send(chat, `📈 Цена: <b>$${fmt(state.market.price)}</b>`);
        }
        case 'dump': {
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            const pct = parseFloat(text.split(/\s+/)[1] || '');
            if (!isFinite(pct)) return send(chat, 'Формат: <code>/dump 10</code>');
            setPrice(pumpDump('dump', pct));
            saveState();
            return send(chat, `📉 Цена: <b>$${fmt(state.market.price)}</b>`);
        }
        case 'freeze': {
            if (!isStaff(user)) return send(chat, '🔒 Команда для staff');
            state.market.frozen = !state.market.frozen;
            adminSay(`${state.market.frozen ? '❄️' : '▶️'} ${fname(user)} заморозка=${state.market.frozen}`);
            saveState();
            return send(chat, state.market.frozen ? '❄️ Курс заморожен' : '▶️ Курс снова плавает');
        }
    }

    if (!dlg) return; // молча на неизвестный текст
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
    if (!CFG.token || CFG.token.includes('@BotFather')) {
        console.error('\n❌ В config.json не указан токен бота.\n' +
            '1) Открой @BotFather в Telegram\n' +
            '2) /newbot → имя и username\n' +
            '3) Скопируй токен (1234567:AA-...) в config.json → "token"\n' +
            '4) Запусти снова: node bot.js\n');
        process.exit(1);
    }
    loadState();
    saveState();

    /* ☁ если есть GH_TOKEN — состояние игры живёт в GitHub (работает даже с выключенным ПК) */
    if (GH.token) await loadStateFromGitHub();
    startApiServer();
    await pushApiJson();

    /* расписание тиков рынка: перечитываем эту переменную каждый раз */
    let tickTimer = null;
    const startTicker = () => {
        if (tickTimer) clearInterval(tickTimer);
        tickTimer = setInterval(marketTick, 30000);
    };
    startTicker();
    marketTick();

    const me = await tg('getMe');
    if (!me) { console.error('❌ Telegram не отвечает / неверный токен.'); process.exit(1); }
    console.log(`✅ ${S('title')} (@${me.username}) — запущен.`);
    console.log(`👥 Игроков в базе: ${Object.keys(state.players).length}. Стафф: ${state.staffIds.length}. Цена FI: $${fmt(state.market.price)}`);
    console.log(`🛠 Пароль staff: ${CFG.staffPassword} (config.json)`);

    process.on('SIGINT', () => { saveState(); saveStateToGitHub(true); console.log('💾 Сохранено. Выход.'); process.exit(0); });
    process.on('uncaughtException', e => console.error('[x]', e.message));
    process.on('unhandledRejection', e => console.error('[x]', e && e.message));

    await pollLoop();
})();
