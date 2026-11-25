"""
mistbuild.py — turn a recipe into painted mesh objects, a GLB and a manifest entry.

Shared by the shipped prefab library (build_prefabs.py) and by the runtime
builder the game server calls when an AI designs a new model (build_recipe.py).
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import mistlib as L  # noqa: E402


class Geo:
    """Triangle soup in the GAME frame with one linear rgb colour per face."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.colors = []

    def add(self, vs, fs, cols):
        o = len(self.verts)
        self.verts.extend(vs)
        self.faces.extend([(f[0] + o, f[1] + o, f[2] + o) for f in fs])
        self.colors.extend(cols)

    @property
    def tris(self):
        return len(self.faces)

    def bbox(self):
        if not self.verts:
            return (0, 0, 0), (0, 0, 0)
        xs = [v[0] for v in self.verts]
        ys = [v[1] for v in self.verts]
        zs = [v[2] for v in self.verts]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    def size(self):
        lo, hi = self.bbox()
        return [round(hi[i] - lo[i], 3) for i in range(3)]


def _extract(bm):
    bm.verts.index_update()
    bm.verts.ensure_lookup_table()
    vs = [(v.co.x, v.co.z, -v.co.y) for v in bm.verts]
    fs = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return vs, fs


def _finalize(p, lod, ratio):
    bm = p.bm
    if p.closed:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    n0 = len(bm.faces)
    if lod == 0:
        if p.planar and p.planar_first:
            bm = L._planar(bm, p.planar)
        bm = L._collapse(bm, p.tris)
        if p.planar and not p.planar_first:
            bm = L._planar(bm, p.planar)
        if p.tris:
            bm = L._collapse(bm, p.tris)
    else:
        target = p.tris * ratio if p.tris else n0 * 0.5
        if not p.keep:
            bm = L._collapse(bm, max(8, int(target)))
        if p.planar:
            bm = L._planar(bm, p.planar + 2.0)
    if any(len(f.verts) != 3 for f in bm.faces):
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
    vs, fs = _extract(bm)
    return vs, fs


def _paint(vs, fs, paint, seed):
    lo, hi = Geo.bbox_static(vs)
    fn = L._prep_paint(paint, (Vector(lo), Vector(hi)), random.Random(seed))
    cols = []
    for a, b, c in fs:
        pa, pb, pc = Vector(vs[a]), Vector(vs[b]), Vector(vs[c])
        n = (pb - pa).cross(pc - pa)
        if n.length < 1e-12:
            n = Vector((0.0, 1.0, 0.0))
        else:
            n = n / n.length
        cols.append(fn((pa + pb + pc) / 3.0, n))
    return cols


def _bbox_static(vs):
    xs = [v[0] for v in vs]
    ys = [v[1] for v in vs]
    zs = [v[2] for v in vs]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


Geo.bbox_static = staticmethod(_bbox_static)


def build_recipe(recipe, lod=0):
    """Build one recipe at one LOD. Returns {"main": Geo, "glow": Geo}."""
    seed = int(recipe.get("seed", 1))
    ctx = L.Ctx(lod)
    parts = []
    for i, raw in enumerate(recipe.get("parts", [])):
        spec = dict(raw)
        if lod == 1 and isinstance(raw.get("lod1"), dict):
            spec.update(raw["lod1"])
        ctx.rnd = random.Random(seed * 7919 + i * 131 + 7)
        L.build_part(spec, ctx, parts)
    ratio = float(recipe.get("lodRatio", 0.25))
    geos = {"main": Geo(), "glow": Geo()}
    for j, p in enumerate(parts):
        vs, fs = _finalize(p, lod, ratio)
        if not fs:
            continue
        geos["glow" if p.glow else "main"].add(vs, fs, _paint(vs, fs, p.paint, seed * 31 + j))
    return geos


# --------------------------------------------------------------------------- objects


