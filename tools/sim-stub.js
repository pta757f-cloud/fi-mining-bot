// Полный DOM-стаб для VM-симуляции клиента (все элементы живые-болванки)
function makeEl(id) {
    const st = {};
    const cls = new Set();
    const ctx2d = new Proxy({}, {
        get: function (t, p) {
            if (p === 'measureText') return function (s) { return { width: String(s || '').length * 6.5 + 4 }; };
            if (p === 'createLinearGradient' || p === 'createRadialGradient') return function () { return { addColorStop: function () {} }; };
            if (p in t) return t[p];
            return function () {};
        },
        set: function (t, p, v) { t[p] = v; return true; }
    });
    const el = {
        id: id || '', innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
        scrollTop: 0, scrollLeft: 0, dataset: {}, style: {}, children: [],
        width: 320, height: 160, hidden: false, offsetWidth: 320, offsetHeight: 160,
        classList: { add: function (c) { if (c) cls.add(String(c)); }, remove: function (c) { if (c) cls.delete(String(c)); }, toggle: function (c) { const k = String(c); if (cls.has(k)) cls.delete(k); else cls.add(k); }, contains: function (c) { return cls.has(String(c)); } },
        appendChild: function (c) { this.children.push(c); return c; },
        removeChild: function () {},
        addEventListener: function () {}, removeEventListener: function () {},
        focus: function () {}, blur: function () {}, click: function () {},
        setAttribute: function () {}, getAttribute: function () { return null; }, removeAttribute: function () {},
        querySelector: function () { return null; }, querySelectorAll: function () { return []; },
        closest: function () { return null; },
        getBoundingClientRect: function () { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
        getContext: function () { return ctx2d; },
        scrollIntoView: function () {},
        ownerSVGElement: null
    };
    return el;
}
const byId = {};
const bySel = {};
globalThis.__ids = [];
globalThis.__sels = [];
globalThis.document = {
    hidden: false,
    activeElement: null,
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    getElementById: function (id) { globalThis.__ids.push(id); if (!byId[id]) byId[id] = makeEl(id); return byId[id]; },
    createElement: function (tag) { return makeEl(tag); },
    querySelector: function (sel) { globalThis.__sels.push(sel); if (!bySel[sel]) bySel[sel] = makeEl(sel); return bySel[sel]; },
    querySelectorAll: function (sel) { globalThis.__sels.push(sel); return []; },
    addEventListener: function () {},
    removeEventListener: function () {}
};
globalThis.window = globalThis;
globalThis.navigator = {
    serviceWorker: { register: function () { return { catch: function () {} }; } },
    clipboard: { writeText: function () { return Promise.resolve(); }, readText: function () { return Promise.reject(new Error('no')); } },
    vibrate: function () {},
    userAgent: 'Mozilla/5.0 (sim)'
};
globalThis.Telegram = {
    WebApp: {
        ready: function () {}, expand: function () {}, close: function () {},
        initData: '', initDataUnsafe: {},
        openTelegramLink: function () {}, openLink: function () {},
        HapticFeedback: { impactOccurred: function () {}, notificationOccurred: function () {}, selectionChanged: function () {} },
        MainButton: { show: function () {}, hide: function () {}, setText: function () {}, onClick: function () {}, hideProgress: function () {}, showProgress: function () {} },
        BackButton: { show: function () {}, hide: function () {}, onClick: function () {} },
        setHeaderColor: function () {}, setBackgroundColor: function () {}
    }
};
globalThis.localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
globalThis.sessionStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
globalThis.location = { href: '', search: '', hash: '', pathname: '/', protocol: 'https:' };
globalThis.history = { replaceState: function () {}, pushState: function () {} };
globalThis.alert = function () {};
globalThis.confirm = function () { return false; };
globalThis.prompt = function () { return null; };
globalThis.matchMedia = function () { return { matches: false, addEventListener: function () {}, removeEventListener: function () {} }; };
globalThis.requestAnimationFrame = function () { return 0; };
globalThis.cancelAnimationFrame = function () {};
globalThis.ResizeObserver = function () { return { observe: function () {}, unobserve: function () {}, disconnect: function () {} }; };
globalThis.IntersectionObserver = function () { return { observe: function () {}, unobserve: function () {}, disconnect: function () {} }; };
globalThis.AudioContext = function () {
    return {
        createOscillator: function () { return { connect: function () { return { connect: function () {} }; }, start: function () {}, stop: function () {}, frequency: { value: 0 } }; },
        createGain: function () { return { connect: function () {}, gain: { value: 0, setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} } }; },
        destination: {}, resume: function () { return Promise.resolve(); }
    };
};
