"""
Renders GLB models for review (explicit batch rendering, meant for blender -b):

    blender -b --factory-startup --python-exit-code 1 --python render_glb.py -- <out.png> <model.glb> [more.glb ...]

The models are imported as exported (no Blender project of their own is made),
lined up on a neutral floor and lit from the front-left, three to a row.
"""
import math
import os
import sys

import bpy
from mathutils import Vector


def world_bbox(objects):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in objects:
        if ob.type != "MESH":
            continue
        for c in ob.bound_box:
            p = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    return lo, hi


def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def studio(size, center):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 1400
    scene.render.resolution_y = 800
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    world = bpy.data.worlds.new("Review") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (0.55, 0.72, 0.86, 1.0)
    bg.inputs[1].default_value = 0.9

    # neutral floor
    bpy.ops.mesh.primitive_plane_add(size=max(60.0, size.x * 6.0), location=(center.x, center.y, -0.02))
    floor = bpy.context.object
    m = bpy.data.materials.new("floor")
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.30, 0.42, 0.22, 1.0)
    m.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1.0
    floor.data.materials.append(m)

    bpy.ops.object.light_add(type="SUN", location=(0, 0, 20))
    sun = bpy.context.object
    sun.data.energy = 3.2
    sun.data.angle = math.radians(4.0)
    sun.rotation_euler = (math.radians(52), 0.0, math.radians(-38))
    bpy.ops.object.light_add(type="AREA", location=(center.x - size.x, center.y - size.y * 1.5, size.z * 2.5 + 6))
    fill = bpy.context.object
    fill.data.energy = 800.0 * max(1.0, size.x / 8.0)
    fill.data.size = max(8.0, size.x)
    fill.rotation_euler = (math.radians(60), 0.0, math.radians(-30))

    target = Vector((center.x, center.y, size.z * 0.42))
    dist = max(size.x * 0.95, size.z * 2.4) + 2.5
    bpy.ops.object.camera_add(location=(target.x + dist * 0.32, target.y - dist, target.z + dist * 0.42))
    cam = bpy.context.object
    scene.camera = cam
    look(cam, target)
    cam.data.lens = 45.0
    return scene


def look(ob, at):
    d = Vector(at) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def tinted(mesh, glow):
    """The game colours models with their vertex colours; the review render does the same."""
    m = bpy.data.materials.new(mesh.name + "_review")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    col = None
    if mesh.color_attributes:
        try:
            col = nt.nodes.new("ShaderNodeVertexColor")
            col.layer_name = mesh.color_attributes[0].name
        except RuntimeError:
            col = nt.nodes.new("ShaderNodeAttribute")
            col.attribute_name = mesh.color_attributes[0].name
        nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    if glow:
        # a glow part is drawn with its vertex colour as light
        bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
        if col:
            nt.links.new(col.outputs["Color"], bsdf.inputs["Emission Color"])
        else:
            bsdf.inputs["Emission Color"].default_value = (1.0, 0.8, 0.4, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 2.4
    mesh.materials.clear()
    mesh.materials.append(m)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        raise SystemExit("usage: ... -- <out.png> <model.glb> [...]")
    out, files = argv[0], argv[1:]
    for f in files:
        if not os.path.isfile(f):
            raise SystemExit("missing " + f)

    clear()
    groups = []
    for f in files:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=f)
        new = [o for o in bpy.data.objects if o not in before]
        for o in new:
            if o.type == "MESH":
                tinted(o.data, o.name.endswith("__glow") or "__glow" in o.name)
        groups.append(new)
        if not new:
            raise SystemExit("no objects in " + f)

    # bake what the importer built, then line the models up with a gap between them
    bpy.context.view_layer.update()
    spans = []
    cursor = 0.0
    tallest = 0.0
    for new in groups:
        bpy.context.view_layer.update()
        lo, hi = world_bbox(new)
        w = hi.x - lo.x
        gap = max(2.5, w * 0.45)
        cursor += gap
        off = Vector((cursor - lo.x, 0.0, -lo.z))
        for o in new:
            if o.parent is None:
                o.location = o.location + off
        bpy.context.view_layer.update()
        lo, hi = world_bbox(new)
        tallest = max(tallest, hi.z)
        spans.append((cursor, cursor + w))
        cursor = hi.x + gap
    total = max(cursor, 4.0)
    size = Vector((total, max(6.0, total * 0.4), max(tallest, 2.0)))
    scene = studio(size, Vector((total * 0.5, 0.0, 0.0)))
    scene.render.filepath = os.path.abspath(out)
    bpy.ops.render.render(write_still=True)
    print("[render] %s  (%d models, %.1f BU wide, %.1f BU tall)" % (out, len(groups), total, tallest))


main()
