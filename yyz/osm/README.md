# OpenStreetMap extract for Toronto Pearson (CYYZ)

`yyz_osm.json` is an Overpass API extract (aeroway gates, parking positions, terminals, aprons,
taxiways, runways) in the box 43.655,-79.665 to 43.705,-79.585, downloaded 2026-11-07.

Map data (c) OpenStreetMap contributors, available under the Open Database License (ODbL):
https://www.openstreetmap.org/copyright

`yyz/build_osm_layout.py` turns it into `yyz/pearson_t1.json` and the dashboard overlay
`dashboard/static/yyz_osm.json`.
