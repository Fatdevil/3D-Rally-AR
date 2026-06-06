// plane-vehicle.js — Stunt plane physics module for Rally AR terrain
// Red Bull-style aerobatic plane: rate-based rotation, force-based movement,
// stall + leaf-fall. Low-poly Edge 540 mesh built in code.
// API: window.rallyPlane.activate(scene, camera [, spawnCfg])
//      window.rallyPlane.deactivate(scene)
//      window.rallyPlane.update(camera)
//
// COORDINATE SYSTEM (Three.js right-handed):
//   nose/forward = -Z,  up = +Y,  right = +X
//
// TOUCH (liggande, två tummar):
//   Höger halva = FLYTANDE SPAK (dyker upp där tummen landar)
//       drag i sidled = roll,  drag vertikalt = pitch (upp = nos upp)
//       svängar genom att banka + auto-koordinerad yaw
//   Vänster halva = GAS-SLIDER (håller värde vid släpp)
//
// TANGENTBORD:
//   W/S = pitch, A/D = roll, Q/E = yaw, Space/Shift = gas+/gas-
//   Pilar fungerar också: ↑↓ = pitch, ←→ = roll
//
// GAMEPAD:
//   Vänster stick Y = gas, Höger stick = pitch + roll
(function() {
'use strict';

/* ── Helpers ─────────────────────────────────────────────── */
function lerp(a, b, t) { return a + (b - a) * Math.max(0, Math.min(1, t)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

var FORWARD = new THREE.Vector3(0, 0, -1);
var UP      = new THREE.Vector3(0, 1, 0);
var RIGHT   = new THREE.Vector3(1, 0, 0);

/* ==========================================================================
 *  FlightModel — arkad-flygfysik (från flightModel.js, anpassad för global THREE)
 *
 *  Rotation  = rate-baserad  (input → önskad vridhastighet, snappar till)
 *  Rörelse   = kraftbaserad  (thrust, lyft med stall-kurva, gravitation, drag)
 *  Löv-fall  = stall → lyft kollapsar, högt vertikalt drag, vaggande pendel
 * ========================================================================== */
function FlightModel(config) {
    this.position    = new THREE.Vector3();
    this.velocity    = new THREE.Vector3();
    this.orientation = new THREE.Quaternion();
    this.angVelBody  = new THREE.Vector3();

    this._leafPhase    = Math.random() * Math.PI * 2;
    this._flutterPhase = Math.random() * Math.PI * 2;

    // Telemetri (sätts av update)
    this.speed   = 0;
    this.aoaDeg  = 0;
    this.stalled = false;
    this.altitude = 0;

    // Alla rattar — SI (meter, sekunder, kg, Newton)
    var defaults = {
        mass:             700,       // kg  (Edge 540-klass)
        gravity:          9.81,

        // Motor — T/W ≈ 1.3 → vertikalt häng
        maxThrust:        9000,      // N

        // Lyft
        liftFactor:       6.5,
        clMax:            1.4,
        stallAngle:       0.28,      // rad (~16°)
        clFalloff:        0.6,       // hur snabbt lyft dör efter stall
        postStallLift:    0.6,       // kvarvarande lyft (0..1)

        // Drag
        dragFactor:       0.9,
        inducedDrag:      0.5,
        lateralDrag:      2.0,       // sidled → "grepp" i svängar
        verticalDrag:     1.0,
        leafVerticalDrag: 6.0,       // högt i stall → dalar långsamt

        // Styrning (rate-baserad), rad/s vid full input
        pitchRate:        3.0,
        yawRate:          1.5,
        rollRate:         6.0,       // ~340°/s
        responsiveness:   8.0,       // snapp-faktor (högre = snabbare)

        // Auktoritet vs fart
        refSpeed:         45,
        minAuthority:     0.25,      // golv vid noll fart

        // Stall / löv-fall
        stallSpeed:       18,        // m/s
        stallControlMul:  0.40,
        flutterFreq:      4.0,
        flutterAmp:       0.6,
        leafSwayFreq:     2.0,
        leafSwayForce:    1500,      // N sidledskraft

        // Stabilitet
        yawStability:     1.5,
        autoLevel:        3.0,       // vingarna rätar upp sig när ingen roll-input
        autoPitch:        0,         // auto-pitch-up vid banking (0 = av)
        maxRoll:          0,         // max bankvinkel i rad (0 = av)
        maxPitch:         0,         // max pitchvinkel i rad (0 = av)
        pitchAutoLevel:   0,         // nosen rätar upp sig mot horisonten (0 = av)
        disableStall:     false,     // inaktivera alla stall-effekter (styrningsförlust, fladder, löv-svaj)
        arcadeMode:       true,      // arkadflyg ("bil i luften"): 100% kontrollerbart, noll sideslip, hastighet längs nosen

        // Teckenväxling
        signPitch:        1,
        signRoll:         1,
        signYaw:          1,
    };
    this.config = {};
    for (var k in defaults) this.config[k] = (config && config[k] !== undefined) ? config[k] : defaults[k];
}

/* Lyftkoefficient med stall-kurva */
FlightModel.prototype._liftCoeff = function(aoa) {
    var c = this.config;
    var a = THREE.MathUtils.clamp(aoa, -Math.PI / 2, Math.PI / 2);
    var s = c.stallAngle;
    if (c.disableStall) {
        var ratio = a / s;
        var clampedRatio = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, ratio));
        return Math.sin(clampedRatio) * c.clMax;
    }
    if (Math.abs(a) <= s) {
        return (a / s) * c.clMax;
    }
    var over = Math.abs(a) - s;
    var fall = Math.max(0, 1 - over / c.clFalloff);
    return Math.sign(a) * c.clMax * fall * c.postStallLift;
};

/* Huvuduppdatering — en gång per frame */
FlightModel.prototype.update = function(dt, input) {
    var c = this.config;
    dt = Math.min(dt, 1 / 30);
    input = input || {};

    var pitchIn  = (input.pitch    || 0) * c.signPitch;
    var rollIn   = (input.roll     || 0) * c.signRoll;
    var yawIn    = (input.yaw      || 0) * c.signYaw;
    var throttle = THREE.MathUtils.clamp(input.throttle || 0, 0, 1);

    if (c.arcadeMode) {
        var forward = FORWARD.clone().applyQuaternion(this.orientation);
        var up      = UP.clone().applyQuaternion(this.orientation);
        var right   = RIGHT.clone().applyQuaternion(this.orientation);

        // 1. Mark-detektering för taxa/landning
        var groundY = 0;
        if (typeof window.localGetTerrainAt === 'function') {
            var terrain = window.localGetTerrainAt(this.position.x, -this.position.z);
            groundY = terrain ? terrain.z : 0;
        } else if (typeof window.getTerrainHeight === 'function') {
            groundY = window.getTerrainHeight(this.position.x, this.position.z);
        }
        var floorY = groundY + 0.8; // gearHeight = 0.8m
        var onGround = (this.position.y <= floorY + 0.05);

        // Om vi är på marken: förhindra att peka nosen neråt, stäng av roll
        if (onGround) {
            pitchIn = Math.max(0, pitchIn);
            rollIn = 0;
        }

        // 2. Beräkna målhastighet baserat på gas
        // 15 m/s vid tomgång (tillåter taxi), 35 m/s vid krusning, 55 m/s vid max boost
        var targetSpeed = 15;
        if (throttle <= 0.6) {
            targetSpeed = lerp(15, 35, throttle / 0.6);
        } else {
            targetSpeed = lerp(35, 55, (throttle - 0.6) / 0.4);
        }
        
        var currentSpeed = this.velocity.length();
        if (currentSpeed < 1) currentSpeed = targetSpeed;
        var speed = lerp(currentSpeed, targetSpeed, 3.0 * dt);

        // 3. Sätt hastighet direkt längs nosen (inget sidledsglid)
        this.velocity.copy(forward).multiplyScalar(speed);

        // 4. Uppdatera position
        this.position.addScaledVector(this.velocity, dt);

        // 5. Styrningshastighet (pitch, yaw, roll)
        var cmd = new THREE.Vector3(
            pitchIn * c.pitchRate,
            yawIn   * c.yawRate,
            rollIn  * c.rollRate
        );

        // Auto-level roll: vingar söker horisonten vid spaksläpp
        // Fades out at high pitch angles to allow loops
        if (Math.abs(rollIn) < 0.1) {
            var pitchAngle = Math.abs(Math.asin(clamp(forward.y, -1, 1)));
            var loopFade = clamp(1 - (pitchAngle - 1.0) / 0.5, 0, 1); // fades 60°→90°
            var autoLevelStrength = onGround ? 15.0 : c.autoLevel * loopFade;
            cmd.z += -right.y * autoLevelStrength;
        }

        // Auto-level pitch: nosen söker horisonten vid spaksläpp i luften
        if (Math.abs(pitchIn) < 0.1 && c.pitchAutoLevel > 0 && !onGround) {
            cmd.x += -forward.y * c.pitchAutoLevel;
        }

        // Auto-pitch: automatisk höjdhållning vid bankning i luften
        if (c.autoPitch > 0 && !onGround) {
            var bankAmount = Math.abs(right.y); // 0 = level, 1 = 90°
            cmd.x += bankAmount * c.autoPitch * (1 - Math.abs(pitchIn));
        }

        // Begränsa max roll/pitch
        if (c.maxRoll > 0 || c.maxPitch > 0) {
            var pitchNow = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
            var rollNow  = Math.asin(THREE.MathUtils.clamp(right.y, -1, 1));
            var margin = 0.92;

            if (c.maxPitch > 0) {
                if (pitchNow > c.maxPitch * margin  && cmd.x > 0) cmd.x *= Math.max(0, 1 - (pitchNow - c.maxPitch * margin) / (c.maxPitch * (1 - margin)));
                if (pitchNow < -c.maxPitch * margin && cmd.x < 0) cmd.x *= Math.max(0, 1 - (-pitchNow - c.maxPitch * margin) / (c.maxPitch * (1 - margin)));
            }
            if (c.maxRoll > 0 && !onGround) {
                if (rollNow > c.maxRoll * margin  && cmd.z > 0) cmd.z *= Math.max(0, 1 - (rollNow - c.maxRoll * margin) / (c.maxRoll * (1 - margin)));
                if (rollNow < -c.maxRoll * margin && cmd.z < 0) cmd.z *= Math.max(0, 1 - (-rollNow - c.maxRoll * margin) / (c.maxRoll * (1 - margin)));
            }
        }

        // Rotationsrespons
        var k = 1 - Math.exp(-c.responsiveness * dt);
        this.angVelBody.lerp(cmd, k);

        // Tillämpa lokal rotation (pitch och roll)
        var localRot = new THREE.Vector3(this.angVelBody.x, 0, this.angVelBody.z);
        var localSpeed = localRot.length();
        if (localSpeed > 1e-6) {
            var axis = localRot.clone().normalize();
            var dq = new THREE.Quaternion().setFromAxisAngle(axis, localSpeed * dt);
            this.orientation.multiply(dq);
        }

        // Tillämpa värld-yaw rotation (kring världens UP-vektor) för att behålla höjden i svängar
        var worldYaw = this.angVelBody.y;
        if (Math.abs(worldYaw) > 1e-6) {
            var dqY = new THREE.Quaternion().setFromAxisAngle(UP, worldYaw * dt);
            this.orientation.premultiply(dqY);
        }

        this.orientation.normalize();

        // Telemetri
        this.speed    = speed;
        this.aoaDeg   = 0;
        this.stalled  = false;
        this.altitude = this.position.y;
        return;
    }

    // Kroppens axlar i världen
    var forward = FORWARD.clone().applyQuaternion(this.orientation);
    var up      = UP.clone().applyQuaternion(this.orientation);
    var right   = RIGHT.clone().applyQuaternion(this.orientation);

    // Fart & hastighet i kroppsram
    var speed  = this.velocity.length();
    var invOri = this.orientation.clone().invert();
    var vLocal = this.velocity.clone().applyQuaternion(invOri);
    var u   = -vLocal.z;   // framåtfart
    var w   =  vLocal.y;   // vertikalfart (kroppsram)
    var lat =  vLocal.x;   // sidledsfart

    var aoa      = Math.atan2(-w, Math.max(u, 0.001));
    var sideslip = Math.atan2(lat, Math.max(u, 0.001));
    var stalled  = speed < c.stallSpeed || Math.abs(aoa) > c.stallAngle;
    if (c.disableStall) {
        stalled = false;
    }

    /* ===== KRAFTER (världsram) ===== */
    var force = new THREE.Vector3();

    // Gravitation
    force.y -= c.gravity * c.mass;

    // Dragkraft längs nosen
    force.addScaledVector(forward, throttle * c.maxThrust);

    // Lyft längs kroppens upp-axel
    var Cl      = this._liftCoeff(aoa);
    var liftMag = c.liftFactor * Cl * speed * speed;
    force.addScaledVector(up, liftMag);

    // Parasitärt + inducerat drag
    if (speed > 1e-4) {
        var velDir    = this.velocity.clone().multiplyScalar(1 / speed);
        var parasitic = c.dragFactor * speed * speed;
        var induced   = c.inducedDrag * Cl * Cl * speed * speed;
        force.addScaledVector(velDir, -(parasitic + induced));
    }

    // Formdrag i kroppsram (linjär i lat, proportionellt mot speed — svagt vid långsam fart, måttligt vid krusfart)
    var vDragCoef = stalled ? c.leafVerticalDrag : c.verticalDrag;
    var formDragLocal = new THREE.Vector3(
        -lat * speed * c.lateralDrag,
        -w   * Math.abs(w) * vDragCoef,
        0
    );
    force.add(formDragLocal.applyQuaternion(this.orientation));

    // Löv-svaj i stall
    if (stalled && speed < c.stallSpeed * 1.5) {
        this._leafPhase += dt * c.leafSwayFreq;
        force.addScaledVector(right, Math.sin(this._leafPhase) * c.leafSwayForce);
    }

    // Semi-implicit Euler
    this.velocity.addScaledVector(force, dt / c.mass);
    this.position.addScaledVector(this.velocity, dt);

    /* ===== ROTATION (rate-baserad) ===== */
    var auth = THREE.MathUtils.clamp(speed / c.refSpeed, c.minAuthority, 1);

    var cmd = new THREE.Vector3(
        pitchIn * c.pitchRate,
        yawIn   * c.yawRate,
        rollIn  * c.rollRate
    ).multiplyScalar(auth);

    // Riktningsstabilitet
    if (speed > c.stallSpeed) {
        cmd.y += -sideslip * c.yawStability * auth;
    }

    // I stall: dämpad styrning + fladder
    if (stalled) {
        cmd.multiplyScalar(c.stallControlMul);
        this._flutterPhase += dt * c.flutterFreq;
        cmd.x += Math.sin(this._flutterPhase)             * c.flutterAmp;
        cmd.z += Math.sin(this._flutterPhase * 0.8 + 1.3) * c.flutterAmp;
    }

    // Auto-level + auto-pitch (kompenserar höjdförlust i bankade svängar)
    // (efter stall-check så de aldrig dämpas av stallControlMul)
    var rightWorld = RIGHT.clone().applyQuaternion(this.orientation);

    // Auto-level roll: räta upp vingarna när ingen roll-input
    if (Math.abs(rollIn) < 0.1 && !stalled) {
        cmd.z += -rightWorld.y * c.autoLevel;
    }

    // Auto-level pitch: nosen söker sig till horisonten när ingen pitch-input
    if (Math.abs(pitchIn) < 0.1 && c.pitchAutoLevel > 0 && !stalled) {
        cmd.x += -forward.y * c.pitchAutoLevel;
    }

    // Auto-pitch: dra nosen upp proportionellt mot bankvinkel
    // Så planet håller höjd i svängar utan att spelaren trycker W
    // Dämpas helt om spelaren själv gör pitch-inmatning för att undvika kontroll-låsning
    if (c.autoPitch > 0) {
        var bankAmount = Math.abs(rightWorld.y); // 0 = plant, 1 = 90° bank
        cmd.x += bankAmount * c.autoPitch * (1 - Math.abs(pitchIn));
    }

    // Begränsa rotationshastighet så att pitch/roll aldrig kan nå förbjudna vinklar
    // (yaw-agnostisk: vi räknar pitch/roll från vektorer, rör aldrig orienteringen direkt)
    if (c.maxRoll > 0 || c.maxPitch > 0) {
        var pitchNow = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
        var rollNow  = Math.asin(THREE.MathUtils.clamp(rightWorld.y, -1, 1));
        var margin = 0.92; // börja bromsa strax innan gränsen

        if (c.maxPitch > 0) {
            if (pitchNow > c.maxPitch * margin  && cmd.x > 0) cmd.x *= Math.max(0, 1 - (pitchNow - c.maxPitch * margin) / (c.maxPitch * (1 - margin)));
            if (pitchNow < -c.maxPitch * margin && cmd.x < 0) cmd.x *= Math.max(0, 1 - (-pitchNow - c.maxPitch * margin) / (c.maxPitch * (1 - margin)));
        }
        if (c.maxRoll > 0) {
            if (rollNow > c.maxRoll * margin  && cmd.z > 0) cmd.z *= Math.max(0, 1 - (rollNow - c.maxRoll * margin) / (c.maxRoll * (1 - margin)));
            if (rollNow < -c.maxRoll * margin && cmd.z < 0) cmd.z *= Math.max(0, 1 - (-rollNow - c.maxRoll * margin) / (c.maxRoll * (1 - margin)));
        }
    }

    // Frame-rate-oberoende lerp
    var k = 1 - Math.exp(-c.responsiveness * dt);
    this.angVelBody.lerp(cmd, k);

    // Integrera orientering
    var wWorld   = this.angVelBody.clone().applyQuaternion(this.orientation);
    var angSpeed = wWorld.length();
    if (angSpeed > 1e-6) {
        var axis = wWorld.multiplyScalar(1 / angSpeed);
        var dq   = new THREE.Quaternion().setFromAxisAngle(axis, angSpeed * dt);
        this.orientation.premultiply(dq);
        this.orientation.normalize();
    }

    // Telemetri
    this.speed    = speed;
    this.aoaDeg   = aoa * 180 / Math.PI;
    this.stalled  = stalled;
    this.altitude = this.position.y;
};

FlightModel.prototype.applyTo = function(mesh) {
    mesh.position.copy(this.position);
    mesh.quaternion.copy(this.orientation);
};

FlightModel.prototype.setHeading = function(yawRadians) {
    this.orientation.setFromAxisAngle(UP, yawRadians);
};


/* ==========================================================================
 *  Low-poly Stunt Plane Mesh  (Edge 540-stil)
 *  ─ nosriktning = -Z
 * ========================================================================== */
function createPlaneMesh() {
    var g = new THREE.Group();
    g.name = 'StuntPlane';

    var blue     = new THREE.MeshLambertMaterial({ color: 0x2563eb });
    var darkBlue = new THREE.MeshLambertMaterial({ color: 0x1d4ed8 });
    var red      = new THREE.MeshLambertMaterial({ color: 0xdc2626 });
    var silver   = new THREE.MeshLambertMaterial({ color: 0x9ca3af });
    var dark     = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    var grey     = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
    var canopy   = new THREE.MeshLambertMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.55 });

    // ── Kropp (fuselage) ──
    var bodyGeo = new THREE.BoxGeometry(0.95, 0.85, 4.8);
    var body = new THREE.Mesh(bodyGeo, blue);
    body.castShadow = true;
    g.add(body);

    // Noskåpa (engine cowl)
    var cowlGeo = new THREE.CylinderGeometry(0.42, 0.48, 1.4, 8);
    var cowl = new THREE.Mesh(cowlGeo, silver);
    cowl.rotation.x = Math.PI / 2;
    cowl.position.set(0, 0, -3.0);
    cowl.castShadow = true;
    g.add(cowl);

    // Stjärtkon (tail cone)
    var tailConeGeo = new THREE.CylinderGeometry(0.15, 0.42, 1.6, 8);
    var tailCone = new THREE.Mesh(tailConeGeo, darkBlue);
    tailCone.rotation.x = Math.PI / 2;
    tailCone.position.set(0, 0.05, 3.0);
    tailCone.castShadow = true;
    g.add(tailCone);

    // ── Vingar ──
    // Vänster
    var wingGeo = new THREE.BoxGeometry(3.5, 0.1, 1.15);
    var wingL = new THREE.Mesh(wingGeo, blue);
    wingL.position.set(-2.2, -0.15, -0.2);
    wingL.castShadow = true;
    g.add(wingL);

    // Höger
    var wingR = new THREE.Mesh(wingGeo, blue);
    wingR.position.set(2.2, -0.15, -0.2);
    wingR.castShadow = true;
    g.add(wingR);

    // Vingtippar (röda)
    var tipGeo = new THREE.BoxGeometry(0.5, 0.09, 0.35);
    var tipL = new THREE.Mesh(tipGeo, red);
    tipL.position.set(-3.95, -0.15, -0.15);
    g.add(tipL);
    var tipR = new THREE.Mesh(tipGeo, red);
    tipR.position.set(3.95, -0.15, -0.15);
    g.add(tipR);

    // ── Stjärt ──
    // Vertikal stabilisator
    var vStabGeo = new THREE.BoxGeometry(0.08, 1.5, 1.2);
    var vStab = new THREE.Mesh(vStabGeo, blue);
    vStab.position.set(0, 0.8, 3.2);
    vStab.castShadow = true;
    g.add(vStab);

    // Roder-accent (röd)
    var rudderGeo = new THREE.BoxGeometry(0.09, 0.7, 0.4);
    var rudder = new THREE.Mesh(rudderGeo, red);
    rudder.position.set(0, 1.1, 3.55);
    g.add(rudder);

    // Horisontell stabilisator
    var hStabGeo = new THREE.BoxGeometry(2.4, 0.07, 0.7);
    var hStab = new THREE.Mesh(hStabGeo, blue);
    hStab.position.set(0, 0.05, 3.3);
    hStab.castShadow = true;
    g.add(hStab);

    // ── Propeller (snurrande grupp) ──
    var propGroup = new THREE.Group();
    propGroup.position.set(0, 0, -3.6);

    // Spinner (nos-kon)
    var spinnerGeo = new THREE.ConeGeometry(0.18, 0.45, 8);
    var spinner = new THREE.Mesh(spinnerGeo, silver);
    spinner.rotation.x = Math.PI / 2;
    spinner.position.z = -0.2;
    propGroup.add(spinner);

    // 3 blad
    for (var i = 0; i < 3; i++) {
        var bladeGeo = new THREE.BoxGeometry(2.4, 0.18, 0.05);
        var blade = new THREE.Mesh(bladeGeo, dark);
        blade.rotation.z = (Math.PI * 2 / 3) * i;
        propGroup.add(blade);
    }
    g.add(propGroup);

    // ── Cockpit (canopy) ──
    var canopyGeo = new THREE.SphereGeometry(0.42, 8, 6);
    canopyGeo.scale(1.1, 0.85, 1.6);
    var cockpit = new THREE.Mesh(canopyGeo, canopy);
    cockpit.position.set(0, 0.35, -1.1);
    g.add(cockpit);

    // ── Landningsställ ──
    // Huvudhjul (under vingarna)
    [-0.8, 0.8].forEach(function(sx) {
        // Ben
        var legGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6);
        var leg = new THREE.Mesh(legGeo, grey);
        leg.position.set(sx, -0.75, -0.6);
        g.add(leg);
        // Hjul
        var wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.08, 8);
        var wheel = new THREE.Mesh(wheelGeo, dark);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx, -1.1, -0.6);
        g.add(wheel);
    });

    // Stjärthjul (litet)
    var twGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.05, 6);
    var tw = new THREE.Mesh(twGeo, dark);
    tw.rotation.z = Math.PI / 2;
    tw.position.set(0, -0.5, 3.0);
    g.add(tw);

    return { group: g, propeller: propGroup };
}


