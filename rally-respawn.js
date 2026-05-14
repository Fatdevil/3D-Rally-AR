// ============================================================
// rally-respawn.js — Checkpoints, Off-Track & Stuck Detection
// ============================================================
(function() {
'use strict';

function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }

const CFG = {
    CHECKPOINT_INTERVAL: 50,  // meters
    OFF_TRACK_MAX: 15,        // meters before respawn
    STUCK_SPEED: 2.0,         // m/s
    STUCK_HINT_TIME: 3.0,     // seconds
    STUCK_RESPAWN_TIME: 8.0,  // seconds
    INVULNERABILITY: 1.5      // seconds
};

// ─── State ───
let lastCheckpoint = { position: null, heading: 0 };
let distSinceCheckpoint = 0;
let offTrackDist = 0;
let stuckTimer = 0;
let _rKeyWasDown = false; // BUG-07 fix: edge-detection for R key

// ─── UI Elements ───
let overlayDiv = null;
let hintDiv = null;

function initUI() {
    if (!overlayDiv) {
        overlayDiv = document.createElement('div');
        overlayDiv.style.position = 'fixed';
        overlayDiv.style.inset = '0';
        overlayDiv.style.pointerEvents = 'none';
        overlayDiv.style.zIndex = '9000';
        overlayDiv.style.transition = 'opacity 0.2s';
        overlayDiv.style.opacity = '0';
        overlayDiv.style.boxShadow = 'inset 0 0 150px rgba(220, 38, 38, 0.8)';
        document.body.appendChild(overlayDiv);
    }
    if (!hintDiv) {
        hintDiv = document.createElement('div');
        hintDiv.style.position = 'fixed';
        hintDiv.style.bottom = '120px';
        hintDiv.style.left = '50%';
        hintDiv.style.transform = 'translateX(-50%)';
        hintDiv.style.pointerEvents = 'none';
        hintDiv.style.zIndex = '9001';
        hintDiv.style.fontFamily = "'Inter', sans-serif";
        hintDiv.style.fontSize = '24px';
        hintDiv.style.fontWeight = '800';
        hintDiv.style.color = '#fff';
        hintDiv.style.textShadow = '0 2px 10px rgba(0,0,0,0.8)';
        hintDiv.style.textAlign = 'center';
        hintDiv.style.opacity = '0';
        hintDiv.style.transition = 'opacity 0.3s';
        document.body.appendChild(hintDiv);
    }
}

// ─── Reset / Init ───
function init(car) {
    if (!car) return;
    initUI();
    // Spara startposition. groundY sparas separat (mark utan drop-margin)
    // för att triggerRespawn() ska kunna beräkna korrekt spawnY.
    // _spawnPosition i rally.html är satt till t.z + 0.35 + 1.5, dvs.
    // terrain + CAR_HEIGHT + drop-margin. Vi extraherar groundY här om möjligt.
    let spawnPos = car._spawnPosition ? car._spawnPosition.clone() : car.position.clone();
    let groundY = spawnPos.y; // fallback: använd position.y direkt utan extra drop
    if (typeof window.localGetTerrainAt === 'function') {
        let s = window.localGetTerrainAt(spawnPos.x, -spawnPos.z);
        if (s && Number.isFinite(s.z)) groundY = s.z + 0.35; // terrain + CAR_HEIGHT
    }
    lastCheckpoint = {
        position: spawnPos,
        groundY: groundY,   // markhöjd + CAR_HEIGHT — används av triggerRespawn
        heading: car.heading
    };
    distSinceCheckpoint = 0;
    offTrackDist = 0;
    stuckTimer = 0;
    _rKeyWasDown = false; // FYN-07 fix: återställ edge-detection vid init
    if (overlayDiv) overlayDiv.style.opacity = '0';
    if (hintDiv) hintDiv.style.opacity = '0';
}

// ─── Respawn Action ───
function triggerRespawn() {
    let car = window.rallyVehicle ? window.rallyVehicle.getCar() : null;
    if (!car || !lastCheckpoint.position) return;

    // Respawn-höjd: sampla aktuell terränghöjd vid checkpointens X/Z.
    // spawnY = terrain.z + CAR_HEIGHT (0.35m) = normalt körläge.
    // Fallback om terrängsampling saknas/ger ogiltig höjd:
    //   använd lastCheckpoint.groundY direkt (inkl CAR_HEIGHT, exkl drop-margin).
    //   INTE lastCheckpoint.position.y, som kan innehålla drop-margin från spawn.
    //   Det undviker dubbel +1.5m (fynd 1 i kontroll av b8eed03).
    const CAR_HEIGHT = 0.35; // Speglar CFG.CAR_HEIGHT i rally-vehicle.js
    let spawnY = lastCheckpoint.groundY !== undefined
        ? lastCheckpoint.groundY          // sparad groundY = terrain + CAR_HEIGHT
        : lastCheckpoint.position.y;      // äldre checkpoint utan groundY — bästa gissning
    if (typeof window.localGetTerrainAt === 'function') {
        let cpX = lastCheckpoint.position.x;
        let cpZ = lastCheckpoint.position.z;
        let terrainSample = window.localGetTerrainAt(cpX, -cpZ);
        if (terrainSample && Number.isFinite(terrainSample.z)) {
            spawnY = terrainSample.z + CAR_HEIGHT; // uppdaterad aktuell terränghöjd
        }
    }
    car.position.copy(lastCheckpoint.position);
    car.position.y = spawnY + 1.5; // + 1.5m drop-in clearance
    car.heading = lastCheckpoint.heading;
    
    // Stop car
    car.velocity.set(0, 0, 0);
    car.speed = 0;
    car.prevLateralVel = 0;
    car.prevForwardVel = 0;
    car.isDrifting = false;
    
    // Invulnerability
    car._invulnerable = CFG.INVULNERABILITY;
    
    // Reset state
    offTrackDist = 0;
    stuckTimer = 0;
    if (overlayDiv) overlayDiv.style.opacity = '0';
    if (hintDiv) hintDiv.style.opacity = '0';
    
    // Update mesh immediately
    if (car.mesh) {
        car.mesh.position.copy(car.position);
        car.mesh.rotation.y = -car.heading;
        car.mesh.rotation.x = 0;
        car.mesh.rotation.z = 0;
    }
    
    // If damage system exists, recover from flip/volt state
    if (window.rallyDamage && window.rallyDamage.resetFlipState) {
        window.rallyDamage.resetFlipState();
    }
    
    console.log('🔄 Respawned at checkpoint');
}

// ─── Main Update ───
function update(dt) {
    let car = window.rallyVehicle ? window.rallyVehicle.getCar() : null;
    if (!car || !car.active || !lastCheckpoint.position) return;
    
    let tType = (car.terrainType || '').toUpperCase();
    let isOB = (tType === 'OB' || tType === 'WATER');
    let hSpeed = car.displaySpeed !== undefined ? car.displaySpeed : Math.abs(car.speed);
    let moveDist = hSpeed * dt;

    // 1. Checkpoint System
    if (car.onGround && !isOB && hSpeed > 2.0) {
        distSinceCheckpoint += moveDist;
        if (distSinceCheckpoint >= CFG.CHECKPOINT_INTERVAL) {
            distSinceCheckpoint = 0;
            lastCheckpoint.position.copy(car.position);
            lastCheckpoint.heading = car.heading;
            // Spara groundY utan drop-margin vid varje checkpoint (fynd 1 fix)
            {
                let t = typeof window.localGetTerrainAt === 'function'
                    ? window.localGetTerrainAt(car.position.x, -car.position.z)
                    : null;
                lastCheckpoint.groundY = (t && Number.isFinite(t.z))
                    ? t.z + 0.35  // terrain + CAR_HEIGHT (speglar CFG.CAR_HEIGHT = 0.35)
                    : car.position.y;
            }
        }
    }

    // 2. Off-Track Accumulation
    if (car.onGround) {
        if (isOB) {
            offTrackDist += moveDist;
        } else {
            offTrackDist -= moveDist * 2.0; // Recover faster on track
        }
    } else {
        // FYN-02 fix: i luften fryses off-track helt — varken ökar eller minskar.
        // Tidigare varianten minskade offTrackDist i luften över icke-OB-yta, vilket
        // innebar att bilen kunde återhämta OB-progress utan markkontakt.
        // car.terrainType uppdateras från localGetTerrainAt varje frame oavsett
        // om bilen är i luften eller inte, så isOB i luften kan inte läggas till
        // som kriterium för recovery.
        // Regel: off-track ändras BARA vid faktisk markkontakt.
    }
    offTrackDist = clamp(offTrackDist, 0, CFG.OFF_TRACK_MAX);
    
    // Vignette overlay
    if (overlayDiv) {
        // Start showing red at 3m, max at 15m
        let opacity = 0;
        if (offTrackDist > 3) {
            opacity = (offTrackDist - 3) / (CFG.OFF_TRACK_MAX - 3);
        }
        overlayDiv.style.opacity = opacity.toFixed(2);
    }
    
    if (offTrackDist >= CFG.OFF_TRACK_MAX) {
        triggerRespawn();
        return;
    }

    // 3. Stuck Detection
    // Consider stuck if very slow, on ground, not volting, and player is applying throttle/brake
    let isVolting = window.rallyDamage && window.rallyDamage.isVolting && window.rallyDamage.isVolting();
    let isFlipped = window.rallyDamage && window.rallyDamage.isFlipped && window.rallyDamage.isFlipped();
    let input = window.rallyVehicle && window.rallyVehicle.getInput ? window.rallyVehicle.getInput() : {throttle:0, brake:0};
    
    let isTryingToMove = (input.throttle > 0 || input.brake > 0);
    
    if ((hSpeed < CFG.STUCK_SPEED && car.onGround && isTryingToMove && !isVolting) || isFlipped) {
        stuckTimer += dt;
    } else {
        stuckTimer = 0;
    }
    
    if (hintDiv) {
        if (stuckTimer >= CFG.STUCK_HINT_TIME) {
            let remain = Math.max(0, Math.ceil(CFG.STUCK_RESPAWN_TIME - stuckTimer));
            hintDiv.innerHTML = `Stuck?<br><span style="font-size:16px; color:#fca5a5;">Auto-respawn in ${remain}...</span>`;
            hintDiv.style.opacity = '1';
        } else {
            hintDiv.style.opacity = '0';
        }
    }
    
    if (stuckTimer >= CFG.STUCK_RESPAWN_TIME) {
        triggerRespawn();
        return;
    }

    // Manual respawn (R key) — BUG-07 fix: edge-triggered, inte nivå-triggad
    // Utan edge-detection anropades triggerRespawn() ~60 gånger/s när R hölls nere.
    let keys = window.rallyVehicle && window.rallyVehicle.getKeys ? window.rallyVehicle.getKeys() : {};
    let rDown = !!keys['KeyR'];
    if (rDown && !_rKeyWasDown) {
        triggerRespawn();
    }
    _rKeyWasDown = rDown;
}

function cleanup() {
    if (overlayDiv) { overlayDiv.remove(); overlayDiv = null; }
    if (hintDiv) { hintDiv.remove(); hintDiv = null; }
}

// ─── Public API ───
window.rallyRespawn = {
    init: init,
    update: update,
    triggerRespawn: triggerRespawn,
    cleanup: cleanup
};

console.log('🔄 Rally Respawn system loaded');
})();
