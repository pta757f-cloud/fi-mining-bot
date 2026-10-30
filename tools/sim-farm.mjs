// Симуляция renderFarm на ТРЁХ снапшотах: владелец (init) + оба телефонных W-профиля (device).
// Строгие проверки: каждый $-id, к которому прислоняется renderFarm, должен существовать
// в produced HTML либо в статике; в HTML не должно быть 'undefined'/'NaN'/'Infinity'.
import fs from 'fs';
import crypto from 'crypto';
import vm from 'node:vm';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const API = 'https://fi-coin-bot.pta757f.workers.dev';
const PAGES = 'https://pta757f-cloud.github.io/fi-mining-bot/index.html';

const html = await (await fetch(PAGES)).text();
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('нет script'); process.exit(1); }
const src = m[1];
const stub = fs.readFileSync(new URL('./sim-stub.js', import.meta.url), 'utf8');

/* ---- подпись initData (та же схема, что verifyInitData) ---- */
function initData(user) {
    const pairs = [['user', JSON.stringify(user)], ['auth_date', String(Math.floor(Date.now() / 1000))]];
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const secret = crypto.createHmac('sha256', 'WebAppData').update(String(CFG.token), 'utf8').digest();
    const hash = crypto.createHmac('sha256', secret).update(pairs.map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8').digest('hex');
    return pairs.map(([k, v]) => `${k}=${v}`).join('&') + '&hash=' + hash;
}

/* ---- расшифровка deviceVault для подписи device-снапшотов ---- */
function devKey() { return crypto.createHash('sha256').update(String(CFG.token) + '|fi-device-vault', 'utf8').digest(); }
const mint = await (await fetch('https://raw.githubusercontent.com/pta757f-cloud/fi-mining-bot/main/data/state.json')).json();
const devs = [];
for (const [uid, blob] of Object.entries(mint.deviceVault || {})) {
    try {
        const raw = Buffer.from(blob, 'base64');
        const dc = crypto.createDecipheriv('aes-256-gcm', devKey(), raw.subarray(0, 12));
        dc.setAuthTag(raw.subarray(12, 28));
        const rec = JSON.parse(Buffer.concat([dc.update(raw.subarray(28)), dc.final()]).toString('utf8'));
        devs.push({ uid, s: rec.s, player: rec.p });
    } catch (e) { console.log('vault', uid, 'open fail:', e.message); }
}

/* ---- получить снапшот Timeout-и negocio ---- */
const snaps = [{ label: 'OWNER(init)', body: { init: initData({ id: 6195813087, first_name: 'Тимофей', username: 'timofey_u' }), actions: [] } }];
for (const d of devs) {
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', String(d.s)).update(d.uid + ':' + ts, 'utf8').digest('hex');
    snaps.push({ label: 'DEVICE ' + d.uid + ' (p=' + d.player + ')', body: { device: { uid: d.uid, ts, sig }, actions: [] } });
}
for (const sn of snaps) {
    sn.snap = await (await fetch(API + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sn.body) })).json();
    console.log(sn.label, '→ players ok?', !!sn.snap.players, 'me.usd=', sn.snap.me && sn.snap.me.usd, 'miners=', (sn.snap.miners || []).length, 'quests=', (sn.snap.me || {}).quests ? 'yes' : 'NO', 'workLeftMin=', (sn.snap.me || {}).workLeftMin);
}

/* ---- VM и прогон renderFarm на каждом снапшоте ---- */
const ctx = vm.createContext({
    fetch: async () => ({ json: () => ({}) }),
    console, TextEncoder, crypto: globalThis.crypto,
    setInterval: () => 0, clearInterval: () => { }, setTimeout: () => 0
});
try { new vm.Script(stub + src); } catch (e) { console.log('PARSE FAIL @', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); process.exit(1); }
vm.runInContext(stub + src, ctx, { timeout: 5000 });

for (const sn of snaps) {
    const snapJson = JSON.stringify(sn.snap).replace(/</g, '\\u003c');
    const out = vm.runInContext(`
(function(){
  globalThis.__ids.length=0; globalThis.__sels.length=0;
  try{ S = ${snapJson}; } catch(e){ globalThis.S = ${snapJson}; }
  try{ tab='farm'; } catch(e){}
  try{ apiBase='https://x'; spinning=false; IS_TG=false; } catch(e){}
  const idsBefore=[...__ids];
  let r;
  try { renderFarm(); r='RENDER OK'; } catch(e){ return 'CRASH: ' + ((e && e.stack) || e); }
  const htmlOut = document.getElementById('screen').innerHTML || '';
  if (htmlOut.length < 5000) globalThis.__peek = htmlOut.slice(0, 700);
  const pageStatic = ${JSON.stringify(html.slice(0, 999999)).replace(/</g, '\\u003c')};
  const OUTER = ['screen','modalWrap','hud','pp','app','body'];
  const badly = (htmlOut.match(/undefined|NaN|Infinity/g) || []);
  const missing = __ids.slice(idsBefore.length).filter(function(id){
      if(!id || OUTER.indexOf(id)>=0) return false;
      return htmlOut.indexOf('id="'+id+'"')<0;
  });
  const list = __ids.slice(idsBefore.length);
  const undefSpots = [];
  let ix = htmlOut.search(/undefined|NaN|Infinity/);
  if (ix>=0) undefSpots.push(htmlOut.slice(Math.max(0,ix-70), ix+40));
  return r + ' | html=' + htmlOut.length + ' | bound-ids=' + JSON.stringify([...new Set(list)]) + ' | missing-ids=' + JSON.stringify(missing) + ' | badTokens=' + badly.length + (undefSpots.length ? ' | spot: ' + JSON.stringify(undefSpots[0]) : '');
})()
`, ctx, { timeout: 5000 });
    console.log(sn.label, '→', out);
    const peek = vm.runInContext('globalThis.__peek || ""', ctx, { timeout: 1000 });
    if (peek) console.log('   HTML head:', JSON.stringify(peek));
    vm.runInContext('globalThis.__peek = null', ctx, { timeout: 1000 });
}