/* ==========================================================================
 *  MobileControls — Flytande spak + gas-slider + auto-koordinerad yaw
 *
 *  Höger halva = FLYTANDE SPAK (pitch + roll)
 *      Ankrar där tummen landar. Expo-kurva + dödzon.
 *      Sväng genom att rolla → auto-koordinerad yaw.
 *  Vänster halva = GAS-SLIDER (håller värde vid släpp)
 *  Tangentbord + Gamepad som fallback.
 *
 *  Baserad på mobileControls.js (ES-modul), inbäddad i IIFE.
 * ========================================================================== */
function MobileControls(options) {
    var o = options || {};
    this.target = o.target || window;

    this.cfg = {
        splitX:         o.splitX         || 0.5,    // gräns vänster/höger (andel av bredd)
        deadzone:       o.deadzone       || 0.08,   // dödzon på spaken
        expo:           o.expo           || 0.5,    // 0=linjärt, 1=mjukt nära mitten
        stickRadius:    o.stickRadius    || 90,     // px för fullt utslag
        invertPitch:    o.invertPitch    || false,  // true = yoke-känsla
        coordination:   o.coordination   || 0.4,    // auto-yaw proportionellt mot roll
        throttleTop:    o.throttleTop    || 0.18,   // gas-topp (andel av höjd)
        throttleBot:    o.throttleBot    || 0.82,   // gas-botten
        initialThrottle: o.initialThrottle || 0.6,
        keyboard:       o.keyboard !== undefined ? o.keyboard : true,
        keyThrottleRate: o.keyThrottleRate || 1.2,  // gas/s med Space/Shift
        autoThrottle:   o.autoThrottle !== undefined ? o.autoThrottle : false,
        cruiseThrottle: o.cruiseThrottle || 0.7,    // auto-gas krusfart
        boostThrottle:  o.boostThrottle  || 1.0,    // boost (Space)
        overlay:        o.overlay !== undefined ? o.overlay : true,
    };

    // Tillstånd
    this.stick    = { active: false, id: null, ax: 0, ay: 0, x: 0, y: 0 };
    this.thr      = { active: false, id: null };
    this.throttle = this.cfg.initialThrottle;
    this._keys    = new Set();
    this._overlayEls = null;
    this._kbRoll  = 0;
    this._kbPitch = 0;

    this._bind();
    if (this.cfg.overlay) this._buildOverlay();
}

