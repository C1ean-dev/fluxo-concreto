@echo off
chcp 65001 > nul
title Concreto Projetado - Servidor SQLite e ORM
cd /d "%~dp0"
echo ==========================================================
echo   Iniciando Servidor HTTP, SQLite e ORM
echo   Concreto Projetado - Fluxo de Relatorios
echo ==========================================================
echo.
echo Abrindo aplicacao e gerenciador do banco no navegador...
start http://localhost:3000/
start http://localhost:3000/banco.html
echo.
echo Pressione Ctrl+C para encerrar o servidor.
echo.
node server.js
pause
