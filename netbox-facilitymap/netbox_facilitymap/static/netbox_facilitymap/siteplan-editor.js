'use strict';
/* siteplan-editor.js — SiteplanEditor: the siteplan view + an edit mode for
   drawing user building hotspots (e.g. the trailers the source PDF never placed).
   In view mode it renders the PDF hotspots + user hotspots as clickable building
   links. Extends Editor; shapes are buildings rather than rooms. */

class SiteplanEditor extends Editor {
  constructor(app) {
    super(app);
    this._badge = null;
    this._promoted = null;   // id of a PDF hotspot promoted to a user hotspot but not yet edited
  }

  // ---- Editor hooks ----
  editing() { return this.app.siteEdit; }
  polys() { return this.store.siteHotspots.map(h => ({ id: h.id, polygon: h.poly })); }
  markDirty() {
    // The first real edit commits a promoted hotspot, so it is no longer discarded.
    if (this.selected && this.selected === this._promoted) this._promoted = null;
    this.store.markSiteDirty(); this._setBadge();
  }
  deselect() {
    this._discardCleanPromotion();
    if (this.selected) { this.selected = null; this.editingLabel = null; this.render(); this.app.closePanel(); }
  }

  /** App.closePanel hook: leaving label-edit mode (e.g. via the panel ✕) restores
   *  the normal selected-shape rendering. */
  onPanelClosed() {
    if (this.editingLabel) { this.editingLabel = null; this.render(); }
  }

  openBuilding(dir, name) {
    // Both hotspot clicks and legend rows route through here, so this covers both.
    const b = this.store.building(dir);
    if (!(b && b.floors.length)) {
      // No floor maps to open. The embed's toast is CSS-hidden, so it just does nothing there.
      if (!this.app.embed) Toast.show('No floor maps for ' + (name || dir));
      return;
    }
    const hash = '/b/' + encodeURIComponent(dir);
    // The dashboard-widget embed is chrome-free with no in-card breadcrumbs, so drilling in
    // there would strand the user with no way back. Open the full map in the top window instead,
    // deep-linked at this building: location.pathname is the MapView URL (minus the ?embed=1
    // query) and the widget iframe is same-origin, so window.top is reachable.
    if (this.app.embed) { window.top.location.href = location.pathname + '#' + hash; return; }
    this.app.go(hash);
  }

  /** PDF hotspots overridden by any user hotspot for the same building, plus all
   *  user hotspots. */
  effectiveHotspots() {
    const sp = this.store.manifest.siteplan;
    const overridden = new Set(this.store.siteHotspots.map(h => h.dir));
    const pdf = sp.hotspots.filter(h => !overridden.has(h.dir))
      .map(h => ({ source: 'pdf', dir: h.dir, name: h.name, code: h.buildingCode, poly: h.poly }));
    const user = this.store.siteHotspots.map(h => ({
      source: 'user', id: h.id, dir: h.dir, name: h.name, ref: h,
      code: Util.code(h.dir || '?'), poly: h.poly,
    }));
    return pdf.concat(user);
  }

  _setBadge() {
    if (!this._badge) return;
    this._badge.innerHTML = this.badgeHtml(this.store.siteDirty);
    this._badge.classList.toggle('dirty', this.store.siteDirty);
  }

