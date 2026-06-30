#!/usr/bin/env python3
"""
preprocess.py — render a facility's floor-plan PDFs into the assets the map serves
(images/ + manifest.json). It is the rendering engine behind the in-app import wizard.

IMPORTANT — isolation: this module is **invoked as a standalone subprocess** by
`imports.py` (run by file path, never imported as `netbox_facilitymap.preprocess`), so it
must stay **stdlib + pypdfium2/Pillow only** and never import Django/NetBox. Keeping the
PDF parser (untrusted input) out of the long-lived NetBox worker is the whole point: a
PDFium exploit is contained in a short-lived, resource-limited child process.

The source PDFs live under `<work-dir>/uploads/` (one folder per building, uploaded
through the wizard). Facility drawings carry no text layer — every label is a vectorized
path — so the floor a PDF belongs to cannot be read from the file. That mapping is
supplied by `import-map.json`: per building a `slug`/`name`/`abbr` and a `{drawing-stem:
floor-token}` table. Floor labels are derived from the token (`b3` -> "Basement 3",
`g` -> "Ground", `l1` -> "Level 1", `r` -> "Roof"); two drawings sharing a token become
one multi-page floor (ordered by drawing number).

Three modes:
  scan     walk uploads/, render a thumbnail per PDF, and print a JSON inventory of
           folders + drawings to stdout (the wizard's mapping step reads this).
  build    read import-map.json, render every mapped PDF to images/<slug>/<id>[-N].png,
           and write manifest.json (the default mode).
  preview  render one named PDF at full scale to --out (the wizard's on-demand high-res
           preview, served from a .thumbs cache).

Rendering needs `pypdfium2` + `Pillow`. The working directory is passed explicitly so the
data can live under NetBox's MEDIA_ROOT while this script lives in the package:

  python3 preprocess.py scan  --base /path/to/workdir
  python3 preprocess.py build --base /path/to/workdir
  python3 preprocess.py preview --base /path/to/workdir --pdf uploads/A/1.pdf --out uploads/.thumbs/A/1.full.png
"""

import io
import json
import os
import re
import sys

try:
    import pypdfium2 as pdfium
except ImportError:
    pdfium = None


