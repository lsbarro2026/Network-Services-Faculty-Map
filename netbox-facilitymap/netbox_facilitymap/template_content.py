"""Render the facility map's room polygons natively on a NetBox Location page (Phase 4).

A `PluginTemplateExtension` injects a panel onto the `dcim.Location` detail page. When the
Location is a *floor* — i.e. some `Room.floor_key == "<site.slug>/<location.slug>"` — the
panel draws that floor's plan image overlaid with the room polygons (each linking to its
bound room Location). This is the Phase-4 payoff: rooms drive NetBox-native rendering and
are object-permission scoped via `Room.objects.restrict(...)`.

Room geometry is normalized 0..1 over the floor's *combined* canvas; we scale it by the
floor's stored `w`×`h` and overlay it on the page-1 plan image. That is pixel-exact for
single-sheet floors (nearly all of them). Multi-sheet floors tile
several sheets into one canvas at runtime, which this static panel does not reproduce, so
they show sheet 1 with a note — a documented minimal-scope limitation.
"""

import json

from netbox.plugins import PluginTemplateExtension

from .models import FacilityMapBlob, Room
from .previews import placement_markers, room_viewbox
from .storage import MANIFEST_NAME, media_url, work_dir


def _page_counts():
    """floor_key -> number of drawing sheets, from the rendered manifest (best-effort).

    Used only to flag multi-sheet floors in the panel; absence/parse-failure just means
    no note. Read fresh (no cache) since the manifest is now a runtime render artifact in
    the working dir, not a packaged static file."""
    try:
        manifest = json.loads((work_dir() / MANIFEST_NAME).read_text())
    except (OSError, ValueError):
        return {}
    counts = {}
    for building in manifest.get('buildings', []):
        for floor in building.get('floors', []):
            counts[f"{building['dir']}/{floor['id']}"] = len(floor.get('pages', []) or [])
    return counts


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
        if not rooms:
            return ''  # neither a bound room nor a floor → no panel
        return self._panel(floor_key, rooms, crop_to=None)

    def _panel(self, floor_key, rooms, crop_to):
        """Render the rooms panel for `rooms` over their floor's plan image. `crop_to` (a
        single Room) zooms the SVG `viewBox` to that room's bounding box and drops the
        per-room cross-links; `None` keeps the whole-floor view. `rooms` is already
        `.restrict(...)`-scoped, so its room_ids keep the markers permission-bounded."""
        blob = FacilityMapBlob.objects.filter(kind='annotations', key='').first()
        floor = ((blob.data or {}).get(floor_key) if blob else None) or {}
        w = floor.get('w') or 1000
        h = floor.get('h') or 1000
        image = floor.get('image')

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
            'image_url': media_url(image),
            'shapes': shapes,
            'markers': markers,
            'viewbox': room_viewbox(crop_to.polygon, w, h) if crop_to else None,
            'multisheet': _page_counts().get(floor_key, 0) > 1,
        })


template_extensions = [FloorRooms]
