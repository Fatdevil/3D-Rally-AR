// ============================================================
// rally-weather.js — FAS3-M4: Weather System for 3D-Rally-AR
// Dynamic weather states that modify surface grip in real-time
// ============================================================
(function() {
'use strict';

const WEATHER_STATES = {
    DRY: {
        gripMult: 1.0,
        visibility: 1.0,
        particleType: null,
        dragMult: 1.0,
        label: 'DRY',
        icon: '☀️',
        // Per-surface sensitivity (how much this weather affects each surface)
        surfaceMods: {
            ASPHALT: 1.0, GRAVEL: 1.0, MUD: 1.0, SNOW: 1.0,
            ICE: 1.0, DIRT: 1.0, WET_TARMAC: 1.0, COBBLESTONE: 1.0
        }
    },
    LIGHT_RAIN: {
        gripMult: 0.82,
        visibility: 0.85,
        particleType: 'rain_light',
        dragMult: 1.02,
        label: 'LIGHT RAIN',
        icon: '🌦️',
        surfaceMods: {
            ASPHALT: 0.78, GRAVEL: 0.88, MUD: 0.70, SNOW: 0.95,
            ICE: 0.85, DIRT: 0.75, WET_TARMAC: 0.90, COBBLESTONE: 0.72
        }
    },
    HEAVY_RAIN: {
        gripMult: 0.60,
        visibility: 0.55,
        particleType: 'rain_heavy',
        dragMult: 1.06,
        label: 'HEAVY RAIN',
        icon: '🌧️',
        surfaceMods: {
            ASPHALT: 0.55, GRAVEL: 0.72, MUD: 0.42, SNOW: 0.80,
            ICE: 0.65, DIRT: 0.50, WET_TARMAC: 0.75, COBBLESTONE: 0.50
        }
    },
    FOG: {
        gripMult: 0.92,
        visibility: 0.30,
        particleType: 'fog',
        dragMult: 1.01,
        label: 'FOG',
        icon: '🌫️',
        surfaceMods: {
            ASPHALT: 0.92, GRAVEL: 0.95, MUD: 0.88, SNOW: 0.90,
            ICE: 0.88, DIRT: 0.90, WET_TARMAC: 0.94, COBBLESTONE: 0.90
        }
    },
    SNOW_FALL: {
        gripMult: 0.55,
        visibility: 0.45,
        particleType: 'snow_fall',
        dragMult: 1.04,
        label: 'SNOW',
        icon: '❄️',
        surfaceMods: {
            ASPHALT: 0.48, GRAVEL: 0.65, MUD: 0.55, SNOW: 0.75,
            ICE: 0.60, DIRT: 0.52, WET_TARMAC: 0.55, COBBLESTONE: 0.45
        }
    }
};

let currentWeather = 'DRY';
let weatherTransition = 0;  // 0..1 blend between old and new
let previousWeather = 'DRY';
let transitionDuration = 8.0;  // seconds for full weather change
let weatherTimer = 0;

// Apply weather modifiers to a surface
function getWeatherGrip(surfaceKey) {
    let w = WEATHER_STATES[currentWeather];
    if (!w) return 1.0;
    let surfaceMod = (w.surfaceMods && w.surfaceMods[surfaceKey]) || w.gripMult;
    
    // Blend during transition
    if (weatherTransition < 1.0 && previousWeather !== currentWeather) {
        let pw = WEATHER_STATES[previousWeather];
        let prevMod = (pw.surfaceMods && pw.surfaceMods[surfaceKey]) || pw.gripMult;
        return prevMod + (surfaceMod - prevMod) * weatherTransition;
    }
    return surfaceMod;
}

function update(dt) {
    if (weatherTransition < 1.0) {
        weatherTransition += dt / transitionDuration;
        if (weatherTransition >= 1.0) {
            weatherTransition = 1.0;
            previousWeather = currentWeather;
        }
    }
}

function setWeather(weatherKey) {
    if (weatherKey === currentWeather) return;
    if (!WEATHER_STATES[weatherKey]) return;
    previousWeather = currentWeather;
    currentWeather = weatherKey;
    weatherTransition = 0;
    console.log(`🌤️ Weather → ${WEATHER_STATES[weatherKey].label}`);
}

window.rallyWeather = {
    update: update,
    setWeather: setWeather,
    getWeatherGrip: getWeatherGrip,
    getCurrentWeather: function() { return WEATHER_STATES[currentWeather]; },
    getWeatherKey: function() { return currentWeather; },
    getDragMult: function() {
        let w = WEATHER_STATES[currentWeather];
        return w ? w.dragMult : 1.0;
    },
    getVisibility: function() {
        let w = WEATHER_STATES[currentWeather];
        return w ? w.visibility : 1.0;
    },
    STATES: WEATHER_STATES
};

})();
