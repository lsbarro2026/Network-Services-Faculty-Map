'use strict';
/* import-uploader.js — ImportUploader: the import wizard's file-ingestion + upload concern.
   Walks a picked/dropped folder or zip into PDF items and streams them to the server. Pure
   ingestion helpers (fromInput/fromDrop/split) and the shared upload primitive (uploadFile)
   are static; the upload orchestrators need the wizard back-ref (`this.w`) for its progress
   element, merge-mode flag, and the post-upload routing (`_scanAndMap`/`_mergeUploads`).

   Mount-aware: uploads resolve against window.MAP.api and carry the session CSRF token so the
   session-auth POST isn't rejected; the server streams the multipart body to disk. */

class ImportUploader {
  constructor(wizard) {
    this.w = wizard;
  }

  static fromInput(fileList) {
    return [...fileList].filter(f => f.name.toLowerCase().endsWith('.pdf'))
      .map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
  }

  static async fromDrop(dt) {
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
  static split(relPath, hasSubfolders) {
    const segs = relPath.split('/').filter(Boolean);
    if (hasSubfolders && segs.length === 2) return { folder: 'Site Plan', file: segs[1] };
    return { folder: segs.length > 1 ? segs[segs.length - 2] : 'Building', file: segs[segs.length - 1] };
  }

  /** POST one file to the working-dir path `<folder>/<file>` under `import/upload`. Multipart so
   *  the server streams to disk (no in-memory body cap); CSRF header so the session-auth POST
   *  isn't rejected. Throws on a non-OK response. Shared by the folder upload and the per-card
   *  Replace control. */
  static async uploadFile(path, file, name) {
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    const fd = new FormData();
    fd.append('file', file, name);
    const headers = {};
    if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
    const r = await fetch(apiBase + 'import/upload?path=' + encodeURIComponent(path),
      { method: 'POST', headers, body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }

  async upload(items) {
    if (!items.length) { Toast.show('No PDFs found in that selection', true); return; }
    const progress = this.w._progress;
    progress.classList.remove('hidden');
    const hasSubfolders = items.some(it => it.path.split('/').filter(Boolean).length >= 3);
    let done = 0;
    for (const it of items) {
      const { folder, file } = ImportUploader.split(it.path, hasSubfolders);
      progress.textContent = `Uploading ${++done} / ${items.length}…`;
      try {
        await ImportUploader.uploadFile(folder + '/' + file, it.file, file);
      } catch (e) { Toast.show('Upload failed: ' + e.message, true); return; }
    }
    progress.textContent = `Uploaded ${items.length} drawings — rendering previews…`;
    if (this.w._mergeMode) this.w._mergeUploads(); else this.w._scanAndMap();
  }

  /** Upload a single `.zip`; the server extracts its PDFs (stripping any wrapper folder)
   *  into the same `uploads/<building>/<file>` layout a folder upload produces. */
  async uploadZip(file) {
    const progress = this.w._progress;
    progress.classList.remove('hidden');
    progress.textContent = `Uploading ${file.name}…`;
    const apiBase = window.MAP ? window.MAP.api : '/api/';
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const headers = {};
      if (window.MAP && window.MAP.csrf) headers['X-CSRFToken'] = window.MAP.csrf;
      const r = await fetch(apiBase + 'import/upload-zip', { method: 'POST', headers, body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'HTTP ' + r.status);
      progress.textContent = `Extracted ${j.count} drawings — rendering previews…`;
    } catch (e) { Toast.show('Zip upload failed: ' + e.message, true); return; }
    if (this.w._mergeMode) this.w._mergeUploads(); else this.w._scanAndMap();
  }
}
