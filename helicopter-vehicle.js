// helicopter-vehicle.js — Helicopter physics module for Rally AR terrain
// Integrates with localGetTerrainAt() for terrain-relative flying
// API: window.rallyHelicopter.activate(scene, camera) / .deactivate(scene) / .update(camera)
(function() {
'use strict';

function lerp(a,b,t){ return a+(b-a)*Math.max(0,Math.min(1,t)); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

// ── Physics Config ──
const PHYS = {
    gravity:        9.8,
    mass:           1.0,
    maxLift:        22.0,
    hoverThrottle:  0.45,   // gravity / maxLift ≈ 0.45
    linearDamping:  0.991,
    pitchAccel:     1.7,
    rollAccel:      1.5,
    yawAccel:       0.9,
    angularDamping: 0.87,
    autoLevel:      0.08,   // Auto-stabilization strength
    maxPitch:       40,     // degrees
    maxRoll:        35,     // degrees
    skidHeight:     1.3,    // Height from ground to heli center (landing gear)
    crashSpeed:     12,     // m/s vertical impact = crash
};

// ── State ──
let heli = {
    position: null, velocity: null,
    pitch: 0, roll: 0, yaw: 0,
    pitchVel: 0, rollVel: 0, yawVel: 0,
    throttle: 0,
    onGround: true, crashed: false,
    active: false, mesh: null,
    mainRotor: null, tailRotor: null,
    displaySpeed: 0, altitude: 0,
};
let input = { throttle:0, pitch:0, roll:0, yaw:0 };
let keys = {}, lastTime = 0;

// ── Heli Mesh (low-poly box helicopter) ──
function createHeliMesh() {
    let g = new THREE.Group(); g.name = 'Helicopter';

    // Body (stretched sphere → box for simplicity)
    let bodyGeo = new THREE.BoxGeometry(2.4, 1.2, 3.4);
    let bodyMat = new THREE.MeshLambertMaterial({ color: 0xff5500 });
    let body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0;
    body.castShadow = true;
    g.add(body);

    // Cockpit window
    let winGeo = new THREE.BoxGeometry(2.0, 0.8, 0.4);
    let winMat = new THREE.MeshLambertMaterial({ color: 0x99ddff, transparent: true, opacity: 0.65 });
    let win = new THREE.Mesh(winGeo, winMat);
    win.position.set(0, 0.2, 1.5);
    g.add(win);

    // Tail boom
    let tailGeo = new THREE.BoxGeometry(0.5, 0.4, 4.0);
    let tailMat = new THREE.MeshLambertMaterial({ color: 0xe04400 });
    let tail = new THREE.Mesh(tailGeo, tailMat);
    tail.position.set(0, 0.1, -3.8);
    tail.castShadow = true;
    g.add(tail);

    // Tail fin
    let finGeo = new THREE.BoxGeometry(0.1, 1.2, 0.8);
    let fin = new THREE.Mesh(finGeo, tailMat);
    fin.position.set(0, 0.7, -5.5);
    g.add(fin);

    // Landing skids
    let skidMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
    [-1.0, 1.0].forEach(function(sx) {
        // Legs
        [-0.6, 0.6].forEach(function(sz) {
            let leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.8, 6), skidMat);
            leg.position.set(sx, -0.9, sz);
            g.add(leg);
        });
        // Skid bar
        let bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 3.0), skidMat);
        bar.position.set(sx, -1.3, 0);
        g.add(bar);
    });

    // Main rotor hub
    let mainRotor = new THREE.Group();
    mainRotor.position.set(0, 0.85, 0);
    // Rotor mast
    let mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.4, 8),
        new THREE.MeshLambertMaterial({ color: 0x333333 })
    );
    mainRotor.add(mast);
    // Blades (3)
    for (let i = 0; i < 3; i++) {
        let blade = new THREE.Mesh(
            new THREE.BoxGeometry(5.5, 0.08, 0.35),
            new THREE.MeshLambertMaterial({ color: 0x1a1a1a })
        );
        blade.rotation.y = (Math.PI * 2 / 3) * i;
        mainRotor.add(blade);
    }
    g.add(mainRotor);
    heli.mainRotor = mainRotor;

    // Tail rotor
    let tailRotor = new THREE.Group();
    tailRotor.position.set(0.3, 0.4, -5.5);
    for (let i = 0; i < 2; i++) {
        let b = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 1.0, 0.14),
            new THREE.MeshLambertMaterial({ color: 0x222222 })
        );
        b.rotation.x = (Math.PI / 2) * i;
        tailRotor.add(b);
    }
    g.add(tailRotor);
    heli.tailRotor = tailRotor;

    return g;
}

