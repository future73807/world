"""
build_recipe.py — build models an AI designed, headless, for the game server.

    blender -b --factory-startup --python build_recipe.py -- --recipes <in.json> --out <dir>

`in.json` is {"recipes": [recipe, ...]}, each recipe using the same declarative
part vocabulary as the shipped prefab library (see mistlib.py). For every
recipe this writes `<dir>/<id>.glb` (near + far LOD, glowing parts as separate
meshes) and finally `<dir>/models.json`, the manifest entries the browser loads.

Progress is reported on stdout as `MIST_PROGRESS <0..1> <text>`.
A recipe that is malformed or uses an unknown part is skipped and reported; it
never stops the other recipes.
"""
import json
import math
import os
import re
import sys
import traceback

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(HERE)
import importlib  # noqa: E402

import mistlib as L  # noqa: E402
import mistbuild as MB  # noqa: E402

importlib.reload(L)
importlib.reload(MB)

MAX_PARTS = 10
MAX_SIZE = 30.0  # BU — nothing the AI asks for may be larger than a landmark
ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")
KIND_DEFAULT_COLLIDE = {
    "tree": (0.42, 1.0),
    "landmark": (0.36, 1.0),
    "shrub": (0.3, 0.9),
    "rock": (0.4, 0.9),
}


def progress(k, n, text):
    print("MIST_PROGRESS %.3f %s" % (k / max(1, n), text))
    sys.stdout.flush()


def finite_numbers(obj, path="parts"):
    """Rejects NaN / inf and absurd magnitudes anywhere in a recipe's numbers."""
    if isinstance(obj, bool) or obj is None:
        return True
    if isinstance(obj, (int, float)):
        return math.isfinite(obj) and abs(obj) <= 1e4
    if isinstance(obj, list):
        return all(finite_numbers(o, path) for o in obj)
    if isinstance(obj, dict):
        return all(isinstance(k, str) and finite_numbers(v, path) for k, v in obj.items())
    return isinstance(obj, str)


def validate(recipe):
    """Returns (clean_recipe, error_or_None)."""
    if not isinstance(recipe, dict):
        return None, "recipe is not an object"
    rid = recipe.get("id") or ""
    if not ID_RE.match(str(rid)):
        return None, "id must be 2-32 chars of a-z, 0-9, _ and start with a letter"
    parts = recipe.get("parts")
    if not isinstance(parts, list) or not parts:
        return None, "no parts"
    if len(parts) > MAX_PARTS:
        return None, "more than %d parts" % MAX_PARTS
    for i, p in enumerate(parts):
        if not isinstance(p, dict):
            return None, "part %d is not an object" % i
        typ = p.get("type")
        if typ not in L.BUILDERS:
            return None, "part %d has unknown type %r" % (i, typ)
    checked = {k: v for k, v in recipe.items() if k != "seed"}
    if not finite_numbers(checked):
        return None, "a number is NaN, infinite or absurdly large"

    clean = dict(recipe)
    clean["id"] = str(rid)
    clean.setdefault("label", rid)
    clean["label"] = str(clean["label"])[:24]
    kind = clean.get("kind") if clean.get("kind") in KIND_DEFAULT_COLLIDE or clean.get("kind") in ("plant", "detail") else "prop"
    clean["kind"] = kind
    clean["desc"] = str(clean.get("desc", ""))[:120]
    clean.setdefault("biomes", [])
    clean.setdefault("material", {})
    clean.setdefault("castShadow", kind in KIND_DEFAULT_COLLIDE)
    clean.setdefault("sink", 0.15 if kind in ("tree", "landmark") else 0.0)
    clean.setdefault("farCut", 24)
    scale = clean.get("scale")
    clean["scale"] = [scale[0], scale[1]] if isinstance(scale, list) and len(scale) == 2 and 0.3 <= scale[0] <= scale[1] <= 3 else [0.9, 1.15]
    if not isinstance(clean.get("seed"), int):
        clean["seed"] = sum((k + 1) * ord(ch) for k, ch in enumerate(rid)) % 100000 + 1
    return clean, None


