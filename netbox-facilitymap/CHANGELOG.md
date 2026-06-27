# Changelog

All notable changes to `netbox-facilitymap`. Versions are git tags; keep
`pyproject.toml` `version` and `PluginConfig.version` in lockstep.

## 1.3.2 — Sharp import previews; cursor-anchored zoom/pan
- **Import.** The map step's thumbnails/preview no longer blur when enlarged or zoomed,
  version → `1.3.2`:
  - **On-demand high-res render.** A new `preview` mode in `preprocess.py` renders one named
    PDF at full `RENDER_SCALE` (the same fidelity as the built floor images), served by
    `PreviewView` (`api/import/preview`) and cached under `uploads/.thumbs/<…>.full.png`.
    Same isolation/permission posture as the other render endpoints (isolated subprocess,
    `change_facilitymapblob`-gated, traversal-guarded), but it renders a single file without
    the import lock, so opening a preview never blocks/409s against an in-flight scan.
  - **Crisp where it matters.** The `scan` thumbnails stay small and fast; the frontend swaps
    in the hi-res render lazily — when a card is wheel-zoomed (`onZoom`) or the size slider
    passes `HIRES_AT`, and always in the preview popup. So enlarging or zooming now reveals
    real detail instead of upscaling a too-small raster (a letter-size sheet's thumbnail is
    ~368px wide; the preview is ~1224px).
  - **Better zoom/pan.** `_framing` became the reusable `_attachZoomPan`, shared by the cards
    and the popup: wheel-zoom is **anchored at the cursor**, panning is **clamped to the
    contained image** (no sliding into the letterbox), and double-click resets. The preview
    popup gained zoom/pan it never had (was `object-fit: contain` only). `_previewUrl` builds
    the render URL; framing remains a client-only viewing aid, never sent to the build.

## 1.3.1 — Fix import preview; resizable thumbnails
- **Import.** Version → `1.3.1`:
  - **Preview fix.** The map-step preview embedded the raw PDF in an `<iframe>`, which went
    blank and instead downloaded the file when the browser is set to download PDFs (or under
    `X-Frame-Options`). `_lightbox` now shows the rendered page **image** (the high-res
    thumbnail PNG), which always renders inline and is sharp enough to read floor labels.
  - **Resizable thumbnails.** A size slider (`_sizer`/`_applyThumbSize`, global `thumbWidth`)
    enlarges every card at once via CSS vars, so labels can be read without opening each
    drawing. Both this and the per-card framing are client-only viewing aids, never sent to the
    build or the manifest.

## 1.3.0 — Smoother facility-import upload flow
- **Import.** The wizard's upload and map steps were streamlined and gained three
  conveniences, version → `1.3.0`:
  - **`.zip` upload.** Alongside the folder picker/drop, you can now pick or drop a single
    `.zip` of the drawings. A new `UploadZipView` (`api/import/upload-zip`, frontend
    `_uploadZip`) extracts it server-side into the same `uploads/<building>/<file>` layout,
    stripping any wrapper folder the archive carries (`_zip_targets`, mirroring `_split`).
    Extraction only writes bytes + checks `%PDF-` magic, so untrusted PDFs are still **parsed**
    only in the render subprocess; it is bounded by new `max_zip_mb` /
    `max_zip_uncompressed_mb` caps plus the existing `max_pdf_mb` / `max_pdfs`, with
    symlink-member refusal and per-member `safe_path` confinement.
  - **In-app preview.** Clicking a drawing card opens a full-window lightbox (`_lightbox`)
    instead of a new browser tab. (Superseded by the 1.3.1 image-based preview.)
  - **Framable thumbnails.** Per-card scroll-to-zoom / drag-to-pan framing (`_framing`,
    per-PDF `frame` state) to frame the floor label — a client-only viewing aid.
  - **Less chrome.** Trimmed the instructional prose on both steps.

