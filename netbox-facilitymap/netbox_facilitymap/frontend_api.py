"""JSON endpoints for the map frontend.

These replace the standalone `server.py` routes. They are plain Django views (not
DRF) mounted *under the plugin's page mount* (`/plugins/facilitymap/api/...`), so they
ride NetBox's session auth and Django's CSRF middleware directly — the frontend posts
its session CSRF token in the `X-CSRFToken` header (see `Api.post` in `lib.js`). The
contract (paths, request/response shapes) is identical to the old server so the
framework-free frontend is reused unchanged.

Three families:
  * Annotations — `AnnotationsView`: room polygons are the relational `Room` model
    (Phase 4), while each floor's `image`/`w`/`h`/`arrows` stay in the `annotations`
    blob. GET composes the whole-document shape (blob floors + `Room` rows merged back
    in); POST decomposes it (rooms → `Room` rows, the rest → the blob). The frontend
    round-trips byte-for-byte and is unchanged.
  * Blob persistence — `siteplan` / `placements` / `layouts`: GET returns the whole
    stored document (or its default), POST upserts it. One `FacilityMapBlob` row per kind.
  * NetBox reads — `netbox/rooms`, `netbox/locations`, `netbox/racks`,
    `netbox/devices`: direct ORM queries over `dcim` models, restricted by the
    requester's object permissions, replacing the token-holding proxy. There is no
    longer a persisted `rackcache` — racks/devices are fetched live per room.
"""

import json

from django.contrib.auth.mixins import LoginRequiredMixin
from django.db import transaction
from django.http import HttpResponseBadRequest, HttpResponseForbidden, JsonResponse
from django.views import View

from dcim.models import Device, Location, Rack, Site

from .models import FacilityMapBlob, Room

# Saving any editor document mutates the shared facility map, so the write endpoints are
# gated on this model permission (admin-grantable) rather than merely "is logged in" —
# reads stay login-only so any authenticated user can view the map.
EDIT_PERM = 'netbox_facilitymap.change_facilitymapblob'

# kind -> the default document the standalone server returned when a file was absent.
# (`annotations` is served by AnnotationsView, not BlobView, so it isn't listed here.)
BLOB_DEFAULTS = {
    'siteplan': lambda: {'hotspots': []},
    'placements': dict,
    'layouts': dict,
}


class BlobView(LoginRequiredMixin, View):
    """GET the stored document for one `kind` (or its default); POST upserts it whole."""
    kind = None

    def get(self, request):
        row = FacilityMapBlob.objects.filter(kind=self.kind, key='').first()
        return JsonResponse(row.data if row else BLOB_DEFAULTS[self.kind](), safe=False)

    def post(self, request):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        try:
            data = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        FacilityMapBlob.objects.update_or_create(
            kind=self.kind, key='', defaults={'data': data})
        return JsonResponse({'ok': True})


def _trim(loc, request):
    """Shape a Location for the frontend (mirrors `NetBoxProxy._trim`). `url` is made
    absolute against the current host so a room click opens the Location page."""
    return {
        'id': loc.pk,
        'name': loc.name,
        'slug': loc.slug,
        'url': request.build_absolute_uri(loc.get_absolute_url()),
        'depth': getattr(loc, 'level', 0),
    }


# --- Annotations: the relational Room model behind the whole-document blob shape ----

def _serialize_room(room, request):
    """Shape a `Room` row back into the frontend's room object (the inverse of the
    editor's room record). `location` is re-derived from the FK via `_trim`, so the
    name/slug/url are always current (no stale denormalized snapshot)."""
    return {
        'id': room.room_id,
        'label': room.label,
        'polygon': room.polygon,
        'datacenter': room.datacenter,
        'location': _trim(room.location, request) if room.location_id else None,
    }


def _split_annotations(doc):
    """Pure: separate a whole annotations document into (blob_data, rooms_by_floor).

    `blob_data` keeps each floor's `image`/`w`/`h`/`arrows` (everything but `rooms`);
    `rooms_by_floor` maps `floor_key -> [room dict, ...]`. Used by POST and the importer."""
    blob, rooms_by_floor = {}, {}
    for fkey, floor in (doc or {}).items():
        floor = dict(floor or {})
        rooms_by_floor[fkey] = floor.pop('rooms', None) or []
        blob[fkey] = floor
    return blob, rooms_by_floor


def compose_annotations(blob_data, user, request):
    """Rebuild the whole-document annotations shape: blob floors with their `Room` rows
    (visible to `user`) merged back in under each floor's `rooms`."""
    doc = {fkey: dict(floor) for fkey, floor in (blob_data or {}).items()}
    by_floor = {}
    for room in Room.objects.restrict(user, 'view').select_related('location'):
        by_floor.setdefault(room.floor_key, []).append(room)
    for fkey, rooms in by_floor.items():
        doc.setdefault(fkey, {})
        doc[fkey]['rooms'] = [_serialize_room(r, request) for r in rooms]
    # A blob floor with no rooms still advertises an empty list (matches the legacy shape).
    for floor in doc.values():
        floor.setdefault('rooms', [])
    return doc


