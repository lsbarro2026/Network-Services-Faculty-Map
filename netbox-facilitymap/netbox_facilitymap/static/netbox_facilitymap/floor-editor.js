'use strict';
/* floor-editor.js — FloorEditor: draw/edit room polygons on a floor image and
   bind each to a NetBox Location. In view mode rooms are invisible clickable
   zones (rooms holding rack/device markers stay highlighted). Extends Editor for
   the shared engine. */

class FloorEditor extends Editor {
  constructor(app, building, floor) {
    super(app);
    this.building = building;
    this.floor = floor;
    this.netbox = app.netbox;
    this._badge = null;
    this.selectedPlacement = null;   // rack/device marker showing rotate/resize handles
    this.selectedArrow = null;       // route arrow showing editable nodes / panel
    this.rackRoom = null;            // room whose rack panel is open
    this.arranging = false;          // Arrange mode: drag sheets into grid cells
    this.dragSheetState = null;      // { page, target:[col,row] } during a sheet drag
    this.layout = null;              // display geometry (padded while arranging)
    this.baseLayout = null;          // the floor's true (unpadded) sheet geometry
    this._peeked = false;            // first mount frames sheet 1 (peek), later shows full-fit
    this._switchingMode = false;     // guards onPanelClosed while _switchMode closes the panel
  }

  // ---- Editor hooks ----
  data() { return this.store.floorData(this.building.dir, this.floor.id); }
  polys() { return this.data().rooms; }
  editing() { return this.app.mode === 'edit'; }
  // The grid + its move/resize are also available while placing racks (where
  // editing() is false), so markers can snap to it like room nodes do in edit mode.
  gridActive() { return this.editing() || this.app.mode === 'racks'; }
  markDirty() { this.store.markDirty(); this._setBadge(); }
  markPlacementsDirty() { this.store.markPlacementsDirty(); this._setBadge(); }
  // The shared label engine serves rack/device placements and route-arrow notes
  // here (floor rooms stay unlabelled). A placement is keyed by its own `uid` — the
  // NetBox `id` collides across racks/devices; an arrow falls back to its `id`. Label
  // edits dirty the store the shape lives in: arrows (`.points`) are annotations,
  // placements the placement store.
  _labelKey(shape) { return shape.uid || shape.id; }
  _labelDirty(shape) { if (shape.points) this.markDirty(); else this.markPlacementsDirty(); }
  deselect() {
    if (!this.selected && !this.selectedArrow) return;
    this.selected = null; this.selectedArrow = null; this.editingLabel = null;
    this.render(); this.app.closePanel();
  }

  /** The save badge tracks placements in racks mode, rooms + sheet layout otherwise. */
  _dirty() {
    return this.app.mode === 'racks'
      ? this.store.placementsDirty
      : (this.store.dirty || this.store.layoutDirty);
  }
  _setBadge() {
    if (!this._badge) return;
    const dirty = this._dirty();
    this._badge.innerHTML = this.badgeHtml(dirty);
    this._badge.classList.toggle('dirty', dirty);
  }

  // ---- view assembly ----
  show() {
    const b = this.building, f = this.floor;
    this.draft = null; this.selected = null; this.editingLabel = null; this.selectedPlacement = null;
    this.selectedArrow = null; this.rackRoom = null;
    this.dragSheetState = null;
    this.grid.adjust = false;
    this.grid.setScope(Util.floorKey(b.dir, f.id));
    if (!this.editing()) this.arranging = false;   // Arrange is an edit-mode activity

    // A floor is one or more sheets (some floors split a single level across
    // multiple plan sheets) tiled into a grid; they share one normalized
    // coordinate space spanning the whole canvas. `floorLayout` is the single source
    // of that geometry; while arranging we pad the canvas with a spare column + row
    // so a sheet can be dragged into a not-yet-used cell.
    const base = this.store.floorLayout(b.dir, f.id);
    this.baseLayout = base;
    const multi = base.cells.length > 1;
    const pad = (this.arranging && multi) ? 1 : 0;
    const cols = base.cols + pad, rows = base.rows + pad;
    const W = cols * base.cellW, H = rows * base.cellH;
    this.layout = { cells: base.cells, cellW: base.cellW, cellH: base.cellH, cols, rows, W, H };

    this.app.crumbs([
      { label: 'Siteplan', hash: '/' },
      { label: b.name, hash: '/b/' + encodeURIComponent(b.dir) },
      { label: f.label },
    ]);
    this.app.setToolbar(this._toolbar());

    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const imgs = base.cells.map(c => Dom.el('img', { class: 'sheet', src: (window.MAP ? window.MAP.media : '/') + c.image, alt: f.label,
      style: `left:${c.col * base.cellW}px;top:${c.row * base.cellH}px;width:${base.cellW}px;height:${base.cellH}px` }));
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap', id: 'floor-wrap', style: `width:${W}px;height:${H}px` },
      [...imgs, s]);
    // The sheet stamp sits in the viewport (not the wrap), so it stays fixed in
    // the corner instead of panning/zooming with the map.
    stage.append(Dom.el('div', { class: 'map-viewport' }, [wrap, this._sheetMark()]));

    // First mount of a multi-sheet floor frames sheet 1 (+ ~10%) so the extra sheet
    // is discoverable; later re-mounts (mode toggles, arrange drops) just full-fit.
    this.initialFocus = (multi && !this._peeked && !this.arranging)
      ? this._peekRegion(base.cells[0], base) : null;
    this._peeked = true;

