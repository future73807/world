"""
mistlib.py — declarative recipe -> faceted low-poly mesh, for 迷雾群岛 (Blender 4.3, bpy).

A recipe is a list of parts. Every part is built as fairly dense geometry,
reduced to its triangle budget, and painted per FACE (flat low-poly shading).
All parts of a recipe are merged into one mesh per output object (main / glow).

The same library builds the shipped prefab library AND the models an AI designs
at runtime, so an AI-authored region uses exactly the pipeline the prefabs used.

Frames: recipes are written in the GAME's frame (Y up, right-handed, 1 unit = 1 BU)
and converted to Blender's Z-up frame at vertex creation.
"""
import colorsys
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector
from mathutils import noise as mnoise

TAU = math.tau

# --------------------------------------------------------------------------- colour


def _s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h, default=(0.5, 0.5, 0.5)):
    """'#rrggbb' or [r,g,b] in sRGB -> linear rgb tuple."""
    if isinstance(h, str):
        s = h.strip().lstrip("#")
        if len(s) == 3:
            s = "".join(ch * 2 for ch in s)
        try:
            return tuple(_s2l(int(s[i:i + 2], 16) / 255.0) for i in (0, 2, 4))
        except ValueError:
            return default
    if isinstance(h, (list, tuple)) and len(h) >= 3:
        return tuple(_s2l(max(0.0, min(1.0, float(c)))) for c in h[:3])
    return default


def mix(a, b, t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def smooth(t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return t * t * (3 - 2 * t)


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def shift_hue(col, dh, ds=0.0, dv=0.0):
    h, s, v = colorsys.rgb_to_hsv(col[0], col[1], col[2])
    return colorsys.hsv_to_rgb((h + dh) % 1.0, clamp(s + ds), clamp(v + dv))


# --------------------------------------------------------------------------- noise


def fbm(co, octaves=3, seed=0.0):
    q = Vector(co) + Vector((seed * 12.9898, seed * 78.233, seed * 37.719))
    s = 0.0
    a = 1.0
    f = 1.0
    n = 0.0
    for _ in range(octaves):
        s += mnoise.noise(q * f) * a
        n += a
        a *= 0.5
        f *= 2.03
    return s / n


# --------------------------------------------------------------------------- frames

def B(v):
    """game frame (x, y up, z) -> Blender frame (x, y, z up)"""
    return Vector((v[0], -v[2], v[1]))


def R(v):
    """Blender frame -> game frame"""
    return Vector((v.x, v.z, -v.y))


_C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
_CT = _C.transposed()


def apply_xf(bm, at, rot, scale):
    """scale, then rotate about the origin, then translate — in the GAME frame."""
    if at is None and rot is None and scale is None:
        return
    if scale is None:
        scale = (1, 1, 1)
    elif isinstance(scale, (int, float)):
        scale = (scale, scale, scale)
    M = Matrix.Translation(Vector(at if at is not None else (0, 0, 0)))
    if rot is not None:
        M = M @ Euler([math.radians(a) for a in rot], "XYZ").to_matrix().to_4x4()
    M = M @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))
    bmesh.ops.transform(bm, matrix=_C @ M @ _CT, verts=bm.verts)


def rot_matrix(rot):
    return Euler([math.radians(a) for a in rot], "XYZ").to_matrix()


# --------------------------------------------------------------------------- part


class Part:
    """One piece of geometry plus how it is painted and reduced."""

    __slots__ = ("bm", "paint", "tris", "glow", "closed", "planar", "planar_first", "keep", "ref", "tag")

    def __init__(self, bm, paint=None, tris=None, glow=False, closed=True, planar=0.0,
                 planar_first=False, keep=False, ref=None, tag=""):
        self.bm = bm
        self.paint = dict(paint or {})
        self.tris = tris
        self.glow = glow
        self.closed = closed
        self.planar = planar
        self.planar_first = planar_first
        self.keep = keep
        self.ref = ref
        self.tag = tag


class Ctx:
    def __init__(self, lod=0):
        self.lod = lod
        self.anchors = {}
        self.rnd = random.Random(1)


def _lod_int(spec, key, default, ctx, step=3, floor=4):
    v = spec.get(key, default)
    if ctx.lod == 1 and key not in spec:
        v = max(floor, v - step)
    return int(v)


def resolve_at(v, ctx, default=None):
    if v is None:
        return None if default is None else Vector(default)
    if isinstance(v, str):
        return Vector(ctx.anchors.get(v, {"c": (0, 0, 0)})["c"])
    if isinstance(v, (list, tuple)) and v and isinstance(v[0], str):
        base = Vector(ctx.anchors.get(v[0], {"c": (0, 0, 0)})["c"])
        off = list(v[1:4])
        while len(off) < 3:
            off.append(0.0)
        return base + Vector(off)
    return Vector([float(c) for c in v])


BUILDERS = {}
# parts that place themselves (they read `at` / anchors internally)
SELF_AT = {"canopy", "rock", "loft", "spikes", "bush"}
# parts assembled from several sub-parts. Their own "glow" key means "this thing has
# glowing sub-parts" (the builder decides which) — it must not light up the whole model.
COMPOSITE = {"tree", "pine", "mushroom", "cactus", "palm", "coral", "flower", "arch", "bush"}


def builder(name):
    def deco(fn):
        BUILDERS[name] = fn
        return fn
    return deco


def build_part(spec, ctx, out):
    """Build one part spec (composite parts recurse) and append its Part(s) to out."""
    typ = spec.get("type", "canopy")
    fn = BUILDERS.get(typ)
    if fn is None:
        raise ValueError("unknown part type: %r" % typ)
    before = len(out)
    fn(spec, ctx, out)
    base_paint = spec.get("paint")
    glow = None if typ in COMPOSITE else spec.get("glow")
    tris = spec.get("tris")
    if typ not in SELF_AT:
        at = resolve_at(spec.get("at"), ctx) if spec.get("at") is not None else None
        for p in out[before:]:
            apply_xf(p.bm, at, spec.get("rot"), spec.get("scale"))
    for p in out[before:]:
        if base_paint:
            for k, v in base_paint.items():
                p.paint.setdefault(k, v)
        if glow is not None:
            p.glow = bool(glow)
        if tris is not None:
            p.tris = tris if p.tris is None else min(p.tris, tris)
    if out and spec.get("anchor"):
        xs = [R(v.co) for p in out[before:] for v in p.bm.verts]
        ctx.anchors[spec["anchor"]] = {
            "c": (sum(v.x for v in xs) / len(xs), max(v.y for v in xs), sum(v.z for v in xs) / len(xs)),
            "top": max(v.y for v in xs),
        }
    return out[before:]


# --------------------------------------------------------------------------- reduce