def sync_rooms(rooms_by_floor, user=None):
    """Upsert `Room` rows from a decomposed annotations document and delete the rest.
    The POST is authoritative for the whole document, so rooms absent from a floor — and
    rooms of floors absent entirely — are removed.

    When `user` is given (the editor POST), deletes are scoped to rooms that user may
    delete (`restrict(user, 'delete')`), so a save never silently removes rooms the caller
    has no permission over. `user=None` (the trusted `facilitymap_import` command) keeps
    the unrestricted behaviour."""
    del_qs = Room.objects.restrict(user, 'delete') if user is not None else Room.objects.all()
    for fkey, rooms in rooms_by_floor.items():
        seen = []
        for room in rooms:
            rid = room.get('id')
            if not rid:
                continue
            seen.append(rid)
            loc = room.get('location') or {}
            loc_id = loc.get('id')
            if loc_id and not Location.objects.filter(pk=loc_id).exists():
                loc_id = None
            Room.objects.update_or_create(
                floor_key=fkey, room_id=rid,
                defaults={
                    'label': room.get('label') or '',
                    'polygon': room.get('polygon') or [],
                    'datacenter': bool(room.get('datacenter')),
                    'location_id': loc_id,
                })
        del_qs.filter(floor_key=fkey).exclude(room_id__in=seen).delete()
    del_qs.exclude(floor_key__in=list(rooms_by_floor.keys())).delete()


class AnnotationsView(LoginRequiredMixin, View):
    """GET composes the whole annotations document (blob floors + `Room` rows); POST
    decomposes it (rooms → `Room` rows, the rest → the `annotations` blob). Same path
    and request/response shape as the standalone server, so the frontend is unchanged."""

    def get(self, request):
        row = FacilityMapBlob.objects.filter(kind='annotations', key='').first()
        return JsonResponse(
            compose_annotations(row.data if row else {}, request.user, request), safe=False)

    def post(self, request):
        if not request.user.has_perm(EDIT_PERM):
            return HttpResponseForbidden('permission denied')
        try:
            doc = json.loads(request.body or b'{}')
        except json.JSONDecodeError:
            return HttpResponseBadRequest('invalid JSON')
        blob, rooms_by_floor = _split_annotations(doc)
        with transaction.atomic():
            sync_rooms(rooms_by_floor, request.user)
            FacilityMapBlob.objects.update_or_create(
                kind='annotations', key='', defaults={'data': blob})
        return JsonResponse({'ok': True})


class NbRoomsView(LoginRequiredMixin, View):
    """Rooms = child Locations of the floor Location; falls back to all Locations under
    the site when the floor slug has no Location. ORM equivalent of `NetBoxProxy.rooms`."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        floor_slug = request.GET.get('floor', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'error': 'site not found: ' + site_slug, 'rooms': []})
        locs = Location.objects.restrict(request.user, 'view').filter(site=site)
        floor = locs.filter(slug=floor_slug).first() if floor_slug else None
        if floor:
            rooms = list(locs.filter(parent=floor))
            if rooms:
                return JsonResponse({'floor': _trim(floor, request),
                                     'rooms': [_trim(x, request) for x in rooms]})
            return JsonResponse({'floor': _trim(floor, request),
                                 'rooms': [_trim(x, request) for x in locs]})
        return JsonResponse({'floor': None, 'rooms': [_trim(x, request) for x in locs]})


class NbLocationsView(LoginRequiredMixin, View):
    """Free-text Location search within a site. ORM equivalent of `NetBoxProxy.locations`."""

    def get(self, request):
        site_slug = request.GET.get('site', '')
        q = request.GET.get('q', '')
        site = Site.objects.filter(slug=site_slug).first()
        if not site:
            return JsonResponse({'rooms': []})
        qs = Location.objects.restrict(request.user, 'view').filter(site=site)
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'rooms': [_trim(x, request) for x in qs[:200]]})


class NbSitesView(LoginRequiredMixin, View):
    """Free-text Site search. The import wizard binds each uploaded building folder to a
    NetBox Site (a "building"), so its slug — which becomes the manifest `siteSlug` —
    matches a real Site and later room/location lookups resolve."""

    def get(self, request):
        q = request.GET.get('q', '')
        qs = Site.objects.restrict(request.user, 'view')
        if q:
            qs = qs.filter(name__icontains=q)
        return JsonResponse({'sites': [{
            'id': s.pk,
            'name': s.name,
            'slug': s.slug,
            'url': request.build_absolute_uri(s.get_absolute_url()),
        } for s in qs[:200]]})


def _trim_rack(rack, request):
    """Shape a Rack for the frontend (mirrors `NetBoxProxy._trim_rack`)."""
    return {
        'id': rack.pk,
        'name': rack.name,
        'url': request.build_absolute_uri(rack.get_absolute_url()),
        'u_height': rack.u_height,
    }


def _trim_device(device, request):
    """Shape a Device for the frontend (mirrors `NetBoxProxy._trim_device`). The
    marker glyph is keyed off `role.slug`/`name` (device-name fallback), so keep role
    populated; a device without a role degrades gracefully to the name heuristic."""
    role = device.role
    dtype = device.device_type
    return {
        'id': device.pk,
        'name': device.name or str(device),
        'url': request.build_absolute_uri(device.get_absolute_url()),
        'role': {'slug': role.slug, 'name': role.name} if role else None,
        'device_type': {'model': dtype.model, 'u_height': dtype.u_height} if dtype else None,
    }


class NbRacksView(LoginRequiredMixin, View):
    """Racks directly in a Location (the room). ORM equivalent of `NetBoxProxy.racks`."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'racks': []})
        qs = Rack.objects.restrict(request.user, 'view').filter(location_id=loc)
        return JsonResponse({'racks': [_trim_rack(x, request) for x in qs]})


class NbDevicesView(LoginRequiredMixin, View):
    """Devices assigned to a Location but not mounted in any rack (racked devices are
    shown under their rack). ORM equivalent of `NetBoxProxy.unracked_devices`."""

    def get(self, request):
        loc = request.GET.get('location', '')
        if not loc:
            return JsonResponse({'devices': []})
        qs = Device.objects.restrict(request.user, 'view').filter(
            location_id=loc, rack__isnull=True)
        return JsonResponse({'devices': [_trim_device(x, request) for x in qs]})
