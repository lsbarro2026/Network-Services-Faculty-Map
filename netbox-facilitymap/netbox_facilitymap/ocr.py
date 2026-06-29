#!/usr/bin/env python3
"""
ocr.py — read the floor code off rendered drawing images so the import wizard can
auto-assign floors. It is the OCR engine behind the wizard's "Automatic" assignment mode.

IMPORTANT — isolation: like `preprocess.py`, this module is **invoked as a standalone
subprocess** by `imports.py` (run by file path, never imported as
`netbox_facilitymap.ocr`), under the same timeout + POSIX resource limits. It must stay
**stdlib + Pillow + rapidocr-onnxruntime only** and never import Django/NetBox. The OCR
engine and its native deps (onnxruntime) load only in this short-lived, capped child.

It reads **only already-rendered, trusted PNGs** — the wizard's `.thumbs/*.full.png`
previews that `preprocess.py` produced — and **never opens a PDF**, so it adds no new
untrusted-input parsing path: PDF rasterization stays solely in `preprocess.py`. The OCR
models ship inside the rapidocr-onnxruntime wheel, so recognition is fully offline (no
network access, ever).

One mode:
  ocr   read a job file (a normalized crop region + a list of images), OCR that one region
        on each image, and print `{"results": [...]}` to stdout (the wizard reads this).

The job file (working-dir-relative paths, normalized 0..1 region):
  {"region": {"x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1},
   "images": [{"folder": "A", "stem": "26024", "image": "uploads/.thumbs/A/26024.full.png"}]}

  python3 ocr.py ocr --base /path/to/workdir --job ocr-job.json
"""

import io
import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:
    RapidOCR = None


class FloorCodeReader:
    """OCR a single normalized region out of each rendered drawing PNG, relative to a working
    directory (``base_dir``). Coordinates are normalized 0..1 so the same region maps onto
    every drawing's render regardless of size."""

    MIN_CROP_PX = 320    # crops shorter than this are upscaled so small codes stay legible
    UPSCALE_TO = 1000    # target short edge after upscaling
    MAX_UPSCALE = 4      # never enlarge more than this (keeps a tiny crop from ballooning)

    def __init__(self, base_dir):
        self.base_dir = base_dir
        self._engine = None

    def engine(self):
        """Load the OCR engine lazily (model init is the expensive part) and reuse it across
        every image in the batch."""
        if self._engine is None:
            self._engine = RapidOCR()
        return self._engine

    def _upscale(self, crop):
        w, h = crop.size
        short = min(w, h)
        if not short or short >= self.MIN_CROP_PX:
            return crop
        factor = min(self.MAX_UPSCALE, self.UPSCALE_TO / short)
        if factor <= 1:
            return crop
        return crop.resize((round(w * factor), round(h * factor)), Image.LANCZOS)

    def read_region(self, image_rel, region):
        """Crop ``image_rel`` to the normalized ``region`` and OCR it. Returns
        ``(text, confidence)``; a missing/unreadable image or an empty region degrades to
        ``("", 0.0)`` so one bad PNG never sinks the batch."""
        path = os.path.join(self.base_dir, image_rel)
        try:
            img = Image.open(path).convert("RGB")
        except Exception as e:
            print("WARN ocr open %s: %s" % (image_rel, e), file=sys.stderr)
            return "", 0.0
        w, h = img.size
        x1 = max(0, min(w, round(region["x"] * w)))
        y1 = max(0, min(h, round(region["y"] * h)))
        x2 = max(0, min(w, round((region["x"] + region["w"]) * w)))
        y2 = max(0, min(h, round((region["y"] + region["h"]) * h)))
        if x2 <= x1 or y2 <= y1:
            return "", 0.0
        crop = self._upscale(img.crop((x1, y1, x2, y2)))
        # Pass PNG bytes (not a numpy array) so this file needs no numpy import; rapidocr
        # decodes bytes internally.
        buf = io.BytesIO()
        crop.save(buf, "PNG")
        try:
            out = self.engine()(buf.getvalue())
        except Exception as e:
            print("WARN ocr read %s: %s" % (image_rel, e), file=sys.stderr)
            return "", 0.0
        # RapidOCR returns (result, elapse) where result is [[box, text, score], ...] or None.
        result = out[0] if out else None
        if not result:
            return "", 0.0
        texts = [r[1].strip() for r in result if len(r) > 1 and r[1] and r[1].strip()]
        scores = [float(r[2]) for r in result if len(r) > 2]
        text = " ".join(texts)
        conf = min(scores) if scores else 0.0     # weakest line bounds our confidence
        return text, conf

    def run(self, job_rel):
        """Read the job, OCR every listed image's region, and print the results as JSON."""
        if Image is None:
            sys.exit("Pillow is required for OCR")
        if RapidOCR is None:
            sys.exit("rapidocr-onnxruntime is required for OCR")
        with open(os.path.join(self.base_dir, job_rel), encoding="utf-8") as f:
            job = json.load(f)
        region = job["region"]
        # Keep any library chatter off stdout — that channel carries only our JSON result.
        real_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            results = []
            for item in job.get("images", []):
                text, conf = self.read_region(item["image"], region)
                results.append({"folder": item.get("folder"), "stem": item.get("stem"),
                                "text": text, "confidence": round(conf, 4)})
        finally:
            sys.stdout = real_stdout
        json.dump({"results": results}, sys.stdout)


def _parse_args(argv):
    """Tiny argv parser (argparse-free, mirroring preprocess.py): a bare `ocr` mode plus
    `--base <dir>` (falls back to $FACILITYMAP_WORKDIR, then the script's own directory) and
    `--job <base-relative.json>`."""
    mode = "ocr"
    base = os.environ.get("FACILITYMAP_WORKDIR")
    opts = {}
    i = 0
    while i < len(argv):
        if argv[i] in ("--base", "--job") and i + 1 < len(argv):
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
    if mode != "ocr":
        sys.exit("usage: ocr.py ocr --base DIR --job ocr-job.json")
    if not opts.get("job"):
        sys.exit("ocr needs --job")
    FloorCodeReader(base).run(opts["job"])