class Preprocessor:
    """Renders uploads/ + import-map.json into images/ and manifest.json, all relative
    to a single working directory (``base_dir``)."""

    RENDER_SCALE = 2.0   # full floor-plan render scale; coords are normalized 0..1
    THUMB_SCALE = 0.6    # wizard thumbnail scale (legible enough to identify a plan)
    THUMBS_DIRNAME = ".thumbs"

    def __init__(self, base_dir):
        self.base_dir = base_dir
        self.source = os.path.join(base_dir, "uploads")
        self.images_dir = os.path.join(base_dir, "images")
        self.manifest_path = os.path.join(base_dir, "manifest.json")
        self.import_map_path = os.path.join(base_dir, "import-map.json")
        self.stub_path = os.path.join(base_dir, "import-map.stub.json")

    # ---- PDF rendering ----
    @classmethod
    def render_pdf_full(cls, pdf_path):
        """Render page 1 of a (text-less) floor or siteplan PDF to PNG bytes at
        RENDER_SCALE, honoring the page's own rotation. Returns (raw, w, h), or None
        when pypdfium2 is missing or the render fails."""
        if pdfium is None:
            return None
        try:
            page = pdfium.PdfDocument(pdf_path)[0]
            pil = page.render(scale=cls.RENDER_SCALE).to_pil().convert("RGB")
            buf = io.BytesIO()
            pil.save(buf, "PNG")
            return buf.getvalue(), pil.width, pil.height
        except Exception:
            return None

    def render_pdf_thumb(self, pdf_path, out_path):
        """Render page 1 to a small PNG at out_path for the wizard's mapping grid.
        Returns True on success."""
        if pdfium is None:
            return False
        try:
            page = pdfium.PdfDocument(pdf_path)[0]
            pil = page.render(scale=self.THUMB_SCALE).to_pil().convert("RGB")
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            pil.save(out_path, "PNG")
            return True
        except Exception as e:
            print("WARN thumb %s: %s" % (pdf_path, e), file=sys.stderr)
            return False

    def preview(self, pdf_rel, out_rel):
        """Render page 1 of a single uploaded PDF at full RENDER_SCALE to ``out_rel`` —
        the wizard's on-demand high-res preview (popup + enlarged/zoomed cards). Both paths
        are working-dir-relative; the caller (imports.py) has already traversal-guarded
        them. Writes atomically via a ``.part`` temp so concurrent identical renders are
        safe. Returns True on success."""
        res = self.render_pdf_full(os.path.join(self.base_dir, pdf_rel))
        if res is None:
            print("WARN preview %s: could not render (need pypdfium2 + Pillow)" % pdf_rel,
                  file=sys.stderr)
            return False
        raw = res[0]
        out_path = os.path.join(self.base_dir, out_rel)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        part = out_path + ".part"
        with open(part, "wb") as f:
            f.write(raw)
        os.replace(part, out_path)
        return True

    def write_image(self, rel_dir, floor_id, raw):
        out_dir = os.path.join(self.images_dir, rel_dir)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, floor_id + ".png")
        with open(path, "wb") as f:
            f.write(raw)
        return os.path.relpath(path, self.base_dir).replace(os.sep, "/")

    # ---- floor labels ----
    @staticmethod
    def floor_label(token):
        """Floor token -> human label. A compact floor code from the wizard's
        floor-type mode is expanded segment-by-segment: 'b3' -> 'Basement 3',
        'gl1' -> 'Ground / Level 1', 'g' -> 'Ground', 'r' -> 'Roof'. Any other token
        — notably a NetBox Location slug from the wizard's Location mode — is
        title-cased as-is ('basement-2' -> 'Basement 2'). The compact parse is
        anchored to the WHOLE token; it is no longer scanned for loose 'g'/'r'
        letters, which used to emit phantom 'Ground'/'Roof' segments (a slug like
        'triumf-b2' wrongly became 'Roof / Basement 2')."""
        seg = r"gl\d+|b\d+|l\d+|g|r"
        t = token.lower()
        if not re.fullmatch(r"(?:%s)+" % seg, t):
            return token.replace("-", " ").replace("_", " ").title() or token.upper()
        names = []
        for m in re.findall(seg, t):
            if m == "g":
                names.append("Ground")
            elif m == "r":
                names.append("Roof")
            elif m.startswith("gl"):
                names += ["Ground", "Level " + m[2:]]
            elif m.startswith("b"):
                names.append("Basement " + m[1:])
            elif m.startswith("l"):
                names.append("Level " + m[1:])
        return " / ".join(names)

    # ---- drawing discovery ----
    @staticmethod
    def dwg_sort_key(stem):
        """Order drawings by number, keeping a '-N' second-sheet suffix after its
        base (26024 < 26024-2 < 26025). Non-numeric names sort last by name."""
        base, _, suf = stem.partition("-")
        if not base.isdigit():
            return (10 ** 9, 0, stem)
        return (int(base), int(suf) if suf.isdigit() else 0, "")

    def pdf_files(self, folder):
        """(stem, filename) of every PDF in a building folder, in drawing order."""
        fdir = os.path.join(self.source, folder)
        items = [(os.path.splitext(f)[0], f)
                 for f in os.listdir(fdir) if f.lower().endswith(".pdf")]
        return sorted(items, key=lambda it: self.dwg_sort_key(it[0]))

    def building_folders(self):
        """Top-level building folders under uploads/ (skips the thumbnail cache)."""
        if not os.path.isdir(self.source):
            return []
        return sorted(d for d in os.listdir(self.source)
                      if d != self.THUMBS_DIRNAME
                      and os.path.isdir(os.path.join(self.source, d)))

    # ---- import map ----
    def load_import_map(self):
        if not os.path.isfile(self.import_map_path):
            return None
        with open(self.import_map_path, encoding="utf-8") as f:
            return json.load(f)

    @staticmethod
    def building_lookup(imap):
        """Resolve a source folder to its map entry by either its upload folder name
        (the map key) or its slug."""
        out = {}
        for name, entry in (imap or {}).get("buildings", {}).items():
            out[name] = entry
            out[entry["slug"]] = entry
        return out

    # ---- building / siteplan assembly ----
    def build_building_from_pdfs(self, folder, entry):
        """Build one manifest building from its PDF folder + import-map entry. PDFs
        sharing a floor token group into one multi-page floor (ordered by drawing
        number). Returns (building, unmapped_stems)."""
        slug, abbr = entry["slug"], entry.get("abbr", "")
        fmap = entry.get("floors", {})
        groups, index, unmapped = [], {}, []
        for stem, fname in self.pdf_files(folder):
            token = fmap.get(stem)
            if not token:
                unmapped.append(stem)
                continue
            fid = abbr + token
            if fid not in index:
                index[fid] = len(groups)
                groups.append([fid, token, []])
            groups[index[fid]][2].append(fname)
        floors = []
        for fid, token, fnames in groups:
            pages = []
            for n, fname in enumerate(fnames, start=1):
                res = self.render_pdf_full(os.path.join(self.source, folder, fname))
                if res is None:
                    print("  WARN %s %s: could not render (need pypdfium2 + Pillow)"
                          % (folder, fname), file=sys.stderr)
                    continue
                raw, w, h = res
                pid = fid if n == 1 else "%s-%d" % (fid, n)
                pages.append({"image": self.write_image(slug, pid, raw),
                              "w": w, "h": h, "caption": None})
            if not pages:
                continue
            p0 = pages[0]
            floors.append({
                "id": fid, "label": self.floor_label(token) or fid,
                "floorSlug": fid, "image": p0["image"], "w": p0["w"], "h": p0["h"],
                "pages": pages,
            })
        code = slug[:2] if re.match(r"\d\d", slug) else None
        print("%-26s slug=%-12s floors=%s%s" % (
            folder, slug, ",".join(f["id"] for f in floors) or "(none)",
            "  UNMAPPED: " + ",".join(unmapped) if unmapped else ""), file=sys.stderr)
        return {"code": code, "dir": slug, "name": entry.get("name", folder),
                "siteSlug": slug, "floors": floors}, unmapped

    def build_siteplan_from_pdf(self, imap):
        """Render the PDF named in import-map.json's `siteplan` block as the siteplan
        background, with no hotspots (drawn in the tool). None when not configured."""
        sp = (imap or {}).get("siteplan")
        if not sp or not sp.get("pdf"):
            return None
        pdf = os.path.join(self.source, sp.get("folder", ""), sp["pdf"])
        res = self.render_pdf_full(pdf)
        if res is None:
            print("  WARN could not render siteplan PDF:", pdf, file=sys.stderr)
            return None
        raw, w, h = res
        image = self.write_image("Siteplan", "siteplan", raw)
        print("siteplan: %dx%d, 0 hotspots (draw building boundaries in the tool)"
              % (w, h), file=sys.stderr)
        return {"image": image, "w": w, "h": h,
                "siteSlug": sp.get("slug", "00-site"), "hotspots": []}

    def write_stub(self, unmapped):
        """Write import-map.stub.json listing drawings with no floor token: one block
        per folder, drawings pre-listed in order with blank tokens to fill in."""
        stub = {}
        for folder, stems in sorted(unmapped.items()):
            stub[folder] = {"slug": folder, "name": folder, "abbr": "",
                            "floors": {s: "" for s in stems}}
        with open(self.stub_path, "w", encoding="utf-8") as f:
            json.dump({"buildings": stub}, f, indent=2, ensure_ascii=False)
        print("WROTE %s — fill in the floor tokens and merge into import-map.json"
              % os.path.relpath(self.stub_path, self.base_dir), file=sys.stderr)

    # ---- modes ----
    def scan(self):
        """Render a thumbnail per PDF and print a JSON inventory of folders/drawings
        to stdout (consumed by the wizard's mapping step)."""
        folders = []
        for folder in self.building_folders():
            pdfs = []
            for stem, fname in self.pdf_files(folder):
                thumb_rel = os.path.join("uploads", self.THUMBS_DIRNAME, folder,
                                         stem + ".png")
                ok = self.render_pdf_thumb(
                    os.path.join(self.source, folder, fname),
                    os.path.join(self.base_dir, thumb_rel))
                pdfs.append({"file": fname, "stem": stem,
                             "thumb": thumb_rel.replace(os.sep, "/") if ok else None,
                             "pdf": ("uploads/%s/%s" % (folder, fname))})
            if pdfs:
                folders.append({"folder": folder, "pdfs": pdfs})
            print("scanned %s (%d)" % (folder, len(pdfs)), file=sys.stderr)
        json.dump({"folders": folders}, sys.stdout)

    def build(self):
        """Render every mapped PDF and write manifest.json from import-map.json."""
        imap = self.load_import_map()
        if not imap:
            sys.exit("No import-map.json — nothing to build.")
        lookup = self.building_lookup(imap)
        siteplan = self.build_siteplan_from_pdf(imap)
        buildings, unmapped = [], {}
        for folder in self.building_folders():
            entry = lookup.get(folder)
            if entry:
                b, miss = self.build_building_from_pdfs(folder, entry)
                if b["floors"]:
                    buildings.append(b)
                if miss:
                    unmapped[folder] = miss
        if unmapped:
            self.write_stub(unmapped)
        with open(self.manifest_path, "w") as f:
            json.dump({"siteplan": siteplan, "buildings": buildings}, f, indent=2)
        print("Wrote %s — buildings: %d, floors: %d"
              % (self.manifest_path, len(buildings),
                 sum(len(b["floors"]) for b in buildings)), file=sys.stderr)


