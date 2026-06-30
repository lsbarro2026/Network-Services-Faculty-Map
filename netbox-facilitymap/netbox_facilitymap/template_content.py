"""Render the facility map natively on NetBox pages via `PluginTemplateExtension`s.

`FloorRooms` injects a floor-plan + room-polygon panel on a `dcim.Location` page (below);
`SiteFloors` injects a floor-picker grid on a `dcim.Site` page (mirroring the SPA's building
view). Both read the same runtime render artifacts and degrade to no panel when absent.

`FloorRooms` — floor plan + room polygons on a NetBox Location page.

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

import json
from urllib.parse import quote

from django.urls import reverse
from dcim.models import Location
from netbox.plugins import PluginTemplateExtension

from .models import Room
from .previews import floor_sheets, placement_markers, room_viewbox
from .storage import MANIFEST_NAME, media_url, work_dir


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

        # Deep-link the panel title into the SPA's floor view (`#/f/<dir>/<fid>`). The hash
        # router decodes each segment (`decodeURIComponent` per part, app.js), so encode
        # `dir`/`fid` to match; partition guards a stray key with no '/'.
        dir_part, _, fid_part = floor_key.partition('/')
        map_url = ''
        if dir_part and fid_part:
            map_url = (reverse('plugins:netbox_facilitymap:map')
                       + f'#/f/{quote(dir_part, safe="")}/{quote(fid_part, safe="")}')

        return self.render('netbox_facilitymap/floor_rooms.html', extra_context={
            'vw': w,
            'vh': h,
            'sheets': geom['sheets'],
            'shapes': shapes,
            'markers': markers,
            'viewbox': room_viewbox(crop_to.polygon, w, h) if crop_to else None,
            'map_url': map_url,
        })


class SiteFloors(PluginTemplateExtension):
    """Embed a building's floor picker on its NetBox `dcim.Site` page.

    Here a Site *is* one building, so this mirrors the SPA's building view
    (`App.renderBuilding`): a grid of floor cards — thumbnail, label, a room-count badge and a
    sheet-count badge — one per rendered floor of the building(s) whose manifest `siteSlug`
    matches `site.slug`. Each card links to that floor's NetBox Location page (the Location
    whose `slug` is the floor id), keeping the user in NetBox where `FloorRooms` then draws the
    plan. The manifest is a runtime render artifact, so a missing/unreadable manifest (or a
    Site with no matching rendered building) yields no panel rather than an empty grid.
    """

    models = ['dcim.site']

    def full_width_page(self):
        site = self.context['object']
        request = self.context['request']

        try:
            manifest = json.loads((work_dir() / MANIFEST_NAME).read_text())
        except (OSError, ValueError):
            return ''

        # `siteSlug` could in principle repeat across `dir`s, so filter rather than assume one.
        buildings = [b for b in manifest.get('buildings', [])
                     if b.get('siteSlug') == site.slug]
        if not buildings:
            return ''

        # Floor Locations under this Site, keyed by slug (== floor id), for the card links.
        locs = {l.slug: l for l in
                Location.objects.restrict(request.user, 'view').filter(site=site)}

        cards = []
        for building in buildings:
            for floor in building.get('floors', []):
                loc = locs.get(floor['id'])
                rooms = (Room.objects.restrict(request.user, 'view')
                         .filter(floor_key=f"{site.slug}/{floor['id']}").count())
                cards.append({
                    'image': media_url(floor.get('image')),
                    'label': floor.get('label') or floor['id'],
                    'url': loc.get_absolute_url() if loc else '',
                    'rooms': rooms,
                    'sheets': len(floor.get('pages') or []),
                })
        if not cards:
            return ''

        return self.render('netbox_facilitymap/site_floors.html',
                           extra_context={'cards': cards})


template_extensions = [FloorRooms, SiteFloors]
