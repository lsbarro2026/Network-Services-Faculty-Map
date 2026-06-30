# Changelog

All notable changes to `netbox-facilitymap`. Versions are git tags; keep
`pyproject.toml` `version` and `PluginConfig.version` in lockstep.

## 1.23.2 — Fix stray `{# … #}` comment text rendering in templates
- **Multi-line `{# … #}` comments no longer render as visible text.** Django's `{# … #}` comment
  syntax is **single-line only** — a comment spanning two or more lines isn't recognized and is
  emitted verbatim. Two such comments leaked their text onto the page:
  - `floor_rooms.html` showed `{# Title links into the facility map tool… #}` above the embedded
    room map on a floor's `dcim.Location` page.
  - `index.html` (the `{% if embed %}` head block) emitted its hide-chrome note into the
    dashboard-widget iframe.
- **Both are now `{% comment %}…{% endcomment %}` blocks**, which is multi-line-safe. Single-line
  `{# … #}` comments elsewhere are unaffected.

## 1.23.1 — Fix phantom "Roof /" / "Ground /" prefix on floor-card labels
- **Floor cards no longer get a spurious "Roof / " (or "Ground / ") prefix.** A floor mapped to
  a NetBox Location (the wizard's Location mode) uses that Location's **slug** as its floor
  token. `floor_label()` expanded a token by scanning it for loose single `g`/`r` letters, so a
  slug like `triumf-b2` matched the `r` in "t**r**iumf" and rendered as "Roof / Basement 2".
- **The compact-code parse is now anchored to the whole token.** Only a token that is *entirely*
  a well-formed compact floor code (`b3`, `g`, `l1`, `r`, or a `gl1` compound) is expanded
  segment-by-segment; everything else — notably a Location slug — is title-cased as-is
  (`basement-2` → "Basement 2", `triumf-b2` → "Triumf B2"). Correct compact tokens are
  unchanged.
- **Heads up:** `manifest.json` labels are a build artifact. Existing facilities keep their old
  labels until re-`build`'d (in-app ImportWizard **Build**, or `preprocess.py build`).

## 1.23.0 — Dashboard widget is a clean map preview, with opt-in pan/zoom & building list
- **The Facility Map dashboard widget now shows only the map, fitted to fill the card.** Its
  iframe always loads `?embed=1`: all chrome is hidden (toolbar, breadcrumbs, side panel), the map
  fills the card (`PanZoom.fit` runs on mount + resize), and there is no in-widget navigation —
  clicking a building does nothing (no breadcrumb to return).
- **Two new widget settings, both off by default:** *Allow pan & zoom* (also shows the floating
  zoom controls + enables keyboard zoom) and *Show the building list* (the "All buildings" aside on
  the siteplan). The widget's old hide-chrome toggle is gone; it still takes an iframe **height**
  and an optional **deep-link** hash.
- Pan/zoom is gated in JS (`window.MAP.interactive` → `App`/`Editor`), not CSS — the pan `.catcher`
  sets an inline `pointer-events:all` that defeats a CSS `pointer-events:none`. The chrome/legend
  are hidden by CSS; navigation is gated at `SiteplanEditor.openBuilding`.
- Safe because `?embed=1` is consumed only by this iframe; the Site/Location embeds are
  server-rendered SVG, not iframes of the SPA. Touches the SPA JS, so **re-run `collectstatic`**
  and **restart the NetBox workers** after upgrading.

## 1.22.0 — Embed the facility map as a home-dashboard widget
- **The facility map is now a NetBox dashboard widget.** From the home dashboard's "Add Widget"
  picker, users can drop in a **Facility Map** card (`dashboard.FacilityMapWidget`). It embeds
  the map SPA in an `<iframe>` of the existing map view — same-origin, so it inherits the user's
  session: the SPA's ORM-backed auth and authenticated `media_url` images work with no extra
  plumbing, and there's no second rendering path.
- The widget is configurable: iframe **height**, a **hide map chrome** toggle (default on), and
  an optional **deep-link** hash (e.g. `#/b/<dir>` or `#/f/<dir>/<fid>`; blank opens the
  siteplan). Hiding chrome works via a new `?embed=1` mode on the map view: `MapView` sets an
  `embed` context flag and `index.html` drops `#topbar` when it's set.
- Widgets aren't auto-discovered, so `FacilityMapConfig.ready()` now imports `dashboard` to run
  its `@register_widget`. No `collectstatic` needed (only a template changed); **restart the
  NetBox workers** after upgrading.

## 1.21.0 — Embed a building's floor picker on its NetBox Site page
- **A Site's detail page now embeds a floor picker.** A second `PluginTemplateExtension`
  (`template_content.SiteFloors`, on `dcim.site`) renders a grid of floor cards mirroring the
  SPA's building view — thumbnail, label, a room-count badge and a sheet-count badge — one per
  rendered floor of the building(s) whose manifest `siteSlug` matches the Site's slug. Each card
  links to that floor's NetBox **Location** page (where `FloorRooms` then draws the plan).
- Reads `manifest.json` fresh (best-effort: a missing/unreadable manifest, no matching building,
  or no rendered floor → no panel, never an empty grid). Room counts and the floor-Location
  lookup are `.restrict(...)`-scoped; floor thumbnails are served through the authenticated
  `media_url`. The template (`site_floors.html`) is inline-styled (no plugin CSS on dcim pages).
  No `collectstatic` needed (no static files changed); **restart the NetBox workers** after upgrading.

## 1.20.0 — Link the Location-page map panel's title into the facility map tool
- **The "Facility Map — Rooms" panel title is now a link.** On a floor or room Location page,
  clicking the panel's card-header opens the facility map SPA deep-linked to that floor
  (`#/f/<dir>/<fid>`) in a new tab. `template_content._panel` builds the URL from
  `reverse('…:map')` plus the hash, URL-encoding each segment to match the hash router's
  per-part decode; it degrades to plain text if no floor key resolves.
- The in-SVG room polygons keep their existing cross-links to each room's Location — this is
  an additive title link, not a change to those. A room-focused/zoomed deep-link (extra hash
  segment + live pan/zoom) was scoped out as net-new. No `collectstatic` needed (no static
  files changed); **restart the NetBox workers** after upgrading.

## 1.19.0 — Embed the full (multi-sheet) floor plan on a floor's Location page
- **A floor's NetBox Location page now embeds its whole floor plan.** The `FloorRooms` panel
  (`template_content.py`) previously rendered only when a floor had `Room` rows and drew just
  the first drawing sheet for a multi-sheet floor. It now renders for any floor with a
  rendered plan — **even before any rooms are drawn** — and tiles **every sheet** of a
  multi-sheet floor into the combined canvas, matching what the map editor shows.
- **Server-side sheet tiling.** A new `previews.floor_sheets(floor_key)` mirrors the
  frontend `Store.floorLayout`: it reads the manifest's per-sheet `pages[]` and the `layouts`
  blob's grid (default vertical stack), lays each sheet into a uniform grid cell, and returns
  the combined `w`×`h` that room polygons and rack/device markers are scaled by. Each sheet
  image is served through the authenticated `media_url`. The old "only the first sheet is
  shown" note is gone.
- A non-floor Location (no rendered plan) still shows no panel — `floor_sheets` returns
  `None`, which is the gate. No `collectstatic` needed (no static files changed); **restart
  the NetBox workers** after upgrading.

## 1.18.0 — Remove the redundant standalone Rooms browse UI
- **The plugin's own "Rooms" menu page is gone.** Each `Room` is bound 1:1 to a
  `dcim.Location`, so rooms are already browsable natively as Locations, and since 1.17.0 a
  room's Location page already renders the cropped floor-plan preview + rack/device markers
  (`template_content.FloorRooms`). The plugin's standalone Room list/detail/edit/bulk UI —
  whose detail page just duplicated the Location-page preview — added little, so it was
  removed: the **Rooms** nav item, the `rooms/*` routes, the six Room views, `forms.py`,
  `tables.py`, the `room.html` detail template, and the `search.py` global-search index.
- **Everything load-bearing is unchanged.** The `Room` model, its migrations, `sync_rooms`
  (the map editor stays authoritative for geometry), the DRF REST API (`api/`, still
  registered at `rooms`), `filtersets.RoomFilterSet`, `previews.py`, and the `FloorRooms`
  Location-page panel all stay.
- **`Room.get_absolute_url()` now resolves to the bound Location** (and to the map app for an
  unbound room) instead of the removed detail route, so the REST API's `display_url`, the
  changelog, and admin still resolve. No `collectstatic` needed (no static files changed);
  restart the NetBox workers after upgrading.

## 1.17.0 — Room-fitted preview with rack/device markers
- **A room's NetBox Location page now shows its floor-plan geometry, cropped to the room.**
  The `FloorRooms` panel (`template_content.py`) previously appeared only on a *floor*
  Location (drawing all its rooms); it now also fires on a *room* Location (one bound via
  `Room.location`) and renders just that room — the SVG `viewBox` is set to the room polygon's
  (padded) bounding box, so the page shows that room's region of the plan zoomed in.
- **The previews also draw the room's rack/device placements.** Each placement renders as a
  styled box (rack vs device) at its position/rotation/size with its label — on the room
  Location page (that room's markers), the floor Location panel (all visible rooms' markers),
  and the plugin's own Room detail page. These are an **MVP**: simple boxes rendered
  server-side from the `placements` blob, *not* the schematic `DeviceShapes` glyphs (those
  live only in the JS editor). Markers are permission-scoped to the rooms the user may view.
- The plugin's own **Room** detail page (`RoomView`) gets the same crop + markers.
- New server-side helper module `previews.py` (`placement_markers` + `room_viewbox`), shared
  by `views.RoomView` and `template_content.FloorRooms`; markers render via the shared
  `templates/.../inc/placement_markers.html` partial. No new runtime dependencies; no
  `collectstatic` needed (no static files changed). Multi-sheet floors keep the existing
  sheet-1-only caveat (geometry is over the combined canvas).

## 1.16.0 — Smaller, more coherent device markers
- **Unracked device glyphs are re-sized so none out-sizes a rack.** Several device
  defaults used to be *wider than a whole rack cabinet* — most visibly the **PDU/outlet**
  glyph (`54px` wide, 1.8× the rack). `DeviceShapes.box()` defaults are re-tuned so every
  device footprint reads as smaller than the rack (≤ its 30px width) while keeping each
  type's distinctive proportions (PDU/switch thin strips, UPS a chunky upright, …). The
  glyph drawing math is unchanged — it scales to the new boxes (e.g. a PDU now shows three
  clearly-spaced outlets).
- **Limitation:** markers a user *manually resized* store their own normalized `w/h` and
  keep that size; only markers using the per-type default pick up the new footprints.
- Re-run `collectstatic` to pick up the static change.

## 1.15.0 — Siteplan building labels hidden by default
- **Building-name labels on the siteplan are now hidden by default.** A new **Show/Hide
  labels** toggle in the siteplan toolbar (both view and edit mode) flips every building
  label on or off page-wide (`app.siteLabels`, default off).
- **Per-building opt-in.** Each building area's panel (edit mode) gains a **Show/Hide label**
  button that reveals just that one building's label even when the page-wide toggle is off.
  The flag (`showLabel`) persists with the siteplan and is kept separate from `labelStyle`,
  so "Reset to auto" on the label style never clears it. Label editing
  (move/rotate/resize/text/font/colour) is unchanged — a label being edited always shows.

## 1.14.0 — Racks/devices on any room (datacenter concept removed)
- **The `datacenter` room flag is gone.** It used to gate everything rack-related — only
  datacenter rooms were interactive in racks mode, could hold placements, and pulled NetBox
  inventory. Racks/devices can now be placed in **any** room bound to a NetBox Location;
  inventory loading and marker drawing key off the room's bound Location instead of the flag.
- **View-mode highlight repurposed.** "Highlight: datacenters" is now **"Highlight: rooms
  with devices"** — it highlights rooms that actually hold rack/device markers (a placement in
  a bound room). It stays on by default (`app.highlight` default `'datacenters'` → `'placements'`);
  the CSS accent class `.room.dc` → `.room.placed`.
