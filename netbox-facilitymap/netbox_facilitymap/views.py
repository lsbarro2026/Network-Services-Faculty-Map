from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.shortcuts import redirect, render
from django.urls import reverse
from django.views import View
from django.views.generic import TemplateView

from .models import FacilityMapBlob
from .previews import ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, clamp_zoom, room_embed_zoom


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
    `change_facilitymapblob` to match every other map write — reads of the setting happen
    server-side in `template_content`, never through this page. The first (and currently
    only) setting is `room_embed_zoom`, validated/clamped at this boundary; a value edited
    outside this form (admin/REST) is re-clamped on read by `previews.room_embed_zoom`.
    """
    permission_required = 'netbox_facilitymap.change_facilitymapblob'
    template_name = 'netbox_facilitymap/settings.html'

    def _context(self, zoom):
        return {
            'room_embed_zoom': zoom,
            'zoom_min': ZOOM_MIN,
            'zoom_max': ZOOM_MAX,
            'zoom_default': ZOOM_DEFAULT,
        }

    def get(self, request):
        return render(request, self.template_name, self._context(room_embed_zoom()))

    def post(self, request):
        raw = request.POST.get('room_embed_zoom')
        try:
            float(raw)
        except (TypeError, ValueError):
            messages.error(request, 'Room embed zoom must be a number.')
            return render(request, self.template_name, self._context(room_embed_zoom()))

        zoom = clamp_zoom(raw)
        blob, _ = FacilityMapBlob.objects.get_or_create(kind='settings', key='')
        data = dict(blob.data or {})
        data['room_embed_zoom'] = zoom
        blob.data = data
        blob.save(update_fields=['data', 'updated'])

        messages.success(request, f'Settings saved — room embed zoom set to {zoom:g}.')
        return redirect(reverse('plugins:netbox_facilitymap:settings'))
