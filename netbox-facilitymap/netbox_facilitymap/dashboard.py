"""Home-dashboard widget — embeds the facility map SPA in a NetBox dashboard card.

The map is a full-screen single-page app (`MapView` → `index.html`), not a server-rendered
panel, so the widget surfaces it the cheap, robust way: an `<iframe>` of the existing view.
Being same-origin, the iframe inherits the user's NetBox session, so the SPA's ORM-backed
auth and authenticated `media_url` images work with no extra plumbing — there is no second
rendering path or API token to maintain. `?embed=1` (read by `MapView`) hides the SPA's own
chrome so it sits cleanly inside the card; an optional deep-link hash opens a specific
building/floor.
"""

from django import forms
from django.urls import reverse
from django.utils.html import format_html

from extras.dashboard.widgets import DashboardWidget, WidgetConfigForm, register_widget


@register_widget
class FacilityMapWidget(DashboardWidget):
    default_title = 'Facility Map'
    description = 'Interactive siteplan → building → floor → room map.'
    width = 6
    height = 4
    default_config = {'height': 600, 'hide_chrome': True}

    class ConfigForm(WidgetConfigForm):
        height = forms.IntegerField(
            min_value=200, initial=600,
            help_text='Height of the embedded map, in pixels.',
        )
        hide_chrome = forms.BooleanField(
            required=False, initial=True,
            help_text="Hide the map's own toolbar and breadcrumbs inside the card.",
        )
        link = forms.CharField(
            required=False,
            help_text='Optional deep-link, e.g. #/b/<dir> or #/f/<dir>/<fid>. Blank opens the siteplan.',
        )

    def render(self, request):
        config = self.config
        src = reverse('plugins:netbox_facilitymap:map')
        if config.get('hide_chrome', True):
            src += '?embed=1'
        # The hash fragment must follow the querystring; the SPA router decodes each segment.
        link = (config.get('link') or '').strip()
        if link:
            src += link if link.startswith('#') else '#' + link.lstrip('/')
        height = config.get('height') or 600
        return format_html(
            '<iframe src="{}" title="Facility Map" loading="lazy" '
            'style="width:100%;height:{}px;border:0;display:block"></iframe>',
            src, height,
        )
