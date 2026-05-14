// ================================================================
//  PERLIN NOISE ENGINE — Golf-grade procedural terrain noise
//  Classic 2D Perlin + fBM (fractal Brownian Motion).
//  Self-contained, zero external dependencies.
//
//  Exposes:
//  - window.perlin2D(x, y) — raw 2D Perlin noise (-1 to 1)
//  - window.fbm(x, y, octaves, lacunarity, persistence) — layered fBM
//  - window.noisePatterns — { PERLIN, ROLLING, DUNES, MOUNDING, LINKS, ERODED }
//  - window.currentNoisePattern — active pattern key
//  - window.noiseScale — frequency/zoom control
//  - window.noiseAmplitude — max height in meters (0.1 - 3.0)
// ================================================================
(function() {
    const _perm = new Uint8Array(512);
    const _grad = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
    (function initPerlin() {
        let p = [];
        for(let i = 0; i < 256; i++) p[i] = i;
        for(let i = 255; i > 0; i--) { let j = Math.floor(Math.random() * (i+1)); [p[i], p[j]] = [p[j], p[i]]; }
        for(let i = 0; i < 512; i++) _perm[i] = p[i & 255];
    })();

    function perlin2D(x, y) {
        let xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
        let xf = x - Math.floor(x), yf = y - Math.floor(y);
        let u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
        let v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

        let aa = _perm[_perm[xi] + yi], ab = _perm[_perm[xi] + yi + 1];
        let ba = _perm[_perm[xi + 1] + yi], bb = _perm[_perm[xi + 1] + yi + 1];

        let g = _grad[aa & 7], x1 = g[0]*xf + g[1]*yf;
        g = _grad[ba & 7]; let x2 = g[0]*(xf-1) + g[1]*yf;
        let l1 = x1 + u * (x2 - x1);

        g = _grad[ab & 7]; x1 = g[0]*xf + g[1]*(yf-1);
        g = _grad[bb & 7]; x2 = g[0]*(xf-1) + g[1]*(yf-1);
        let l2 = x1 + u * (x2 - x1);

        return l1 + v * (l2 - l1); // Returns -1 to 1
    }

    // fBM — fractal Brownian Motion (layered octaves)
    function fbm(x, y, octaves, lacunarity, persistence) {
        let val = 0, amp = 1, freq = 1, max = 0;
        for(let i = 0; i < octaves; i++) {
            val += perlin2D(x * freq, y * freq) * amp;
            max += amp;
            amp *= persistence;
            freq *= lacunarity;
        }
        return val / max;
    }

    // Expose core functions for direct use
    window.perlin2D = perlin2D;
    window.fbm = fbm;

    // ================================================================
    //  NOISE PATTERNS — Optimized for golf course terrain
    // ================================================================
    window.noisePatterns = {

        // 🌊 PERLIN — Classic organic noise. Good general-purpose terrain.
        // Use: Rough areas, general terrain shaping
        PERLIN: (x, z) => fbm(x, z, 4, 2.0, 0.5),

        // 🏌️ ROLLING — Ultra-low frequency, smooth fairway undulations.
        // Two overlapping long-wavelength sine-like waves for natural feel.
        // Use: Fairway terrain, approach areas, large-scale elevation changes
        ROLLING: (x, z) => {
            let base = fbm(x * 0.4, z * 0.4, 2, 2.0, 0.6);   // Very slow base wave
            let detail = fbm(x, z, 2, 2.0, 0.3) * 0.25;        // Subtle surface detail
            return base + detail;
        },

        // 🏜️ DUNES — Elongated sand-dune terrain (stretched on one axis).
        // Use: Links-style holes, coastal terrain, waste areas
        DUNES: (x, z) => fbm(x * 0.5, z * 1.5, 3, 2.2, 0.45),

        // ⛳ MOUNDING — Discrete rounded mounds/bumps, widely spaced.
        // Soft positive-only bumps (never digs below surface).
        // Use: Spectator mounding around greens, collection areas, gentle terrain features
        MOUNDING: (x, z) => {
            let n = fbm(x * 1.2, z * 1.2, 2, 2.5, 0.5);
            // Soft positive clamp — creates rounded bumps, never valleys
            return Math.max(0, n) * Math.max(0, n) * 2.5;
        },

        // 🌬️ LINKS — Wind-swept coastal terrain with soft ridges and hollows.
        // Mix of gentle ridges + organic noise for authentic links character.
        // Use: Links-style courses, seaside holes, undulating rough
        LINKS: (x, z) => {
            let ridges = 1 - Math.abs(fbm(x * 0.8, z * 0.6, 3, 2.0, 0.5));
            let organic = fbm(x + 33, z + 77, 3, 2.0, 0.45);
            return ridges * 0.55 + organic * 0.45; // Blend: soft ridges + natural variation
        },

        // 🪨 ERODED — Weathered terrain with channels and worn features.
        // Use: Waste areas, rugged terrain borders, natural hazards
        ERODED: (x, z) => {
            let p = fbm(x, z, 5, 2.1, 0.45);
            let r = 1 - Math.abs(fbm(x + 50, z + 50, 3, 2.0, 0.5)) * 2;
            return p * 0.6 + r * 0.4;
        }
    };

    window.currentNoisePattern = 'PERLIN';
    window.noiseScale = 0.15;      // Controls frequency/zoom of noise
    window.noiseAmplitude = 1.0;   // Max height in meters (used by brush)
})();
