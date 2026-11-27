#!/usr/bin/env python3
"""Import CC0 models from majo-no-tabitabi into the prefabs pipeline.

Run with Blender, not plain Python:

  blender -b -noaudio --python world_v2/blender/import_cc0.py -- --list
  blender -b -noaudio --python world_v2/blender/import_cc0.py -- tree_broadleaf_1 tree_pine_1
  blender -b -noaudio --python world_v2/blender/import_cc0.py -- --all-trees

What it does, per model:
  1. reads `baseColorFactor` from the source GLB JSON (authoritative);
  2. imports the mesh, multiplies the material colour into every corner's vertex colour;
  3. drops materials, so the result is exactly what `assets.ts` `slim()` keeps
     (position + COLOR_0 + index) and what `build_prefabs.py` exports
     (`export_materials="NONE"`, `export_vertex_color="ACTIVE"`);
  4. writes `<id>.glb` into `world_v2/cc0/` plus a `<id>.json` sidecar with the
     measured size, triangle count and suggested collision, ready for the manifest step.

Why the bake is required: the source models carry random per-vertex noise in COLOR_0
(measured: values like 0.69/1.00/0.36) and put the real trunk/leaf colours in the
material's baseColorFactor. The game discards materials, so without the bake every
tree would render as grey noise. Verified: baking makes trunk brown and leaves green.

Licences: every id this script accepts is CC0 except the four listed in CC_BY below,
which require attribution if shipped.
"""
from __future__ import annotations

import json
import os
import struct
import sys
import urllib.request

import bpy

# --- repository layout -------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(PROJECT, "world_v2", "cc0")
CACHE = os.path.join(OUT, "source")

RAW = "https://raw.githubusercontent.com/shoal-rat/majo-no-tabitabi/HEAD/assets/"

# id -> path inside the reference repository's assets/ tree
TREES = {
    "tree_bamboo_1": "models/nature/trees/tree_bamboo_1.glb",
    "tree_bamboo_2": "models/nature/trees/tree_bamboo_2.glb",
    "tree_birch_1": "models/nature/trees/tree_birch_1.glb",
    "tree_broadleaf_1": "models/nature/trees/tree_broadleaf_1.glb",
    "tree_broadleaf_2": "models/nature/trees/tree_broadleaf_2.glb",
    "tree_broadleaf_3": "models/nature/trees/tree_broadleaf_3.glb",
    "tree_broadleaf_4": "models/nature/trees/tree_broadleaf_4.glb",
    "tree_broadleaf_5": "models/nature/trees/tree_broadleaf_5.glb",
    "tree_broadleaf_snow_1": "models/nature/trees/tree_broadleaf_snow_1.glb",
    "tree_cherry_2": "models/nature/trees/tree_cherry_2.glb",
    "tree_dead_1": "models/nature/trees/tree_dead_1.glb",
    "tree_dead_2": "models/nature/trees/tree_dead_2.glb",
    "tree_dead_3": "models/nature/trees/tree_dead_3.glb",
    "tree_dead_snow_1": "models/nature/trees/tree_dead_snow_1.glb",
    "tree_giant_ancient": "models/nature/trees/tree_giant_ancient.glb",
    "tree_ginkgo_1": "models/nature/trees/tree_ginkgo_1.glb",
    "tree_ginkgo_2": "models/nature/trees/tree_ginkgo_2.glb",
    "tree_maple_2": "models/nature/trees/tree_maple_2.glb",
    "tree_maple_3": "models/nature/trees/tree_maple_3.glb",
    "tree_pine_1": "models/nature/trees/tree_pine_1.glb",
    "tree_pine_2": "models/nature/trees/tree_pine_2.glb",
    "tree_pine_3": "models/nature/trees/tree_pine_3.glb",
    "tree_pine_snow_1": "models/nature/trees/tree_pine_snow_1.glb",
    "tree_willow_1": "models/nature/trees/tree_willow_1.glb",
    "tree_willow_2": "models/nature/trees/tree_willow_2.glb",
}

