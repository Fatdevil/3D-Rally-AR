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
    ENGINE_POWER: 55000,  // Arcade power unit (not Nm or N — scales with gear/turbo/falloff)
    MAX_SPEED: 80, // m/s (ca 288 km/h i absolut max teoretisk topfart)
    BRAKE_FORCE: 65000, 
    REVERSE_MAX: 15,
    DRAG: 0.995, // Minskade luftmotståndet avsevärt för att tillåta högre toppfarter
    HANDBRAKE_DRAG: 0.92,
    MAX_STEER: 28, MIN_STEER: 3, WHEELBASE: 2.7,
    DRIFT_STEER_BONUS: 1.5, HANDBRAKE_GRIP: 0.05,
    GRAVITY: 9.81, GRAVITY_AIR_MULT: 1.4, AIR_CONTROL: 0.3,
    CAR_HEIGHT: 0.35, WHEEL_SPIN: 0.15,
    ROLL_SENS: 0.8, PITCH_SENS: 0.12,
    DRIFT_TARGET_GRIP: 0.20, // Exponerad för realtidsjustering
    // FAS1-K1: Weight transfer
    CGH: 0.50,     // Center of gravity height (m) — WRC ~0.45-0.55
    TRACK: 1.60,   // Track width (m) — typical rally car
    // FAS1-H3: Brake bias
    BRAKE_BIAS: 0.60,  // 60% front, 40% rear (default rally)
    // FAS1-H1: Suspension per wheel
    SPRING_RATE: 25000,        // N/m — rally gravel spec
    DAMPER: 4000,              // Ns/m — compression damping
    SUSPENSION_TRAVEL: 0.15,   // m — max compression from rest
    WHEEL_RADIUS: 0.35,        // m — matches visual wheel geo
    // Wheel positions relative to car center (local space)
    WHEEL_FL: [-1.0, 0, 1.3],   // Front Left
    WHEEL_FR: [1.0, 0, 1.3],    // Front Right
    WHEEL_RL: [-1.0, 0, -1.3],  // Rear Left
    WHEEL_RR: [1.0, 0, -1.3],   // Rear Right
    // FAS2-H2: Gearbox & engine
    GEAR_RATIOS: [0, 3.5, 2.2, 1.6, 1.2, 0.95],  // [neutral, 1st..5th]
    FINAL_DRIVE: 4.1,          // Final drive ratio
    WHEEL_CIRCUMFERENCE: 2.0,  // m (2π × 0.318) — legacy, use WHEEL_RADIUS instead
    TRACTION_MULT: 2.5,        // arcade traction multiplier (>1 = more grip than physics)
    MAX_RPM: 7500,
    IDLE_RPM: 1200,
    SHIFT_UP_RPM: 6800,
    SHIFT_DOWN_RPM: 3200,
    SHIFT_TIME: 0.15,          // seconds — sequential gearbox shift delay
    TURBO_LAG: 0.3,            // seconds to build full boost
    TURBO_BOOST: 1.35,         // max torque multiplier from turbo
    // Torque curve: [rpm_fraction, torque_fraction] — sampled & interpolated
    TORQUE_CURVE: [[0, 0.45], [0.15, 0.65], [0.3, 0.82], [0.5, 0.95], [0.65, 1.0], [0.8, 0.98], [0.9, 0.90], [1.0, 0.75]],
    // FAS2-K3: Differential (LSD)
    DIFF_DRIVE_LOCK: 0.3,      // 0=open, 1=locked — under acceleration
    DIFF_BRAKE_LOCK: 0.2,      // 0=open, 1=locked — under braking/coast
    DIFF_PRELOAD: 50,          // Nm — minimum locking torque
    TORQUE_BIAS: 0.5,          // 0=full front, 0.5=50/50, 1=full rear (4WD default)
    // FAS2-H5: Anti-roll bars
    ARB_FRONT: 8000,           // N/m — front anti-roll stiffness
    ARB_REAR: 6000,            // N/m — rear anti-roll stiffness
    // FAS2-H6: Camber & Toe
    CAMBER_FRONT: -1.5,        // degrees (negative = top tilts in)
    CAMBER_REAR: -0.8,         // degrees
    TOE_FRONT: 0.2,            // degrees (positive = toe-out)
    TOE_REAR: -0.1,            // degrees (negative = toe-in = stability)
    // FAS3-H4: Tyre compound system
    TYRE_COMPOUND: 'SOFT',     // SOFT / MEDIUM / HARD / WET
    TYRE_WEAR_RATE: 0.00004,   // wear per second per m/s² (SOFT baseline)
    TYRE_OVERHEAT_TEMP: 110,   // °C — above this, grip drops
    TYRE_OPTIMAL_TEMP: 85,     // °C — peak grip temperature
    TYRE_COLD_TEMP: 40,        // °C — below this, grip reduced
    TYRE_COOLING_RATE: 0.02,   // 1/s Newton cooling coefficient (M2 fix: was 2.0 × 0.01)
    TYRE_HEATING_RATE: 0.4     // °C/s per unit of slip intensity
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
    _invulnerable: 0, _spawnPosition: null,
    // FAS1-K1: Per-wheel state
    wheelLoad: [0, 0, 0, 0],       // Vertical load per wheel (N) [FL,FR,RL,RR]
    totalGrip: 1.0,                // Normalized total grip (sum of per-wheel / baseline)
    // FAS1-H1: Suspension per wheel
    suspPos: [0, 0, 0, 0],         // Compression (0=rest, +up=compressed) (m)
    suspVel: [0, 0, 0, 0],         // Compression velocity (m/s)
    normalForce: [0, 0, 0, 0],     // Contact force per wheel (N) — 0 when airborne
    wheelGroundY: [0, 0, 0, 0],    // Terrain height at each wheel
    // FAS1-K2: Friction circle
    frictionScale: 1.0,            // Combined slip scaling factor (1.0 = no saturation)
    // FAS2-H2: Gearbox state
    rpm: 1200,                     // Current engine RPM
    gear: 1,                       // Current gear (1-5)
    turboPressure: 0,              // 0..1 turbo boost level
    shiftTimer: 0,                 // Countdown during gear change (no power)
    // FAS2-K3: Differential
    diffLockState: 0,              // Current effective lock ratio (0..1)
    // FAS3-H4: Tyre compound state
    tyreWear: 0,                   // 0..1 (0=new, 1=destroyed)
    tyreTemp: 60,                  // °C
    tyreGripMult: 1.0,             // Combined compound+wear+temp grip multiplier
    tyreCompound: 'SOFT'           // Current compound name
};
let input = { throttle:0, brake:0, steer:0, handbrake:false };
let keys = {}, lastTime = 0;

// ─── CAR MESH — Procedural Rally Car (~900 tris, 3 materials) ───
// Profile-aware body color. Maintains { steer, spin } wheel API.
const CAR_PROFILE_COLORS = {
    GROUP_A:     0xdc2626, // Red
    WRC:         0x2563eb, // Blue
    RWD_DRIFT:   0xf97316, // Orange
    FWD_HOT:     0xfbbf24, // Yellow
    TROPHY_TRUCK:0x16a34a  // Green
};

