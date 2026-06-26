# Changelog

All notable changes to `netbox-facilitymap`. Versions are git tags; keep
`pyproject.toml` `version` and `PluginConfig.version` in lockstep.

## Unreleased
- **Ships with no facility content.** Removed the bundled demo floor images and replaced
  `static/netbox_facilitymap/manifest.json` with an empty stub
  (`{"siteplan":null,"buildings":[]}`); an operator now supplies `manifest.json` + `images/`
  by building them in the standalone tool and copying them in (see README *Build artifacts*).
- De-branded the plugin to be facility-agnostic (`verbose_name` → "Facility Map"; generic
  descriptions; `GRID_STEP_PREFIX` → `facilitymap:`). `import-wizard.js` from the tool is
  intentionally **not** vendored (PDF import is tool-only). (Bump the version on release.)

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
