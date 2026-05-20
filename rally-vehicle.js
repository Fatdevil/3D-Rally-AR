// rally-vehicle.js — Full arcade rally physics with drift system
(function() {
'use strict';

function lerp(a,b,t){ return a+(b-a)*Math.max(0,Math.min(1,t)); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1) || window.location.search.includes('forceTouch=true');
let touchInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
let touchControlsEl = null;

const CFG = {
    MASS: 1100, 
    ENGINE_FORCE: 55000, 
    MAX_SPEED: 80, // m/s (ca 288 km/h i absolut max teoretisk topfart)
    BRAKE_FORCE: 65000, 
    REVERSE_MAX: 15,
    DRAG: 0.995, // Minskade luftmotståndet avsevärt för att tillåta högre toppfarter
    HANDBRAKE_DRAG: 0.92,
    MAX_STEER: 28, MIN_STEER: 3, WHEELBASE: 2.7,
    DRIFT_STEER_BONUS: 1.5, HANDBRAKE_GRIP: 0.05,
    GRAVITY: 9.81, GRAVITY_AIR_MULT: 1.4, AIR_CONTROL: 0.3,
    CAR_HEIGHT: 0.35, WHEEL_SPIN: 0.15,
    ROLL_SENS: 0.8, PITCH_SENS: 0.12
};
const DMG_VOLT_THRESH = 25; // m/s barrier impact to trigger volt

let car = {
    position: null, velocity: null, heading: 0, speed: 0,
    onGround: true, surfaceName: 'DIRT', surfaceKey: 'DIRT', terrainType: 'ROUGH', mesh: null, wheels: [],
    active: false, isDrifting: false, slipAngleDeg: 0,
    gripFactor: 0.9, currentGrip: 0.55,
    visualRoll: 0, visualPitch: 0,
    prevLateralVel: 0, prevForwardVel: 0,
    displaySpeed: 0,
    _invulnerable: 0, _spawnPosition: null
};
let input = { throttle:0, brake:0, steer:0, handbrake:false };
let keys = {}, lastTime = 0;

// ─── CAR MESH ───
function createCarMesh() {
    let g = new THREE.Group(); g.name = 'RallyCar';
    
    // LÅDBILEN: Bygg en tydlig visuell bil för att förstå fysiken
    let chassisGeom = new THREE.BoxGeometry(1.8, 0.6, 4.0);
    let chassisMat = new THREE.MeshLambertMaterial({color: 0xdc2626});
    let chassis = new THREE.Mesh(chassisGeom, chassisMat);
    chassis.position.y = 0.55; 
    g.add(chassis);
    
    // Vit huv för att visa vad som är FRAMÅT (+Z)
    let hoodGeom = new THREE.BoxGeometry(1.6, 0.3, 1.2);
    let hoodMat = new THREE.MeshLambertMaterial({color: 0xffffff});
    let hood = new THREE.Mesh(hoodGeom, hoodMat);
    hood.position.set(0, 0.7, 1.4); 
    g.add(hood);

    car.wheels = [];
    let wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    let wheelMat = new THREE.MeshLambertMaterial({color: 0x111111});
    let rimGeo = new THREE.BoxGeometry(0.4, 0.6, 0.35);
    let rimMat = new THREE.MeshLambertMaterial({color: 0xffffff});

    let wheelPos = [
        [-1.0, 0.35,  1.3], // Fram vänster
        [ 1.0, 0.35,  1.3], // Fram höger
        [-1.0, 0.35, -1.3], // Bak vänster
        [ 1.0, 0.35, -1.3]  // Bak höger
    ];
    
    for(let i=0; i<4; i++) {
        let steerGroup = new THREE.Group();
        steerGroup.position.set(...wheelPos[i]);
        
        let spinGroup = new THREE.Group();
        let w = new THREE.Mesh(wheelGeo, wheelMat);
        let rim = new THREE.Mesh(rimGeo, rimMat);
        
        spinGroup.add(w);
        spinGroup.add(rim);
        steerGroup.add(spinGroup);
        g.add(steerGroup);
        
        // Spara båda grupperna så vi kan styra dem separat i update()
        car.wheels.push({ steer: steerGroup, spin: spinGroup });
    }

    // TILLFÄLLIGT BORTKOPPLAD GLB FÖR ATT FELSÖKA FYSISK RIKTNING
    /*
    if (window.THREE && window.THREE.GLTFLoader) {
        ... (GLB koden sparad men inaktiv) ...
    }
    */
    return g;
}

// ─── INPUT ───
window.addEventListener('keydown', e=>{ if(car.active) keys[e.code]=true; });
window.addEventListener('keyup', e=>{ keys[e.code]=false; });
function readInput() {
    input.throttle = 0; input.brake = 0; input.steer = 0; input.handbrake = false;
    if(keys['KeyW'] || keys['ArrowUp']) input.throttle = 1;
    if(keys['KeyS'] || keys['ArrowDown']) input.brake = 1;
    if(keys['KeyA'] || keys['ArrowLeft']) input.steer = 1;
    if(keys['KeyD'] || keys['ArrowRight']) input.steer = -1;
    if(keys['Space']) input.handbrake = true;
    
    // Merge mobile touch inputs
    if (isMobile) {
        if (touchInput.throttle) input.throttle = touchInput.throttle;
        if (touchInput.brake) input.brake = touchInput.brake;
        if (touchInput.steer) input.steer = touchInput.steer;
        if (touchInput.handbrake) input.handbrake = touchInput.handbrake;
    }
    
    let gps=navigator.getGamepads?navigator.getGamepads():[];
    for(let gp of gps){ if(!gp||!gp.connected)continue;
        let sx=gp.axes[0]||0; if(Math.abs(sx)<0.12)sx=0;
        let gt=gp.buttons[7]?gp.buttons[7].value:0, gb=gp.buttons[6]?gp.buttons[6].value:0;
        if(gt>0.05||gb>0.05||Math.abs(sx)>0.12){
            input.throttle=gt; input.brake=gb; input.steer=sx;
            input.handbrake=gp.buttons[0]?gp.buttons[0].pressed:false;
        } break;
    }
}

// ─── PHYSICS ───
function updateVehicle(dt) {
    if(!car.active||!car.mesh) return;
    dt = Math.min(dt, 0.05);
    readInput();

    // Terrain + surface
    let terrain = {z:0, normal:[0,0,1], type:'ROUGH'};
    if(typeof window.localGetTerrainAt==='function')
        terrain = window.localGetTerrainAt(car.position.x, -car.position.z);
    let surface = window.resolveSurface ? window.resolveSurface(terrain.type) : {grip:0.5,longGrip:0.6,brake:0.65,maxSpeed:0.82,accel:0.78,dragAdd:0.015,driftThreshold:10,driftSustain:1.4,driftRecovery:0.65,rumble:0,depthVariance:0,landing:0.65};
    car.surfaceName = surface.label || terrain.type;
    car.surfaceKey = (window.RALLY_SURFACE_MAP && window.RALLY_SURFACE_MAP[terrain.type]) || terrain.type;
    car.terrainType = terrain.type;

    // Damage modifiers (queried once per frame)
    let dmgMod = window.rallyDamage ? window.rallyDamage.getModifiers() : {steerMult:1,accelMult:1,maxSpeedMult:1};

    // Smooth surface transition
    car.currentGrip = lerp(car.currentGrip, surface.grip, 4.0*dt);

    // Direction vectors
    let fwd = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));
    let right = new THREE.Vector3(Math.cos(car.heading), 0, -Math.sin(car.heading));

    // Decompose velocity
    let forwardVel = car.velocity.dot(fwd);
    let lateralVel = car.velocity.dot(right);
    car.speed = forwardVel;
    // displaySpeed beräknas korrekt efter speed cap nedan (BUG-16: denna rad var redundant)

    // Slip angle
    let slipAngle = 0;
    if(Math.abs(forwardVel)>0.5)
        slipAngle = Math.atan2(lateralVel, Math.abs(forwardVel));
    car.slipAngleDeg = slipAngle * 180/Math.PI;

    // Drift state (with hysteresis)
    // Post-flip grace: suppress drift entry for 1.5s after volt recovery
    if (window.rallyDamage && window.rallyDamage.hasPostFlipGrace()) {
        car.isDrifting = false;
    } else {
        let threshRad = surface.driftThreshold * Math.PI/180;
        if(Math.abs(slipAngle) > threshRad) car.isDrifting = true;
        else if(Math.abs(slipAngle) < threshRad*0.5) car.isDrifting = false;
    }

    // Grip factor curve (lerped, not binary)
    let targetGrip;
    if(input.handbrake && forwardVel > 3) targetGrip = CFG.HANDBRAKE_GRIP;
    else if(car.isDrifting) targetGrip = 0.20; // Sänkt från 0.25 för mer svepande sladdar (80% sidobevarande)
    else targetGrip = 0.90;
    let gripSpeed = car.isDrifting ? (surface.driftSustain*3.0) : (surface.driftRecovery*5.0);
    car.gripFactor = lerp(car.gripFactor, targetGrip, gripSpeed*dt);

    // === ACCELERATION ===
    if(input.throttle>0 && forwardVel>=0) {
        let speedRatio = clamp(forwardVel/CFG.MAX_SPEED, 0, 1);
        let throttleScale = 1.0 - speedRatio*speedRatio;
        let accel = (CFG.ENGINE_FORCE/CFG.MASS) * throttleScale * input.throttle * surface.accel;
        accel *= dmgMod.accelMult;
        
        // Traction limit (Väg 1): limit forward acceleration by normal-force-derived tire friction
        let normalY = car.onGround ? ((terrain.normal && terrain.normal[2] !== undefined) ? terrain.normal[2] : 1.0) : 0.0;
        let maxTractionAccel = CFG.GRAVITY * surface.grip * normalY * 4.0;
        accel = Math.min(accel, maxTractionAccel);
        
        car.velocity.addScaledVector(fwd, accel*dt);
    } else if(input.throttle>0 && forwardVel<0) {
        // Throttle while reversing = brake
        // ARKAD-FIX: Om man har spunnit 180 grader och håller gasen (W) vill vi 
        // stoppa bakåt-glidet extremt snabbt så det inte känns som att W backar!
        car.velocity.addScaledVector(fwd, (CFG.BRAKE_FORCE/CFG.MASS) * 2.0 * dt);
    }
    // Reverse — aktiveras när bilen är nästan stillastående (forwardVel ≤0.1 m/s)
    if(input.brake>0 && forwardVel<=0.1) {
        let accel = (CFG.ENGINE_FORCE/CFG.MASS)*0.4*input.brake*surface.accel;
        
        // Traction limit for reverse
        let normalY = car.onGround ? ((terrain.normal && terrain.normal[2] !== undefined) ? terrain.normal[2] : 1.0) : 0.0;
        let maxTractionAccel = CFG.GRAVITY * surface.grip * normalY * 4.0;
        accel = Math.min(accel, maxTractionAccel);
        
        car.velocity.addScaledVector(fwd, -accel*dt);
    }
    // Braking — FYN-01 fix: tröskel sänkt från > 0.5 till > 0.1 m/s.
    // Matchar nu reverse-tröskeln så att dödzonen 0.1–0.5 m/s är stängd.
    // Tidigare hanterades inte broms alls i det intervallet.
    if(input.brake>0 && forwardVel>0.1) {
        let brakeAccel = (CFG.BRAKE_FORCE/CFG.MASS)*input.brake*surface.brake;
        let newFwd = forwardVel - brakeAccel*dt;
        if(newFwd<0) newFwd=0;
        car.velocity.addScaledVector(fwd, (newFwd-forwardVel));
    }

    // === SLOPE GRAVITY (mountain physics) ===
    // terrain.normal = [nx, nz, ny] where ny≈1 for flat ground
    // When surface tilts, nx/nz indicate slope direction
    // Gravity component along slope surface pushes car downhill
    if (car.onGround) {
        let nx = terrain.normal[0] || 0;
        let nz = terrain.normal[1] || 0;

        // Gravity force projected onto terrain surface (world space)
        let slopeGravX = CFG.GRAVITY * nx;
        let slopeGravZ = CFG.GRAVITY * nz;

        // Decompose into car-relative axes
        let slopeFwd = slopeGravX * fwd.x + slopeGravZ * fwd.z;      // uphill(-) / downhill(+)
        let slopeLat = slopeGravX * right.x + slopeGravZ * right.z;   // side push

        // Forward: full gravity effect (uphills slow you, downhills speed you up)
        car.velocity.addScaledVector(fwd, slopeFwd * dt);

        // Lateral: reduced by grip (high grip = tires resist side-slide)
        let sideSlipFactor = 1.0 - car.gripFactor * surface.grip;     // 0 = no slide, 1 = full slide
        car.velocity.addScaledVector(right, slopeLat * sideSlipFactor * dt);
    }

    // === LATERAL CORRECTION (THE DRIFT MAGIC) ===
    let lateralRetain = Math.pow(1-car.gripFactor, 60*dt);
    car.velocity.addScaledVector(right, lateralVel*(lateralRetain-1));

    // Handbrake extra drag
    let dragMult = CFG.DRAG - surface.dragAdd;
    if(input.handbrake) dragMult = Math.min(dragMult, CFG.HANDBRAKE_DRAG);
    car.velocity.multiplyScalar(Math.pow(dragMult, 60*dt));

    // Natural decel at low speed
    let spd = car.velocity.length();
    if(input.throttle===0 && input.brake===0 && spd<1.0) car.velocity.multiplyScalar(0.95);
    if(spd<0.1 && input.throttle===0) car.velocity.set(0,car.velocity.y,0);

    // Speed cap (with damage penalty)
    let maxSpd = CFG.MAX_SPEED * surface.maxSpeed * dmgMod.maxSpeedMult;
    let hSpd = Math.sqrt(car.velocity.x*car.velocity.x + car.velocity.z*car.velocity.z);
    let hSpdPreCap = hSpd;          // scalar speed before cap — barrier damage uses this
    let vxPreCap = car.velocity.x;  // velocity vector before cap — for latComp + volt direction
    let vzPreCap = car.velocity.z;
    if(hSpd>maxSpd) { let s=maxSpd/hSpd; car.velocity.x*=s; car.velocity.z*=s; }
    // displaySpeed from POST-cap velocity (HUD and respawn read correct value)
    car.displaySpeed = Math.sqrt(car.velocity.x*car.velocity.x + car.velocity.z*car.velocity.z);
    // Reverse cap
    let fv2 = car.velocity.dot(fwd);
    if(fv2 < -CFG.REVERSE_MAX) {
        car.velocity.addScaledVector(fwd, -CFG.REVERSE_MAX - fv2);
    }

    // ─── BARRIER COLLISION — delta-V damage + volt ───
    // BARRIER.maxSpeed=0.00 zeroes velocity during speed cap above.
    // All three values (speed, direction, latComp) must use pre-cap data.
    //
    // speedAfter = speedBefore * 0.9 (analytical: 10% speed-loss per impact frame)
    //
    // applyDamage(impactSpeed) takes m/s with threshold 8 and multiplier 0.003:
    //   dmg = (impactSpeed - 8) * 0.003
    //   20 m/s → (20-8)*0.003 = 0.036 = 3.6% damage  ✓
    //   50 m/s → (50-8)*0.003 = 0.126 = 12.6% damage  ✓
    //   10 m/s → (10-8)*0.003 = 0.006 = 0.6% damage   ✓
    //    8 m/s → below threshold, no damage
    //
    // DMG_VOLT_THRESH: read from rallyDamage config if exposed, else use local constant.
    // This avoids drift between rally-vehicle.js and the VOLT_SPEED_THRESHOLD in rally-damage.js.
    if (terrain.type.toUpperCase() === 'OB') {
        let speedBefore = hSpdPreCap;          // pre-cap approach speed (m/s)
        car.velocity.x *= 0.9; car.velocity.z *= 0.9; // physics damping (no-op when BARRIER cap=0)
        // Pass speedBefore directly — applyDamage() takes m/s, not scaled damage points
        if (window.rallyDamage && speedBefore >= 8) { // 8 m/s = DMG.SPEED_THRESHOLD
            window.rallyDamage.applyDamage(speedBefore);
            if (window.rallyCamera) window.rallyCamera.triggerShake(speedBefore * 0.4);
            // Volt threshold: prefer damage system's own config to avoid duplication
            let voltThresh = (window.rallyDamage.cfg && window.rallyDamage.cfg.VOLT_SPEED_THRESHOLD)
                ? window.rallyDamage.cfg.VOLT_SPEED_THRESHOLD
                : DMG_VOLT_THRESH;
            if (speedBefore > voltThresh) {
                let latComp = Math.abs(vxPreCap * right.x + vzPreCap * right.z);
                if (latComp > 5 || speedBefore > 35) {
                    let savedVx = car.velocity.x, savedVz = car.velocity.z;
                    car.velocity.x = vxPreCap; car.velocity.z = vzPreCap;
                    window.rallyDamage.triggerVolt(car, fwd, right);
                    car.velocity.x = savedVx; car.velocity.z = savedVz;
                }
            }
        }
    }

    // === STEERING (circle-arc model) ===
    let postDragFwd = car.velocity.dot(fwd); // recalc after drag/lateral correction
    if(car.onGround && Math.abs(postDragFwd)>0.3 && Math.abs(input.steer)>0.01) {
        let speedT = clamp(Math.abs(postDragFwd)/CFG.MAX_SPEED, 0, 1);
        let steerDeg = lerp(CFG.MAX_STEER, CFG.MIN_STEER, speedT);
        steerDeg *= dmgMod.steerMult;
        if(car.isDrifting) steerDeg *= CFG.DRIFT_STEER_BONUS;
        let steerRad = steerDeg * Math.PI/180 * Math.abs(input.steer);
        let turnRadius = CFG.WHEELBASE / Math.tan(steerRad + 0.001);
        let angularVel = postDragFwd / turnRadius;
        let yaw = angularVel * Math.sign(input.steer) * dt;
        car.heading += yaw;
    }

    // === POSITION UPDATE ===
    car.position.x += car.velocity.x * dt;
    car.position.z += car.velocity.z * dt;

    // === TERRAIN FOLLOWING ===
    let groundY = terrain.z;
    if(car.position.y > groundY + CFG.CAR_HEIGHT + 0.3) {
        car.onGround = false;
        car.velocity.y -= CFG.GRAVITY * CFG.GRAVITY_AIR_MULT * dt;
        car.position.y += car.velocity.y * dt;
        // Air control
        if(Math.abs(input.steer)>0.1)
            car.heading += input.steer * CFG.AIR_CONTROL * dt;
        if(car.position.y <= groundY + CFG.CAR_HEIGHT) {
            car.position.y = groundY + CFG.CAR_HEIGHT;
            // Landing absorption
            let landingImpact = -car.velocity.y; // positive m/s downward
            if(car.velocity.y < -5) car.visualPitch = clamp(car.velocity.y*0.5, -8, 0);
            car.velocity.y *= -0.15 * surface.landing;
            if(Math.abs(car.velocity.y)<0.5) car.velocity.y=0;
            car.onGround = true;
            // Damage from hard landing
            if (window.rallyDamage && landingImpact > 8) {
                window.rallyDamage.applyDamage(landingImpact);
                if (window.rallyCamera) window.rallyCamera.triggerShake(landingImpact);
            }
        }
    } else {
        car.onGround = true;
        car.velocity.y = 0;
        car.position.y += (groundY + CFG.CAR_HEIGHT - car.position.y) * 0.3;
    }

    // World bounds
    let half = (window.TERRAIN_SIZE||900)/2-5;
    car.position.x = clamp(car.position.x, -half, half);
    car.position.z = clamp(car.position.z, -half, half);

    // === VISUAL SUSPENSION (time-normalized lerps) ===
    let latAccel = (lateralVel - car.prevLateralVel) / Math.max(dt,0.001);
    car.prevLateralVel = lateralVel;
    // SPELKÄNSLA: Öka roll/krängning markant vid styrning så bilen lutar utåt i svängen (centrifugalkraft)
    let rollAssist = -input.steer * 4.0; 
    let tgtRoll = clamp(latAccel*CFG.ROLL_SENS + rollAssist, -15, 15);
    let rollRate = 1 - Math.pow(1 - 0.2, dt * 60);
    car.visualRoll = lerp(car.visualRoll, tgtRoll, rollRate);

    let fwdAccel = (forwardVel - car.prevForwardVel) / Math.max(dt,0.001);
    car.prevForwardVel = forwardVel;
    // SPELKÄNSLA: Öka pitch mjukt vid gas/broms så nosen lyfts/dyker (klampad för att förhindra mark-clipping)
    let pitchAssist = 0;
    if(input.throttle > 0) pitchAssist = -1.2; // W = Nosen upp
    if(input.brake > 0) pitchAssist = 2.0;    // S = Nosen ner
    // FIX: fwdAccel måste vara negativ för att lyfta nosen!
    let tgtPitch = clamp(-fwdAccel*CFG.PITCH_SENS + pitchAssist, -4, 4);
    let pitchRate = 1 - Math.pow(1 - 0.2, dt * 60);
    car.visualPitch = lerp(car.visualPitch, tgtPitch, pitchRate);

    // Terrain slope
    let slopePitch = 0;
    let slopeRoll = 0;
    if (car.onGround) {
        let nx = terrain.normal[0]||0, nz = terrain.normal[1]||0;
        // Pitch: nose up/down to match slope. 0.95 multiplier for realistic alignment.
        slopePitch = (nx*Math.sin(car.heading) + nz*Math.cos(car.heading)) * 0.95;
        // Roll: tilt left/right. Inverted sign so car tilts with the hill side instead of into it.
        slopeRoll = (-nx*Math.cos(car.heading) + nz*Math.sin(car.heading)) * 0.95;
    }

    // Skip mesh rotation if volting (damage system controls rotation)
    if (window.rallyDamage && window.rallyDamage.isVolting()) {
        car.mesh.position.copy(car.position);
        car.mesh.rotation.order = "YXZ"; // Viktigt för Pitch/Roll
        // Volt handles rotation — only set Y (heading)
        car.mesh.rotation.y = car.heading;
    } else if (window.rallyDamage && window.rallyDamage.isFlipped()) {
        car.mesh.position.copy(car.position);
        car.mesh.rotation.order = "YXZ"; // Viktigt för Pitch/Roll
        car.mesh.rotation.y = car.heading; // Keep heading updated during flip
        // Flip recovery handles x/z rotation
    } else {
        // Normal mesh update
        car.mesh.position.copy(car.position);
        car.mesh.rotation.order = "YXZ"; // FIX: Pitch/Roll måste räknas från bilens lokala riktning!
        car.mesh.rotation.y = car.heading; // FIX: Tog bort minustecknet som gjorde att bilen svängde åt fel håll visuellt!
        car.mesh.rotation.x = slopePitch + car.visualPitch*Math.PI/180;
        car.mesh.rotation.z = slopeRoll + car.visualRoll*Math.PI/180;
    }

    // Wheel spin + steer
    let wheelRotSpeed = car.speed / 0.35; // radie
    car.wheels.forEach((w, i) => {
        // w.spin hanterar däckens snurr runt X-axeln
        w.spin.rotation.x += wheelRotSpeed * dt;
        // w.steer hanterar hjulens svängning runt Y-axeln
        w.steer.rotation.y = 0; // reset
        if(i<2) w.steer.rotation.y = input.steer * 0.45; // FIX: Tog bort minustecknet så hjulen svänger åt rätt håll
    });
}

