from netbox.plugins import PluginMenuItem

menu_items = (
    PluginMenuItem(
        link='plugins:netbox_facilitymap:map',
        link_text='Facility Map',
        permissions=['netbox_facilitymap.view_facilitymapblob'],
    ),
)
