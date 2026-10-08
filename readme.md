# GPD — GeoPolitical Domination (Web)

Browser edition of the turn-based world-conquest strategy game. Play locally against adaptive AI bots, watch bots battle, or play online with desktop players through the shared Firebase backend.

**Tech:** TypeScript, Vite, HTML Canvas, Web Audio, Firebase Auth + Firestore REST, Netlify.

## Run locally
```bash
npm install
npm run dev
```
Regenerate map data (needs the Python source): `python3 scripts/build_map_data.py <python-src-dir>`

## Status
Game engine, bot AI, map data, Firebase client and session layer are ported. The renderer, menu screens, build scaffold and deployment remain — see [PLAN.md](PLAN.md).
