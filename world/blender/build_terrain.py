"""
build_terrain.py — build the birth island's terrain in Blender and export it for the game.

    blender --python world/blender/build_terrain.py
    blender world/terrain.blend --python world/blender/build_terrain.py -- [--no-render]

After sculpting or editing world/terrain.blend by hand:
    blender world/terrain.blend --python world/blender/build_terrain.py -- --export-only
    (exports what is in the file; does NOT rebuild the meshes)

Input  (written by app/scripts/export-terrain.mjs):
    world/terrain/birth_chunks.f32    positions, colours, triangle indices of every chunk
    world/terrain/birth_index.json    chunk list and offsets
Output:
    world/terrain.blend                       the editable terrain project
    app/public/terrain/birth.glb              the chunk meshes the game loads
    app/public/terrain/birth_heights.bin      collision heights, sampled FROM THE
                                              BLENDER MESHES (so sculpting in the
                                              .blend and re-running this script
                                              changes what the slime walks on)
    app/public/terrain/birth_index.json
    world/renders/terrain_top.png, terrain_persp.png, markers
"""
import json
import os
import sys
import time
import traceback

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(globals().get("__file__") or r"D:\Desktop\world\world\blender\build_terrain.py"))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.append(HERE)
import mistbuild as MB  # noqa: E402
import mistlib as L  # noqa: E402

SRC_F32 = os.path.join(ROOT, "world", "terrain", "birth_chunks.f32")
SRC_IDX = os.path.join(ROOT, "world", "terrain", "birth_index.json")
BLEND = os.path.join(ROOT, "world", "terrain.blend")
RENDERS = os.path.join(ROOT, "world", "renders")
OUT_DIR = os.path.join(ROOT, "app", "public", "terrain")
DONE = os.path.join(RENDERS, "_terrain_done.json")
ERR = os.path.join(RENDERS, "_terrain_error.txt")
LOG = os.path.join(RENDERS, "_terrain_log.txt")

CHUNK = 10.0  # BU per chunk edge (app/src/game/world.ts)
GRID = 15  # height samples per chunk edge (SUBDIV + 1)


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


def log(msg):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), msg))


def argv_after_dash():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def collection(scene, name):
    col = bpy.data.collections.get(name)
    if not col:
        col = bpy.data.collections.new(name)
    if col.name not in scene.collection.children:
        scene.collection.children.link(col)
    return col


def material():
    return MB.mist_material(False)


