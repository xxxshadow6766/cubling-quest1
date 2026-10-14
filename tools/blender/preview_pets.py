"""Dev helper: renders a few assembled pet part combinations from assets.glb.
blender --background --factory-startup --python tools/blender/preview_pets.py -- client/public/models/assets.glb out.png
"""
import bpy, sys, math
argv = sys.argv[sys.argv.index("--") + 1:]
glb, out = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
sc = bpy.context.scene
objs = {o.name: o for o in sc.objects}
for o in sc.objects:
    o.hide_render = True
combos = [
    ["pet_body", "pet_eyes", "pet_shine", "pet_mouth", "pet_cheeks", "pet_belly", "pet_ears_cat", "pet_tail_thin"],
    ["pet_body", "pet_eyes", "pet_shine", "pet_mouth", "pet_cheeks", "pet_ears_bunny", "pet_tail_puff"],
    ["pet_body", "pet_eyes", "pet_shine", "pet_snout", "pet_ears_floppy", "pet_tail_curly", "pet_spots"],
    ["pet_body", "pet_eyes", "pet_shine", "pet_mouth", "pet_horns", "pet_wings", "pet_tail_spike", "pet_belly"],
    ["pet_body", "pet_visor", "pet_mouth", "pet_antenna", "pet_tail_fin", "pet_fin_top"],
    ["pet_body", "pet_eyes", "pet_shine", "pet_mouth", "pet_cheeks", "pet_ears_bear", "pet_crown", "pet_halo", "pet_horn_uni"],
]
for i, c in enumerate(combos):
    for n in c:
        o = objs[n].copy()
        sc.collection.objects.link(o)
        o.hide_render = False
        o.location.x += (i % 3) * 2.0
        o.location.z -= (i // 3) * 2.0
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
sc.collection.objects.link(cam)
cam.data.type = "ORTHO"
cam.data.ortho_scale = 7
cam.location = (2.6, -9, 1.5)
cam.rotation_euler = (math.radians(85), 0, math.radians(-12))
sc.camera = cam
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.color_type = "MATERIAL"
sc.render.resolution_x = 900
sc.render.resolution_y = 650
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