- **Field fully removed**, including a migration that drops the column
  (`0004_remove_room_datacenter`, irreversible — existing per-room datacenter flags are
  discarded). Stripped from the model, REST serializer/filter, native forms (edit/filter/bulk),
  table, search index, `frontend_api` read+`sync_rooms` write paths, the Location floor panel,
  and the room edit panel's "Datacenter / racks here" checkbox. The Room and Location pages
  now draw every room in green (the blue datacenter fill is gone).
- Migrate (`migrate` drops the column) and reload workers; re-run `collectstatic`.
  Version → `1.14.0`.

## 1.13.0 — Clearer per-building code-region button label
- **"Mark this building's code" → "Set this building's code region".** The per-building button
  in `_buildingSection` that overrides the code-crop region (`building.codeRegion`) had an
  unclear label — it didn't say *what* was being marked. It now reads **"Set this building's
  code region"**, which is accurate whether it's the first region for a building (global pick
  skipped) or an override of the global one. Label + docs only; behaviour unchanged (still
  calls `_stepRegionPick(b)`). Version → `1.13.0`.

## 1.12.0 — Per-building code re-mark reachable without a global region
- **"Mark this building's code" no longer requires a global region first.** The per-building
  code-crop override (`building.codeRegion`) was already supported, but its button in
  `_buildingSection` was gated on a global or per-building region already existing — so a user who
  **skipped** the global region pick (full-drawing thumbnails) had no way to set a region for a
  single outlier building. The button now shows whenever the building has a markable drawing (the
  same `type !== 'none'` test `_stepRegionPick` uses to find a sample), so the override is reachable
  with no global region, while staying hidden for a siteplan-only building.
