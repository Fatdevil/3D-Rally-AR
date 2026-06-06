// ================================================================
//  ENGINE REGISTRY — Config-driven game engine definitions
//  
//  Each engine defines: tools, terrain rules, physics, power classes,
//  and BUILD CONFIG that controls how Draw-to-World constructs terrain.
//
//  Adding a new engine = add one object here. No code changes needed.
//  Fine-tuning = just change numbers in buildConfig.
//
//  Exposes: window.ENGINE_REGISTRY
// ================================================================
(function () {
    'use strict';

    // Default build config — used as fallback if engine doesn't specify
    window.DEFAULT_BUILD_CONFIG = {
        mountainFalloff: 'smooth',
        mountainMaxHeight: 80,
        mountainHeightScale: 0.8,
        mountainNoise: 0,
        mountainRidgeSpacing: 6,
        roadWidth: 10,
        roadMaterial: 'gravel',
        roadBarrierL: 'STAKES',
        roadBarrierR: 'STAKES',
        roadFoundation: false,
        roadBanking: 0,
        waterDepth: 3,
        waterAsRoad: false,
        terrainNoise: 0,
        checkpointSpacing: 80,
        checkpointMax: 5,
        // ── Grass ──
        grassQuality: 'MED',
        grassRoughHeight: 30,
        grassDeepHeight: 60,
        // ── Water Table ──
        waterTableLevel: -0.5,
        waterType: 'LAKE',
        waterColor: '#38bdf8',
        // ── Environment ──
        skyColor: '#87ceeb',
        fogDensity: 1.0,
        timeOfDay: 12,
        ambientIntensity: 0.4,
        sunIntensity: 0.8,
        biome: 'GLOBAL'
    };

    window.ENGINE_REGISTRY = {

        // ═══════════════════════════════════════
        // 🏎️ RALLY — Offroad gravel, jumps, drifting
        // ═══════════════════════════════════════
        rally: {
            label: 'Rally',
            icon: '🏎️',
            description: 'Offroad rally with gravel, jumps and drifting',
            tools: ['road', 'mountain', 'tree', 'water', 'jump', 'eraser'],
            stamps: { tree: '🌳' },
            terrain: {
                mountainMaxHeight: 40,
                mountainTexture: 'rock',
                groundType: 'grass',
                waterMode: 'bunker',
                roadType: 'gravel'
            },
            physics: {
                profileKey: 'GROUP_A'
            },
            powerClasses: [
                { label: '50 HP',  emoji: '🐢', desc: 'Calm',   multiplier: 0.6 },
                { label: '100 HP', emoji: '🏎️', desc: 'Normal', multiplier: 1.0 },
                { label: '300 HP', emoji: '🔥', desc: 'CHAOS!', multiplier: 1.8 }
            ],
            roadConfig: {
                hasBarriers: false,
                hasCenterLine: true,
                width: 'normal'
            },
            buildConfig: {
                mountainFalloff: 'smooth',
                mountainMaxHeight: 80,
                mountainHeightScale: 0.8,
                mountainNoise: 0,
                mountainRidgeSpacing: 6,
                roadWidth: 10,
                roadMaterial: 'gravel',
                roadBarrierL: 'NONE',
                roadBarrierR: 'NONE',
                roadFoundation: false,
                roadBanking: 0,
                waterDepth: 3,
                waterAsRoad: false,
                terrainNoise: 0,
                checkpointSpacing: 80,
                checkpointMax: 5,
                grassQuality: 'MED',
                grassRoughHeight: 35,
                grassDeepHeight: 65,
                waterTableLevel: -0.5,
                waterType: 'LAKE',
                waterColor: '#38bdf8',
                skyColor: '#87ceeb',
                fogDensity: 1.0,
                timeOfDay: 12,
                ambientIntensity: 0.4,
                sunIntensity: 0.8,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // 🏁 F1 — High speed, smooth asphalt, barriers
        // ═══════════════════════════════════════
        f1: {
            label: 'F1',
            icon: '🏁',
            description: 'High speed on smooth asphalt with barriers',
            tools: ['road', 'mountain', 'water', 'jump', 'eraser'],
            stamps: {},
            terrain: {
                mountainMaxHeight: 8,
                mountainTexture: 'concrete',
                groundType: 'asphalt',
                waterMode: 'forbidden',
                roadType: 'smooth_asphalt'
            },
            physics: {
                profileKey: 'WRC'
            },
            powerClasses: [
                { label: '100 HP',  emoji: '🐢', desc: 'Rookie',  multiplier: 0.7 },
                { label: '500 HP',  emoji: '🏁', desc: 'Pro',     multiplier: 1.0 },
                { label: '1000 HP', emoji: '🔥', desc: 'LEGEND!', multiplier: 1.6 }
            ],
            roadConfig: {
                hasBarriers: true,
                hasCenterLine: false,
                width: 'wide'
            },
            buildConfig: {
                mountainFalloff: 'smooth',
                mountainMaxHeight: 10,
                mountainHeightScale: 0.15,
                mountainNoise: 0,
                mountainRidgeSpacing: 4,
                roadWidth: 14,
                roadMaterial: 'asphalt',
                roadBarrierL: 'CONCRETE',
                roadBarrierR: 'CONCRETE',
                roadFoundation: true,
                roadBanking: 5,
                waterDepth: 1,
                waterAsRoad: false,
                terrainNoise: 0,
                checkpointSpacing: 60,
                checkpointMax: 8,
                grassQuality: 'LOW',
                grassRoughHeight: 15,
                grassDeepHeight: 25,
                waterTableLevel: -2.0,
                waterType: 'LAKE',
                waterColor: '#2196F3',
                skyColor: '#64b5f6',
                fogDensity: 0.6,
                timeOfDay: 14,
                ambientIntensity: 0.5,
                sunIntensity: 0.9,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // 🚤 BOAT — Water = the track!
        // ═══════════════════════════════════════
        boat: {
            label: 'Boat',
            icon: '🚤',
            description: 'Boat race on water — draw rivers and lakes',
            tools: ['water', 'mountain', 'tree', 'jump', 'eraser'],
            stamps: { tree: '🌴' },
            terrain: {
                mountainMaxHeight: 20,
                mountainTexture: 'rock',
                groundType: 'sand',
                waterMode: 'primary',
                roadType: 'water_channel'
            },
            physics: {
                profileKey: 'BOAT'
            },
            powerClasses: [
                { label: '50 HP',  emoji: '🐢', desc: 'Paddle', multiplier: 0.5 },
                { label: '150 HP', emoji: '🚤', desc: 'Cruise', multiplier: 1.0 },
                { label: '500 HP', emoji: '🔥', desc: 'TURBO!', multiplier: 2.0 }
            ],
            roadConfig: {
                hasBarriers: false,
                hasCenterLine: false,
                width: 'wide'
            },
            buildConfig: {
                mountainFalloff: 'sharp',
                mountainMaxHeight: 25,
                mountainHeightScale: 0.5,
                mountainNoise: 0.1,
                mountainRidgeSpacing: 5,
                roadWidth: 16,
                roadMaterial: 'gravel',
                roadBarrierL: 'NONE',
                roadBarrierR: 'NONE',
                roadFoundation: false,
                roadBanking: 0,
                waterDepth: 5,
                waterAsRoad: true,
                terrainNoise: 0.05,
                checkpointSpacing: 100,
                checkpointMax: 6,
                grassQuality: 'OFF',
                grassRoughHeight: 10,
                grassDeepHeight: 20,
                waterTableLevel: 0.5,
                waterType: 'OCEAN',
                waterColor: '#0288d1',
                skyColor: '#4fc3f7',
                fogDensity: 0.8,
                timeOfDay: 11,
                ambientIntensity: 0.5,
                sunIntensity: 0.9,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // 🚁 HELICOPTER — Fly through rings, tall jagged peaks
        // ═══════════════════════════════════════
        helicopter: {
            label: 'Helicopter',
            icon: '🚁',
            description: 'Fly through rings and over mountains — high peaks!',
            tools: ['road', 'mountain', 'tree', 'water', 'eraser'],
            stamps: { tree: '🌲' },
            terrain: {
                mountainMaxHeight: 250,
                mountainTexture: 'snow_rock',
                groundType: 'grass',
                waterMode: 'decoration',
                roadType: 'landing_pad'
            },
            physics: {
                profileKey: 'HELICOPTER'
            },
            powerClasses: [
                { label: 'Light',  emoji: '🐢', desc: 'Tourist',  multiplier: 0.6 },
                { label: 'Medium', emoji: '🚁', desc: 'Rescue',   multiplier: 1.0 },
                { label: 'Attack', emoji: '🔥', desc: 'APACHE!',  multiplier: 2.0 }
            ],
            roadConfig: {
                hasBarriers: false,
                hasCenterLine: false,
                width: 'narrow'
            },
            buildConfig: {
                mountainFalloff: 'sharp',
                mountainMaxHeight: 250,
                mountainHeightScale: 1.5,
                mountainNoise: 0.3,
                mountainRidgeSpacing: 4,
                roadWidth: 8,
                roadMaterial: 'gravel',
                roadBarrierL: 'NONE',
                roadBarrierR: 'NONE',
                roadFoundation: false,
                roadBanking: 0,
                waterDepth: 6,
                waterAsRoad: false,
                terrainNoise: 0.15,
                checkpointSpacing: 120,
                checkpointMax: 4,
                grassQuality: 'LOW',
                grassRoughHeight: 40,
                grassDeepHeight: 80,
                waterTableLevel: -1.0,
                waterType: 'LAKE',
                waterColor: '#26a69a',
                skyColor: '#b3e5fc',
                fogDensity: 1.5,
                timeOfDay: 10,
                ambientIntensity: 0.35,
                sunIntensity: 0.7,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // 🎮 DRONE — FPV through gates, tight terrain
        // ═══════════════════════════════════════
        drone: {
            label: 'Drone',
            icon: '🎮',
            description: 'FPV drone through gates and tight terrain',
            tools: ['road', 'mountain', 'tree', 'eraser'],
            stamps: { tree: '🌲' },
            terrain: {
                mountainMaxHeight: 50,
                mountainTexture: 'concrete',
                groundType: 'grass',
                waterMode: 'decoration',
                roadType: 'ground_marker'
            },
            physics: {
                profileKey: 'DRONE'
            },
            powerClasses: [
                { label: 'Slow',   emoji: '🐢', desc: 'Beginner',  multiplier: 0.5 },
                { label: 'Sport',  emoji: '🎮', desc: 'Freestyle', multiplier: 1.0 },
                { label: 'Race',   emoji: '🔥', desc: 'BANZAI!',   multiplier: 2.2 }
            ],
            roadConfig: {
                hasBarriers: false,
                hasCenterLine: false,
                width: 'narrow'
            },
            buildConfig: {
                mountainFalloff: 'plateau',
                mountainMaxHeight: 50,
                mountainHeightScale: 1.0,
                mountainNoise: 0.15,
                mountainRidgeSpacing: 3,
                roadWidth: 6,
                roadMaterial: 'asphalt',
                roadBarrierL: 'NONE',
                roadBarrierR: 'NONE',
                roadFoundation: false,
                roadBanking: 0,
                waterDepth: 2,
                waterAsRoad: false,
                terrainNoise: 0.1,
                checkpointSpacing: 50,
                checkpointMax: 10,
                grassQuality: 'LOW',
                grassRoughHeight: 20,
                grassDeepHeight: 40,
                waterTableLevel: -1.5,
                waterType: 'LAKE',
                waterColor: '#38bdf8',
                skyColor: '#90caf9',
                fogDensity: 0.5,
                timeOfDay: 15,
                ambientIntensity: 0.45,
                sunIntensity: 0.85,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // 🏎️ GOKART — Tight, barriers, power-ups
        // ═══════════════════════════════════════
        gokart: {
            label: 'Gokart',
            icon: '🏎️',
            description: 'Tight tracks with barriers and power-ups',
            tools: ['road', 'mountain', 'tree', 'water', 'eraser'],
            stamps: { tree: '🌳' },
            terrain: {
                mountainMaxHeight: 3,
                mountainTexture: 'rubber',
                groundType: 'asphalt',
                waterMode: 'puddle',
                roadType: 'smooth_asphalt'
            },
            physics: {
                profileKey: 'FWD_HOT'
            },
            powerClasses: [
                { label: '50cc',  emoji: '🐢', desc: 'Kids',   multiplier: 0.5 },
                { label: '125cc', emoji: '🏎️', desc: 'Junior', multiplier: 1.0 },
                { label: '250cc', emoji: '🔥', desc: 'PRO!',   multiplier: 1.5 }
            ],
            roadConfig: {
                hasBarriers: true,
                hasCenterLine: false,
                width: 'narrow'
            },
            buildConfig: {
                mountainFalloff: 'smooth',
                mountainMaxHeight: 4,
                mountainHeightScale: 0.1,
                mountainNoise: 0,
                mountainRidgeSpacing: 4,
                roadWidth: 8,
                roadMaterial: 'asphalt',
                roadBarrierL: 'CONCRETE',
                roadBarrierR: 'CONCRETE',
                roadFoundation: true,
                roadBanking: 3,
                waterDepth: 0.5,
                waterAsRoad: false,
                terrainNoise: 0,
                checkpointSpacing: 40,
                checkpointMax: 8,
                grassQuality: 'OFF',
                grassRoughHeight: 10,
                grassDeepHeight: 15,
                waterTableLevel: -2.0,
                waterType: 'LAKE',
                waterColor: '#4dd0e1',
                skyColor: '#81d4fa',
                fogDensity: 0.4,
                timeOfDay: 13,
                ambientIntensity: 0.5,
                sunIntensity: 0.9,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // ✈️ PROPELLER — Propeller plane, wide ridges
        // ═══════════════════════════════════════
        propeller: {
            label: 'Propeller',
            icon: '✈️',
            description: 'Propeller plane — lower altitude, kid-friendly',
            tools: ['road', 'mountain', 'tree', 'water', 'eraser'],
            stamps: { tree: '🌲' },
            terrain: {
                mountainMaxHeight: 150,
                mountainTexture: 'rock',
                groundType: 'grass',
                waterMode: 'decoration',
                roadType: 'runway'
            },
            physics: {
                profileKey: 'PROPELLER'
            },
            powerClasses: [
                { label: 'Trainer',  emoji: '🐢', desc: 'Cessna',   multiplier: 0.6 },
                { label: 'Sport',    emoji: '✈️', desc: 'Spitfire',  multiplier: 1.0 },
                { label: 'Racer',    emoji: '🔥', desc: 'MUSTANG!',  multiplier: 1.8 }
            ],
            roadConfig: {
                hasBarriers: false,
                hasCenterLine: true,
                width: 'wide'
            },
            buildConfig: {
                mountainFalloff: 'smooth',
                mountainMaxHeight: 150,
                mountainHeightScale: 1.2,
                mountainNoise: 0.1,
                mountainRidgeSpacing: 5,
                roadWidth: 14,
                roadMaterial: 'asphalt',
                roadBarrierL: 'NONE',
                roadBarrierR: 'NONE',
                roadFoundation: true,
                roadBanking: 0,
                waterDepth: 4,
                waterAsRoad: false,
                terrainNoise: 0.08,
                checkpointSpacing: 150,
                checkpointMax: 4,
                grassQuality: 'MED',
                grassRoughHeight: 30,
                grassDeepHeight: 50,
                waterTableLevel: -0.5,
                waterType: 'LAKE',
                waterColor: '#29b6f6',
                skyColor: '#e1f5fe',
                fogDensity: 1.2,
                timeOfDay: 11,
                ambientIntensity: 0.45,
                sunIntensity: 0.85,
                biome: 'GLOBAL'
            }
        },

        // ═══════════════════════════════════════
        // 🏍️ MOTOCROSS — Dirt bike, jumps, wheelies
        // ═══════════════════════════════════════
        motocross: {
            label: 'Motocross',
            icon: '🏍️',
            description: 'Dirt bike with jumps, wheelies and crashes',
            tools: ['road', 'mountain', 'tree', 'water', 'jump', 'eraser'],
            stamps: { tree: '🌳' },
            terrain: {
                mountainMaxHeight: 30,
                mountainTexture: 'rock',
                groundType: 'dirt',
                waterMode: 'bunker',
                roadType: 'dirt_track'
            },
            physics: {
                profileKey: 'MOTOCROSS'
            },
            powerClasses: [
                { label: '125cc', emoji: '🐢', desc: 'Rookie',  multiplier: 0.6 },
                { label: '250cc', emoji: '🏍️', desc: 'Sport',   multiplier: 1.0 },
                { label: '450cc', emoji: '🔥', desc: 'FACTORY!', multiplier: 1.6 }
            ],
            roadConfig: {
                hasBarriers: false,
                hasCenterLine: false,
                width: 'narrow'
            },
            buildConfig: {
                mountainFalloff: 'smooth',
                mountainMaxHeight: 35,
                mountainHeightScale: 0.6,
                mountainNoise: 0.05,
                mountainRidgeSpacing: 5,
                roadWidth: 7,
                roadMaterial: 'dirt',
                roadBarrierL: 'NONE',
                roadBarrierR: 'NONE',
                roadFoundation: false,
                roadBanking: 2,
                waterDepth: 2,
                waterAsRoad: false,
                terrainNoise: 0.06,
                checkpointSpacing: 60,
                checkpointMax: 6,
                grassQuality: 'MED',
                grassRoughHeight: 40,
                grassDeepHeight: 70,
                waterTableLevel: -0.5,
                waterType: 'LAKE',
                waterColor: '#38bdf8',
                skyColor: '#87ceeb',
                fogDensity: 0.8,
                timeOfDay: 14,
                ambientIntensity: 0.45,
                sunIntensity: 0.85,
                biome: 'GLOBAL'
            }
        }
    };

    // ── Helper: get engine keys as array ──
    window.ENGINE_REGISTRY._keys = function () {
        return Object.keys(window.ENGINE_REGISTRY).filter(function (k) {
            return k !== '_keys';
        });
    };

    // ── Load admin overrides from localStorage ──
    try {
        var overrides = JSON.parse(localStorage.getItem('engine_config_overrides') || '{}');
        var keys = window.ENGINE_REGISTRY._keys();
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (overrides[key]) {
                window.ENGINE_REGISTRY[key].buildConfig = overrides[key];
                console.log('🔧 Engine override loaded: ' + key);
            }
        }
    } catch (e) {
        // No overrides or parse error — use defaults
    }

})();
