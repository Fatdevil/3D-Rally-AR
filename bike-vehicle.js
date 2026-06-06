// ============================================================
// bike-vehicle.js — Arcade Motocross Physics + Procedural Model
// 4th vehicle type in the rally system (Car/Heli/Plane/Bike)
//
// Interface mirrors rallyHelicopter / rallyPlane:
//   window.rallyBike.activate(scene, camera, opts)
//   window.rallyBike.deactivate(scene)
//   window.rallyBike.isActive()
//   window.rallyBike.getPosition()
//   window.rallyBike.getSpeed()
//   window.rallyBike.update(camera)
//
// Reads terrain via window.localGetTerrainAt(x, -z)
// Reads surfaces via window.resolveSurface(type)
// ============================================================
(function() {
'use strict';

// ── Constants ──
const DEG = Math.PI / 180;
const FWD = new THREE.Vector3(0, 0, -1);
const UP  = new THREE.Vector3(0, 1, 0);
const RGT = new THREE.Vector3(1, 0, 0);

// ── Physics Config ──
const CFG = {
    gravity:        22,
    wheelBase:      2.2,
    rideHeight:     0.55,
    suspK:          180,
    suspC:          19,
    contactGrace:   0.35,

    enginePower:    35,
    brakePower:     30,
    drag:           0.02,
    lateralFriction:     0.92,
    driftLateralFriction: 0.985,

    steerRate:      3.0,
    steerMinSpeed:  3,
    leanFactor:     0.6,
    leanRefSpeed:   15,

    groundAlignResp: 25,
    groundAlignGain: 2.5,

    // Wheelie
    wheelieRiseRate:  1.6,
    wheelieDecayRate: 1.8,
    wheelieMaxAngle:  1.3,

    airPitchRate:   4.0,
    airRollRate:    4.0,
    airYawRate:     1.5,
    airResp:        4.0,

    crashRollMax:   1.0,
    minAirForCrash: 0.25,

    // Camera
    camDistance:     8,
    camHeight:      3.5,
    camLookAhead:   3,
    camSmooth:      4,

    // Crash
    crashRespawnTime: 1.8,

    // Wheel spin visual
    wheelSpinMult:  0.3
};

// ── State ──
let _active = false;
let _scene = null;
let _camera = null;
let _bikeGroup = null;
let _hudEl = null;
let _input = { throttle: 0, brake: 0, steer: 0, pitch: 0 };
let _lastTime = 0;

// Physics state
let _pos    = new THREE.Vector3();
let _vel    = new THREE.Vector3();
let _orient = new THREE.Quaternion();
let _angVel = new THREE.Vector3();
let _yaw    = 0;
let _speed  = 0;
let _grounded = true;
let _crashed  = false;
let _airTime  = 0;
let _wasGround = true;
let _crashTimer = 0;
let _surfaceName = 'DIRT';
let _wheeliePitch = 0;

// Camera state
let _camPos = new THREE.Vector3();
let _camTarget = new THREE.Vector3();

// Model parts (for animation)
let _frontWheelMesh = null;
let _rearWheelMesh  = null;
let _handlebarGroup = null;
let _riderGroup     = null;
let _wheelRadius    = 0.45;

// ── Terrain Helpers ──
function getHeight(x, z) {
    if (typeof window.localGetTerrainAt === 'function') {
        let t = window.localGetTerrainAt(x, -z);
        return t ? t.z : 0;
    }
    if (typeof window.getTerrainHeight === 'function') {
        return window.getTerrainHeight(x, z) || 0;
    }
    return 0;
}

function getTerrainData(x, z) {
    if (typeof window.localGetTerrainAt === 'function') {
        return window.localGetTerrainAt(x, -z);
    }
    return { z: 0, normal: [0, 0, 1], type: 'DIRT' };
}

function getNormal(x, z) {
    let terrain = getTerrainData(x, z);
    let n = terrain.normal || [0, 0, 1];
    // localGetTerrainAt format: [nx, nz, ny_up] → Three.js Y-up
    return new THREE.Vector3(n[0], n[2], n[1]).normalize();
}

function getSurface(type) {
    if (typeof window.resolveSurface === 'function') {
        return window.resolveSurface(type);
    }
    return { grip: 0.55, accel: 0.78, brake: 0.65, maxSpeed: 0.82, dragAdd: 0.003 };
}

// ── Math Helpers ──
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function quatFromForwardUp(f, u) {
    let fwd = f.clone().normalize();
    let upn = u.clone().normalize();
    let z = fwd.clone().negate();
    let x = new THREE.Vector3().crossVectors(upn, z);
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0); else x.normalize();
    let y = new THREE.Vector3().crossVectors(z, x).normalize();
    let m = new THREE.Matrix4().makeBasis(x, y, z);
    return new THREE.Quaternion().setFromRotationMatrix(m);
}

function angVelToward(from, to, gain) {
    let dq = to.clone().multiply(from.clone().invert()).normalize();
    let w = clamp(dq.w, -1, 1);
    let angle = 2 * Math.acos(w);
    let s = Math.sqrt(1 - w * w);
    let axis = new THREE.Vector3(1, 0, 0);
    if (s > 1e-6) axis.set(dq.x / s, dq.y / s, dq.z / s);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    return axis.multiplyScalar(angle * gain);
}

// ── Procedural Model Builder ──
function buildBikeModel() {
    let group = new THREE.Group();
    group.name = 'motocross_bike';

    let frameMat = new THREE.MeshLambertMaterial({ color: 0xdc2626 }); // röd ram
    let metalMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 }); // silver
    let darkMat  = new THREE.MeshLambertMaterial({ color: 0x1e293b }); // mörk
    let tyreMat  = new THREE.MeshLambertMaterial({ color: 0x0f172a }); // däck
    let seatMat  = new THREE.MeshLambertMaterial({ color: 0x334155 }); // säte
    let riderMat = new THREE.MeshLambertMaterial({ color: 0xfbbf24 }); // förare (gul tröja)
    let helmetMat= new THREE.MeshLambertMaterial({ color: 0xef4444 }); // hjälm
    let bootMat  = new THREE.MeshLambertMaterial({ color: 0x1e293b }); // stövlar

    // ── Frame (main tube) ──
    let frameGeo = new THREE.BoxGeometry(0.15, 0.15, 2.0);
    let frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.set(0, 0.45, 0);
    frame.rotation.x = -0.15; // slight angle
    group.add(frame);

    // ── Down tube ──
    let downGeo = new THREE.BoxGeometry(0.12, 0.6, 0.12);
    let down = new THREE.Mesh(downGeo, frameMat);
    down.position.set(0, 0.2, -0.3);
    group.add(down);

    // ── Seat tube ──
    let seatTubeGeo = new THREE.BoxGeometry(0.12, 0.5, 0.12);
    let seatTube = new THREE.Mesh(seatTubeGeo, frameMat);
    seatTube.position.set(0, 0.55, 0.35);
    seatTube.rotation.x = 0.2;
    group.add(seatTube);

    // ── Engine block ──
    let engineGeo = new THREE.BoxGeometry(0.35, 0.3, 0.5);
    let engine = new THREE.Mesh(engineGeo, darkMat);
    engine.position.set(0, 0.15, 0);
    group.add(engine);

    // ── Exhaust pipe ──
    let exhaustGeo = new THREE.CylinderGeometry(0.03, 0.04, 0.8, 6);
    let exhaust = new THREE.Mesh(exhaustGeo, metalMat);
    exhaust.rotation.x = Math.PI / 2;  // run along Z axis (length of bike)
    exhaust.position.set(0.22, 0.05, 0.4);
    group.add(exhaust);

    // ── Seat ──
    let seatGeo = new THREE.BoxGeometry(0.28, 0.08, 0.7);
    let seat = new THREE.Mesh(seatGeo, seatMat);
    seat.position.set(0, 0.72, 0.25);
    group.add(seat);

    // ── Fuel tank ──
    let tankGeo = new THREE.BoxGeometry(0.3, 0.2, 0.4);
    let tank = new THREE.Mesh(tankGeo, frameMat);
    tank.position.set(0, 0.65, -0.15);
    group.add(tank);

    // ── Front fork ──
    let forkGeo = new THREE.BoxGeometry(0.06, 1.0, 0.06);
    let forkL = new THREE.Mesh(forkGeo, metalMat);
    forkL.position.set(-0.12, 0.1, -0.95);
    forkL.rotation.x = -0.25;
    group.add(forkL);
    let forkR = forkL.clone();
    forkR.position.x = 0.12;
    group.add(forkR);

    // ── Rear swingarm ──
    let swingGeo = new THREE.BoxGeometry(0.08, 0.08, 0.9);
    let swingL = new THREE.Mesh(swingGeo, metalMat);
    swingL.position.set(-0.15, 0.15, 0.65);
    swingL.rotation.x = 0.1;
    group.add(swingL);
    let swingR = swingL.clone();
    swingR.position.x = 0.15;
    group.add(swingR);

    // ── Rear shock ──
    let shockGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.45, 6);
    let shock = new THREE.Mesh(shockGeo, riderMat);
    shock.position.set(0, 0.45, 0.55);
    shock.rotation.x = 0.3;
    group.add(shock);

    // ── Front Wheel ──
    let wheelGeo = new THREE.CylinderGeometry(_wheelRadius, _wheelRadius, 0.18, 12);
    _frontWheelMesh = new THREE.Mesh(wheelGeo, tyreMat);
    _frontWheelMesh.rotation.z = Math.PI / 2;
    _frontWheelMesh.position.set(0, 0, -1.1);
    // Hub
    let hubGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.2, 8);
    let hubF = new THREE.Mesh(hubGeo, metalMat);
    hubF.rotation.z = Math.PI / 2;
    hubF.position.copy(_frontWheelMesh.position);
    group.add(hubF);
    group.add(_frontWheelMesh);

    // ── Rear Wheel ──
    _rearWheelMesh = new THREE.Mesh(wheelGeo.clone(), tyreMat);
    _rearWheelMesh.rotation.z = Math.PI / 2;
    _rearWheelMesh.position.set(0, 0, 1.1);
    let hubR = new THREE.Mesh(hubGeo.clone(), metalMat);
    hubR.rotation.z = Math.PI / 2;
    hubR.position.copy(_rearWheelMesh.position);
    group.add(hubR);
    group.add(_rearWheelMesh);

    // ── Front fender ──
    let fenderGeo = new THREE.BoxGeometry(0.22, 0.04, 0.6);
    let fenderF = new THREE.Mesh(fenderGeo, frameMat);
    fenderF.position.set(0, 0.42, -1.1);
    group.add(fenderF);

    // ── Rear fender ──
    let fenderR = new THREE.Mesh(fenderGeo.clone(), frameMat);
    fenderR.position.set(0, 0.42, 1.0);
    group.add(fenderR);

    // ── Number plate (front) ──
    let plateGeo = new THREE.BoxGeometry(0.35, 0.3, 0.03);
    let plateMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    let plate = new THREE.Mesh(plateGeo, plateMat);
    plate.position.set(0, 0.85, -0.75);
    plate.rotation.x = -0.3;
    group.add(plate);

    // ── Handlebars ──
    _handlebarGroup = new THREE.Group();
    _handlebarGroup.position.set(0, 0.8, -0.65);
    let barGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.7, 6);
    let bar = new THREE.Mesh(barGeo, metalMat);
    bar.rotation.z = Math.PI / 2;
    _handlebarGroup.add(bar);
    // Grips
    let gripGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.12, 6);
    let gripL = new THREE.Mesh(gripGeo, darkMat);
    gripL.rotation.z = Math.PI / 2;
    gripL.position.set(-0.35, 0, 0);
    _handlebarGroup.add(gripL);
    let gripR = gripL.clone();
    gripR.position.x = 0.35;
    _handlebarGroup.add(gripR);
    group.add(_handlebarGroup);

    // ── Rider ──
    _riderGroup = new THREE.Group();
    _riderGroup.position.set(0, 0.75, 0.15);

    // Boots
    let bootGeo = new THREE.BoxGeometry(0.14, 0.35, 0.22);
    let bootL = new THREE.Mesh(bootGeo, bootMat);
    bootL.position.set(-0.18, -0.1, -0.1);
    _riderGroup.add(bootL);
    let bootR = bootL.clone();
    bootR.position.x = 0.18;
    _riderGroup.add(bootR);

    // Legs (pants)
    let legGeo = new THREE.BoxGeometry(0.16, 0.5, 0.18);
    let pantsMat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
    let legL = new THREE.Mesh(legGeo, pantsMat);
    legL.position.set(-0.16, 0.2, -0.05);
    legL.rotation.x = 0.3;
    _riderGroup.add(legL);
    let legR = legL.clone();
    legR.position.x = 0.16;
    _riderGroup.add(legR);

    // Torso
    let torsoGeo = new THREE.BoxGeometry(0.4, 0.5, 0.25);
    let torso = new THREE.Mesh(torsoGeo, riderMat);
    torso.position.set(0, 0.55, -0.1);
    torso.rotation.x = -0.3; // leaning forward
    _riderGroup.add(torso);

    // Arms
    let armGeo = new THREE.BoxGeometry(0.1, 0.45, 0.1);
    let armL = new THREE.Mesh(armGeo, riderMat);
    armL.position.set(-0.25, 0.5, -0.3);
    armL.rotation.x = -0.7;
    _riderGroup.add(armL);
    let armR = armL.clone();
    armR.position.x = 0.25;
    _riderGroup.add(armR);

    // Helmet
    let helmetGeo = new THREE.BoxGeometry(0.28, 0.28, 0.3);
    let helmet = new THREE.Mesh(helmetGeo, helmetMat);
    helmet.position.set(0, 0.85, -0.2);
    _riderGroup.add(helmet);

    // Visor
    let visorGeo = new THREE.BoxGeometry(0.26, 0.1, 0.05);
    let visorMat = new THREE.MeshLambertMaterial({ color: 0x334155, transparent: true, opacity: 0.8 });
    let visor = new THREE.Mesh(visorGeo, visorMat);
    visor.position.set(0, 0.82, -0.37);
    _riderGroup.add(visor);

    // Goggles strap
    let strapGeo = new THREE.BoxGeometry(0.3, 0.04, 0.32);
    let strap = new THREE.Mesh(strapGeo, riderMat);
    strap.position.set(0, 0.88, -0.2);
    _riderGroup.add(strap);

    group.add(_riderGroup);

    // Cast shadow on all children
    group.traverse(function(child) {
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    });

    return group;
}

