# Guida al Setup di ngrok per Accesso Remoto

Per rendere la tua web-app accessibile da qualsiasi parte del mondo (e ottenere una connessione **HTTPS** sicura), puoi utilizzare **ngrok**.

## 1. Installazione

1. Registrati gratuitamente su [ngrok.com](https://ngrok.com/).
2. Scarica la versione per Windows.
3. Estrai l'archivio `ngrok.exe` in una cartella a tua scelta (es. sul Desktop o nella cartella del progetto).

## 2. Autenticazione

Apri il terminale (PowerShell) nella cartella dove hai estratto ngrok e inserisci il tuo token (trovato nella dashboard di ngrok):

```powershell
./ngrok config add-authtoken IL_TUO_TOKEN_QUI
```

## 3. Avvio della Web App

Prima di avviare ngrok, assicurati che il tuo server locale sia attivo:

```powershell
cd "backend"
uvicorn main:app --host 0.0.0.0 --port 8000
```

## 4. Avvio del Tunnel ngrok

In una **nuova finestra** del terminale, avvia il tunnel:

```powershell
./ngrok http 8000
```

## 5. Utilizzo

Ngrok ti fornirà un URL pubblico (es. `https://abcd-123.ngrok-free.app`).

- **HTTPS Automatico**: L'URL fornito da ngrok è già protetto da certificato SSL.
- **Accesso Mobile**: Apri questo URL sul tuo smartphone o tablet.
- **Sincronizzazione**: Tutte le modifiche fatte tramite l'URL ngrok si rifletteranno istantaneamente su tutti gli altri dispositivi (locali e remoti) grazie ai WebSocket.

---

> [!IMPORTANT]
> Se ricevi un avviso "ngrok-free.app is about to show you...", clicca su **"Visit Site"**. Questo è un avviso di sicurezza standard per gli account gratuiti di ngrok.
