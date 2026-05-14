// ============================================================
// rally-camera.js — Chase Camera, Shake & Impact Slow-Motion
// Extracted from rally-vehicle.js. Receives physDt so camera
// and physics run at the same time-scale during slow-mo.
// ============================================================
(function() {
'use strict';

function lerp(a,b,t){ return a+(b-a)*Math.max(0,Math.min(1,t)); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

const CAM = {
    BEHIND: 8, HEIGHT: 3.5, LOOK_AHEAD: 5,
    POS_LERP: 0.08, ROT_LERP: 0.12,
    DRIFT_SENS: 0.3,
    FOV_BASE: 65, FOV_BOOST: 15,
    // Volt camera: pull out wider
    VOLT_BEHIND_MULT: 1.5,
    VOLT_HEIGHT_MULT: 1.3
};

// ─── State ───
let camHeading = 0;
let camTarget = null;   // smoothed position
let camLookAt = null;   // smoothed look-at

// Shake
let shakeIntensity = 0;
let shakeTimer = 0;

// Slow-motion
let impactFreeze = 0;   // seconds remaining at slow speed
const SLOWMO_FACTOR = 0.1; // 10% time-speed during freeze

// ─── Init (called from rally-vehicle activate) ───
function init(car) {
    camHeading = car.heading;
    let cf = new THREE.Vector3(Math.sin(camHeading), 0, Math.cos(camHeading));
    camTarget = car.position.clone()
        .sub(cf.clone().multiplyScalar(CAM.BEHIND))
        .add(new THREE.Vector3(0, CAM.HEIGHT, 0));
    camLookAt = car.position.clone()
        .add(cf.clone().multiplyScalar(CAM.LOOK_AHEAD));
    shakeIntensity = 0;
    shakeTimer = 0;
    impactFreeze = 0;
}

// ─── Trigger shake from impact ───
function triggerShake(impactSpeed) {
    if (impactSpeed < 8) return;
    if (impactSpeed < 15) {
        shakeIntensity = 0.3; shakeTimer = 0.15;
    } else if (impactSpeed < 25) {
        shakeIntensity = 0.8; shakeTimer = 0.25;
    } else {
        shakeIntensity = 1.5; shakeTimer = 0.4;
        // Trigger slow-mo for severe impacts
        impactFreeze = 0.35;
    }
}

// ─── Compute physDt from realDt (slow-mo applied) ───
function computePhysDt(realDt) {
    if (impactFreeze > 0) {
        impactFreeze -= realDt;
        return realDt * SLOWMO_FACTOR;
    }
    return realDt;
}

// ─── Main Update ───
// physDt: time-scaled dt (slow during impact)
// realDt: actual wall-clock dt (for visual effects like shake duration)
function update(camera, physDt, realDt) {
    let car = window.rallyVehicle ? window.rallyVehicle.getCar() : null;
    if (!car || !car.active || !car.mesh) return;
    if (!camTarget || !camLookAt) init(car);

    // Smooth heading follow
    let diff = car.heading - camHeading;
    while (diff > Math.PI)  diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    let sf = Math.min(1, Math.abs(car.speed) / 10);
    let headingRate = CAM.ROT_LERP + sf * 0.1;
    camHeading += diff * (1 - Math.pow(1 - headingRate, physDt * 60));

    let camFwd   = new THREE.Vector3(Math.sin(camHeading), 0, Math.cos(camHeading));
    let camRight  = new THREE.Vector3(Math.cos(camHeading), 0, -Math.sin(camHeading));

    // Distance and height
    let behindDist = CAM.BEHIND + Math.abs(car.speed) * 0.04;
    let heightBoost = (Math.abs(car.speed) / 52) * 1.5; // 52 = MAX_SPEED

    // Volt camera: wider view during volts/flips
    let isVolt = window.rallyDamage && (window.rallyDamage.isVolting() || window.rallyDamage.isFlipped());
    if (isVolt) {
        behindDist *= CAM.VOLT_BEHIND_MULT;
        heightBoost += CAM.HEIGHT * (CAM.VOLT_HEIGHT_MULT - 1);
    }

    let targetPos = car.position.clone()
        .sub(camFwd.clone().multiplyScalar(behindDist))
        .add(new THREE.Vector3(0, CAM.HEIGHT + heightBoost, 0));

    // Drift camera offset
    if (car.isDrifting && !isVolt) {
        let driftOffset = car.prevLateralVel * CAM.DRIFT_SENS;
        targetPos.addScaledVector(camRight, driftOffset);
    }

    // Terrain clip prevention
    if (typeof window.localGetTerrainAt === 'function') {
        let ct = window.localGetTerrainAt(targetPos.x, -targetPos.z);
        if (ct && targetPos.y < ct.z + 2.0) targetPos.y = ct.z + 2.0;
    }

    let targetLook = car.position.clone()
        .add(camFwd.clone().multiplyScalar(CAM.LOOK_AHEAD))
        .add(new THREE.Vector3(0, 0.5, 0));

    // Time-based lerp for camera smoothing (syncs with slow-mo)
    let posLerp = 1 - Math.pow(1 - CAM.POS_LERP, physDt * 60);
    let rotLerp = 1 - Math.pow(1 - CAM.ROT_LERP * 1.5, physDt * 60);
    camTarget.lerp(targetPos, posLerp);
    camLookAt.lerp(targetLook, rotLerp);
    camera.position.copy(camTarget);
    camera.lookAt(camLookAt);

    // Camera shake — timer uses realDt (constant real-world duration)
    // BUG-06 fix: amplitude är nu framerate-oberoende.
    // Tidigare skalades shake med realDt*60 vilket gav dubbel amplitude vid 30fps
    // och halv amplitude vid 120fps. Nu är amplituden konstant per trigger.
    if (shakeTimer > 0) {
        shakeTimer -= realDt;  // real time, not physics time
        let t = clamp(shakeTimer / 0.4, 0, 1);
        let shake = shakeIntensity * t;
        camera.position.x += (Math.random() - 0.5) * shake;
        camera.position.y += (Math.random() - 0.5) * shake * 0.5;
    }

    // FOV boost (time-based lerp)
    let speedRatio = clamp(Math.abs(car.speed) / 52, 0, 1);
    let targetFov = CAM.FOV_BASE + speedRatio * CAM.FOV_BOOST;
    let fovLerp = 1 - Math.pow(1 - 0.05, physDt * 60);
    camera.fov = lerp(camera.fov, targetFov, fovLerp);
    camera.updateProjectionMatrix();
}

// ─── Public API ───
window.rallyCamera = {
    init: init,
    update: update,
    triggerShake: triggerShake,
    computePhysDt: computePhysDt,
    isSlowMo: function() { return impactFreeze > 0; }
};

console.log('📷 Rally Camera system loaded');
})();