// ── HUD ──
function createHUD() {
    if (_hudEl) return;
    _hudEl = document.createElement('div');
    _hudEl.id = 'bike-hud';
    _hudEl.style.cssText =
        'position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:1000;' +
        'display:flex; gap:16px; align-items:flex-end; pointer-events:none;' +
        'font-family:"Inter","Segoe UI",sans-serif;';

    _hudEl.innerHTML =
        '<div style="background:rgba(15,23,42,0.9); border:1px solid #475569; border-radius:12px; padding:10px 20px; backdrop-filter:blur(8px); text-align:center;">' +
        '  <div style="color:#94a3b8; font-size:9px; font-weight:bold; text-transform:uppercase;">SPEED</div>' +
        '  <div id="bike-speed" style="color:#fff; font-size:32px; font-weight:900; line-height:1;">0</div>' +
        '  <div style="color:#64748b; font-size:10px; font-weight:bold;">KM/H</div>' +
        '</div>' +
        '<div style="background:rgba(15,23,42,0.9); border:1px solid #475569; border-radius:12px; padding:10px 14px; backdrop-filter:blur(8px); text-align:center;">' +
        '  <div style="color:#94a3b8; font-size:9px; font-weight:bold; text-transform:uppercase;">SURFACE</div>' +
        '  <div id="bike-surface" style="color:#4ade80; font-size:12px; font-weight:800;">DIRT</div>' +
        '</div>' +
        '<div id="bike-air-badge" style="display:none; background:rgba(56,189,248,0.9); border-radius:20px; padding:6px 14px; text-align:center;">' +
        '  <div style="color:#fff; font-size:11px; font-weight:900;">🪂 AIR <span id="bike-air-time">0.0</span>s</div>' +
        '</div>';

    document.body.appendChild(_hudEl);
}