/* Anropa varje frame → { pitch, roll, yaw, throttle } */
MobileControls.prototype.getInput = function(dt) {
    dt = dt || 0;
    var pitch, roll;

    if (this.stick.active) {
        // Touch/mus-spak
        roll  = this._shape(this.stick.x);
        var py = this._shape(this.stick.y);     // skärm-y nedåt
        pitch = this.cfg.invertPitch ? py : -py; // drag upp = nos upp
        this._kbRoll = 0; this._kbPitch = 0;    // nollställ keyboard-ramp
    } else if (this.cfg.keyboard) {
        // Tangentbord med mjuk upptrappning (inte binärt 0/1)
        var targetRoll  = (this._k('ArrowRight', 'd') - this._k('ArrowLeft', 'a'));
        var targetPitch = (this._k('ArrowUp', 'w') - this._k('ArrowDown', 's'));
        var ramp = Math.min(1, 15 * dt);  // snabb ramp för direkt respons
        this._kbRoll  = lerp(this._kbRoll  || 0, targetRoll,  ramp);
        this._kbPitch = lerp(this._kbPitch || 0, targetPitch, ramp);
        roll  = this._kbRoll;
        pitch = this._kbPitch;
        pitch = this.cfg.invertPitch ? -pitch : pitch;
    } else {
        pitch = 0; roll = 0;
    }

    // Gas
    var gpBoost = false;
    var gps = navigator.getGamepads ? navigator.getGamepads() : [];
    var gp = null;
    for (var gi = 0; gi < gps.length; gi++) {
        if (gps[gi] && gps[gi].connected) {
            gp = gps[gi];
            if (gp.buttons[0] && gp.buttons[0].pressed) gpBoost = true;
            if (gp.buttons[7] && gp.buttons[7].pressed) gpBoost = true;
            break;
        }
    }

    if (this.cfg.autoThrottle) {
        // Auto-gas: krusfart + Space = boost (eller touch, eller gamepad A/RT)
        var boosting = this._k(' ') || (this.thr.active && this.throttle > 0.85) || gpBoost;
        this.throttle = boosting ? this.cfg.boostThrottle : this.cfg.cruiseThrottle;
    } else if (this.cfg.keyboard && !this.thr.active && dt > 0) {
        this.throttle += (this._k(' ') - this._k('Shift')) * this.cfg.keyThrottleRate * dt;
        this.throttle = clamp(this.throttle, 0, 1);
    }

    // Gamepad-axlar
    if (gp) {
        var ly = gp.axes[1] || 0;
        var rx = gp.axes[2] || 0, ry = gp.axes[3] || 0;
        var dz = 0.12;
        if (Math.abs(ly) > dz && !this.cfg.autoThrottle) {
            this.throttle += -ly * this.cfg.keyThrottleRate * dt;
            this.throttle = clamp(this.throttle, 0, 1);
        }
        if (Math.abs(ry) > dz) pitch += -ry;
        if (Math.abs(rx) > dz) roll  += rx; // Laga inverterad roll
    }

    // Uppdatera den visuella slidern kontinuerligt i loopen
    this._renderThrottle();

    // Koordinerad yaw ur roll (+ ev. Q/E på desktop)
    var yaw = -roll * this.cfg.coordination;
    if (this.cfg.keyboard) yaw += (this._k('q') - this._k('e'));

    return {
        pitch:    clamp(pitch, -1, 1),
        roll:     clamp(roll,  -1, 1),
        yaw:      clamp(yaw,   -2, 2),
        throttle: clamp(this.throttle, 0, 1),
    };
};

