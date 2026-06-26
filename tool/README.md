# Facility Map — Room Annotation Tool

A local web app to turn **any** facility's floor-plan PDFs into a navigable
**siteplan → building → floor → room** map, and to draw clickable **room
polygons** that link to **NetBox Locations**. The tool ships with **no facility
content** — you import your own drawings from inside the app (see *Importing a
facility*). Output is `annotations.json`, the durable artifact the **NetBox plugin**
in `../netbox-facilitymap/` consumes (install/operate it via
`../netbox-facilitymap/README.md`).

> **Developers / AI tools:** the deep reference is `ARCHITECTURE.md` (every class,
> method, data model, route, coordinate convention, and the gotchas in §10). Local
> AI-tool context + coding standards live in `../CLAUDE.md`. Keep both current with
> every change.

## Setup / run

```bash
cd tool
pip install -r requirements.txt  # required: renders the imported PDFs (pypdfium2 + Pillow)
python3 server.py                # serve on http://127.0.0.1:8765
# or, equivalently, the convenience launcher:
./start.sh
```

Open <http://127.0.0.1:8765/>. With nothing imported yet, the tool opens on its
**import** screen. The **server** needs only the Python 3 stdlib; PDF rendering runs in
a `preprocess.py` subprocess that uses the two `requirements.txt` wheels (`pypdfium2` +
`Pillow`, self-contained — no system packages, so the tool bundles cleanly into a venv
or Docker image). The UI is a light "CAD" theme (Public Sans + IBM Plex Mono) with fonts
bundled under `web/fonts/`, so the tool needs no internet and looks identical offline.

### Importing a facility

Drawings come as a **PDF-only** tree — one folder per building, each holding its floor
plans (one PDF per floor). Because the PDFs carry **no text layer** (every label is a
vectorized path), the floor a drawing represents can't be read from the file — you assign
it in the wizard. From the tool's **Import** screen (the home screen until a facility
exists; also reachable via the ⚙ gear → *Import a facility from PDFs*):

1. **Upload** — drop or pick the folder of building sub-folders. Each PDF is uploaded to
   the server (`tool/uploads/`, gitignored).
2. **Map** — the server renders a thumbnail of every PDF. For each building, set its
   **name**, **site slug** (must match the NetBox site slug), and **floor-id prefix**,
   then give each drawing a floor (**Basement N / Ground / Level N / Roof**). Click a
   thumbnail to open the full PDF if you need to read its title block. Use *Number floors
   1…N* to bulk-fill, then adjust. Two drawings on the same floor (stacked sheets) →
   set the second to **“same floor (extra sheet)”** to make one multi-page floor. Pick one
   PDF as the optional **site plan** background.
3. **Build** — the tool renders full-resolution images to `images/<slug>/…`, writes
   `manifest.json`, and reloads onto the new map. The mapping is saved as `import-map.json`
   so a later re-import only needs the deltas. *Start over* clears everything.

Floor labels are derived from the assigned token (`b3` → "Basement 3", `g` → "Ground",
`l1` → "Level 1", `r` → "Roof"); a floor's id is the prefix + token (`a1` + `b3` =
`a1b3`). The site plan has **no building hotspots** — draw the building boundaries on it
in the siteplan editor (*Edit building areas*, below).

`config.json` holds the NetBox URL + API token (gitignored — never commit it).
Copy `config.example.json` to `config.json` and fill in your values:

```json
{
  "netbox_url": "https://netbox.example.com",
  "netbox_token": "your-netbox-api-token-here",
  "verify_ssl": true,
  "port": 8765
}
```

`verify_ssl` and `port` are optional (defaults: `true` and `8765`). The token needs
at least read access to `dcim` in NetBox.

## Using it

**Pan & zoom (every map).** The siteplan and floor maps work like Google Maps:
they open **fit to the screen**, then you can **drag the background to pan**,
**scroll to zoom** toward the cursor, and use the **+ / − / ⤢ (fit)** buttons in
the bottom-right corner. `+` / `-` / `0` on the keyboard do the same (zoom in, out,
reset). You can zoom **out** to about half the opening view (handy for getting your
bearings), and pan a map **edge or corner all the way to the middle of the screen**
to inspect or zoom into it. To pan while the pointer is over a room or hotspot, drag
with the **middle mouse button**. Drawing, snapping, and dragging all stay
pixel-accurate at any zoom.

**Unsaved work is protected.** Each editor shows a **● unsaved** badge once you make
a change. If you navigate away (a breadcrumb, a building, a floor card, the ⚙ gear, or
the browser Back button) — or close/refresh the tab — while you have unsaved edits, the
tool asks you to confirm before leaving so you don't lose work. Click **Save** first to
clear the badge and skip the prompt.