def _parse_args(argv):
    """Tiny argv parser (argparse-free to keep the child minimal): a bare
    `scan`/`build`/`preview` mode plus an optional `--base <dir>` (falls back to
    $FACILITYMAP_WORKDIR, then the script's own directory). `preview` also takes
    `--pdf <uploads-relative.pdf>` and `--out <base-relative.png>`."""
    mode = "build"
    base = os.environ.get("FACILITYMAP_WORKDIR")
    opts = {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--base", "--pdf", "--out") and i + 1 < len(argv):
            key = argv[i][2:]
            if key == "base":
                base = argv[i + 1]
            else:
                opts[key] = argv[i + 1]
            i += 2
        else:
            mode = argv[i]
            i += 1
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    return mode, base, opts


if __name__ == "__main__":
    mode, base, opts = _parse_args(sys.argv[1:])
    pre = Preprocessor(base)
    if mode == "scan":
        pre.scan()
    elif mode == "build":
        pre.build()
    elif mode == "preview":
        if not opts.get("pdf") or not opts.get("out"):
            sys.exit("preview needs --pdf and --out")
        if not pre.preview(opts["pdf"], opts["out"]):
            sys.exit("preview render failed")
    else:
        sys.exit("usage: preprocess.py [scan|build|preview] [--base DIR]")