function createCarMesh() {
    let g = new THREE.Group(); g.name = 'RallyCar';

    // car.position.y = groundY + CAR_HEIGHT (0.35m above terrain)
    // All geometry must be offset DOWN by CAR_HEIGHT so wheels touch ground
    let yOff = -CFG.CAR_HEIGHT; // -0.35

    // Determine body color from active profile
    let profileKey = (window.rallyCarProfiles && window.rallyCarProfiles.getCurrentProfile()) || 'GROUP_A';
    let bodyColor = CAR_PROFILE_COLORS[profileKey] || 0xdc2626;

    // === MATERIALS ===
    let bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
    let darkMat = new THREE.MeshLambertMaterial({ color: 0x1e293b }); // dark trim
    let accentMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }); // lights, details
    let glassMat = new THREE.MeshLambertMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4 });
    let carbonMat = new THREE.MeshLambertMaterial({ color: 0x334155 }); // carbon/underbody

    // Store materials for runtime color swap
    g.userData.bodyMat = bodyMat;

    // === BODY SHELL ===
    // Main body (lower)
    let bodyLower = new THREE.Mesh(
        new THREE.BoxGeometry(1.85, 0.45, 4.2),
        bodyMat
    );
    bodyLower.position.set(0, 0.42 + yOff, 0);
    g.add(bodyLower);

    // Cabin (upper, narrower, set back)
    let cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.65, 0.42, 1.8),
        bodyMat
    );
    cabin.position.set(0, 0.87 + yOff, -0.15);
    g.add(cabin);

    // === HOOD (front, sloped) ===
    let hoodGeo = new THREE.BoxGeometry(1.7, 0.12, 1.4);
    let hood = new THREE.Mesh(hoodGeo, bodyMat);
    hood.position.set(0, 0.72 + yOff, 1.2);
    hood.rotation.x = -0.08; // slight downward slope
    g.add(hood);

    // Hood scoop (rally intake)
    let scoop = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.15, 0.5),
        darkMat
    );
    scoop.position.set(0, 0.82 + yOff, 1.0);
    g.add(scoop);

    // === REAR DECK ===
    let rearDeck = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.1, 0.8),
        bodyMat
    );
    rearDeck.position.set(0, 0.72 + yOff, -1.5);
    rearDeck.rotation.x = 0.06;
    g.add(rearDeck);

    // === WINDSHIELD (front) ===
    let windshield = new THREE.Mesh(
        new THREE.BoxGeometry(1.55, 0.5, 0.06),
        glassMat
    );
    windshield.position.set(0, 0.9 + yOff, 0.75);
    windshield.rotation.x = 0.35; // angled
    g.add(windshield);

    // Rear window
    let rearWindow = new THREE.Mesh(
        new THREE.BoxGeometry(1.45, 0.4, 0.06),
        glassMat
    );
    rearWindow.position.set(0, 0.88 + yOff, -1.0);
    rearWindow.rotation.x = -0.3;
    g.add(rearWindow);

    // Side windows (left + right)
    for (let side of [-1, 1]) {
        let sideWin = new THREE.Mesh(
            new THREE.BoxGeometry(0.04, 0.32, 1.2),
            glassMat
        );
        sideWin.position.set(side * 0.83, 0.9 + yOff, -0.1);
        g.add(sideWin);
    }

    // === FRONT BUMPER ===
    let frontBumper = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.22, 0.25),
        darkMat
    );
    frontBumper.position.set(0, 0.28 + yOff, 2.05);
    g.add(frontBumper);

    // Front splitter
    let splitter = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.04, 0.15),
        carbonMat
    );
    splitter.position.set(0, 0.25 + yOff, 2.1);
    g.add(splitter);

    // === REAR BUMPER ===
    let rearBumper = new THREE.Mesh(
        new THREE.BoxGeometry(1.9, 0.25, 0.2),
        darkMat
    );
    rearBumper.position.set(0, 0.3 + yOff, -2.05);
    g.add(rearBumper);

    // Rear diffuser
    let diffuser = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.06, 0.2),
        carbonMat
    );
    diffuser.position.set(0, 0.25 + yOff, -2.1);
    g.add(diffuser);

    // === HEADLIGHTS (2× front) ===
    let headlightLights = [];
    let headlightMeshes = [];
    let lightsActive = (typeof car !== 'undefined' && car && car.headlightsOn);
    for (let side of [-0.7, 0.7]) {
        let lightMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: lightsActive ? 0xfffee0 : 0x000000 });
        let headlight = new THREE.Mesh(
            new THREE.BoxGeometry(0.35, 0.12, 0.08),
            lightMat
        );
        headlight.position.set(side, 0.55 + yOff, 2.08);
        g.add(headlight);
        headlightMeshes.push(headlight);

        // Actual Three.js SpotLight for headlight beam
        let spotLight = new THREE.SpotLight(0xfffee0, lightsActive ? 15.0 : 0.0, 50, Math.PI / 4, 0.5, 0.8);
        spotLight.position.set(side, 0.55 + yOff, 2.1);
        spotLight.castShadow = true;
        spotLight.shadow.mapSize.width = 512;
        spotLight.shadow.mapSize.height = 512;
        spotLight.shadow.camera.near = 0.5;
        spotLight.shadow.camera.far = 50;

        let target = new THREE.Object3D();
        target.position.set(side, 0.55 + yOff, 15.0); // 15m in front
        
        g.add(spotLight);
        g.add(target);
        spotLight.target = target;
        
        headlightLights.push(spotLight);
    }
    g.userData.headlights = headlightLights;
    g.userData.headlightMeshes = headlightMeshes;

    // === TAILLIGHTS (2× rear) ===
    for (let side of [-0.7, 0.7]) {
        let taillight = new THREE.Mesh(
            new THREE.BoxGeometry(0.3, 0.1, 0.08),
            new THREE.MeshLambertMaterial({ color: 0xef4444 })
        );
        taillight.position.set(side, 0.55 + yOff, -2.08);
        g.add(taillight);
    }

    // === SPOILER (rear wing) ===
    // Wing stands
    for (let side of [-0.5, 0.5]) {
        let stand = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.25, 0.06),
            carbonMat
        );
        stand.position.set(side, 0.98 + yOff, -1.7);
        g.add(stand);
    }
    // Wing blade
    let wing = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.04, 0.3),
        carbonMat
    );
    wing.position.set(0, 1.13 + yOff, -1.7);
    wing.rotation.x = -0.12;
    g.add(wing);

    // === SIDE SKIRTS ===
    for (let side of [-1, 1]) {
        let skirt = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 0.12, 3.8),
            darkMat
        );
        skirt.position.set(side * 0.95, 0.28 + yOff, 0);
        g.add(skirt);
    }

    // === WHEEL ARCHES (flared fenders) ===
    let archGeo = new THREE.BoxGeometry(0.12, 0.2, 0.7);
    for (let i = 0; i < 4; i++) {
        let sx = (i % 2 === 0) ? -1 : 1;
        let sz = (i < 2) ? 1.3 : -1.3;
        let arch = new THREE.Mesh(archGeo, bodyMat);
        arch.position.set(sx * 0.96, 0.52 + yOff, sz);
        g.add(arch);
    }

    // === ROOF RAIL / LIGHT BAR (rally style) ===
    let lightBar = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.06, 0.12),
        accentMat
    );
    lightBar.position.set(0, 1.12 + yOff, 0.6);
    g.add(lightBar);

    // Rally number plate (front)
    let plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.3, 0.02),
        accentMat
    );
    plate.position.set(0, 0.45 + yOff, 2.1);
    g.add(plate);

    // Underbody removed — not visible from chase cam and caused ground clipping

    // === GATHER BODY PARTS INTO SUBGROUP ===
    // All children added to g so far are body parts. Move them to a separate CarBody group
    // so we can tilt the body visually without tilting the wheels.
    let bodyGroup = new THREE.Group();
    bodyGroup.name = 'CarBody';
    bodyGroup.rotation.order = 'YXZ';
    
    let children = [...g.children];
    children.forEach(child => {
        g.remove(child);
        bodyGroup.add(child);
    });
    g.add(bodyGroup);
    g.userData.bodyGroup = bodyGroup;

    // === WHEELS (same API: { steer, spin }) ===
    car.wheels = [];
    let wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.28, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    let wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });

    // Rim: 5-spoke star effect using small boxes
    let rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.30, 8);
    rimGeo.rotateZ(Math.PI / 2);
    let rimMat = new THREE.MeshLambertMaterial({ color: 0xd4d4d8 });

    // Rim center cap
    let capGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.32, 8);
    capGeo.rotateZ(Math.PI / 2);

    let wheelPos = [
        [-1.0, 0.34 + yOff,  1.3],  // FL
        [ 1.0, 0.34 + yOff,  1.3],  // FR
        [-1.0, 0.34 + yOff, -1.3],  // RL
        [ 1.0, 0.34 + yOff, -1.3]   // RR
    ];

    for (let i = 0; i < 4; i++) {
        let steerGroup = new THREE.Group();
        steerGroup.position.set(...wheelPos[i]);

        let spinGroup = new THREE.Group();

        // Tyre
        let tyre = new THREE.Mesh(wheelGeo, wheelMat);
        spinGroup.add(tyre);

        // Rim
        let rim = new THREE.Mesh(rimGeo, rimMat);
        spinGroup.add(rim);

        // Center cap
        let cap = new THREE.Mesh(capGeo, accentMat);
        spinGroup.add(cap);

        steerGroup.add(spinGroup);
        g.add(steerGroup);

        car.wheels.push({ steer: steerGroup, spin: spinGroup });
    }

    // Brake discs removed — static meshes don't follow suspension and can clip ground

    // GLB upgrade path: when a GLB is loaded, swap body meshes but keep wheels
    // window.rallyVehicle._swapBodyGLB(glbScene) can be implemented later

    return g;
}

// ─── FAS2-H2: ENGINE HELPERS ───
// Sample torque curve at normalized RPM (0..1) → torque fraction (0..1)
function sampleTorqueCurve(rpmNorm) {
    let curve = CFG.TORQUE_CURVE;
    if (rpmNorm <= curve[0][0]) return curve[0][1];
    if (rpmNorm >= curve[curve.length-1][0]) return curve[curve.length-1][1];
    for (let i = 1; i < curve.length; i++) {
        if (rpmNorm <= curve[i][0]) {
            let t = (rpmNorm - curve[i-1][0]) / (curve[i][0] - curve[i-1][0]);
            return curve[i-1][1] + t * (curve[i][1] - curve[i-1][1]);
        }
    }
    return 0.75;
}

// Auto-shift logic: returns new gear or same
function autoShift(rpm, gear, throttle) {
    if (car.shiftTimer > 0) return gear;  // mid-shift, don't change
    let maxGear = CFG.GEAR_RATIOS.length - 1;
    if (rpm > CFG.SHIFT_UP_RPM && gear < maxGear && throttle > 0.3) return gear + 1;
    if (rpm < CFG.SHIFT_DOWN_RPM && gear > 1) return gear - 1;
    return gear;
}

// ─── FAS3-H4: TYRE COMPOUND SYSTEM ───
const TYRE_COMPOUNDS = {
    SOFT: {
        gripMult: 1.12,         // peak grip bonus
        wearRate: 1.0,          // baseline wear
        optimalTemp: 85,        // °C
        tempRange: 25,          // ±°C from optimal = good grip
        label: 'SOFT', color: '#ef4444'
    },
    MEDIUM: {
        gripMult: 1.0,
        wearRate: 0.55,
        optimalTemp: 80,
        tempRange: 35,
        label: 'MEDIUM', color: '#fbbf24'
    },
    HARD: {
        gripMult: 0.90,
        wearRate: 0.30,
        optimalTemp: 75,
        tempRange: 45,
        label: 'HARD', color: '#94a3b8'
    },
    WET: {
        gripMult: 0.78,         // less grip on dry surface
        wearRate: 1.5,          // wears fast on dry
        optimalTemp: 55,
        tempRange: 40,
        label: 'WET', color: '#38bdf8'
    }
};

