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

The cropped per-room map embed (the panel shown on a room's `dcim.Location` page) has three
independent controls. All three affect only that cropped embed, not whole-floor views, and take
effect on the next page load:

- **Room embed zoom** — how far the embed zooms in. `1.0` is a tight crop to the room itself;
  higher values pull more of the surrounding floor into view. Range **1.0–5.0**, default **2.0**.
- **Room embed size** — the embed's *footprint*: how much of the page column it fills, as a
  percent, independent of zoom (the magnification is unchanged). Range **40–100 %**, default
  **100 %**.
- **Room embed orientation** — the box shape: **vertical** (a taller box) or **landscape** (a
  short, wide box). Either way the crop is reshaped to fill the box with surrounding floor, so the
  room stays centred and fully visible. Default **vertical**.

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
        # "backup_dir": "/var/backups/facilitymap",  # default: <MEDIA_ROOT>/facilitymap-backups
        "backup_max_mb": 1024,    # prune oldest backups once the dir exceeds this (newest always kept)
    },
}
```

## Install (into a NetBox instance)

Installing pulls the runtime deps `pypdfium2` + `Pillow` automatically (self-contained wheels, so
it works on headless servers with no system packages) and writes under NetBox's `MEDIA_ROOT`,
already writable by the service. The plugin's project metadata lives in the `netbox-facilitymap/`
subdirectory of the [repo](https://github.com/lsbarro2026/Network-Services-Faculty-Map), **not** at
the root, so installing from GitHub needs pip's `#subdirectory=netbox-facilitymap` fragment — omit
it and pip fails (see Troubleshooting below).

Install into NetBox's virtualenv as the `netbox` service user (so the files stay owned by it, not
root):

```bash
sudo -u netbox /opt/netbox/venv/bin/pip install "git+https://github.com/lsbarro2026/Network-Services-Faculty-Map.git#subdirectory=netbox-facilitymap"
```

> **Variants.** To pin a specific version, append `@<tag>` before the `#` fragment (e.g.
> `…Network-Services-Faculty-Map.git@<tag>#subdirectory=netbox-facilitymap`) — see the repo's
> tags/releases for what's available. For local development, editable-install the subdirectory:
> `pip install -e /path/to/Network-Services-Faculty-Map/netbox-facilitymap`.

> **Troubleshooting.** If pip fails with *"does not appear to be a Python project: neither
> 'setup.py' nor 'pyproject.toml' found"*, the `#subdirectory=netbox-facilitymap` fragment is
> missing from the URL — the project metadata lives in that subdirectory, not the repo root. Add it
> and re-run.

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
> pinned to `4.1.7`–`4.6.99` (the whole 4.6 patch line; patch releases don't shift the plugin
> APIs, only minors do). NetBox's plugin/menu/`restrict()`/template-extension APIs shift
> between 4.x minors, so re-verify against your exact minor before widening the range. The
> `Room` schema migration (`0002_room`) is authored to 4.x conventions; if
> `makemigrations netbox_facilitymap` against your minor produces a different file, prefer
> the generated one.

## Upgrade

Re-run the same install command with `--upgrade`, then re-apply the DB/static changes:

```bash
sudo -u netbox /opt/netbox/venv/bin/pip install --upgrade "git+https://github.com/lsbarro2026/Network-Services-Faculty-Map.git#subdirectory=netbox-facilitymap"
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input
sudo systemctl restart netbox netbox-rq
```

> **Surviving NetBox upgrades.** NetBox's own `upgrade.sh` rebuilds the virtualenv into a new
> versioned directory and reinstalls **only** the plugins listed in
> `/opt/netbox/local_requirements.txt`. A plugin installed with the bare `pip install` above is
> **not** in that file, so a NetBox upgrade silently drops it while `PLUGINS` still enables it —
> `migrate` then crashes with `ModuleNotFoundError: No module named 'netbox_facilitymap'`. To make
> the install durable, add the same install target to that file once:
>
> ```bash
> echo "git+https://github.com/lsbarro2026/Network-Services-Faculty-Map.git#subdirectory=netbox-facilitymap" \
>   | sudo -u netbox tee -a /opt/netbox/local_requirements.txt
> ```
>
> (Append `@<tag>` before the `#` to pin a version, as in the install command.) `upgrade.sh` then
> reinstalls the plugin on every NetBox upgrade.

## Uninstall

Remove `"netbox_facilitymap"` from `PLUGINS`, then `pip uninstall netbox-facilitymap` and
restart NetBox. To drop the data first, reverse the migrations before removing the package:

```bash
python /opt/netbox/netbox/manage.py migrate netbox_facilitymap zero
```