// =============================================================
// ─── HUD (Speed, Surface, Grip, Drift, Damage) ───
// All HUD elements are created once and updated every frame.
// Damage bar reads from window.rallyDamage if present.
// =============================================================
function createHUD() {
    let ex=document.getElementById('rally-hud'); if(ex) ex.remove();
    let h=document.createElement('div'); h.id='rally-hud';
    let hudStyle = isMobile 
        ? "position:fixed;top:16px;right:16px;z-index:9999;pointer-events:none;font-family:'Inter','Segoe UI',sans-serif"
        : "position:fixed;bottom:30px;right:30px;z-index:9999;pointer-events:none;font-family:'Inter','Segoe UI',sans-serif";
    
    let innerHTML = '';
    if (isMobile) {
        innerHTML = `
        <div style="background:rgba(15,23,42,0.92);border:1px solid #334155;border-radius:16px;padding:10px 18px;backdrop-filter:blur(12px);display:flex;align-items:center;gap:14px;pointer-events:none;box-shadow:0 8px 32px rgba(0,0,0,0.3)">
            <div style="text-align:center;min-width:55px;">
                <div id="rally-speed" style="font-size:32px;font-weight:900;color:#4ade80;letter-spacing:-1px;line-height:1">0</div>
                <div style="font-size:9px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-top:1px">km/h</div>
            </div>
            <div style="width:1px;height:30px;background:#334155"></div>
            <div style="display:flex;flex-direction:column;gap:1px;font-size:10px;font-weight:bold">
                <div style="display:flex;justify-content:space-between;gap:6px;"><span style="color:#64748b">SURF:</span><span id="rally-surface" style="color:#4ade80">DIRT</span></div>
                <div style="display:flex;justify-content:space-between;gap:6px;"><span style="color:#64748b">GRIP:</span><span id="rally-grip" style="color:#fbbf24">50%</span></div>
                <div style="font-size:8px;color:#475569">Slip: <span id="rally-slip">0</span>°</div>
            </div>
            <div style="width:1px;height:30px;background:#334155"></div>
            <div style="min-width:70px">
                <div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold;margin-bottom:2px">Damage</div>
                <div style="background:#1e293b;border-radius:3px;height:5px;overflow:hidden">
                    <div id="rally-damage-bar" style="height:100%;width:0%;background:#4ade80;border-radius:3px;transition:width 0.2s,background 0.4s"></div>
                </div>
                <div id="rally-damage-text" style="font-size:9px;color:#4ade80;font-weight:bold;margin-top:2px;text-align:right">0%</div>
            </div>
            <div id="rally-drift-badge" style="font-size:10px;font-weight:900;color:#f97316;opacity:0;transition:opacity 0.2s;position:absolute;bottom:-18px;left:50%;transform:translateX(-50%)">🔥 DRIFT</div>
        </div>`;
    } else {
        innerHTML = `
        <div style="background:rgba(15,23,42,0.92);border:1px solid #334155;border-radius:16px;padding:16px 24px;backdrop-filter:blur(12px);min-width:180px;text-align:center">
        <div id="rally-speed" style="font-size:52px;font-weight:900;color:#38bdf8;letter-spacing:-2px;line-height:1">0</div>
        <div style="font-size:11px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:2px;margin-top:2px">km/h</div>
        <div style="height:1px;background:#334155;margin:10px 0"></div>
        <div style="display:flex;justify-content:space-between;align-items:center">
        <div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Surface</div>
        <div id="rally-surface" style="font-size:12px;color:#4ade80;font-weight:bold">DIRT</div></div>
        <div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Grip</div>
        <div id="rally-grip" style="font-size:12px;color:#fbbf24;font-weight:bold">50%</div></div></div>
        <div id="rally-drift-badge" style="font-size:14px;font-weight:900;color:#f97316;margin-top:6px;opacity:0;transition:opacity 0.2s">🔥 DRIFT</div>
        <div style="font-size:9px;color:#475569;margin-top:4px">Slip: <span id="rally-slip">0</span>°</div>
        <div style="height:1px;background:#334155;margin:10px 0"></div>
        <div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold;margin-bottom:4px">Car Damage</div>
        <div style="background:#1e293b;border-radius:4px;height:6px;overflow:hidden">
          <div id="rally-damage-bar" style="height:100%;width:0%;background:#4ade80;border-radius:4px;transition:width 0.2s,background 0.4s"></div>
        </div>
        <div id="rally-damage-text" style="font-size:10px;color:#4ade80;font-weight:bold;margin-top:3px">0%</div>
        </div>`;
    }

    h.innerHTML=`<div style="${hudStyle}">${innerHTML}</div>
<div id="rally-controls-hint" style="position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;
background:rgba(15,23,42,0.9);border:1px solid #334155;border-radius:12px;padding:12px 24px;backdrop-filter:blur(8px);
font-family:'Inter',sans-serif;transition:opacity 2s ease">
<div style="color:#e2e8f0;font-size:13px;font-weight:bold;text-align:center">🏎️ RALLY MODE</div>
<div style="color:#94a3b8;font-size:11px;margin-top:4px;text-align:center">
<b>W/↑</b> Gas &nbsp; <b>S/↓</b> Broms &nbsp; <b>A/D</b> Sväng &nbsp; <b>SPACE</b> Handbroms &nbsp; <b>R</b> Fastnat (Unstuck) &nbsp; <b>BACKSPACE</b> Backa till CP</div>
<div style="color:#64748b;font-size:10px;margin-top:2px;text-align:center">🎮 Gamepad: Triggers=Gas/Broms, Stick=Sväng, A=Handbroms</div></div>`;

    document.body.appendChild(h);
    setTimeout(()=>{ let c=document.getElementById('rally-controls-hint'); if(c)c.style.opacity='0'; setTimeout(()=>{if(c)c.remove();},2000); },5000);
}