function updateHUD() {
    let speedEl = document.getElementById('bike-speed');
    if (speedEl) speedEl.textContent = Math.round(_speed * 3.6);

    let surfEl = document.getElementById('bike-surface');
    if (surfEl) {
        surfEl.textContent = _surfaceName;
        let surface = getSurface(_surfaceName);
        if (surface.grip < 0.2) surfEl.style.color = '#38bdf8';      // ice/water
        else if (surface.grip < 0.45) surfEl.style.color = '#f97316'; // mud
        else if (surface.grip < 0.6) surfEl.style.color = '#fbbf24';  // dirt/gravel
        else surfEl.style.color = '#4ade80';                           // asphalt
    }

    let airBadge = document.getElementById('bike-air-badge');
    let airTimeEl = document.getElementById('bike-air-time');
    if (airBadge) {
        if (_airTime > 0.15 && !_grounded) {
            airBadge.style.display = 'block';
            if (airTimeEl) airTimeEl.textContent = _airTime.toFixed(1);
        } else {
            airBadge.style.display = 'none';
        }
    }
}

function removeHUD() {
    if (_hudEl && _hudEl.parentNode) {
        _hudEl.parentNode.removeChild(_hudEl);
        _hudEl = null;
    }
}

// Crash overlay
let _crashOverlay = null;
function showCrashOverlay() {
    if (_crashOverlay) return;
    _crashOverlay = document.createElement('div');
    _crashOverlay.id = 'bike-crash-overlay';
    _crashOverlay.style.cssText =
        'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10000;' +
        'color:#ef4444; font-size:48px; font-weight:900; font-family:"Inter",sans-serif;' +
        'text-shadow: 0 0 30px rgba(239,68,68,0.6); pointer-events:none; opacity:1;' +
        'transition: opacity 0.5s;';
    _crashOverlay.textContent = '💥 CRASH!';
    document.body.appendChild(_crashOverlay);

    // Red vignette
    let vignette = document.createElement('div');
    vignette.id = 'bike-crash-vignette';
    vignette.style.cssText =
        'position:fixed; top:0; left:0; width:100%; height:100%; z-index:9999;' +
        'pointer-events:none; opacity:0.4; transition:opacity 0.8s;' +
        'background:radial-gradient(ellipse at center, transparent 40%, rgba(239,68,68,0.5) 100%);';
    document.body.appendChild(vignette);
    setTimeout(function() { vignette.style.opacity = '0'; }, 800);
}

