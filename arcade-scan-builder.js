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
                await sleep(80); // Longer yield to prevent Chrome "page unresponsive"
            }
            if ((plan.sculpts || []).length > 0) {
                updateTerrainGeometry();
            }

            // 2. Dig water features + set up water mesh/mask
            for (let w of (plan.water || [])) {
                let depth = w.depth || 3;
                let radius = w.radius || 20;
                // Dig terrain down to create lake bed
                sculptTerrain(w.x, w.z, radius, -(depth + 2.5), 'smooth');
                
                // Set waterData + waterBaseZ for the water surface
                let waterLevel = (window.waterTableLevel != null) ? window.waterTableLevel : -0.5;
                if (window.waterData && window.waterBaseZ) {
                    let geo = window._arcadePlaneGeo || (window.G && window.G.planeGeo);
                    if (geo) {
                        let segs = window.TERRAIN_SEGS || 600;
                        let size = window.TERRAIN_SIZE || 900;
                        let stride = segs + 1;
                        let step = size / segs;
                        let half = size / 2;
                        let r2 = (radius + 12) * (radius + 12); // +12m margin like builder
                        
                        for (let gz = 0; gz <= segs; gz++) {
                            for (let gx = 0; gx <= segs; gx++) {
                                let idx = gz * stride + gx;
                                let vx = -half + gx * step;
                                let vz = -half + gz * step;
                                let dx = vx - w.x, dz = vz - w.z;
                                if (dx * dx + dz * dz < r2) {
                                    window.waterData[idx] = waterLevel;
                                    window.waterBaseZ[idx] = waterLevel;
                                }
                            }
                        }
                    }
                }
                
                pcb(++done, total, 'Creating: ' + (w.label || 'water'));
                await sleep(30);
            }
            if ((plan.water || []).length > 0) {
                updateTerrainGeometry();
                // Sync water visual mesh + rebuild alpha mask
                if (window.syncWaterVisual) window.syncWaterVisual();
                if (window.rebuildWaterMask) window.rebuildWaterMask(false);
            }

            // 3. Build roads
            for (let road of (plan.roads || [])) {
                buildRoad(road);
                pcb(++done, total, 'Building road');
                await sleep(200); // Roads are heavy — longer yield
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
            // Always run — if plan.race is missing, auto-generate from road data
            let raceData = plan.race || {};
            // Auto-detect start/finish from first road if not specified
            if (!raceData.start && (window._builtRoads || []).length > 0) {
                let firstRoad = window._builtRoads[0];
                let pts = firstRoad.sampledPoints;
                if (pts && pts.length >= 2) {
                    raceData.start = { x: pts[0].x, z: pts[0].z, heading: 0 };
                    let last = pts[pts.length - 1];
                    let first = pts[0];
                    let dx = last.x - first.x, dz = last.z - first.z;
                    let dist = Math.sqrt(dx*dx + dz*dz);
                    if (dist < 30) {
                        // Loop track — start = finish
                        raceData.finish = { x: pts[0].x, z: pts[0].z, heading: 0 };
                        raceData.laps = raceData.laps || 3;
                    } else {
                        raceData.finish = { x: last.x, z: last.z, heading: 0 };
                    }
                    console.log('🏁 Auto-detected start/finish from road endpoints');
                }
            }
            setupRace(raceData);
            pcb(++done, total, 'Setting up race gates');
            await sleep(50);

            // 6. Set up golf holes
            for (let hole of (plan.holes || [])) {
                setupGolfHole(hole);
                pcb(++done, total, 'Building hole ' + hole.number);
                await sleep(50);
            }

            // Sync terrain chunks and refresh grass shells
            if (window._terrainChunks) window._terrainChunks.syncAll();
            if (window._terrainShells) window._terrainShells.refresh();

            pcb(total, total, '✅ World built!');
            console.log('🎨 ScanBuilder: Build complete!');

            // ── AUTO-REPOSITION CAMERA above terrain ──
            // After build, camera may be inside mountains. Move it to a bird's-eye view.
            try {
                let cam = window.camera;
                let ctrl = window.controls;
                if (cam && ctrl) {
                    // Find terrain center height
                    let centerY = 0;
                    if (window.getTerrainHeight) {
                        centerY = window.getTerrainHeight(0, 0);
                    }
                    // Find max terrain height for safe camera position
                    let maxY = centerY;
                    let geo = window._arcadePlaneGeo;
                    if (geo) {
                        let pos = geo.attributes.position.array;
                        for (let vi = 2; vi < pos.length; vi += 3) {
                            if (pos[vi] > maxY) maxY = pos[vi];
                        }
                    }
                    // Position camera well above the highest point
                    let safeY = maxY + 150;
                    cam.position.set(0, safeY, 200);
                    ctrl.target.set(0, centerY, 0);
                    ctrl.update();
                    console.log('📷 Camera repositioned: y=' + safeY.toFixed(0) + ' (terrain max=' + maxY.toFixed(0) + ')');
                }
            } catch (camErr) {
                console.warn('📷 Camera reposition failed:', camErr.message);
            }
        }
    };

    // ── TERRAIN SCULPTING ──
    // Directly modifies the PlaneGeometry vertex positions
    function sculptTerrain(cx, cz, radius, height, falloff) {
        let geo = window._arcadePlaneGeo || (window.G && window.G.planeGeo);
        if (!geo) { console.warn('ScanBuilder: No terrain geometry found'); return; }

        // Fetch mountainMaxHeight from sessionStorage to enforce engine constraints
        let maxHeightCap = 80;
        try {
            let bcStr = sessionStorage.getItem('scan_build_config');
            if (bcStr) {
                let bcObj = JSON.parse(bcStr);
                if (bcObj && bcObj.mountainMaxHeight !== undefined) {
                    maxHeightCap = bcObj.mountainMaxHeight;
                }
            }
        } catch (e) {
            console.error('ScanBuilder: Error reading build config cap', e);
        }

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

                // If raising terrain (mountain/hill), enforce the max height cap
                if (height > 0) {
                    let oldH = positions[idx * 3 + 2];
                    let newH = oldH + height * factor;
                    
                    // Soft cap using tanh compression above 70% of cap
                    let cappedH = newH;
                    let threshold = maxHeightCap * 0.7;
                    if (newH > threshold) {
                        cappedH = threshold + (maxHeightCap - threshold) * Math.tanh((newH - threshold) / (maxHeightCap - threshold));
                    }
                    
                    positions[idx * 3 + 2] = Math.max(oldH, cappedH);
                } else {
                    positions[idx * 3 + 2] += height * factor;
                }
            }
        }
    }

    function updateTerrainGeometry() {
        let geo = window._arcadePlaneGeo || (window.G && window.G.planeGeo);
        if (!geo) return;
        if (window.clampTerrainBorders) window.clampTerrainBorders(geo);
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
        window._smartRoadFoundation = road.foundation === true;  // Only cut through terrain if plan specifies it
        window._smartRoadShoulder = 4;
        window._smartRoadBanking = road.banking || 0; // Respektera planens inställning
        window._smartRoadGradeDown = 0.75; // More generous downhill limit (75% grade)
        window._smartRoadGradeUp = 0.60;   // More generous uphill limit (60% grade)
        window._smartRoadBarrierL = road.barrierL || 'NONE'; // Respektera planens inställning
        window._smartRoadBarrierR = road.barrierR || 'NONE'; // Respektera planens inställning
        window._smartRoadEdgeL = 'NONE';
        window._smartRoadEdgeR = 'NONE';
        window._smartShapeClosed = isLoop;

        // Inject points into smart-builder's internal array
        if (window._injectSmartGreenPoints) {
            window._injectSmartGreenPoints(points);
        } else {
            console.warn('ScanBuilder: _injectSmartGreenPoints not available, using fallback');
            if (!window._builtRoads) window._builtRoads = [];
            var fallbackNodes = road.nodes.map(function(n) { return { worldX: n.x, worldY: 0, worldZ: n.z }; });
            window._builtRoads.push({
                id: 'road_scan_' + Date.now().toString(36),
                nodes: fallbackNodes,
                width: road.width || 10,
                material: mapMaterial(road.material),
                closed: isLoop,
                sampledPoints: road.nodes.map(function(n) { return { x: n.x, y: 0, z: n.z }; })
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
                    closed: isLoop,
                    sampledPoints: road.nodes.map(function(n) { return { x: n.x, y: 0, z: n.z }; })
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
    // Places start gate, finish gate, and checkpoints, snapping them to the built road spline
    function setupRace(race) {
        let scene = window._arcadeScene || (window.G && window.G.scene);
        
        function snapToRoadIfNeeded(pos, defaultHeading) {
            if (!pos) return null;
            let snap = { x: pos.x, z: pos.z, heading: defaultHeading || 0 };
            if (window.getNearestRoadPoint && window.THREE) {
                let hitPt = new THREE.Vector3(pos.x, 0, pos.z);
                let snapData = window.getNearestRoadPoint(hitPt);
                if (snapData) {
                    snap.x = snapData.point.x;
                    snap.z = snapData.point.z;
                    snap.heading = Math.atan2(snapData.tangent.x, snapData.tangent.z);
                    console.log('🚗 SnapToRoad: snapped (', pos.x, ',', pos.z, ') -> (', snap.x, ',', snap.z, ') heading:', snap.heading);
                }
            }
            return snap;
        }

        if (!window.raceConfig) {
            // Initialize if not exists
            window.raceConfig = {
                start: null, finish: null, checkpoints: [],
                bestTime: null, laps: 1, missedCheckpointRule: 'PENALTY_5S',
                usePbr: true, checkpointMeshes: []
            };
        }

        // Remove existing gate and checkpoint meshes from scene
        if (scene) {
            if (window.raceConfig.startMesh) {
                scene.remove(window.raceConfig.startMesh);
                window.raceConfig.startMesh = null;
            }
            if (window.raceConfig.finishMesh) {
                scene.remove(window.raceConfig.finishMesh);
                window.raceConfig.finishMesh = null;
            }
            if (window.raceConfig.checkpointMeshes) {
                window.raceConfig.checkpointMeshes.forEach(function(m) {
                    if (m.ring) {
                        scene.remove(m.ring);
                        if (m.ring.geometry) m.ring.geometry.dispose();
                        if (m.ring.material) m.ring.material.dispose();
                    }
                    if (m.label) {
                        scene.remove(m.label);
                        if (m.label.material) {
                            if (m.label.material.map) m.label.material.map.dispose();
                            m.label.material.dispose();
                        }
                    }
                });
            }
        }
        window.raceConfig.checkpointMeshes = [];

        // Snap start and finish elements to the road spline
        let snappedStart = snapToRoadIfNeeded(race.start, race.start ? race.start.heading : 0);
        let snappedFinish = snapToRoadIfNeeded(race.finish, race.finish ? race.finish.heading : 0);

        // Check if start and finish coordinates are at the same location (distance < 2.0m)
        let isCombined = false;
        if (snappedStart && snappedFinish) {
            let dx = snappedStart.x - snappedFinish.x;
            let dz = snappedStart.z - snappedFinish.z;
            let dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < 2.0) isCombined = true;
        }

        if (isCombined) {
            let sy = window.getTerrainHeight ? window.getTerrainHeight(snappedStart.x, snappedStart.z) : 0;
            window.raceConfig.start = {
                x: snappedStart.x, y: sy, z: snappedStart.z,
                rotation: snappedStart.heading
            };
            window.raceConfig.finish = {
                x: snappedStart.x, y: sy, z: snappedStart.z,
                rotation: snappedStart.heading
            };

            if (typeof createRallyGate === 'function' && scene) {
                try {
                    let sfg = createRallyGate(snappedStart.x, sy, snappedStart.z, 'start_finish');
                    sfg.rotation.y = snappedStart.heading;
                    scene.add(sfg);
                    window.raceConfig.startMesh = sfg;
                    window.raceConfig.finishMesh = null;
                } catch(e) {
                    console.error('ScanBuilder: Failed to create combined rally gate mesh:', e);
                }
            }
        } else {
            // Place START gate
            if (snappedStart) {
                let sy = window.getTerrainHeight ? window.getTerrainHeight(snappedStart.x, snappedStart.z) : 0;
                window.raceConfig.start = {
                    x: snappedStart.x, y: sy, z: snappedStart.z,
                    rotation: snappedStart.heading
                };
                if (typeof createRallyGate === 'function' && scene) {
                    try {
                        let sg = createRallyGate(snappedStart.x, sy, snappedStart.z, 'start');
                        sg.rotation.y = snappedStart.heading;
                        scene.add(sg);
                        window.raceConfig.startMesh = sg;
                    } catch(e) {
                        console.error('ScanBuilder: Failed to create start rally gate mesh:', e);
                    }
                } else if (window.createTeeObject && scene) {
                    try {
                        let startMesh = window.createTeeObject(snappedStart.x, sy, snappedStart.z, 'yellow');
                        if (startMesh) {
                            scene.add(startMesh);
                            window.raceConfig.startMesh = startMesh;
                        }
                    } catch(e) {}
                }
            }

            // Place FINISH gate
            if (snappedFinish) {
                let fy = window.getTerrainHeight ? window.getTerrainHeight(snappedFinish.x, snappedFinish.z) : 0;
                window.raceConfig.finish = {
                    x: snappedFinish.x, y: fy, z: snappedFinish.z,
                    rotation: snappedFinish.heading
                };
                if (typeof createRallyGate === 'function' && scene) {
                    try {
                        let fg = createRallyGate(snappedFinish.x, fy, snappedFinish.z, 'finish');
                        fg.rotation.y = snappedFinish.heading;
                        scene.add(fg);
                        window.raceConfig.finishMesh = fg;
                    } catch(e) {
                        console.error('ScanBuilder: Failed to create finish rally gate mesh:', e);
                    }
                } else if (window.createFlagObject && scene) {
                    try {
                        let finishMesh = window.createFlagObject(snappedFinish.x, fy, snappedFinish.z);
                        if (finishMesh) {
                            scene.add(finishMesh);
                            window.raceConfig.finishMesh = finishMesh;
                        }
                    } catch(e) {}
                }
            }
        }

        // ── AUTO-GENERATE CHECKPOINTS from road data ──
        // No AI needed — system reads road sampledPoints and places 6-8 checkpoints:
        // 1. Compute curvature at each road point
        // 2. Pick curve apexes (highest curvature = furthest from straight line)
        // 3. Fill gaps with evenly-spaced points to prevent shortcuts
        let autoCheckpoints = [];
        if (race.checkpoints && race.checkpoints.length > 0) {
            // Use explicit checkpoints if provided (backward compat)
            autoCheckpoints = race.checkpoints.map(function(cp) {
                let snappedCp = snapToRoadIfNeeded(cp, 0) || cp;
                let cy = window.getTerrainHeight ? window.getTerrainHeight(snappedCp.x, snappedCp.z) : 0;
                return { x: snappedCp.x, y: cy, z: snappedCp.z, radius: cp.radius || 15 };
            });
        } else {
            // AUTO-GENERATE from road geometry
            autoCheckpoints = autoGenerateCheckpoints();
        }

        window.raceConfig.checkpoints = autoCheckpoints;

        // Build checkpoint meshes (visible yellow torus rings)
        if (scene && window.THREE && autoCheckpoints.length > 0) {
            autoCheckpoints.forEach(function(cp, i) {
                try {
                    let ring = new THREE.Mesh(
                        new THREE.TorusGeometry((cp.radius || 15) * 0.5, 0.3, 8, 24),
                        new THREE.MeshLambertMaterial({ color: 0xfacc15, transparent: true, opacity: 0.7 })
                    );
                    ring.rotation.x = Math.PI / 2;
                    ring.position.set(cp.x, cp.y + 3, cp.z);
                    scene.add(ring);
                    window.raceConfig.checkpointMeshes.push({ ring: ring, label: null });
                } catch(e) {
                    console.error('ScanBuilder: Failed to create checkpoint mesh:', e);
                }
            });
            console.log('🏁 Auto-checkpoints placed:', autoCheckpoints.length);
        }

        // Set laps
        window.raceConfig.laps = race.laps || 1;
    }

    // ── AUTO-GENERATE CHECKPOINTS ──
    // Analyzes built road geometry and places 6-8 strategic checkpoints.
    // Algorithm:
    //   1. Collect all sampledPoints from _builtRoads
    //   2. Compute curvature (angle change) at each point
    //   3. Find curve apexes (local maxima of curvature)
    //   4. Pick top N apex points as "must-have" checkpoints
    //   5. Fill remaining slots with evenly-spaced points to prevent shortcuts
    //   6. Sort checkpoints in road-order
    function autoGenerateCheckpoints() {
        let roads = window._builtRoads || [];
        if (roads.length === 0) {
            console.warn('🏁 autoGenerateCheckpoints: No roads found');
            return [];
        }

        // Collect all sampled points into a single path
        // For multi-road courses, concatenate; for single road, use directly
        let allPoints = [];
        for (let ri = 0; ri < roads.length; ri++) {
            let pts = roads[ri].sampledPoints;
            if (!pts || pts.length < 2) continue;
            for (let pi = 0; pi < pts.length; pi++) {
                allPoints.push({ x: pts[pi].x, y: pts[pi].y || 0, z: pts[pi].z, roadIdx: ri, ptIdx: pi });
            }
        }

        if (allPoints.length < 10) {
            console.warn('🏁 autoGenerateCheckpoints: Too few road points (' + allPoints.length + ')');
            return [];
        }

        // Step 1: Compute cumulative arc length for each point
        let arcLength = [0];
        for (let i = 1; i < allPoints.length; i++) {
            let dx = allPoints[i].x - allPoints[i-1].x;
            let dz = allPoints[i].z - allPoints[i-1].z;
            arcLength.push(arcLength[i-1] + Math.sqrt(dx*dx + dz*dz));
        }
        let totalLength = arcLength[allPoints.length - 1];

        // Step 2: Compute curvature at each point (angle change over ~10m window)
        let curvature = new Float32Array(allPoints.length);
        let WINDOW = 5; // look-ahead/behind points
        for (let i = WINDOW; i < allPoints.length - WINDOW; i++) {
            let prev = allPoints[i - WINDOW];
            let curr = allPoints[i];
            let next = allPoints[i + WINDOW];

            let ax = curr.x - prev.x, az = curr.z - prev.z;
            let bx = next.x - curr.x, bz = next.z - curr.z;

            let lenA = Math.sqrt(ax*ax + az*az);
            let lenB = Math.sqrt(bx*bx + bz*bz);
            if (lenA < 0.01 || lenB < 0.01) continue;

            // Cross product magnitude = sin(angle) * |a| * |b|
            let cross = Math.abs(ax * bz - az * bx);
            curvature[i] = cross / (lenA * lenB); // = |sin(angle)|
        }

        // Step 3: Find curve apexes (local maxima of curvature)
        // Minimum curvature threshold — ignore gentle bends
        let CURVATURE_THRESHOLD = 0.15; // ~8.6° turn
        let MIN_APEX_SPACING = totalLength * 0.08; // Apexes must be ≥8% of track apart

        let apexes = []; // {index, curvature, arcLen}
        for (let i = WINDOW + 2; i < allPoints.length - WINDOW - 2; i++) {
            if (curvature[i] < CURVATURE_THRESHOLD) continue;
            // Is this a local maximum? (higher than neighbors ±2)
            if (curvature[i] >= curvature[i-1] && curvature[i] >= curvature[i+1] &&
                curvature[i] >= curvature[i-2] && curvature[i] >= curvature[i+2]) {
                apexes.push({ index: i, curv: curvature[i], dist: arcLength[i] });
            }
        }

        // Sort by curvature (sharpest first)
        apexes.sort(function(a, b) { return b.curv - a.curv; });

        // Step 4: Pick top apexes respecting minimum spacing
        let TARGET_CHECKPOINTS = Math.min(8, Math.max(4, Math.round(totalLength / 150))); // ~1 per 150m, clamped 4-8
        let selectedIndices = []; // indices into allPoints

        for (let ai = 0; ai < apexes.length && selectedIndices.length < Math.ceil(TARGET_CHECKPOINTS * 0.6); ai++) {
            let apex = apexes[ai];
            // Check spacing vs already selected
            let tooClose = false;
            for (let si = 0; si < selectedIndices.length; si++) {
                let existingDist = arcLength[selectedIndices[si]];
                if (Math.abs(apex.dist - existingDist) < MIN_APEX_SPACING) {
                    tooClose = true;
                    break;
                }
            }
            if (!tooClose) {
                selectedIndices.push(apex.index);
            }
        }

        // Step 5: Fill remaining slots with evenly-spaced points
        // Skip first 5% and last 5% (too close to start/finish)
        let usedDistances = selectedIndices.map(function(idx) { return arcLength[idx]; });
        let MARGIN = totalLength * 0.05;
        let remaining = TARGET_CHECKPOINTS - selectedIndices.length;

        if (remaining > 0) {
            let spacing = (totalLength - 2 * MARGIN) / (remaining + 1);
            for (let fi = 0; fi < remaining; fi++) {
                let targetDist = MARGIN + spacing * (fi + 1);
                // Check it's not too close to an existing checkpoint
                let tooClose = false;
                for (let ud = 0; ud < usedDistances.length; ud++) {
                    if (Math.abs(targetDist - usedDistances[ud]) < MIN_APEX_SPACING * 0.5) {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;

                // Find nearest road point to this arc distance
                let bestIdx = 0;
                let bestDiff = Infinity;
                for (let pi = 0; pi < allPoints.length; pi++) {
                    let diff = Math.abs(arcLength[pi] - targetDist);
                    if (diff < bestDiff) { bestDiff = diff; bestIdx = pi; }
                }
                selectedIndices.push(bestIdx);
                usedDistances.push(arcLength[bestIdx]);
            }
        }

        // Step 6: Sort by arc length (road order) and build checkpoint objects
        selectedIndices.sort(function(a, b) { return arcLength[a] - arcLength[b]; });

        let roadWidth = (roads[0] && roads[0].width) || 10;
        let cpRadius = Math.max(15, roadWidth + 5); // road width + 5m margin

        let checkpoints = [];
        for (let ci = 0; ci < selectedIndices.length; ci++) {
            let pt = allPoints[selectedIndices[ci]];
            let cy = 0;
            if (window.getTerrainHeight) cy = window.getTerrainHeight(pt.x, pt.z);
            checkpoints.push({ x: pt.x, y: cy, z: pt.z, radius: cpRadius });
        }

        console.log('🏁 Auto-generated ' + checkpoints.length + ' checkpoints from ' +
            allPoints.length + ' road points (track: ' + Math.round(totalLength) + 'm, ' +
            apexes.length + ' curve apexes found)');

        return checkpoints;
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
             + 1; // race setup always runs (auto-generates if needed)
    }

    // Simple box blur (applied multiple times ≈ gaussian)
    function gaussianBlur(data, w, h, passes) {
        var src = new Float32Array(data);
        var dst = new Float32Array(w * h);
        for (var p = 0; p < (passes || 2); p++) {
            // Horizontal pass
            for (var y = 0; y < h; y++) {
                for (var x = 0; x < w; x++) {
                    var sum = 0, count = 0;
                    for (var dx = -2; dx <= 2; dx++) {
                        var nx = x + dx;
                        if (nx >= 0 && nx < w) {
                            sum += src[y * w + nx];
                            count++;
                        }
                    }
                    dst[y * w + x] = sum / count;
                }
            }
            // Vertical pass
            var tmp = src; src = dst; dst = tmp;
            for (var y = 0; y < h; y++) {
                for (var x = 0; x < w; x++) {
                    var sum = 0, count = 0;
                    for (var dy = -2; dy <= 2; dy++) {
                        var ny = y + dy;
                        if (ny >= 0 && ny < h) {
                            sum += src[ny * w + x];
                            count++;
                        }
                    }
                    dst[y * w + x] = sum / count;
                }
            }
            var tmp2 = src; src = dst; dst = tmp2;
        }
        return src;
    }

    // Bilinear interpolation for texture field sampling
    function sampleBilinear(array, w, h, x, y) {
        var x0 = Math.floor(x);
        var x1 = Math.min(w - 1, x0 + 1);
        var y0 = Math.floor(y);
        var y1 = Math.min(h - 1, y0 + 1);

        var tx = x - x0;
        var ty = y - y0;

        var c00 = array[y0 * w + x0];
        var c10 = array[y0 * w + x1];
        var c01 = array[y1 * w + x0];
        var c11 = array[y1 * w + x1];

        var top = c00 * (1 - tx) + c10 * tx;
        var bottom = c01 * (1 - tx) + c11 * tx;

        return top * (1 - ty) + bottom * ty;
    }

    // Calculate minimum distance from point (px, pz) to line segment between (x1, z1) and (x2, z2)
    function getDistanceToSegment(px, pz, x1, z1, x2, z2) {
        var dx = x2 - x1;
        var dz = z2 - z1;
        var lenSq = dx * dx + dz * dz;
        if (lenSq < 0.01) {
            var ndx = px - x1;
            var ndz = pz - z1;
            return Math.sqrt(ndx * ndx + ndz * ndz);
        }
        var t = ((px - x1) * dx + (pz - z1) * dz) / lenSq;
        t = Math.max(0, Math.min(1, t));
        var cx = x1 + t * dx;
        var cz = z1 + t * dz;
        var cdx = px - cx;
        var cdz = pz - cz;
        return Math.sqrt(cdx * cdx + cdz * cdz);
    }

})();