function updateHUD() {
    let se=document.getElementById('rally-speed'),
        su=document.getElementById('rally-surface'),
        gr=document.getElementById('rally-grip'),
        dr=document.getElementById('rally-drift-badge'),
        sl=document.getElementById('rally-slip'),
        db=document.getElementById('rally-damage-bar'),
        dt2=document.getElementById('rally-damage-text');
    if(se){
        let kmh=Math.round(car.displaySpeed*3.6);
        se.textContent=kmh;
        se.style.color = kmh<80?'#4ade80':kmh<140?'#fbbf24':'#ef4444';
    }
    if(su){
        su.textContent=car.surfaceName;
        let surface = window.resolveSurface ? window.resolveSurface(car.surfaceKey) : null;
        su.style.color = surface ? surface.color : '#94a3b8';
    }
    if(gr){
        let pct=Math.round(car.gripFactor*100);
        gr.textContent=pct+'%';
        gr.style.color = pct>70?'#4ade80':pct>40?'#fbbf24':'#ef4444';
    }
    if(dr) dr.style.opacity = car.isDrifting?'1':'0';
    if(sl) sl.textContent = Math.abs(Math.round(car.slipAngleDeg));
    // Damage bar (reads from rallyDamage module)
    if(db && dt2) {
        let dmg = window.rallyDamage ? window.rallyDamage.getDamage() : 0;
        let pct = Math.round(dmg * 100);
        db.style.width = pct + '%';
        let col = pct < 30 ? '#4ade80' : pct < 60 ? '#fbbf24' : pct < 90 ? '#f97316' : '#ef4444';
        db.style.background = col;
        dt2.style.color = col;
        dt2.textContent = pct + '%';
    }
}

