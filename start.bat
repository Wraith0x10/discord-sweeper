@echo off
cd /d "%~dp0"
echo Starting Discord Sweeper...
start "" http://127.0.0.1:4783
node server.js
pause
