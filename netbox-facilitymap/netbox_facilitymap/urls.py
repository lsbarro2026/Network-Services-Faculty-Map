from django.urls import path

from netbox.views.generic import ObjectChangeLogView

from . import frontend_api, imports, views
from .models import Room

urlpatterns = [
    path('', views.MapView.as_view(), name='map'),

    # Room: NetBox-native UI (Phase 5). The map editor remains authoritative for room
    # geometry; these are the standard list/detail/edit/delete + bulk routes.
    path('rooms/', views.RoomListView.as_view(), name='room_list'),
    path('rooms/add/', views.RoomEditView.as_view(), name='room_add'),
    path('rooms/edit/', views.RoomBulkEditView.as_view(), name='room_bulk_edit'),
    path('rooms/delete/', views.RoomBulkDeleteView.as_view(), name='room_bulk_delete'),
    path('rooms/<int:pk>/', views.RoomView.as_view(), name='room'),
    path('rooms/<int:pk>/edit/', views.RoomEditView.as_view(), name='room_edit'),
    path('rooms/<int:pk>/delete/', views.RoomDeleteView.as_view(), name='room_delete'),
    path('rooms/<int:pk>/changelog/', ObjectChangeLogView.as_view(), {'model': Room},
         name='room_changelog'),

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
    path('api/netbox/racks', frontend_api.NbRacksView.as_view(), name='api-nb-racks'),
    path('api/netbox/devices', frontend_api.NbDevicesView.as_view(), name='api-nb-devices'),

    # PDF import (permission-gated) + authenticated serving of the rendered result.
    path('api/import/upload', imports.UploadView.as_view(), name='api-import-upload'),
    path('api/import/scan', imports.ScanView.as_view(), name='api-import-scan'),
    path('api/import/build', imports.BuildView.as_view(), name='api-import-build'),
    path('api/import/reset', imports.ResetView.as_view(), name='api-import-reset'),
    path('api/manifest', imports.ManifestView.as_view(), name='api-manifest'),
    path('api/media/<path:path>', imports.MediaView.as_view(), name='api-media'),
]