function createTouchControls() {
    if (touchControlsEl) return;
    
    touchControlsEl = document.createElement('div');
    touchControlsEl.id = 'rally-touch-controls';
    
    // Left Steering Panel (← / →)
    let leftPanel = document.createElement('div');
    leftPanel.style.cssText = 'position:fixed;bottom:25px;left:25px;display:flex;gap:12px;z-index:10000;pointer-events:auto;';
    
    let btnLeft = document.createElement('div');
    btnLeft.style.cssText = 'width:72px;height:72px;background:rgba(255,255,255,0.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.15);border-radius:50%;color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:bold;user-select:none;-webkit-user-select:none;cursor:pointer;box-shadow:0 8px 32px rgba(0,0,0,0.2);';
    btnLeft.innerHTML = '←';
    
    let btnRight = document.createElement('div');
    btnRight.style.cssText = btnLeft.style.cssText;
    btnRight.innerHTML = '→';
    
    let steerLeft = false, steerRight = false;
    function updateSteer() {
        touchInput.steer = (steerLeft ? 1 : 0) + (steerRight ? -1 : 0);
    }
    
    btnLeft.addEventListener('touchstart', e => { e.preventDefault(); steerLeft = true; updateSteer(); btnLeft.style.background = 'rgba(255,255,255,0.25)'; });
    btnLeft.addEventListener('touchend', e => { e.preventDefault(); steerLeft = false; updateSteer(); btnLeft.style.background = 'rgba(255,255,255,0.08)'; });
    btnLeft.addEventListener('touchcancel', e => { e.preventDefault(); steerLeft = false; updateSteer(); btnLeft.style.background = 'rgba(255,255,255,0.08)'; });
    
    btnRight.addEventListener('touchstart', e => { e.preventDefault(); steerRight = true; updateSteer(); btnRight.style.background = 'rgba(255,255,255,0.25)'; });
    btnRight.addEventListener('touchend', e => { e.preventDefault(); steerRight = false; updateSteer(); btnRight.style.background = 'rgba(255,255,255,0.08)'; });
    btnRight.addEventListener('touchcancel', e => { e.preventDefault(); steerRight = false; updateSteer(); btnRight.style.background = 'rgba(255,255,255,0.08)'; });
    
    leftPanel.appendChild(btnLeft);
    leftPanel.appendChild(btnRight);
    touchControlsEl.appendChild(leftPanel);
    
    // Right Throttle/Brake/Handbrake Panel
    let rightPanel = document.createElement('div');
    rightPanel.style.cssText = 'position:fixed;bottom:25px;right:25px;display:flex;flex-direction:column;gap:12px;align-items:flex-end;z-index:10000;pointer-events:auto;';
    
    let btnDrift = document.createElement('div');
    btnDrift.style.cssText = 'width:100px;height:42px;background:rgba(249,115,22,0.15);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(249,115,22,0.4);border-radius:21px;color:#f97316;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;letter-spacing:1px;user-select:none;-webkit-user-select:none;cursor:pointer;box-shadow:0 8px 32px rgba(249,115,22,0.1);';
    btnDrift.innerHTML = 'DRIFT';
    
    btnDrift.addEventListener('touchstart', e => { e.preventDefault(); touchInput.handbrake = true; btnDrift.style.background = 'rgba(249,115,22,0.35)'; });
    btnDrift.addEventListener('touchend', e => { e.preventDefault(); touchInput.handbrake = false; btnDrift.style.background = 'rgba(249,115,22,0.15)'; });
    btnDrift.addEventListener('touchcancel', e => { e.preventDefault(); touchInput.handbrake = false; btnDrift.style.background = 'rgba(249,115,22,0.15)'; });
    
    let rowSpeed = document.createElement('div');
    rowSpeed.style.cssText = 'display:flex;gap:12px;align-items:center;';
    
    let btnBrake = document.createElement('div');
    btnBrake.style.cssText = 'width:68px;height:68px;background:rgba(239,68,68,0.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(239,68,68,0.4);border-radius:50%;color:#ef4444;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;user-select:none;-webkit-user-select:none;cursor:pointer;box-shadow:0 8px 32px rgba(239,68,68,0.1);';
    btnBrake.innerHTML = 'BROM';
    
    btnBrake.addEventListener('touchstart', e => { e.preventDefault(); touchInput.brake = 1; btnBrake.style.background = 'rgba(239,68,68,0.3)'; });
    btnBrake.addEventListener('touchend', e => { e.preventDefault(); touchInput.brake = 0; btnBrake.style.background = 'rgba(239,68,68,0.12)'; });
    btnBrake.addEventListener('touchcancel', e => { e.preventDefault(); touchInput.brake = 0; btnBrake.style.background = 'rgba(239,68,68,0.12)'; });
    
    let btnGas = document.createElement('div');
    btnGas.style.cssText = 'width:84px;height:84px;background:rgba(34,197,94,0.15);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(34,197,94,0.4);border-radius:50%;color:#22c55e;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;user-select:none;-webkit-user-select:none;cursor:pointer;box-shadow:0 8px 32px rgba(34,197,94,0.15);';
    btnGas.innerHTML = 'GAS';
    
    btnGas.addEventListener('touchstart', e => { e.preventDefault(); touchInput.throttle = 1; btnGas.style.background = 'rgba(34,197,94,0.35)'; });
    btnGas.addEventListener('touchend', e => { e.preventDefault(); touchInput.throttle = 0; btnGas.style.background = 'rgba(34,197,94,0.15)'; });
    btnGas.addEventListener('touchcancel', e => { e.preventDefault(); touchInput.throttle = 0; btnGas.style.background = 'rgba(34,197,94,0.15)'; });
    
    rowSpeed.appendChild(btnBrake);
    rowSpeed.appendChild(btnGas);
    rightPanel.appendChild(btnDrift);
    rightPanel.appendChild(rowSpeed);
    touchControlsEl.appendChild(rightPanel);
    
    // Top Panel: Respawn / Checkpoint buttons
    let topPanel = document.createElement('div');
    topPanel.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:10000;pointer-events:auto;';
    
    let btnUnstuck = document.createElement('div');
    btnUnstuck.style.cssText = 'background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid #334155;color:#fbbf24;border-radius:20px;padding:8px 14px;font-size:12px;font-weight:bold;cursor:pointer;user-select:none;-webkit-user-select:none;box-shadow:0 4px 12px rgba(0,0,0,0.25);';
    btnUnstuck.innerHTML = '🔄 Fastnat';
    btnUnstuck.addEventListener('click', e => {
        if (window.rallyRespawn) window.rallyRespawn.triggerRespawn();
    });
    
    let btnCP = document.createElement('div');
    btnCP.style.cssText = 'background:rgba(15,23,42,0.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid #334155;color:#ef4444;border-radius:20px;padding:8px 14px;font-size:12px;font-weight:bold;cursor:pointer;user-select:none;-webkit-user-select:none;box-shadow:0 4px 12px rgba(0,0,0,0.25);';
    btnCP.innerHTML = '🚩 Backa till CP';
    btnCP.addEventListener('click', e => {
        if (window.rallyRespawn) window.rallyRespawn.triggerCheckpointRespawn();
    });
    
    topPanel.appendChild(btnUnstuck);
    topPanel.appendChild(btnCP);
    touchControlsEl.appendChild(topPanel);
    
    document.body.appendChild(touchControlsEl);
}

