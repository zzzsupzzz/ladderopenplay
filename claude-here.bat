@echo off
cd /d "%~dp0"
powershell -NoExit -Command "claude --dangerously-skip-permissions"