/* ── Pointer Events (touch + mus) ─────────────── */
MobileControls.prototype._bind = function() {
    var self = this;
    var el = this.target;

    // Stoppa scroll/zoom på touch
    var styleHost = (el === window) ? document.body : el;
    if (styleHost && styleHost.style) styleHost.style.touchAction = 'none';

    this._onDown = function(e) { self._down(e); };
    this._onMove = function(e) { self._move(e); };
    this._onUp   = function(e) { self._up(e); };
    this._onBlur = function() {
        self._keys.clear();
        self._kbRoll = 0;
        self._kbPitch = 0;
    };

    el.addEventListener('pointerdown',   this._onDown, { passive: false });
    el.addEventListener('pointermove',   this._onMove, { passive: false });
    el.addEventListener('pointerup',     this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    window.addEventListener('blur',      this._onBlur);

    if (this.cfg.keyboard) {
        this._onKD = function(e) {
            var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            self._keys.add(k);
            // R-tangent för krasch-reset (ändrad: tillåt alltid reset)
            if (k === 'r') resetPlane();
            // Förhindra scroll/tab för spelknappar
            if (' wsadqeWSADQE'.indexOf(e.key) >= 0 ||
                e.key.indexOf('Arrow') === 0 || e.key === 'Shift') {
                e.preventDefault();
            }
        };
        this._onKU = function(e) {
            self._keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
        };
        window.addEventListener('keydown', this._onKD);
        window.addEventListener('keyup',   this._onKU);
    }
};

MobileControls.prototype._rect = function() {
    if (this.target === window) {
        return { left: 0, top: 0, width: innerWidth, height: innerHeight };
    }
    return this.target.getBoundingClientRect();
};

MobileControls.prototype._down = function(e) {
    if (!state.active) return;
    
    // Tillåt klick/beröring på knappar och länkar (t.ex. Back/Hub eller Byt-knappen)
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.closest('button') || e.target.closest('a'))) {
        return;
    }

    e.preventDefault();
    var r = this._rect();
    var fx = (e.clientX - r.left) / r.width;

    if (fx < this.cfg.splitX) {
        // Vänster → gas-slider
        if (this.thr.id === null) {
            this.thr.active = true;
            this.thr.id = e.pointerId;
            this._setThrottle(e.clientY, r);
        }
    } else {
        // Höger → flytande spak — ankra här
        if (this.stick.id === null) {
            this.stick.active = true;
            this.stick.id = e.pointerId;
            this.stick.ax = e.clientX;
            this.stick.ay = e.clientY;
            this.stick.x = 0;
            this.stick.y = 0;
            this._renderStick(e.clientX, e.clientY);
        }
    }
};

