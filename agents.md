# AGENTS.md

Continue from **PLAN.md** (milestone 5 onward).

## Architecture
- `src/constants.ts` — port of `constants.py` (economy, palettes, modes, scopes, colour helpers).
- `src/mapdata.ts` — loads `public/data/countries.json`, Path2D per country, hit-testing, name lookup, scope filtering.
- `src/game.ts` — local engine (port of `models.py`, `game_logic.py`, client action/bot adapters).
- `src/bot.ts` — port of `bot_playstyles.py`; keep logic 1:1 with Python.
- `src/firebase.ts` — port of `firebase_sync.py`; optimistic concurrency via `currentDocument.updateTime`.
- `src/session.ts` — `LocalSession` / `OnlineSession` behind one `Session` interface for the UI.
- `src/settings.ts`, `src/audio.ts`, `src/rules.ts`.
- `scripts/build_map_data.py` + `continents.py` — generate map JSON using the Python game's own `geometry.py`.

## Non-obvious decisions
- Online play shares the desktop Firebase project (owner's choice): **do not change document shapes, country IDs (1-based GeoJSON order) or field names**, or cross-play breaks.
- The Firebase web API key is a public client key, not a secret.
- The GeoJSON has no continent data; `scripts/continents.py` assigns them.
- No `package.json`/`index.html` exists yet — milestone 5. Do not reuse the old stub `web/` code from the upload.
