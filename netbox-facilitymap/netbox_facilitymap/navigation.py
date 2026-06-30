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
