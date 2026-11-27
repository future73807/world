#!/usr/bin/env python3
"""Merge the imported CC0 models into the game's prefabs library.

Run with Blender:

  blender -b -noaudio --python world_v2/blender/merge_cc0.py -- --plan
  blender -b -noaudio --python world_v2/blender/merge_cc0.py -- --apply

What it does:
  * reads `world_v2/cc0/index.json` (written by `import_cc0.py`)
  * makes a decimated `__lod1` twin for each model, so the library keeps the
    near/far LOD contract that `assets.ts` `combine()` expects
  * appends both meshes plus a manifest entry to `app/public/models/prefabs.glb`
    and `prefabs.json`, re-exporting the whole library in one pass

The existing 55 models are re-exported untouched: meshes are collected from the
current GLB, not rebuilt from Blender recipes, so this cannot regress the V3 art.

Manifest entries reuse the field set already in `prefabs.json`; biome and label
come from `MAP` below, which is the supervisor's allocation of the CC0 trees to
the six biomes this project already has.
"""
from __future__ import annotations

import json
import math
import os
import struct
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, "..", ".."))
CC0 = os.path.join(PROJECT, "world_v2", "cc0")
PREFAB_GLB = os.path.join(PROJECT, "app", "public", "models", "prefabs.glb")
PREFAB_JSON = os.path.join(PROJECT, "app", "public", "models", "prefabs.json")

