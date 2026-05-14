// rally-vehicle.js — Full arcade rally physics with drift system
(function() {
'use strict';

function lerp(a,b,t){ return a+(b-a)*Math.max(0,Math.min(1,t)); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

const CFG = {
    MASS: 1100, ENGINE_FORCE: 9000, MAX_SPEED: 52,
    BRAKE_FORCE: 15000, REVERSE_MAX: 12,
    DRAG: 0.97, HANDBRAKE_DRAG: 0.92,
    MAX_STEER: 28, MIN_STEER: 2, WHEELBASE: 2.7,
    DRIFT_STEER_BONUS: 1.3, HANDBRAKE_GRIP: 0.05,
    GRAVITY: 9.81, GRAVITY_AIR_MULT: 1.4, AIR_CONTROL: 0.3,
    CAR_HEIGHT: 0.35, WHEEL_SPIN: 0.15,
    ROLL_SENS: 0.8, PITCH_SENS: 0.4
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
    let bodyMat = new THREE.MeshLambertMaterial({color:0xdc2626});
    let body = new THREE.Mesh(new THREE.BoxGeometry(2.0,0.55,4.2), bodyMat);
    body.position.y=0.35; body.castShadow=true; g.add(body);
    let roof = new THREE.Mesh(new THREE.BoxGeometry(1.6,0.45,1.8), new THREE.MeshLambertMaterial({color:0xb91c1c}));
    roof.position.set(0,0.85,-0.3); roof.castShadow=true; g.add(roof);
    let windMat = new THREE.MeshLambertMaterial({color:0x1e293b,transparent:true,opacity:0.7});
    let ws = new THREE.Mesh(new THREE.BoxGeometry(1.5,0.4,0.05), windMat);
    ws.position.set(0,0.82,0.6); ws.rotation.x=-0.25; g.add(ws);
    let rw = ws.clone(); rw.position.set(0,0.82,-1.2); rw.rotation.x=0.2; g.add(rw);
    let lgeo = new THREE.BoxGeometry(0.35,0.15,0.05);
    [-0.6,0.6].forEach(x=>{
        g.add(Object.assign(new THREE.Mesh(lgeo, new THREE.MeshBasicMaterial({color:0xfef08a})),{position:new THREE.Vector3(x,0.35,2.13)}));
        g.add(Object.assign(new THREE.Mesh(lgeo, new THREE.MeshBasicMaterial({color:0xef4444})),{position:new THREE.Vector3(x,0.35,-2.13)}));
    });
    let platGeo=new THREE.BoxGeometry(0.05,0.4,0.5), platMat=new THREE.MeshLambertMaterial({color:0xffffff});
    [-1.02,1.02].forEach(x=>{ let p=new THREE.Mesh(platGeo,platMat); p.position.set(x,0.45,0); g.add(p); });
    let bar=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.08,0.15), new THREE.MeshLambertMaterial({color:0x334155}));
    bar.position.set(0,1.12,-0.1); g.add(bar);
    let podMat=new THREE.MeshBasicMaterial({color:0xfef9c3}), podGeo=new THREE.BoxGeometry(0.2,0.12,0.12);
    [-0.6,-0.2,0.2,0.6].forEach(x=>{ let p=new THREE.Mesh(podGeo,podMat); p.position.set(x,1.2,-0.1); g.add(p); });
    car.wheels=[];
    [{x:-0.95,z:1.3},{x:0.95,z:1.3},{x:-0.95,z:-1.3},{x:0.95,z:-1.3}].forEach(wp=>{
        let wg=new THREE.Group();
        let tire=new THREE.Mesh(new THREE.CylinderGeometry(0.32,0.32,0.22,10), new THREE.MeshLambertMaterial({color:0x1a1a1a}));
        tire.rotation.z=Math.PI/2; tire.castShadow=true; wg.add(tire);
        let rim=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.15,0.24,6), new THREE.MeshLambertMaterial({color:0x94a3b8}));
        rim.rotation.z=Math.PI/2; wg.add(rim);
        wg.position.set(wp.x,0,wp.z); g.add(wg); car.wheels.push(wg);
    });
    return g;
}