def _reduce(bm, collapse=None, planar_deg=None):
    """Run Blender's Decimate modifier (collapse and/or planar) on a bmesh."""
    me = bpy.data.meshes.new("_mist_tmp")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("_mist_tmp", me)
    bpy.context.scene.collection.objects.link(ob)
    if planar_deg:
        m = ob.modifiers.new("planar", "DECIMATE")
        m.decimate_type = "DISSOLVE"
        m.angle_limit = math.radians(planar_deg)
        m.delimit = {"NORMAL"}
    if collapse is not None and collapse < 0.999:
        m = ob.modifiers.new("collapse", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = collapse
        m.use_collapse_triangulate = True
        m.use_symmetry = False
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me2 = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    out = bmesh.new()
    out.from_mesh(me2)
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(me)
    bpy.data.meshes.remove(me2)
    bmesh.ops.triangulate(out, faces=out.faces[:])
    return out


def _planar(bm, deg):
    return _reduce(bm, None, deg) if deg else bm


def _collapse(bm, target):
    n = len(bm.faces)
    if target and n > target:
        return _reduce(bm, max(0.02, target / float(n)), None)
    return bm


# --------------------------------------------------------------------------- paint


def _prep_paint(paint, bbox, frnd):
    """Resolve a paint spec into a per-face closure."""
    c1 = hex_rgb(paint.get("color", "#9aa39a"))
    c2 = hex_rgb(paint.get("color2", paint.get("color", "#9aa39a")))
    cu = hex_rgb(paint.get("under", "#4a5548"))
    mode = paint.get("mode", "uniform")
    zones = []
    for z in paint.get("zones", []):
        zones.append((z.get("y0", -1e9), z.get("y1", 1e9), hex_rgb(z.get("color", "#808080")), z.get("mode", "replace")))
    coat = paint.get("coat")
    if coat:
        coat = {
            "color": hex_rgb(coat.get("color", "#ffffff")),
            "t0": coat.get("t0", 0.55),
            "amount": coat.get("amount", 0.8),
            "freq": coat.get("freq", 1.6),
            "seed": frnd.uniform(0, 90),
            "y0": coat.get("y0", -1e9),
        }
    jitter = paint.get("jitter", 0.0)
    hue = paint.get("hue", 0.0)
    band_h = paint.get("bandH", 0.5)
    band_off = paint.get("bandOff", 0.0)
    y0, y1 = bbox[0].y, bbox[1].y
    span = max(1e-6, y1 - y0)

    def paint_face(c, n):
        up = clamp((n.y + 0.55) / 1.45)
        if mode == "height":
            col = mix(c1, c2, smooth(clamp((c.y - y0) / span)))
        elif mode == "normal":
            if up < 0.5:
                col = mix(cu, c1, smooth(up * 2.0))
            else:
                col = mix(c1, c2, smooth((up - 0.5) * 2.0))
        elif mode == "bands":
            k = (c.y + band_off) / band_h
            f = k - math.floor(k)
            on = math.floor(k) % 2 == 0
            col = mix(c1, c2, smooth((f - 0.35) / 0.3) if on else 1.0 - smooth((f - 0.35) / 0.3))
        else:
            col = c1
        for za, zb, zc, zm in zones:
            if za <= c.y < zb:
                col = zc if zm == "replace" else mix(col, zc, float(zm) if not isinstance(zm, str) else 0.5)
        if coat and c.y >= coat["y0"]:
            k = clamp((n.y - coat["t0"]) / max(1e-6, 1.0 - coat["t0"]))
            if k > 0:
                m = 0.5 + 0.5 * fbm((c.x * coat["freq"], c.y * coat["freq"], c.z * coat["freq"]), 2, coat["seed"])
                col = mix(col, coat["color"], k * coat["amount"] * (0.55 + 0.45 * m))
        if jitter:
            col = tuple(ch * (1.0 + (frnd.random() - 0.5) * 2.0 * jitter) for ch in col)
        if hue:
            col = shift_hue(col, (frnd.random() - 0.5) * 2.0 * hue)
        return col

    return paint_face


# --------------------------------------------------------------------------- mesh helpers


def _new_bm():
    return bmesh.new()


def _bm_verts(bm, pts):
    return [bm.verts.new(B(p)) for p in pts]


def _quad_up(bm, a, b, c, d, up):
    """Quad a-b-c-d wound so its face normal points along `up` (game-frame Vectors)."""
    n = (b - a).cross(c - a)
    if n.dot(up) < 0:
        a, b, c, d = d, c, b, a
    vs = _bm_verts(bm, (a, b, c, d))
    bm.faces.new(vs)


def _tri_up(bm, a, b, c, up):
    n = (b - a).cross(c - a)
    if n.dot(up) < 0:
        b, c = c, b
    bm.faces.new(_bm_verts(bm, (a, b, c)))


def _icosphere(sub=3):
    bm = _new_bm()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    return bm


def catmull(pts, radii, sub):
    """Catmull-Rom through the control points; `sub` spans between each pair."""
    if len(pts) == 1:
        return [pts[0]], [radii[0]]
    if len(pts) == 2:
        out, rs = [], []
        for s in range(sub + 1):
            t = s / float(sub)
            out.append(pts[0].lerp(pts[1], t))
            rs.append(radii[0] + (radii[1] - radii[0]) * t)
        return out, rs
    P = [pts[0]] + list(pts) + [pts[-1]]
    Q = [radii[0]] + list(radii) + [radii[-1]]
    out, rs = [], []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        r0, r1, r2, r3 = Q[i - 1], Q[i], Q[i + 1], Q[i + 2]
        for s in range(sub):
            t = s / float(sub)
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
            rs.append(0.5 * ((2 * r1) + (-r0 + r2) * t + (2 * r0 - 5 * r1 + 4 * r2 - r3) * t2 + (-r0 + 3 * r1 - 3 * r2 + r3) * t3))
    out.append(pts[-1])
    rs.append(radii[-1])
    return out, [max(0.004, r) for r in rs]


def limb_bm(path, radii, sides=8, sub=3, flare=0.0, flare_t=0.2, noise=0.0, noise_f=2.5,
            squash=(1.0, 1.0), wave=None, caps=True, seed=0.0):
    """Organic tapered tube swept along a smooth curve (game-frame input/output bmesh)."""
    pts, rs = catmull([Vector([float(c) for c in p]) for p in path], [float(r) for r in radii], max(1, sub))
    n = len(pts)
    T = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        T.append(t.normalized())
    N = T[0].orthogonal().normalized()
    frames = []
    for i in range(n):
        if i > 0:
            N = T[i - 1].rotation_difference(T[i]) @ N
            N = (N - T[i] * N.dot(T[i])).normalized()
        frames.append((N.copy(), T[i].cross(N).normalized()))
    bm = _new_bm()
    rings = []
    for i in range(n):
        t = i / float(n - 1)
        r = rs[i]
        if flare:
            r *= 1.0 + flare * max(0.0, 1.0 - t / flare_t) ** 2
        Nv, Bv = frames[i]
        ring = []
        for s in range(sides):
            a = s / float(sides) * TAU
            f = 1.0
            if wave:
                f *= 1.0 + wave[1] * math.cos(wave[0] * a)
            off = Nv * (math.cos(a) * r * f * squash[0]) + Bv * (math.sin(a) * r * f * squash[1])
            co = pts[i] + off
            if noise:
                co = pts[i] + off * (1.0 + noise * fbm((co.x * noise_f, co.y * noise_f, co.z * noise_f), 2, seed))
            ring.append(bm.verts.new(B(co)))
        rings.append(ring)
    for i in range(n - 1):
        A, Bq = rings[i], rings[i + 1]
        for s in range(sides):
            s2 = (s + 1) % sides
            bm.faces.new((A[s], Bq[s], Bq[s2], A[s2]))
    if caps:
        c0 = bm.verts.new(B(pts[0]))
        c1 = bm.verts.new(B(pts[-1]))
        for s in range(sides):
            s2 = (s + 1) % sides
            bm.faces.new((rings[0][s2], rings[0][s], c0))
            bm.faces.new((rings[-1][s], rings[-1][s2], c1))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    return bm


def loft_bm(rings, sides=8, at=(0, 0, 0), irreg=0.0, wave=None, caps=True, rot=0.0, seed=0.0, ref=None, tier=0.0, rnd=None):
    """Stack of rings (game frame). Each ring: {y, r | rx/rz, x, z, rot}.
    `tier` > 0 jitters each ring's centre, radius and rotation a little, so stacked
    slabs and mesas read as natural strata instead of a wedding cake."""
    at = Vector([float(c) for c in at])
    fac = []
    for s in range(sides):
        a = s / float(sides) * TAU
        f = 1.0 + irreg * fbm((math.cos(a) * 1.3, math.sin(a) * 1.3, 0.0), 2, seed)
        if wave:
            f *= 1.0 + wave[1] * math.cos(wave[0] * a)
        fac.append(f)
    bm = _new_bm()
    loops = []
    for ring in rings:
        y = float(ring.get("y", 0.0))
        r = ring.get("r", None)
        rx = float(ring.get("rx", r if r is not None else 0.0))
        rz = float(ring.get("rz", ring.get("rx", r) if r is not None else 0.0))
        cx = float(ring.get("x", 0.0))
        cz = float(ring.get("z", 0.0))
        rr = math.radians(ring.get("rot", rot))
        if tier and rnd is not None:
            cx += rnd.uniform(-tier, tier) * max(rx, rz)
            cz += rnd.uniform(-tier, tier) * max(rx, rz)
            k = 1.0 + rnd.uniform(-tier, tier)
            rx *= k
            rz *= k
            rr += rnd.uniform(-0.35, 0.35)
        if rx <= 1e-5 and rz <= 1e-5:
            loops.append([bm.verts.new(B(at + Vector((cx, y, cz))))])
            continue
        loop = []
        for s in range(sides):
            a = s / float(sides) * TAU + rr
            loop.append(bm.verts.new(B(at + Vector((cx + math.cos(a) * rx * fac[s], y, cz + math.sin(a) * rz * fac[s])))))
        loops.append(loop)
    for i in range(len(loops) - 1):
        A, Bq = loops[i], loops[i + 1]
        if len(A) == 1 and len(Bq) == 1:
            continue
        if len(A) == 1:
            for s in range(sides):
                bm.faces.new((A[0], Bq[s], Bq[(s + 1) % sides]))
        elif len(Bq) == 1:
            for s in range(sides):
                bm.faces.new((A[s], Bq[0], A[(s + 1) % sides]))
        else:
            for s in range(sides):
                s2 = (s + 1) % sides
                bm.faces.new((A[s], Bq[s], Bq[s2], A[s2]))
    if caps:
        if len(loops[0]) > 1:
            c = bm.verts.new(B(at + Vector((float(rings[0].get("x", 0.0)), float(rings[0].get("y", 0.0)), float(rings[0].get("z", 0.0))))))
            for s in range(sides):
                bm.faces.new((loops[0][(s + 1) % sides], loops[0][s], c))
        if len(loops[-1]) > 1:
            last = rings[-1]
            c = bm.verts.new(B(at + Vector((float(last.get("x", 0.0)), float(last.get("y", 0.0)), float(last.get("z", 0.0))))))
            for s in range(sides):
                bm.faces.new((loops[-1][s], loops[-1][(s + 1) % sides], c))
    closed = caps and ref is None
    if ref is None:
        ref = at
    # orient consistently away from the interior reference point
    bm.normal_update()
    inner = B(Vector(ref))
    score = 0.0
    for f in bm.faces:
        score += f.normal.dot(f.calc_center_median() - inner)
    if score < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    if closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    return bm


def blade_pts(length, width, segs, fold, bend, bend_pow=1.6, twist=0.0, base_w=0.14, flat=False):
    """Centreline + left/rib/right points of one blade along +Y, bending toward +X."""
    pts = []
    p = Vector((0, 0, 0))
    step = length / max(1, segs)
    for i in range(segs + 1):
        t = i / float(segs)
        th = bend * ((t + 0.5 / segs) ** bend_pow)
        d = Vector((math.sin(th), math.cos(th), 0.0))
        S = Vector((0.0, 0.0, 1.0))
        if twist:
            S = Matrix.Rotation(twist * t, 3, d) @ S
        N = d.cross(S).normalized()
        # lanceolate outline: narrow at the sheath, widest ~30% up, a fine tip
        w = width * math.sin(math.pi * min(1.0, base_w + (1.0 - base_w) * (t ** 0.7)))
        rib = p + N * (fold * w)
        left = p - S * w - N * (fold * w * 0.6)
        right = p + S * w - N * (fold * w * 0.6)
        pts.append((rib, left, right, N, flat or (i == segs)))
        p = p + d * step
    return pts


def add_blade(bm, pts, M=None, at=(0, 0, 0)):
    at = Vector(at)
    for i in range(len(pts) - 1):
        rib0, l0, r0, n0, _ = pts[i]
        rib1, l1, r1, n1, flat1 = pts[i + 1]
        if M is not None:
            rib0, l0, r0, rib1, l1, r1 = (M @ v for v in (rib0, l0, r0, rib1, l1, r1))
            n0 = M @ n0
        up = n0
        if (r0 - l0).length < 1e-6:
            continue
        # left panel (left -> rib), right panel (rib -> right)
        _quad_up(bm, l0 + at, rib0 + at, rib1 + at, l1 + at, up)
        _quad_up(bm, rib0 + at, r0 + at, r1 + at, rib1 + at, up)


def add_ribbon(bm, pts, M=None, at=(0, 0, 0)):
    """Flat strip version (2 tris per segment) for far LODs and petals."""
    at = Vector(at)
    for i in range(len(pts) - 1):
        _, l0, r0, n0, _ = pts[i]
        _, l1, r1, n1, _ = pts[i + 1]
        if M is not None:
            l0, r0, l1, r1 = (M @ v for v in (l0, r0, l1, r1))
            n0 = M @ n0
        if (r0 - l0).length < 1e-6 or (r1 - l1).length < 1e-6:
            _tri_up(bm, l0 + at, r0 + at, r1 + at, n0)
        else:
            _quad_up(bm, l0 + at, r0 + at, r1 + at, l1 + at, n0)


# --------------------------------------------------------------------------- builders


@builder("limb")
def b_limb(spec, ctx, out):
    path = spec.get("path") or [[0, -0.1, 0], [0, spec.get("h", 1.0), 0]]
    radii = spec.get("radii") or [spec.get("r", 0.1)] * len(path)
    sides = _lod_int(spec, "sides", 8, ctx)
    sub = spec.get("sub", 3 if ctx.lod == 0 else 2)
    bm = limb_bm(path, radii, sides, sub, flare=spec.get("flare", 0.0), flare_t=spec.get("flareT", 0.2),
                 noise=spec.get("noise", 0.0), noise_f=spec.get("noiseF", 2.5),
                 squash=tuple(spec.get("squash", (1.0, 1.0))), wave=spec.get("wave"), caps=spec.get("caps", True),
                 seed=ctx.rnd.uniform(0, 50))
    out.append(Part(bm, spec.get("paint"), spec.get("tris"), closed=spec.get("caps", True)))


@builder("loft")
def b_loft(spec, ctx, out):
    sides = _lod_int(spec, "sides", 8, ctx)
    bm = loft_bm(spec.get("rings", []), sides, at=spec.get("at", (0, 0, 0)), irreg=spec.get("irreg", 0.0),
                 wave=spec.get("wave"), caps=spec.get("caps", True), rot=spec.get("rot", 0.0),
                 seed=ctx.rnd.uniform(0, 50), ref=spec.get("ref"), tier=spec.get("tier", 0.0), rnd=ctx.rnd)
    out.append(Part(bm, spec.get("paint"), spec.get("tris"), closed=spec.get("caps", True) and spec.get("ref") is None,
                 glow=spec.get("glow", False), planar=spec.get("planar", 0.0)))


@builder("canopy")
def b_canopy(spec, ctx, out):
    at = resolve_at(spec.get("at", "crown"), ctx, (0, 0, 0))
    crown = ctx.anchors.get("crown", {"r": 1.0})
    size = spec.get("size") or [2.5 * crown["r"], 1.7 * crown["r"], 2.5 * crown["r"]]
    lobes = spec.get("lobes", 5)
    if ctx.lod == 1 and "lobes" not in spec:
        lobes = max(2, lobes - 3)
    noise = spec.get("noise", 0.14)
    nf = spec.get("noiseF", 1.7)
    seed = ctx.rnd.uniform(0, 200)
    cs, Rs = [Vector((0, 0, 0))], [spec.get("core", 0.6)]
    for i in range(max(0, lobes - 1)):
        a = i / float(max(1, lobes - 1)) * TAU + ctx.rnd.uniform(-0.3, 0.3)
        d = ctx.rnd.uniform(0.36, 0.6)
        Rc = ctx.rnd.uniform(0.46, 0.6)
        el = ctx.rnd.uniform(-0.28, 0.26)
        c = Vector((math.cos(a) * d, el * 0.9, math.sin(a) * d)) * math.sqrt(1.0 - el * el * 0.6)
        cs.append(c)
        Rs.append(max(Rc, c.length * 1.04))
    if spec.get("top"):
        cs.append(Vector((0.0, 0.42, 0.0)))
        Rs.append(0.5)
    bm = _icosphere(3)
    sx, sy, sz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    for v in bm.verts:
        d = R(v.co).normalized()
        r = 0.0
        for c, Rc in zip(cs, Rs):
            b = c.dot(d)
            disc = Rc * Rc - (c.length_squared - b * b)
            if disc >= 0:
                r = max(r, b + math.sqrt(disc))
        if r <= 0:
            r = 0.3
        r *= 1.0 + noise * (0.65 * fbm((d.x * nf, d.y * nf, d.z * nf), 2, seed) + 0.35 * fbm((d.x * nf * 2.7, d.y * nf * 2.7, d.z * nf * 2.7), 2, seed + 7))
        v.co = B(at + Vector((d.x * sx * r, d.y * sy * r, d.z * sz * r)))
    out.append(Part(bm, spec.get("paint"), spec.get("tris", 700), planar=spec.get("planar", 9.0)))


@builder("rock")
def b_rock(spec, ctx, out):
    """Faceted boulder: the convex hull of a jittered point cloud, so every stone is a
    handful of big clean facets instead of a smooth dome."""
    at = resolve_at(spec.get("at", (0, 0, 0)), ctx, (0, 0, 0))
    size = spec.get("size", [1.4, 1.0, 1.2])
    style = spec.get("style", "boulder")
    n = int(spec.get("points", {"boulder": 34, "angular": 15, "slab": 26}.get(style, 30)))
    if ctx.lod == 1 and "points" not in spec:
        n = max(10, int(n * 0.7))   # stones are cheap: keep most facets at distance
    noise = spec.get("noise", 0.24)
    seed = ctx.rnd.uniform(0, 200)
    sx, sy, sz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    floor = -sy * spec.get("flat", 0.34)
    bm = _new_bm()
    for i in range(n):
        y = 1.0 - 2.0 * (i + 0.5) / n
        r = math.sqrt(max(0.0, 1.0 - y * y))
        a = i * 2.39996323 + ctx.rnd.uniform(-0.3, 0.3)
        d = Vector((r * math.cos(a), y, r * math.sin(a))) + Vector((ctx.rnd.uniform(-1, 1), ctx.rnd.uniform(-1, 1), ctx.rnd.uniform(-1, 1))) * 0.24
        if d.length < 1e-6:
            continue
        d.normalize()
        rad = clamp(1.0 + noise * fbm((d.x * 1.3, d.y * 1.3, d.z * 1.3), 2, seed) + ctx.rnd.uniform(-0.07, 0.07), 0.8, 1.16)
        p = Vector((d.x * sx * rad, d.y * sy * rad, d.z * sz * rad))
        if p.y < floor:
            p.y = floor + (p.y - floor) * 0.15
        bm.verts.new(B(at + p))
    hull = bmesh.ops.convex_hull(bm, input=bm.verts[:])
    # a vertex can sit in both lists; handing the same element twice aborts the delete op
    gone = list({g: None for g in hull["geom_unused"] + hull["geom_interior"]})
    bmesh.ops.delete(bm, geom=gone, context="VERTS")
    # seat the stone on the ground: its flattened base sits just below y = 0
    ymin = min(R(v.co).y for v in bm.verts)
    bmesh.ops.translate(bm, vec=B((0, -0.06 - ymin, 0)), verts=bm.verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    out.append(Part(bm, spec.get("paint"), spec.get("tris")))


@builder("blade")
def b_blade(spec, ctx, out):
    """One leaf / petal / grass blade growing along +Y; `tilt`/`yaw`/`roll` orient it."""
    bm = _new_bm()
    segs = max(1, int(spec.get("segs", 3 if ctx.lod == 0 else 2)))
    pts = blade_pts(spec.get("len", 0.5), spec.get("w", 0.06), segs, spec.get("fold", 0.35),
                    math.radians(spec.get("bend", 40.0)), spec.get("bendPow", 1.6),
                    math.radians(spec.get("twist", 0.0)), spec.get("baseW", 0.16))
    M = _orient(spec.get("tilt", 0.0), spec.get("yaw", 0.0), spec.get("roll", 0.0))
    if spec.get("flat"):
        add_ribbon(bm, pts, M, (0, 0, 0))
    else:
        add_blade(bm, pts, M, (0, 0, 0))
    out.append(Part(bm, spec.get("paint"), None, closed=False, keep=True))


def _orient(tilt, yaw, roll=0.0):
    """Blade +Y axis: tilt toward +Z by `tilt` deg, then yaw about Y, then roll about the blade axis."""
    return Matrix.Rotation(math.radians(yaw), 3, "Y") @ Matrix.Rotation(math.radians(tilt), 3, "X") @ Matrix.Rotation(math.radians(roll), 3, "Y")


def _rot_y(a):
    return Matrix.Rotation(math.radians(a), 3, "Y")


def _rot_x(a):
    return Matrix.Rotation(math.radians(a), 3, "X")


def _rot_z(a):
    return Matrix.Rotation(math.radians(a), 3, "Z")


@builder("tuft")
def b_tuft(spec, ctx, out):
    """A clump of blades growing from one spot: grass, reeds, a sedge.

    `leafW` makes a share of the blades broad (the basal leaves of a reed);
    `heads` puts a seed head — a cattail's sausage on a stiff stem with a spike
    above it — on some of them; `plumes` adds feathery tips.
    """
    r = ctx.rnd
    bm = _new_bm()
    n = int(spec.get("n", 12))
    if ctx.lod == 1 and "n" not in spec:
        n = max(4, int(n * 0.42))
    lo, hi = spec.get("len", [0.3, 0.46])
    wl, wh = spec.get("w", [0.028, 0.042])
    spread = spec.get("spread", 0.5)
    segs = int(spec.get("segs", 3 if ctx.lod == 0 else 2))
    heads = int(spec.get("heads", 0))
    plumes = int(spec.get("plumes", 0))
    leaf_w = float(spec.get("leafW", 1.0))
    leaf_share = float(spec.get("leafShare", 0.0))
    stem_lo, stem_hi = spec.get("stem", [hi * 1.05, hi * 1.35])
    hp = None
    sp = None
    stalk_paint = spec.get("paint", {"color": "#7f8f48", "color2": "#c5c97a", "mode": "height"})
    for i in range(n):
        t = i / float(n)
        broad = leaf_w != 1.0 and r.random() < leaf_share
        headed = i < heads
        plumed = heads <= i < heads + plumes
        L = r.uniform(stem_lo, stem_hi) if (headed or plumed) else r.uniform(lo, hi) * (1.15 if broad else 1.0)
        w = (r.uniform(wl, wh) * (leaf_w if broad else 1.0)) * (1.6 if ctx.lod == 1 else 1.0)
        # seed stems stand nearly straight; the leaves lean out from the clump
        tilt = r.uniform(0.02, 0.12) if (headed or plumed) else (0.2 + r.random() * spread) if r.random() < 0.66 else r.random() * 0.16
        if spec.get("arch") and not (headed or plumed):
            # an arching leaf (a reed's): it rises from the clump and tips over away
            # from it, rising and falling in the one upright plane
            M = _rot_y(math.degrees(t * TAU + r.uniform(-0.6, 0.6))) @ _rot_x(r.uniform(*spec.get("lean", [0.12, 0.4]))) @ _rot_y(-90.0)
            pts = blade_pts(L, w, segs, spec.get("fold", 0.3), math.radians(r.uniform(*spec.get("bend", [50, 100]))), spec.get("bendPow", 1.4), 0.0, spec.get("baseW", 0.16))
        else:
            # _rot_y takes degrees: the yaw used to be passed in radians, so every
            # blade of a clump leaned the same way and tufts grew into flat fans
            M = _rot_y(math.degrees(t * TAU + r.uniform(-0.6, 0.6))) @ _rot_x(tilt)
            bend = r.uniform(-9, 9) if (headed or plumed) else r.uniform(*spec.get("bend", [-55, 55]))
            pts = blade_pts(L, w, segs, spec.get("fold", 0.3), math.radians(r.uniform(bend, bend * 0.4 if headed else bend)),
                            spec.get("bendPow", 1.7), 0.0, spec.get("baseW", 0.16))
        at = Vector((r.uniform(-0.07, 0.07), -0.015, r.uniform(-0.07, 0.07)))
        add_blade(bm, pts, M, at)
        if not (headed or plumed):
            continue
        tip = M @ pts[-1][0] + at
        if headed:
            # the cattail: a rounded sausage on the end of the stem, a bare spike above it
            hr = float(spec.get("headR", 0.035))
            hh = float(spec.get("headH", 0.2))
            hp = hp or spec.get("headPaint", {"color": "#6b4f36", "color2": "#8a6a48", "mode": "height"})
            out.append(Part(loft_bm([{"y": -0.012, "r": 0.0}, {"y": 0.018, "r": hr * 0.92}, {"y": 0.03, "r": hr},
                                     {"y": hh - hr * 0.7, "r": hr}, {"y": hh - hr * 0.2, "r": hr * 0.78}, {"y": hh, "r": 0.0}],
                                    6 if ctx.lod == 0 else 5, at=tip), hp))
            if ctx.lod == 0 or "heads" in spec:
                sp_bm = limb_bm([[0, hh - 0.02, 0], [0.004, hh + float(spec.get("spike", 0.14)) * 0.5, 0.003],
                                 [0.012, hh + float(spec.get("spike", 0.14)), 0.006]], [0.0075, 0.0055, 0.002], 4, 2, caps=True, seed=1.0)
                bmesh.ops.translate(sp_bm, vec=B(Vector(tip)), verts=sp_bm.verts)
                out.append(Part(sp_bm, stalk_paint))
        else:
            # a plume: a soft, tapered brush of seeds
            pl = float(spec.get("plumeLen", 0.28))
            sp = sp or spec.get("plumePaint", {"color": "#c9b98a", "color2": "#eadfc2", "mode": "height"})
            out.append(Part(loft_bm([{"y": -0.01, "r": 0.008}, {"y": pl * 0.22, "r": 0.042}, {"y": pl * 0.55, "r": 0.05},
                                     {"y": pl * 0.85, "r": 0.028}, {"y": pl, "r": 0.0}], 6 if ctx.lod == 0 else 5, at=tip,
                                    irreg=0.3, seed=r.uniform(0, 50)), sp))
    out.append(Part(bm, spec.get("paint"), None, closed=False, keep=True))


@builder("frond")
def b_frond(spec, ctx, out):
    """Palm/fern leaf: drooping rib with leaflets on both sides."""
    r = ctx.rnd
    bm = _new_bm()
    L = spec.get("len", 2.0)
    droop = math.radians(spec.get("droop", 62))
    nl = int(spec.get("leaflets", 16))
    if ctx.lod == 1 and "leaflets" not in spec:
        nl = max(5, int(nl * 0.5))
    lw = spec.get("w", 0.075)
    flat = ctx.lod == 1 and spec.get("lodFlat", True)
    # rib: starts along +X, curves downward
    p = Vector((0, 0, 0))
    rib = [p.copy()]
    steps = 10
    for i in range(steps):
        t = (i + 0.5) / steps
        ph = droop * (t ** 1.25)
        p = p + Vector((math.cos(ph), -math.sin(ph), 0.0)) * (L / steps)
        rib.append(p.copy())
    rw = spec.get("ribW", 0.035)
    for i in range(steps):
        a, b = rib[i], rib[i + 1]
        _quad_up(bm, a + Vector((0, 0, -rw)), a + Vector((0, 0, rw)), b + Vector((0, 0, rw)), b + Vector((0, 0, -rw)), Vector((0, 1, 0)))
    for i in range(nl):
        t = 0.1 + 0.86 * (i / float(max(1, nl - 1)))
        k = t * steps
        i0 = min(steps - 1, int(k))
        base = rib[i0].lerp(rib[i0 + 1], k - i0)
        ll = spec.get("leaflet", [0.42, 0.3]) if isinstance(spec.get("leaflet"), list) else [spec.get("leaflet", 0.42)] * 2
        length = (ll[0] * (1.0 - t) + ll[1] * t) * L
        length *= r.uniform(0.88, 1.08)
        for side in (-1.0, 1.0):
            # along the rib, swung sideways away from it, then angled downward
            M = _rot_z(-spec.get("sweep", 28)) @ _rot_y(-side * spec.get("flare", 62)) @ _rot_z(-90)
            pts = blade_pts(length, lw * (1.0 - 0.35 * t), 2 if not flat else 1, 0.3, math.radians(spec.get("leafBend", 38)), 1.4, 0.0, 0.1, flat)
            # far LOD: flat two-triangle leaflets are indistinguishable past ~25 BU
            (add_ribbon if flat else add_blade)(bm, pts, M, base)
    out.append(Part(bm, spec.get("paint"), None, closed=False, keep=True))


@builder("curtain")
def b_curtain(spec, ctx, out):
    """Hanging strands from the rim of a crown — weeping foliage, moss veils.

    Every strand starts just under the rim, tucked inside the foliage, and falls
    from there with a slight outward lean: nothing pierces the top or the sides of
    the crown, which is what strands rooted at its middle used to do.
    """
    r = ctx.rnd
    crown = ctx.anchors.get("crown", {"c": (0, 2, 0), "r": 1.4})
    c = resolve_at(spec.get("at", "crown"), ctx, (0, 2, 0))
    rad = spec.get("r", crown.get("r", 1.4))
    n = int(spec.get("n", 16))
    if ctx.lod == 1 and "n" not in spec:
        n = max(5, int(n * 0.45))
    lo, hi = spec.get("len", [1.2, 2.0])
    w = spec.get("w", 0.085)
    ylo, yhi = spec.get("yOff", [-0.45, -0.2])  # where under the rim the strand takes hold
    bm = _new_bm()
    for ring in range(int(spec.get("rings", 1))):
        k = 1.0 - ring * 0.22  # an inner ring hangs further in, and fills the curtain out
        for i in range(n):
            a = i / float(n) * TAU + r.uniform(-0.12, 0.12) + ring * 0.37 / n * TAU
            reach = rad * k * r.uniform(0.93, 1.04)
            base = c + Vector((math.cos(a) * reach, r.uniform(ylo, yhi), math.sin(a) * reach))
            # point the strand down, leaning a little outward; its own bend is a sway sideways
            M = _rot_y(90.0 - math.degrees(a)) @ _rot_x(180.0 - r.uniform(*spec.get("lean", [5, 16])))
            pts = blade_pts(r.uniform(lo, hi), w * r.uniform(0.8, 1.2), 3 if ctx.lod == 0 else 2, spec.get("fold", 0.3),
                            math.radians(r.uniform(*spec.get("bend", [-10, 10]))), spec.get("bendPow", 2.2), 0.0, 0.3)
            add_blade(bm, pts, M, base)
    out.append(Part(bm, spec.get("paint"), None, closed=False, keep=True))


@builder("spikes")
def b_spikes(spec, ctx, out):
    """Tiny pale thorns scattered over a vertical ribbed column surface."""
    r = ctx.rnd
    bm = _new_bm()
    n = int(spec.get("n", 40))
    if ctx.lod == 1:
        n = max(6, int(n * 0.3))
    r0, r1 = spec.get("r", [0.3, 0.26])
    y0, y1 = spec.get("y", [0.1, 2.0])
    at = Vector(spec.get("at", (0, 0, 0)))
    L = spec.get("len", 0.13)
    ribs = int(spec.get("ribs", 6))
    for i in range(n):
        t = r.random()
        a = r.choice([(k + 0.5) / ribs * TAU for k in range(ribs)]) + r.uniform(-0.06, 0.06)
        y = y0 + (y1 - y0) * t
        rad = (r0 + (r1 - r0) * t) * 1.0
        c = at + Vector((math.cos(a) * rad, y, math.sin(a) * rad))
        d = Vector((math.cos(a), r.uniform(-0.25, 0.45), math.sin(a))).normalized()
        tip = c + d * L
        s = Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))
        u = d.cross(s).normalized() * (L * 0.22)
        v = d.cross(u).normalized() * (L * 0.22)
        for k in range(3):
            a1 = k / 3.0 * TAU
            a2 = (k + 1) / 3.0 * TAU
            _tri_up(bm, c + u * math.cos(a1) + v * math.sin(a1), c + u * math.cos(a2) + v * math.sin(a2), tip, d)
    out.append(Part(bm, spec.get("paint"), None, closed=True, keep=True))


