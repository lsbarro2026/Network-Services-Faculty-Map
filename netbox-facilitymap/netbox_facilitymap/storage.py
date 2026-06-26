"""Where the PDF-import pipeline keeps its files, and how to read them back safely.

The import wizard uploads PDFs and the render subprocess writes `images/` + `manifest.json`
into a single **working directory**. Unlike the package's `static/` tree (read-only at
runtime), this dir must be writable, so it lives under NetBox's `MEDIA_ROOT` by default —
`<MEDIA_ROOT>/netbox_facilitymap/` — overridable via the `work_dir` plugin setting.

`safe_path()` is the one traversal guard every file-serving / file-writing caller goes
through: it resolves a caller-supplied relative path *inside* the working dir and refuses
anything that escapes it (symlinks included, via `resolve()`).
"""

from pathlib import Path

from django.conf import settings
from django.urls import reverse

from netbox.plugins import get_plugin_config

#: filename of the rendered manifest within the working dir.
MANIFEST_NAME = 'manifest.json'
#: the manifest served before any facility has been imported.
EMPTY_MANIFEST = {'siteplan': None, 'buildings': []}
#: top-level subdirs of the working dir that MediaView is allowed to serve from.
SERVE_ROOTS = ('images', 'uploads')


def work_dir():
    """Absolute path to the import working dir (created lazily by callers that write)."""
    configured = get_plugin_config('netbox_facilitymap', 'work_dir')
    base = Path(configured) if configured else Path(settings.MEDIA_ROOT) / 'netbox_facilitymap'
    return base


def safe_path(rel):
    """Resolve ``rel`` inside the working dir, rejecting traversal. Raises ValueError if
    the resolved path escapes the working dir. Returns an absolute ``Path`` (which may not
    exist yet — callers check)."""
    base = work_dir().resolve()
    full = (base / rel).resolve()
    if full != base and base not in full.parents:
        raise ValueError('path escapes the working directory')
    return full


def media_url(image):
    """Authenticated URL for a working-dir-relative image path (e.g. the manifest's
    ``images/<slug>/<id>.png``). Empty string when there is no image. Used by the
    server-rendered Location pages; the SPA builds the same URL from ``window.MAP.media``."""
    if not image:
        return ''
    return reverse('plugins:netbox_facilitymap:api-media', kwargs={'path': image})
