# Facility Map

A navigable **siteplan → building → floor → room** map of a facility,
where each room links to its **NetBox Location**. The annotation tool is **generic and
ships with no facility content** — drawings are imported from inside the app (one folder
of floor-plan PDFs per building); see [`tool/README.md`](tool/README.md#importing-a-facility).

The project ships in two parts that share one data format (room polygons stored
normalized 0..1, bound to `dcim.Location`):

| Part | What it is | Start here |
|---|---|---|
| **`tool/`** | A local, dependency-free web app to draw and edit the room polygons, arrows, and rack placements. Produces `annotations.json` (and friends). | [`tool/README.md`](tool/README.md) |
| **`netbox-facilitymap/`** | An installable **NetBox 4.x plugin** that ingests the tool's output and renders the same map (and a relational `Room` model) inside NetBox. | [`netbox-facilitymap/README.md`](netbox-facilitymap/README.md) |

The standalone tool keeps running unchanged alongside the plugin; annotations
move between the two freely (`manage.py facilitymap_import`).

## Where to go

- **Set up / run the annotation tool** → [`tool/README.md`](tool/README.md)
- **Understand or maintain the tool** (every class, route, data model, coordinate
  convention) → [`tool/ARCHITECTURE.md`](tool/ARCHITECTURE.md)
- **Install / operate the NetBox plugin** → [`netbox-facilitymap/README.md`](netbox-facilitymap/README.md)
- **Plugin design & packaging** (storage model, build mechanics, install internals)
  → [`netbox-facilitymap/DESIGN.md`](netbox-facilitymap/DESIGN.md)
- **Plugin release history** → [`netbox-facilitymap/CHANGELOG.md`](netbox-facilitymap/CHANGELOG.md)

## Drawings

The tool ships empty. Floor-plan PDFs are uploaded and rendered through the in-app
**Import** wizard (the home screen until a facility is imported); the uploaded PDFs and
rendered assets live under `tool/uploads/` + `tool/images/` and are gitignored. Because
the drawings carry no text layer, each PDF's floor is assigned in the wizard. See
[`tool/README.md`](tool/README.md#importing-a-facility).
