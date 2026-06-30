"""Render the facility map's floor plan + room polygons natively on a NetBox Location page.

A `PluginTemplateExtension` injects a panel onto the `dcim.Location` detail page. When the
Location is a *floor* — i.e. `floor_key == "<site.slug>/<location.slug>"` has a rendered
plan — the panel draws that floor's plan image (all sheets, tiled) overlaid with any room
polygons (each linking to its bound room Location). Rooms drive NetBox-native rendering and
are object-permission scoped via `Room.objects.restrict(...)`.

Room geometry is normalized 0..1 over the floor's *combined* canvas; `previews.floor_sheets`
resolves that canvas (tiling every sheet at its grid cell, mirroring the editor) and returns
its combined `w`×`h`, which we scale the polygons/markers by. The panel renders even before
any rooms are drawn, and `floor_sheets(...) is None` is the gate for "this Location has no
rendered plan" (so we emit nothing rather than an empty SVG).
"""

from netbox.plugins import PluginTemplateExtension

from .models import Room
from .previews import floor_sheets, placement_markers, room_viewbox


class FloorRooms(PluginTemplateExtension):
    # Plural `models` is the NetBox 4.x API (the legacy singular `model` was removed);
    # verify against the pinned minor (4.1.7–4.6.0) — template-extension APIs shift.
    models = ['dcim.location']

    def right_page(self):
        loc = self.context['object']
        request = self.context['request']

        # This Location *is* a room (bound via Room.location) → show just that room, cropped
        # to its geometry. This is the per-room view the user lands on from a room's page.
        room = (Room.objects.restrict(request.user, 'view')
                .filter(location=loc).select_related('location').first())
        if room:
            return self._panel(room.floor_key, [room], crop_to=room)

        # Otherwise this Location *is a floor* (its slug keys some rooms) → show every room
        # on the floor, uncropped, each linking to its own room Location.
        site = getattr(loc, 'site', None)
        if not site:
            return ''
        floor_key = f'{site.slug}/{loc.slug}'
        rooms = list(
            Room.objects.restrict(request.user, 'view')
            .filter(floor_key=floor_key).select_related('location'))
        # An empty `rooms` is fine — a real floor with no rooms drawn still shows its plan.
        # `_panel` returns '' when `floor_key` has no rendered plan (i.e. not a floor at all).
        return self._panel(floor_key, rooms, crop_to=None)

    def _panel(self, floor_key, rooms, crop_to):
        """Render the panel for `rooms` over their floor's plan image (all sheets, tiled).
        `crop_to` (a single Room) zooms the SVG `viewBox` to that room's bounding box and
        drops the per-room cross-links; `None` keeps the whole-floor view. `rooms` is already
        `.restrict(...)`-scoped, so its room_ids keep the markers permission-bounded.
        Returns '' when `floor_key` has no rendered plan, so non-floor Locations show nothing."""
        geom = floor_sheets(floor_key)
        if not geom:
            return ''
        w, h = geom['w'], geom['h']

        shapes = []
        for room in rooms:
            pts = ' '.join(f'{x * w:.1f},{y * h:.1f}' for x, y in (room.polygon or []))
            if not pts:
                continue
            shapes.append({
                'points': pts,
                'label': room.label or room.room_id,
                # Cross-link to the room's Location only on the floor view; on the room's own
                # page a self-link would be noise.
                'url': '' if crop_to else (room.location.get_absolute_url() if room.location_id else ''),
            })

        markers = placement_markers(floor_key, w, h, {r.room_id for r in rooms})

        return self.render('netbox_facilitymap/floor_rooms.html', extra_context={
            'vw': w,
            'vh': h,
            'sheets': geom['sheets'],
            'shapes': shapes,
            'markers': markers,
            'viewbox': room_viewbox(crop_to.polygon, w, h) if crop_to else None,
        })


template_extensions = [FloorRooms]