  // ---- view assembly ----
  show() {
    const sp = this.store.manifest.siteplan;
    this.draft = null; this.selected = null; this.editingLabel = null; this._promoted = null; this.grid.adjust = false;
    this.grid.setScope('siteplan');
    this.app.crumbs([{ label: 'Siteplan' }]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    if (!sp) { this.app.setToolbar([]); stage.append(Dom.el('div', { class: 'empty' }, 'No siteplan image')); return; }
    this.app.setToolbar(this._toolbar());

    const img = Dom.el('img', { src: (window.MAP ? window.MAP.media : '/') + sp.image, alt: 'siteplan' });
    const s = Dom.svg('svg', { preserveAspectRatio: 'none' });
    const wrap = Dom.el('div', { class: 'map-wrap' }, [img, s]);
    const viewport = Dom.el('div', { class: 'map-viewport' }, wrap);
    stage.append(Dom.el('div', { class: 'siteplan-view' }, [viewport, this._legend(s)]));
    this.attach(img, s, [sp.w, sp.h]);
  }

  _toolbar() {
    const editBtn = Dom.el('button', { class: this.editing() ? 'active' : '',
      html: Icons.edit + '<span>' + (this.editing() ? 'Editing areas' : 'Edit building areas') + '</span>' });
    editBtn.onclick = () => { this.app.siteEdit = !this.app.siteEdit; this.show(); };

    if (!this.editing()) {
      // The wizard entry point and the page-wide labels toggle both live in Settings now
      // (App.showSettings) — the siteplan toolbar no longer carries them.
      return [editBtn];
    }

    const addBtn = Dom.el('button', { onclick: () => this.beginDraw(
      'Click to outline a building · Backspace undoes a point · Right-click removes a point · Enter/double-click to close'),
      html: Icons.draw + '<span>Add building area</span>' });
    this._badge = Dom.el('span', { class: 'badge' + (this.store.siteDirty ? ' dirty' : ''),
      html: this.badgeHtml(this.store.siteDirty) });
    const saveBtn = Dom.el('button', { class: 'primary', onclick: () => this.save() }, 'Save siteplan');
    return [editBtn, addBtn, this.undoButton(), this.toolDivider(), this.orthoButton(),
      this.gridToggleButton(), this.gridSizeSelect(), this.gridMoveButton(), this.toolDivider(), saveBtn, this._badge];
  }

  _legend(s) {
    const legend = Dom.el('aside', { class: 'legend' });
    legend.append(Dom.el('div', { class: 'legend-head' }, 'All buildings'));
    const numbered = this.store.manifest.buildings.filter(b => Util.isNumbered(b.dir));
    const trailers = this.store.manifest.buildings.filter(b => !Util.isNumbered(b.dir));
    const onMap = new Set(this.effectiveHotspots().map(h => h.dir));
    const hover = (dir, on) => { const n = s.querySelector(`[data-hs="${CSS.escape(dir)}"]`); if (n) n.classList.toggle('hot', on); };

    const rows = Dom.el('div', { class: 'legend-rows' });
    const addGroup = (title, list, ql) => {
      const matches = list.filter(b => !ql || b.name.toLowerCase().includes(ql)
        || Util.code(b.dir).toLowerCase().includes(ql) || b.dir.toLowerCase().includes(ql));
      if (!matches.length) return;
      if (title) rows.append(Dom.el('div', { class: 'legend-group' }, title));
      for (const b of matches) {
        const has = b.floors.length > 0;
        rows.append(Dom.el('div', {
          class: 'legend-row' + (has ? '' : ' nomap'),
          onclick: () => this.openBuilding(b.dir, b.name),
          onmouseenter: () => hover(b.dir, true),
          onmouseleave: () => hover(b.dir, false),
        }, [
          Dom.el('span', { class: 'lc' }, Util.code(b.dir)),
          Dom.el('span', { class: 'ln' }, b.name + (has ? '' : ' (no map)')),
          onMap.has(b.dir) ? null : Dom.el('span', { class: 'nopin', title: 'Not placed on the map' }, '◌'),
        ]));
      }
    };
    const renderRows = (q) => {
      rows.innerHTML = '';
      const ql = q.trim().toLowerCase();
      addGroup('', numbered, ql);
      addGroup('Trailers', trailers, ql);
      if (!rows.children.length) rows.append(Dom.el('div', { class: 'legend-empty' }, 'No matching buildings'));
    };

    legend.append(Dom.el('input', { class: 'legend-search', type: 'search',
      placeholder: 'Search buildings…', oninput: (e) => renderRows(e.target.value) }));
    legend.append(rows);
    renderRows('');
    return legend;
  }

  // ---- rendering ----
  render() {
    const s = this.svg; if (!s) return;
    const [W, H] = this.dispSize(); if (!W) return;
    const editing = this.editing();
    this.prepareSvg(s);
    if (editing) this.grid.draw(s, W, H, this.dims);
    this.addCatcher(s, W, H);

    const byDir = Object.fromEntries(this.store.manifest.buildings.map(b => [b.dir, b]));
    for (const hs of this.effectiveHotspots()) {
      const b = byDir[hs.dir];
      const has = !!(b && b.floors.length);
      const pts = hs.poly.map(p => `${p[0] * W},${p[1] * H}`).join(' ');
      let cls = 'hotspot ' + hs.source;
      if (!editing) cls += ' view';
      if (editing && hs.source === 'pdf') cls += ' ref';
      if (hs.source === 'user' && hs.id === this.selected) cls += ' selected';
      const poly = Dom.svg('polygon', { points: pts, class: cls });
      if (hs.dir) poly.setAttribute('data-hs', hs.dir);
      if (!has && !editing) { poly.style.opacity = .4; poly.style.cursor = 'default'; }
      poly.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.draft) return;
        if (editing && hs.source === 'user') {
          if (this._promoted && this._promoted !== hs.id) this._discardCleanPromotion();
          this.selected = hs.id; this.render(); this.openHotspotPanel(hs.ref);
        } else if (editing) { this._discardCleanPromotion(); this.promoteHotspot(hs); }
        else if (!editing) this.openBuilding(hs.dir, hs.name);
      });
      const title = Dom.svg('title');
      title.textContent = (hs.name || hs.dir || 'unassigned') + (has ? '' : ' (no map)');
      poly.append(title);
      s.append(poly);

