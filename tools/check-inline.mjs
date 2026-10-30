// Локальная валидация ИНЛАЙН-СКРИПТА index.html ДО деплоя.
// Парс + renderFarm/renderMarket/renderShop/updateMarketLive на снапшотах (owner + телефоны).
// Проверки: краши с местом, bannerOK только у телефонных профилей, missing-ids, undefined/NaN, флэш цены.
import fs from 'fs';
import crypto from 'crypto';
import vm from 'node:vm';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const API = 'https://fi-coin-bot.pta757f.workers.dev';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('нет script'); process.exit(1); }
const src = m[1];
const stub = fs.readFileSync(new URL('./sim-stub.js', import.meta.url), 'utf8');

function initData(user) {
    const pairs = [['user', JSON.stringify(user)], ['auth_date', String(Math.floor(Date.now() / 1000))]];
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const secret = crypto.createHmac('sha256', 'WebAppData').update(String(CFG.token), 'utf8').digest();
    const hash = crypto.createHmac('sha256', secret).update(pairs.map(([k, v]) => `${k}=${v}`).join('\n'), 'utf8').digest('hex');
    return pairs.map(([k, v]) => `${k}=${v}`).join('&') + '&hash=' + hash;
}
function devKey() { return crypto.createHash('sha256').update(String(CFG.token) + '|fi-device-vault', 'utf8').digest(); }
const mint = await (await fetch('https://raw.githubusercontent.com/pta757f-cloud/fi-mining-bot/main/data/state.json')).json();

const snaps = [{ label: 'OWNER(init)', body: { init: initData({ id: 6195813087, first_name: 'Тимофей', username: 'timofey_u' }), actions: [] } }];
for (const [uid, blob] of Object.entries(mint.deviceVault || {})) {
    try {
        const raw = Buffer.from(blob, 'base64');
        const dc = crypto.createDecipheriv('aes-256-gcm', devKey(), raw.subarray(0, 12));
        dc.setAuthTag(raw.subarray(12, 28));
        const rec = JSON.parse(Buffer.concat([dc.update(raw.subarray(28)), dc.final()]).toString('utf8'));
        const ts = Date.now();
        const sig = crypto.createHmac('sha256', String(rec.s)).update(uid + ':' + ts, 'utf8').digest('hex');
        snaps.push({ label: 'DEVICE ' + uid + '(p=' + rec.p + ')', body: { device: { uid, ts, sig }, actions: [] } });
    } catch (e) { console.log('vault fail', uid, e.message); }
}
for (const sn of snaps) {
    sn.snap = await (await fetch(API + '/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sn.body) })).json();
    if (!sn.snap || !sn.snap.me) { console.log(sn.label, '→ СНАПШОТ НЕ ПРИШЁЛ'); process.exit(1); }
}

const ctx = vm.createContext({
    fetch: async () => ({ json: () => ({}) }),
    console, TextEncoder, crypto: globalThis.crypto,
    setInterval: () => 0, clearInterval: () => { }, setTimeout: () => 0
});
try { new vm.Script(stub + src); } catch (e) { console.log('PARSE FAIL @', (e.stack || e.message).split('\n').slice(0, 3).join(' | ')); process.exit(1); }
console.log('parse: OK');
vm.runInContext(stub + src, ctx, { timeout: 5000 });

let allOk = true;
for (const sn of snaps) {
    const snapJson = JSON.stringify(sn.snap).replace(/</g, '\\u003c');
    const out = vm.runInContext(`
(function(){
  globalThis.__ids.length=0;
  const ids0=[...__ids];
  const tryR=function(f){try{f();return null}catch(e){return (e&&e.stack)||String(e)}};
  try{ S=${snapJson}; } catch(e){ globalThis.S=${snapJson}; }
  tab='farm'; apiBase='https://x'; spinning=false;
  const farmErr=tryR(function(){renderFarm()});
  const htmlFarm=document.getElementById('screen').innerHTML||'';
  const ids1=[...__ids].slice(ids0.length);
  const mkErr=tryR(function(){tab='market';renderMarket();updateMarketLive();});
  tab='shop';
  const shErr=tryR(function(){renderShop();});
  const missing=ids1.filter(function(id){if(!id||['screen','goShop','lkBannerBtn'].indexOf(id)>=0)return false;return htmlFarm.indexOf('id="'+id+'"')<0;});
  const bannerOK=htmlFarm.indexOf('lkBannerBtn')>=0;
  const badT=(htmlFarm.match(/undefined|NaN|Infinity/g)||[]).length;
  const flash=tryR(function(){
    S.market.price=(S.market.price||3)+0;globalThis.__mPrev=undefined;updateMarketLive();
    S.market.price=(S.market.price||3)*1.02;updateMarketLive();
    const ok1=document.getElementById('mPrice').classList.contains('up');
    S.market.price=(S.market.price||3)*0.94;updateMarketLive();
    const ok2=document.getElementById('mPrice').classList.contains('dn');
    S.market.price=(S.market.price||3)*1.08;updateMarketLive();
    const ok3=document.getElementById('mPrice').classList.contains('up');
    if(!ok1||!ok2||!ok3)throw new Error('flash up1='+ok1+' dn='+ok2+' up2='+ok3);});
  const fmt=function(e){return e?(String(e&&e.message||e).slice(0,120)+' @'+String(e&&e.stack||'').split('\\n')[1]):'OK'};
  return 'farm='+fmt(farmErr)+' html='+htmlFarm.length+' bannerOK='+bannerOK+' mk='+fmt(mkErr)+' sh='+fmt(shErr)+' flash='+fmt(flash)+' missing='+JSON.stringify(missing)+' badTokens='+badT;
})()
`, ctx, { timeout: 5000 });
    console.log(sn.label, '→', out);
    const isDev=/DEVICE/.test(sn.label);
    const okFarm=/farm=OK/.test(out);
    const okBanner=isDev ? /bannerOK=true/.test(out) : true;
    const okRest=/mk=OK/.test(out) && /sh=OK/.test(out) && /flash=OK/.test(out) && /missing=\[\]/.test(out);
    if (!okFarm || !okBanner || !okRest) allOk = false;
}
console.log(allOk ? 'ALL OK' : 'HAS ISSUES');
