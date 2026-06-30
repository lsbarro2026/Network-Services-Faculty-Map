# NetBox Plugin — Design & Packaging

How `netbox-facilitymap` repackages the standalone facility-map tool
(`../tool/`) as an **installable NetBox 4.x plugin** — the storage decision, the
package layout, the packaging mechanics, and the import/build pipeline.

This is the deep design reference. For **install/operate** steps see `README.md`;
for the **release history** see `CHANGELOG.md`. (The standalone tool that this plugin grew
out of was retired at `1.2.0`; its sources and docs no longer exist in the repo.)

> Status: **built** in this directory — all phases (skeleton → read-only map →
> editing/save → ORM racks/devices + auth hardening → relational `Room` +
> NetBox-native render → full Room UI + REST → **in-app PDF import**) are implemented and
> were first shipped as `1.2.0` (current: `1.5.0`). As of `1.2.0` the plugin is **self-contained**: the standalone tool's
> PDF-import pipeline was folded in (§7) and the tool retired, so this directory is the
> whole project. References to `../tool/` below are historical (where the code came from).

---

## 0. As-built notes (where the build refined the original plan)

Two deliberate refinements are worth recording:

1. **The browser-facing JSON endpoints are plain Django views under the *page* mount,
   not a DRF router.** `frontend_api.py`'s views (`AnnotationsView`, `BlobView`, `NbRoomsView`,
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
(`template_content.FloorRooms`) draws room geometry on a `dcim.Location` page: on a **room**
Location (one bound via `Room.location`) it shows that single room **cropped to its polygon**;
on a **floor** Location it embeds the whole floor plan — tiling every drawing sheet of a
multi-sheet floor server-side (`previews.floor_sheets`, mirroring the editor's `Store.floorLayout`)
— overlaid with the floor's rooms, and it renders even before any rooms are drawn. A room has no standalone plugin page —
it is surfaced on its bound Location, so `Room.get_absolute_url()` resolves to that Location
(or the map app when unbound). Both variants also overlay the rack/device **placement markers**
(MVP styled boxes — `previews.placement_markers`; not the JS `DeviceShapes` glyphs), built
server-side from the `placements` blob and permission-scoped to the visible room(s).
A second extension (`template_content.SiteFloors`) embeds a **floor picker** on the `dcim.Site`
page (here a Site = one building): a grid of floor cards mirroring the SPA's building view,
read fresh from the manifest, each card linking to that floor's NetBox Location page.
The map also surfaces on the **home dashboard**: `dashboard.FacilityMapWidget` is a draggable
widget that `<iframe>`s the SPA. Unlike the template extensions, a dashboard widget isn't
auto-discovered, so `FacilityMapConfig.ready()` imports `dashboard` to register it. The iframe is
same-origin and so inherits the user's session — no second rendering path, and the SPA's own
ORM-backed auth and authenticated media carry over. A `?embed=1` mode (an `embed` context flag in
`MapView`, read by `index.html`) hides the SPA chrome so the map fills the card; the widget's
config sets height, the hide-chrome toggle, and an optional deep-link hash.
`Room` also carries a NetBox-native **DRF REST API** (`api/`, registered at `rooms`), with **no
schema change** beyond the `0002_room` table. (The standalone Room browse UI — list/detail/edit/
bulk, table, forms, global-search index, and the **Rooms** nav item — was removed in `1.18.0`
as redundant: rooms are already browsable as Locations and each Location page renders the
preview.) The map editor's `sync_rooms`
POST stays authoritative for room **geometry**, so a natively created/edited room is durable
only until the editor next saves that floor (last-writer-wins; native edit is most useful for
`label`/`location`/`tags`). The remaining blobs (siteplan/placements/layouts) are
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
    __init__.py                          # FacilityMapConfig(PluginConfig) + render guardrails (§4)
    navigation.py                        # Facility Map nav item
    urls.py                              # page mount + api/ JSON + import/media routes
    views.py                             # MapView (TemplateView)
    frontend_api.py                      # AnnotationsView (compose/decompose) + blob CRUD + ORM reads
                                         # (page-mount views; named to not shadow the api/ REST package)
    imports.py                           # PDF import endpoints + authenticated manifest/media serving (§7)
    preprocess.py                        # PDF render engine, run as an isolated subprocess (§7)
    storage.py                           # work_dir()/safe_path()/media_url() (MEDIA_ROOT working dir)
    models.py                            # FacilityMapBlob; Room(NetBoxModel) FK → dcim.Location
    filtersets.py                        # RoomFilterSet (used by the DRF REST API)
    template_content.py                  # FloorRooms (room panel on the Location page) + SiteFloors (floor picker on the Site page)
    dashboard.py                         # FacilityMapWidget: home-dashboard widget that iframes the SPA
    previews.py                          # room/Location preview helpers (placement markers + room-crop viewBox)
    api/                                 # DRF REST API for Room
      serializers.py  views.py  urls.py  # RoomSerializer + RoomViewSet + NetBoxRouter
    management/
      commands/
        facilitymap_import.py            # import a legacy JSON export into the DB (§7)
    migrations/                          # 0001_initial, 0002_room, 0003_backfill_rooms
    templates/netbox_facilitymap/
      index.html                         # injects window.MAP (api/media/static/csrf)
      floor_rooms.html                   # the Location-page room overlay
      inc/placement_markers.html         # rack/device marker boxes (included by floor_rooms.html)
    static/netbox_facilitymap/           # framework-free frontend only (no facility data)
      lib.js device-shapes.js netbox.js store.js grid.js panzoom.js
      editor.js floor-editor.js siteplan-editor.js import-wizard.js app.js
      style.css
      fonts/                             # bundled WOFF2 (Public Sans + IBM Plex Mono)

  # facility data is NOT packaged — it is rendered at runtime into the working dir:
  <MEDIA_ROOT>/netbox_facilitymap/       # writable; see storage.work_dir() (§7)
    uploads/<folder>/*.pdf  uploads/.thumbs/...   # uploaded PDFs + wizard thumbnails
    images/<slug>/<floor>.png            # rendered floor/siteplan images
    manifest.json  import-map.json       # rendered manifest + the wizard's floor mapping
```

The frontend JS/CSS/fonts moved from `tool/web/` (only ~20 URL literals changed), now
**including `import-wizard.js`** — the PDF import runs in-plugin (§7). The plugin ships with
**no facility content**: `manifest.json` + `images/` are produced at runtime under
`MEDIA_ROOT` (not packaged static assets), and `api/manifest` serves an empty stub until the
first import.

**Reused vs. replaced (origin: the retired `tool/`):**

| Origin (`tool/`) | Fate in plugin |
|---|---|
| `web/*.js`, `style.css`, `fonts/` | Reused; only ~20 URL literals change → `static/netbox_facilitymap/`. |
| `web/index.html` | Becomes `templates/netbox_facilitymap/index.html` (config injection + `{% static %}`). |
| `web/import-wizard.js` | **Vendored** → `static/`; its `/api/import/*` + `/uploads/*` URLs rebased onto `window.MAP`. |
| `server.py` `JsonStore` (the JSON files) | Replaced by `FacilityMapBlob` model + CRUD views; room polygons further promoted to `Room`. |
| `server.py` `NetBoxProxy` | Replaced by ORM-backed views; deleted. |
| `server.py` `Config`/`ToolServer`/`Handler` | Deleted — NetBox provides server, routing, auth. |
| `server.py` `_trim`/`_trim_rack`/`_trim_device` | Reused as shaping functions (keep the 4.x `role` / 3.x `device_role` fallback). |
| `server.py` `/api/import/*` + static serving | Reimplemented in `imports.py` — permission-gated, validated, authenticated media (§7). |
| `rackcache.json` + `/api/netbox/sync-room` | Dropped — racks/devices queried live via ORM. |
| `preprocess.py` | **Vendored** as `netbox_facilitymap/preprocess.py`; run as an isolated subprocess (§7). |
| `manifest.json` + `images/` | Format preserved; now **rendered at runtime** under `MEDIA_ROOT`, served authenticated. |

---

## 4. Plugin registration

`netbox_facilitymap/__init__.py`:
```python
from netbox.plugins import PluginConfig

class FacilityMapConfig(PluginConfig):
    name = 'netbox_facilitymap'
    verbose_name = 'Facility Map'
    description = 'Navigable siteplan → building → floor → room map linked to Locations'
    version = '1.9.0'              # keep in lockstep with pyproject.toml; see CHANGELOG
    author = 'Facility Map'
    base_url = 'facilitymap'
    min_version = '4.1.7'     # pinned to the tested range; NetBox enforces at load
    max_version = '4.6.0'
    default_settings = {      # import/render guardrails (overridable in PLUGINS_CONFIG, §7)
        'work_dir': None, 'max_pdf_mb': 50, 'max_pdfs': 400,
        'max_zip_mb': 200, 'max_zip_uncompressed_mb': 2048,   # .zip upload caps
        'render_timeout_s': 300, 'render_mem_mb': 4096,
    }

config = FacilityMapConfig
```

- **Navigation** (`navigation.py`): a single **Facility Map** `PluginMenuItem` to the
  full-page map.
- **Full-page view** (`views.py`): `MapView(LoginRequiredMixin, TemplateView)` rendering
  `netbox_facilitymap/index.html`; `urls.py`: `path('', MapView.as_view(), name='map')`.
  The app is a full-bleed SVG canvas, so it uses a **minimal standalone template** (it does
  *not* `{% extends 'base/layout.html' %}`) served inside the authenticated mount. The
  relational `Room` model is exposed through the DRF REST API (`api/`); it has no standalone
  browse UI (removed in `1.18.0` — rooms are reached via their bound Location).

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
  normalized 0..1), and `location` FK → `dcim.Location`, backfilled from the
  annotations blob by migration `0003_backfill_rooms` (reversible). `Room` is the source of
  truth; `AnnotationsView` composes/decomposes so the blob keeps only
  `image`/`w`/`h`/`arrows`. Hotspots / placements / layouts / arrows stay blobs
  (editor-internal, low query value).
- **REST API surface, no schema change** — `Room` carries a DRF REST API (`api/` subpackage,
  with `RoomFilterSet`), object-permission scoped, reusing the `0002_room` table. (The
  standalone browse UI — list/detail/edit/bulk, table, forms, `RoomIndex` global search, and
  the **Rooms** nav item — was removed in `1.18.0` as redundant with the native Location
  pages.) The map editor remains authoritative for room geometry (`sync_rooms`), so REST edits
  beyond `label`/`location`/`tags` are overwritten on the editor's next save of that floor
  (last-writer-wins).

---

## 6. Packaging mechanics (for `pip install`)

`pyproject.toml` (setuptools backend; hatchling works equally):
```toml
[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "netbox-facilitymap"
version = "1.5.0"
description = "Facility map plugin for NetBox"
requires-python = ">=3.10"
dependencies = ["pypdfium2", "Pillow"]   # PDF render engine; Django/DRF from NetBox
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
- **Runtime deps are `pypdfium2` + `Pillow`** (the PDF render engine, §7). NetBox supplies
  Django/DRF. `pypdfium2` bundles PDFium as a self-contained wheel (no system
  Ghostscript/poppler), so a plain `pip install` works on any environment, headless servers
  included. The native renderer loads only in its **subprocess** (`preprocess.py`), never the
  NetBox worker, so the native-code surface stays out of the long-lived process.
- **Ship the static + template files**, not just `.py` — that is what `package-data` /
  `MANIFEST.in` guarantee. The plugin ships with **no facility content**: floor images +
  `manifest.json` are rendered at runtime under `MEDIA_ROOT` (§7), not packaged.
- **Static is namespaced** under `static/netbox_facilitymap/` so `collectstatic` can't
  collide with another app; templates likewise under `templates/netbox_facilitymap/`.
- **Versioning = git tags.** Tag releases `v1.1.0`, etc., so installs can pin to a tag. Keep
  `version` in `pyproject.toml` and `PluginConfig.version` in lockstep; bump on every
  release and note it in `CHANGELOG.md`.
- **Compatibility gate.** `min_version`/`max_version` in `PluginConfig` are enforced by
  NetBox at load — they are pinned to the tested range because NetBox plugin APIs
  (`PluginConfig`, menu, `restrict()`, template extensions) shift between 4.x minors.

---

## 7. In-app PDF import pipeline (`imports.py` + `preprocess.py` + `storage.py`)

As of `1.2.0` the plugin imports a facility from PDFs itself. The standalone tool kept PDF
rendering out of NetBox for two reasons — no render endpoint, and avoiding the parser's
attack surface in-process. Folding it in keeps the second concern by **isolating the
renderer in a subprocess**; the first is solved by the new endpoints.

**Working directory.** Uploads + rendered output need a writable location (the package's
`static/` tree is read-only at runtime), so `storage.work_dir()` resolves
`<MEDIA_ROOT>/netbox_facilitymap/` (overridable via the `work_dir` plugin setting). It holds
`uploads/` (PDFs + `.thumbs/`), `images/`, `manifest.json`, and `import-map.json` — the
exact layout `preprocess.py` already expects. `storage.safe_path()` is the shared traversal
guard; `storage.media_url()` reverses the authenticated `api-media` route for server-rendered
pages.

**Endpoints** (`imports.py`, under the page mount). All import endpoints require the
`netbox_facilitymap.change_facilitymapblob` permission (`PermissionRequiredMixin`), not just
a login — importing rewrites the whole map and `reset` wipes it:
- `POST api/import/upload?path=<folder>/<file>` — multipart (`file`), streamed to disk;
  validates `%PDF-` magic bytes, a `max_pdf_mb` cap, and a traversal-guarded path under
  `uploads/`. The wizard derives `<folder>` from each PDF's position: floor PDFs keep their
  building subfolder, while a PDF sitting **loose at the top level** of the dropped facility
  folder is the overall site map and is folded into the reserved `Site Plan` folder (so the
  existing siteplan auto-detect/build path handles it). Naming a folder `Site Plan` still
  works; the loose-PDF route is recognized by **position, not filename**.
- `POST api/import/upload-zip` — multipart `.zip`; the server extracts it into the same
  `uploads/<folder>/<file>` layout (`_zip_targets` mirrors the upload `_split`, stripping a
  shared wrapper directory the archive usually carries). Extraction runs in the worker — it
  only writes bytes and re-checks `%PDF-` magic, so it does **not** breach the "untrusted PDFs
  parsed only in the subprocess" rule — and is hardened against zip bombs / traversal: `.zip`
  magic + `max_zip_mb`, streamed per-member `max_pdf_mb` and cumulative
  `max_zip_uncompressed_mb` caps (never trusting `ZipInfo.file_size`), a `max_pdfs` member
  cap, refusal of symlink/special members, and per-member `safe_path` confinement.
- `POST api/import/scan` / `POST api/import/build` — run `preprocess.py scan|build` (build
  first persists the posted import-map and enforces `max_pdfs`).
- `GET api/import/preview?path=<uploads-rel.pdf>` — render **one** uploaded PDF at full scale
  on demand (`preprocess.py preview`) and stream the PNG, cached at `uploads/.thumbs/<…>.full.png`.
  This backs the wizard's high-res preview (popup + enlarged/zoomed cards): the small `scan`
  thumbnails stay cheap, and the crisp render is produced lazily only where it's actually
  viewed. Same `EDIT_PERM` + subprocess isolation + `safe_path` confinement as the others, but
  it renders a single file to a distinct cache path **without the import lock**, so a preview
  never 409s against an in-flight scan (a racing `reset` just 404s). The `.full.png` cache sits
  under `.thumbs`, which `scan` skips and `reset` wipes — no extra cleanup.
- `POST api/import/reset` — clear the working dir.
- `GET api/manifest` (login) — serve the rendered manifest, or the empty stub.
- `GET api/media/<path>` (login) — stream a rendered image / thumbnail / uploaded PDF from
  the working dir; traversal-guarded and confined to `images/`/`uploads/`. Floor plans are
  **not** exposed at a public static URL.

**Renderer isolation + limits.** `_run_script(script, mode, …, mem_mb, timeout_s)` spawns
`python <script> <mode> --base <workdir>` **by file path** (not `-m`, so the package's
NetBox-importing `__init__` never loads into the child), with `timeout=render_timeout_s` and
a POSIX `preexec_fn` setting `RLIMIT_CPU` + `RLIMIT_AS`. The render child
(`preprocess.py`, `_run_preprocess`) stays stdlib + `pypdfium2`/`Pillow` only and only
rasterizes page 1 — no PDF text/JS/embedded content is executed — and is held to
`render_mem_mb` (the tight cap that contains a malicious PDF parser) alongside the CPU/timeout
caps. A working-dir lockfile (`_acquire_lock`, with stale-lock recovery) serializes
**scan/build** renders across worker processes, since the tool's thread lock could not; the
single-file `preview` render skips the lock by design.

`manifest.json` encodes the load-bearing conventions (`dir == Site slug`,
`floorSlug == Location slug`, image filenames) that the `Room` FKs must honour; it is served
(authenticated), not modelled.

**Building → NetBox Site binding.** The `dir == Site slug` convention only resolves if a
building's slug actually matches a real `dcim.Site`. The wizard therefore has a dedicated
**"Map buildings to NetBox"** step (between scan and floor-mapping) where the operator binds
each building folder to a Site — auto-matched by name/slug where possible, otherwise picked
via a `api/netbox/sites?q=` search. The chosen Site's slug is written into the building's
`slug`, so it flows verbatim through `import-map.json` → `build_building_from_pdfs` → the
manifest's `siteSlug`. The binding is captured **entirely by the slug** — `preprocess.py`,
the import-map shape, and the manifest are unchanged, keeping the renderer Django-free.

**Post-build editing (re-import without a wipe).** A normal `build` rewrites `import-map.json`
+ `images/` + `manifest.json` but never touches `uploads/`, the draft, or the DB — only `reset`
wipes. So **re-opening the wizard resumes onto the current facility**, and the operator can fix a
binding, **replace** one floorplan in place (a new PDF POSTed to the same `uploads/` path → same
stem → same floor id → rooms survive), or **add** a building/floor (additive upload + re-scan,
with the saved draft re-applied so prior assignments persist), or **add a floor Location** the
auto-detect heuristic missed by searching the bound site's Locations in the floor selector
(reusing the existing `netbox/locations` read; the floor id is still the Location slug). This
reuses the existing `upload`/`upload-zip`/`scan`/`build` endpoints — **no new backend** and no
incremental render (build stays a full rewrite, which is simple and idempotent). The one data-safety hazard is that
re-assigning a drawing's floor or re-binding a building **changes the floor id**, orphaning
`Room` rows keyed to the old `floor_key`. The wizard guards this entirely client-side: before a
build it diffs the about-to-build floor keys against the live manifest's floors-with-rooms and
**warns + confirms**; on confirm it discards the affected rooms via an ordinary `/api/annotations`
save (keys removed), so the delete rides the **authoritative, `restrict(user,'delete')`-scoped
`sync_rooms`** path — the data-safety posture (§5) is unchanged, no new delete endpoint exists.

**Legacy data import.** The `facilitymap_import` management command still moves a JSON export
into the DB (for migrating an older deployment), unchanged:
```
python manage.py facilitymap_import --src /path/to/dir
#   annotations.json     -> rooms (Room rows) + blob (image/w/h/arrows)
#   siteplan.json        -> row  (kind='siteplan',   key='')
#   rackplacements.json  -> rows (kind='placements', key='')
#   pagelayouts.json     -> rows (kind='layouts',    key='')
```
Round-trip is trivial (`json.load` → split top-level keys; inverse to re-export). New
facilities use the in-app wizard instead.

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
2. **Untrusted PDF parsing** — uploads are rasterized server-side. Mitigated by isolating
   the parser in a short-lived, resource-limited **subprocess** (never the NetBox worker),
   `%PDF-` + size/count validation, permission-gating, and `pypdfium2` (hardened PDFium,
   no system Ghostscript/poppler). Residual risk is a PDFium CVE inside the sandboxed child;
   keep `pypdfium2` patched. Large facilities also produce many PNGs under `MEDIA_ROOT` —
   served on-demand by `MediaView`, so no `collectstatic` bloat, but watch disk.
   `.zip` uploads are unpacked in the worker (only PDF *rendering* stays in the subprocess);
   the zip-bomb / traversal surface that adds is bounded by streamed size caps
   (`max_zip_mb`, `max_zip_uncompressed_mb`, per-member `max_pdf_mb`, `max_pdfs`) and
   symlink-member refusal in `UploadZipView`.
3. **Live-query UX** — dropping `rackcache` removed the offline snapshot and adds slight
   per-panel latency. Acceptable, but a behaviour change from the standalone tool.
4. **NetBox version drift** — `restrict()` / `PluginConfig` / menu / template-extension APIs
   shift between 4.x minors; pin `min/max_version` and test against the exact prod minor.
5. **Object perms** — blob **writes** (annotations/siteplan/placements/layouts) and all
   import endpoints now require the `change_facilitymapblob` permission, and `sync_rooms`
   scopes deletes via `restrict(user, 'delete')`; blob *reads* remain all-or-nothing per
   login. Rooms, now a `NetBoxModel`, are read through `Room.objects.restrict()`, so
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
  `?floor_key=`/`?location_id=` filter; the **Rooms** nav item opens a
  filterable list, a row opens the native detail view, edit/bulk/delete work; global search
  finds a room by label; a user lacking `view_room` sees neither the list rows nor the REST
  results; and a native field edit survives until the map editor next saves that floor
  (last-writer-wins).
