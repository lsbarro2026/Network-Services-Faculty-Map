'use strict';
/* store.js — single source of truth for loaded + edited data, plus persistence.
   Holds the manifest (read-only), room annotations, and user siteplan hotspots.
   Owns dirty flags; notifies via onDirty(kind) so views can refresh save badges. */

class Store {
  constructor() {
    this.manifest = null;          // { siteplan, buildings:[...] } from manifest.json
    this.annotations = {};         // "dir/floorId" -> { image,w,h, rooms:[...] }
    this.siteHotspots = [];        // user-drawn building hotspots [{id,dir,name,poly}]
    this.dirty = false;            // unsaved room annotations
    this.siteDirty = false;        // unsaved siteplan hotspots
    this.placementsDirty = false;  // unsaved rack/device placements
    this.nbRoomsByFloor = {};      // cache: floorKey -> NetBox rooms response
    this.rackCache = { locations: {}, syncedAt: null };  // synced rack inventory (regenerable)
    this.placements = {};          // "dir/floorId" -> { placements:[...] }
    this.layouts = {};             // "dir/floorId" -> { grid:[[col,row],...] } (sheet arrangement)
    this.layoutDirty = false;      // unsaved sheet arrangement
    this.onDirty = null;           // optional callback(kind:'floor'|'site'|'racks')
  }

  async load() {
    // Cache-bust the manifest so a fresh import (or re-import) is picked up immediately.
    this.manifest = await Api.get('/manifest.json?t=' + Date.now());
    this.annotations = await Api.get('/api/annotations');
    this.siteHotspots = (await Api.get('/api/siteplan')).hotspots || [];
    this.rackCache = await Api.get('/api/rackcache');
    this.placements = await Api.get('/api/rackplacements');
    this.layouts = await Api.get('/api/pagelayouts');
  }

  /** Whether a facility has been imported (manifest has at least one building). */
  hasContent() { return !!(this.manifest && this.manifest.buildings && this.manifest.buildings.length); }

  building(dir) { return this.manifest.buildings.find(b => b.dir === dir); }

  /** Resolve a floor's sheets + saved arrangement into geometry. The single place
   *  that knows how sheets tile the combined canvas: each sheet sits in one cell of
   *  a uniform grid (cell = max sheet w×h). Default (no saved grid) is a vertical
   *  stack (`col 0, row = page index`); single-page floors are one cell. Returns
   *  `{ cells:[{page,col,row,image,w,h,caption}], cellW, cellH, cols, rows, W, H }`. */
  floorLayout(dir, fid) {
    const f = this.building(dir).floors.find(x => x.id === fid);
    const pages = (f.pages && f.pages.length) ? f.pages
      : [{ image: f.image, w: f.w, h: f.h, caption: null }];
    const cellW = Math.max(...pages.map(p => p.w));
    const cellH = Math.max(...pages.map(p => p.h));
    const saved = this.layouts[Util.floorKey(dir, fid)];
    const grid = (saved && saved.grid && saved.grid.length === pages.length) ? saved.grid : null;
    const cells = pages.map((p, i) => {
      const [col, row] = grid ? grid[i] : [0, i];
      return { page: i, col, row, image: p.image, w: p.w, h: p.h, caption: p.caption };
    });
    const cols = Math.max(...cells.map(c => c.col)) + 1;
    const rows = Math.max(...cells.map(c => c.row)) + 1;
    return { cells, cellW, cellH, cols, rows, W: cols * cellW, H: rows * cellH };
  }

  /** Get (creating if absent) the annotation record for a floor. */
  floorData(dir, fid) {
    const key = Util.floorKey(dir, fid);
    if (!this.annotations[key]) {
      const f = this.building(dir).floors.find(x => x.id === fid);
      // Rooms are normalized over the whole tiled canvas → record its combined dims.
      const g = this.floorLayout(dir, fid);
      this.annotations[key] = { image: f.image, w: g.W, h: g.H, rooms: [], arrows: [] };
    }
    // Back-fill `arrows` on every call — records loaded from an existing
    // annotations.json predate the field and never pass the create branch above.
    const rec = this.annotations[key];
    if (!rec.arrows) rec.arrows = [];
    return rec;
  }

  /** Persist a floor's sheet arrangement (grid is [[col,row],...] per page index). */
  setLayout(dir, fid, grid) {
    this.layouts[Util.floorKey(dir, fid)] = { grid };
    this.markLayoutDirty();
  }

  /** Get (creating if absent) the rack/device placement record for a floor. */
  placementData(dir, fid) {
    const key = Util.floorKey(dir, fid);
    if (!this.placements[key]) this.placements[key] = { placements: [] };
    return this.placements[key];
  }

  /** Synced racks + unracked devices for a NetBox Location id. */
  racksForLocation(locId) {
    return (locId != null && this.rackCache.locations[locId]) || { racks: [], devices: [] };
  }

  markDirty() { this.dirty = true; if (this.onDirty) this.onDirty('floor'); }
  markSiteDirty() { this.siteDirty = true; if (this.onDirty) this.onDirty('site'); }
  markPlacementsDirty() { this.placementsDirty = true; if (this.onDirty) this.onDirty('racks'); }
  markLayoutDirty() { this.layoutDirty = true; if (this.onDirty) this.onDirty('floor'); }
  hasUnsaved() { return this.dirty || this.siteDirty || this.placementsDirty || this.layoutDirty; }

  /** Persist annotations (floors with neither rooms nor arrows are pruned). */
  async saveAnnotations() {
    const out = {};
    for (const k in this.annotations) {
      const rec = this.annotations[k];
      if (rec.rooms.length || (rec.arrows && rec.arrows.length)) out[k] = rec;
    }
    await Api.post('/api/annotations', out);
    this.dirty = false; if (this.onDirty) this.onDirty('floor');
  }

  async saveSiteplan() {
    await Api.post('/api/siteplan', { hotspots: this.siteHotspots });
    this.siteDirty = false; if (this.onDirty) this.onDirty('site');
  }

  /** Persist rack/device placements (floors with no placements are pruned). */
  async savePlacements() {
    const out = {};
    for (const k in this.placements)
      if (this.placements[k].placements.length) out[k] = this.placements[k];
    await Api.post('/api/rackplacements', out);
    this.placements = out;
    this.placementsDirty = false; if (this.onDirty) this.onDirty('racks');
  }

  /** Persist sheet arrangements (a default/vertical-stack grid is pruned). */
  async saveLayouts() {
    const out = {};
    for (const k in this.layouts) {
      const grid = this.layouts[k].grid;
      // A vertical stack (col 0, row = index) is the default — no need to store it.
      if (grid && grid.some(([c, r], i) => c !== 0 || r !== i)) out[k] = { grid };
    }
    await Api.post('/api/pagelayouts', out);
    this.layouts = out;
    this.layoutDirty = false; if (this.onDirty) this.onDirty('floor');
  }

  /** Re-fetch the rack cache after a sync. */
  async reloadRackCache() { this.rackCache = await Api.get('/api/rackcache'); }
}
