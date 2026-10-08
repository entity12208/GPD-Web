"""
Generate public/data/countries.json from the Python game's GeoJSON.

Uses the Python client's own geometry.py so that country IDs, centroids,
bounding boxes and the adjacency graph are identical to the desktop game
(required for online cross-play, where countries are keyed by ID).
Polygons are simplified for rendering only.

Usage: python3 scripts/build_map_data.py <path-to-GeoPoliticalDomination-python-src>
"""
import json
import os
import sys

src = os.path.abspath(sys.argv[1])
sys.path.insert(0, src)
from constants import WIDTH, MAP_H, GEOJSON_CACHE  # noqa: E402
from geometry import load_countries_from_geojson, build_adjacency  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from continents import CONTINENT_BY_ISO  # noqa: E402


def simplify(points, tol):
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            if norm == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


with open(GEOJSON_CACHE, encoding="utf-8") as f:
    feats = json.load(f)["features"]
countries = load_countries_from_geojson(GEOJSON_CACHE, WIDTH, MAP_H)
build_adjacency(countries)

# Mirror the cid assignment in load_countries_from_geojson to recover ISO codes
iso_by_cid = {}
cid = 1
for feat in feats:
    iso_by_cid[cid] = feat.get("properties", {}).get("ISO3166-1-Alpha-2", "")
    cid += 1

out = []
for cid, c in countries.items():
    rings = []
    for ring in c["polygons"]:
        dedup = []
        for p in ring:
            if not dedup or dedup[-1] != tuple(p):
                dedup.append(tuple(p))
        s = simplify(dedup, 0.6)
        if len(s) >= 3:
            rings.append([v for p in s for v in p])
    iso = iso_by_cid.get(cid, "")
    name = c["name"]
    cont = c["continent"] or CONTINENT_BY_ISO.get(iso) or CONTINENT_BY_ISO.get(name, "Oceania")
    out.append({
        "id": cid, "n": name, "iso": iso, "c": cont,
        "ce": list(c["centroid"]), "b": list(c["bbox"]),
        "a": [[a["to"], a["cost"]] for a in c["adj"]],
        "p": rings,
    })

dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "data", "countries.json")
with open(dst, "w", encoding="utf-8") as f:
    json.dump({"w": WIDTH, "h": MAP_H, "countries": out}, f, separators=(",", ":"))
print("wrote", len(out), "countries to", os.path.normpath(dst))
