// ============================================================
// rally-vehicle.js — Rally Vehicle Controller for 3D-Rally-AR
// Phase 1: Box car + keyboard/gamepad + terrain following
// ============================================================

(function() {
    'use strict';

    // ─────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────
    const CFG = {
        MAX_SPEED:      50,     // m/s (~180 km/h)
        ACCELERATION:   18,     // m/s²
        BRAKE_FORCE:    30,     // m/s²
        REVERSE_MAX:    12,     // m/s (~43 km/h)
        DRAG:           0.98,   // air drag per frame
        STEER_SPEED:    2.2,    // radians/s at low speed
        STEER_FALLOFF:  0.4,    // steering reduces at high speed (min multiplier)
        GRAVITY:        19.6,   // m/s² (slightly exaggerated for fun)
        CAR_HEIGHT:     0.35,   // center of car above ground
        WHEEL_SPIN_RATE: 0.15,  // visual wheel rotation speed

        // Camera
        CAM_BEHIND:     10,
        CAM_HEIGHT:     4.5,
        CAM_LOOK_AHEAD: 15,
        CAM_SMOOTH:     0.06,

        // Surface friction table (biome → grip multiplier)
        SURFACE_GRIP: {
            'FAIRWAY':    1.0,
            'TEE':        1.0,
            'GREEN':      0.95,
            'FOREGREEN':  0.95,
            'SEMI-ROUGH': 0.7,
            'ROUGH':      0.5,
            'DEEP ROUGH': 0.35,
            'SAND':       0.3,
            'WASTE':      0.35,
            'WATER':      0.1,
            'OB':         0.0
        },
        SURFACE_MAX_SPEED: {
            'FAIRWAY':    1.0,
            'TEE':        1.0,
            'GREEN':      0.95,
            'FOREGREEN':  0.95,
            'SEMI-ROUGH': 0.78,
            'ROUGH':      0.55,
            'DEEP ROUGH': 0.45,
            'SAND':       0.33,
            'WASTE':      0.38,
            'WATER':      0.15,
            'OB':         0.0
        }
    };

    // ─────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────
    let car = {
        position:  new THREE.Vector3(0, 2, 0),
        velocity:  new THREE.Vector3(0, 0, 0),
        heading:   0,           // radians — direction car faces (yaw)
        speed:     0,           // scalar m/s (signed: negative = reverse)
        onGround:  true,
        surfaceType: 'ROUGH',
        grip:      0.5,
        mesh:      null,
        wheels:    [],
        active:    false
    };

    let input = {
        throttle:  0,   // 0-1
        brake:     0,   // 0-1
        steer:     0,   // -1 (left) to 1 (right)
        handbrake: false
    };

    let keys = {};
    let lastTime = 0;
    let chaseCamTarget = new THREE.Vector3();
    let chaseCamLookAt = new THREE.Vector3();

    // ─────────────────────────────────────────────
    // CAR MESH (low-poly box car)
    // ─────────────────────────────────────────────
    function createCarMesh() {
        let group = new THREE.Group();
        group.name = 'RallyCar';

        // Body
        let bodyGeo = new THREE.BoxGeometry(2.0, 0.55, 4.2);
        let bodyMat = new THREE.MeshLambertMaterial({ color: 0xdc2626 }); // Rally red
        let body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.35;
        body.castShadow = true;
        group.add(body);

        // Roof / cabin
        let roofGeo = new THREE.BoxGeometry(1.6, 0.45, 1.8);
        let roofMat = new THREE.MeshLambertMaterial({ color: 0xb91c1c });
        let roof = new THREE.Mesh(roofGeo, roofMat);
        roof.position.set(0, 0.85, -0.3);
        roof.castShadow = true;
        group.add(roof);

        // Windshield (dark glass)
        let windGeo = new THREE.BoxGeometry(1.5, 0.4, 0.05);
        let windMat = new THREE.MeshLambertMaterial({ color: 0x1e293b, transparent: true, opacity: 0.7 });
        let windshield = new THREE.Mesh(windGeo, windMat);
        windshield.position.set(0, 0.82, 0.6);
        windshield.rotation.x = -0.25;
        group.add(windshield);

        // Rear window
        let rearWind = windshield.clone();
        rearWind.position.set(0, 0.82, -1.2);
        rearWind.rotation.x = 0.2;
        group.add(rearWind);

        // Headlights
        let lightGeo = new THREE.BoxGeometry(0.35, 0.15, 0.05);
        let lightMat = new THREE.MeshBasicMaterial({ color: 0xfef08a }); // Warm yellow
        [-0.6, 0.6].forEach(x => {
            let light = new THREE.Mesh(lightGeo, lightMat);
            light.position.set(x, 0.35, 2.13);
            group.add(light);
        });

        // Tail lights
        let tailMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
        [-0.6, 0.6].forEach(x => {
            let tail = new THREE.Mesh(lightGeo, tailMat);
            tail.position.set(x, 0.35, -2.13);
            group.add(tail);
        });

        // Rally number plate (white square on side)
        let platGeo = new THREE.BoxGeometry(0.05, 0.4, 0.5);
        let platMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        [-1.02, 1.02].forEach(x => {
            let plate = new THREE.Mesh(platGeo, platMat);
            plate.position.set(x, 0.45, 0);
            group.add(plate);
        });

        // Roof light bar (rally style)
        let barGeo = new THREE.BoxGeometry(1.8, 0.08, 0.15);
        let barMat = new THREE.MeshLambertMaterial({ color: 0x334155 });
        let bar = new THREE.Mesh(barGeo, barMat);
        bar.position.set(0, 1.12, -0.1);
        group.add(bar);

        // Light pods on roof bar
        let podGeo = new THREE.BoxGeometry(0.2, 0.12, 0.12);
        let podMat = new THREE.MeshBasicMaterial({ color: 0xfef9c3 });
        [-0.6, -0.2, 0.2, 0.6].forEach(x => {
            let pod = new THREE.Mesh(podGeo, podMat);
            pod.position.set(x, 1.2, -0.1);
            group.add(pod);
        });

        // Wheels
        car.wheels = [];
        let wheelPositions = [
            { x: -0.95, z:  1.3 },  // Front Left
            { x:  0.95, z:  1.3 },  // Front Right
            { x: -0.95, z: -1.3 },  // Rear Left
            { x:  0.95, z: -1.3 }   // Rear Right
        ];

        wheelPositions.forEach(wp => {
            let wheelGroup = new THREE.Group();

            // Tire
            let tireGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10);
            let tireMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
            let tire = new THREE.Mesh(tireGeo, tireMat);
            tire.rotation.z = Math.PI / 2;
            tire.castShadow = true;
            wheelGroup.add(tire);

            // Rim
            let rimGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.24, 6);
            let rimMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });
            let rim = new THREE.Mesh(rimGeo, rimMat);
            rim.rotation.z = Math.PI / 2;
            wheelGroup.add(rim);

            wheelGroup.position.set(wp.x, 0.0, wp.z);
            group.add(wheelGroup);
            car.wheels.push(wheelGroup);
        });

        return group;
    }

    // ─────────────────────────────────────────────
    // INPUT: Keyboard
    // ─────────────────────────────────────────────
    window.addEventListener('keydown', e => {
        if (!car.active) return;
        keys[e.code] = true;
    });

    window.addEventListener('keyup', e => {
        keys[e.code] = false;
    });

    function readKeyboard() {
        input.throttle = (keys['KeyW'] || keys['ArrowUp']) ? 1.0 : 0;
        input.brake    = (keys['KeyS'] || keys['ArrowDown']) ? 1.0 : 0;
        input.steer    = ((keys['KeyA'] || keys['ArrowLeft']) ? -1 : 0) +
                         ((keys['KeyD'] || keys['ArrowRight']) ? 1 : 0);
        input.handbrake = !!keys['Space'];
    }

    // ─────────────────────────────────────────────
    // INPUT: Gamepad API
    // ─────────────────────────────────────────────
    function readGamepad() {
        let gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        let gp = null;
        for (let g of gamepads) {
            if (g && g.connected) { gp = g; break; }
        }
        if (!gp) return;

        // Standard gamepad mapping:
        // Left stick X = axes[0] (steer)
        // Right trigger = buttons[7] (throttle)
        // Left trigger = buttons[6] (brake)
        // A button = buttons[0] (handbrake)

        let stickX = gp.axes[0] || 0;
        let deadzone = 0.12;
        if (Math.abs(stickX) < deadzone) stickX = 0;

        // Override keyboard input with gamepad if active
        let triggerThrottle = gp.buttons[7] ? gp.buttons[7].value : 0;
        let triggerBrake = gp.buttons[6] ? gp.buttons[6].value : 0;

        if (triggerThrottle > 0.05 || triggerBrake > 0.05 || Math.abs(stickX) > deadzone) {
            input.throttle = triggerThrottle;
            input.brake = triggerBrake;
            input.steer = stickX;
            input.handbrake = gp.buttons[0] ? gp.buttons[0].pressed : false;
        }
    }

    // ─────────────────────────────────────────────
    // PHYSICS UPDATE
    // ─────────────────────────────────────────────
    function updateVehicle(dt) {
        if (!car.active || !car.mesh) return;
        if (dt > 0.1) dt = 0.1; // Clamp large dt

        // Read input
        readKeyboard();
        readGamepad();

        // Get terrain at car position
        let terrain = { z: 0, normal: [0, 0, 1], type: 'ROUGH' };
        if (typeof window.localGetTerrainAt === 'function') {
            terrain = window.localGetTerrainAt(car.position.x, -car.position.z);
        }
        car.surfaceType = terrain.type;
        car.grip = CFG.SURFACE_GRIP[terrain.type] || 0.5;
        let speedCap = CFG.MAX_SPEED * (CFG.SURFACE_MAX_SPEED[terrain.type] || 0.5);

        // OB = wall → hard stop
        if (terrain.type === 'OB') {
            car.speed *= 0.9;
            if (Math.abs(car.speed) < 0.5) car.speed = 0;
        }

        // WATER = massive drag
        if (terrain.type === 'WATER') {
            car.speed *= 0.95;
        }

        // ── Acceleration / Braking ──
        if (input.throttle > 0 && car.speed >= 0) {
            // Forward acceleration
            car.speed += CFG.ACCELERATION * input.throttle * car.grip * dt;
        } else if (input.brake > 0 && car.speed > 0.5) {
            // Braking
            car.speed -= CFG.BRAKE_FORCE * input.brake * dt;
            if (car.speed < 0) car.speed = 0;
        } else if (input.brake > 0 && car.speed <= 0.5) {
            // Reverse
            car.speed -= CFG.ACCELERATION * 0.4 * input.brake * car.grip * dt;
        } else if (input.throttle > 0 && car.speed < 0) {
            // Throttle while reversing = brake
            car.speed += CFG.BRAKE_FORCE * 0.5 * dt;
            if (car.speed > 0) car.speed = 0;
        }

        // Natural deceleration (drag + rolling resistance)
        if (input.throttle === 0 && input.brake === 0) {
            car.speed *= Math.pow(CFG.DRAG, 60 * dt);
            // Extra rolling resistance at low speed
            if (Math.abs(car.speed) < 1.0) car.speed *= 0.95;
            if (Math.abs(car.speed) < 0.1) car.speed = 0;
        }

        // Speed caps
        if (car.speed > speedCap) car.speed = speedCap;
        if (car.speed < -CFG.REVERSE_MAX) car.speed = -CFG.REVERSE_MAX;

        // ── Steering ──
        if (Math.abs(car.speed) > 0.3) {
            let speedRatio = Math.abs(car.speed) / CFG.MAX_SPEED;
            let steerMult = 1.0 - speedRatio * (1.0 - CFG.STEER_FALLOFF);

            // Handbrake: more steering at high speed (drift!)
            if (input.handbrake && car.speed > 5) {
                steerMult = 1.2;
                car.speed *= 0.985; // Lose speed during handbrake
            }

            let steerAngle = input.steer * CFG.STEER_SPEED * steerMult * dt;
            // Reverse steering when going backwards
            if (car.speed < 0) steerAngle = -steerAngle;
            car.heading += steerAngle;
        }

        // ── Position Update ──
        let forward = new THREE.Vector3(
            Math.sin(car.heading),
            0,
            Math.cos(car.heading)
        );
        car.position.x += forward.x * car.speed * dt;
        car.position.z += forward.z * car.speed * dt;

        // ── Terrain Following ──
        let groundY = terrain.z;
        if (car.position.y > groundY + CFG.CAR_HEIGHT + 0.3) {
            // Airborne
            car.onGround = false;
            car.velocity.y -= CFG.GRAVITY * dt;
            car.position.y += car.velocity.y * dt;
            if (car.position.y <= groundY + CFG.CAR_HEIGHT) {
                car.position.y = groundY + CFG.CAR_HEIGHT;
                car.velocity.y = 0;
                car.onGround = true;
            }
        } else {
            // On ground — snap to terrain
            car.onGround = true;
            car.velocity.y = 0;
            // Smooth terrain following
            let targetY = groundY + CFG.CAR_HEIGHT;
            car.position.y += (targetY - car.position.y) * 0.3;
        }

        // ── World bounds (keep on terrain) ──
        let halfTerrain = (window.TERRAIN_SIZE || 900) / 2 - 5;
        car.position.x = Math.max(-halfTerrain, Math.min(halfTerrain, car.position.x));
        car.position.z = Math.max(-halfTerrain, Math.min(halfTerrain, car.position.z));

        // ── Apply to Mesh ──
        car.mesh.position.copy(car.position);
        car.mesh.rotation.y = -car.heading;

        // Tilt car to match terrain normal
        let nx = terrain.normal[0];
        let nz = terrain.normal[1];
        // Pitch (forward/back tilt)
        let forwardSlope = nx * Math.sin(car.heading) + nz * Math.cos(car.heading);
        car.mesh.rotation.x = -forwardSlope * 0.6;
        // Roll (side tilt)
        let sideSlope = nx * Math.cos(car.heading) - nz * Math.sin(car.heading);
        car.mesh.rotation.z = sideSlope * 0.5;

        // ── Wheel spin ──
        let spinSpeed = car.speed * CFG.WHEEL_SPIN_RATE;
        car.wheels.forEach((w, i) => {
            // Rotate tire around axle
            if (w.children[0]) {
                w.children[0].rotation.x += spinSpeed * dt * 10;
                w.children[1].rotation.x += spinSpeed * dt * 10;
            }
            // Front wheels turn with steering (first 2 wheels)
            if (i < 2) {
                w.rotation.y = input.steer * 0.35;
            }
        });
    }

    // ─────────────────────────────────────────────
    // CHASE CAMERA
    // ─────────────────────────────────────────────
    function updateChaseCamera(camera, controls) {
        if (!car.active || !car.mesh) return;

        let forward = new THREE.Vector3(
            Math.sin(car.heading),
            0,
            Math.cos(car.heading)
        );

        // Target camera position: behind and above car
        let targetPos = car.position.clone()
            .sub(forward.clone().multiplyScalar(CFG.CAM_BEHIND))
            .add(new THREE.Vector3(0, CFG.CAM_HEIGHT, 0));

        // Raise camera more at high speed
        let speedBoost = Math.abs(car.speed) / CFG.MAX_SPEED;
        targetPos.y += speedBoost * 2;

        // Look-at point: ahead of car
        let targetLook = car.position.clone()
            .add(forward.clone().multiplyScalar(CFG.CAM_LOOK_AHEAD));

        // Smooth interpolation
        chaseCamTarget.lerp(targetPos, CFG.CAM_SMOOTH);
        chaseCamLookAt.lerp(targetLook, CFG.CAM_SMOOTH * 1.5);

        camera.position.copy(chaseCamTarget);
        if (controls) {
            controls.target.copy(chaseCamLookAt);
            controls.update();
        }
    }

    // ─────────────────────────────────────────────
    // HUD
    // ─────────────────────────────────────────────
    function createHUD() {
        let existing = document.getElementById('rally-hud');
        if (existing) existing.remove();

        let hud = document.createElement('div');
        hud.id = 'rally-hud';
        hud.innerHTML = `
            <div style="position:fixed; bottom:30px; right:30px; z-index:9999; pointer-events:none; font-family:'Inter','Segoe UI',sans-serif;">
                <!-- Speedometer -->
                <div style="background:rgba(15,23,42,0.92); border:1px solid #334155; border-radius:16px; padding:16px 24px; backdrop-filter:blur(12px); min-width:180px; text-align:center;">
                    <div id="rally-speed" style="font-size:52px; font-weight:900; color:#38bdf8; letter-spacing:-2px; line-height:1;">0</div>
                    <div style="font-size:11px; color:#64748b; font-weight:bold; text-transform:uppercase; letter-spacing:2px; margin-top:2px;">km/h</div>
                    <div style="height:1px; background:#334155; margin:10px 0;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size:8px; color:#64748b; text-transform:uppercase; font-weight:bold;">Surface</div>
                            <div id="rally-surface" style="font-size:12px; color:#4ade80; font-weight:bold;">ROUGH</div>
                        </div>
                        <div>
                            <div style="font-size:8px; color:#64748b; text-transform:uppercase; font-weight:bold;">Grip</div>
                            <div id="rally-grip" style="font-size:12px; color:#fbbf24; font-weight:bold;">50%</div>
                        </div>
                    </div>
                    <div id="rally-gear" style="font-size:10px; color:#94a3b8; margin-top:6px;">
                        🎮 WASD / Gamepad
                    </div>
                </div>
            </div>
            <!-- Controls hint (top center, fades out) -->
            <div id="rally-controls-hint" style="position:fixed; top:80px; left:50%; transform:translateX(-50%); z-index:9999; pointer-events:none;
                background:rgba(15,23,42,0.9); border:1px solid #334155; border-radius:12px; padding:12px 24px; backdrop-filter:blur(8px);
                font-family:'Inter',sans-serif; transition:opacity 2s ease;">
                <div style="color:#e2e8f0; font-size:13px; font-weight:bold; text-align:center;">🏎️ RALLY MODE</div>
                <div style="color:#94a3b8; font-size:11px; margin-top:4px; text-align:center;">
                    <b>W/↑</b> Gas &nbsp; <b>S/↓</b> Broms &nbsp; <b>A/D</b> Sväng &nbsp; <b>SPACE</b> Handbroms
                </div>
                <div style="color:#64748b; font-size:10px; margin-top:2px; text-align:center;">
                    🎮 Gamepad: Triggers = Gas/Broms, Stick = Sväng, A = Handbroms
                </div>
            </div>
        `;
        document.body.appendChild(hud);

        // Fade out controls hint after 5 seconds
        setTimeout(() => {
            let hint = document.getElementById('rally-controls-hint');
            if (hint) hint.style.opacity = '0';
            setTimeout(() => { if (hint) hint.remove(); }, 2000);
        }, 5000);
    }

    function updateHUD() {
        let speedEl = document.getElementById('rally-speed');
        let surfEl = document.getElementById('rally-surface');
        let gripEl = document.getElementById('rally-grip');

        if (speedEl) {
            let kmh = Math.abs(Math.round(car.speed * 3.6));
            speedEl.textContent = kmh;

            // Color: green < 80, yellow < 140, red > 140
            if (kmh < 80) speedEl.style.color = '#4ade80';
            else if (kmh < 140) speedEl.style.color = '#fbbf24';
            else speedEl.style.color = '#ef4444';
        }
        if (surfEl) {
            surfEl.textContent = car.surfaceType;
            // Color by surface
            let surfColors = {
                'FAIRWAY': '#4ade80', 'TEE': '#4ade80', 'GREEN': '#22d3ee',
                'SEMI-ROUGH': '#a3e635', 'ROUGH': '#fbbf24', 'DEEP ROUGH': '#f97316',
                'SAND': '#fde047', 'WATER': '#38bdf8', 'OB': '#ef4444'
            };
            surfEl.style.color = surfColors[car.surfaceType] || '#94a3b8';
        }
        if (gripEl) {
            let pct = Math.round(car.grip * 100);
            gripEl.textContent = pct + '%';
            if (pct > 70) gripEl.style.color = '#4ade80';
            else if (pct > 40) gripEl.style.color = '#fbbf24';
            else gripEl.style.color = '#ef4444';
        }
    }

    // ─────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────
    window.rallyVehicle = {
        // Start driving
        activate: function(scene, camera, controls) {
            if (car.mesh) scene.remove(car.mesh);

            car.mesh = createCarMesh();
            car.position.set(0, 2, 0);
            car.speed = 0;
            car.heading = 0;
            car.velocity.set(0, 0, 0);
            car.active = true;
            keys = {};

            // Snap to terrain at start
            if (typeof window.localGetTerrainAt === 'function') {
                let t = window.localGetTerrainAt(0, 0);
                car.position.y = t.z + CFG.CAR_HEIGHT;
            }

            scene.add(car.mesh);

            // Init chase cam
            chaseCamTarget.copy(camera.position);
            chaseCamLookAt.copy(controls.target);

            // Create HUD
            createHUD();

            console.log('🏎️ Rally Vehicle activated');
        },

        // Stop driving
        deactivate: function(scene) {
            car.active = false;
            if (car.mesh) {
                scene.remove(car.mesh);
                car.mesh = null;
            }
            let hud = document.getElementById('rally-hud');
            if (hud) hud.remove();
            keys = {};
            console.log('🏎️ Rally Vehicle deactivated');
        },

        // Called every frame from animate loop
        update: function(camera, controls) {
            let now = performance.now();
            let dt = lastTime ? (now - lastTime) / 1000 : 0.016;
            lastTime = now;

            updateVehicle(dt);
            updateChaseCamera(camera, controls);
            updateHUD();
        },

        isActive: function() { return car.active; },
        getSpeed: function() { return car.speed; },
        getPosition: function() { return car.position; },
        getCar: function() { return car; }
    };

})();