MobileControls.prototype._move = function(e) {
    if (!state.active) return;
    var r = this._rect();
    if (e.pointerId === this.stick.id) {
        e.preventDefault();
        var dx = e.clientX - this.stick.ax;
        var dy = e.clientY - this.stick.ay;
        this.stick.x = clamp(dx / this.cfg.stickRadius, -1, 1);
        this.stick.y = clamp(dy / this.cfg.stickRadius, -1, 1);
        this._renderStick(e.clientX, e.clientY);
    } else if (e.pointerId === this.thr.id) {
        e.preventDefault();
        this._setThrottle(e.clientY, r);
    }
};

MobileControls.prototype._up = function(e) {
    if (e.pointerId === this.stick.id) {
        this.stick.active = false;
        this.stick.id = null;
        this.stick.x = 0;   // centrera = vingar plant
        this.stick.y = 0;
        this._hideStick();
    } else if (e.pointerId === this.thr.id) {
        this.thr.active = false;
        this.thr.id = null;  // gasen HÅLLER sitt värde
    }
};

MobileControls.prototype._setThrottle = function(clientY, r) {
    if (this._overlayEls && this._overlayEls.thr) {
        var rect = this._overlayEls.thr.getBoundingClientRect();
        var padding = 6;
        var top = rect.top + padding;
        var bot = rect.bottom - padding;
        this.throttle = clamp((bot - clientY) / (bot - top), 0, 1);
    } else {
        var top = r.top + this.cfg.throttleTop * r.height;
        var bot = r.top + this.cfg.throttleBot * r.height;
        this.throttle = clamp((bot - clientY) / (bot - top), 0, 1);
    }
    this._renderThrottle();
};

