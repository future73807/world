import bpy
import bmesh
import json
import math
import os
import random
import time
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(ROOT)
OLD_GLB = os.path.join(ROOT, "app", "public", "models", "prefabs.glb")
OLD_MANIFEST = os.path.join(ROOT, "app", "public", "models", "prefabs.json")
BLEND = os.path.join(ROOT, "world_v2", "prefabs.blend")
RENDERS = os.path.join(ROOT, "world_v2", "renders")
OUT_DIR = os.path.join(ROOT, "app", "public", "models")
TAU = math.tau

KEEP = {
    "palm_a", "palm_b",
    "desert_cactus_a", "desert_cactus_b",
    "snow_pine_a", "snow_pine_b", "snow_pine_c",
    "landmark_elder_tree",
}

COLLIDE = {
    "coral_brain": {"r": 0.46, "h": 0.62},
    "beach_driftwood": {"r": 0.52, "h": 0.62},
    "desert_mesa": {"r": 1.75, "h": 2.5},
    "desert_boulder": {"r": 0.72, "h": 1.05},
    "forest_tree_a": {"r": 0.52, "h": 4.9},
    "forest_tree_b": {"r": 0.48, "h": 6.2},
    "forest_tree_c": {"r": 0.46, "h": 4.6},
    "forest_stump": {"r": 0.64, "h": 1.12},
    "forest_log": {"r": 0.5, "h": 0.86},
    "landmark_arch": [{"x": 3.25, "z": 0, "r": 0.82, "h": 4.5}, {"x": -3.25, "z": 0, "r": 0.82, "h": 4.5}],
    "landmark_obelisk": {"r": 1.18, "h": 6.9},
    "landmark_crystal": {"r": 1.7, "h": 6.8},
    "landmark_giant_mushroom": {"r": 1.05, "h": 5.8},
    "landmark_vent": {"r": 2.15, "h": 3.35},
    "landmark_ribs": [{"x": 2.15, "z": 0.75, "r": 0.46, "h": 4.6}, {"x": -2.15, "z": 0.75, "r": 0.46, "h": 4.6}, {"x": 1.85, "z": -1.15, "r": 0.4, "h": 4.1}, {"x": -1.85, "z": -1.15, "r": 0.4, "h": 4.1}],
    "meadow_tree_a": {"r": 0.46, "h": 4.15},
    "rock_a": {"r": 0.72, "h": 1.05},
    "rock_b": {"r": 0.78, "h": 1.18},
    "rock_slab": {"r": 1.02, "h": 1.18},
    "shrub_a": False,
    "snow_dead_tree": {"r": 0.34, "h": 4.8},
    "snow_rock": {"r": 0.86, "h": 1.18},
    "ice_shard": {"r": 0.58, "h": 2.25},
    "swamp_willow": {"r": 0.62, "h": 4.7},
    "swamp_mushroom_a": {"r": 0.38, "h": 2.65},
    "swamp_mushroom_b": {"r": 0.3, "h": 1.45},
    "swamp_snag": {"r": 0.44, "h": 3.8},
    "swamp_mossrock": {"r": 0.82, "h": 1.05},
    "volcano_obsidian": {"r": 0.76, "h": 2.45},
    "volcano_basalt": {"r": 1.0, "h": 2.65},
    "volcano_charred": {"r": 0.46, "h": 4.15},
    "volcano_rock": {"r": 0.82, "h": 1.28},
}

SINK = {
    "forest_tree_a": 0.18, "forest_tree_b": 0.18, "forest_tree_c": 0.18,
    "meadow_tree_a": 0.18, "snow_dead_tree": 0.18, "swamp_willow": 0.2,
    "swamp_snag": 0.18, "volcano_charred": 0.18,
}

LOD_TARGET = {
    "forest_tree_a": 360, "forest_tree_b": 340, "forest_tree_c": 360,
    "swamp_willow": 460, "landmark_arch": 180, "landmark_ribs": 190,
    "landmark_crystal": 120, "landmark_giant_mushroom": 220,
    "coral_branch": 120, "coral_brain": 220, "coral_fan": 100, "grass_a": 44, "grass_b": 44,
    "desert_grass": 90, "flower_a": 120, "flower_b": 120, "flower_c": 110,
    "swamp_reeds": 100, "volcano_basalt": 90, "volcano_charred": 256,
    "meadow_bush": 60, "shrub_a": 60, "desert_shrub": 55,
}


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


def gradient(c1, c2, under=None, jitter=0.035):
    c1, c2 = col(c1), col(c2)
    under = col(under) if under else c1

    def paint(c, n):
        up = max(0.0, min(1.0, (n.z + 0.25) / 1.25))
        out = mix(under, c1, min(1.0, up * 1.7))
        out = mix(out, c2, up * up)
        k = 1 + (hash1(c.x * 7.1 + c.y * 13.7 + c.z * 19.3) - 0.5) * jitter
        return tuple(max(0.0, min(1.0, v * k)) for v in out)
    return paint


def bands(c1, c2, height=0.45, jitter=0.025):
    c1, c2 = col(c1), col(c2)

    def paint(c, n):
        f = (c.z / height) % 1.0
        t = max(0.0, min(1.0, (f - 0.62) / 0.25))
        out = mix(c1, c2, t)
        k = 1 + (hash1(c.x * 9.7 + c.z * 17.1) - 0.5) * jitter
        return tuple(max(0.0, min(1.0, v * k)) for v in out)
    return paint


class Piece:
    def __init__(self, verts, faces, paint, glow=False, face_colors=None):
        self.verts = [Vector(v) for v in verts]
        self.faces = [tuple(f) for f in faces]
        self.paint = paint
        self.glow = glow
        self.face_colors = face_colors

    def transform(self, matrix):
        self.verts = [matrix @ v for v in self.verts]

    def translate(self, delta):
        d = Vector(delta)
        self.verts = [v + d for v in self.verts]


class Model:
    def __init__(self):
        self.pieces = []

    def add(self, piece):
        self.pieces.append(piece)
        return piece

    def translate(self, delta):
        for p in self.pieces:
            p.translate(delta)

    def bounds(self):
        vs = [v for p in self.pieces for v in p.verts]
        return Vector(tuple(min(v[i] for v in vs) for i in range(3))), Vector(tuple(max(v[i] for v in vs) for i in range(3)))