@builder("tree")
def b_tree(spec, ctx, out):
    """Trunk + root flare + branches, then a lobed canopy at the crown."""
    r = ctx.rnd
    h = spec.get("h", 4.6)
    r0 = spec.get("r0", 0.34)
    r1 = spec.get("r1", 0.1)
    bend = spec.get("bend", [0.3, -0.2])
    wob = spec.get("wobble", 0.1)
    bx, bz = bend
    bark = spec.get("bark", {"color": "#7d6249", "color2": "#a98a6a", "mode": "height"})
    flare = spec.get("flare", 0.42)
    sides = _lod_int(spec, "sides", 9, ctx)

    def axis(t):
        return [bx * t * t + wob * math.sin(t * 5.1) * 0.6, h * t, bz * t * t + wob * math.cos(t * 4.3) * 0.6]

    path = [[0, -0.4, 0], axis(0.28), axis(0.56), axis(0.8), axis(0.97)]
    trunk = limb_bm(path, [r0, r0 * 0.84, r0 * 0.62, r0 * 0.4, r1], sides, 3 if ctx.lod == 0 else 1,
                    flare=flare, flare_t=0.16, noise=spec.get("noise", 0.035), noise_f=3.0, seed=r.uniform(0, 50))
    out.append(Part(trunk, bark, spec.get("trunkTris")))
    roots = spec.get("roots")
    if roots and int(roots.get("n", 0)) > 0:
        n = int(roots["n"])
        L = roots.get("len", 0.9)
        rr = roots.get("r", 0.17)
        for i in range(n):
            a = i / float(n) * TAU + r.uniform(-0.3, 0.3)
            Lr = L * r.uniform(0.8, 1.15)
            dx, dz = math.cos(a), math.sin(a)
            p = [[dx * 0.05, 0.5, dz * 0.05], [dx * Lr * 0.42, 0.2, dz * Lr * 0.42],
                 [dx * Lr * 0.8, 0.03, dz * Lr * 0.8], [dx * Lr * 1.02, -0.18, dz * Lr * 1.02]]
            out.append(Part(limb_bm(p, [rr * 1.25, rr * 0.8, rr * 0.45, 0.02], 6 if ctx.lod == 0 else 4, 2 if ctx.lod == 0 else 1), bark))
    br = spec.get("branches")
    tips = []
    if br and int(br.get("n", 0)) > 0:
        n = int(br["n"])
        a0 = r.uniform(0, TAU)
        for i in range(n):
            a = a0 + i / float(n) * TAU + r.uniform(-0.35, 0.35)
            t = r.uniform(br.get("from", 0.52), br.get("to", 0.8))
            base = axis(t)
            L = r.uniform(*br.get("len", [1.0, 1.6]))
            rise = r.uniform(*br.get("rise", [0.4, 0.9]))
            tip = [base[0] + math.cos(a) * L, base[1] + rise, base[2] + math.sin(a) * L]
            mid = [base[0] + (tip[0] - base[0]) * 0.5, (base[1] + tip[1]) * 0.5 + 0.1, base[2] + (tip[2] - base[2]) * 0.5]
            rb = br.get("r", 0.1)
            out.append(Part(limb_bm([base, mid, tip], [rb, rb * 0.62, 0.03], 6 if ctx.lod == 0 else 4, 2 if ctx.lod == 0 else 1), bark))
            tips.append(tip)
    off = spec.get("crownOffset", [0, 0, 0])
    crown = [bx + off[0], h * spec.get("crownY", 0.95) + off[1], bz + off[2]]
    reach = max([math.hypot(tp[0] - crown[0], tp[2] - crown[2]) for tp in tips] or [h * 0.24])
    ctx.anchors["crown"] = {"c": crown, "r": max(0.8, reach)}
    can = spec.get("canopy")
    if can:
        build_part(dict(can, type="canopy"), ctx, out)


