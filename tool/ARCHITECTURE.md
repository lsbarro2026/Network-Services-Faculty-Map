# Architecture Reference

Exhaustive technical reference for the facility-map annotation tool. Read
this once to orient; you should not need to read source files to understand *what*
exists or *where* it lives. Pair with `CLAUDE.md` (standards + maintenance rules)
and `README.md` (user-facing usage).

> **Keep this file current.** Any change to a class, method signature, data model,
> route, file location, or coordinate convention MUST be reflected here in the
> same change. See `CLAUDE.md` § "Documentation maintenance".

---

## 1. What the tool is

A local web app to (a) navigate **siteplan → building → floor → room** and (b) annotate
floor-plan images by drawing **room polygons** and binding each to a **NetBox Location**.
Output JSON is the durable artifact that drives the NetBox plugin in
`../netbox-facilitymap/` (built — ORM reads + live racks/devices + a relational `Room`
model rendered natively on NetBox Location pages; see `../netbox-facilitymap/DESIGN.md`).
This standalone tool keeps running unchanged alongside the plugin.

The tool is **generic and ships with no facility content**. A facility is imported from
inside the app: the user uploads one folder of floor-plan PDFs per building, the server
renders them (via a `preprocess.py` subprocess), and the result is `images/` +
`manifest.json` (§4 import). Because the PDFs have no text layer, each PDF's floor is
**assigned by the user** in the import wizard, not inferred.

---

## 2. Directory map

```
tool/
  preprocess.py          # Preprocessor: render imported PDFs -> images + manifest (scan|build)
  server.py              # Config/NetBoxProxy/JsonStore/Handler/ToolServer (the server)
  start.sh               # Convenience launcher: checks config, runs server.py
  requirements.txt       # render deps (pypdfium2, Pillow) — required for the import
  config.json            # NetBox url + token + port (gitignored; contains a secret)
  config.example.json    # Safe template — copy to config.json and fill in values
  uploads/               # GITIGNORED: PDFs uploaded by the import wizard, + .thumbs/
  import-map.json        # GITIGNORED: import wizard's building/floor mapping
  import-map.stub.json   # GITIGNORED: drawings left unmapped by the last build
  manifest.json          # GITIGNORED/GENERATED: buildings, floors, siteplan
  annotations.json       # GITIGNORED/EDITED: room polygons -> NetBox Location
  siteplan.json          # GITIGNORED/EDITED: user-drawn building hotspots
  rackcache.json         # GITIGNORED/GENERATED: synced NetBox racks/devices per location
  rackplacements.json    # GITIGNORED/EDITED: rack/device marker positions inside rooms
  pagelayouts.json       # GITIGNORED/EDITED: per-floor sheet arrangement grid
  images/<slug>/<floor>.png # GITIGNORED/GENERATED: rendered floor + siteplan images
  web/
    index.html           # shell; loads the scripts below in dependency order
    style.css            # all styling — light "CAD" theme; tokens in :root; @font-face
    fonts/               # bundled WOFF2 (Public Sans + IBM Plex Mono, SIL OFL); offline
    lib.js               # Util, Dom, Geom, Toast, Api, Icons + consts (SVGNS, *_PX)
    device-shapes.js     # DeviceShapes (per-type rack/device marker glyphs)
    netbox.js            # NetBoxClient
    store.js             # Store (data + persistence + dirty tracking)
    grid.js              # GridController (shared snapping grid)
    panzoom.js           # PanZoom (map viewport: pan + zoom transform)
    editor.js            # Editor (abstract base: the shared polygon engine)
    floor-editor.js      # FloorEditor extends Editor (rooms + NetBox binding)
    siteplan-editor.js   # SiteplanEditor extends Editor (building hotspots)
    import-wizard.js     # ImportWizard (in-app PDF import: upload -> map -> build)
    app.js               # App (orchestrator + router + boot). Loaded LAST.
  README.md  ARCHITECTURE.md  CLAUDE.md
```

The tool ships with **no facility content** — everything above the `web/` line that is
marked GITIGNORED is created by importing a facility (see §4 import) and is absent on a
fresh checkout.

Script load order is dependency order; every class is a global (no build step,
no modules). `App` is instantiated on `DOMContentLoaded` (in `app.js`).

---

## 3. Frontend class reference

All UI coordinates are **normalized 0..1** relative to the image unless noted.

### lib.js (foundations — pure static classes)
- **`Util`** — `uid()`, `floorKey(dir,fid)`, `isNumbered(dir)` (`/^\d\d-/`), `code(dir)` (2-digit code or full dir for trailers).
- **`Dom`** — `$(sel,root)`, `el(tag,attrs,children)` (attrs: `class`, `html`, `on*` listeners, else setAttribute), `svg(tag,attrs)` (SVG-namespaced).
- **`Geom`** — `centroid(poly)`, `bounds(poly)` → `{minX,minY,maxX,maxY,w,h,cx,cy}` axis-aligned bbox + center (used to size/place siteplan labels), `projSeg(px,py,ax,ay,bx,by)` → `{x,y,d}` nearest point on a segment (displayed px), `pointInPoly(nx,ny,poly)` (ray-cast), `clampToPoly(nx,ny,poly)` (inside → unchanged, else nearest edge point — used to keep rack markers inside a room).
- **`Toast`** — `show(msg,err?)` transient notification.
- **`Icons`** — inline 13×13 SVG glyphs (`edit, draw, undo, snap, grid, move, dup, check, rack, settings, rightangle`) using `currentColor`, for icon buttons + chrome. Build buttons via `Dom.el('button',{html:Icons.x+'<span>Label</span>'})`.
- **`Api`** — `get(path)`, `post(path,body)`; throw on non-2xx.
- Consts: `SVGNS`, `CLOSE_PX` (12), `SNAP_PX` (11), `ORTHO_PX` (9) — displayed-px
  thresholds. `ANGLE_STEP` (15) — label-rotation snap increment (°). `LABEL_SIZE_MIN`
  (6) / `LABEL_SIZE_MAX` (120) — label font-size clamp (px). `LABEL_FONTS` — the label
  font-family choices (`{name,css}`): the two bundled fonts (Public Sans, IBM Plex Mono)
  plus generic `sans-serif`/`serif`/`monospace` (offline, no CDN).

### device-shapes.js (pure static — like Icons/Geom)
- **`DeviceShapes`** — schematic glyphs for the rack/device markers in racks mode.
  `typeFor(p,item)` → a glyph type: `'rack'` for `kind==='rack'`, else keyword-matches
  the device's NetBox **role** (slug/name) then its own name (so it degrades to a
  name-based guess when the role is unset) → `switch | router | server | firewall | ups
  | pdu | storage | patchpanel | generic`. `box(type)` → a default `{w,h}` (display px)
  so the types read at distinct sizes (rack tall, pdu/switch strips, …). `glyph(type,
  wpx,hpx)` → an array of `Dom.svg` children **centered at the origin** (the marker `<g>`
  supplies translate+rotate), built from classed primitives `dev-body` (unit outline),
  `dev-line` (rails/bays/bricks), `dev-port` (ports/outlets), `dev-led` (status dots).
  A `rack` is intentionally just the `dev-body` box (no inner detail) — its name rides
  **inside** the box as the label (see `_drawPlacementLabel`); devices keep their detailed
  glyph and sit the name below it.

### netbox.js
- **`NetBoxClient`** — `rooms(siteSlug,floorSlug)`, `locations(siteSlug,q)`,
  `syncRoom(locationId,name)` (POST `/api/netbox/sync-room`, merges one room's racks
  + devices into the cache), `racks(locationId)`, `devices(locationId)`. Thin
  wrappers over the server proxy (the browser never calls NetBox directly).

### store.js
- **`Store`** — single source of truth. Fields: `manifest`, `annotations`
  (`"dir/fid"→record`), `siteHotspots[]`, `dirty`, `siteDirty`, `placementsDirty`,
  `layoutDirty`, `nbRoomsByFloor` (cache), `rackCache` (`{locations:{<locId>:{name,racks,devices}},
  syncedAt}`), `placements` (`"dir/fid"→{placements:[…]}`), `layouts`
  (`"dir/fid"→{grid:[[col,row]…]}`, sheet arrangement), `onDirty` (optional
  callback `'floor'|'site'|'racks'`). Methods: `load()` (manifest + annotations +
  siteplan + rackcache + rackplacements + pagelayouts), `building(dir)`,
  `floorLayout(dir,fid)` (**the** sheet-tiling resolver → `{cells:[{page,col,row,image,
  w,h,caption}],cellW,cellH,cols,rows,W,H}`; default = vertical stack), `floorData(dir,fid)`
  (create-on-miss; seeds combined `w/h` from `floorLayout`), `placementData(dir,fid)`
  (create-on-miss), `setLayout(dir,fid,grid)` (+`markLayoutDirty`),
  `racksForLocation(locId)`, `markDirty()`, `markSiteDirty()`,
  `markPlacementsDirty()`, `markLayoutDirty()`, `hasUnsaved()`, `saveAnnotations()`
  (prunes empty floors), `saveSiteplan()`, `savePlacements()` (prunes empty floors),
  `saveLayouts()` (prunes default/vertical-stack grids), `reloadRackCache()`.