def ico(model, loc, scale, paint, sub=2, seed=0, rough=0.0, flatten=0.0, glow=False):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    for v in bm.verts:
        d = v.co.normalized()
        n = 1 + rough * (0.55 * math.sin(d.x * 5.1 + seed) * math.cos(d.y * 4.3 - seed * 0.7) + 0.45 * math.sin(d.z * 7.7 + seed * 1.3))
        v.co = Vector((d.x * scale[0] * n, d.y * scale[1] * n, d.z * scale[2] * n))
        floor = loc[2] - scale[2] * flatten
        if flatten and v.co.z < floor:
            v.co.z = floor + (v.co.z - floor) * 0.18
        v.co += Vector(loc)
    verts = [v.co.copy() for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return model.add(Piece(verts, faces, paint, glow))


def catmull(points, radii, samples=4):
    pts = [Vector(p) for p in points]
    out_p, out_r = [], []
    for i in range(len(pts) - 1):
        p0 = pts[max(0, i - 1)]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[min(len(pts) - 1, i + 2)]
        r0, r1 = radii[i], radii[i + 1]
        for j in range(samples):
            t = j / samples
            t2, t3 = t * t, t * t * t
            p = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
            out_p.append(p)
            out_r.append(r0 * (1 - t) + r1 * t)
    out_p.append(pts[-1])
    out_r.append(radii[-1])
    return out_p, out_r


def tube(model, path, radii, paint, sides=7, samples=3, glow=False, caps=True):
    pts, rs = catmull(path, radii, samples)
    verts, faces = [], []
    up = Vector((0, 0, 1))
    for i, (p, r) in enumerate(zip(pts, rs)):
        t = pts[min(i + 1, len(pts) - 1)] - pts[max(0, i - 1)]
        if t.length < 1e-6:
            t = up.copy()
        t.normalize()
        ref = Vector((1, 0, 0)) if abs(t.dot(up)) > 0.92 else up
        u = t.cross(ref).normalized()
        v = t.cross(u).normalized()
        for j in range(sides):
            a = j / sides * TAU
            verts.append(p + (u * math.cos(a) + v * math.sin(a)) * r)
    for i in range(len(pts) - 1):
        for j in range(sides):
            a = i * sides + j
            b = i * sides + (j + 1) % sides
            c = (i + 1) * sides + (j + 1) % sides
            d = (i + 1) * sides + j
            faces.append((a, b, c, d))
    if caps:
        for idx, reverse in ((0, True), (len(pts) - 1, False)):
            c = len(verts)
            verts.append(pts[idx])
            for j in range(sides):
                a = idx * sides + j
                b = idx * sides + (j + 1) % sides
                faces.append((c, b, a) if reverse else (c, a, b))
    model.add(Piece(verts, faces, paint, glow))


def lathe(model, profile, sides, loc, paint, phase=0.0, glow=False, irregular=0.0, seed=0):
    verts, faces = [], []
    count = len(profile)
    for i, (r, z) in enumerate(profile):
        for j in range(sides):
            a = phase + j / sides * TAU
            rr = r * (1 + irregular * math.sin(a * 3 + i * 1.7 + seed))
            verts.append(Vector((loc[0] + math.cos(a) * rr, loc[1] + math.sin(a) * rr, loc[2] + z)))
    for i in range(count - 1):
        for j in range(sides):
            a = i * sides + j
            b = i * sides + (j + 1) % sides
            c = (i + 1) * sides + (j + 1) % sides
            d = (i + 1) * sides + j
            faces.append((a, b, c, d))
    if profile[0][0] > 1e-6:
        c = len(verts)
        verts.append(Vector((loc[0], loc[1], loc[2] + profile[0][1])))
        for j in range(sides):
            faces.append((c, (j + 1) % sides, j))
    if profile[-1][0] > 1e-6:
        c = len(verts)
        verts.append(Vector((loc[0], loc[1], loc[2] + profile[-1][1])))
        off = (count - 1) * sides
        for j in range(sides):
            faces.append((c, off + j, off + (j + 1) % sides))
    model.add(Piece(verts, faces, paint, glow))


def blade(model, base, length, width, yaw, bend, paint, lean=0.0, thickness=0.012, glow=False):
    direction = Vector((math.cos(yaw), math.sin(yaw), 0))
    side = Vector((-math.sin(yaw), math.cos(yaw), 0))
    verts, faces = [], []
    segs = 4
    for i in range(segs):
        t = i / (segs - 1)
        w = width * (0.28 + 0.72 * math.sin(math.pi * (0.12 + 0.88 * t))) * (1 - 0.78 * t ** 1.7)
        c = Vector(base) + direction * (bend * t ** 1.55) + Vector((0, 0, length * t - lean * t * t))
        th = thickness * (1 - 0.75 * t)
        ring = [c - side * w, c + direction * th, c + side * w, c - direction * th]
        verts.extend(ring)
    for i in range(segs - 1):
        for j in range(4):
            a = i * 4 + j
            b = i * 4 + (j + 1) % 4
            c = (i + 1) * 4 + (j + 1) % 4
            d = (i + 1) * 4 + j
            faces.append((a, b, c, d))
    tip = Vector(base) + direction * bend + Vector((0, 0, length - lean))
    verts.append(tip)
    for j in range(4):
        faces.append(((segs - 1) * 4 + j, (segs - 1) * 4 + (j + 1) % 4, len(verts) - 1))
    model.add(Piece(verts, faces, paint, glow))


def canopy(model, center, scale, lobes, paint, seed=0, sub=2):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    rnd = random.Random(seed)
    cs = [Vector((0, 0, 0.05))]
    rs = [0.68]
    for i in range(lobes - 1):
        a = i / max(1, lobes - 1) * TAU + rnd.uniform(-0.35, 0.35)
        e = rnd.uniform(-0.35, 0.38)
        rr = math.sqrt(max(0.05, 1 - e * e))
        c = Vector((math.cos(a) * rr * rnd.uniform(0.35, 0.62), math.sin(a) * rr * rnd.uniform(0.35, 0.62), e))
        cs.append(c)
        rs.append(rnd.uniform(0.42, 0.62))
    for v in bm.verts:
        d = v.co.normalized()
        hit = 0.42
        for c, r in zip(cs, rs):
            oc = d * -1.0
            b = oc.dot(c)
            cc = c.dot(c) - r * r
            disc = b * b - cc
            if disc >= 0:
                t = -b - math.sqrt(disc)
                if t > 0:
                    hit = max(hit, t)
        wobble = 1 + 0.055 * math.sin(d.x * 8 + seed) * math.cos(d.z * 7 - seed) + 0.025 * math.sin(d.y * 13 + seed * 2)
        v.co = Vector(center) + Vector((d.x * scale[0] * hit * wobble, d.y * scale[1] * hit * wobble, d.z * scale[2] * hit * wobble))
    verts = [v.co.copy() for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    model.add(Piece(verts, faces, paint))


def rock(model, loc, scale, paint, seed=0, sub=1, rough=0.28):
    ico(model, loc, scale, paint, sub=sub, seed=seed, rough=rough, flatten=0.62)


def roots(model, radius, length, paint, seed=0, n=6):
    rnd = random.Random(seed)
    for i in range(n):
        a = i / n * TAU + rnd.uniform(-0.25, 0.25)
        d = Vector((math.cos(a), math.sin(a), 0))
        l = length * rnd.uniform(0.75, 1.15)
        tube(model, [d * radius * 0.25 + Vector((0, 0, 0.34)), d * l * 0.55 + Vector((0, 0, 0.12)), d * l + Vector((0, 0, -0.08))], [radius * 0.42, radius * 0.24, 0.018], paint, sides=6, samples=2)


def dead_branch(model, start, direction, length, radius, depth, paint, rnd, glow=False):
    end = Vector(start) + Vector(direction).normalized() * length
    tube(model, [start, (Vector(start) + end) * 0.5, end], [radius, radius * 0.72, radius * 0.28], paint, sides=6 if depth else 5, samples=2, glow=glow)
    if depth <= 0:
        return
    count = 3 if depth >= 2 else 2
    for i in range(count):
        a = rnd.uniform(0, TAU)
        d = Vector(direction).normalized()
        axis = Vector((math.cos(a), math.sin(a), rnd.uniform(-0.2, 0.55))).normalized()
        child = (d * 0.55 + axis * 0.75).normalized()
        dead_branch(model, end, child, length * rnd.uniform(0.52, 0.72), radius * 0.58, depth - 1, paint, rnd, glow)


def elder_clone(model, scale=(1, 1, 1), crown_only=False, tint=None, distort=0.0, seed=0):
    source = bpy.data.objects.get("landmark_elder_tree")
    if source is None:
        raise RuntimeError("accepted elder tree mesh is unavailable")
    me = source.data
    ca = me.color_attributes[0]
    max_z = max(v.co.z for v in me.vertices)
    included = []
    centers = []
    for poly in me.polygons:
        if crown_only and poly.center.z < max_z * 0.5:
            continue
        included.append(poly)
        centers.append(poly.center.copy())
    cx = sum(c.x for c in centers) / len(centers) if crown_only else 0.0
    cy = sum(c.y for c in centers) / len(centers) if crown_only else 0.0
    remap = {}
    verts = []
    faces = []
    colors = []
    pink = col("#e9a4bd")
    dry = col("#9a9562")
    for poly in included:
        face = []
        color = [0.0, 0.0, 0.0]
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if vi not in remap:
                v = me.vertices[vi].co
                wobble = 1 + distort * math.sin(v.x * 1.7 + seed) * math.cos(v.y * 1.9 - seed * 0.6)
                x = (v.x - cx) * scale[0] * wobble
                y = (v.y - cy) * scale[1] * wobble
                z = v.z * scale[2]
                if distort:
                    z += distort * 0.18 * math.sin(v.x * 2.1 + v.y * 1.3 + seed)
                remap[vi] = len(verts)
                verts.append((x, y, z))
            face.append(remap[vi])
            c = ca.data[li].color
            for k in range(3):
                color[k] += c[k]
        faces.append(tuple(face))
        color = tuple(v / len(poly.loop_indices) for v in color)
        green = color[1] > color[0] * 1.12 and color[1] > color[2] * 1.15
        if green and tint == "blossom":
            noise = 0.5 + 0.5 * math.sin(poly.center.x * 3.1 + poly.center.z * 2.7 + seed)
            color = mix(color, pink, 0.72 + noise * 0.2)
        elif green and tint == "dry":
            color = mix(color, dry, 0.68)
        colors.append(color)
    return model.add(Piece(verts, faces, col("#ffffff"), face_colors=colors))


def make_tree(model, variant):
    if variant == "a":
        elder_clone(model, (0.47, 0.43, 0.45), distort=0.025, seed=3)
    elif variant == "b":
        elder_clone(model, (0.39, 0.4, 0.53), distort=0.02, seed=7)
    elif variant == "c":
        elder_clone(model, (0.46, 0.43, 0.43), tint="blossom", distort=0.03, seed=11)
    else:
        elder_clone(model, (0.43, 0.4, 0.36), distort=0.02, seed=17)


def make_shrub(model, flowery=False, dry=False):
    twig = gradient("#67513d", "#9b7e58", "#40382e", 0.05) if dry else gradient("#6c513b", "#a07c55", "#40362c", 0.05)
    crown = elder_clone(model, (0.2, 0.18, 0.22), crown_only=True, tint="dry" if dry else None, distort=0.04, seed=21)
    crown.translate((0, 0, -0.85))
    side = elder_clone(model, (0.14, 0.13, 0.18), crown_only=True, tint="dry" if dry else None, distort=0.05, seed=29)
    side.translate((0.42, -0.18, -0.7))
    top = elder_clone(model, (0.12, 0.11, 0.16), crown_only=True, tint="dry" if dry else None, distort=0.06, seed=37)
    top.translate((-0.16, 0.12, -0.55))
    rnd = random.Random(19)
    for i in range(8):
        a = rnd.uniform(0, TAU)
        tip = Vector((math.cos(a) * rnd.uniform(0.3, 0.68), math.sin(a) * rnd.uniform(0.3, 0.68), rnd.uniform(0.55, 0.95)))
        tube(model, [(0, 0, 0.02), tip * 0.5 + Vector((0, 0, 0.12)), tip], [0.035, 0.022, 0.006], twig, sides=5, samples=2)
    if flowery:
        flower = gradient("#f2d56e", "#fff0a6", "#c79b3e", 0.03)
        for i in range(16):
            a = i / 16 * TAU
            r = 0.55 + 0.12 * math.sin(i * 2.3)
            ico(model, (math.cos(a) * r, math.sin(a) * r * 0.85, 0.86 + 0.16 * math.sin(i * 1.7)), (0.07, 0.07, 0.055), flower, sub=1, seed=i)


def make_grass(model, tall=False, dry=False):
    rnd = random.Random(91 if tall else 73)
    paint = gradient("#b99b4f", "#ead58a", "#786c38", 0.06) if dry else gradient("#4d8d43", "#b4d675", "#2f6638", 0.07)
    n = 13 if tall else 16
    for i in range(n):
        a = i / n * TAU + rnd.uniform(-0.22, 0.22)
        length = rnd.uniform(0.42, 0.72) if tall else rnd.uniform(0.24, 0.46)
        width = rnd.uniform(0.022, 0.038) if tall else rnd.uniform(0.028, 0.045)
        blade(model, (rnd.uniform(-0.07, 0.07), rnd.uniform(-0.07, 0.07), 0), length, width, a, rnd.uniform(0.08, 0.28) * (1.4 if tall else 1), paint, lean=rnd.uniform(0.02, 0.12), thickness=0.008)


def make_flower(model, petal, core, blue=False):
    stem = gradient("#578e49", "#91bd68", "#35673d", 0.04)
    pet = gradient(petal, "#fff7ef", petal, 0.025)
    mid = col(core)
    for k in range(2):
        off = Vector(((-0.09 if k == 0 else 0.1), (0.06 if k == 0 else -0.05), 0))
        h = 0.5 if k == 0 else 0.4
        top = off + Vector((0.07 if k == 0 else -0.05, 0, h))
        tube(model, [off + Vector((0, 0, -0.03)), off.lerp(top, 0.55) + Vector((0, 0, 0.03)), top], [0.022, 0.016, 0.012], stem, sides=5, samples=3)
        for j in range(2):
            a = k * 2.2 + j * 2.7
            blade(model, off + Vector((0, 0, h * 0.3)), h * 0.42, h * 0.1, a, h * 0.22, stem, thickness=0.007)
        for j in range(6 if not blue else 5):
            a = j / (6 if not blue else 5) * TAU
            petal = ico(model, (0, 0, 0), (h * 0.13, h * 0.055, h * 0.22), pet, sub=1, seed=k * 9 + j, rough=0.04)
            petal.transform(Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.radians(72), 4, "X"))
            petal.translate(top + Vector((math.cos(a) * h * 0.11, math.sin(a) * h * 0.11, h * 0.035)))
        for j in range(5):
            a = j / 5 * TAU + 0.3
            petal = ico(model, (0, 0, 0), (h * 0.09, h * 0.04, h * 0.15), pet, sub=1, seed=40 + k * 5 + j, rough=0.03)
            petal.transform(Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.radians(58), 4, "X"))
            petal.translate(top + Vector((math.cos(a) * h * 0.055, math.sin(a) * h * 0.055, h * 0.085)))
        ico(model, top + Vector((0, 0, h * 0.1)), (h * 0.09, h * 0.09, h * 0.055), mid, sub=1, seed=k)


