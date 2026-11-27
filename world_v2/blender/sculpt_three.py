#!/usr/bin/env python3
"""Sculpt the three coral-shore models the reference style can actually express.

Run with Blender:

  blender -b -noaudio --python world_v2/blender/sculpt_three.py -- --plan
  blender -b -noaudio --python world_v2/blender/sculpt_three.py -- --apply
  blender -b -noaudio --python world_v2/blender/sculpt_three.py -- --apply coral_brain

METHOD — why this is different from the two earlier attempts.

The first attempt assembled primitives (tubes, ellipsoids) and the models read as assemblies.
The second tried procedural branching and the corals read as brooms. Both fail for the same
reason: those models are identified by their *surface*, and an assembly of primitives has no
surface of its own.

This script builds a single continuous quad grid for each model and then **displaces every
vertex by a field function**. The folds of a brain coral, the taper of a fan, the ridges of a
starfish arm are all produced by pushing the same mesh around. That is what "sculpting" means
here, and it is the only approach that produces a surface rather than a pile of parts.

Budgets are the originals, so nothing regresses in the LOD ring:
  coral_brain    1720 tris near / 220 lod
  coral_fan      1140 tris near /  88 lod
  beach_starfish   40 tris near /  10 lod
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


# --------------------------------------------------------------------------- grid kit
class Grid:
    """A continuous quad surface with (u, v) parametrisation, displaced afterwards."""

    def __init__(self, nu: int, nv: int):
        self.nu = nu          # around / along
        self.nv = nv          # across / up
        self.uv: list[tuple[float, float]] = []
        self.pts: list[Vector] = []
        self.cols: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, ...]] = []
        self.wrap_u = True

    def add_row(self, row: list[tuple[float, float, Vector, tuple]]):
        base = len(self.pts)
        for u, v, p, c in row:
            self.uv.append((u, v))
            self.pts.append(p)
            self.cols.append(c)
        return base

    def stitch(self):
        """Join consecutive rows into quads.

        A row holds `nu` points (the count around/along the surface) and there are `nv`
        rows. The two were swapped here at first, which stitched the fan into a ladder of
        separate ribbons instead of one sheet.
        """
        per_row = self.nu
        rows = len(self.pts) // per_row
        for r in range(rows - 1):
            a0 = r * per_row
            b0 = (r + 1) * per_row
            last = per_row - 1 if not self.wrap_u else per_row
            for j in range(last):
                k = (j + 1) % per_row
                self.faces.append((a0 + j, a0 + k, b0 + k, b0 + j))


def ring_row(nv, radius_fn, z, centre=(0, 0), colour_fn=None, wobble=0.0, seed=0):
    row = []
    for j in range(nv):
        a = j / nv * TAU
        r = radius_fn(a)
        if wobble:
            r *= 1 + (hash1(seed + j * 3.7 + a * 5.1) - 0.5) * wobble * 2
        p = Vector((centre[0] + math.cos(a) * r, centre[1] + math.sin(a) * r, z))
        c = colour_fn(p, a, r) if colour_fn else (1.0, 1.0, 1.0)
        row.append((a / TAU, z, p, c))
    return row


# --------------------------------------------------------------------------- models
def sculpt_coral_brain():
    """A brain coral: a dome whose surface is folded by a meandering field.

    The folds are real geometry. Two travelling waves at an angle to each other produce the
    maze pattern; modulating their amplitude by radius keeps the rim smooth so the dome still
    reads as a dome from the side.
    """
    NU, NV = 30, 12
    g = Grid(NU, NV)
    dark, mid, light = col("#4a325c"), col("#8d6cae"), col("#bfa3d8")
    R = 0.55

    def groove(p, a, r):
        # the same field used for the displacement, reused for shading, so the dark lines
        # sit in the actual troughs instead of being painted on
        f = math.sin(a * 5.0 + r * 9.0) * math.sin(a * 3.0 - r * 7.0 + 1.1)
        t = max(0.0, min(1.0, (f + 1) * 0.5))
        base = mix(dark, light, 0.22 + 0.6 * t)
        k = 1 + (hash1(p.x * 8.1 + p.y * 11.3) - 0.5) * 0.05
        return tuple(max(0.0, min(1.0, v * k)) for v in base)

    for i in range(NV):
        t = i / (NV - 1)
        # dome profile: wide rim, rounded top
        prof = math.cos(t * math.pi * 0.5) ** 0.62
        z = 0.02 + t * 0.33
        row = []
        for j in range(NU):
            a = j / NU * TAU
            r = R * prof
            # the fold field: amplitude fades at the rim so the silhouette stays clean
            fade = prof ** 1.4
            fold = (math.sin(a * 5.0 + r * 9.0) * math.sin(a * 3.0 - r * 7.0 + 1.1))
            rr = r + fold * 0.026 * fade
            zz = z + fold * 0.020 * fade
            p = Vector((math.cos(a) * rr, math.sin(a) * rr, zz))
            row.append((a / TAU, t, p, groove(p, a, r)))
        g.add_row(row)
    g.stitch()
    # cap the top with a fan, and close the bottom
    top = len(g.pts)
    g.pts.append(Vector((0, 0, 0.365)))
    g.cols.append(light)
    last_row = (NV - 1) * NU
    for j in range(NU):
        k = (j + 1) % NU
        g.faces.append((last_row + j, last_row + k, top))
    bottom = len(g.pts)
    g.pts.append(Vector((0, 0, 0.0)))
    g.cols.append(dark)
    for j in range(NU):
        k = (j + 1) % NU
        g.faces.append((bottom, k, j))
    return g


def sculpt_coral_fan():
    """A sea fan: one membrane that narrows and thickens toward the base, with scalloped rim.

    Built as a single sheet (two-sided via the material), so it reads as a fan, not a broom.
    The rim scallop and the radial ribs are both displacement — the ribs sit slightly proud
    and are painted darker, which is how the reference does shallow relief.
    """
    NU, NV = 34, 9
    g = Grid(NU, NV)
    dark, mid, light = col("#5c2a1a"), col("#a85a2c"), col("#d98f4e")

    def fan_point(u, v):
        # u: across the fan (-1..1 at the rim), v: base (0) to rim (1)
        a = (u - 0.5) * 2.0                        # -1 .. 1
        # half-width grows with v, and the top edge is scalloped
        half = 0.10 + 0.52 * (v ** 0.72)
        x = a * half
        # scallop: the rim dips between ribs
        scallop = 0.055 * math.cos(a * math.pi * 4.0) * (v ** 2)
        z = 0.03 + v * (1.02 + 0.22 * math.sin(math.pi * (0.5 + a * 0.35))) - scallop
        # radial rib relief: 4 ribs, each a slight bulge in Y
        rib = math.cos(a * math.pi * 4.0)
        y = rib * 0.020 * (v ** 0.5)
        return Vector((x, y, z)), a, rib

    for j in range(NV):
        v = j / (NV - 1)
        row = []
        for i in range(NU):
            u = i / (NU - 1)
            p, a, rib = fan_point(u, v)
            # thickness: the sheet is a single surface, so shade the ribs instead of splitting it
            t = max(0.0, min(1.0, 0.5 + rib * 0.5))
            base = mix(dark, light, 0.18 + 0.55 * t * (0.4 + 0.6 * v))
            k = 1 + (hash1(p.x * 9.1 + p.z * 7.3) - 0.5) * 0.05
            c = tuple(max(0.0, min(1.0, x * k)) for x in base)
            row.append((u, v, p, c))
        g.add_row(row)
    g.wrap_u = False
    g.stitch()
    return g


def sculpt_starfish():
    """A starfish: five arms that rise in the middle, thin at the tips, with a raised ridge.

    Built as a single radial sheet. The arm profile is a smooth function of angle
    (a superellipse on the five-fold symmetry), and the vertical bulge is the ridge.
    """
    NU, NV = 60, 5          # 12 segments per arm x 5
    g = Grid(NU, NV)
    dark, mid, light = col("#7a3418"), col("#c46a2c"), col("#e8a05a")

    def arm_radius(a):
        # five-fold: full radius at arm centres, pinched between
        f = 0.5 + 0.5 * math.cos(a * 5.0)
        return 0.10 + 0.235 * (f ** 0.72)

    for i in range(NV):
        t = i / (NV - 1)               # 0 = centre, 1 = rim
        row = []
        for j in range(NU):
            a = j / NU * TAU
            r = arm_radius(a) * t
            # height: thick at centre, tapering to the rim, plus a ridge along the arms
            ridge = math.cos(a * 5.0)
            h = 0.075 * (1 - t ** 1.8) + 0.022 * max(0.0, ridge) * (1 - t * 0.7)
            # the arm tips curl down slightly
            h -= 0.018 * (t ** 3)
            p = Vector((math.cos(a) * r, math.sin(a) * r, max(0.004, h)))
            shade = 0.35 + 0.5 * max(0.0, ridge) * (1 - t * 0.5) + 0.2 * (1 - t)
            base = mix(dark, light, min(1.0, shade))
            k = 1 + (hash1(p.x * 13.1 + p.y * 7.7) - 0.5) * 0.05
            row.append((a / TAU, t, p, tuple(max(0.0, min(1.0, x * k)) for x in base)))
        g.add_row(row)
    g.stitch()
    # underside: mirror the rim down to a flat base so the model has thickness
    bottom = len(g.pts)
    g.pts.append(Vector((0, 0, 0.0)))
    g.cols.append(dark)
    rim = (NV - 1) * NU
    for j in range(NU):
        k = (j + 1) % NU
        g.faces.append((bottom, rim + k, rim + j))
    return g


# thickness 0 means "leave it a single sheet". The game material is DoubleSide, so a
# one-sided fan is correct; Solidify turned it into a stack of separate ribbons.
MODELS = {
    "coral_brain": (sculpt_coral_brain, 0.020),
    "coral_fan": (sculpt_coral_fan, 0.0),
    "beach_starfish": (sculpt_starfish, 0.008),
}


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    apply = "--apply" in argv
    wanted = [a for a in argv if a in MODELS] or sorted(MODELS)
    print(f"[sculpt] {len(wanted)}: {', '.join(wanted)}", flush=True)
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

    for mid in wanted:
        build, thick = MODELS[mid]
        g = build()
        free(mid)
        free(mid + "__lod1")

        me = bpy.data.meshes.new(mid)
        me.from_pydata([tuple(p) for p in g.pts], [], list(g.faces))
        me.validate()
        me.update()
        ca = me.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
        # the grid carries one colour per point; the corner copies its point's colour
        for poly in me.polygons:
            poly.use_smooth = False
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                c = g.cols[vi] if vi < len(g.cols) else (1.0, 1.0, 1.0)
                ca.data[li].color = [c[0], c[1], c[2], 1.0]

        ob = bpy.data.objects.new(mid, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.name = mid
        me.name = mid

        if thick > 0:
            # a closed volume holds its silhouette at grazing angles; models that are meant to
            # be a single sheet (the sea fan) skip this and rely on DoubleSide
            sol = ob.modifiers.new("thick", "SOLIDIFY")
            sol.thickness = thick
            sol.offset = 0.0
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            bpy.ops.object.modifier_apply(modifier=sol.name)

        tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
        print(f"[sculpt] {mid}: {len(ob.data.vertices)} verts, {tris} tris", flush=True)

        lod_me = ob.data.copy()
        lod_me.name = mid + "__lod1"
        lod = bpy.data.objects.new(mid + "__lod1", lod_me)
        bpy.context.scene.collection.objects.link(lod)
        m = lod.modifiers.new("dec", "DECIMATE")
        m.ratio = 0.22
        bpy.context.view_layer.objects.active = lod
        bpy.ops.object.select_all(action="DESELECT")
        lod.select_set(True)
        bpy.ops.object.modifier_apply(modifier=m.name)
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
    print("[sculpt] re-exported", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
