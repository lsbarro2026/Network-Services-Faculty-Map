from netbox.plugins import PluginMenuButton, PluginMenuItem

menu_items = (
    PluginMenuItem(
        link='plugins:netbox_facilitymap:map',
        link_text='Facility Map',
        permissions=['netbox_facilitymap.view_facilitymapblob'],
    ),
    PluginMenuItem(
        link='plugins:netbox_facilitymap:room_list',
        link_text='Rooms',
        permissions=['netbox_facilitymap.view_room'],
        buttons=(
            PluginMenuButton(
                link='plugins:netbox_facilitymap:room_add',
                title='Add',
                icon_class='mdi mdi-plus-thick',
                permissions=['netbox_facilitymap.add_room'],
            ),
        ),
    ),
)
