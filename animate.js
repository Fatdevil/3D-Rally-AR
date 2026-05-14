    function animate() {
        requestAnimationFrame(animate);
        if (window.animateStars) window.animateStars(); // Star twinkle (external module)
        if (window.ParticleEngine) window.ParticleEngine.update(0.016); // Particle animation (external module)
        if (window.WindSway) window.WindSway.update(performance.now() * 0.001); // Wind sway
        if (window.AutumnLeaves) window.AutumnLeaves.update(0.016); // 3D falling leaves
        if (window.updateTracerFade) window.updateTracerFade(); // Tracer fade-out after landing

        // === FLAG CLOTH WAVE ===
        if (window._allFlagCloths && window._allFlagCloths.length > 0) {
            let t = performance.now() * 0.001;
            let windMph = window.currentWindMph || 0;
            let windStrength = Math.min(1.0, windMph / 25.0);
            // Wind direction → radians (flag blows AWAY from wind source)
            let windDirRad = ((window.currentWindDir || 0) + 180) * Math.PI / 180;
            // Base flutter even with no wind (flag always moves a little)
            let baseFlutter = 0.08;
            let totalStr = baseFlutter + windStrength * 0.6;
            
            for (let fi = 0; fi < window._allFlagCloths.length; fi++) {
                let cloth = window._allFlagCloths[fi];
                if (!cloth || !cloth.geometry) continue;
                
                // Rotate flag cloth around the pole to face wind direction
                // The cloth is positioned at (0.75, 5.5, 0) relative to group
                // We pivot the cloth around the pole (X=0) by adjusting parent rotation
                if (cloth.parent) {
                    // Smoothly interpolate rotation towards wind direction
                    let targetRot = windDirRad;
                    let currentRot = cloth.parent._flagWindRot || 0;
                    let diff = targetRot - currentRot;
                    // Normalize angle diff to [-PI, PI]
                    while (diff > Math.PI) diff -= 2 * Math.PI;
                    while (diff < -Math.PI) diff += 2 * Math.PI;
                    currentRot += diff * 0.02;  // Smooth lag
                    cloth.parent._flagWindRot = currentRot;
                    cloth.parent.rotation.y = currentRot;
                }
                
                let pos = cloth.geometry.attributes.position;
                let w = 1.5;  // cloth width
                
                // Cache original Y positions ONCE (from unmodified PlaneGeometry)
                if (!cloth.geometry._origY) {
                    cloth.geometry._origY = new Float32Array(pos.count);
                    for (let oi = 0; oi < pos.count; oi++) {
                        cloth.geometry._origY[oi] = pos.getY(oi);
                    }
                }
                
                // Gravity droop: flag hangs down when wind is calm
                // windLift: 0 = full droop (windstill), 1 = fully horizontal (strong wind)
                let windLift = Math.min(1.0, windMph / 12.0);  // Full horizontal at 12+ mph
                let maxDroop = -1.2;  // Max vertical droop at the tip (meters)
                
                for (let i = 0; i < pos.count; i++) {
                    let x = pos.getX(i);  // 0 = pole side, 1.5 = free edge
                    let xNorm = (x + w/2) / w;  // 0..1 from pole to tip
                    
                    // Wave flutter: more displacement at the free edge
                    let wave = Math.sin(t * 8.0 + xNorm * 4.0 + fi) * xNorm * xNorm * totalStr;
                    let wave2 = Math.sin(t * 12.5 + xNorm * 6.0 + fi * 2.3) * xNorm * xNorm * totalStr * 0.3;
                    pos.setZ(i, wave + wave2);
                    
                    // Gravity droop on Y-axis: quadratic curve from pole to tip
                    // At windstill: tip droops maxDroop, pole-side stays fixed
                    // At full wind: no droop (flag flies horizontal)
                    let droop = maxDroop * xNorm * xNorm * (1.0 - windLift);
                    // Add tiny idle sway even when drooping
                    droop += Math.sin(t * 2.0 + xNorm * 3.0) * xNorm * 0.03;
                    pos.setY(i, cloth.geometry._origY[i] + droop);
                }
                
                pos.needsUpdate = true;
            }
        }
        
        // Panning movement (WASD)
        if(moveDir) {
            // Farten justeras magiskt efter höjden! (Mer höjd = Snabbare kamera)
            let altOffset = Math.max(0, camera.position.y - 10); // Ingen boost under 10m
            let speed = 0.4 + (altOffset * 0.03); // Max speed limit
            if (speed > 15.0) speed = 15.0; // Sätt gräns så man inte flyger ut i oändligheten
            
            let forward = new THREE.Vector3();
            camera.getWorldDirection(forward);
            forward.y = 0;
            if(forward.lengthSq() > 0) forward.normalize();
            else forward.set(0,0,-1); // Fallback
            
            let right = new THREE.Vector3();
            right.crossVectors(forward, camera.up).normalize();
            
            let shift = new THREE.Vector3();
            if(moveDir === 'W') shift.copy(forward).multiplyScalar(speed);
            else if(moveDir === 'S') shift.copy(forward).multiplyScalar(-speed);
            else if(moveDir === 'A') shift.copy(right).multiplyScalar(-speed);
            else if(moveDir === 'D') shift.copy(right).multiplyScalar(speed);
            
            controls.target.add(shift);
            camera.position.add(shift);
        }
        
        controls.update();

        // --- GREEN BEADS + GRID VISUALIZATION (Trackman/GSPro style) ---
        // Activate when ball is within 50 yards of flag (not just putting mode)
        let showGreenViz = false;
        let vizHole = courseHoles[playingHoleIndex];
        if (vizHole && vizHole.flag && playState === 'ROUND_IDLE' && window.ballPos) {
            let dx = window.ballPos.x - vizHole.flag.x;
            let dz = window.ballPos.z - vizHole.flag.z;
            let distToFlag = Math.sqrt(dx*dx + dz*dz);
            showGreenViz = distToFlag < BEAD_ACTIVATION_DISTANCE;
        }
        
        if (showGreenViz) {
            let hole = vizHole;
            
            // --- BEADS (toggle: window.greenBeadsEnabled) ---
            if (window.greenBeadsEnabled) {
                if (window.greenBeads.length === 0) {
                    for(let x=-40; x<=40; x+=2.5) {
                        for(let z=-40; z<=40; z+=2.5) {
                            let bead = new THREE.Mesh(beadGeo, beadMat);
                            bead.startX = hole.flag.x + x;
                            bead.startZ = hole.flag.z + z;
                            bead.position.set(bead.startX, 0, bead.startZ);
                            bead.distOffset = Math.random(); 
                            greenBeadsGroup.add(bead);
                            window.greenBeads.push(bead);
                        }
                    }
                }
                
                let stimp = window.GREEN_STIMP || 10.0;
                let dt = 0.016; 
                
                for(let i=0; i<window.greenBeads.length; i++) {
                    let bead = window.greenBeads[i];
                    let surf = localGetTerrainAt(bead.position.x, -bead.position.z);
                    
                    if (surf && surf.type === 'GREEN') {
                        bead.visible = true;
                        bead.position.y = surf.z + 0.05; 
                        
                        let fallX = -surf.normal.x;
                        let fallZ = -surf.normal.z;
                        let slopeMag = Math.sqrt(fallX*fallX + fallZ*fallZ);
                        
                        if (slopeMag > 0.001) {
                            let dirX = fallX / slopeMag;
                            let dirZ = fallZ / slopeMag;
                            let speed = slopeMag * stimp * 2.0;
                            // BUG-07: Grass grain uses hole-index seed for per-hole variation.
                            // Multiplier 7.3 (irrational-ish) avoids visible repetition patterns.
                            let grainSeed = (typeof playingHoleIndex !== 'undefined') ? playingHoleIndex * 7.3 : 0;
                            let sx = Math.sin(bead.position.x * 0.3 + bead.position.z * 0.2 + grainSeed);
                            let sz = Math.cos(bead.position.z * 0.3 - bead.position.x * 0.2 + grainSeed);
                            let currentStimp = window.GREEN_STIMP || 10.0;
                            let grainScale = 0.03 * (10.0 / currentStimp);
                            let gl = Math.sqrt(sx*sx + sz*sz + 1e-6);
                            bead.position.x += (dirX * speed + (sx/gl) * grainScale * 25.0) * dt;
                            bead.position.z += (dirZ * speed + (sz/gl) * grainScale * 25.0) * dt;
                        } else {
                            // Flat green: grain only, seeded per hole
                            let grainSeed = (typeof playingHoleIndex !== 'undefined') ? playingHoleIndex * 7.3 : 0;
                            let sx = Math.sin(bead.position.x * 0.3 + bead.position.z * 0.2 + grainSeed);
                            let sz = Math.cos(bead.position.z * 0.3 - bead.position.x * 0.2 + grainSeed);
                            let currentStimp = window.GREEN_STIMP || 10.0;
                            let grainScale = 0.03 * (10.0 / currentStimp);
                            let gl = Math.sqrt(sx*sx + sz*sz + 1e-6);
                            bead.position.x += (sx / gl) * grainScale * 15.0 * dt;
                            bead.position.z += (sz / gl) * grainScale * 15.0 * dt;
                        }
                    } else {
                        bead.visible = false;
                    }
                    
                    let dX = bead.position.x - bead.startX;
                    let dZ = bead.position.z - bead.startZ;
                    let traveled = Math.sqrt(dX*dX + dZ*dZ);
                    if (traveled > (2.0 + bead.distOffset * 1.0)) {
                        bead.position.x = bead.startX;
                        bead.position.z = bead.startZ;
                    }
                }
            } else if (window.greenBeads.length > 0) {
                window.greenBeads.forEach(b => greenBeadsGroup.remove(b));
                window.greenBeads = [];
            }
            
            // --- GREEN GRID (BUG-01/04 FIX: Persistent mesh, visibility toggle only) ---
            // buildGreenGrid() is called once when ball lands on green (see landing callback).
            // Here we only sync visibility with the toggle switch.
            if (window.greenGridMesh) {
                window.greenGridMesh.visible = window.greenGridEnabled;
            } else if (window.greenGridEnabled) {
                // Fallback: build if somehow missing (e.g. first load with grid ON)
                window.buildGreenGrid(hole, playingHoleIndex);
                            window.buildBreakLine(); // Show putt break line
            }

            // --- GSPro Break Line Indicator (only in putting mode) ---
            if (window.breakLineMesh) {
                scene.remove(window.breakLineMesh);
                window.breakLineMesh = null;
            }
            if (window.isPuttingMode) {
                let aimDir = new THREE.Vector3().subVectors(controls.target, camera.position);
                aimDir.y = 0; aimDir.normalize();
                
                let bPoints = [new THREE.Vector3(window.ballMesh.position.x, window.ballMesh.position.y, window.ballMesh.position.z)];
                let bCur = { x: window.ballMesh.position.x, z: window.ballMesh.position.z };
                let bDir = aimDir.clone();
                for(let i=0; i<150; i++) {
                    let surf = localGetTerrainAt(bCur.x, -bCur.z);
                    if (!surf || surf.type !== 'GREEN') break;
                    let slopeForce = new THREE.Vector3(-surf.normal.x, 0, -surf.normal.z);
                    bDir.add(slopeForce.multiplyScalar(0.15));
                    
                    let sx = Math.sin(bCur.x * 0.3 + bCur.z * 0.2);
                    let sz = Math.cos(bCur.z * 0.3 - bCur.x * 0.2);
                    let currentStimp = window.GREEN_STIMP || 10.0;
                    let grainScale = 0.03 * (10.0 / currentStimp);
                    let gl = Math.sqrt(sx*sx + sz*sz + 1e-6);
                    bDir.add(new THREE.Vector3(sx/gl, 0, sz/gl).multiplyScalar(grainScale * 0.8));
                    bDir.normalize();
                    
                    bCur.x += bDir.x * 0.1;
                    bCur.z += bDir.z * 0.1;
                    bPoints.push(new THREE.Vector3(bCur.x, surf.z + 0.02, bCur.z));
                }
                let lineGeo = new THREE.BufferGeometry().setFromPoints(bPoints);
                let lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
                window.breakLineMesh = new THREE.Line(lineGeo, lineMat);
                scene.add(window.breakLineMesh);
            }

            // --- ELEVATION PROFILE (Tour de France style cross-section) ---
            let epContainer = document.getElementById('elevation-profile-container');
            let epCanvas = document.getElementById('elevation-canvas');
            if (epContainer && epCanvas && window.ballPos && hole && hole.flag) {
                epContainer.style.display = 'block';
                let ctx = epCanvas.getContext('2d');
                let W = 220, H = 80;
                
                // Sample terrain heights from ball to flag + 3m overshoot
                let bx = window.ballPos.x, bz = window.ballPos.z;
                let fx = hole.flag.x, fz = hole.flag.z;
                let totalDist = Math.sqrt((fx-bx)*(fx-bx) + (fz-bz)*(fz-bz));
                let overshoot = 3.0; // Show 3m past the flag
                let sampleDist = totalDist + overshoot;
                if (sampleDist < 1) sampleDist = 1;
                let dirX = (fx - bx) / (totalDist || 1);
                let dirZ = (fz - bz) / (totalDist || 1);
                
                let samples = [];
                let sampleStep = 0.25; // every 25cm
                let numSamples = Math.ceil(sampleDist / sampleStep);
                if (numSamples > 400) numSamples = 400;
                
                let minH = Infinity, maxH = -Infinity;
                for (let i = 0; i <= numSamples; i++) {
                    let d = i * sampleStep;
                    let sx = bx + dirX * d;
                    let sz = bz + dirZ * d;
                    let surf = localGetTerrainAt(sx, -sz);
                    let h = surf ? surf.z : 0;
                    samples.push({ d: d, h: h, isGreen: surf && surf.type === 'GREEN' });
                    if (h < minH) minH = h;
                    if (h > maxH) maxH = h;
                }
                
                // Exaggerate vertical range for visibility (min 0.05m range)
                let hRange = maxH - minH;
                if (hRange < 0.05) { hRange = 0.05; minH = (minH + maxH) / 2 - 0.025; maxH = minH + 0.05; }
                let padding = hRange * 0.15;
                minH -= padding;
                maxH += padding;
                hRange = maxH - minH;
                
                // Clear and draw
                ctx.clearRect(0, 0, W, H);
                
                // Draw filled gradient terrain profile
                let topMargin = 16; // Space for title
                let botMargin = 14; // Space for distance labels
                let drawH = H - topMargin - botMargin;
                
                let gradient = ctx.createLinearGradient(0, topMargin, 0, H - botMargin);
                gradient.addColorStop(0, 'rgba(76, 175, 80, 0.7)');  // Brighter green top
                gradient.addColorStop(1, 'rgba(27, 94, 32, 0.9)');   // Dark green bottom
                
                ctx.beginPath();
                ctx.moveTo(0, H - botMargin); // Bottom left
                for (let i = 0; i < samples.length; i++) {
                    let x = (samples[i].d / sampleDist) * W;
                    let y = topMargin + drawH * (1 - (samples[i].h - minH) / hRange);
                    if (i === 0) ctx.lineTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.lineTo(W, H - botMargin); // Bottom right
                ctx.closePath();
                ctx.fillStyle = gradient;
                ctx.fill();
                
                // Draw terrain outline
                ctx.beginPath();
                for (let i = 0; i < samples.length; i++) {
                    let x = (samples[i].d / sampleDist) * W;
                    let y = topMargin + drawH * (1 - (samples[i].h - minH) / hRange);
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = 'rgba(255,255,255,0.6)';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                
                // Flag position marker (vertical dashed line)
                let flagX = (totalDist / sampleDist) * W;
                let flagSurf = localGetTerrainAt(fx, -fz);
                let flagH = flagSurf ? flagSurf.z : 0;
                let flagY = topMargin + drawH * (1 - (flagH - minH) / hRange);
                
                ctx.beginPath();
                ctx.setLineDash([3, 3]);
                ctx.moveTo(flagX, topMargin);
                ctx.lineTo(flagX, H - botMargin);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.setLineDash([]);
                
                // Flag icon
                ctx.fillStyle = '#ef4444';
                ctx.fillRect(flagX - 1, flagY - 10, 2, 10);
                ctx.beginPath();
                ctx.moveTo(flagX + 1, flagY - 10);
                ctx.lineTo(flagX + 8, flagY - 7);
                ctx.lineTo(flagX + 1, flagY - 4);
                ctx.fillStyle = '#ef4444';
                ctx.fill();
                
                // Ball position dot
                let ballSurf = localGetTerrainAt(bx, -bz);
                let ballH = ballSurf ? ballSurf.z : 0;
                let ballY = topMargin + drawH * (1 - (ballH - minH) / hRange);
                ctx.beginPath();
                ctx.arc(0, ballY, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 1;
                ctx.stroke();
                
                // Height difference annotation
                let heightDiff = flagH - ballH;
                let diffText = (heightDiff >= 0 ? '▲' : '▼') + ' ' + Math.abs(heightDiff).toFixed(2) + 'm';
                let diffColor = heightDiff >= 0 ? '#f87171' : '#60a5fa';
                ctx.font = 'bold 9px Inter, sans-serif';
                ctx.fillStyle = diffColor;
                ctx.textAlign = 'center';
                ctx.fillText(diffText, flagX, topMargin + 10);
                
                // Distance label at bottom
                ctx.fillStyle = '#94a3b8';
                ctx.font = '8px Inter, sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('Ball', 2, H - 3);
                ctx.textAlign = 'center';
                ctx.fillText(totalDist.toFixed(1) + 'm', flagX, H - 3);
                ctx.textAlign = 'right';
                ctx.fillText('+' + overshoot.toFixed(0) + 'm', W - 2, H - 3);
            }

        } else {
            // Outside activation distance — cleanup all green viz
            if (window.greenBeads && window.greenBeads.length > 0) {
                window.greenBeads.forEach(b => greenBeadsGroup.remove(b));
                window.greenBeads = [];
            }
            if (window.breakLineMesh) {
                scene.remove(window.breakLineMesh);
                window.breakLineMesh = null;
            }
            // BUG-04 FIX: Do NOT destroy greenGridMesh when ball leaves 45m zone.
            // Grid is persistent until hole changes. Only hide it.
            if (window.greenGridMesh) {
                window.greenGridMesh.visible = false;
            }
            let epContainer = document.getElementById('elevation-profile-container');
            if (epContainer) epContainer.style.display = 'none';
        }

        applySculpting();

        // Om bollen flyger, hämta nästa punkt i trajectory
        if (isFlying && flightData && flightData.path && flightTick < flightData.path.length) {
            
            var now = performance.now();
            if (!window._flightStartTime) {
                window._flightStartTime = now;
                window._lastProcessedTick = 0;
                window._flightAccumMs = 0;
                window._lastFrameTime = now;
            }
            
            var frameDeltaMs = Math.min(now - (window._lastFrameTime || now), 50); // cap at 50ms
            window._lastFrameTime = now;
            
            // Determine playback speed based on ball phase
            // Flight + Bounce: 1x real-time (realistic), Roll: ramp up after 1.5s
            var speedMultiplier = 1.0;
            if (flightData.path[flightTick]) {
                let curPhase = flightData.path[flightTick].phase;
                if (curPhase === 'roll' || curPhase === 'skid') {
                    if (!window._rollStartTick) window._rollStartTick = flightTick;
                    // How long we've been rolling (in real playback ms)
                    let rollDurationMs = (flightTick - window._rollStartTick) * 5.0;
                    // Stay at 1x for first 3s, then skip to 3x
                    if (rollDurationMs > 3000) {
                        speedMultiplier = 3.0;
                    }
                }
            }
            
            window._flightAccumMs += frameDeltaMs * speedMultiplier;
            
            // Physics dt = 0.005s = 5ms per tick
            var newTick = Math.floor(window._flightAccumMs / 5.0);
            
            if (newTick >= flightData.path.length - 1) {
                newTick = flightData.path.length - 1;
                var pt = flightData.path[newTick];
                window.ballMesh.position.set(pt.x, pt.z + 0.0213, -pt.y);
            } else {
                var exactTick = window._flightAccumMs / 5.0;
                var t = exactTick - newTick; // Lerp factor 0.0 -> 1.0
                var p1 = flightData.path[newTick];
                var p2 = flightData.path[newTick + 1];
                
                var lerpX = p1.x + (p2.x - p1.x) * t;
                var lerpY = p1.y + (p2.y - p1.y) * t;
                var lerpZ = p1.z + (p2.z - p1.z) * t;
                
                window.ballMesh.position.set(lerpX, lerpZ + 0.0213, -lerpY);
            }
            
            for (let k = window._lastProcessedTick; k <= newTick; k++) {
                if (tracerPointsCount < MAX_TRACER_POINTS) {
                    let p = flightData.path[k];
                    tracerPositions[tracerPointsCount * 3] = p.x;
                    tracerPositions[tracerPointsCount * 3 + 1] = p.z + 0.0213;
                    tracerPositions[tracerPointsCount * 3 + 2] = -p.y;
                    
                    // Per-vertex color for gradient tracers
                    let style = window.TRACER_STYLES[window.currentTracerStyle || 'CLASSIC'];
                    if (style && style.vertexFn) {
                        let vc = window.getTracerVertexColor(style.vertexFn, tracerPointsCount, flightData.path.length);
                        if (vc) {
                            tracerColors[tracerPointsCount * 3] = vc[0];
                            tracerColors[tracerPointsCount * 3 + 1] = vc[1];
                            tracerColors[tracerPointsCount * 3 + 2] = vc[2];
                        }
                    }
                    tracerPointsCount++;
                }
            }
            window._lastProcessedTick = newTick + 1;

            // === AUDIO: Bounce sound on phase transition ===
            if (window.AudioEngine && flightData.path[newTick]) {
                let curPhase = flightData.path[newTick].phase;
                if (!window._lastFlightPhase) window._lastFlightPhase = 'flight';
                if (curPhase === 'bounce' && window._lastFlightPhase !== 'bounce') {
                    window.AudioEngine.playBounce();
                }
                window._lastFlightPhase = curPhase;
            }
            
            flightTracer.geometry.attributes.position.needsUpdate = true;
            if (flightTracer.geometry.attributes.color) flightTracer.geometry.attributes.color.needsUpdate = true;
            flightTracer.geometry.setDrawRange(0, tracerPointsCount);
            
            // Ball glow light follows ball position
            if (window.ballGlowLight) {
                window.ballGlowLight.position.copy(window.ballMesh.position);
            }
            
            // === UNIFIED FLIGHT CAMERA ===
            if (window.camFollowMode === 'FREE') {
                // Free cam: user controls via OrbitControls
            } else if (gameCamPhase === 'FLIGHT_FOLLOW') {
                let shotDir = new THREE.Vector3(0, 0, -1);
                if (window.aimTarget && window.shotStartPos) {
                    shotDir.subVectors(window.aimTarget, window.shotStartPos);
                    shotDir.y = 0;
                    if (shotDir.lengthSq() > 0.01) shotDir.normalize();
                }
                
                let targetCamPos = window.ballMesh.position.clone().sub(shotDir.clone().multiplyScalar(CAM.FLIGHT_BEHIND));
                targetCamPos.y = Math.max(CAM.FLIGHT_HEIGHT_MIN, window.ballMesh.position.y + 3);
                
                // Broadcast-style smooth follow (0.05 = gentle tracking, no jitter)
                camera.position.x += (targetCamPos.x - camera.position.x) * 0.05;
                camera.position.y += (targetCamPos.y - camera.position.y) * 0.05;
                camera.position.z += (targetCamPos.z - camera.position.z) * 0.05;
                
                // Smooth lookAt via lerped target (prevents rotation whiplash)
                if (!window._smoothLookTarget) window._smoothLookTarget = window.ballMesh.position.clone();
                window._smoothLookTarget.lerp(window.ballMesh.position, 0.08);
                camera.lookAt(window._smoothLookTarget);
            }
            
            // --- REAL-TIME HUD UPDATE ---
            if (window.shotStartPos && flightData.path[newTick]) {
                let curP = flightData.path[newTick];
                // shotStartPos is THREE.Vector3(physX, physHeight, -physY)
                // curP is physics: {x: physX, y: physY, z: physHeight}
                // Distance in XY plane (ground): dX = physX diff, dY = physY diff
                let dX = curP.x - window.shotStartPos.x;
                let dY = curP.y - (-window.shotStartPos.z); // physY_start = -shotStartPos.z
                let totalM = Math.sqrt(dX*dX + dY*dY);
                
                let elTotal = document.getElementById('hud-total');
                if (elTotal) elTotal.innerText = window.formatDistStr(totalM);
                
                let elCarry = document.getElementById('hud-carry');
                // Om bollen fortfarande flyger, uppdatera Carry. Annars stannar den på det värde den landade på!
                if (elCarry && curP.phase === 'flight') {
                    elCarry.innerText = window.formatDistStr(totalM);
                }
            }
            
            // COLLISION DETECTION! Krockar bollen med ett block?
            for(let i=0; i<targets.length; i++) {
                let t = targets[i];
                if(t.active) {
                    let d = window.ballMesh.position.distanceTo(t.mesh.position);
                    if(d < t.radius) {
                        t.active = false;
                        scene.remove(t.mesh); // PANG! Block försvinner.
                        
                        points += 500;
                        
                        // Popp-effekt
                        let pop = document.getElementById('score-popup');
                        pop.style.opacity = '1';
                        pop.style.transform = 'translate(-50%, -50%) scale(1)';
                    }
                }
            }
            
            flightTick = newTick;
            
            if (flightTick === flightData.path.length - 1) {
                isFlying = false; // Bollen har stannat
                // Start tracer fade-out (if FADE mode enabled)
                if (window.startTracerFade) window.startTracerFade();
                
                // --- UPPDATERA CARRY/TOTAL I HUD ---
                if (window.shotStartPos) {
                    let finalPhys = flightData.path[flightData.path.length-1];
                    // shotStartPos is THREE.Vector3(physX, physHeight, -physY)
                    // finalPhys is physics: {x: physX, y: physY, z: physHeight}
                    let dX = finalPhys.x - window.shotStartPos.x;
                    let dY = finalPhys.y - (-window.shotStartPos.z); // physY_start = -shotStartPos.z
                    
                    let totalM = Math.sqrt(dX*dX + dY*dY);
                    let carryM = (flightData.metrics.carryMeters || 0);
                    
                    // Sanity: total should never be less than carry
                    if (totalM < carryM) totalM = carryM;
                    
                    if (document.getElementById('hud-carry')) {
                        document.getElementById('hud-carry').innerText = window.formatDistStr(carryM);
                        if (document.getElementById('hud-carryraw')) document.getElementById('hud-carryraw').innerText = window.formatDistStr(carryM);
                        if (document.getElementById('hud-total')) document.getElementById('hud-total').innerText = window.formatDistStr(totalM); 
                        
                        let offPath = Math.abs(finalPhys.x - window.shotStartPos.x);
                        if (document.getElementById('hud-offline')) document.getElementById('hud-offline').innerText = window.formatDistStr(offPath);
                    }
                }
                
                if (playState === 'ROUND_FLYING') {
                    playState = 'ROUND_IDLE';
                    
                    // RANGE MODE: Reset ball to tee after each shot
                    if (window._isRangeMode && courseHoles[0] && courseHoles[0].tees && courseHoles[0].tees.range) {
                        let rangeTee = courseHoles[0].tees.range;
                        window.ballPos.x = rangeTee.x;
                        window.ballPos.y = rangeTee.y + 0.2;
                        window.ballPos.z = rangeTee.z;
                        window.ballMesh.position.set(window.ballPos.x, window.ballPos.y, window.ballPos.z);
                        window.ballMesh.visible = true;
                        
                        // Reset camera behind tee, looking along range direction
                        let dir = rangeTee.rot || 0;
                        let behindDist = 12, lookAheadDist = 30;
                        camera.position.set(
                            window.ballPos.x - Math.sin(dir) * behindDist,
                            window.ballPos.y + 3,
                            window.ballPos.z - Math.cos(dir) * behindDist
                        );
                        controls.target.set(
                            window.ballPos.x + Math.sin(dir) * lookAheadDist,
                            window.ballPos.y,
                            window.ballPos.z + Math.cos(dir) * lookAheadDist
                        );
                        controls.update();
                        
                        // Reset aim target along range direction
                        if (window.aimTarget) {
                            window.aimTarget.set(
                                rangeTee.x + Math.sin(dir) * 200,
                                rangeTee.y,
                                rangeTee.z + Math.cos(dir) * 200
                            );
                        }
                    } else {
                        // COURSE MODE: Ball stays where it landed
                        window.ballPos.x = window.ballMesh.position.x;
                        window.ballPos.y = window.ballMesh.position.y;
                        window.ballPos.z = window.ballMesh.position.z;
                    }
                    
                    if (document.getElementById('play-tools')) document.getElementById('play-tools').style.display = 'flex';
                    let hole = courseHoles[playingHoleIndex];
                    let distToPin = 999;
                    if(hole && hole.flag) {
                        distToPin = window.ballMesh.position.distanceTo(new THREE.Vector3(hole.flag.x, hole.flag.y, hole.flag.z));
                        
                        // --- BUG-04 FIX: Build green grid ONCE on landing, not in animate loop ---
                        let landSurf = localGetTerrainAt(window.ballMesh.position.x, -window.ballMesh.position.z);
                        
                        // === WATER HAZARD & OB AUTO-DETECTION ===
                        let finalTerrain = flightData && flightData.metrics ? flightData.metrics.finalTerrainType : (landSurf ? landSurf.type : 'FAIRWAY');
                        let p = window.players[window.activePlayerIndex];
                        let entryPoint = null;
                        if (flightData && flightData.positions) {
                            for (let fi = flightData.positions.length - 1; fi >= 0; fi--) {
                                let fp = flightData.positions[fi];
                                let fSurf = localGetTerrainAt(fp.x, -fp.z);
                                if (fSurf && fSurf.type !== 'WATER') { entryPoint = {x: fp.x, y: fp.y, z: fp.z}; break; }
                            }
                        }
                        if (!entryPoint) entryPoint = p.teePosition || p.lie;
                        let prevLie = p.teePosition || p.lie;
                        
                        if (landSurf && landSurf.type === 'GREEN') {
                            window.buildGreenGrid(hole, playingHoleIndex);
                        }
                        
                        if (landSurf && landSurf.type === 'GREEN') {
                            let norm = localGetNormalAt(window.ballMesh.position.x, -window.ballMesh.position.z);
                            console.log('Green Landing Normal:', norm.x.toFixed(3), norm.y.toFixed(3), norm.z.toFixed(3));
                        }
                        
                        // ==========================================
                        // GOLF OS CORE ENGINE: SCORING & RULES (FAS 2/3)
                        // ==========================================
                        if (playState === 'ROUND_IDLE') {
                            let isHoled = flightData.metrics && flightData.metrics.holed;
                            let isGreen = landSurf && landSurf.type === 'GREEN';
                            let isFringe = landSurf && (landSurf.type === 'FAIRWAY' || landSurf.type === 'SEMI-ROUGH') && distToPin < 5.0;
                            let distFt = distToPin * 3.28084;
                            let holePar = hole ? (hole.par || 4) : 4;
                            
                            if (window.matchSettings) window.GolfEngine.updateSettings(window.matchSettings);
                        window.GolfEngine.handleShotResult(p, distFt, isGreen, isFringe, isHoled, holePar, finalTerrain, entryPoint, prevLie);
                        
                        flightData = {};
                    }
                } else {
                    // ARCADE MODE: Klassisk reset efter 2 sekunder
                    setTimeout(() => {
                        controls.enabled = true; // Lås upp igen!
                        camera.position.set(0, 4, 10);
                        controls.target.set(0, 0, -20);
                        controls.update();
                    }, 500);
                }
            }
        }

        // === UNIFIED AIM CAMERA (runs when NOT flying) ===
        if (!isFlying && window.camFollowMode === 'AUTO' && (gameCamPhase === 'IDLE_AIM' || gameCamPhase === 'PUTT_AIM') && playState === 'ROUND_IDLE' && window.aimTarget) {
            if (landingSettleTimer > 0) {
                landingSettleTimer--;
                // During settle: smooth lerp to aim position
            }
            let isPutt = gameCamPhase === 'PUTT_AIM';
            let camH = isPutt ? CAM.PUTT_HEIGHT : CAM.AIM_HEIGHT;
            let camD = isPutt ? CAM.PUTT_DISTANCE : CAM.AIM_DISTANCE;
            
            let aimDir = new THREE.Vector3().subVectors(window.aimTarget, window.ballMesh.position).normalize();
            if (aimDir.lengthSq() < 0.01) aimDir.set(0, 0, -1);
            
            let targetPos = window.ballMesh.position.clone().add(
                new THREE.Vector3(-aimDir.x * camD, camH, -aimDir.z * camD)
            );
            
            camera.position.x += (targetPos.x - camera.position.x) * CAM.AIM_LERP;
            camera.position.y += (targetPos.y - camera.position.y) * CAM.AIM_LERP;
            camera.position.z += (targetPos.z - camera.position.z) * CAM.AIM_LERP;
            controls.target.copy(window.aimTarget);
            controls.enabled = true;
        }

        // === HOLE FLYOVER CAMERA ===
        if (gameCamPhase === 'HOLE_FLYOVER') {
            flyoverProgress++;
            let t = Math.min(flyoverProgress / flyoverDuration, 1.0);
            // Smooth ease-in-out
            let ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            
            // Interpolate along terrain-following waypoints
            let path = window._flyoverPath;
            if (path && path.length > 1) {
                let pathPos = ease * (path.length - 1);
                let idx = Math.min(Math.floor(pathPos), path.length - 2);
                let frac = pathPos - idx;
                
                // Smooth sub-segment interpolation
                camera.position.lerpVectors(path[idx], path[idx + 1], frac);
                
                // Smooth look target: interpolate where we're looking (no jumps)
                let lookIdx = Math.min(idx + 4, path.length - 1);
                let rawLookTarget = path[lookIdx].clone();
                
                // In last 20% of flyover, transition look target to flag
                if (t > 0.8) {
                    let hole = courseHoles[playingHoleIndex];
                    if (hole && hole.flag) {
                        let flagTarget = new THREE.Vector3(hole.flag.x, hole.flag.y || 0, hole.flag.z);
                        let blendToFlag = (t - 0.8) / 0.2;
                        rawLookTarget.lerp(flagTarget, blendToFlag);
                    }
                }
                
                // Smoothly lerp the look target (eliminates rotation jitter)
                if (!window._flyoverSmoothLook) window._flyoverSmoothLook = rawLookTarget.clone();
                window._flyoverSmoothLook.lerp(rawLookTarget, 0.06); // 6% per frame = butter smooth
                camera.lookAt(window._flyoverSmoothLook);
            }
            
            // Done? Settle camera behind ball in aim position
            if (t >= 1.0) {
                gameCamPhase = 'IDLE_AIM';
                controls.enabled = true;
                
                // Position camera behind ball, looking at aim target
                let hole = courseHoles[playingHoleIndex];
                if (hole && hole.flag && window.ballMesh) {
                    let aimDir = new THREE.Vector3(
                        hole.flag.x - window.ballMesh.position.x,
                        0,
                        hole.flag.z - window.ballMesh.position.z
                    ).normalize();
                    camera.position.set(
                        window.ballMesh.position.x - aimDir.x * 5,
                        window.ballMesh.position.y + 2,
                        window.ballMesh.position.z - aimDir.z * 5
                    );
                    controls.target.copy(window.ballMesh.position);
                    controls.target.y += 0.5;
                    controls.update();
                }
                
                // Hide HUD
                let hud = document.getElementById('flyover-hud');
                if (hud) hud.style.display = 'none';
            }
        }

        // === WIND-DRIVEN WATER WAVES ===
        {
            let wArr = waterGeo.attributes.position.array;
            let windMph = window.currentWindMph || 0;
            let windRad = (window.currentWindDir || 0) * Math.PI / 180;
            let amp = Math.min(windMph * 0.004, 0.15);  // Wave height from wind (capped)
            let t = performance.now() * 0.001;
            
            if (amp > 0.001) {
                let wdx = Math.cos(windRad);
                let wdy = Math.sin(windRad);
                for (let i = 0; i < wArr.length; i += 3) {
                    let baseZ = window.waterBaseZ[i / 3];
                    if (baseZ > -90) { // Only animate visible water
                        let phase = wArr[i] * wdx + wArr[i + 1] * wdy;
                        wArr[i + 2] = baseZ + Math.sin(t * 2.5 + phase * 0.3) * amp;
                    }
                }
                waterGeo.attributes.position.needsUpdate = true;
            }
        }

        renderer.clear();
        renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
        renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);
        
        // --- GSPRO AIM BILLBOARD PROJECTION ---
        let bb = document.getElementById('aim-billboard');
        if ((appMode === 'PLAY' || appMode === 'TEST') && playState === 'ROUND_IDLE' && window.aimTarget) {
            bb.style.display = 'block';
            let pos = window.aimTarget.clone();
            pos.project(camera);
            
            // Endast om framför kameran
            if (pos.z < 1) {
                let x = (pos.x * .5 + .5) * window.innerWidth;
                let y = (pos.y * -.5 + .5) * window.innerHeight;
                bb.style.left = x + 'px';
                bb.style.top = (y - 30) + 'px'; // Sväva strax ovanför
                
                // Uppdatera info
                let hole = courseHoles[playingHoleIndex];
                let dist = window.ballMesh.position.distanceTo(window.aimTarget);
                let elevDiff = window.aimTarget.y - window.ballMesh.position.y;
                document.getElementById('aim-bb-dist').innerText = (dist * 1.09361).toFixed(0); 
                document.getElementById('aim-bb-elev').innerText = Math.abs(elevDiff * 1.09361).toFixed(1) + 'y';
                document.getElementById('aim-bb-arrow').innerText = elevDiff > 0 ? '▲' : '▼';
                document.getElementById('aim-bb-arrow').style.color = elevDiff > 0 ? '#4ade80' : '#f87171'; // Grön upp, Röd ner
            } else {
                bb.style.display = 'none';
            }
        } else {
            if(bb) bb.style.display = 'none';
        }
        
        // --- LIE & CONDITIONS HUD ---
        let lieHud = document.getElementById('lie-conditions-hud');
        if ((appMode === 'PLAY' || appMode === 'TEST') && playState === 'ROUND_IDLE') {
            try {
                if(lieHud) lieHud.style.display = 'block';
                if (typeof localGetTerrainAt === 'function') {
                    let surf = localGetTerrainAt(window.ballMesh.position.x, -window.ballMesh.position.z);
                    let isTee = (window.players && window.players[window.activePlayerIndex] && window.players[window.activePlayerIndex].strokes === 0);
                    
                    let lType = isTee ? 'FAIRWAY' : (surf ? (surf.type || 'FAIRWAY') : 'FAIRWAY');
                    
                    // Expose surface to SwingEngine.autoSelectClub — updated every frame.
                    // Without this, currentBallSurface is always undefined and the
                    // GREEN override in autoSelectClub never fires.
                    window.currentBallSurface = lType;
                    
                    if (document.getElementById('lie-text')) {
                        document.getElementById('lie-text').innerText = isTee ? 'TEE' : lType;
                    }
                    
                    let iconCol = '#16a34a'; // Fairway
                    if (lType === 'WATER') iconCol = '#38bdf8';
                    else if (lType === 'SAND' || lType === 'WASTE') iconCol = '#fcd34d';
                    else if (lType === 'DEEP ROUGH') iconCol = '#14532d';
                    else if (lType === 'ROUGH') iconCol = '#15803d';
                    else if (lType === 'SEMI-ROUGH') iconCol = '#22c55e';
                    else if (lType === 'OB') iconCol = '#ef4444';
                    else iconCol = '#4ade80'; // Tee / Green
                    
                    if (document.getElementById('lie-icon')) {
                        document.getElementById('lie-icon').style.background = iconCol;
                    }
                    
                    let powStr = "100%"; let spinStr = "100%"; let powCol = "#4ade80";
                    if (!isTee) {
                        if (lType === 'ROUGH') { powStr = "85 - 95%"; spinStr = "60 - 70%"; powCol = "#fbbf24"; }
                        else if (lType === 'DEEP ROUGH') { powStr = "75 - 90%"; spinStr = "40 - 60%"; powCol = "#f87171"; }
                        else if (lType === 'SEMI-ROUGH') { powStr = "95 - 98%"; spinStr = "85 - 95%"; }
                        else if (lType === 'SAND' || lType === 'WASTE') { powStr = "80 - 95%"; spinStr = "40 - 60%"; powCol = "#fbbf24"; }
                    }
                    
                    if (document.getElementById('lie-power')) document.getElementById('lie-power').innerText = powStr;
                    if (document.getElementById('lie-power')) document.getElementById('lie-power').style.color = powCol;
                    if (document.getElementById('lie-spin')) document.getElementById('lie-spin').innerText = spinStr;
                    let spinCol = powCol;
                    if (document.getElementById('lie-spin')) document.getElementById('lie-spin').style.color = spinCol;
                }
                
                if (window.aimTarget && document.getElementById('lie-distance')) {
                    let dX = window.aimTarget.x - window.ballMesh.position.x;
                    let dZ = window.aimTarget.z - window.ballMesh.position.z;
                    let distYds = Math.sqrt(dX*dX + dZ*dZ) * 1.09361;
                    document.getElementById('lie-distance').innerText = distYds.toFixed(1) + " yds";
                    
                    let elevDistM = window.aimTarget.y - window.ballMesh.position.y;
                    let sign = elevDistM > 0 ? "+" : (elevDistM < 0 ? "-" : "");
                    document.getElementById('lie-elevation').innerText = sign + Math.abs(elevDistM).toFixed(1) + "m";
                }
            } catch (e) {
                console.error("[Lie HUD Error]:", e);
            }
        } else {
            if(lieHud) lieHud.style.display = 'none';
        }

        // --- THE GSPRO MINIMAP PASS ---
        let mapCont = document.getElementById('minimap-container');
        if ((appMode === 'PLAY' || appMode === 'TEST') && (playState === 'ROUND_IDLE' || playState === 'ROUND_FLYING')) {
            if (mapCont) mapCont.style.display = 'block';
            let mapW = 220; let mapH = 340;
            // GSPro karta i nedre högra hörnet = window.innerWidth - mapW - 20
            let mX = window.innerWidth - mapW - 20; 
            let mY = 20; 
            
            renderer.setViewport(mX, mY, mapW, mapH);
            renderer.setScissor(mX, mY, mapW, mapH);
            // Eftersom vi satt scissorTest = true förut, rensar detta bart minikartan!
            let oldClearColor = renderer.getClearColor(new THREE.Color());
            renderer.setClearColor(0x0f172a, 1.0); // Mörkblå bakgrund
            renderer.clear(true, true, false);
            
            let hole = courseHoles[playingHoleIndex];
            // Range mode: use aimTarget as virtual flag (no real flag exists)
            let flagTarget = null;
            if (hole && hole.flag) {
                flagTarget = new THREE.Vector3(hole.flag.x, hole.flag.y, hole.flag.z);
            } else if (window._isRangeMode && window.aimTarget) {
                flagTarget = window.aimTarget.clone();
            }
            if (flagTarget) {
                let fv = flagTarget;
                let dist = window.ballMesh.position.distanceTo(fv);
                
                // Direction: ball → flag/aim (= "up" in minimap)
                let dir = new THREE.Vector3().subVectors(fv, window.ballMesh.position);
                dir.y = 0; dir.normalize();
                
                if (window._isRangeMode) {
                    // === RANGE MODE: Fixed camera, tee at bottom ===
                    // Camera centered on ball (tee), looking straight down
                    minimapCamera.position.set(window.ballMesh.position.x, 300, window.ballMesh.position.z);
                    
                    // Asymmetric frustum: 90% forward, 10% behind tee
                    let rangeView = Math.max(dist, 250); // At least 250m visible
                    let behindTee = 25; // Small margin behind tee
                    let aspect = 220 / 340; // minimap aspect ratio
                    let halfWidth = (rangeView + behindTee) * aspect / 2;
                    
                    minimapCamera.top = rangeView;       // Lots of space forward
                    minimapCamera.bottom = -behindTee;    // Minimal space behind tee
                    minimapCamera.left = -halfWidth;
                    minimapCamera.right = halfWidth;
                    
                    // Shift camera forward so tee sits at very bottom
                    minimapCamera.position.add(dir.clone().multiplyScalar((rangeView - behindTee) / 2));
                } else {
                    // === COURSE MODE: Dynamic framing (existing behavior) ===
                    minimapCamera.position.set((window.ballMesh.position.x + fv.x)/2, 300, (window.ballMesh.position.z + fv.z)/2);
                    
                    let offsetDist = dist * 0.15 + 15;
                    minimapCamera.position.sub(dir.clone().multiplyScalar(offsetDist));
                    
                    let pad = 20 + offsetDist;
                    minimapCamera.left = -(dist/2 + pad); 
                    minimapCamera.right = (dist/2 + pad);
                    minimapCamera.top = (dist/2 + pad) / 0.64;
                    minimapCamera.bottom = -(dist/2 + pad) / 0.64;
                }
                
                minimapCamera.updateProjectionMatrix();
                minimapCamera.up.set(dir.x, 0, dir.z);
                minimapCamera.lookAt(minimapCamera.position.x, 0, minimapCamera.position.z);
                
                // --- KARTA UI (Yards & Grader) ---
                if (window.aimTarget) {
                    let dX = window.aimTarget.x - window.ballMesh.position.x;
                    let dZ = window.aimTarget.z - window.ballMesh.position.z;
                    let flatD = Math.sqrt(dX*dX + dZ*dZ);
                    let dY = window.aimTarget.y - window.ballMesh.position.y;
                    
                    let degUp = (Math.atan2(dY, flatD) * 180 / Math.PI).toFixed(1);
                    document.getElementById('minimap-updown').innerText = Math.abs(degUp) + (degUp >= 0 ? "° UP" : "° DN");
                    
                    // Left/Right? Eftersom kameran följer Siktet är vi alltid 0.0°!
                    document.getElementById('minimap-leftright').innerText = "0.0° RIGHT";
                    
                    if (typeof localGetTerrainAt === 'function') {
                        let surf = localGetTerrainAt(window.aimTarget.x, -window.aimTarget.z);
                        if (surf) document.getElementById('minimap-lie-text').innerText = surf.type || 'Fairway';
                    }
                }
            }
            let oldMat = plane.material;
            
            if (window.minimapMat && window.heatmapShaderRef) {
                window.heatmapShaderRef.uniforms.uFlagHeight.value = (hole && hole.flag) ? hole.flag.y : 0.0;
                
                // Måste se till att maskreferensen lever
                if (window.heatmapShaderRef.uniforms.tGreenMask.value !== window.greenMaskTex) {
                    window.heatmapShaderRef.uniforms.tGreenMask.value = window.greenMaskTex;
                }
                
                plane.material = window.minimapMat;
            }
            
            // Ritning av Line Overlay (Ball -> Target -> Flag)
            if (window.aimTarget && hole && hole.flag && document.getElementById('mm-line-1')) {
                let fv = new THREE.Vector3(hole.flag.x, hole.flag.y, hole.flag.z);
                let pB = window.ballMesh.position.clone().project(minimapCamera);
                let pA = window.aimTarget.clone().project(minimapCamera);
                let pF = fv.clone().project(minimapCamera);
                
                // Transformera från NDS [-1, 1] till Pixel Coordinates [0, 220] & [0, 340]
                let toX = (v) => (v.x * 0.5 + 0.5) * 220;
                let toY = (v) => (-v.y * 0.5 + 0.5) * 340;
                
                let bx = toX(pB), by = toY(pB);
                let ax = toX(pA), ay = toY(pA);
                let fx = toX(pF), fy = toY(pF);
                
                document.getElementById('mm-line-1').setAttribute('x1', bx);
                document.getElementById('mm-line-1').setAttribute('y1', by);
                document.getElementById('mm-line-1').setAttribute('x2', ax);
                document.getElementById('mm-line-1').setAttribute('y2', ay);
                document.getElementById('mm-line-2').setAttribute('x1', ax);
                document.getElementById('mm-line-2').setAttribute('y1', ay);
                document.getElementById('mm-line-2').setAttribute('x2', fx);
                document.getElementById('mm-line-2').setAttribute('y2', fy);
                document.getElementById('mm-dot-target').setAttribute('cx', ax);
                document.getElementById('mm-dot-target').setAttribute('cy', ay);
                
                let dT = document.getElementById('mm-dist-target');
                let dF = document.getElementById('mm-dist-flag');
                dT.style.display = 'block';
                dF.style.display = 'block';
                
                dT.innerText = window.formatDistStr(window.ballMesh.position.distanceTo(window.aimTarget), 0);
                dF.innerText = window.formatDistStr(window.aimTarget.distanceTo(fv), 0);
                
                dT.style.left = ((bx+ax)/2 + 20) + 'px';
                dT.style.top = ((by+ay)/2) + 'px';
                dF.style.left = ((ax+fx)/2 + 20) + 'px';
                dF.style.top = ((ay+fy)/2) + 'px';
            }
            
            // depth är redan rensat via clear() ovan
            renderer.render(scene, minimapCamera);
            
            plane.material = oldMat; // Återställ markens material
            renderer.setClearColor(oldClearColor, 1.0); // Återställ clear color ifall den används på andra ställen
        } else {
            if (mapCont) mapCont.style.display = 'none';
        }
    }
    
    // LM Bridge extracted to arcade-lm-bridge.js (self-booting IIFE)

    
    // Initialize auth (Device ID) before loading level
    if (window.GolfAuth) {
        window.GolfAuth.init().then(() => {
            console.log('🔑 Auth initialized, loading level...');
            loadLevel();
        }).catch(() => {
            console.warn('Auth init failed, loading level anyway...');
            loadLevel();
        });