function updateTyres(dt, forwardVel, lateralVel, slipAngle, onGround, surfaceGrip) {
    let compound = TYRE_COMPOUNDS[car.tyreCompound] || TYRE_COMPOUNDS.SOFT;

    if (!onGround) {
        // Airborne: cool down, no wear
        car.tyreTemp = Math.max(20, car.tyreTemp - CFG.TYRE_COOLING_RATE * 2 * dt);
        return;
    }

    // Slip intensity = combined lateral + longitudinal slip
    // M3 fix: slipAngle now in degrees (consistent with car.slipAngleDeg)
    let slipAngleRad = Math.abs(slipAngle) * Math.PI / 180;
    let slipIntensity = slipAngleRad * 2.0 + Math.abs(forwardVel) * 0.01;

    // Temperature: heats from slip, cools towards ambient
    let ambientTemp = 22;  // °C base (weather could modify this)
    car.tyreTemp += slipIntensity * CFG.TYRE_HEATING_RATE * dt;
    // M2 fix: removed erroneous ×0.01 that made cooling 100× too slow
    car.tyreTemp -= (car.tyreTemp - ambientTemp) * CFG.TYRE_COOLING_RATE * dt;
    car.tyreTemp = clamp(car.tyreTemp, ambientTemp, 160);

    // Wear: proportional to speed² × slip × compound rate
    let speed2 = forwardVel * forwardVel + lateralVel * lateralVel;
    let wearThisFrame = CFG.TYRE_WEAR_RATE * compound.wearRate * slipIntensity * Math.sqrt(speed2) * dt;
    car.tyreWear = clamp(car.tyreWear + wearThisFrame, 0, 1);

    // Grip multiplier from compound + temperature + wear
    // Temperature curve: peak at optimal, falls off in both directions
    let tempDiff = Math.abs(car.tyreTemp - compound.optimalTemp);
    let tempFactor = clamp(1.0 - (tempDiff / compound.tempRange) * 0.3, 0.5, 1.0);

    // Wear effect: linear falloff (0% wear = 100%, 100% wear = 40%)
    let wearFactor = 1.0 - car.tyreWear * 0.6;

    car.tyreGripMult = compound.gripMult * tempFactor * wearFactor;

    // Weather bonus for WET compound in rain
    if (car.tyreCompound === 'WET' && window.rallyWeather) {
        let weatherKey = window.rallyWeather.getWeatherKey();
        if (weatherKey === 'HEAVY_RAIN' || weatherKey === 'LIGHT_RAIN') {
            car.tyreGripMult *= 1.35;  // WET tyres excel in rain
        }
    }
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
        let sx=gp.axes[0]||0; if(Math.abs(sx)<0.18)sx=0;
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

    // Direction vectors
    let fwd = new THREE.Vector3(Math.sin(car.heading), 0, Math.cos(car.heading));
    let right = new THREE.Vector3(Math.cos(car.heading), 0, -Math.sin(car.heading));

    // Decompose velocity
    let forwardVel = car.velocity.dot(fwd);
    let lateralVel = car.velocity.dot(right);

    // Terrain + surface
    let terrain = {z:0, normal:[0,0,1], type:'ROUGH'};
    if(typeof window.localGetTerrainAt==='function')
        terrain = window.localGetTerrainAt(car.position.x, -car.position.z);
    // FAS3-K4: Use degraded surface resolution (includes track wear)
    let terrainSize = window.TERRAIN_SIZE || 900;
    let surface = window.resolveSurfaceDegraded
        ? window.resolveSurfaceDegraded(terrain.type, car.position.x, car.position.z, terrainSize)
        : (window.resolveSurface ? window.resolveSurface(terrain.type) : {grip:0.5,longGrip:0.6,brake:0.65,maxSpeed:0.82,accel:0.78,dragAdd:0.015,driftThreshold:10,driftSustain:1.4,driftRecovery:0.65,rumble:0,depthVariance:0,landing:0.65});
    car.surfaceName = surface.label || terrain.type;
    car.surfaceKey = (window.RALLY_SURFACE_MAP && window.RALLY_SURFACE_MAP[terrain.type]) || terrain.type;
    car.terrainType = terrain.type;

    // Damage modifiers (queried once per frame)
    let dmgMod = window.rallyDamage ? window.rallyDamage.getModifiers() : {steerMult:1,accelMult:1,maxSpeedMult:1};

    // === FAS1-H1: PER-WHEEL SUSPENSION ===
    // Pre-calculate slope pitch/roll for physical alignment on terrain
    if (car.slopePitch === undefined) car.slopePitch = 0;
    if (car.slopeRoll === undefined) car.slopeRoll = 0;
    if (car.onGround) {
        let nx = terrain.normal[0]||0, nz = terrain.normal[1]||0;
        // Negate pitch and roll to correct the orientation sign (so nose points down when going downhill)
        let targetSlopePitch = -(nx*Math.sin(car.heading) + nz*Math.cos(car.heading)) * 0.95;
        let targetSlopeRoll = -(-nx*Math.cos(car.heading) + nz*Math.sin(car.heading)) * 0.95;
        // Smoothly follow terrain slope when on ground
        car.slopePitch = lerp(car.slopePitch, targetSlopePitch, 15 * dt);
        car.slopeRoll = lerp(car.slopeRoll, targetSlopeRoll, 15 * dt);
    } else {
        // Airborne: slowly decay slope pitch and roll towards 0 (gravity alignment)
        car.slopePitch = lerp(car.slopePitch, 0, 2.0 * dt);
        car.slopeRoll = lerp(car.slopeRoll, 0, 2.0 * dt);
    }

    let euler = new THREE.Euler(car.slopePitch, car.heading, car.slopeRoll, 'YXZ');
    let wheelOffsets = [CFG.WHEEL_FL, CFG.WHEEL_FR, CFG.WHEEL_RL, CFG.WHEEL_RR];
    let avgGroundY = 0;
    let allWheelsGround = true;
    let baseLoad = CFG.MASS * CFG.GRAVITY / 4;  // static load per wheel

    for (let i = 0; i < 4; i++) {
        // Transform wheel local position to world position, accounting for pitch & roll
        let lx = wheelOffsets[i][0], lz = wheelOffsets[i][2];
        let ly = CFG.WHEEL_RADIUS - CFG.CAR_HEIGHT; // Actual local rest height of the wheel relative to car center
        let localPos = new THREE.Vector3(lx, ly, lz);
        localPos.applyEuler(euler);

        let wx = car.position.x + localPos.x;
        let wz = car.position.z + localPos.z;
        if (typeof window.localGetTerrainAt === 'function') {
            let wt = window.localGetTerrainAt(wx, -wz);
            car.wheelGroundY[i] = wt.z;
        } else {
            car.wheelGroundY[i] = 0;
        }
        avgGroundY += car.wheelGroundY[i];

        // Spring-damper integration
        let groundTarget = car.wheelGroundY[i] + CFG.WHEEL_RADIUS;
        // FIX-M2: depthVariance — per-surface micro-noise in wheel load
        if (surface.depthVariance > 0 && car.onGround) {
            let speedFactor = clamp(Math.abs(car.speed) / 40, 0, 1);
            let phase = performance.now() * 0.013 + i * 2.3 + car.position.x * 0.7;
            let noise = (Math.sin(phase) * 0.6 + Math.sin(phase * 2.7) * 0.4);
            groundTarget += noise * surface.depthVariance * speedFactor * 0.80;
        }
        
        // Error is the compression displacement from the design ride height
        let error = groundTarget - (car.position.y + localPos.y);

        // Spring force + damping (per-wheel mass = total/4)
        let massPerWheel = CFG.MASS / 4;
        car.suspVel[i] += (error * CFG.SPRING_RATE / massPerWheel - car.suspVel[i] * CFG.DAMPER / massPerWheel) * dt;
        car.suspPos[i] += car.suspVel[i] * dt;
        car.suspPos[i] = clamp(car.suspPos[i], -CFG.SUSPENSION_TRAVEL * 0.3, CFG.SUSPENSION_TRAVEL);

        // Contact force: spring force around static load equilibrium
        car.normalForce[i] = Math.max(0, baseLoad + error * CFG.SPRING_RATE);
        if (car.normalForce[i] < 1) allWheelsGround = false;
    }
    avgGroundY /= 4;

    // === FAS2-H5: ANTI-ROLL BARS ===
    // ARB resists body roll by transferring load between left/right wheels.
    // NOTE: Applied AFTER weight transfer so ARB modifies the final wheelLoad.
    // (Previously applied to normalForce which was partially overwritten by weight transfer.)

    // === FAS1-K1: WEIGHT TRANSFER ===
    // Calculate per-wheel vertical loads based on longitudinal + lateral acceleration
    baseLoad = CFG.MASS * CFG.GRAVITY / 4;  // static load per wheel
    let fwdAccelK1 = (car.speed - car.prevForwardVel) / Math.max(dt, 0.001);
    // Lateral acceleration: v²/R from actual steering geometry
    let latAccelK1 = 0;
    if (car.onGround && Math.abs(input.steer) > 0.01 && Math.abs(forwardVel) > 1) {
        let speedT = clamp(Math.abs(forwardVel) / CFG.MAX_SPEED, 0, 1);
        let steerDegK1 = lerp(CFG.MAX_STEER, CFG.MIN_STEER, speedT);
        let steerRadK1 = steerDegK1 * Math.PI / 180 * Math.abs(input.steer);
        let turnRadiusK1 = CFG.WHEELBASE / Math.tan(steerRadK1 + 0.001);
        latAccelK1 = (forwardVel * forwardVel) / turnRadiusK1 * Math.sign(input.steer);
        // Clamp to realistic lateral g-forces (max ~2g for arcade)
        latAccelK1 = clamp(latAccelK1, -20, 20);
    }

    // Longitudinal transfer: accel → rear load+, front load−
    let longTransfer = CFG.MASS * fwdAccelK1 * CFG.CGH / CFG.WHEELBASE;
    // Lateral transfer: cornering → outer wheels load+, inner load−
    let latTransfer = CFG.MASS * latAccelK1 * CFG.CGH / CFG.TRACK;

    // FL, FR, RL, RR
    car.wheelLoad[0] = baseLoad - longTransfer * 0.5 - latTransfer * 0.5;  // FL
    car.wheelLoad[1] = baseLoad - longTransfer * 0.5 + latTransfer * 0.5;  // FR
    car.wheelLoad[2] = baseLoad + longTransfer * 0.5 - latTransfer * 0.5;  // RL
    car.wheelLoad[3] = baseLoad + longTransfer * 0.5 + latTransfer * 0.5;  // RR

    // Clamp loads (never negative — wheel lifts off)
    for (let i = 0; i < 4; i++) {
        car.wheelLoad[i] = Math.max(0, car.wheelLoad[i]);
        // Blend with suspension normalForce when available
        if (car.normalForce[i] > 0) {
            car.wheelLoad[i] = lerp(car.wheelLoad[i], car.normalForce[i], 0.3);
        }
    }

    // Anti-roll bars: applied to final wheelLoad (after weight transfer)
    {
        // Front ARB: compares FL vs FR suspension compression
        let frontDiff = car.suspPos[0] - car.suspPos[1];  // positive = left more compressed
        let frontArbForce = frontDiff * CFG.ARB_FRONT;
        let maxArbFront = Math.min(car.wheelLoad[0], car.wheelLoad[1]) * 0.4;
        frontArbForce = clamp(frontArbForce, -maxArbFront, maxArbFront);
        car.wheelLoad[0] -= frontArbForce;
        car.wheelLoad[1] += frontArbForce;

        // Rear ARB: compares RL vs RR
        let rearDiff = car.suspPos[2] - car.suspPos[3];
        let rearArbForce = rearDiff * CFG.ARB_REAR;
        let maxArbRear = Math.min(car.wheelLoad[2], car.wheelLoad[3]) * 0.4;
        rearArbForce = clamp(rearArbForce, -maxArbRear, maxArbRear);
        car.wheelLoad[2] -= rearArbForce;
        car.wheelLoad[3] += rearArbForce;
    }

    // Total grip: sum of per-wheel grip forces, normalized to baseline
    let totalLoad = car.wheelLoad[0] + car.wheelLoad[1] + car.wheelLoad[2] + car.wheelLoad[3];
    let baselineLoad = CFG.MASS * CFG.GRAVITY;
    car.totalGrip = clamp(totalLoad / Math.max(baselineLoad, 1), 0.1, 1.5);

    // Smooth surface transition
    car.currentGrip = lerp(car.currentGrip, surface.grip, 4.0*dt);

    // === FAS3-M4: WEATHER GRIP MODIFIER ===
    // Weather modifies surface grip per-surface-type
    let weatherGripMult = 1.0;
    if (window.rallyWeather) {
        window.rallyWeather.update(dt);
        weatherGripMult = window.rallyWeather.getWeatherGrip(car.surfaceKey);
        // Weather also modifies drag
        let weatherDrag = window.rallyWeather.getDragMult();
        if (weatherDrag > 1.0) {
            // Weather drag: scale with 60*dt for framerate-independence
            // getDragMult() returns values like 1.02-1.06, converting:
            // 1/1.06 = 0.943 → pow(0.943, 60*0.0167) = pow(0.943, 1) = 0.943 per 60fps-frame
            // This is intentionally strong — rain should slow you noticeably.
            // Previous: pow(1/drag, dt) gave ~0.1% per frame — barely noticeable.
            let dragFactor = Math.pow(1.0 / weatherDrag, 60 * dt);
            car.velocity.multiplyScalar(dragFactor);
            forwardVel *= dragFactor;
            lateralVel *= dragFactor;
        }
    }

    // === FAS3-H4: TYRE SIMULATION ===
    // Must run before grip factor is used (modifies car.tyreGripMult)
    // M3 fix: pass slipAngle in degrees (consistent with car.slipAngleDeg) and actual lateralVel
    updateTyres(dt, car.speed, lateralVel, car.slipAngleDeg, car.onGround, surface.grip);

    // Apply tyre + weather to totalGrip
    car.totalGrip *= car.tyreGripMult * weatherGripMult;
    car.totalGrip = clamp(car.totalGrip, 0.05, 2.0);

    // === FAS3-H7: SURFACE PARTICLE EMITTER ===
    // Trigger particles from arcade-particle-engine based on surface + speed + slip
    if (car.onGround && Math.abs(car.speed) > 3 && window.arcadeParticles) {
        let particleIntensity = surface.particleIntensity || 0;
        let slipBoost = Math.abs(car.slipAngleDeg) / 30;
        let speedBoost = Math.abs(car.speed) / 50;
        let emitStrength = particleIntensity * (0.3 + slipBoost * 0.5 + speedBoost * 0.2);
        if (emitStrength > 0.15 && surface.particle && surface.particle !== 'none') {
            window.arcadeParticles.emit({
                type: surface.particle,
                position: { x: car.position.x, y: car.position.y - 0.2, z: car.position.z },
                intensity: clamp(emitStrength, 0, 1),
                velocity: { x: -Math.sin(car.heading) * 2, y: 0.5, z: -Math.cos(car.heading) * 2 }
            });
        }
    }

    car.speed = forwardVel;
    // prevForwardVel is saved AFTER speed cap below (C4 fix: avoids false acceleration spikes at cap)

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
    else if(car.isDrifting) targetGrip = CFG.DRIFT_TARGET_GRIP; // Använder konfigurerbar greppfaktor
    else targetGrip = 0.90;
    let gripSpeed = car.isDrifting ? (surface.driftSustain*3.0) : (surface.driftRecovery*5.0);
    car.gripFactor = lerp(car.gripFactor, targetGrip, gripSpeed*dt);

    // === FAS2-H6: CAMBER & TOE EFFECTS ===
    // Camber: negative camber gives lateral grip bonus (tire contact patch optimization)
    let camberGripFront = 1.0 + (-CFG.CAMBER_FRONT) * 0.008;  // -1.5° → +1.2% lat grip
    let camberGripRear = 1.0 + (-CFG.CAMBER_REAR) * 0.008;    // -0.8° → +0.64% lat grip
    // Toe-out front: faster turn-in but less high-speed stability
    let toeSteerMult = 1.0 + CFG.TOE_FRONT * 0.15;  // 0.2° → +3% steer response
    let toeStabilityPenalty = 1.0 - Math.abs(CFG.TOE_FRONT) * 0.05 * clamp(Math.abs(forwardVel) / 40, 0, 1);
    // Rear toe-in: stability. Rear toe-out: rotation
    let rearToeGrip = CFG.TOE_REAR < 0 ? 1.0 : 1.0 - CFG.TOE_REAR * 0.12;  // toe-out rear = less rear grip

    // === FAS1-K2: FRICTION CIRCLE ===
    // Calculate available friction budget from per-wheel loads
    let frictionBudget = surface.grip * car.totalGrip * CFG.MASS * CFG.GRAVITY;

    // === FAS2-H2: GEARBOX & ENGINE ===
    // Calculate RPM from wheel speed → gear ratio → final drive
    {
        let wheelSpeed = Math.max(0, Math.abs(forwardVel));
        let gearRatio = CFG.GEAR_RATIOS[car.gear] || CFG.GEAR_RATIOS[1];
        car.rpm = (wheelSpeed / CFG.WHEEL_CIRCUMFERENCE) * gearRatio * CFG.FINAL_DRIVE * 60;
        car.rpm = clamp(car.rpm, CFG.IDLE_RPM, CFG.MAX_RPM);

        // Handle stillstand: idle RPM with throttle revving
        if (wheelSpeed < 1.0) {
            car.rpm = CFG.IDLE_RPM + input.throttle * (CFG.MAX_RPM * 0.6 - CFG.IDLE_RPM);
        }
        // H4 fix: reverse = idle RPM only (no power through drivetrain)
        if (forwardVel < -0.5) {
            car.rpm = CFG.IDLE_RPM;
        }

        // Auto-shift
        let newGear = autoShift(car.rpm, car.gear, input.throttle);
        if (newGear !== car.gear) {
            car.gear = newGear;
            car.shiftTimer = CFG.SHIFT_TIME;  // brief power cut during shift
        }
        if (car.shiftTimer > 0) car.shiftTimer -= dt;

        // Turbo pressure: builds with throttle + sufficient RPM, decays without
        // M1 fix: turbo requires RPM > 3000 (no boost from idle revving)
        let turboTarget = (input.throttle > 0.5 && car.rpm > 3000) ? 1.0 : 0.0;
        let turboRate = turboTarget > car.turboPressure
            ? (1.0 / CFG.TURBO_LAG)     // spool up
            : (1.0 / (CFG.TURBO_LAG * 0.5));  // spool down faster
        car.turboPressure = lerp(car.turboPressure, turboTarget, turboRate * dt);
    }

    // === ACCELERATION (with H2 engine model) ===
    let longiForce = 0;  // L3: renamed from thrustForce — longitudinal force on car
    if(input.throttle>0 && forwardVel>=0) {
        // H2: Torque from engine curve × gear ratio × turbo
        let rpmNorm = clamp((car.rpm - CFG.IDLE_RPM) / (CFG.MAX_RPM - CFG.IDLE_RPM), 0, 1);
        let torqueFraction = sampleTorqueCurve(rpmNorm);
        let turboMult = 1.0 + (CFG.TURBO_BOOST - 1.0) * car.turboPressure;
        let engineTorque = CFG.ENGINE_POWER * torqueFraction * turboMult;

        // Power cut during gear shift
        if (car.shiftTimer > 0) engineTorque *= 0.05;

        // Gear multiplication
        let gearRatio = CFG.GEAR_RATIOS[car.gear] || CFG.GEAR_RATIOS[1];
        let wheelForce = engineTorque * gearRatio * CFG.FINAL_DRIVE / CFG.WHEEL_RADIUS;

        // Speed-based power falloff (prevents infinite acceleration)
        let speedRatio = clamp(forwardVel/CFG.MAX_SPEED, 0, 1);
        wheelForce *= (1.0 - speedRatio * speedRatio);
        wheelForce *= input.throttle * surface.accel * dmgMod.accelMult;

        // === FAS2-K3: DIFFERENTIAL (LSD) ===
        // Open diff sends torque to wheel with least resistance (spinning wheel)
        // LSD: locks wheels together, transferring torque to loaded wheel
        {
            let driveLoadInner, driveLoadOuter;
            // Determine inside/outside wheels based on steering
            if (input.steer > 0.05) {
                // Turning left: FL=inner, FR=outer, RL=inner, RR=outer
                driveLoadInner = (car.wheelLoad[0] + car.wheelLoad[2]) * 0.5;
                driveLoadOuter = (car.wheelLoad[1] + car.wheelLoad[3]) * 0.5;
            } else if (input.steer < -0.05) {
                driveLoadInner = (car.wheelLoad[1] + car.wheelLoad[3]) * 0.5;
                driveLoadOuter = (car.wheelLoad[0] + car.wheelLoad[2]) * 0.5;
            } else {
                driveLoadInner = driveLoadOuter = (totalLoad * 0.5);
            }

            // Lock ratio: how much torque goes to loaded wheel
            let lockRatio = input.throttle > 0.1 ? CFG.DIFF_DRIVE_LOCK : CFG.DIFF_BRAKE_LOCK;
            car.diffLockState = lerp(car.diffLockState, lockRatio, 5.0 * dt);

            // Open diff efficiency: inner/outer load ratio (1.0 = equal, <1 = inner lighter)
            let loadRatio = driveLoadInner / Math.max(driveLoadOuter, 1);
            // Open diff wastes force proportional to load imbalance
            let openDiffLoss = 1.0 - (1.0 - loadRatio) * 0.5;  // open diff loses up to 50%
            // LSD recovers that loss
            let diffEfficiency = lerp(openDiffLoss, 1.0, car.diffLockState);
            // Preload: minimum lock at low torque (clamped to max 0.3 = 30% lock)
            let preloadLock = clamp(CFG.DIFF_PRELOAD / Math.max(Math.abs(wheelForce), 1), 0, 0.3);
            diffEfficiency = Math.max(diffEfficiency, preloadLock);

            wheelForce *= diffEfficiency;
        }

        // FIX-M3: TORQUE_BIAS — axle-specific traction limit
        // FWD (TORQUE_BIAS=0): limited by front axle load → understeer under power
        // RWD (TORQUE_BIAS=1): limited by rear axle load → oversteer under power
        // 4WD (TORQUE_BIAS=0.5): uses total load → balanced
        let rearBias = CFG.TORQUE_BIAS;       // 0=FWD, 0.5=4WD, 1.0=RWD
        let frontBias = 1.0 - rearBias;
        let frontAxleLoad = car.wheelLoad[0] + car.wheelLoad[1];
        let rearAxleLoad = car.wheelLoad[2] + car.wheelLoad[3];
        let drivenAxleLoad = (frontBias > 0 && rearBias > 0) ? (frontAxleLoad + rearAxleLoad) : (frontAxleLoad * frontBias + rearAxleLoad * rearBias);
        let normalY = car.onGround ? ((terrain.normal && terrain.normal[2] !== undefined) ? terrain.normal[2] : 1.0) : 0.0;
        // M5 fix: use longGrip for traction (longitudinal grip vs lateral grip)
        let maxTractionForce = drivenAxleLoad * (surface.longGrip || surface.grip) * normalY * CFG.TRACTION_MULT;
        wheelForce = Math.min(wheelForce, maxTractionForce);

        let accel = wheelForce / CFG.MASS;
        longiForce = wheelForce;
        car.velocity.addScaledVector(fwd, accel*dt);
    } else if(input.throttle>0 && forwardVel<0) {
        // Throttle while reversing = brake
        car.velocity.addScaledVector(fwd, (CFG.BRAKE_FORCE/CFG.MASS) * 2.0 * dt);
    }
    // Reverse — aktiveras när bilen är nästan stillastående (forwardVel ≤0.1 m/s)
    if(input.brake>0 && forwardVel<=0.1) {
        let accel = (CFG.ENGINE_POWER/CFG.MASS)*0.4*input.brake*surface.accel;
        
        // FIX-M3: TORQUE_BIAS for reverse traction
        let normalY = car.onGround ? ((terrain.normal && terrain.normal[2] !== undefined) ? terrain.normal[2] : 1.0) : 0.0;
        let rearBiasRev = CFG.TORQUE_BIAS;
        let frontBiasRev = 1.0 - rearBiasRev;
        let frontAxleRev = car.wheelLoad[0] + car.wheelLoad[1];
        let rearAxleRev = car.wheelLoad[2] + car.wheelLoad[3];
        let drivenLoadRev = (frontBiasRev > 0 && rearBiasRev > 0) ? (frontAxleRev + rearAxleRev) : (frontAxleRev * frontBiasRev + rearAxleRev * rearBiasRev);
        let maxTractionAccel = drivenLoadRev / CFG.MASS * surface.grip * normalY * CFG.TRACTION_MULT;
        accel = Math.min(accel, maxTractionAccel);
        
        car.velocity.addScaledVector(fwd, -accel*dt);
    }
    // === FAS1-H3: BRAKE BIAS ===
    // Split braking force front/rear. More rear bias = easier oversteer under braking.
    // Handbrake locks rear wheels only.
    if(input.brake>0 && forwardVel>0.1) {
        // M5 fix: braking uses longGrip for longitudinal grip
        let totalBrakeForce = CFG.BRAKE_FORCE * input.brake * surface.brake * (surface.longGrip || surface.grip);
        let frontBrake = totalBrakeForce * CFG.BRAKE_BIAS;
        let rearBrake = totalBrakeForce * (1 - CFG.BRAKE_BIAS);
        // H3: Handbrake adds massive rear brake (locks rear wheels)
        if (input.handbrake) {
            rearBrake = Math.max(rearBrake, CFG.BRAKE_FORCE * 0.8);
        }
        // K1: Scale brake effectiveness by axle load distribution
        let frontLoadRatio = (car.wheelLoad[0] + car.wheelLoad[1]) / Math.max(totalLoad, 1);
        let rearLoadRatio = (car.wheelLoad[2] + car.wheelLoad[3]) / Math.max(totalLoad, 1);
        let effectiveBrakeAccel = (frontBrake * frontLoadRatio + rearBrake * rearLoadRatio) / CFG.MASS;
        let newFwd = forwardVel - effectiveBrakeAccel * dt;
        if(newFwd<0) newFwd=0;
        car.velocity.addScaledVector(fwd, (newFwd-forwardVel));
        longiForce = Math.max(longiForce, effectiveBrakeAccel * CFG.MASS);
    }

    // K2: Apply friction circle — if combined lat+long exceeds budget, scale both down
    {
        let latForce = Math.abs(lateralVel) * surface.grip * totalLoad;
        let longForce = Math.abs(longiForce);
        let combined = Math.sqrt(latForce * latForce + longForce * longForce);
        if (combined > frictionBudget && combined > 0) {
            car.frictionScale = frictionBudget / combined;
        } else {
            car.frictionScale = 1.0;
        }
    }

    // === SLOPE GRAVITY (mountain physics) ===
    // terrain.normal = [slope_x, slope_z, vertical] where vertical≈1 for flat ground
    // Format from localGetTerrainAt(): [-ndx/len, -ndz/len, 1/len] (central difference)
    // M6: This is a first-order approximation: g_slope ≈ g × sin(θ) ≈ g × nx/nz
    //     Exact would be: g × (N × (N × G)) / |N|² but the error is <2% for slopes <30°
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
    // LANDING FIX: Only apply lateral grip correction when on the ground.
    // Airborne: the car has no tyre contact so there is no lateral grip to correct.
    // Applying it airborne was eating horizontal speed the moment the car touched down.
    if (car.onGround) {
        // K2: frictionScale reduces lateral grip when longitudinal force is high
        // H6: camber improves lateral grip — applied per-axle for asymmetric setups
        let frontCamberGrip = camberGripFront;
        let rearCamberGrip = camberGripRear * rearToeGrip;
        let frontLoadFrac = (car.wheelLoad[0] + car.wheelLoad[1]) / Math.max(totalLoad, 1);
        let rearLoadFrac = 1.0 - frontLoadFrac;
        let weightedCamberGrip = frontCamberGrip * frontLoadFrac + rearCamberGrip * rearLoadFrac;
        let effectiveGripFactor = car.gripFactor * car.frictionScale * weightedCamberGrip;
        // FIX-M3: TORQUE_BIAS lateral effect
        if (input.throttle > 0.1) {
            let powerSaturation = input.throttle * clamp(Math.abs(forwardVel) / 30, 0, 1) * 0.15;
            let rearLoss = powerSaturation * CFG.TORQUE_BIAS;
            let frontLoss = powerSaturation * (1.0 - CFG.TORQUE_BIAS);
            effectiveGripFactor *= (1.0 - rearLoss);
            car._frontLossThisFrame = frontLoss;
        } else {
            car._frontLossThisFrame = 0;
        }
        let lateralRetain = Math.pow(1-effectiveGripFactor, 60*dt);
        car.velocity.addScaledVector(right, lateralVel*(lateralRetain-1));
    } else {
        car._frontLossThisFrame = 0;
    }

    // Handbrake extra drag
    let dragMult = CFG.DRAG * (1.0 - surface.dragAdd);
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
    // C4 fix: save post-cap forward velocity for weight transfer (next frame)
    car.prevForwardVel = car.velocity.dot(fwd);
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
    let postDragFwd = car.velocity.dot(fwd);
    if(car.onGround && Math.abs(postDragFwd)>0.3 && Math.abs(input.steer)>0.01) {
        let speedT = clamp(Math.abs(postDragFwd)/CFG.MAX_SPEED, 0, 1);
        let steerDeg = lerp(CFG.MAX_STEER, CFG.MIN_STEER, speedT);
        steerDeg *= dmgMod.steerMult;
        if(car.isDrifting) steerDeg *= CFG.DRIFT_STEER_BONUS;
        // C6 fix: FWD understeer — driven front axle loses steering under power
        if (car._frontLossThisFrame > 0.01) {
            steerDeg *= (1.0 - car._frontLossThisFrame * 0.8);
        }
        // H6: Toe-out increases initial steer response, stability penalty at high speed
        steerDeg *= toeSteerMult * toeStabilityPenalty;
        let steerRad = steerDeg * Math.PI/180 * Math.abs(input.steer);
        let turnRadius = CFG.WHEELBASE / Math.tan(steerRad + 0.001);
        let angularVel = postDragFwd / turnRadius;
        let yaw = angularVel * Math.sign(input.steer) * dt;
        car.heading += yaw;
    }

    // === VISUAL STEERING INTERPOLATION ===
    {
        let targetVisualSteer = 0;
        if (Math.abs(input.steer) > 0.01) {
            let speedT = clamp(Math.abs(car.speed) / CFG.MAX_SPEED, 0, 1);
            let steerDeg = lerp(CFG.MAX_STEER, CFG.MIN_STEER, speedT);
            steerDeg *= dmgMod.steerMult;
            if (car.isDrifting) steerDeg *= CFG.DRIFT_STEER_BONUS;
            steerDeg *= toeSteerMult * toeStabilityPenalty;
            targetVisualSteer = input.steer * (steerDeg * Math.PI / 180);
        }
        if (car.visualSteer === undefined) car.visualSteer = 0;
        car.visualSteer = lerp(car.visualSteer, targetVisualSteer, 15 * dt);
    }

    // === POSITION UPDATE ===
    car.position.x += car.velocity.x * dt;
    car.position.z += car.velocity.z * dt;

    // === TERRAIN FOLLOWING ===
    let groundY = terrain.z;
    if (!car._landingGrace) car._landingGrace = 0;
    if (car._landingGrace > 0) car._landingGrace -= dt;

    // While in landing grace period, treat as grounded even if position is slightly above ground
    let airborneThresh = 0.05 + clamp(Math.abs(car.speed) * 0.005, 0, 0.20);
    let isAirborne = car.position.y > groundY + CFG.CAR_HEIGHT + airborneThresh
                     && car._landingGrace <= 0;

    if (isAirborne) {
        car.onGround = false;
        car.velocity.y -= CFG.GRAVITY * CFG.GRAVITY_AIR_MULT * dt;
        car.velocity.y = Math.max(car.velocity.y, -50); // terminal velocity cap
        car.position.y += car.velocity.y * dt;
        // Air control
        if(Math.abs(input.steer)>0.1)
            car.heading += input.steer * CFG.AIR_CONTROL * dt;
        if(car.position.y <= groundY + CFG.CAR_HEIGHT) {
            // === LANDING ===
            car.position.y = groundY + CFG.CAR_HEIGHT;
            let landingImpact = -car.velocity.y; // positive = hard impact
            // Kill vertical velocity completely — no bounce.
            // The bounce felt wrong: car came in at 100km/h, vertical component got
            // reflected upward making the whole car trajectory arc back into the air.
            car.velocity.y = 0;
            // Camera shake proportional to impact
            if (landingImpact > 4 && window.rallyCamera) {
                window.rallyCamera.triggerShake(landingImpact * 0.5);
            }
            // Damage from very hard landing
            if (window.rallyDamage && landingImpact > 8) {
                window.rallyDamage.applyDamage(landingImpact);
            }
            car.onGround = true;
            // Landing grace: prevents re-triggering airborne for 0.15s after touch-down
            // so the dynamic threshold doesn't immediately kick car back into the air
            // on steep downhill landings where the ground falls away quickly.
            car._landingGrace = 0.15;
        }
    } else {
        car.onGround = true;
        car.velocity.y = 0;
        // Tight terrain following: 85% snap per frame at 60fps eliminates downhill float
        let followRate = 1 - Math.pow(0.15, dt * 60);
        car.position.y += (groundY + CFG.CAR_HEIGHT - car.position.y) * followRate;
    }

    // World bounds
    let half = (window.TERRAIN_SIZE||900)/2-5;
    car.position.x = clamp(car.position.x, -half, half);
    car.position.z = clamp(car.position.z, -half, half);

    // FAS0-M1: Paint tire tracks into terrain shader B-channel
    if (car.onGround && Math.abs(car.speed) > 2 && window.terrainShaderGeo && window._terrainGeo) {
        let trkIntensity = Math.min(1, Math.abs(car.slipAngleDeg) / 20);  // stronger tracks during drift
        if (car.isDrifting) trkIntensity = Math.max(trkIntensity, 0.6);    // minimum during active drift
        if (trkIntensity > 0.05) {
            window.terrainShaderGeo.paintTireTrack(
                car.position.x, car.position.z,
                trkIntensity,
                window._terrainGeo,
                window.TERRAIN_SIZE || 900
            );
        }
    }

    // FAS3-K4: Write track degradation (progressive surface wear)
    if (car.onGround && Math.abs(car.speed) > 1 && window.rallyTrackDegrade) {
        let degradeIntensity = 0.00005 * Math.abs(car.speed) + Math.abs(car.slipAngleDeg) * 0.0001;
        window.rallyTrackDegrade.degrade(car.position.x, car.position.z, degradeIntensity, terrainSize);
    }

    // FAS0-M2: Surface rumble → camera micro-shake
    if (car.onGround && window.rallyCamera && surface.rumble > 0) {
        let rumbleStr = clamp(surface.rumble * Math.abs(car.speed) / 60, 0, 0.5);
        window.rallyCamera.setRumble(rumbleStr);
    } else if (window.rallyCamera) {
        window.rallyCamera.setRumble(0);
    }

    // === VISUAL SUSPENSION (time-normalized lerps) ===
    // L5: prevLateralVel is used ONLY here for visual roll — saved immediately after use.
    // The frame-to-frame delta gives lateral jerk for body roll animation.
    let latAccel = (lateralVel - car.prevLateralVel) / Math.max(dt,0.001);
    car.prevLateralVel = lateralVel;
    // SPELKÄNSLA: Öka roll/krängning markant vid styrning så bilen lutar utåt i svängen (centrifugalkraft)
    let rollAssist = -input.steer * 4.0; 
    let tgtRoll = clamp(latAccel*CFG.ROLL_SENS + rollAssist, -15, 15);

    // FAS1-H1: Blend suspension-derived roll into visual roll
    // Suspension roll = difference between left and right suspension compression
    let suspRollFront = (car.suspPos[1] - car.suspPos[0]) / CFG.TRACK * 30;  // degrees, scaled
    let suspRollRear = (car.suspPos[3] - car.suspPos[2]) / CFG.TRACK * 30;
    let suspRoll = (suspRollFront + suspRollRear) * 0.5;
    tgtRoll = tgtRoll * 0.6 + suspRoll * 0.4;  // blend 60% accel-based, 40% suspension-based

    let rollRate = 1 - Math.pow(1 - 0.2, dt * 60);
    car.visualRoll = lerp(car.visualRoll, tgtRoll, rollRate);

    let fwdAccel = (forwardVel - car.prevForwardVel) / Math.max(dt,0.001);
    // SPELKÄNSLA: Öka pitch mjukt vid gas/broms så nosen lyfts/dyker
    let pitchAssist = 0;
    if(input.throttle > 0) pitchAssist = -1.2; // W = Nosen upp
    if(input.brake > 0) pitchAssist = 2.0;    // S = Nosen ner

    // FAS1-H1: Blend suspension-derived pitch
    let suspPitchFront = (car.suspPos[0] + car.suspPos[1]) * 0.5;
    let suspPitchRear = (car.suspPos[2] + car.suspPos[3]) * 0.5;
    let suspPitch = (suspPitchFront - suspPitchRear) / CFG.WHEELBASE * 25;  // degrees

    let tgtPitch = clamp(-fwdAccel*CFG.PITCH_SENS + pitchAssist, -4, 4);
    tgtPitch = tgtPitch * 0.6 + suspPitch * 0.4;  // blend 60% accel-based, 40% suspension-based

    let pitchRate = 1 - Math.pow(1 - 0.2, dt * 60);
    car.visualPitch = lerp(car.visualPitch, tgtPitch, pitchRate);

    // Terrain slope (already computed at the top for suspension physics)

    // === VISUAL POSITION WITH SUSPENSION COMPRESSION ===
    let visualPos = car.position.clone();
    if (car.onGround) {
        let avgSusp = (car.suspPos[0] + car.suspPos[1] + car.suspPos[2] + car.suspPos[3]) / 4;
        visualPos.y -= avgSusp;
    }

    // Skip mesh rotation if volting (damage system controls rotation)
    if (window.rallyDamage && window.rallyDamage.isVolting()) {
        car.mesh.position.copy(visualPos);
        car.mesh.rotation.order = "YXZ"; // Viktigt för Pitch/Roll
        // Volt handles rotation — only set Y (heading)
        car.mesh.rotation.y = car.heading;
        if (car.mesh.userData.bodyGroup) {
            car.mesh.userData.bodyGroup.rotation.set(0, 0, 0);
        }
    } else if (window.rallyDamage && window.rallyDamage.isFlipped()) {
        car.mesh.position.copy(visualPos);
        car.mesh.rotation.order = "YXZ"; // Viktigt för Pitch/Roll
        car.mesh.rotation.y = car.heading; // Keep heading updated during flip
        if (car.mesh.userData.bodyGroup) {
            car.mesh.userData.bodyGroup.rotation.set(0, 0, 0);
        }
        // Flip recovery handles x/z rotation
    } else {
        // Normal mesh update
        car.mesh.position.copy(visualPos);
        car.mesh.rotation.order = "YXZ";
        car.mesh.rotation.y = car.heading;
        car.mesh.rotation.x = car.slopePitch;
        car.mesh.rotation.z = car.slopeRoll;
        
        // Visual tilt is isolated to bodyGroup so wheels stay on the ground
        if (car.mesh.userData.bodyGroup) {
            car.mesh.userData.bodyGroup.rotation.x = car.visualPitch * Math.PI / 180;
            car.mesh.userData.bodyGroup.rotation.z = car.visualRoll * Math.PI / 180;
        }
    }

    // Wheel spin + steer + FAS1-H1: per-wheel suspension Y offset
    let wheelRotSpeed = car.speed / 0.35; // radie
    car.wheels.forEach((w, i) => {
        // w.spin hanterar däckens snurr runt X-axeln
        w.spin.rotation.x += wheelRotSpeed * dt;
        // w.steer hanterar hjulens svängning runt Y-axeln
        w.steer.rotation.y = 0; // reset
        if(i<2) w.steer.rotation.y = car.visualSteer || 0;
        // H1: Move each wheel mesh vertically based on its suspension compression
        w.steer.position.y = car.suspPos[i];
    });
    
    // Update wheel spray/particles
    if (window.arcadeParticles) window.arcadeParticles.update(dt);
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
            <div style="text-align:center;min-width:65px;position:relative;">
                <div id="rally-speed" style="font-size:32px;font-weight:900;color:#4ade80;letter-spacing:-1px;line-height:1">0</div>
                <div style="font-size:9px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-top:1px">km/h</div>
                <!-- Gear Box (Mobile) -->
                <div style="position:absolute;top:-4px;right:-8px;background:#1e293b;border:1px solid #38bdf8;border-radius:4px;padding:1px 4px;font-size:10px;font-weight:900;color:#38bdf8;line-height:1">
                    G:<span id="rally-gear">1</span>
                </div>
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
            <!-- Dummy elements to prevent JS errors on mobile -->
            <div id="rally-tyre-info" style="display:none"></div>
            <div id="rally-weather" style="display:none"></div>
            <div id="rally-rpm-fill" style="display:none"></div>
            <div id="rally-rpm-val" style="display:none"></div>
            <div id="rally-drift-badge" style="font-size:10px;font-weight:900;color:#f97316;opacity:0;transition:opacity 0.2s;position:absolute;bottom:-18px;left:50%;transform:translateX(-50%)">🔥 DRIFT</div>
        </div>`;
    } else {
        innerHTML = `
        <div style="background:rgba(15,23,42,0.92);border:1px solid #334155;border-radius:16px;padding:16px 24px;backdrop-filter:blur(12px);min-width:200px;text-align:center;position:relative;box-shadow:0 12px 40px rgba(0,0,0,0.4)">
            
            <!-- Speed & Gear Row -->
            <div style="display:flex;justify-content:center;align-items:center;gap:16px;margin-bottom:6px;">
                <div style="text-align:left;">
                    <div id="rally-speed" style="font-size:52px;font-weight:900;color:#38bdf8;letter-spacing:-2px;line-height:1;margin:0">0</div>
                    <div style="font-size:10px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:2px;margin-top:2px">km/h</div>
                </div>
                
                <!-- Gear Box -->
                <div style="background:#1e293b;border:2px solid #38bdf8;border-radius:10px;padding:6px 12px;min-width:46px;text-align:center;">
                    <div style="font-size:8px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">GEAR</div>
                    <div id="rally-gear" style="font-size:24px;font-weight:900;color:#38bdf8;line-height:1">1</div>
                </div>
            </div>

            <!-- RPM Gauge Bar -->
            <div style="margin:8px 0 10px 0;text-align:left;">
                <div style="display:flex;justify-content:space-between;font-size:8px;color:#64748b;font-weight:bold;text-transform:uppercase;margin-bottom:3px">
                    <span>RPM</span>
                    <span id="rally-rpm-val" style="color:#60a5fa;font-family:monospace">0 RPM</span>
                </div>
                <div style="background:#1e293b;border-radius:3px;height:6px;overflow:hidden;border:1px solid #334155;position:relative;">
                    <div id="rally-rpm-fill" style="height:100%;width:0%;background:#60a5fa;border-radius:3px;transition:width 0.05s;"></div>
                </div>
            </div>

            <!-- Tyre Info Container -->
            <div id="rally-tyre-info" style="font-size:9px;font-weight:bold;margin:6px 0;display:flex;justify-content:center;gap:6px;align-items:center;">
            </div>

            <!-- Weather Indicator -->
            <div id="rally-weather" style="font-size:10px;font-weight:bold;color:#94a3b8;margin:4px 0;display:none;">
            </div>

            <div style="height:1px;background:#334155;margin:10px 0"></div>
            <div style="display:flex;justify-content:space-between;align-items:center">
                <div>
                    <div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Surface</div>
                    <div id="rally-surface" style="font-size:12px;color:#4ade80;font-weight:bold">DIRT</div>
                </div>
                <div>
                    <div style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:bold">Grip</div>
                    <div id="rally-grip" style="font-size:12px;color:#fbbf24;font-weight:bold">50%</div>
                </div>
            </div>
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
        dt2=document.getElementById('rally-damage-text'),
        gearEl=document.getElementById('rally-gear'),
        rpmFill=document.getElementById('rally-rpm-fill'),
        rpmVal=document.getElementById('rally-rpm-val'),
        tyreEl=document.getElementById('rally-tyre-info'),
        weatherEl=document.getElementById('rally-weather');

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
    
    if (gearEl) {
        gearEl.textContent = car.gear;
    }
    
    if (rpmFill) {
        let rpmPct = clamp((car.rpm - CFG.IDLE_RPM) / (CFG.MAX_RPM - CFG.IDLE_RPM) * 100, 0, 100);
        rpmFill.style.width = rpmPct + '%';
        rpmFill.style.background = rpmPct > 85 ? '#ef4444' : rpmPct > 65 ? '#fbbf24' : '#60a5fa';
    }
    if (rpmVal) {
        rpmVal.textContent = Math.round(car.rpm) + ' RPM';
        rpmVal.style.color = car.rpm > CFG.MAX_RPM * 0.85 ? '#ef4444' : car.rpm > CFG.MAX_RPM * 0.65 ? '#fbbf24' : '#60a5fa';
    }
    
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

    // FAS3-H4: Tyre compound / wear / temp display
    if (tyreEl) {
        let compound = TYRE_COMPOUNDS[car.tyreCompound] || TYRE_COMPOUNDS.SOFT;
        let wearPct = Math.round(car.tyreWear * 100);
        let tempC = Math.round(car.tyreTemp);
        let tempCol = tempC > CFG.TYRE_OVERHEAT_TEMP ? '#ef4444' : tempC > CFG.TYRE_OPTIMAL_TEMP ? '#fbbf24' : tempC > CFG.TYRE_COLD_TEMP ? '#4ade80' : '#60a5fa';
        let wearCol = wearPct > 70 ? '#ef4444' : wearPct > 40 ? '#fbbf24' : '#4ade80';
        tyreEl.innerHTML = `<span style="color:${compound.color}">${compound.label}</span> <span style="color:${wearCol}">W:${wearPct}%</span> <span style="color:${tempCol}">${tempC}°C</span>`;
    }

    // FAS3-M4: Weather indicator
    if (weatherEl && window.rallyWeather) {
        let w = window.rallyWeather.getCurrentWeather();
        if (w && w.label !== 'DRY') {
            weatherEl.textContent = w.icon + ' ' + w.label;
            weatherEl.style.display = 'block';
        } else {
            weatherEl.style.display = 'none';
        }
    }
}

