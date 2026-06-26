from django.urls import path

from netbox.views.generic import ObjectChangeLogView

from . import api, views
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
    path('api/annotations', api.AnnotationsView.as_view(), name='api-annotations'),
    path('api/siteplan', api.BlobView.as_view(kind='siteplan'), name='api-siteplan'),
    path('api/rackplacements', api.BlobView.as_view(kind='placements'), name='api-placements'),
    path('api/pagelayouts', api.BlobView.as_view(kind='layouts'), name='api-layouts'),

    # NetBox reads (replace the token-holding proxy with direct ORM queries,
    # restricted by the requester's object permissions).
    path('api/netbox/rooms', api.NbRoomsView.as_view(), name='api-nb-rooms'),
    path('api/netbox/locations', api.NbLocationsView.as_view(), name='api-nb-locations'),
    path('api/netbox/racks', api.NbRacksView.as_view(), name='api-nb-racks'),
    path('api/netbox/devices', api.NbDevicesView.as_view(), name='api-nb-devices'),
]
