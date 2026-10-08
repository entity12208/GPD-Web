# GPD — GeoPolitical Domination (Web)

Browser edition of the turn-based world-conquest strategy game. Play locally against adaptive AI bots, watch bots battle, or play online with desktop players through the shared Firebase backend.

**Tech:** TypeScript, Vite, HTML Canvas, Web Audio, Firebase Auth + Firestore REST, Netlify.

The browser UI follows the desktop game's centered main menu, full-map play view, turn panel, nation cards, and bottom action dock. A built-in Learning Guide outlines geography, economic trade-offs, probability and risk, strategic planning, information visibility, and peace incentives. These are concepts to explore through the game's rules—not claims that it simulates or predicts real-world politics.

## Run locally
```bash
npm i
npm run dev
```
Create a production build with `npm run build`.
Regenerate map data (needs the Python source): `python3 scripts/build_map_data.py <python-src-dir>`

Online play requires a secure browser context: use HTTPS, or `localhost` for local development. A LAN address served over plain HTTP does not expose the browser's Web Crypto API.

## Status
The playable web edition includes local games against adaptive bots, bot spectating, online rooms, the interactive map, and account/profile screens. The engine, map data, Firebase client and session layer share the desktop game's existing data model — see [plan.md](plan.md).