## 1.2.2 — Recognize a loose top-level PDF as the site map on import
- **Import.** The import wizard now seeds the overall siteplan from a PDF dropped **loose at
  the top level** of the facility folder (any filename), not only from a sub-folder named like
  *site plan*. `import-wizard.js` `_split` routes a two-segment `<root>/<file>.pdf` path into
  the reserved `Site Plan` folder, reusing the existing siteplan auto-detect/build path. The
  signal is **position, not filename** (so a map named e.g. `2600 - Drawing List Plan.pdf` is
  picked up); it fires only when the drop also has subfoldered drawings, so a single flat
  building folder isn't mistaken for a siteplan. Frontend-only; no backend, schema, or
  security change. Version → `1.2.2`.

## 1.2.1 — Fix URLconf import crash (api module/package collision)
- **Bugfix.** The page-mount browser endpoints module `api.py` collided with the `api/` DRF
  REST package: Python resolves a package over a same-named module, so `from . import api` in
  `urls.py` imported the empty `api/__init__.py` and every `api.*View` reference raised
  `AttributeError` (first surfaced as `module 'netbox_facilitymap.api' has no attribute
  'AnnotationsView'`), crashing URLconf import so `urlpatterns` was never defined and
  `manage.py migrate` failed. Renamed `api.py` → `frontend_api.py` (the `api/` package name is
  fixed by NetBox REST auto-discovery) and updated its two importers (`urls.py`, the
  `facilitymap_import` command). No schema change; no behaviour change. Version → `1.2.1`.

## 1.2.0 — In-app PDF import; one self-contained plugin
The standalone tool is retired: its PDF-import pipeline moves into the plugin, so the plugin
now imports a facility from PDFs in-app with no external build step. (Supersedes the prior
unreleased "ships empty / copy from the tool / import-wizard is tool-only" notes.)
- **In-app import.** Vendored `import-wizard.js`; new `imports.py` adds the
  `api/import/upload|scan|build|reset` endpoints plus authenticated `api/manifest` and
  `api/media/<path>` serving. `app.js` routes `#/import` and defaults an empty install to the
  wizard; a **Settings → Import a facility from PDFs** button was added. `preprocess.py` (the
  render engine) and `storage.py` (working-dir helpers) are new package modules.
- **Render engine.** `preprocess.py` is invoked as an isolated **subprocess** (by file path,
  so Django is never imported into the child) with a timeout + POSIX rlimits; it reads/writes
  a working dir under `MEDIA_ROOT` (`work_dir` setting). Runtime deps `pypdfium2` + `Pillow`
  are now declared in `pyproject.toml`.
- **Storage/serving.** `manifest.json` + `images/` move from the public static tree to the
  authenticated working dir; the frontend resolves them via `window.MAP.media`/`api`.
  `template_content.py` and `views.py` build image URLs through the new `media_url()` route.
- **Security hardening.** Import endpoints and all map **writes** now require the
  `netbox_facilitymap.change_facilitymapblob` permission (was login-only):
  `BlobView.post`/`AnnotationsView.post` are gated, and `sync_rooms(rooms_by_floor, user)`
  scopes deletes via `restrict(user, 'delete')`. Uploads enforce `%PDF-` magic bytes, a size
  cap, a PDF-count cap, and a traversal-guarded path; a working-dir lockfile serializes
  concurrent renders. New `default_settings`: `work_dir`, `max_pdf_mb`, `max_pdfs`,
  `render_timeout_s`, `render_mem_mb`.
- No schema change (no new migration; `makemigrations` reports nothing). Version → `1.2.0`.

## 1.1.0 — Phase 5: Room UI + REST
- `Room` becomes a full NetBox-native model surface (no schema change — the existing
  `0002_room` table is unchanged):
  - **REST API** under `/api/plugins/facilitymap/rooms/` — new `api/` subpackage
    (`RoomSerializer` + `RoomViewSet(NetBoxModelViewSet)` + `NetBoxRouter`), filterable by
    `floor_key` / `datacenter` / `location_id`, object-permission scoped.
  - **UI** — list (filtered/searchable) + detail + edit + delete + bulk edit/delete via
    `netbox.views.generic`, a `RoomTable`, `RoomForm`/`RoomFilterForm`/`RoomBulkEditForm`,
    and a `RoomFilterSet` (shared with REST). A **Rooms** nav item is added.
  - **Search** — `RoomIndex` registers `Room` in global search.
  - `Room.get_absolute_url()` now points at the native detail view (was a fallback to the
    bound Location); a custom `room.html` shows the attributes + a polygon-over-floor preview.