function hideCrashOverlay() {
    if (_crashOverlay) {
        _crashOverlay.style.opacity = '0';
        let el = _crashOverlay;
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
        _crashOverlay = null;
    }
    let vig = document.getElementById('bike-crash-vignette');
    if (vig && vig.parentNode) vig.parentNode.removeChild(vig);
}

// ── Input ──
let _keysDown = {};
function onKeyDown(e) {
    _keysDown[e.key.toLowerCase()] = true;
    _keysDown[e.code] = true;
}
function onKeyUp(e) {
    _keysDown[e.key.toLowerCase()] = false;
    _keysDown[e.code] = false;
}

function readInput() {
    _input.throttle = (_keysDown['w'] || _keysDown['arrowup']) ? 1 : 0;
    _input.brake    = (_keysDown['s'] || _keysDown['arrowdown']) ? 1 : 0;
    _input.steer    = 0;
    if (_keysDown['a'] || _keysDown['arrowleft'])  _input.steer = -1;
    if (_keysDown['d'] || _keysDown['arrowright']) _input.steer =  1;
    _input.pitch = 0;
    if (_keysDown['q'] || _keysDown['KeyQ']) _input.pitch =  1; // nos upp (wheelie)
    if (_keysDown['e'] || _keysDown['KeyE']) _input.pitch = -1; // nos ner
}

