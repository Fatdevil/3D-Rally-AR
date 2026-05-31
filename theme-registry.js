// ================================================================
//  THEME REGISTRY — Config-driven visual theme definitions
//  
//  Each theme defines: ground, sky, panorama, stamp overrides
//  Adding a new theme = add one object here. No code changes needed.
//
//  Exposes: window.THEME_REGISTRY
// ================================================================
(function () {
    'use strict';

    window.THEME_REGISTRY = {

        // ═══════════════════════════════════════
        // 🎨 FRITT — Default, no theme override
        // ═══════════════════════════════════════
        none: {
            label: 'Free',
            icon: '🎨',
            description: 'No theme — free building',
            preview: null,
            ground: { color: '#4a7c3f', texture: 'grass' },
            sky: 'default',
            panorama: null,
            stamps: {},
            extraTools: [],
            extraStamps: {}
        },

        // ═══════════════════════════════════════
        // 🏜️ ÖKEN — Sand, kaktusar, pyramider
        // ═══════════════════════════════════════
        desert: {
            label: 'Desert',
            icon: '🏜️',
            description: 'Hot desert landscape with sand and cacti',
            preview: 'themes/desert_preview.png',
            ground: { color: '#d4a76a', texture: 'sand' },
            sky: 'warm',
            panorama: 'panorama_desert.png',
            stamps: { tree: '🌵' },
            extraTools: [],
            extraStamps: {}
        },

        // ═══════════════════════════════════════
        // ❄️ VINTER — Snö, granar, is
        // ═══════════════════════════════════════
        winter: {
            label: 'Winter',
            icon: '❄️',
            description: 'Snowy winter landscape with pine trees',
            preview: 'themes/winter_preview.png',
            ground: { color: '#e8eef5', texture: 'snow' },
            sky: 'cold',
            panorama: 'panorama_winter.png',
            stamps: { tree: '🌲' },
            extraTools: [],
            extraStamps: {}
        },

        // ═══════════════════════════════════════
        // 🏝️ TROPISK — Strand, palmer, piratskepp
        // ═══════════════════════════════════════
        tropical: {
            label: 'Tropical',
            icon: '🏝️',
            description: 'Tropical paradise with beaches and palm trees',
            preview: 'themes/tropical_preview.png',
            ground: { color: '#5a9e4b', texture: 'tropical_grass' },
            sky: 'warm',
            panorama: 'panorama_tropical.png',
            stamps: { tree: '🌴' },
            extraTools: [],
            extraStamps: {}
        },

        // ═══════════════════════════════════════
        // 🏙️ CITY — Höghus, asfalt, urban
        // ═══════════════════════════════════════
        city: {
            label: 'City',
            icon: '🏙️',
            description: 'Urban city environment with skyscrapers',
            preview: 'themes/city_preview.png',
            ground: { color: '#666666', texture: 'asphalt' },
            sky: 'urban',
            panorama: 'panorama_city.png',
            stamps: { tree: '🏢' },
            extraTools: ['skyscraper', 'police', 'fire'],
            extraStamps: {
                skyscraper: '🏙️',
                police: '🚔',
                fire: '🚒'
            }
        },

        // ═══════════════════════════════════════
        // 🌋 VULKAN — Lava, klippor, rök
        // ═══════════════════════════════════════
        volcano: {
            label: 'Volcano',
            icon: '🌋',
            description: 'Volcanic landscape with lava and cliffs',
            preview: 'themes/volcano_preview.png',
            ground: { color: '#3a3a3a', texture: 'volcanic_rock' },
            sky: 'red',
            panorama: 'panorama_volcano.png',
            stamps: { tree: '🌴' },
            extraTools: [],
            extraStamps: {}
        }
    };

    // ── Helper: get theme keys as array ──
    window.THEME_REGISTRY._keys = function () {
        return Object.keys(window.THEME_REGISTRY).filter(function (k) {
            return k !== '_keys';
        });
    };

})();