/* ── Expo-kurva + dödzon ──────────────────────── */
MobileControls.prototype._shape = function(v) {
    var dz = this.cfg.deadzone;
    var s = Math.sign(v);
    var a = Math.abs(v);
    if (a < dz) return 0;
    a = (a - dz) / (1 - dz);                      // skala bort dödzonen
    var e = this.cfg.expo;
    return s * ((1 - e) * a + e * a * a * a);      // expo-kurva
};

MobileControls.prototype._key = function(name) {
    return this._keys.has(name) ? 1 : 0;
};
MobileControls.prototype._k = function() {
    for (var i = 0; i < arguments.length; i++) {
        if (this._keys.has(arguments[i])) return 1;
    }
    return 0;
};

/* ── Overlay (flytande spak-ring + gasmätare) ──── */
MobileControls.prototype._buildOverlay = function() {
    var mk = function(css) {
        var d = document.createElement('div');
        d.style.cssText = css;
        d.className = 'plane-mc-overlay';
        document.body.appendChild(d);
        return d;
    };
    var base = 'position:fixed;pointer-events:none;z-index:9998;border-radius:50%;display:none;';
    this._overlayEls = {
        ring:    mk(base + 'width:180px;height:180px;border:2px solid rgba(96,165,250,.3);transform:translate(-50%,-50%);'),
        knob:    mk(base + 'width:64px;height:64px;background:rgba(96,165,250,.35);border:3px solid rgba(96,165,250,.7);transform:translate(-50%,-50%);backdrop-filter:blur(4px);'),
        thr:     mk('position:fixed;pointer-events:none;z-index:9998;left:22px;bottom:14%;width:46px;height:160px;border:2px solid rgba(96,165,250,.25);border-radius:23px;background:rgba(15,23,42,.3);'),
        thrFill: mk('position:fixed;pointer-events:none;z-index:9998;left:26px;bottom:14%;width:38px;border-radius:19px;background:rgba(96,165,250,.4);'),
        thrLbl:  mk('position:fixed;pointer-events:none;z-index:9998;left:16px;font-family:monospace;font-size:10px;color:rgba(96,165,250,.5);text-align:center;width:58px;'),
    };
    // Placera GAS-label under slidern
    this._overlayEls.thrLbl.style.bottom = 'calc(14% - 20px)';
    this._overlayEls.thrLbl.textContent = 'GAS';
    this._renderThrottle();
};

MobileControls.prototype._renderStick = function(cx, cy) {
    if (!this._overlayEls) return;
    var ring = this._overlayEls.ring, knob = this._overlayEls.knob;
    ring.style.display = knob.style.display = 'block';
    ring.style.left = this.stick.ax + 'px'; ring.style.top = this.stick.ay + 'px';

    var dx = cx - this.stick.ax;
    var dy = cy - this.stick.ay;
    var dist = Math.sqrt(dx*dx + dy*dy);
    var maxR = this.cfg.stickRadius;
    if (dist > maxR && dist > 0) {
        dx *= maxR / dist;
        dy *= maxR / dist;
    }
    knob.style.left = (this.stick.ax + dx) + 'px';
    knob.style.top = (this.stick.ay + dy) + 'px';
};

MobileControls.prototype._hideStick = function() {
    if (!this._overlayEls) return;
    this._overlayEls.ring.style.display = this._overlayEls.knob.style.display = 'none';
};

MobileControls.prototype._renderThrottle = function() {
    if (!this._overlayEls) return;
    this._overlayEls.thrFill.style.height = Math.round(this.throttle * 156) + 'px';
};

