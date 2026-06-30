# netbox-facilitymap

A self-contained NetBox 4.x plugin that embeds a facility map — a navigable **siteplan →
building → floor → room** view whose rooms link to NetBox **Locations** — inside NetBox.
Import a facility's floor-plan **PDFs in-app**, draw and bind room polygons, and render the
same map natively on NetBox Location pages. The framework-free frontend, the relational
`Room` model, and the PDF-import pipeline all live in the one plugin — there is no separate
tool or external build step.

> Status: **built**. Design & packaging internals in [`DESIGN.md`](DESIGN.md); the deep
> frontend/coordinate/data reference in [`ARCHITECTURE.md`](ARCHITECTURE.md); release
> history in [`CHANGELOG.md`](CHANGELOG.md).

## What it does

- Installs into NetBox and mounts at `/plugins/facilitymap/` with **Facility Map** and
  **Settings** nav items.
- **Full-bleed map** (the app takes the whole viewport; it does not embed in NetBox chrome).
- **Import a facility from PDFs, in-app.** Upload a folder of floor-plan PDFs — or a single
  `.zip` of them (any wrapper folder is stripped automatically) — and the plugin renders them
  to floor images and a manifest, then drops you onto the new map. While mapping floors, click
  a drawing to preview it and scroll/drag its thumbnail to frame the floor label. (See
  *Security model* — the renderer runs isolated and is permission-gated.)
- View annotated floors; pan/zoom; view-mode room clicks open the bound Location page.
- **Draw + save** rooms, siteplan hotspots, arrows, and sheet layouts (CSRF-protected,
  permission-gated). Bind a room to a NetBox Location (live ORM autocomplete).
