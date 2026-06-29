'use strict';
/* import-wizard.js — ImportWizard: the in-app "import a facility from PDFs" flow.
   Three steps in one stage-takeover view:
     1. Upload  — pick/drop building folders of PDFs; each PDF is POSTed to the server.
     2. Map     — the server renders a thumbnail per PDF; the user confirms each
                  building's name/slug/abbr and assigns each PDF a floor.
     3. Build   — the assembled import map is sent to the server, which renders the
                  images + manifest; the app then reloads onto the new facility.
   The PDFs carry no text layer, so floor identity is assigned here, not inferred.

   Mount-aware: file uploads and thumbnail/PDF previews resolve against window.MAP
   (api/media), and uploads carry the session CSRF token; scan/build/reset ride the
   shared Api.post wrapper (which rebases /api/* and adds CSRF). */

class ImportWizard {
  static HIRES_AT = 260;   // card width (px) at/above which the size slider upgrades to hi-res
  static OCR_MIN_CONF = 0.5;  // OCR results below this confidence are left for manual review

  constructor(app) {
    this.app = app;
    this.inv = null;        // scan inventory { folders:[{folder, pdfs:[...]}] }
    this.buildings = [];    // per-folder editable model (see _modelFromInventory)
    this.site = { folder: '', file: '' };  // chosen siteplan PDF (or empty = none)
    this.thumbWidth = 170;  // map-step card width (px); the size slider drives it
    this._bIdx = 0;         // index of the building currently visible in the map step
    this._autoMapDone = false;  // the building→NetBox auto-match pass runs once per scan
    // Floor-assignment mode for the map step: null = ask, 'manual' = assign each card by hand,
    // 'auto' = read the floor code by OCR. `_ocrRegion` is the normalized 0..1 box the user
    // dragged over the floor code, applied to every drawing. Both persist in the draft.
    this._assignMode = null;
    this._ocrRegion = null;
    // Add-drawings flow: when true the upload step merges new PDFs into the current model
    // (re-applying the saved draft so existing assignments survive) instead of starting fresh.
    this._mergeMode = false;
  }

  // ---- helpers ----
  static slugify(s) {
    return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  static prettyName(folder) {
    return folder.replace(/^\d+\s*[-_ ]\s*/, '').replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ').trim() || folder;
  }
  static initials(name) {
    const w = name.split(/\s+/).filter(Boolean);
    return (w.length > 1 ? w.map(x => x[0]).join('') : name.slice(0, 3)).toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /** Resolve a working-dir-relative asset path (thumbnail / PDF) to its authenticated
   *  media URL. */
  static _media(rel) {
    return (window.MAP ? window.MAP.media : '/') + encodeURI(rel);
  }

  /** On-demand high-res render URL for an uploaded PDF (`p.pdf`). The server renders it at
   *  full scale and caches the PNG, so this stays crisp when enlarged or zoomed — unlike the
   *  small scan thumbnail. Used by the preview popup and the lazy card upgrade. */
  static _previewUrl(pdfRel) {
    const api = window.MAP ? window.MAP.api : '/api/';
    return api + 'import/preview?path=' + encodeURIComponent(pdfRel);
  }

  _stage(title) {
    this.app.current = null;
    this.app.crumbs([{ label: 'Siteplan', hash: '/' }, { label: 'Import' }]);
    this.app.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const view = Dom.el('div', { class: 'import-view' }, [Dom.el('h2', {}, title)]);
    stage.append(view);
    return view;
  }

  async show() {
    // Probe for an in-progress import (existing uploads). The scan also regenerates
    // thumbnails so the map step's cards are ready when we jump straight to it.
    const loadView = this._stage('Import a facility');
    loadView.append(Dom.el('p', { class: 'imp-progress' }, 'Checking for existing uploads…'));
    try {
      const inv = await Api.post('/api/import/scan', {});
      if (inv.ok && inv.folders?.length) {
        this.inv = inv;
        this._modelFromInventory();
        await this._applyDraft();
        // Resume straight to floor mapping only when every building is already bound to a
        // NetBox site (from the restored draft); otherwise revisit the binding step.
        if (this._allBuildingsBound()) { this._autoMapDone = true; this._stepMap(); }
        else this._stepBuildings();
        return;
      }
    } catch (_) { /* no uploads or scan unavailable */ }
    this._stepUpload();
  }

  // ---- step 1: upload ----
  _stepUpload() {
    const view = this._stage(this._mergeMode ? 'Add drawings' : 'Import a facility');

    const folderInput = Dom.el('input', {
      type: 'file', class: 'imp-file', multiple: 'multiple', accept: '.pdf',
      onchange: (e) => this._upload(this._fromInput(e.target.files)),
    });
    folderInput.setAttribute('webkitdirectory', '');

    const drop = Dom.el('div', { class: 'imp-drop', onclick: () => folderInput.click() }, [
      Dom.el('div', { class: 'imp-drop-big' }, 'Drop or click to choose a facility folder'),
    ]);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const z = [...(e.dataTransfer.files || [])].find(f => f.name.toLowerCase().endsWith('.zip'));
      if (z) return this._uploadZip(z);
      this._upload(await this._fromDrop(e.dataTransfer));
    });
    view.append(drop);
    view.append(folderInput);
    this._progress = Dom.el('div', { class: 'imp-progress hidden' });
    view.append(this._progress);
    const cont = this._mergeMode
      ? Dom.el('button', { class: 'primary', onclick: () => this._mergeUploads() }, 'Done adding')
      : Dom.el('button', { class: 'primary', onclick: () => this._scanAndMap() }, 'Continue to mapping');
    const back = this._mergeMode
      ? Dom.el('button', { onclick: () => { this._mergeMode = false; this._stepMap(); } }, 'Cancel')
      : Dom.el('button', { onclick: () => this._reset() }, 'Start over');
    view.append(Dom.el('div', { class: 'imp-actions' }, [cont, back]));
  }

  _fromInput(fileList) {
    return [...fileList].filter(f => f.name.toLowerCase().endsWith('.pdf'))
      .map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
  }