    this.attach(imgs[0], s, [W, H]);
    this.loadNbRooms();
    if (this.app.mode === 'racks' || this.app.mode === 'view') this._ensurePlacementInventory();
  }

  /** The normalized rect framing one sheet's cell, padded ~10% so a neighbour peeks. */
  _peekRegion(cell, lay) {
    const padX = lay.cellW * 0.1, padY = lay.cellH * 0.1;
    const x0 = cell.col * lay.cellW, y0 = cell.row * lay.cellH;
    return [
      Math.max(0, (x0 - padX) / lay.W), Math.max(0, (y0 - padY) / lay.H),
      Math.min(1, (x0 + lay.cellW + padX) / lay.W), Math.min(1, (y0 + lay.cellH + padY) / lay.H),
    ];
  }

  /** Decorative drawing-sheet stamp, pinned to the viewport corner. */
  _sheetMark() {
    const code = (Util.code(this.building.dir) + ' ' + this.floor.id).trim();
    return Dom.el('div', { class: 'sheet-mark' }, Dom.el('div', { class: 'sheet-stamp' }, code));
  }

  _toolbar() {
    const racksMode = this.app.mode === 'racks';
    const modeBtn = Dom.el('button', { class: this.editing() ? 'active' : '',
      html: Icons.edit + '<span>' + (this.editing() ? 'Edit mode' : 'View mode') + '</span>' });
    modeBtn.onclick = () => this._switchMode(this.editing() ? 'view' : 'edit');

    this._badge = Dom.el('span', { class: 'badge' + (this._dirty() ? ' dirty' : ''),
      html: this.badgeHtml(this._dirty()) });
    const saveBtn = Dom.el('button', { class: 'primary', onclick: () => this.save() }, 'Save');

    // Place-racks toggle lives in edit mode; racks is a sub-mode reached from edit.
    const racksBtn = Dom.el('button', { class: racksMode ? 'active' : '',
      title: 'Place racks/devices in rooms',
      html: Icons.rack + '<span>Place racks</span>' });
    racksBtn.onclick = () => this._switchMode(racksMode ? 'edit' : 'racks');

    if (this.editing()) {
      const drawBtn = Dom.el('button', { onclick: () => this.beginDraw(
        'Click to add points · Backspace undoes a point · Enter/double-click to close · Esc to cancel'),
        html: Icons.draw + '<span>Draw room</span>' });
      const arrowBtn = Dom.el('button', { title: 'Draw a wayfinding route arrow to a room',
        onclick: () => this.beginArrow(), html: Icons.arrow + '<span>Draw arrow</span>' });
      const tools = [modeBtn, drawBtn, arrowBtn, this.undoButton(), this.toolDivider(), this.snapButton(),
        this.orthoButton(), this.gridToggleButton(), this.gridSizeSelect(), this.gridMoveButton()];
      if (this.layout && this.layout.cells.length > 1) tools.push(this.toolDivider(), this._arrangeButton());
      tools.push(this.toolDivider(), racksBtn, this.toolDivider(), saveBtn, this._badge);
      return tools;
    }

    if (racksMode) return [racksBtn, this.toolDivider(),
      this.gridToggleButton(), this.gridSizeSelect(), this.gridMoveButton(),
      this.toolDivider(), saveBtn, this._badge];

    const hlSel = Dom.el('select', { title: 'Highlight in view mode' });
    [['Highlight: rooms with devices', 'placements'], ['Highlight: none', 'none']].forEach(([l, v]) => {
      const o = Dom.el('option', { value: v }, l);
      if (v === this.app.highlight) o.selected = true;
      hlSel.append(o);
    });
    hlSel.onchange = () => { this.app.highlight = hlSel.value; this.render(); };
    return [modeBtn, hlSel, saveBtn, this._badge];
  }

  /** Toggle between edit/view/racks WITHOUT tearing down the stage. The three modes
   *  render the same sheet images + geometry — only the toolbar and interactive layer
   *  differ — so we rebuild the toolbar and re-`render()` against the existing `.map-wrap`,
   *  leaving the live `PanZoom` transform (the user's zoom/pan) intact. Contrast `show()`,
   *  which rebuilds the stage and refits — reserved for first mount and arrange relayout.
   *  Arrange pads the canvas geometry, so leaving it needs a full `show()` relayout. */
  _switchMode(mode) {
    if (this.arranging) { this.arranging = false; this.app.mode = mode; this.show(); return; }
    this.app.mode = mode;
    this.draft = null; this.selected = null; this.selectedArrow = null;
    this.selectedPlacement = null; this.rackRoom = null; this.editingLabel = null;
    this.grid.adjust = false;
    // Dismiss any stale panel, but suppress the close hook: it would (re-)interpret a
    // racks-mode close as "drop to edit" and bounce us straight back out of racks.
    this._switchingMode = true;
    this.app.closePanel();
    this._switchingMode = false;
    this.app.setToolbar(this._toolbar());   // rebuild: the badge/_dirty() meaning is per-mode
    this.render();
    if (mode === 'racks' || mode === 'view') this._ensurePlacementInventory();
  }

  async save() {
    try {
      if (this.app.mode === 'racks') await this.store.savePlacements();
      else { await this.store.saveAnnotations(); await this.store.saveLayouts(); }
      this._setBadge(); Toast.show('Saved');
    } catch (e) { Toast.show('Save failed: ' + e.message, true); }
  }

  /** Toggle Arrange mode (drag sheets into grid cells). Edit-mode, multi-sheet only. */
  _arrangeButton() {
    const b = Dom.el('button', { class: this.arranging ? 'active' : '',
      title: 'Drag sheets to arrange them in a grid', html: Icons.move + '<span>Arrange sheets</span>' });
    b.onclick = () => {
      this.arranging = !this.arranging;
      if (this.arranging) {
        this.selected = null; this.editingLabel = null; this.draft = null;
        this.app.closePanel();
        Toast.show('Drag a sheet to a cell to move it · drop on another to swap · Esc to exit');
      }
      this.show();
    };
    return b;
  }

  // ---- rendering ----
  render() {
    const s = this.svg; if (!s) return;
    const [W, H] = this.dispSize(); if (!W) return;
    const editing = this.editing();
    const racks = this.app.mode === 'racks';
    const arranging = editing && this.arranging;
    this.prepareSvg(s);
    if (this.gridActive() && !arranging) this.grid.draw(s, W, H, this.dims);
    this.addCatcher(s, W, H);
    if (!arranging) this._drawCaptions(s, W, H);

    if (arranging) { this._drawArrange(s, W, H); return; }

    // Rooms holding rack/device markers (a placement needs a bound Location to draw),
    // used to highlight them in view mode.
    const placedRooms = new Set(
      this.store.placementData(this.building.dir, this.floor.id).placements.map(p => p.room));
    for (const room of this.data().rooms) {
      const placed = placedRooms.has(room.id) && !!room.location;
      const pts = room.polygon.map(p => `${p[0] * W},${p[1] * H}`).join(' ');
      // Racks mode draws every room as a clickable target. View mode keeps rooms as
      // invisible click-zones, except those highlighted because they hold markers.
      const showShape = editing || racks || (placed && this.app.highlight === 'placements');
      let cls;
      if (!showShape) cls = 'clickzone';
      else {
        cls = 'room';
        if (placed) cls += ' placed';
        if (editing && room.id === this.selected) cls += ' selected';
        if (editing && !room.location) cls += ' unbound';
      }
      const poly = Dom.svg('polygon', { points: pts, class: cls });
      if (cls === 'clickzone') poly.style.pointerEvents = 'all';
      const title = Dom.svg('title');
      title.textContent = (room.label || '(unbound)') + (placed ? ' — has devices' : '');
      poly.append(title);
      poly.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.draft) return;
        if (editing) { this.selected = room.id; this.render(); this.openRoomPanel(room); }
        else if (racks) { this.selectedPlacement = null; this.rackRoom = room; this.render(); this.openRackPanel(room); }
        else if (room.location) window.open(room.location.url, '_blank');
      });
      s.append(poly);

      // No centroid label is drawn: the floor-plan images already carry the
      // printed room names/numbers, so an overlay would just double-print them.
      if (editing && room.id === this.selected)
        this.drawVertices(s, room.polygon, W, H, room.id, () => this.markDirty());
    }
    if (!racks) this._drawArrows(s, W, H);   // wayfinding routes: edit + view, not racks
    this.drawDraft(s, W, H);
    if (racks || this.app.mode === 'view') this.drawPlacements(s, W, H);
  }

  /** Caption each sheet of a multi-sheet floor at its cell's top-left (mirrors the
   *  PDF's per-sheet label). Drawn as inert SVG text, so it costs no layout height
   *  and does not shift the shared coordinate space. */
  _drawCaptions(s, W, H) {
    const lay = this.layout; if (!lay || lay.cells.length < 2) return;
    const inset = 0.02 * lay.cellW;
    for (const c of lay.cells) {
      if (!c.caption) continue;
      const t = Dom.svg('text', { x: c.col * lay.cellW + inset, y: c.row * lay.cellH + inset * 1.4,
        'dominant-baseline': 'hanging', class: 'page-caption' });
      t.textContent = c.caption;
      s.append(t);
    }
  }

  // ---- Arrange mode: drag sheets into a grid ----
  /** Draw the sheet grid: cell outlines, a drop-target highlight, and a draggable
   *  tile per sheet. Only the tiles are interactive; the rest of the canvas keeps
   *  panning. */
  _drawArrange(s, W, H) {
    const lay = this.layout, { cellW, cellH, cols, rows } = lay;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        s.append(Dom.svg('rect', { x: c * cellW, y: r * cellH, width: cellW, height: cellH, class: 'sheet-grid' }));

    if (this.dragSheetState && this.dragSheetState.target) {
      const [tc, tr] = this.dragSheetState.target;
      s.append(Dom.svg('rect', { x: tc * cellW, y: tr * cellH, width: cellW, height: cellH, class: 'sheet-drop' }));
    }

    for (const cell of lay.cells) {
      const x = cell.col * cellW, y = cell.row * cellH;
      const dragging = this.dragSheetState && this.dragSheetState.page === cell.page;
      const tile = Dom.svg('rect', { x, y, width: cellW, height: cellH, rx: 8,
        class: 'sheet-tile' + (dragging ? ' dragging' : '') });
      tile.addEventListener('pointerdown', (e) => this._startSheetDrag(e, cell));
      s.append(tile);
      const label = Dom.svg('text', { x: x + cellW / 2, y: y + cellH / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'sheet-tile-label' });
      label.textContent = cell.caption || ('Sheet ' + (cell.page + 1));
      label.style.pointerEvents = 'none';
      s.append(label);
    }
  }

  /** Begin dragging a sheet tile; the target cell follows the pointer (clamped one
   *  cell beyond the current grid so you can extend it), and drop commits the move. */
  _startSheetDrag(e, cell) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.dragSheetState = { page: cell.page, target: [cell.col, cell.row] };
    this.dragSheet = {
      move: (nx, ny) => {
        const lay = this.layout;
        const c = Math.max(0, Math.min(this.baseLayout.cols, Math.floor(nx * lay.W / lay.cellW)));
        const r = Math.max(0, Math.min(this.baseLayout.rows, Math.floor(ny * lay.H / lay.cellH)));
        this.dragSheetState.target = [c, r];
        this.render();
      },
      drop: () => this._commitSheetMove(),
    };
    this.svg.setPointerCapture(e.pointerId);
    this.render();
  }

  /** Place the dragged sheet in the target cell (swap if occupied), trim the grid to
   *  the origin, remap any rooms/racks to follow their sheet, and re-lay-out. */
  _commitSheetMove() {
    const st = this.dragSheetState; this.dragSheetState = null;
    if (!st) { this.render(); return; }
    const oldGeom = this.store.floorLayout(this.building.dir, this.floor.id);
    const cells = oldGeom.cells.map(c => [c.col, c.row]);   // [col,row] per page index
    const from = cells[st.page], [tc, tr] = st.target;
    if (tc === from[0] && tr === from[1]) { this.render(); return; }   // no-op
    const occ = cells.findIndex(([c, r], i) => i !== st.page && c === tc && r === tr);
    if (occ >= 0) cells[occ] = [from[0], from[1]];   // swap
    cells[st.page] = [tc, tr];
    const minC = Math.min(...cells.map(c => c[0])), minR = Math.min(...cells.map(c => c[1]));
    const grid = cells.map(([c, r]) => [c - minC, r - minR]);
    this.store.setLayout(this.building.dir, this.floor.id, grid);
    this._remapLayout(oldGeom, this.store.floorLayout(this.building.dir, this.floor.id));
    this.show();   // relayout (still arranging → re-padded)
  }

  /** Re-project every room point / placement from the old tiling to the new one so
   *  each shape stays on its own sheet: locate its old cell, take its within-cell
   *  fraction, and map that into the sheet's new cell. Pure arithmetic on the stored
   *  combined-normalized coords — no schema or engine change. */
  _remapLayout(oldG, newG) {
    if (oldG.W === newG.W && oldG.H === newG.H
        && oldG.cells.every((c, i) => c.col === newG.cells[i].col && c.row === newG.cells[i].row)) return;
    const map = (nx, ny) => {
      const px = nx * oldG.W, py = ny * oldG.H;
      const cell = oldG.cells.find(c => px >= c.col * oldG.cellW && px < (c.col + 1) * oldG.cellW
        && py >= c.row * oldG.cellH && py < (c.row + 1) * oldG.cellH) || oldG.cells[0];
      const lx = (px - cell.col * oldG.cellW) / oldG.cellW, ly = (py - cell.row * oldG.cellH) / oldG.cellH;
      const nc = newG.cells[cell.page];
      return [+(((nc.col + lx) * newG.cellW) / newG.W).toFixed(5),
              +(((nc.row + ly) * newG.cellH) / newG.H).toFixed(5)];
    };
    const fdata = this.store.floorData(this.building.dir, this.floor.id);
    const rooms = fdata.rooms;
    for (const room of rooms) {
      room.polygon = room.polygon.map(p => map(p[0], p[1]));
    }
    // Route arrows live in the same combined-normalized space → remap with the rooms
    // so each route stays on its own sheet. Their `room` binding is an id, untouched.
    const arrows = fdata.arrows;
    for (const a of arrows) a.points = a.points.map(p => map(p[0], p[1]));
    const placements = this.store.placementData(this.building.dir, this.floor.id).placements;
    for (const p of placements) {
      const [x, y] = map(p.x, p.y); p.x = x; p.y = y;
      if (p.w != null) p.w = +(p.w * oldG.W / newG.W).toFixed(5);
      if (p.h != null) p.h = +(p.h * oldG.H / newG.H).toFixed(5);
    }
    if (rooms.length || arrows.length) this.store.markDirty();
    if (placements.length) this.store.markPlacementsDirty();
  }

  // ---- rack/device placement markers (rooms bound to a Location) ----
  /** Live-load inventory for every bound room that has placements on this floor,
   *  so markers render with their real glyphs instead of the stale fallback. Each
   *  Location is fetched once and kept in the in-memory cache; one re-render restyles
   *  the markers when the inventory lands (roadmap §10 risk 3: brief stale flash). */
  async _ensurePlacementInventory() {
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    if (!pdata.placements.length) return;
    const roomById = {};
    for (const r of this.data().rooms) roomById[r.id] = r;
    const locIds = new Set();
    for (const p of pdata.placements) {
      const room = roomById[p.room];
      if (room && room.location) locIds.add(room.location.id);
    }
    const pending = [...locIds].filter(id => !this.store.rackCache.locations[id]);
    if (!pending.length) return;
    try {
      await Promise.all(pending.map(id => this.store.ensureRacks(this.netbox, id)));
      this.render();
    } catch (e) { Toast.show('NetBox: ' + e.message, true); }
  }

  /** Cached inventory entry for a placement, or null if it's no longer in NetBox. */
  _cacheItem(p) {
    const loc = this.store.rackCache.locations[p.loc];
    if (!loc) return null;
    return (p.kind === 'rack' ? loc.racks : loc.devices).find(x => x.id === p.id) || null;
  }

  /** Draw a marker per placement. In racks mode markers are draggable (move
   *  clamped to the room polygon) and the selected one gets rotate + resize
   *  handles; in view mode they are read-only links to NetBox. Each marker is a
   *  `translate(center) rotate(rot)` group sized to (normalized) w×h. */
  drawPlacements(s, W, H) {
    const draggable = this.app.mode === 'racks';
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    const roomById = {};
    for (const r of this.data().rooms) roomById[r.id] = r;

    // Draw the selected marker last so its handles sit above its neighbours.
    const visible = pdata.placements.filter(p => {
      const room = roomById[p.room];
      return room && room.location;
    });
    visible.sort((a, b) => (a === this.selectedPlacement ? 1 : 0) - (b === this.selectedPlacement ? 1 : 0));

    for (const p of visible) {
      const room = roomById[p.room];
      const item = this._cacheItem(p);
      const stale = !item;
      const selected = draggable && p === this.selectedPlacement;
      // The glyph type is keyed off the NetBox role (device-name fallback); its size
      // defaults per type unless the user has resized this marker (p.w/p.h).
      const type = DeviceShapes.typeFor(p, item);
      const box = DeviceShapes.box(type);
      const wpx = p.w != null ? p.w * W : box.w;
      const hpx = p.h != null ? p.h * H : box.h;
      const g = Dom.svg('g', {
        class: 'rack-marker' + (p.kind === 'device' ? ' device' : '')
          + (stale ? ' stale' : '') + (selected ? ' selected' : ''),
        transform: `translate(${p.x * W},${p.y * H}) rotate(${p.rot || 0})`,
      });
      for (const el of DeviceShapes.glyph(type, wpx, hpx)) g.append(el);
      const title = Dom.svg('title');
      title.textContent = (p.kind === 'rack' ? 'Rack: ' : 'Device: ') + (p.label || '?')
        + (stale ? ' (not in latest sync)' : '');
      g.append(title);

      if (draggable) {
        g.style.cursor = 'grab';
        g.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.selectedPlacement = p; this.editingLabel = null;
          this.dragItem = { move: (nx, ny, ev) => {
            let x = nx, y = ny;
            // Snap the centre to the grid (Alt frees it), then keep it in the room.
            if (this.grid.on && !(ev && ev.altKey)) {
              const [iw, ih] = this.dims;
              x = this.grid.snap(x * iw, this.grid.ox) / iw;
              y = this.grid.snap(y * ih, this.grid.oy) / ih;
            }
            const [cx, cy] = Geom.clampToPoly(x, y, room.polygon);
            p.x = +cx.toFixed(5); p.y = +cy.toFixed(5);
            this.markPlacementsDirty(); this.render();
          } };
          s.setPointerCapture(e.pointerId);
          this.render(); this.openPlacementPanel(p, room);
        });
        // Hide the marker's move/rotate/resize handles while its label is being edited
        // (the label grows its own handles — two overlapping sets would collide).
        if (selected && this.editingLabel !== p.uid) this._placementHandles(g, s, p, W, H, wpx, hpx);
      } else if (item && item.url) {
        g.style.cursor = 'pointer';
        g.addEventListener('click', (e) => { e.stopPropagation(); window.open(item.url, '_blank'); });
      }
      s.append(g);

      // The name rides the shared label engine as a separate, stylable label (drawn
      // on the svg, not the rotated marker group, so it keeps its own rotation).
      this._drawPlacementLabel(s, p, hpx, W, H);
    }
  }

  /** Draw a placement's name as an independently movable/stylable label via the shared
   *  Editor label engine. Auto-placed just below the glyph; an optional `labelStyle`
   *  (x/y/rot/size/font/colour/text) overrides. While this placement's label is being
   *  edited it gains move/rotate/resize handles (keyed by the placement uid). */
  _drawPlacementLabel(s, p, hpx, W, H) {
    const ls = p.labelStyle || {};
    // Racks carry their name centered inside the (filled) box; devices sit it just
    // below the glyph. `inside` only holds at the default position — a moved label
    // (custom x/y) reverts to the haloed style so it stays legible over the plan.
    const inside = p.kind === 'rack' && ls.x == null && ls.y == null;
    const lcx = ls.x != null ? ls.x : p.x;
    const lcy = ls.y != null ? ls.y : (inside ? p.y : p.y + (hpx / 2 + 10) / H);
    const sizePx = ls.size || 11;
    const t = Dom.svg('text', { class: 'rack-label' + (inside ? ' inside' : ''),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    this._setLabelLines(t, (ls.text != null ? ls.text : (p.label || '?')).split('\n'));
    this.attachLabel(s, p, t, lcx, lcy, sizePx, W, H);
  }

  /** Rotate handle (above the top edge) + resize handle (bottom-right corner) for
   *  the selected marker. Both reuse the Editor `dragItem` channel; their geometry
   *  is local to the rotated group, but the math works in display px around the
   *  marker centre so it is rotation-correct. */
  _placementHandles(g, s, p, W, H, wpx, hpx) {
    const ry = -hpx / 2 - 16;
    g.append(Dom.svg('line', { x1: 0, y1: -hpx / 2, x2: 0, y2: ry, class: 'rack-stem' }));
    const rot = Dom.svg('circle', { cx: 0, cy: ry, r: 5, class: 'rack-handle' });
    rot.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.dragItem = { move: (nx, ny, ev) => {
        const dx = (nx - p.x) * W, dy = (ny - p.y) * H;
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (!(ev && ev.altKey)) deg = Math.round(deg / ANGLE_STEP) * ANGLE_STEP;   // Alt frees rotation
        p.rot = ((Math.round(deg) % 360) + 360) % 360;
        this.markPlacementsDirty(); this.render();
      } };
      s.setPointerCapture(e.pointerId);
    });
    g.append(rot);

    const size = Dom.svg('rect', { x: wpx / 2 - 4, y: hpx / 2 - 4, width: 8, height: 8, class: 'rack-handle' });
    size.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const rad = (p.rot || 0) * Math.PI / 180, cs = Math.cos(rad), si = Math.sin(rad);
      this.dragItem = { move: (nx, ny, ev) => {
        const ex = (nx - p.x) * W, ey = (ny - p.y) * H;          // pointer rel. to centre (px)
        const lx = ex * cs + ey * si, ly = -ex * si + ey * cs;   // un-rotate into the marker's frame
        let w = Math.max(16, 2 * Math.abs(lx)) / W;
        let h = Math.max(14, 2 * Math.abs(ly)) / H;
        // Quantize the footprint to the grid (offset 0 — this snaps a size, not a
        // position); Alt frees it, and a marker stays at least one cell on a side.
        if (this.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = this.dims;
          w = Math.max(this.grid.step, this.grid.snap(w * iw, 0)) / iw;
          h = Math.max(this.grid.step, this.grid.snap(h * ih, 0)) / ih;
        }
        p.w = +w.toFixed(5); p.h = +h.toFixed(5);
        this.markPlacementsDirty(); this.render();
      } };
      s.setPointerCapture(e.pointerId);
    });
    g.append(size);
  }

  // ---- drawing actions ----
  /** Drawing always clears a selected arrow (starting a room or an arrow). */
  beginDraw(msg, kind) { this.selectedArrow = null; super.beginDraw(msg, kind); }

  finish() {
    if (this.draft.kind === 'arrow') return this._finishArrow();
    const dp = this.draft.points;
    if (dp.length < 3) { this.draft = null; this.render(); return; }
    const room = { id: Util.uid(), label: '', polygon: dp.slice(), location: null };
    this.data().rooms.push(room);
    this.draft = null; this.selected = room.id; this.markDirty();
    this.render(); this.openRoomPanel(room);
  }

  // ---- route arrows (wayfinding) ----
  beginArrow() {
    this.beginDraw('Click points along the route · Enter/double-click to finish at the room · Esc to cancel', 'arrow');
  }

  /** Close the arrow draft into a route. Drops a trailing duplicate point (the click
   *  that precedes a double-click already added it) and needs ≥ 2 points. */
  _finishArrow() {
    const dp = this.draft.points;
    const n = dp.length;
    if (n >= 2 && dp[n - 1][0] === dp[n - 2][0] && dp[n - 1][1] === dp[n - 2][1]) dp.pop();
    if (dp.length < 2) { this.draft = null; this.render(); return; }
    const arrow = { id: Util.uid(), points: dp.slice(), room: null, label: '', color: ARROW_COLORS[0] };
    this._bindArrowDest(arrow);
    this.data().arrows.push(arrow);
    this.draft = null; this.selected = null; this.selectedArrow = arrow; this.markDirty();
    this.render(); this.openArrowPanel(arrow);
  }

  /** Auto-bind the arrow's destination to the room its arrowhead (last point) lands
   *  in, or null. Re-run whenever the route is reshaped so the binding stays fresh. */
  _bindArrowDest(arrow) {
    const last = arrow.points[arrow.points.length - 1];
    const hit = this.data().rooms.find(r => Geom.pointInPoly(last[0], last[1], r.polygon));
    arrow.room = hit ? hit.id : null;
  }

  selectArrow(arrow) {
    this.selected = null; this.editingLabel = null; this.selectedArrow = arrow;
    this.render(); this.openArrowPanel(arrow);
  }

  deleteArrow(arrow) {
    const arr = this.data().arrows;
    const i = arr.indexOf(arrow);
    if (i >= 0) arr.splice(i, 1);
    this.selectedArrow = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
  }

  /** Draw each route: a fat transparent hit line (edit only), the coloured polyline,
   *  an arrowhead at the destination end, and an optional note at the start. The
   *  selected arrow grows editable nodes. View-mode arrows are inert overlays. */
  _drawArrows(s, W, H) {
    const editing = this.editing();
    for (const a of this.data().arrows) {
      if (!a.points || a.points.length < 2) continue;
      const color = a.color || ARROW_COLORS[0];
      const pts = a.points.map(p => `${p[0] * W},${p[1] * H}`).join(' ');

      if (editing) {
        const hit = Dom.svg('polyline', { points: pts, class: 'arrow-hit', fill: 'none' });
        hit.addEventListener('click', (e) => { e.stopPropagation(); if (!this.draft) this.selectArrow(a); });
        s.append(hit);
      }
      const line = Dom.svg('polyline', { points: pts, fill: 'none',
        class: 'arrow' + (editing && a === this.selectedArrow ? ' selected' : '') });
      line.style.stroke = color;
      line.style.pointerEvents = 'none';   // all hit-testing goes through .arrow-hit (edit only)
      s.append(line);

      const n = a.points.length, p0 = a.points[n - 2], p1 = a.points[n - 1];
      const tri = Geom.arrowHead(p0[0] * W, p0[1] * H, p1[0] * W, p1[1] * H, ARROW_HEAD_PX);
      const head = Dom.svg('polygon', { points: tri.map(p => p.join(',')).join(' '), class: 'arrow-head' });
      head.style.fill = color; head.style.pointerEvents = 'none';
      s.append(head);

      this._drawArrowLabel(s, a, color, W, H);

      // Suppress the editable nodes while this arrow's label is being moved/styled.
      if (editing && a === this.selectedArrow && this.editingLabel !== this._labelKey(a))
        this.drawVertices(s, a.points, W, H, a.id,
          () => { this._bindArrowDest(a); this.markDirty(); }, { closed: false, minPts: 2 });
    }
  }

  /** Draw a route's note as an independently movable/stylable label via the shared
   *  Editor label engine. Auto-placed just above the arrow's start point; an optional
   *  `labelStyle` (x/y/rot/size/font/colour/text) overrides. Rendered only when there
   *  is text (notes are optional). While this arrow's label is being edited it gains
   *  move/rotate/resize handles (keyed by the arrow id). */
  _drawArrowLabel(s, a, color, W, H) {
    const ls = a.labelStyle || {};
    if (!((ls.text != null && ls.text !== '') || a.label)) return;
    const [sx, sy] = a.points[0];
    const sizePx = ls.size || 13;
    const lcx = ls.x != null ? ls.x : sx;
    const lcy = ls.y != null ? ls.y : sy - (sizePx * 0.7 + 4) / H;   // just above the start
    const t = Dom.svg('text', { class: 'arrow-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.style.fontSize = sizePx + 'px';
    t.style.fill = color;   // default = arrow colour; attachLabel overrides if labelStyle.color
    this._setLabelLines(t, (ls.text != null ? ls.text : a.label).split('\n'));
    this.attachLabel(s, a, t, lcx, lcy, sizePx, W, H);
  }

  /** Side panel for a selected route: its auto-detected destination, an editable
   *  note, a colour swatch row, and delete. */
  openArrowPanel(arrow) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Route arrow';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const dest = arrow.room && this.data().rooms.find(r => r.id === arrow.room);
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Destination (at the arrowhead)'),
      Dom.el('div', { class: 'val' }, dest ? (dest.label || '(unbound room)') : '(arrowhead is not over a room)'),
    ]));

    const note = Dom.el('input', { placeholder: 'e.g. Enter from the north stairwell' });
    note.value = arrow.label || '';
    note.oninput = () => { arrow.label = note.value; this.markDirty(); this.render(); };
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Note (shown at the start)'), note]));

    const swatches = Dom.el('div', { class: 'swatch-row' }, ARROW_COLORS.map(c => {
      const sw = Dom.el('button', { class: 'swatch' + (c === (arrow.color || ARROW_COLORS[0]) ? ' on' : ''),
        title: c }); sw.style.background = c;
      sw.onclick = () => { arrow.color = c; this.markDirty(); this.render(); this.openArrowPanel(arrow); };
      return sw;
    }));
    body.append(Dom.el('div', { class: 'field' }, [Dom.el('label', {}, 'Colour'), swatches]));

    if (arrow.label)
      body.append(Dom.el('button', { class: 'wide', onclick: () => this.editArrowLabel(arrow),
        html: Icons.edit + '<span>Edit label</span>' }));

    body.append(Dom.el('div', { class: 'hint' },
      'Drag a node to bend · midpoint adds a turn · right-click removes.'));
    body.append(Dom.el('button', { class: 'wide danger', onclick: () => this.deleteArrow(arrow) }, 'Delete arrow'));
  }

  /** Enter label-edit for a route: the note grows move/rotate/resize handles and the
   *  shared style panel opens. Done/Escape return to the arrow panel. */
  editArrowLabel(arrow) {
    this.selectedArrow = arrow; this.editingLabel = this._labelKey(arrow);
    this.render();
    this.openLabelPanel(arrow, () => {
      this.editingLabel = null; this.render(); this.openArrowPanel(arrow);
    }, arrow.label || '');
  }

  /** Build off an existing room: clone its (nudged) shape as a new room. */
  duplicateRoom(src) {
    const off = 0.01;
    const poly = src.polygon.map(p => [+Math.min(1, p[0] + off).toFixed(5), +Math.min(1, p[1] + off).toFixed(5)]);
    const room = { id: Util.uid(), label: '', polygon: poly, location: null };
    this.data().rooms.push(room);
    this.selected = room.id; this.markDirty();
    this.render(); this.openRoomPanel(room);
    Toast.show('Duplicated — drag vertices to reshape (snaps to the original)');
  }

  deleteRoom(room) {
    const rooms = this.data().rooms;
    const i = rooms.indexOf(room);
    if (i >= 0) rooms.splice(i, 1);
    this.selected = null; this.markDirty(); this.render(); this.app.closePanel();
  }

  // ---- NetBox binding panel ----
  async loadNbRooms() {
    const key = Util.floorKey(this.building.dir, this.floor.id);
    if (this.store.nbRoomsByFloor[key]) return this.store.nbRoomsByFloor[key];
    try {
      const res = await this.netbox.rooms(this.building.siteSlug, this.floor.id);
      this.store.nbRoomsByFloor[key] = res;
      return res;
    } catch (e) { Toast.show('NetBox: ' + e.message, true); return { rooms: [] }; }
  }

  async openRoomPanel(room) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = room.location ? room.label : 'Bind room';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Selected polygon'),
      Dom.el('div', { class: 'val' }, room.location ? room.location.name : '(unbound)'),
      room.location ? Dom.el('div', {}, Dom.el('a', { href: room.location.url, target: '_blank' }, 'open in NetBox ↗')) : null,
    ]));
    body.append(Dom.el('div', { class: 'row' }, [
      Dom.el('button', { onclick: () => { room.location = null; room.label = ''; this.markDirty(); this.render(); this.openRoomPanel(room); } }, 'Unbind'),
      Dom.el('button', { class: 'danger', onclick: () => this.deleteRoom(room) }, 'Delete'),
    ]));

    body.append(Dom.el('button', { class: 'wide', onclick: () => this.duplicateRoom(room),
      html: Icons.dup + '<span>Duplicate as new room</span>' }));
    body.append(Dom.el('div', { class: 'hint' }, 'Bind to a NetBox Location on this floor:'));
    const search = Dom.el('input', { id: 'room-search', placeholder: 'Search rooms…' });
    body.append(search);
    const list = Dom.el('div', {}); body.append(list);

    const res = await this.loadNbRooms();
    const rooms = res.rooms || [];
    if (res.floor === null) body.insertBefore(
      Dom.el('div', { class: 'hint' }, '⚠ No NetBox Location matches floor slug "' + this.floor.id + '"; showing all site locations.'),
      search);
    if (!rooms.length) list.append(Dom.el('div', { class: 'hint' }, 'No NetBox locations returned.'));

    const boundIds = new Set(this.data().rooms.filter(r => r.location).map(r => r.location.id));
    const renderList = (q) => {
      list.innerHTML = '';
      const ql = q.toLowerCase();
      rooms.filter(r => !ql || r.name.toLowerCase().includes(ql) || r.slug.includes(ql))
        .slice(0, 300)
        .forEach(loc => {
          const isThis = room.location && room.location.id === loc.id;
          const item = Dom.el('div', { class: 'room-item' + (isThis ? ' bound' : '') }, [
            Dom.el('div', { class: 'nm' }, loc.name + (isThis ? '  ✓' : (boundIds.has(loc.id) ? '  •' : ''))),
            Dom.el('div', { class: 'sl' }, loc.slug),
          ]);
          item.onclick = () => {
            room.location = { id: loc.id, name: loc.name, slug: loc.slug, url: loc.url };
            room.label = loc.name; this.markDirty(); this.render(); this.openRoomPanel(room);
          };
          list.append(item);
        });
    };
    search.addEventListener('input', () => renderList(search.value));
    renderList(''); search.focus();
  }

  // ---- rack placement panel (racks mode) ----
  /** List the room's synced racks + unracked devices; click a row to place it
   *  (or remove an already-placed one). */
  openRackPanel(room) {
    this.selected = null;
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = room.label || 'Racks';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    if (!room.location) {
      body.append(Dom.el('div', { class: 'hint' }, 'Bind this room to a NetBox Location (in Edit mode) before placing racks.'));
      return;
    }

    const refreshBtn = Dom.el('button', { class: 'wide',
      title: "Pull this room's racks & devices from NetBox" });
    refreshBtn.innerHTML = Icons.rack + '<span>Refresh racks</span>';
    refreshBtn.onclick = async () => {
      const restore = refreshBtn.innerHTML;
      refreshBtn.disabled = true; refreshBtn.innerHTML = '<span>Refreshing…</span>';
      try {
        const inv = await this.store.ensureRacks(this.netbox, room.location.id, true);
        Toast.show('Refreshed ' + (room.label || room.location.name)
          + ' · ' + inv.racks.length + ' racks · ' + inv.devices.length + ' devices');
        this.render();             // restyle stale markers against the fresh inventory
        this.openRackPanel(room);  // re-render the list with fresh inventory
      } catch (e) {
        Toast.show('Refresh failed: ' + e.message, true);
        refreshBtn.disabled = false; refreshBtn.innerHTML = restore;
      }
    };
    body.append(refreshBtn);

    // First open of a room fetches its inventory live; re-render the panel when it
    // lands so the lists populate without a manual Refresh click.
    if (!this.store.rackCache.locations[room.location.id]) {
      body.append(Dom.el('div', { class: 'hint' }, 'Loading racks & devices from NetBox…'));
      this.store.ensureRacks(this.netbox, room.location.id)
        .then(() => { this.render(); if (this.rackRoom === room) this.openRackPanel(room); })
        .catch(e => Toast.show('NetBox: ' + e.message, true));
      return;
    }

    const inv = this.store.racksForLocation(room.location.id);
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    const mine = () => pdata.placements.filter(p => p.room === room.id);
    const placedKey = new Set(mine().map(p => p.kind + ':' + p.id));

    body.append(Dom.el('div', { class: 'hint' },
      'Click an item to drop it in the room, then drag to place. Click a placed (✓) item to '
      + 'remove it.'));

    const section = (heading, items, kind) => {
      body.append(Dom.el('div', { class: 'field' }, Dom.el('label', {}, heading + ' (' + items.length + ')')));
      if (!items.length) { body.append(Dom.el('div', { class: 'hint' }, 'None.')); return; }
      items.forEach(it => {
        const placed = placedKey.has(kind + ':' + it.id);
        const row = Dom.el('div', { class: 'room-item' + (placed ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, it.name + (placed ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, kind === 'rack' ? (it.u_height ? it.u_height + 'U rack' : 'rack') : 'device'),
        ]);
        row.onclick = () => placed
          ? this.removePlacement(mine().find(p => p.kind === kind && p.id === it.id), room)
          : this.placeItem(room, kind, it);
        body.append(row);
      });
    };
    section('Racks', inv.racks, 'rack');
    section('Unracked devices', inv.devices, 'device');

    // Placed items no longer present in the latest sync — offer removal.
    const stale = mine().filter(p => !this._cacheItem(p));
    if (stale.length) {
      body.append(Dom.el('div', { class: 'field' }, Dom.el('label', {}, 'Placed, not in latest sync (' + stale.length + ')')));
      stale.forEach(p => {
        const row = Dom.el('div', { class: 'room-item' }, [
          Dom.el('div', { class: 'nm' }, (p.label || '?') + '  ✓'),
          Dom.el('div', { class: 'sl' }, p.kind),
        ]);
        row.onclick = () => this.removePlacement(p, room);
        body.append(row);
      });
    }
  }

  /** Drop a marker for a rack/device at the room centroid (clamped inside it). */
  placeItem(room, kind, item) {
    const pdata = this.store.placementData(this.building.dir, this.floor.id);
    if (pdata.placements.some(p => p.room === room.id && p.kind === kind && p.id === item.id)) return;
    const [cx, cy] = Geom.clampToPoly(...Geom.centroid(room.polygon), room.polygon);
    const p = { id: item.id, kind, room: room.id, loc: room.location.id,
      x: +cx.toFixed(5), y: +cy.toFixed(5), label: item.name, uid: Util.uid() };
    pdata.placements.push(p);
    this.selectedPlacement = p;   // ready to drag / rotate / resize immediately
    this.markPlacementsDirty(); this.render(); this.openRackPanel(room);
  }

  removePlacement(p, room) {
    if (!p) return;
    const arr = this.store.placementData(this.building.dir, this.floor.id).placements;
    const i = arr.indexOf(p);
    if (i >= 0) arr.splice(i, 1);
    if (this.selectedPlacement === p) this.selectedPlacement = null;
    if (this.editingLabel === p.uid) this.editingLabel = null;
    this.markPlacementsDirty(); this.render();
    if (room) this.openRackPanel(room);
  }

  /** Side panel for a selected marker: its identity, an Edit-label entry (shared
   *  label engine), delete, and a way back to the room's inventory list. */
  openPlacementPanel(p, room) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = p.label || (p.kind === 'rack' ? 'Rack' : 'Device');
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    const item = this._cacheItem(p);
    const type = DeviceShapes.typeFor(p, item);
    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, p.kind === 'rack' ? 'Rack' : 'Device'),
      Dom.el('div', { class: 'val' }, (p.label || '?') + ' · ' + type + (item ? '' : ' (not in latest sync)')),
      item && item.url ? Dom.el('div', {}, Dom.el('a', { href: item.url, target: '_blank' }, 'open in NetBox ↗')) : null,
    ]));

    body.append(Dom.el('div', { class: 'hint' },
      'Drag to move (snaps to grid) · top handle rotates (' + ANGLE_STEP
      + '°) · corner resizes · Alt bypasses snapping.'));

    body.append(Dom.el('button', { class: 'wide', onclick: () => this.editLabel(p, room),
      html: Icons.edit + '<span>Edit label</span>' }));
    body.append(Dom.el('div', { class: 'row' }, [
      Dom.el('button', { class: 'danger', onclick: () => this.removePlacement(p, room) }, 'Delete'),
      Dom.el('button', { onclick: () => { this.selectedPlacement = null; this.render(); this.openRackPanel(room); } }, 'Back to list'),
    ]));
  }

  /** Enter label-edit for a placement: reuse the shared label engine keyed by the
   *  placement uid (lazily back-filled for records that predate it). Done returns to
   *  the marker's panel. */
  editLabel(p, room) {
    p.uid = p.uid || Util.uid();
    this.selectedPlacement = p; this.editingLabel = p.uid;
    this.render();
    this.openLabelPanel(p, () => {
      this.editingLabel = null; this.render(); this.openPlacementPanel(p, room);
    }, p.label || '?');
  }

  /** Delete the selected marker with Delete/Backspace in racks mode; otherwise the
   *  base editor handles the key (draw undo, escape, …). */
  handleKey(e) {
    if (e.key === 'Escape' && this.arranging) { this.arranging = false; this.show(); return; }
    // Selected route arrow (edit mode, not mid-draw): exit label-edit, then delete or
    // deselect it. Delete is suppressed while the label is being edited.
    if (this.editing() && this.selectedArrow && !this.draft) {
      if (e.key === 'Escape' && this.editingLabel) {
        this.editingLabel = null; this.render(); this.openArrowPanel(this.selectedArrow); return; }
      if (!this.editingLabel && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault(); this.deleteArrow(this.selectedArrow); return; }
      if (e.key === 'Escape') {
        this.selectedArrow = null; this.editingLabel = null; this.render(); this.app.closePanel(); return; }
    }
    if (this.app.mode === 'racks' && this.selectedPlacement
        && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const p = this.selectedPlacement;
      this.removePlacement(p, this.data().rooms.find(r => r.id === p.room));
      return;
    }
    if (e.key === 'Escape' && this.app.mode === 'racks') {
      // Exit label-edit first (back to the marker panel), then deselect, then close.
      if (this.editingLabel) {
        this.editingLabel = null; this.render();
        const p = this.selectedPlacement, room = p && this.data().rooms.find(r => r.id === p.room);
        if (p && room) this.openPlacementPanel(p, room);
        return;
      }
      if (this.selectedPlacement) { this.selectedPlacement = null; this.render(); return; }
      if (this.rackRoom) { this.app.closePanel(); return; }   // closePanel → onPanelClosed drops back to edit
    }
    super.handleKey(e);
  }

  /** App.closePanel hook: a closed sidebar means we've left whatever it was driving.
   *  In racks mode that's placement itself — drop back to edit so the Place-racks button
   *  reflects reality (one click re-enters) and the zoom survives (in-place `_switchMode`,
   *  not `show()`). Skipped during a deliberate `_switchMode` (which already closes the
   *  panel) so entering/leaving racks doesn't recurse. */
  onPanelClosed() {
    if (this._switchingMode) return;
    if (this.app.mode === 'racks') { this._switchMode('edit'); return; }
    if (this.selectedArrow) { this.selectedArrow = null; this.editingLabel = null; this.render(); }
  }
}