@builder("roots")
def b_roots(spec, ctx, out):
    """Flared roots gripping the ground around the foot of a trunk."""
    r = ctx.rnd
    n = int(spec.get("n", 4))
    L = float(spec.get("len", 0.9))
    rr = float(spec.get("r", 0.17))
    bark = spec.get("paint", spec.get("bark", {"color": "#7d6249", "color2": "#a98a6a", "mode": "height"}))
    for i in range(n):
        a = i / float(n) * TAU + r.uniform(-0.3, 0.3)
        Lr = L * r.uniform(0.8, 1.15)
        dx, dz = math.cos(a), math.sin(a)
        p = [[dx * 0.05, 0.5, dz * 0.05], [dx * Lr * 0.42, 0.2, dz * Lr * 0.42],
             [dx * Lr * 0.8, 0.03, dz * Lr * 0.8], [dx * Lr * 1.02, -0.18, dz * Lr * 1.02]]
        out.append(Part(limb_bm(p, [rr * 1.25, rr * 0.8, rr * 0.45, 0.02], 6 if ctx.lod == 0 else 4, 2 if ctx.lod == 0 else 1), bark))


@builder("bush")
def b_bush(spec, ctx, out):
    """A low shrub: lobed foliage resting on the ground, with a few bare twigs
    poking up through it. Nothing shows a trunk — a bush is all leaves from the
    ground up."""
    size = spec.get("size", [1.7, 1.3, 1.7])
    lobes = int(spec.get("lobes", 4))
    if ctx.lod == 1 and "lobes" not in spec:
        lobes = max(2, lobes - 1)
    paint = spec.get("paint", {"color": "#5fa24a", "color2": "#a9d47c", "under": "#35663a", "mode": "normal", "jitter": 0.05, "hue": 0.012})
    r = ctx.rnd
    # a big lobe and a smaller one leaning on it: two greens, never one even ball
    out_c = []
    build_part({"type": "canopy", "at": (0.0, size[1] * 0.46, 0.0), "size": size, "lobes": lobes, "noise": spec.get("noise", 0.2),
                "noiseF": spec.get("noiseF", 1.7), "tris": spec.get("tris", 340), "paint": paint}, ctx, out_c)
    a = r.uniform(0, TAU)
    k = float(spec.get("side", 0.62))
    build_part({"type": "canopy", "at": (math.cos(a) * size[0] * 0.3, size[1] * 0.34, math.sin(a) * size[2] * 0.3),
                "size": [size[0] * k, size[1] * k, size[2] * k], "lobes": 2, "noise": spec.get("noise", 0.2), "noiseF": spec.get("noiseF", 1.7),
                "tris": int(spec.get("tris", 340) * 0.45),
                "paint": dict(paint, hue=float(paint.get("hue", 0.012)) * 2.4)}, ctx, out_c)
    twigs = int(spec.get("twigs", 0))
    for i in range(twigs):
        ang = r.uniform(0, TAU)
        tip = (math.cos(ang) * size[0] * r.uniform(0.12, 0.34), size[1] * r.uniform(0.82, 1.04), math.sin(ang) * size[2] * r.uniform(0.12, 0.34))
        out.append(Part(limb_bm([[0, 0.05, 0], [tip[0] * 0.4, size[1] * 0.5, tip[2] * 0.4], tip], [0.035, 0.024, 0.008], 5 if ctx.lod == 0 else 4, 2),
                        spec.get("bark", {"color": "#6b5240", "color2": "#9a7c5e", "mode": "height"})))
    out.extend(out_c)
    ctx.anchors["crown"] = {"c": [0.0, size[1] * 0.8, 0.0], "r": size[0] * 0.5}


