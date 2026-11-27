#!/usr/bin/env python3
"""Sculpt the five remaining models with a displaced continuous surface.

Run with Blender:

  blender -b -noaudio --python world_v2/blender/sculpt_five.py -- --plan
  blender -b -noaudio --python world_v2/blender/sculpt_five.py -- --apply
  blender -b -noaudio --python world_v2/blender/sculpt_five.py -- --apply landmark_vent

Why this method, and where it applies.

Three earlier approaches were tried on this repo:
  * assemble primitives  -> reads as an assembly, not a surface
  * procedural branching -> the corals read as brooms
  * displace a continuous grid -> worked for coral_brain / coral_fan / beach_starfish

The last one is used here. Each model is one continuous quad surface displaced by a field
function, with the shading driven by the same field so the dark bands sit in real troughs.

The five remaining models were each diagnosed from a render of the *current* version first;
what they actually suffer from is not "ugly" but three fixable things:

  landmark_vent   the lava tubes taper to 0.01 and stick out like spider legs; the stone
                  body is one smooth cone; the crater disc floats free of the rim
  landmark_ribs   even, uniform tubes: no rib-to-rib variety and no mass at the joints
  landmark_obelisk one smooth tapered slab with small bumps; no stepped strata
  desert_mesa     a smooth mound; the strata rings are painted on, not cut in
  coral_branch    two forks of thin tube; no taper rhythm and no polyp texture

Budgets stay near the originals so the LOD ring and the perf numbers do not move.
"""
from __future__ import annotations

import math
import os
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


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a + 1e-9)))
    return t * t * (3 - 2 * t)


# --------------------------------------------------------------------------- surface
class Surface:
    """One continuous quad surface. Rows are added in order; `stitch` joins them."""

    def __init__(self, per_row: int, wrap: bool = True):
        self.per_row = per_row
        self.wrap = wrap
        self.pts: list[Vector] = []
        self.cols: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, ...]] = []

    def row(self, pts: list[Vector], cols: list[tuple]):
        base = len(self.pts)
        self.pts.extend(pts)
        self.cols.extend(cols)
        return base

    def stitch(self):
        rows = len(self.pts) // self.per_row
        last = self.per_row if self.wrap else self.per_row - 1
        for r in range(rows - 1):
            a0, b0 = r * self.per_row, (r + 1) * self.per_row
            for j in range(last):
                k = (j + 1) % self.per_row
                self.faces.append((a0 + j, a0 + k, b0 + k, b0 + j))

    def cap(self, row_index: int, apex: Vector, colour, outward=True):
        tip = len(self.pts)
        self.pts.append(apex)
        self.cols.append(colour)
        base = row_index * self.per_row
        for j in range(self.per_row):
            k = (j + 1) % self.per_row
            self.faces.append((tip, base + j, base + k) if outward else (tip, base + k, base + j))


# --------------------------------------------------------------------------- 1. vent
def rock_radius(a: float, t: float) -> tuple[float, float]:
    """The vent's rock surface: radius and height at angle `a`, height parameter `t`.

    Shared by the rock and by the lava channels, which is what guarantees the lava lies on
    the stone instead of floating in front of it.
    """
    base_r = 2.16 - 1.34 * (t ** 0.86)
    if t > 0.86:
        base_r *= 0.74
    gully = 0.5 + 0.5 * math.sin(a * 9.0 + t * 2.1)
    bulge = 0.5 + 0.5 * math.sin(a * 3.0 - 0.7)
    disp = 1.0 + 0.085 * gully + 0.055 * bulge
    return base_r * disp, t * 2.62 + 0.05 * math.sin(a * 7.0) * (t ** 2)


