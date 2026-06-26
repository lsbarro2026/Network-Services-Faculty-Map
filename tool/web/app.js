'use strict';
/* app.js — App: top-level orchestrator and entry point. Owns the singletons
   (Store, NetBoxClient, GridController), cross-view UI state (edit/view mode,
   siteplan-edit flag, view-mode highlight), the hash router, and global chrome
   (breadcrumbs, toolbar, side panel, keyboard). Loaded LAST. */

class App {
  constructor() {
    this.store = new Store();
    this.netbox = new NetBoxClient();
    this.grid = new GridController();   // shared by both editors
    this.mode = 'edit';                 // floor editor: 'edit' | 'view' | 'racks'
    this.siteEdit = false;              // siteplan: editing building areas
    this.highlight = 'datacenters';     // floor view-mode highlight
    this.current = null;                // active Editor (or null on building view)
  }

  async init() {
    try { await this.store.load(); }
    catch (e) {
      document.body.innerHTML = '<div class="empty">Failed to load: ' + e.message
        + '<br>Is server.py running?</div>';
      return;
    }
    this._bindGlobal();
    this._navHash = location.hash;   // baseline for the unsaved-work navigation guard
    this.router();
  }

  // ---- routing ----
  go(hash) { location.hash = hash; }

  router() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    this.closePanel();
    if (parts[0] === 'import') return this.showImport();
    if (parts[0] === 'settings') return this.showSettings();
    if (parts[0] === 'b') return this.renderBuilding(decodeURIComponent(parts[1]));
    if (parts[0] === 'f') return this.showFloor(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
    // With no facility imported yet, the home screen is the import wizard.
    if (!this.store.hasContent()) return this.showImport();
    return this.showSiteplan();
  }

  showImport() { this.current = null; new ImportWizard(this).show(); }

  /** Settings view (no editor active). Rack inventory now syncs per room from the
   *  floor's Place-racks panel, so there is nothing rack-related to configure here. */
  showSettings() {
    this.current = null;
    this.crumbs([{ label: 'Siteplan', hash: '/' }, { label: 'Settings' }]);
    this.setToolbar([]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    stage.append(Dom.el('div', { class: 'settings-view' }, [
      Dom.el('h2', {}, 'Settings'),
      Dom.el('button', { class: 'primary', onclick: () => this.go('/import') },
        'Import a facility from PDFs'),
      Dom.el('div', { class: 'hint' },
        'Upload building folders of floor-plan PDFs to (re)build the map. Rack inventory '
        + 'is pulled per room from the floor view: Edit → Place racks → open a datacenter '
        + 'room → Refresh racks.'),
    ]));
  }

  showSiteplan() { this.current = new SiteplanEditor(this); this.current.show(); }

  showFloor(dir, fid) {
    const b = this.store.building(dir);
    if (!b) return this.showSiteplan();
    const f = b.floors.find(x => x.id === fid);
    if (!f) return this.renderBuilding(dir);
    this.current = new FloorEditor(this, b, f);
    this.current.show();
  }

  /** Building view: a grid of floor cards (no editor active). */
  renderBuilding(dir) {
    this.current = null;
    const b = this.store.building(dir);
    if (!b) return this.showSiteplan();
    this.crumbs([{ label: 'Siteplan', hash: '/' }, { label: b.name }]);
    this.setToolbar([Dom.el('span', { class: 'hint' }, b.siteSlug)]);
    const stage = Dom.$('#stage'); stage.innerHTML = '';
    if (!b.floors.length) { stage.append(Dom.el('div', { class: 'empty' }, 'No floor maps for ' + b.name)); return; }

    const grid = Dom.el('div', { class: 'floor-grid' });
    for (const f of b.floors) {
      const key = Util.floorKey(dir, f.id);
      const rec = this.store.annotations[key];
      const n = (rec && rec.rooms.length) || 0;
      grid.append(Dom.el('div', {
        class: 'floor-card',
        onclick: () => this.go('/f/' + encodeURIComponent(dir) + '/' + encodeURIComponent(f.id)),
      }, [
        Dom.el('img', { src: '/' + f.image, loading: 'lazy' }),
        Dom.el('div', { class: 'cap' }, [
          Dom.el('b', {}, f.label),
          Dom.el('span', { class: 'cnt ' + (n ? 'mapped' : 'unmapped') }, n ? n + ' rooms' : 'unmapped'),
          ...(f.pages && f.pages.length > 1 ? [Dom.el('span', { class: 'cnt sheets' }, f.pages.length + ' sheets')] : []),
        ]),
      ]));
    }
    stage.append(grid);
  }

  // ---- shared chrome ----
  crumbs(items) {
    const nav = Dom.$('#crumbs'); nav.innerHTML = '';
    items.forEach((it, i) => {
      if (i) nav.append(Dom.el('span', { class: 'sep' }, '›'));
      nav.append(it.hash ? Dom.el('a', { onclick: () => this.go(it.hash) }, it.label)
        : Dom.el('span', {}, it.label));
    });
  }
  setToolbar(nodes) {
    const tb = Dom.$('#toolbar'); tb.innerHTML = '';
    [].concat(nodes).forEach(n => n && tb.append(n));
  }
  closePanel() {
    Dom.$('#panel').classList.add('hidden');
    if (this.current && this.current.onPanelClosed) this.current.onPanelClosed();
  }

  _bindGlobal() {
    const gear = Dom.$('#settings-gear');
    gear.innerHTML = Icons.settings;
    gear.addEventListener('click', () => this.go('/settings'));
    Dom.$('#panel-close').addEventListener('click', () => this.closePanel());
    window.addEventListener('beforeunload', (e) => {
      if (this.store.hasUnsaved()) { e.preventDefault(); e.returnValue = ''; }
    });
    // Guard in-app navigation: hashchange fires after the URL has changed, so on a
    // cancelled prompt we revert location.hash (which fires a second hashchange we
    // swallow via _revertingHash). Covers every page change — crumbs, hotspots, floor
    // cards, gear, go(), and the Back/Forward buttons — through the one chokepoint.
    window.addEventListener('hashchange', () => {
      if (this._revertingHash) { this._revertingHash = false; this._navHash = location.hash; return; }
      if (this.store.hasUnsaved() &&
          !confirm('You have unsaved changes that will be lost. Leave this page?')) {
        this._revertingHash = true;
        location.hash = this._navHash;
        return;
      }
      this._navHash = location.hash;
      this.router();
    });
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (this.current instanceof Editor) this.current.handleKey(e);
    });
  }
}

window.addEventListener('DOMContentLoaded', () => new App().init());