### grid.js
- **`GridController`** — one instance on `App`, so the toggle/origin persist across
  views. Fields `on, ox, oy` (offset in **intrinsic image px** → square cells),
  `adjust` (move/resize mode), and `scope` (the current persistence scope). Cell
  size is exposed as a `step` getter/setter over `_step`; the setter persists to
  `localStorage` **per scope** under key `GRID_STEP_PREFIX + scope`
  (`facilitymap:gridStep:<scope>`), so each floor — and the siteplan — remembers
  its own chosen size across reloads. `setScope(key)` points the grid at a scope and
  reloads its saved size; `FloorEditor.show()` sets it to `Util.floorKey(dir, fid)`
  and `SiteplanEditor.show()` to `'siteplan'` (before building the toolbar, so the
  `gridSizeSelect` reflects the scope). `loadStep()` reads the current scope back,
  validated to the clamp range `[GRID_STEP_MIN=4, GRID_STEP_MAX=120]`, else
  `GRID_STEP_DEFAULT=25` (also the value before any scope is set). Methods:
  `snap(v,offset)`, `draw(s,W,H,dims)`, `resize(deltaY)` (clamped to the same
  min/max). The `gridSizeSelect` dropdown offers `4/8/12/25/50 px`.

### panzoom.js — `PanZoom` (the map viewport)
One instance **per Editor** (`this.viewport`), reset on each mount. A pure state +
math helper modeled on `GridController`: it owns the viewport transform and is
*driven* by `Editor`'s pointer/key handlers — it wires no DOM events of its own.
The transform is a single CSS `translate(tx px,ty px) scale(k)` written to the
`.map-wrap` (origin `0 0`), so a wrap-local point `u` maps to screen as
`base + (tx,ty) + k·u`. Because it lives on an ancestor of the `<svg>`, every
existing normalized-coordinate path keeps working unchanged (`Editor.evtNorm`
reads `getBoundingClientRect()`, which already reflects the transform).
- Fields: `wrap`, `container` (the `.map-viewport` clip box), `tx`, `ty`, `k`,
  `minScale`/`maxScale` (set by `_setRange`). The zoom **floor** is ½ the view's
  opening zoom, capped at the whole-wrap fit so a full zoom-out still reveals
  everything; the ceiling is 8× (or 8× the fit). `get scale()` exposes `k`.
- Methods: `mount(wrap,container)`, `_setRange(fitWhole,opening)` (the one place the
  zoom floor/ceiling are computed), `fit()` (scale-to-fit + centre, sets the zoom
  range; also the **reset**), `fitRegion(nx0,ny0,nx1,ny1)` (frame a normalized
  sub-rect of the wrap — used to open a multi-sheet floor on its first sheet; floor
  = ½ the framed scale, still capped at the whole-wrap fit), `zoomAt(pt,target)`
  (zoom keeping screen point `pt` fixed), `zoomBy(factor,pt?)` (about `pt` or the
  viewport centre), `panBy(dx,dy)` (screen px), `clamp()` (pan limit: the map may be
  panned until an edge/corner reaches the viewport **centre**, never past it, so any
  edge can sit mid-screen while the map never fully leaves the viewport),
  `onResize()`, `apply()` (write the transform). All maths derive from live bounding
  rects, so there is no layout/margin bookkeeping.

### editor.js — `Editor` (abstract base, the shared engine)
Owns the `<svg>` overlay, snapping, drawing, undo, vertex dragging, grid
move/resize, and the map **viewport** (`this.viewport`, a `PanZoom`). Construct
with `app`; pulls `store` and `grid` from it.

**Subclass contract (must implement):** `render()`, `polys()` (→`[{id,polygon}]`
for snapping), `editing()` (bool), `finish()` (close draft → shape), `deselect()`,
`markDirty()`.