def vent_body(glow: bool):
    """A volcanic vent: a rough cone with a broken crater lip.

    Fixes over the current model: the body is one displaced surface (so the silhouette is
    irregular instead of a clean cone), the crater rim is ragged, and the lava now runs in
    channels cut into the flank rather than in free-standing spikes.
    """
    s = Surface(20)
    if glow:
        dark, mid, light = col("#c2410c"), col("#ff7a18"), col("#ffb347")
    else:
        dark, mid, light = col("#191920"), col("#42424e"), col("#6b6b7a")

    rings = 9
    for i in range(rings):
        t = i / (rings - 1)
        row_p, row_c = [], []
        for j in range(s.per_row):
            a = j / s.per_row * TAU
            r, zz = rock_radius(a, t)
            p = Vector((math.cos(a) * r, math.sin(a) * r, zz))
            # shade by height and by how recessed this point is
            lift = 0.5 + 0.5 * math.sin(a * 9.0 + t * 2.1)
            base = mix(dark, mid, 0.25 + 0.55 * t)
            base = mix(base, light, (lift ** 2) * 0.45 * (0.3 + 0.7 * t))
            k = 1 + (hash1(p.x * 11.3 + p.y * 7.7 + t) - 0.5) * 0.06
            row_c.append(tuple(max(0.0, min(1.0, v * k)) for v in base))
            row_p.append(p)
        s.row(row_p, row_c)
    s.stitch()
    s.cap(0, Vector((0, 0, 0.0)), dark, outward=False)
    # the crater floor: a bowl that connects the lip to the inner wall (was floating)
    s2_top = (rings - 1) * s.per_row
    inner = []
    inner_c = []
    for j in range(s.per_row):
        a = j / s.per_row * TAU
        r = 0.52 * (1 + 0.10 * math.sin(a * 5.0))
        p = Vector((math.cos(a) * r, math.sin(a) * r, 2.05))
        inner.append(p)
        inner_c.append(mix(dark, mid, 0.55))
    s.row(inner, inner_c)
    s.stitch()
    s.cap(rings, Vector((0, 0, 1.92)), dark, outward=True)
    return s


def vent_lava():
    """Lava: a pool in the crater, and channels that hug the rock flank.

    The two earlier versions made the channels a separate offset cylinder, so they floated
    off the wall and read as ribbons. This samples the *same* radius formula the rock uses
    (`rock_radius`), scaled by 1.006, so a channel is a thin skin lying on the stone.
    """
    hot, mid, dark = col("#ffd27a"), col("#ff7a18"), col("#b4330a")
    parts = []

    # --- pool: fills the crater floor
    pool = Surface(20)
    for i in range(3):
        t = i / 2
        r = 0.52 * (1 - t * 0.86)
        z = 2.04 - t * 0.10
        row_p, row_c = [], []
        for j in range(pool.per_row):
            a = j / pool.per_row * TAU
            row_p.append(Vector((math.cos(a) * r, math.sin(a) * r, z)))
            row_c.append(mix(hot, mid, t * 0.6))
        pool.row(row_p, row_c)
    pool.stitch()
    pool.cap(0, Vector((0, 0, 1.93)), mid, outward=False)
    parts.append(pool)

    # --- four channels, each a 7-wide strip sampled off the rock surface
    for ch in range(4):
        strip = Surface(5, wrap=False)
        a0 = ch / 4 * TAU + 0.35
        rows = 9
        for i in range(rows):
            # start below the lip so the crater pool stays visible from above
            t = 0.80 - i / (rows - 1) * 0.74
            row_p, row_c = [], []
            for j in range(5):
                a = a0 + (j - 2) * 0.055
                r, z = rock_radius(a, t)
                # 1.006: a skin on the stone, not a body in front of it
                rr = r * 1.006
                zz = z + 0.012
                row_p.append(Vector((math.cos(a) * rr, math.sin(a) * rr, zz)))
                edge = abs(j - 2) / 2.0
                # hotter at the lip, cooling as it runs down, dark at the channel edges
                row_c.append(mix(hot, dark, 0.08 + 0.50 * (i / (rows - 1)) + 0.30 * edge))
            strip.row(row_p, row_c)
        strip.stitch()
        parts.append(strip)

    return parts


