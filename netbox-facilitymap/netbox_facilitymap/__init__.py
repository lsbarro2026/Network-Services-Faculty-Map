"""Facility Map — NetBox plugin.

A self-contained NetBox 4.x plugin: import a facility's floor-plan PDFs in-app, draw and
bind room polygons, and render the same map natively inside NetBox. The framework-free
frontend lives under `static/`; editor JSON state becomes `FacilityMapBlob` rows and room
polygons the relational `Room` model; NetBox data is read straight from the ORM. PDF
import (`preprocess.py` + the `api/import/*` endpoints) rasterizes uploads into floor
images under `MEDIA_ROOT`, served back through authenticated views. See DESIGN.md for the
full design.
"""

from netbox.plugins import PluginConfig


class FacilityMapConfig(PluginConfig):
    name = 'netbox_facilitymap'
    verbose_name = 'Facility Map'
    description = 'Navigable siteplan → building → floor → room map linked to NetBox Locations'
    version = '1.41.0'
    author = 'Liam Sbarro'
    author_email = 'ljs.social2005@gmail.com'
    base_url = 'facilitymap'
    # Supported NetBox range. Plugin/menu/restrict()/template-extension APIs shift between
    # 4.x minors, so keep this pinned to the tested span and re-verify when widening it.
    min_version = '4.1.7'
    max_version = '4.6.99'  # whole 4.6.x patch line; only minors shift the APIs we depend on
    # Import/render guardrails (all overridable in PLUGINS_CONFIG). `work_dir=None` means
    # "<MEDIA_ROOT>/netbox_facilitymap" (resolved in storage.py); the caps bound the
    # untrusted-PDF attack surface.
    default_settings = {
        'work_dir': None,        # writable dir for uploads/images/manifest (None → MEDIA_ROOT)
        'max_pdf_mb': 50,        # reject a single uploaded PDF larger than this
        'max_pdfs': 400,         # reject an import with more PDFs than this
        'max_zip_mb': 200,       # reject a single uploaded .zip larger than this
        'max_zip_uncompressed_mb': 2048,  # cumulative decompressed cap (zip-bomb guard)
        'render_timeout_s': 300,  # kill the render subprocess after this many seconds
        'render_mem_mb': 4096,   # RLIMIT_AS for the render subprocess (POSIX)
        # Opt-in backups (run `facilitymap_backup`/`facilitymap_restore`; nothing runs on its
        # own). `backup_dir=None` means "<MEDIA_ROOT>/facilitymap-backups" (resolved in
        # backup.py); `backup_max_mb` caps the dir, FIFO-pruned oldest-first on every backup.
        'backup_dir': None,      # writable dir for backup .tar.gz files (None → MEDIA_ROOT sibling)
        'backup_max_mb': 1024,   # prune oldest backups once the dir exceeds this (newest always kept)
    }

    def ready(self):
        # NetBox auto-discovers navigation/template_content but NOT dashboard widgets, so
        # import the module here to run its `@register_widget` decorator at app-ready.
        super().ready()
        from . import dashboard  # noqa: F401


config = FacilityMapConfig
