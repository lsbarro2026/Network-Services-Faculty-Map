"""Server-rendered UI pages for the plugin.

`MapView` serves the full-bleed map application shell (the framework-free frontend then
talks back through `frontend_api`); `SettingsView` is the permission-gated page for the
editable plugin settings. Both are login-gated and read NetBox data straight from the ORM —
there is no API token in play. Room/Location page content lives in `template_content.py`,
not here.
"""

from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views import View
from django.views.generic import TemplateView

from .models import FacilityMapBlob
from .previews import (
    ORIENTATION_DEFAULT, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN,
    clamp_embed_size, clamp_orientation, clamp_zoom, room_embed_orientation, room_embed_size,
    room_embed_zoom,
)

# Orientation choices for the Settings <select> (value → human label). The values are the keys
# of `previews.ORIENTATION_ASPECT`; `clamp_orientation` rejects anything else on read/write.
ORIENTATION_CHOICES = [('vertical', 'Vertical (taller)'), ('landscape', 'Landscape (wide)')]


class MapView(LoginRequiredMixin, TemplateView):
    """The full-bleed map application.

    Renders a minimal standalone template (it deliberately does *not* extend
    `base/layout.html`) so the SVG canvas gets the whole viewport, matching the
    standalone tool. Reached via the plugin nav item under NetBox's authenticated
    mount, so `LoginRequiredMixin` is enough — the JSON endpoints in `api.py` carry
    the data access.
    """
    template_name = 'netbox_facilitymap/index.html'

    def get_context_data(self, **kwargs):
        # `?embed=1` (set by the dashboard widget's iframe) drops the SPA chrome and navigation
        # so the map sits cleanly inside a card; `interactive`/`legend` are opt-in relaxations
        # of that static default. See `index.html` and `dashboard.py`.
        context = super().get_context_data(**kwargs)
        context['embed'] = 'embed' in self.request.GET
        context['interactive'] = 'interactive' in self.request.GET
        context['legend'] = 'legend' in self.request.GET
        return context


class SettingsView(LoginRequiredMixin, PermissionRequiredMixin, View):
    """In-app plugin settings (NetBox → Plugins → Facility Map → Settings).

    Persists the editable settings to the single `kind='settings'` blob row. Gated on
    `change_facilitymapblob` to match every other map write — reads of the settings happen
    server-side in `template_content`, never through this page. The settings govern the
    per-room map embed: `room_embed_zoom` (magnification), `room_embed_size` (footprint —
    the box's width as a percent of its column) and `room_embed_orientation` (box shape).
    Each is validated/clamped at this boundary; a value edited outside this form (admin/REST)
    is re-clamped on read by the matching `previews.room_embed_*` helper.
    """
    permission_required = 'netbox_facilitymap.change_facilitymapblob'
    template_name = 'netbox_facilitymap/settings.html'

    def _context(self):
        return {
            'room_embed_zoom': room_embed_zoom(),
            'zoom_min': ZOOM_MIN,
            'zoom_max': ZOOM_MAX,
            'zoom_default': ZOOM_DEFAULT,
            'room_embed_size': room_embed_size(),
            'size_min': SIZE_MIN,
            'size_max': SIZE_MAX,
            'size_default': SIZE_DEFAULT,
            'room_embed_orientation': room_embed_orientation(),
            'orientation_default': ORIENTATION_DEFAULT,
            'orientations': ORIENTATION_CHOICES,
        }

    def get(self, request):
        return render(request, self.template_name, self._context())

    def post(self, request):
        # Both numeric fields must parse as numbers before we clamp; orientation is enum-safe
        # (clamp_orientation falls back to the default for anything unrecognised) so it needs
        # no separate error path.
        raw_zoom = request.POST.get('room_embed_zoom')
        raw_size = request.POST.get('room_embed_size')
        try:
            float(raw_zoom)
        except (TypeError, ValueError):
            messages.error(request, 'Room embed zoom must be a number.')
            return render(request, self.template_name, self._context())
        try:
            float(raw_size)
        except (TypeError, ValueError):
            messages.error(request, 'Room embed size must be a number.')
            return render(request, self.template_name, self._context())

        zoom = clamp_zoom(raw_zoom)
        size = clamp_embed_size(raw_size)
        orientation = clamp_orientation(request.POST.get('room_embed_orientation'))
        blob, _ = FacilityMapBlob.objects.get_or_create(kind='settings', key='')
        data = dict(blob.data or {})
        data['room_embed_zoom'] = zoom
        data['room_embed_size'] = size
        data['room_embed_orientation'] = orientation
        blob.data = data
        blob.save(update_fields=['data', 'updated'])

        messages.success(
            request,
            f'Settings saved — room embed zoom {zoom:g}, size {size:g}%, {orientation}.',
        )
        return redirect(reverse('plugins:netbox_facilitymap:settings'))
