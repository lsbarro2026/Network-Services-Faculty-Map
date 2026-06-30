"""Global-search index for `Room` (Phase 5). NetBox auto-discovers `search.py`."""

from netbox.search import SearchIndex, register_search

from .models import Room


@register_search
class RoomIndex(SearchIndex):
    model = Room
    fields = (
        ('label', 100),
        ('room_id', 200),
        ('floor_key', 500),
    )
    display_attrs = ('floor_key', 'location')
