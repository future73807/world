#!/usr/bin/env python3
"""Rebuild the 10 models that have no CC0 counterpart, matching the reference language.

Run with Blender:

  blender -b -noaudio --python world_v2/blender/rebuild_ten.py -- --plan
  blender -b -noaudio --python world_v2/blender/rebuild_ten.py -- --apply
  blender -b -noaudio --python world_v2/blender/rebuild_ten.py -- --apply coral_brain

Design notes, measured from the reference assets rather than guessed:

  tree_broadleaf_1  431 verts / 530 tris   (ratio 1.23)
  plant_bush_1      114 verts / 168 tris   (ratio 1.47)
  rock_boulder_3    200 verts / 168 tris   (ratio 0.84)

So the reference is *minimal*: a bush is 168 tris. An earlier attempt at this task built a
cactus at 2474 tris and it read worse than the 1064-tri original, because detail is not what
makes these models look right. What makes them look right is:

  1. a silhouette that reads at distance,
  2. a few large flat facets with hard normals (no smoothing),
  3. a mean albedo far darker than the scene, so the light does the modelling,
  4. one colour family per model, with value spread *inside* that family.

Each builder below states the tri budget it aims for and why. Nothing here touches the eight
KEEP assets (palms, cacti, snow pines, the elder tree) — those are the user's calls.
"""
from __future__ import annotations

import math
import os
import random
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, "..", ".."))
PREFAB_GLB = os.path.join(PROJECT, "app", "public", "models", "prefabs.glb")
TAU = math.pi * 2