window.setCarHeadlights = function(on) {
    if (typeof car === 'undefined' || !car) return;
    car.headlightsOn = on;
    if (!car.mesh) return;
    let headlights = car.mesh.userData.headlights;
    let meshes = car.mesh.userData.headlightMeshes;
    if (headlights) {
        headlights.forEach(l => {
            l.intensity = on ? 15.0 : 0.0;
        });
    }
    if (meshes) {
        meshes.forEach(m => {
            m.material.emissive.setHex(on ? 0xfffee0 : 0x000000);
        });
    }
};

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
        car.slopeRoll=0; car.slopePitch=0;
        car.prevLateralVel=0; car.prevForwardVel=0;
        car.displaySpeed=0; car.terrainType='ROUGH';
        car.surfaceKey='DIRT'; car.surfaceName='DIRT';
        // FAS3-H4: Reset tyre state
        car.tyreWear = 0; car.tyreTemp = 60; car.tyreGripMult = 1.0;
        car.tyreCompound = CFG.TYRE_COMPOUND || 'SOFT';
        // FAS2-H2: Reset gearbox
        car.rpm = CFG.IDLE_RPM; car.gear = 1;
        car.turboPressure = 0; car.shiftTimer = 0;
        // FAS3-M3: Apply car profile if set
        if (window.rallyCarProfiles && window._selectedProfile) {
            window.rallyCarProfiles.applyProfile(window._selectedProfile, CFG);
        }
        // FAS3-K4: Reset track degradation
        if (window.rallyTrackDegrade) window.rallyTrackDegrade.init();
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
        
        // Clean up wheel particles
        if (window.arcadeParticles && window.arcadeParticles.cleanup) {
            window.arcadeParticles.cleanup(scene);
        }
        
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
    getInput:()=>input,
    CFG: CFG,
    TYRE_COMPOUNDS: TYRE_COMPOUNDS,
    setCompound: function(compound) {
        if (TYRE_COMPOUNDS[compound]) {
            car.tyreCompound = compound;
            car.tyreWear = 0;
            car.tyreTemp = 60;
            console.log(`🔧 Tyre compound → ${compound}`);
        }
    },
    applyProfile: function(profileKey) {
        if (window.rallyCarProfiles) {
            window.rallyCarProfiles.applyProfile(profileKey, CFG);
            window._selectedProfile = profileKey;
            // Live body color swap
            if (car.mesh && car.mesh.userData.bodyMat && CAR_PROFILE_COLORS[profileKey]) {
                car.mesh.userData.bodyMat.color.setHex(CAR_PROFILE_COLORS[profileKey]);
            }
        }
    }
};

