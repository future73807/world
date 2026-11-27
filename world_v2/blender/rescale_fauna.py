#!/usr/bin/env python3
"""Bake the fauna to a believable size into the geometry, not into the manifest scale.

The reference project authors its animals in its own units: a deer there is 0.044 tall, a
chicken 0.008 — each species off by a different factor (3.8x to 52x against this world's
scale, where the player slime is ~1.05 BU). Fixing that with the manifest `scale` field
works but leaves `size` wrong, and `size` is what placement uses for colliders and for the
near/far draw radius, so the animals would be treated as pebbles.

This scales the mesh vertices and rewrites `size`/`base`/`collide` in the manifest.
"""
from __future__ import annotations

import json
import os
import struct
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, "..", ".."))
GLB = os.path.join(PROJECT, "app", "public", "models", "prefabs.glb")
MAN = os.path.join(PROJECT, "app", "public", "models", "prefabs.json")

# id -> standing height in this world's units
TARGET = {
    "cc0_deer": 1.55,
    "cc0_fox": 0.72,
    "cc0_hedgehog": 0.26,
    "cc0_cat": 0.48,
    "cc0_chicken": 0.42,
    "cc0_cow": 1.45,
    "cc0_frog": 0.12,
    # camp props: a barrel is chest high, a crate is knee high, a boat is small
    "cc0_barrel_a": 0.95,
    "cc0_crate_a": 0.68,
    "cc0_cart": 1.05,
    "cc0_hay": 0.80,
    "cc0_boat": 0.60,
    "cc0_campfire": 0.55,
}


def log(*a):
    print("[scale]", *a, flush=True)


def glb_json(path):
    with open(path, "rb") as f:
        f.read(12)
        clen, _ = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen))


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    apply = "--apply" in argv
    man = json.load(open(MAN, encoding="utf-8"))
    js = glb_json(GLB)
    present = {m["name"] for m in js["meshes"]}

    plan = []
    for mid, h in TARGET.items():
        if mid not in present:
            log(f"SKIP {mid}: not in library")
            continue
        cur = man["models"][mid]["size"][1]
        if cur <= 0:
            log(f"SKIP {mid}: zero height")
            continue
        plan.append((mid, h / cur))
        log(f"{mid:16} {cur:.3f} -> {h:.2f} BU  (x{h / cur:.2f})")
    if not apply:
        log("dry run")
        return 0

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB)
    objs = {o.name: o for o in bpy.data.objects if o.type == "MESH"}

    for mid, k in plan:
        for suffix in ("", "__lod1"):
            ob = objs.get(mid + suffix)
            if ob is None:
                continue
            for v in ob.data.vertices:
                v.co = v.co * k
            ob.data.update()

    for o in bpy.context.scene.objects:
        o.select_set(o.type == "MESH")
    bpy.context.view_layer.objects.active = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=GLB, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_materials="NONE",
        export_vertex_color="ACTIVE", export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False, export_extras=True,
    )
    log("re-exported")

    # rewrite the manifest geometry facts from the new vertices
    js2 = glb_json(GLB)
    def tris(m):
        t = 0
        for pr in m["primitives"]:
            i = pr.get("indices")
            t += js2["accessors"][i]["count"] // 3 if i is not None else js2["accessors"][pr["attributes"]["POSITION"]]["count"] // 3
        return t
    byname = {m["name"]: m for m in js2["meshes"]}
    for mid, _k in plan:
        e = man["models"][mid]
        near = byname[mid]
        accs = [js2["accessors"][pr["attributes"]["POSITION"]] for pr in near["primitives"]]
        mn = [min(a["min"][i] for a in accs) for i in range(3)]
        mx = [max(a["max"][i] for a in accs) for i in range(3)]
        e["size"] = [round(mx[0] - mn[0], 3), round(mx[1] - mn[1], 3), round(mx[2] - mn[2], 3)]
        e["base"] = round(-e.get("sink", 0.06), 3)
        e["scale"] = [0.92, 1.08]
        e["tris"] = tris(near)
        lod = byname.get(mid + "__lod1")
        e["lod1Tris"] = tris(lod) if lod else e["tris"]
        c = e.get("collide")
        if isinstance(c, dict):
            c["r"] = round(max(e["size"][0], e["size"][2]) * 0.30, 2)
            c["h"] = round(e["size"][1], 2)
        log(f"{mid}: size now {e['size']}")
    tmp = MAN + ".tmp"
    json.dump(man, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, MAN)
    return 0


if __name__ == "__main__":
    sys.exit(main())