**Provided:** `dispSize()` (the whole drawing surface in unscaled layout px — reads
`this.wrap` (the `.map-wrap`), **not** a single `<img>`, so it spans every stacked
sheet of a multi-page floor), `evtNorm(e)`, `snapPoint(nx,ny,exclude)` (priority:
existing **vertex → edge → grid**; the snap radius is divided by `viewport.scale`
so it feels constant at any zoom. An **edge** snap is additionally quantized *along
the wall* when the grid is on — the node stays on the wall but its along-wall
coordinate snaps to the grid (grid-snap the projected point, re-project onto the
segment), so it no longer slides freely along a neighbour's edge),
`orthoSnap(nx,ny,neighbours)` (the **right-angle** constraint, gated by the `orthoOn`
flag: if the pointer is within `ORTHO_PX` of making an edge to one of `neighbours`
horizontal/vertical it locks that axis to that neighbour's coordinate — the two edges
then meet at 90° — while the un-locked axis still grid-snaps; returns
`{pt, engaged:{x,y}|null}` where `engaged` names the neighbour each axis locked to, for
the indicator), `_placePoint(nx,ny,neighbours,exclude)` (the **shared placement snap**
used by both drawing *and* vertex dragging: runs `snapPoint`, and if a vertex/edge snap
to **another** shape did not win, layers `orthoSnap` on top when `orthoOn` and there are
neighbours — so right angle applies while drawing a new polygon as well as while
reshaping one; returns `{pt,kind,ortho}`), `_draftNeighbours()` (the draft's right-angle
partners: the last placed point — the edge being drawn — plus the first point, to square
up on close), `beginDraw(msg, kind='poly')` (`kind` is `'poly'` for a closed polygon —
rooms, hotspots — or `'arrow'` for an open polyline: an arrow draft never closes near its
first point and previews an arrowhead), `undoNode()`,
`attach(img,svg,dims)` (binds events; derives + stores `wrap`/`container` from the
svg, `viewport.mount()`s, appends the zoom controls, observes the container →
`render`+`viewport.onResize`, and `fit()`s once **every** `<img>` in the wrap has
loaded so a multi-sheet stack is measured at full height), `_bindPointer()` (click/dblclick/pointer*/wheel —
includes **pan** + **wheel-zoom**; see below), `handleKey(e)` (Enter=finish,
Backspace/Ctrl-Z=undo, **`+`/`-` zoom, `0` fit**, Esc=cancel/deselect). Render
helpers: `prepareSvg(s)` (clear + toggle `draw-active`/`grid-adjust`),
`addCatcher(s,W,H)` (a full-bleed `.catcher` rect, always pointer-catching, for
background pan/draw), `drawVertices(s,poly,W,H,excludeId,dirtyFn,opts={})` (editable
handles for the selected shape: **drag** a `.vertex` to reshape, **drag a
`.vertex.midpoint`** edge-centre handle to insert a node on that edge,
**right-click** a `.vertex` to remove it — kept at ≥`opts.minPts` points; insert/remove
reuse the `dragVertex` channel and only fire on button 0 so right-click and background
pan never collide. Both the vertex drag and the midpoint insert are gated by the shared
**drag threshold** (see `_pastDragThreshold` below): a vertex press that never travels
past the threshold is a select/inspect click — it moves nothing and does **not** call
`dirtyFn`; the midpoint defers its `poly.splice` (held as `dragVertex.pending` +
`point`) until the threshold is crossed, so clicking a midpoint without dragging adds no
node and leaves the shape clean. `opts.closed` (default `true`) treats `poly` as a closed polygon;
`false` treats it as an **open polyline** (route arrows) — no midpoint or right-angle on
the phantom edge from the last node back to the first, and `closed` rides the `dragVertex`
record so the move handler picks the right neighbours. `opts.minPts` defaults to 3 (2 for
arrows). While a right-angle drag is engaged it also calls
`_drawOrthoGuide(s,node,ortho,W,H)`, which draws the locked edge(s) from the
`node` (normalized) as accent `.ortho-guide` lines plus a small `.ortho-corner` square
glyph at a true 90° corner — a transient overlay cleared by the `render()` on
`pointerup`), `drawDraft(s,W,H)` (the draft polyline/cursor; the cursor carries the same
`ortho` info so `_drawOrthoGuide` shows the indicator **while drawing** too).
**Label editing (siteplan hotspots + floor rack/device placements + route-arrow notes).** A
shape carries an optional `labelStyle` `{x,y,rot,size,font,color,text}` (all fields optional;
absent → the auto-placed/auto-sized label). Floor **rooms** are never labelled, but
`FloorEditor` uses this engine for **rack/device placements** (the glyph is the device, the
label is the name) and **route-arrow notes** (the label is the arrow's `label` note), and
`SiteplanEditor` for building hotspots. Two overridable hooks keep the engine shape-kind
agnostic: `_labelKey(shape)` (identity — base returns `shape.id`; `FloorEditor` returns
`shape.uid || shape.id`, so a placement keys off its `uid` — the NetBox `id` collides across
racks/devices — while an arrow falls back to its `id`) and `_labelDirty(shape)` (dirty channel
— base `markDirty()`; `FloorEditor` branches: arrows (`.points`) → `markDirty()` (annotations),
placements → `markPlacementsDirty()`).
`editingLabel` holds the `_labelKey` of the shape whose label is being edited.
`attachLabel(s,shape,textEl,cx,cy,sizePx,W,H)` wraps a **centered** `<text>` (content +
font-size already set) in a `translate(cx,cy) rotate(rot)` `<g>`, applies the `labelStyle`
font/colour, and — when `editingLabel === _labelKey(shape)` — makes the text draggable
(grab-offset preserved; the centre snaps to the grid, **Alt** frees it) and calls
`_drawLabelHandles`, which adds a rotate handle (snaps to `ANGLE_STEP`°, Alt frees) and a
corner resize handle (maps the un-rotated vertical extent back to a font-size, clamped
`LABEL_SIZE_MIN..MAX`). All three ride the shared `dragItem` channel — whose `move(nx,ny,e)`
receives the **event** too (for `e.altKey`). `_labelStyle(shape)` lazily creates `labelStyle`
for a write. `_setLabelLines(t,lines)` sets centred single/multi-line tspans (hand-broken
labels). `openLabelPanel(shape, onDone, defaultText)` fills the side panel with a
**display-text** textarea (writes `labelStyle.text` — line breaks for wrapping, **never** the
bound name; empty / == `defaultText` reverts to auto) + font/size/rotation/colour inputs +
**Reset to auto** (deletes `labelStyle`) + **Done** (`onDone` returns to the shape's normal
panel). Each control mutates `labelStyle` → `_labelDirty(shape)` → `render()`, so the panel
and the on-canvas handles stay in sync.

Toolbar factories: `undoButton`, `snapButton`, `orthoButton` (toggles `orthoOn` —
right-angle snap), `gridToggleButton`, `gridSizeSelect`, `gridMoveButton`,
`toolDivider` (grouping `.tb-div`), `badgeHtml(dirty)` (saved/unsaved status
innerHTML with green check), `_zoomControls()` (the `.zoom-ctl` +/−/fit cluster).
Flags: `snapOn` (vertex/edge snap, default on) and `orthoOn` (right-angle snap,
default off) are independent per-editor toggles.

**Pan/zoom interaction** (all in `_bindPointer`, driving `this.viewport`): wheel =
zoom-to-cursor (except while `grid.adjust`, which keeps grid-resize); pan starts on
`pointerdown` with the **middle button anywhere** or the **left button on the
background** (the svg or a `.catcher`, never a shape/vertex), moves past a 4px
threshold; a left-button pan sets `_suppressClick` so the trailing click never adds
a point / deselects. A vertex/handle press or drag (`dragVertex`/`dragItem`) sets
`_suppressClick` on `pointerup` for the same reason: the synthetic click that
follows a drag would otherwise hit the background-click `deselect()`, so the shape
**stays selected for the next node edit**. Vertex & grid drags use
`evtNorm`/scale-corrected deltas, so they track the cursor at any zoom.
A capture-phase `pointerdown` records the press origin as `_dragDown {x,y,moved}`, and
`_pastDragThreshold(e)` latches `moved` once the pointer travels ≥4px (the same
threshold pan uses). The `pointermove` handler gates **both** `dragVertex` and
`dragItem` on it: below the threshold the press is a select/inspect click that moves no
geometry and marks nothing dirty — so clicking a vertex or a rack/label marker to select
it (with the usual sub-pixel jitter) no longer flips a dirty flag and falsely triggers
the unsaved-work navigation guard.

Editor state: `draft {points:[[nx,ny]], cursor:{pt,kind,ortho}}`, `selected` (shape id),
`editingLabel` (the `_labelKey` — hotspot id / placement uid — of the shape whose label is being moved/styled),
`dragVertex {poly,i,exclude,dirty,closed}` (a midpoint press also carries `pending`+`point`
until the drag threshold materializes the inserted node), `gridDrag`,
`dragItem {move(nx,ny,e)}` (a generic draggable normalized point — used by rack markers
and label move/rotate/resize; its `pointermove` branch calls `move()` passing the event
for `altKey`), `_dragDown {x,y,moved}` (press origin for `_pastDragThreshold`),
`dragSheet {move(nx,ny),drop()}` (dragging a whole sheet in Arrange mode — `pointermove`
calls `move()`; `pointerup` calls `drop()` to commit), `pan
{x,y,moved,btn}` (active viewport pan), `_suppressClick`, `snapOn`,
`initialFocus` (`[nx0,ny0,nx1,ny1]` framed on the first mount via `viewport.fitRegion`,
else `null` → full `fit()`).

### floor-editor.js — `FloorEditor extends Editor`
`constructor(app, building, floor)`. Shapes are **rooms**.
- Editor hooks: `data()`=`store.floorData`, `polys()`=`data().rooms`,
  `editing()`=`app.mode==='edit'`, `markDirty()` (+badge), `deselect()`.
  `markPlacementsDirty()` is the racks-mode analogue (placements dirty + badge).
- `show()` builds crumbs/toolbar/stage and `attach()`es; preloads NetBox rooms.
  The stage holds a `.map-viewport` (pan/zoom clip box) wrapping the `.map-wrap`. A
  floor is one or more **sheets tiled into a grid** (`store.floorLayout`): the wrap is
  sized to the combined `W×H` and each sheet `<img.sheet>` is positioned absolutely at
  its cell; the single overlay `<svg>` spans the whole canvas, and `attach` is handed
  the combined intrinsic dims `[W,H]`. While **arranging** the canvas is padded one
  extra column + row (`this.layout` = padded display geometry; `this.baseLayout` = the
  true geometry) so a sheet can be dragged into a not-yet-used cell. On the **first**
  mount of a multi-sheet floor `show()` sets `initialFocus` to `_peekRegion(cell0)` so
  it opens framed on sheet 1 + ~10%; later mounts full-fit (`_peeked`). `_drawCaptions`
  labels each sheet at its cell's top-left with inert `.page-caption` text.
  `_sheetMark()` adds a decorative drawing-sheet stamp
  (`Util.code`+floor id, `.sheet-mark`) pinned to the viewport corner — it lives in
  the viewport, not the wrap, so it stays put while the map pans/zooms.
- `_toolbar()` — edit: mode toggle + Draw/Undo/Snap/Right angle/Grid/Size/Move +
  **Arrange sheets** (only when >1 sheet) + **Place racks** toggle + Save+badge; racks
  (a sub-mode reached from edit): the active **Place racks** toggle (returns to edit) +
  **Grid/Size/Move** (the grid serves marker snapping here) + Save+badge; view: mode
  toggle + highlight select + Save+badge. `gridActive()` (= `editing() || racks`) gates
  grid draw + move/resize so they work in racks mode too. `_dirty()`/
  `_setBadge()`/`save()` track placements in racks mode, else rooms **+ sheet layout**;
  edit `save()` writes both `saveAnnotations` and `saveLayouts`.
- **Arrange mode** (`arranging`, `_arrangeButton`): drag whole sheets into grid cells.
  `_drawArrange(s,W,H)` draws the cell grid, a `.sheet-drop` target, and a draggable
  `.sheet-tile` per sheet; `_startSheetDrag` opens the `Editor.dragSheet` channel whose
  `move` tracks the hovered cell (clamped one cell beyond the grid) and `drop` →
  `_commitSheetMove` (place/swap, trim to origin, `store.setLayout`, then `_remapLayout`).
  `_remapLayout(oldGeom,newGeom)` re-projects every room point, **route-arrow point**,
  and placement from its old cell to the sheet's new cell so shapes follow their sheet —
  pure arithmetic on the combined-normalized coords (no schema/engine change). Esc exits.
- `render()` — rooms; in **view mode** rooms are invisible `.clickzone`s that open
  `location.url`, except `datacenter` rooms when `app.highlight==='datacenters'`;
  in **racks mode** only datacenter rooms are drawn/interactive (click →
  `openRackPanel`). Placement markers draw in view + racks modes.
  - **No room labels.** The floor-plan images already carry the printed room
    names/numbers, so the floor editor draws **no** centroid text overlay on a room —
    only the polygon (and its vertices while selected/editing). The shared label engine
    in `Editor` is used here for **placement names** (see Rack placement) but never for
    rooms. `rackRoom` (the room whose rack panel is open) is still tracked for racks-mode
    state (it resets `selectedPlacement`), set on a racks-mode room click and cleared by
    `onPanelClosed()` / `show()`.
- `finish()` (branches: arrow draft → `_finishArrow`; else push room, open panel),
  `duplicateRoom(src)`, `deleteRoom(room)`,
  `loadNbRooms()` (cached), `openRoomPanel(room)` (NetBox Location autocomplete +
  datacenter checkbox + duplicate). `onPanelClosed()` clears the racks-mode active room
  and any `selectedArrow`.
- **Route arrows (wayfinding).** A floor record also holds `arrows` (see §5). The
  **Draw arrow** tool (`beginArrow` → `beginDraw(msg,'arrow')`) draws an open polyline;
  `_finishArrow()` drops a trailing duplicate point, needs ≥2 points, and pushes
  `{id,points,room,label,color}`. `_bindArrowDest(arrow)` auto-binds `room` to whichever
  room polygon contains the arrowhead (last point) — re-run on every node drag so it stays
  fresh. `_drawArrows(s,W,H)` renders each route (edit + view, **not** racks): a fat
  transparent `.arrow-hit` polyline (edit-only, for selection), the coloured `.arrow`
  polyline (constant width via non-scaling-stroke), an `.arrow-head` triangle
  (`Geom.arrowHead`, fixed `ARROW_HEAD_PX` layout px so it scales with the map), and the
  optional note at the start. The note is a `.arrow-label` drawn by `_drawArrowLabel` via the
  shared label engine (`_setLabelLines`/`attachLabel`): auto-placed just above `points[0]`, an
  optional `labelStyle` overrides position/font/size/rotation/colour/text, and it is rendered
  only when there is text (notes are optional). The selected arrow grows editable nodes via
  `drawVertices(...,{closed:false,minPts:2})` — suppressed while its label is being edited
  (`editingLabel === _labelKey(arrow)`). `selectArrow`/`openArrowPanel`
  (destination + note + `ARROW_COLORS` swatches + **Edit label** (when the note is non-empty,
  → `editArrowLabel` → `editingLabel` + `openLabelPanel`, returning to the arrow panel on
  Done) + delete)/`deleteArrow`; `handleKey` exits label-edit (Esc → arrow panel) then deletes
  (Delete/Backspace) or deselects (Esc) `selectedArrow` in edit mode. `deleteArrow`/
  `onPanelClosed` also clear `editingLabel`. The base
  `beginDraw` is overridden to also clear `selectedArrow`. View-mode arrows are inert
  (`pointer-events:none`) so room/datacenter clicks underneath still work.
- **Rack placement:** `drawPlacements(s,W,H)` draws a `.rack-marker`
  `translate(centre) rotate(rot)` `<g>` per placement. The glyph is a per-type
  `DeviceShapes.glyph(type,wpx,hpx)` (type via `DeviceShapes.typeFor` off the NetBox
  role/name; size = normalized `w×h`, else the type's `DeviceShapes.box` default) — in
  racks mode draggable with the centre **grid-snapped** (Alt frees) then
  `Geom.clampToPoly`; in view mode a NetBox link. `selectedPlacement` gets rotate
  (snaps to `ANGLE_STEP`°, Alt frees) + resize (grid-snapped, Alt frees) handles via
  `_placementHandles(g,s,p,W,H,wpx,hpx)` (both ride `Editor.dragItem`; resize un-rotates
  the pointer into the marker frame). The placement **name** is a separate label drawn by
  `_drawPlacementLabel` → the shared `Editor.attachLabel`/`openLabelPanel` — appended to
  the svg, **not** the rotated marker `<g>`, so it keeps its own rotation; handles
  suppressed on the marker while `editingLabel === p.uid`. Auto-placement is kind-aware:
  a **rack** name centers *inside* its box (`.rack-label.inside` — plain white, no halo)
  while a **device** name sits below the glyph (haloed `.rack-label`); a `labelStyle`
  overrides, and a moved label (custom `x/y`) drops `.inside` so it regains the halo. `openPlacementPanel(p,room)` (opened on marker
  pointerdown) shows the device + **Edit label** (`editLabel` → set `editingLabel=p.uid`,
  `openLabelPanel`) + Delete + Back-to-list. `_cacheItem(p)` resolves a placement to its
  `rackCache` entry (null = stale); `openRackPanel(room)` has a **Refresh racks** button
  (→ `netbox.syncRoom` + `store.reloadRackCache` + re-render) and lists the room's synced
  racks + unracked devices (click a row to place / remove); `placeItem(room,kind,item)`
  (drop at clamped centroid, assigns a `uid`, selects it), `removePlacement(p,room)`;
  `handleKey` deletes the selected marker (Delete/Backspace) / exits label-edit then
  deselects (Escape) in racks mode; `onPanelClosed` clears the marker/label selection.

### siteplan-editor.js — `SiteplanEditor extends Editor`
Shapes are **building hotspots**. `editing()`=`app.siteEdit`.
- `effectiveHotspots()` — PDF hotspots (from manifest) overridden by any user
  hotspot for the same `dir`, plus all user hotspots (`store.siteHotspots`).
- `show()` builds the map (`.map-viewport` → `.map-wrap`) + building **index**
  (`_legend(s)`) as a flex row, so the index stays put while the map pans/zooms
  beside it. The index has a live **search box** (`.legend-search`) above
  re-renderable rows (`renderRows(q)` filters numbered + trailer groups on
  name/code/dir; empty groups are dropped; `◌` = not placed on map). `_toolbar()`
  — Edit toggle; in edit: Add area/Undo/Right angle/Grid/Size/Move/Save (no Snap
  button — the siteplan editor always vertex/edge-snaps).
- `render()` draws hotspots. In **view mode** they get the `.view` class (invisible
  at rest, neutral grey fill on hover or when the index row is hovered); in **edit
  mode** PDF hotspots are dashed `.ref`, user hotspots `.user`. View click →
  `openBuilding`; edit click on a user hotspot → select + panel; edit click on a PDF
  hotspot → `promoteHotspot` (see below) then select + panel. The **selected**
  hotspot's `_drawLabel` is suppressed so the name doesn't obscure its
  vertices/edges while the polygon is being edited.
- **Editing PDF areas (promotion).** PDF/source hotspots are read-only geometry, so
  to reshape one it is *promoted* to a user hotspot on edit-click: `promoteHotspot(pdfHs)`
  deep-copies its `poly` (never mutate the manifest) into `store.siteHotspots` with the
  same `dir`/`name`, selects it, and opens its panel — `effectiveHotspots()` then hides
  the PDF original (same `dir`), so there is no duplicate and **Delete area** reverts to
  the PDF shape. Promotion is **not** marked dirty; `_promoted` holds the new id and
  `_discardCleanPromotion()` removes it again if the user navigates/Escapes/clicks away
  without editing (so an inspect-click never dirties `siteplan.json`). The first real
  edit commits it (cleared in `markDirty`). `handleKey` (Escape) and `deselect` both
  discard a clean promotion.
- `_drawLabel(s,hs,W,H)` centers the building **name** on the polygon bbox center
  (`Geom.bounds`, nudged inside concave shapes via `Geom.clampToPoly`) and
  auto-sizes it to fit: measured once at a reference size via `getBBox()`, then
  scaled analytically and clamped (7–22px), with the halo stroke kept proportional.
  Long names in roughly-square areas wrap to two lines (`_wrapLines`); areas too
  small for the name fall back to the short code. Font-size is set as an **inline
  style** (a CSS `font-size` rule would override an attribute). A user `labelStyle`
  (on `hs.ref`, the persistent store hotspot) **overrides** the centre (`x,y`, respected
  as-is — no inside-poly clamp), `size` (skips the auto-fit/wrap/code-fallback), `rot`,
  `font`, `color`, and the display `text` (its `\n`s are honoured and it is fit to the box;
  visual only — the building name is untouched). The text is centred at the group origin
  and handed to `Editor.attachLabel` (translate+rotate + edit handles). `render()` draws the label for
  the selected hotspot **when its label is being edited** (`editingLabel === hs.id`) and
  then suppresses that hotspot's vertices.
- **Editing a label:** `openHotspotPanel` adds an **Edit label** button → sets
  `editingLabel` and opens `Editor.openLabelPanel`. Editing a PDF hotspot's label first
  goes through `promoteHotspot` (the panel only opens on a user hotspot); the first
  `labelStyle` change calls `markDirty`, which commits the promotion. `onPanelClosed` /
  `deselect` / Escape clear `editingLabel`.
- `finish()` (push hotspot, open panel), `openHotspotPanel(hs)` (assign building /
  delete), `save()`.

### import-wizard.js — `ImportWizard` (not an Editor; a stage-takeover view)
The in-app PDF import, in three steps rendered into `#stage`. **Upload** (`_stepUpload`):
a `webkitdirectory` folder picker + a drag-drop zone (`_fromInput`/`_fromDrop` walk the
selection — `_fromDrop` uses `webkitGetAsEntry` recursion); each `.pdf` is POSTed raw to
`/api/import/upload?path=<building>/<file>` (folder = the file's parent dir). **Map**
(`_scanAndMap`/`_stepMap`): POSTs `/api/import/scan`, then `_modelFromInventory` builds an
editable per-folder model (name/slug/abbr defaults via `slugify`/`prettyName`/`initials`;
a folder matching `/site\s*plan/i` seeds the siteplan and contributes no floors, the rest
default to Level 1..N). Each PDF gets a thumbnail (click opens the full PDF) + a floor
control (Basement/Ground/Level/Roof/`same floor`); `_resolveFloors` turns the controls
into the `{stem: token}` table (a `same`-floor entry reuses the previous token → multi-page).
**Build** (`_build`): assembles `{siteplan, buildings}`, POSTs `/api/import/build`, then
`store.load()` + `router()` to land on the new map. `_reset` clears via `/api/import/reset`.
No modal helper exists, so each step replaces `#stage`. See §10 *In-app import*.

### app.js — `App` (orchestrator + entry)
Owns singletons `store`, `netbox`, `grid`, and cross-view state `mode`
(floor `'edit'|'view'|'racks'`), `siteEdit`, `highlight`, plus `current` (active
Editor or null).
- `init()` → `store.load()` then `_bindGlobal()` + `router()`.
- `router()` parses the hash: `#/import` → `showImport()`, `#/settings` →
  `showSettings()`, `#/b/<dir>` → `renderBuilding()`, `#/f/<dir>/<fid>` → `showFloor()`,
  `#/` → `showSiteplan()`. **With no facility imported (`!store.hasContent()`) the home
  default is `showImport()`** instead of the siteplan.
- `showImport()` = the `ImportWizard` (no editor; `current=null`).
- `renderBuilding(dir)` = floor-card grid (no editor; `current=null`).
- `showSettings()` = settings view (no editor): an **Import a facility from PDFs** button
  (→ `#/import`) plus a note. Rack inventory syncs per room from the floor's Place-racks
  panel, so nothing rack-related is here.
- Chrome: `crumbs(items)`, `setToolbar(nodes)`, `closePanel()` (calls
  `current.onPanelClosed()` if present — e.g. to restore the racks-mode room label),
  `go(hash)`.
- `_bindGlobal()` wires the persistent `#settings-gear` button (→ `#/settings`),
  panel close, `beforeunload` (warns on `store.hasUnsaved()` — tab close/refresh),
  `hashchange`, and global `keydown` → `current.handleKey`. The `hashchange` handler
  **guards in-app navigation**: when `store.hasUnsaved()` it shows a native `confirm()`
  before routing; OK discards + proceeds, Cancel reverts `location.hash` to the
  last-committed value (`_navHash`) so the user stays put. This single chokepoint covers
  every page change (crumbs, hotspots, floor cards, gear, `go()`, Back/Forward) — mode
  toggles don't change the hash, so they keep their dirty edits and are not intercepted.
  `_revertingHash` swallows the synthetic `hashchange` the revert itself fires. State:
  `_navHash` (last-committed hash), `_revertingHash` (revert-in-progress flag).

---

## 4. Backend class reference

### preprocess.py — `Preprocessor` (the import render engine)
Renders uploaded PDFs into `images/` + `manifest.json`. Stdlib + `pypdfium2`/`Pillow`;
the **server spawns it as a subprocess**, so those deps never load into the server.
`__init__(script_dir)` resolves `source` (= `uploads/`), `images_dir`, `manifest_path`,
`import_map_path`, `stub_path`. Class data: `RENDER_SCALE` (2.0, full plans),
`THUMB_SCALE` (0.6, wizard thumbnails), `THUMBS_DIRNAME` (`.thumbs`).

The floor PDFs have **no text layer** (every label is vectorized), so a PDF's floor is
**data, not inferred** — it comes from `import-map.json`, which the wizard writes.

- **Rendering:** `render_pdf_full(pdf)` → `(raw_png, w, h)` for page 1 at `RENDER_SCALE`
  (page rotation honored; no target size — it is the *source* of the image).
  `render_pdf_thumb(pdf, out)` writes a small PNG at `THUMB_SCALE` for the wizard grid.
  `write_image(rel_dir, id, raw)` saves under `images/<rel_dir>/<id>.png` and returns the
  manifest-relative path.
- **Labels:** `floor_label(token)` maps a floor token to a label (`b3`→"Basement 3",
  `g`→"Ground", `gl1`→"Ground / Level 1", `l1`→"Level 1", `r`→"Roof").
- **Discovery:** `dwg_sort_key(stem)` orders drawings by number, keeping a `-N`
  second-sheet suffix after its base (`26024 < 26024-2 < 26025`). `pdf_files(folder)` →
  `(stem, filename)` in that order. `building_folders()` lists the top-level folders in
  `uploads/` (skips `.thumbs`).
- **Import map:** `load_import_map()` reads `import-map.json`; `building_lookup(imap)`
  indexes its `buildings` by both folder name **and** `slug`.
- **Assembly:** `build_building_from_pdfs(folder, entry)` looks up each PDF's floor token
  in the entry's `floors` table, **groups PDFs sharing a token into one multi-page floor**
  (ordered by drawing number; floor id = `abbr`+token, label via `floor_label`, pages
  written `<id>.png`/`<id>-2.png`/…), and returns `(building, unmapped_stems)`.
  `build_siteplan_from_pdf(imap)` renders the map's `siteplan.pdf` as the background with
  **`hotspots: []`** (drawn in the tool). `write_stub(unmapped)` emits
  `import-map.stub.json` (drawings with no token, blank, to fill in).
- **Modes (`__main__` dispatch on `argv[1]`):**
  - `scan` — render a thumbnail per PDF and **print a JSON inventory** to stdout
    (`{folders:[{folder, pdfs:[{file,stem,thumb,pdf}]}]}`); progress on stderr. Drives the
    wizard's mapping step.
  - `build` (default) — read `import-map.json`, render every mapped PDF, write
    `manifest.json` (buildings with zero floors are dropped); summary on stderr.

### server.py
- **`Config`** — loads `config.json` (`netbox_url`, `token`, `port`, `ssl_ctx`).
- **`NetBoxProxy`** — `_get(path,params)` (sends `Authorization: Token …`),
  `_trim(loc)` (→`{id,name,slug,url(=display_url),depth}`),
  `_trim_rack(r)` (→`{id,name,url,u_height}`), `_trim_device(d)`
  (→`{id,name,url,role:{slug,name}|null,device_type:{model,u_height}|null}` — `role` is
  NetBox 4.x / `device_role` 3.x; the marker glyph keys off it),
  `site_id(slug)` (cached), `rooms(site,floor)` (floor Location's children, else all
  site Locations), `locations(site,q)`, `racks(location_id)`
  (`/api/dcim/racks/?location_id=`), `unracked_devices(location_id)`
  (`/api/dcim/devices/?location_id=&rack_id=null`).
- **`JsonStore`** — `load()` / `save(data)` (atomic temp-replace, prior kept as
  `.bak`). Six instances: annotations, siteplan, rackcache (regenerable),
  placements, pagelayouts, importmap.
- **`Handler(BaseHTTPRequestHandler)`** — deps injected as class attrs
  (`root, proxy, annotations, siteplan, rackcache, placements, pagelayouts, importmap`).
  `_sync_room(data)` merges one Location's racks/devices into `rackcache.json`.
  **In-app import** (rendering via a `preprocess.py` subprocess, so the server stays
  stdlib-only): `_save_upload(rel)` writes one uploaded PDF's raw body into `uploads/<rel>`
  (`_safe_join` rejects traversal; `.pdf` only); `_run_preprocess(mode)` spawns
  `python3 preprocess.py <mode>` under the module-level `IMPORT_LOCK` (scan returns its
  stdout inventory, build returns its stderr log); `_import_build(data)` saves the posted
  import map then runs build; `_import_reset()` deletes `uploads/`, `images/`,
  `manifest.json`, and the map. `GET /manifest.json` returns an empty manifest when none
  is built yet. Routes below.
- **`ToolServer`** — wires deps onto `Handler`, runs `ThreadingHTTPServer`.

### Routes
| Method | Path | Handler |
|---|---|---|
| GET | `/` | `web/index.html` |
| GET | `/web/*`, `/images/*`, `/uploads/*` | static (each confined to its subdir; `Handler.CONTENT_TYPES` maps `.html/.js/.css/.png/.json/.woff2/.pdf`; uploads paths are URL-unquoted) |
| GET | `/manifest.json` | the built manifest, or `{"siteplan":null,"buildings":[]}` when none exists yet |
| GET | `/api/annotations` · POST | `JsonStore` load / save |
| GET | `/api/siteplan` · POST | `JsonStore` load / save |
| GET | `/api/rackcache` | `JsonStore` load (written by sync) |
| GET | `/api/rackplacements` · POST | `JsonStore` load / save |
| GET | `/api/pagelayouts` · POST | `JsonStore` load / save |
| GET | `/api/netbox/rooms?site=&floor=` | `NetBoxProxy.rooms` |
| GET | `/api/netbox/locations?site=&q=` | `NetBoxProxy.locations` |
| GET | `/api/netbox/racks?location=` | `NetBoxProxy.racks` |
| GET | `/api/netbox/devices?location=` | `NetBoxProxy.unracked_devices` |
| POST | `/api/netbox/sync-room` | `Handler._sync_room` |
| POST | `/api/import/upload?path=<rel>` | `_save_upload` (raw PDF body → `uploads/<rel>`) |
| POST | `/api/import/scan` | `_run_preprocess('scan')` → thumbnails + inventory |
| POST | `/api/import/build` | `_import_build` (save map, render images + manifest) |
| POST | `/api/import/reset` | `_import_reset` (clear uploads/images/manifest/map) |

---

## 5. Data models

**manifest.json** (generated by `preprocess.py build`; absent until a facility is
imported, when the server serves `{"siteplan":null,"buildings":[]}`):
```jsonc
{ "siteplan": null |                                        // null when no siteplan PDF chosen
    { "image","w","h","siteSlug":"00-site", "hotspots":[] },  // import always emits hotspots:[]
  "buildings":[ {"code","dir","name","siteSlug",            // dir/siteSlug == the building slug
    "floors":[ {"id","label","floorSlug","image","w","h",   // floorSlug == id; image/w/h == pages[0]
      "pages":[ {"image","w","h","caption":null} ]} ]} ] }  // 1+ sheets sharing a floor token
```
**import-map.json** (written by the import wizard / `_import_build`; the floor mapping):
```jsonc
{ "siteplan": null | {"folder","pdf","slug":"00-site"},       // which uploaded PDF is the site map
  "buildings": { "<upload-folder>": {                        // key = uploads/ sub-folder name
    "slug","name","abbr",                                    // slug = NetBox site slug; abbr = floor-id prefix
    "floors": { "<drawing-stem>": "<token>" } } } }          // token: b3 / g / l1 / r / gl1 …
```
**annotations.json** (edited):
```jsonc
{ "<dir>/<floorId>": { "image","w","h",
    "rooms":[ {"id","label","polygon":[[nx,ny]...],
      "location":{"id","name","slug","url"}, "datacenter":bool } ],
    "arrows":[ {"id","points":[[nx,ny]...],   // open polyline (≥2), wayfinding route
      "room":"<roomId|null>",                 // destination room under the arrowhead (auto)
      "label":"", "color":"#066fd1",          // note shown at the start; route colour
      "labelStyle":{…}? } ] } }               // optional note-label override (x/y/rot/size/font/color/text)
```
Rooms are not labelled (the floor images already print room names/numbers); a
`labelStyle` left on an old room record is ignored. An **arrow**, however, may carry an
optional `labelStyle` (same shape as a siteplan hotspot's) overriding its note label —
absent → auto-placed just above the start. `arrows` is optional and
back-filled to `[]` on load (`Store.floorData`); a floor with arrows but no rooms is
still persisted (`saveAnnotations` prunes only when **both** are empty). Arrow points
share the rooms' combined-normalized coordinate space (§6).

**siteplan.json** (edited):
`{ "hotspots":[ {"id","dir","name","poly":[[nx,ny]...],"labelStyle":{…}?} ] }`

`labelStyle` (optional, on a siteplan hotspot) overrides the auto-placed building label:
`x,y` = label-centre (normalized 0..1), `rot` = degrees CW, `size` = font-size px, `font` =
CSS family (from `LABEL_FONTS`), `color` = `#rrggbb`, `text` = **display-only** label string
(its `\n`s become line breaks; purely visual — it does **not** change the bound `name`). Any
absent field falls back to the auto behavior; absent `labelStyle` = fully automatic
(back-compat — guard reads with `?.`).

**rackcache.json** (generated by sync; regenerable):
```jsonc
{ "syncedAt": "<iso8601>|null",
  "locations": { "<locationId>": { "name",
    "racks":[ {"id","name","url","u_height"} ],
    "devices":[ {"id","name","url",                         // devices = unracked in that location
      "role":{"slug","name"}|null,                          // NetBox role → marker glyph type
      "device_type":{"model","u_height"}|null} ] } } }       // (both null when NetBox omits them)
```
**rackplacements.json** (edited; floors with no placements pruned on save):
```jsonc
{ "<dir>/<floorId>": { "placements":[
    {"id":<rackOrDeviceId>,"kind":"rack"|"device","room":"<roomId>",
     "loc":<locationId>,"x":nx,"y":ny,"label","uid",
     "rot":deg?,"w":nw?,"h":nh?,"labelStyle":{…}?} ] } }   // x,y,w,h normalized 0..1; rot degrees CW
```
`rot`/`w`/`h` are optional — absent on an un-rotated, default-sized marker. `uid` is a
stable per-placement key (the label engine keys off it; the NetBox `id` collides across
racks/devices) — lazily back-filled on old records. `labelStyle` (optional, same shape as a
siteplan hotspot's) overrides the auto-placed name label (x/y/rot/size/font/color/text).

**pagelayouts.json** (edited; a default vertical-stack grid is pruned on save):
```jsonc
{ "<dir>/<floorId>": { "grid": [ [col,row], ... ] } }   // one [col,row] per sheet, in page order
```
Each entry places a multi-sheet floor's sheets into a uniform grid (cell = max sheet
w×h). Absent (or pruned) = the default vertical stack (`col 0, row = page index`).
`Store.floorLayout` resolves this into the combined canvas (§3); rearranging remaps room
+ placement coords so each shape follows its sheet (§6).

---

## 6. Coordinate systems (critical)

- **Stored coordinates are always normalized 0..1** to the drawing surface →
  resolution independent. SVG overlays use `preserveAspectRatio:none` at 100%×100% of
  the `.map-wrap`, so `nx*clientWidth` maps correctly at any zoom. For a **multi-sheet
  floor** that surface is the whole tiled grid of sheets (`Store.floorLayout`): the
  sheets share one coordinate space spanning the combined canvas — e.g. with the default
  vertical stack a room on the lower sheet has `ny` in `[0.5,1]`.
  `dispSize()` reads the wrap, not one image, so this is automatic at any arrangement.
  **Rearranging** sheets (Arrange mode) changes the canvas, so `FloorEditor._remapLayout`
  re-projects every room/placement from its old cell into its sheet's new cell, keeping
  shapes on their own sheet.
- **Viewport (pan/zoom)** is a CSS `translate+scale` transform that `PanZoom`
  applies to the `.map-wrap` (an ancestor of the svg). It is purely visual:
  `dispSize()`/`render()` keep working in unscaled **layout px** (the svg's own box),
  and the transform scales the result. Pointer math survives because `evtNorm`
  reads `svg.getBoundingClientRect()`, which reflects the transform — so **never**
  rewrite `evtNorm` in terms of `clientWidth`. Screen→content deltas (grid move,
  snap/close radii) must divide by `viewport.scale`; vertex/`dragItem` drags use
  `evtNorm` and need no correction. Pan/zoom require **no `render()`** — the
  compositor scales the existing SVG. To keep node markers a constant on-screen
  size at any zoom, `PanZoom.apply()` publishes `--inv-scale` (= `1/k`) on the
  wrap and CSS counter-scales the vertex/snap-cursor circle radii via
  `r: calc(<base>px * var(--inv-scale))` — the radius analogue of
  `non-scaling-stroke`, and likewise needing no `render()` on zoom. The zoom-out
  **floor** is ½ the view's opening zoom (so a single-sheet floor shrinks to half the
  viewport), and `clamp()` lets any map edge/corner be panned to the viewport
  **centre** — so an edge feature can be brought to mid-screen to inspect (`PanZoom`).
- **Grid** is defined in **intrinsic image px** (manifest `w`/`h`, e.g. 2449×1585)
  so cells stay square and stable; converted to display px at render time.
- **Siteplan hotspots** are all **user-drawn** in the tool (normalized 0..1 over the
  siteplan image, like any polygon); the import produces a siteplan with `hotspots: []`.
  There is no hotspot-import coordinate conversion.

---

## 7. NetBox model relied upon

Nested Locations: **Site (building) → Location (floor) → Location (room)**.
- Building **`slug`** (set in the import wizard) **==** site slug. The siteplan maps to
  site `00-site`.
- Floor id (prefix + token, e.g. `a1b3`) **==** floor Location slug where one exists;
  rooms are that floor Location's children. When a floor slug has no Location (e.g. a
  combined `gl1` floor), the proxy returns all site Locations and the
  UI shows a warning. A **multi-sheet floor** is still one floor: all its sheets
  share the single `floorSlug` (= the file id), so either sheet resolves the same
  NetBox floor Location; only the page ids differ (`<id>` / `<id>-2`).
- REST auth header is **`Token …`**, not `Bearer`. The web link is `display_url`.
- **Racks/devices** (`/api/dcim/racks/`, `/api/dcim/devices/`) attach to a Location
  by `location_id` (the room Location id stored in `room.location.id`). A rack's
  racked devices are excluded from "unracked" by the `rack_id=null` filter.

---

## 8. Common runtime flows

- **Boot:** `App.init` → `Store.load` (manifest/annotations/siteplan/rackcache/
  rackplacements/pagelayouts) → `router`.
- **Arrange sheets (multi-sheet floor):** edit mode → **Arrange sheets** → drag a
  `.sheet-tile` to a grid cell (drop on another to swap) → `_commitSheetMove` updates
  `Store.layouts` + `_remapLayout`s rooms/racks → **Save** → `Store.saveLayouts` → POST
  `/api/pagelayouts`. First view of such a floor opens framed on sheet 1 (`fitRegion`).
- **Draw a room:** `FloorEditor.beginDraw` → clicks add snapped points
  (`Editor.snapPoint`) → close → `finish()` pushes a room and opens
  `openRoomPanel` → pick a NetBox Location → `Store.markDirty` → **Save** →
  `Store.saveAnnotations` → POST.
- **Draw a route arrow (wayfinding):** Edit mode → **Draw arrow** → click points along
  the path, ending inside the destination room → Enter/double-click → `_finishArrow`
  pushes an arrow, auto-binds its destination, opens `openArrowPanel` (note + colour) →
  reshape via nodes → **Save** → `Store.saveAnnotations` → POST. Shows in view mode as an
  inert route overlay.
- **Place a building hotspot:** `SiteplanEditor` (Edit areas) → draw → assign
  building in `openHotspotPanel` → Save siteplan → POST `/api/siteplan`.
- **Navigate (view):** siteplan hotspot / index → building floor grid → floor; in
  view mode a room click opens `location.url`.
- **Place racks:** Edit mode → **Place racks** toggle → click a datacenter room →
  `openRackPanel` → **Refresh racks** → POST `/api/netbox/sync-room` → server fetches
  that Location's racks + unracked devices and merges them into `rackcache.json` →
  `Store.reloadRackCache` → the panel lists its racks/devices → click a row → `placeItem` drops a
  per-type `DeviceShapes` glyph at the room centroid → drag to move (**grid-snapped**, Alt
  frees, then `Geom.clampToPoly`); on the selected marker the top handle **rotates**
  (snaps to `ANGLE_STEP`°) and the corner **resizes** (grid-snapped), and its **Edit
  label** panel restyles the name via the shared label engine → **Save** →
  `Store.savePlacements` → POST `/api/rackplacements`. The grid (toggle/size/move) is
  available in racks mode via `gridActive()`. In view mode the markers render with their
  stored glyph/rotation/size + styled label as read-only NetBox links.

---

## 9. Extending the tool (recipes)

- **New shared drawing behaviour** → `Editor` (both editors inherit).
- **New room field** → add in `FloorEditor.finish`/`openRoomPanel`, render in
  `FloorEditor.render`, document the schema in §5. Old records lack it → guard
  with `!!room.field`.
- **New per-floor annotation entity** (like `arrows`) → store it as a sibling array on
  the floor record, back-fill it in `Store.floorData`, keep it on save in
  `Store.saveAnnotations` (loosen the empty-floor prune), draw it in `FloorEditor.render`,
  and remap it in `_remapLayout` if its coords are in the combined space. No server change
  (`JsonStore` round-trips arbitrary JSON).
- **New draft shape that isn't a closed polygon** → pass a `kind` to `beginDraw`, branch
  `finish()`, and edit nodes with `drawVertices(...,{closed:false,minPts})` (arrows are the
  worked example).
- **New API/persistence** → add a `JsonStore` (or `NetBoxProxy` method) + a route
  in `Handler`; expose via `Store`/`NetBoxClient`; never put the token in the
  browser.
- **New view** → add a branch in `App.router` and a `show*`/`render*` method.

After any such change, update §2–§8 here and the relevant `CLAUDE.md`/`README.md`.

---

## 10. Invariants / gotchas

This is the **single source of truth** for the project's gotchas (the local
`CLAUDE.md` points here rather than restating them). Section references below point
at the deep treatment.

### Foundations

- Frontend is **vanilla JS, no dependencies, no build**; backend is **stdlib-only
  Python 3**. The one approved exception is `preprocess.py`'s `pypdfium2` + `Pillow`
  (PDF rendering, §4) — the **server stays stdlib-only** by invoking `preprocess.py` as a
  **subprocess** (`Handler._run_preprocess`), never importing it. Keep it that way: do not
  `import preprocess` (or pypdfium2/Pillow) from `server.py`.
- The tool **ships with no facility content** — no committed drawings, images, manifest,
  or import map; everything is created by an in-app import and is gitignored. Don't
  reintroduce facility data or facility-specific names into the code.
- `config.json` holds a live API token — never commit it, log it, return it to the
  browser, or paste it into chat. The browser reaches NetBox **only** through the
  server proxy.
- NetBox REST auth is `Authorization: Token …`, **not** `Bearer` (§4, §7).
- Generated files (`images/`, `manifest.json`, `rackcache.json`) are reproducible
  (`rackcache.json` per room from Place racks → Refresh racks); edited files
  (`annotations.json`, `siteplan.json`, `rackplacements.json`, `pagelayouts.json`)
  are user data — never clobber them blind; saves already keep a `.bak`. A floor
  with arrows but no rooms must still persist (`annotations.json` holds both, §5).
- Coordinates are stored **normalized 0..1** to the image — keep them
  resolution-independent (§6).
- `App.mode` has **three** values (`'edit' | 'view' | 'racks'`); anything reading it
  must tolerate all three (`editing()` is strictly `'edit'`; `gridActive()` is edit
  **or** racks — relax gates through that hook, not ad-hoc `mode==='racks'` checks).
- Restart `server.py` after editing it (static files and JSON are read per-request,
  but Python classes load once).
- Web fonts are **bundled** under `web/fonts/` (no CDN) so the tool works offline;
  keep it that way. SIL OFL — licence in `web/fonts/OFL.txt`.

### Coordinates & slugs

- Siteplan hotspots are **user-drawn** and normalized 0..1 over the siteplan image; the
  import never imports hotspots (`hotspots: []`). No screen-px/pt conversion exists.
- A building's NetBox **site slug** is the `slug` the user set in the wizard (stored in
  `import-map.json`); floor ids = floor-id prefix (`abbr`) + token and equal floor
  **Location slugs** where they exist (§7). Load-bearing for room→Location binding.

### In-app import (wizard + preprocess subprocess)

- The floor PDFs have **no text layer** — every label is a vectorized path, so nothing can
  read the building/floor off a sheet. Floor identity is **assigned by the user** in the
  wizard and stored in `import-map.json` as a `{drawing-stem: floor-token}` table. Don't
  try to OCR or text-extract the sheets.
- **Two drawings sharing a floor token = one multi-page floor** (ordered by drawing
  number) — that is how stacked sheets of one floor group. In the wizard the *“same floor
  (extra sheet)”* control reuses the previous token; in the map it's just the same token.
- Rendering is a **subprocess**: `Handler._run_preprocess` spawns `preprocess.py scan|build`
  under `IMPORT_LOCK` (serialized). `scan` prints its inventory JSON to **stdout** (so keep
  progress on **stderr**, or the server's JSON parse breaks); `build` reads `import-map.json`
  and writes `manifest.json` (buildings with zero floors are dropped).
- Uploads land in `uploads/<building>/<file>.pdf` via raw-body POST (no multipart);
  `_save_upload`/`_safe_join` confine writes to `uploads/` and accept `.pdf` only.
  `RENDER_SCALE`/`THUMB_SCALE` set pixel size only — coords are normalized, so changing
  them is safe. After a build the client must `store.load()` (manifest is cache-busted).

### Multi-sheet floors

- A floor can have **multiple sheets** (`manifest` floor `pages[]`; e.g. one floor drawn
  across two plans, assigned the same floor token in the import), **tiled into a grid** by
  `Store.floorLayout` (the one place sheet geometry is resolved; default = vertical
  stack). They render as one floor view in a **single normalized coordinate space**
  spanning the whole canvas — so `Editor.dispSize` reads the `.map-wrap`, never a lone
  `<img>`. All sheets share one `floorSlug`; only page image ids differ (`<id>`/`<id>-2`).
- **Arrange sheets** mode drags sheets between cells; the arrangement persists in
  `pagelayouts.json` and `FloorEditor._remapLayout` re-projects existing rooms/racks so
  each shape follows its sheet. First view of a multi-sheet floor opens framed on sheet 1
  (`PanZoom.fitRegion`, via `initialFocus`). See §3 `floor-editor.js`.

### Node editing (`Editor.drawVertices`)

- `drawVertices(...,opts)` owns **node editing** for every editor (drag a `.vertex` to
  reshape, drag a `.vertex.midpoint` to add a node, right-click a vertex to remove it
  ≥`opts.minPts`). Add/remove fire on **button 0 only** so right-click and background pan
  don't collide — keep those guards.
- A vertex/marker press only becomes an edit past the **drag threshold**
  (`Editor._pastDragThreshold`, ≥4px, like pan): below it the press is a select/inspect
  click that moves nothing and **must not** mark the store dirty (a stray click flipping a
  dirty flag falsely fires the unsaved-work nav guard). Any new `dragVertex`/`dragItem`
  drag must mutate + `markDirty` only inside its `move()` (which the gate controls), never
  on `pointerdown`.
- `opts.closed` (default true) is for closed polygons (rooms, hotspots); route **arrows**
  pass `{closed:false,minPts:2}` for an open polyline — `closed` rides the `dragVertex`
  record so the move handler picks non-wrapping neighbours. Arrows draw in edit + view (not
  racks); their view-mode overlay is `pointer-events:none` so room clicks beneath register.

### Label engine

- The shared label engine lives in `Editor` (`attachLabel` / `_drawLabelHandles` /
  `openLabelPanel`, state `editingLabel`). It is shape-kind agnostic via two hooks:
  `_labelKey(shape)` (identity — base `shape.id`) and `_labelDirty(shape)` (dirty channel —
  base `markDirty`). Always mutate the **persistent** shape (the siteplan hotspot's
  `hs.ref`, **not** the `effectiveHotspots` copy; the placement record itself), and keep the
  event arg on `dragItem.move(nx,ny,e)` (Alt bypasses snapping).
- **Building** labels (siteplan only) are user-editable via an optional `labelStyle`
  (`{x,y,rot,size,font,color,text}`) — move, rotate-snapped to `ANGLE_STEP`°,
  resize→font-size, font from `LABEL_FONTS`, colour, and a **display-only** `text` whose
  `\n`s set line breaks (it never changes the bound name).
- **Floor rooms are NOT labelled** — the floor-plan images already print room
  names/numbers (a stray `labelStyle` on an old room record is ignored). But **rack/device
  placements and route-arrow notes are**: `FloorEditor` overrides `_labelKey` →
  `shape.uid || shape.id` (placements key off `uid`; the NetBox `id` collides across
  racks/devices) and `_labelDirty`, which **branches** — arrows (`.points`) → `markDirty`
  (annotations), placements → `markPlacementsDirty`.

### Siteplan hotspots

- PDF hotspots are read-only geometry: editing one **promotes** it to a user hotspot
  (`SiteplanEditor.promoteHotspot`) that overrides the PDF original — **never mutate the
  manifest `poly`** (it is deep-copied). A promote that is never edited is discarded
  (`_discardCleanPromotion`) so a stray click can't dirty `siteplan.json` (§3).

### Racks / device shapes

- **Place racks is not a bare screen:** the grid (toggle/size/move) works there via
  `gridActive()`. Marker move grid-snaps then clamps to the room; the rotate handle snaps
  to `ANGLE_STEP`°; the resize handle grid-snaps — all with **Alt** to bypass. Marker
  **glyphs** come from `DeviceShapes` (`web/device-shapes.js`), keyed off the device's
  NetBox `role` (with a device-name keyword fallback) — re-run **Refresh racks** after
  touching `server.py._trim_device` to repopulate roles in `rackcache.json`.

### Pan / zoom

- `PanZoom` is a CSS transform on `.map-wrap`, purely visual. Keep `Editor.evtNorm`
  reading `getBoundingClientRect()` (never `clientWidth` math) so coordinates survive the
  transform, and divide screen→content deltas (grid move, snap/close radii) by
  `viewport.scale`. Don't call `render()` on pan/zoom — the compositor scales the existing
  SVG (§6).

### Theming

- UI is a light "CAD" theme driven by `:root` tokens in `web/style.css`; reskin via those
  tokens, never rename the JS-load-bearing class names (§11).

---

## 11. UI design system (light theme)

Adopted from the `tool/Template` mockup. Single hand-written `style.css`, no
framework. All colours/spacing are CSS custom properties on `:root`; reskinning is
mostly a matter of editing those tokens.

- **Palette:** `--bg #f4f5f7` canvas, `--panel #fff` surfaces, `--accent #066fd1`
  (blue) primary, `--success #2fa84f` green, `--warn`/`--danger` for selected/error.
  Borders `--line`/`--border-strong`; text `--text`/`--text2`/`--muted`/`--faint`.
- **Type:** `--ui` = Public Sans (UI), `--mono` = IBM Plex Mono (codes, counts,
  badges, sheet stamp). Both bundled locally (see §10).
- **Buttons:** flex icon+label; idle (white/`--border-strong`), `.active`
  (blue tint), `.primary` (solid blue Save), `.danger` (red). `#toolbar .tb-div`
  vertical dividers group controls. SVG icons come from `Icons` (§3).
- **Status:** `.badge` (saved → green check / `.dirty` → amber "● unsaved");
  floor-card `.cnt.mapped` (green pill) / `.cnt.unmapped` (grey pill) /
  `.cnt.sheets` (blue pill, shown when a floor has >1 stacked sheet).
- **SVG drawing layer (over a light image):** blue = PDF/source hotspots &
  datacenter `.room.dc`; green = user hotspots & bound `.room`; `--warn` =
  selected/draft; `--danger` = `.unbound`. In siteplan **view mode** hotspots are
  `.hotspot.view` — invisible at rest, neutral grey fill on `:hover`/`.hot` (index
  hover). `.grid-line` is **dark** translucent (visible on the light canvas).
  `.hotspot-label` uses a solid **black** fill with a white halo (chosen for legibility
  when the siteplan is zoomed to fit); `.page-caption` uses white fill with a dark halo
  (readable on any drawing); `.page-caption` (mono, larger) headers each sheet of a
  multi-page floor at its top edge. Floor rooms carry no label (the images already print
  room names/numbers — §3). **Route arrows** (`.arrow`/`.arrow-head`/`.arrow-label`,
  wayfinding) take their colour inline from `ARROW_COLORS`; the `.arrow` stroke is
  non-scaling (constant width) while the `.arrow-head` triangle scales with the map, and a
  fat transparent `.arrow-hit` line (edit-only, dropped while drawing/grid-adjusting) is
  the click target. The `.arrow-label` note rides the shared label engine (wrapped in a
  `.label-grp`, with the same drag/rotate/resize `.label-handle`/`.label-stem` while edited).
  `.hotspot-label` has **no fixed font-size** — `SiteplanEditor._drawLabel` sets
  size and halo width inline per polygon (§3). It is wrapped in a
  `.label-grp` group (translate+rotate); while a label is being edited its `.label-handle`
  (rotate/resize) + `.label-stem` (amber, like the rack handles) appear and the `<text>`
  becomes draggable. `.rack-marker` (per-type `DeviceShapes` glyphs inside rooms) is
  built from `.dev-body` (unit outline — blue for racks, `--text2` grey for `.device`,
  dashed faint for `.stale`), `.dev-line` (white rails/bays), `.dev-port` (white
  ports/outlets), `.dev-led` (green dots); the marker's name is a separate `.rack-label`
  (white-haloed, font/size/colour from its `labelStyle`). `.rack-handle` (rotate/resize)
  and `.rack-stem` are amber. Polygon edit handles: `.vertex`
  (white/amber, draggable) plus `.vertex.midpoint` (translucent accent edge-centre
  handles that insert a node — see `Editor.drawVertices` §3). The right-angle snap
  indicator is amber too: `.ortho-guide` (dashed line along each locked edge) and
  `.ortho-corner` (a small square corner glyph at a true 90° corner), drawn while
  **drawing** a polygon or dragging a node with right-angle snap engaged
  (`Editor._drawOrthoGuide` §3).
  **Arrange mode** (multi-sheet floors): `.sheet-grid` (dashed cell outlines),
  `.sheet-tile` (blue, draggable; `.dragging` = amber) with a mono `.sheet-tile-label`,
  and `.sheet-drop` (green dashed drop-target). Floor sheets are `img.sheet`
  (absolutely positioned at their grid cell; the siteplan keeps the flow `img`).
- **Map viewport:** `.map-viewport` is the clip box (`overflow:hidden`) that fills
  the stage (floor) or the flex map column (siteplan); the `.map-wrap` inside it is
  pan/zoomed via a CSS transform. The `.zoom-ctl` cluster (+/−/fit, bottom-right)
  reuses the standard `button` look. Drawing strokes (`.grid-line`, `.room`,
  `.hotspot`, `.draft`, `.vertex`, `.rack-marker .dev-body`, `.rack-marker .dev-line`,
  `.label-handle`, `.label-stem`)
  use `vector-effect:non-scaling-stroke`
  so line weights stay constant while geometry scales with zoom; node markers
  (`.vertex`, `.snap-cursor`) likewise hold a constant on-screen radius via
  `r: calc(<base>px * var(--inv-scale))`, where `--inv-scale` (= `1/k`) is set on
  the wrap by `PanZoom.apply()`. Cursors: `.map-wrap`
  is `grab`, `svg.panning` is `grabbing`, `svg.draw-active` is `crosshair`.
- Class names are load-bearing (the JS builds DOM with them) — restyle freely but
  do not rename. See `CLAUDE.md` for the full list.
