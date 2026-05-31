// ================================================================
//  PLATE REGISTRY — Pre-built map templates with locked zones
//  
//  Each plate defines: mask (locked zones), pre-built scene data,
//  and compatibility with engines + themes.
//
//  Plates are NEVER shown to the player — they are randomly
//  selected during BUILD based on engine + theme compatibility.
//  The plate is revealed as a SURPRISE with the finished track!
//
//  Exposes: window.PLATE_REGISTRY, window.selectRandomPlate()
// ================================================================
(function () {
    'use strict';

    window.PLATE_REGISTRY = {

        // ═══════════════════════════════════════
        // 📄 BLANK — Empty canvas, no locked zones
        // ═══════════════════════════════════════
        blank: {
            label: 'Tom',
            preview: null,
            mask: null,
            preBuilt: null,
            compatibleEngines: '*',
            compatibleThemes: ['none']
        },

        // ═══════════════════════════════════════
        // 🏝️ PIRATE BAY — Tropical coast with pirate ships
        // ═══════════════════════════════════════
        pirate_bay: {
            label: 'Pirate Bay',
            preview: 'plates/pirate_bay_preview.png',
            mask: 'plates/pirate_bay_mask.png',
            preBuilt: 'plates/pirate_bay_scene.json',
            compatibleEngines: ['rally', 'gokart', 'boat'],
            compatibleThemes: ['tropical']
        },

        // ═══════════════════════════════════════
        // ⛰️ MOUNTAIN PASS — High altitude alpine track
        // ═══════════════════════════════════════
        mountain_pass: {
            label: 'Mountain Pass',
            preview: 'plates/mountain_pass_preview.png',
            mask: 'plates/mountain_pass_mask.png',
            preBuilt: 'plates/mountain_pass_scene.json',
            compatibleEngines: ['rally', 'f1', 'helicopter', 'propeller'],
            compatibleThemes: ['winter']
        },

        // ═══════════════════════════════════════
        // 🏙️ DOWNTOWN — City blocks with skyscrapers
        // ═══════════════════════════════════════
        downtown: {
            label: 'Downtown',
            preview: 'plates/downtown_preview.png',
            mask: 'plates/downtown_mask.png',
            preBuilt: 'plates/downtown_scene.json',
            compatibleEngines: ['f1', 'gokart', 'drone'],
            compatibleThemes: ['city']
        },

        // ═══════════════════════════════════════
        // 🏜️ CANYON RUN — Desert canyon with rock formations
        // ═══════════════════════════════════════
        canyon_run: {
            label: 'Canyon Run',
            preview: 'plates/canyon_run_preview.png',
            mask: 'plates/canyon_run_mask.png',
            preBuilt: 'plates/canyon_run_scene.json',
            compatibleEngines: ['rally', 'helicopter', 'propeller', 'drone'],
            compatibleThemes: ['desert']
        },

        // ═══════════════════════════════════════
        // 🌋 LAVA FIELDS — Volcanic terrain with lava flows
        // ═══════════════════════════════════════
        lava_fields: {
            label: 'Lava Fields',
            preview: 'plates/lava_fields_preview.png',
            mask: 'plates/lava_fields_mask.png',
            preBuilt: 'plates/lava_fields_scene.json',
            compatibleEngines: ['rally', 'helicopter', 'drone'],
            compatibleThemes: ['volcano']
        }
    };

    // ═══════════════════════════════════════════════════════════
    // selectRandomPlate(engineKey, themeKey)
    // Randomly selects a compatible plate during BUILD.
    // Returns: { key, plate, sceneData }
    // ═══════════════════════════════════════════════════════════
    window.selectRandomPlate = async function (engineKey, themeKey) {
        var registry = window.PLATE_REGISTRY;

        // 1. Filter plates matching engine + theme
        var candidates = Object.keys(registry).filter(function (key) {
            var plate = registry[key];

            // 'none' theme → always use blank
            if (themeKey === 'none' && key === 'blank') return true;
            if (themeKey === 'none') return false;
            if (key === 'blank') return false;

            var engineMatch = plate.compatibleEngines === '*' ||
                              plate.compatibleEngines.indexOf(engineKey) !== -1;
            var themeMatch  = plate.compatibleThemes === '*' ||
                              plate.compatibleThemes.indexOf(themeKey) !== -1;
            return engineMatch && themeMatch;
        });

        // Fallback to blank if no match
        if (candidates.length === 0) candidates = ['blank'];

        // 2. Random pick
        var pick = candidates[Math.floor(Math.random() * candidates.length)];
        var plate = registry[pick];

        console.log('🎁 Slumpad platta: ' + plate.label + ' (' + pick + ')');

        // 3. Load mask + pre-built scene
        var result = { key: pick, plate: plate, sceneData: null };

        if (plate.mask && window.TemplateMask) {
            if (!window.TemplateMask.isInit()) window.TemplateMask.init();
            try {
                await window.TemplateMask.importFromURL(plate.mask);
            } catch (e) {
                console.warn('⚠️ Could not load plate mask:', plate.mask, e);
            }
        }

        if (plate.preBuilt) {
            try {
                var response = await fetch(plate.preBuilt);
                result.sceneData = await response.json();
            } catch (e) {
                console.warn('⚠️ Could not load plate scene:', plate.preBuilt, e);
            }
        }

        return result;
    };

})();