def build():
    """Replaces the terrain collection with meshes built from the export."""
    data = np.fromfile(SRC_F32, dtype="<f4")
    with open(SRC_IDX, "r", encoding="utf-8") as fh:
        idx = json.load(fh)
    if int(idx["grid"]) != GRID:
        raise RuntimeError("height grid is %s, expected %s — update GRID" % (idx["grid"], GRID))

    scene = bpy.data.scenes.get("Terrain") or bpy.context.scene
    scene.name = "Terrain"
    # the game only loads the export for the seed it was built for: keep it with the project
    scene["mist_seed"] = int(idx["seed"])
    old = bpy.data.collections.get("Birth_Terrain")
    if old:
        for ob in list(old.all_objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(old)
    for name in ("Cube", "Light", "Camera"):
        ob = bpy.data.objects.get(name)
        if ob is not None:
            bpy.data.objects.remove(ob, do_unlink=True)
    col = collection(scene, "Birth_Terrain")
    mat = material()

    t0 = time.time()
    tris = 0
    fixed = 0
    dropped = 0
    for c in idx["layout"]:
        v = int(c["v"])
        ntri = int(c["i"])
        po = int(c["po"])
        co = int(c["co"])
        pos = data[po:po + v * 3].reshape(-1, 3)
        colr = data[co:co + v * 3].reshape(-1, 3)
        ind = data[c["io"]:c["io"] + ntri * 3].astype(np.int64).reshape(-1, 3)
        # game frame (x, y up, z) -> Blender (x, y, z up); a proper rotation, so the
        # counter-clockwise winding (faces pointing up) is preserved
        verts = np.stack([pos[:, 0], -pos[:, 2], pos[:, 1]], axis=1)
        me = bpy.data.meshes.new("Chunk_%d_%d" % (c["cx"], c["cz"]))
        me.from_pydata([tuple(p) for p in verts], [], [tuple(int(k) for k in f) for f in ind])
        # from_pydata does not check its input; validate() removes whatever is
        # malformed (the exporter would otherwise warn about every chunk)
        if me.validate(verbose=False):
            fixed += 1
        me.update()
        if len(me.polygons) != ntri:
            dropped += ntri - len(me.polygons)
        for poly in me.polygons:
            poly.use_smooth = False
        attr = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
        flat = np.concatenate([colr, np.ones((v, 1), dtype="<f4")], axis=1).reshape(-1)
        attr.data.foreach_set("color", flat.astype(np.float32))
        me.materials.append(mat)
        ob = bpy.data.objects.new("Chunk_%d_%d" % (c["cx"], c["cz"]), me)
        ob["mist_cx"] = int(c["cx"])
        ob["mist_cz"] = int(c["cz"])
        col.objects.link(ob)
        tris += ntri
    bpy.context.view_layer.update()
    objects = sorted(col.all_objects, key=lambda o: (int(o["mist_cx"]), int(o["mist_cz"])))
    log("built %d chunk meshes (%d triangles) in %.1fs; validate() touched %d chunks, dropped %d faces"
        % (len(objects), tris, time.time() - t0, fixed, dropped))
    # a broken export must never reach the game: a clean chunk list validates untouched
    if fixed or dropped:
        raise RuntimeError("terrain export is inconsistent: validate() touched %d chunks and dropped %d faces" % (fixed, dropped))
    # the chunk list is in OBJECT order: sample_heights() writes in the same order
    return col, objects, {"seed": idx["seed"], "chunks": [[int(o["mist_cx"]), int(o["mist_cz"])] for o in objects]}


def existing():
    """--export-only: use the chunks already in the open project (sculpted, edited)."""
    col = bpy.data.collections.get("Birth_Terrain")
    if not col or not len(col.all_objects):
        raise RuntimeError("--export-only needs world/terrain.blend (collection Birth_Terrain) open")
    objects = sorted(col.all_objects, key=lambda o: (int(o["mist_cx"]), int(o["mist_cz"])))
    log("using %d chunk meshes from the open project" % len(objects))
    scene = bpy.data.scenes.get("Terrain") or bpy.context.scene
    seed = scene.get("mist_seed")
    if seed is None:
        # a project saved before the seed was recorded: the derived export may still have it
        try:
            with open(SRC_IDX, "r", encoding="utf-8") as fh:
                seed = int(json.load(fh)["seed"])
            log("seed %d read from %s" % (seed, SRC_IDX))
        except Exception:
            raise RuntimeError("--export-only: this project does not record the seed it was built for (scene 'Terrain', property mist_seed); rebuild it with `npm run assets:terrain`")
    # a null seed here would make the game ignore the whole export without a word
    return col, objects, {"seed": int(seed), "chunks": [[int(o["mist_cx"]), int(o["mist_cz"])] for o in objects]}


def sample_heights(objects):
    """
    Heights of the regular grid under each chunk, read off the Blender meshes
    (evaluated, so modifiers and sculpting count). All chunks go into ONE BVH
    tree: chunk vertices are jittered by a few centimetres, so a grid point on a
    chunk border can fall just outside that chunk — but never outside the island.
    The game's (x, z) maps to Blender (x, -z); each ray looks straight down -Z.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    verts = []
    tris = []
    for ob in objects:
        me = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph))
        me.calc_loop_triangles()
        world = ob.matrix_world
        base = len(verts)
        verts.extend(world @ v.co for v in me.vertices)
        tris.extend(tuple(base + k for k in t.vertices) for t in me.loop_triangles)
        bpy.data.meshes.remove(me)
    bvh = BVHTree.FromPolygons(verts, tris, all_triangles=True)
    log("terrain surface: %d vertices, %d triangles" % (len(verts), len(tris)))

    step = CHUNK / (GRID - 1)
    out = []
    misses = 0
    down = Vector((0.0, 0.0, -1.0))
    # on the OUTER edge of the exported area a grid point can sit a few centimetres
    # beyond its jittered chunk with no neighbour behind it: retry a hair inward
    nudges = ((0.0, 0.0), (0.09, 0.0), (-0.09, 0.0), (0.0, 0.09), (0.0, -0.09), (0.06, 0.06), (-0.06, -0.06))
    # analytic heights from the world code: a vertical hint for the few points a ray cannot reach
    hint_by_chunk = {}
    try:
        hint_all = np.fromfile(os.path.join(ROOT, "world", "terrain", "birth_heights.f32"), dtype="<f4")
        with open(SRC_IDX, "r", encoding="utf-8") as fh:
            node_chunks = json.load(fh)["chunks"]
        for k, (hx, hz) in enumerate(node_chunks):
            hint_by_chunk[(int(hx), int(hz))] = hint_all[k * GRID * GRID:(k + 1) * GRID * GRID]
    except Exception:
        hint_by_chunk = {}
    fallback = 0
    for ob in objects:
        cx = int(ob["mist_cx"])
        cz = int(ob["mist_cz"])
        for j in range(GRID):
            for i in range(GRID):
                gx = cx * CHUNK + i * step
                gz = cz * CHUNK + j * step
                loc = None
                for ox, oy in nudges:
                    loc = bvh.ray_cast(Vector((gx + ox, -gz + oy, 400.0)), down, 800.0)[0]
                    if loc is not None:
                        break
                if loc is None:
                    # an outer corner the jitter pushed past every nudge: take the
                    # closest point of the surface to the analytic height instead
                    hint = hint_by_chunk.get((cx, cz))
                    zh = float(hint[j * GRID + i]) if hint is not None and j * GRID + i < len(hint) else 0.0
                    near = bvh.find_nearest(Vector((gx, -gz, zh)))[0]
                    if near is None:
                        misses += 1
                        out.append(zh)
                    else:
                        fallback += 1
                        out.append(float(near.z))
                else:
                    out.append(float(loc.z))
    if fallback:
        log("height samples taken from the nearest surface point instead of a ray: %d of %d" % (fallback, len(out)))
    if misses:
        raise RuntimeError("%d of %d height samples missed the terrain entirely" % (misses, len(out)))
    return np.array(out, dtype="<f4")


def check_against_analytic(objects, heights):
    """
    The meshes were built from the world code, so the heights read back off them
    must match the analytic grid (up to the mesh's own linear interpolation). A
    mismatch means the chunk order got out of step somewhere — refuse to export.
    """
    hint_all = np.fromfile(os.path.join(ROOT, "world", "terrain", "birth_heights.f32"), dtype="<f4")
    with open(SRC_IDX, "r", encoding="utf-8") as fh:
        node_chunks = json.load(fh)["chunks"]
    order = {(int(a), int(b)): k for k, (a, b) in enumerate(node_chunks)}
    n = GRID * GRID
    diffs = []
    for k, ob in enumerate(objects):
        ref = order.get((int(ob["mist_cx"]), int(ob["mist_cz"])))
        if ref is None:
            raise RuntimeError("chunk %s is not in the Node export" % ob.name)
        mine = heights[k * n:(k + 1) * n]
        theirs = hint_all[ref * n:(ref + 1) * n]
        diffs.append(np.abs(mine - theirs))
    d = np.concatenate(diffs)
    log("self-check vs analytic heights: mean %.4f BU, p99 %.4f BU, max %.4f BU" % (d.mean(), np.percentile(d, 99), d.max()))
    if d.mean() > 0.05 or np.percentile(d, 99) > 0.25:
        raise RuntimeError("heights read from the meshes do not match the surface they were built from (mean %.3f, p99 %.3f)" % (d.mean(), np.percentile(d, 99)))


def export(objects, idx, heights):
    os.makedirs(OUT_DIR, exist_ok=True)
    for ob in bpy.context.scene.objects:
        ob.select_set(False)
    for ob in objects:
        ob.select_set(True)
    glb = os.path.join(OUT_DIR, "birth.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=False,
        export_normals=False,  # the game flat-shades the terrain from derivatives
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=True,
    )
    heights.tofile(os.path.join(OUT_DIR, "birth_heights.bin"))
    MB.write_json(
        os.path.join(OUT_DIR, "birth_index.json"),
        {"seed": idx["seed"], "grid": GRID, "chunks": idx["chunks"], "source": "world/terrain.blend"},
    )
    log("exported %s (%.2f MB) + heights for %d chunks" % (glb, os.path.getsize(glb) / 1048576.0, len(idx["chunks"])))


class TerrainBuild:
    """Window mode: the studio renders run as background jobs chained by render_post."""

    def __init__(self, do_render):
        self.do_render = do_render
        self.t0 = time.time()

    def run(self):
        for m in (DONE, ERR):
            if os.path.exists(m):
                os.remove(m)
        export_only = "--export-only" in argv_after_dash()
        col, objects, idx = existing() if export_only else build()
        heights = sample_heights(objects)
        if not export_only:
            check_against_analytic(objects, heights)
        export(objects, idx, heights)
        if self.do_render and not bpy.app.background:
            self.studio(col)
        else:
            if self.do_render:
                self.studio_sync(col)
                self._close()
            self.finish(2 if self.do_render else 0)

    # -- previews -------------------------------------------------------------
    def _open(self, col):
        pv = bpy.data.scenes.get("Terrain_Preview") or bpy.data.scenes.new("Terrain_Preview")
        # start from an empty preview scene. Only preview-owned objects are deleted;
        # the terrain objects are merely unlinked — the terrain collection itself
        # must never be passed to a cleaner that removes child collections.
        for ob in list(pv.collection.objects):
            if ob.name in ("Sun", "Cam"):
                bpy.data.objects.remove(ob, do_unlink=True)
            else:
                pv.collection.objects.unlink(ob)
        for ch in list(pv.collection.children):
            pv.collection.children.unlink(ch)
        pv.world = bpy.data.worlds.new("TerrainWorld")
        pv.world.use_nodes = True
        bg = pv.world.node_tree.nodes.get("Background")
        bg.inputs[0].default_value = (0.80, 0.86, 0.92, 1.0)
        bg.inputs[1].default_value = 0.7
        sun = bpy.data.lights.new("Sun", "SUN")
        sun.energy = 2.0
        sun.angle = 0.06
        sun_ob = bpy.data.objects.new("Sun", sun)
        sun_ob.rotation_euler = Vector((0.55, 0.62, -0.56)).to_track_quat("-Z", "Y").to_euler()
        pv.collection.objects.link(sun_ob)
        cam = bpy.data.cameras.new("Cam")
        cam_ob = bpy.data.objects.new("Cam", cam)
        pv.collection.objects.link(cam_ob)
        pv.camera = cam_ob
        for ob in col.all_objects:
            pv.collection.objects.link(ob)
        pv.render.engine = "BLENDER_EEVEE_NEXT"
        pv.eevee.taa_render_samples = 16
        pv.view_settings.view_transform = "Standard"
        pv.view_settings.look = "None"
        pv.render.image_settings.file_format = "PNG"
        return pv, cam, cam_ob

    def _close(self):
        pv = bpy.data.scenes.get("Terrain_Preview")
        if not pv:
            return
        for ob in list(pv.collection.objects):
            if ob.name in ("Sun", "Cam"):
                bpy.data.objects.remove(ob, do_unlink=True)
            else:
                pv.collection.objects.unlink(ob)

    def _top(self, pv, cam, cam_ob):
        cam.type = "ORTHO"
        cam.ortho_scale = 170
        cam_ob.location = (0, 0, 220)
        cam_ob.rotation_euler = (0, 0, 0)
        pv.render.resolution_x = pv.render.resolution_y = 1400
        pv.render.filepath = os.path.join(RENDERS, "terrain_top.png")

    def _persp(self, pv, cam, cam_ob):
        cam.type = "PERSP"
        cam.lens = 32
        cam_ob.location = (-150, -170, 120)
        cam_ob.rotation_euler = (Vector((0, 0, 8)) - cam_ob.location).to_track_quat("-Z", "Y").to_euler()
        pv.render.resolution_x = 1600
        pv.render.resolution_y = 900
        pv.render.filepath = os.path.join(RENDERS, "terrain_persp.png")

    def studio_sync(self, col):
        pv, cam, cam_ob = self._open(col)
        self._top(pv, cam, cam_ob)
        bpy.ops.render.render(write_still=True, scene=pv.name)
        self._persp(pv, cam, cam_ob)
        bpy.ops.render.render(write_still=True, scene=pv.name)

    def studio(self, col):
        self.col = col
        self.stage = 0
        bpy.app.handlers.render_post.append(self._on_post)
        bpy.app.handlers.render_cancel.append(self._on_cancel)
        bpy.app.timers.register(self._next, first_interval=0.2)

    def _next(self):
        try:
            pv, cam, cam_ob = self._open(self.col)
            if self.stage == 0:
                self._top(pv, cam, cam_ob)
            else:
                self._persp(pv, cam, cam_ob)
            log("rendering %s" % os.path.basename(pv.render.filepath))
            bpy.ops.render.render("INVOKE_DEFAULT", write_still=True, scene=pv.name)
        except Exception:
            self._detach()
            raise
        return None

    def _on_post(self, *_a):
        self.stage += 1
        if self.stage >= 2:
            self._detach()
            self._close()
            self.finish(2)
            return
        bpy.app.timers.register(self._next, first_interval=0.4)

    def _on_cancel(self, *_a):
        self._detach()
        self.finish(self.stage, cancelled=True)

    def _detach(self):
        for h in (self._on_post,):
            if h in bpy.app.handlers.render_post:
                bpy.app.handlers.render_post.remove(h)
        if self._on_cancel in bpy.app.handlers.render_cancel:
            bpy.app.handlers.render_cancel.remove(self._on_cancel)

    # -- wrap-up --------------------------------------------------------------
    def finish(self, shots, cancelled=False):
        try:
            win = bpy.context.window
            if win:
                win.workspace = bpy.data.workspaces.get("Layout") or win.workspace
                for area in win.screen.areas:
                    if area.type == "VIEW_3D":
                        for sp in area.spaces:
                            if sp.type == "VIEW_3D":
                                sp.shading.type = "MATERIAL"
                                sp.region_3d.view_perspective = "PERSP"
            bpy.ops.wm.save_as_mainfile(filepath=BLEND)
            MB.write_json(DONE, {"ok": True, "shots": shots, "seconds": round(time.time() - self.t0, 1), "cancelled": cancelled})
            log("DONE in %.1fs" % (time.time() - self.t0))
        except Exception:
            with open(ERR, "w", encoding="utf-8") as f:
                f.write(traceback.format_exc())
            traceback.print_exc()
        finally:
            sys.stdout.flush()
            sys.stdout, sys.stderr = _ORIG


def _boot():
    os.makedirs(RENDERS, exist_ok=True)
    sys.stdout = _Tee(LOG)
    sys.stderr = sys.stdout
    try:
        TerrainBuild("--no-render" not in argv_after_dash()).run()
    except Exception:
        with open(ERR, "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
        traceback.print_exc()
        sys.stdout.flush()
        sys.stdout, sys.stderr = _ORIG


if bpy.app.background:
    _boot()
elif not bpy.app.timers.is_registered(_boot):
    bpy.app.timers.register(_boot, first_interval=1.5)
