"""Facility Map — NetBox plugin.

Repackages the standalone room-annotation tool as an installable NetBox 4.x plugin.
The framework-free frontend is reused (verbatim except ~20 URL literals) from
`tool/web/`; the standalone server's JSON files become `FacilityMapBlob` rows and its
NetBox proxy becomes direct ORM reads. The plugin ships with **no facility content** —
the floor images + `manifest.json` are an operator-supplied build artifact (see
DESIGN.md §7). See DESIGN.md for the full design.
"""

from netbox.plugins import PluginConfig


class FacilityMapConfig(PluginConfig):
    name = 'netbox_facilitymap'
    verbose_name = 'Facility Map'
    description = 'Navigable siteplan → building → floor → room map linked to NetBox Locations'
    version = '1.1.0'
    author = 'Facility Map'
    author_email = ''
    base_url = 'facilitymap'
    # Supported NetBox range. Plugin/menu/restrict()/template-extension APIs shift between
    # 4.x minors, so keep this pinned to the tested span and re-verify when widening it.
    min_version = '4.1.7'
    max_version = '4.6.0'
    default_settings = {}


config = FacilityMapConfig