// ── Physics Update ──
function updatePhysics(dt) {
    dt = Math.min(dt, 1 / 30);

    if (_crashed) {
        _crashTimer -= dt;
        if (_crashTimer <= 0) {
            respawn(_pos.x, _pos.z, _yaw);
            hideCrashOverlay();
        }
        return;
    }

    let throttle = _input.throttle;
    let brake    = _input.brake;
    let steer    = _input.steer;
    let pitchIn  = _input.pitch;

    // Body axes
    let forward = FWD.clone().applyQuaternion(_orient);
    let up      = UP.clone().applyQuaternion(_orient);
    let right   = RGT.clone().applyQuaternion(_orient);
    _speed = Math.sqrt(_vel.x * _vel.x + _vel.z * _vel.z);

    // Surface at current position
    let terrain = getTerrainData(_pos.x, _pos.z);
    _surfaceName = terrain.type || 'DIRT';
    let surface = getSurface(_surfaceName);

    // Ground contact at front + rear wheel
    let half = CFG.wheelBase * 0.5;
    _grounded = false;
    let support = new THREE.Vector3();
    let groundN = getNormal(_pos.x, _pos.z);

    for (let sgn of [half, -half]) {
        let wp = _pos.clone().addScaledVector(forward, sgn);
        let gy = getHeight(wp.x, wp.z);
        let comp = (gy + CFG.rideHeight) - wp.y;
        if (comp > -CFG.contactGrace) _grounded = true;
        if (comp > 0) {
            let n = getNormal(wp.x, wp.z);
            let vN = _vel.dot(n);
            let cComp = Math.min(comp, 0.5);
            let f = Math.max(0, CFG.suspK * cComp - CFG.suspC * vN);
            support.addScaledVector(n, f);
        }
    }

    // ── Forces ──
    _vel.y -= CFG.gravity * dt;                    // gravity
    _vel.addScaledVector(support, dt);              // suspension

    if (_grounded) {
        // ── Decompose velocity into forward/lateral components ──
        let flatFwd = new THREE.Vector3(Math.sin(_yaw), 0, Math.cos(_yaw));
        let flatRight = new THREE.Vector3(flatFwd.z, 0, -flatFwd.x);

        let forwardSpeed = _vel.x * flatFwd.x + _vel.z * flatFwd.z;
        let lateralSpeed = _vel.x * flatRight.x + _vel.z * flatRight.z;

        // ── Drive force (along heading, not body tilt) ──
        let surfAccel = surface.accel !== undefined ? surface.accel : 1;
        let surfBrake = surface.brake !== undefined ? surface.brake : 1;
        let drive = throttle * CFG.enginePower * surfAccel - brake * CFG.brakePower * surfBrake;
        forwardSpeed += drive * dt;

        // Extra braking
        if (brake > 0 && Math.abs(forwardSpeed) > 0.5) {
            forwardSpeed *= (1 - brake * 1.5 * surfBrake * dt);
        }

        // ── Lateral friction (THIS controls drift feel) ──
        let surfGrip = surface.grip !== undefined ? surface.grip : 0.55;
        let baseLateralFriction = CFG.lateralFriction;

        // Drift: gas+steer or brake+steer → less lateral friction → more slide
        let inputForce = Math.max(throttle, brake * 0.8);
        let slideIntensity = inputForce * Math.abs(steer) * clamp(_speed / 8, 0, 1);
        let driftFriction = baseLateralFriction + slideIntensity * (CFG.driftLateralFriction - baseLateralFriction);

        // Surface reduces friction further
        driftFriction = 1 - (1 - driftFriction) * surfGrip;

        // Apply: multiply lateral speed by friction (0.92 = tight, 0.98 = wide slide)
        lateralSpeed *= Math.pow(driftFriction, dt * 60);

        // ── Reconstruct velocity from components ──
        let yVel = _vel.y; // preserve vertical
        _vel.set(
            flatFwd.x * forwardSpeed + flatRight.x * lateralSpeed,
            yVel,
            flatFwd.z * forwardSpeed + flatRight.z * lateralSpeed
        );

        // Max speed limiter
        let surfMaxSpeed = surface.maxSpeed !== undefined ? surface.maxSpeed : 1;
        let maxKmh = 130 * surfMaxSpeed;
        let maxMs = maxKmh / 3.6;
        if (_speed > maxMs) {
            let scale = maxMs / _speed;
            _vel.x *= scale;
            _vel.z *= scale;
        }
    }

    // Drag (air + surface) — horizontal only
    let dragK = (CFG.drag + (surface.dragAdd || 0)) * _speed * dt;
    _vel.x -= _vel.x * dragK;
    _vel.z -= _vel.z * dragK;

    // Integrate position
    _pos.addScaledVector(_vel, dt);

    // ── Rotation ──
    if (_grounded && !_crashed) {
        // Steering
        let sf = clamp(_speed / CFG.steerMinSpeed, 0.2, 1) * (1 - 0.3 * clamp(_speed / 35, 0, 1));
        _yaw -= steer * CFG.steerRate * sf * dt;

        // ── Dynamic Wheelie ──
        if (pitchIn > 0 && throttle > 0.2) {
            _wheeliePitch += CFG.wheelieRiseRate * (0.5 + 0.5 * throttle) * dt;
        } else if (pitchIn < 0 || brake > 0) {
            _wheeliePitch -= CFG.wheelieDecayRate * 2.0 * dt;
        } else {
            _wheeliePitch -= CFG.wheelieDecayRate * dt;
        }
        _wheeliePitch = clamp(_wheeliePitch, 0, CFG.wheelieMaxAngle + 0.5);

        // Loop-out crash (with balance zone)
        if (_wheeliePitch > CFG.wheelieMaxAngle + 0.3) {
            _crashed = true;
            _crashTimer = CFG.crashRespawnTime;
            _vel.set(0, 0, 0);
            _wheeliePitch = 0;
            showCrashOverlay();
            return;
        }

        // Target orientation: ground normal + lean + wheelie
        let fFlat = new THREE.Vector3(Math.sin(_yaw), 0, Math.cos(_yaw));
        let lean = steer * Math.min(_speed / CFG.leanRefSpeed, 1) * CFG.leanFactor;
        let tiltUp = groundN.clone().applyAxisAngle(fFlat, lean);
        let qTarget = quatFromForwardUp(fFlat, tiltUp);

        if (_wheeliePitch > 0.01) {
            qTarget.multiply(new THREE.Quaternion().setFromAxisAngle(RGT, _wheeliePitch));
        }

        let desired = angVelToward(_orient, qTarget, CFG.groundAlignGain);
        _angVel.lerp(desired, 1 - Math.exp(-CFG.groundAlignResp * dt));
    } else if (!_crashed) {
        // Air: pitch + roll + yaw whip (all via _angVel)
        let desired = new THREE.Vector3();
        desired.addScaledVector(right, pitchIn * CFG.airPitchRate);
        desired.addScaledVector(forward, -steer * CFG.airRollRate);
        desired.addScaledVector(up, -steer * CFG.airYawRate);
        _angVel.lerp(desired, 1 - Math.exp(-CFG.airResp * dt));
        _wheeliePitch *= Math.pow(0.95, dt * 60);
    }

    integrateOrientation(dt);

    // ── Landing / crash check (separated roll vs pitch) ──
    if (!_grounded) _airTime += dt;
    if (_grounded && !_wasGround && !_crashed) {
        let upNow = UP.clone().applyQuaternion(_orient);
        let rightNow = RGT.clone().applyQuaternion(_orient);
        let rollError = Math.abs(Math.asin(clamp(rightNow.dot(groundN), -1, 1)));
        let pitchDot = clamp(upNow.dot(groundN), -1, 1);

        let shouldCrash = false;
        if (_airTime > CFG.minAirForCrash) {
            if (rollError > CFG.crashRollMax) shouldCrash = true;
            if (pitchDot < -0.2) shouldCrash = true;
        }

        if (shouldCrash) {
            _crashed = true;
            _crashTimer = CFG.crashRespawnTime;
            _vel.set(0, 0, 0);
            _wheeliePitch = 0;
            showCrashOverlay();
        } else {
            let f = FWD.clone().applyQuaternion(_orient);
            if (Math.hypot(f.x, f.z) > 0.1) _yaw = Math.atan2(f.x, f.z);
            _wheeliePitch = 0;
        }
        _airTime = 0;
    }
    _wasGround = _grounded;
}

