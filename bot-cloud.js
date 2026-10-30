/* ============================================================
   FI COIN — ОБЛАЧНАЯ ОБЁРТКА ДЛЯ DENO DEPLOY (бесплатный хостинг)
   ------------------------------------------------------------
   Запускается как Dynamic Entrypoint: bot-cloud.js
   Работает поверх bot.js (тот же Node-код — через node-совместимость Deno).

   Что делает облачный режим:
   • состояние игры живёт в GitHub-зеркале (репо fi-mining-bot/data/state.json)
   • Telegram подключается через WEBHOOK (кнопки «Это ты?» и 2FA-код работают),
     бесконечный getUpdates-цикл не нужен — облако просыпается на каждый запрос
   • тик рынка «догоняется» от state.lastTick при каждом запросе

   Переменные окружения (задаются в панели Deno Deploy):
   BOT_TOKEN    — токен @BotFather
   GH_TOKEN     — GitHub PAT (зеркало состояния)
   PUBLIC_URL   — адрес приложения, например https://имя.deno.dev
   ============================================================ */
'use strict';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* обёртка включает облачный режим ДО загрузки bot.js */
process.env.FI_CLOUD = '1';

/* читаем bot.js из кэша на каждый запрос — пока бот грузится, exports пустой */
const getBot = () => require('./bot.js');

const H = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
};

/* проверка секрета Telegram-вебхука (см. setWebhook в bot.js) */
function checkWebhookSecret(req) {
    const secret = String(process.env.TG_WEBHOOK_SECRET || '');
    if (!secret) return true; /* секрет не задан — не режем */
    return String(req.headers.get('x-telegram-bot-api-secret-token') || '') === secret;
}

Deno.serve(
    { port: Number(process.env.PORT || 8787) },
    async (req) => {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
        try {
            const bot = getBot();
            if (!bot || typeof bot.catchupTicks !== 'function') {
                /* бот ещё стартует (растёт из GitHub) — клиент сам повторит запрос */
                return new Response(JSON.stringify({ ok: false, err: 'starting' }), {
                    status: 503, headers: Object.assign({}, H, { 'Retry-After': '2' })
                });
            }
            const url = new URL(req.url);
            /* Telegram всегда стучит сюда при облачном режиме */
            if (url.pathname === '/tg/webhook' && req.method === 'POST') {
                if (!checkWebhookSecret(req)) return new Response('forbidden', { status: 403 });
            }
            /* догоняем рыночные тики, пропущенные за время сна облака */
            bot.catchupTicks(400);
            const bodyRaw = req.method === 'GET' ? '' : await req.text();
            const out = await bot.apiRoute(url.pathname, req.method, bodyRaw);
            return new Response(JSON.stringify(out), { headers: H });
        } catch (e) {
            console.error('[cloud]', e && (e.stack ? e.stack.split('\n')[0] : e.message));
            return new Response(JSON.stringify({ ok: false, err: 'server' }), { status: 500, headers: H });
        }
    }
);

console.log('🌐 FI Coin (облачный режим Deno Deploy) поднят.');