  async _fromDrop(dt) {
    const roots = [...dt.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const out = [];
    const walk = (entry, prefix) => new Promise((res) => {
      if (entry.isFile) return entry.file(f => { out.push({ file: f, path: prefix + entry.name }); res(); });
      if (!entry.isDirectory) return res();
      const reader = entry.createReader();
      const readAll = () => reader.readEntries(async (ents) => {
        if (!ents.length) return res();
        for (const e of ents) await walk(e, prefix + entry.name + '/');
        readAll();
      });
      readAll();
    });
    for (const r of roots) await walk(r, '');
    return out.filter(x => x.file.name.toLowerCase().endsWith('.pdf'));
  }

  /** Building folder + filename from a relative path `<root>/<building>/<file>.pdf`. A PDF
   *  sitting directly under the dropped root (`<root>/<file>.pdf`, two segments) is the
   *  overall site map, so route it into the reserved `Site Plan` bucket — but only when the
   *  drop also has subfoldered drawings (`hasSubfolders`), else a single flat building folder
   *  would be mistaken for the siteplan. The `Site Plan` name reuses the existing siteplan
   *  auto-detect/build path unchanged. */
  static _split(relPath, hasSubfolders) {
    const segs = relPath.split('/').filter(Boolean);
    if (hasSubfolders && segs.length === 2) return { folder: 'Site Plan', file: segs[1] };
    return { folder: segs.length > 1 ? segs[segs.length - 2] : 'Building', file: segs[segs.length - 1] };
  }

  async _upload(items) {
    if (!items.length) { Toast.show('No PDFs found in that selection', true); return; }
    this._progress.classList.remove('hidden');
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    const hasSubfolders = items.some(it => it.path.split('/').filter(Boolean).length >= 3);
    let done = 0;
    for (const it of items) {
      const { folder, file } = ImportWizard._split(it.path, hasSubfolders);
      this._progress.textContent = `Uploading ${++done} / ${items.length}…`;
      try {
        // Multipart so the server streams to disk (no in-memory body cap); CSRF header so
        // the session-auth POST isn't rejected.
        const fd = new FormData();
        fd.append('file', it.file, file);
        const headers = {};
        if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
        const r = await fetch(apiBase + 'import/upload?path=' + encodeURIComponent(folder + '/' + file),
          { method: 'POST', headers, body: fd });
        if (!r.ok) throw new Error('HTTP ' + r.status);
      } catch (e) { Toast.show('Upload failed: ' + e.message, true); return; }
    }
    this._progress.textContent = `Uploaded ${items.length} drawings — rendering previews…`;
    if (this._mergeMode) this._mergeUploads(); else this._scanAndMap();
  }

  /** Upload a single `.zip`; the server extracts its PDFs (stripping any wrapper folder)
   *  into the same `uploads/<building>/<file>` layout a folder upload produces. */
  async _uploadZip(file) {
    this._progress.classList.remove('hidden');
    this._progress.textContent = `Uploading ${file.name}…`;
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const headers = {};
      if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
      const r = await fetch(apiBase + 'import/upload-zip', { method: 'POST', headers, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      this._progress.textContent = `Extracted ${j.count} drawings — rendering previews…`;
    } catch (e) { Toast.show('Zip upload failed: ' + e.message, true); return; }
    if (this._mergeMode) this._mergeUploads(); else this._scanAndMap();
  }

  // ---- step 2: map ----
  async _scanAndMap() {
    try {
      const inv = await Api.post('/api/import/scan', {});
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.inv = inv;
    } catch (e) { Toast.show('Scan failed: ' + e.message, true); return; }
    if (!this.inv.folders.length) { Toast.show('No PDFs uploaded yet', true); return this._stepUpload(); }
    this._modelFromInventory();
    this._bIdx = 0;
    this._autoMapDone = false;
    this._stepBuildings();
  }

  /** Add more drawing folders/PDFs to an in-progress or already-built facility without
   *  resetting. Persists the current assignments as a draft first, then routes through the
   *  normal upload step in "merge" mode so the re-scan re-applies that draft — existing drawings
   *  keep their floors and only the newly added ones arrive unassigned. */
  async _addDrawings() {
    await this._saveDraft();
    this._mergeMode = true;
    this._stepUpload();
  }

  /** Finish an add-drawings upload: re-scan, rebuild the model, and re-apply the saved draft so
   *  prior assignments survive (unlike `_scanAndMap`, which starts fresh). New folders surface
   *  unbound in the binding step, which auto-skips back to the map once everything is bound. */
  async _mergeUploads() {
    try {
      const inv = await Api.post('/api/import/scan', {});
      if (!inv.ok) throw new Error(inv.error || 'scan failed');
      this.inv = inv;
    } catch (e) { Toast.show('Scan failed: ' + e.message, true); return; }
    this._mergeMode = false;
    if (!this.inv.folders.length) return this._stepMap();
    this._modelFromInventory();
    await this._applyDraft();
    // Re-run the building→NetBox auto-match so a newly added, still-unbound building gets a
    // suggested site (already-bound buildings are skipped, so confirmed bindings are untouched).
    this._autoMapDone = false;
    this._stepBuildings();
  }

  /** Build the editable model with sensible defaults: a folder that looks like a site
   *  plan supplies the siteplan PDF and contributes no floors; every other folder is a
   *  building whose PDFs default to Level 1..N (the user adjusts basements/ground/roof). */
  _modelFromInventory() {
    this.buildings = [];
    this.site = { folder: '', file: '' };
    for (const f of this.inv.folders) {
      const isSite = /site\s*plan/i.test(f.folder);
      if (isSite && f.pdfs.length && !this.site.file) {
        this.site = { folder: f.folder, file: f.pdfs[0].file };
      }
      const name = ImportWizard.prettyName(f.folder);
      this.buildings.push({
        folder: f.folder, pdfs: f.pdfs,
        name, slug: ImportWizard.slugify(f.folder), abbr: ImportWizard.initials(name),
        // The NetBox Site this building is bound to, chosen in the "Map buildings to NetBox"
        // step: { id, slug, name, auto } (auto = picked by auto-map, awaiting confirmation).
        // null = unbound. Its slug overwrites `slug` so it flows downstream as `siteSlug`.
        nbSite: null,
        // NetBox floor Locations for the building's bound site, lazily fetched in the map
        // step so floors can be picked as buttons. undefined = not fetched, 'loading' = in
        // flight, array = done (empty array = fall back to the floor-type buttons).
        nbFloors: undefined,
        // Per-PDF floor assignment. `token` (a NetBox Location slug) takes precedence over
        // `type`/`num`; when set, the build emits the slug verbatim as the floor id (see
        // `_resolveFloors`/`_build`).
        assign: Object.fromEntries(f.pdfs.map((p, i) =>
          [p.stem, isSite ? { type: 'none', num: 1, token: null, label: '' }
            : { type: 'level', num: i + 1, token: null, label: '' }])),
        // Per-card thumbnail framing (zoom/pan) — a viewing aid only, never sent to build.
        frame: Object.fromEntries(f.pdfs.map(p => [p.stem, { scale: 1, x: 0, y: 0 }])),
      });
    }
  }

  // ---- step 1.5: bind buildings to NetBox sites ----

  /** Building folders that contribute floors — siteplan-only folders need no NetBox site
   *  (they have no floors and are skipped by the build, see `_build`). */
  _floorBuildings() {
    return this.buildings.filter(b => Object.keys(this._resolveFloors(b)).length > 0);
  }

  /** True once every floor-contributing building is bound to a NetBox site. */
  _allBuildingsBound() {
    return this._floorBuildings().every(b => b.nbSite);
  }

  /** Bind a building to a NetBox site: store its identity and prefill name/slug/abbr from it
   *  so the slug flows downstream as the manifest `siteSlug`. `auto` flags an unconfirmed
   *  auto-match (the operator reviews it in the step). */
  _bindSite(b, site, auto) {
    b.nbSite = { id: site.id, slug: site.slug, name: site.name, auto: !!auto };
    b.slug = site.slug;
    b.name = site.name;
    b.abbr = ImportWizard.initials(site.name);
  }

  /** Try to auto-match each still-unbound building to a NetBox site by name/slug. Runs once
   *  per scan (guarded by `_autoMapDone`). Accept only a confident match — a site whose slug
   *  equals the folder-derived slug, or whose name matches, or a lone search result — and
   *  flag it `auto` so the operator confirms it. Ambiguous folders stay unbound for manual
   *  binding. */
  async _autoMapBuildings() {
    if (this._autoMapDone) return;
    this._autoMapDone = true;
    for (const b of this._floorBuildings()) {
      if (b.nbSite) continue;
      let res;
      try { res = await this.app.netbox.sites(b.name); } catch (_) { continue; }
      const sites = res.sites || [];
      const nameLc = b.name.toLowerCase();
      const match = sites.find(s => s.slug === b.slug)
        || sites.find(s => s.name.toLowerCase() === nameLc)
        || (sites.length === 1 ? sites[0] : null);
      if (match) this._bindSite(b, match, true);
    }
  }

  async _stepBuildings() {
    const buildings = this._floorBuildings();
    if (!buildings.length) return this._stepMap();   // siteplan-only import — nothing to bind

    const view = this._stage('Map buildings to NetBox');
    view.append(Dom.el('p', { class: 'hint' },
      'Bind each building to its NetBox site so rooms can be linked to Locations later. We '
      + 'matched them automatically where we could — confirm those and pick a site for any '
      + 'left unbound.'));

    if (!this._autoMapDone) {
      view.append(Dom.el('p', { class: 'imp-progress' }, 'Matching buildings to NetBox…'));
      await this._autoMapBuildings();
      return this._stepBuildings();   // re-render with the auto-match results
    }

    for (const b of buildings) view.append(this._bindRow(b));

    const bound = this._allBuildingsBound();
    const cont = Dom.el('button', { class: 'primary',
      onclick: async () => { await this._saveDraft(); this._stepMap(); } },
      'Continue to floor mapping →');
    cont.disabled = !bound;
    const actions = [cont, Dom.el('button', { onclick: () => this._reset() }, 'Start over')];
    if (!bound) actions.push(Dom.el('span', { class: 'hint' },
      'Bind every building to a NetBox site first.'));
    view.append(Dom.el('div', { class: 'imp-actions' }, actions));
  }

  /** One building's bind control: its current state plus a site-search autocomplete. */
  _bindRow(b) {
    const state = Dom.el('div', { class: 'imp-bind-state' });
    if (b.nbSite && b.nbSite.auto)
      state.append(Dom.el('span', { class: 'imp-bind-auto' },
        '✓ auto-matched → ' + b.nbSite.name + ' (' + b.nbSite.slug + ') — confirm or change'));
    else if (b.nbSite)
      state.append(Dom.el('span', { class: 'imp-bind-ok' },
        '✓ ' + b.nbSite.name + ' (' + b.nbSite.slug + ')'));
    else
      state.append(Dom.el('span', { class: 'imp-bind-warn' },
        '⚠ not bound — pick a NetBox site'));

    const search = Dom.el('input', { placeholder: 'Search NetBox sites…' });
    const list = Dom.el('div', { class: 'imp-bind-list' });
    let token = 0;
    const run = async (q) => {
      const mine = ++token;
      let res;
      try { res = await this.app.netbox.sites(q); } catch (_) { return; }
      if (mine !== token) return;   // a newer keystroke superseded this fetch
      list.innerHTML = '';
      const sites = res.sites || [];
      if (!sites.length) { list.append(Dom.el('div', { class: 'hint' }, 'No sites found.')); return; }
      for (const s of sites) {
        const isThis = b.nbSite && b.nbSite.slug === s.slug;
        const item = Dom.el('div', { class: 'room-item' + (isThis ? ' bound' : '') }, [
          Dom.el('div', { class: 'nm' }, s.name + (isThis ? '  ✓' : '')),
          Dom.el('div', { class: 'sl' }, s.slug),
        ]);
        item.onclick = () => { this._bindSite(b, s, false); this._stepBuildings(); };
        list.append(item);
      }
    };
    search.addEventListener('input', () => run(search.value));

    return Dom.el('section', { class: 'imp-bind' }, [
      Dom.el('div', { class: 'imp-bind-head' }, [
        Dom.el('div', { class: 'imp-bind-folder' }, b.folder), state,
      ]),
      search, list,
    ]);
  }

  // ---- step 2a: choose automatic vs manual floor assignment ----

  /** First thing in the map step: pick how every drawing gets assigned to a floor. Automatic
   *  reads the floor code off each drawing by OCR — the user marks where the code sits once,
   *  and we read that same spot everywhere; Manual is the assign-each-card flow. The choice is
   *  remembered in the draft, and the user can switch to manual at any time afterwards. */
  _stepAssignChoice() {
    const view = this._stage('Map drawings to floors');
    view.append(Dom.el('p', { class: 'hint' }, 'How do you want to assign each drawing to a floor?'));
    const choose = (mode) => async () => { this._assignMode = mode; await this._saveDraft(); this._stepMap(); };
    const auto = Dom.el('div', { class: 'imp-choice' }, [
      Dom.el('h3', {}, 'Automatic'),
      Dom.el('p', {}, 'Mark once where the floor code sits on a drawing; we read that spot on '
        + 'every drawing and assign the floors for you. You confirm anything we’re unsure about.'),
      Dom.el('button', { class: 'primary', onclick: choose('auto') }, 'Read floor codes for me'),
    ]);
    const manual = Dom.el('div', { class: 'imp-choice' }, [
      Dom.el('h3', {}, 'Manual'),
      Dom.el('p', {}, 'Assign each drawing to its floor yourself, one card at a time.'),
      Dom.el('button', { onclick: choose('manual') }, 'Assign them myself'),
    ]);
    view.append(Dom.el('div', { class: 'imp-choices' }, [auto, manual]));
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      Dom.el('button', { onclick: () => this._reset() }, 'Start over'),
    ]));
  }

  /** Automatic mode marks where the floor code sits: the user drags one box over the code on a
   *  sample drawing, stored normalized 0..1 so it maps onto every drawing's render. "Read all
   *  drawings" runs the OCR pass; the user can drop to manual at any point. */
  _stepRegionPick() {
    const b = this.buildings.find(x => x.pdfs && x.pdfs.length);
    const p = b && b.pdfs[0];
    if (!p) { this._assignMode = 'manual'; return this._stepMap(); }  // nothing to OCR

    const view = this._stage('Mark the floor code');
    view.append(Dom.el('p', { class: 'hint' },
      'Drag a tight box around the floor code on this sample drawing. We’ll read the same spot '
      + 'on every drawing to assign its floor.'));

    const img = Dom.el('img', { class: 'imp-region-img', src: ImportWizard._previewUrl(p.pdf) });
    const sel = Dom.el('div', { class: 'imp-region-sel hidden' });
    const stage = Dom.el('div', { class: 'imp-region-stage' }, [img, sel]);
    this._attachRegionDrag(img, sel);
    view.append(stage);

    const go = Dom.el('button', { class: 'primary', onclick: () => this._runOcr() }, 'Read all drawings');
    go.disabled = !this._ocrRegion;
    this._regionGo = go;
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      go,
      Dom.el('button', { onclick: () => { this._assignMode = 'manual'; this._stepMap(); } }, 'Assign manually instead'),
      Dom.el('button', { onclick: () => this._reset() }, 'Start over'),
    ]));
  }

  /** Drag a selection box over the sample image, storing it normalized 0..1 on `_ocrRegion`.
   *  The overlay shares the <img>'s box (the image fills it, no letterboxing), so pointer
   *  positions map straight to image space via `getBoundingClientRect()`. */
  _attachRegionDrag(img, sel) {
    const draw = (r) => {
      sel.classList.remove('hidden');
      sel.style.left = (r.x * 100) + '%'; sel.style.top = (r.y * 100) + '%';
      sel.style.width = (r.w * 100) + '%'; sel.style.height = (r.h * 100) + '%';
    };
    if (this._ocrRegion) draw(this._ocrRegion);
    img.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = img.getBoundingClientRect();
      const nx = (c) => Math.max(0, Math.min(1, (c - rect.left) / rect.width));
      const ny = (c) => Math.max(0, Math.min(1, (c - rect.top) / rect.height));
      const x0 = nx(e.clientX), y0 = ny(e.clientY);
      let pending = null;
      try { img.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => {
        const x1 = nx(ev.clientX), y1 = ny(ev.clientY);
        pending = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        draw(pending);
      };
      const up = () => {
        img.removeEventListener('pointermove', move);
        img.removeEventListener('pointerup', up);
        if (pending && pending.w > 0.005 && pending.h > 0.005) {
          this._ocrRegion = pending;
          if (this._regionGo) this._regionGo.disabled = false;
        }
      };
      img.addEventListener('pointermove', move);
      img.addEventListener('pointerup', up);
    });
  }

  /** A small banner shown atop the map step in automatic mode: confirms floors were read and
   *  offers an escape back to re-reading the region or to manual assignment. */
  _autoBanner() {
    return Dom.el('div', { class: 'imp-automode' }, [
      Dom.el('span', {}, 'Floors read automatically — confirm any flagged drawings below.'),
      Dom.el('button', { onclick: () => { this._ocrRegion = null; this._stepMap(); } }, 'Re-read region'),
      Dom.el('button', { onclick: () => { this._assignMode = 'manual'; this._stepMap(); } }, 'Switch to manual'),
    ]);
  }

  /** Run the OCR pass: preload every building's floor Locations (so the text→floor match has
   *  its vocabulary), send the marked region to the server, then map the recognized text to a
   *  floor and pre-fill the assignments. Confident matches land in `b.assign[*]`; the rest are
   *  left `unassigned` for the user to confirm via the normal cards. */
  async _runOcr() {
    if (!this._ocrRegion) return;
    const view = this._stage('Reading floor codes…');
    view.append(Dom.el('div', { class: 'imp-spinner' },
      'Reading the floor code on every drawing — this can take a minute.'));
    await Promise.all(this.buildings.map(b => this._loadFloors(b)));
    let res;
    try {
      res = await Api.post('/api/import/ocr-assign', { region: this._ocrRegion });
      if (!res.ok) throw new Error(res.error || 'OCR failed');
    } catch (e) {
      Toast.show('Auto-assign failed: ' + e.message, true);
      this._ocrRegion = null;
      return this._stepRegionPick();
    }
    const s = this._applyOcr(res.results || []);
    await this._saveDraft();
    Toast.show(`Auto-assigned ${s.assigned} of ${s.total} drawings`
      + (s.review ? ` — confirm ${s.review} we weren’t sure about` : ''));
    this._stepMap();
  }

  /** Map each OCR result to a floor and write confident matches into `b.assign[*]` (the same
   *  shape `_floorButtons` writes). A drawing already excluded (`type:'none'`) or already
   *  assigned to a Location (`token`) is left untouched. Low-confidence / unmatched / ambiguous
   *  drawings are marked `unassigned`, which the existing build gate forces the user to
   *  confirm. Returns a small summary for the toast. */
  _applyOcr(results) {
    const byFolder = new Map(this.buildings.map(b => [b.folder, b]));
    let assigned = 0, review = 0, total = 0;
    for (const r of results) {
      const b = byFolder.get(r.folder);
      if (!b || !(r.stem in b.assign)) continue;
      const a = b.assign[r.stem];
      if (a.type === 'none' || a.token) continue;   // siteplan excludes / already assigned
      total++;
      const match = (r.confidence >= ImportWizard.OCR_MIN_CONF) ? this._matchFloor(b, r.text) : null;
      if (match) { Object.assign(a, match); assigned++; }
      else { a.token = null; a.label = ''; a.type = 'unassigned'; review++; }
    }
    return { assigned, review, total };
  }

  /** Find the floor a drawing's OCR text names, as an assign-shaped patch, or null when there's
   *  no confident, unambiguous match. In Location mode it matches the recognized code against
   *  the building's floor Locations (by name or slug); otherwise it resolves to the floor-type
   *  vocabulary. */
  _matchFloor(b, text) {
    const key = ImportWizard._floorKey(text);
    if (!key) return null;
    if (Array.isArray(b.nbFloors) && b.nbFloors.length) {
      const hits = b.nbFloors.filter(loc =>
        ImportWizard._floorKey(loc.name) === key || ImportWizard._floorKey(loc.slug) === key);
      if (hits.length !== 1) return null;   // none or ambiguous → leave for review
      const loc = hits[0];
      return { token: loc.slug, label: loc.name, type: 'level', num: 1 };
    }
    if (key === 'r') return { token: null, label: '', type: 'roof', num: 1 };
    if (key === 'g') return { token: null, label: '', type: 'ground', num: 1 };
    const m = key.match(/^([bl])(\d+)$/);
    if (m) return { token: null, label: '', type: m[1] === 'b' ? 'basement' : 'level', num: parseInt(m[2], 10) };
    return null;
  }

  /** Reduce a floor label/code to a canonical key for matching OCR text against floor names:
   *  'Level 2'/'L2'/'FL 02'/'2' → 'l2', 'Ground'/'G' → 'g', 'Basement 1'/'B1' → 'b1',
   *  'Roof'/'RF' → 'r'. Returns '' when nothing floor-like is found. */
  static _floorKey(s) {
    const t = (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!t) return '';
    let m;
    if (/\b(?:roof|rf|r)\b/.test(t) && !/\d/.test(t)) return 'r';
    if ((m = t.match(/\b(?:basement|bsmt|sub|b)\s*0*(\d+)\b/))) return 'b' + m[1];
    if (/\b(?:ground|grd|gf|g)\b/.test(t) && !/\d/.test(t)) return 'g';
    if ((m = t.match(/\b(?:level|lvl|floor|flr|fl|l)\s*0*(\d+)\b/))) return 'l' + m[1];
    if ((m = t.match(/^0*(\d+)$/))) return 'l' + m[1];   // a bare number = that level
    return '';
  }

  _stepMap() {
    // First entry: pick automatic (OCR) vs manual assignment; automatic then marks the region.
    if (!this._assignMode) return this._stepAssignChoice();
    if (this._assignMode === 'auto' && !this._ocrRegion) return this._stepRegionPick();

    const view = this._stage('Map drawings to floors');
    this._mapView = view;
    this._cards = [];   // {upgrade()} per card — lets the size slider swap in hi-res renders
    view.append(Dom.el('p', { class: 'hint' },
      'Name each building and assign every drawing to a floor. Click a card for a full '
      + 'preview, or drag the size slider to enlarge every thumbnail at once.'));
    if (this._assignMode === 'auto') view.append(this._autoBanner());

    view.append(this._sizer());
    this._applyThumbSize();
    view.append(this._siteplanRow());

    if (this.buildings.length > 1) view.append(this._buildingNav());
    const b = this.buildings[this._bIdx];
    this._ensureFloors(b);   // kick off the NetBox Location fetch for this building (cached)
    view.append(this._buildingSection(b));
    this._applyThumbSize();   // re-apply now cards exist, so a large size upgrades them to hi-res

    // A second nav at the bottom so the user isn't forced back to the top after assigning a
    // building's drawings. Re-rendering rebuilds both bars each switch, keeping them in sync.
    if (this.buildings.length > 1) view.append(this._buildingNav());

    view.append(this._buildActions());
  }

  /** The Build / Add-drawings / Start-over action row. Build is gated until every drawing is
   *  assigned to a floor (no building left with an `unassigned` drawing) and a site-plan image is
   *  chosen; while gated it shows a disabled button + a hint naming what's missing, so the button
   *  never silently vanishes. "Add drawings" (additive upload) and "Start over" stay available
   *  regardless. */
  _buildActions() {
    const unassigned = this._unassignedBuildings();
    const needSiteplan = !this.site.file;
    const actions = [];
    if (unassigned.length || needSiteplan) {
      const blocked = Dom.el('button', { class: 'primary' }, 'Build facility map');
      blocked.disabled = true;
      actions.push(blocked);
      const reasons = [];
      if (unassigned.length)
        reasons.push('Assign every drawing to a floor first — still unassigned in: '
          + unassigned.join(', ') + '.');
      if (needSiteplan) reasons.push('Choose a site-plan image above.');
      actions.push(Dom.el('span', { class: 'hint' }, reasons.join(' ')));
    } else {
      actions.push(Dom.el('button', { class: 'primary', onclick: () => this._build() },
        'Build facility map'));
    }
    actions.push(Dom.el('button', { onclick: () => this._addDrawings() }, '+ Add drawings'));
    actions.push(Dom.el('button', { onclick: () => this._reset() }, 'Start over'));
    return Dom.el('div', { class: 'imp-actions' }, actions);
  }

  /** Building paging: ← Previous / Next → with a "Building N of M" label. Navigating saves the
   *  draft, steps `_bIdx`, and re-renders. Factored into a helper so it can be reused. */
  _buildingNav() {
    const nav = Dom.el('div', { class: 'imp-nav' });
    const prev = Dom.el('button', { onclick: async () => { await this._saveDraft(); this._bIdx--; this._stepMap(); } }, '← Previous');
    const next = Dom.el('button', { onclick: async () => { await this._saveDraft(); this._bIdx++; this._stepMap(); } }, 'Next →');
    prev.disabled = this._bIdx === 0;
    next.disabled = this._bIdx === this.buildings.length - 1;
    nav.append(prev, Dom.el('span', { class: 'imp-nav-label' },
      `Building ${this._bIdx + 1} of ${this.buildings.length}`), next);
    return nav;
  }

  /** Lazily fetch a building's NetBox floor Locations so the per-card floor selector can offer
   *  them as buttons. Cached on `b.nbFloors`; on completion the map step re-renders if this
   *  building is still the visible one. A blank slug or empty result leaves `b.nbFloors = []`,
   *  which drives the floor-type fallback. */
  _ensureFloors(b) {
    if (b.nbFloors !== undefined) return;
    this._loadFloors(b).then(() => {
      if (this._mapView && this.buildings[this._bIdx] === b) this._stepMap();
    });
  }

  /** Fetch and cache a building's NetBox floor Locations (idempotent). Resolves once
   *  `b.nbFloors` is settled to an array — empty when unbound or the site has none (driving the
   *  floor-type fallback). Shared by the lazy per-building load (`_ensureFloors`) and the OCR
   *  auto-assign pass, which preloads every building so the text→floor match has its
   *  vocabulary. */
  async _loadFloors(b) {
    if (Array.isArray(b.nbFloors)) return;   // already loaded
    const slug = (b.slug || '').trim();
    if (!slug) { b.nbFloors = []; return; }
    b.nbFloors = 'loading';
    // The building Location is named after the bound NetBox site, so match on that (not the
    // user-editable `b.name`); fall back to `b.name` when unbound.
    const siteName = (b.nbSite && b.nbSite.name) || b.name;
    let floors = [];
    try {
      const res = await this.app.netbox.locations(slug);
      floors = this._floorsFromLocations(res.rooms || [], siteName);
    } catch (_) { floors = []; }
    b.nbFloors = floors;
    if (floors.length) this._normalizeToLocations(b);
  }

  /** Pick the floor Locations out of a site's flat Location list using the parent tree. The
   *  building Location is the root named after the bound site (e.g. "CYCLOTRON VAULT"); its
   *  children are floors. Any OTHER root is itself a floor — some sites park a floor like
   *  "Roof" or "Level B2" at the top level, as a sibling of the building. When no root matches
   *  the site name the site has no building wrapper and the roots themselves are the floors
   *  (e.g. ARIEL). Identifying the building by name — not by tree shape — works even when the
   *  floors have no rooms under them yet; `depth`/`level` is avoided (MPTT-only, unreliable on
   *  NetBox 4.2+). Floors are sorted by name for a stable, natural order (B1, B2, G, …, Roof). */
  _floorsFromLocations(locs, siteName) {
    const ids = new Set(locs.map(l => l.id));
    const roots = locs.filter(l => l.parent == null || !ids.has(l.parent));
    const nameLc = (siteName || '').trim().toLowerCase();
    const building = nameLc
      ? roots.find(r => (r.name || '').trim().toLowerCase() === nameLc) : null;
    const floors = roots.filter(r => r !== building);
    if (building) for (const l of locs) if (l.parent === building.id) floors.push(l);
    return floors.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));
  }

  /** Entering Location mode: a drawing with no Location token yet is marked `unassigned` so it
   *  contributes no floor and gates the build until the user picks a Location button — the auto
   *  Level 1..N defaults only apply to the floor-type fallback. `unassigned` is distinct from a
   *  deliberate `— none —` (`type:'none'`), which is a real choice and passes the build gate
   *  (see `_unassignedBuildings`). */
  _normalizeToLocations(b) {
    for (const p of b.pdfs) {
      const a = b.assign[p.stem];
      if (!a.token) a.type = 'unassigned';
    }
  }

  /** Global thumbnail-size slider — resizes every card at once (the alternative to opening
   *  each one). Lives on the wizard so the choice survives step re-renders. */
  _sizer() {
    return Dom.el('div', { class: 'imp-sizer' }, [
      Dom.el('span', {}, 'Thumbnail size'),
      Dom.el('input', { type: 'range', min: '150', max: '480', step: '10',
        value: String(this.thumbWidth),
        oninput: (e) => { this.thumbWidth = parseInt(e.target.value, 10); this._applyThumbSize(); } }),
    ]);
  }

  /** Push the current size onto the map view as CSS vars the grid/cards read. Past a width
   *  threshold a small scan thumbnail can't stay legible when stretched, so upgrade every
   *  card to its on-demand hi-res render (lazy-loaded + server-cached, so only on-screen
   *  large cards actually fetch). */
  _applyThumbSize() {
    if (!this._mapView) return;
    this._mapView.style.setProperty('--imp-card-w', this.thumbWidth + 'px');
    this._mapView.style.setProperty('--imp-thumb-h', Math.round(this.thumbWidth * 110 / 150) + 'px');
    if (this.thumbWidth >= ImportWizard.HIRES_AT && this._cards)
      for (const c of this._cards) c.upgrade();
  }

  _siteplanRow() {
    const sel = Dom.el('select', {
      onchange: (e) => {
        const v = e.target.value;
        if (!v) { this.site = { folder: '', file: '' }; return; }
        const [folder, file] = JSON.parse(v); this.site = { folder, file };
      },
    });
    sel.append(Dom.el('option', { value: '' }, '— none —'));
    for (const f of this.inv.folders)
      for (const p of f.pdfs) {
        const v = JSON.stringify([f.folder, p.file]);
        const o = Dom.el('option', { value: v }, f.folder + ' / ' + p.file);
        if (this.site.folder === f.folder && this.site.file === p.file) o.selected = true;
        sel.append(o);
      }
    return Dom.el('div', { class: 'imp-siteplan' }, [
      Dom.el('label', {}, 'Site plan image (optional)'), sel,
    ]);
  }

  _buildingSection(b) {
    const field = (label, key, w) => Dom.el('label', { class: 'imp-field' }, [
      Dom.el('span', {}, label),
      Dom.el('input', { value: b[key], style: 'width:' + w,
        oninput: (e) => { b[key] = e.target.value; } }),
    ]);
    const fields = [
      field('Building name', 'name', '15em'),
      field('Site slug', 'slug', '9em'),
    ];
    // In Location mode the floor id must equal the real Location slug, so the floor prefix is
    // forced empty (see `_build`) and the prefix + auto-number controls are hidden; they only
    // apply to the floor-type fallback.
    if (!(Array.isArray(b.nbFloors) && b.nbFloors.length)) {
      fields.push(field('Floor prefix', 'abbr', '6em'));
      fields.push(Dom.el('button', { class: 'imp-auto',
        onclick: () => this._autoNumber(b) }, 'Number floors 1…N'));
    }
    const head = Dom.el('div', { class: 'imp-bhead' }, fields);
    const grid = Dom.el('div', { class: 'imp-grid' });
    for (const p of b.pdfs) grid.append(this._pdfCard(b, p));
    return Dom.el('section', { class: 'imp-building' }, [head, grid]);
  }

  _pdfCard(b, p) {
    const a = b.assign[p.stem];
    // A replaced drawing's thumbnail is regenerated at the same path, so bust the browser cache.
    const bust = p._rev ? ('?v=' + p._rev) : '';
    let thumb;
    if (p.thumb) {
      const img = Dom.el('img', { src: ImportWizard._media(p.thumb) + bust, loading: 'lazy' });
      thumb = Dom.el('div', { class: 'imp-thumb' }, [img]);
      // Lazily swap the small scan thumbnail for the full-scale render the first time the
      // card is enlarged or zoomed — keeps the initial grid light, sharpens on demand.
      let hires = false;
      const upgrade = () => { if (!hires) { hires = true;
        img.src = ImportWizard._previewUrl(p.pdf) + (p._rev ? '&v=' + p._rev : ''); } };
      this._cards.push({ upgrade });
      this._attachZoomPan(thumb, img, b.frame[p.stem],
        { onClick: () => this._lightbox(p), onZoom: upgrade });
    } else {
      thumb = Dom.el('div', { class: 'imp-thumb imp-nothumb' }, p.file);
    }
    const body = Dom.el('div', { class: 'imp-cardbody' }, [
      Dom.el('div', { class: 'imp-cardfile' }, [
        Dom.el('span', { class: 'imp-cardname' }, p.file),
        this._replaceControl(b, p),
      ]),
      this._floorButtons(b, a),
    ]);
    // Flag a still-unassigned drawing so it stands out in the grid (and in the gated build hint).
    const cls = 'imp-card' + (a.type === 'unassigned' ? ' unassigned' : '');
    return Dom.el('div', { class: cls }, [thumb, body]);
  }

  /** Per-drawing "Replace" control: upload a newer PDF for this floor in place. The new bytes are
   *  written to the EXISTING upload path (same folder + filename), so the drawing's stem — and
   *  therefore its floor id and any rooms already drawn on that floor — are preserved. */
  _replaceControl(b, p) {
    const input = Dom.el('input', { type: 'file', accept: '.pdf', style: 'display:none',
      onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this._replacePdf(b, p, f); } });
    const btn = Dom.el('button', { class: 'imp-replace',
      title: 'Upload a newer drawing for this floor. Keeps the same floor assignment, so rooms '
        + 'already drawn on it stay.',
      onclick: () => input.click() }, 'Replace');
    return Dom.el('span', { class: 'imp-replace-wrap' }, [btn, input]);
  }

  /** Overwrite one drawing's PDF in place, then re-scan to refresh its thumbnail. The upload path
   *  is fixed to the existing filename (regardless of the picked file's name) so the floor id is
   *  unchanged — id-preserving, so rooms drawn on that floor survive the next build. */
  async _replacePdf(b, p, file) {
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    const headers = {};
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    try {
      const fd = new FormData();
      fd.append('file', file, p.file);
      const r = await fetch(apiBase + 'import/upload?path=' + encodeURIComponent(b.folder + '/' + p.file),
        { method: 'POST', headers, body: fd });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      try { const inv = await Api.post('/api/import/scan', {}); if (inv.ok) this.inv = inv; }
      catch (_) { /* the existing thumbnail stays until the next scan */ }
      p._rev = (p._rev || 0) + 1;
      Toast.show('Replaced ' + p.file);
      this._stepMap();
    } catch (e) { Toast.show('Replace failed: ' + e.message, true); }
  }

  /** Floor selector for one drawing, as a row of buttons. In Location mode (the building's
   *  bound site has floor Locations) it offers one button per Location — clicking writes the
   *  Location slug as the assignment token so the build's floor id equals the real
   *  `Location.slug`. Otherwise it falls back to the floor-type vocabulary
   *  (none/basement/ground/level N/roof), preserving the old `<select>` semantics. */
  _floorButtons(b, a) {
    const row = Dom.el('div', { class: 'imp-floors' });
    if (b.nbFloors === 'loading') {
      row.append(Dom.el('span', { class: 'hint' }, 'Loading floors…'));
      return row;
    }
    if (a.type === 'unassigned')
      row.append(Dom.el('span', { class: 'imp-floor-warn' }, '⚠ pick a floor'));
    const btn = (label, active, onClick) =>
      Dom.el('button', { class: 'imp-floor' + (active ? ' active' : ''), onclick: onClick }, label);
    // "— none —" excludes a drawing from the floor set in either mode.
    row.append(btn('— none —', a.type === 'none' && !a.token, () => {
      a.token = null; a.label = ''; a.type = 'none'; this._stepMap();
    }));
    if (Array.isArray(b.nbFloors) && b.nbFloors.length) {
      for (const loc of b.nbFloors)
        row.append(btn(loc.name, a.token === loc.slug, () => {
          a.token = loc.slug; a.label = loc.name; a.type = 'level'; this._stepMap();
        }));
    } else {
      const set = (type, num) => () => {
        a.token = null; a.label = ''; a.type = type; a.num = num; this._stepMap();
      };
      row.append(btn('Basement', a.type === 'basement', set('basement', 1)));
      row.append(btn('Ground', a.type === 'ground', set('ground', 1)));
      for (let i = 1; i <= b.pdfs.length; i++)
        row.append(btn('Level ' + i, a.type === 'level' && a.num === i, set('level', i)));
      row.append(btn('Roof', a.type === 'roof', set('roof', 1)));
    }
    return row;
  }

  /** Wire scroll-to-zoom (anchored at the cursor) + drag-to-pan onto a framed image box —
   *  shared by the mapping cards and the preview popup. `frame` ({scale,x,y}) holds the view
   *  state; for a card it lives on the wizard model so the framing survives step switches (a
   *  viewing aid only, never sent to the build). Panning is clamped to the rendered
   *  (object-fit contained) image so a drag can't slide into the letterbox margins.
   *  `opts.onClick` fires when a press doesn't travel (a click, not a drag); `opts.onZoom`
   *  fires the first time the user zooms in (used to swap in the hi-res render). Double-click
   *  resets the view. */
  _attachZoomPan(box, img, frame, opts = {}) {
    const apply = () => { img.style.transform = `translate(${frame.x}px, ${frame.y}px) scale(${frame.scale})`; };
    const clamp = () => {
      const bw = box.clientWidth, bh = box.clientHeight;
      const nw = img.naturalWidth || bw, nh = img.naturalHeight || bh;
      const fit = Math.min(bw / nw, bh / nh) || 1;      // object-fit: contain ratio
      const mx = Math.max(0, (frame.scale * nw * fit - bw) / 2);
      const my = Math.max(0, (frame.scale * nh * fit - bh) / 2);
      frame.x = Math.max(-mx, Math.min(mx, frame.x));
      frame.y = Math.max(-my, Math.min(my, frame.y));
    };
    apply();
    box.addEventListener('wheel', (e) => {
      e.preventDefault();
      const prev = frame.scale;
      const next = Math.min(8, Math.max(1, prev * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (next === prev) return;
      // Keep the point under the cursor fixed across the zoom (transform-origin is centre).
      const r = box.getBoundingClientRect();
      const cx = e.clientX - (r.left + r.width / 2), cy = e.clientY - (r.top + r.height / 2);
      frame.x = cx - (cx - frame.x) * (next / prev);
      frame.y = cy - (cy - frame.y) * (next / prev);
      frame.scale = next;
      if (frame.scale === 1) { frame.x = 0; frame.y = 0; } else clamp();
      apply();
      if (next > prev && opts.onZoom) opts.onZoom();
    }, { passive: false });
    box.addEventListener('dblclick', () => { frame.scale = 1; frame.x = 0; frame.y = 0; apply(); });
    box.addEventListener('pointerdown', (e) => {
      const sx = e.clientX, sy = e.clientY, ox = frame.x, oy = frame.y;
      let moved = 0;
      try { box.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      const move = (ev) => {
        moved += Math.abs(ev.movementX) + Math.abs(ev.movementY);
        if (frame.scale > 1) {
          frame.x = ox + (ev.clientX - sx); frame.y = oy + (ev.clientY - sy);
          clamp(); apply();
        }
      };
      const up = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        if (moved < 4 && opts.onClick) opts.onClick();
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
    });
  }

  /** Full-window preview of a drawing. Renders the PDF on demand at full scale (not the small
   *  scan thumbnail), so it stays sharp under wheel-zoom + drag-pan (scroll to zoom at the
   *  cursor, drag to pan, double-click to reset). A PNG always renders inline — no browser
   *  "download PDFs" detour or X-Frame-Options blank. Dismissed by the backdrop, the ✕, or Esc. */
  _lightbox(p) {
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { document.removeEventListener('keydown', onKey); box.remove(); };
    const img = Dom.el('img', { class: 'imp-lightbox-img', src: ImportWizard._previewUrl(p.pdf) });
    const spin = Dom.el('div', { class: 'imp-lightbox-spin' }, 'Rendering preview…');
    img.addEventListener('load', () => spin.remove());
    img.addEventListener('error', () => { spin.remove(); Toast.show('Preview failed to render', true); });
    const body = Dom.el('div', { class: 'imp-lightbox-body' }, [img, spin]);
    const panel = Dom.el('div', { class: 'imp-lightbox-panel' }, [
      Dom.el('div', { class: 'imp-lightbox-head' }, [
        Dom.el('span', {}, p.file),
        Dom.el('button', { class: 'imp-lightbox-x', title: 'Close', onclick: close }, '✕'),
      ]),
      body,
    ]);
    const box = Dom.el('div', { class: 'imp-lightbox' }, [panel]);
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(box);
    this._attachZoomPan(body, img, { scale: 1, x: 0, y: 0 });
  }

  _autoNumber(b) {
    b.pdfs.forEach((p, i) => { b.assign[p.stem] = { type: 'level', num: i + 1, token: null, label: '' }; });
    this._stepMap();
  }

  /** POST the current building model to the server as a draft so it can be restored on next
   *  open. Silent on failure — a missing draft just means the user starts fresh. */
  async _saveDraft() {
    try {
      const apiBase = window.MAP ? window.MAP.api : '/api/';
      const headers = { 'Content-Type': 'application/json' };
      if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
      await fetch(apiBase + 'import/save-draft', {
        method: 'POST', headers,
        body: JSON.stringify({ buildings: this.buildings, site: this.site,
          assignMode: this._assignMode, ocrRegion: this._ocrRegion, bIdx: this._bIdx }),
      });
    } catch (e) { console.warn('Draft save failed:', e); }
  }

  /** Fetch a saved draft and merge it into `this.buildings` / `this.site`. New folders (not
   *  in the draft) keep their `_modelFromInventory` defaults; removed stems are ignored. */
  async _applyDraft() {
    try {
      const apiBase = window.MAP ? window.MAP.api : '/api/';
      const r = await fetch(apiBase + 'import/load-draft');
      if (!r.ok) return;
      const draft = await r.json();
      if (!draft.ok) return;
      const byFolder = new Map((draft.buildings || []).map(b => [b.folder, b]));
      for (const b of this.buildings) {
        const d = byFolder.get(b.folder);
        if (!d) continue;
        if (d.name != null) b.name = d.name;
        if (d.slug != null) b.slug = d.slug;
        if (d.abbr != null) b.abbr = d.abbr;
        if (d.nbSite !== undefined) b.nbSite = d.nbSite;
        for (const [stem, a] of Object.entries(d.assign || {}))
          if (stem in b.assign) b.assign[stem] = a;
        for (const [stem, f] of Object.entries(d.frame || {}))
          if (stem in b.frame) b.frame[stem] = f;
      }
      if (draft.site?.file) this.site = draft.site;
      if (draft.assignMode) this._assignMode = draft.assignMode;
      if (draft.ocrRegion) this._ocrRegion = draft.ocrRegion;
      // Resume on the building the user last viewed. Clamp — folders can be added/removed
      // between sessions, and `_stepMap` indexes `buildings[_bIdx]` with no bounds check.
      if (this.buildings.length) {
        const n = Number.isInteger(draft.bIdx) ? draft.bIdx : 0;
        this._bIdx = Math.max(0, Math.min(n, this.buildings.length - 1));
      }
    } catch (e) { console.warn('Draft load failed:', e); }
  }

  /** Resolve a building's per-PDF controls into the import-map `floors` table. */
  _resolveFloors(b) {
    const floors = {}; let last = null;
    for (const p of b.pdfs) {
      const a = b.assign[p.stem]; let tok = null;
      if (a.token) tok = a.token;   // direct NetBox Location slug (Location mode)
      else if (a.type === 'basement') tok = 'b' + (a.num || 1);
      else if (a.type === 'ground') tok = 'g';
      else if (a.type === 'level') tok = 'l' + (a.num || 1);
      else if (a.type === 'roof') tok = 'r';
      else if (a.type === 'same') tok = last;
      if (tok) { floors[p.stem] = tok; last = tok; }
    }
    return floors;
  }

  /** Names of buildings that still hold an `unassigned` drawing (Location mode, untouched —
   *  see `_normalizeToLocations`). The build gate lists these so the user knows where to look.
   *  A cheap synchronous pass over the in-memory model — `_stepMap` recomputes it every render.
   *  Buildings the user hasn't visited keep their `_modelFromInventory` level defaults (never
   *  `unassigned`), so they don't gate the build; only visited Location-mode buildings can. */
  _unassignedBuildings() {
    return this.buildings
      .filter(b => b.pdfs.some(p => b.assign[p.stem].type === 'unassigned'))
      .map(b => b.name || b.folder);
  }

  /** Floors that currently hold rooms but whose id won't exist after this build — i.e. the
   *  rebuild would orphan their rooms. Compares the keys the build will produce
   *  (`siteSlug/(abbr+token)`, mirroring `preprocess.build`) against the live manifest's floors
   *  and their room counts. Returns `[{ key, label, count }]`; empty when nothing is at risk
   *  (e.g. a pure PDF replacement, where the id is unchanged). */
  async _orphanedFloors(map) {
    const store = this.app.store;
    if (!store || !store.manifest) return [];
    const newKeys = new Set();
    for (const folder in map.buildings) {
      const mb = map.buildings[folder];
      for (const stem in mb.floors) newKeys.add(mb.slug + '/' + (mb.abbr + mb.floors[stem]));
    }
    // Fetch annotations fresh so the room counts reflect the current DB, not a stale cache.
    let anns = store.annotations || {};
    try { anns = await Api.get('/api/annotations'); } catch (_) { /* fall back to the cache */ }
    const out = [];
    for (const b of store.manifest.buildings) {
      for (const f of b.floors) {
        const key = b.dir + '/' + f.id;
        const n = (anns[key] && anns[key].rooms && anns[key].rooms.length) || 0;
        if (n && !newKeys.has(key)) out.push({ key, label: b.name + ' / ' + f.label, count: n });
      }
    }
    return out;
  }

  // ---- step 3: build ----
  async _build() {
    const map = { siteplan: this.site.file
      ? { folder: this.site.folder, pdf: this.site.file, slug: '00-site' } : null, buildings: {} };
    for (const b of this.buildings) {
      if (!b.slug.trim()) { Toast.show('Every building needs a site slug (' + b.folder + ')', true); return; }
      const floors = this._resolveFloors(b);
      if (!Object.keys(floors).length) continue;   // a siteplan-only folder, etc.
      // Floor tokens that are real Location slugs must not be re-prefixed: `preprocess.py`
      // builds the floor id as `abbr + token`, and that id is later matched against
      // `Location.slug`, so force an empty prefix whenever a direct token is in play.
      const usesTokens = b.pdfs.some(p => b.assign[p.stem].token);
      map.buildings[b.folder] = { slug: b.slug.trim(), name: b.name.trim() || b.folder,
        abbr: usesTokens ? '' : b.abbr.trim(), floors };
    }
    if (!Object.keys(map.buildings).length) { Toast.show('Assign at least one floor', true); return; }

    // Re-assigning a drawing's floor or re-binding a building changes the floor id; rooms drawn
    // on the old id are no longer in the rebuilt manifest. Warn before discarding them.
    const orphaned = await this._orphanedFloors(map);
    if (orphaned.length) {
      const lines = orphaned.map(o => '  • ' + o.label + '  ('
        + o.count + (o.count === 1 ? ' room' : ' rooms') + ')');
      if (!confirm('This rebuild changes these floors’ ids, so the rooms drawn on them will be '
          + 'removed:\n\n' + lines.join('\n') + '\n\nContinue and discard those rooms?'))
        return this._stepMap();
    }

    const view = this._stage('Building facility map…');
    view.append(Dom.el('div', { class: 'imp-spinner' },
      'Rendering ' + Object.keys(map.buildings).length + ' buildings — this can take a minute.'));
    try {
      const r = await Api.post('/api/import/build', map);
      if (!r.ok) throw new Error(r.error || 'build failed');
      await this.app.store.load();
      // Discard the rooms the user agreed to drop: removing the orphaned floors and re-saving
      // routes the delete through the authoritative, permission-scoped `sync_rooms` (no new
      // endpoint, no loosened scoping).
      if (orphaned.length) {
        for (const o of orphaned) delete this.app.store.annotations[o.key];
        try { await this.app.store.saveAnnotations(); } catch (_) { /* best effort cleanup */ }
      }
      Toast.show('Facility imported');
      this.app.go('#/'); this.app.router();
    } catch (e) {
      Toast.show('Build failed: ' + e.message, true);
      this._stepMap();
    }
  }

  async _reset() {
    if (!confirm('Clear the uploaded PDFs and start the import over?')) return;
    try { await Api.post('/api/import/reset', {}); } catch (e) { /* ignore */ }
    this.inv = null; this.buildings = []; this.site = { folder: '', file: '' };
    this._bIdx = 0;
    this._autoMapDone = false;
    this._assignMode = null;
    this._ocrRegion = null;
    this._mergeMode = false;
    this._stepUpload();
  }
}