def collide_for(entry, kind):
    """Collision cylinder from the model's own footprint."""
    w, h, d = entry["size"]
    if kind in ("plant", "detail"):
        return False
    fr, fh = KIND_DEFAULT_COLLIDE.get(kind, (0.4, 0.9))
    return {"r": round(max(w, d) * 0.5 * fr, 3), "h": round(max(0.4, h * fh), 3)}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {}
    for i, a in enumerate(argv):
        if a.startswith("--") and i + 1 < len(argv):
            opts[a[2:]] = argv[i + 1]
    src = opts.get("recipes")
    out = opts.get("out")
    if not src or not out:
        raise SystemExit("usage: --recipes <in.json> --out <dir>")
    os.makedirs(out, exist_ok=True)
    with open(src, "r", encoding="utf-8") as fh:
        recipes = json.load(fh).get("recipes", [])

    scene = bpy.context.scene
    for ob in list(scene.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    tmp = bpy.data.collections.new("Generated")
    scene.collection.children.link(tmp)

    models = []
    failed = []
    total = len(recipes)
    for n, raw in enumerate(recipes):
        recipe, err = validate(raw)
        if err:
            failed.append({"id": str(raw.get("id", "")) if isinstance(raw, dict) else "", "error": err})
            progress(n + 1, total, "skipped")
            continue
        try:
            progress(n, total, "building %s" % recipe["label"])
            g0 = MB.build_recipe(recipe, 0)
            g1 = None if recipe.get("lod1") is False else MB.build_recipe(recipe, 1)
            if max(g0["main"].size() + g0["glow"].size()) > MAX_SIZE * 3:
                raise RuntimeError("model is larger than %d BU" % MAX_SIZE)
            objs = []
            for geos, lod, tag in ((g0, 0, ""), (g1, 1, "__lod1")):
                for sub in ("main", "glow"):
                    if geos is None or not geos[sub].tris:
                        continue
                    suffix = ("__glow" if sub == "glow" else "") + tag
                    ob = MB.make_object(recipe["id"] + suffix, geos[sub], tmp)
                    ob["mist_id"] = recipe["id"]
                    ob["mist_lod"] = lod
                    ob["mist_glow"] = sub == "glow"
                    ob["mist_tris"] = geos[sub].tris
                    objs.append(ob)
            glb = os.path.join(out, recipe["id"] + ".glb")
            MB.export_glb(objs, glb)
            entry = MB.manifest_entry(recipe, g0, g1)
            if "collide" not in recipe:
                entry["collide"] = collide_for(entry, recipe["kind"])
            entry["source"] = "blender"
            entry["url"] = recipe["id"] + ".glb"
            models.append(entry)
            print("[recipe] %-28s lod0=%5d lod1=%5s size=%s" % (recipe["id"], entry["tris"], entry["lod1Tris"], entry["size"]))
        except Exception as ex:  # noqa: BLE001
            traceback.print_exc()
            failed.append({"id": recipe["id"], "error": str(ex)[:200]})
            for ob in list(tmp.all_objects):
                if ob.get("mist_id") == recipe["id"]:
                    bpy.data.objects.remove(ob, do_unlink=True)
        progress(n + 1, total, "done %s" % recipe["label"])

    # keep what was built in an editable project next to the GLBs: the models are
    # lined up along X so they can be looked at (the GLBs were exported at the origin)
    try:
        cursor = 0.0
        for m in models:
            width = max(m["size"][0], 2.0) + 2.0
            for ob in tmp.all_objects:
                if ob.get("mist_id") == m["id"]:
                    ob.location.x = cursor + width * 0.5
            cursor += width
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "models.blend"))
    except Exception:
        traceback.print_exc()

    MB.write_json(os.path.join(out, "models.json"), {"models": models, "failed": failed, "blender": bpy.app.version_string})
    print("[recipe] DONE %d built, %d failed" % (len(models), len(failed)))
    sys.stdout.flush()


try:
    main()
except Exception:
    traceback.print_exc()
    sys.stdout.flush()
    sys.exit(1)
