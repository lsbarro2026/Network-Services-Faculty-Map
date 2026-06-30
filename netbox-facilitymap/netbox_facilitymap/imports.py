"""In-app PDF import: upload → scan → build, plus authenticated serving of the result.

These endpoints replace the standalone tool's `/api/import/*` routes and its static
serving of `images/` + `manifest.json`. The security posture (the whole reason import was
kept out of NetBox originally) is enforced here:

  * **Isolation** — PDFs are never parsed in this process. `_run_preprocess` shells out to
    `preprocess.py` *by file path* (so the package's NetBox-importing `__init__` is not
    loaded into the child), with a timeout and POSIX resource limits. A PDFium exploit is
    contained in a short-lived, capped subprocess.
  * **Authorization** — every import endpoint requires the `change_facilitymapblob`
    permission (`PermissionRequiredMixin`), not merely a login, unlike the legacy
    localhost-trust model. Manifest/media reads require a login (same access as the map).
  * **Input validation** — uploads must be `%PDF-` magic-byte PDFs within a size cap and a
    traversal-guarded path; an import is rejected past a PDF-count cap.
  * **Serving** — rendered floor plans are streamed from `MEDIA_ROOT` through a login-gated
    view, never exposed at a guessable public static URL.
  * **Concurrency** — a working-dir lockfile serializes renders across worker processes
    (a thread lock could not), with stale-lock recovery.
"""

import json
import mimetypes
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.http import (FileResponse, Http404, HttpResponseBadRequest, JsonResponse)
from django.views import View

from netbox.plugins import get_plugin_config

from .storage import EMPTY_MANIFEST, MANIFEST_NAME, SERVE_ROOTS, safe_path, work_dir

# Importing/rebuilding a facility rewrites the whole map (and `reset` wipes it), so gate it
# on the blob model's change permission — admin-grantable, and stricter than login-only.
EDIT_PERM = 'netbox_facilitymap.change_facilitymapblob'

LOCK_NAME = '.import.lock'

# On-demand high-res preview renders are cached here (mirrors preprocess.py's THUMBS_DIRNAME).
# Living under uploads/.thumbs means `scan` skips it and `reset` wipes it for free.
THUMBS_DIRNAME = '.thumbs'


def _cfg(key):
    return get_plugin_config('netbox_facilitymap', key)


# --- render subprocess (isolated + resource-limited) -------------------------------

def _rlimits(timeout_s, mem_mb):
    """Return a POSIX `preexec_fn` capping the child's CPU time and address space, so a
    runaway or malicious render can't exhaust the host."""
    def apply():
        import resource
        cpu = int(timeout_s) + 5
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        if mem_mb:
            nbytes = int(mem_mb) * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (nbytes, nbytes))
    return apply