def make_mushroom(model, giant=False, amber=False, small=False):
    rnd = random.Random(55 if giant else 22)
    if giant:
        h, cap_r, cap_h = 4.6, 3.0, 1.25
    elif small:
        h, cap_r, cap_h = 0.48, 0.24, 0.16
    elif amber:
        h, cap_r, cap_h = 1.15, 0.58, 0.4
    else:
        h, cap_r, cap_h = 2.25, 1.08, 0.68
    stalk = gradient("#d8c8a6", "#fff0cf", "#9b8b70", 0.035)
    cap = gradient("#d78647", "#f4bd70", "#8c4d32", 0.055) if amber else gradient("#5e9f86", "#a9d5ae", "#356c5c", 0.05)
    if small:
        cap = gradient("#c95343", "#ef8d68", "#843b35", 0.04)
    gill_paint = col("#a8f0c1") if not amber and not small else col("#ffd27d")
    bend = cap_r * 0.12
    tube(model, [(0, 0, -0.12), (bend * 0.25, 0, h * 0.42), (bend * 0.75, 0, h * 0.82), (bend, 0, h + cap_h * 0.18)], [cap_r * 0.25, cap_r * 0.19, cap_r * 0.17, cap_r * 0.23], stalk, sides=10, samples=4)
    profile = [(cap_r * 0.98, 0), (cap_r * 1.04, cap_h * 0.12), (cap_r * 0.9, cap_h * 0.43), (cap_r * 0.62, cap_h * 0.75), (cap_r * 0.28, cap_h * 0.94), (0, cap_h)]
    lathe(model, profile, 14 if giant else 11, (bend, 0, h), cap, irregular=0.035, seed=3)
    for i in range(14 if giant else 9):
        a = i / (14 if giant else 9) * TAU
        tube(model, [(bend, 0, h + cap_h * 0.18), (bend + math.cos(a) * cap_r * 0.52, math.sin(a) * cap_r * 0.52, h + cap_h * 0.08), (bend + math.cos(a) * cap_r * 0.94, math.sin(a) * cap_r * 0.94, h + cap_h * 0.02)], [0.025, 0.018, 0.008], gill_paint, sides=4, samples=2, glow=not small)
    spot = col("#fff1d8")
    for i in range(14 if giant else (6 if not small else 3)):
        a = rnd.uniform(0, TAU)
        rr = rnd.uniform(0.22, 0.74) * cap_r
        u = rr / cap_r
        z = h + cap_h * (1.0 - 0.55 * u ** 1.6) + 0.035
        ico(model, (bend + math.cos(a) * rr, math.sin(a) * rr, z), (cap_r * (0.12 if giant else 0.09), cap_r * (0.09 if giant else 0.07), cap_r * 0.03), spot, sub=1, seed=i, rough=0.08)
    if giant:
        roots(model, cap_r * 0.28, cap_r * 0.7, stalk, seed=8, n=7)
        for i in range(3):
            a = i / 3 * TAU + 0.5
            ico(model, (math.cos(a) * cap_r * 0.75, math.sin(a) * cap_r * 0.75, 0.18), (0.38, 0.32, 0.22), cap, sub=1, seed=i, rough=0.2)


