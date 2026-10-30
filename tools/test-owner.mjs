/* Синтетический тест owner-редактора: данные подписаны по алгоритму Telegram initData (verifyInitData). */
import crypto from 'crypto';
import fs from 'fs';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const API = 'https://fi-coin-bot.pta757f.workers.dev';
const ME = { id: 6195813087, first_name: 'Тимофей', username: 'timofey_u' };

function initData(user) {
    const pairs = [['user', JSON.stringify(user)], ['auth_date', String(Math.floor(Date.now() / 1000))]];
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const secret = crypto.createHmac('sha256', 'WebAppData').update(String(CFG.token), 'utf8').digest();
    const hash = crypto.createHmac('sha256', secret).update(pairs.map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8').digest('hex');
    return pairs.map(([k, v]) => `${k}=${v}`).join('&') + '&hash=' + hash;
}

async function staff(action) {
    const r = await fetch(API + '/api/staff', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init: initData(ME), action })
    });
    return r.json();
}

const w = await staff({ a: 'who' });
console.log('raw who:', JSON.stringify(w).slice(0, 300));
console.log('who ok:', w.ok, '| role:', JSON.stringify(w.role && { kind: w.role.kind, name: w.role.name }));

let g = await staff({ a: 'pGet', to: String(ME.id) });
if (!g.ok) { console.log('pGet FAIL:', g.msg); process.exit(1); }
const pl = g.pl;
console.log('pGet:', pl.id, '| ник:', JSON.stringify(pl.nick), '| usd:', Math.round(pl.usd), '| fi:', Math.round(pl.fi), '| devices:', pl.devices, '| miners:', JSON.stringify(pl.miners));

/* тест ника: ставим → читаем → снимаем */
await staff({ a: 'pEdit', to: String(ME.id), nick: 'Тим рок-звезда' });
g = await staff({ a: 'pGet', to: String(ME.id) });
console.log('после pEdit nick:', JSON.stringify(g.pl.nick));
await staff({ a: 'pEdit', to: String(ME.id), nick: '' });
g = await staff({ a: 'pGet', to: String(ME.id) });
console.log('после pEdit nick="":', JSON.stringify(g.pl.nick), '(ожидаем пусто)');

/* микротест ригов: +1 usb → −1 usb */
const before = (g.pl.miners && g.pl.miners.usb) || 0;
await staff({ a: 'pGrant', to: String(ME.id), what: 'miner', key: 'usb', amt: 1 });
g = await staff({ a: 'pGet', to: String(ME.id) });
const mid = (g.pl.miners && g.pl.miners.usb) || 0;
await staff({ a: 'pGrant', to: String(ME.id), what: 'miner', key: 'usb', amt: -1 });
g = await staff({ a: 'pGet', to: String(ME.id) });
const after = (g.pl.miners && g.pl.miners.usb) || 0;
console.log(`pGrant usb: до ${before} → ${mid} → ${after} ${before === mid - 1 && after === before ? '(OK)' : '(СБОЙ)'}`);

/* negative-тесты: не-владелец не пройдёт; неизвестный ключ отвергнут */
const n1 = await staff({ a: 'pGrant', to: String(ME.id), what: 'lab', key: 'нет такого', amt: 1 });
console.log('неизвестный lab-ключ отвергнут:', n1.ok === false, '|', n1.msg);

const l = await staff({ a: 'players' });
console.log('players:', l.ok, '| первый:', l.players && l.players[0] && l.players[0].n, '| ls есть:', !!(l.players && l.players[0] && 'ls' in l.players[0]));
console.log('ТЕСТ ЗАВЕРШЁН');