// === ARCADE PARTICLES IMPLEMENTATION ===
// High-performance CPU-managed particle pool for tire smoke, gravel spray, mud, etc.
(function() {
    let maxParticles = 400;
    let particles = [];
    let activeCount = 0;
    let particlesInit = false;
    
    // Geometry & Material
    let geometry = null;
    let material = null;
    let points = null;
    let positions = null;
    let colors = null;
    let sizes = null;
    let texture = null;
    
    function createTexture() {
        let canvas = document.createElement('canvas');
        canvas.width = 16; canvas.height = 16;
        let ctx = canvas.getContext('2d');
        let grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
        grad.addColorStop(0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.3, 'rgba(255,255,255,0.8)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 16, 16);
        return new THREE.CanvasTexture(canvas);
    }
    
    function initSystem() {
        if (particlesInit || !window.scene) return;
        
        positions = new Float32Array(maxParticles * 3);
        colors = new Float32Array(maxParticles * 3);
        sizes = new Float32Array(maxParticles);
        
        // Populate pool
        for (let i = 0; i < maxParticles; i++) {
            particles.push({
                active: false,
                pos: new THREE.Vector3(),
                vel: new THREE.Vector3(),
                color: new THREE.Color(),
                size: 1.0,
                life: 0,
                maxLife: 1.0,
                gravity: 10.0
            });
            positions[i*3] = positions[i*3+1] = positions[i*3+2] = 99999; // Offscreen
        }
        
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
        
        texture = createTexture();
        material = new THREE.PointsMaterial({
            size: 2.5,
            map: texture,
            vertexColors: true,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            blending: THREE.NormalBlending
        });
        
        points = new THREE.Points(geometry, material);
        points.frustumCulled = false;
        window.scene.add(points);
        particlesInit = true;
    }
    
    // Type definitions with specific color ranges
    const TYPES = {
        gravel_spray: {
            colors: [0xd97706, 0xb45309, 0x8b5a2b, 0xcd853f, 0xa0522d],
            size: [1.8, 3.5], life: [0.6, 1.2], gravity: 3.0
        },
        mud_heavy: {
            colors: [0x3d2314, 0x5c3a21, 0x26140a, 0x4a2f1b],
            size: [2.2, 4.0], life: [0.7, 1.3], gravity: 4.0
        },
        rubber_smoke: {
            colors: [0xe2e8f0, 0xcbd5e1, 0x94a3b8],
            size: [2.5, 5.0], life: [0.6, 1.2], gravity: -1.5 // Smoke rises!
        },
        snow_spray: {
            colors: [0xffffff, 0xf1f5f9, 0xe2e8f0],
            size: [1.8, 3.2], life: [0.5, 1.0], gravity: 1.5
        },
        stone_dust: {
            colors: [0x94a3b8, 0x64748b, 0x475569],
            size: [2.0, 3.8], life: [0.5, 1.0], gravity: 1.8
        },
        water_spray: {
            colors: [0xe0f2fe, 0xbae6fd, 0x7dd3fc],
            size: [2.0, 3.8], life: [0.4, 0.9], gravity: 2.2
        },
        dust_cloud: {
            colors: [0xf59e0b, 0xd97706, 0xb45309],
            size: [2.0, 4.5], life: [0.6, 1.2], gravity: -0.5 // Sand hangs in air
        },
        grass_spray: {
            colors: [0x22c55e, 0x16a34a, 0x4ade80, 0x15803d, 0x86efac],
            size: [1.2, 2.8], life: [0.4, 0.9], gravity: 2.5
        },
        ice_crystals: {
            colors: [0xbfdbfe, 0xdbeafe, 0xeff6ff],
            size: [1.0, 2.0], life: [0.3, 0.7], gravity: 1.0
        }
    };
    
    function emitParticle(typeKey, px, py, pz, vx, vy, vz, strength) {
        if (!particlesInit) initSystem();
        if (!geometry) return;
        
        // Find inactive particle
        let p = null;
        for (let i = 0; i < maxParticles; i++) {
            let idx = (i + activeCount) % maxParticles;
            if (!particles[idx].active) {
                p = particles[idx];
                break;
            }
        }
        if (!p) return; // Pool full
        
        let type = TYPES[typeKey] || TYPES.gravel_spray;
        p.active = true;
        p.pos.set(px, py, pz);
        // Random velocity spread with strong upward arc
        p.vel.set(
            vx + (Math.random() - 0.5) * 4.0 * strength,
            vy + Math.random() * 4.0 * strength, // Upward velocity boost
            vz + (Math.random() - 0.5) * 4.0 * strength
        );
        p.gravity = type.gravity;
        
        let hex = type.colors[Math.floor(Math.random() * type.colors.length)];
        p.color.setHex(hex);
        
        p.size = type.size[0] + Math.random() * (type.size[1] - type.size[0]);
        p.life = type.life[0] + Math.random() * (type.life[1] - type.life[0]);
        p.maxLife = p.life;
        
        activeCount++;
    }
    
    window.arcadeParticles = {
        emit: function(opts) {
            if (!particlesInit) initSystem();
            if (!geometry) return;
            
            // Check if car is drifting/sliding to emit from rear wheels specifically
            let count = Math.max(1, Math.round(5 * opts.intensity));
            
            // If the car object is available, let's emit directly from rear tires!
            let carObj = window.rallyVehicle ? window.rallyVehicle.getCar() : null;
            if (carObj && carObj.position && carObj.active) {
                let cosH = Math.cos(carObj.heading), sinH = Math.sin(carObj.heading);
                // Rear wheels local offsets: [-1.0, 0, -1.3] and [1.0, 0, -1.3]
                let offsets = [
                    [-0.95, -1.3], // Rear Left
                    [0.95, -1.3]   // Rear Right
                ];
                
                for (let c = 0; c < count; c++) {
                    offsets.forEach(off => {
                        let lx = off[0], lz = off[1];
                        // Transform to world coordinates
                        let wx = carObj.position.x + lx * cosH + lz * sinH;
                        let wz = carObj.position.z - lx * sinH + lz * cosH;
                        // Sample terrain height at tire location (raised to 0.18 to prevent clipping into road decal)
                        let wy = carObj.position.y - 0.7 + 0.18; 
                        
                        emitParticle(
                            opts.type,
                            wx, wy, wz,
                            opts.velocity.x * 0.8,
                            opts.velocity.y * 1.5,
                            opts.velocity.z * 0.8,
                            opts.intensity
                        );
                    });
                }
            } else {
                // Fallback to center position
                for (let c = 0; c < count; c++) {
                    emitParticle(
                        opts.type,
                        opts.position.x, opts.position.y, opts.position.z,
                        opts.velocity.x, opts.velocity.y, opts.velocity.z,
                        opts.intensity
                    );
                }
            }
        },
        
        update: function(dt) {
            if (!geometry || !points || !particlesInit) return;
            
            let posAttr = geometry.attributes.position.array;
            let colAttr = geometry.attributes.color.array;
            let sizeAttr = geometry.attributes.size.array;
            
            let dirty = false;
            
            for (let i = 0; i < maxParticles; i++) {
                let p = particles[i];
                let idx = i * 3;
                
                if (p.active) {
                    p.life -= dt;
                    if (p.life <= 0) {
                        p.active = false;
                        activeCount = Math.max(0, activeCount - 1);
                        posAttr[idx] = posAttr[idx+1] = posAttr[idx+2] = 99999; // Move offscreen
                        dirty = true;
                    } else {
                        // Apply gravity/buoyancy
                        p.vel.y -= p.gravity * dt;
                        
                        // Apply velocity
                        p.pos.addScaledVector(p.vel, dt);
                        
                        posAttr[idx] = p.pos.x;
                        posAttr[idx+1] = p.pos.y;
                        posAttr[idx+2] = p.pos.z;
                        
                        colAttr[idx] = p.color.r;
                        colAttr[idx+1] = p.color.g;
                        colAttr[idx+2] = p.color.b;
                        
                        // Fade size based on life
                        let lifeT = p.life / p.maxLife;
                        sizeAttr[i] = p.size * lifeT;
                        
                        dirty = true;
                    }
                }
            }
            
            if (dirty) {
                geometry.attributes.position.needsUpdate = true;
                geometry.attributes.color.needsUpdate = true;
                geometry.attributes.size.needsUpdate = true;
            }
        },
        
        cleanup: function(scene) {
            if (points && scene) {
                scene.remove(points);
            }
            if (geometry) geometry.dispose();
            if (material) material.dispose();
            if (texture) texture.dispose();
            geometry = null;
            material = null;
            points = null;
            texture = null;
            particles = [];
            activeCount = 0;
            particlesInit = false;
        }
    };
})();

})();
