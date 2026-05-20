// ============================================================
// rally-car-profiles.js — FAS3-M3: Vehicle Profiles for 3D-Rally-AR
// Pre-defined car setups: FWD/RWD/4WD with drivetrain & handling presets
// ============================================================
(function() {
'use strict';

// Each profile overrides specific CFG values
const CAR_PROFILES = {
    // === GROUP A — Balanced 4WD Rally (default) ===
    GROUP_A: {
        label: 'Group A Rally',
        description: '4WD, balanced, gravel-tuned',
        icon: '🏎️',
        overrides: {
            MASS: 1100,
            ENGINE_FORCE: 55000,
            MAX_SPEED: 80,
            BRAKE_FORCE: 65000,
            TORQUE_BIAS: 0.5,        // 50/50 4WD
            DIFF_DRIVE_LOCK: 0.3,
            DIFF_BRAKE_LOCK: 0.2,
            CGH: 0.50,
            SPRING_RATE: 25000,
            DAMPER: 4000,
            ARB_FRONT: 8000,
            ARB_REAR: 6000,
            BRAKE_BIAS: 0.60,
            CAMBER_FRONT: -1.5,
            CAMBER_REAR: -0.8,
            TOE_FRONT: 0.2,
            TOE_REAR: -0.1,
            TURBO_BOOST: 1.35,
            TURBO_LAG: 0.3,
            GEAR_RATIOS: [0, 3.5, 2.2, 1.6, 1.2, 0.95],
            FINAL_DRIVE: 4.1
        }
    },

    // === WRC — Aggressive 4WD with center diff ===
    WRC: {
        label: 'WRC',
        description: 'Aggressive 4WD, high power, active diff',
        icon: '🏁',
        overrides: {
            MASS: 1190,
            ENGINE_FORCE: 72000,
            MAX_SPEED: 85,
            BRAKE_FORCE: 78000,
            TORQUE_BIAS: 0.45,       // slight front bias
            DIFF_DRIVE_LOCK: 0.55,   // aggressive LSD
            DIFF_BRAKE_LOCK: 0.35,
            CGH: 0.48,
            SPRING_RATE: 30000,
            DAMPER: 5000,
            ARB_FRONT: 10000,
            ARB_REAR: 7000,
            BRAKE_BIAS: 0.58,
            CAMBER_FRONT: -2.0,
            CAMBER_REAR: -1.2,
            TOE_FRONT: 0.3,
            TOE_REAR: -0.15,
            TURBO_BOOST: 1.50,
            TURBO_LAG: 0.4,
            GEAR_RATIOS: [0, 3.2, 2.1, 1.5, 1.15, 0.88],
            FINAL_DRIVE: 4.3
        }
    },

    // === RWD_DRIFT — Rear-wheel drive drift machine ===
    RWD_DRIFT: {
        label: 'RWD Drift',
        description: 'RWD, tail-happy, tarmac spec',
        icon: '💨',
        overrides: {
            MASS: 1050,
            ENGINE_FORCE: 48000,
            MAX_SPEED: 75,
            BRAKE_FORCE: 55000,
            TORQUE_BIAS: 1.0,        // 100% rear wheel drive
            DIFF_DRIVE_LOCK: 0.7,    // high LSD for predictable slides
            DIFF_BRAKE_LOCK: 0.4,
            CGH: 0.55,
            SPRING_RATE: 22000,
            DAMPER: 3500,
            ARB_FRONT: 6000,
            ARB_REAR: 9000,          // stiff rear = oversteer
            BRAKE_BIAS: 0.55,
            CAMBER_FRONT: -2.5,
            CAMBER_REAR: -1.8,
            TOE_FRONT: 0.4,
            TOE_REAR: 0.1,           // toe-out rear = rotation
            TURBO_BOOST: 1.25,
            TURBO_LAG: 0.2,
            DRIFT_TARGET_GRIP: 0.15,
            DRIFT_STEER_BONUS: 1.8,
            GEAR_RATIOS: [0, 3.8, 2.4, 1.7, 1.3, 1.0],
            FINAL_DRIVE: 3.9
        }
    },

    // === FWD_HOT — Front-wheel drive hot hatch ===
    FWD_HOT: {
        label: 'FWD Hot Hatch',
        description: 'FWD, nimble, understeer under power',
        icon: '🚗',
        overrides: {
            MASS: 950,
            ENGINE_FORCE: 38000,
            MAX_SPEED: 65,
            BRAKE_FORCE: 48000,
            TORQUE_BIAS: 0.0,        // 100% front wheel drive
            DIFF_DRIVE_LOCK: 0.15,
            DIFF_BRAKE_LOCK: 0.1,
            CGH: 0.45,
            SPRING_RATE: 20000,
            DAMPER: 3200,
            ARB_FRONT: 9000,         // stiff front = understeer
            ARB_REAR: 4000,
            BRAKE_BIAS: 0.68,        // heavy front bias (FWD)
            CAMBER_FRONT: -1.0,
            CAMBER_REAR: -0.5,
            TOE_FRONT: 0.1,
            TOE_REAR: -0.2,          // strong rear toe-in = stability
            TURBO_BOOST: 1.15,
            TURBO_LAG: 0.15,
            DRIFT_TARGET_GRIP: 0.30, // harder to drift
            HANDBRAKE_GRIP: 0.08,
            GEAR_RATIOS: [0, 3.6, 2.3, 1.65, 1.25, 1.0],
            FINAL_DRIVE: 3.7
        }
    },

    // === TROPHY_TRUCK — Heavy offroad beast ===
    TROPHY_TRUCK: {
        label: 'Trophy Truck',
        description: 'Heavy, massive suspension, offroad king',
        icon: '🛻',
        overrides: {
            MASS: 1800,
            ENGINE_FORCE: 85000,
            MAX_SPEED: 70,
            BRAKE_FORCE: 90000,
            TORQUE_BIAS: 0.5,
            DIFF_DRIVE_LOCK: 0.6,
            DIFF_BRAKE_LOCK: 0.3,
            CGH: 0.70,
            SPRING_RATE: 18000,       // soft for big hits
            DAMPER: 6000,             // high damping
            SUSPENSION_TRAVEL: 0.30,  // massive travel!
            ARB_FRONT: 5000,
            ARB_REAR: 5000,
            BRAKE_BIAS: 0.55,
            CAMBER_FRONT: -0.5,
            CAMBER_REAR: -0.3,
            TOE_FRONT: 0.0,
            TOE_REAR: 0.0,
            TURBO_BOOST: 1.20,
            TURBO_LAG: 0.5,
            GEAR_RATIOS: [0, 4.0, 2.5, 1.8, 1.35, 1.1],
            FINAL_DRIVE: 4.5
        }
    }
};

let currentProfile = 'GROUP_A';
let defaultCFG = null;  // snapshot of default CFG

function applyProfile(profileKey, cfg) {
    if (!CAR_PROFILES[profileKey]) {
        console.warn(`⚠️ Unknown car profile: ${profileKey}`);
        return;
    }

    // Save defaults on first call
    if (!defaultCFG) {
        defaultCFG = {};
        for (let key in cfg) {
            if (typeof cfg[key] === 'object' && Array.isArray(cfg[key])) {
                defaultCFG[key] = cfg[key].slice();
            } else {
                defaultCFG[key] = cfg[key];
            }
        }
    }

    // Reset to defaults first
    for (let key in defaultCFG) {
        if (typeof defaultCFG[key] === 'object' && Array.isArray(defaultCFG[key])) {
            cfg[key] = defaultCFG[key].slice();
        } else {
            cfg[key] = defaultCFG[key];
        }
    }

    // Apply profile overrides
    let profile = CAR_PROFILES[profileKey];
    for (let key in profile.overrides) {
        if (typeof profile.overrides[key] === 'object' && Array.isArray(profile.overrides[key])) {
            cfg[key] = profile.overrides[key].slice();
        } else {
            cfg[key] = profile.overrides[key];
        }
    }

    currentProfile = profileKey;
    console.log(`🚗 Car profile → ${profile.label} (${profile.description})`);
}

window.rallyCarProfiles = {
    applyProfile: applyProfile,
    getProfiles: function() { return CAR_PROFILES; },
    getCurrentProfile: function() { return currentProfile; },
    getCurrentProfileData: function() { return CAR_PROFILES[currentProfile]; },
    PROFILES: CAR_PROFILES
};

})();
