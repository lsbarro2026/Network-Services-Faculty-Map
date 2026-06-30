"""Home-dashboard widget — embeds the facility map SPA in a NetBox dashboard card.

The map is a full-screen single-page app (`MapView` → `index.html`), not a server-rendered
panel, so the widget surfaces it the cheap, robust way: an `<iframe>` of the existing view.
Being same-origin, the iframe inherits the user's NetBox session, so the SPA's ORM-backed
auth and authenticated `media_url` images work with no extra plumbing — there is no second
rendering path or API token to maintain. The iframe always loads `?embed=1`, which puts the
SPA in its static mode (read by `MapView`): no chrome, no side panel, no in-widget navigation,
and the map fitted to fill the card. Two opt-in config toggles relax that — `&interactive=1`
re-enables pan/zoom and `&legend=1` shows the "All buildings" list — both off by default. An
optional deep-link hash pins a specific building/floor.
"""

from django import forms
from django.urls import reverse
from django.utils.html import format_html

from extras.dashboard.widgets import DashboardWidget, WidgetConfigForm, register_widget


@register_widget
class FacilityMapWidget(DashboardWidget):
    default_title = 'Facility Map'
    description = 'Interactive siteplan → building → floor → room map.'
    width = 12
    height = 6
    default_config = {'height': 800}

    class ConfigForm(WidgetConfigForm):
        height = forms.IntegerField(
            min_value=200, initial=800,
            help_text='Height of the embedded map, in pixels.',
        )
        interactive = forms.BooleanField(
            required=False, initial=False,
            help_text='Allow pan & zoom inside the card (off = a fixed, fitted map).',
        )
        show_legend = forms.BooleanField(
            required=False, initial=False,
            help_text='Show the "All buildings" list beside the siteplan.',
        )
        link = forms.CharField(
            required=False,
            help_text='Optional deep-link, e.g. #/b/<dir> or #/f/<dir>/<fid>. Blank opens the siteplan.',
        )

    def render(self, request):
        config = self.config
        # Always embedded (chrome-free, no navigation); pan/zoom and the building list are opt-in.
        src = reverse('plugins:netbox_facilitymap:map') + '?embed=1'
        if config.get('interactive'):
            src += '&interactive=1'
        if config.get('show_legend'):
            src += '&legend=1'
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
