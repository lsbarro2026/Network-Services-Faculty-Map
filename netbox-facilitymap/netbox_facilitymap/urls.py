from django.urls import path

from . import frontend_api, imports, views

urlpatterns = [
    path('', views.MapView.as_view(), name='map'),

    # Editor data (blob persistence) — same logical paths as the standalone server,
    # rooted here at /plugins/facilitymap/api/ (see window.MAP.api in index.html).
    path('api/annotations', frontend_api.AnnotationsView.as_view(), name='api-annotations'),
    path('api/siteplan', frontend_api.BlobView.as_view(kind='siteplan'), name='api-siteplan'),
    path('api/rackplacements', frontend_api.BlobView.as_view(kind='placements'), name='api-placements'),
    path('api/pagelayouts', frontend_api.BlobView.as_view(kind='layouts'), name='api-layouts'),

    # NetBox reads (replace the token-holding proxy with direct ORM queries,
    # restricted by the requester's object permissions).
    path('api/netbox/rooms', frontend_api.NbRoomsView.as_view(), name='api-nb-rooms'),
    path('api/netbox/locations', frontend_api.NbLocationsView.as_view(), name='api-nb-locations'),
    path('api/netbox/sites', frontend_api.NbSitesView.as_view(), name='api-nb-sites'),
    path('api/netbox/racks', frontend_api.NbRacksView.as_view(), name='api-nb-racks'),
    path('api/netbox/devices', frontend_api.NbDevicesView.as_view(), name='api-nb-devices'),

    # PDF import (permission-gated) + authenticated serving of the rendered result.
    path('api/import/upload', imports.UploadView.as_view(), name='api-import-upload'),
    path('api/import/upload-zip', imports.UploadZipView.as_view(), name='api-import-upload-zip'),
    path('api/import/scan', imports.ScanView.as_view(), name='api-import-scan'),
    path('api/import/preview', imports.PreviewView.as_view(), name='api-import-preview'),
    path('api/import/build', imports.BuildView.as_view(), name='api-import-build'),
    path('api/import/reset', imports.ResetView.as_view(), name='api-import-reset'),
    path('api/import/save-draft', imports.SaveDraftView.as_view(), name='api-import-save-draft'),
    path('api/import/load-draft', imports.LoadDraftView.as_view(), name='api-import-load-draft'),
    path('api/manifest', imports.ManifestView.as_view(), name='api-manifest'),
    path('api/media/<path:path>', imports.MediaView.as_view(), name='api-media'),
]