def make_coral_branch(model):
    paint = gradient("#e77f91", "#ffc1c5", "#a94f6c", 0.06)
    rnd = random.Random(71)

    def branch(start, direction, length, radius, depth):
        end = Vector(start) + Vector(direction).normalized() * length
        tube(model, [start, Vector(start).lerp(end, 0.55), end], [radius, radius * 0.76, radius * 0.38], paint, sides=6, samples=2)
        if depth:
            for i in range(2):
                a = rnd.uniform(0, TAU)
                d = (Vector(direction) * 0.45 + Vector((math.cos(a) * 0.65, math.sin(a) * 0.65, rnd.uniform(0.35, 0.85)))).normalized()
                branch(end, d, length * rnd.uniform(0.55, 0.72), radius * 0.62, depth - 1)
    branch((0, 0, 0), (0, 0, 1), 0.52, 0.11, 3)


def make_brain_coral(model):
    paint = gradient("#b594d1", "#e0c4ee", "#715b98", 0.045)
    groove = col("#705483")
    ico(model, (0, 0, 0.33), (0.56, 0.48, 0.36), paint, sub=3, seed=4, rough=0.1, flatten=0.55)
    for k in range(7):
        pts = []
        for i in range(13):
            t = i / 12
            a = -1.15 + 2.3 * t
            x = -0.43 + 0.86 * t
            y = (k - 3) * 0.095 + 0.035 * math.sin(t * 9 + k)
            z = 0.34 + 0.32 * math.sqrt(max(0.0, 1 - (x / 0.56) ** 2 - (y / 0.5) ** 2))
            pts.append((x, y, z))
        tube(model, pts, [0.012] * len(pts), groove, sides=4, samples=2)


def make_fan_coral(model):
    paint = gradient("#e98b54", "#ffc074", "#a85439", 0.05)
    rnd = random.Random(88)
    for i in range(9):
        t = i / 8
        x = (t - 0.5) * 0.9
        path = [(0, 0, 0.02), (x * 0.35, 0, 0.38), (x, 0.02 * math.sin(i), 0.72 + 0.28 * math.sin(math.pi * t)), (x * 1.12, 0, 1.05 + 0.16 * math.sin(math.pi * t))]
        tube(model, path, [0.035, 0.026, 0.016, 0.006], paint, sides=5, samples=3)
        if i % 2 == 0:
            for j in range(2):
                z = 0.45 + j * 0.25
                tube(model, [(x * 0.55, 0, z), (x * 0.55 + rnd.uniform(-0.12, 0.12), 0, z + 0.16)], [0.014, 0.004], paint, sides=4, samples=2)


def make_crystal(model, giant=False, obsidian=False):
    rnd = random.Random(101 if giant else 102)
    count = 6 if giant else 4
    h = 5.9 if giant else 1.9
    base_paint = gradient("#477f9e", "#bdefff", "#24536f", 0.035) if not obsidian else gradient("#252735", "#626378", "#10121c", 0.025)
    glow_paint = col("#82eaff") if not obsidian else col("#ff7b3d")
    for i in range(count):
        a = i / count * TAU + rnd.uniform(-0.25, 0.25)
        dist = 0 if i == 0 else rnd.uniform(0.25, 0.72)
        hh = h * (1 if i == 0 else rnd.uniform(0.46, 0.78))
        rr = h * (0.12 if i == 0 else 0.085)
        base = Vector((math.cos(a) * dist, math.sin(a) * dist, -0.08))
        tilt = 0 if i == 0 else rnd.uniform(0.08, 0.3)
        piece = Piece([], [], base_paint)
        profile = [(rr * 1.08, 0), (rr, hh * 0.12), (rr * 0.86, hh * 0.72), (rr * 0.58, hh * 0.9), (0, hh)]
        verts, faces = [], []
        sides = 6
        for r, z in profile:
            for j in range(sides):
                aa = a + j / sides * TAU
                verts.append(Vector((math.cos(aa) * r, math.sin(aa) * r, z)))
        for k in range(len(profile) - 1):
            for j in range(sides):
                faces.append((k * sides + j, k * sides + (j + 1) % sides, (k + 1) * sides + (j + 1) % sides, (k + 1) * sides + j))
        piece = Piece(verts, faces, base_paint)
        axis = Vector((-math.sin(a), math.cos(a), 0))
        piece.transform(Matrix.Translation(base) @ Matrix.Rotation(tilt, 4, axis))
        model.add(piece)
        edge_a = a + 0.3
        p0 = base + Vector((math.cos(edge_a) * rr * 0.94, math.sin(edge_a) * rr * 0.94, hh * 0.16))
        p1 = base + Vector((math.cos(edge_a) * rr * 0.72, math.sin(edge_a) * rr * 0.72, hh * 0.72))
        tube(model, [p0, p1], [0.022 if giant else 0.012, 0.006], glow_paint, sides=4, samples=2, glow=not obsidian)
    if giant:
        for i in range(5):
            a = i / 5 * TAU
            rock(model, (math.cos(a) * 0.85, math.sin(a) * 0.85, 0.12), (0.48, 0.38, 0.25), gradient("#718ba0", "#b8cddd", "#425a6c", 0.05), seed=i)


def wedge(model, a0, a1, ri, ro, rx, rz, depth, paint, seed):
    rnd = random.Random(seed)
    yo = depth * 0.5 * rnd.uniform(0.92, 1.06)
    yi = -yo
    verts = []
    for y in (yi, yo):
        for r in (ri, ro):
            for a in (a0, a1):
                verts.append((math.cos(a) * rx * r, y, math.sin(a) * rz * r))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    model.add(Piece(verts, faces, paint))


