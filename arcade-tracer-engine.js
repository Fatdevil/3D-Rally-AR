// ================================================================
//  TRACER STYLES & GLOW BALL ENGINE
//  Depends on: tracerMat, glowTracer, glowTracerMat (accessed via typeof)
//              window.ballMesh, window.ballGlowLight, window.currentTimeOfDay
//
//  Exposes:
//  - window.currentTracerStyle
//  - window.setTracerStyle(styleName)
//  - window.updateTracerForTimeOfDay(hour)
//  - window.getTracerVertexColor(vertexFn, index, total)
//  - window.TRACER_STYLES
// ================================================================
(function() {
    window.currentTracerStyle = 'CLASSIC';

    const TRACER_STYLES = {
        'CLASSIC':    { core: '#ffffff', glow: null,      glowInt: 0,   ballEmissive: null,      ballLight: false, vertexFn: null,      dashed: false, label: '⚪ Classic' },
        'NEON_GREEN': { core: '#00ff88', glow: '#00ff44', glowInt: 1.5, ballEmissive: '#00ff88', ballLight: true,  vertexFn: null,      dashed: false, label: '💚 Neon' },
        'NEON_PINK':  { core: '#ff00ff', glow: '#ff44ff', glowInt: 1.5, ballEmissive: '#ff44ff', ballLight: true,  vertexFn: null,      dashed: false, label: '💜 Pink' },
        'FIRE':       { core: '#ff8800', glow: '#ff4400', glowInt: 1.2, ballEmissive: '#ff6600', ballLight: true,  vertexFn: 'fire',    dashed: false, label: '🔥 Fire' },
        'ICE':        { core: '#44aaff', glow: '#2266ff', glowInt: 1.0, ballEmissive: '#4488ff', ballLight: true,  vertexFn: 'ice',     dashed: false, label: '❄️ Ice' },
        'RAINBOW':    { core: '#ffffff', glow: '#ffffff', glowInt: 0.8, ballEmissive: '#ffffff', ballLight: true,  vertexFn: 'rainbow', dashed: false, label: '🌈 Rainbow' },
        'PHANTOM':    { core: '#8888cc', glow: null,      glowInt: 0,   ballEmissive: null,      ballLight: false, vertexFn: 'fade',    dashed: false, label: '👻 Phantom' },
        'PRO_DOT':    { core: '#fbbf24', glow: null,      glowInt: 0,   ballEmissive: null,      ballLight: false, vertexFn: null,      dashed: true,  label: '📍 Pro Dot' },
        'OFF':        { core: '#000000', glow: null,      glowInt: 0,   ballEmissive: null,      ballLight: false, vertexFn: null,      dashed: false, label: '🚫 Off', hidden: true }
    };
    window.TRACER_STYLES = TRACER_STYLES;

    function hslToRgb(h, s, l) {
        let r, g, b;
        if (s === 0) { r = g = b = l; } else {
            let hue2rgb = (p, q, t) => { if(t<0)t+=1; if(t>1)t-=1; if(t<1/6) return p+(q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p+(q-p)*(2/3-t)*6; return p; };
            let q = l < 0.5 ? l*(1+s) : l+s-l*s; let p = 2*l-q;
            r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);
        }
        return [r, g, b];
    }

    window.getTracerVertexColor = function(vertexFn, index, total) {
        let t = index / Math.max(total, 1);
        switch(vertexFn) {
            case 'fire': return [1.0, Math.max(0, 1.0 - t * 1.5), 0];
            case 'ice':  return [0.2 + t * 0.8, 0.5 + t * 0.5, 1.0];
            case 'rainbow': {
                let hue = ((t * 360 + performance.now() * 0.05) % 360) / 360;
                return hslToRgb(hue, 1.0, 0.5);
            }
            case 'fade': return [0.53, 0.53, 0.8];
            default: return null;
        }
    };

    window.setTracerStyle = function(styleName) {
        let style = TRACER_STYLES[styleName];
        if (!style) return;
        window.currentTracerStyle = styleName;

        // T02 FIX: OFF style — hide tracer completely
        if (window.flightTracer) {
            window.flightTracer.visible = (styleName !== 'OFF');
        }

        // Core line — uses window.tracerMat set by arcade.html
        if (window.tracerMat) {
            window.tracerMat.color.set(style.core);
            window.tracerMat.vertexColors = !!style.vertexFn;
            // T02 FIX: Ensure opacity is correct (OFF gets 0, others get 0.9)
            window.tracerMat.opacity = (styleName === 'OFF') ? 0 : 0.9;
            window.tracerMat.needsUpdate = true;
        }

        // Glow overlay
        if (window.glowTracer) {
            if (style.glow && styleName !== 'OFF') {
                window.glowTracerMat.color.set(style.glow);
                window.glowTracer.visible = true;
                window.glowTracerMat.opacity = 0.3;
            } else {
                window.glowTracer.visible = false;
            }
            window.glowTracerMat.needsUpdate = true;
        }

        // T01 FIX: PRO_DOT dashed mode — swap material for real dashed lines
        if (window.flightTracer) {
            if (style.dashed) {
                if (!(window.flightTracer.material instanceof THREE.LineDashedMaterial)) {
                    let dashedMat = new THREE.LineDashedMaterial({
                        color: style.core, transparent: true, opacity: 0.9,
                        dashSize: 0.8, gapSize: 0.5, depthTest: false, depthWrite: false
                    });
                    window.flightTracer.material = dashedMat;
                    window.tracerMat = dashedMat;
                }
                window.flightTracer.computeLineDistances();
            } else if (window.flightTracer.material instanceof THREE.LineDashedMaterial) {
                // Switch back to solid LineBasicMaterial
                let solidMat = new THREE.LineBasicMaterial({
                    color: style.core, transparent: true, opacity: 0.9,
                    vertexColors: !!style.vertexFn, depthTest: false, depthWrite: false
                });
                window.flightTracer.material = solidMat;
                window.tracerMat = solidMat;
            }
        }

        // Ball skin
        applyBallSkin(style);

        // Update UI buttons
        document.querySelectorAll('.tracer-btn').forEach(b => b.style.outline = 'none');
        let activeBtn = document.getElementById('tracer-btn-' + styleName);
        if (activeBtn) activeBtn.style.outline = '2px solid #fff';

        // Sync with current TimeOfDay
        window.updateTracerForTimeOfDay(window.currentTimeOfDay || 12);
    };

    // ── Tracer fade-out after ball lands ──
    // tracerFadeMode: 'SOLID' = stays until next shot, 'FADE' = fades out after landing, 'OFF' = no tracer
    window.tracerFadeMode = 'FADE'; // Default: fade out
    window._tracerFadeTimer = -1; // -1 = not fading, 0+ = fading progress
    window._tracerBaseOpacity = 0.9;
    const FADE_DURATION = 180; // frames (~3 sec at 60fps)

    window.setTracerFadeMode = function(mode) {
        window.tracerFadeMode = mode;
        if (mode === 'OFF') {
            window.setTracerStyle('OFF');
        } else if (window.currentTracerStyle === 'OFF') {
            window.setTracerStyle('CLASSIC');
        }
        // Update toggle button text
        let btn = document.getElementById('btn-tracer-fade');
        if (btn) {
            if (mode === 'SOLID') { btn.innerText = '━ SOLID'; btn.style.background = '#4f46e5'; }
            else if (mode === 'FADE') { btn.innerText = '╌ FADE'; btn.style.background = '#0d9488'; }
            else { btn.innerText = '🚫 OFF'; btn.style.background = '#64748b'; }
        }
    };

    window.startTracerFade = function() {
        if (window.tracerFadeMode === 'FADE') {
            window._tracerFadeTimer = 0;
            window._tracerBaseOpacity = window.tracerMat ? window.tracerMat.opacity : 0.9;
        }
    };

    window.updateTracerFade = function() {
        if (window._tracerFadeTimer < 0) return;
        window._tracerFadeTimer++;
        let t = Math.min(window._tracerFadeTimer / FADE_DURATION, 1.0);
        let opacity = window._tracerBaseOpacity * (1.0 - t);
        if (window.tracerMat) window.tracerMat.opacity = opacity;
        if (window.glowTracerMat) window.glowTracerMat.opacity = opacity * 0.3;
        if (t >= 1.0) {
            window._tracerFadeTimer = -1;
            // Fully transparent — hide draw range
            if (window.tracerMat) window.tracerMat.opacity = 0;
        }
    };

    function applyBallSkin(style) {
        if (!window.ballMesh || !window.ballMesh.material) return;
        let mat = window.ballMesh.material;
        if (style.ballEmissive) {
            mat.emissive = new THREE.Color(style.ballEmissive);
            let nightFactor = (window.currentTimeOfDay < 6 || window.currentTimeOfDay > 19) ? 1.5 : 0.2;
            mat.emissiveIntensity = nightFactor;
        } else {
            mat.emissive = new THREE.Color(0x000000);
            mat.emissiveIntensity = 0;
        }
        mat.needsUpdate = true;
    }

    window.updateTracerForTimeOfDay = function(hour) {
        let nightFactor = 0;
        if (hour < 5 || hour > 20) nightFactor = 1.0;
        else if (hour < 7) nightFactor = 1.0 - (hour - 5) / 2;
        else if (hour > 18) nightFactor = (hour - 18) / 2;

        let style = TRACER_STYLES[window.currentTracerStyle || 'CLASSIC'];

        // Glow overlay
        if (window.glowTracer && window.glowTracerMat && style.glow) {
            window.glowTracerMat.opacity = 0.15 + nightFactor * 0.5;
            window.glowTracerMat.needsUpdate = true;
        }

        // Ball glow light
        if (window.ballGlowLight) {
            window.ballGlowLight.intensity = nightFactor * (style.glowInt || 0) * 2.0;
            if (style.ballEmissive) window.ballGlowLight.color.set(style.ballEmissive);
        }

        // Ball emissive
        if (window.ballMesh && window.ballMesh.material && style.ballEmissive) {
            window.ballMesh.material.emissiveIntensity = 0.1 + nightFactor * 1.5;
            window.ballMesh.material.needsUpdate = true;
        }
    };
})();
