#!/usr/bin/env python3
"""
ocr.py — read the floor code off rendered drawing images so the import wizard can
auto-assign floors. It is the OCR engine behind the wizard's "Automatic" assignment mode.

IMPORTANT — isolation: like `preprocess.py`, this module is **invoked as a standalone
subprocess** by `imports.py` (run by file path, never imported as
`netbox_facilitymap.ocr`), under the same timeout + POSIX resource limits. It must stay
**stdlib + Pillow + numpy + onnxruntime only** and never import Django/NetBox. The OCR
model and its native runtime load only in this short-lived, capped child.

Engine: a **PP-OCRv4 text-recognition** ONNX model (Apache-2.0, vendored under `models/`)
run on `onnxruntime`, with all image preprocessing done in `numpy`/`Pillow`. This is
deliberately **not OpenCV** — OpenCV's desktop build needs X11 system libraries that
headless servers lack, which made the previous rapidocr-based engine fail to import on a
bare box. onnxruntime's wheels are self-contained (only base libc/libstdc++), so a plain
`pip install` works on any environment with no system packages and no network (the model
ships in the wheel, so recognition is fully offline).

Because the user already draws a tight box around the code, we run **recognition only**
(no text-detection model — that's the part that needs OpenCV). A small `numpy`
horizontal-projection splitter handles a box that spans more than one text line.

It reads **only already-rendered, trusted PNGs** — the wizard's `.thumbs/*.full.png`
previews that `preprocess.py` produced — and **never opens a PDF**, so it adds no new
untrusted-input parsing path: PDF rasterization stays solely in `preprocess.py`.

One mode:
  ocr   read a job file (a normalized crop region + a list of images), OCR that one region
        on each image, and print `{"results": [...]}` to stdout (the wizard reads this).

The job file (working-dir-relative paths, normalized 0..1 region):
  {"region": {"x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1},
   "images": [{"folder": "A", "stem": "26024", "image": "uploads/.thumbs/A/26024.full.png"}]}

  python3 ocr.py ocr --base /path/to/workdir --job ocr-job.json
"""

import json
import math
import os
import sys

try:
    from PIL import Image
except ImportError:
    Image = None

try:
    import numpy as np
    import onnxruntime as ort
    _OCR_IMPORT_ERROR = None
except Exception as exc:   # capture the real reason (missing wheel, unloadable native lib, …)
    np = ort = None
    _OCR_IMPORT_ERROR = exc

# The recognition model is vendored next to this file so recognition is fully offline.
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "rec.onnx")

REC_INPUT_H = 48     # PP-OCRv4 rec input height (rec_img_shape = [3, 48, 320])
REC_WIDTH_ANCHOR = 320   # the model's reference width; the real width scales with the crop


def _to_ascii(s):
    """Fold fullwidth Latin/digits/punctuation (U+FF01–FF5E) and the ideographic space back to
    ASCII — the PP-OCR model occasionally emits fullwidth forms (e.g. `（B3）`), which the
    frontend's floor-code parser would otherwise drop along with the digits."""
    out = []
    for ch in s:
        o = ord(ch)
        if 0xFF01 <= o <= 0xFF5E:
            out.append(chr(o - 0xFEE0))
        elif ch == "　":
            out.append(" ")
        else:
            out.append(ch)
    return "".join(out)


