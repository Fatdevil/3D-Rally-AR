# 3D-Rally-AR 🏎️

Rally racing game built on the Antigravity 3D terrain engine.

## Origin

Forked from `3D-Golf-AR` (2026-05-14). Contains the full terrain builder (BUILD mode) with:
- 900m × 900m terrain with 600-segment mesh
- Sculpt / Smooth / Flatten / Ramp / Ridge / Noise tools
- Smart Builder (polygon-based: Green, Bunker, Fairway, Stamp)
- Paint system with biome support (4 biomes)
- Water system (lake/ocean)
- Nature placement (trees, rocks, plants)
- Terrain analysis overlays (slope, contour, elevation)
- Wind sway, leaves, particle engine
- Save/Load via PostgreSQL backend

## TODO: Rally-specific

- [ ] Replace golf ball with rally car model
- [ ] Vehicle physics (acceleration, braking, steering, drift)
- [ ] Track/road builder tool (spline-based)
- [ ] Checkpoints and timing system
- [ ] Camera system (chase cam, cockpit, replay)
- [ ] Collision detection with terrain features
- [ ] Sound engine (engine, skid, crash)
- [ ] Strip golf-specific code (swing engine, scorecard, holes, flags, tees)

## Getting started

```bash
npm install
node server.js
# Open http://localhost:3000/arcade.html?autorun=edit_build
```

## Files to strip (golf-specific)

| File | Purpose | Rally action |
|------|---------|-------------|
| `arcade-swing-engine.js` | Golf swing mechanics | **REPLACE** with vehicle controller |
| `arcade-tracer-engine.js` | Ball flight tracer | **REPLACE** with tire tracks |
| `physics.js` | Golf ball physics | **REPLACE** with vehicle physics |
| `golfball-texture.png` | Ball texture | **REMOVE** |
| `golf_*.png` | Hub images | **REPLACE** with rally images |

## Files to keep (shared engine)

| File | Purpose |
|------|---------|
| `arcade.html` | Core engine + terrain builder |
| `smart-builder.js` | Smart Builder tools |
| `arcade-perlin.js` | Procedural noise |
| `arcade-scene-engine.js` | Scene management |
| `arcade-wind-sway.js` | Wind animation |
| `arcade-leaves.js` | Foliage system |
| `arcade-particle-engine.js` | VFX particles |
| `arcade-terrain-overlays.js` | Analysis tools |
| `arcade.css` | UI styling |