// ─── INPUT ───
window.addEventListener('keydown', e=>{ if(car.active) keys[e.code]=true; });
window.addEventListener('keyup', e=>{ keys[e.code]=false; });
function readInput() {
    input.throttle=(keys['KeyW']||keys['ArrowUp'])?1:0;
    input.brake=(keys['KeyS']||keys['ArrowDown'])?1:0;
    input.steer=((keys['KeyA']||keys['ArrowLeft'])?-1:0)+((keys['KeyD']||keys['ArrowRight'])?1:0);
    input.handbrake=!!keys['Space'];
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
    car.displaySpeed = Math.sqrt(car.velocity.x*car.velocity.x + car.velocity.z*car.velocity.z); // total horizontal speed for HUD

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
    else if(car.isDrifting) targetGrip = 0.25;
    else targetGrip = 0.90;
    let gripSpeed = car.isDrifting ? (surface.driftSustain*3.0) : (surface.driftRecovery*5.0);
    car.gripFactor = lerp(car.gripFactor, targetGrip, gripSpeed*dt);

    // === ACCELERATION ===
    if(input.throttle>0 && forwardVel>=0) {
        let speedRatio = clamp(forwardVel/CFG.MAX_SPEED, 0, 1);
        let throttleScale = 1.0 - speedRatio*speedRatio;
        let accel = (CFG.ENGINE_FORCE/CFG.MASS) * throttleScale * input.throttle * surface.accel;
        accel *= dmgMod.accelMult;
        car.velocity.addScaledVector(fwd, accel*dt);
    } else if(input.throttle>0 && forwardVel<0) {
        // Throttle while reversing = brake
        car.velocity.addScaledVector(fwd, (CFG.BRAKE_FORCE/CFG.MASS)*0.5*dt);
    }
    // Reverse
    if(input.brake>0 && forwardVel<=0.5) {
        let accel = (CFG.ENGINE_FORCE/CFG.MASS)*0.4*input.brake*surface.accel;
        car.velocity.addScaledVector(fwd, -accel*dt);
    }
    // Braking
    if(input.brake>0 && forwardVel>0.5) {
        let brakeAccel = (CFG.BRAKE_FORCE/CFG.MASS)*input.brake*surface.brake;
        let newFwd = forwardVel - brakeAccel*dt;
        if(newFwd<0) newFwd=0;
        car.velocity.addScaledVector(fwd, (newFwd-forwardVel));
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
    if(hSpd>maxSpd) { let s=maxSpd/hSpd; car.velocity.x*=s; car.velocity.z*=s; }
    // Fix #1: displaySpeed from POST-cap velocity (HUD and respawn read correct value)
    car.displaySpeed = Math.sqrt(car.velocity.x*car.velocity.x + car.velocity.z*car.velocity.z);
    // Reverse cap
    let fv2 = car.velocity.dot(fwd);
    if(fv2 < -CFG.REVERSE_MAX) {
        car.velocity.addScaledVector(fwd, -CFG.REVERSE_MAX - fv2);
    }

    // ─── BARRIER COLLISION — delta-V damage + volt ───
    // terrain.type is raw ('OB'); car.surfaceKey becomes 'BARRIER' after SURFACE_MAP lookup.
    // Fix #3: toUpperCase for robustness against lowercase terrain data.
    // Fix #4: damage based on delta-V (speed change at impact), not absolute speed.
    //   A car scraping a wall at constant speed has deltaV ~0 → minimal damage.
    //   A frontal hit at 140 km/h has high deltaV → large damage.
    if (terrain.type.toUpperCase() === 'OB') {
        let speedBefore = car.displaySpeed; // post-cap, pre-bounce
        car.velocity.x *= 0.9; car.velocity.z *= 0.9;
        let speedAfter  = Math.sqrt(car.velocity.x*car.velocity.x + car.velocity.z*car.velocity.z);
        let deltaV = speedBefore - speedAfter; // always >= 0; zero during scrapes
        if (window.rallyDamage && deltaV > 2) {
            window.rallyDamage.applyDamage(deltaV * 4); // scale: 10 m/s delta → 40 dmg-units
            if (window.rallyCamera) window.rallyCamera.triggerShake(deltaV * 4);
            if (speedBefore > DMG_VOLT_THRESH) {
                let latComp = Math.abs(car.velocity.dot(right));
                if (latComp > 5 || speedBefore > 35)
                    window.rallyDamage.triggerVolt(car, fwd, right);
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
    let tgtRoll = clamp(-latAccel*CFG.ROLL_SENS, -8, 8);
    let rollRate = 1 - Math.pow(1 - 0.12, dt * 60);
    car.visualRoll = lerp(car.visualRoll, tgtRoll, rollRate);

    let fwdAccel = (forwardVel - car.prevForwardVel) / Math.max(dt,0.001);
    car.prevForwardVel = forwardVel;
    let tgtPitch = clamp(fwdAccel*CFG.PITCH_SENS, -5, 5);
    let pitchRate = 1 - Math.pow(1 - 0.10, dt * 60);
    car.visualPitch = lerp(car.visualPitch, tgtPitch, pitchRate);

    // Terrain slope
    let nx = terrain.normal[0]||0, nz = terrain.normal[1]||0;
    let slopePitch = -(nx*Math.sin(car.heading) + nz*Math.cos(car.heading))*0.6;
    let slopeRoll = (nx*Math.cos(car.heading) - nz*Math.sin(car.heading))*0.5;

    // Skip mesh rotation if volting (damage system controls rotation)
    if (window.rallyDamage && window.rallyDamage.isVolting()) {
        car.mesh.position.copy(car.position);
        // Volt handles rotation — only set Y (heading)
        car.mesh.rotation.y = -car.heading;
    } else if (window.rallyDamage && window.rallyDamage.isFlipped()) {
        car.mesh.position.copy(car.position);
        car.mesh.rotation.y = -car.heading; // Keep heading updated during flip
        // Flip recovery handles x/z rotation
    } else {
        // Normal mesh update
        car.mesh.position.copy(car.position);
        car.mesh.rotation.y = -car.heading;
        car.mesh.rotation.x = slopePitch + car.visualPitch*Math.PI/180;
        car.mesh.rotation.z = slopeRoll + car.visualRoll*Math.PI/180;
    }

    // Wheel spin + steer
    let spinSpd = forwardVel * CFG.WHEEL_SPIN;
    car.wheels.forEach((w,i)=>{
        if(w.children[0]){
            w.children[0].rotation.x += spinSpd*dt*10;
            w.children[1].rotation.x += spinSpd*dt*10;
        }
        if(i<2) w.rotation.y = -input.steer*0.35;
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
    h.innerHTML=`<div style="position:fixed;bottom:30px;right:30px;z-index:9999;pointer-events:none;font-family:'Inter','Segoe UI',sans-serif">
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
</div></div>
<div id="rally-controls-hint" style="position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;
background:rgba(15,23,42,0.9);border:1px solid #334155;border-radius:12px;padding:12px 24px;backdrop-filter:blur(8px);
font-family:'Inter',sans-serif;transition:opacity 2s ease">
<div style="color:#e2e8f0;font-size:13px;font-weight:bold;text-align:center">🏎️ RALLY MODE</div>
<div style="color:#94a3b8;font-size:11px;margin-top:4px;text-align:center">
<b>W/↑</b> Gas &nbsp; <b>S/↓</b> Broms &nbsp; <b>A/D</b> Sväng &nbsp; <b>SPACE</b> Handbroms &nbsp; <b>R</b> Respawn</div>
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
        console.log('🏎️ Rally Vehicle activated (drift physics v4 + damage + camera + respawn)');
    },
    deactivate: function(scene) {
        car.active=false;
        if(car.mesh){scene.remove(car.mesh); car.mesh=null;}
        let h=document.getElementById('rally-hud'); if(h)h.remove();
        if (window.rallyRespawn) window.rallyRespawn.cleanup();
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
