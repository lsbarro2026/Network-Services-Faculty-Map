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
  constructor(app) {
    this.app = app;
    this.inv = null;        // scan inventory { folders:[{folder, pdfs:[...]}] }
    this.buildings = [];    // per-folder editable model (see _modelFromInventory)
    this.site = { folder: '', file: '' };  // chosen siteplan PDF (or empty = none)
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

  _stage(title) {
    this.app.current = null;
    this.app.crumbs([{ label: 'Siteplan', hash: '/' }, { label: 'Import' }]);
    this.app.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    const view = Dom.el('div', { class: 'import-view' }, [Dom.el('h2', {}, title)]);
    stage.append(view);
    return view;
  }

  show() { this._stepUpload(); }

  // ---- step 1: upload ----
  _stepUpload() {
    const view = this._stage('Import a facility');
    view.append(Dom.el('p', { class: 'hint' },
      'Select the folder of building drawings — one sub-folder per building, each holding '
      + 'its floor PDFs. The PDFs are uploaded to NetBox and rendered there.'));

    const input = Dom.el('input', {
      type: 'file', class: 'imp-file', multiple: 'multiple', accept: '.pdf',
      onchange: (e) => this._upload(this._fromInput(e.target.files)),
    });
    input.setAttribute('webkitdirectory', '');
    const drop = Dom.el('div', { class: 'imp-drop' }, [
      Dom.el('div', { class: 'imp-drop-big' }, 'Drop a facility folder here'),
      Dom.el('div', { class: 'hint' }, 'or'),
      Dom.el('label', { class: 'imp-pick' }, [Dom.el('span', {}, 'Choose folder…'), input]),
    ]);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('over');
      this._upload(await this._fromDrop(e.dataTransfer));
    });
    view.append(drop);
    this._progress = Dom.el('div', { class: 'imp-progress hidden' });
    view.append(this._progress);
    view.append(Dom.el('div', { class: 'hint' },
      ['Already uploaded? ', Dom.el('a', { onclick: () => this._scanAndMap() }, 'Continue to mapping'),
        ' · ', Dom.el('a', { onclick: () => this._reset() }, 'Start over')]));
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

  /** Building folder + filename from a relative path `<root>/<building>/<file>.pdf`. */
  static _split(relPath) {
    const segs = relPath.split('/').filter(Boolean);
    return { folder: segs.length > 1 ? segs[segs.length - 2] : 'Building', file: segs[segs.length - 1] };
  }

  async _upload(items) {
    if (!items.length) { Toast.show('No PDFs found in that selection', true); return; }
    this._progress.classList.remove('hidden');
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    let done = 0;
    for (const it of items) {
      const { folder, file } = ImportWizard._split(it.path);
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
    this._scanAndMap();
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
    this._stepMap();
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
        assign: Object.fromEntries(f.pdfs.map((p, i) =>
          [p.stem, isSite ? { type: 'none', num: 1 } : { type: 'level', num: i + 1 }])),
      });
    }
  }

  _stepMap() {
    const view = this._stage('Map drawings to floors');
    view.append(Dom.el('p', { class: 'hint' },
      'For each building, set its name, NetBox site slug, and floor-id prefix, then assign '
      + 'each drawing a floor. Click a thumbnail to open the full PDF. Two drawings on the '
      + 'same floor (e.g. stacked sheets) → set the second to “same floor”.'));

    view.append(this._siteplanRow());
    for (const b of this.buildings) view.append(this._buildingSection(b));

    const buildBtn = Dom.el('button', { class: 'primary', onclick: () => this._build() },
      'Build facility map');
    view.append(Dom.el('div', { class: 'imp-actions' }, [
      buildBtn,
      Dom.el('button', { onclick: () => this._reset() }, 'Start over'),
    ]));
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
      Dom.el('span', { class: 'hint' }, 'the overall map; draw building areas on it later'),
    ]);
  }

  _buildingSection(b) {
    const field = (label, key, w) => Dom.el('label', { class: 'imp-field' }, [
      Dom.el('span', {}, label),
      Dom.el('input', { value: b[key], style: 'width:' + w,
        oninput: (e) => { b[key] = e.target.value; } }),
    ]);
    const head = Dom.el('div', { class: 'imp-bhead' }, [
      field('Building name', 'name', '15em'),
      field('Site slug', 'slug', '9em'),
      field('Floor prefix', 'abbr', '6em'),
      Dom.el('button', { class: 'imp-auto',
        onclick: () => this._autoNumber(b) }, 'Number floors 1…N'),
    ]);
    const grid = Dom.el('div', { class: 'imp-grid' });
    for (const p of b.pdfs) grid.append(this._pdfCard(b, p));
    return Dom.el('section', { class: 'imp-building' }, [head, grid]);
  }

  _pdfCard(b, p) {
    const a = b.assign[p.stem];
    const num = Dom.el('input', { type: 'number', min: '1', class: 'imp-num', value: a.num,
      oninput: (e) => { a.num = parseInt(e.target.value, 10) || 1; } });
    const showNum = () => { num.style.visibility = (a.type === 'basement' || a.type === 'level') ? '' : 'hidden'; };
    const sel = Dom.el('select', { onchange: (e) => { a.type = e.target.value; showNum(); } });
    for (const [v, lbl] of [['none', '— none —'], ['basement', 'Basement'], ['ground', 'Ground'],
      ['level', 'Level'], ['roof', 'Roof'], ['same', '↳ same floor (extra sheet)']]) {
      const o = Dom.el('option', { value: v }, lbl); if (a.type === v) o.selected = true; sel.append(o);
    }
    showNum();
    const href = ImportWizard._media(p.pdf);
    return Dom.el('div', { class: 'imp-card' }, [
      Dom.el('a', { href, target: '_blank', rel: 'noopener', class: 'imp-thumb' },
        p.thumb ? Dom.el('img', { src: ImportWizard._media(p.thumb), loading: 'lazy' })
          : Dom.el('div', { class: 'imp-nothumb' }, p.file)),
      Dom.el('div', { class: 'imp-cardfile' }, p.file),
      Dom.el('div', { class: 'imp-cardrow' }, [sel, num]),
    ]);
  }

  _autoNumber(b) {
    b.pdfs.forEach((p, i) => { b.assign[p.stem] = { type: 'level', num: i + 1 }; });
    this._stepMap();
  }

  /** Resolve a building's per-PDF controls into the import-map `floors` table. */
  _resolveFloors(b) {
    const floors = {}; let last = null;
    for (const p of b.pdfs) {
      const a = b.assign[p.stem]; let tok = null;
      if (a.type === 'basement') tok = 'b' + (a.num || 1);
      else if (a.type === 'ground') tok = 'g';
      else if (a.type === 'level') tok = 'l' + (a.num || 1);
      else if (a.type === 'roof') tok = 'r';
      else if (a.type === 'same') tok = last;
      if (tok) { floors[p.stem] = tok; last = tok; }
    }
    return floors;
  }

  // ---- step 3: build ----
  async _build() {
    const map = { siteplan: this.site.file
      ? { folder: this.site.folder, pdf: this.site.file, slug: '00-site' } : null, buildings: {} };
    for (const b of this.buildings) {
      if (!b.slug.trim()) { Toast.show('Every building needs a site slug (' + b.folder + ')', true); return; }
      const floors = this._resolveFloors(b);
      if (!Object.keys(floors).length) continue;   // a siteplan-only folder, etc.
      map.buildings[b.folder] = { slug: b.slug.trim(), name: b.name.trim() || b.folder,
        abbr: b.abbr.trim(), floors };
    }
    if (!Object.keys(map.buildings).length) { Toast.show('Assign at least one floor', true); return; }

    const view = this._stage('Building facility map…');
    view.append(Dom.el('div', { class: 'imp-spinner' },
      'Rendering ' + Object.keys(map.buildings).length + ' buildings — this can take a minute.'));
    try {
      const r = await Api.post('/api/import/build', map);
      if (!r.ok) throw new Error(r.error || 'build failed');
      await this.app.store.load();
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
    this._stepUpload();
  }
}
