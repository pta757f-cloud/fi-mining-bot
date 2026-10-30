/* ============================================================
   FI COIN — ОБЁРТКА ДЛЯ CLOUDFLARE WORKERS (бесплатно, без карты)
   ------------------------------------------------------------
   bot.js остаётся обычным Node-кодом; воркер — тонкий адаптер:
   • переменные воркера кладём в process.env ещё ДО загрузки bot.js
   • bot.js в облачном режиме: Telegram подключается через webhook,
     тик рынка «догоняется» от state.lastTick на каждом запросе,
     состояние игры живёт в GitHub-зеркале (репо → data/state.json)

   Переменные (Dashboard → Workers → fi-coin-bot → Settings → Variables):
   BOT_TOKEN   — токен @BotFather
   GH_TOKEN    — GitHub PAT (зеркало состояния)
   PUBLIC_URL  — https://<имя>.workers.dev (задать после первого деплоя)
   ============================================================ */
'use strict';

let botPromise = null;

/* env-биндинги воркера → process.env (bot.js их читает оттуда) */
function seedEnv(env) {
    try {
        if (!process.env) process.env = {};
        for (const k of ['BOT_TOKEN', 'GH_TOKEN', 'PUBLIC_URL', 'TG_WEBHOOK_SECRET']) {
            const v = env && env[k];
            if (v !== undefined && v !== null && String(v) !== '') process.env[k] = String(v);
        }
    } catch (e) { /* nodejs_compat подложит окружение сам */ }
}

/* ждём, пока бот прогрузит состояние из GitHub-зеркала (глобальный флаг FI_READY) */
async function getBotReady() {
    if (!botPromise) botPromise = import('./bot.js');
    try { await botPromise; } catch (e) {
        console.error('[worker boot]', e && (e.stack ? e.stack.split('\n')[0] : e.message));
        return null;
    }
    for (let i = 0; i < 80 && !globalThis.FI_READY; i++) {
        await new Promise(r => setTimeout(r, 250));
    }
    return globalThis.FI_READY ? globalThis.FI_BOT : null;
}

const H = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600'
};

export default {
    async fetch(req, env) {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });
        seedEnv(env);
        const bot = await getBotReady();
        if (!bot || typeof bot.catchupTicks !== 'function') {
            /* бот ещё стартует — клиент повторит запрос сам */
            return new Response(JSON.stringify({ ok: false, err: 'starting' }), {
                status: 503, headers: Object.assign({}, H, { 'Retry-After': '2' })
            });
        }
        try {
            const url = new URL(req.url);
            /* Telegram стучит сюда с каждым сообщением/нажатием кнопки */
            if (url.pathname === '/tg/webhook' && req.method === 'POST') {
                const secret = String(process.env.TG_WEBHOOK_SECRET || '');
                if (secret && String(req.headers.get('x-telegram-bot-api-secret-token') || '') !== secret) {
                    return new Response('forbidden', { status: 403 });
                }
            }
            /* догоняем рыночные тики, пропущенные за время сна */
            bot.catchupTicks(400);
            const bodyRaw = req.method === 'GET' ? '' : await req.text();
            const out = await bot.apiRoute(url.pathname, req.method, bodyRaw);
            return new Response(JSON.stringify(out), { headers: H });
        } catch (e) {
            console.error('[worker]', e && (e.stack ? e.stack.split('\n')[0] : e.message));
            return new Response(JSON.stringify({ ok: false, err: 'server' }), { status: 500, headers: H });
        }
    }
};
