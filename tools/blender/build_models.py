"""
Cubling Quest - procedural model builder for Blender (4.2+ / 5.x).

Builds every 3D asset used by the game (modular pet parts, the player
character, breakables, eggs, machines, gates and themed scenery) entirely
from code and exports them into ONE binary glTF file.

Run (headless, does not touch any open Blender session):
    blender --background --factory-startup --python tools/blender/build_models.py -- client/public/models/assets.glb [preview.png]
or simply:
    npm run models

Conventions (Blender space, Z-up, the "front" of a model faces -Y; glTF
export converts this to Y-up with the front facing +Z for three.js):
  * Every object's origin sits on the ground plane (z = 0) unless noted.
  * Pet parts are positioned around a unit body (x,y in [-0.5,0.5], z in [0,1])
    so the client can merge any combination into one mesh.
  * Materials whose name starts with "tint_" are recoloured at runtime by the
    client (per species, per theme, per player). Other materials keep their colour.
"""
import bpy
import bmesh
import math
import os
import random
import sys
from mathutils import Vector, Matrix, Euler

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0]) if argv else os.path.abspath("assets.glb")
PREVIEW = os.path.abspath(argv[1]) if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
rng = random.Random(1337)
PI = math.pi


# ---------------------------------------------------------------- materials
def hex_lin(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


_mats = {}


def M(name, color="#ffffff", rough=0.55, metal=0.0, emit=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None) or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    col = hex_lin(color)
    bsdf.inputs["Base Color"].default_value = (*col, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit > 0:
        bsdf.inputs["Emission Color"].default_value = (*col, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*col, 1.0)
    _mats[name] = m
    return m


# ---------------------------------------------------------------- primitives (pure bmesh, no operators)
def p_cube(sx=1, sy=1, sz=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    return bm


def p_rcube(sx, sy, sz, r=0.15, seg=3):
    bm = p_cube(sx, sy, sz)
    r = min(r, sx * 0.49, sy * 0.49, sz * 0.49)
    bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=r, offset_type="OFFSET",
                    segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    return bm


def p_sphere(r=0.5, u=20, v=12):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r)
    return bm


def p_ico(r=0.5, sub=1, jitter=0.0):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    if jitter:
        for vert in bm.verts:
            vert.co *= 1.0 + rng.uniform(-jitter, jitter)
    return bm


def p_cyl(r=0.5, d=1.0, seg=20, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r, radius2=r if r2 is None else r2, depth=d)
    return bm


def p_cone(r=0.5, d=1.0, seg=16):
    return p_cyl(r, d, seg, r2=0.0)


def p_torus(R=0.5, r=0.1, seg=24, rseg=10, arc=2 * PI):
    bm = bmesh.new()
    full = abs(arc - 2 * PI) < 1e-6
    n = seg if full else seg + 1
    rings = []
    for i in range(n):
        a = arc * i / seg
        ring = []
        for j in range(rseg):
            b = 2 * PI * j / rseg
            rad = R + r * math.cos(b)
            ring.append(bm.verts.new((rad * math.cos(a), rad * math.sin(a), r * math.sin(b))))
        rings.append(ring)
    for i in range(seg):
        r0, r1 = rings[i], rings[(i + 1) % n]
        for j in range(rseg):
            bm.faces.new((r0[j], r1[j], r1[(j + 1) % rseg], r0[(j + 1) % rseg]))
    if not full:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def p_egg(r=0.5, u=28, v=18):
    bm = p_sphere(r, u, v)
    for vert in bm.verts:
        t = (vert.co.z + r) / (2 * r)  # 0 bottom .. 1 top
        k = 1.0 - 0.24 * t * t
        vert.co.x *= k
        vert.co.y *= k
        vert.co.z = vert.co.z * 1.3 + r * 1.3
    return bm


def egg_surface(theta, phi, r=0.5):
    """Point + normal on the p_egg surface (approximate normal is fine for decals)."""
    x = r * math.sin(phi) * math.cos(theta)
    y = r * math.sin(phi) * math.sin(theta)
    z = r * math.cos(phi)
    t = (z + r) / (2 * r)
    k = 1.0 - 0.24 * t * t
    p = Vector((x * k, y * k, z * 1.3 + r * 1.3))
    n = Vector((x / k, y / k, z / 1.3)).normalized()
    return p, n


# ---------------------------------------------------------------- builder
class B:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def add(self, src, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), smooth=True):
        mtx = Matrix.LocRotScale(Vector(loc), Euler(rot).to_quaternion(), Vector(scale))
        bmesh.ops.transform(src, matrix=mtx, verts=src.verts)
        if mat not in self.mats:
            self.mats.append(mat)
        idx = self.mats.index(mat)
        for f in src.faces:
            f.material_index = idx
            f.smooth = smooth
        tmp = bpy.data.meshes.new("_tmp")
        src.to_mesh(tmp)
        src.free()
        self.bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        return self

    def mirror(self, factory, mat, loc, rot=(0, 0, 0), scale=(1, 1, 1), smooth=True, flip_rot_axes=(1, 2)):
        """Add a part twice, mirrored across X. Rotations around Y and Z are negated."""
        for s in (-1, 1):
            r = list(rot)
            if s < 0:
                for a in flip_rot_axes:
                    r[a] = -r[a]
            self.add(factory(), mat, (loc[0] * s, loc[1], loc[2]), tuple(r), scale, smooth)
        return self

    def obj(self, name, parent=None, loc=(0, 0, 0)):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        scene.collection.objects.link(ob)
        ob.location = loc
        if parent is not None:
            ob.parent = parent
        return ob


def empty(name, loc=(0, 0, 0), parent=None):
    ob = bpy.data.objects.new(name, None)
    scene.collection.objects.link(ob)
    ob.location = loc
    if parent is not None:
        ob.parent = parent
    return ob


# ---------------------------------------------------------------- shared materials
GOLD = M("gold", "#ffc93c", 0.28, 0.85)
GOLD_D = M("gold_dark", "#e09a1f", 0.35, 0.85)
WHITE = M("white", "#ffffff", 0.4)
DARK = M("dark", "#2a2438", 0.5)
EYE = M("eye", "#1b1430", 0.15)
SHINE = M("shine", "#ffffff", 0.2, 0.0, 1.5)
MOUTH = M("mouth", "#4a1f33", 0.6)
CHEEK = M("cheek", "#ff8fb1", 0.7)
STONE = M("stone", "#ece7f5", 0.8)
WOOD = M("wood", "#a7703f", 0.8)
WOOD_D = M("wood_dark", "#7a4b25", 0.85)
TRUNK = M("trunk", "#8a5a3c", 0.9)
METAL = M("metal", "#8b93a7", 0.35, 0.8)
CHROME = M("chrome", "#dfe4ec", 0.15, 0.95)
GLASS = M("glass", "#bfe9ff", 0.05, 0.0, 0.2)
SCREEN = M("screen", "#1a2238", 0.3, 0.0, 0.3)
SKIN = M("skin", "#ffd9b8", 0.7)
SHOE = M("shoe", "#3b3b4f", 0.6)
CREAM = M("cream", "#f5ead6", 0.8)
WATER = M("water", "#5fd0ff", 0.1, 0.0, 0.15)

T_BODY = M("tint_body", "#ffffff", 0.55)
T_SEC = M("tint_secondary", "#ffe8d0", 0.6)
T_EAR = M("tint_ear", "#ffffff", 0.55)
T_TAIL = M("tint_tail", "#ffffff", 0.55)
T_ACC = M("tint_accent", "#ffd34d", 0.4)
T_WING = M("tint_wing", "#ffffff", 0.5)

# ================================================================ PET PARTS
B().add(p_rcube(1, 1, 1, r=0.3, seg=4), T_BODY, (0, 0, 0.5)).obj("pet_body")
B().add(p_sphere(0.5, 20, 12), T_SEC, (0, -0.47, 0.33), scale=(0.62, 0.12, 0.44)).obj("pet_belly")
(B().mirror(lambda: p_sphere(0.1, 16, 10), EYE, (0.2, -0.49, 0.6), scale=(0.85, 0.45, 1.2))
    .obj("pet_eyes"))
(B().mirror(lambda: p_sphere(0.034, 10, 6), SHINE, (0.17, -0.535, 0.665))
    .mirror(lambda: p_sphere(0.018, 8, 6), SHINE, (0.23, -0.53, 0.55))
    .obj("pet_shine"))
B().add(p_torus(0.06, 0.017, 16, 6, PI), MOUTH, (0, -0.515, 0.45), rot=(-PI / 2, 0, 0)).obj("pet_mouth")
B().mirror(lambda: p_sphere(0.07, 12, 8), CHEEK, (0.33, -0.49, 0.47), scale=(1, 0.3, 0.7)).obj("pet_cheeks")

# ears / head tops
B().mirror(lambda: p_cone(0.17, 0.34, 12), T_EAR, (0.27, 0, 1.08), rot=(0, 0.32, 0), scale=(1, 0.6, 1)).obj("pet_ears_cat")
B().mirror(lambda: p_sphere(0.5, 14, 10), T_EAR, (0.17, 0.05, 1.27), rot=(0, 0.15, 0), scale=(0.22, 0.13, 0.66)).obj("pet_ears_bunny")
B().mirror(lambda: p_sphere(0.14, 14, 10), T_EAR, (0.33, 0, 0.97), scale=(1, 0.55, 1)).obj("pet_ears_bear")
B().mirror(lambda: p_sphere(0.5, 14, 10), T_EAR, (0.53, 0.02, 0.72), rot=(0, -0.25, 0), scale=(0.16, 0.34, 0.54)).obj("pet_ears_floppy")
B().mirror(lambda: p_sphere(0.2, 16, 10), T_EAR, (0.36, 0, 1.0), scale=(1, 0.35, 1)).obj("pet_ears_mouse")
B().mirror(lambda: p_cone(0.085, 0.32, 10), T_ACC, (0.22, 0, 1.13), rot=(0, 0.3, 0)).obj("pet_horns")
(B().mirror(lambda: p_cyl(0.022, 0.32, 8), DARK, (0.15, 0, 1.15), rot=(0, 0.25, 0))
    .mirror(lambda: p_sphere(0.065, 12, 8), T_ACC, (0.19, 0, 1.31))
    .obj("pet_antenna"))
B().add(p_cone(0.28, 0.4, 14), T_EAR, (0, 0.08, 1.12), rot=(0.3, 0, 0), scale=(0.22, 1, 1)).obj("pet_fin_top")
(B().add(p_sphere(0.5, 12, 8), T_EAR, (0.1, 0, 1.17), rot=(0, -0.5, 0), scale=(0.34, 0.08, 0.16))
    .add(p_cyl(0.025, 0.14, 6), T_EAR, (0.0, 0, 1.06))
    .obj("pet_leaf"))
B().add(p_cone(0.07, 0.34, 12), T_ACC, (0, -0.22, 1.12), rot=(0.3, 0, 0)).obj("pet_horn_uni")
(B().add(p_cyl(0.21, 0.12, 20), GOLD, (0, 0, 1.06))
    .add(p_cone(0.05, 0.14, 8), GOLD, (0.15, 0, 1.18)).add(p_cone(0.05, 0.14, 8), GOLD, (-0.15, 0, 1.18))
    .add(p_cone(0.05, 0.14, 8), GOLD, (0, 0.15, 1.18)).add(p_cone(0.05, 0.14, 8), GOLD, (0, -0.15, 1.18))
    .add(p_sphere(0.04, 8, 6), M("ruby", "#ff3b6b", 0.2, 0.2, 0.4), (0, -0.21, 1.06))
    .obj("pet_crown"))
B().add(p_torus(0.22, 0.035, 24, 8), M("halo", "#fff4a8", 0.3, 0.0, 1.2), (0, 0, 1.36)).obj("pet_halo")
(B().add(p_sphere(0.5, 14, 10), T_SEC, (0, -0.53, 0.4), scale=(0.34, 0.16, 0.22))
    .mirror(lambda: p_sphere(0.022, 8, 6), MOUTH, (0.05, -0.61, 0.42))
    .obj("pet_snout"))
B().add(p_rcube(0.72, 0.08, 0.2, r=0.04), M("tint_visor", "#56f0ff", 0.2, 0.2, 0.9), (0, -0.52, 0.62)).obj("pet_visor")
(B().add(p_sphere(0.5, 16, 10), T_SEC, (0, 0.12, 0.78), scale=(1.0, 0.9, 0.62))
    .obj("pet_shell"))
spots = B()
for (x, y, z, s) in [(0.22, -0.1, 1.0, 0.13), (-0.25, 0.18, 1.0, 0.1), (0.5, 0.15, 0.55, 0.11), (-0.5, -0.1, 0.4, 0.09), (0.0, 0.5, 0.65, 0.12)]:
    n = Vector((x * 1.0, y * 1.0, (z - 0.5))).normalized()
    spots.add(p_sphere(s, 12, 8), T_SEC, (x, y, z), rot=n.to_track_quat("Z", "Y").to_euler(), scale=(1, 1, 0.3))
spots.obj("pet_spots")

# tails
B().add(p_torus(0.17, 0.042, 20, 8, 1.5 * PI), T_TAIL, (0, 0.62, 0.48), rot=(0, PI / 2, 0)).obj("pet_tail_thin")
B().add(p_sphere(0.5, 16, 10), T_TAIL, (0, 0.68, 0.52), rot=(0.7, 0, 0), scale=(0.3, 0.64, 0.3)).obj("pet_tail_fluffy")
B().add(p_sphere(0.14, 14, 10), T_TAIL, (0, 0.55, 0.3)).obj("pet_tail_puff")
B().add(p_cone(0.24, 0.32, 14), T_TAIL, (0, 0.68, 0.45), rot=(PI / 2, 0, 0), scale=(0.22, 1, 1)).obj("pet_tail_fin")
B().add(p_cone(0.12, 0.48, 10), T_TAIL, (0, 0.72, 0.32), rot=(-PI / 2 + 0.35, 0, 0)).obj("pet_tail_spike")
B().add(p_torus(0.11, 0.045, 18, 8), T_TAIL, (0, 0.58, 0.38), rot=(0, PI / 2, 0)).obj("pet_tail_curly")

# wings
B().mirror(lambda: p_sphere(0.5, 16, 10), T_WING, (0.58, 0.18, 0.72), rot=(0, -0.35, 0.5), scale=(0.78, 0.12, 0.44)).obj("pet_wings")

# ================================================================ CHARACTER
char = empty("char")
T_SHIRT = M("tint_shirt", "#4da3ff", 0.6)
T_PANTS = M("tint_pants", "#394a7a", 0.7)
T_HAIR = M("tint_hair", "#5a3825", 0.8)
B().add(p_rcube(0.78, 0.48, 0.78, r=0.16), T_SHIRT, (0, 0, 1.06)).obj("char_torso", char)
head = (B().add(p_rcube(0.96, 0.9, 0.86, r=0.3, seg=4), SKIN, (0, 0, 0.42))
        .add(p_rcube(1.0, 0.95, 0.34, r=0.15), T_HAIR, (0, 0.03, 0.78))
        .add(p_rcube(1.0, 0.35, 0.5, r=0.12), T_HAIR, (0, 0.33, 0.55))
        .mirror(lambda: p_sphere(0.085, 14, 10), EYE, (0.2, -0.45, 0.45), scale=(0.9, 0.45, 1.2))
        .mirror(lambda: p_sphere(0.03, 8, 6), SHINE, (0.17, -0.49, 0.5))
        .mirror(lambda: p_sphere(0.07, 10, 8), CHEEK, (0.33, -0.44, 0.3), scale=(1, 0.3, 0.7))
        .add(p_torus(0.06, 0.016, 14, 6, PI), MOUTH, (0, -0.46, 0.27), rot=(-PI / 2, 0, 0)))
head.obj("char_head", char, (0, 0, 1.45))
for side, nm in ((-1, "char_arm_l"), (1, "char_arm_r")):
    (B().add(p_rcube(0.24, 0.26, 0.34, r=0.08), T_SHIRT, (0, 0, -0.12))
        .add(p_rcube(0.2, 0.22, 0.34, r=0.09), SKIN, (0, 0, -0.38))
        .add(p_sphere(0.12, 12, 8), SKIN, (0, 0, -0.58))
        .obj(nm, char, (side * 0.51, 0, 1.36)))
for side, nm in ((-1, "char_leg_l"), (1, "char_leg_r")):
    (B().add(p_rcube(0.3, 0.32, 0.56, r=0.1), T_PANTS, (0, 0, -0.28))
        .add(p_rcube(0.32, 0.44, 0.16, r=0.07), SHOE, (0, -0.05, -0.62))
        .obj(nm, char, (side * 0.2, 0, 0.7)))

# ================================================================ BREAKABLES & PICKUPS
coin = (B().add(p_cyl(0.3, 0.08, 24), GOLD, (0, 0, 0), rot=(PI / 2, 0, 0))
        .add(p_cyl(0.2, 0.1, 20), GOLD_D, (0, 0, 0), rot=(PI / 2, 0, 0)))
coin.obj("coin")

pile = B()
pile.add(p_cyl(0.85, 0.12, 24), GOLD_D, (0, 0, 0.06))
layers = [(8, 0.55, 0.16), (6, 0.36, 0.26), (4, 0.18, 0.36), (1, 0.0, 0.46)]
for count, rad, z in layers:
    for i in range(count):
        a = 2 * PI * i / count + rng.uniform(-0.2, 0.2)
        pile.add(p_cyl(0.26, 0.07, 20), GOLD, (math.cos(a) * rad, math.sin(a) * rad, z),
                 rot=(rng.uniform(-0.25, 0.25), rng.uniform(-0.25, 0.25), 0))
pile.add(p_cyl(0.26, 0.07, 20), GOLD, (0.05, 0, 0.72), rot=(PI / 2 - 0.2, 0, 0.4))
pile.add(p_cyl(0.18, 0.08, 18), GOLD_D, (0.05, -0.04, 0.72), rot=(PI / 2 - 0.2, 0, 0.4))
pile.obj("coin_pile")

T_WOOD = M("tint_wood", "#c8894a", 0.8)
crate = B().add(p_rcube(1.4, 1.4, 1.4, r=0.04), T_WOOD, (0, 0, 0.7))
for x in (-0.62, 0.62):
    for y in (-0.62, 0.62):
        crate.add(p_cube(0.2, 0.2, 1.44), WOOD_D, (x, y, 0.7))
for z in (0.08, 1.32):
    for y in (-0.62, 0.62):
        crate.add(p_cube(1.44, 0.2, 0.2), WOOD_D, (0, y, z))
    for x in (-0.62, 0.62):
        crate.add(p_cube(0.2, 1.44, 0.2), WOOD_D, (x, 0, z))
for rz in (0, PI / 2, PI, 3 * PI / 2):
    m = Matrix.Rotation(rz, 4, "Z")
    p = m @ Vector((0, -0.715, 0.7))
    crate.add(p_cube(1.5, 0.06, 0.18), WOOD_D, tuple(p), rot=(0, PI / 4, rz))
crate.obj("crate", None)

T_SAFE = M("tint_safe", "#6d7a8c", 0.35, 0.65)
safe = (B().add(p_rcube(1.5, 1.4, 1.6, r=0.12), T_SAFE, (0, 0, 0.9))
        .add(p_rcube(1.2, 0.06, 1.25, r=0.05), M("safe_door", "#525c6b", 0.4, 0.6), (0, -0.7, 0.92))
        .add(p_cyl(0.22, 0.1, 24), CHROME, (0.22, -0.76, 1.0), rot=(PI / 2, 0, 0))
        .add(p_cyl(0.08, 0.14, 12), DARK, (0.22, -0.8, 1.0), rot=(PI / 2, 0, 0))
        .add(p_rcube(0.09, 0.09, 0.45, r=0.03), CHROME, (-0.32, -0.78, 0.92))
        .mirror(lambda: p_sphere(0.05, 8, 6), CHROME, (0.5, -0.74, 1.45))
        .mirror(lambda: p_sphere(0.05, 8, 6), CHROME, (0.5, -0.74, 0.38)))
for x in (-0.6, 0.6):
    for y in (-0.55, 0.55):
        safe.add(p_rcube(0.22, 0.22, 0.12, r=0.04), DARK, (x, y, 0.06))
safe.obj("safe")

T_CHEST = M("tint_chest", "#a0522d", 0.75)
chest = (B().add(p_rcube(1.8, 1.2, 0.9, r=0.06), T_CHEST, (0, 0, 0.45))
         .add(p_cyl(0.6, 1.8, 24), T_CHEST, (0, 0, 0.9), rot=(0, PI / 2, 0))
         .add(p_rcube(1.86, 1.26, 0.12, r=0.03), GOLD, (0, 0, 0.88))
         .add(p_rcube(0.32, 0.14, 0.38, r=0.05), GOLD, (0, -0.64, 0.86))
         .add(p_sphere(0.05, 8, 6), DARK, (0, -0.72, 0.84)))
for x in (-0.62, 0.62):
    chest.add(p_cube(0.14, 1.25, 0.92), GOLD, (x, 0, 0.45))
    chest.add(p_torus(0.6, 0.05, 20, 6, PI), GOLD, (x, 0, 0.9), rot=(PI / 2, 0, PI / 2))
chest.obj("chest")

T_BOX = M("tint_box", "#ff6fae", 0.55)
T_RIB = M("tint_ribbon", "#fff06a", 0.4)
(B().add(p_rcube(1.3, 1.3, 1.1, r=0.08), T_BOX, (0, 0, 0.55))
    .add(p_cube(1.34, 0.26, 1.14), T_RIB, (0, 0, 0.55))
    .add(p_cube(0.26, 1.34, 1.14), T_RIB, (0, 0, 0.55))
    .mirror(lambda: p_torus(0.2, 0.07, 16, 8), T_RIB, (0.2, 0, 1.25), rot=(PI / 2, 0.5, 0))
    .add(p_sphere(0.1, 10, 8), T_RIB, (0, 0, 1.15))
    .obj("present"))

T_GEM = M("tint_gem", "#43e0ff", 0.08, 0.1, 0.35)
(B().add(p_cyl(0.4, 0.22, 8, r2=0.24), T_GEM, (0, 0, 0.11), smooth=False)
    .add(p_cone(0.4, 0.5, 8), T_GEM, (0, 0, -0.25), rot=(PI, 0, 0), smooth=False)
    .obj("gem"))

T_COMET = M("tint_comet", "#7c5cff", 0.3, 0.1, 0.5)
comet = B().add(p_ico(0.9, 1, 0.14), M("comet_rock", "#4a3f6b", 0.9), (0, 0, 0.75), scale=(1, 1, 0.8), smooth=False)
for i in range(7):
    a = 2 * PI * i / 7
    comet.add(p_cone(0.18, 0.9, 6), T_COMET, (math.cos(a) * 0.55, math.sin(a) * 0.55, 1.0),
              rot=(math.sin(a) * 0.6, -math.cos(a) * -0.6, 0), smooth=False)
comet.add(p_cone(0.25, 1.3, 6), T_COMET, (0, 0, 1.5), smooth=False)
comet.obj("comet")

# ================================================================ EGG + STAND
T_EGG = M("tint_egg", "#ffffff", 0.35)
T_SPOT = M("tint_spot", "#7fd3ff", 0.4)
egg = B().add(p_egg(0.5), T_EGG)
for (th, ph, s) in [(0.3, 1.2, 0.11), (1.6, 0.8, 0.09), (2.7, 1.5, 0.12), (3.9, 1.0, 0.1), (5.0, 1.7, 0.1), (4.4, 2.2, 0.08), (1.0, 2.0, 0.09), (2.2, 2.4, 0.07)]:
    p, n = egg_surface(th, ph)
    egg.add(p_sphere(s, 12, 8), T_SPOT, tuple(p), rot=n.to_track_quat("Z", "Y").to_euler(), scale=(1, 1, 0.3))
egg.obj("egg")

T_TRIM = M("tint_trim", "#ff9dd8", 0.5)
(B().add(p_cyl(2.0, 0.4, 32), STONE, (0, 0, 0.2))
    .add(p_torus(2.0, 0.12, 32, 8), T_TRIM, (0, 0, 0.4))
    .add(p_cyl(0.95, 0.6, 24), T_TRIM, (0, 0, 0.7))
    .add(p_torus(0.95, 0.08, 24, 6), GOLD, (0, 0, 1.0))
    .mirror(lambda: p_cyl(0.12, 3.6, 10), WOOD, (1.7, 0.9, 2.0))
    .add(p_rcube(3.9, 0.22, 1.1, r=0.1), T_TRIM, (0, 0.9, 3.75))
    .add(p_rcube(3.6, 0.1, 0.85, r=0.06), WHITE, (0, 0.78, 3.75))
    .obj("egg_stand"))

# ================================================================ GATE
T_GATE = M("tint_gate", "#ffffff", 0.6)
(B().mirror(lambda: p_rcube(2.0, 2.0, 9.0, r=0.25), T_GATE, (6.0, 0, 4.5))
    .add(p_rcube(14.0, 2.2, 1.8, r=0.3), T_GATE, (0, 0, 9.4))
    .mirror(lambda: p_sphere(0.6, 16, 10), GOLD, (6.0, 0, 10.6))
    .add(p_rcube(4.5, 0.3, 1.2, r=0.15), GOLD, (0, -1.1, 9.4))
    .mirror(lambda: p_rcube(2.4, 2.4, 0.6, r=0.1), STONE, (6.0, 0, 0.3))
    .obj("gate_arch"))
bars = B()
for i in range(7):
    x = -4.2 + i * 1.4
    bars.add(p_cyl(0.15, 8.4, 10), METAL, (x, 0, 4.2))
    bars.add(p_cone(0.25, 0.5, 10), METAL, (x, 0, 8.55))
for z in (2.0, 6.0):
    bars.add(p_cyl(0.13, 10.0, 10), METAL, (0, 0, z), rot=(0, PI / 2, 0))
bars.add(p_rcube(1.1, 0.5, 1.2, r=0.15), GOLD, (0, -0.35, 4.0))
bars.add(p_torus(0.32, 0.08, 16, 6, PI), METAL, (0, -0.35, 4.6), rot=(PI / 2, 0, 0))
bars.add(p_cyl(0.1, 0.1, 10), DARK, (0, -0.62, 3.9), rot=(PI / 2, 0, 0))
bars.obj("gate_bars")

# ================================================================ STATIONS
T_MACH = M("tint_machine", "#ffd34d", 0.45, 0.2)
T_LIGHT = M("tint_light", "#ffef9a", 0.3, 0.0, 1.5)
mach = (B().add(p_rcube(3.4, 2.8, 1.2, r=0.2), T_MACH, (0, 0, 0.6))
        .add(p_rcube(2.8, 2.3, 2.2, r=0.3), M("machine_white", "#f4f3fa", 0.5), (0, 0, 2.2))
        .add(p_sphere(1.1, 24, 14), GLASS, (0, 0, 3.5), scale=(1, 1, 0.82))
        .add(p_cyl(0.95, 0.75, 24, r2=0.38), T_MACH, (0, 0, 4.55))
        .add(p_rcube(1.7, 0.1, 0.95, r=0.05), SCREEN, (0, -1.16, 2.4))
        .add(p_rcube(1.2, 0.7, 0.55, r=0.1), T_MACH, (0, -1.35, 0.95)))
for i in range(5):
    mach.add(p_sphere(0.1, 8, 6), T_LIGHT, (-0.8 + i * 0.4, -1.17, 3.05))
mach.obj("machine")

T_PORTAL = M("tint_portal", "#b77bff", 0.3, 0.1, 0.8)
(B().add(p_cyl(2.8, 0.4, 32), STONE, (0, 0, 0.2))
    .add(p_cyl(2.1, 0.4, 32), STONE, (0, 0, 0.6))
    .add(p_torus(1.9, 0.3, 40, 12), T_PORTAL, (0, 0, 3.1), rot=(PI / 2, 0, 0))
    .mirror(lambda: p_rcube(0.6, 0.6, 3.2, r=0.15), STONE, (2.1, 0, 2.2))
    .mirror(lambda: p_sphere(0.35, 14, 10), T_LIGHT, (2.1, 0, 4.0))
    .obj("portal"))
B().add(p_cyl(1.65, 0.06, 40), M("portal_inner", "#e9d4ff", 0.2, 0.0, 1.4), (0, 0, 3.1), rot=(PI / 2, 0, 0)).obj("portal_inner")

T_AWN = M("tint_awning", "#ff5d73", 0.6)
booth = (B().add(p_rcube(4.2, 1.4, 1.2, r=0.12), WOOD, (0, 0, 0.6))
         .add(p_rcube(4.4, 1.6, 0.14, r=0.05), WOOD_D, (0, 0, 1.25)))
for x in (-2.0, 2.0):
    for y in (-0.6, 0.6):
        booth.add(p_cyl(0.1, 3.2, 8), WOOD_D, (x, y, 1.6))
for i in range(6):
    x = -2.1 + 0.84 * i + 0.42
    booth.add(p_cube(0.84, 2.3, 0.16), T_AWN if i % 2 == 0 else WHITE, (x, 0, 3.25), rot=(0.18, 0, 0), smooth=False)
booth.obj("booth")

board = (B().mirror(lambda: p_cyl(0.13, 3.4, 8), WOOD_D, (1.5, 0, 1.7))
         .add(p_rcube(3.4, 0.22, 2.0, r=0.1), WOOD, (0, 0, 2.5)))
for (x, z, c) in [(-1.0, 2.9, "#fff7a8"), (0.1, 2.75, "#a8f0ff"), (1.05, 2.95, "#ffc2e2"), (-0.55, 2.0, "#c8ffb0"), (0.7, 2.05, "#ffffff")]:
    board.add(p_cube(0.75, 0.05, 0.6), M("note_" + c[1:], c, 0.9), (x, -0.13, z), rot=(0, rng.uniform(-0.15, 0.15), 0), smooth=False)
board.obj("board")

(B().add(p_cyl(0.5, 0.2, 16), WOOD_D, (0, 0, 0.1))
    .add(p_cyl(0.16, 1.2, 10), WOOD_D, (0, 0, 0.75))
    .add(p_rcube(1.1, 0.8, 0.12, r=0.04), WOOD, (0, 0, 1.38), rot=(-0.4, 0, 0))
    .add(p_rcube(0.5, 0.7, 0.1, r=0.03), M("tint_book", "#5b7cff", 0.6), (-0.27, 0, 1.47), rot=(-0.4, -0.12, 0))
    .add(p_rcube(0.5, 0.7, 0.1, r=0.03), M("tint_book", "#5b7cff", 0.6), (0.27, 0, 1.47), rot=(-0.4, 0.12, 0))
    .add(p_rcube(0.92, 0.62, 0.04, r=0.02), CREAM, (0, -0.02, 1.53), rot=(-0.4, 0, 0))
    .obj("lectern"))

T_PAD = M("tint_pad", "#5ef2c2", 0.3, 0.0, 0.6)
(B().add(p_cyl(1.7, 0.3, 32), STONE, (0, 0, 0.15))
    .add(p_cyl(1.35, 0.06, 32), T_PAD, (0, 0, 0.32))
    .add(p_torus(1.6, 0.08, 32, 6), T_PAD, (0, 0, 0.32))
    .obj("pad"))

(B().add(p_cyl(3.2, 0.7, 40), STONE, (0, 0, 0.35))
    .add(p_cyl(2.85, 0.2, 40), WATER, (0, 0, 0.62))
    .add(p_cyl(0.45, 2.0, 16), STONE, (0, 0, 1.3))
    .add(p_cyl(1.3, 0.35, 24, r2=0.6), STONE, (0, 0, 2.35))
    .add(p_cyl(1.1, 0.1, 24), WATER, (0, 0, 2.5))
    .add(p_sphere(0.35, 14, 10), GOLD, (0, 0, 2.9))
    .obj("fountain"))

# ================================================================ SCENERY
T_LEAF = M("tint_leaf", "#6fd96a", 0.75)
T_ROCK = M("tint_rock", "#a5a9b8", 0.9)
T_PET = M("tint_petal", "#ff8ad0", 0.6)
T_CAP = M("tint_cap", "#ff5a5a", 0.6)
T_CRY = M("tint_crystal", "#9b8cff", 0.08, 0.1, 0.45)
T_CANDY = M("tint_candy", "#ff4f7b", 0.4)
T_CORAL = M("tint_coral", "#ff7f6e", 0.7)
T_BLD = M("tint_building", "#3a4a7a", 0.4, 0.3)
T_PUMP = M("tint_pumpkin", "#ff9a2e", 0.6)
T_METAL = M("tint_metal", "#c79a52", 0.3, 0.8)
T_BLOCK = M("tint_block", "#4fa3ff", 0.45)
T_FENCE = M("tint_fence", "#f2e6d0", 0.8)
T_PLANET = M("tint_planet", "#ff9f6b", 0.7)
T_RING = M("tint_ring", "#ffe6a8", 0.5)

(B().add(p_cyl(0.35, 2.2, 10, r2=0.25), TRUNK, (0, 0, 1.1))
    .add(p_ico(1.45, 2), T_LEAF, (0, 0, 3.0))
    .add(p_ico(1.0, 2), T_LEAF, (0.85, 0.3, 2.55))
    .add(p_ico(0.95, 2), T_LEAF, (-0.75, -0.4, 2.65))
    .obj("tree_round"))
(B().add(p_cyl(0.3, 1.6, 8, r2=0.22), TRUNK, (0, 0, 0.8))
    .add(p_cone(1.7, 2.1, 12), T_LEAF, (0, 0, 2.2), smooth=False)
    .add(p_cone(1.3, 1.8, 12), T_LEAF, (0, 0, 3.25), smooth=False)
    .add(p_cone(0.9, 1.5, 12), T_LEAF, (0, 0, 4.2), smooth=False)
    .obj("tree_pine"))
palm = B()
px, pz = 0.0, 0.0
for i in range(6):
    palm.add(p_cyl(0.28 - i * 0.02, 0.85, 10), TRUNK, (px, 0, pz + 0.42), rot=(0, 0.06 * i, 0))
    px += 0.06 * i
    pz += 0.8
for i in range(7):
    a = 2 * PI * i / 7
    palm.add(p_sphere(0.5, 14, 8), T_LEAF, (px + math.cos(a) * 1.0, math.sin(a) * 1.0, pz - 0.15),
             rot=(0, 0.35, a), scale=(2.4, 0.7, 0.18))
palm.add(p_sphere(0.18, 10, 8), WOOD_D, (px + 0.2, 0.15, pz - 0.35))
palm.add(p_sphere(0.18, 10, 8), WOOD_D, (px - 0.15, -0.2, pz - 0.35))
palm.obj("tree_palm")
(B().add(p_ico(0.75, 2), T_LEAF, (0, 0, 0.55)).add(p_ico(0.6, 2), T_LEAF, (0.65, 0.2, 0.45))
    .add(p_ico(0.55, 2), T_LEAF, (-0.6, -0.15, 0.42)).obj("bush"))
B().add(p_ico(0.9, 1, 0.16), T_ROCK, (0, 0, 0.45), scale=(1.15, 1, 0.75), smooth=False).obj("rock")
flower = B().add(p_cyl(0.04, 0.6, 6), M("stem", "#4caf50", 0.8), (0, 0, 0.3))
for i in range(5):
    a = 2 * PI * i / 5
    flower.add(p_sphere(0.5, 10, 6), T_PET, (math.cos(a) * 0.14, math.sin(a) * 0.14, 0.64), rot=(0, 0, a), scale=(0.3, 0.18, 0.08))
flower.add(p_sphere(0.075, 10, 8), M("pollen", "#ffd64a", 0.6), (0, 0, 0.66))
flower.obj("flower")
mush = (B().add(p_cyl(0.25, 1.0, 12, r2=0.2), CREAM, (0, 0, 0.5))
        .add(p_sphere(0.85, 20, 12), T_CAP, (0, 0, 1.0), scale=(1, 1, 0.55)))
for i in range(6):
    a = 2 * PI * i / 6 + 0.3
    n = Vector((math.cos(a) * 0.6, math.sin(a) * 0.6, 0.6)).normalized()
    mush.add(p_sphere(0.13, 10, 6), WHITE, (math.cos(a) * 0.5, math.sin(a) * 0.5, 1.33), rot=n.to_track_quat("Z", "Y").to_euler(), scale=(1, 1, 0.3))
mush.add(p_sphere(0.15, 10, 6), WHITE, (0, 0, 1.47), scale=(1, 1, 0.3))
mush.obj("mushroom")
cry = B()
for (x, y, h, tx, ty) in [(0, 0, 1.9, 0, 0), (0.45, 0.1, 1.2, 0.0, 0.4), (-0.4, 0.2, 1.4, 0.0, -0.4), (0.1, -0.4, 1.0, 0.4, 0.1)]:
    cry.add(p_cyl(0.3, h * 0.7, 6), T_CRY, (x, y, h * 0.35), rot=(tx, ty, 0), smooth=False)
    top = Matrix.Rotation(tx, 4, "X") @ Matrix.Rotation(ty, 4, "Y") @ Vector((0, 0, h * 0.7 + h * 0.15))
    cry.add(p_cone(0.3, h * 0.3, 6), T_CRY, (x + top.x * 0.5, y + top.y * 0.5, top.z * 0.98 - h * 0.0), rot=(tx, ty, 0), smooth=False)
cry.obj("crystal")
(B().add(p_cyl(0.35, 2.0, 14), T_LEAF, (0, 0, 1.0))
    .add(p_sphere(0.35, 14, 8), T_LEAF, (0, 0, 2.0))
    .add(p_cyl(0.2, 0.6, 10), T_LEAF, (0.55, 0, 1.1), rot=(0, PI / 2, 0))
    .add(p_cyl(0.2, 0.7, 10), T_LEAF, (0.8, 0, 1.45))
    .add(p_sphere(0.2, 10, 6), T_LEAF, (0.8, 0, 1.8))
    .add(p_cyl(0.18, 0.5, 10), T_LEAF, (-0.5, 0, 0.8), rot=(0, PI / 2, 0))
    .add(p_cyl(0.18, 0.6, 10), T_LEAF, (-0.72, 0, 1.1))
    .add(p_sphere(0.18, 10, 6), T_LEAF, (-0.72, 0, 1.4))
    .obj("cactus"))
cane = (B().add(p_cyl(0.16, 2.4, 14), WHITE, (0, 0, 1.2))
        .add(p_torus(0.4, 0.16, 18, 10, PI), WHITE, (0.4, 0, 2.4), rot=(PI / 2, 0, 0)))
for z in (0.3, 0.75, 1.2, 1.65, 2.1):
    cane.add(p_torus(0.16, 0.06, 14, 6), T_CANDY, (0, 0, z), rot=(0.4, 0, 0))
cane.obj("candy_cane")
(B().add(p_cyl(0.06, 2.1, 8), WHITE, (0, 0, 1.05))
    .add(p_cyl(0.75, 0.22, 28), T_CANDY, (0, 0, 2.5), rot=(PI / 2, 0, 0))
    .add(p_torus(0.45, 0.07, 24, 6), WHITE, (0, -0.12, 2.5), rot=(PI / 2, 0, 0))
    .add(p_torus(0.2, 0.06, 18, 6), WHITE, (0, -0.12, 2.5), rot=(PI / 2, 0, 0))
    .obj("lollipop"))
coral = B().add(p_cyl(0.18, 1.2, 10, r2=0.12), T_CORAL, (0, 0, 0.6))
for i in range(5):
    a = 2 * PI * i / 5
    d = Vector((math.cos(a), math.sin(a), 1.4)).normalized()
    base = Vector((0, 0, 0.7 + 0.1 * i))
    tip = base + d * 0.8
    coral.add(p_cyl(0.1, 0.8, 8, r2=0.07), T_CORAL, tuple((base + tip) / 2), rot=d.to_track_quat("Z", "Y").to_euler())
    coral.add(p_sphere(0.12, 10, 6), T_CORAL, tuple(tip))
coral.add(p_sphere(0.15, 10, 6), T_CORAL, (0, 0, 1.25))
coral.obj("coral")
cloud = B()
for (x, y, z, r) in [(0, 0, 0, 1.2), (1.1, 0.2, -0.2, 0.9), (-1.1, -0.1, -0.15, 0.95), (0.4, -0.5, 0.35, 0.8), (-0.4, 0.5, 0.3, 0.75)]:
    cloud.add(p_ico(r, 2), M("cloud", "#ffffff", 0.9, 0.0, 0.15), (x, y, z), scale=(1, 1, 0.7))
cloud.obj("cloud")
(B().add(p_rcube(1.0, 0.3, 1.3, r=0.2, seg=4), M("grave", "#8d8f99", 0.9), (0, 0, 0.75))
    .add(p_rcube(1.3, 0.6, 0.2, r=0.05), M("grave", "#8d8f99", 0.9), (0, 0, 0.1))
    .add(p_cube(0.12, 0.05, 0.5), DARK, (0, -0.16, 0.95))
    .add(p_cube(0.36, 0.05, 0.12), DARK, (0, -0.16, 1.05))
    .obj("tombstone"))
(B().add(p_cyl(0.09, 3.0, 10), DARK, (0, 0, 1.5))
    .add(p_cyl(0.3, 0.2, 12), DARK, (0, 0, 0.1))
    .add(p_sphere(0.3, 16, 10), T_LIGHT, (0, 0, 3.15))
    .add(p_cone(0.38, 0.3, 12), DARK, (0, 0, 3.55))
    .obj("lamp"))
bld = B().add(p_rcube(4.0, 4.0, 10.0, r=0.25), T_BLD, (0, 0, 5.0))
for z in range(1, 10):
    for rz in (0, PI / 2, PI, 3 * PI / 2):
        p = Matrix.Rotation(rz, 4, "Z") @ Vector((0, -2.02, z * 1.0 + 0.3))
        bld.add(p_cube(3.0, 0.06, 0.35), T_LIGHT, tuple(p), rot=(0, 0, rz), smooth=False)
bld.add(p_cyl(0.08, 2.0, 6), METAL, (0.8, 0.8, 11.0)).add(p_sphere(0.15, 8, 6), M("beacon", "#ff3355", 0.3, 0.0, 2.0), (0.8, 0.8, 12.0))
bld.obj("building")
(B().add(p_sphere(0.75, 18, 12), WHITE, (0, 0, 0.7)).add(p_sphere(0.55, 16, 10), WHITE, (0, 0, 1.75))
    .add(p_sphere(0.4, 14, 10), WHITE, (0, 0, 2.5))
    .add(p_cone(0.08, 0.4, 8), M("carrot", "#ff8c2a", 0.6), (0, -0.55, 2.5), rot=(PI / 2, 0, 0))
    .mirror(lambda: p_sphere(0.05, 8, 6), EYE, (0.14, -0.35, 2.62))
    .add(p_torus(0.42, 0.1, 18, 8), T_LIGHT, (0, 0, 2.15))
    .obj("snowman"))
pump = B()
for i in range(7):
    a = 2 * PI * i / 7
    pump.add(p_sphere(0.42, 14, 10), T_PUMP, (math.cos(a) * 0.28, math.sin(a) * 0.28, 0.42), scale=(1, 1, 0.95))
pump.add(p_cyl(0.07, 0.35, 8), M("stem", "#4caf50", 0.8), (0, 0, 0.9), rot=(0.2, 0, 0))
pump.obj("pumpkin")
gear = B().add(p_torus(0.75, 0.2, 28, 8), T_METAL, (0, 0, 0))
for i in range(10):
    a = 2 * PI * i / 10
    gear.add(p_cube(0.28, 0.3, 0.32), T_METAL, (math.cos(a) * 1.0, math.sin(a) * 1.0, 0), rot=(0, 0, a), smooth=False)
gear.add(p_cyl(0.25, 0.4, 14), T_METAL, (0, 0, 0))
gb = B().add(p_rcube(0.5, 0.5, 1.2, r=0.08), DARK, (0, 0.0, 0.6))
gear_tmp = gear  # gear stands upright on a post
gear_obj = gear.obj("gear_part")
gear_obj.location = (0, 0, 1.9)
gear_obj.rotation_euler = (PI / 2, 0, 0)
gpost = gb.obj("gear")
gear_obj.parent = gpost
block = B().add(p_rcube(1.2, 1.2, 1.2, r=0.12), T_BLOCK, (0, 0, 0.6))
for x in (-0.3, 0.3):
    for y in (-0.3, 0.3):
        block.add(p_cyl(0.18, 0.16, 14), T_BLOCK, (x, y, 1.26))
block.obj("block")
reed = B()
for i in range(5):
    a = 2 * PI * i / 5
    x, y = math.cos(a) * 0.25, math.sin(a) * 0.25
    h = 1.4 + rng.uniform(-0.3, 0.4)
    reed.add(p_cyl(0.035, h, 6), T_LEAF, (x, y, h / 2))
    reed.add(p_cyl(0.08, 0.38, 8), WOOD_D, (x, y, h - 0.1))
reed.obj("reed")
(B().mirror(lambda: p_rcube(0.26, 0.26, 1.25, r=0.06), T_FENCE, (1.0, 0, 0.62))
    .add(p_rcube(2.2, 0.12, 0.18, r=0.04), T_FENCE, (0, 0, 0.45))
    .add(p_rcube(2.2, 0.12, 0.18, r=0.04), T_FENCE, (0, 0, 0.9))
    .obj("fence"))
(B().add(p_sphere(1.5, 28, 18), T_PLANET, (0, 0, 0))
    .add(p_torus(2.3, 0.12, 40, 6), T_RING, (0, 0, 0), rot=(0.4, 0.2, 0), scale=(1, 1, 0.25))
    .obj("planet"))
iceberg = B()
for (x, y, s) in [(0, 0, 1.0), (0.8, 0.3, 0.6), (-0.7, 0.2, 0.7)]:
    iceberg.add(p_ico(1.0 * s, 1, 0.2), M("ice", "#d9f4ff", 0.15, 0.0, 0.15), (x, y, 0.6 * s), scale=(1, 1, 1.3), smooth=False)
iceberg.obj("iceberg")

# ================================================================ EXPORT
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True)
print("EXPORTED", OUT, len(bpy.data.objects), "objects")

# ---------------------------------------------------------------- optional preview sheet
if PREVIEW:
    roots = [o for o in scene.objects if o.parent is None]
    cols = 9
    for i, o in enumerate(sorted(roots, key=lambda o: o.name)):
        o.location.x += (i % cols) * 7.0
        o.location.y += (i // cols) * 9.0
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 70
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (28, -40, 40)
    cam.rotation_euler = (math.radians(55), 0, 0)
    scene.camera = cam
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    scene.collection.objects.link(sun)
    sun.rotation_euler = (0.6, 0.2, 0.4)
    try:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.color_type = "MATERIAL"
        scene.display.shading.light = "STUDIO"
    except Exception:
        pass
    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1100
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print("PREVIEW", PREVIEW)
