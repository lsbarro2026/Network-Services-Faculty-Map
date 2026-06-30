"""Server-side helpers for the native room/Location previews.

`RoomView.get_extra_context` (`views.py`) and `FloorRooms.right_page`
(`template_content.py`) both draw a floor's plan image with room polygons overlaid, and
now also the rack/device placement markers the editor stored. These two helpers build the
marker geometry and the room-page crop box so both call sites render identically and the
templates stay arithmetic-free.

Markers are an **MVP**: a styled box per placement (rack vs device), mirroring the geometry
of `FloorEditor.drawPlacements` (`static/.../floor-editor.js`) but *not* the schematic
glyphs from `DeviceShapes` — those live only in JS. Coordinates are normalized 0..1 over the
floor's *combined* canvas, scaled here by the floor's stored `w`×`h` (so multi-sheet floors
inherit the same sheet-1 offset caveat as the polygon overlay).
"""

from .models import FacilityMapBlob

# Default marker footprint (display px) when a placement has no user-set w/h. We don't
# resolve the per-type glyph server-side, so two defaults suffice — a tall rack cabinet vs a
# wider device box (mirrors `DeviceShapes.box` 'rack' and the generic device sizes).
_RACK_BOX = (30, 40)
_DEVICE_BOX = (34, 22)


def placement_markers(floor_key, w, h, room_ids):
    """Marker dicts for the placements on `floor_key` whose room is in `room_ids`.

    `room_ids` (a set/iterable of `Room.room_id` strings) both selects which rooms' markers
    to draw and object-permission-scopes the result — callers pass only rooms the user may
    view. Each returned dict is pre-computed for direct template rendering: a `transform`
    that centers + rotates the marker, the centered rect attrs, the label, and a baseline
    `y` for the label below the box.
    """
    room_ids = set(room_ids)
    if not room_ids:
        return []
    blob = FacilityMapBlob.objects.filter(kind='placements', key='').first()
    placements = (((blob.data or {}).get(floor_key) if blob else None) or {}).get('placements') or []

    markers = []
    for p in placements:
        if p.get('room') not in room_ids:
            continue
        is_rack = p.get('kind') == 'rack'
        dw, dh = _RACK_BOX if is_rack else _DEVICE_BOX
        wpx = p['w'] * w if p.get('w') is not None else dw
        hpx = p['h'] * h if p.get('h') is not None else dh
        markers.append({
            'transform': f"translate({p.get('x', 0) * w:.1f},{p.get('y', 0) * h:.1f}) "
                         f"rotate({p.get('rot') or 0})",
            'x': f'{-wpx / 2:.1f}',
            'y': f'{-hpx / 2:.1f}',
            'w': f'{wpx:.1f}',
            'h': f'{hpx:.1f}',
            'label': p.get('label') or '',
            'label_y': f'{hpx / 2 + 12:.1f}',
            'is_rack': is_rack,
        })
    return markers


def room_viewbox(polygon, w, h, pad=0.08, zoom=2.0):
    """SVG `viewBox` string cropping a single room's polygon, or None if it has no points.

    Bounding box of the normalized polygon scaled by `w`×`h`, padded by `pad` of the larger
    side (with a small px floor so a tiny room still gets margin), then the whole box is
    scaled about the room's centre by `zoom` to pull surrounding floor into view — `zoom=1`
    is the tight pad-only crop; the default `2` doubles each visible side (~4× the area). The
    box is finally clamped to the floor's `0..w`×`0..h` extent so a room near an edge shows
    real floor rather than blank space past the image (a box larger than the floor on an axis
    just falls back to that axis's full extent). Returned as "minx miny width height"; the
    caller falls back to the full floor view on None.
    """
    if not polygon:
        return None
    xs = [x * w for x, _ in polygon]
    ys = [y * h for _, y in polygon]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    margin = max(max((maxx - minx), (maxy - miny)) * pad, 8)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    bw = min(((maxx - minx) + 2 * margin) * zoom, w)
    bh = min(((maxy - miny) + 2 * margin) * zoom, h)
    bx = min(max(cx - bw / 2, 0), w - bw)
    by = min(max(cy - bh / 2, 0), h - bh)
    return f'{bx:.1f} {by:.1f} {bw:.1f} {bh:.1f}'
