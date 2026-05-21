// ============================================================================
// arcade-scan-builder.js — Draw-to-World Build Engine
// Bridges AI JSON build plans to the existing builder APIs
// ============================================================================
(function() {
    'use strict';

    window.ScanBuilder = {

        // ── Main entry point ──
        // Called after AI returns a build plan JSON
        build: async function(plan, progressCallback) {
            if (!plan) { console.error('ScanBuilder: No plan provided'); return; }
            let pcb = progressCallback || function() {};
            let total = countOps(plan);
            let done = 0;

            console.log('🎨 ScanBuilder: Starting build...', JSON.stringify({
                sculpts: (plan.sculpts || []).length,
                roads: (plan.roads || []).length,
                trees: (plan.trees || []).length,
                water: (plan.water || []).length
            }));

            // 1. Sculpt terrain (hills, valleys, crests)
            for (let s of (plan.sculpts || [])) {
                sculptTerrain(s.x, s.z, s.radius, s.height, s.falloff || 'smooth');
                pcb(++done, total, 'Sculpting: ' + (s.label || 'terrain'));
                await sleep(30);
            }
            if ((plan.sculpts || []).length > 0) {
                updateTerrainGeometry();
            }

            // 2. Dig water features
            for (let w of (plan.water || [])) {
                sculptTerrain(w.x, w.z, w.radius || 20, -(w.depth || 3), 'smooth');
                pcb(++done, total, 'Creating: ' + (w.label || 'water'));
                await sleep(30);
            }
            if ((plan.water || []).length > 0) {
                updateTerrainGeometry();
            }

            // 3. Build roads
            for (let road of (plan.roads || [])) {
                buildRoad(road);
                pcb(++done, total, 'Building road');
                await sleep(100);
            }

            // 4. Place trees (skip any on/near roads or in water)
            let treeBatch = plan.trees || [];
            let roadNodes = [];
            let roadClearance = 15; // meters from road center
            for (let road of (plan.roads || [])) {
                let hw = (road.width || 10) / 2 + 5;
                if (hw > roadClearance) roadClearance = hw;
                for (let n of (road.nodes || [])) roadNodes.push(n);
            }
            let waterZones = (plan.water || []).map(function(w) {
                return { x: w.x, z: w.z, r: (w.radius || 20) + 5 };
            });
            let planted = 0;
            for (let i = 0; i < treeBatch.length; i++) {
                let t = treeBatch[i];
                let skip = false;
                // Check roads
                for (let rn of roadNodes) {
                    let dx = t.x - rn.x, dz = t.z - rn.z;
                    if (dx * dx + dz * dz < roadClearance * roadClearance) { skip = true; break; }
                }
                // Check water
                if (!skip) {
                    for (let wz of waterZones) {
                        let dx = t.x - wz.x, dz = t.z - wz.z;
                        if (dx * dx + dz * dz < wz.r * wz.r) { skip = true; break; }
                    }
                }
                if (!skip) {
                    placeTree(t.x, t.z, t.type, t.scale);
                    planted++;
                }
                if (i % 10 === 0) {
                    pcb(done + Math.floor(i / treeBatch.length * treeBatch.length), total, 'Planting trees (' + (i + 1) + '/' + treeBatch.length + ')');
                    await sleep(10);
                }
            }
            if (planted < treeBatch.length) {
                console.log('🌲 ScanBuilder: Skipped ' + (treeBatch.length - planted) + ' trees on/near roads');
            }
            done += treeBatch.length;

            // 5. Set up race (rally mode)
            if (plan.race) {
                setupRace(plan.race);
                pcb(++done, total, 'Setting up race gates');
                await sleep(50);
            }

            // 6. Set up golf holes
            for (let hole of (plan.holes || [])) {
                setupGolfHole(hole);
                pcb(++done, total, 'Building hole ' + hole.number);
                await sleep(50);
            }

            pcb(total, total, '✅ World built!');
            console.log('🎨 ScanBuilder: Build complete!');
        }
    };

    // ── TERRAIN SCULPTING ──
    // Directly modifies the PlaneGeometry vertex positions
    function sculptTerrain(cx, cz, radius, height, falloff) {
        let geo = window._arcadePlaneGeo || (window.G && window.G.planeGeo);
        if (!geo) { console.warn('ScanBuilder: No terrain geometry found'); return; }

        let positions = geo.attributes.position.array;
        let segs = window.TERRAIN_SEGS || 600;
        let size = window.TERRAIN_SIZE || 900;
        let stride = segs + 1;
        let step = size / segs;
        let half = size / 2;

        let r2 = radius * radius;

        // Convert world coords to grid bounds for efficient iteration
        let gxMin = Math.max(0, Math.floor((cx - radius + half) / step));
        let gxMax = Math.min(segs, Math.ceil((cx + radius + half) / step));
        let gzMin = Math.max(0, Math.floor((cz - radius + half) / step));
        let gzMax = Math.min(segs, Math.ceil((cz + radius + half) / step));

        for (let gz = gzMin; gz <= gzMax; gz++) {
            for (let gx = gxMin; gx <= gxMax; gx++) {
                let idx = gz * stride + gx;
                // PlaneGeometry rotated -90° on X:
                // positions[idx*3]   = local X = world X
                // positions[idx*3+1] = local Y = -world Z
                // positions[idx*3+2] = local Z = height (world Y)
                let wx = positions[idx * 3];
                let wz = -positions[idx * 3 + 1];

                let dx = wx - cx;
                let dz = wz - cz;
                let distSq = dx * dx + dz * dz;
                if (distSq > r2) continue;

                let dist = Math.sqrt(distSq);
                let t = dist / radius;

                // Falloff curves
                let factor;
                if (falloff === 'sharp') {
                    factor = t < 0.7 ? 1.0 : 1.0 - ((t - 0.7) / 0.3);
                } else if (falloff === 'plateau') {
                    factor = t < 0.5 ? 1.0 : (t < 0.8 ? 1.0 - ((t - 0.5) / 0.3) * 0.3 : Math.max(0, 1.0 - ((t - 0.5) / 0.5)));
                } else { // smooth (default)
                    factor = Math.cos(t * Math.PI * 0.5);
                    factor = factor * factor; // smoother falloff
                }

                positions[idx * 3 + 2] += height * factor;
            }
        }
    }

    function updateTerrainGeometry() {
        let geo = window._arcadePlaneGeo || (window.G && window.G.planeGeo);
        if (!geo) return;
        geo.attributes.position.needsUpdate = true;
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
    }

    // ── ROAD BUILDING ──
    // Uses the existing executeSmartRoad() pipeline via smart-builder.js
    function buildRoad(road) {
        if (!road.nodes || road.nodes.length < 2) return;

        // Convert AI node format {x, z} to THREE.Vector3 for smartGreenPoints
        let points = road.nodes.map(function(n) {
            let y = window.getTerrainHeight ? window.getTerrainHeight(n.x, n.z) : 0;
            return new THREE.Vector3(n.x, y, n.z);
        });

        // Detect if it's a loop (first and last node close together)
        let first = points[0], last = points[points.length - 1];
        let loopDist = Math.sqrt((first.x - last.x) ** 2 + (first.z - last.z) ** 2);
        let isLoop = loopDist < 30; // Less than 30m = treat as loop

        // Set smart-builder state
        window._smartRoadWidth = road.width || 10;
        window._smartRoadSurface = mapMaterial(road.material);
        window._smartRoadFoundation = true;
        window._smartRoadShoulder = 4;
        window._smartRoadBanking = 50; // 50% banking for rally feel
        window._smartRoadBarrierL = 'STAKES';
        window._smartRoadBarrierR = 'STAKES';
        window._smartRoadEdgeL = 'NONE';
        window._smartRoadEdgeR = 'NONE';
        window._smartShapeClosed = isLoop;

        // Inject points into smart-builder's internal array
        if (window._injectSmartGreenPoints) {
            window._injectSmartGreenPoints(points);
        } else {
            console.warn('ScanBuilder: _injectSmartGreenPoints not available, using fallback');
            if (!window._builtRoads) window._builtRoads = [];
            window._builtRoads.push({
                id: 'road_scan_' + Date.now().toString(36),
                nodes: road.nodes.map(function(n) { return { worldX: n.x, worldY: 0, worldZ: n.z }; }),
                width: road.width || 10,
                material: mapMaterial(road.material),
                closed: isLoop
            });
            return;
        }

        // Execute the build
        if (window.executeSmartRoad) {
            try {
                window.executeSmartRoad();
            } catch (e) {
                console.error('ScanBuilder: executeSmartRoad failed:', e);
                if (!window._builtRoads) window._builtRoads = [];
                window._builtRoads.push({
                    id: 'road_scan_' + Date.now().toString(36),
                    nodes: road.nodes.map(function(n) { return { worldX: n.x, worldY: 0, worldZ: n.z }; }),
                    width: road.width || 10,
                    material: mapMaterial(road.material),
                    closed: isLoop
                });
            }
        }
    }

    function mapMaterial(aiMaterial) {
        let m = (aiMaterial || 'gravel').toUpperCase();
        if (m === 'ASPHALT' || m === 'TARMAC') return 'ASPHALT';
        if (m === 'DIRT' || m === 'MUD') return 'DIRT';
        return 'GRAVEL';
    }

    // ── TREE PLACEMENT ──
    // Uses the exposed window.createTree() function from arcade.html
    function placeTree(x, z, type, scale) {
        let treeType = mapTreeType(type);
        let s = scale || (0.8 + Math.random() * 0.4);
        let rot = Math.random() * Math.PI * 2;

        if (window.createTree) {
            window.createTree(treeType, x, z, s, rot, null, null);
        } else if (window.placedTrees) {
            // Fallback: push directly to placedTrees array
            let groundY = window.getTerrainHeight ? window.getTerrainHeight(x, z) : 0;
            window.placedTrees.push({
                type: treeType, x: x, z: z, y: groundY,
                scale: s, rot: rot, color: null, trunkColor: null
            });
        }
    }

    function mapTreeType(aiType) {
        let t = (aiType || 'oak').toLowerCase();
        if (t === 'pine' || t === 'spruce' || t === 'fir') return 'pine';
        if (t === 'birch') return 'birch';
        if (t === 'dead' || t === 'bare') return 'dead';
        if (t === 'palm') return 'palm';
        if (t === 'cactus') return 'cactus';
        if (t === 'bush' || t === 'shrub') return 'bush';
        return 'oak'; // Default
    }

    // ── RACE SETUP ──
    // Places start gate, finish gate, and checkpoints
    function setupRace(race) {
        if (!window.raceConfig) {
            // Initialize if not exists
            window.raceConfig = {
                start: null, finish: null, checkpoints: [],
                bestTime: null, laps: 1, missedCheckpointRule: 'PENALTY_5S',
                usePbr: true
            };
        }

        // Place START gate
        if (race.start) {
            let sy = window.getTerrainHeight ? window.getTerrainHeight(race.start.x, race.start.z) : 0;
            window.raceConfig.start = {
                x: race.start.x, y: sy, z: race.start.z,
                rotation: race.start.heading || 0
            };
            // Create visual marker
            if (window.createTeeObject) {
                try {
                    let startMesh = window.createTeeObject(race.start.x, sy, race.start.z, 'yellow');
                    if (startMesh && window._arcadeScene) {
                        window._arcadeScene.add(startMesh);
                    }
                } catch(e) {}
            }
        }

        // Place FINISH gate
        if (race.finish) {
            let fy = window.getTerrainHeight ? window.getTerrainHeight(race.finish.x, race.finish.z) : 0;
            window.raceConfig.finish = {
                x: race.finish.x, y: fy, z: race.finish.z,
                rotation: race.finish.heading || 0
            };
            if (window.createFlagObject) {
                try {
                    let finishMesh = window.createFlagObject(race.finish.x, fy, race.finish.z);
                    if (finishMesh && window._arcadeScene) {
                        window._arcadeScene.add(finishMesh);
                    }
                } catch(e) {}
            }
        }

        // Place CHECKPOINTS
        if (race.checkpoints && race.checkpoints.length > 0) {
            window.raceConfig.checkpoints = race.checkpoints.map(function(cp) {
                let cy = window.getTerrainHeight ? window.getTerrainHeight(cp.x, cp.z) : 0;
                return { x: cp.x, y: cy, z: cp.z, radius: cp.radius || 12 };
            });
        }

        // Set laps
        window.raceConfig.laps = race.laps || 1;
    }

    // ── GOLF HOLE SETUP ──
    function setupGolfHole(hole) {
        // Golf holes are managed via courseHoles in arcade.html
        // This is a simplified bridge — full implementation pending
        if (!window.courseHoles) return;

        let idx = (hole.number || 1) - 1;
        while (window.courseHoles.length <= idx) {
            window.courseHoles.push({ par: 4, tees: {}, flag: null });
        }

        let h = window.courseHoles[idx];
        h.par = hole.par || 4;

        if (hole.tee) {
            let ty = window.getTerrainHeight ? window.getTerrainHeight(hole.tee.x, hole.tee.z) : 0;
            h.tees = h.tees || {};
            h.tees.yellow = { x: hole.tee.x, y: ty, z: hole.tee.z };
        }

        if (hole.pin) {
            let py = window.getTerrainHeight ? window.getTerrainHeight(hole.pin.x, hole.pin.z) : 0;
            h.flag = { x: hole.pin.x, y: py, z: hole.pin.z };
        }
    }

    // ── UTILITIES ──
    function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

    function countOps(plan) {
        return (plan.sculpts || []).length
             + (plan.roads || []).length
             + (plan.trees || []).length
             + (plan.water || []).length
             + (plan.holes || []).length
             + (plan.race ? 1 : 0);
    }

})();