- **The scoped reset button is labelled to match.** When a scoped pick has an override but there's
  no global region, the reset button now reads **"Clear — show full drawing"** instead of the
  misleading **"Use the global region"** (still shown when a global region exists). Frontend +
  docs only. Version → `1.12.0`.

## 1.11.0 — Add a floor by searching NetBox Locations
- **"+ Add floor" escape hatch in the floor selector.** The per-drawing floor buttons come from
  `_floorsFromLocations`, a heuristic that can miss a floor Location (one nested under an
  intermediate Location, or when the building name doesn't match). In Location mode each drawing's
  floor row now ends with a **"+ Add floor"** button that opens an inline search over the building's
  bound-site Locations (`netbox.locations`, free-text autocomplete reusing the `.room-item` markup),
  excluding ones already shown. Picking a result adds it as a floor button for **every** drawing in
  the building and assigns the current drawing to it in one click (`_floorAddControl`/`_addFloor`).
- **Survives a resume.** `nbFloors` is rebuilt from the heuristic on each load, but a hand-added
  floor is re-included from the persisted assignment token (`_mergeAssignedFloors` in
  `_loadFloors`), so its button — and any sibling drawing's ability to pick it — comes back.
- Frontend + CSS only; the build/manifest/preprocess path is unchanged (the floor id is still the
  Location slug). Version → `1.11.0`.

## 1.10.0 — Drop OCR; show a close-up of each drawing's code instead
- **Removed the offline OCR auto-assignment.** Reading the floor code off scanned title blocks
  was never reliable enough to trust, so the whole engine is gone: `ocr.py`, the vendored
  PP-OCRv4 model (`models/rec.onnx`), the `OcrAssignView` endpoint (`api/import/ocr-assign`),
  the `ocr_mem_mb` setting, and the `onnxruntime` + `numpy` runtime dependencies. Installing now
  pulls only `pypdfium2` + `Pillow`, and the wheel no longer bundles a 10.8 MB model. The
  automatic/manual mode choice is gone — assignment is manual.
- **Code-crop thumbnails make manual assignment fast.** The same "mark the code once" gesture
  that used to feed OCR now drives a purely visual flow. Before the mapping grid the user drags a
  box over the spot that identifies each drawing (`_codeRegion`, normalized 0..1) on a sample
  drawing; every floor card then shows a **close-up crop of just that spot** (`_codeCropThumb`)
  instead of the full drawing, so floors are recognizable at a glance. The crop is pure CSS over
  the existing hi-res preview — no new backend. Clicking a card opens the whole drawing in the
  lightbox for an outlier whose code sits elsewhere.
- **Per-building override + skip.** A building whose title block sits in a different corner gets a
  **"Mark this building's code"** button that overrides the crop region for just its cards
  (`building.codeRegion`). The region step is skippable (**"Skip — show full drawings"**) to fall
  back to full-drawing thumbnails. Both the global region and per-building overrides persist in the
  draft. Version → `1.10.0`.

## 1.9.0 — Auto floor assignment reads the caption, not the code
- **Mark the whole floor caption, not a tight box on the code.** The region step now asks the
  user to box the entire floor-designation caption (e.g. "… SECOND BASEMENT LEVEL (B2) PLAN …")
  rather than just "(B2)". `_floorKey` already pulls the code out of a full caption, and the
  code's exact position **drifts with caption length** (a long building name pushes it sideways)
  while the title-block caption sits at a stable spot — so a caption-sized box is
  position-tolerant across buildings. This was the real reason most buildings came back
  unassigned: the tight code-box, drawn on one sample, landed on *building-name* text on other
  sheets (it read fragments like "CMMS"/"MATERIAL", never the code).
- **Per-building re-read for the odd building whose title block is in another corner.** A
  **"Re-read this building's floor codes"** button (auto mode, shown only while a building still
  has an unassigned drawing) re-opens the region picker on a sample from *that* building and runs
  a **folder-scoped** OCR pass — `OcrAssignView` accepts an optional `folder` so it OCRs only that
  building's drawings, and the results update just it. The global **Re-read region** /
  **Switch to manual** escapes are unchanged. Version → `1.9.0`.

## 1.8.0 — Auto floor assignment shows its work and stops throwing away near-misses
- **The automatic pass now shows what OCR read on every card.** `_applyOcr` stashes the raw
  read (`a.ocrText`/`a.ocrConf`) on every processed drawing, and each card renders a small
  read-out chip (`Read “L1” · 47%`). Previously the recognized text was discarded, so a drawing
  that wasn't auto-assigned went blank with no hint of *why* — now it explains itself (what was
  seen and how confidently), which is also the fastest way to tell a faint/low-confidence read
  apart from a genuine misread.
