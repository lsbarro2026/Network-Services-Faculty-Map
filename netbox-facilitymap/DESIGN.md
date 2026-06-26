# NetBox Plugin — Design & Packaging

How `netbox-facilitymap` repackages the standalone facility-map tool
(`../tool/`) as an **installable NetBox 4.x plugin** — the storage decision, the
package layout, the packaging mechanics, and the import/build pipeline.

This is the deep design reference. For **install/operate** steps see `README.md`;
for the **release history** see `CHANGELOG.md`; for the standalone tool's internals
see `../tool/ARCHITECTURE.md`.

> Status: **built** in this directory — all phases (skeleton → read-only map →
> editing/save → ORM racks/devices + auth hardening → relational `Room` +
> NetBox-native render → full Room UI + REST) are implemented and shipped as
> `1.1.0`. The standalone tool keeps running unchanged alongside the plugin.

---

## 0. As-built notes (where the build refined the original plan)

Two deliberate refinements are worth recording:

1. **The browser-facing JSON endpoints are plain Django views under the *page* mount,
   not a DRF router.** `api.py`'s views (`AnnotationsView`, `BlobView`, `NbRoomsView`,
   `NbLocationsView`, `NbRacksView`, `NbDevicesView`) are `django.views.View` subclasses
   wired in `urls.py` at `/plugins/facilitymap/api/…`, so they ride NetBox **session
   auth + Django's CSRF middleware** directly — the cleanest fit for a browser-session
   frontend. (NetBox's DRF API is token-oriented; routing these through it would mean
   fighting its auth defaults.) `window.MAP.api` reverses the page mount + `api/` rather
   than a `plugins-api:` namespace. The `_trim`/`_trim_device` shaping is reused as plain
   functions. The DRF API that *does* exist is the separate `api/` subpackage for the
   relational `Room` model (below), mounted under `/api/plugins/facilitymap/`.
2. **`locations` + `rooms` ORM reads landed early.** Room→Location *binding* can't work
   without them, so those two reads shipped alongside editing; the remaining ORM reads
   (`netbox/racks`, `netbox/devices`) followed, and the `rackcache` stub + `sync-room`
   proxy were **removed** — racks mode now fetches inventory live per room
   (`Store.ensureRacks`) into an in-memory cache. The token-holding proxy is fully gone.

The **blob model stores one row per `kind` with `key=''`** holding the whole document
(the frontend POSTs each file as a whole dict — `Store.saveAnnotations` etc.), rather than
per-floor `key="dir/floorId"` rows. The `key` column is reserved for a future per-floor
shard.

**Room as source of truth.** Room polygons are promoted to the relational
`Room(NetBoxModel)`; the `annotations` blob holds only each floor's `image`/`w`/`h`/`arrows`.
Rather than a one-way projection, `Room` is authoritative: `api.AnnotationsView` *composes*
the whole-document shape on GET (blob floors + `Room` rows merged back under `rooms`) and
*decomposes* a POST (rooms → rows via `sync_rooms`, the rest → the blob), so the
framework-free frontend and the JSON export round-trip unchanged. A `PluginTemplateExtension`
(`template_content.FloorRooms`) draws the room polygons on the floor's `dcim.Location` page.
`Room` also carries the full NetBox-native surface — DRF REST API, UI list/detail/edit/delete
+ bulk, filterset, table, global search, and a **Rooms** nav item — all object-permission
scoped, with **no schema change** beyond the `0002_room` table. The map editor's `sync_rooms`
POST stays authoritative for room **geometry**, so a natively created/edited room is durable
only until the editor next saves that floor (last-writer-wins; native edit is most useful for
`label`/`location`/`datacenter`/`tags`). The remaining blobs (siteplan/placements/layouts) are
**not** promoted.

The supported NetBox range is pinned to **`4.1.7`–`4.6.0`**.

---

## 1. Why a plugin fits

A NetBox plugin is a Django app that runs inside NetBox's own process, so it gets the
database, URL routing, session auth, object permissions, and direct ORM access to
`dcim.Site/Location/Rack/Device` for free. The standalone tool maps onto it cleanly:

- The **frontend** (`web/*.js`, `style.css`, fonts) is reused almost verbatim — it is
  framework-free, build-free, and routed entirely off `location.hash`. Its only coupling
  to the standalone server was ~20 **root-absolute URL literals** (`/api/...`,
  `/images/...`, `/manifest.json`, `/web/...`) that assume a `/` mount; those are rewritten
  to honour the plugin's `/plugins/facilitymap/` mount.
- The standalone **`NetBoxProxy`** existed only to keep the API token server-side and dodge
  CORS. Inside NetBox it collapses into direct ORM querysets and disappears (and with it,
  the `config.json` token).
- The **JSON files** that are the tool's entire persistence layer port 1:1 onto a thin
  JSON-blob Django model, so existing `annotations.json` / `siteplan.json` / etc. import
  directly.

**Target:** NetBox 4.x (Django, Python ≥ 3.10).
**Distribution name:** `netbox-facilitymap` (PyPI/dist name).
**Python package / Django app:** `netbox_facilitymap`.
**URL mount:** `/plugins/facilitymap/` (`base_url = 'facilitymap'`).
**Static/template namespace:** `netbox_facilitymap/` (namespaced by package to avoid
collisions in NetBox's shared static tree).

---

## 2. Decisions taken

- **Storage:** a thin **JSON-blob model** (1:1 with the tool's JSON files, minimal
  frontend churn), plus a promotion of **only room polygons** to a relational `Room`
  model FK'd to `dcim.Location`. The on-disk JSON format stays byte-compatible so existing
  annotations port directly (§5, §0).
- **Scope:** full phased delivery, smallest shippable milestone first (CHANGELOG.md).
- **Packaging:** a standalone, pip-installable repo, installed into NetBox's virtualenv
  with `pip install` (editable today; `git+https://…@vX.Y.Z` once it has its own repo)
  (§6, README.md).

---

## 3. Repository & package layout

The plugin is structured as a standard installable Python distribution (intended to split
into its **own repository**, separate from `tool/`, so `pip install
git+https://github.com/<org>/netbox-facilitymap` works directly).

```
netbox-facilitymap/                      # distribution root
  pyproject.toml                         # build + dependency + version metadata (§6)
  MANIFEST.in                            # ship non-.py files (templates, static)
  README.md                              # install + operate
  DESIGN.md                              # this file
  CHANGELOG.md
  LICENSE
  netbox_facilitymap/                    # the importable Django app package
    __init__.py                          # FacilityMapConfig(PluginConfig)  (§4)
    navigation.py                        # Facility Map + Rooms nav items
    urls.py                              # page mount + api/ JSON endpoints + Room UI routes
    views.py                             # MapView (TemplateView) + Room UI (list/detail/edit/bulk)
    api.py                               # AnnotationsView (compose/decompose) + blob CRUD + ORM reads
    models.py                            # FacilityMapBlob; Room(NetBoxModel) FK → dcim.Location
    filtersets.py  tables.py  forms.py   # RoomFilterSet / RoomTable / Room*Form
    search.py                            # RoomIndex (global search)
    template_content.py                  # FloorRooms (room panel on the floor Location page)
    api/                                 # DRF REST API for Room
      serializers.py  views.py  urls.py  # RoomSerializer + RoomViewSet + NetBoxRouter
    management/
      commands/
        facilitymap_import.py            # load existing tool/ JSON into the DB (§7)
    migrations/                          # 0001_initial, 0002_room, 0003_backfill_rooms
    templates/netbox_facilitymap/
      index.html                         # was tool/web/index.html (injects window.MAP)
      floor_rooms.html                   # the Location-page room overlay
      room.html                          # Room detail page + polygon preview
    static/netbox_facilitymap/
      lib.js device-shapes.js netbox.js store.js grid.js panzoom.js
      editor.js floor-editor.js siteplan-editor.js app.js
      style.css
      fonts/                             # bundled WOFF2 (Public Sans + IBM Plex Mono)
      images/<slug>/<floor>.png          # operator-supplied (from tool/images/); absent by default
      manifest.json                      # operator-supplied; ships as an empty stub
```

The frontend JS/CSS/fonts are reused from `tool/web/`; **`import-wizard.js` is *not*
copied** (the PDF import is tool-only — NetBox has no render endpoint). The plugin ships
with **no facility content**: `manifest.json` is the empty stub
`{"siteplan":null,"buildings":[]}` and there is no `images/` until an operator builds one
(§7).

**Reused vs. replaced (from `tool/`):**

| Existing (`tool/`) | Fate in plugin |
|---|---|
| `web/*.js`, `style.css`, `fonts/` | Reused; only ~20 URL literals change → `static/netbox_facilitymap/`. |
| `web/index.html` | Becomes `templates/netbox_facilitymap/index.html` (config injection + `{% static %}`). |
| `server.py` `JsonStore` (the JSON files) | Replaced by `FacilityMapBlob` model + CRUD views; room polygons further promoted to `Room`. |
| `server.py` `NetBoxProxy` | Replaced by ORM-backed views; deleted. |
| `server.py` `Config`/`ToolServer`/`Handler` | Deleted — NetBox provides server, routing, auth. |
| `server.py` `_trim`/`_trim_rack`/`_trim_device` | Reused as shaping functions (keep the 4.x `role` / 3.x `device_role` fallback). |
| `rackcache.json` + `/api/netbox/sync-room` | Dropped — racks/devices queried live via ORM. |
| `preprocess.py` | Stays **external/offline** (the tool's import engine); the plugin never renders PDFs (§7). |
| `import-wizard.js` | **Not copied** — PDF import is tool-only (no render endpoint in NetBox). |
| `manifest.json` + `images/` | Format preserved; **operator-supplied** static assets — ship empty. |

---

## 4. Plugin registration

`netbox_facilitymap/__init__.py`:
```python
from netbox.plugins import PluginConfig

class FacilityMapConfig(PluginConfig):
    name = 'netbox_facilitymap'
    verbose_name = 'Facility Map'
    description = 'Navigable siteplan → building → floor → room map linked to Locations'
    version = '1.1.0'
    author = 'Facility Map'
    base_url = 'facilitymap'
    min_version = '4.1.7'     # pinned to the tested range; NetBox enforces at load
    max_version = '4.6.0'
    default_settings = {}     # netbox_url/token/port from config.json are obsolete

config = FacilityMapConfig
```

- **Navigation** (`navigation.py`): a **Facility Map** `PluginMenuItem` to the full-page
  map, plus a **Rooms** item to the native `Room` list.
- **Full-page view** (`views.py`): `MapView(LoginRequiredMixin, TemplateView)` rendering
  `netbox_facilitymap/index.html`; `urls.py`: `path('', MapView.as_view(), name='map')`.
  The app is a full-bleed SVG canvas, so it uses a **minimal standalone template** (it does
  *not* `{% extends 'base/layout.html' %}`) served inside the authenticated mount. The
  relational `Room` model adds the usual `netbox.views.generic` list/detail/edit/delete +
  bulk views alongside it.

---

## 5. Storage model

One generic blob table mirrors the tool's user-data JSON files; CRUD is a single view
pattern; the room polygons are promoted to a first-class model.

```python
class FacilityMapBlob(models.Model):
    kind = models.CharField(max_length=20)   # 'annotations'|'siteplan'|'placements'|'layouts'
    key  = models.CharField(max_length=120, blank=True)  # reserved per-floor shard; '' today
    data = models.JSONField(default=dict)
    updated = models.DateTimeField(auto_now=True)
    class Meta:
        unique_together = [('kind', 'key')]
```

- A blob-CRUD view upserts the row; `rackcache` is **not** modelled — it is regenerated
  live from the ORM (§0).
- **Room promotion (the real payoff):** the room polygon is a first-class
  `Room(NetBoxModel)` with `floor_key`, `room_id`, `label`, `polygon` (JSONField,
  normalized 0..1), `datacenter`, and `location` FK → `dcim.Location`, backfilled from the
  annotations blob by migration `0003_backfill_rooms` (reversible). `Room` is the source of
  truth; `AnnotationsView` composes/decomposes so the blob keeps only
  `image`/`w`/`h`/`arrows`. Hotspots / placements / layouts / arrows stay blobs
  (editor-internal, low query value).
- **Full Room surface, no schema change** — `Room` carries a DRF REST API (`api/`
  subpackage), UI list/detail/edit/delete + bulk, `RoomFilterSet`, `RoomTable`, global-search
  `RoomIndex`, and the **Rooms** nav item — all object-permission scoped, reusing the
  `0002_room` table. The map editor remains authoritative for room geometry (`sync_rooms`),
  so native edits beyond `label`/`location`/`datacenter`/`tags` are overwritten on the
  editor's next save of that floor (last-writer-wins).

---

## 6. Packaging mechanics (for `pip install`)

`pyproject.toml` (setuptools backend; hatchling works equally):
```toml
[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "netbox-facilitymap"
version = "1.1.0"
description = "Facility map plugin for NetBox"
requires-python = ">=3.10"
dependencies = []                 # stdlib + Django/DRF (NetBox supplies them)
readme = "README.md"
license = { text = "MIT" }

[tool.setuptools.packages.find]
include = ["netbox_facilitymap*"]

[tool.setuptools.package-data]
netbox_facilitymap = ["templates/**/*", "static/**/*"]
```

`MANIFEST.in` (belt-and-braces so templates/static/fonts/images ship in the sdist):
```
recursive-include netbox_facilitymap/templates *
recursive-include netbox_facilitymap/static *
```

**Key packaging rules**
- **No runtime pip dependencies.** The plugin code is stdlib + Django/DRF (which NetBox
  already provides). `preprocess.py`'s optional `pypdfium2`/`Pillow` are a *developer* build
  tool, never a plugin runtime dep — keep them out of `[project.dependencies]`.
- **Ship the static + template files**, not just `.py` — that is what `package-data` /
  `MANIFEST.in` guarantee. The plugin ships with an empty `manifest.json` stub and no floor
  PNGs; an operator supplies them (build in the tool, copy into `static/`).
- **Static is namespaced** under `static/netbox_facilitymap/` so `collectstatic` can't
  collide with another app; templates likewise under `templates/netbox_facilitymap/`.
- **Versioning = git tags.** Tag releases `v1.1.0`, etc., so installs can pin to a tag. Keep
  `version` in `pyproject.toml` and `PluginConfig.version` in lockstep; bump on every
  release and note it in `CHANGELOG.md`.
- **Compatibility gate.** `min_version`/`max_version` in `PluginConfig` are enforced by
  NetBox at load — they are pinned to the tested range because NetBox plugin APIs
  (`PluginConfig`, menu, `restrict()`, template extensions) shift between 4.x minors.

---

## 7. preprocess / images pipeline & data import

- **`preprocess.py` stays external/offline.** It is the standalone tool's render engine
  (the tool's in-app import uploads PDFs and renders them via a `preprocess.py` subprocess);
  it never contacts NetBox — the wrong thing to run in-process. The plugin ships with **no
  facility content**: `manifest.json` is an empty stub and `images/` is absent. To populate
  the plugin, import drawings in the tool, then copy `tool/manifest.json` + `tool/images/`
  into `static/netbox_facilitymap/` and run `collectstatic`.
- `manifest.json` stays a **read-only served static file** — not modelled. It encodes the
  load-bearing conventions (`dir == Site slug`, `floorSlug == Location slug`, image
  filenames) that the import command and the `Room` FKs must honour.
- **Data import** — a management command moves existing tool data into the DB:
  ```
  python manage.py facilitymap_import --src /path/to/tool
  #   annotations.json     -> rooms (Room rows) + blob (image/w/h/arrows)
  #   siteplan.json        -> row  (kind='siteplan',   key='')
  #   rackplacements.json  -> rows (kind='placements', key=<floorKey>)
  #   pagelayouts.json     -> rows (kind='layouts',    key=<floorKey>)
  ```
  Round-trip is trivial (`json.load` → split top-level keys; inverse to re-export), so
  annotations move between the standalone tool and the plugin freely. Annotations embed
  absolute `location.url`s — harmless inside the same NetBox; the command may optionally
  re-resolve `location.id` against the current host, or trust ids.

---

## 8. Delivery phases

The plugin shipped in six independently-installable, tagged phases (Phase 0 skeleton →
Phase 5 Room UI + REST). The blow-by-blow — what each version added and its git tag — lives
in **`CHANGELOG.md`** (versions `0.1.0` → `1.1.0`); it is not duplicated here.

### Frontend adaptation (the ~20 URL literals)

The framework-free frontend is reused verbatim except for its root-absolute URL literals,
rewritten to honour the `/plugins/facilitymap/` mount:

1. Inject one global in `index.html`, before the scripts:
   ```django
   <script>window.MAP = {
     api:    "{% url 'plugins:netbox_facilitymap:map' %}api/",
     static: "{% static 'netbox_facilitymap/' %}",
     csrf:   "{{ csrf_token }}" };</script>
   ```
2. Thread it through `Api` (`lib.js`, the single fetch chokepoint): `Api.get/post` prepend
   `window.MAP.api` for `/api/*` paths.
3. The image concatenations (`app.js`, `floor-editor.js`, `siteplan-editor.js`):
   `'/' + img` → `window.MAP.static + img`.
4. `index.html` asset tags → `{% static 'netbox_facilitymap/lib.js' %}` etc.
5. Fonts: `@font-face url('/web/fonts/...')` in `style.css` → CSS-relative
   `url('fonts/...')` (resolves beside the stylesheet at any mount).
6. `manifest` (`store.js`): `/manifest.json` → `window.MAP.static + 'manifest.json'`.
7. **CSRF (highest-likelihood gotcha):** add `'X-CSRFToken': window.MAP.csrf` to the POST
   headers in `Api.post`, or every save 403s under NetBox session auth.

Hash routing (`app.js router()`) is already prefix-agnostic — no change.

---

## 9. Risks

1. **CSRF on session POST** — silent 403s if the token header isn't threaded into
   `Api.post`. Highest-likelihood gotcha (§8).
2. **`collectstatic` + large PNG set** — 30+ building dirs of PNGs bloat the static tree;
   works, but may need a served-data fallback view if size hurts.
3. **Live-query UX** — dropping `rackcache` removed the offline snapshot and adds slight
   per-panel latency. Acceptable, but a behaviour change from the standalone tool.
4. **NetBox version drift** — `restrict()` / `PluginConfig` / menu / template-extension APIs
   shift between 4.x minors; pin `min/max_version` and test against the exact prod minor.
5. **Object perms** — the remaining blobs (siteplan/placements/layouts) are still
   all-or-nothing. Rooms, now a `NetBoxModel`, are read through `Room.objects.restrict()`, so
   they honour any object-permission constraints an admin defines — including constraints
   keyed to the `location` FK, which the blob could never express. (Promotion makes rooms
   *scopable*; it does not auto-inherit the Location's own permissions.)
6. **Slug/filename coupling** — `dir == Site slug`, `floorId == Location slug`, and image
   filenames are load-bearing; `preprocess.py` stays the external source of truth, so drift
   between the image build and NetBox slugs silently breaks room→Location binding.

---

## 10. Verification

- **Install:** `pip install` succeeds in the NetBox venv; the plugin appears under
  **Plugins**; both nav items render; `/plugins/facilitymap/` returns the map without 500s;
  `min_version`/`max_version` accepted.
- **Map:** load a floor inside NetBox — images, fonts, CSS, and `manifest.json` all resolve
  under the `/plugins/facilitymap/` mount (no 404s in devtools); pan/zoom + view-mode room
  clicks work; compare side-by-side with the standalone tool.
- **Editing:** draw + save a room (no CSRF 403); run `facilitymap_import` against the
  existing `tool/` JSON and confirm pre-existing annotations render unchanged; round-trip
  export matches the original JSON.
- **ORM reads:** rooms/locations/racks/devices panels populate from the ORM; verify
  `.restrict()` hides objects from a user lacking permission.
- **Room model:** `makemigrations netbox_facilitymap` reports **no changes** (no schema
  delta); room polygons render on a NetBox Location page; backfilled `Room` rows FK to the
  correct Locations; `GET /api/plugins/facilitymap/rooms/` lists rooms and
  `?floor_key=`/`?datacenter=`/`?location_id=` filter; the **Rooms** nav item opens a
  filterable list, a row opens the native detail view, edit/bulk/delete work; global search
  finds a room by label; a user lacking `view_room` sees neither the list rows nor the REST
  results; and a native field edit survives until the map editor next saves that floor
  (last-writer-wins).
