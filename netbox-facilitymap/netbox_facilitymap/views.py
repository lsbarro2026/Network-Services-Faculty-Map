from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import TemplateView

from netbox.views import generic

from .filtersets import RoomFilterSet
from .forms import RoomBulkEditForm, RoomFilterForm, RoomForm
from .models import FacilityMapBlob, Room
from .previews import placement_markers, room_viewbox
from .storage import media_url as _media_url
from .tables import RoomTable


class MapView(LoginRequiredMixin, TemplateView):
    """The full-bleed map application.

    Renders a minimal standalone template (it deliberately does *not* extend
    `base/layout.html`) so the SVG canvas gets the whole viewport, matching the
    standalone tool. Reached via the plugin nav item under NetBox's authenticated
    mount, so `LoginRequiredMixin` is enough — the JSON endpoints in `api.py` carry
    the data access.
    """
    template_name = 'netbox_facilitymap/index.html'


# --- Room: NetBox-native UI (Phase 5) ----------------------------------------------
# The map editor stays authoritative for room *geometry* (a `sync_rooms` POST rewrites
# polygons); these views add list/detail/edit/delete + the bulk ops over the same rows,
# scoped by object permission via NetBox's generic views.

class RoomListView(generic.ObjectListView):
    queryset = Room.objects.prefetch_related('location', 'tags')
    table = RoomTable
    filterset = RoomFilterSet
    filterset_form = RoomFilterForm


class RoomView(generic.ObjectView):
    queryset = Room.objects.prefetch_related('location', 'tags')

    def get_extra_context(self, request, instance):
        """A floor-plan preview cropped to this room, mirroring `template_content.FloorRooms`:
        the normalized polygon + this room's rack/device markers are scaled by the floor's
        stored `w`×`h` (from the annotations blob) and drawn over the page-1 plan image, with
        the SVG `viewBox` cropped to the room's bounding box (`points`/markers stay in
        full-floor coordinates; only the viewBox zooms in)."""
        blob = FacilityMapBlob.objects.filter(kind='annotations', key='').first()
        floor = ((blob.data or {}).get(instance.floor_key) if blob else None) or {}
        w = floor.get('w') or 1000
        h = floor.get('h') or 1000
        image = floor.get('image')
        points = ' '.join(f'{x * w:.1f},{y * h:.1f}' for x, y in (instance.polygon or []))
        return {
            'vw': w,
            'vh': h,
            'image_url': _media_url(image),
            'points': points,
            'viewbox': room_viewbox(instance.polygon, w, h),
            'markers': placement_markers(instance.floor_key, w, h, {instance.room_id}),
        }


class RoomEditView(generic.ObjectEditView):
    queryset = Room.objects.all()
    form = RoomForm


class RoomDeleteView(generic.ObjectDeleteView):
    queryset = Room.objects.all()


class RoomBulkEditView(generic.BulkEditView):
    queryset = Room.objects.prefetch_related('location', 'tags')
    filterset = RoomFilterSet
    table = RoomTable
    form = RoomBulkEditForm


class RoomBulkDeleteView(generic.BulkDeleteView):
    queryset = Room.objects.prefetch_related('location', 'tags')
    filterset = RoomFilterSet
    table = RoomTable