      // Labels are hidden by default: a hotspot's label shows only when the
      // page-wide toggle is on (app.siteLabels) or this building opted in
      // (hs.ref.showLabel). Still hide it for the selected hotspot so it doesn't
      // obscure the vertices/edges while editing the polygon — unless its label is
      // the thing being edited, in which case always show it (with its handles).
      const labelEditing = this.editingLabel === hs.id;
      const labelVisible = this.app.siteLabels || (hs.ref && hs.ref.showLabel);
      if (labelEditing || (labelVisible && hs.id !== this.selected)) this._drawLabel(s, hs, W, H);

      if (editing && hs.source === 'user' && hs.id === this.selected && this.editingLabel !== hs.id)
        this.drawVertices(s, hs.poly, W, H, hs.id, () => this.markDirty());
    }
    this.drawDraft(s, W, H);
  }

  /** Centered building-name label. By default it is auto-placed on the polygon
   *  bbox and auto-sized to fit (long names wrap to two lines in roughly-square
   *  areas; tiny areas fall back to the short code). A user `labelStyle` overrides
   *  the centre (`x,y`), `size`, `rot`, `font`, `color`, and the **display `text`**
   *  (visual only — its line breaks are honoured and it is fit to the box, but it
   *  never changes the building name). The text is centred at the group origin so
   *  attachLabel can translate+rotate it (and add edit handles). */
  _drawLabel(s, hs, W, H) {
    const REF = 100, FILL = 0.82, MIN = 7, MAX = 22;
    const shape = hs.ref || hs;        // the persistent store hotspot carries labelStyle
    const ls = shape.labelStyle || {};
    const name = (hs.name && hs.name.trim()) || hs.code || hs.dir || '';
    const custom = ls.text != null ? ls.text : null;
    if (!name && custom == null) return;

    const b = Geom.bounds(hs.poly);
    let cx, cy;
    if (ls.x != null && ls.y != null) { cx = ls.x; cy = ls.y; }   // explicit placement is respected as-is
    else { cx = b.cx; cy = b.cy; if (!Geom.pointInPoly(cx, cy, hs.poly)) [cx, cy] = Geom.clampToPoly(cx, cy, hs.poly); }

    const t = Dom.svg('text', { x: 0, y: 0, 'text-anchor': 'middle',
      'dominant-baseline': 'central', class: 'hotspot-label' });
    const availW = b.w * W * FILL, availH = b.h * H * FILL;
    // Measure once at a reference size then scale analytically
    // (preserveAspectRatio:none → 1 unit == 1 displayed px). The text must be in
    // the DOM to measure; attachLabel re-parents it into the rotatable group.
    const measure = () => {
      const bb = t.getBBox();
      return (bb.width && bb.height) ? Math.min(availW / bb.width, availH / bb.height) : 0;
    };

    let size;
    if (custom != null) {
      // User display text: honour its explicit line breaks; fit it to the box (or to
      // an explicit size). Never auto-wraps or falls back to the code.
      this._setLabelLines(t, custom.split('\n'));
      if (ls.size != null) size = ls.size;
      else {
        if (availW <= 0 || availH <= 0) return;
        t.style.fontSize = REF + 'px'; s.append(t);
        size = Math.max(MIN, Math.min(MAX, REF * measure())); s.removeChild(t);
      }
    } else if (ls.size != null) {
      this._setLabelLines(t, [name]); size = ls.size;
    } else {
      if (availW <= 0 || availH <= 0) return;
      t.style.fontSize = REF + 'px';
      this._setLabelLines(t, [name]); s.append(t);
      let scale = measure();
      const ar = (b.h * H) ? (b.w * W) / (b.h * H) : 1;
      if (name.split(/\s+/).length >= 2 && ar > 0.6 && ar < 1.7 && REF * scale < 11) {
        const wrapped = this._wrapLines(name);
        if (wrapped.length === 2) {
          this._setLabelLines(t, wrapped);
          const wScale = measure();
          if (wScale > scale) scale = wScale; else this._setLabelLines(t, [name]); // keep the bigger fit
        }
      }
      if (REF * scale < MIN && hs.code && name !== hs.code) { this._setLabelLines(t, [hs.code]); scale = measure(); }
      size = Math.max(MIN, Math.min(MAX, REF * scale));
      s.removeChild(t);
    }
    t.style.fontSize = size + 'px'; // inline style — a CSS font-size rule would win over an attribute
    t.style.strokeWidth = (size / 6).toFixed(2) + 'px'; // keep the halo proportional to the text
    this.attachLabel(s, shape, t, cx, cy, size, W, H);
  }

  /** Split a name into two character-balanced lines (greedy on word boundaries). */
  _wrapLines(name) {
    const words = name.trim().split(/\s+/);
    if (words.length < 2) return [name];
    const half = name.length / 2;
    let i = 1, line1 = words[0];
    while (i < words.length && line1.length + 1 + words[i].length <= half) { line1 += ' ' + words[i]; i++; }
    if (i >= words.length) { i = words.length - 1; line1 = words.slice(0, i).join(' '); }
    return [line1, words.slice(i).join(' ')];
  }

  /** Promote a PDF/source hotspot into an editable user hotspot. The new user
   *  hotspot overrides the PDF one for the same `dir` (via effectiveHotspots), so
   *  there is no duplicate. Not marked dirty: an inspect-click that never edits the
   *  shape is discarded again by _discardCleanPromotion (see markDirty/deselect). */
  promoteHotspot(pdfHs) {
    const hs = { id: Util.uid(), dir: pdfHs.dir, name: pdfHs.name,
      poly: pdfHs.poly.map(p => p.slice()) };   // deep copy — never mutate the manifest poly
    this.store.siteHotspots.push(hs);
    this.selected = hs.id; this._promoted = hs.id;
    this.render(); this.openHotspotPanel(hs);
  }

  /** Drop a promoted-but-unedited hotspot so a stray click never dirties the file. */
  _discardCleanPromotion() {
    if (!this._promoted) return;
    const i = this.store.siteHotspots.findIndex(h => h.id === this._promoted);
    if (i >= 0) this.store.siteHotspots.splice(i, 1);
    if (this.selected === this._promoted) this.selected = null;
    this._promoted = null;
  }

  handleKey(e) {
    // Escape out of label-edit mode first (back to the hotspot panel), then out of
    // selection.
    if (e.key === 'Escape' && this.editingLabel && !this.draft) {
      const hs = this.store.siteHotspots.find(h => h.id === this.editingLabel);
      this.editingLabel = null; this.render();
      if (hs) this.openHotspotPanel(hs);
      return;
    }
    if (e.key === 'Escape' && this.selected && !this.draft) {
      this._discardCleanPromotion();
      this.selected = null; this.render(); this.app.closePanel();
      return;
    }
    super.handleKey(e);
  }

  // ---- drawing actions ----
  finish() {
    const dp = this.draft.points;
    if (dp.length < 3) { this.draft = null; this.render(); return; }
    const hs = { id: Util.uid(), dir: null, name: '', poly: dp.slice() };
    this.store.siteHotspots.push(hs);
    this.draft = null; this.selected = hs.id; this.markDirty();
    this.render(); this.openHotspotPanel(hs);
  }

  async save() {
    try { await this.store.saveSiteplan(); this._setBadge(); Toast.show('Siteplan saved'); }
    catch (e) { Toast.show('Save failed: ' + e.message, true); }
  }

  openHotspotPanel(hs) {
    const panel = Dom.$('#panel'); panel.classList.remove('hidden');
    Dom.$('#panel-title').textContent = 'Building area';
    const body = Dom.$('#panel-body'); body.innerHTML = '';

    body.append(Dom.el('div', { class: 'field' }, [
      Dom.el('label', {}, 'Assigned building'),
      Dom.el('div', { class: 'val' }, hs.dir ? (hs.name || hs.dir) : '(unassigned)'),
    ]));
    body.append(Dom.el('button', { class: 'wide', html: Icons.edit + '<span>Edit label</span>',
      onclick: () => {
        this.editingLabel = hs.id; this.render();
        const dn = (hs.name && hs.name.trim()) || (hs.dir ? Util.code(hs.dir) : '') || '';
        this.openLabelPanel(hs, () => { this.editingLabel = null; this.render(); this.openHotspotPanel(hs); }, dn);
      } }));
    // Per-building label visibility — opts this one building's label in even when the
    // page-wide toggle is off. Persisted on the store hotspot (separate from labelStyle
    // so "Reset to auto" never wipes it); Save siteplan writes it.
    body.append(Dom.el('button', { class: 'wide',
      html: Icons.edit + '<span>' + (hs.showLabel ? 'Hide label' : 'Show label') + '</span>',
      onclick: () => { hs.showLabel = !hs.showLabel; this.markDirty(); this.render(); this.openHotspotPanel(hs); } }));
    body.append(Dom.el('button', { class: 'danger wide', onclick: () => {
      const i = this.store.siteHotspots.indexOf(hs);
      if (i >= 0) this.store.siteHotspots.splice(i, 1);
      this.selected = null; this.editingLabel = null; this.markDirty(); this.render(); this.app.closePanel();
    } }, 'Delete area'));
    body.append(Dom.el('div', { class: 'hint' }, 'Assign this area to a building:'));
    const search = Dom.el('input', { id: 'room-search', placeholder: 'Search buildings…' });
    body.append(search);
    const list = Dom.el('div', {}); body.append(list);

    const renderList = (q) => {
      list.innerHTML = '';
      const ql = q.toLowerCase();
      this.store.manifest.buildings
        .filter(b => !ql || b.name.toLowerCase().includes(ql) || b.dir.toLowerCase().includes(ql))
        .forEach(b => {
          const item = Dom.el('div', { class: 'room-item' + (hs.dir === b.dir ? ' bound' : '') }, [
            Dom.el('div', { class: 'nm' }, Util.code(b.dir) + ' · ' + b.name + (hs.dir === b.dir ? '  ✓' : '')),
            Dom.el('div', { class: 'sl' }, b.floors.length ? b.floors.length + ' floors' : 'no map'),
          ]);
          item.onclick = () => { hs.dir = b.dir; hs.name = b.name; this.markDirty(); this.render(); this.openHotspotPanel(hs); };
          list.append(item);
        });
    };
    search.addEventListener('input', () => renderList(search.value));
    renderList(''); search.focus();
  }
}