// ── Input ──
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1);
let joy = { left: {x:0, y:0}, right: {x:0, y:0} };
let joystickContainer = null;

const HELI_KEYS = new Set(['Space','ShiftLeft','ShiftRight','KeyI','KeyK','KeyJ','KeyL','KeyU','KeyO','KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE']);
window.addEventListener('keydown', function(e) {
    if (heli.active) {
        keys[e.code] = true;
        if (e.code === 'KeyR' && heli.crashed) resetHelicopter();
        if (HELI_KEYS.has(e.code)) e.preventDefault();
    }
});
window.addEventListener('keyup', function(e) { keys[e.code] = false; });

// ── Touch Joysticks (iPad/Mobile) ──
function createTouchJoysticks() {
    if (joystickContainer) return; // Already created
    joystickContainer = document.createElement('div');
    joystickContainer.id = 'heli-touch-controls';
    joystickContainer.style.cssText = 'position:fixed;bottom:0;left:0;right:0;height:220px;z-index:9998;pointer-events:none;';
    
    // CSS for joystick zones
    joystickContainer.innerHTML =
        '<div id="heli-jzone-left" style="position:absolute;bottom:24px;left:24px;width:150px;height:150px;pointer-events:all;">' +
            '<div id="heli-jbase-left" style="width:100%;height:100%;border-radius:50%;border:2px solid rgba(255,140,0,0.3);background:rgba(255,140,0,0.06);position:relative;">' +
                '<div id="heli-jstick-left" style="width:52px;height:52px;border-radius:50%;background:rgba(255,140,0,0.25);border:2px solid rgba(255,140,0,0.6);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);"></div>' +
            '</div>' +
            '<div style="position:absolute;bottom:-22px;width:100%;text-align:center;color:rgba(255,140,0,0.4);font-size:10px;font-family:monospace;">THROTTLE ↑↓ · TURN ←→</div>' +
        '</div>' +
        '<div id="heli-jzone-right" style="position:absolute;bottom:24px;right:24px;width:150px;height:150px;pointer-events:all;">' +
            '<div id="heli-jbase-right" style="width:100%;height:100%;border-radius:50%;border:2px solid rgba(255,140,0,0.3);background:rgba(255,140,0,0.06);position:relative;">' +
                '<div id="heli-jstick-right" style="width:52px;height:52px;border-radius:50%;background:rgba(255,140,0,0.25);border:2px solid rgba(255,140,0,0.6);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);"></div>' +
            '</div>' +
            '<div style="position:absolute;bottom:-22px;width:100%;text-align:center;color:rgba(255,140,0,0.4);font-size:10px;font-family:monospace;">FLIGHT DIRECTION</div>' +
        '</div>';
    document.body.appendChild(joystickContainer);
    
    // Wire up touch events
    setupJoystick('heli-jbase-left', 'heli-jstick-left', 'left');
    setupJoystick('heli-jbase-right', 'heli-jstick-right', 'right');
}

function setupJoystick(baseId, stickId, side) {
    let base = document.getElementById(baseId);
    let stick = document.getElementById(stickId);
    if (!base || !stick) return;
    let R = 75, maxD = R * 0.72;
    let touchId = null, cx0 = 0, cy0 = 0;
    
    function start(touch) {
        touchId = touch.identifier;
        let r = base.getBoundingClientRect();
        cx0 = r.left + R; cy0 = r.top + R;
        move(touch);
    }
    function findTouch(touches) {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === touchId) return touches[i];
        }
        return null;
    }
    function move(touch) {
        if (touchId === null || !touch) return;
        let dx = touch.clientX - cx0, dy = touch.clientY - cy0;
        let d = Math.sqrt(dx*dx + dy*dy);
        if (d > maxD) { dx *= maxD/d; dy *= maxD/d; }
        stick.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
        joy[side].x = dx / maxD;
        joy[side].y = dy / maxD;
    }
    function end() {
        touchId = null;
        stick.style.transform = 'translate(-50%,-50%)';
        joy[side].x = joy[side].y = 0;
    }
    
    base.addEventListener('touchstart', function(e) { e.preventDefault(); start(e.changedTouches[0]); }, {passive:false});
    base.addEventListener('touchmove',  function(e) { e.preventDefault(); let t = findTouch(e.touches); if(t) move(t); }, {passive:false});
    base.addEventListener('touchend',   function(e) { e.preventDefault(); if(findTouch(e.changedTouches)) end(); }, {passive:false});
    base.addEventListener('touchcancel',function(e) { e.preventDefault(); if(findTouch(e.changedTouches)) end(); }, {passive:false});
}

