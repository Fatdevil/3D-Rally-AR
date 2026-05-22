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
            let total = countOps(plan) + 1; // +1 for mountain scan
            let done = 0;

            console.log('🎨 ScanBuilder: Starting build...', JSON.stringify({
                sculpts: (plan.sculpts || []).length,
                roads: (plan.roads || []).length,
                trees: (plan.trees || []).length,
                water: (plan.water || []).length
            }));

            // 0. Build mountains from canvas green pixels (distance transform)
            pcb(++done, total, 'Scanning mountains...');
            await this.buildMountainsFromCanvas(plan);
            await sleep(50);

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
        },

        // ── Mountain builder from canvas pixels ──
        // Reads the draw-canvas, extracts green mountain pixels,
        // applies distance transform, and sculpts terrain heightmap
        buildMountainsFromCanvas: async function(plan) {
            // Get the canvas image from sessionStorage or DOM
            let canvasEl = document.getElementById('draw-canvas');
            let imgSrc = sessionStorage.getItem('scan_canvas_image');
            
            if (!imgSrc && !canvasEl) {
                console.log('🏔️ ScanBuilder: No canvas for mountain scan');
                return;
            }

            // Load image
            let img = new Image();
            let loaded = new Promise(function(resolve) {
                img.onload = resolve;
                img.onerror = resolve;
            });
            img.src = imgSrc || canvasEl.toDataURL('image/png');
            await loaded;
            if (!img.width) return;

            // Draw to temp canvas at manageable resolution
            let S = 4; // downsample factor
            let w = Math.floor(img.width / S);
            let h = Math.floor(img.height / S);
            var tmp = document.createElement('canvas');
            tmp.width = w; tmp.height = h;
            var tc = tmp.getContext('2d');
            tc.drawImage(img, 0, 0, w, h);
            var pixels = tc.getImageData(0, 0, w, h).data;

            // Step 1: Extract green mountain pixels → binary mask
            var mask = new Uint8Array(w * h);
            var hasMountain = false;
            for (var y = 0; y < h; y++) {
                for (var x = 0; x < w; x++) {
                    var i = (y * w + x) * 4;
                    var r = pixels[i], g = pixels[i+1], b = pixels[i+2], a = pixels[i+3];
                    // Mountain green: rgba(74, 140, 60, 0.7) on white background
                    // After compositing on white: R≈130-180, G≈170-210, B≈120-170
                    // Key: G is dominant, G > R, G > B, not too bright (not white)
                    var isGreen = g > 130 && g > r && g > b && r < 200 && b < 180 && a > 128;
                    // Also catch direct green strokes
                    var isDirectGreen = g > 100 && g > r * 1.2 && g > b * 1.2 && a > 128;
                    if (isGreen || isDirectGreen) {
                        mask[y * w + x] = 1;
                        hasMountain = true;
                    }
                }
            }

            if (!hasMountain) {
                console.log('🏔️ ScanBuilder: No mountain pixels found');
                return;
            }

            // Step 2: Distance Transform (Euclidean approximation)
            // For each mountain pixel, compute distance to nearest edge
            var dist = new Float32Array(w * h);
            var maxDist = 0;

            // Initialize: edge pixels = 0, interior = large
            for (var y = 0; y < h; y++) {
                for (var x = 0; x < w; x++) {
                    var idx = y * w + x;
                    if (mask[idx] === 0) {
                        dist[idx] = 0;
                    } else {
                        // Check if it's an edge pixel (has non-mountain neighbor)
                        var isEdge = false;
                        for (var dy = -1; dy <= 1 && !isEdge; dy++) {
                            for (var dx = -1; dx <= 1 && !isEdge; dx++) {
                                if (dx === 0 && dy === 0) continue;
                                var nx = x + dx, ny = y + dy;
                                if (nx < 0 || nx >= w || ny < 0 || ny >= h || mask[ny * w + nx] === 0) {
                                    isEdge = true;
                                }
                            }
                        }
                        dist[idx] = isEdge ? 1 : 9999;
                    }
                }
            }

            // Forward pass
            for (var y = 1; y < h; y++) {
                for (var x = 1; x < w - 1; x++) {
                    var idx = y * w + x;
                    if (mask[idx] === 0) continue;
                    dist[idx] = Math.min(dist[idx],
                        dist[(y-1)*w + x-1] + 1.414,
                        dist[(y-1)*w + x] + 1,
                        dist[(y-1)*w + x+1] + 1.414,
                        dist[y*w + x-1] + 1
                    );
                }
            }

            // Backward pass
            for (var y = h - 2; y >= 0; y--) {
                for (var x = w - 2; x >= 1; x--) {
                    var idx = y * w + x;
                    if (mask[idx] === 0) continue;
                    dist[idx] = Math.min(dist[idx],
                        dist[(y+1)*w + x+1] + 1.414,
                        dist[(y+1)*w + x] + 1,
                        dist[(y+1)*w + x-1] + 1.414,
                        dist[y*w + x+1] + 1
                    );
                    if (dist[idx] > maxDist) maxDist = dist[idx];
                }
            }

            if (maxDist < 1) return;

            // Step 3: Gaussian blur the distance field for smooth mountains
            var blurred = gaussianBlur(dist, w, h, 3);

            // Step 4: Apply to terrain heightmap
            var geo = window._arcadePlaneGeo || (window.G && window.G.planeGeo);
            if (!geo) { console.warn('ScanBuilder: No terrain geometry'); return; }

            var positions = geo.attributes.position.array;
            var segs = window.TERRAIN_SEGS || 600;
            var size = window.TERRAIN_SIZE || 900;
            var stride = segs + 1;
            var step = size / segs;
            var half = size / 2;

            // Map canvas coords to world coords
            // Canvas (0,0) → world (-half, -half), Canvas (w,h) → world (half, half)
            var maxHeight = 40; // Max mountain height in world units
            var applied = 0;

            // Collect clearance zones to keep tees/pins flat for golf mode.
            // Roads, race gates and checkpoints are excluded so roads climb mountains naturally
            // and setupRace snaps gates properly to the road surface.
            var clearanceZones = [];
            if (plan) {
                if (plan.holes) {
                    plan.holes.forEach(function(hole) {
                        if (hole.tee) clearanceZones.push({ type: 'point', x: hole.tee.x, z: hole.tee.z, radius: 20 });
                        if (hole.pin) clearanceZones.push({ type: 'point', x: hole.pin.x, z: hole.pin.z, radius: 25 });
                    });
                }
            }

            for (var gy = 0; gy <= segs; gy++) {
                for (var gx = 0; gx <= segs; gx++) {
                    var gi = gy * stride + gx;
                    var wx = positions[gi * 3];       // world X
                    var wz = -positions[gi * 3 + 1];  // world Z

                    // Map world → canvas pixel (fractional for bilinear interpolation)
                    var cx = (wx + half) / size * w;
                    var cy = (wz + half) / size * h;
                    if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;

                    var d = sampleBilinear(blurred, w, h, cx, cy);
                    if (d > 0) {
                        // Height scales with the actual width (d) instead of normalizing all peaks to maxHeight.
                        // Thin lines make gentle ridges; thick fills make tall mountains.
                        // S = 4 downsample, so d = 1 pixel represents ~4.5m in world coordinates.
                        // Scaling by 2.5 means height increases by ~2.5m per pixel of distance transform.
                        var height = Math.min(maxHeight, d * 2.5);

                        // Apply clearance fade factor
                        var fadeFactor = 1.0;
                        for (var i = 0; i < clearanceZones.length; i++) {
                            var cz = clearanceZones[i];
                            var distToZone = 99999;
                            if (cz.type === 'point') {
                                var dx = wx - cz.x;
                                var dz = wz - cz.z;
                                distToZone = Math.sqrt(dx * dx + dz * dz);
                            } else if (cz.type === 'segment') {
                                distToZone = getDistanceToSegment(wx, wz, cz.x1, cz.z1, cz.x2, cz.z2);
                            }
                            
                            if (distToZone < cz.radius) {
                                var f = distToZone / cz.radius;
                                var fSq = f * f; // quadratic fade for smooth transition
                                if (fSq < fadeFactor) fadeFactor = fSq;
                            }
                        }

                        height *= fadeFactor;
                        positions[gi * 3 + 2] += height;
                        applied++;
                    }
                }
            }

            if (applied > 0) {
                updateTerrainGeometry();
                console.log('🏔️ ScanBuilder: Built mountains (' + applied + ' vertices raised, maxDist=' + maxDist.toFixed(1) + ')');
            }
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
        window._smartRoadFoundation = false; // Lay road directly on terrain without sculpting (prevents spiky artifacts)
        window._smartRoadShoulder = 4;
        window._smartRoadBanking = 0; // 0 degree banking for natural terrain contouring
        window._smartRoadGradeDown = 0.75; // More generous downhill limit (75% grade)
        window._smartRoadGradeUp = 0.60;   // More generous uphill limit (60% grade)
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

        // Place CHECKPOINTS and build their meshes
        if (race.checkpoints && race.checkpoints.length > 0) {
            window.raceConfig.checkpoints = race.checkpoints.map(function(cp) {
                let snappedCp = snapToRoadIfNeeded(cp, 0) || cp;
                let cy = window.getTerrainHeight ? window.getTerrainHeight(snappedCp.x, snappedCp.z) : 0;
                return { x: snappedCp.x, y: cy, z: snappedCp.z, radius: cp.radius || 12 };
            });

            if (scene && window.THREE) {
                window.raceConfig.checkpoints.forEach(function(cp, i) {
                    try {
                        let ring = new THREE.Mesh(
                            new THREE.TorusGeometry((cp.radius || 12) * 0.5, 0.25, 8, 24),
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
            }
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
