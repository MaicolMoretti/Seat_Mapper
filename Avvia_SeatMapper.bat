@echo off
title Avvio Seat Mapper
echo ==============================================
echo   Avvio di Seat Mapper (con Ngrok e Server)
echo ==============================================

:: Percorso di ngrok
set NGROK_PATH=C:\Users\maico\Downloads\ngrok-v3-stable-windows-amd64\ngrok.exe

:: Controlla se ngrok esiste
if not exist "%NGROK_PATH%" (
    echo ERRORE: ngrok.exe non trovato in %NGROK_PATH%
    echo Scarica ngrok da https://ngrok.com/download e mettilo nella cartella indicata.
    pause
    exit /b 1
)

:: 1. Avvia il Server FastAPI in una nuova finestra
echo [1/3] Avvio del server FastAPI...
cd /d "%~dp0backend"
start "Seat Mapper - Server" cmd /k "venv\Scripts\activate.bat && uvicorn main:app --host 0.0.0.0 --port 8000"

:: Torna alla cartella principale
cd /d "%~dp0"

:: Aspetta che il server si avvii
timeout /t 3 /nobreak > NUL

:: 2. Avvia Ngrok in una nuova finestra
echo [2/3] Avvio del tunnel Ngrok...
start "Seat Mapper - Ngrok" "%NGROK_PATH%" http --domain=conjugated-exploitable-julee.ngrok-free.dev 8000

:: Aspetta che ngrok stabilisca il tunnel
timeout /t 5 /nobreak > NUL

:: 3. Apri il browser
echo [3/3] Apertura del browser...
start https://conjugated-exploitable-julee.ngrok-free.dev/

echo.
echo ==============================================
echo  Tutto fatto! Questa finestra si chiude.
echo  (Per spegnere l'applicazione, chiudi le due
echo   finestre nere con il server e ngrok)
echo ==============================================
timeout /t 5 > NUL