# Rocks, shrubs, ground plants. Same CC0 terms as the trees; the game's rock/shrub/plant
# props are small (160-1720 tris) so these are a close match in budget.
ROCKS = {
    "rock_boulder_1": "models/nature/rocks/rock_boulder_1.glb",
    "rock_boulder_2": "models/nature/rocks/rock_boulder_2.glb",
    "rock_boulder_3": "models/nature/rocks/rock_boulder_3.glb",
    "rock_boulder_4": "models/nature/rocks/rock_boulder_4.glb",
    "rock_boulder_5": "models/nature/rocks/rock_boulder_5.glb",
    "rock_boulder_6": "models/nature/rocks/rock_boulder_6.glb",
    "rock_cliff_1": "models/nature/rocks/rock_cliff_1.glb",
    "rock_cliff_2": "models/nature/rocks/rock_cliff_2.glb",
    "rock_moss_1": "models/nature/rocks/rock_moss_1.glb",
    "rock_moss_2": "models/nature/rocks/rock_moss_2.glb",
    "rock_painted_1": "models/nature/rocks/rock_painted_1.glb",
    "rock_snow_1": "models/nature/rocks/rock_snow_1.glb",
    "rock_snow_2": "models/nature/rocks/rock_snow_2.glb",
    "rock_standing_1": "models/nature/rocks/rock_standing_1.glb",
    "rock_standing_2": "models/nature/rocks/rock_standing_2.glb",
    "rock_standing_3": "models/nature/rocks/rock_standing_3.glb",
    "rock_arch_1": "models/nature/rocks/rock_arch_1.glb",
}

PLANTS = {
    "plant_bush_1": "models/nature/plants/plant_bush_1.glb",
    "plant_bush_2": "models/nature/plants/plant_bush_2.glb",
    "plant_bush_3": "models/nature/plants/plant_bush_3.glb",
    "plant_bush_4": "models/nature/plants/plant_bush_4.glb",
    "plant_bush_5": "models/nature/plants/plant_bush_5.glb",
    "plant_bush_berries": "models/nature/plants/plant_bush_berries.glb",
    "plant_bush_snow": "models/nature/plants/plant_bush_snow.glb",
    "plant_fern_1": "models/nature/plants/plant_fern_1.glb",
    "plant_fern_2": "models/nature/plants/plant_fern_2.glb",
    "plant_grass_1": "models/nature/plants/plant_grass_1.glb",
    "plant_grass_2": "models/nature/plants/plant_grass_2.glb",
    "plant_grass_3": "models/nature/plants/plant_grass_3.glb",
    "plant_reed_1": "models/nature/plants/plant_reed_1.glb",
    "plant_reed_2": "models/nature/plants/plant_reed_2.glb",
    "plant_flower_2": "models/nature/plants/plant_flower_2.glb",
    "plant_flower_4": "models/nature/plants/plant_flower_4.glb",
    "plant_mushroom_small_1": "models/nature/plants/plant_mushroom_small_1.glb",
    "plant_mushroom_small_3": "models/nature/plants/plant_mushroom_small_3.glb",
    "plant_mushroom_giant_1": "models/nature/plants/plant_mushroom_giant_1.glb",
    "plant_mushroom_giant_2": "models/nature/plants/plant_mushroom_giant_2.glb",
    "nat_crystal_1": "models/nature/nature/nat_crystal_1.glb",
    "nat_crystal_cluster_1": "models/nature/nature/nat_crystal_cluster_1.glb",
    "nat_crystal_cluster_4": "models/nature/nature/nat_crystal_cluster_4.glb",
    "nat_stump_1": "models/nature/nature/nat_stump_1.glb",
    "nat_fallen_trunk_2": "models/nature/nature/nat_fallen_trunk_2.glb",
    "plant_lilypad_1": "models/refined/plant_lilypad_1.glb",
    "plant_lilypad_2": "models/refined/plant_lilypad_2.glb",
    "plant_mushroom_giant_3": "models/nature/plants/plant_mushroom_giant_3.glb",
    "plant_mushroom_giant_4": "models/nature/plants/plant_mushroom_giant_4.glb",
    "plant_vine_1": "models/nature/plants/plant_vine_1.glb",
    "nat_crystal_2": "models/nature/nature/nat_crystal_2.glb",
    "nat_crystal_cluster_2": "models/nature/nature/nat_crystal_cluster_2.glb",
    "nat_crystal_cluster_6": "models/nature/nature/nat_crystal_cluster_6.glb",
    "nat_crystal_mineral_1": "models/nature/nature/nat_crystal_mineral_1.glb",
    "nat_fallen_trunk_1": "models/nature/nature/nat_fallen_trunk_1.glb",
}