- **Relational rooms.** Room polygons are a first-class `Room(NetBoxModel)` FK'd to
  `dcim.Location` (the source of truth behind the editor's JSON), so they are queryable and
  object-permission scopable. Each floor's `dcim.Location` page shows a **Rooms** panel that
  draws the floor plan with its room polygons, each linking to its bound room Location.
- **Place racks/devices** in any room bound to a Location: inventory is fetched live from
  NetBox (`netbox/racks`, `netbox/devices`), restricted to the requester's object permissions.
- **Room REST API.** Rooms are exposed through a REST API at
  `/api/plugins/facilitymap/rooms/` (filter by `floor_key`/`location_id`), object-permission
  scoped. (There is no standalone Rooms browse page — rooms are reached via their bound
  `dcim.Location`, whose page already shows the cropped preview.) The **map editor stays
  authoritative for room geometry**, so a REST room create/edit is durable only until the
  editor next saves that floor (last-writer-wins); REST editing is best for
  `label`/`location`/`tags`.

## Importing a facility

The plugin ships with **no facility content**; you build it from your drawings:

1. Open **Facility Map** (an empty install lands on the import wizard; otherwise use
   **Settings → Edit buildings & floors**).
2. **Upload** a folder of building drawings — one sub-folder per building, each holding its
   floor PDFs — or a single **`.zip`** of that folder (a wrapper folder inside the zip is
   stripped automatically). The overall siteplan image comes from either a PDF dropped **loose
   at the top level** of the facility folder (any name) or a sub-folder named like *site plan*.
3. **Map** each drawing to a floor (the PDFs carry no text layer, so floor identity is
   assigned here), confirm each building's NetBox **site slug** and floor-id prefix. First pick
   the **site plan** on its own step (it's the overall site map and has no floor code, so it's
   chosen apart from floor assignment). Then comes a quick **region-pick** step: on a sample
   drawing, drag one box over the spot that identifies each drawing — the **floor-designation
   caption** (e.g. "… SECOND BASEMENT LEVEL (B2) PLAN …") or title-block code (zoom in with
   **−/Fit/+** and scroll to pan if it's small). Each floor card on the mapping grid then shows a
   **close-up crop of just that spot** of the drawing, so you can read off the floor and assign it
   at a glance. Clicking a card opens the **whole drawing** in a lightbox (the escape hatch for an
   outlier whose code sits outside the box). For a building whose title block sits elsewhere,
   **Set this building's code region** overrides the crop region for just that building's cards. If the
   code's position is too inconsistent to box, **Skip — show full drawings** falls back to
   full-drawing thumbnails. The crop is drawn entirely in the browser over the images the plugin
   already renders — no floor identity ever leaves your server. When a building's site has NetBox
   floor Locations, each drawing is assigned by picking one as a button; if the floor you need
   isn't listed (the auto-detect missed it), use **+ Add floor** to search that site's Locations
   and pull it in.
4. **Build** — the plugin renders the images + manifest and opens the map. Then draw rooms
   and bind each to its NetBox Location.

**Editing a built facility.** Re-opening the wizard resumes onto the current facility (no
"Start over" needed), so you can **fix** a building/floor assignment, **replace** a single
floorplan in place (the per-drawing *Replace* button — keeps the same floor, so rooms already
drawn on it stay), or **add** a building/floor (*+ Add drawings* — existing assignments are
preserved; only the new drawings need assigning). Adding a building re-points at an existing
NetBox Site/Location — create the Location in NetBox first. Re-assigning a drawing's floor or
re-binding a building **changes that floor's id**, so any rooms drawn on it are dropped; the
wizard warns and asks you to confirm before discarding them.

Rendered images, thumbnails, the manifest, and uploaded PDFs live under a writable working
directory — `<MEDIA_ROOT>/netbox_facilitymap/` by default (override with the `work_dir`
setting) — and are served back only through **authenticated** endpoints, never a public
static URL.

> **Migrating from an older export.** If you have JSON exported by a previous version
> (`annotations.json`, `siteplan.json`, `rackplacements.json`, `pagelayouts.json`), import
> it with `manage.py facilitymap_import --src /path/to/dir` (rooms land as `Room` rows). New
> facilities should use the in-app wizard instead.

## Settings

**NetBox → Plugins → Facility Map → Settings** is an in-app, DB-backed settings page —
editable in the browser, no config-file edit or worker restart needed. Saving requires the
`netbox_facilitymap.change_facilitymapblob` permission (the same as every map write), and the
nav entry only appears for users who hold it.

- **Room embed zoom** — how far the cropped per-room map embed (the panel shown on a room's
  `dcim.Location` page) zooms in. `1.0` is a tight crop to the room itself; higher values pull
  more of the surrounding floor into view. Range **1.0–5.0**, default **2.0**. It affects only
  the cropped room embed, not whole-floor views, and takes effect on the next page load.

(These are distinct from the `PLUGINS_CONFIG` render guardrails below, which are edited in the
server config and need a restart.)

## Security model

Accepting and rasterizing uploaded PDFs is an attack surface, so it is contained:

- **Renderer isolation.** PDFs are parsed **only in a short-lived subprocess**
  (`preprocess.py`, invoked by file path so the plugin/Django is never imported into the
  child), with a wall-clock **timeout** and POSIX **resource limits** (CPU + address space).
  A PDFium exploit cannot reach the NetBox worker's memory or DB. The renderer is
  [`pypdfium2`](https://github.com/pypdfium2-team/pypdfium2) (Google's PDFium as a
  self-contained wheel) — no system Ghostscript/poppler.
- **Authorization.** Every import endpoint and every map **write** requires the
  `netbox_facilitymap.change_facilitymapblob` permission (not merely a login). Grant it to
  the users who maintain the map. Reads require a login (same access as the map).
- **Input validation.** Uploads must be real `%PDF-` files within a size cap, on a
  traversal-guarded path; an import past a PDF-count cap is rejected. A `.zip` upload is
  unpacked in the worker (PDF *rendering* still runs only in the subprocess) under size,
  decompression, count, traversal, and symlink-member guards.
- **Authenticated serving.** Floor plans are streamed from the working dir through a
  login-gated, traversal-guarded view — not exposed at a guessable public URL.
- **Concurrency.** A working-dir lockfile serializes renders across worker processes.

Tunable guardrails (all optional, with safe defaults) via `PLUGINS_CONFIG`:

```python
PLUGINS_CONFIG = {
    "netbox_facilitymap": {
        # "work_dir": "/var/lib/netbox-facilitymap",  # default: <MEDIA_ROOT>/netbox_facilitymap
        "max_pdf_mb": 50,         # reject a single PDF larger than this
        "max_pdfs": 400,          # reject an import with more PDFs than this
        "max_zip_mb": 200,        # reject a .zip upload larger than this
        "max_zip_uncompressed_mb": 2048,  # cumulative decompressed cap (zip-bomb guard)
        "render_timeout_s": 300,  # kill the render subprocess after this long
        "render_mem_mb": 4096,    # RLIMIT_AS for the render subprocess (POSIX)
    },
}
```

## Install (into a NetBox instance)

Run as the NetBox service user, **inside NetBox's virtualenv** (default `/opt/netbox/venv`).
Installing pulls the runtime deps `pypdfium2` + `Pillow` automatically — both ship as
self-contained wheels, so the plugin works on **any environment, including headless servers, with
no system packages**. NetBox's `MEDIA_ROOT` must be writable by the service (it already is for
NetBox's own uploads).

The plugin lives in the `netbox-facilitymap/` subdirectory of the
[Network-Services-Faculty-Map](https://github.com/lsbarro2026/Network-Services-Faculty-Map)
repository, so installing straight from GitHub uses pip's `#subdirectory=` syntax.

```bash
source /opt/netbox/venv/bin/activate

# Straight from GitHub (no clone needed) — note the subdirectory pin:
pip install "git+https://github.com/lsbarro2026/Network-Services-Faculty-Map.git#subdirectory=netbox-facilitymap"
# …or pin to a release tag — use the latest tag (currently v1.5.0):
# pip install "git+https://github.com/lsbarro2026/Network-Services-Faculty-Map.git@v1.5.0#subdirectory=netbox-facilitymap"

# …or, from a local checkout (dev): editable install from this directory
# pip install -e /path/to/Network-Services-Faculty-Map/netbox-facilitymap
```

Enable it in `/opt/netbox/netbox/netbox/configuration.py`:

```python
PLUGINS = [
    "netbox_facilitymap",
]
# PLUGINS_CONFIG is optional — see Security model for the tunable render guardrails.
```

Apply the database + static changes and restart:

```bash
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input
sudo systemctl restart netbox netbox-rq
```

Open **NetBox → Plugins → Facility Map** (or `/plugins/facilitymap/`) and import your PDFs.

> **NetBox version.** `min_version`/`max_version` in `netbox_facilitymap/__init__.py` are
> pinned to `4.1.7`–`4.6.0`. NetBox's plugin/menu/`restrict()`/template-extension APIs shift
> between 4.x minors, so re-verify against your exact minor before widening the range. The
> `Room` schema migration (`0002_room`) is authored to 4.x conventions; if
> `makemigrations netbox_facilitymap` against your minor produces a different file, prefer
> the generated one.

## Upgrade

```bash
source /opt/netbox/venv/bin/activate
# from GitHub:
pip install --upgrade "git+https://github.com/lsbarro2026/Network-Services-Faculty-Map.git#subdirectory=netbox-facilitymap"
# …or from a local checkout: git pull, then  pip install --upgrade -e /path/to/Network-Services-Faculty-Map/netbox-facilitymap
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input
sudo systemctl restart netbox netbox-rq
```

## Uninstall

Remove `"netbox_facilitymap"` from `PLUGINS`, then `pip uninstall netbox-facilitymap` and
restart NetBox. To drop the data first, reverse the migrations before removing the package:

```bash
python /opt/netbox/netbox/manage.py migrate netbox_facilitymap zero
```

Rendered images and uploads under `<MEDIA_ROOT>/netbox_facilitymap/` are not removed by
uninstall; delete that directory manually if you want them gone.

## Layout

```
netbox_facilitymap/
  __init__.py        FacilityMapConfig(PluginConfig) — version + render guardrails
  navigation.py      Facility Map + Settings nav items
  urls.py            page mount + settings + /api/ JSON endpoints + import/media routes
  views.py           MapView (full-bleed TemplateView) + SettingsView (plugin settings)
  frontend_api.py    AnnotationsView (compose/decompose) + blob GET/POST + ORM netbox reads
  imports.py         PDF import (upload/scan/build/reset) + authenticated manifest/media serving
  preprocess.py      PDF render engine (run as an isolated subprocess; pypdfium2 + Pillow)
  storage.py         work_dir() / safe_path() / media_url() helpers (MEDIA_ROOT working dir)
  api/               DRF REST API for Room (serializers, viewset, router) → /api/plugins/facilitymap/
  models.py          FacilityMapBlob (JSON docs) + Room (NetBoxModel, FK → dcim.Location)
  filtersets.py      RoomFilterSet (used by the REST API)
  template_content.py  FloorRooms (room-polygon panel on the floor Location page)
  migrations/        0001_initial, 0002_room, 0003_backfill_rooms
  management/commands/facilitymap_import.py  (import a legacy JSON export)
  templates/netbox_facilitymap/index.html        (injects window.MAP)
  templates/netbox_facilitymap/floor_rooms.html  (the Location-page room overlay)
  static/netbox_facilitymap/                     (framework-free frontend: JS/CSS/fonts)
```