Rendered images and uploads under `<MEDIA_ROOT>/netbox_facilitymap/` are not removed by
uninstall; delete that directory manually if you want them gone.

## Backups (optional)

You probably don't need this. The plugin's data — the `FacilityMapBlob` + `Room` rows in the
NetBox database, and the floor images/manifest/uploads under `MEDIA_ROOT` — is already captured
by any standard whole-NetBox backup: a `pg_dump` of the database plus a copy of `MEDIA_ROOT`
(NetBox has no built-in backup, so [running one is the operator's job](https://netboxlabs.com/docs/netbox/administration/replicating-netbox/)).
**If you do that, the map is covered and you can skip this section.**

For sites that *don't* run a whole-NetBox backup, the plugin ships an opt-in, self-contained
backup of just its own data. It is invisible until you reach for it: no UI, no scheduled job,
nothing runs on its own.

```bash
# Write one timestamped backup (DB rows + working-dir files) to the backup dir:
python /opt/netbox/netbox/manage.py facilitymap_backup
```

Each run writes a single `facilitymap-backup-YYYYMMDD-HHMMSS.tar.gz`, then FIFO-prunes the
backup dir — deleting the oldest archives once the dir exceeds `backup_max_mb` (default
**1024 MB**), always keeping at least the newest. Backups are written to `backup_dir` (default
`<MEDIA_ROOT>/facilitymap-backups`, created `0700` with `0600` files), which sits under
`MEDIA_ROOT` so a whole-NetBox media backup sweeps them up too; set `backup_dir` to relocate
them. Both knobs are `PLUGINS_CONFIG` settings (see Security model).

**Nightly schedule** — the command doesn't schedule itself; add one cron line as the NetBox
service user (this is the only setup):

```cron
# 02:30 every night
30 2 * * *  /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py facilitymap_backup >> /var/log/facilitymap-backup.log 2>&1
```

**Restore** is a separate, **destructive** command — it replaces *all* current rooms/blobs and
working-dir files with the archive's contents. Restore into the same NetBox instance the backup
came from (room→Location links reference live Location ids):

```bash
python /opt/netbox/netbox/manage.py facilitymap_restore --src /path/to/facilitymap-backup-20260630-023000.tar.gz
# prompts for confirmation; add --noinput for unattended use
sudo systemctl restart netbox netbox-rq
```

## Layout

```
netbox_facilitymap/
  __init__.py        FacilityMapConfig(PluginConfig) — version + render/backup guardrails
  navigation.py      Facility Map + Settings nav items
  urls.py            page mount + settings + /api/ JSON endpoints + import/media routes
  views.py           MapView (full-bleed TemplateView) + SettingsView (plugin settings)
  frontend_api.py    AnnotationsView (compose/decompose) + blob GET/POST + ORM netbox reads
  imports.py         PDF import (upload/scan/build/reset) + authenticated manifest/media serving
  preprocess.py      PDF render engine (run as an isolated subprocess; pypdfium2 + Pillow)
  storage.py         work_dir() / safe_path() / media_url() helpers (MEDIA_ROOT working dir)
  backup.py          opt-in plugin-scoped backup/restore (DB rows + working dir → .tar.gz)
  api/               DRF REST API for Room (serializers, viewset, router) → /api/plugins/facilitymap/
  models.py          FacilityMapBlob (JSON docs) + Room (NetBoxModel, FK → dcim.Location)
  filtersets.py      RoomFilterSet (used by the REST API)
  template_content.py  FloorRooms (room panel on the floor Location page) + SiteFloors (floor picker on the Site page)
  migrations/        0001_initial, 0002_room, 0003_backfill_rooms, 0004_remove_room_datacenter, 0005_alter_facilitymapblob_kind
  management/commands/facilitymap_import.py   (import a legacy JSON export)
  management/commands/facilitymap_backup.py   (write a backup .tar.gz, then FIFO-prune)
  management/commands/facilitymap_restore.py  (restore from a backup .tar.gz — destructive)
  templates/netbox_facilitymap/index.html        (injects window.MAP)
  templates/netbox_facilitymap/floor_rooms.html  (the Location-page room overlay)
  templates/netbox_facilitymap/site_floors.html  (the Site-page floor picker)
  templates/netbox_facilitymap/settings.html     (chrome'd form for the Settings view)
  templates/netbox_facilitymap/inc/floor_sheets.html      (tiled floor-plan sheets; included by floor_rooms.html)
  templates/netbox_facilitymap/inc/placement_markers.html (rack/device marker boxes; included by floor_rooms.html)
  static/netbox_facilitymap/                     (framework-free frontend: JS/CSS/fonts)
```