- **A low-confidence read that still parses to a floor is no longer silently dropped.** Before,
  any result below `OCR_MIN_CONF` (0.5) was thrown away and the drawing left blank-`unassigned`.
  Now the guess is kept as `a.ocrSuggest`: the drawing stays `unassigned` (so the build gate
  still forces a human confirm — OCR never auto-commits a shaky read), but `_floorButtons`
  **pre-highlights** the guessed floor (`.suggested`, a dashed outline) so the user confirms it
  in one click instead of choosing blind. Truly unmatched/ambiguous reads stay `unassigned` and
  record an `a.ocrReason` (`no floor matched`/`nothing read`) shown on the card.
- This directly targets the case where only a handful of buildings auto-classified while the
  rest came back empty: the codes *were* being read, but sub-0.5 confidence reads were discarded
  invisibly. Version → `1.8.0`.

## 1.7.0 — OCR that installs anywhere (no OpenCV, no system libs)
- **Replaced the OCR engine so a plain `pip install` works on any environment.** The previous
  rapidocr engine depended on `opencv-python`, whose `cv2` needs X11 system libraries
  (`libGL`/`libxcb`) that headless servers don't ship — so automatic floor assignment failed out
  of the box on a bare NetBox host. The new engine runs a **PP-OCRv4 text-recognition model**
  (Apache-2.0, **vendored in the wheel** under `models/rec.onnx`) on `onnxruntime`, with all image
  preprocessing in `numpy`/`Pillow` — **no OpenCV**. onnxruntime's wheels depend only on base
  libc/libstdc++, and the model ships in the package, so recognition is fully offline with **no
  system packages and no network**.
  - **Dependencies:** drop `rapidocr-onnxruntime`; add `onnxruntime` + `numpy` (Pillow stays).
  - Because the user already boxes the code, the engine does **recognition only** (no detection
    model — that's the part that needed OpenCV). A small numpy horizontal-projection splitter
    handles a box that spans multiple text lines; fullwidth glyphs are folded to ASCII.
  - The isolation contract is unchanged: `ocr.py` is still a capped subprocess that reads only
    already-rendered, trusted PNGs and never opens a PDF. The `ocr_mem_mb` budget still applies
    (onnxruntime also reserves a large virtual-address space). Version → `1.7.0`.

## 1.6.1 — Name the real reason OCR can't load
- **The "rapidocr-onnxruntime is required" message now includes the real import error.** The
  guard caught any `ImportError` and reported the same generic line, so an *installed* but
  *unloadable* dependency (e.g. on a headless server, OpenCV's `cv2` failing on a missing
  `libGL.so.1`/`libxcb.so.1`) looked identical to a missing package. `ocr.py` now captures the
  actual import exception and appends it (`… — import failed: libxcb.so.1: cannot open shared
  object file`), so the toast points at the fix. Note for headless installs: OpenCV (pulled in
  by rapidocr) needs the X11 runtime libs — `dnf install mesa-libGL libxcb` (or the
  `opencv-python-headless` swap). Version → `1.6.1`.

## 1.6.0 — Site plan first, zoomable floor-code picker, clearer OCR errors
- **Real error messages, not "HTTP 500".** `Api.get`/`Api.post` now surface the server's own
  message on a failed request (the `error` field of a JSON body, or the plain-text body) instead
  of a bare status code. The automatic floor-code pass talks only to the **local** NetBox
  endpoint `api/import/ocr-assign` — never the internet — so when OCR fails you now see the
  actual cause (e.g. a missing dependency) rather than a mysterious "HTTP error".
- **OCR subprocess gets its own memory budget** (`ocr_mem_mb`, default `0` = no `RLIMIT_AS`).
  `ocr.py` reads only already-rendered, trusted PNGs, so the tight `render_mem_mb` cap — sized to
  contain a malicious PDF parser — doesn't apply, and it was killing onnxruntime (which reserves
  a large virtual-address space). The CPU/timeout cap still applies.