1. **Siteplan** — each building shows its **name**, centered and auto-sized to fit
   its area (long names wrap to two lines; tiny areas show the short code). The
   building outlines themselves are hidden while viewing; hovering a building — or
   its row in the **building index** on the right — darkens it so you can see what
   you're about to click. Click it to open the building. The index lists *every*
   building including trailers (and ones with no map; `◌` = not yet placed on the
   map), and has a **search box** to filter the list as you type.
   - **Edit building areas** lets you draw your own clickable building hotspots
     (e.g. for the trailers, which the source PDF never placed). Draw a polygon,
     assign it to a building, **Save siteplan** → stored in `siteplan.json`. You can
     also **click any existing area — including the 27 from the source PDF — to
     reshape it**: it becomes a green editable area (drag vertices, add/remove nodes;
     see below) that overrides the PDF one, so you can fix a misaligned hotspot.
     **Delete area** on a promoted PDF area reverts it to the original PDF shape.
     Same grid/snap/undo tools as the floor editor.
   - **Edit label** (in a building area's panel) lets you reposition and restyle that
     building's label: **drag the label** to move it (snaps to the grid), use the **top
     handle to rotate** (snaps to 15°) and the **corner handle to resize**, and set the
     **display text, font, size, rotation, and colour** in the panel. The **display text**
     is purely visual — edit it to control spacing and line breaks (press **Enter** for a
     break); it does **not** change the building's actual name/binding. **Hold Alt** while
     dragging to move/rotate freely (no snapping). **Reset to auto** restores the automatic
     text/placement/size; **Done** returns. Saved with the siteplan.
2. **Building** — pick a floor (cards show extracted thumbnails + a `mapped` /
   `unmapped` status badge, plus a `sheets` badge when a floor has more than one
   drawing sheet).
3. **Floor** — some floors are drawn across two sheets (assigned the same floor in
   the import). They appear **tiled in one floor view**, each
   captioned at its top corner; scroll/zoom between them and annotate either as a single
   continuous map. Opening such a floor frames the **first sheet** (with a sliver of the
   next) so you can tell there's more than one. **Arrange sheets** (edit-mode toolbar,
   shown only for multi-sheet floors) lets you **drag a sheet into any grid cell** — drop
   it on another sheet to swap, or into an empty cell to lay the plans out the way the
   building actually runs (e.g. side by side). Any rooms you've already drawn move with
   their sheet. **Save** stores the arrangement; **Esc** leaves Arrange. In **Edit mode**
   (toolbar buttons carry icons; the active tool is tinted blue, a sheet stamp + north
   arrow sit on the drawing):
   - **Draw room** → click vertices → **Enter** / double-click / click the first
     point to close. A live cursor shows where the next point will land.
   - **Draw arrow** → click points along a route, ending inside the room you want to
     reach, then **Enter** / double-click to finish. This drops a **wayfinding arrow**:
     the arrowhead points at the destination room (auto-detected and shown in the panel),
     and the route bends through the corridors you clicked. In the arrow's panel, add a
     **note** (e.g. "Enter from the north stairwell", shown at the start) and pick a
     **colour** so several routes can be told apart. Once a note is set, **Edit label**
     lets you move/rotate/resize/recolour it (and hand-break its text) like building and
     rack labels. Select an arrow to reshape it (drag a node, drag a midpoint to add a
     turn, right-click a node to remove one) or **Delete** it. Arrows stay visible in
     **View mode** as a guide for anyone following the route.
   - **Grid** (square cells, sized in image px: 4/8/12/25/50) and **Snap** make
     points — and dragged vertices — snap to the grid and to nearby room
     vertices/edges, so adjacent rooms share exact boundaries ("snap two drawings
     together"). Each floor — and the siteplan — remembers its own grid size
     between sessions, so a busy floor can use a finer cell than a simple one.
     When a dragged vertex snaps onto another shape's wall it also steps
     along that wall by the grid, so it can't slide to an uneven spot.
   - **Right angle** keeps corners square. **While drawing**, the next point lines up
     horizontally/vertically with the previous point (and the first point, to close off a
     clean rectangle); **while reshaping**, a dragged vertex lines up with its two
     neighbours. Either way it pulls the edge to a clean 90°, and while it engages the
     locked edge is highlighted with a small square marking a true right angle. Off by
     default; toggle it on per editor.
   - **Move grid**: drag to reposition the grid origin, scroll to resize it, so
     the grid can be aligned to the building.
   - **Undo point** (or **Backspace** / **Ctrl-Z**) removes the last node while
     drawing.
   - **Duplicate as new room** (in the room panel) clones a room's shape so you
     can build the next room off an existing one, then drag to adjust.
   - Bind to a NetBox Location from the panel list (children of the floor
     Location). Bound = green, unbound = red. Select a room to drag vertices,
     **Unbind**, or **Delete**.
   - **Reshape a selected shape** (a room here, or a building area on the siteplan):
     **drag a vertex** to move it, **drag a blue midpoint handle** on an edge to add
     a node there, and **right-click a vertex** to remove it (a shape keeps at least
     3 points). New nodes snap to the grid and nearby vertices/edges like any point.
   - Rooms are **not labelled** — the floor-plan drawings already print room names and
     numbers, so the tool draws no text on top of them.
   - **Datacenter / racks here** checkbox marks a room so it stays visible in
     view mode.
   - **Save** writes `annotations.json` (atomic; previous version kept as `.bak`).
4. **View mode** — rooms are **invisible but clickable**: clicking opens the
   room's NetBox Location page. Rooms flagged as datacenters stay highlighted; the
   **Highlight** selector toggles that on/off. Placed rack/device markers also show
   here (read-only); clicking one opens its NetBox page.
5. **Racks** — in **Edit mode**, the **Place racks** toggle (in the edit toolbar)
   switches to rack-placement and lays out racks inside datacenter rooms:
   - Click a datacenter room to open its panel, then click **Refresh racks** to pull
     just that room's racks and *unracked* devices from NetBox into a local cache
     (`rackcache.json`). Each room is pulled on its own — re-click **Refresh racks**
     whenever that room changes in NetBox.
   - The panel lists the room's racks and unracked devices. **Click a row to drop** a
     marker in the room, then **drag it** to where the unit physically sits — markers
     stay **clamped inside the room**. A **rack** is drawn as a clean labelled box with
     its name **inside** it; **devices** are drawn as a **representative shape for their
     type** (network switch, router, server, firewall, UPS, PDU/power strip, storage,
     patch panel, …) with the name below, chosen from the device's NetBox **role** (re-run
     **Refresh racks** to pull roles); devices with no role fall back to a guess from their
     name.
   - A selected marker shows a **top handle to rotate** and a **corner handle to
     resize** it to the unit's real footprint and orientation; **Delete** removes it.
     **Edit label** (on the selected-marker panel) restyles the name — move it, change
     font/size/colour/rotation, or set custom display text — like the siteplan building
     labels. Click a placed (✓) row to remove it too.
   - The **Grid** controls (toggle / size / **Move grid**) work here too: with the grid
     on, a marker's position snaps to it as you drag, its rotation snaps to 15°, and a
     resize snaps to the grid — hold **Alt** to bypass any snapping.
   - **Save** writes `rackplacements.json` (atomic; previous version kept as `.bak`).

