#!/usr/bin/env python3
"""Re-grade the hand-built models that have no CC0 counterpart to the reference palette.

Run with Blender:

  blender -b -noaudio --python world_v2/blender/regrade_models.py -- --plan
  blender -b -noaudio --python world_v2/blender/regrade_models.py -- --apply

Why this exists: the CC0 imports match majo-no-tabitabi's look, but 14 models (palms,
corals, cacti, the three bespoke landmarks, the glow mushrooms) have no CC0 match and were
hand-built before the reference was chosen. Measured against the imported trees, they sit
off-palette: the imported foliage averages luminance 0.06-0.17 with saturation 0.43-0.65,
while these run 0.24-0.43 with saturation as low as 0.08 (the bone arch and the vent).

The reference look is "deep saturated albedo under bright light", not "pale washed albedo".
So the fix is a hue-preserving re-grade: bring each model's mean colour into the reference
band by scaling value down and saturation up, leaving hue and the internal value spread
(which is what gives the facets their read) untouched.

Writes the result back into app/public/models/prefabs.glb, replacing only the named meshes
and their LOD twins, so no other model is touched.
"""
from __future__ import annotations

import json
import os
import struct
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, "..", ".."))
PREFAB_GLB = os.path.join(PROJECT, "app", "public", "models", "prefabs.glb")

# Target bands, measured from the CC0 imports. They are NOT one number: the reference
# palette spans dark foliage (lum .06-.17) up to pale bark and bone (birch .52, bone .45),
# so each model is graded against the band its material belongs to. Applying the foliage
# band to bone would turn the arch into mud.
FOLIAGE = dict(l=0.14, s=0.50)   # cactus flesh, palm fronds, coral flesh, mushroom caps
BARK = dict(l=0.22, s=0.46)      # palm trunk: darker than the old zebra stripes, still woody
SAND = dict(l=0.26, s=0.42)      # sandstone: mesas, the obelisk
BONE = dict(l=0.34, s=0.26)      # whale ribs: warm ivory, not plaster
BASALT = dict(l=0.13, s=0.08)    # vent stone: near neutral on purpose — value only, no invented hue

# Models to re-grade, with the band they belong to and why they are off it today.
GRADE = {
    "palm_a":            (BARK,    "trunk reads as zebra stripes: value too high, contrast too even"),
    "palm_b":            (BARK,    "same as palm_a"),
    "coral_branch":      (FOLIAGE, "pink is too light (lum .43); deep red under light reads better"),
    "coral_brain":       (FOLIAGE, "purple too pale and too desaturated (lum .42, sat .31)"),
    "coral_fan":         (FOLIAGE, "orange too light"),
    "beach_starfish":    (FOLIAGE, "orange far too bright (lum .37, sat .73)"),
    "desert_cactus_a":   (FOLIAGE, "too bright and too saturated for the desert set"),
    "desert_cactus_b":   (FOLIAGE, "same"),
    "desert_mesa":       (SAND,    "sandstone too pale"),
    "landmark_obelisk":  (SAND,    "sandstone too pale"),
    "landmark_ribs":     (BONE,    "bone is nearly grey (lum .43, sat .18), reads as plaster"),
    "landmark_vent":     (BASALT,  "almost black with no saturation (lum .07, sat .08)"),
    "swamp_mushroom_a":  (FOLIAGE, "cap too pale and desaturated (lum .34, sat .27)"),
    "swamp_mushroom_b":  (FOLIAGE, "same"),
}


def log(*a):
    print("[regrade]", *a)


def rgb_to_hls(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, l, 0.0
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h / 6, l, s


def hls_to_rgb(h, l, s):
    def f(n):
        k = (n + h * 12) % 12
        a = s * min(l, 1 - l)
        return l - a * max(-1, min(k - 3, 9 - k, 1))
    return f(0), f(8), f(4)


def regrade_colour(rgb, target_l, target_s):
    """Hue-preserving: keep the hue, move luminance and saturation to the target band.

    The per-vertex luminance spread is preserved by applying the shift in HLS space to
    `l` relative to the model mean, so facets keep their contrast instead of flattening.
    """
    h, l, s = rgb_to_hls(*rgb)
    return hls_to_rgb(h, max(0.0, min(1.0, l)), max(0.0, min(1.0, s)))


def glb_json(path):
    with open(path, "rb") as f:
        magic, _, _ = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            raise ValueError("not a GLB")
        clen, _ = struct.unpack("<II", f.read(8))
        return json.loads(f.read(clen))


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    apply = "--apply" in argv

    js = glb_json(PREFAB_GLB)
    present = {m["name"] for m in js["meshes"]}
    plan = []
    for mid in sorted(GRADE):
        for suffix in ("", "__lod1"):
            name = mid + suffix
            plan.append((name, name in present))
    for name, ok in plan:
        if not ok:
            log(f"NOTE {name} not in library, skipped")

    log(f"{len(GRADE)} models to re-grade ({'apply' if apply else 'dry run'})")
    for mid in sorted(GRADE):
        band, why = GRADE[mid]
        log(f"  {mid:22} lum->{band['l']:.2f} sat->{band['s']:.2f}  ({why})")
    if not apply:
        return 0

    # --- load, re-grade the target meshes, re-export everything
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=PREFAB_GLB)
    meshes = {o.name: o for o in bpy.data.objects if o.type == "MESH"}

    changed = 0
    for mid in sorted(GRADE):
        band, _why = GRADE[mid]
        tl, ts = band["l"], band["s"]
        for suffix in ("", "__lod1"):
            ob = meshes.get(mid + suffix)
            if ob is None:
                continue
            ca = ob.data.color_attributes.active_color
            if ca is None:
                log(f"WARN {ob.name}: no colour layer")
                continue
            # model mean in HLS, so the shift keeps the facet spread
            n = len(ca.data)
            if n == 0:
                continue
            sr = sg = sb = 0.0
            for i in range(n):
                c = ca.data[i].color
                sr += c[0]; sg += c[1]; sb += c[2]
            mean_h, mean_l, mean_s = rgb_to_hls(sr / n, sg / n, sb / n)
            d_l = tl - mean_l
            # Saturation may only be *lifted* on a material that already has a hue. A near
            # neutral (the vent's grey basalt) has an arbitrary hue, and pushing its
            # saturation up paints it a colour nobody chose — that turned the vent purple.
            # Near neutrals keep their hue discipline and only move in value.
            neutral = mean_s < 0.15
            d_s = 0.0 if neutral else (ts - mean_s) / max(0.08, mean_s)
            if neutral:
                log(f"  {ob.name}: near-neutral (sat {mean_s:.2f}), value only")
            for i in range(n):
                c = ca.data[i].color
                h, l, s = rgb_to_hls(c[0], c[1], c[2])
                nl = max(0.0, min(1.0, l + d_l))
                ns = max(0.0, min(1.0, s * (1.0 + d_s)))
                r, g, b = hls_to_rgb(h, nl, ns)
                ca.data[i].color = [r, g, b, 1.0]
            changed += 1

    log(f"re-graded {changed} meshes")

    for o in bpy.context.scene.objects:
        o.select_set(o.type == "MESH")
    bpy.context.view_layer.objects.active = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=PREFAB_GLB, export_format="GLB", use_selection=True, export_apply=True,
        export_yup=True, export_texcoords=False, export_normals=True, export_tangents=False,
        export_materials="NONE", export_vertex_color="ACTIVE", export_cameras=False,
        export_lights=False, export_animations=False, export_skins=False, export_morph=False,
        export_extras=True,
    )
    log(f"re-exported {PREFAB_GLB}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
