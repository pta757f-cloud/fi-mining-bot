/* NODE_OPTIONS=--require skip-bad-ip.cjs
   Сеть пользователя дропает TLS1.3-рукопожатия (ECONNRESET/TIMEOUT), TLS1.2 работает.
   Форсируем maxVersion=TLSv1.2 для всех внешних tls.connect — fetch/wrangler оживают. */
try {
    const tlsmod = require('tls');
    const origConnect = tlsmod.connect;
    if (typeof origConnect === 'function') {
        tlsmod.connect = function patchedTlsConnect(options, cb) {
            try {
                if (typeof options === 'string') options = { host: options };
                else options = Object.assign({}, options || {});
                if (!options.maxVersion) options.maxVersion = 'TLSv1.2';
            } catch (_) { }
            return origConnect(options, cb);
        };
    }
} catch (_) { }
