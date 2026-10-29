@echo off
chcp 65001 >nul
title FI Mining Bot
cd /d %~dp0
echo.
echo ================= FI MINING BOT =================
echo   Консоль разработчика: в Telegram у бота /staff
echo   Остановка: Ctrl+C
echo =================================================
echo.
node bot.js
echo.
pause
