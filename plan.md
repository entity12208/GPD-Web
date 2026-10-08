# GPD Web — Roadmap

1. **Game engine port (done)** — rules, economy, combat, continent bonuses, elimination (`src/game.ts`), adaptive bot AI with difficulty presets (`src/bot.ts`), constants and rules text.
2. **Map data (done)** — `public/data/countries.json`, generated from the Python game's own geometry code so country IDs and adjacency match the desktop client.
3. **Firebase backend (done)** — accounts, rooms, turn actions, lobby, chat, joined games, stats, Elo leaderboard, friends, notifications (`src/firebase.ts`), same project/layout as desktop.
4. **Sessions (done)** — one interface for local, spectate and online games (`src/session.ts`), incl. tournament timer.
5. **Project scaffold (done)** — `package.json` (Vite + TypeScript), `index.html`, `vite.config.ts`, `netlify.toml` (publish `dist`, SPA redirect).
6. **Canvas renderer + play screen (done)** — interactive map, pan/zoom, ownership fills, troop pins, hover details, fog of war / blind mode, action bar (Peace/Expand/Gather/Nothing + 1–4 keys), gather/expand dialogs, logs, chat, lobby start, and game-over display.
7. **Menu screens (done)** — account login/register, main menu, local/spectate setup, online browser, create/join by code, My Games, stats, leaderboard, friends, notifications, rules, and settings.
8. **Deploy as GPD** — rename the Netlify site to `gpd` (or closest free name) and deploy.
