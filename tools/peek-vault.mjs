/* Аудит deviceVault: расшифровка local (BOT_TOKEN из config.json), печать только uid→p и поля. */
import crypto from 'crypto';
import fs from 'fs';

const CFG = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const boot = await fetch('https://raw.githubusercontent.com/pta757f-cloud/fi-mining-bot/main/data/state.json');
const state = JSON.parse(await boot.text());

function devKey() {
    return crypto.createHash('sha256').update(String(CFG.token) + '|fi-device-vault', 'utf8').digest();
}
function openRec(b64) {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', devKey(), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

const vault = state.deviceVault || {};
console.log('записей:', Object.keys(vault).length);
for (const [uid, b64] of Object.entries(vault)) {
    try {
        const rec = openRec(b64);
        console.log(uid, '→ p=' + rec.p, ' s=' + (rec.s ? String(rec.s).slice(0, 4) + '***' : '(нет)'), ' fields=' + Object.keys(rec).join(','));
    } catch (e) {
        console.log(uid, '→ РАСШИФРОВКА НЕ УДАЛАСЬ:', e.message);
    }
}