# --------------------------------------------------------------------------- 2. ribs
def ribs():
    """A whale ribcage: rib thickness and spacing vary, with mass where ribs meet the spine.

    The current model is a uniform set of tubes. Real ribcages have a heavy arched pair at the
    front, thinning ribs behind, and a spine that visibly knuckles where each rib joins.
    """
    s = Surface(9)          # 9 points around each tube, as a grid
    bone_d, bone_m, bone_l = col("#8d8368"), col("#cfc5a4"), col("#f2ead0")

    def shade(t_height, out_facing, seed):
        base = mix(bone_d, bone_m, 0.30 + 0.5 * t_height)
        base = mix(base, bone_l, (out_facing ** 2) * 0.4)
        k = 1 + (hash1(seed * 13.7) - 0.5) * 0.05
        return tuple(max(0.0, min(1.0, v * k)) for v in base)

    def rib_arc(y, span, height, radius, sides_seed):
        rows = 9
        for i in range(rows):
            t = i / (rows - 1)
            # an arc from one foot, over the top, down to the other
            a = math.pi * t
            x = -math.cos(a) * span
            z = math.sin(a) * height
            # the rib is thickest low and at the top, thin on the flanks
            r = radius * (0.62 + 0.55 * (abs(math.cos(a)) ** 0.6))
            row_p, row_c = [], []
            for j in range(s.per_row):
                ang = j / s.per_row * TAU
                # the tube's own cross-section, squashed a little front-to-back
                p = Vector((x, y + math.cos(ang) * r * 0.78, z + math.sin(ang) * r))
                facing = max(0.0, math.sin(ang) * 0.5 + 0.5)
                row_p.append(p)
                row_c.append(shade(t, facing, sides_seed + i + j))
            s.row(row_p, row_c)
        s.stitch()
        s.cap(0, Vector((-span, y, 0)), bone_d, outward=False)
        s.cap(rows - 1, Vector((span, y, 0)), bone_d, outward=True)

    # two heavy front ribs, three lighter ones behind
    for k, (y, span, height, radius) in enumerate([
        (-0.85, 2.42, 4.62, 0.28),
        (0.85, 2.42, 4.62, 0.28),
        (-1.45, 1.92, 3.72, 0.19),
        (-0.45, 2.06, 4.06, 0.21),
        (0.45, 2.02, 3.98, 0.20),
        (1.40, 1.86, 3.58, 0.18),
    ]):
        rib_arc(y, span, height, radius, seed_base := 100 + k * 17)
    return s


# --------------------------------------------------------------------------- 3. obelisk
def obelisk():
    """A weathered standing stone: stepped strata cut into the shaft, eroded edges.

    The current model is one smooth tapered slab. The reference language cuts the mass into
    readable bands, so this displaces the shaft by a stepped field and erodes the corners.
    """
    s = Surface(8)          # eight-sided, so the corners read as facets
    d, m, l = col("#5a3320"), col("#a06a3d"), col("#c99a63")

    profile = [(1.20, 0.00), (1.10, 0.26), (0.94, 0.58), (0.90, 1.55),
               (0.84, 1.62), (0.80, 2.70), (0.74, 2.78), (0.70, 3.85),
               (0.64, 3.93), (0.62, 4.90), (0.56, 4.98), (0.44, 5.60),
               (0.22, 6.12), (0.10, 6.34)]
    for i, (r, z) in enumerate(profile):
        row_p, row_c = [], []
        for j in range(s.per_row):
            a = j / s.per_row * TAU + math.pi / 8
            # erosion: knock the corners back and add surface grain
            corner = abs(math.cos(a * 2)) ** 1.5
            erode = 1.0 - 0.055 * corner * smoothstep(0.0, 3.0, z)
            grain = 1.0 + (hash1(j * 7.3 + i * 3.1) - 0.5) * 0.05
            rr = r * erode * grain
            p = Vector((math.cos(a) * rr, math.sin(a) * rr, z))
            # each step face is lighter on top, darker in the recess
            band = (z / 1.08) % 1.0
            lift = smoothstep(0.55, 1.0, band) if i % 2 == 1 else 0.15
            base = mix(d, l, 0.22 + 0.45 * (z / 6.4) + 0.30 * lift)
            row_p.append(p)
            row_c.append(tuple(max(0.0, min(1.0, v)) for v in base))
        s.row(row_p, row_c)
    s.stitch()
    s.cap(0, Vector((0, 0, 0.0)), d, outward=False)
    s.cap(len(profile) - 1, Vector((0, 0, 6.42)), l, outward=True)
    return s


