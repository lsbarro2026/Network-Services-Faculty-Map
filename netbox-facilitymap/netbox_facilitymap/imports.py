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


def _run_preprocess(mode):
    """Spawn `preprocess.py <mode> --base <workdir>` and shape its result. Invoked by file
    path (not `-m`) so the child stays stdlib + pypdfium2 only — no Django in-process."""
    base = work_dir()
    base.mkdir(parents=True, exist_ok=True)
    script = str(Path(__file__).resolve().parent / 'preprocess.py')
    timeout = _cfg('render_timeout_s')
    kwargs = {}
    if os.name == 'posix':
        kwargs['preexec_fn'] = _rlimits(timeout, _cfg('render_mem_mb'))
    try:
        proc = subprocess.run(
            [sys.executable, script, mode, '--base', str(base)],
            capture_output=True, text=True, cwd=str(base), timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'render timed out after %ss' % timeout}
    if proc.returncode != 0:
        return {'ok': False,
                'error': (proc.stderr or proc.stdout).strip()[:2000] or 'preprocess failed'}
    if mode == 'scan':
        try:
            return {'ok': True, **json.loads(proc.stdout or '{}')}
        except json.JSONDecodeError:
            return {'ok': False, 'error': (proc.stderr or proc.stdout)[:1000]}
    return {'ok': True, 'log': proc.stderr.strip()[:2000]}


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
        for f in (MANIFEST_NAME, 'import-map.json', 'import-map.stub.json', LOCK_NAME):
            try:
                (base / f).unlink()
            except FileNotFoundError:
                pass
        return JsonResponse({'ok': True})


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
