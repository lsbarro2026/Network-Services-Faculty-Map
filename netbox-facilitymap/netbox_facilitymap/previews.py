"""Server-side helpers for the native room/Location previews.

`FloorRooms` (`template_content.py`) draws a floor's plan image with room polygons
overlaid, and also the rack/device placement markers the editor stored. `floor_sheets`
resolves the floor's tiled sheet geometry (so the whole multi-sheet plan renders, not just
sheet 1), and `placement_markers`/`room_viewbox` build the marker geometry and room-page
crop box — keeping the templates arithmetic-free.

Markers are an **MVP**: a styled box per placement (rack vs device), mirroring the geometry
of `FloorEditor.drawPlacements` (`static/.../floor-editor.js`) but *not* the schematic
glyphs from `DeviceShapes` — those live only in JS. Coordinates are normalized 0..1 over the
floor's *combined* canvas (the tiled grid of sheets); callers scale them by the combined
`w`×`h` that `floor_sheets` returns.
"""

import json

from .models import FacilityMapBlob
from .storage import MANIFEST_NAME, media_url, work_dir

# Default marker footprint (display px) when a placement has no user-set w/h. We don't
# resolve the per-type glyph server-side, so two defaults suffice — a tall rack cabinet vs a
# wider device box (mirrors `DeviceShapes.box` 'rack' and the generic device sizes).
_RACK_BOX = (30, 40)
_DEVICE_BOX = (34, 22)

# Room-embed crop zoom (how much surrounding floor the cropped per-room embed pulls in):
# 1.0 = tight pad-only crop, higher = wider. Editable in-app via the Settings page; these
# bound it on both write (the Settings view) and read (`room_embed_zoom`), the single source
# of truth for the range. `room_viewbox`'s own default param mirrors `ZOOM_DEFAULT`.
ZOOM_MIN = 1.0
ZOOM_MAX = 5.0
ZOOM_DEFAULT = 2.0


def clamp_zoom(value):
    """Coerce `value` to a float within `[ZOOM_MIN, ZOOM_MAX]`, or `ZOOM_DEFAULT` if it
    isn't a finite number. Shared by the Settings view (write) and `room_embed_zoom`
    (read) so a stored value is sane even if edited outside the form (admin/REST)."""
    try:
        z = float(value)
    except (TypeError, ValueError):
        return ZOOM_DEFAULT
    if z != z:  # NaN
        return ZOOM_DEFAULT
    return min(max(z, ZOOM_MIN), ZOOM_MAX)


def room_embed_zoom():
    """The configured room-embed crop zoom, clamped to `[ZOOM_MIN, ZOOM_MAX]`.

    Reads the single `kind='settings'` blob; falls back to `ZOOM_DEFAULT` when the row,
    the key, or a sane value is absent — so the cropped room embed keeps today's behaviour
    until an operator changes it on the Settings page."""
    blob = FacilityMapBlob.objects.filter(kind='settings', key='').first()
    raw = (blob.data or {}).get('room_embed_zoom') if blob else None
    return clamp_zoom(raw) if raw is not None else ZOOM_DEFAULT


def _manifest_pages(floor_key):
    """`[{image, w, h}, ...]` (one per sheet, page order) for `floor_key`, or `[]` if the
    rendered manifest is missing/unreadable or has no such floor. Single-sheet floors still
    return one page; the floor-level `image/w/h` mirror `pages[0]`. Read fresh (no cache) —
    the manifest is a runtime render artifact in the working dir (mirrors `_page_counts`)."""
    try:
        manifest = json.loads((work_dir() / MANIFEST_NAME).read_text())
    except (OSError, ValueError):
        return []
    for building in manifest.get('buildings', []):
        for floor in building.get('floors', []):
            if f"{building['dir']}/{floor['id']}" == floor_key:
                pages = floor.get('pages') or []
                if pages:
                    return pages
                if floor.get('image'):
                    return [{'image': floor['image'],
                             'w': floor.get('w') or 1000, 'h': floor.get('h') or 1000}]
                return []
    return []


def floor_sheets(floor_key):
    """Tiled sheet geometry for a floor, or `None` when it has no rendered plan.

    Mirrors the frontend `Store.floorLayout` (store.js) + `FloorEditor`'s per-sheet image
    placement (floor-editor.js): each sheet sits in one cell of a uniform grid (cell = max
    sheet `w`×`h`); the saved `layouts` blob gives `[col, row]` per page (default = vertical
    stack), and sheets are drawn at `(col*cellW, row*cellH)` sized `cellW`×`cellH`. Returns
    ``{'sheets': [{'url', 'x', 'y', 'w', 'h'}, ...], 'w': W, 'h': H}`` where `W`×`H` is the
    combined canvas the room/placement coords are normalized over (so callers scale by it,
    not by sheet-1 dims). Sheet `url`s go through `media_url` (authenticated, never public).

    `None` is the "is this Location actually a floor?" gate — callers render nothing rather
    than an empty SVG. Falls back to the `annotations` blob's single page-1 image when the
    manifest is unavailable, preserving the pre-tiling behavior for single-sheet floors.
    """
    pages = _manifest_pages(floor_key)
    if not pages:
        blob = FacilityMapBlob.objects.filter(kind='annotations', key='').first()
        floor = ((blob.data or {}).get(floor_key) if blob else None) or {}
        if not floor.get('image'):
            return None
        w, h = floor.get('w') or 1000, floor.get('h') or 1000
        return {'sheets': [{'url': media_url(floor['image']),
                            'x': '0.0', 'y': '0.0', 'w': f'{w:.1f}', 'h': f'{h:.1f}'}],
                'w': w, 'h': h}

    cell_w = max(p['w'] for p in pages)
    cell_h = max(p['h'] for p in pages)
    blob = FacilityMapBlob.objects.filter(kind='layouts', key='').first()
    saved = ((blob.data or {}).get(floor_key) if blob else None) or {}
    grid = saved.get('grid')
    if not (isinstance(grid, list) and len(grid) == len(pages)):
        grid = [[0, i] for i in range(len(pages))]   # default: vertical stack

    sheets, cols, rows = [], 0, 0
    for page, (col, row) in zip(pages, grid):
        cols, rows = max(cols, col + 1), max(rows, row + 1)
        sheets.append({
            'url': media_url(page['image']),
            'x': f'{col * cell_w:.1f}',
            'y': f'{row * cell_h:.1f}',
            'w': f'{cell_w:.1f}',
            'h': f'{cell_h:.1f}',
        })
    return {'sheets': sheets, 'w': cols * cell_w, 'h': rows * cell_h}


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


def room_viewbox(polygon, w, h, pad=0.08, zoom=ZOOM_DEFAULT):
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