function destroyTouchControls() {
    if (touchControlsEl) {
        touchControlsEl.remove();
        touchControlsEl = null;
    }
    touchInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
}

// ─── PUBLIC API ───
window.rallyVehicle = {
    activate: function(scene, camera, controls) {
        if(car.mesh) scene.remove(car.mesh);
        car.mesh = createCarMesh();
        car.position = new THREE.Vector3(0,2,0);
        car.velocity = new THREE.Vector3(0,0,0);
        car.speed=0; car.heading=0; car.active=true;
        car.isDrifting=false; car.gripFactor=0.9;
        car.visualRoll=0; car.visualPitch=0;
        car.prevLateralVel=0; car.prevForwardVel=0;
        car.displaySpeed=0; car.terrainType='ROUGH';
        car.surfaceKey='DIRT'; car.surfaceName='DIRT';
        keys={};
        lastTime = 0;
        car._invulnerable = 0;
        if(typeof window.localGetTerrainAt==='function'){
            let t=window.localGetTerrainAt(0,0);
            car.position.y = t.z+CFG.CAR_HEIGHT;
        }
        scene.add(car.mesh);
        // Init camera AFTER terrain height is set
        if (window.rallyCamera) window.rallyCamera.init(car);
        createHUD();
        // Reset damage system
        if (window.rallyDamage) window.rallyDamage.reset();
        // Save spawn position for respawn fallback (after terrain adjust)
        car._spawnPosition = car.position.clone();
        // Init respawn system
        if (window.rallyRespawn) window.rallyRespawn.init(car);
        
        // Touch controls setup on mobile
        if (isMobile) createTouchControls();
        
        console.log('🏎️ Rally Vehicle activated (drift physics v4 + damage + camera + respawn)');
    },
    deactivate: function(scene) {
        car.active=false;
        if(car.mesh){scene.remove(car.mesh); car.mesh=null;}
        let h=document.getElementById('rally-hud'); if(h)h.remove();
        if (window.rallyRespawn) window.rallyRespawn.cleanup();
        
        // Clean up mobile touch controls
        destroyTouchControls();
        
        keys={}; console.log('🏎️ Rally Vehicle deactivated');
    },
    update: function(camera) {
        let now=performance.now();
        let realDt=lastTime?(now-lastTime)/1000:0.016;
        lastTime=now;
        realDt = Math.min(realDt, 0.05);
        // Compute physDt (slow-mo applied by camera system)
        let physDt = window.rallyCamera ? window.rallyCamera.computePhysDt(realDt) : realDt;
        updateVehicle(physDt);
        if (window.rallyCamera) window.rallyCamera.update(camera, physDt, realDt);
        if (window.rallyDamage) window.rallyDamage.update(physDt);
        if (window.rallyRespawn) window.rallyRespawn.update(physDt);
        updateHUD();
    },
    isActive:()=>car.active,
    getSpeed:()=>car.speed,
    getPosition:()=>car.position,
    getCar:()=>car,
    isDrifting:()=>car.isDrifting,
    getSlipAngle:()=>car.slipAngleDeg,
    getKeys:()=>keys,
    getInput:()=>input
};
})();