class _Recognizer:
    """Thin wrapper over the PP-OCRv4 recognition ONNX model: preprocess a single text-line
    image the way PaddleOCR does, run the net, and CTC-greedy-decode the output to text."""

    def __init__(self, model_path):
        opts = ort.SessionOptions()
        opts.log_severity_level = 3   # keep onnxruntime quiet; stdout carries only our JSON
        self.sess = ort.InferenceSession(model_path, sess_options=opts,
                                         providers=["CPUExecutionProvider"])
        self.input_name = self.sess.get_inputs()[0].name
        meta = self.sess.get_modelmeta().custom_metadata_map
        chars = meta["character"].splitlines() if "character" in meta else []
        # PaddleOCR CTC label set: blank at index 0, the model's charset, then a trailing space.
        self.labels = ["<blank>"] + chars + [" "]

    def _norm(self, pil_line, max_wh_ratio):
        """Resize a line crop to height 48 (keeping aspect), normalize to [-1, 1] in BGR, and
        right-pad to the batch width — mirrors PaddleOCR/rapidocr `resize_norm_img`."""
        bgr = np.asarray(pil_line.convert("RGB"))[:, :, ::-1]   # PaddleOCR trained on cv2 BGR
        h, w = bgr.shape[:2]
        target_w = int(REC_INPUT_H * max_wh_ratio)
        ratio = w / float(h)
        resized_w = (target_w if math.ceil(REC_INPUT_H * ratio) > target_w
                     else int(math.ceil(REC_INPUT_H * ratio)))
        resized_w = max(1, resized_w)
        small = Image.fromarray(bgr.astype(np.uint8)).resize((resized_w, REC_INPUT_H), Image.BILINEAR)
        arr = np.asarray(small).astype(np.float32).transpose(2, 0, 1) / 255.0
        arr -= 0.5
        arr /= 0.5
        pad = np.zeros((3, REC_INPUT_H, target_w), dtype=np.float32)
        pad[:, :, :resized_w] = arr
        return pad

    def read_line(self, pil_line):
        """Recognize one text-line image. Returns ``(text, [char_probs])`` (probs let the caller
        average a confidence across lines)."""
        w, h = pil_line.size
        if not w or not h:
            return "", []
        max_wh_ratio = max(REC_WIDTH_ANCHOR / REC_INPUT_H, w / float(h))
        batch = self._norm(pil_line, max_wh_ratio)[np.newaxis, :]
        preds = self.sess.run(None, {self.input_name: batch})[0][0]   # [T, num_labels]
        idx = preds.argmax(axis=1)
        prob = preds.max(axis=1)
        keep = np.ones(len(idx), dtype=bool)
        keep[1:] = idx[1:] != idx[:-1]   # collapse CTC repeats
        keep &= idx != 0                 # drop the blank label
        text = "".join(self.labels[i] for i in idx[keep])
        return text, prob[keep].tolist()


class FloorCodeReader:
    """OCR a single normalized region out of each rendered drawing PNG, relative to a working
    directory (``base_dir``). Coordinates are normalized 0..1 so the same region maps onto
    every drawing's render regardless of size."""

    MIN_CROP_PX = 320    # crops shorter than this are upscaled so small codes stay legible
    UPSCALE_TO = 1000    # target short edge after upscaling
    MAX_UPSCALE = 4      # never enlarge more than this (keeps a tiny crop from ballooning)
    DARK_LEVEL = 160     # 0–255 luminance below which a pixel counts as ink (line splitting)
    LINE_MERGE_GAP = 4   # merge ink bands separated by ≤ this many blank rows (descenders)
    LINE_PAD = 3         # pad each split line by this many rows so glyphs aren't clipped

    def __init__(self, base_dir):
        self.base_dir = base_dir
        self._engine = None

    def engine(self):
        """Load the recognizer lazily (model init is the expensive part) and reuse it across
        every image in the batch."""
        if self._engine is None:
            self._engine = _Recognizer(MODEL_PATH)
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

    def _split_lines(self, crop):
        """Split a crop into text lines by horizontal ink projection (pure numpy). The model
        recognizes one line at a time, so a box spanning several lines must be cut first;
        a single-line crop returns one band (itself)."""
        gray = np.asarray(crop.convert("L"))
        inked = (gray < self.DARK_LEVEL).sum(axis=1) > 0
        bands, start = [], None
        for i, has_ink in enumerate(inked):
            if has_ink and start is None:
                start = i
            elif not has_ink and start is not None:
                bands.append([start, i])
                start = None
        if start is not None:
            bands.append([start, len(inked)])
        merged = []
        for b in bands:
            if merged and b[0] - merged[-1][1] <= self.LINE_MERGE_GAP:
                merged[-1][1] = b[1]
            else:
                merged.append(b)
        if not merged:
            return [crop]
        height = gray.shape[0]
        return [crop.crop((0, max(0, a - self.LINE_PAD), crop.width, min(height, b + self.LINE_PAD)))
                for a, b in merged]

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
        try:
            rec = self.engine()
            texts, probs = [], []
            for line in self._split_lines(crop):
                line_text, line_probs = rec.read_line(line)
                line_text = _to_ascii(line_text).strip()
                if line_text:
                    texts.append(line_text)
                    probs.extend(line_probs)
        except Exception as e:
            print("WARN ocr read %s: %s" % (image_rel, e), file=sys.stderr)
            return "", 0.0
        text = " ".join(texts)
        conf = float(sum(probs) / len(probs)) if probs else 0.0
        return text, conf

    def run(self, job_rel):
        """Read the job, OCR every listed image's region, and print the results as JSON."""
        if Image is None:
            sys.exit("Pillow is required for OCR")
        if np is None or ort is None:
            msg = "onnxruntime and numpy are required for OCR"
            if _OCR_IMPORT_ERROR is not None:
                msg += " — import failed: %s" % (_OCR_IMPORT_ERROR,)
            sys.exit(msg)
        if not os.path.isfile(MODEL_PATH):
            sys.exit("OCR model missing at %s (it should ship in the wheel under models/)" % MODEL_PATH)
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
