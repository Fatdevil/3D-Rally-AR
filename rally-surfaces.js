// ============================================================
// rally-surfaces.js — Surface Material System for 3D-Rally-AR
// 8 surface types with full physics parameters per spec
// ============================================================
(function() {
'use strict';

const SURFACES = {
    ASPHALT: {
        grip: 0.85, longGrip: 0.98, brake: 1.00,
        maxSpeed: 1.00, accel: 1.00, dragAdd: 0.00,
        driftThreshold: 20, driftSustain: 0.7, driftRecovery: 0.95,
        particle: 'rubber_smoke', particleIntensity: 0.4,
        rumble: 0.1, depthVariance: 0.02, landing: 0.9,
        color: '#4ade80', label: 'ASPHALT'
    },
    GRAVEL: {
        grip: 0.52, longGrip: 0.70, brake: 0.75,
        maxSpeed: 0.88, accel: 0.84, dragAdd: 0.002, // Rejält sänkt
        driftThreshold: 10, driftSustain: 1.3, driftRecovery: 0.70,
        particle: 'gravel_spray', particleIntensity: 0.9,
        rumble: 0.4, depthVariance: 0.12, landing: 0.75,
        color: '#a3e635', label: 'GRAVEL'
    },
    MUD: {
        grip: 0.38, longGrip: 0.45, brake: 0.50,
        maxSpeed: 0.72, accel: 0.68, dragAdd: 0.008, // Sänkt
        driftThreshold: 7, driftSustain: 1.8, driftRecovery: 0.40,
        particle: 'mud_heavy', particleIntensity: 1.0,
        rumble: 0.3, depthVariance: 0.25, landing: 0.55,
        color: '#f97316', label: 'MUD'
    },
    SNOW: {
        grip: 0.48, longGrip: 0.55, brake: 0.55,
        maxSpeed: 0.80, accel: 0.76, dragAdd: 0.004,
        driftThreshold: 9, driftSustain: 1.5, driftRecovery: 0.60,
        particle: 'snow_spray', particleIntensity: 0.85,
        rumble: 0.2, depthVariance: 0.08, landing: 0.70,
        color: '#e2e8f0', label: 'SNOW'
    },
    ICE: {
        grip: 0.14, longGrip: 0.18, brake: 0.20,
        maxSpeed: 0.85, accel: 0.90, dragAdd: 0.00,
        driftThreshold: 3, driftSustain: 3.0, driftRecovery: 0.15,
        particle: 'ice_crystals', particleIntensity: 0.2,
        rumble: 0.05, depthVariance: 0.03, landing: 0.95,
        color: '#93c5fd', label: 'ICE'
    },
    DIRT: {
        grip: 0.55, longGrip: 0.60, brake: 0.65,
        maxSpeed: 0.82, accel: 0.78, dragAdd: 0.003, // Rejält sänkt
        driftThreshold: 10, driftSustain: 1.4, driftRecovery: 0.65,
        particle: 'grass_spray', particleIntensity: 0.75,
        rumble: 0.35, depthVariance: 0.18, landing: 0.65,
        color: '#fbbf24', label: 'DIRT'
    },
    WET_TARMAC: {
        grip: 0.68, longGrip: 0.72, brake: 0.72,
        maxSpeed: 0.90, accel: 0.90, dragAdd: 0.003,
        driftThreshold: 14, driftSustain: 1.0, driftRecovery: 0.80,
        particle: 'water_spray', particleIntensity: 1.0,
        rumble: 0.15, depthVariance: 0.06, landing: 0.88,
        color: '#22d3ee', label: 'WET TARMAC'
    },
    COBBLESTONE: {
        grip: 0.72, longGrip: 0.75, brake: 0.80,
        maxSpeed: 0.78, accel: 0.85, dragAdd: 0.005,
        driftThreshold: 16, driftSustain: 0.9, driftRecovery: 0.85,
        particle: 'stone_dust', particleIntensity: 0.5,
        rumble: 0.85, depthVariance: 0.22, landing: 0.88,
        color: '#94a3b8', label: 'COBBLESTONE'
    },
    WATER: {
        grip: 0.05, longGrip: 0.05, brake: 0.10,
        maxSpeed: 0.15, accel: 0.10, dragAdd: 0.04, // Sänkt
        driftThreshold: 2, driftSustain: 5.0, driftRecovery: 0.10,
        particle: 'water_spray', particleIntensity: 1.0,
        rumble: 0.6, depthVariance: 0.0, landing: 0.3,
        color: '#38bdf8', label: 'WATER'
    },
    BARRIER: {
        grip: 0.00, longGrip: 0.00, brake: 0.00,
        maxSpeed: 0.00, accel: 0.00, dragAdd: 0.5,
        driftThreshold: 1, driftSustain: 1.0, driftRecovery: 1.0,
        particle: 'none', particleIntensity: 0.0,
        rumble: 1.0, depthVariance: 0.0, landing: 1.0,
        color: '#ef4444', label: 'BARRIER'
    }
};

// Golf biome → Rally surface translation
// Allows smart-builder.js to keep working without changes
const SURFACE_MAP = {
    'GREEN':      'ASPHALT',
    'FAIRWAY':    'ASPHALT',
    'TEE':        'ASPHALT',
    'FOREGREEN':  'WET_TARMAC',
    'SEMI-ROUGH': 'GRAVEL',
    'ROUGH':      'DIRT',
    'FESCUE':     'MUD',
    'DEEP ROUGH': 'MUD',
    'SAND':       'DIRT',
    'WASTE':      'GRAVEL',
    'BUNKER':     'DIRT',
    'WATER':      'WATER',
    'OB':         'BARRIER',
    // WINTER biome surface types
    'SNOW_SURFACE': 'SNOW',
    'ICE_SURFACE':  'ICE'
};

// Resolve terrain type to SurfaceMaterial
window.resolveSurface = function(terrainType) {
    let t = (terrainType || 'DIRT').toUpperCase();
    let key = SURFACE_MAP[t] || t;
    return SURFACES[key] || SURFACES.DIRT;
};

window.RALLY_SURFACES = SURFACES;
window.RALLY_SURFACE_MAP = SURFACE_MAP;

// === FAS3-K4: TRACK DEGRADATION SYSTEM ===
// Spatial grid tracking how much each area has been driven on
// Degradation reduces grip and increases rumble progressively
const DEGRADE_GRID_SIZE = 10;  // meters per cell
const DEGRADE_GRID_DIM = 100;  // 100×100 grid = 1000m terrain
let degradeGrid = null;

function initDegradeGrid() {
    degradeGrid = new Float32Array(DEGRADE_GRID_DIM * DEGRADE_GRID_DIM);
}

// Called each frame while car is on ground
function degradeSurface(worldX, worldZ, intensity, terrainSize) {
    if (!degradeGrid) initDegradeGrid();
    let half = terrainSize / 2;
    let gx = Math.floor((worldX + half) / DEGRADE_GRID_SIZE);
    let gz = Math.floor((worldZ + half) / DEGRADE_GRID_SIZE);
    if (gx < 0 || gx >= DEGRADE_GRID_DIM || gz < 0 || gz >= DEGRADE_GRID_DIM) return;
    let idx = gz * DEGRADE_GRID_DIM + gx;
    degradeGrid[idx] = Math.min(1.0, degradeGrid[idx] + intensity);
}

// Get degradation at position (0..1, 0=fresh, 1=fully worn)
function getDegradation(worldX, worldZ, terrainSize) {
    if (!degradeGrid) return 0;
    let half = terrainSize / 2;
    let gx = Math.floor((worldX + half) / DEGRADE_GRID_SIZE);
    let gz = Math.floor((worldZ + half) / DEGRADE_GRID_SIZE);
    if (gx < 0 || gx >= DEGRADE_GRID_DIM || gz < 0 || gz >= DEGRADE_GRID_DIM) return 0;
    return degradeGrid[gz * DEGRADE_GRID_DIM + gx];
}

// Resolve surface with degradation applied
window.resolveSurfaceDegraded = function(terrainType, worldX, worldZ, terrainSize) {
    let base = window.resolveSurface(terrainType);
    let deg = getDegradation(worldX, worldZ, terrainSize || 900);
    if (deg < 0.01) return base;

    // Degraded surface: reduce grip, increase rumble, more drag
    return Object.assign({}, base, {
        grip: base.grip * (1.0 - deg * 0.25),           // up to 25% grip loss
        longGrip: base.longGrip * (1.0 - deg * 0.20),
        brake: base.brake * (1.0 - deg * 0.15),
        rumble: Math.min(1.0, base.rumble + deg * 0.3),
        dragAdd: base.dragAdd + deg * 0.003,
        particleIntensity: Math.min(1.0, base.particleIntensity + deg * 0.2)
    });
};

window.rallyTrackDegrade = {
    degrade: degradeSurface,
    getDegradation: getDegradation,
    reset: function() { if (degradeGrid) degradeGrid.fill(0); },
    init: initDegradeGrid
};

})();