# --------------------------------------------------------------------------- colour
def srgb(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def col(h):
    h = h.lstrip("#")
    return tuple(srgb(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] * (1 - t) + b[i] * t for i in range(3))


def hash1(x):
    return (math.sin(x * 127.1 + 311.7) * 43758.5453123) % 1.0


def axis_gradient(dark, mid, light=None, jitter=0.04):
    """Colour by how far along an axis a point sits — the reference paints this way.

    The reference's own trees vary value with height (light from above) and keep a single
    hue family. Reproducing that is most of the "look".
    """
    d, m = col(dark), col(mid)
    l = col(light) if light else m

    def paint(p, n):
        t = max(0.0, min(1.0, p.z / max(0.4, n)))
        out = mix(d, m, min(1.0, t * 1.6))
        out = mix(out, l, t * t * 0.7)
        k = 1 + (hash1(p.x * 7.1 + p.y * 13.7 + p.z * 19.3) - 0.5) * jitter
        return tuple(max(0.0, min(1.0, v * k)) for v in out)
    return paint


def flat_col(hexcol, jitter=0.03):
    base = col(hexcol)

    def paint(p, n):
        k = 1 + (hash1(p.x * 5.3 + p.z * 11.7) - 0.5) * jitter
        return tuple(max(0.0, min(1.0, v * k)) for v in base)
    return paint


# --------------------------------------------------------------------------- geometry kit
class Geo:
    def __init__(self):
        self.v = []
        self.f = []
        self.faces_colour = []   # per-face paint callable, so one mesh can hold several materials

    def add_face(self, idxs, paint):
        self.f.append(tuple(idxs))
        self.faces_colour.append(paint)

    def quad_strip(self, ring_a, ring_b, paint, closed=True):
        n = len(ring_a)
        rng = range(n) if closed else range(n - 1)
        for j in rng:
            k = (j + 1) % n
            self.add_face((ring_a[j], ring_a[k], ring_b[k], ring_b[j]), paint)

    def ring(self, centre, radius, sides, plane="xy", wobble=0.0, seed=0):
        rnd = random.Random(seed)
        ids = []
        for j in range(sides):
            a = j / sides * TAU
            r = radius * (1 + (rnd.random() - 0.5) * wobble * 2)
            c, s = math.cos(a) * r, math.sin(a) * r
            if plane == "xy":
                p = Vector((centre[0] + c, centre[1] + s, centre[2]))
            elif plane == "xz":
                p = Vector((centre[0] + c, centre[1], centre[2] + s))
            else:
                p = Vector((centre[0], centre[1] + c, centre[2] + s))
            ids.append(len(self.v))
            self.v.append(p)
        return ids

    def cone_cap(self, ring_ids, apex, paint, outward=True):
        tip = len(self.v)
        self.v.append(Vector(apex))
        n = len(ring_ids)
        for j in range(n):
            k = (j + 1) % n
            self.add_face((tip, ring_ids[j], ring_ids[k]) if outward else (tip, ring_ids[k], ring_ids[j]), paint)

    def fan_cap(self, ring_ids, centre, paint, outward=True):
        c = len(self.v)
        self.v.append(Vector(centre))
        n = len(ring_ids)
        for j in range(n):
            k = (j + 1) % n
            self.add_face((c, ring_ids[j], ring_ids[k]) if outward else (c, ring_ids[k], ring_ids[j]), paint)


def blob_geo(geo, loc, scale, paint, sub=1, rough=0.12, seed=0, sink=0.5):
    """A faceted rounded mass. sub=1 gives 80 faces — the reference's bush is about this."""
    rnd = random.Random(seed)
    t = (1 + 5 ** 0.5) / 2
    base = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0),
            (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
            (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
             (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
             (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
             (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    pts = [Vector(p).normalized() for p in base]
    if sub >= 1:
        mids = {}
        out = []
        for a, b, c in faces:
            def m(i, j):
                key = (min(i, j), max(i, j))
                if key not in mids:
                    mids[key] = len(pts)
                    pts.append(((pts[i] + pts[j]) / 2).normalized())
                return mids[key]
            ab, bc, ca = m(a, b), m(b, c), m(c, a)
            out += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = out
    ids = []
    sx, sy, sz = scale
    # squash the underside so it sits on the ground instead of hovering
    for p in pts:
        k = 1 + (rnd.random() - 0.5) * rough * 2
        z = p.z * sz * k
        if p.z < 0:
            z *= sink
        ids.append(len(geo.v))
        geo.v.append(Vector((loc[0] + p.x * sx * k, loc[1] + p.y * sy * k, loc[2] + z)))
    for f in faces:
        geo.add_face(tuple(ids[i] for i in f), paint)


def tube_geo(geo, path, radii, paint, sides=6):
    pts = [Vector(p) for p in path]
    rings = []
    for i, p in enumerate(pts):
        if i == 0:
            d = pts[1] - pts[0]
        elif i == len(pts) - 1:
            d = pts[-1] - pts[-2]
        else:
            d = pts[i + 1] - pts[i - 1]
        d.normalize()
        up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        xa = d.cross(up).normalized()
        ya = d.cross(xa).normalized()
        r = radii[i] if isinstance(radii, list) else radii
        ring = []
        for j in range(sides):
            a = j / sides * TAU
            ring.append(len(geo.v))
            geo.v.append(p + xa * (math.cos(a) * r) + ya * (math.sin(a) * r))
        rings.append(ring)
    for i in range(len(rings) - 1):
        geo.quad_strip(rings[i], rings[i + 1], paint)
    geo.fan_cap(rings[0], pts[0], paint, outward=False)
    geo.fan_cap(rings[-1], pts[-1], paint, outward=True)


# --------------------------------------------------------------------------- the ten
def coral_branch():
    """0.5 x 1.1 BU. Reference budget: ~300-500 tris. A trunk with three forks, tapered."""
    g = Geo()
    rnd = random.Random(71)
    paint = axis_gradient("#4e1a24", "#a3455a", "#d97b8c")

    def grow(start, direction, length, radius, depth):
        end = start + direction.normalized() * length
        mid = start.lerp(end, 0.55) + Vector((0, 0, length * 0.10))
        tube_geo(g, [start, mid, end], [radius, radius * 0.72, radius * 0.40], paint, sides=5)
        if depth:
            for k in range(2):
                a = rnd.uniform(0, TAU)
                nd = (direction * 0.45 + Vector((math.cos(a) * 0.75, math.sin(a) * 0.75, rnd.uniform(0.3, 0.9)))).normalized()
                grow(end, nd, length * rnd.uniform(0.6, 0.76), radius * 0.62, depth - 1)

    grow(Vector((0, 0, 0)), Vector((0, 0, 1)), 0.50, 0.115, 3)
    return g


def coral_brain():
    """1.1 x 0.34 x 0.94 BU, a flattened dome. Reference budget ~200-320 tris.

    The grooves are what name it, but geometry grooves cost a lot of faces. The reference
    solves this by painting value bands, so this keeps a low-poly dome and darkens along the
    grooves in the vertex colour instead of extruding them.
    """
    g = Geo()
    base = axis_gradient("#4a325c", "#8e6fae", "#c0a3d8")
    dome = axis_gradient("#3f2a52", "#7d5e9c", "#b092c8")

    def grooved(p, n):
        # a travelling band pattern, cheap and it reads as the brain's folds
        wave = 0.5 + 0.5 * math.sin(math.atan2(p.y, p.x) * 5.0 + p.x * 4.0)
        c = dome(p, n)
        k = 0.62 + 0.38 * wave
        return (c[0] * k, c[1] * k, c[2] * k)

    rings = 5
    sides = 18
    ring_ids = []
    for i in range(rings):
        t = i / (rings - 1)
        r = 0.55 * math.cos(t * math.pi * 0.5) ** 0.72
        z = 0.05 + t * 0.30
        ring_ids.append(g.ring((0, 0, z), max(0.02, r), sides, wobble=0.05, seed=i))
    for i in range(rings - 1):
        g.quad_strip(ring_ids[i], ring_ids[i + 1], grooved)
    g.fan_cap(ring_ids[0], (0, 0, 0.02), base, outward=False)
    g.fan_cap(ring_ids[-1], (0, 0, 0.35), grooved, outward=True)
    # a few lobe bumps on top for silhouette
    for i in range(5):
        a = i / 5 * TAU + 0.5
        blob_geo(g, (math.cos(a) * 0.30, math.sin(a) * 0.30, 0.26),
                 (0.17, 0.17, 0.09), grooved, sub=0, rough=0.10, seed=30 + i, sink=0.6)
    return g


def coral_fan():
    """1.02 x 1.2 x 0.07 BU, a flat sea fan. Reference budget ~250-400 tris.

    The old one was 9 thin cylinders — 1140 tris spent on tubes that read as wire. A fan reads
    as a fan when it is a flat mesh with a notched edge, so this builds two-sided ribbon
    strips between radiating ribs.
    """
    g = Geo()
    paint = axis_gradient("#5c2a1a", "#a85a2c", "#d98f4e")
    rib_paint = axis_gradient("#4a2013", "#8a4520", "#b87236")
    ribs = 9
    apex = Vector((0, 0, 0.03))
    tips = []
    for i in range(ribs):
        t = i / (ribs - 1)
        x = (t - 0.5) * 0.98
        z = 0.42 + 0.72 * math.sin(math.pi * (0.18 + 0.64 * t))
        tips.append(Vector((x, 0, z)))
    # membrane: a strip from apex up through two rows to the notched rim
    row1 = [Vector((v.x * 0.42, 0, 0.02 + v.z * 0.55)) for v in tips]
    row2 = [Vector((v.x * 0.78, 0, 0.02 + v.z * 0.86)) for v in tips]
    prog = []
    for seq, first in ((row1, True), (row2, False)):
        ids = []
        for p in seq:
            ids.append(len(g.v))
            g.v.append(p)
        prog.append(ids)
    ap = len(g.v)
    g.v.append(apex)
    for j in range(ribs - 1):
        g.add_face((ap, prog[0][j], prog[0][j + 1]), paint)
        g.add_face((prog[0][j], prog[1][j], prog[1][j + 1], prog[0][j + 1]), paint)
    # ribs stand proud of the membrane: a thin quad per rib, which is the silhouette
    for i, tip in enumerate(tips):
        a = len(g.v)
        b = len(g.v) + 1
        g.v.append(Vector((tip.x * 0.96, -0.012, tip.z * 0.97)))
        g.v.append(Vector((tip.x * 0.96, 0.012, tip.z * 0.97)))
        top = len(g.v)
        g.v.append(tip)
        g.add_face((a, b, top), rib_paint)
    return g


def beach_starfish():
    """0.62 x 0.08 x 0.65 BU. Reference budget: this is 40 tris today; ~80 is plenty.

    Five arms with a raised centre ridge, painted darker toward the tips — the reference
    starfish read comes from the value falloff, not from geometry.
    """
    g = Geo()
    paint = axis_gradient("#7a3418", "#c46a2c", "#e8a05a")
    arms = 5
    outer, inner = 0.32, 0.13
    top_ids, bot_ids = [], []
    for i in range(arms * 2):
        a = i / (arms * 2) * TAU + math.pi / 2
        r = outer if i % 2 == 0 else inner
        top_ids.append(len(g.v))
        g.v.append(Vector((math.cos(a) * r, math.sin(a) * r, 0.05 if i % 2 == 0 else 0.035)))
        bot_ids.append(len(g.v))
        g.v.append(Vector((math.cos(a) * r * 0.94, math.sin(a) * r * 0.94, 0.0)))
    n = len(top_ids)
    for j in range(n):
        k = (j + 1) % n
        g.add_face((top_ids[j], top_ids[k], bot_ids[k], bot_ids[j]), paint)
    g.fan_cap(top_ids, (0, 0, 0.075), paint, outward=True)
    g.fan_cap(bot_ids, (0, 0, 0.0), paint, outward=False)
    return g


def desert_mesa():
    """3.7 x 2.3 x 3.8 BU, a layered rock butte. Reference budget ~200-320 tris.

    The old one was 490 tris of smooth mound. A mesa reads as a mesa because of the flat top
    and the stepped strata, both of which are cheap: flat rings at different radii.
    """
    g = Geo()
    paint = axis_gradient("#5e3524", "#a8683f", "#cf9257")
    strata = [(2.02, 0.00), (1.94, 0.28), (1.60, 0.34), (1.52, 0.86),
              (1.14, 0.92), (1.06, 1.52), (0.72, 1.58), (0.62, 2.06), (0.40, 2.10)]
    sides = 11
    rings = []
    rnd = random.Random(52)
    for i, (r, z) in enumerate(strata):
        rings.append(g.ring((0, 0, z), r, sides, wobble=0.07, seed=i))
    for i in range(len(rings) - 1):
        g.quad_strip(rings[i], rings[i + 1], paint)
    g.fan_cap(rings[0], (0, 0, 0.0), paint, outward=False)
    g.fan_cap(rings[-1], (0, 0, 2.22), paint, outward=True)
    # a few boulders at the foot, the reference always breaks a big mass with small ones
    for i in range(4):
        a = rnd.uniform(0, TAU)
        d = rnd.uniform(1.7, 2.1)
        blob_geo(g, (math.cos(a) * d, math.sin(a) * d, 0.14),
                 (0.28, 0.26, 0.20), paint, sub=0, rough=0.22, seed=70 + i)
    return g


def landmark_obelisk():
    """2.6 x 6.4 x 1.7 BU. Reference budget ~250-400 tris.

    Keeps the four-sided tapered shaft (it is a landmark, the silhouette is the point) and
    replaces the old thin ring bands with real stepped collars, which read at distance.
    """
    g = Geo()
    paint = axis_gradient("#5a3320", "#a06a3d", "#c99a63")
    dark = flat_col("#4a2a1a")
    profile = [(1.20, 0.0), (1.06, 0.30), (0.92, 0.62), (0.86, 4.55),
               (0.72, 4.95), (0.50, 5.55), (0.26, 6.10), (0.10, 6.35)]
    sides = 4
    rings = []
    for i, (r, z) in enumerate(profile):
        rings.append(g.ring((0, 0, z), r, sides, wobble=0.03, seed=i))
    for i in range(len(rings) - 1):
        p = dark if i in (1, 3, 5) else paint
        g.quad_strip(rings[i], rings[i + 1], p)
    g.fan_cap(rings[0], (0, 0, 0.0), paint, outward=False)
    g.cone_cap(rings[-1], (0, 0, 6.42), paint)
    # base plinth
    pl = g.ring((0, 0, 0.16), 1.36, 8, wobble=0.04, seed=9)
    pl2 = g.ring((0, 0, 0.0), 1.44, 8, wobble=0.05, seed=10)
    g.quad_strip(pl, pl2, dark)
    g.fan_cap(pl, (0, 0, 0.16), dark, outward=True)
    return g


def landmark_ribs():
    """5.2 x 5.6 x 4.4 BU, a whale ribcage. Reference budget ~350-500 tris.

    The old one spent 2192 tris on smooth tubes. The shape that matters is the *arch* and the
    *gap* under it, so this uses fewer, thicker, faceted ribs and keeps the spine.
    """
    g = Geo()
    paint = axis_gradient("#8d8368", "#d8cfae", "#f2ead0")
    for y in (-0.80, 0.80):
        path = [(-2.50, y, 0.05), (-2.15, y, 1.95), (-1.35, y, 3.85),
                (0, y, 4.85), (1.35, y, 3.85), (2.15, y, 1.95), (2.50, y, 0.05)]
        tube_geo(g, path, [0.30, 0.26, 0.23, 0.20, 0.23, 0.26, 0.30], paint, sides=7)
    # spine along the top
    tube_geo(g, [(0, -1.9, 4.72), (0, -0.8, 4.92), (0, 0.8, 4.92), (0, 1.9, 4.72)],
             [0.17, 0.21, 0.21, 0.17], paint, sides=6)
    # middle ribs, each a single arc from spine to ground — fewer and thicker than before
    for y in (-1.30, -0.45, 0.45, 1.30):
        for s in (-1, 1):
            path = [(s * 1.95, y, 0.16), (s * 1.58, y, 1.45), (s * 0.86, y, 2.95), (0, y, 4.05)]
            tube_geo(g, path, [0.19, 0.15, 0.11, 0.07], paint, sides=5)
    # the pelvis scoop at the front
    tube_geo(g, [(-2.05, -2.05, 0.28), (-1.25, -2.30, 0.58), (0, -2.42, 0.76),
                 (1.25, -2.30, 0.58), (2.05, -2.05, 0.28)],
             [0.24, 0.29, 0.34, 0.29, 0.24], paint, sides=7)
    blob_geo(g, (0, -2.38, 0.78), (0.58, 0.48, 0.40), paint, sub=1, rough=0.10, seed=5)
    return g


def landmark_vent():
    """4.4 x 3.2 x 4.4 BU, a volcanic vent. Reference budget ~300-450 tris.

    The glow is a separate `__glow` mesh in this project's convention, so the stone here
    stays neutral basalt and the lava goes to its own piece.
    """
    g = Geo()
    stone = axis_gradient("#1c1c22", "#43434d", "#6a6a76")
    profile = [(2.05, 0.0), (2.30, 0.42), (1.88, 1.28), (1.20, 2.28), (0.96, 2.72),
               (0.66, 2.42), (0.50, 2.10)]
    sides = 12
    rings = []
    for i, (r, z) in enumerate(profile):
        rings.append(g.ring((0, 0, z), r, sides, wobble=0.10, seed=7 + i))
    for i in range(len(rings) - 1):
        g.quad_strip(rings[i], rings[i + 1], stone)
    g.fan_cap(rings[0], (0, 0, 0.0), stone, outward=False)
    g.fan_cap(rings[-1], (0, 0, 2.02), stone, outward=True)
    # broken spikes round the crater lip
    rnd = random.Random(411)
    for i in range(9):
        a = i / 9 * TAU + rnd.uniform(-0.12, 0.12)
        d = rnd.uniform(0.90, 1.30)
        hh = rnd.uniform(0.36, 0.86)
        r = rnd.uniform(0.16, 0.26)
        base = (math.cos(a) * d, math.sin(a) * d, 2.20)
        ring = g.ring(base, r, 5, wobble=0.10, seed=i)
        g.cone_cap(ring, (base[0], base[1], 2.20 + hh), stone)
    return g


def vent_glow():
    """The lava: a disc in the crater plus four drips down the outside."""
    g = Geo()
    lava = flat_col("#ff6a1a", 0.04)
    r_out = g.ring((0, 0, 2.19), 0.60, 12)
    r_in = g.ring((0, 0, 2.31), 0.34, 12)
    g.quad_strip(r_out, r_in, lava)
    g.fan_cap(r_in, (0, 0, 2.32), lava)
    for i in range(4):
        a = i / 4 * TAU + 0.4
        path = [(math.cos(a) * 0.62, math.sin(a) * 0.62, 2.18),
                (math.cos(a + 0.2) * 1.10, math.sin(a + 0.2) * 1.10, 1.45),
                (math.cos(a + 0.32) * 1.66, math.sin(a + 0.32) * 1.66, 0.58)]
        tube_geo(g, path, [0.055, 0.038, 0.012], lava, sides=4)
    return g


def swamp_mushroom(giant=True):
    """Giant: 2.2 x 3.1 x 2.2 BU. Small: 1.2 x 1.7 x 1.2. ~250-400 tris.

    The reference mushroom language: a clean dome cap with visible gill under-edge and a
    bulbous stalk. The old one was 861 tris of noisy lump; this is simpler and reads better.
    """
    g = Geo()
    # cap_r is a RADIUS; the manifest size is a diameter, so these are half of
    # the original 2.19 / 1.17 widths. Getting this wrong made the giant mushroom
    # twice the size it must be and would have broken the swamp scale.
    if giant:
        h, cap_r, cap_h, stalk_r = 3.05, 1.08, 0.66, 0.36
    else:
        h, cap_r, cap_h, stalk_r = 1.68, 0.58, 0.40, 0.22
    stalk = axis_gradient("#6b5533", "#c9b487", "#e8d7ac")
    cap_top = axis_gradient("#243f2c", "#487a4a", "#6fa863")
    gill = axis_gradient("#8a7a56", "#cbbd93", "#e6d9b4")

    # stalk: swollen at the base, tapering under the cap
    rings = []
    for i in range(5):
        t = i / 4
        r = stalk_r * (1.42 - t * 0.62)
        rings.append(g.ring((0, 0, t * (h - cap_h * 0.2)), r, 9, wobble=0.05, seed=i))
    for i in range(len(rings) - 1):
        g.quad_strip(rings[i], rings[i + 1], stalk)
    g.fan_cap(rings[0], (0, 0, 0.0), stalk, outward=False)

    # cap: a dome that overhangs, with a separate gill ring under the rim
    cap_z = h - cap_h * 0.1
    dome = []
    for i in range(4):
        t = i / 3
        r = cap_r * math.cos(t * math.pi * 0.42)
        dome.append(g.ring((0, 0, cap_z + t * cap_h), max(0.05, r), 12, wobble=0.03, seed=20 + i))
    for i in range(len(dome) - 1):
        g.quad_strip(dome[i], dome[i + 1], cap_top)
    g.fan_cap(dome[-1], (0, 0, cap_z + cap_h * 1.04), cap_top)
    # gill / under-edge: a short cone back to the stalk
    under = g.ring((0, 0, cap_z - cap_h * 0.16), cap_r * 0.94, 12, wobble=0.02, seed=31)
    neck = g.ring((0, 0, cap_z - cap_h * 0.06), stalk_r * 0.86, 9, wobble=0.02, seed=32)
    g.quad_strip(under, dome[0], cap_top)
    g.quad_strip(neck, under, gill)
    # a few pale spots on the cap, the reference does this with colour not geometry
    for i in range(5 if giant else 3):
        a = i / (5 if giant else 3) * TAU + 0.7
        blob_geo(g, (math.cos(a) * cap_r * 0.52, math.sin(a) * cap_r * 0.52, cap_z + cap_h * 0.82),
                 (0.13, 0.13, 0.05), gill, sub=0, rough=0.1, seed=50 + i)
    return g


BUILDERS = {
    "coral_branch": coral_branch,
    "coral_brain": coral_brain,
    "coral_fan": coral_fan,
    "beach_starfish": beach_starfish,
    "desert_mesa": desert_mesa,
    "landmark_obelisk": landmark_obelisk,
    "landmark_ribs": landmark_ribs,
    "landmark_vent": landmark_vent,
    "swamp_mushroom_a": lambda: swamp_mushroom(True),
    "swamp_mushroom_b": lambda: swamp_mushroom(False),
}
GLOW = {"landmark_vent": vent_glow}


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    apply = "--apply" in argv
    wanted = [a for a in argv if a in BUILDERS] or sorted(BUILDERS)
    print(f"[ten] {len(wanted)}: {', '.join(wanted)}", flush=True)
    if not apply:
        return 0

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=PREFAB_GLB)
    existing = {o.name: o for o in bpy.data.objects if o.type == "MESH"}

    def free(name):
        ob = existing.get(name)
        if not ob:
            return
        me = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if me and me.users == 0:
            bpy.data.meshes.remove(me)

    def make(mid, geo, suffix=""):
        me = bpy.data.meshes.new(mid + suffix)
        me.from_pydata([tuple(v) for v in geo.v], [], list(geo.f))
        me.validate()
        me.update()
        ca = me.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
        for poly in me.polygons:
            poly.use_smooth = False
            paint = geo.faces_colour[poly.index]
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                c = paint(geo.v[vi], max(0.6, max(v.z for v in geo.v)))
                ca.data[li].color = [c[0], c[1], c[2], 1.0]
        ob = bpy.data.objects.new(mid + suffix, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.name = mid + suffix
        me.name = mid + suffix
        return ob

    for mid in wanted:
        geo = BUILDERS[mid]()
        free(mid)
        free(mid + "__lod1")
        ob = make(mid, geo)
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        print(f"[ten] {mid}: {len(ob.data.vertices)} verts, {tris} tris", flush=True)
        # LOD twin
        lod_me = ob.data.copy()
        lod_me.name = mid + "__lod1"
        lod = bpy.data.objects.new(mid + "__lod1", lod_me)
        bpy.context.scene.collection.objects.link(lod)
        m = lod.modifiers.new("dec", "DECIMATE")
        m.ratio = 0.30
        bpy.context.view_layer.objects.active = lod
        bpy.ops.object.select_all(action="DESELECT")
        lod.select_set(True)
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.shade_flat()
        # glow piece, if this model has one
        if mid in GLOW:
            free(mid + "__glow")
            free(mid + "__glow__lod1")
            gob = make(mid, GLOW[mid](), "__glow")
            ltris = sum(len(p.vertices) - 2 for p in gob.data.polygons)
            print(f"[ten] {mid}__glow: {ltris} tris", flush=True)

    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.select_set(True)
    bpy.context.view_layer.objects.active = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=PREFAB_GLB, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_materials="NONE",
        export_vertex_color="ACTIVE", export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False, export_extras=True,
    )
    print(f"[ten] re-exported", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
