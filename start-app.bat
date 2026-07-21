@echo off
rem Starts the Quotation Manager (API + web app) and opens the browser.
set "PATH=C:\Program Files\nodejs;%PATH%"
start "Quotation API" cmd /k "cd /d %~dp0server && npm run dev"
start "Quotation Web" cmd /k "cd /d %~dp0client && npm run dev"
timeout /t 4 /nobreak >nul
start http://localhost:5173
