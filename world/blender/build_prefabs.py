"""
build_prefabs.py — build the shipped prefab library from world/recipes/prefabs/*.json.

    blender --python world/blender/build_prefabs.py -- [--only a,b] [--no-render]
    blender world/prefabs.blend --python world/blender/build_prefabs.py -- [--only a,b]

Writes  app/public/models/prefabs.glb + prefabs.json , the editable source
world/prefabs.blend, and contact sheets under world/renders/.
Everything is logged to world/renders/_prefabs_log.txt; a done/error marker is
written last so a driving agent can tell a finished round from a running one.

In a window the work is deferred to a timer so it runs once the event loop is
live (depsgraph evaluation, the GLB exporter and EEVEE all need it), and the
contact sheets are rendered as background jobs chained through render_post.
"""
import json
import os
import sys
import time
import traceback

import bpy

_HERE = globals().get("__file__") or r"D:\Desktop\world\world\blender\build_prefabs.py"
HERE = os.path.dirname(os.path.abspath(_HERE))
sys.path.append(HERE)
ROOT = os.path.dirname(os.path.dirname(HERE))
import importlib

import mistlib as L  # noqa: E402
import mistbuild as MB  # noqa: E402

# Re-run from Blender's Text Editor or Python console: always pick up the current
# library code instead of the modules cached from an earlier run in this session.
importlib.reload(L)
importlib.reload(MB)

RECIPES = os.path.join(ROOT, "world", "recipes", "prefabs")
BLEND = os.path.join(ROOT, "world", "prefabs.blend")
RENDERS = os.path.join(ROOT, "world", "renders")
OUT_DIR = os.path.join(ROOT, "app", "public", "models")
DONE = os.path.join(RENDERS, "_prefabs_done.json")
ERR = os.path.join(RENDERS, "_prefabs_error.txt")
LOG = os.path.join(RENDERS, "_prefabs_log.txt")

GROUPS = ["shared", "meadow", "forest", "snow", "desert", "swamp", "volcanic", "beach", "landmark"]


# --------------------------------------------------------------------------- logging


class _Tee:
    def __init__(self, path):
        self.f = open(path, "w", encoding="utf-8", buffering=1)

    def write(self, s):
        try:
            self.f.write(s)
        except Exception:
            pass

    def flush(self):
        try:
            self.f.flush()
        except Exception:
            pass


_ORIG = (sys.stdout, sys.stderr)


def _streams_on():
    sys.stdout = _Tee(LOG)
    sys.stderr = sys.stdout


def _streams_off():
    sys.stdout.flush()
    sys.stdout, sys.stderr = _ORIG


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg))


def argv_after_dash():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


# --------------------------------------------------------------------------- scene upkeep