# --------------------------------------------------------------------------- 4. mesa
def mesa():
    """A layered butte: the strata are cut steps in the surface, not painted rings.

    The current model is a smooth mound with colour bands. Here the radius steps in hard at
    each stratum so the silhouette itself is stepped, which is what reads from a distance.
    """
    s = Surface(14)
    d, m, l = col("#5e3524"), col("#a8683f"), col("#cf9257")

    def profile_at(t):
        # four strata, each a near-vertical wall then a flat shelf
        strata = [(0.00, 2.02), (0.10, 2.00), (0.14, 1.72), (0.16, 1.70),
                  (0.34, 1.68), (0.38, 1.38), (0.40, 1.36), (0.60, 1.34),
                  (0.64, 1.02), (0.66, 1.00), (0.84, 0.98), (0.88, 0.70),
                  (0.90, 0.68), (1.00, 0.44)]
        for k in range(len(strata) - 1):
            t0, r0 = strata[k]
            t1, r1 = strata[k + 1]
            if t0 <= t <= t1:
                f = 0.0 if t1 - t0 < 1e-6 else (t - t0) / (t1 - t0)
                return r0 + (r1 - r0) * f, k
        return strata[-1][1], len(strata) - 1

    rings = 22
    for i in range(rings):
        t = i / (rings - 1)
        r_base, band = profile_at(t)
        z = t * 2.20
        row_p, row_c = [], []
        for j in range(s.per_row):
            a = j / s.per_row * TAU
            # erosion: vertical runnels and a slow lobe, stronger on the lower strata
            runnel = 0.5 + 0.5 * math.sin(a * 11.0)
            lobe = 0.5 + 0.5 * math.sin(a * 3.0 + 1.2)
            disp = 1 + (0.055 * runnel + 0.04 * lobe) * (1 - t * 0.5)
            # boulders at the foot break the base ring up
            boulder = 0.0
            if t < 0.10:
                boulder = 0.10 * smoothstep(0.10, 0.0, t) * (0.5 + 0.5 * math.sin(a * 5.0))
            r = r_base * disp + boulder
            p = Vector((math.cos(a) * r, math.sin(a) * r, z))
            # shade by stratum: the wall of each step is dark, the shelf is lit
            wall = 1.0 if (band % 4) in (1, 2) else 0.0
            base = mix(d, m, 0.28 + 0.45 * t)
            base = mix(base, l, (0.30 if wall else 0.62) * (0.4 + 0.6 * t))
            k = 1 + (hash1(p.x * 9.7 + p.y * 13.1) - 0.5) * 0.05
            row_p.append(p)
            row_c.append(tuple(max(0.0, min(1.0, v * k)) for v in base))
        s.row(row_p, row_c)
    s.stitch()
    s.cap(0, Vector((0, 0, 0.0)), d, outward=False)
    s.cap(rings - 1, Vector((0, 0, 2.26)), l, outward=True)
    return s