function destroyTouchJoysticks() {
    if (joystickContainer) {
        joystickContainer.remove();
        joystickContainer = null;
    }
    joy.left.x = joy.left.y = 0;
    joy.right.x = joy.right.y = 0;
}

function readInput() {
    input.throttle = 0; input.pitch = 0; input.roll = 0; input.yaw = 0;
    
    if (isMobile) {
        // Touch joysticks: 
        // Left stick = throttle + coordinated turn (yaw + 65% bank)
        // Right stick = pitch + pure roll (strafe)
        input.throttle = -joy.left.y;   // push up = more gas
        input.yaw      = -joy.left.x;   // Left = positive yaw, Right = negative yaw
        input.roll     = -joy.left.x * 0.65 - joy.right.x; // Coordinated bank (65%) + Strafe roll (100%)
        input.pitch    = -joy.right.y;  // push up = fly forward
    } else {
        // Keyboard: Throttle = Space/Shift, Flight = WASD or IKJL, Turn/Strafe = QE or UO
        if (keys['Space']) input.throttle = 1;
        if (keys['ShiftLeft'] || keys['ShiftRight']) input.throttle = -1;
        
        // Pitch (Forward/Backward)
        if (keys['KeyI'] || keys['KeyW']) input.pitch = 1;
        if (keys['KeyK'] || keys['KeyS']) input.pitch = -1;
        
        // Coordinated Turn (A/D or U/O for legacy): 100% Yaw + 65% Roll for visible coordinated bank
        let turnInput = 0;
        if (keys['KeyA'] || keys['KeyU']) turnInput += 1.0;
        if (keys['KeyD'] || keys['KeyO']) turnInput -= 1.0;
        
        // Pure Strafe Roll (Q/E or J/L for legacy): 100% Roll
        let strafeInput = 0;
        if (keys['KeyQ'] || keys['KeyJ']) strafeInput += 1.0;
        if (keys['KeyE'] || keys['KeyL']) strafeInput -= 1.0;
        
        input.yaw = turnInput;
        input.roll = turnInput * 0.65 + strafeInput;
    }
    
    // Gamepad (works on both mobile+desktop) - add to keyboard inputs with clamp
    let gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let gp of gps) {
        if (!gp || !gp.connected) continue;
        let lx = gp.axes[0] || 0, ly = gp.axes[1] || 0;
        let rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;
        
        let gpYaw = Math.abs(lx) > 0.12 ? -lx : 0;
        let gpRoll = (Math.abs(lx) > 0.12 ? -lx * 0.65 : 0) + (Math.abs(rx) > 0.12 ? -rx : 0);
        let gpThrottle = Math.abs(ly) > 0.12 ? -ly : 0;
        let gpPitch = Math.abs(ry) > 0.12 ? -ry : 0;
 
        if (gpYaw !== 0 || gpRoll !== 0 || gpThrottle !== 0 || gpPitch !== 0) {
            input.yaw = input.yaw + gpYaw;
            input.roll = input.roll + gpRoll;
            input.throttle = input.throttle + gpThrottle;
            input.pitch = input.pitch + gpPitch;
        }
        break;
    }
    
    // Secure bounds [-1, 1] for all final outputs
    input.yaw = clamp(input.yaw, -1, 1);
    input.roll = clamp(input.roll, -1, 1);
    input.throttle = clamp(input.throttle, -1, 1);
    input.pitch = clamp(input.pitch, -1, 1);
}

