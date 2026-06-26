# netbox-facilitymap

A NetBox 4.x plugin that embeds a facility map — a navigable **siteplan →
building → floor → room** view whose rooms link to NetBox **Locations** — inside NetBox.
It packages the standalone annotation tool (`../tool/`): the framework-free frontend is
reused (verbatim except its URL literals), the tool's flat JSON files become a
`FacilityMapBlob` table, and the tool's token-holding NetBox proxy becomes direct ORM
reads. The plugin **ships with no facility content** — see *Build artifacts*.

> Status: **built** (skeleton → read-only map → editing/save → ORM racks/devices +
> auth hardening → relational `Room` + NetBox-native render → full Room UI + REST),
> shipped as `1.1.0`. Design & packaging internals in [`DESIGN.md`](DESIGN.md);
> release history in [`CHANGELOG.md`](CHANGELOG.md).

## What works in this milestone

- Installs into NetBox and mounts at `/plugins/facilitymap/` with a **Facility Map** nav item.
- **Full-bleed map** (the app takes the whole viewport; it does not embed in NetBox chrome).
- View annotated floors; pan/zoom; view-mode room clicks open the bound Location page.
- **Draw + save** rooms, siteplan hotspots, arrows, and sheet layouts (CSRF-protected).
  Bind a room to a NetBox Location (live ORM autocomplete).
- **Relational rooms.** Room polygons are a first-class `Room(NetBoxModel)` FK'd to
  `dcim.Location` (the source of truth behind the editor's JSON), so they are queryable and
  object-permission scopable. Each floor's `dcim.Location` page shows a **Rooms** panel that
  draws the floor plan with its room polygons, each linking to its bound room Location.
- Import existing tool data with `manage.py facilitymap_import` (rooms land as `Room` rows).
- **Place racks/devices** in datacenter rooms: inventory is fetched live from NetBox
  (`netbox/racks`, `netbox/devices`), restricted to the requester's object permissions.
- **Native Room UI + REST.** Rooms have a **Rooms** nav item with a filterable list,
  detail (with a polygon-over-floor preview), edit/delete, and bulk edit/delete; a REST API
  at `/api/plugins/facilitymap/rooms/` (filter by `floor_key`/`datacenter`/`location_id`);
  and global-search coverage — all object-permission scoped. The **map editor stays
  authoritative for room geometry**, so a native room create/edit is durable only until the
  editor next saves that floor (last-writer-wins); native editing is best for
  `label`/`location`/`datacenter`/`tags`.

## Build artifacts (ships empty)

The JS/CSS/fonts under `netbox_facilitymap/static/netbox_facilitymap/` are reused from the
standalone tool. The facility data — `manifest.json` + `images/` — is **operator-supplied**
and ships empty (`manifest.json` is the stub `{"siteplan":null,"buildings":[]}`, no `images/`).
To populate the plugin for your facility:

1. Import your drawings in the standalone tool (its in-app **Import** wizard) to produce
   `tool/manifest.json` + `tool/images/`.
2. Copy `tool/manifest.json` and `tool/images/` into `static/netbox_facilitymap/`, then run
   `collectstatic`.
3. Import the annotations with `manage.py facilitymap_import` (rooms land as `Room` rows).

(The import wizard itself is **tool-only** — NetBox has no PDF-render endpoint; the plugin
consumes the tool's built output.)

## Install (into a NetBox instance)

Run as the NetBox service user, **inside NetBox's virtualenv** (default `/opt/netbox/venv`).

```bash
source /opt/netbox/venv/bin/activate

# From a checkout (dev): editable install from this directory
pip install -e /path/to/netbox-facilitymap
# …or, once it has its own GitHub repo, pin to a release tag:
# pip install git+https://github.com/<org>/netbox-facilitymap.git@v1.1.0
```

Enable it in `/opt/netbox/netbox/netbox/configuration.py`:

```python
PLUGINS = [
    "netbox_facilitymap",
]
# PLUGINS_CONFIG is optional — the plugin ships working defaults.
```

Apply the database + static changes and restart:

```bash
python /opt/netbox/netbox/manage.py migrate
python /opt/netbox/netbox/manage.py collectstatic --no-input

# first install only: import existing annotations from the standalone tool
python /opt/netbox/netbox/manage.py facilitymap_import --src /path/to/tool

sudo systemctl restart netbox netbox-rq
```

Open **NetBox → Plugins → Facility Map** (or `/plugins/facilitymap/`).

> **NetBox version.** `min_version`/`max_version` in `netbox_facilitymap/__init__.py` are
> pinned to `4.1.7`–`4.6.0`. NetBox's plugin/menu/`restrict()`/template-extension APIs shift
> between 4.x minors, so re-verify against your exact minor before widening the range. The
> `Room` schema migration
> (`0002_room`) is authored to 4.x conventions; if `makemigrations netbox_facilitymap`
> against your minor produces a different file, prefer the generated one.

## Upgrade

```bash
source /opt/netbox/venv/bin/activate
pip install --upgrade -e /path/to/netbox-facilitymap     # or @vX.Y.Z from GitHub
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

## Layout

```
netbox_facilitymap/
  __init__.py        FacilityMapConfig(PluginConfig)
  navigation.py      Facility Map + Rooms nav items
  urls.py            page mount + /api/ JSON endpoints + Room UI routes
  views.py           MapView (full-bleed TemplateView) + Room list/detail/edit/delete/bulk
  api.py             AnnotationsView (compose/decompose) + blob GET/POST + ORM netbox reads
  api/               DRF REST API for Room (serializers, viewset, router) → /api/plugins/facilitymap/
  models.py          FacilityMapBlob (JSON docs) + Room (NetBoxModel, FK → dcim.Location)
  filtersets.py      RoomFilterSet (shared by REST + UI list)
  tables.py          RoomTable
  forms.py           RoomForm / RoomFilterForm / RoomBulkEditForm
  search.py          RoomIndex (global search)
  template_content.py  FloorRooms (room-polygon panel on the floor Location page)
  migrations/        0001_initial, 0002_room, 0003_backfill_rooms
  management/commands/facilitymap_import.py
  templates/netbox_facilitymap/index.html        (injects window.MAP)
  templates/netbox_facilitymap/floor_rooms.html  (the Location-page room overlay)
  templates/netbox_facilitymap/room.html         (Room detail page + polygon preview)
  static/netbox_facilitymap/                     (frontend + build artifacts)
```