def mist_material(glow=False):
    name = "Mist_Glow" if glow else "Mist_VertexColor"
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    attr.location = (-420, 120)
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    if glow:
        nt.links.new(attr.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.25
        bsdf.inputs["Roughness"].default_value = 0.6
    return m


def make_object(name, geo, collection):
    me = bpy.data.meshes.new(name)
    me.from_pydata([L.B(v) for v in geo.verts], [], geo.faces)
    me.update()
    for poly in me.polygons:
        poly.use_smooth = False
    attr = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    for i, poly in enumerate(me.polygons):
        # Clamped: the glTF exporter scales a colour by 65535 and casts to an
        # unsigned short, so a channel a hair above 1 (white with its jitter)
        # wrapped round to almost 0 — snow with yellow wedges in it.
        c = [max(0.0, min(1.0, v)) for v in geo.colors[i]]
        for li in poly.loop_indices:
            attr.data[li].color = (c[0], c[1], c[2], 1.0)
    me.materials.append(mist_material(name.endswith("__glow") or name.endswith("__glow__lod1")))
    ob = bpy.data.objects.new(name, me)
    collection.objects.link(ob)
    return ob


def export_glb(objects, filepath):
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objects:
        ob.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=True,
    )
    for ob in objects:
        ob.select_set(False)


def manifest_entry(recipe, lod0, lod1):
    lo, hi = lod0["main"].bbox()
    for g in lod0.values():
        if g.tris:
            l2, h2 = g.bbox()
            lo = [min(lo[i], l2[i]) for i in range(3)]
            hi = [max(hi[i], h2[i]) for i in range(3)]
    col = recipe.get("collide")
    if col is None:
        col = {"r": round(max(hi[0] - lo[0], hi[2] - lo[2]) * 0.5 * 0.82, 3), "h": round(hi[1], 3)}
    if col is False:
        col = False
    return {
        "id": recipe["id"],
        "label": recipe.get("label", recipe["id"]),
        "kind": recipe.get("kind", "prop"),
        "biomes": recipe.get("biomes", []),
        "desc": recipe.get("desc", ""),
        "group": recipe.get("group", ""),
        "tris": lod0["main"].tris + lod0["glow"].tris,
        "lod1Tris": (lod1["main"].tris + lod1["glow"].tris) if lod1 else None,
        "glow": lod0["glow"].tris > 0,
        "size": [round(hi[i] - lo[i], 3) for i in range(3)],
        "base": round(lo[1], 3),
        "collide": col,
        "material": recipe.get("material", {}),
        "scale": recipe.get("scale", [0.9, 1.15]),
        "castShadow": recipe.get("castShadow", True),
        "sink": recipe.get("sink", 0.0),
        "farCut": recipe.get("farCut", 24),
    }


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- preview scene


def _link(parent, ob):
    """Link into a Scene or a Collection."""
    (parent.collection if hasattr(parent, "collection") else parent).objects.link(ob)
    return ob


def _mesh_object(name, bm, mat, sc):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if mat:
        me.materials.append(mat)
    return _link(sc, bpy.data.objects.new(name, me))


def flat_material(name, rgb, rough=1.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs["Roughness"].default_value = rough
    return m


def shadow_material():
    m = bpy.data.materials.get("PreviewShadow")
    if m:
        return m
    m = bpy.data.materials.new("PreviewShadow")
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (0.05, 0.07, 0.09, 1.0)
    b.inputs["Alpha"].default_value = 0.26
    m.surface_render_method = "BLENDED"
    m.use_backface_culling = False
    return m


def clear_scene(sc):
    def unlink(coll):
        for ob in list(coll.objects):
            coll.objects.unlink(ob)
            bpy.data.objects.remove(ob, do_unlink=True)
        for ch in list(coll.children):
            unlink(ch)
            bpy.data.collections.remove(ch)
    unlink(sc.collection)


def build_preview_scene(sc):
    """Studio for contact sheets: soft sky, one sun, a matte ground, an orthographic 3/4 camera.
    Light levels are chosen so that even the palest top faces stay below clipping — the first
    sheets were lit so hard that snow, ice and mushroom caps all blew out to white."""
    clear_scene(sc)
    sc.world = bpy.data.worlds.new("PreviewWorld")
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.78, 0.85, 0.93, 1.0)
    bg.inputs[1].default_value = 0.6
    sun = bpy.data.lights.new("PreviewSun", "SUN")
    sun.energy = 1.9
    sun.angle = math.radians(4.0)
    sun.use_shadow = True
    sc.eevee.use_shadows = True
    sun_ob = _link(sc, bpy.data.objects.new("PreviewSun", sun))
    d = Vector((0.55, 0.62, -0.56)).normalized()
    sun_ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sun_ob.location = (0, 0, 12)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=80.0)
    _mesh_object("PreviewGround", bm, flat_material("PreviewGroundMat", L.hex_rgb("#c4c9cd")), sc)
    cam = bpy.data.cameras.new("PreviewCam")
    cam.type = "ORTHO"
    cam.ortho_scale = 13.0
    cam.clip_end = 400
    cam_ob = _link(sc, bpy.data.objects.new("PreviewCam", cam))
    sc.camera = cam_ob
    sc.render.engine = "BLENDER_EEVEE_NEXT"
    sc.eevee.taa_render_samples = 16
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = -0.1
    sc.view_settings.gamma = 1.0
    sc.render.resolution_x = 1600
    sc.render.resolution_y = 1100
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    return cam_ob