# Which CC0 model becomes which library id, and where it grows.
# Keep the game's existing ids out of this table: those stay from build_prefabs.py.
MAP = {
    "tree_broadleaf_1": dict(id="cc0_broadleaf_a", label="阔叶树", biomes=["forest"], group="forest", desc="圆冠阔叶树，粗壮树干向上收分，冠层由数团叶球叠成。"),
    "tree_broadleaf_2": dict(id="cc0_broadleaf_b", label="宽冠阔叶", biomes=["forest"], group="forest", desc="冠幅更宽的阔叶树，主干短，叶团向四周铺开。"),
    "tree_broadleaf_3": dict(id="cc0_broadleaf_c", label="大冠阔叶", biomes=["forest"], group="forest", desc="高大阔叶树，三层叶团层叠，远看有清楚的塔形剪影。"),
    "tree_broadleaf_4": dict(id="cc0_broadleaf_d", label="中冠阔叶", biomes=["forest", "meadow"], group="meadow", desc="中等高度的阔叶树，冠层偏圆，适合林缘。"),
    "tree_birch_1": dict(id="cc0_birch", label="白桦", biomes=["forest", "meadow"], group="meadow", desc="细高白桦，枝叶疏朗，成片时透光。"),
    "tree_maple_2": dict(id="cc0_maple_a", label="枫树", biomes=["meadow"], group="meadow", desc="短干宽冠的枫树，叶团分三层，色偏黄绿。"),
    "tree_maple_3": dict(id="cc0_maple_b", label="矮枫", biomes=["meadow"], group="meadow", desc="矮壮枫树，冠层低垂，适合草甸点缀。"),
    "tree_ginkgo_1": dict(id="cc0_ginkgo_a", label="银杏", biomes=["meadow"], group="meadow", desc="高瘦银杏，叶团集中在顶部，剪影收束。"),
    "tree_ginkgo_2": dict(id="cc0_ginkgo_b", label="高银杏", biomes=["meadow"], group="meadow", desc="极高的银杏，树干细长，顶部一小簇叶团。"),
    "tree_pine_1": dict(id="cc0_pine_a", label="尖杉", biomes=["snow", "forest"], group="snow", desc="圆锥形针叶树，三层锥冠，顶部收尖。"),
    "tree_pine_2": dict(id="cc0_pine_b", label="高尖杉", biomes=["snow"], group="snow", desc="高瘦针叶树，冠层窄，适合雪线密林。"),
    "tree_pine_3": dict(id="cc0_pine_c", label="宽杉", biomes=["snow"], group="snow", desc="冠幅较宽的针叶树，锥冠分节明显。"),
    "tree_pine_snow_1": dict(id="cc0_pine_snow", label="积雪杉", biomes=["snow"], group="snow", desc="冠层覆雪的针叶树，顶部偏白。"),
    "tree_broadleaf_snow_1": dict(id="cc0_broadleaf_snow", label="雪原阔叶", biomes=["snow"], group="snow", desc="窄冠阔叶树，叶团小而密，适应雪原。"),
    "tree_dead_snow_1": dict(id="cc0_dead_snow", label="雪枯木", biomes=["snow"], group="snow", desc="覆雪的枯树，枝干裸露，剪影嶙峋。"),
    "tree_dead_1": dict(id="cc0_dead_a", label="枯树", biomes=["volcanic", "swamp"], group="volcanic", desc="无叶枯树，主干分叉成数根粗枝。"),
    "tree_dead_2": dict(id="cc0_dead_b", label="细枯木", biomes=["volcanic"], group="volcanic", desc="细高枯木，枝条稀少，适合焦土。"),
    "tree_dead_3": dict(id="cc0_dead_c", label="残枝枯木", biomes=["volcanic", "swamp"], group="volcanic", desc="矮壮枯木，断枝粗短，底部有残根。"),
    "tree_willow_1": dict(id="cc0_willow_a", label="垂柳", biomes=["swamp"], group="swamp", desc="垂枝柳树，枝条向下披散，冠层贴地。"),
    "tree_willow_2": dict(id="cc0_willow_b", label="矮垂柳", biomes=["swamp"], group="swamp", desc="低矮垂柳，冠层几乎垂到地面，适合水边。"),
    "tree_bamboo_1": dict(id="cc0_bamboo_a", label="竹丛", biomes=["swamp", "beach"], group="beach", desc="细高竹丛，秆直节细，顶部小叶。"),
    "tree_bamboo_2": dict(id="cc0_bamboo_b", label="矮竹丛", biomes=["beach"], group="beach", desc="矮竹丛，秆密而短，适合岸线。"),
    "tree_cherry_2": dict(id="cc0_cherry", label="绯樱", biomes=["meadow", "beach"], group="beach", desc="粉色冠层的樱树，冠幅宽而低。"),
    "tree_giant_ancient": dict(id="cc0_ancient", label="远古巨树", biomes=["forest", "landmark"], group="landmark", desc="巨型古树，冠幅超过二十 BU，作为岛上的地标。"),

    # --- rocks. The game's own rocks are 160-1720 tris with a cylindrical collider
    # (r, h); the CC0 boulders and standing stones land in the same budget.
    "rock_boulder_1": dict(id="cc0_boulder_a", label="小卵石", kind="rock", biomes=["shared"], group="shared", desc="圆钝的小卵石，散在路面上。"),
    "rock_boulder_2": dict(id="cc0_boulder_b", label="卵石", kind="rock", biomes=["shared"], group="shared", desc="略大的卵石，表面平缓。"),
    "rock_boulder_3": dict(id="cc0_boulder_c", label="块岩", kind="rock", biomes=["shared"], group="shared", desc="带棱面的块岩，主断面清晰。"),
    "rock_boulder_4": dict(id="cc0_boulder_d", label="大块岩", kind="rock", biomes=["shared", "forest"], group="forest", desc="体积较大的块岩，两个断面合成一个坡。"),
    "rock_boulder_5": dict(id="cc0_boulder_e", label="卧岩", kind="rock", biomes=["meadow", "forest"], group="meadow", desc="横向铺开的卧岩，适合草甸边缘。"),
    "rock_cliff_1": dict(id="cc0_cliff_a", label="断崖岩", kind="rock", biomes=["snow", "volcanic"], group="snow", desc="陡立的断崖岩块，上窄下宽。"),
    "rock_cliff_2": dict(id="cc0_cliff_b", label="岩壁", kind="rock", biomes=["volcanic"], group="volcanic", desc="带层理的岩壁，侧面几乎垂直。"),
    "rock_moss_1": dict(id="cc0_mossrock_a", label="苔岩", kind="rock", biomes=["swamp", "forest"], group="swamp", desc="覆着苔的湿岩，适合水边和林下。"),
    "rock_moss_2": dict(id="cc0_mossrock_b", label="小苔岩", kind="rock", biomes=["swamp"], group="swamp", desc="低矮的小苔岩，半埋在泥里。"),
    "rock_snow_1": dict(id="cc0_snowrock_a", label="雪岩", kind="rock", biomes=["snow"], group="snow", desc="顶面积雪的岩石，雪盖与岩面分明。"),
    "rock_snow_2": dict(id="cc0_snowrock_b", label="小雪岩", kind="rock", biomes=["snow"], group="snow", desc="小块的积雪岩，适合雪原零散点缀。"),
    "rock_standing_1": dict(id="cc0_standing_a", label="立石", kind="rock", biomes=["meadow", "volcanic"], group="meadow", desc="竖立的独立石柱，剪影细高。"),
    "rock_standing_2": dict(id="cc0_standing_b", label="矮立石", kind="rock", biomes=["volcanic"], group="volcanic", desc="矮壮的立石，底部宽厚。"),
    "rock_standing_3": dict(id="cc0_standing_c", label="斜立石", kind="rock", biomes=["desert"], group="desert", desc="倾斜的风蚀立石，适合旱地。"),
    "rock_painted_1": dict(id="cc0_painted_rock", label="彩岩", kind="rock", biomes=["desert"], group="desert", desc="带色带的风蚀岩，地层颜色分明。"),
    "rock_arch_1": dict(id="cc0_rock_arch", label="石拱", kind="landmark", biomes=["desert", "landmark"], group="landmark", desc="天然石拱，两面通透，可作地标。"),

    # --- shrubs and ground plants
    "plant_bush_1": dict(id="cc0_bush_a", label="圆灌丛", kind="shrub", biomes=["shared"], group="shared", desc="紧凑的圆冠灌丛。"),
    "plant_bush_2": dict(id="cc0_bush_b", label="宽灌丛", kind="shrub", biomes=["meadow"], group="meadow", desc="横向铺开的灌丛，冠层分块。"),
    "plant_bush_3": dict(id="cc0_bush_c", label="大灌丛", kind="shrub", biomes=["forest", "meadow"], group="forest", desc="体量更大的灌丛，适合林缘。"),
    "plant_bush_4": dict(id="cc0_bush_d", label="疏灌丛", kind="shrub", biomes=["meadow", "desert"], group="meadow", desc="枝叶疏朗的灌丛，透光。"),
    "plant_bush_5": dict(id="cc0_bush_e", label="矮灌丛", kind="shrub", biomes=["shared"], group="shared", desc="低矮贴地的灌丛。"),
    "plant_bush_berries": dict(id="cc0_bush_berries", label="浆果丛", kind="shrub", biomes=["forest", "meadow"], group="meadow", desc="结着浆果的灌丛，果实颜色点缀冠层。"),
    "plant_bush_snow": dict(id="cc0_bush_snow", label="雪灌丛", kind="shrub", biomes=["snow"], group="snow", desc="覆雪的灌丛，顶部偏白。"),
    "plant_fern_1": dict(id="cc0_fern_a", label="蕨丛", kind="plant", biomes=["forest", "swamp"], group="forest", desc="贴地散开的蕨，叶片向外铺。"),
    "plant_fern_2": dict(id="cc0_fern_b", label="矮蕨", kind="plant", biomes=["swamp"], group="swamp", desc="低矮的蕨丛，适合湿地林下。"),
    "plant_grass_1": dict(id="cc0_grass_a", label="野草丛", kind="plant", biomes=["shared"], group="shared", desc="成束的野草，叶尖外弯。"),
    "plant_grass_2": dict(id="cc0_grass_b", label="宽叶草", kind="plant", biomes=["meadow"], group="meadow", desc="叶片更宽的低草，成片铺开。"),
    "plant_grass_3": dict(id="cc0_grass_c", label="高草", kind="plant", biomes=["meadow", "desert"], group="meadow", desc="抽长的细草，风里会倒向一侧。"),
    "plant_reed_1": dict(id="cc0_reed_a", label="芦苇", kind="plant", biomes=["swamp"], group="swamp", desc="成丛的芦苇，秆直而密。"),
    "plant_reed_2": dict(id="cc0_reed_b", label="矮芦苇", kind="plant", biomes=["swamp", "beach"], group="swamp", desc="较矮的芦苇丛，适合浅水边。"),
    "plant_flower_2": dict(id="cc0_flower_a", label="野花", kind="detail", biomes=["shared"], group="shared", desc="单枝野花，花头小而清楚。"),
    "plant_flower_4": dict(id="cc0_flower_b", label="簇花", kind="detail", biomes=["meadow"], group="meadow", desc="成簇开放的花，花瓣分层。"),
    "plant_mushroom_small_1": dict(id="cc0_mushroom_s", label="小菇", kind="detail", biomes=["forest", "swamp"], group="forest", desc="小小一朵的菇，伞盖薄。"),
    "plant_mushroom_small_3": dict(id="cc0_mushroom_m", label="丛菇", kind="detail", biomes=["forest"], group="forest", desc="两三朵并生的菇。"),
    "nat_crystal_1": dict(id="cc0_crystal_a", label="晶柱", kind="rock", biomes=["snow"], group="snow", desc="单根冰晶柱，向上收尖。"),
    "nat_crystal_cluster_1": dict(id="cc0_crystal_b", label="晶簇", kind="rock", biomes=["snow"], group="snow", desc="数根晶体聚成一簇。"),
    "nat_crystal_cluster_4": dict(id="cc0_crystal_c", label="大晶簇", kind="rock", biomes=["snow", "volcanic"], group="snow", desc="体量更大的晶簇，棱面更多。"),
    "nat_stump_1": dict(id="cc0_stump", label="树桩", kind="rock", biomes=["forest"], group="forest", desc="锯断的老树桩，断面平整。"),
    "nat_fallen_trunk_2": dict(id="cc0_log", label="倒木", kind="rock", biomes=["forest", "swamp"], group="forest", desc="横倒的树干，一端带残根。"),
    "plant_lilypad_1": dict(id="cc0_lilypad_a", label="睡莲", kind="detail", biomes=["swamp"], group="swamp", desc="贴水的圆叶，边缘微翘。"),
    "plant_lilypad_2": dict(id="cc0_lilypad_b", label="大睡莲", kind="detail", biomes=["swamp"], group="swamp", desc="更大的浮叶，叶面平展。"),
    "plant_mushroom_giant_3": dict(id="cc0_giant_mushroom_a", label="巨型菌盖", kind="landmark", biomes=["swamp", "landmark"], group="landmark", desc="低矮而极宽的巨型菌，伞盖铺开像屋顶。"),
    "plant_mushroom_giant_4": dict(id="cc0_giant_mushroom_b", label="高巨菌", kind="landmark", biomes=["swamp", "landmark"], group="landmark", desc="细高巨菌，伞盖窄而高，剪影醒目。"),
    "plant_vine_1": dict(id="cc0_vine", label="垂藤", kind="plant", biomes=["forest", "swamp"], group="forest", desc="垂下的藤蔓，叶片沿茎分布。"),
    "nat_crystal_2": dict(id="cc0_crystal_d", label="细晶柱", kind="rock", biomes=["snow"], group="snow", desc="细长的单根晶柱。"),
    "nat_crystal_cluster_2": dict(id="cc0_crystal_d_cluster", label="晶簇二", kind="rock", biomes=["snow", "volcanic"], group="snow", desc="数根晶体聚簇，棱面清楚。"),
    "nat_crystal_cluster_6": dict(id="cc0_crystal_e", label="高晶簇", kind="rock", biomes=["snow"], group="snow", desc="较高的晶簇，向上散开。"),
    "nat_crystal_mineral_1": dict(id="cc0_mineral", label="矿石", kind="rock", biomes=["volcanic", "snow"], group="volcanic", desc="扁平的矿石块，棱角分明。"),
    "nat_fallen_trunk_1": dict(id="cc0_log_long", label="长倒木", kind="rock", biomes=["forest", "swamp"], group="forest", desc="横陈的长倒木，一端带根盘。"),
    "nat_crystal_3": dict(id="cc0_crystal_f", label="冰棱柱", kind="rock", biomes=["glacier"], group="glacier", desc="细高的冰棱，向上收成尖。"),
    "nat_crystal_4": dict(id="cc0_crystal_g", label="钝冰晶", kind="rock", biomes=["glacier", "snow"], group="glacier", desc="低矮的钝头冰晶，埋在冰面里。"),
    "nat_crystal_cluster_3": dict(id="cc0_crystal_h", label="冰晶丛", kind="rock", biomes=["glacier"], group="glacier", desc="成丛的冰晶，棱面互相交叠。"),
    "nat_crystal_cluster_5": dict(id="cc0_crystal_i", label="碎冰簇", kind="rock", biomes=["glacier", "snow"], group="glacier", desc="碎块状的小晶簇。"),
    "nat_log_snow_1": dict(id="cc0_snow_log", label="雪埋枯木", kind="rock", biomes=["glacier", "snow"], group="glacier", desc="半埋在雪里的枯木。"),
    "nat_stump_snow_1": dict(id="cc0_snow_stump", label="雪树桩", kind="rock", biomes=["glacier", "tundra"], group="glacier", desc="顶面积雪的树桩。"),
    "rock_cliff_3": dict(id="cc0_cliff_c", label="冰岩壁", kind="rock", biomes=["glacier", "highland"], group="glacier", desc="层理清晰的岩壁。"),
    "rock_cliff_4": dict(id="cc0_cliff_d", label="断岩", kind="rock", biomes=["glacier", "highland"], group="glacier", desc="断口锋利的岩块。"),
    "plant_lotus_1": dict(id="cc0_lotus", label="睡莲叶", kind="detail", biomes=["swamp"], group="swamp", desc="浮在水面的莲叶。"),
    "plant_vine_2": dict(id="cc0_vine_b", label="垂藤二", kind="plant", biomes=["jungle"], group="jungle", desc="另一种垂下的藤。"),
    "plant_rice_1": dict(id="cc0_rice", label="水稲", kind="plant", biomes=["swamp"], group="swamp", desc="成丛的水生禾草。"),
    "plant_wheat_1": dict(id="cc0_wheat_a", label="野麦", kind="plant", biomes=["meadow"], group="meadow", desc="抽穗的野麦。"),
    "plant_wheat_2": dict(id="cc0_wheat_b", label="高麦", kind="plant", biomes=["meadow"], group="meadow", desc="更高的麦草。"),
    "nat_log_1": dict(id="cc0_log_b", label="倒木二", kind="rock", biomes=["forest"], group="forest", desc="横倒的木干。"),
    "nat_log_moss_1": dict(id="cc0_log_moss", label="苔倒木", kind="rock", biomes=["forest", "jungle"], group="forest", desc="长满苔的倒木。"),
    # --- ambient wildlife: one species per biome so each terrain reads as inhabited
    "ani_deer": dict(id="cc0_deer", label="鹿", kind="fauna", biomes=["forest", "meadow"], group="forest", desc="低头觅食的鹿，细腿支着圆润的躯干。"),
    "ani_fox": dict(id="cc0_fox", label="狐", kind="fauna", biomes=["snow", "forest"], group="snow", desc="尾巴蓬松的狐狸，常在雪线附近活动。"),
    "ani_hedgehog": dict(id="cc0_hedgehog", label="刺猬", kind="fauna", biomes=["forest", "meadow"], group="meadow", desc="背上一圈尖刺的小刺猬。"),
    "ani_cat": dict(id="cc0_cat", label="野猫", kind="fauna", biomes=["meadow", "beach"], group="beach", desc="翘着尾巴的野猫，在草地上踱步。"),
    "ani_chicken": dict(id="cc0_chicken", label="野鸡", kind="fauna", biomes=["meadow", "beach"], group="meadow", desc="低头啄食的野鸡。"),
    "ani_cow": dict(id="cc0_cow", label="野牛", kind="fauna", biomes=["meadow"], group="meadow", desc="体形厚实的野牛，站在草甸上。"),
    "ani_frog": dict(id="cc0_frog", label="青蛙", kind="fauna", biomes=["swamp", "ocean"], group="swamp", desc="蹲在湿地的青蛙，后腿收着。"),
    # --- camp dressing left by travellers
    "prop_bonfire": dict(id="cc0_campfire", label="野营火堆", kind="detail", biomes=["beach", "meadow"], group="beach", desc="一堆架起的柴火，是旅人留下的营地。"),
    "prop_barrel_large": dict(id="cc0_barrel_a", label="大木桶", kind="detail", biomes=["beach"], group="beach", desc="箍着铁圈的大木桶。"),
    "prop_crate_big": dict(id="cc0_crate_a", label="木箱", kind="detail", biomes=["beach"], group="beach", desc="钉着木条的货箱。"),
    "prop_cart": dict(id="cc0_cart", label="手推车", kind="detail", biomes=["meadow"], group="meadow", desc="两轮的手推车，车斗里空着。"),
    "prop_hay_sheaf": dict(id="cc0_hay", label="干草捆", kind="detail", biomes=["meadow"], group="meadow", desc="捆扎好的干草，草甸上的农事痕迹。"),
    "bld_boat_rowing": dict(id="cc0_boat", label="小划艇", kind="detail", biomes=["beach"], group="beach", desc="拖上岸的木划艇。"),
}

