# Facility Map

A navigable **siteplan → building → floor → room** map of a facility, where each room links
to its **NetBox Location**. It ships as a single installable **NetBox 4.x plugin** that is
**generic and ships with no facility content** — you import a facility from inside NetBox
(one folder of floor-plan PDFs per building), then draw and bind room polygons.

Everything lives in [`netbox-facilitymap/`](netbox-facilitymap/): the framework-free map
editor, the relational `Room` model rendered natively on NetBox Location pages, and the
in-app PDF-import pipeline. (Earlier versions split a standalone drawing tool from the
plugin; as of `1.2.0` the import pipeline was folded in and the tool retired, so the plugin
is self-contained.)

## Get the code

```bash
git clone https://github.com/lsbarro2026/Network-Services-Faculty-Map.git
cd Network-Services-Faculty-Map
# later, to update an existing checkout:
git pull
```

The plugin installs into NetBox's virtualenv from the `netbox-facilitymap/` subdirectory —
you can install it straight from GitHub without cloning first; see
[`netbox-facilitymap/README.md`](netbox-facilitymap/README.md#install-into-a-netbox-instance).

## Where to go

- **Install / operate the plugin** → [`netbox-facilitymap/README.md`](netbox-facilitymap/README.md)
- **Import a facility, security model** → [`netbox-facilitymap/README.md`](netbox-facilitymap/README.md#importing-a-facility)
- **Plugin design & packaging** (storage model, import pipeline, build mechanics)
  → [`netbox-facilitymap/DESIGN.md`](netbox-facilitymap/DESIGN.md)
- **Deep reference** (every frontend class, route, data model, coordinate convention)
  → [`netbox-facilitymap/ARCHITECTURE.md`](netbox-facilitymap/ARCHITECTURE.md)
- **Release history** → [`netbox-facilitymap/CHANGELOG.md`](netbox-facilitymap/CHANGELOG.md)

## Drawings

The plugin ships empty. Floor-plan PDFs are uploaded and rendered through the in-app
**Import** wizard (the home screen until a facility is imported); the uploaded PDFs and
rendered images live under `<MEDIA_ROOT>/netbox_facilitymap/` and are served back through
authenticated endpoints. Because the drawings carry no text layer, each PDF's floor is
assigned in the wizard. See
[`netbox-facilitymap/README.md`](netbox-facilitymap/README.md#importing-a-facility).