def purge():
    for name in ("Prefabs_Source", "Prefabs_Display", "Prefabs_LOD1"):
        col = bpy.data.collections.get(name)
        if col:
            for ob in list(col.all_objects):
                bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.collections.remove(col)
    pv = bpy.data.scenes.get("Preview")
    if pv:
        MB.clear_scene(pv)
    for ob in list(bpy.data.objects):
        if ob.name.startswith("_mist_tmp"):
            bpy.data.objects.remove(ob, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for b in list(block):
            if b.users == 0:
                block.remove(b)


def collection(scene, name):
    col = bpy.data.collections.get(name)
    if not col:
        col = bpy.data.collections.new(name)
    if col.name not in scene.collection.children:
        scene.collection.children.link(col)
    return col


def add_label(col, text, loc, size, mat):
    cu = bpy.data.curves.new("label", "FONT")
    cu.body = text
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "TOP"
    cu.materials.append(mat)
    ob = bpy.data.objects.new("label", cu)
    ob.location = loc
    col.objects.link(ob)
    return ob


# --------------------------------------------------------------------------- the build


class PrefabBuild:
    def __init__(self):
        self.recipes = []
        self.built = []
        self.errors = {}
        self.manifest = {"version": 1, "blender": bpy.app.version_string, "glb": "prefabs.glb",
                         "generated": time.strftime("%Y-%m-%d %H:%M:%S"), "models": {}}
        self.t0 = time.time()
        self.only = None
        self.do_render = True

    # -- stages ---------------------------------------------------------------
    def prepare(self):
        opts = argv_after_dash()
        if "--only" in opts:
            self.only = set(opts[opts.index("--only") + 1].split(","))
        self.do_render = "--no-render" not in opts
        os.makedirs(RENDERS, exist_ok=True)
        os.makedirs(OUT_DIR, exist_ok=True)
        for m in (DONE, ERR):
            if os.path.exists(m):
                os.remove(m)
        for f in os.listdir(RENDERS):
            if f.startswith("sheet_") and f.endswith(".png"):
                os.remove(os.path.join(RENDERS, f))

        scene = bpy.data.scenes.get("Prefabs") or bpy.context.scene
        scene.name = "Prefabs"
        purge()
        for name in ("Cube", "Light", "Camera"):
            ob = bpy.data.objects.get(name)
            if ob is not None and ob.users_scene and ob.name not in ("PreviewSun", "PreviewCam", "PreviewGround"):
                bpy.data.objects.remove(ob, do_unlink=True)
        self.scene = scene
        self.src = collection(scene, "Prefabs_Source")
        self.disp = collection(scene, "Prefabs_Display")
        self.src.hide_viewport = False
        self.src.hide_render = True

        for f in sorted(os.listdir(RECIPES)):
            if not f.endswith(".json"):
                continue
            with open(os.path.join(RECIPES, f), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            for r in data if isinstance(data, list) else [data]:
                if self.only and r["id"] not in self.only:
                    continue
                self.recipes.append(r)
        if not self.recipes:
            raise RuntimeError("no recipes selected")
        log("prepared: %d recipes" % len(self.recipes))

    def build(self):
        out_json = os.path.join(OUT_DIR, "prefabs.json")
        if self.only and os.path.exists(out_json):
            with open(out_json, "r", encoding="utf-8") as fh:
                self.manifest["models"] = json.load(fh).get("models", {})
        for r in self.recipes:
            try:
                g0 = MB.build_recipe(r, 0)
                g1 = None if r.get("lod1") is False else MB.build_recipe(r, 1)
                objs = []
                for geos, lod, tag in ((g0, 0, ""), (g1, 1, "__lod1")):
                    for sub in ("main", "glow"):
                        if geos is None or not geos[sub].tris:
                            continue
                        # "<id>", "<id>__glow", "<id>__lod1", "<id>__glow__lod1" — the
                        # spelling the browser's AssetLibrary looks these up by
                        suffix = ("__glow" if sub == "glow" else "") + tag
                        ob = MB.make_object(r["id"] + suffix, geos[sub], self.src)
                        ob["mist_id"] = r["id"]
                        ob["mist_lod"] = lod
                        ob["mist_glow"] = sub == "glow"
                        ob["mist_tris"] = geos[sub].tris
                        objs.append(ob)
                e = MB.manifest_entry(r, g0, g1)
                self.manifest["models"][r["id"]] = e
                self.built.append((r, g0, objs))
                print("[prefab] %-26s lod0=%5d lod1=%5s size=%s" % (r["id"], e["tris"], e["lod1Tris"], e["size"]))
            except Exception as ex:  # noqa: BLE001
                self.errors[r["id"]] = traceback.format_exc()
                print("[prefab] FAILED %s: %s\n%s" % (r["id"], ex, self.errors[r["id"]]))
        if not self.built:
            raise RuntimeError("every recipe failed:\n" + "\n".join(self.errors.values()))
        self.manifest["errors"] = sorted(self.errors)
        log("built %d models (%d failed) in %.1fs" % (len(self.built), len(self.errors), time.time() - self.t0))

    def export(self):
        MB.export_glb([ob for ob in self.src.all_objects], os.path.join(OUT_DIR, "prefabs.glb"))
        MB.write_json(os.path.join(OUT_DIR, "prefabs.json"), self.manifest)
        log("exported prefabs.glb + prefabs.json")

    def layout(self):
        self.src.hide_viewport = True
        label_mat = MB.flat_material("LabelMat", L.hex_rgb("#2b3440"))
        group_mat = MB.flat_material("GroupMat", L.hex_rgb("#8a94a0"))
        row_y = 0.0
        for g in GROUPS:
            items = [b for b in self.built if (b[0].get("group") or "shared") == g]
            if not items:
                continue
            x = 0.0
            for r, _g0, objs in items:
                e = self.manifest["models"][r["id"]]
                for ob in objs:
                    if ob["mist_lod"]:
                        continue
                    d = bpy.data.objects.new("show_" + ob.name, ob.data)
                    d.location = (x, row_y, 0)
                    self.disp.objects.link(d)
                add_label(self.disp, "%s\n%d tris" % (r["id"], e["tris"]), (x, row_y - 0.5, 0.02), 0.17, label_mat)
                x += max(e["size"][0], 1.2) + 1.5
            add_label(self.disp, g.upper(), (-3.4, row_y + 0.5, 0.02), 0.42, group_mat)
            row_y -= 7.0
        sc = self.scene
        sc.world = sc.world or bpy.data.worlds.new("PrefabsWorld")
        sc.world.use_nodes = True
        bg = sc.world.node_tree.nodes.get("Background")
        bg.inputs[0].default_value = (0.80, 0.86, 0.92, 1.0)
        bg.inputs[1].default_value = 1.0

    # -- contact sheets -------------------------------------------------------
    SHEET = 12

    def _sheet_jobs(self):
        starts = list(range(0, len(self.built), self.SHEET))
        return [(0, s) for s in starts] + [(1, s) for s in starts]

    def _place_sheet(self, s, lod):
        """Lay out one sheet of up to 12 models (near LOD, or the far LOD for lod = 1)."""
        pv = bpy.data.scenes["Preview"]
        chunk = self.built[s:s + self.SHEET]
        rows = (len(chunk) + 3) // 4
        for i, item in enumerate(chunk):
            r, _g0, objs = item
            e = self.manifest["models"][r["id"]]
            mine = [ob for ob in objs if ob["mist_lod"] == lod] or [ob for ob in objs if ob["mist_lod"] == 0]
            meshes = [(ob.data, bool(ob["mist_glow"])) for ob in mine]
            hgt = 1.0 if r.get("kind") == "detail" else 1.5
            tag = "%d tris" % (e["tris"] if lod == 0 else (e["lod1Tris"] or e["tris"]))
            MB.place_for_sheet(pv, meshes, (i % 4 - 1.5) * 2.3, -(i // 4) * 3.3 + 1.3, hgt,
                               "%s  ·  %s  ·  h %.1f" % (r["id"], tag, e["size"][1]), self.label_mat)
        # world-space box of everything on the sheet (Blender frame), for the fitted camera
        self._box = ((-4.8, 1.3 - (rows - 1) * 3.3 - 1.6, 0.0), (4.8, 2.5, 1.7))
        name = "sheet_%02d.png" if lod == 0 else "sheet_lod1_%02d.png"
        pv.render.filepath = os.path.join(RENDERS, name % (s // self.SHEET + 1))

    def _open_studio(self):
        pv = bpy.data.scenes.get("Preview") or bpy.data.scenes.new("Preview")
        cam = MB.build_preview_scene(pv)
        return pv, cam

    def sheets_sync(self):
        pv, cam = self._open_studio()
        self.label_mat = MB.flat_material("LabelMat", L.hex_rgb("#2b3440"))
        for lod, s in self._sheet_jobs():
            MB.clear_scene(pv)
            pv, cam = self._open_studio()
            self._place_sheet(s, lod)
            MB.aim_camera(cam, *self._box)
            bpy.ops.render.render(write_still=True, scene=pv.name)
        return len(self._sheet_jobs())

    def sheets_async(self):
        """Window mode: one background render job per sheet, chained through render_post."""
        self.label_mat = MB.flat_material("LabelMat", L.hex_rgb("#2b3440"))
        jobs = self._sheet_jobs()
        state = {"i": 0}
        pv = bpy.data.scenes.get("Preview") or bpy.data.scenes.new("Preview")

        def stop():
            bpy.app.handlers.render_post.remove(on_post)
            bpy.app.handlers.render_cancel.remove(on_cancel)
            MB.clear_scene(pv)
            self.finish(len(jobs))

        def next_sheet():
            if state["i"] >= len(jobs):
                stop()
                return None
            MB.clear_scene(pv)
            _pv, cam = self._open_studio()
            lod, s = jobs[state["i"]]
            self._place_sheet(s, lod)
            MB.aim_camera(cam, *self._box)
            log("rendering %s" % os.path.basename(pv.render.filepath))
            state["i"] += 1
            bpy.ops.render.render("INVOKE_DEFAULT", write_still=True, scene=pv.name)
            return None

        def on_post(*_a):
            bpy.app.timers.register(next_sheet, first_interval=0.4)

        def on_cancel(*_a):
            stop()

        bpy.app.handlers.render_post.append(on_post)
        bpy.app.handlers.render_cancel.append(on_cancel)
        bpy.app.timers.register(next_sheet, first_interval=0.2)

    # -- wrap-up --------------------------------------------------------------
    def finish(self, sheets, cancelled=False):
        try:
            win = bpy.context.window
            if win:
                win.workspace = bpy.data.workspaces.get("Layout") or win.workspace
                for area in win.screen.areas:
                    if area.type == "VIEW_3D":
                        for sp in area.spaces:
                            if sp.type == "VIEW_3D":
                                sp.shading.type = "MATERIAL"
            bpy.ops.wm.save_as_mainfile(filepath=BLEND)
            MB.write_json(DONE, {"ok": True, "count": len(self.built), "sheets": sheets,
                                 "seconds": round(time.time() - self.t0, 1), "errors": self.errors})
            log("DONE %d models, %d sheets, %.1fs" % (len(self.built), sheets, time.time() - self.t0))
        except Exception:
            with open(ERR, "w", encoding="utf-8") as f:
                f.write(traceback.format_exc())
            traceback.print_exc()
        finally:
            _streams_off()

    def run(self):
        if bpy.app.background:
            self.prepare()
            self.build()
            self.export()
            self.layout()
            sheets = self.sheets_sync() if self.do_render else 0
            self.finish(sheets)
        else:
            self.prepare()
            self.build()
            self.export()
            self.layout()
            if self.do_render:
                self.sheets_async()  # finish() runs after the last sheet
            else:
                self.finish(0)


def _boot():
    os.makedirs(RENDERS, exist_ok=True)
    _streams_on()
    build = PrefabBuild()
    try:
        build.run()
    except Exception:
        with open(ERR, "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
        traceback.print_exc()
        _streams_off()


if bpy.app.background:
    _boot()
elif not bpy.app.timers.is_registered(_boot):
    # window mode: importing (or reloading) this module from the Python console
    # schedules exactly one build; the timer fires once the event loop is live
    bpy.app.timers.register(_boot, first_interval=1.5)