def make_arch(model):
    stone = gradient("#858b80", "#c1c2ad", "#545e55", 0.065)
    moss = gradient("#698b4c", "#a4bc6d", "#3f623b", 0.06)
    rnd = random.Random(307)
    n = 11
    for i in range(n):
        a0 = i / n * math.pi + rnd.uniform(0.006, 0.018)
        a1 = (i + 1) / n * math.pi - rnd.uniform(0.006, 0.018)
        ri = 0.76 * rnd.uniform(0.92, 1.06)
        ro = 1.0 * rnd.uniform(0.94, 1.09) * (1.08 if i == n // 2 else 1.0)
        rx = 3.9 * rnd.uniform(0.97, 1.04)
        rz = 5.65 * rnd.uniform(0.98, 1.03)
        depth = 1.55 * rnd.uniform(0.88, 1.14)
        wedge(model, a0, a1, ri, ro, rx, rz, depth, stone, i + 40)
    for side in (-1, 1):
        rock(model, (side * 3.5, 0, 0.38), (1.08, 0.98, 0.58), stone, seed=side + 9, sub=1, rough=0.28)
        rock(model, (side * 4.12, 0.3, 0.22), (0.62, 0.54, 0.34), stone, seed=side + 12, rough=0.3)
        rock(model, (side * 2.65, -0.72, 0.14), (0.38, 0.32, 0.2), stone, seed=side + 20, rough=0.3)
    for i in (1, 2, 3, 7, 8, 9):
        a = (i + 0.5) / n * math.pi
        ico(model, (math.cos(a) * 3.9, 0.12, math.sin(a) * 5.65 + 0.06), (0.4, 0.44, 0.1), moss, sub=1, seed=i, rough=0.22)
    for i in range(5):
        a = math.pi * (0.2 + i * 0.15)
        x, z = math.cos(a) * 3.85, math.sin(a) * 5.6
        tube(model, [(x, -0.45, z + 0.05), (x * 1.01, -0.5, z - 0.35), (x * 1.02, -0.48, z - 0.72)], [0.035, 0.025, 0.008], moss, sides=4, samples=2)


def make_obelisk(model):
    stone = bands("#a85f3f", "#d39462", 0.62, 0.04)
    dark = col("#754831")
    profile = [(1.18, 0), (1.05, 0.35), (0.88, 4.9), (0.64, 5.8), (0.38, 6.25), (0.12, 6.42)]
    lathe(model, profile, 4, (0, 0, 0), stone, phase=math.pi / 4, irregular=0.035, seed=2)
    for z, r in ((0.55, 1.02), (1.55, 0.98), (3.25, 0.9), (4.75, 0.84)):
        lathe(model, [(r, z), (r * 1.06, z + 0.12), (r * 1.02, z + 0.25)], 4, (0, 0, 0), dark, phase=math.pi / 4)
    for side in (-1, 1):
        for j in range(4):
            z = 1.9 + j * 0.58
            ico(model, (side * 0.73, -0.58, z), (0.09, 0.035, 0.16), dark, sub=0, seed=j)
    rock(model, (1.25, 0.4, 0.2), (0.55, 0.42, 0.32), stone, seed=3, rough=0.25)


def make_ribs(model):
    bone = gradient("#d8d2b8", "#fff6db", "#918d79", 0.035)
    for y in (-0.72, 0.72):
        tube(model, [(-2.25, y, 0.05), (-2.05, y, 2.1), (-1.25, y, 4.25), (0, y, 5.25), (1.25, y, 4.25), (2.05, y, 2.1), (2.25, y, 0.05)], [0.34, 0.29, 0.24, 0.2, 0.24, 0.29, 0.34], bone, sides=8, samples=4)
    tube(model, [(0, -1.75, 5.18), (0, -0.7, 5.35), (0, 0.7, 5.35), (0, 1.75, 5.18)], [0.18, 0.23, 0.23, 0.18], bone, sides=7, samples=3)
    for y in (-1.25, -0.45, 0.45, 1.25):
        tube(model, [(-1.75, y, 0.18), (-1.45, y, 1.55), (-0.75, y, 3.15), (0, y, 4.55)], [0.2, 0.16, 0.12, 0.08], bone, sides=6, samples=3)
        tube(model, [(1.75, y, 0.18), (1.45, y, 1.55), (0.75, y, 3.15), (0, y, 4.55)], [0.2, 0.16, 0.12, 0.08], bone, sides=6, samples=3)
    tube(model, [(-1.85, -1.9, 0.32), (-1.15, -2.15, 0.62), (0, -2.25, 0.82), (1.15, -2.15, 0.62), (1.85, -1.9, 0.32)], [0.26, 0.31, 0.36, 0.31, 0.26], bone, sides=8, samples=4)
    ico(model, (0, -2.22, 0.82), (0.62, 0.52, 0.42), bone, sub=1, seed=5, rough=0.12)


def make_vent(model):
    stone = gradient("#3d3b40", "#777077", "#222228", 0.07)
    lava = col("#ff6a1a")
    lathe(model, [(1.9, 0), (2.15, 0.45), (1.75, 1.3), (1.15, 2.35), (0.92, 2.75), (0.62, 2.45), (0.48, 2.15)], 11, (0, 0, 0), stone, irregular=0.09, seed=7)
    lathe(model, [(0.58, 2.18), (0.54, 2.27), (0.34, 2.31), (0, 2.32)], 12, (0, 0, 0), lava, glow=True)
    rnd = random.Random(411)
    for i in range(10):
        a = i / 10 * TAU + rnd.uniform(-0.12, 0.12)
        d = rnd.uniform(0.82, 1.28)
        hh = rnd.uniform(0.38, 0.95)
        rr = rnd.uniform(0.18, 0.3)
        lathe(model, [(rr * 1.12, 0), (rr, hh * 0.25), (rr * 0.78, hh * 0.78), (rr * 0.55, hh)], 6, (math.cos(a) * d, math.sin(a) * d, 2.28), stone, phase=a, irregular=0.08, seed=i)
    for i in range(7):
        a = i / 7 * TAU
        tube(model, [(math.cos(a) * 0.65, math.sin(a) * 0.65, 2.25), (math.cos(a + 0.18) * 1.15, math.sin(a + 0.18) * 1.15, 1.55), (math.cos(a + 0.3) * 1.72, math.sin(a + 0.3) * 1.72, 0.62)], [0.055, 0.038, 0.01], lava, sides=4, samples=3, glow=True)


def make_wood(model, kind):
    bark = gradient("#6b513c", "#a07d55", "#40362d", 0.07) if kind != "drift" else gradient("#a79b82", "#ded2b3", "#746c5d", 0.05)
    if kind == "stump":
        lathe(model, [(0.62, 0), (0.66, 0.18), (0.58, 0.92), (0.54, 1.02)], 9, (0, 0, 0), bark, irregular=0.08, seed=3)
        roots(model, 0.52, 0.92, bark, seed=6, n=6)
        top = gradient("#c5a776", "#ecd39e", "#8f704d", 0.02)
        lathe(model, [(0.53, 1.01), (0.5, 1.055), (0.42, 1.07), (0.3, 1.075), (0.16, 1.08), (0, 1.08)], 9, (0, 0, 0), top)
        tube(model, [(0.35, 0.18, 0.62), (0.68, 0.22, 0.95)], [0.13, 0.06], bark, sides=6, samples=2)
    else:
        path = [(-1.35, 0.05, 0.34), (-0.65, 0.12, 0.52), (0.15, -0.03, 0.43), (0.95, 0.08, 0.31), (1.42, 0.04, 0.24)] if kind == "log" else [(-1.1, 0.1, 0.22), (-0.5, 0.28, 0.48), (0.2, 0.12, 0.4), (0.8, -0.18, 0.2), (1.25, -0.08, 0.32)]
        tube(model, path, [0.34, 0.38, 0.32, 0.24, 0.12], bark, sides=8, samples=4)
        tube(model, [(-0.45, 0.02, 0.42), (-0.62, 0.42, 0.83), (-0.35, 0.62, 1.03)], [0.14, 0.09, 0.035], bark, sides=6, samples=3)
        end = gradient("#c3a679", "#e2c99a", "#826849", 0.025)
        lathe(model, [(0.31, 0), (0.29, 0.04), (0.22, 0.06), (0, 0.07)], 8, path[-1], end, phase=0.2)


def make_starfish(model):
    paint = gradient("#e88b55", "#ffc07c", "#a9533d", 0.04)
    verts, faces = [], []
    n = 10
    for z in (-0.035, 0.035):
        for i in range(n):
            a = i / n * TAU
            r = 0.34 if i % 2 == 0 else 0.14
            verts.append((math.cos(a) * r, math.sin(a) * r, z + 0.04))
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    c0, c1 = len(verts), len(verts) + 1
    verts.extend([(0, 0, 0.04), (0, 0, 0.0)])
    for i in range(n):
        j = (i + 1) % n
        faces.append((c0, i, j))
        faces.append((c1, n + j, n + i))
    model.add(Piece(verts, faces, paint))


def make_lily(model):
    leaf = gradient("#5f9b5b", "#a9c977", "#356b46", 0.045)
    flower = gradient("#f2b7c7", "#ffe4e5", "#bb718d", 0.03)
    for i in range(3):
        a = i / 3 * TAU + 0.3
        c = Vector((math.cos(a) * 0.32, math.sin(a) * 0.28, 0.035))
        verts, faces = [], []
        sides = 14
        gap = 0.42
        for z in (0, 0.035):
            for j in range(sides + 1):
                aa = a + gap + j / sides * (TAU - gap * 2)
                r = (0.42 if i != 1 else 0.34) * (1 + 0.035 * math.sin(j * 2.7))
                verts.append(c + Vector((math.cos(aa) * r, math.sin(aa) * r, z)))
        row = sides + 1
        for j in range(sides):
            faces.append((j, j + 1, row + j + 1, row + j))
        model.add(Piece(verts, faces, leaf))
    for j in range(6):
        a = j / 6 * TAU
        blade(model, (0.12, -0.08, 0.09), 0.18, 0.065, a, 0.08, flower, thickness=0.006)
    ico(model, (0.12, -0.08, 0.13), (0.06, 0.06, 0.04), col("#f4d56e"), sub=1)


def make_pebbles(model):
    paint = gradient("#858d88", "#b7b9a9", "#5b6560", 0.06)
    for i, (x, y, s) in enumerate(((-0.28, 0.05, 0.2), (0.02, 0.18, 0.26), (0.3, -0.08, 0.18), (0.12, -0.2, 0.13))):
        rock(model, (x, y, s * 0.45), (s * 1.2, s, s * 0.72), paint, seed=i, rough=0.25)


def make_mesa(model):
    paint = bands("#a96143", "#e0a06b", 0.42, 0.04)
    lathe(model, [(1.75, 0), (1.9, 0.28), (1.55, 0.62), (1.42, 1.25), (1.12, 1.62), (0.96, 2.05), (0.7, 2.28)], 9, (0, 0, 0), paint, irregular=0.08, seed=4)
    rock(model, (-1.25, 0.35, 0.25), (0.62, 0.5, 0.38), paint, seed=8, rough=0.24)


def make_slab(model):
    paint = gradient("#7c8581", "#b6b9aa", "#515e59", 0.055)
    for i in range(3):
        rock(model, ((i - 1) * 0.16, (i % 2) * 0.08, 0.25 + i * 0.31), (1.18 - i * 0.1, 0.92 - i * 0.06, 0.3), paint, seed=i + 2, sub=1, rough=0.18)


def make_snow_rock(model):
    stone = gradient("#71808d", "#aebdca", "#465866", 0.05)
    snow = gradient("#e8f2fa", "#ffffff", "#b7cedd", 0.018)
    rock(model, (0, 0, 0.38), (0.92, 0.78, 0.55), stone, seed=3, sub=2, rough=0.22)
    ico(model, (0, 0, 0.79), (0.77, 0.64, 0.2), snow, sub=2, seed=4, rough=0.08, flatten=0.2)


def make_moss_rock(model):
    stone = gradient("#596b60", "#8c9c83", "#394c43", 0.06)
    moss = gradient("#5c8445", "#9ab966", "#365d37", 0.07)
    rock(model, (0, 0, 0.34), (0.86, 0.72, 0.5), stone, seed=3, sub=2, rough=0.24)
    for i in range(4):
        a = i / 4 * TAU
        ico(model, (math.cos(a) * 0.28, math.sin(a) * 0.24, 0.7 + 0.06 * math.sin(i)), (0.42, 0.34, 0.14), moss, sub=1, seed=i, rough=0.14)


def make_basalt(model):
    paint = bands("#353840", "#686a70", 0.55, 0.035)
    rnd = random.Random(121)
    for i in range(6):
        a = i / 6 * TAU
        d = 0 if i == 0 else rnd.uniform(0.25, 0.62)
        h = rnd.uniform(1.65, 2.5)
        lathe(model, [(0.26, 0), (0.28, h * 0.15), (0.25, h * 0.88), (0.23, h)], 6, (math.cos(a) * d, math.sin(a) * d, 0), paint, phase=a, irregular=0.035, seed=i)


def make_volcano_rock(model):
    stone = gradient("#35353d", "#6a6268", "#1d2027", 0.06)
    lava = col("#ff7c32")
    rock(model, (0, 0, 0.36), (0.86, 0.72, 0.52), stone, seed=5, sub=1, rough=0.32)
    lathe(model, [(0.46, 0.015), (0.4, 0.04), (0.22, 0.055), (0, 0.06)], 10, (0.35, -0.25, 0), lava, glow=True)
    for i in range(3):
        a = i / 3 * TAU
        tube(model, [(0.38, -0.2, 0.08), (math.cos(a) * 0.55, math.sin(a) * 0.45, 0.18), (math.cos(a) * 0.78, math.sin(a) * 0.62, 0.32)], [0.025, 0.014, 0.004], lava, sides=4, samples=2, glow=True)


def make_willow(model):
    leaf = gradient("#356f3c", "#79aa55", "#214c32", 0.07)
    elder_clone(model, (0.46, 0.43, 0.4), distort=0.025, seed=141)
    rnd = random.Random(141)
    for i in range(26):
        a = i / 26 * TAU + rnd.uniform(-0.1, 0.1)
        radius = rnd.uniform(1.65, 2.25)
        x, y = math.cos(a) * radius, math.sin(a) * radius * 0.9
        length = rnd.uniform(0.9, 1.9)
        top = 4.25 - length * 0.15
        tube(model, [(x, y, top), (x * 1.04, y * 1.04, top - length * 0.55), (x * 1.08, y * 1.08, top - length)], [0.02, 0.014, 0.005], leaf, sides=4, samples=3)
        for j in range(5):
            z = top - length * (0.2 + j * 0.16)
            blade(model, (x * 1.05, y * 1.05, z), 0.3, 0.05, a + (j % 2) * math.pi, 0.1, leaf, thickness=0.006)


def make_reeds(model):
    leaf = gradient("#6f9148", "#b7c878", "#45653b", 0.055)
    stem = gradient("#7d8e4c", "#c0b774", "#4f653a", 0.04)
    head = gradient("#7a5137", "#b07a4e", "#49382c", 0.04)
    rnd = random.Random(151)
    for i in range(16):
        a = i / 16 * TAU + rnd.uniform(-0.2, 0.2)
        blade(model, (rnd.uniform(-0.08, 0.08), rnd.uniform(-0.08, 0.08), 0), rnd.uniform(0.7, 1.45), rnd.uniform(0.035, 0.065), a, rnd.uniform(0.12, 0.35), leaf, thickness=0.009)
    for i in range(4):
        x, y = rnd.uniform(-0.22, 0.22), rnd.uniform(-0.22, 0.22)
        h = rnd.uniform(1.45, 1.95)
        tube(model, [(x, y, 0), (x + 0.03, y, h)], [0.018, 0.012], stem, sides=5, samples=2)
        lathe(model, [(0.045, 0), (0.06, 0.08), (0.055, 0.27), (0.018, 0.34), (0, 0.37)], 7, (x + 0.03, y, h - 0.05), head)


def make_dead(model, burnt=False):
    bark = gradient("#49433d", "#857b69", "#272a29", 0.07) if burnt else gradient("#8a877b", "#c7c0aa", "#56584f", 0.05)
    rnd = random.Random(161 if burnt else 162)
    tube(model, [(0, 0, -0.12), (0.08, 0, 1.4), (-0.06, 0.04, 2.8), (0.12, 0.02, 4.25)], [0.32, 0.25, 0.16, 0.05], bark, sides=8, samples=4)
    roots(model, 0.3, 0.82, bark, seed=5, n=5)
    for i in range(5):
        a = i / 5 * TAU + rnd.uniform(-0.3, 0.3)
        start = Vector((0, 0, 1.45 + i * 0.48))
        direction = Vector((math.cos(a), math.sin(a), rnd.uniform(0.35, 0.8))).normalized()
        dead_branch(model, start, direction, 1.35 - i * 0.1, 0.13, 2, bark, rnd)
    if burnt:
        glow = col("#ff7134")
        tube(model, [(0.17, -0.2, 0.35), (0.12, -0.18, 1.3), (0.19, -0.13, 2.25), (0.05, -0.08, 3.35)], [0.028, 0.022, 0.016, 0.005], glow, sides=4, samples=3, glow=True)
        for i in range(4):
            a = i / 4 * TAU
            tube(model, [(0.1, -0.16, 1.6), (math.cos(a) * 0.42, math.sin(a) * 0.42, 2.15)], [0.018, 0.004], glow, sides=4, samples=2, glow=True)


def build_model(mid):
    m = Model()
    if mid == "forest_tree_a":
        make_tree(m, "a")
    elif mid == "forest_tree_b":
        make_tree(m, "b")
    elif mid == "forest_tree_c":
        make_tree(m, "c")
    elif mid == "meadow_tree_a":
        make_tree(m, "d")
    elif mid == "meadow_bush":
        make_shrub(m, flowery=True)
    elif mid == "shrub_a":
        make_shrub(m)
    elif mid == "desert_shrub":
        make_shrub(m, dry=True)
    elif mid in ("grass_a", "grass_b"):
        make_grass(m, tall=mid == "grass_b")
    elif mid == "desert_grass":
        make_grass(m, tall=True, dry=True)
    elif mid == "flower_a":
        make_flower(m, "#fff8e8", "#edc65f")
    elif mid == "flower_b":
        make_flower(m, "#f2a8bd", "#f2d274")
    elif mid == "flower_c":
        make_flower(m, "#83bce9", "#f4d777", blue=True)
    elif mid == "forest_mushroom_s":
        make_mushroom(m, small=True)
    elif mid == "swamp_mushroom_a":
        make_mushroom(m)
    elif mid == "swamp_mushroom_b":
        make_mushroom(m, amber=True)
    elif mid == "landmark_giant_mushroom":
        make_mushroom(m, giant=True)
    elif mid == "coral_branch":
        make_coral_branch(m)
    elif mid == "coral_brain":
        make_brain_coral(m)
    elif mid == "coral_fan":
        make_fan_coral(m)
    elif mid in ("landmark_crystal", "ice_shard"):
        make_crystal(m, giant=mid == "landmark_crystal")
    elif mid == "volcano_obsidian":
        make_crystal(m, obsidian=True)
    elif mid == "landmark_arch":
        make_arch(m)
    elif mid == "landmark_obelisk":
        make_obelisk(m)
    elif mid == "landmark_ribs":
        make_ribs(m)
    elif mid == "landmark_vent":
        make_vent(m)
    elif mid in ("forest_stump", "forest_log", "beach_driftwood"):
        make_wood(m, "stump" if mid == "forest_stump" else ("drift" if mid == "beach_driftwood" else "log"))
    elif mid == "beach_starfish":
        make_starfish(m)
    elif mid == "swamp_lily":
        make_lily(m)
    elif mid == "pebbles":
        make_pebbles(m)
    elif mid == "desert_mesa":
        make_mesa(m)
    elif mid == "rock_slab":
        make_slab(m)
    elif mid in ("rock_a", "rock_b", "desert_boulder"):
        paint = gradient("#7d8580", "#b7b8a8", "#525e58", 0.065) if mid == "rock_a" else gradient("#7a7f83", "#b5b9b6", "#4c555b", 0.055)
        if mid == "desert_boulder":
            paint = gradient("#a96847", "#dca272", "#714936", 0.055)
        scale = (0.82, 0.7, 0.52) if mid == "rock_a" else ((0.9, 0.72, 0.62) if mid == "rock_b" else (0.82, 0.66, 0.48))
        rock(m, (0, 0, scale[2] * 0.72), scale, paint, seed=17 if mid == "rock_a" else 18, sub=2 if mid == "rock_a" else 1, rough=0.3 if mid == "rock_b" else 0.2)
        rock(m, (scale[0] * 0.68, -scale[1] * 0.32, 0.18), (scale[0] * 0.38, scale[1] * 0.36, 0.24), paint, seed=23, rough=0.24)
    elif mid == "snow_rock":
        make_snow_rock(m)
    elif mid == "swamp_mossrock":
        make_moss_rock(m)
    elif mid == "volcano_basalt":
        make_basalt(m)
    elif mid == "volcano_rock":
        make_volcano_rock(m)
    elif mid == "swamp_willow":
        make_willow(m)
    elif mid == "swamp_reeds":
        make_reeds(m)
    elif mid in ("snow_dead_tree", "swamp_snag", "volcano_charred"):
        make_dead(m, burnt=mid == "volcano_charred")
    else:
        raise KeyError(mid)
    sink = SINK.get(mid, 0.06)
    lo, hi = m.bounds()
    m.translate((0, 0, -sink - lo.z))
    return m


def tri_count(me):
    return sum(max(0, len(p.vertices) - 2) for p in me.polygons)


def material(name, glow=False):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.62 if glow else 0.88
    if glow:
        mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.4
    return mat


def planar_reduce(ob):
    mod = ob.modifiers.new("PlanarLOD", "DECIMATE")
    mod.decimate_type = "DISSOLVE"
    mod.angle_limit = math.radians(8)
    mod.delimit = {"NORMAL"}
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def bevel_object(ob, width):
    mod = ob.modifiers.new("EdgeSoften", "BEVEL")
    mod.width = width
    mod.segments = 1
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(24)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def make_object(name, pieces, collection, target=None, glow=False):
    verts, faces, colors = [], [], []
    offset = 0
    for p in pieces:
        verts.extend([tuple(v) for v in p.verts])
        faces.extend([tuple(offset + i for i in f) for f in p.faces])
        offset += len(p.verts)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    attr = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    cursor = 0
    for p in pieces:
        for _ in p.faces:
            if cursor >= len(me.polygons):
                break
            poly = me.polygons[cursor]
            if p.face_colors and cursor < len(p.face_colors):
                paint = p.face_colors[cursor]
            else:
                paint = p.paint(poly.center, poly.normal) if callable(p.paint) else p.paint
            paint = tuple(max(0.0, min(1.0, v)) for v in paint[:3])
            for li in poly.loop_indices:
                attr.data[li].color = (*paint, 1.0)
            poly.use_smooth = False
            cursor += 1
    bm = bmesh.new()
    bm.from_mesh(me)
    bad = [f for f in bm.faces if f.calc_area() < 1e-10]
    if bad:
        bmesh.ops.delete(bm, geom=bad, context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material("V2_Glow" if glow else "V2_VertexColor", glow))
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    if name == "landmark_arch":
        bevel_object(ob, 0.065)
    elif name == "landmark_obelisk":
        bevel_object(ob, 0.035)
    elif name in {"rock_a", "rock_b", "desert_boulder", "rock_slab", "desert_mesa", "snow_rock", "swamp_mossrock"}:
        bevel_object(ob, 0.025)
    if target and tri_count(me) > target:
        planar_reduce(ob)
    if target and tri_count(me) > target:
        mod = ob.modifiers.new("LOD", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max(0.04, target / tri_count(me))
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob


def decimate_copy(ob, name, collection, target):
    cp = ob.copy()
    cp.data = ob.data.copy()
    cp.data.name = name
    cp.name = name
    collection.objects.link(cp)
    if tri_count(cp.data) > target:
        planar_reduce(cp)
    if tri_count(cp.data) > target:
        mod = cp.modifiers.new("LOD", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max(0.04, target / tri_count(cp.data))
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = cp
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return cp


def export_glb(objects, path):
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objects:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_materials="NONE", export_vertex_color="ACTIVE", export_cameras=False,
        export_lights=False, export_animations=False, export_skins=False, export_morph=False,
        export_extras=True,
    )
    for ob in objects:
        ob.select_set(False)


def main():
    t0 = time.time()
    for path in (RENDERS, OUT_DIR):
        os.makedirs(path, exist_ok=True)
    with open(OLD_MANIFEST, "r", encoding="utf-8") as f:
        old_manifest = json.load(f)
    old_models = old_manifest["models"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Prefabs_V2"
    src = bpy.data.collections.new("Prefabs_Source")
    scene.collection.children.link(src)
    bpy.ops.import_scene.gltf(filepath=OLD_GLB)
    expected_keep = {mid + suffix for mid in KEEP for suffix in ("", "__glow", "__lod1", "__glow__lod1")}
    imported = []
    for ob in list(bpy.context.scene.objects):
        if ob.type == "MESH" and ob.name in expected_keep:
            for c in list(ob.users_collection):
                c.objects.unlink(ob)
            src.objects.link(ob)
            imported.append(ob.name)
        elif ob.type == "MESH":
            bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    missing_keep = sorted(expected_keep - set(imported))
    missing_keep = [x for x in missing_keep if not x.endswith("__glow") and not x.endswith("__glow__lod1")]
    if missing_keep:
        raise RuntimeError("kept meshes missing from old GLB: " + ", ".join(missing_keep))
    new_ids = sorted(set(old_models) - KEEP)
    made = {}
    for mid in new_ids:
        model = build_model(mid)
        main_pieces = [p for p in model.pieces if not p.glow]
        glow_pieces = [p for p in model.pieces if p.glow]
        near_target = {"meadow_bush": 700, "shrub_a": 700, "desert_shrub": 650}.get(mid)
        near = make_object(mid, main_pieces, src, target=near_target)
        glow = None
        if glow_pieces:
            glow = make_object(mid + "__glow", glow_pieces, src, glow=True)
        sink = SINK.get(mid, 0.06)
        ground_meshes = [near] + ([glow] if glow else [])
        delta = -sink - min(v.co.z for ob in ground_meshes for v in ob.data.vertices)
        for ob in (near, glow):
            if ob:
                for v in ob.data.vertices:
                    v.co.z += delta
                ob.data.update()
        lod_target = LOD_TARGET.get(mid, max(40, int(tri_count(near.data) * 0.32)))
        lod = decimate_copy(near, mid + "__lod1", src, lod_target)
        glow_lod = None
        if glow:
            glow_lod = decimate_copy(glow, mid + "__glow__lod1", src, max(24, int(tri_count(glow.data) * 0.38)))
        made[mid] = (near, lod, glow, glow_lod)
        print("[v2] %-26s near=%4d lod=%4d glow=%s" % (mid, tri_count(near.data), tri_count(lod.data), bool(glow)), flush=True)
    if set(made) != set(old_models) - KEEP:
        raise RuntimeError("model coverage mismatch")
    all_objects = list(src.all_objects)
    export_glb(all_objects, os.path.join(OUT_DIR, "prefabs.glb"))
    manifest = {"version": 2, "blender": bpy.app.version_string, "generated": time.strftime("%Y-%m-%d %H:%M:%S"), "glb": "prefabs.glb", "models": {}}
    for mid in sorted(old_models):
        entry = dict(old_models[mid])
        if mid in KEEP:
            manifest["models"][mid] = entry
            continue
        near, lod, glow, glow_lod = made[mid]
        lo = Vector(tuple(min(near.bound_box[i][j] for i in range(8)) for j in range(3)))
        hi = Vector(tuple(max(near.bound_box[i][j] for i in range(8)) for j in range(3)))
        if glow:
            lo = Vector(tuple(min(lo[j], min(glow.bound_box[i][j] for i in range(8))) for j in range(3)))
            hi = Vector(tuple(max(hi[j], max(glow.bound_box[i][j] for i in range(8))) for j in range(3)))
        entry["tris"] = tri_count(near.data) + (tri_count(glow.data) if glow else 0)
        entry["lod1Tris"] = tri_count(lod.data) + (tri_count(glow_lod.data) if glow_lod else 0)
        entry["glow"] = bool(glow)
        entry["size"] = [round(hi.x - lo.x, 3), round(hi.z - lo.z, 3), round(hi.y - lo.y, 3)]
        entry["base"] = round(lo.z, 3)
        entry["collide"] = COLLIDE.get(mid, False)
        entry["sink"] = SINK.get(mid, 0.06)
        if entry["kind"] in ("tree", "landmark") and entry["collide"] is False:
            entry["collide"] = {"r": round(max(hi.x - lo.x, hi.y - lo.y) * 0.24, 2), "h": round(hi.z - lo.z, 2)}
        manifest["models"][mid] = entry
    tmp = os.path.join(OUT_DIR, "prefabs.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.replace(tmp, os.path.join(OUT_DIR, "prefabs.json"))
    source_map = {ob.name: ob for ob in all_objects}
    report = {"generated": manifest["generated"], "kept": sorted(KEEP), "rebuilt": new_ids, "models": {}}
    for mid, entry in manifest["models"].items():
        near = source_map.get(mid)
        lod = source_map.get(mid + "__lod1")
        if not near or not lod:
            raise RuntimeError("missing near/lod object " + mid)
        for ob in (near, lod):
            if not ob.data.color_attributes:
                raise RuntimeError("missing vertex colors " + ob.name)
            for v in ob.data.vertices:
                if not all(math.isfinite(c) for c in v.co):
                    raise RuntimeError("non-finite vertex " + ob.name)
        if entry["lod1Tris"] > entry["tris"]:
            raise RuntimeError("LOD is larger " + mid)
        report["models"][mid] = {"tris": entry["tris"], "lod1Tris": entry["lod1Tris"], "size": entry["size"], "collide": entry["collide"]}
    report["totalNearTris"] = sum(x["tris"] for x in report["models"].values())
    report["totalLodTris"] = sum(x["lod1Tris"] for x in report["models"].values())
    with open(os.path.join(RENDERS, "build_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    print("[v2] done in %.1fs; %d models; near=%d lod=%d" % (time.time() - t0, len(manifest["models"]), report["totalNearTris"], report["totalLodTris"]), flush=True)


if __name__ == "__main__":
    main()