def aim_camera(cam_ob, lo, hi, az_deg=28.0, el_deg=30.0, dist=60.0, margin=1.06):
    """Orthographic 3/4 view fitted to a world-space box (Blender frame), so nothing is cropped."""
    az = math.radians(az_deg)
    el = math.radians(el_deg)
    back = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    fwd = -back
    right = fwd.cross(Vector((0.0, 0.0, 1.0))).normalized()
    up = right.cross(fwd).normalized()
    pts = [Vector((x, y, z)) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    rs = [p.dot(right) for p in pts]
    us = [p.dot(up) for p in pts]
    aspect = 1600.0 / 1100.0
    cam_ob.data.ortho_scale = max(max(rs) - min(rs), (max(us) - min(us)) * aspect) * margin
    centre = Vector(((lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5))
    target = right * ((min(rs) + max(rs)) * 0.5) + up * ((min(us) + max(us)) * 0.5) + fwd * centre.dot(fwd)
    cam_ob.location = target + back * dist
    cam_ob.rotation_euler = fwd.to_track_quat("-Z", "Y").to_euler()


def _label(sc, text, loc, size, mat):
    cu = bpy.data.curves.new("label", "FONT")
    cu.body = text
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "TOP"
    ob = _link(sc, bpy.data.objects.new("label", cu))
    ob.location = loc
    cu.materials.append(mat)
    return ob


def place_for_sheet(sc, meshes, cx, cy, height, label, label_mat, spec_shadow=True):
    """Put scaled display copies of `meshes` (list of (mesh, glow)) in a sheet cell."""
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for me, _g in meshes:
        for v in me.vertices:
            for k in range(3):
                lo[k] = min(lo[k], v.co[k])
                hi[k] = max(hi[k], v.co[k])
    ext = [hi[k] - lo[k] for k in range(3)]
    s = height / max(1e-6, ext[2])
    s = min(s, 1.9 / max(1e-6, ext[0], ext[1]))
    ccx = (lo[0] + hi[0]) * 0.5
    ccy = (lo[1] + hi[1]) * 0.5
    for me, glow in meshes:
        ob = _link(sc, bpy.data.objects.new("disp", me))
        ob.scale = (s, s, s)
        ob.location = (cx - ccx * s, cy - ccy * s, -lo[2] * s)
        me.materials.clear()
        me.materials.append(mist_material(glow))
    # soft contact shadow: a dark disc under the model keeps it visually seated on the
    # ground even when a headless EEVEE pass renders without shadow maps
    if spec_shadow:
        sh = bmesh.new()
        bmesh.ops.create_circle(sh, cap_ends=True, cap_tris=False, segments=28, radius=1.0)
        me2 = bpy.data.meshes.new("shadow")
        sh.to_mesh(me2)
        sh.free()
        me2.materials.append(shadow_material())
        ob = _link(sc, bpy.data.objects.new("shadow", me2))
        ob.scale = (max(ext[0], ext[1]) * s * 0.62, max(ext[0], ext[1]) * s * 0.62, 1.0)
        ob.location = (cx, cy - 0.05, 0.006)
    _label(sc, label, (cx, cy - 1.25, 0.02), 0.135, label_mat)
