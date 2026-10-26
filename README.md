# Glass Chess

A FastAPI + WebSocket chess site with two game modes:

- Play vs Computer (Easy / Medium / Hard)
- Online multiplayer with private invite links

Features include accurate legal moves via `python-chess`, timers, move history, sound, resign, draw offers for online games, promotion chooser, rematches, spectators, reconnecting player seats, responsive 1:1 chessboard, and a glassmorphism UI.

## Run locally

```powershell
py -m pip install -r requirements.txt
py main.py
```

Open: `http://127.0.0.1:8000`

## Deploy

The included `railway.json` is ready for Railway. Push the project to GitHub, deploy the repository on Railway, and generate a public domain from Networking settings.