MobileControls.prototype.dispose = function() {
    var el = this.target;
    el.removeEventListener('pointerdown',   this._onDown);
    el.removeEventListener('pointermove',   this._onMove);
    el.removeEventListener('pointerup',     this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
    window.removeEventListener('blur',      this._onBlur);
    if (this.cfg.keyboard) {
        window.removeEventListener('keydown', this._onKD);
        window.removeEventListener('keyup',   this._onKU);
    }
    if (this._overlayEls) {
        var els = this._overlayEls;
        for (var k in els) { if (els[k] && els[k].remove) els[k].remove(); }
        this._overlayEls = null;
    }
    // Återställ touchAction
    var styleHost = (el === window) ? document.body : el;
    if (styleHost && styleHost.style) styleHost.style.touchAction = '';
};


/* ==========================================================================
 *  State
 * ========================================================================== */
var state = {
    active: false,
    crashed: false,
    onGround: false,
    model: null,
    mesh: null,
    propeller: null,
    throttle: 0.6,
    displaySpeed: 0,
    altitude: 0,
};

var mobileControls = null;   // MobileControls-instans (skapas vid activate)
var lastTime = 0;

// Wrapper config (inte FlightModel-fysik)
var WRAP = {
    gearHeight:     0.8,    // markklaring (hjul → centrum)
    crashSpeed:     999,    // studsa, aldrig krasch
    minAltitude:    0.8,    // minimum höjd över terräng (0.8m tillåter landning på hjulen)
    ceilingY:       500,    // max höjd
};

/* ==========================================================================
 *  Fysik-uppdatering (per frame)
 * ========================================================================== */
function updatePlane(dt) {
    if (!state.active || !state.model || state.crashed) return;
    dt = Math.min(dt, 0.05);

    // Läs input via MobileControls (hanterar touch + tangentbord + gamepad)
    var input = mobileControls ? mobileControls.getInput(dt) : { pitch: 0, roll: 0, yaw: 0, throttle: 0.6 };
    state.throttle = input.throttle;

    // Kör FlightModel
    state.model.update(dt, input);

    // ── Terrängkollision ──
    var groundY = 0;
    if (typeof window.localGetTerrainAt === 'function') {
        var terrain = window.localGetTerrainAt(state.model.position.x, -state.model.position.z);
        groundY = terrain ? terrain.z : 0;
    } else if (typeof window.getTerrainHeight === 'function') {
        groundY = window.getTerrainHeight(state.model.position.x, state.model.position.z);
    }

    var minFloor = groundY + WRAP.minAltitude;
    var floorY   = groundY + WRAP.gearHeight;

    if (state.model.position.y <= floorY) {
        // Hjulkontakt / landning
        state.model.position.y = floorY;
        if (Math.abs(state.model.velocity.y) > 2.0) {
            state.model.velocity.y = Math.abs(state.model.velocity.y) * 0.3; // studs
            state.onGround = false;
        } else {
            state.model.velocity.y = Math.max(0, state.model.velocity.y);
            state.model.velocity.x *= 0.96; // rullfriktion
            state.model.velocity.z *= 0.96;
            state.onGround = true;
        }
    } else if (state.model.position.y <= minFloor) {
        // Säkerhetsgolv (om minAltitude > gearHeight): mjuk studs men ingen broms/landningsstatus
        state.model.position.y = minFloor;
        state.model.velocity.y = Math.abs(state.model.velocity.y) * 0.3;
        state.onGround = false;
    } else {
        state.onGround = false;
    }

    // Världsgränser
    var half = (window.TERRAIN_SIZE || 900) / 2 - 5;
    state.model.position.x = clamp(state.model.position.x, -half, half);
    state.model.position.z = clamp(state.model.position.z, -half, half);
    state.model.position.y = Math.min(state.model.position.y, WRAP.ceilingY);

    // ── Synka mesh ──
    state.model.applyTo(state.mesh);

    // Propeller-snurr (snabbare med gas)
    if (state.propeller) {
        var rSpeed = 3 + state.throttle * 28;
        state.propeller.rotation.z += rSpeed * dt;
    }

    // Telemetri
    state.displaySpeed = state.model.speed;
    state.altitude     = Math.max(0, state.model.position.y - groundY);
}


/* ==========================================================================
 *  Kamera (jaktvy bakom planet)
 * ========================================================================== */
var camOffset  = new THREE.Vector3(0, 5, 16);
var camSmooth  = new THREE.Vector3();
var camTarget  = new THREE.Vector3();
var camUpSmooth = new THREE.Vector3(0, 1, 0);
var camInited  = false;
var lastFwd    = new THREE.Vector3(0, 0, -1);

function updateCamera(camera) {
    if (!state.mesh || !state.model) return;

    var ori = state.model.orientation;
    var forward = FORWARD.clone().applyQuaternion(ori);
    var up      = UP.clone().applyQuaternion(ori);

    // Camera: behind + above in plane's LOCAL frame (follows through loops)
    var targetCam = state.model.position.clone()
        .addScaledVector(forward, -camOffset.z)   // behind plane
        .addScaledVector(up, camOffset.y);         // above plane (local up!)

    if (!camInited) {
        camSmooth.copy(targetCam);
        camUpSmooth.copy(up);
        camInited = true;
    }

    camSmooth.lerp(targetCam, 0.09);
    camera.position.copy(camSmooth);

    // Look ahead of the plane
    camTarget.copy(state.model.position).addScaledVector(forward, 8);
    camera.lookAt(camTarget);

    // Smooth up-vector so camera rolls with the plane (no sudden flips)
    camUpSmooth.lerp(up, 0.07);
    camUpSmooth.normalize();
    camera.up.copy(camUpSmooth);
}


/* ==========================================================================
 *  HUD
 * ========================================================================== */
function createHUD() {
    var ex = document.getElementById('plane-hud');
    if (ex) ex.remove();
    var h = document.createElement('div');
    h.id = 'plane-hud';
    h.innerHTML =
        '<div style="position:fixed;bottom:30px;right:30px;z-index:9999;pointer-events:none;font-family:\'Inter\',\'Segoe UI\',sans-serif">' +
        '<div style="background:rgba(15,23,42,0.92);border:1px solid #334155;border-radius:16px;padding:16px 24px;backdrop-filter:blur(12px);min-width:200px;text-align:center">' +
        '<div id="plane-speed" style="font-size:52px;font-weight:900;color:#3b82f6;letter-spacing:-2px;line-height:1">0</div>' +
        '<div style="font-size:11px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:2px;margin-top:2px">km/h</div>' +
        '<div style="height:1px;background:#334155;margin:10px 0"></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Alt</div>' +
          '<div id="plane-alt" style="font-size:14px;color:#22d3ee;font-weight:bold">0m</div></div>' +
          '<div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">AoA</div>' +
          '<div id="plane-aoa" style="font-size:14px;color:#4ade80;font-weight:bold">0°</div></div>' +
          '<div><div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Gas</div>' +
          '<div id="plane-thr" style="font-size:14px;color:#4ade80;font-weight:bold">0%</div></div>' +
        '</div>' +
        '<div id="plane-state" style="font-size:12px;font-weight:900;color:#4ade80;margin-top:8px">🛬 MARK</div>' +
        '</div></div>' +
        // Kontroll-hint
        '<div id="plane-controls-hint" style="position:fixed;top:80px;left:50%;transform:translateX(-50%);z-index:9999;pointer-events:none;' +
        'background:rgba(15,23,42,0.9);border:1px solid #334155;border-radius:12px;padding:12px 24px;backdrop-filter:blur(8px);' +
        'font-family:\'Inter\',sans-serif;transition:opacity 2s ease">' +
        '<div style="color:#e2e8f0;font-size:13px;font-weight:bold;text-align:center">✈️ STUNTPLAN</div>' +
        '<div style="color:#94a3b8;font-size:11px;margin-top:4px;text-align:center">' +
        ((/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1) ?
          'Höger tumme: STYR &nbsp; SPACE = BOOST 🚀' :
          '<b>AD/←→</b> Sväng &nbsp; <b>WS/↑↓</b> Upp/Ner &nbsp; <b>SPACE</b> Boost 🚀 &nbsp; <b>H</b> Byt') +
        '</div></div>';
    document.body.appendChild(h);
    // Fada ut hint efter 6s
    setTimeout(function() {
        var c = document.getElementById('plane-controls-hint');
        if (c) c.style.opacity = '0';
        setTimeout(function() { if (c) c.remove(); }, 2000);
    }, 6000);
}

function updateHUD() {
    var se = document.getElementById('plane-speed');
    var al = document.getElementById('plane-alt');
    var ao = document.getElementById('plane-aoa');
    var th = document.getElementById('plane-thr');
    var st = document.getElementById('plane-state');
    if (!state.model) return;

    var kmh = Math.round(state.displaySpeed * 3.6);
    if (se) {
        se.textContent = kmh;
        se.style.color = kmh < 60 ? '#4ade80' : kmh < 150 ? '#3b82f6' : '#f59e0b';
    }
    if (al) al.textContent = Math.round(state.altitude) + 'm';
    if (ao) {
        var aoaVal = Math.round(state.model.aoaDeg);
        ao.textContent = aoaVal + '°';
        ao.style.color = state.model.stalled ? '#ef4444' : Math.abs(aoaVal) > 12 ? '#fbbf24' : '#4ade80';
    }
    if (th) {
        var pct = Math.round(state.throttle * 100);
        th.textContent = pct + '%';
        th.style.color = pct > 80 ? '#f59e0b' : pct > 40 ? '#4ade80' : '#94a3b8';
    }
    if (st) {
        if (state.onGround) {
            st.innerHTML = '🛬 MARK';
            st.style.color = '#4ade80';
        } else if (state.model.stalled) {
            st.innerHTML = '🍂 STALL';
            st.style.color = '#ef4444';
        } else {
            st.innerHTML = '✈️ FLYGER';
            st.style.color = '#3b82f6';
        }
    }
}

/* ── Krasch-UI ─────────────────────────────────── */
function showCrashUI(show) {
    var ex = document.getElementById('plane-crash');
    if (show) {
        if (!ex) {
            var d = document.createElement('div');
            d.id = 'plane-crash';
            d.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;' +
                'color:#ef4444;font-size:48px;font-family:monospace;text-align:center;text-shadow:0 0 20px #ef4444;pointer-events:none;';
            d.innerHTML = 'KRASCH!<br><span style="font-size:18px">tryck R för omstart</span>';
            document.body.appendChild(d);
        }
    } else {
        if (ex) ex.remove();
    }
}

function resetPlane() {
    if (!state.model) return;
    var groundY = 0;
    if (typeof window.localGetTerrainAt === 'function') {
        var t = window.localGetTerrainAt(state.model.position.x, -state.model.position.z);
        groundY = t ? t.z : 0;
    }
    state.model.position.set(state.model.position.x, groundY + 50, state.model.position.z);
    state.model.velocity.set(0, 0, 0);
    state.model.angVelBody.set(0, 0, 0);
    // Ge framåtfart så det inte stallar direkt
    var fwd = FORWARD.clone().applyQuaternion(state.model.orientation);
    state.model.velocity.copy(fwd.multiplyScalar(40));
    state.throttle = 0.6;
    state.crashed = false;
    state.onGround = false;
    showCrashUI(false);
}


/* ==========================================================================
 *  PUBLIC API — window.rallyPlane
 * ========================================================================== */
window.rallyPlane = {
    /**
     * Aktivera stuntplanet.
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {Object} [spawnCfg] - { x, y, z, heading }  (valfritt)
     */
    activate: function(scene, camera, spawnCfg) {
        // Rensa eventuellt gammalt
        if (state.mesh) scene.remove(state.mesh);

        // Skapa fysikmodell
        state.model = new FlightModel({
            signRoll:    -1,
            yawRate:     1.5,      // lugnare sväng (var 3.5)
            rollRate:    1.5,      // mjukare bank (var 3.0)
            lateralDrag: 1.5,     // måttligt sidmotstånd — velocity följer nosen utan att blockera svängar
            yawStability: 0.2,    // låg riktningsstabilitet så nosen stannar där man pekar den
            stallSpeed:  3,       // lägre stallfart (praktiskt taget omöjligt att stalla)
            maxThrust:   8000,    // bra toppfart
            autoLevel:   6.0,      // stabiliserar vingarna snabbt men utan wobble (var 10)
            autoPitch:   0.2,     // mycket mild höjdhållning i svängar (var 1.5)
            maxRoll:     0.8,     // begränsa bankvinkeln till max ~45 grader för att förhindra roll-over
            maxPitch:    0,       // ingen pitch-begränsning — loops tillåtna!
            pitchAutoLevel: 1.0,   // mild — nosen söker horisonten vid spaksläpp men stör inte loops
            minAuthority: 0.8,   // starka roder även vid låg fart
            refSpeed:    25,     // full authority tidigt
            responsiveness: 10,  // responsiv men stabil (var 12)
            arcadeMode:     true,  // stäng av komplicerad fysik, flyg som i en räls/arkad-bil
            disableStall:   true,  // stäng av stall helt så man aldrig tappar kontrollen
        });

        // Spawn-position
        var sx = 0, sy = 50, sz = 0, sh = 0;
        if (spawnCfg) {
            sx = spawnCfg.x || 0;
            sy = spawnCfg.y !== undefined ? spawnCfg.y : 50;
            sz = spawnCfg.z || 0;
            sh = spawnCfg.heading || 0;
        }
        state.model.position.set(sx, sy, sz);
        state.model.setHeading(sh);

        // Ge initial framåtfart
        var fwd = FORWARD.clone().applyQuaternion(state.model.orientation);
        state.model.velocity.copy(fwd.multiplyScalar(40));

        // Skapa mesh
        var meshResult = createPlaneMesh();
        state.mesh      = meshResult.group;
        state.propeller = meshResult.propeller;

        state.throttle   = 0.6;
        state.crashed    = false;
        state.onGround   = false;
        state.active     = true;
        state.displaySpeed = 0;
        state.altitude   = 0;
        camInited = false;
        lastFwd.set(0, 0, -1).applyQuaternion(state.model.orientation);
        lastTime = 0;

        scene.add(state.mesh);
        createHUD();

        // Skapa MobileControls (flytande spak + gas-slider + tangentbord + gamepad)
        if (mobileControls) mobileControls.dispose();
        mobileControls = new MobileControls({
            overlay:         true,
            autoThrottle:    true,     // auto-gas: krusfart + Space = boost
            cruiseThrottle:  0.7,
            boostThrottle:   1.0,
            coordination:    1.2,      // dämpad gir-koordination för att slippa spinn (var 3.0)
            expo:            0.4,      // lätt expo
            deadzone:        0.10,     // dödzon
            stickRadius:     80,       // spakradie
        });

        var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1);
        console.log('✈️ Stuntplan aktiverat — ' + (isMobile ? 'flytande spak + gas-slider' : 'tangentbord + mus'));
    },

    deactivate: function(scene) {
        state.active = false;
        if (state.mesh) { scene.remove(state.mesh); state.mesh = null; }
        state.propeller = null;
        state.model = null; // Stoppa HUD-beräkningar
        var h = document.getElementById('plane-hud'); if (h) h.remove();
        var c = document.getElementById('plane-controls-hint'); if (c) c.remove();
        if (mobileControls) { mobileControls.dispose(); mobileControls = null; }
        showCrashUI(false);
        console.log('✈️ Stuntplan avaktiverat');
    },

    update: function(camera) {
        var now = performance.now();
        var dt = lastTime ? (now - lastTime) / 1000 : 0.016;
        lastTime = now;
        dt = Math.min(dt, 0.05);
        updatePlane(dt);
        updateCamera(camera);
        updateHUD();
    },

    isActive:    function() { return state.active; },
    getPosition: function() { return state.model ? state.model.position : new THREE.Vector3(); },
    getPlane:    function() { return state; },
    getAltitude: function() { return state.altitude; },
    getSpeed:    function() { return state.displaySpeed; },
    reset:       function() { resetPlane(); },
    getConfig:   function() { return state.model ? state.model.config : null; },
};

})();