function integrateOrientation(dt) {
    let s = _angVel.length();
    if (s > 1e-6) {
        let dq = new THREE.Quaternion().setFromAxisAngle(_angVel.clone().multiplyScalar(1 / s), s * dt);
        _orient.premultiply(dq).normalize();
    }
}

// ── Dirt/Grass Spray Particles ──
const SPRAY_POOL_SIZE = 60;
let _sprayParticles = [];
let _sprayGroup = null;

function initSpraySystem(scene) {
    _sprayGroup = new THREE.Group();
    _sprayGroup.name = 'bike_spray';
    scene.add(_sprayGroup);

    for (let i = 0; i < SPRAY_POOL_SIZE; i++) {
        let size = 0.08 + Math.random() * 0.12;
        let geo = new THREE.BoxGeometry(size, size, size);
        let mat = new THREE.MeshLambertMaterial({ color: 0x8B6914, transparent: true, opacity: 1 });
        let mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        _sprayGroup.add(mesh);
        _sprayParticles.push({
            mesh: mesh,
            vel: new THREE.Vector3(),
            life: 0,
            maxLife: 0
        });
    }
}

function disposeSpraySystem(scene) {
    if (_sprayGroup) {
        _sprayGroup.traverse(function(c) {
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        });
        scene.remove(_sprayGroup);
        _sprayGroup = null;
    }
    _sprayParticles = [];
}