- **Site plan is chosen first, in its own step** (`_stepSiteplan`). The site plan is the overall
  site map and carries no floor code, so it's picked before — and apart from — floor assignment;
  the chosen drawing is excluded from floor assignment and the OCR pass. The map step now shows a
  compact "Site plan: … · Change" summary instead of the inline dropdown.
- **Zoomable floor-code picker.** The "draw a box around the floor code" sample now sits in a
  scrollable viewport with **−/Fit/+** zoom (scroll to pan), so a small code can be boxed
  accurately. The box stays correct at any zoom (it normalizes against the image's live rect).
- **Floor codes embedded in a caption** resolve more robustly — `_floorKey` already pulled the
  code out of prose like *"Third Basement Level (B3) Plan"* (→ `b3`); spelled-out ordinals
  (*"Second Floor"* → `l2`, first–tenth) are now handled too. Version → `1.6.0`.

## 1.5.1 — Concise instructional copy
- **Tightened the in-app help text** to match NetBox's terse `help_text` convention — a label
  plus at most one short line, no narration of what the UI already shows. No behaviour change;
  copy only. Import wizard: the *Map buildings*, *assign-choice*, *region-pick*, and *map* step
  hints, plus the gated Build reason (still names the unassigned buildings, just shorter).
  Settings: the import blurb. Floor/label/rack panels: the place-racks, marker-manipulation,
  route-node, and label hints (per-control detail no longer repeated across panels). Contextual
  draw banners and `title=` tooltips are unchanged (already the right pattern). New §11 doc
  convention records the rule so future strings stay terse — version → `1.5.1`.

## 1.5.0 — Edit buildings & floors after a build (post-build re-import)
- **Edit a built facility without "Start over".** A normal Build already leaves `uploads/` and
  the draft in place, so re-opening the wizard resumes onto the current facility; this release
  makes that **discoverable** and adds **granular, non-destructive editing** for three needs —
  fix a mistake, replace a drawing, add a building/floor — version → `1.5.0`:
  - **Entry points.** An *Edit buildings & floors* button on the siteplan view-mode toolbar
    (`SiteplanEditor._toolbar`) and a relabelled *Import or edit a facility* button on the
    Settings page, both routing to `#/import` (distinct from the destructive *Start over*).
  - **Replace a floorplan in place.** A per-card **Replace** control (`_replaceControl`/
    `_replacePdf`) uploads a newer drawing to the floor's existing `uploads/` path, so the
    drawing stem — and therefore the floor id and any rooms drawn on it — are **preserved**
    (id-preserving; rooms survive). A re-scan refreshes the thumbnail (cache-busted per `_rev`).
  - **Add a building/floor.** A **+ Add drawings** action (`_addDrawings`/`_mergeUploads`) reuses
    the upload step in "merge" mode (`_mergeMode`): it saves the current assignments as a draft,
    accepts new folders/PDFs, then re-scans and **re-applies the draft** so existing assignments
    survive and only the new drawings arrive unassigned. It re-runs the building auto-match for
    any new unbound building. Adding only **re-points** at existing NetBox Sites/floor Locations —
    the wizard never creates Locations.
  - **Room-safety warning.** Re-assigning a drawing's floor or re-binding a building changes the
    floor id, orphaning rooms keyed to the old id. `_build` now runs `_orphanedFloors` before a
    rebuild: it diffs the about-to-build floor keys against the live manifest's floors-with-rooms
    and **warns + confirms** (naming each affected floor + room count) before proceeding. On
    confirm it discards those rooms through the authoritative, permission-scoped `sync_rooms`
    path (an `/api/annotations` save with the orphaned keys removed) — **no new endpoint, no
    loosened delete scoping**. Replacing a PDF with the same assignment is unaffected (id
    unchanged, no warning).
  - **No backend changes.** Replace/add reuse the existing `upload`/`upload-zip`/`scan` endpoints;
    the room-safety check is computed in the browser from the manifest + annotations and the
    discard reuses the existing annotations save. `imports.py`/`preprocess.py`/`frontend_api.py`
    are untouched, so the security/data-safety posture is unchanged.

## 1.4.0 — Automatic floor assignment (offline OCR)
- **Import.** The map step now opens on a choice between **Automatic** and **Manual** floor
  assignment (`_assignMode`), version → `1.4.0`:
  - **Automatic.** The user drags one box over where the floor code sits on a sample drawing
    (`_stepRegionPick`/`_attachRegionDrag`, stored **normalized 0..1** in `_ocrRegion`); the
    wizard reads that same region on every drawing and pre-fills each floor. Results below
    `OCR_MIN_CONF`, unmatched, or ambiguous are left `unassigned` for the user to confirm — OCR
    pre-fills, the human still owns the final assignment. A banner offers re-reading the region
    or switching to manual at any time. `_assignMode`/`_ocrRegion` persist in the draft.
  - **Offline OCR engine.** A new `POST api/import/ocr-assign` (`OcrAssignView`) OCRs the
    region on every drawing's rendered image and returns `{results:[{folder,stem,text,
    confidence}]}`; the frontend matches each code to a floor (`_matchFloor`/`_floorKey`,
    handling Location mode and the floor-type fallback). OCR runs in a **new sibling
    subprocess** `ocr.py` (`FloorCodeReader`) over **already-rendered, trusted PNGs** — it
    never opens a PDF, so PDF parsing stays solely in `preprocess.py`. Same isolation as the
    renderer (file-path invocation, timeout, POSIX rlimits) and `change_facilitymapblob`-gated;
    lock-free like `preview`.
  - **New dependency `rapidocr-onnxruntime`.** Its OCR models ship inside the wheel, so
    recognition is **fully offline** — no network, no system OCR binary. Pulled automatically
    by `pip install`. `preprocess.py` stays stdlib + pypdfium2/Pillow; `ocr.py` is stdlib +
    Pillow + rapidocr.
  - **Refactors.** `_run_preprocess` generalized to `_run_script` (+ `_run_ocr`);
    `_ensure_preview` factored out of `PreviewView` and shared with the OCR pass; `_ensureFloors`
    split so the awaitable `_loadFloors` can preload every building's floors before matching.

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