LOD_RATIO = 0.28


def log(*a):
    print("[merge]", *a)


def read_manifest() -> dict:
    with open(PREFAB_JSON, encoding="utf-8") as f:
        return json.load(f)


def glb_meshes(path: str) -> dict[str, list]:
    """Name -> list of mesh objects loaded from an existing GLB."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    out: dict[str, list] = {}
    for o in bpy.data.objects:
        if o.type == "MESH":
            out.setdefault(o.name, []).append(o)
    return out


def tri_count(obj) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def bbox(obj):
    lo = [min(obj.bound_box[i][j] for i in range(8)) for j in range(3)]
    hi = [max(obj.bound_box[i][j] for i in range(8)) for j in range(3)]
    return lo, hi


def load_cc0(model_id: str) -> list:
    path = os.path.join(CC0, model_id + ".glb")
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]


def decimate_copy(src, name: str, ratio: float):
    """A decimated twin for the far LOD, keeping the vertex colours."""
    dup = src.copy()
    dup.data = src.data.copy()
    dup.name = name
    dup.data.name = name
    bpy.context.scene.collection.objects.link(dup)
    mod = dup.modifiers.new("dec", "DECIMATE")
    mod.ratio = ratio
    bpy.context.view_layer.objects.active = dup
    bpy.ops.object.select_all(action="DESELECT")
    dup.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return dup


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    apply = "--apply" in argv

    index = json.load(open(os.path.join(CC0, "index.json"), encoding="utf-8"))
    manifest = read_manifest()
    present = set(manifest["models"])

    plan = []
    for src_id, spec in MAP.items():
        if spec["id"] in present:
            plan.append((src_id, spec["id"], "already in manifest, skipped"))
            continue
        if src_id not in index:
            plan.append((src_id, spec["id"], "MISSING from world_v2/cc0/index.json"))
            continue
        plan.append((src_id, spec["id"], f"add, {index[src_id]['tris']} tris"))

    for a, b, note in plan:
        log(f"{a:26} -> {b:20} {note}")
    if not apply:
        log("dry run; pass --apply to write")
        return 0

    todo = [p for p in plan if p[2].startswith("add")]
    if not todo:
        log("nothing to add")
        return 0

    # --- load the existing library, then append the new meshes
    existing = glb_meshes(PREFAB_GLB)
    log(f"existing meshes in prefabs.glb: {sum(len(v) for v in existing.values())}")

    added_entries = {}
    for src_id, lib_id, _ in todo:
        meshes = load_cc0(src_id)
        if not meshes:
            log(f"SKIP {src_id}: no mesh")
            continue
        near = meshes[0]
        for extra in meshes[1:]:
            bpy.ops.object.select_all(action="DESELECT")
            extra.select_set(True)
            near.select_set(True)
            bpy.context.view_layer.objects.active = near
            bpy.ops.object.join()
        near.name = lib_id
        near.data.name = lib_id
        near.location = (0, 0, 0)

        lod = decimate_copy(near, lib_id + "__lod1", LOD_RATIO)

        lo, hi = bbox(near)
        size = [round(hi[0] - lo[0], 3), round(hi[2] - lo[2], 3), round(hi[1] - lo[1], 3)]
        height = hi[2] - lo[2]
        spec = MAP[src_id]
        kind = spec.get("kind", "landmark" if lib_id == "cc0_ancient" else "tree")
        # Collision follows the game's existing convention per kind: rocks and trees
        # get a cylinder, shrubs/plants/details do not collide at all (the originals
        # store `false` and the placement code reads that as walk-through).
        if kind in ("rock", "landmark", "tree"):
            collide = {"r": round(max(size[0], size[2]) * 0.24, 2), "h": round(height, 2)}
        else:
            collide = False
        entry = {
            "id": lib_id,
            "label": spec["label"],
            "kind": kind,
            "biomes": spec["biomes"],
            "desc": spec["desc"],
            "group": spec["group"],
            "tris": tri_count(near),
            "lod1Tris": tri_count(lod),
            "glow": False,
            "size": size,
            "base": round(lo[2], 3),
            "collide": collide,
            "material": {},
            "scale": [0.85, 1.25],
            "castShadow": kind in ("rock", "landmark", "tree", "fauna"),
            "sink": 0.12 if kind in ("rock", "landmark", "tree") else 0.06,
            "farCut": 26 if kind in ("rock", "landmark", "tree") else 22,
            "source": "majo-no-tabitabi (CC0)",
        }
        added_entries[lib_id] = entry
        log(f"added {lib_id}: {entry['tris']} tris, lod {entry['lod1Tris']}, size {size}")

    # --- re-export everything: old meshes plus the new ones
    all_meshes = [o for v in existing.values() for o in v]
    all_meshes += [bpy.data.objects[n] for n in added_entries]
    all_meshes += [bpy.data.objects[n + "__lod1"] for n in added_entries]

    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in all_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = all_meshes[0]

    bpy.ops.export_scene.gltf(
        filepath=PREFAB_GLB, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_materials="NONE", export_vertex_color="ACTIVE", export_cameras=False,
        export_lights=False, export_animations=False, export_skins=False, export_morph=False,
        export_extras=True,
    )
    log(f"re-exported prefabs.glb with {len(all_meshes)} meshes")

    manifest["models"].update(added_entries)
    manifest["generated"] = manifest.get("generated", "") + " + cc0"
    tmp = PREFAB_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    os.replace(tmp, PREFAB_JSON)
    log(f"manifest now has {len(manifest['models'])} models")
    return 0


if __name__ == "__main__":
    sys.exit(main())
