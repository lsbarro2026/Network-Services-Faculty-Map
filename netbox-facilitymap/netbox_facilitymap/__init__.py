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
    version = '1.2.0'
    author = 'Facility Map'
    author_email = ''
    base_url = 'facilitymap'
    # Supported NetBox range. Plugin/menu/restrict()/template-extension APIs shift between
    # 4.x minors, so keep this pinned to the tested span and re-verify when widening it.
    min_version = '4.1.7'
    max_version = '4.6.0'
    # Import/render guardrails (all overridable in PLUGINS_CONFIG). `work_dir=None` means
    # "<MEDIA_ROOT>/netbox_facilitymap" (resolved in storage.py); the caps bound the
    # untrusted-PDF attack surface.
    default_settings = {
        'work_dir': None,        # writable dir for uploads/images/manifest (None → MEDIA_ROOT)
        'max_pdf_mb': 50,        # reject a single uploaded PDF larger than this
        'max_pdfs': 400,         # reject an import with more PDFs than this
        'render_timeout_s': 300,  # kill the render subprocess after this many seconds
        'render_mem_mb': 4096,   # RLIMIT_AS for the render subprocess (POSIX)
    }


config = FacilityMapConfig