function emitSpray(count, pos, forward, right, speed, steerAmt, surfaceType) {
    // Color based on surface
    let color;
    let st = (surfaceType || '').toUpperCase();
    if (st.indexOf('GRASS') >= 0 || st.indexOf('FESCUE') >= 0 || st.indexOf('ROUGH') >= 0) {
        color = [0x4a7c3f, 0x5a8f4a, 0x3d6b33]; // greens
    } else if (st.indexOf('SAND') >= 0 || st.indexOf('BUNKER') >= 0) {
        color = [0xd4a847, 0xc9953a, 0xbf8a2e]; // sand
    } else if (st.indexOf('ASPHALT') >= 0 || st.indexOf('ROAD') >= 0) {
        color = [0x555555, 0x666666, 0x444444]; // gray
    } else {
        color = [0x8B6914, 0x7a5c12, 0x6b4f10]; // dirt/brown
    }

    let emitted = 0;
    for (let i = 0; i < _sprayParticles.length && emitted < count; i++) {
        let p = _sprayParticles[i];
        if (p.life > 0) continue;

        // Spawn at rear wheel
        let spawnPos = pos.clone().addScaledVector(forward, -1.1); // rear wheel offset
        spawnPos.y += 0.1;

        // Spray direction: backwards + sideways + up
        let sideSign = (Math.random() > 0.5 ? 1 : -1);
        if (Math.abs(steerAmt) > 0.3) sideSign = steerAmt > 0 ? 1 : -1; // spray opposite to turn
        let vx = right.x * sideSign * (2 + Math.random() * 3) + forward.x * (1 + Math.random() * 2);
        let vy = 1.5 + Math.random() * 3;
        let vz = right.z * sideSign * (2 + Math.random() * 3) + forward.z * (1 + Math.random() * 2);

        // Add some bike speed momentum
        vx += forward.x * speed * 0.15;
        vz += forward.z * speed * 0.15;

        p.vel.set(vx, vy, vz);
        p.mesh.position.copy(spawnPos);
        p.maxLife = 0.4 + Math.random() * 0.5;
        p.life = p.maxLife;
        p.mesh.visible = true;
        p.mesh.material.color.setHex(color[Math.floor(Math.random() * color.length)]);
        p.mesh.material.opacity = 1;
        p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);

        emitted++;
    }
}

function updateSprayParticles(dt) {
    if (!_sprayGroup) return;

    for (let i = 0; i < _sprayParticles.length; i++) {
        let p = _sprayParticles[i];
        if (p.life <= 0) continue;

        p.life -= dt;
        if (p.life <= 0) {
            p.mesh.visible = false;
            continue;
        }

        // Physics
        p.vel.y -= 12 * dt; // gravity on particles
        p.mesh.position.addScaledVector(p.vel, dt);

        // Fade out
        let t = p.life / p.maxLife;
        p.mesh.material.opacity = t * t;

        // Spin
        p.mesh.rotation.x += 5 * dt;
        p.mesh.rotation.z += 3 * dt;

        // Scale down
        let s = 0.5 + 0.5 * t;
        p.mesh.scale.setScalar(s);
    }

    // Emit based on speed and turning
    if (_grounded && _speed > 2) {
        let forward = FWD.clone().applyQuaternion(_orient);
        let right = RGT.clone().applyQuaternion(_orient);
        let steerAmt = _input.steer;
        let turnIntensity = Math.abs(steerAmt);
        let speedFactor = clamp(_speed / 15, 0, 1);

        // Base spray: always some when moving fast
        let baseCount = Math.floor(speedFactor * 2);
        // Extra spray when turning hard
        let turnCount = Math.floor(turnIntensity * speedFactor * 4);
        // Extra when drifting (brake + steer)
        let driftCount = (_input.brake > 0 && turnIntensity > 0.3 && _speed > 5) ? 5 : 0;
        // Wheelie spray
        let wheelieCount = (_input.pitch > 0.5 && _input.throttle > 0) ? 3 : 0;

        let total = baseCount + turnCount + driftCount + wheelieCount;
        if (total > 0) {
            emitSpray(total, _pos, forward, right, _speed, steerAmt, _surfaceName);
        }
    }
}

