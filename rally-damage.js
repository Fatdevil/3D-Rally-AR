// ============================================================
// rally-damage.js — Damage, Volt & Visual Deformation System
// Accumulating damage that degrades handling. Impact-driven
// scripted volts. Billboard smoke at 60%+. Never a full stop.
// ============================================================
(function() {
'use strict';

function lerp(a,b,t){ return a+(b-a)*Math.max(0,Math.min(1,t)); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

const DMG = {
    SPEED_THRESHOLD: 8,       // m/s — below this: no damage
    MULTIPLIER: 0.003,        // damage per m/s impact above threshold
    STEER_PENALTY_30: 0.15,   // -15% steering at 30-60%
    STEER_PENALTY_60: 0.40,   // -40% steering at 60-90%
    ENGINE_PENALTY_60: 0.20,  // -20% engine at 60%+
    MAX_SPEED_FLOOR: 0.25,    // 25% of max = never stationary
    DEFORM_RANGE: 0.08,       // max mesh deform offset (meters)
    SMOKE_THRESHOLD: 0.60,    // 60% damage → smoke starts
    SMOKE_INTERVAL: 0.3,      // seconds between smoke sprites
    SMOKE_LIFETIME: 0.8,      // seconds per sprite
    SMOKE_RISE: 0.5,          // m/s upward drift
    VOLT_SPEED_THRESHOLD: 25, // m/s impact to trigger volt
    VOLT_LATERAL_MIN: 5,      // m/s lateral for side-volt
    VOLT_DURATION: 1.0,       // seconds for volt animation
    FLIP_DETECT_DOT: 0.3,    // car.up · worldUp threshold
    FLIP_RECOVERY_DELAY: 1.2, // seconds before auto-flip
    FLIP_GRACE: 1.5           // seconds post-flip drift immunity
};

// ─── STATE ───
let damage = 0;           // 0.0 → 1.0
let isVolting = false;
let voltTimer = 0;
let voltRollAxis = { x: 0, z: 0 };
let voltStartRotation = { x: 0, z: 0 };
let isFlipped = false;
let flipTimer = 0;
let postFlipGrace = 0;
let smokeTimer = 0;
let smokeSprites = [];
let smokeMaterial = null;
let deformOffsets = [];    // per-child random offsets applied on damage

// ─── DAMAGE APPLICATION ───
function applyDamage(impactSpeed) {
    if (impactSpeed < DMG.SPEED_THRESHOLD) return 0;
    let car = getCar();
    if (!car || car._invulnerable > 0) return 0;

    let dmg = (impactSpeed - DMG.SPEED_THRESHOLD) * DMG.MULTIPLIER;
    damage = clamp(damage + dmg, 0, 1);

    // Visual deformation — nudge random body children
    if (car.mesh && car.mesh.children.length > 0) {
        let numParts = Math.min(2, car.mesh.children.length);
        for (let i = 0; i < numParts; i++) {
            let idx = Math.floor(Math.random() * car.mesh.children.length);
            let child = car.mesh.children[idx];
            if (!child._deformApplied) child._deformApplied = { x:0, y:0, z:0 };
            let d = DMG.DEFORM_RANGE * (dmg / 0.05); // scale with hit severity
            child._deformApplied.x += (Math.random() - 0.5) * d;
            child._deformApplied.y += (Math.random() - 0.5) * d * 0.5;
            child._deformApplied.z += (Math.random() - 0.5) * d;
            // Clamp total deformation
            child._deformApplied.x = clamp(child._deformApplied.x, -DMG.DEFORM_RANGE, DMG.DEFORM_RANGE);
            child._deformApplied.y = clamp(child._deformApplied.y, -DMG.DEFORM_RANGE*0.5, DMG.DEFORM_RANGE*0.5);
            child._deformApplied.z = clamp(child._deformApplied.z, -DMG.DEFORM_RANGE, DMG.DEFORM_RANGE);
            // Apply offset (additive, permanent until reset)
            if (!child._origPos) child._origPos = child.position.clone();
            child.position.set(
                child._origPos.x + child._deformApplied.x,
                child._origPos.y + child._deformApplied.y,
                child._origPos.z + child._deformApplied.z
            );
        }
    }
    return dmg;
}

// ─── PHYSICS MODIFIERS (queried by rally-vehicle.js each frame) ───
function getModifiers() {
    let steerMult = 1.0;
    let accelMult = 1.0;
    let maxSpeedMult = 1.0;

    if (damage > 0.3 && damage <= 0.6) {
        steerMult = 1 - DMG.STEER_PENALTY_30;
    } else if (damage > 0.6 && damage <= 0.9) {
        steerMult = 1 - DMG.STEER_PENALTY_60;
        accelMult = 1 - DMG.ENGINE_PENALTY_60;
    } else if (damage > 0.9) {
        steerMult = 1 - DMG.STEER_PENALTY_60;
        accelMult = 1 - DMG.ENGINE_PENALTY_60 * 1.5;
    }

    maxSpeedMult = Math.max(DMG.MAX_SPEED_FLOOR, 1 - damage * 0.7);
    return { steerMult, accelMult, maxSpeedMult };
}

// ─── VOLT (impact-driven scripted) ───
function triggerVolt(car, fwd, right) {
    if (isVolting || isFlipped) return;
    let lateralComponent = car.velocity.dot(right);
    let forwardComponent = car.velocity.dot(fwd);

    // Roll axis from impact vector — frontal = pitch, side = roll, diagonal = both
    voltRollAxis = {
        x: -lateralComponent * 0.04,
        z:  forwardComponent * 0.02
    };
    // Minimum roll so it's always visible
    let mag = Math.abs(voltRollAxis.x) + Math.abs(voltRollAxis.z);
    if (mag < 0.05) voltRollAxis.x = 0.08 * Math.sign(lateralComponent || 1);

    voltTimer = DMG.VOLT_DURATION;
    voltStartRotation = {
        x: car.mesh.rotation.x,
        z: car.mesh.rotation.z
    };
    isVolting = true;
}

function updateVolt(car, dt) {
    if (!isVolting) return;
    voltTimer -= dt;
    let t = 1 - clamp(voltTimer / DMG.VOLT_DURATION, 0, 1); // 0→1

    // Smooth roll: ease-in-out sine curve * axis magnitude * full rotation
    let rollAmount = Math.sin(t * Math.PI) * Math.PI * 2;
    car.mesh.rotation.x = voltStartRotation.x + voltRollAxis.z * rollAmount;
    car.mesh.rotation.z = voltStartRotation.z + voltRollAxis.x * rollAmount;

    // Kill horizontal velocity during volt (grounded friction)
    car.velocity.x *= Math.pow(0.92, dt * 60);
    car.velocity.z *= Math.pow(0.92, dt * 60);

    if (voltTimer <= 0) {
        isVolting = false;
        // Check if landed upside down
        checkFlipState(car);
    }
}

// ─── FLIP DETECTION & AUTO-RECOVERY ───
function checkFlipState(car) {
    if (!car.mesh) return;
    let carUp = new THREE.Vector3(0, 1, 0);
    carUp.applyEuler(car.mesh.rotation);
    let upDot = carUp.dot(new THREE.Vector3(0, 1, 0));
    if (upDot < DMG.FLIP_DETECT_DOT) {
        isFlipped = true;
        flipTimer = 0;
    }
}

function updateFlip(car, dt) {
    if (!isFlipped) return;
    if (car.velocity.length() > 2.0) return; // wait until nearly stopped

    flipTimer += dt;
    if (flipTimer > DMG.FLIP_RECOVERY_DELAY) {
        // Smooth force back to upright — framerate-independent
        let rate = 1 - Math.pow(0.05, dt * 60);
        car.mesh.rotation.x = lerp(car.mesh.rotation.x, 0, rate);
        car.mesh.rotation.z = lerp(car.mesh.rotation.z, 0, rate);

        if (Math.abs(car.mesh.rotation.x) < 0.1 && Math.abs(car.mesh.rotation.z) < 0.1) {
            car.mesh.rotation.x = 0;
            car.mesh.rotation.z = 0;
            isFlipped = false;
            flipTimer = 0;
            postFlipGrace = DMG.FLIP_GRACE;
        }
    }
}

function updatePostFlipGrace(dt) {
    if (postFlipGrace > 0) postFlipGrace -= dt;
}

// ─── SMOKE (billboard sprites at 60%+ damage) ───
function initSmokeMaterial() {
    if (smokeMaterial) return;
    let canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    let ctx = canvas.getContext('2d');
    let grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(180,180,180,0.6)');
    grad.addColorStop(0.5, 'rgba(120,120,120,0.3)');
    grad.addColorStop(1, 'rgba(80,80,80,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    let tex = new THREE.CanvasTexture(canvas);
    smokeMaterial = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false
    });
}

function updateSmoke(car, dt) {
    if (damage < DMG.SMOKE_THRESHOLD) {
        // Clean up any existing sprites
        smokeSprites.forEach(s => { if (s.parent) s.parent.remove(s); });
        smokeSprites = [];
        return;
    }
    if (!window.scene) return;
    initSmokeMaterial();

    // Emit new sprite
    smokeTimer += dt;
    if (smokeTimer >= DMG.SMOKE_INTERVAL) {
        smokeTimer = 0;
        let sprite = new THREE.Sprite(smokeMaterial.clone());
        // Position at car's hood area
        let hoodOffset = new THREE.Vector3(
            (Math.random() - 0.5) * 0.6,
            0.8,
            1.5 + (Math.random() - 0.5) * 0.3
        );
        // Rotate offset by car heading
        let cos = Math.cos(-car.heading), sin = Math.sin(-car.heading);
        let rx = hoodOffset.x * cos - hoodOffset.z * sin;
        let rz = hoodOffset.x * sin + hoodOffset.z * cos;
        sprite.position.set(
            car.position.x + rx,
            car.position.y + hoodOffset.y,
            car.position.z + rz
        );
        sprite.scale.setScalar(0.1);
        sprite._age = 0;
        sprite._lifetime = DMG.SMOKE_LIFETIME;
        window.scene.add(sprite);
        smokeSprites.push(sprite);
    }

    // Update existing sprites
    for (let i = smokeSprites.length - 1; i >= 0; i--) {
        let s = smokeSprites[i];
        s._age += dt;
        let t = s._age / s._lifetime;
        if (t >= 1) {
            if (s.parent) s.parent.remove(s);
            if (s.material) s.material.dispose();
            smokeSprites.splice(i, 1);
        } else {
            s.scale.setScalar(lerp(0.1, 1.5, t));
            s.material.opacity = 0.6 * (1 - t);
            s.position.y += DMG.SMOKE_RISE * dt;
        }
    }
}

// ─── RESET ───
function reset() {
    damage = 0;
    isVolting = false;
    voltTimer = 0;
    isFlipped = false;
    flipTimer = 0;
    postFlipGrace = 0;
    smokeTimer = 0;
    smokeSprites.forEach(s => { if (s.parent) s.parent.remove(s); if (s.material) s.material.dispose(); });
    smokeSprites = [];
    deformOffsets = [];
    // Reset mesh deformations
    let car = getCar();
    if (car && car.mesh) {
        car.mesh.children.forEach(child => {
            if (child._origPos) {
                child.position.copy(child._origPos);
                child._deformApplied = null;
                child._origPos = null;
            }
        });
    }
}

// ─── HELPERS ───
function getCar() {
    return window.rallyVehicle ? window.rallyVehicle.getCar() : null;
}

// ─── MAIN UPDATE (called from rally-vehicle.js each frame) ───
function update(dt) {
    let car = getCar();
    if (!car || !car.active) return;

    updateVolt(car, dt);
    updateFlip(car, dt);
    updatePostFlipGrace(dt);
    updateSmoke(car, dt);

    // Invulnerability countdown
    if (car._invulnerable > 0) car._invulnerable -= dt;
}

// ─── PUBLIC API ───
window.rallyDamage = {
    update: update,
    applyDamage: applyDamage,
    getModifiers: getModifiers,
    triggerVolt: triggerVolt,
    reset: reset,
    getDamage: function() { return damage; },
    isVolting: function() { return isVolting; },
    isFlipped: function() { return isFlipped; },
    hasPostFlipGrace: function() { return postFlipGrace > 0; },
    getPostFlipGrace: function() { return postFlipGrace; }
};

console.log('💥 Rally Damage system loaded');
})();