@builder("pine")
def b_pine(spec, ctx, out):
    r = ctx.rnd
    h = spec.get("h", 6.0)
    r0 = spec.get("r0", 0.2)
    bark = spec.get("bark", {"color": "#5b4634", "color2": "#7a624a", "mode": "height"})
    out.append(Part(limb_bm([[0, -0.35, 0], [0.02, h * 0.5, 0.01], [0.04, h * 0.93, 0.03]], [r0 * 1.5, r0 * 0.72, 0.03], 7 if ctx.lod == 0 else 5, 2 if ctx.lod == 0 else 1, flare=0.3), bark))
    layers = int(spec.get("layers", 4))
    if ctx.lod == 1 and "layers" not in spec:
        layers = max(2, layers - 1)
    base_r = spec.get("radius", h * 0.27)
    y0 = h * spec.get("skirt", 0.14)
    y1 = h * 0.97
    tier_h = (y1 - y0) / float(layers) * spec.get("overlap", 1.75)
    sides = _lod_int(spec, "sides", 9, ctx, step=3, floor=6)
    for i in range(layers):
        t = i / float(max(1, layers - 1))
        y = y0 + (y1 - y0) * t * 0.82
        R = base_r * (1.0 - t) ** 0.92 + 0.1
        lean = spec.get("lean", 0.0)
        at = (lean * t * h * 0.08, y, 0.0)
        rot = r.uniform(0, TAU)
        # one seed per tier: the snow shell and the needle tier underneath share
        # the same irregular outline, so neither pokes through the other
        sd = r.uniform(0, 50)
        wav = [sides // 3, 0.06] if sides >= 6 else None
        out.append(Part(loft_bm([{"y": 0, "r": R}, {"y": tier_h * 0.5, "r": R * 0.5}, {"y": tier_h, "r": 0.0}], sides, at=at, irreg=spec.get("irreg", 0.1), wave=wav, caps=True, rot=rot, seed=sd),
                        spec.get("needles", {"color": "#3f7f6a", "color2": "#7fc49a", "under": "#26524a", "mode": "normal", "jitter": 0.05})))
        if spec.get("snow"):
            # the snow blanket starts ~40% up the tier: the green skirt stays visible below it
            out.append(Part(loft_bm([{"y": tier_h * 0.40, "r": R * 0.66}, {"y": tier_h * 0.70, "r": R * 0.365}, {"y": tier_h + 0.06, "r": 0.0}], sides, at=at, irreg=spec.get("irreg", 0.1), wave=wav, caps=False, rot=rot, seed=sd),
                            spec.get("snowPaint", {"color": "#eef6fd", "color2": "#ffffff", "under": "#cfdfee", "mode": "normal", "jitter": 0.015}), ref=(at[0], at[1] + tier_h * 0.38, at[2])))
    ctx.anchors["crown"] = {"c": [0, y1, 0], "r": 0.4}


@builder("mushroom")
def b_mushroom(spec, ctx, out):
    """Stalk, a bell of a cap with a rolled rim, gills under it, and — if asked —
    spots lying flat on the cap and a skirt ring on the stalk. The stalk ends just
    above the gills, inside the cap: from below it disappears into them, from above
    it is under the cap, and nowhere does it poke through."""
    r = ctx.rnd
    h = spec.get("h", 1.8)
    cap_r = spec.get("capR", 0.9)
    cap_h = spec.get("capH", cap_r * 0.55)
    bend = spec.get("bend", 0.16)
    r0 = spec.get("r0", cap_r * 0.2)
    stalk = spec.get("stalk", {"color": "#d9cdb2", "color2": "#efe6cf", "mode": "height"})
    sides = _lod_int(spec, "sides", 12, ctx, step=4, floor=7)
    top = (bend, h, 0)
    ir = spec.get("irreg", 0.05)
    seed = r.uniform(0, 50)
    # the cap's outline from the rim to the tip: (share of the radius, share of the height)
    profile = spec.get("profile", [(0.96, -0.02), (1.0, 0.12), (0.88, 0.44), (0.62, 0.74), (0.3, 0.93), (0.0, 1.0)])
    rt = r0 * 1.25  # the stalk widens into the gills
    gill_y = 0.2  # share of the cap's height at which the gills meet the stalk
    gill_in = max(0.16, rt * 1.02 / cap_r)
    out.append(Part(limb_bm([[0, -0.25, 0], [bend * 0.3, h * 0.45, 0], [bend * 0.8, h * 0.86, 0], [bend, h + cap_h * (gill_y + 0.06), 0]],
                            [r0 * 1.6, r0 * 0.95, r0 * 0.85, rt], 8 if ctx.lod == 0 else 5, 2, flare=spec.get("flare", 0.35)), stalk))
    out.append(Part(loft_bm([{"y": cap_h * y, "r": cap_r * rr} for rr, y in profile], sides, at=top, irreg=ir, caps=False, seed=seed),
                    spec.get("cap", {"color": "#c9603f", "color2": "#e6926a", "mode": "normal", "jitter": 0.04}), ref=(bend, h + cap_h * 0.45, 0)))
    gill = spec.get("gill", {"color": "#b9a98a", "mode": "uniform"})
    out.append(Part(loft_bm([{"y": cap_h * profile[0][1], "r": cap_r * profile[0][0]}, {"y": cap_h * 0.1, "r": cap_r * 0.6}, {"y": cap_h * gill_y, "r": cap_r * gill_in}],
                            sides, at=top, irreg=ir, caps=False, seed=seed),
                    gill, glow=spec.get("glow", False), ref=(bend, h + cap_h * 0.5, 0)))
    if spec.get("ring"):
        # the skirt: what is left of the veil that once joined the rim to the stalk
        y = h * spec.get("ringY", 0.68)
        out.append(Part(loft_bm([{"y": 0.0, "r": rt * 1.04}, {"y": -cap_h * 0.035, "r": rt * 1.7}, {"y": -cap_h * 0.085, "r": rt * 2.05}],
                                sides, at=(bend * y / h, y, 0), caps=False, seed=seed),
                        spec.get("ringPaint", stalk), ref=(bend * y / h, y + cap_h * 0.1, 0)))
    k = int(spec.get("spots", 0))
    if ctx.lod == 1 and "spots" not in spec:
        k = k // 2
    for i in range(k):
        t = r.uniform(0.14, 0.9)
        # where along the outline, read by segment; with it the slope of the cap there
        f = t * (len(profile) - 1)
        j = min(len(profile) - 2, int(f))
        u = f - j
        (r0_, y0_), (r1_, y1_) = profile[j], profile[j + 1]
        rr = (r0_ + (r1_ - r0_) * u) * (1.0 + ir * 0.4)
        yy = y0_ + (y1_ - y0_) * u
        tilt = math.atan2(max(1e-4, (y1_ - y0_) * cap_h), max(1e-4, abs(r1_ - r0_) * cap_r))  # the surface's slope there
        a = r.uniform(0, TAU)
        # a spot lies on the cap like a patch: a shallow disc turned to the cap's slope at that point
        sr = cap_r * float(spec.get("spotR", 0.11)) * r.uniform(0.8, 1.2)
        bm = loft_bm([{"y": -sr * 0.12, "r": sr * 0.9}, {"y": sr * 0.1, "r": sr}, {"y": sr * 0.3, "r": sr * 0.55}, {"y": sr * 0.36, "r": 0.0}],
                     6 if ctx.lod == 0 else 5, at=(0, 0, 0), caps=True)
        d = Vector((math.cos(a), 0.0, math.sin(a)))
        nrm = Vector((d.x * math.sin(tilt), math.cos(tilt), d.z * math.sin(tilt)))
        c = Vector(top) + Vector((d.x * rr * cap_r, yy * cap_h, d.z * rr * cap_r)) - nrm * (sr * 0.04)
        M = Matrix.Rotation(tilt, 3, Vector((0.0, 1.0, 0.0)).cross(d).normalized())
        bmesh.ops.transform(bm, matrix=_C @ M.to_4x4() @ _CT, verts=bm.verts)
        bmesh.ops.translate(bm, vec=B(c), verts=bm.verts)
        out.append(Part(bm, spec.get("spotPaint", {"color": "#fff4e2", "mode": "uniform"})))
    ctx.anchors["crown"] = {"c": [bend, h + cap_h, 0], "r": cap_r}


@builder("cactus")
def b_cactus(spec, ctx, out):
    r = ctx.rnd
    h = spec.get("h", 2.4)
    rad = spec.get("r", 0.3)
    ribs = int(spec.get("ribs", 6))
    sides = ribs * 2
    skin = spec.get("skin", {"color": "#4f9a5f", "color2": "#86c77a", "mode": "normal", "under": "#2f6a44", "jitter": 0.04})
    # body: a ribbed column with a rounded top, gently leaning
    lean = spec.get("lean", [0.06, 0.0])
    rings = []
    n = 7
    for i in range(n + 1):
        t = i / float(n)
        rr = rad * (1.0 - 0.16 * t)
        if t > 0.86:
            rr *= math.sqrt(max(0.0, 1.0 - ((t - 0.86) / 0.14) ** 2)) * 0.9 + 0.1
        rings.append({"y": h * t, "r": rr, "x": lean[0] * t * t, "z": lean[1] * t * t})
    rings[-1]["r"] = 0.0
    out.append(Part(loft_bm(rings, sides, irreg=0.0, wave=[ribs, spec.get("ribDepth", 0.1)], caps=True, seed=1), skin, planar=0.0))
    arms = spec.get("arms", [])
    for a in arms:
        side, yy, al, up = a[0], h * a[1], rad * a[2], rad * a[3]
        sgn = 1.0 if side >= 0 else -1.0
        path = [[0, yy, 0], [sgn * al * 0.55, yy + 0.02, 0], [sgn * al, yy + up * 0.35, 0], [sgn * al, yy + up, 0]]
        ra = rad * 0.62
        out.append(Part(limb_bm(path, [ra, ra, ra * 0.92, ra * 0.5], sides, 3, wave=[ribs, spec.get("ribDepth", 0.1)], seed=3), skin))
    # a rounded cap on each arm tip
    for a in arms:
        side, yy, al, up = a[0], h * a[1], rad * a[2], rad * a[3]
        sgn = 1.0 if side >= 0 else -1.0
        ra = rad * 0.62
        out.append(Part(loft_bm([{"y": 0, "r": ra * 0.5}, {"y": ra * 0.3, "r": ra * 0.42}, {"y": ra * 0.55, "r": 0.0}], sides, at=(sgn * al, yy + up - 0.02, 0), wave=[ribs, spec.get("ribDepth", 0.1)]), skin))
    if spec.get("spines", True):
        build_part({"type": "spikes", "n": spec.get("spineN", 44), "r": [rad, rad * 0.8], "y": [0.12, h * 0.9], "len": spec.get("spineLen", 0.12), "ribs": ribs,
                    "paint": spec.get("spinePaint", {"color": "#f2e9b8", "mode": "uniform"})}, ctx, out)
    flower = spec.get("flower")
    if flower:
        build_part(dict(flower, type="canopy", at=(lean[0], h * 0.985, lean[1]), lobes=1 if "lobes" not in flower else flower["lobes"]), ctx, out)
    ctx.anchors["crown"] = {"c": [lean[0], h, lean[1]], "r": rad}


@builder("palm")
def b_palm(spec, ctx, out):
    r = ctx.rnd
    h = spec.get("h", 6.0)
    lean = spec.get("lean", [1.2, 0.3])
    r0 = spec.get("r0", 0.3)
    bark = spec.get("bark", {"color": "#8a6b4b", "color2": "#b08d63", "mode": "bands", "bandH": 0.42, "jitter": 0.05})
    path = [[0, -0.3, 0], [lean[0] * 0.08, h * 0.3, lean[1] * 0.08], [lean[0] * 0.35, h * 0.62, lean[1] * 0.35], [lean[0] * 0.75, h * 0.86, lean[1] * 0.75], [lean[0], h, lean[1]]]
    out.append(Part(limb_bm(path, [r0 * 1.5, r0 * 0.95, r0 * 0.72, r0 * 0.55, r0 * 0.48], 8 if ctx.lod == 0 else 6, 4 if ctx.lod == 0 else 2, flare=0.35), bark))
    top = Vector((lean[0], h, lean[1]))
    nf = int(spec.get("fronds", 9))
    if ctx.lod == 1 and "fronds" not in spec:
        nf = max(5, nf - 3)
    fl = spec.get("frondLen", h * 0.42)
    a0 = r.uniform(0, TAU)
    for i in range(nf):
        a = a0 + i / float(nf) * TAU + r.uniform(-0.12, 0.12)
        lift = r.uniform(*spec.get("lift", [-6, 14]))
        before = len(out)
        build_part({"type": "frond", "len": fl * r.uniform(0.86, 1.1),
                    "leaflets": (spec.get("leaflets", 18) if ctx.lod == 0 else max(6, int(spec.get("leaflets", 18) * 0.45))),
                    "droop": spec.get("droop", 64),
                    "paint": spec.get("leaf", {"color": "#5aa648", "color2": "#9bd36a", "under": "#3a7a3a", "mode": "normal", "jitter": 0.05, "hue": 0.012})}, ctx, out)
        # pitch the frond up in its own frame, swing it round the trunk axis, move it to the crown
        M = rot_matrix([0, math.degrees(a), 0]) @ _rot_z(lift)
        Mb = (_C @ M.to_4x4() @ _CT)
        for p in out[before:]:
            bmesh.ops.transform(p.bm, matrix=Mb, verts=p.bm.verts)
            bmesh.ops.translate(p.bm, vec=B(top), verts=p.bm.verts)
    if spec.get("coconuts", 3) > 0:
        k = int(spec["coconuts"])
        for i in range(k):
            a = i / float(k) * TAU + 0.4
            c = top + Vector((math.cos(a) * 0.22, -0.2, math.sin(a) * 0.22))
            out.append(Part(loft_bm([{"y": -0.13, "r": 0.0}, {"y": -0.06, "r": 0.13}, {"y": 0.08, "r": 0.13}, {"y": 0.15, "r": 0.0}], 7, at=c), spec.get("nut", {"color": "#6b4f33", "color2": "#8c6a42", "mode": "height"})))
    ctx.anchors["crown"] = {"c": list(top), "r": fl * 0.5}


@builder("coral")
def b_coral(spec, ctx, out):
    """Branching coral: a short trunk that splits into tapered fingers."""
    r = ctx.rnd
    n = int(spec.get("fingers", 7))
    if ctx.lod == 1 and "fingers" not in spec:
        n = max(3, n - 3)
    h = spec.get("h", 0.9)
    rad = spec.get("r", 0.1)
    paint = spec.get("paint", {"color": "#f08a9a", "color2": "#ffc2c8", "under": "#b8526e", "mode": "normal", "jitter": 0.05})
    sides = 6 if ctx.lod == 0 else 4
    out.append(Part(limb_bm([[0, -0.1, 0], [0, h * 0.22, 0]], [rad * 2.1, rad * 1.5], sides, 2), paint))
    flat = bool(spec.get("flat"))
    for i in range(n):
        a = i / float(n) * TAU + r.uniform(-0.3, 0.3)
        tilt = r.uniform(0.2, 0.75)
        L = h * r.uniform(0.7, 1.1)
        if flat:
            # a sea fan: the fingers all lie in one upright plane and spread like a hand
            a = math.pi * 0.5 + r.uniform(-0.06, 0.06)
            tilt = 0.12 + 1.15 * (i / float(max(1, n - 1))) + r.uniform(-0.06, 0.06)
            L = h * (0.62 + 0.42 * math.sin(math.pi * (0.15 + 0.85 * i / float(max(1, n - 1)))))
        d = Vector((math.cos(a) * math.sin(tilt), math.cos(tilt), math.sin(a) * math.sin(tilt)))
        p0 = Vector((0, h * 0.2, 0))
        p1 = p0 + d * L * 0.55 + Vector((0, 0.06, 0))
        p2 = p0 + d * L
        out.append(Part(limb_bm([p0, p1, p2], [rad * 1.1, rad * 0.7, 0.012], sides, 2), paint))
        if ctx.lod == 0:
            d2 = (d + Vector((r.uniform(-0.7, 0.7), 0.25, r.uniform(-0.7, 0.7)))).normalized()
            out.append(Part(limb_bm([p1, p1 + d2 * L * 0.4], [rad * 0.55, 0.01], sides, 2), paint))
    ctx.anchors["crown"] = {"c": [0, h, 0], "r": h * 0.6}


@builder("crystal")
def b_crystal(spec, ctx, out):
    """Cluster of sharp prismatic shards growing from one root."""
    r = ctx.rnd
    n = int(spec.get("shards", 5))
    if ctx.lod == 1 and "shards" not in spec:
        n = max(2, n - 3)
    h = spec.get("h", 2.2)
    sides = int(spec.get("sides", 5))
    paint = spec.get("paint", {"color": "#6fc7d6", "color2": "#d9fbff", "under": "#2f7f96", "mode": "normal", "jitter": 0.06})
    for i in range(n):
        a = i / float(n) * TAU + r.uniform(-0.4, 0.4)
        dist = 0.0 if i == 0 else r.uniform(0.18, 0.42) * h * 0.5
        hh = h * (1.0 if i == 0 else r.uniform(0.4, 0.75))
        tilt = 0.0 if i == 0 else r.uniform(0.12, 0.5)
        rad = h * 0.13 * (1.0 if i == 0 else r.uniform(0.6, 0.9))
        base = Vector((math.cos(a) * dist, -0.15, math.sin(a) * dist))
        rings = [{"y": 0, "r": rad * 1.1}, {"y": hh * 0.72, "r": rad * 0.86}, {"y": hh, "r": 0.0}]
        bm = loft_bm(rings, sides, at=base, irreg=0.08, rot=r.uniform(0, TAU), seed=r.uniform(0, 50))
        # tilt away from the centre
        d = Vector((math.cos(a), 0, math.sin(a)))
        axis = Vector((0, 1, 0)).cross(d).normalized() if d.length > 1e-6 else Vector((1, 0, 0))
        M = Matrix.Rotation(tilt, 3, axis)
        bmesh.ops.transform(bm, matrix=_C @ M.to_4x4() @ _CT, verts=bm.verts)
        out.append(Part(bm, paint, glow=spec.get("glow", False)))
    ctx.anchors["crown"] = {"c": [0, h, 0], "r": h * 0.3}


@builder("arch")
def b_arch(spec, ctx, out):
    """Weathered stone arch: a chain of chunky blocks bent along an arc, broad
    where the weight lands at the feet and slender under the crown, roughened and
    dissolved into big flat facets so it reads as rock, not as a bent pipe."""
    r = ctx.rnd
    span = spec.get("span", 5.0)
    rise = spec.get("rise", 5.6)
    thick = spec.get("thick", 1.1)
    lean = spec.get("lean", 0.0)  # how far the crown sits off the middle
    n = 14 if ctx.lod == 0 else 9
    path, radii = [], []
    for i in range(n + 1):
        t = i / float(n)
        s = math.sin(math.pi * t)
        x = (t - 0.5) * span + lean * s
        y = rise * s ** 0.8 - 0.5 * (1.0 - s)
        path.append([x + r.uniform(-0.06, 0.06), max(-0.6, y) + r.uniform(-0.05, 0.05), r.uniform(-0.08, 0.08)])
        # block over block: every second one stands a little proud
        foot = abs(math.cos(math.pi * t)) ** 1.6
        voussoir = 1.0 if i % 2 else 0.9
        radii.append(thick * (0.5 + 0.75 * foot) * voussoir * r.uniform(0.94, 1.06))
    stone = spec.get("paint", {"color": "#8c8f8a", "color2": "#b4b6ae", "under": "#5c625f", "mode": "normal", "jitter": 0.05,
                               "coat": {"color": "#8fb46a", "t0": 0.5, "amount": 0.7}})
    bm = limb_bm(path, radii, 7 if ctx.lod == 0 else 5, 3 if ctx.lod == 0 else 2, noise=0.2, noise_f=1.0,
                 squash=(1.0, 0.72), seed=r.uniform(0, 50))
    out.append(Part(bm, stone, spec.get("tris", 420), planar=14.0))
    ctx.anchors["crown"] = {"c": [lean, rise, 0], "r": span * 0.5}


@builder("flower")
def b_flower(spec, ctx, out):
    r = ctx.rnd
    h = spec.get("h", 0.45)
    petal = spec.get("petal", "#fdf6e2")
    core = spec.get("core", "#e8c06e")
    leaves = int(spec.get("leaves", 2))
    stem = {"color": "#5f9454", "color2": "#86b86e", "mode": "height"}
    lean = spec.get("lean", 0.12)
    top = (lean, h, lean * 0.4)
    out.append(Part(limb_bm([[0, -0.05, 0], [lean * 0.4, h * 0.55, lean * 0.2], top], [0.024, 0.018, 0.014], 4, 2), stem))
    for i in range(leaves):
        a = r.uniform(0, TAU)
        build_part({"type": "blade", "len": h * 0.5, "w": h * 0.13, "segs": 2, "fold": 0.25, "bend": 70, "tilt": 62, "yaw": math.degrees(a),
                    "at": (lean * 0.15, h * 0.3, lean * 0.06), "paint": {"color": "#6aa55a", "color2": "#a4d47c", "mode": "normal"}}, ctx, out)
    k = int(spec.get("petals", 5))
    for i in range(k):
        a = i / float(k) * TAU + r.uniform(-0.1, 0.1)
        pr = h * spec.get("petalLen", 0.24)
        build_part({"type": "blade", "len": pr, "w": pr * 0.55, "segs": 2, "fold": 0.18, "bend": 22, "tilt": 80, "yaw": math.degrees(a), "flat": True,
                    "at": top, "paint": {"color": petal, "color2": petal, "mode": "normal"}}, ctx, out)
    out.append(Part(loft_bm([{"y": -0.01, "r": h * 0.05}, {"y": h * 0.035, "r": h * 0.06}, {"y": h * 0.07, "r": 0.0}], 6, at=top),
                    {"color": core, "color2": core, "mode": "uniform"}))
    ctx.anchors["crown"] = {"c": list(top), "r": h * 0.2}
