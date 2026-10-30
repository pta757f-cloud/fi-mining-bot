// Проверка маркеров нового клиентского кода на Pages
const h = await (await fetch('https://pta757f-cloud.github.io/fi-mining-bot/index.html')).text();
const marks = ['pEdit', 'pGrant', 'pDayReset', 'pWipeDev', 'pDelete', 'pGet', 'playerEditor', 'peBtn'];
for (const m of marks) console.log(m + ':', h.includes(m));
console.log('len:', h.length);