# --------------------------------------------------------------------------- 5. coral branch
def coral_branch():
    """A branching coral: tapered limbs with a visible polyp rhythm on the surface.

    The current model is two forks of smooth tube. The reference corals have a knobbly
    surface, so each limb here is a displaced tube: radius varies along the limb and the
    cross-section is lumped rather than round.
    """
    s = Surface(7)
    d, m, l = col("#4e1a24"), col("#a3455a"), col("#d97b8c")

    def limb(p0, p1, r0, r1, seed):
        rows = 7
        seg = p1 - p0
        up = Vector((0, 0, 1)) if abs(seg.normalized().z) < 0.92 else Vector((1, 0, 0))
        xa = seg.normalized().cross(up).normalized()
        ya = seg.normalized().cross(xa).normalized()
        for i in range(rows):
            t = i / (rows - 1)
            centre = p0.lerp(p1, t)
            r = r0 + (r1 - r0) * (t ** 0.8)
            row_p, row_c = [], []
            for j in range(s.per_row):
                a = j / s.per_row * TAU
                # polyp lumps: the surface is not round
                lump = 1 + 0.13 * math.sin(a * 3.0 + t * 11.0 + seed) + 0.07 * math.sin(t * 19.0)
                rr = r * lump
                p = centre + xa * (math.cos(a) * rr) + ya * (math.sin(a) * rr)
                lit = max(0.0, math.cos(a - 0.6)) * (1 - t * 0.4)
                base = mix(d, l, 0.22 + 0.50 * t + 0.22 * lit)
                k = 1 + (hash1(p.x * 17.1 + p.z * 9.3) - 0.5) * 0.05
                row_p.append(p)
                row_c.append(tuple(max(0.0, min(1.0, v * k)) for v in base))
            s.row(row_p, row_c)
        s.stitch()
        s.cap(len(s.pts) // s.per_row - rows, p0, d, outward=False)
        s.cap(len(s.pts) // s.per_row - 1, p1, l, outward=True)

    # Limbs leave the stem at different heights and the forks lean outward, not up:
    # splaying them all from one point is what made the first version read as a lotus.
    base = Vector((0, 0, 0))
    knee1 = Vector((0.03, 0.01, 0.40))
    knee2 = Vector((0.02, -0.01, 0.66))
    limb(base, knee1, 0.115, 0.085, 1.0)
    limb(knee1, knee2, 0.085, 0.062, 2.3)
    # two forks, spreading sideways from the upper stem rather than from its tip
    limb(knee1, Vector((-0.20, 0.05, 0.74)), 0.062, 0.030, 3.7)
    limb(knee2, Vector((0.22, -0.06, 0.84)), 0.058, 0.028, 5.1)
    # each fork carries its own pair of tips
    limb(Vector((-0.20, 0.05, 0.74)), Vector((-0.31, 0.02, 0.94)), 0.030, 0.010, 6.9)
    limb(Vector((-0.20, 0.05, 0.74)), Vector((-0.13, 0.11, 0.90)), 0.030, 0.010, 8.3)
    limb(Vector((0.22, -0.06, 0.84)), Vector((0.33, -0.10, 0.99)), 0.028, 0.009, 9.7)
    limb(Vector((0.22, -0.06, 0.84)), Vector((0.15, -0.13, 1.02)), 0.028, 0.009, 11.3)
    limb(knee2, Vector((0.02, -0.02, 1.10)), 0.050, 0.014, 12.9)
    return s


MODELS = {
    "landmark_vent": lambda: vent_body(False),
    "landmark_ribs": ribs,
    "landmark_obelisk": obelisk,
    "desert_mesa": mesa,
    "coral_branch": coral_branch,
}
GLOW = {"landmark_vent": vent_lava}
# models that are a single sheet rather than a closed volume
NO_SOLIDIFY = set()


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    apply = "--apply" in argv
    wanted = [a for a in argv if a in MODELS] or sorted(MODELS)
    print(f"[five] {len(wanted)}: {', '.join(wanted)}", flush=True)
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

    def build(name, surf):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(p) for p in surf.pts], [], list(surf.faces))
        me.validate()
        me.update()
        ca = me.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
        for poly in me.polygons:
            poly.use_smooth = False
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                c = surf.cols[vi] if vi < len(surf.cols) else (1.0, 1.0, 1.0)
                ca.data[li].color = [c[0], c[1], c[2], 1.0]
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.name = name
        me.name = name
        return ob

    for mid in wanted:
        surf = MODELS[mid]()
        free(mid)
        free(mid + "__lod1")
        ob = build(mid, surf)
        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        print(f"[five] {mid}: {len(ob.data.vertices)} verts, {tris} tris", flush=True)

        lod_me = ob.data.copy()
        lod_me.name = mid + "__lod1"
        lod = bpy.data.objects.new(mid + "__lod1", lod_me)
        bpy.context.scene.collection.objects.link(lod)
        m = lod.modifiers.new("dec", "DECIMATE")
        m.ratio = 0.24
        bpy.context.view_layer.objects.active = lod
        bpy.ops.object.select_all(action="DESELECT")
        lod.select_set(True)
        bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.shade_flat()

        if mid in GLOW:
            free(mid + "__glow")
            free(mid + "__glow__lod1")
            # a glow piece may be several surfaces (pool + channels); merge them into one mesh
            surfs = GLOW[mid]()
            if not isinstance(surfs, list):
                surfs = [surfs]
            merged = Surface(1)
            for sf in surfs:
                off = len(merged.pts)
                merged.pts.extend(sf.pts)
                merged.cols.extend(sf.cols)
                merged.faces.extend(tuple(i + off for i in f) for f in sf.faces)
            gob = build(mid + "__glow", merged)
            gt = sum(len(p.vertices) - 2 for p in gob.data.polygons)
            print(f"[five] {mid}__glow: {gt} tris", flush=True)
            # the validator requires a LOD twin for the glow mesh too
            g_lod_me = gob.data.copy()
            g_lod_me.name = mid + "__glow__lod1"
            g_lod = bpy.data.objects.new(mid + "__glow__lod1", g_lod_me)
            bpy.context.scene.collection.objects.link(g_lod)
            gm = g_lod.modifiers.new("dec", "DECIMATE")
            gm.ratio = 0.30
            bpy.context.view_layer.objects.active = g_lod
            bpy.ops.object.select_all(action="DESELECT")
            g_lod.select_set(True)
            bpy.ops.object.modifier_apply(modifier=gm.name)
            bpy.ops.object.shade_flat()

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
    print("[five] re-exported", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