// ── Physics Update ──
function updateHelicopter(dt) {
    if (!heli.active || !heli.mesh || heli.crashed) return;
    dt = Math.min(dt, 0.05);
    readInput();

    // Throttle
    heli.throttle += input.throttle * 1.6 * dt;
    heli.throttle = clamp(heli.throttle, 0, 1);

    // Angular physics
    let maxPR = PHYS.maxPitch * Math.PI / 180;
    let maxRR = PHYS.maxRoll * Math.PI / 180;

    heli.pitchVel += input.pitch * PHYS.pitchAccel * dt;
    heli.rollVel  += input.roll  * PHYS.rollAccel  * dt;
    heli.yawVel   += input.yaw   * PHYS.yawAccel   * dt;

    // Auto-leveling (return to neutral when no input, frame-rate independent)
    heli.pitchVel -= heli.pitch * PHYS.autoLevel * (dt * 60);
    heli.rollVel  -= heli.roll  * PHYS.autoLevel * (dt * 60);

    // Angular damping (frame-rate independent)
    let angDamp = Math.pow(PHYS.angularDamping, dt * 60);
    heli.pitchVel *= angDamp;
    heli.rollVel  *= angDamp;
    heli.yawVel   *= angDamp;

    // Integrate angles (frame-rate independent, scaled to feel identical to 60 FPS)
    heli.pitch += heli.pitchVel * (dt * 60);
    heli.roll  += heli.rollVel * (dt * 60);
    heli.yaw   += heli.yawVel * (dt * 60);

    // Clamp tilt
    heli.pitch = clamp(heli.pitch, -maxPR, maxPR);
    heli.roll  = clamp(heli.roll,  -maxRR, maxRR);

    // Lock/damp angles on ground to prevent visual clipping
    if (heli.onGround) {
        heli.pitch *= Math.pow(0.08, dt * 60);
        heli.roll  *= Math.pow(0.08, dt * 60);
    }

    // === Forces ===
    // Rotor lift direction = local Y, decomposed through pitch/roll/yaw into world
    let liftMag = heli.throttle * PHYS.maxLift;

    let local_lx = Math.sin(heli.roll) * liftMag;
    let local_ly = Math.cos(heli.pitch) * Math.cos(heli.roll) * liftMag;
    let local_lz = Math.sin(heli.pitch) * Math.cos(heli.roll) * liftMag; // Corrected sign for forward force

    let cosY = Math.cos(heli.yaw), sinY = Math.sin(heli.yaw);
    let fx = local_lx * cosY + local_lz * sinY;
    let fy = local_ly - PHYS.gravity * PHYS.mass;
    let fz = -local_lx * sinY + local_lz * cosY;

    // Velocity integration
    heli.velocity.x += fx * dt;
    heli.velocity.y += fy * dt;
    heli.velocity.z += fz * dt;

    // Air drag
    let d = Math.pow(PHYS.linearDamping, dt * 60);
    heli.velocity.multiplyScalar(d);

    // Position integration
    heli.position.x += heli.velocity.x * dt;
    heli.position.y += heli.velocity.y * dt;
    heli.position.z += heli.velocity.z * dt;

    // === Terrain collision ===
    let groundY = 0;
    if (typeof window.localGetTerrainAt === 'function') {
        let terrain = window.localGetTerrainAt(heli.position.x, -heli.position.z);
        groundY = terrain ? terrain.z : 0; // Null-check fix
    } else if (typeof window.getTerrainHeight === 'function') {
        groundY = window.getTerrainHeight(heli.position.x, heli.position.z);
    }

    let floorY = groundY + PHYS.skidHeight;

    if (heli.position.y <= floorY) {
        // Landing / crash check
        let impactSpeed = -heli.velocity.y;
        if (impactSpeed > PHYS.crashSpeed) {
            heli.crashed = true;
            showCrashUI(true);
            return;
        }
        heli.position.y = floorY;
        heli.velocity.y = Math.max(0, heli.velocity.y);
        heli.velocity.x *= 0.90;
        heli.velocity.z *= 0.90;
        heli.pitch *= 0.88;
        heli.roll  *= 0.88;
    }
    heli.onGround = (heli.position.y <= floorY + 0.1);

    // World bounds
    let half = (window.TERRAIN_SIZE || 900) / 2 - 5;
    heli.position.x = clamp(heli.position.x, -half, half);
    heli.position.z = clamp(heli.position.z, -half, half);
    // Altitude ceiling
    heli.position.y = Math.min(heli.position.y, 300);

    // === Update mesh ===
    heli.mesh.position.copy(heli.position);
    heli.mesh.rotation.set(heli.pitch, heli.yaw, -heli.roll, 'YXZ');

    // Rotor spin (speed depends on throttle)
    let rSpeed = 4 + heli.throttle * 18;
    if (heli.mainRotor) heli.mainRotor.rotation.y += rSpeed * dt;
    if (heli.tailRotor) heli.tailRotor.rotation.x += rSpeed * 2.5 * dt;

    // Stats
    heli.displaySpeed = heli.velocity.length();
    heli.altitude = Math.max(0, heli.position.y - groundY);
}