def _run_script(script_name, mode, extra=None, json_stdout=False, mem_mb=None, timeout_s=None):
    """Spawn `<script_name> <mode> --base <workdir> [extra...]` and shape its result. Invoked
    by file path (not `-m`) so the child stays minimal/isolated — no Django in-process. The
    render (`preprocess.py`) and OCR (`ocr.py`) subprocesses share this isolation: a timeout
    plus POSIX CPU/address-space rlimits cap a runaway or malicious child. `mem_mb`/`timeout_s`
    default to the render caps; the OCR pass overrides `mem_mb` since it reads only trusted PNGs
    (a render-sized RLIMIT_AS kills onnxruntime). `json_stdout` reads the child's stdout as the
    JSON result (scan/ocr); otherwise stderr is returned as a log."""
    base = work_dir()
    base.mkdir(parents=True, exist_ok=True)
    script = str(Path(__file__).resolve().parent / script_name)
    timeout = _cfg('render_timeout_s') if timeout_s is None else timeout_s
    if mem_mb is None:
        mem_mb = _cfg('render_mem_mb')
    kwargs = {}
    if os.name == 'posix':
        kwargs['preexec_fn'] = _rlimits(timeout, mem_mb)
    try:
        proc = subprocess.run(
            [sys.executable, script, mode, '--base', str(base), *(extra or [])],
            capture_output=True, text=True, cwd=str(base), timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': '%s timed out after %ss' % (mode, timeout)}
    if proc.returncode != 0:
        return {'ok': False,
                'error': (proc.stderr or proc.stdout).strip()[:2000] or (mode + ' failed')}
    if json_stdout:
        try:
            return {'ok': True, **json.loads(proc.stdout or '{}')}
        except json.JSONDecodeError:
            return {'ok': False, 'error': (proc.stderr or proc.stdout)[:1000]}
    return {'ok': True, 'log': proc.stderr.strip()[:2000]}


def _run_preprocess(mode, extra=None):
    """Run the render subprocess (`preprocess.py`). `extra` carries mode-specific argv (e.g.
    `--pdf`/`--out` for `preview`); `scan` returns its inventory from stdout."""
    return _run_script('preprocess.py', mode, extra, json_stdout=(mode == 'scan'))


def _run_ocr(extra=None):
    """Run the OCR subprocess (`ocr.py`) over already-rendered PNGs; returns its results from
    stdout. Kept separate from `preprocess.py` so the render child never imports the OCR deps
    and the OCR child never parses a PDF. Uses its own memory budget (`ocr_mem_mb`): it touches
    only trusted PNGs, so the render-sized RLIMIT_AS — which would kill onnxruntime — is wrong."""
    return _run_script('ocr.py', 'ocr', extra, json_stdout=True, mem_mb=_cfg('ocr_mem_mb'))


def _ensure_preview(pdf_rel):
    """Ensure the full-scale PNG for an uploaded PDF exists (rendering it via `preprocess.py`
    if missing/stale) and return its working-dir-relative cache path. Shared by the preview
    endpoint and the OCR pass so both reuse the one `.thumbs/<...>.full.png` cache. `pdf_rel`
    is working-dir-relative (`uploads/...`). Raises `Http404` when the PDF is absent; returns
    `None` on a render failure."""
    base = work_dir().resolve()
    full = safe_path(pdf_rel)
    try:
        inside = full.relative_to(base / 'uploads')
    except ValueError:
        raise Http404
    if not full.is_file():
        raise Http404
    cache = base / 'uploads' / THUMBS_DIRNAME / inside.with_suffix('.full.png')
    cache_rel = cache.relative_to(base).as_posix()
    try:
        fresh = cache.is_file() and cache.stat().st_mtime >= full.stat().st_mtime
    except OSError:
        fresh = False
    if not fresh:
        result = _run_preprocess('preview', ['--pdf', full.relative_to(base).as_posix(),
                                             '--out', cache_rel])
        if not result.get('ok') or not cache.is_file():
            return None
    return cache_rel


def _acquire_lock(stale_after):
    """Atomically create the working-dir lockfile. Returns its Path, or None if another
    import holds a still-fresh lock. A lock older than `stale_after` (a crashed render) is
    reclaimed once."""
    base = work_dir()
    base.mkdir(parents=True, exist_ok=True)
    lock = base / LOCK_NAME
    try:
        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            age = time.time() - lock.stat().st_mtime
        except FileNotFoundError:
            age = stale_after + 1
        if age <= stale_after:
            return None
        try:
            os.unlink(str(lock))
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except (FileExistsError, FileNotFoundError):
            return None
    os.close(fd)
    return lock


def _run_locked(mode):
    """Run a render under the working-dir lock; 409 if one is already in flight."""
    lock = _acquire_lock(_cfg('render_timeout_s') * 2)
    if lock is None:
        return JsonResponse({'ok': False, 'error': 'an import is already running'}, status=409)
    try:
        result = _run_preprocess(mode)
    finally:
        try:
            os.unlink(str(lock))
        except FileNotFoundError:
            pass
    return JsonResponse(result)


def _count_pdfs(base):
    uploads = base / 'uploads'
    return sum(1 for _ in uploads.rglob('*.pdf')) if uploads.is_dir() else 0


def _zip_targets(names):
    """Map a zip's `.pdf` member paths to `(folder, file)` upload destinations, mirroring the
    wizard's folder-upload split (see `ImportWizard._split`). A single directory shared by
    every drawing — the wrapper folder a zip usually has — is stripped first; a PDF then
    sitting at the root alongside subfoldered drawings is treated as the overall site map."""
    pdfs = [n for n in names if n.lower().endswith('.pdf') and not n.endswith('/')]
    split = [[s for s in n.replace('\\', '/').split('/') if s] for n in pdfs]
    # Peel off any leading directory shared by every drawing (nested wrapper folders).
    while split and all(len(s) > 1 for s in split) and len({s[0] for s in split}) == 1:
        split = [s[1:] for s in split]
    has_subfolders = any(len(s) >= 2 for s in split)
    out = {}
    for name, segs in zip(pdfs, split):
        if not segs:
            continue
        if has_subfolders and len(segs) == 1:
            out[name] = ('Site Plan', segs[-1])
        else:
            out[name] = (segs[-2] if len(segs) > 1 else 'Building', segs[-1])
    return out


# --- endpoints ---------------------------------------------------------------------

class _ImportView(PermissionRequiredMixin, View):
    """POST-only base: unauthenticated → login redirect; authenticated without the change
    permission → 403 (PermissionRequiredMixin default)."""
    permission_required = EDIT_PERM


class UploadView(_ImportView):
    """Store one uploaded PDF under `<workdir>/uploads/<folder>/<file>`. The file rides a
    multipart form (`file` field) so Django streams it to disk rather than buffering the
    whole body in memory."""

    def post(self, request):
        rel = (request.GET.get('path') or '').lstrip('/')
        if not rel.lower().endswith('.pdf'):
            return HttpResponseBadRequest('a .pdf path is required')
        try:
            target = safe_path('uploads/' + rel)
            parts = target.relative_to(work_dir().resolve()).parts
        except ValueError:
            return HttpResponseBadRequest('invalid path')
        if not parts or parts[0] != 'uploads':
            return HttpResponseBadRequest('invalid path')

        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if up.size > _cfg('max_pdf_mb') * 1024 * 1024:
            return JsonResponse({'ok': False, 'error': 'file exceeds size limit'}, status=413)
        if not up.read(5).startswith(b'%PDF-'):
            return HttpResponseBadRequest('not a PDF (bad magic bytes)')

        target.parent.mkdir(parents=True, exist_ok=True)
        part = target.with_name(target.name + '.part')
        up.seek(0)
        with open(part, 'wb') as f:
            for chunk in up.chunks():
                f.write(chunk)
        os.replace(part, target)
        return JsonResponse({'ok': True, 'bytes': up.size})


class UploadZipView(_ImportView):
    """Extract one uploaded `.zip` of building drawings into `<workdir>/uploads/...`, mapping
    members the same way folder uploads are (`_zip_targets`). Extraction only writes bytes and
    checks magic — PDFs are still parsed solely in the isolated render subprocess, so this does
    not breach that isolation. Guarded against oversize archives, zip bombs (per-file +
    cumulative decompressed caps), path traversal, and symlink/special members."""

    def post(self, request):
        up = request.FILES.get('file')
        if up is None:
            return HttpResponseBadRequest('missing file')
        if not (up.name or '').lower().endswith('.zip'):
            return HttpResponseBadRequest('a .zip file is required')
        if up.size > _cfg('max_zip_mb') * 1024 * 1024:
            return JsonResponse({'ok': False, 'error': 'zip exceeds size limit'}, status=413)
        if not up.read(4).startswith(b'PK\x03\x04'):
            return HttpResponseBadRequest('not a zip (bad magic bytes)')
        up.seek(0)

        max_pdfs = _cfg('max_pdfs')
        per_file_cap = _cfg('max_pdf_mb') * 1024 * 1024
        total_cap = _cfg('max_zip_uncompressed_mb') * 1024 * 1024
        base = work_dir()
        base.mkdir(parents=True, exist_ok=True)

        count, total = 0, 0
        try:
            with zipfile.ZipFile(up) as zf:
                targets = _zip_targets(zf.namelist())
                if not targets:
                    return JsonResponse({'ok': False, 'error': 'no PDFs in the zip'}, status=400)
                if len(targets) > max_pdfs:
                    return JsonResponse(
                        {'ok': False, 'error': 'too many PDFs (limit %d)' % max_pdfs}, status=400)
                for info in zf.infolist():
                    if info.filename not in targets or info.is_dir():
                        continue
                    # Refuse symlinks/special files — safe_path's resolve() would follow them.
                    mode = (info.external_attr >> 16) & 0o170000
                    if mode and mode != 0o100000:
                        return HttpResponseBadRequest('zip contains a non-regular file')
                    folder, fname = targets[info.filename]
                    try:
                        target = safe_path('uploads/' + folder + '/' + fname)
                        parts = target.relative_to(work_dir().resolve()).parts
                    except ValueError:
                        return HttpResponseBadRequest('zip entry escapes the working directory')
                    if not parts or parts[0] != 'uploads':
                        return HttpResponseBadRequest('invalid zip entry path')

                    target.parent.mkdir(parents=True, exist_ok=True)
                    part = target.with_name(target.name + '.part')
                    written = 0
                    with zf.open(info) as src, open(part, 'wb') as dst:
                        chunk = src.read(1024 * 1024)
                        if not chunk.startswith(b'%PDF-'):
                            os.unlink(part)
                            return HttpResponseBadRequest('zip contains a non-PDF (%s)' % fname)
                        while chunk:
                            written += len(chunk)
                            total += len(chunk)
                            if written > per_file_cap:
                                os.unlink(part)
                                return JsonResponse(
                                    {'ok': False, 'error': 'a PDF exceeds the size limit'}, status=413)
                            if total > total_cap:
                                os.unlink(part)
                                return JsonResponse(
                                    {'ok': False, 'error': 'zip decompresses too large'}, status=413)
                            dst.write(chunk)
                            chunk = src.read(1024 * 1024)
                    os.replace(part, target)
                    count += 1
        except zipfile.BadZipFile:
            return HttpResponseBadRequest('corrupt zip file')
        return JsonResponse({'ok': True, 'count': count})


class ScanView(_ImportView):
    """Render a thumbnail per uploaded PDF and return the folders/drawings inventory."""

    def post(self, request):
        return _run_locked('scan')


class BuildView(_ImportView):
    """Persist the wizard's import map, then render images + manifest."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        base = work_dir()
        base.mkdir(parents=True, exist_ok=True)
        max_pdfs = _cfg('max_pdfs')
        if _count_pdfs(base) > max_pdfs:
            return JsonResponse(
                {'ok': False, 'error': 'too many PDFs (limit %d)' % max_pdfs}, status=400)
        (base / 'import-map.json').write_text(json.dumps(data))
        return _run_locked('build')


class ResetView(_ImportView):
    """Clear an import so the user can start over (uploads/images/manifest/map/lock)."""

    def post(self, request):
        base = work_dir()
        for d in ('uploads', 'images'):
            shutil.rmtree(base / d, ignore_errors=True)
        for f in (MANIFEST_NAME, 'import-map.json', 'import-map.stub.json',
                  'import-map.draft.json', 'ocr-job.json', LOCK_NAME):
            try:
                (base / f).unlink()
            except FileNotFoundError:
                pass
        return JsonResponse({'ok': True})


class SaveDraftView(_ImportView):
    """Persist the wizard's in-progress building/floor assignments for smart resume."""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        base = work_dir()
        base.mkdir(parents=True, exist_ok=True)
        (base / 'import-map.draft.json').write_text(json.dumps(data), encoding='utf-8')
        return JsonResponse({'ok': True})


class LoadDraftView(_ImportView):
    """Return the saved wizard draft (buildings/site) if one exists."""

    def get(self, request):
        draft = work_dir() / 'import-map.draft.json'
        if not draft.is_file():
            return JsonResponse({'ok': False})
        try:
            data = json.loads(draft.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            return JsonResponse({'ok': False})
        return JsonResponse({'ok': True, **data})


class PreviewView(_ImportView):
    """Render one uploaded PDF at full scale on demand and stream the PNG back — the wizard's
    high-res preview for the popup and for enlarged/zoomed mapping cards. Permission-gated +
    isolated like the other render endpoints, but it renders a single file to a cache without
    taking the import lock, so opening a preview never 409s against an in-flight scan.

    GET ?path=uploads/<folder>/<file>.pdf"""

    def get(self, request):
        rel = (request.GET.get('path') or '').lstrip('/')
        if not rel.lower().endswith('.pdf'):
            return HttpResponseBadRequest('a .pdf path is required')
        try:
            cache_rel = _ensure_preview(rel)
        except ValueError:
            raise Http404
        if cache_rel is None:
            return JsonResponse({'ok': False, 'error': 'preview render failed'}, status=500)
        return FileResponse(open(work_dir() / cache_rel, 'rb'), content_type='image/png')


class OcrAssignView(_ImportView):
    """Read the floor code off every uploaded drawing so the wizard can auto-assign floors.
    The user drags one rectangle over the floor-designation caption on a sample drawing; this
    OCRs that same normalized region on every drawing and returns the recognized text +
    confidence per drawing (the wizard maps text → floor). An optional ``folder`` restricts the
    pass to a single building — the wizard's per-building "re-read" for an outlier whose title
    block sits in a different spot than the global sample.

    OCR runs in the isolated `ocr.py` subprocess over **already-rendered, trusted PNGs** — the
    only PDF-touching step is reusing the existing `preview` render to make sure each drawing
    has a full-scale PNG. Like `PreviewView` it runs lock-free (it only reads images), so it
    never 409s an in-flight scan.

    POST {"region": {"x": .., "y": .., "w": .., "h": ..}, "folder"?: "<name>"}  (region 0..1)"""

    def post(self, request):
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        region = data.get('region') or {}
        try:
            x, y, w, h = (float(region[k]) for k in ('x', 'y', 'w', 'h'))
        except (KeyError, TypeError, ValueError):
            return HttpResponseBadRequest('region needs numeric x/y/w/h')
        # Allow a hair over 1 for rounding; require a positive, in-bounds box.
        if not (x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= 1.001 and y + h <= 1.001):
            return HttpResponseBadRequest('region must lie within 0..1')
        only_folder = (data.get('folder') or '').strip()   # optional: scope to one building

        base = work_dir().resolve()
        uploads = base / 'uploads'
        if not uploads.is_dir():
            return JsonResponse({'ok': False, 'error': 'no uploads to read'}, status=400)
        max_pdfs = _cfg('max_pdfs')
        if _count_pdfs(base) > max_pdfs:
            return JsonResponse(
                {'ok': False, 'error': 'too many PDFs (limit %d)' % max_pdfs}, status=400)

        images = []
        folders = sorted(p.name for p in uploads.iterdir()
                         if p.is_dir() and p.name != THUMBS_DIRNAME)
        # A `folder` scope is matched against the existing directory names only (never joined
        # with user input), so it adds no traversal surface; an unknown name is a 400.
        if only_folder:
            if only_folder not in folders:
                return JsonResponse({'ok': False, 'error': 'unknown folder'}, status=400)
            folders = [only_folder]
        for folder in folders:
            pdfs = sorted(p for p in (uploads / folder).iterdir()
                          if p.is_file() and p.suffix.lower() == '.pdf')
            for pdf in pdfs:
                cache_rel = _ensure_preview('uploads/%s/%s' % (folder, pdf.name))
                if cache_rel:   # skip a drawing whose preview render failed
                    images.append({'folder': folder, 'stem': pdf.stem, 'image': cache_rel})
        if not images:
            return JsonResponse({'ok': False, 'error': 'nothing to read'}, status=400)

        job = {'region': {'x': x, 'y': y, 'w': w, 'h': h}, 'images': images}
        (base / 'ocr-job.json').write_text(json.dumps(job), encoding='utf-8')
        result = _run_ocr(['--job', 'ocr-job.json'])
        return JsonResponse(result, status=200 if result.get('ok') else 500)


class ManifestView(LoginRequiredMixin, View):
    """Serve the rendered manifest, or the empty stub before any facility is imported.
    Login-gated (same read access as the map), not a public static file."""

    def get(self, request):
        try:
            return JsonResponse(
                json.loads((work_dir() / MANIFEST_NAME).read_text()), safe=False)
        except (OSError, ValueError):
            return JsonResponse(EMPTY_MANIFEST, safe=False)


class MediaView(LoginRequiredMixin, View):
    """Stream a rendered image / thumbnail / uploaded PDF from the working dir. Login-gated
    + traversal-guarded + confined to the `images`/`uploads` subtrees, so floor plans are
    not exposed at a guessable public URL."""

    def get(self, request, path):
        try:
            full = safe_path(path)
            parts = full.relative_to(work_dir().resolve()).parts
        except ValueError:
            raise Http404
        if not parts or parts[0] not in SERVE_ROOTS or not full.is_file():
            raise Http404
        ctype, _ = mimetypes.guess_type(str(full))
        return FileResponse(open(full, 'rb'), content_type=ctype or 'application/octet-stream')
