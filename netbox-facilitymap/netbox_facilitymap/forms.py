"""Forms for `Room` (Phase 5): edit, filter, and bulk-edit.

`polygon` is intentionally not a form field — geometry is owned by the map editor (a POST
from the editor's `sync_rooms` is authoritative for it; see the roadmap "last-writer-wins"
note). Native editing here targets the metadata that is useful between editor sessions:
`label`, `location` binding, `datacenter`, and the `NetBoxModel` extras (`tags`).

NetBox form base classes / field imports shift between 4.x minors — verify against the
pinned range (`4.1.7`–`4.6.0`) if a path fails to import.
"""

from django import forms

from netbox.forms import NetBoxModelForm, NetBoxModelFilterSetForm, NetBoxModelBulkEditForm
from utilities.forms.fields import DynamicModelChoiceField, DynamicModelMultipleChoiceField, TagFilterField
from utilities.forms.constants import BOOLEAN_WITH_BLANK_CHOICES

from dcim.models import Location

from .models import Room


class RoomForm(NetBoxModelForm):
    location = DynamicModelChoiceField(queryset=Location.objects.all(), required=False)

    class Meta:
        model = Room
        fields = ('floor_key', 'room_id', 'label', 'location', 'datacenter', 'tags')


class RoomFilterForm(NetBoxModelFilterSetForm):
    model = Room
    floor_key = forms.CharField(required=False)
    location_id = DynamicModelMultipleChoiceField(
        queryset=Location.objects.all(), required=False, label='Location')
    datacenter = forms.NullBooleanField(
        required=False, widget=forms.Select(choices=BOOLEAN_WITH_BLANK_CHOICES))
    tag = TagFilterField(model)


class RoomBulkEditForm(NetBoxModelBulkEditForm):
    model = Room
    label = forms.CharField(max_length=200, required=False)
    location = DynamicModelChoiceField(queryset=Location.objects.all(), required=False)
    datacenter = forms.NullBooleanField(
        required=False, widget=forms.Select(choices=BOOLEAN_WITH_BLANK_CHOICES))

    nullable_fields = ('location',)