// ── Camera ──
let camOffset = new THREE.Vector3(0, 8, 22);
let camTarget = new THREE.Vector3();
let camSmooth = new THREE.Vector3();
let camInited = false;

function updateCamera(camera) {
    if (!heli.mesh) return;

    let cosY = Math.cos(heli.yaw), sinY = Math.sin(heli.yaw);
    // Camera is positioned behind the helicopter's heading (negative relative Z)
    let ox = -sinY * camOffset.z;
    let oz = -cosY * camOffset.z;

    let targetCam = new THREE.Vector3(
        heli.position.x + ox,
        heli.position.y + camOffset.y,
        heli.position.z + oz
    );

    if (!camInited) {
        camSmooth.copy(targetCam);
        camInited = true;
    }
    camSmooth.lerp(targetCam, 0.06);
    camera.position.copy(camSmooth);

    camTarget.set(heli.position.x, heli.position.y + 1.2, heli.position.z);
    camera.lookAt(camTarget);
}

// ── HUD ──
function createHUD() {
    let ex = document.getElementById('heli-hud'); if (ex) ex.remove();
    let h = document.createElement('div'); h.id = 'heli-hud';
    h.innerHTML = '<div style="position:fixed;bottom:30px;right:30px;z-index:9999;pointer-events:none;font-family:\'Inter\',\'Segoe UI\',sans-serif">' +
    '<div style="background:rgba(15,23,42,0.92);border:1px solid #334155;border-radius:16px;padding:16px 24px;backdrop-filter:blur(12px);min-width:180px;text-align:center">' +
    '<div id="heli-speed" style="font-size:52px;font-weight:900;color:#ff8800;letter-spacing:-2px;line-height:1">0</div>' +
    '<div style="font-size:11px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:2px;margin-top:2px">km/h</div>' +
    '<div style="height:1px;background:#334155;margin:10px 0"></div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
    '<div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Altitude</div>' +
    '<div id="heli-alt" style="font-size:14px;color:#38bdf8;font-weight:bold">0m</div></div>' +
    '<div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Throttle</div>' +
    '<div id="heli-throttle" style="font-size:14px;color:#4ade80;font-weight:bold">0%</div></div></div>' +
    '<div id="heli-state" style="font-size:12px;font-weight:900;color:#4ade80;margin-top:8px">🛬 GROUND</div>' +
    '</div></div>' +
    '<div id="heli-controls-hint" style="position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;' +
    'background:rgba(15,23,42,0.9);border:1px solid #334155;border-radius:12px;padding:12px 24px;backdrop-filter:blur(8px);' +
    'font-family:\'Inter\',sans-serif;transition:opacity 2s ease">' +
    '<div style="color:#e2e8f0;font-size:13px;font-weight:bold;text-align:center">🚁 HELICOPTER MODE</div>' +
    '<div style="color:#94a3b8;font-size:11px;margin-top:4px;text-align:center">' +
    '<b>SPACE</b> Up &nbsp; <b>SHIFT</b> Down &nbsp; <b>WASD / IKJL</b> Fly &nbsp; <b>Q/E / U/O</b> Turn &nbsp; <b>H</b> Switch to Car</div></div>';
    document.body.appendChild(h);
    setTimeout(function() {
        let c = document.getElementById('heli-controls-hint');
        if (c) c.style.opacity = '0';
        setTimeout(function() { if (c) c.remove(); }, 2000);
    }, 6000);
}

