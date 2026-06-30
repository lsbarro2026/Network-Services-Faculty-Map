from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import TemplateView


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
        # `?embed=1` (set by the dashboard widget's iframe) drops the SPA chrome so the map
        # sits cleanly inside a card. See `index.html` and `dashboard.py`.
        context = super().get_context_data(**kwargs)
        context['embed'] = 'embed' in self.request.GET
        return context