- `polygon` stays editor-owned: the map editor's `sync_rooms` POST remains authoritative for
  geometry, so native create/edit of a room is durable only until the editor next saves that
  floor (last-writer-wins; native edit is best for `label`/`location`/`datacenter`/`tags`).
- Version bumped to `1.1.0`. No new migration (confirm `makemigrations` reports no changes).

## 1.0.0 — Phase 4: relational `Room` + NetBox-native render
- New `Room(NetBoxModel)` (`floor_key`, `room_id`, `label`, `polygon`, `datacenter`,
  `location` FK → `dcim.Location`). Migration `0002_room` creates it; `0003_backfill_rooms`
  backfills from the `annotations` blob and strips the promoted `rooms` out of it
  (reversible — `migrate netbox_facilitymap zero` re-injects them).
- `Room` is the **source of truth** for room geometry. `AnnotationsView` replaces
  `BlobView` for `annotations`: GET composes the whole-document shape (blob floors +
  `Room` rows), POST decomposes it (`sync_rooms` upserts/deletes rows, the rest → the
  blob). The framework-free frontend and JSON export round-trip unchanged; the
  `annotations` blob now holds only each floor's `image`/`w`/`h`/`arrows`.
- `template_content.FloorRooms` (a `PluginTemplateExtension`) draws the room polygons on a
  floor's `dcim.Location` page, each linking to its bound room Location;
  `Room.objects.restrict()` scopes them by object permission. (Multi-sheet floors show
  sheet 1 only — a noted minimal-scope limitation.)
- `facilitymap_import` now decomposes `annotations.json` into `Room` rows + the room-less
  blob (other files unchanged).
- Supported NetBox range pinned to `4.1.7`–`4.6.0`; version bumped to `1.0.0`.

## 0.4.0 — Phase 3: ORM racks + auth hardening
- ORM-backed `netbox/racks` and `netbox/devices` reads (`NbRacksView` / `NbDevicesView`,
  scoped via `.restrict()`), replacing the last proxy-shaped reads — racks mode is
  object-permission-aware (a user who can't view a Rack/Device doesn't see it).
- Removed the persisted `rackcache`: the `RackCacheView` stub + `/api/rackcache` route
  and the `sync-room` client method are gone. The frontend fetches racks/devices live
  per room (`Store.ensureRacks`) into an in-memory cache, refreshed by the Refresh racks
  button. The token-holding proxy model is fully retired.

## 0.3.0 — Phase 2: editing works
- `FacilityMapBlob` model + initial migration; blob GET/POST upsert views for
  annotations / siteplan / placements / layouts.
- CSRF token threaded into `Api.post` (`X-CSRFToken`) so saves don't 403 under session auth.
- ORM-backed `netbox/rooms` and `netbox/locations` reads (replace the proxy) for
  room→Location binding, permission-scoped via `.restrict()`.
- `facilitymap_import` management command (loads the standalone tool's JSON into rows).

## 0.2.0 — Phase 1: read-only map inside NetBox
- Frontend (JS/CSS/fonts) + `manifest.json` + `images/` shipped as namespaced static.
- `index.html` templatized with the `window.MAP` config global; `Api` rebases `/api/*`
  onto the plugin mount; manifest/image/font paths made mount-relative.
- Blob GET endpoints (+ `rackcache` stub) so the boot loads cleanly.

## 0.1.0 — Phase 0: skeleton boots
- `PluginConfig`, nav item, full-bleed `MapView`, package metadata
  (`pyproject.toml` / `MANIFEST.in`).
