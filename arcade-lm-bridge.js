// ================================================================
//  LM BRIDGE — WebSocket connection to Launch Monitor hardware
//  Connects to ws://localhost:8081 (SkyTrak/GSPro bridge).
//  Auto-reconnects on disconnect (max 5 attempts).
//
//  Extracted from arcade.html — Compatibility contract:
//  - Calls window.triggerRealShot(data) on shot received
//  - Updates DOM: #lm-status-dot (color), #lm-status-text (text)
//  - Self-boots on load (initLaunchMonitorBridge called at bottom)
//  - Skips entirely in Rally mode (no golf swing needed)
// ================================================================
(function() {
    // Skip in Rally mode — no launch monitor needed
    var isRally = window.location.hash.indexOf('rally') >= 0
                || document.title.indexOf('Rally') >= 0
                || (window._gameMode && window._gameMode === 'RALLY');
    if (isRally) {
        window.lmConnected = false;
        return;
    }

    var _lmRetries = 0;
    var _lmMaxRetries = 5;
    function initLaunchMonitorBridge() {
        var ws = new WebSocket('ws://localhost:8081');
        var dot = document.getElementById('lm-status-dot');
        var txt = document.getElementById('lm-status-text');

        ws.onopen = function() {
            _lmRetries = 0; // Reset on successful connection
            if(txt) txt.textContent = "LM Brygga Redo";
            if(dot) dot.style.background = "#eab308";
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
                    msg.data.isLiveData = true;
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
            _lmRetries++;
            if (_lmRetries < _lmMaxRetries) {
                setTimeout(initLaunchMonitorBridge, 5000);
            }
        };
    }

    // Boot:
    initLaunchMonitorBridge();
})();