function updateHUD() {
    let se = document.getElementById('heli-speed');
    let al = document.getElementById('heli-alt');
    let th = document.getElementById('heli-throttle');
    let st = document.getElementById('heli-state');
    if (se) {
        let kmh = Math.round(heli.displaySpeed * 3.6);
        se.textContent = kmh;
        se.style.color = kmh < 50 ? '#4ade80' : kmh < 100 ? '#fbbf24' : '#ff5500';
    }
    if (al) al.textContent = Math.round(heli.altitude) + 'm';
    if (th) {
        let pct = Math.round(heli.throttle * 100);
        th.textContent = pct + '%';
        th.style.color = pct > 70 ? '#ff5500' : pct > 40 ? '#fbbf24' : '#4ade80';
    }
    if (st) st.innerHTML = heli.onGround ? '🛬 GROUND' : '🚁 FLYING';
}

// ── Crash UI ──
function showCrashUI(show) {
    let ex = document.getElementById('heli-crash');
    if (show) {
        if (!ex) {
            let d = document.createElement('div'); d.id = 'heli-crash';
            d.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;' +
                'color:#ff4444;font-size:48px;font-family:monospace;text-align:center;text-shadow:0 0 20px #ff4444;pointer-events:none;';
            d.innerHTML = 'CRASH!<br><span style="font-size:18px">press R to restart</span>';
            document.body.appendChild(d);
        }
    } else {
        if (ex) ex.remove();
    }
}

function resetHelicopter() {
    // Reset to spawn position or last known ground
    let groundY = 0;
    if (typeof window.localGetTerrainAt === 'function') {
        let t = window.localGetTerrainAt(heli.position.x, -heli.position.z);
        groundY = t ? t.z : 0;
    }
    heli.position.set(heli.position.x, groundY + PHYS.skidHeight, heli.position.z);
    heli.velocity.set(0, 0, 0);
    heli.pitch = heli.roll = 0; // Keep yaw (heading)
    heli.pitchVel = heli.rollVel = heli.yawVel = 0;
    heli.throttle = 0;
    heli.crashed = false;
    showCrashUI(false);
}

// ── PUBLIC API ──
window.rallyHelicopter = {
    activate: function(scene, camera) {
        if (heli.mesh) scene.remove(heli.mesh);
        heli.mesh = createHeliMesh();
        heli.position = new THREE.Vector3(0, 2, 0);
        heli.velocity = new THREE.Vector3(0, 0, 0);
        heli.pitch = heli.roll = heli.yaw = 0;
        heli.pitchVel = heli.rollVel = heli.yawVel = 0;
        heli.throttle = 0;
        heli.onGround = true;
        heli.crashed = false;
        heli.active = true;
        heli.displaySpeed = 0;
        heli.altitude = 0;
        camInited = false;
        keys = {};
        lastTime = 0;

        // Spawn on terrain
        if (typeof window.localGetTerrainAt === 'function') {
            let t = window.localGetTerrainAt(0, 0);
            heli.position.y = (t ? t.z : 0) + PHYS.skidHeight;
        }

        scene.add(heli.mesh);
        createHUD();
        if (isMobile) createTouchJoysticks();
        console.log('🚁 Helicopter activated — terrain-integrated' + (isMobile ? ' (touch controls)' : ''));
    },

    deactivate: function(scene) {
        heli.active = false;
        if (heli.mesh) { scene.remove(heli.mesh); heli.mesh = null; }
        let h = document.getElementById('heli-hud'); if (h) h.remove();
        destroyTouchJoysticks();
        showCrashUI(false);
        keys = {};
        console.log('🚁 Helicopter deactivated');
    },

    update: function(camera) {
        let now = performance.now();
        let dt = lastTime ? (now - lastTime) / 1000 : 0.016;
        lastTime = now;
        dt = Math.min(dt, 0.05);
        updateHelicopter(dt);
        updateCamera(camera);
        updateHUD();
    },

    isActive: function() { return heli.active; },
    getPosition: function() { return heli.position; },
    getHeli: function() { return heli; },
    getAltitude: function() { return heli.altitude; },
    getSpeed: function() { return heli.displaySpeed; },
    reset: function() { resetHelicopter(); },
    getConfig: function() { return PHYS; },
};

})();