// ── Apply Physics to Model ──
function applyToModel() {
    if (!_bikeGroup) return;
    _bikeGroup.position.copy(_pos);
    _bikeGroup.quaternion.copy(_orient);

    // Wheel spin
    if (_frontWheelMesh) {
        _frontWheelMesh.rotation.x += _speed * CFG.wheelSpinMult;
    }
    if (_rearWheelMesh) {
        _rearWheelMesh.rotation.x += _speed * CFG.wheelSpinMult;
    }

    // Handlebar turn
    if (_handlebarGroup) {
        _handlebarGroup.rotation.y = -_input.steer * 0.3;
    }

    // Rider lean (forward when accelerating, back when braking)
    if (_riderGroup) {
        let leanForward = -0.15 + _input.throttle * -0.1 + _input.brake * 0.15;
        _riderGroup.rotation.x = leanForward;
        // Side lean
        _riderGroup.rotation.z = _input.steer * 0.2;
    }
}

// ── Camera ──
function updateCamera(dt) {
    if (!_camera) return;

    let forward = FWD.clone().applyQuaternion(_orient);
    forward.y = 0;
    forward.normalize();

    // Target: look ahead of bike
    let target = _pos.clone().addScaledVector(forward, CFG.camLookAhead);
    target.y = _pos.y + 1.0;

    // Camera position: behind and above
    let idealCamPos = _pos.clone()
        .addScaledVector(forward, -CFG.camDistance)
        .add(new THREE.Vector3(0, CFG.camHeight, 0));

    // Don't go under terrain
    let camGroundY = getHeight(idealCamPos.x, idealCamPos.z);
    if (idealCamPos.y < camGroundY + 1.5) {
        idealCamPos.y = camGroundY + 1.5;
    }

    // Smooth follow
    let t = 1 - Math.exp(-CFG.camSmooth * dt);
    _camPos.lerp(idealCamPos, t);
    _camTarget.lerp(target, t);

    _camera.position.copy(_camPos);
    _camera.lookAt(_camTarget);
}

// ── Respawn ──
function respawn(x, z, yaw) {
    let y = getHeight(x, z) + CFG.rideHeight + 0.5;
    _pos.set(x, y, z);
    _vel.set(0, 0, 0);
    _angVel.set(0, 0, 0);
    _yaw = yaw || 0;
    let n = getNormal(x, z);
    let fFlat = new THREE.Vector3(Math.sin(_yaw), 0, Math.cos(_yaw));
    _orient.copy(quatFromForwardUp(fFlat, n));
    _crashed = false;
    _airTime = 0;
    _wasGround = true;
    _crashTimer = 0;
    _speed = 0;
    _wheeliePitch = 0;

    // Init camera
    let forward = fFlat;
    _camPos.copy(_pos).addScaledVector(forward, -CFG.camDistance).add(new THREE.Vector3(0, CFG.camHeight, 0));
    _camTarget.copy(_pos).addScaledVector(forward, CFG.camLookAhead);
    _camTarget.y = _pos.y + 1;
}

// ── Public API ──
window.rallyBike = {
    activate: function(scene, camera, opts) {
        opts = opts || {};
        _scene = scene;
        _camera = camera;
        _active = true;
        _lastTime = performance.now();

        // Build model
        _bikeGroup = buildBikeModel();
        scene.add(_bikeGroup);

        // Spawn
        let x = opts.x || 0;
        let z = opts.z || 0;
        let heading = opts.heading || 0;
        respawn(x, z, heading);

        // HUD
        createHUD();

        // Input
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        _keysDown = {};

        // Particles
        initSpraySystem(scene);

        console.log('🏍️ Motocross bike activated at', x.toFixed(1), z.toFixed(1));
    },

    deactivate: function(scene) {
        _active = false;
        if (_bikeGroup && scene) {
            scene.remove(_bikeGroup);
            _bikeGroup.traverse(function(child) {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(function(m) { m.dispose(); });
                    else child.material.dispose();
                }
            });
            _bikeGroup = null;
        }
        removeHUD();
        hideCrashOverlay();
        disposeSpraySystem(scene);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        _keysDown = {};
        console.log('🏍️ Motocross bike deactivated');
    },

    isActive: function() { return _active; },

    getPosition: function() { return _pos.clone(); },

    getSpeed: function() { return _speed; },

    getBike: function() {
        return {
            position: _pos,
            velocity: _vel,
            heading: _yaw,
            speed: _speed,
            grounded: _grounded,
            crashed: _crashed,
            airTime: _airTime,
            mesh: _bikeGroup
        };
    },

    update: function(camera) {
        if (!_active) return;

        let now = performance.now();
        let dt = (now - _lastTime) / 1000;
        _lastTime = now;
        dt = Math.min(dt, 0.05);
        if (dt <= 0) return;

        readInput();
        updatePhysics(dt);
        applyToModel();
        updateSprayParticles(dt);
        updateCamera(dt);
        updateHUD();
    }
};

console.log('🏍️ Motocross bike module loaded');
})();
