// ============================================================
// golf-stubs.js — Stub functions for disabled golf modules
// Prevents "undefined" errors in arcade.html builder mode
// These can be removed once all golf HTML references are cleaned
// ============================================================
(function() {
'use strict';

// Stub: GolfBallPhysicsEngine (physics.js)
window.GolfPhysics = window.GolfPhysics || {
    init: function(){},
    simulateShot: function(){ return { carry:0, total:0, apex:0, landAngle:0, trajectory:[] }; },
    getTrajectory: function(){ return []; },
    reset: function(){}
};

// Stub: SwingEngine (arcade-swing-engine.js)
window.SwingEngine = window.SwingEngine || {
    selectClub: function(){},
    onTap: function(){},
    enableSwingMode: function(){},
    disableSwingMode: function(){},
    getSelectedClub: function(){ return 'DRIVER'; },
    isActive: function(){ return false; },
    onTouchStart: function(){},
    onTouchEnd: function(){}
};

// Stub: TracerEngine (arcade-tracer-engine.js)
window.TracerEngine = window.TracerEngine || {
    init: function(){},
    addTracer: function(){},
    clearTracers: function(){},
    update: function(){},
    setGlowBall: function(){}
};

// Stub: AudioEngine (arcade-audio-engine.js)
window.AudioEngine = window.AudioEngine || {
    init: function(){},
    playSwing: function(){},
    playImpact: function(){},
    playHoled: function(){},
    playApplause: function(){},
    playBounce: function(){},
    setVolume: function(){},
    toggleMute: function(){},
    isMuted: function(){ return true; }
};

// Stub: GolfEngine (arcade-game-core.js)
window.GolfEngine = window.GolfEngine || {
    init: function(){},
    startRound: function(){},
    recordStroke: function(){},
    getState: function(){ return {}; },
    isHoledOut: function(){ return false; },
    reset: function(){}
};

console.log('⚡ Golf stubs loaded — legacy modules disabled');
})();
