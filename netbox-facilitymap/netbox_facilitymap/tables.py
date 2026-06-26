"""Tabular list rendering for `Room` (Phase 5)."""

import django_tables2 as tables

from netbox.tables import NetBoxTable, columns

from .models import Room


class RoomTable(NetBoxTable):
    label = tables.Column(linkify=True)
    location = tables.Column(linkify=True)
    datacenter = columns.BooleanColumn()
    tags = columns.TagColumn(url_name='plugins:netbox_facilitymap:room_list')

    class Meta(NetBoxTable.Meta):
        model = Room
        fields = (
            'pk', 'id', 'label', 'floor_key', 'room_id', 'location', 'datacenter',
            'tags', 'created', 'last_updated',
        )
        default_columns = ('label', 'floor_key', 'location', 'datacenter')
