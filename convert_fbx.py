import bpy
import sys
import os

# Clear scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# Try importing as a generic format using Blender's older importers
fbx_path = "/Users/sarahsackerud/.gemini/antigravity/scratch/3D-Rally-AR/assets/ready/dirt_bike_fbx.FBX"

# Method: Use Blender's built-in ASCII FBX importer (legacy)
# First check if it's ASCII or binary
with open(fbx_path, 'rb') as f:
    header = f.read(20)
    print("FBX Header bytes:", header)
    
# Try the better_import_fbx addon or legacy mode
try:
    bpy.ops.import_scene.fbx(filepath=fbx_path, use_manual_orientation=True)
except Exception as e:
    print("Standard FBX import failed:", e)
    # Try as Autodesk format with legacy flag
    try:
        bpy.ops.import_scene.fbx(filepath=fbx_path, use_prepost_rot=False)
    except Exception as e2:
        print("Legacy FBX import also failed:", e2)
        print("FBX 6100 cannot be imported by this Blender version")
        sys.exit(1)

# Export as GLB
glb_path = "/Users/sarahsackerud/.gemini/antigravity/scratch/3D-Rally-AR/dirt_bike.glb"
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format='GLB',
    export_animations=True,
    export_skins=True
)

print("SUCCESS: Exported to " + glb_path)