## Data

The tool's entire persistence layer is a handful of JSON files in `tool/`:

- `manifest.json` — buildings, floors, siteplan, and NetBox slugs (**generated** by the
  import; rendered from `uploads/` + `import-map.json`).
- `import-map.json` — the import wizard's building/floor mapping (regenerated on import).
- `annotations.json` — per-floor **rooms** (polygons bound to NetBox Locations) and
  wayfinding **arrows** (user data).
- `siteplan.json` — user-drawn/edited building hotspots and label overrides (user data).
- `rackplacements.json` — rack/device marker positions inside rooms (user data).
- `pagelayouts.json` — per-floor sheet arrangement for multi-sheet floors (user data).
- `rackcache.json` — NetBox inventory snapshot, regenerable per room via **Refresh
  racks** (generated, gitignored).

All polygon/marker coordinates are stored **normalized 0–1** so they're
resolution-independent. The exact field-by-field schemas are in
**`ARCHITECTURE.md` §5**, and saves keep a `.bak` of the previous version.

## NetBox model relied upon

Nested Locations: **Site (building) → Location (floor) → Location (room)**.
Each building's **site slug** is the slug you set in the import wizard (stored in
`import-map.json`). Floor ids are the floor-id prefix + floor token (e.g. `a1` + `b3` =
`a1b3`) and equal floor Location slugs where they exist; when a floor slug has no
Location, the panel falls back to all locations under the site and shows a warning.

## NetBox plugin (`../netbox-facilitymap/`)

This tool is also packaged as an installable **NetBox 4.x plugin** that ingests
`annotations.json` and renders the same SVG room overlays inside NetBox —
normalized polygons + Location ids port directly, no re-annotation. The plugin is
**built**: a read-only map, full editing/save, ORM-backed racks/devices with
object-permission scoping, and a relational `Room` model (FK'd to `dcim.Location`)
with a native UI + REST API, drawn on NetBox Location pages.

- **Install / operate it:** `../netbox-facilitymap/README.md`
- **How it's designed** (storage model, packaging mechanics, install internals):
  `../netbox-facilitymap/DESIGN.md`
- **Release history:** `../netbox-facilitymap/CHANGELOG.md`
