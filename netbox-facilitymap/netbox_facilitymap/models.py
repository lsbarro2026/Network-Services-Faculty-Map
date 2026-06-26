from django.db import models
from django.urls import reverse

from netbox.models import NetBoxModel


class FacilityMapBlob(models.Model):
    """One JSON document of editor state.

    The standalone tool persisted its data as a handful of flat JSON files, and the
    frontend GETs/POSTs each one as a *whole document* (e.g. `Store.saveAnnotations`
    posts the entire annotations dict). So one row per `kind` (with `key=''`) holds
    the complete dict and stays byte-compatible with `siteplan.json` /
    `rackplacements.json` / `pagelayouts.json`.

    Since Phase 4 the `annotations` blob holds only each floor's `image`/`w`/`h`/`arrows`:
    room polygons were promoted to the relational `Room` model below. The
    `AnnotationsView` recomposes the whole-document shape on GET, so the frontend and
    JSON export are unchanged. The `key` column remains reserved for a future per-floor
    shard of the remaining blob state.
    """

    KIND_CHOICES = (
        ('annotations', 'Room annotations'),
        ('siteplan', 'Siteplan hotspots'),
        ('placements', 'Rack/device placements'),
        ('layouts', 'Sheet layouts'),
    )

    kind = models.CharField(max_length=20, choices=KIND_CHOICES)
    key = models.CharField(max_length=120, blank=True, default='')
    data = models.JSONField(default=dict)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['kind', 'key']
        unique_together = [('kind', 'key')]

    def __str__(self):
        return f'{self.kind}/{self.key}' if self.key else self.kind


class Room(NetBoxModel):
    """A floor-plan room polygon, promoted out of the `annotations` blob (Phase 4).

    Each row is one room the editor drew on a floor: its normalized polygon plus the
    `dcim.Location` it is bound to. Promoting the polygon to a first-class
    `NetBoxModel` (rather than leaving it in the JSON blob) is what lets NetBox render
    rooms on a Location page, query them relationally, and — via `.restrict()` — scope
    them by object permission. Arrows / hotspots / placements / layouts stay blobs
    (editor-internal, low query value).

    `Room` is the source of truth for room geometry: `AnnotationsView` composes these
    rows back into the whole-document annotations shape on GET and decomposes a POSTed
    document into rows, so the framework-free frontend round-trips byte-for-byte.
    """

    # "<dir>/<floorId>" — the annotations document key (== "<site.slug>/<floorLocation.slug>").
    floor_key = models.CharField(max_length=120)
    # The editor's per-room uid (e.g. "rabc1234"); stable identity for upsert within a floor.
    room_id = models.CharField(max_length=40)
    label = models.CharField(max_length=200, blank=True)
    polygon = models.JSONField(default=list)  # [[nx, ny], ...] normalized 0..1
    datacenter = models.BooleanField(default=False)
    # The bound *room* Location (a child of the floor Location). Null = unbound.
    location = models.ForeignKey(
        'dcim.Location', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='+')

    class Meta:
        ordering = ['floor_key', 'label']
        unique_together = [('floor_key', 'room_id')]

    def __str__(self):
        return self.label or self.room_id

    def get_absolute_url(self):
        # Phase 5 added a native detail view; link to it (list/table/search all rely on it).
        return reverse('plugins:netbox_facilitymap:room', args=[self.pk])
