// ================================================================
//  LM BRIDGE — WebSocket connection to Launch Monitor hardware
//  Connects to ws://localhost:8081 (SkyTrak/GSPro bridge).
//  Auto-reconnects every 5s on disconnect.
//
//  Extracted from arcade.html — Compatibility contract:
//  - Calls window.triggerRealShot(data) on shot received
//  - Updates DOM: #lm-status-dot (color), #lm-status-text (text)
//  - Self-boots on load (initLaunchMonitorBridge called at bottom)
// ================================================================
(function() {
    function initLaunchMonitorBridge() {
        var ws = new WebSocket('ws://localhost:8081');
        var dot = document.getElementById('lm-status-dot');
        var txt = document.getElementById('lm-status-text');

        ws.onopen = function() {
            if(txt) txt.textContent = "LM Brygga Redo";
            if(dot) dot.style.background = "#eab308";
            // Tag input mode for leaderboard separation
            if (window.G) window.G.inputMode = 'LAUNCH_MONITOR';
            window.lmConnected = true;
        };
        ws.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);
                if (msg.type === 'status') {
                    if(txt) txt.textContent = msg.data.message;
                    if(dot) dot.style.background = msg.data.color;
                } else if (msg.type === 'shot') {
                    if(dot) {
                        dot.style.background = "#38bdf8";
                        setTimeout(() => dot.style.background = "#4ade80", 500);
                    }
                    msg.data.isLiveData = true; // Markera som LM-data så physics.js skippar virtuella lie-straff!
                    if (typeof window.triggerRealShot === 'function') {
                        window.triggerRealShot(msg.data);
                    }
                }
            } catch(e) {}
        };
        ws.onclose = function() {
            if(txt) txt.textContent = "LM Brygga Nere";
            if(dot) dot.style.background = "#ef4444";
            if (window.G) window.G.inputMode = 'SWING_METER';
            window.lmConnected = false;
            setTimeout(initLaunchMonitorBridge, 5000);
        };
    }

    // Boot:
    initLaunchMonitorBridge();
})();
