'use strict';
/* editor.js — Editor: abstract base for the polygon editors.
   Encapsulates the shared engine: an <svg> overlay on an image, normalized
   coordinates, grid + vertex/edge snapping, polygon drawing with a live cursor,
   undo, vertex dragging, and grid move/resize. Subclasses (FloorEditor,
   SiteplanEditor) supply the data + the meaning of a shape.

   Subclasses MUST implement: render(), polys(), editing(), finish(), deselect(),
   markDirty(). Coordinates everywhere are normalized 0..1 to the image. */

class Editor {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.grid = app.grid;          // shared GridController
    this.viewport = new PanZoom(); // per-view pan/zoom transform on the .map-wrap
    this.snapOn = true;
    this.orthoOn = false;          // right-angle snap: align a dragged node to its neighbours
    this.img = null;               // <img> background
    this.svg = null;               // <svg> overlay
    this.dims = null;              // [iw, ih] intrinsic image px
    this.draft = null;             // { points:[[nx,ny]], cursor:{pt,kind} } while drawing
    this.selected = null;          // selected shape id
    this.editingLabel = null;      // id of the shape whose label is being moved/styled
    this.dragVertex = null;        // { poly, i, exclude, dirty } while dragging
    this.gridDrag = null;          // { x, y, ox, oy } while moving grid
    this.dragItem = null;          // { move(nx,ny) } while dragging a free point (e.g. a rack marker)
    this.dragSheet = null;         // { move(nx,ny), drop() } while dragging a whole sheet (Arrange mode)
    this.pan = null;               // { x, y, moved, btn } while panning the viewport
    this._dragDown = null;         // { x, y, moved } press origin for the vertex/item drag threshold
    this._suppressClick = false;   // swallow the click that ends a left-button pan drag
    this.initialFocus = null;      // [nx0,ny0,nx1,ny1] to frame on first mount, else full fit
  }

  // ---- abstract (subclass responsibilities) ----
  render() { throw new Error('render() not implemented'); }
  polys() { return []; }           // [{ id, polygon }] used for snapping
  editing() { return false; }
  // Whether grid drawing + move/resize are available here. Defaults to edit mode;
  // FloorEditor also enables it in racks mode (where editing() is false).
  gridActive() { return this.editing(); }
  finish() {}                      // close the current draft into a shape
  deselect() {}
  markDirty() {}

  // ---- geometry / coordinates ----
  // The displayed (unscaled layout px) size of the whole drawing surface. Reads
  // the .map-wrap, not a single <img>, so it spans every stacked sheet of a
  // multi-page floor. clientWidth/Height ignore the pan/zoom transform (keep it —
  // getBoundingClientRect would fold the scale in).
  dispSize() { return [this.wrap.clientWidth, this.wrap.clientHeight]; }
  evtNorm(e) {
    const r = this.svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  /** Snap a normalized point. Priority: existing vertex > existing edge > grid.
   *  `exclude` ignores a shape's own geometry (the one being dragged). */
  snapPoint(nx, ny, exclude) {
    const [W, H] = this.dispSize(), [iw, ih] = this.dims;
    const px = nx * W, py = ny * H;
    const polys = this.polys();
    // Distances below are in layout px; divide the visual threshold by the zoom
    // scale so snapping feels the same at any zoom level.
    const snapPx = SNAP_PX / this.viewport.scale;
    let kind = null, out = [nx, ny];
    if (this.snapOn) {
      let best = snapPx, bv = null;
      for (const r of polys) {
        if (r.id === exclude) continue;
        for (const v of r.polygon) {
          const d = Math.hypot(px - v[0] * W, py - v[1] * H);
          if (d < best) { best = d; bv = v; }
        }
      }
      if (bv) return { pt: [bv[0], bv[1]], kind: 'vertex' };
      let beste = snapPx, be = null, beSeg = null;
      for (const r of polys) {
        if (r.id === exclude) continue;
        const pl = r.polygon;
        for (let i = 0; i < pl.length; i++) {
          const a = pl[i], b = pl[(i + 1) % pl.length];
          const ax = a[0] * W, ay = a[1] * H, bx = b[0] * W, by = b[1] * H;
          const pr = Geom.projSeg(px, py, ax, ay, bx, by);
          if (pr.d < beste) { beste = pr.d; be = [pr.x / W, pr.y / H]; beSeg = [ax, ay, bx, by]; }
        }
      }
      if (be) { out = be; kind = 'edge'; }
      // Keep an edge-snapped node ON the wall but quantize its position ALONG the
      // wall to the grid: snap the projected point to the grid, then re-project that
      // grid point back onto the winning segment. Otherwise the node slides freely
      // along the wall and yields uneven geometry.
      if (kind === 'edge' && this.grid.on) {
        const gx = this.grid.snap(out[0] * iw, this.grid.ox) / iw * W;
        const gy = this.grid.snap(out[1] * ih, this.grid.oy) / ih * H;
        const pr = Geom.projSeg(gx, gy, beSeg[0], beSeg[1], beSeg[2], beSeg[3]);
        out = [pr.x / W, pr.y / H];
      }
    }
    if (kind === null && this.grid.on) {
      out = [this.grid.snap(out[0] * iw, this.grid.ox) / iw,
             this.grid.snap(out[1] * ih, this.grid.oy) / ih];
      kind = 'grid';
    }
    return { pt: [+out[0].toFixed(5), +out[1].toFixed(5)], kind };
  }

  /** Right-angle ("ortho") constraint for a point being placed/dragged, relative to
   *  its `neighbours` (the points it will connect to: a dragged vertex's two adjacent
   *  nodes, or while drawing the previous point — and the first point, for closing). If
   *  the pointer is within ORTHO_PX of making an edge to a neighbour horizontal or
   *  vertical, lock that axis to the neighbour's coordinate (so the two edges meet at
   *  90°); the un-locked axis still snaps to the grid. Returns the constrained point
   *  plus `engaged` = `{x,y}` naming the neighbour each axis locked to (for the
   *  on-screen indicator), or null when nothing locked. */
  orthoSnap(nx, ny, neighbours) {
    const [W, H] = this.dispSize(), [iw, ih] = this.dims;
    const thresh = ORTHO_PX / this.viewport.scale;
    let x = nx, y = ny, ex = null, ey = null;
    for (const nb of neighbours) {
      if (Math.abs((nx - nb[0]) * W) < thresh) { x = nb[0]; ex = nb; break; }
    }
    for (const nb of neighbours) {
      if (nb === ex) continue;   // don't lock both axes to one neighbour (would collapse the point onto it)
      if (Math.abs((ny - nb[1]) * H) < thresh) { y = nb[1]; ey = nb; break; }
    }
    if (this.grid.on) {
      if (ex === null) x = this.grid.snap(x * iw, this.grid.ox) / iw;
      if (ey === null) y = this.grid.snap(y * ih, this.grid.oy) / ih;
    }
    return { pt: [+x.toFixed(5), +y.toFixed(5)], engaged: (ex || ey) ? { x: ex, y: ey } : null };
  }

  /** Snap a point being placed or dragged. A vertex/edge snap to ANOTHER shape is the
   *  strongest intent and wins; otherwise, when right-angle snap is on and the point
   *  has `neighbours`, align it to a right angle (`orthoSnap`); else fall back to the
   *  plain vertex/edge/grid result. Returns `{ pt, kind, ortho }` (`ortho` = the
   *  engaged indicator info, or null). Shared by drawing and vertex dragging. */
  _placePoint(nx, ny, neighbours, exclude) {
    const snap = this.snapPoint(nx, ny, exclude);
    if (this.orthoOn && neighbours.length && snap.kind !== 'vertex' && snap.kind !== 'edge') {
      const o = this.orthoSnap(nx, ny, neighbours);
      return { pt: o.pt, kind: snap.kind, ortho: o.engaged };
    }
    return { pt: snap.pt, kind: snap.kind, ortho: null };
  }

  /** The points a draft's next/closing point should right-angle-align to: the last
   *  placed point (the edge being drawn) and the first point (to square up on close). */
  _draftNeighbours() {
    const dp = this.draft.points, nb = [];
    if (dp.length) nb.push(dp[dp.length - 1]);
    if (dp.length > 1) nb.push(dp[0]);
    return nb;
  }

  // ---- drawing lifecycle ----
  // `kind` is 'poly' (a closed polygon: rooms, hotspots) or 'arrow' (an open
  // polyline: wayfinding routes). It changes how a click finishes the draft
  // (polygons close near the first point; arrows never do) and how it renders.
  beginDraw(msg, kind = 'poly') { this.draft = { points: [], cursor: null, kind }; this.selected = null; if (msg) Toast.show(msg); this.render(); }
  undoNode() { if (this.draft && this.draft.points.length) { this.draft.points.pop(); this.draft.cursor = null; this.render(); } }

  /** Wire pointer/keyboard interactions onto the svg. Called once per mount.
   *  The svg lives in `.map-wrap` (the transformed element) inside `.map-viewport`
   *  (the clip box / pan viewport). */
  attach(img, svgEl, dims) {
    this.img = img; this.svg = svgEl; this.dims = dims;
    this._bindPointer();
    const wrap = svgEl.parentNode, container = wrap.parentNode;
    this.wrap = wrap;
    this.viewport.mount(wrap, container);
    container.append(this._zoomControls());
    // Fit once the wrap has real dimensions. A floor can tile several sheets, so
    // wait for every <img> to load before measuring (each one grows the wrap). A
    // multi-sheet floor frames its first sheet (this.initialFocus); else full fit.
    const fit = () => {
      this.render();
      this.initialFocus ? this.viewport.fitRegion(...this.initialFocus) : this.viewport.fit();
    };
    const imgs = [...wrap.querySelectorAll('img')];
    let pending = imgs.filter(im => !im.complete).length;
    pending ? imgs.forEach(im => im.complete || im.addEventListener('load',
      () => { if (--pending === 0) fit(); })) : fit();
    new ResizeObserver(() => { this.render(); this.viewport.onResize(); }).observe(container);
  }

  _bindPointer() {
    const s = this.svg;
    // Record the press origin for the vertex/item drag threshold. Capture phase so it
    // fires before a vertex/marker handler's stopPropagation hides the event from us.
    s.addEventListener('pointerdown', (e) => {
      this._dragDown = { x: e.clientX, y: e.clientY, moved: false };
    }, true);
    s.addEventListener('click', (e) => {
      if (this._suppressClick) { this._suppressClick = false; return; }
      if (!this.editing() || this.grid.adjust) return;
      if (this.draft) {
        const snapped = this._placePoint(...this.evtNorm(e), this._draftNeighbours()).pt;
        const dp = this.draft.points;
        // Polygons close when you click near the first point; an open arrow never does.
        if (this.draft.kind !== 'arrow' && dp.length >= 3) {
          const [W, H] = this.dispSize();
          const d = Math.hypot((snapped[0] - dp[0][0]) * W, (snapped[1] - dp[0][1]) * H);
          if (d < CLOSE_PX / this.viewport.scale) return this.finish();
        }
        dp.push(snapped); this.draft.cursor = null; this.render();
      } else { this.deselect(); }
    });
    s.addEventListener('dblclick', (e) => { e.preventDefault(); if (this.draft) this.finish(); });
    s.addEventListener('pointerdown', (e) => {
      if (this.grid.adjust && this.gridActive()) {
        this.gridDrag = { x: e.clientX, y: e.clientY, ox: this.grid.ox, oy: this.grid.oy };
        s.setPointerCapture(e.pointerId); return;
      }
      // Pan: middle button anywhere, or left button on empty map background
      // (the svg itself or the transparent catcher — never a shape or vertex).
      const onBackground = e.target === s || e.target.classList.contains('catcher');
      if (e.button === 1 || (e.button === 0 && onBackground)) {
        this.pan = { x: e.clientX, y: e.clientY, moved: false, btn: e.button };
        s.setPointerCapture(e.pointerId);
      }
    });
    s.addEventListener('pointermove', (e) => {
      if (this.pan) {
        const dx = e.clientX - this.pan.x, dy = e.clientY - this.pan.y;
        if (!this.pan.moved && Math.hypot(dx, dy) < 4) return;
        this.pan.moved = true; this.pan.x = e.clientX; this.pan.y = e.clientY;
        s.classList.add('panning'); this.viewport.panBy(dx, dy); return;
      }
      if (this.gridDrag) {
        const [W, H] = this.dispSize(), [iw, ih] = this.dims, k = this.viewport.scale;
        this.grid.ox = this.gridDrag.ox + (e.clientX - this.gridDrag.x) / k / W * iw;
        this.grid.oy = this.gridDrag.oy + (e.clientY - this.gridDrag.y) / k / H * ih;
        this.render(); return;
      }
      if (this.dragSheet) { this.dragSheet.move(...this.evtNorm(e)); return; }
      // A vertex/marker press only becomes an edit once the pointer travels past a
      // small threshold; below it the press is a select/inspect click and must not
      // move geometry or mark the store dirty (else a stray click looks like an edit).
      if ((this.dragItem || this.dragVertex) && !this._pastDragThreshold(e)) return;
      if (this.dragItem) { this.dragItem.move(...this.evtNorm(e), e); return; }
      if (this.dragVertex) {
        // A midpoint press defers inserting its node until the drag really starts, so
        // clicking a midpoint without dragging adds nothing (and stays clean).
        if (this.dragVertex.pending) {
          this.dragVertex.poly.splice(this.dragVertex.i, 0, this.dragVertex.point);
          this.dragVertex.pending = false;
        }
        const { poly, i, exclude, dirty, closed } = this.dragVertex;
        const n = poly.length;
        // Right-angle neighbours are the adjacent nodes. A closed polygon wraps; an
        // open path (arrow) has none past its two ends, so don't wrap across them.
        const nbs = closed === false
          ? [i > 0 ? poly[i - 1] : null, i < n - 1 ? poly[i + 1] : null].filter(Boolean)
          : [poly[(i - 1 + n) % n], poly[(i + 1) % n]];
        const r = this._placePoint(...this.evtNorm(e), nbs, exclude);
        poly[i] = [Math.max(0, Math.min(1, r.pt[0])), Math.max(0, Math.min(1, r.pt[1]))];
        this.dragVertex.ortho = r.ortho;
        dirty(); this.render(); return;
      }
      if (this.draft) {
        const r = this._placePoint(...this.evtNorm(e), this._draftNeighbours());
        this.draft.cursor = { pt: r.pt, kind: r.kind, ortho: r.ortho };
        this.render();
      }
    });
    s.addEventListener('pointerup', () => {
      // A sheet drag ends here: commit the move (which re-renders) and swallow the
      // trailing click so it doesn't deselect/draw.
      if (this.dragSheet) { this._suppressClick = true; const d = this.dragSheet; this.dragSheet = null; d.drop(); return; }
      // A left-button pan is followed by a click event — swallow that one click.
      if (this.pan && this.pan.moved && this.pan.btn === 0) this._suppressClick = true;
      // A vertex/handle press or drag also ends with a synthetic click on the svg;
      // swallow it so it doesn't fall through to the background-click deselect,
      // keeping the shape selected for the next node edit.
      if (this.dragVertex || this.dragItem) this._suppressClick = true;
      const hadVertex = !!this.dragVertex;
      this.pan = null; s.classList.remove('panning');
      this.dragVertex = null; this.gridDrag = null; this.dragItem = null;
      if (hadVertex) this.render();   // drop the transient right-angle guide
    });
    s.addEventListener('pointerleave', () => {
      if (this.draft && this.draft.cursor) { this.draft.cursor = null; this.render(); }
    });
    s.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.grid.adjust && this.gridActive()) { this.grid.resize(e.deltaY); this.render(); return; }
      this.viewport.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX, y: e.clientY });
    }, { passive: false });
  }

  /** True once a vertex/marker press has travelled far enough to count as a drag
   *  (latched, like the pan threshold). Below it the press is a select/inspect click. */
  _pastDragThreshold(e) {
    const d = this._dragDown;
    if (!d || d.moved) return true;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return false;
    d.moved = true; return true;
  }

  handleKey(e) {
    if (e.key === 'Enter' && this.draft) { this.finish(); return; }
    if ((e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) && this.draft) {
      e.preventDefault(); this.undoNode(); return;
    }
    if (e.key === '+' || e.key === '=') { this.viewport.zoomBy(1.3); return; }
    if (e.key === '-' || e.key === '_') { this.viewport.zoomBy(1 / 1.3); return; }
    if (e.key === '0') { this.viewport.fit(); return; }
    if (e.key === 'Escape') {
      if (this.draft) { this.draft = null; this.render(); }
      else if (this.selected) { this.selected = null; this.render(); this.app.closePanel(); }
    }
  }

  // ---- shared render helpers (subclasses call these inside render()) ----
  prepareSvg(s) {
    s.innerHTML = '';
    s.classList.toggle('draw-active', !!this.draft);
    s.classList.toggle('grid-adjust', this.gridActive() && this.grid.adjust);
  }
  addCatcher(s, W, H) {
    // Always catches background pointer events (for panning and, in edit mode,
    // for drawing). Shapes are drawn on top, so their clicks still take priority.
    const c = Dom.svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', class: 'catcher' });
    c.style.pointerEvents = 'all';
    s.append(c);
  }
  /** Editable vertices for the selected shape: drag a vertex to reshape, drag a
   *  midpoint handle to insert a node on that edge, right-click a vertex to remove
   *  it (kept at >= `minPts` points). Midpoints are drawn first so the draggable
   *  vertices sit on top. Insert/remove reuse the `dragVertex` channel (capture is on
   *  the svg, so it survives the render() that rebuilds the handles).
   *  `opts.closed` (default true) treats `poly` as a closed polygon (rooms, hotspots);
   *  false treats it as an open polyline (arrows) — no midpoint/ortho on the phantom
   *  edge from the last point back to the first. `opts.minPts` is the removal floor. */
  drawVertices(s, poly, W, H, excludeId, dirtyFn, opts = {}) {
    const { closed = true, minPts = 3 } = opts;
    const dv = this.dragVertex;
    if (dv && dv.poly === poly && dv.ortho) this._drawOrthoGuide(s, poly[dv.i], dv.ortho, W, H);
    const segs = closed ? poly.length : poly.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const m = Dom.svg('circle', { cx: mx * W, cy: my * H, r: 4, class: 'vertex midpoint' });
      m.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        // Defer the insert until the drag passes the threshold (see pointermove), so a
        // click on a midpoint that never drags adds no node and leaves the shape clean.
        this.dragVertex = { poly, i: i + 1, point: [+mx.toFixed(5), +my.toFixed(5)],
          pending: true, exclude: excludeId, dirty: dirtyFn, closed };
        s.setPointerCapture(e.pointerId);
      });
      s.append(m);
    }
    poly.forEach((p, i) => {
      const v = Dom.svg('circle', { cx: p[0] * W, cy: p[1] * H, r: 5, class: 'vertex' });
      v.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        this.dragVertex = { poly, i, exclude: excludeId, dirty: dirtyFn, closed };
        s.setPointerCapture(e.pointerId);
      });
      v.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (poly.length <= minPts) { Toast.show('Needs at least ' + minPts + ' points'); return; }
        poly.splice(i, 1); dirtyFn(); this.render();
      });
      s.append(v);
    });
  }
  /** Indicator for an in-progress right-angle snap: draw each locked edge as an
   *  accent guide to its neighbour, and a small square corner glyph at the `node`
   *  (normalized) when both axes lock (a true 90° corner). `ortho` is
   *  `Editor.orthoSnap`'s `engaged`. Used for a dragged vertex and the draft cursor. */
  _drawOrthoGuide(s, node, ortho, W, H) {
    const x = node[0] * W, y = node[1] * H;
    const guide = (nb) => s.append(Dom.svg('line',
      { x1: x, y1: y, x2: nb[0] * W, y2: nb[1] * H, class: 'ortho-guide' }));
    if (ortho.x) guide(ortho.x);
    if (ortho.y) guide(ortho.y);
    if (ortho.x && ortho.y) {
      const d = 11 / this.viewport.scale;
      const sx = ortho.y[0] * W >= x ? 1 : -1;   // toward the horizontal-edge neighbour
      const sy = ortho.x[1] * H >= y ? 1 : -1;   // toward the vertical-edge neighbour
      s.append(Dom.svg('path', { class: 'ortho-corner', fill: 'none',
        d: `M ${x + sx * d} ${y} L ${x + sx * d} ${y + sy * d} L ${x} ${y + sy * d}` }));
    }
  }

  drawDraft(s, W, H) {
    if (!this.draft || !this.draft.points.length) return;
    const dp = this.draft.points, cur = this.draft.cursor;
    const arrow = this.draft.kind === 'arrow';
    const chain = cur ? dp.concat([cur.pt]) : dp;
    // An arrow draft is an open route — no area fill (the `.draft` class fills the
    // implied closed shape for polygons, which would shade the arrow like a room).
    s.append(Dom.svg('polyline', { points: chain.map(p => `${p[0] * W},${p[1] * H}`).join(' '),
      class: 'draft' + (arrow ? ' open' : ''), fill: 'none' }));
    // An arrow draft previews its head at the leading end so the direction is clear;
    // its first point gets no 'first' emphasis (there is nothing to close onto).
    if (arrow && chain.length >= 2) {
      const a = chain[chain.length - 2], b = chain[chain.length - 1];
      const tri = Geom.arrowHead(a[0] * W, a[1] * H, b[0] * W, b[1] * H, ARROW_HEAD_PX);
      s.append(Dom.svg('polygon', { points: tri.map(p => p.join(',')).join(' '), class: 'draft-head' }));
    }
    dp.forEach((p, i) => s.append(Dom.svg('circle', { cx: p[0] * W, cy: p[1] * H, r: 5, class: 'vertex' + (!arrow && i === 0 ? ' first' : '') })));
    if (cur && cur.ortho) this._drawOrthoGuide(s, cur.pt, cur.ortho, W, H);
    if (cur) s.append(Dom.svg('circle', { cx: cur.pt[0] * W, cy: cur.pt[1] * H, r: cur.kind === 'vertex' ? 7 : 5, class: 'snap-cursor' + (cur.kind ? ' k-' + cur.kind : '') }));
  }

  // ---- label editing (shared by both editors) ----
  // A shape (siteplan hotspot / floor room) carries an optional `labelStyle`
  // `{x,y,rot,size,font,color}`; absent fields fall back to the auto-placed label.
  // While `editingLabel === shape.id` the label is draggable and grows rotate +
  // resize handles. Geometry mirrors FloorEditor._placementHandles.

  /** Lazily create the shape's labelStyle so a control/handle can write to it. */
  _labelStyle(shape) { return shape.labelStyle || (shape.labelStyle = {}); }

  // Identity + dirty hooks so the label engine serves more than one shape kind.
  // Base = a shape keyed by `id`, dirtying the room/hotspot store. FloorEditor
  // overrides these for placements (keyed by `uid`, dirtying the placement store).
  _labelKey(shape) { return shape.id; }
  _labelDirty(shape) { this.markDirty(); }

  /** Set centered, vertically-balanced lines on a label `<text>` (origin x:0). One
   *  line is plain text; several become tspans so a user can hand-break the label. */
  _setLabelLines(t, lines) {
    t.textContent = '';
    if (lines.length <= 1) { t.textContent = lines[0] || ''; return; }
    const lh = 1.2;   // em line-height (matches the old 2-line layout: -0.6 / +1.2)
    lines.forEach((ln, i) => {
      const span = Dom.svg('tspan', { x: 0,
        dy: i === 0 ? (-(lines.length - 1) / 2 * lh).toFixed(3) + 'em' : lh + 'em' });
      span.textContent = ln === '' ? ' ' : ln;   // keep a blank line from collapsing
      t.append(span);
    });
  }

  /** Wrap a centered `<text>` (content + font-size already set) in a
   *  `translate(cx,cy) rotate(rot)` group, apply the labelStyle font/colour, and —
   *  when this shape's label is being edited — make it draggable and add handles.
   *  `cx,cy` are the label-centre in normalized coords; `sizePx` is the text's
   *  current font-size (used to map a resize drag back to a font-size). */
  attachLabel(s, shape, textEl, cx, cy, sizePx, W, H) {
    const ls = shape.labelStyle || {};
    if (ls.font) textEl.style.fontFamily = ls.font;
    if (ls.color) textEl.style.fill = ls.color;
    const g = Dom.svg('g', { class: 'label-grp',
      transform: `translate(${cx * W},${cy * H}) rotate(${ls.rot || 0})` });
    g.append(textEl);
    s.append(g);
    if (this.editingLabel !== this._labelKey(shape)) return g;

    // Drag the label to move it (snaps to the grid; Alt frees it). Keep the grab
    // offset so it doesn't jump its centre under the cursor.
    textEl.style.pointerEvents = 'auto';
    textEl.style.cursor = 'move';
    textEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const [sx, sy] = this.evtNorm(e), offx = cx - sx, offy = cy - sy;
      this.dragItem = { move: (nx, ny, ev) => {
        let x = nx + offx, y = ny + offy;
        if (this.grid.on && !(ev && ev.altKey)) {
          const [iw, ih] = this.dims;
          x = this.grid.snap(x * iw, this.grid.ox) / iw;
          y = this.grid.snap(y * ih, this.grid.oy) / ih;
        }
        const st = this._labelStyle(shape);
        st.x = +Math.max(0, Math.min(1, x)).toFixed(5);
        st.y = +Math.max(0, Math.min(1, y)).toFixed(5);
        this._labelDirty(shape); this.render();
      } };
      s.setPointerCapture(e.pointerId);
    });

    const bb = textEl.getBBox();
    this._drawLabelHandles(s, shape, g, cx, cy, bb.width / 2, bb.height / 2, sizePx, W, H);
    return g;
  }

  /** Rotate handle (above the text) + resize handle (bottom-right corner) for the
   *  label being edited. Rotation snaps to ANGLE_STEP°, resize maps the un-rotated
   *  vertical extent back to a font-size; Alt frees the rotation snap. Both ride the
   *  shared `dragItem` channel. */
  _drawLabelHandles(s, shape, g, cx, cy, halfW, halfH, sizePx, W, H) {
    const ry = -halfH - 16;
    g.append(Dom.svg('line', { x1: 0, y1: -halfH, x2: 0, y2: ry, class: 'label-stem' }));
    const rot = Dom.svg('circle', { cx: 0, cy: ry, r: 5, class: 'label-handle' });
    rot.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.dragItem = { move: (nx, ny, ev) => {
        const dx = (nx - cx) * W, dy = (ny - cy) * H;
        let deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (!(ev && ev.altKey)) deg = Math.round(deg / ANGLE_STEP) * ANGLE_STEP;
        this._labelStyle(shape).rot = ((Math.round(deg) % 360) + 360) % 360;
        this._labelDirty(shape); this.render();
      } };
      s.setPointerCapture(e.pointerId);
    });
    g.append(rot);

    const size = Dom.svg('rect', { x: halfW + 2, y: halfH + 2, width: 9, height: 9, class: 'label-handle' });
    size.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rad = (shape.labelStyle && shape.labelStyle.rot || 0) * Math.PI / 180;
      const cs = Math.cos(rad), si = Math.sin(rad);
      this.dragItem = { move: (nx, ny) => {
        const ex = (nx - cx) * W, ey = (ny - cy) * H;
        const ly = -ex * si + ey * cs;                  // un-rotate into the label frame
        const next = halfH ? Math.abs(ly) / halfH * sizePx : sizePx;
        this._labelStyle(shape).size = +Math.max(LABEL_SIZE_MIN, Math.min(LABEL_SIZE_MAX, next)).toFixed(1);
        this._labelDirty(shape); this.render();
      } };
      s.setPointerCapture(e.pointerId);
    });
    g.append(size);
  }

  /** Open the side panel with controls for the shape's label (display text / font /
   *  size / rotation / colour / reset). Editing the text is **purely visual** — it
   *  overrides only how the label is drawn (spacing, hand-inserted line breaks), never
   *  the shape's bound name. `defaultText` is the auto label to fall back to; `onDone`
   *  returns to the shape's normal panel. */
  openLabelPanel(shape, onDone, defaultText = '') {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Edit label';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'hint' },
      'Drag the label to move (snaps to grid), the top handle to rotate (' + ANGLE_STEP
      + '°), the corner to resize. Hold Alt to bypass snapping.'));

    const field = (label, ctl) => Dom.el('div', { class: 'field' }, [Dom.el('label', {}, label), ctl]);

    // Display text only — line breaks control wrapping; the bound name is unchanged.
    const textArea = Dom.el('textarea', { class: 'label-ctl text', rows: 2, placeholder: defaultText });
    textArea.value = (shape.labelStyle && shape.labelStyle.text != null) ? shape.labelStyle.text : defaultText;
    textArea.oninput = () => {
      const v = textArea.value, st = this._labelStyle(shape);
      if (v.trim() === '' || v === defaultText) delete st.text;   // revert to the auto label
      else st.text = v;
      this._labelDirty(shape); this.render();
    };
    body.append(field('Label text (display only — Enter adds a line break)', textArea));

    const fontSel = Dom.el('select', { class: 'label-ctl' });
    LABEL_FONTS.forEach(f => {
      const o = Dom.el('option', { value: f.css }, f.name);
      if (shape.labelStyle && shape.labelStyle.font === f.css) o.selected = true;
      fontSel.append(o);
    });
    fontSel.onchange = () => { this._labelStyle(shape).font = fontSel.value; this._labelDirty(shape); this.render(); };
    body.append(field('Font', fontSel));

    const sizeInp = Dom.el('input', { type: 'number', min: LABEL_SIZE_MIN, max: LABEL_SIZE_MAX, step: 1, class: 'label-ctl', placeholder: 'auto' });
    if (shape.labelStyle && shape.labelStyle.size != null) sizeInp.value = Math.round(shape.labelStyle.size);
    sizeInp.oninput = () => { const v = +sizeInp.value; if (v) { this._labelStyle(shape).size = v; this._labelDirty(shape); this.render(); } };
    body.append(field('Size (px)', sizeInp));

    const rotInp = Dom.el('input', { type: 'number', step: ANGLE_STEP, class: 'label-ctl' });
    rotInp.value = (shape.labelStyle && shape.labelStyle.rot) || 0;
    rotInp.oninput = () => { this._labelStyle(shape).rot = ((+rotInp.value % 360) + 360) % 360; this._labelDirty(shape); this.render(); };
    body.append(field('Rotation (°)', rotInp));

    const colInp = Dom.el('input', { type: 'color', class: 'label-ctl color' });
    colInp.value = (shape.labelStyle && shape.labelStyle.color) || '#ffffff';
    colInp.oninput = () => { this._labelStyle(shape).color = colInp.value; this._labelDirty(shape); this.render(); };
    body.append(field('Color', colInp));

    body.append(Dom.el('button', { class: 'wide', onclick: () => {
      delete shape.labelStyle; this._labelDirty(shape); this.render(); onDone();
    } }, 'Reset to auto'));
    body.append(Dom.el('button', { class: 'wide primary', onclick: onDone }, 'Done'));
  }

  /** Floating zoom controls (+ / − / fit) for the map viewport corner. */
  _zoomControls() {
    const btn = (label, title, fn) => Dom.el('button', { title, type: 'button',
      onclick: () => fn() }, label);
    return Dom.el('div', { class: 'zoom-ctl' }, [
      btn('+', 'Zoom in', () => this.viewport.zoomBy(1.3)),
      btn('−', 'Zoom out', () => this.viewport.zoomBy(1 / 1.3)),
      btn('⤢', 'Reset to fit', () => this.viewport.fit()),
    ]);
  }

  // ---- shared toolbar buttons ----
  /** A vertical divider that groups related toolbar controls. */
  toolDivider() { return Dom.el('span', { class: 'tb-div' }); }

  /** innerHTML for a saved/unsaved status badge (green check when saved). */
  badgeHtml(dirty) { return dirty ? '<span>● unsaved</span>' : Icons.check + '<span>saved</span>'; }

  undoButton() {
    return Dom.el('button', { onclick: () => this.undoNode(), html: Icons.undo + '<span>Undo point</span>' });
  }
  snapButton() {
    const b = Dom.el('button', { class: this.snapOn ? 'active' : '', title: 'Snap to nearby vertices/edges', html: Icons.snap + '<span>Snap</span>' });
    b.onclick = () => { this.snapOn = !this.snapOn; b.classList.toggle('active', this.snapOn); };
    return b;
  }
  orthoButton() {
    const b = Dom.el('button', { class: this.orthoOn ? 'active' : '', title: 'Right-angle snap: align a dragged node to its neighbours (90° corners)', html: Icons.rightangle + '<span>Right angle</span>' });
    b.onclick = () => { this.orthoOn = !this.orthoOn; b.classList.toggle('active', this.orthoOn); };
    return b;
  }
  gridToggleButton() {
    const b = Dom.el('button', { class: this.grid.on ? 'active' : '', html: Icons.grid + '<span>Grid</span>' });
    b.onclick = () => { this.grid.on = !this.grid.on; b.classList.toggle('active', this.grid.on); this.render(); };
    return b;
  }
  gridSizeSelect() {
    const sel = Dom.el('select', { title: 'Grid size (image px)' });
    [4, 8, 12, 25, 50].forEach((v) => {
      const o = Dom.el('option', { value: v }, v + ' px');
      if (v === this.grid.step) o.selected = true;
      sel.append(o);
    });
    sel.onchange = () => { this.grid.step = +sel.value; this.render(); };
    return sel;
  }
  gridMoveButton() {
    const b = Dom.el('button', { class: this.grid.adjust ? 'active' : '', title: 'Drag to move the grid · scroll to resize', html: Icons.move + '<span>Move grid</span>' });
    b.onclick = () => { this.grid.adjust = !this.grid.adjust; b.classList.toggle('active', this.grid.adjust); if (this.grid.adjust) Toast.show('Drag to move the grid · scroll to resize'); };
    return b;
  }
}
