"""Plugin navigation entries.

Two `PluginMenuItem`s under the plugin's menu: **Facility Map** (the full-page map, gated on
`view_facilitymapblob`) and **Settings** (the settings page, gated on the write permission
`change_facilitymapblob` so only editors see it). NetBox auto-discovers `menu_items`.
"""

from netbox.plugins import PluginMenuItem

menu_items = (
    PluginMenuItem(
        link='plugins:netbox_facilitymap:map',
        link_text='Facility Map',
        permissions=['netbox_facilitymap.view_facilitymapblob'],
    ),
    # Editable plugin settings. Gated on the write permission (like the settings view
    # itself), so only users who can change the map see the Settings entry.
    PluginMenuItem(
        link='plugins:netbox_facilitymap:settings',
        link_text='Settings',
        permissions=['netbox_facilitymap.change_facilitymapblob'],
    ),
)
