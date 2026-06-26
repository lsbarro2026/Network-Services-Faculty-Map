'use strict';
/* lib.js — framework-free foundations shared by every module.
   Pure static helper classes (no instances, no state). Loaded first. */

const SVGNS = 'http://www.w3.org/2000/svg';
const CLOSE_PX = 12;   // click-near-first-vertex threshold (displayed px) to close a polygon
const SNAP_PX = 11;    // snap radius (displayed px) for vertices/edges
const ORTHO_PX = 9;    // alignment tolerance (displayed px) for right-angle node snap
const ANGLE_STEP = 15; // label rotation snaps to this many degrees (Alt to free-rotate)
const LABEL_SIZE_MIN = 6, LABEL_SIZE_MAX = 120;   // label font-size clamp (px)
// Font choices for a label — bundled fonts (Public Sans, IBM Plex Mono) plus generic
// families that use OS fonts, so everything stays offline (no CDN). `css` is the
// value written to labelStyle.font and applied inline; `name` is the dropdown label.
const LABEL_FONTS = [
  { name: 'Public Sans', css: "'Public Sans', sans-serif" },
  { name: 'IBM Plex Mono', css: "'IBM Plex Mono', monospace" },
  { name: 'Sans-serif', css: 'sans-serif' },
  { name: 'Serif', css: 'serif' },
  { name: 'Monospace', css: 'monospace' },
];
// Route arrows (FloorEditor wayfinding): palette of theme colours as literal hex
// (so they can drive an SVG stroke/fill attribute directly); first is the default.
const ARROW_COLORS = ['#066fd1', '#2fa84f', '#e0a93d', '#e0533d'];
// Arrowhead size in LAYOUT px. It scales with the map under zoom (like a room
// fill) rather than counter-scaling — pan/zoom never re-renders, so a JS size
// divided by the zoom scale would be stale (see ARCHITECTURE §6).
const ARROW_HEAD_PX = 15;

/** Small id / key helpers. */
class Util {
  static uid() { return 'r' + Math.random().toString(36).slice(2, 9); }
  static floorKey(dir, fid) { return dir + '/' + fid; }
  static isNumbered(dir) { return /^\d\d-/.test(dir || ''); }
  static code(dir) { return Util.isNumbered(dir) ? dir.slice(0, 2) : dir; }
}

/** DOM construction helpers. */
class Dom {
  static $(sel, root = document) { return root.querySelector(sel); }

  /** el('div', {class, html, onclick, ...attrs}, child|[children]) */
  static el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    for (const c of [].concat(children)) if (c) n.append(c);
    return n;
  }

  /** SVG element with attributes. */
  static svg(tag, attrs = {}) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
}

/** Inline SVG glyphs for toolbar buttons and chrome. Each is a 13×13 stroke
 *  icon using `currentColor`, so a button's text colour (idle, .active, .primary)
 *  recolours the icon to match. Lifted from the tool/Template design. */
class Icons {
  static _ico(body, size = 13) {
    return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" `
      + `fill="none" stroke="currentColor" stroke-width="1.5">${body}</svg>`;
  }
  static get edit() { return Icons._ico('<path d="M11 2.5l2.5 2.5-7.5 7.5-3 .5.5-3z"/>'); }
  static get draw() { return Icons._ico('<rect x="2.7" y="2.7" width="10.6" height="10.6" rx="1"/><path d="M8 5.4v5.2M5.4 8h5.2"/>'); }
  static get undo() { return Icons._ico('<path d="M5.5 5.5L3 8l2.5 2.5"/><path d="M3 8h6.5a3 3 0 0 1 0 6H7"/>'); }
  static get snap() { return Icons._ico('<path d="M4 3v5a4 4 0 0 0 8 0V3"/><line x1="4" y1="3" x2="6.2" y2="3"/><line x1="9.8" y1="3" x2="12" y2="3"/>'); }
  static get grid() { return Icons._ico('<rect x="2.7" y="2.7" width="10.6" height="10.6" rx="1"/><path d="M6.2 2.7v10.6M9.8 2.7v10.6M2.7 6.2h10.6M2.7 9.8h10.6"/>'); }
  static get move() { return Icons._ico('<path d="M8 2.5v11M2.5 8h11"/><path d="M8 2.5l-1.5 1.7M8 2.5l1.5 1.7M8 13.5l-1.5-1.7M8 13.5l1.5-1.7M2.5 8l1.7-1.5M2.5 8l1.7 1.5M13.5 8l-1.7-1.5M13.5 8l-1.7 1.5"/>'); }
  static get dup() { return Icons._ico('<rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M3 11V3.5A.5.5 0 0 1 3.5 3H11"/>'); }
  static get check() { return Icons._ico('<path d="M3.5 8.5l3 3 6-6.5"/>', 12); }
  static get rack() { return Icons._ico('<rect x="3.5" y="2.5" width="9" height="11" rx="1"/><path d="M3.5 5.5h9M3.5 8h9M3.5 10.5h9"/>'); }
  static get settings() { return Icons._ico('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>'); }
  static get rightangle() { return Icons._ico('<path d="M4 2.5v11h11"/><path d="M4 9.5h4.5v4.5"/>'); }
  static get arrow() { return Icons._ico('<path d="M2.5 13.5l11-11"/><path d="M6.5 2.5h7v7"/>'); }
}

/** Pure geometry helpers (normalized or pixel space, caller-consistent). */
class Geom {
  static centroid(poly) {
    let x = 0, y = 0;
    for (const p of poly) { x += p[0]; y += p[1]; }
    return [x / poly.length, y / poly.length];
  }

  /** Axis-aligned bounding box of a polygon; verts and result in caller's space. */
  static bounds(poly) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY,
             cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  /** Nearest point on segment a-b to p; all args in displayed px. */
  static projSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx, qy = ay + t * dy;
    return { x: qx, y: qy, d: Math.hypot(px - qx, py - qy) };
  }

  /** Ray-casting point-in-polygon; point and poly in the same (normalized) space. */
  static pointInPoly(nx, ny, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > ny) !== (yj > ny)) && (nx < (xj - xi) * (ny - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  /** Triangle for an arrowhead pointing from a→b (tip at b), in the caller's
   *  coordinate space. `sizePx` is the tip-to-base length; the base half-width is
   *  ~0.55× that. Returns [tip, baseLeft, baseRight]; a zero-length a→b degrades to
   *  a horizontal head rather than NaN. */
  static arrowHead(ax, ay, bx, by, sizePx) {
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const cx = bx - dx * sizePx, cy = by - dy * sizePx;   // base centre, behind the tip
    const px = -dy, py = dx, half = sizePx * 0.55;         // unit perpendicular
    return [[bx, by], [cx + px * half, cy + py * half], [cx - px * half, cy - py * half]];
  }

  /** Keep a point inside a polygon: inside → unchanged, else nearest edge point. */
  static clampToPoly(nx, ny, poly) {
    if (Geom.pointInPoly(nx, ny, poly)) return [nx, ny];
    let best = Infinity, bx = nx, by = ny;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const pr = Geom.projSeg(nx, ny, a[0], a[1], b[0], b[1]);
      if (pr.d < best) { best = pr.d; bx = pr.x; by = pr.y; }
    }
    return [bx, by];
  }
}

/** Transient bottom-screen notification. */
class Toast {
  static _timer = null;
  static show(msg, err = false) {
    const t = Dom.$('#toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(Toast._timer);
    Toast._timer = setTimeout(() => { t.className = ''; }, 2200);
  }
}

/** Thin fetch wrapper. Throws on non-2xx so callers can try/catch. */
class Api {
  static async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  static async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
}