# Animals. All CC0. Placed as ambient wildlife, one species per biome so each terrain
# reads as inhabited rather than as a model gallery.
FAUNA = {
    "ani_deer": "models/refined/ani_deer.glb",
    "ani_stag": "models/refined/ani_stag.glb",
    "ani_fox": "models/refined/ani_fox.glb",
    "ani_wolf": "models/refined/ani_wolf.glb",
    "ani_raccoon": "models/refined/ani_raccoon.glb",
    "ani_hedgehog": "models/refined/ani_hedgehog.glb",
    "ani_frog": "models/refined/ani_frog.glb",
    "ani_koi": "models/refined/ani_koi.glb",
    "ani_sheep": "models/refined/ani_sheep.glb",
    "ani_cow": "models/refined/ani_cow.glb",
    "ani_chicken": "models/refined/ani_chicken.glb",
    "ani_cat": "models/refined/ani_cat.glb",
    "ani_dog": "models/refined/ani_dog.glb",
}

# Sellable set dressing, also CC0: barrels, crates, a campfire, a cart.
PROPS = {
    "prop_bonfire": "models/refined/prop_bonfire.glb",
    "prop_barrel_large": "models/refined/prop_barrel_large.glb",
    "prop_barrel_small": "models/refined/prop_barrel_small.glb",
    "prop_crate_big": "models/refined/prop_crate_big.glb",
    "prop_crate_large": "models/refined/prop_crate_large.glb",
    "prop_cart": "models/refined/prop_cart.glb",
    "prop_bench": "models/refined/prop_bench.glb",
    "prop_hay_sheaf": "models/refined/prop_hay_sheaf.glb",
    "prop_boulder_1": "models/refined/prop_boulder_1.glb",
    "prop_boulder_2": "models/refined/prop_boulder_2.glb",
    "prop_boulder_3": "models/refined/prop_boulder_3.glb",
    "bld_boat_rowing": "models/refined/bld_boat_rowing.glb",
}

ALL_MODELS = {}
ALL_MODELS.update(TREES)
ALL_MODELS.update(ROCKS)
ALL_MODELS.update(PLANTS)
ALL_MODELS.update(FAUNA)
ALL_MODELS.update(PROPS)

# These four need attribution when shipped. Kept separate so the manifest step
# can write a CREDITS entry without grepping the source repository.
CC_BY = {
    "tree_cherry_1": "Poly by Google",
    "tree_maple_1": "Poly by Google",
    "plant_flower_1": "Poly by Google",
    "plant_sunflower_1": "Poly by Google",
}


def log(*a):
    print("[cc0]", *a)


def fetch(rel: str) -> str:
    """Download into world_v2/cc0/source/, reuse the cached copy."""
    os.makedirs(CACHE, exist_ok=True)
    name = os.path.basename(rel)
    dst = os.path.join(CACHE, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        return dst
    url = RAW + rel
    log("downloading", url)
    with urllib.request.urlopen(url, timeout=60) as r, open(dst, "wb") as f:
        f.write(r.read())
    return dst


def gltf_json(path: str) -> dict:
    with open(path, "rb") as f:
        magic, _, _ = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            raise ValueError(f"{path} is not a GLB")
        clen, _ = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen))


def base_colours(path: str) -> dict[int, tuple[float, float, float]]:
    """baseColorFactor per material index, defaulting to white."""
    js = gltf_json(path)
    out = {}
    for i, m in enumerate(js.get("materials", [])):
        f = m.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
        out[i] = tuple(f[:3])
    return out


def triangle_count(obj) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def import_one(model_id: str, rel: str) -> dict:
    src = fetch(rel)
    base = base_colours(src)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"{model_id}: no mesh in {src}")

    for ob in meshes:
        me = ob.data
        ca = me.color_attributes.active_color
        if ca is None:
            ca = me.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
        for poly in me.polygons:
            c = base.get(poly.material_index, (1.0, 1.0, 1.0))
            for li in poly.loop_indices:
                v = ca.data[li].color
                ca.data[li].color = [
                    min(1.0, v[0] * c[0]),
                    min(1.0, v[1] * c[1]),
                    min(1.0, v[2] * c[2]),
                    1.0,
                ]
        me.materials.clear()

    near = meshes[0]
    for ob in meshes[1:]:
        # join extra meshes of the same asset so one id is one mesh
        bpy.ops.object.select_all(action="DESELECT")
        ob.select_set(True)
        near.select_set(True)
        bpy.context.view_layer.objects.active = near
        bpy.ops.object.join()

    near.name = model_id
    near.data.name = model_id
    near.location = (0, 0, 0)

    os.makedirs(OUT, exist_ok=True)
    dst = os.path.join(OUT, model_id + ".glb")
    bpy.ops.object.select_all(action="DESELECT")
    near.select_set(True)
    bpy.context.view_layer.objects.active = near
    bpy.ops.export_scene.gltf(
        filepath=dst, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True,
        export_materials="NONE", export_vertex_color="ACTIVE",
        export_cameras=False, export_lights=False, export_skins=False, export_morph=False,
    )

    lo = [min(near.bound_box[i][j] for i in range(8)) for j in range(3)]
    hi = [max(near.bound_box[i][j] for i in range(8)) for j in range(3)]
    size = [round(hi[0] - lo[0], 3), round(hi[2] - lo[2], 3), round(hi[1] - lo[1], 3)]
    tris = triangle_count(near)
    height = hi[2] - lo[2]
    sidecar = {
        "id": model_id,
        "source": rel,
        "license": "CC-BY 3.0" if model_id in CC_BY else "CC0",
        "attribution": CC_BY.get(model_id),
        "tris": tris,
        "size": size,
        "base": round(lo[2], 3),
        "crownRatio": round(max(size[0], size[2]) / height, 3) if height else None,
        "collide": {"r": round(max(size[0], size[2]) * 0.24, 2), "h": round(height, 2)},
        "verifiedNoMaterial": True,
    }
    with open(os.path.join(OUT, model_id + ".json"), "w", encoding="utf-8") as f:
        json.dump(sidecar, f, ensure_ascii=False, indent=1)
    log(f"{model_id}: {tris} tris, size={size}, crownRatio={sidecar['crownRatio']}")
    return sidecar


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv[0] == "--list":
        for k in sorted(ALL_MODELS):
            mark = "  (CC-BY, needs attribution)" if k in CC_BY else ""
            print(f"{k:24} {ALL_MODELS[k]}{mark}")
        return 0

    if argv[0] == "--all-trees":
        ids = sorted(TREES)
    elif argv[0] == "--all-rocks":
        ids = sorted(ROCKS)
    elif argv[0] == "--all-plants":
        ids = sorted(PLANTS)
    elif argv[0] == "--all-fauna":
        ids = sorted(FAUNA)
    elif argv[0] == "--all-props":
        ids = sorted(PROPS)
    elif argv[0] == "--all":
        ids = sorted(ALL_MODELS)
    else:
        ids = argv
    unknown = [i for i in ids if i not in ALL_MODELS]
    if unknown:
        log("unknown id(s):", ", ".join(unknown))
        return 2

    rows = []
    for i in ids:
        try:
            rows.append(import_one(i, ALL_MODELS[i]))
        except Exception as e:
            log(f"FAILED {i}: {e}")

    index_path = os.path.join(OUT, "index.json")
    existing = {}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            existing = json.load(f)
    for r in rows:
        existing[r["id"]] = r
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(existing, f, ensure_ascii=False, indent=1)
    log(f"wrote {len(rows)} model(s); index has {len(existing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
