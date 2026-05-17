// ================================================================
// terrain-shader-utils.js — PHASE 2: Procedural texture generators
// Loaded before terrain-shader-material.js and terrain-shader-geo.js
// All functions exposed via window.terrainShaderUtils
// ================================================================
(function () {
    'use strict';

    // ── Seeded noise (deterministic, no Math.random dependency) ──────────────
    function seededRandom(seed) {
        const x = Math.sin(seed + 1) * 43758.5453;
        return x - Math.floor(x);
    }

    // Bilinear-interpolated 2-D smooth noise
    function smoothNoise(x, y) {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = x - ix, fy = y - iy;
        // Smoothstep for less blocky result
        const ux = fx * fx * (3 - 2 * fx);
        const uy = fy * fy * (3 - 2 * fy);
        const a = seededRandom(ix      + iy       * 57);
        const b = seededRandom(ix + 1  + iy       * 57);
        const c = seededRandom(ix      + (iy + 1) * 57);
        const d = seededRandom(ix + 1  + (iy + 1) * 57);
        return a * (1 - ux) * (1 - uy)
             + b * ux * (1 - uy)
             + c * (1 - ux) * uy
             + d * ux * uy;
    }

    // Multi-octave FBM (Fractal Brownian Motion)
    function fbm(x, y, octaves) {
        let val = 0, amp = 0.5, freq = 1, max = 0;
        for (let i = 0; i < octaves; i++) {
            val += smoothNoise(x * freq, y * freq) * amp;
            max += amp;
            amp  *= 0.5;
            freq *= 2.1;
        }
        return val / max; // normalise 0..1
    }

    // Parse '#RRGGBB' → [r,g,b] 0-255
    function hexToRgb(hex) {
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)
        ];
    }

    // Pick a colour from a weighted palette using a 0-1 noise value
    function weightedColor(palette, t) {
        let cum = 0;
        for (const entry of palette) {
            cum += entry.weight;
            if (t < cum) return entry.hex;
        }
        return palette[palette.length - 1].hex;
    }

    // Fill a canvas pixel by pixel with a palette + noise
    function fillNoiseCanvas(ctx, w, h, palette, freqX, freqY) {
        const imgData = ctx.createImageData(w, h);
        const px = imgData.data;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const t   = fbm(x * freqX, y * freqY, 4);
                const rgb = hexToRgb(weightedColor(palette, t));
                const i   = (y * w + x) * 4;
                px[i]     = rgb[0];
                px[i + 1] = rgb[1];
                px[i + 2] = rgb[2];
                px[i + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
    }

    // ── Shared canvas factory ─────────────────────────────────────────────────
    function makeCanvas(size) {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        return { c, ctx: c.getContext('2d') };
    }

    function makeTexture(canvas, repeatX, repeatY) {
        const t   = new THREE.CanvasTexture(canvas);
        t.wrapS   = THREE.RepeatWrapping;
        t.wrapT   = THREE.RepeatWrapping;
        t.repeat.set(repeatX || 12, repeatY || 12);
        t.needsUpdate = true;
        return t;
    }

    // ── Neutral normal map (flat surface — rgb 128,128,255) ──────────────────
    function generateNeutralNormal(size) {
        const { c, ctx } = makeCanvas(size || 64);
        ctx.fillStyle = 'rgb(128,128,255)';
        ctx.fillRect(0, 0, c.width, c.height);
        return makeTexture(c, 1, 1);
    }

    // ── GRAVEL textures ───────────────────────────────────────────────────────
    const GRAVEL_PALETTE = [
        { hex: '#847864', weight: 0.35 },  // mid-tone beige — dominant
        { hex: '#6E6354', weight: 0.30 },  // warm brown
        { hex: '#A69B86', weight: 0.20 },  // light sandy
        { hex: '#BDB4A1', weight: 0.10 },  // pale stone
        { hex: '#4B423A', weight: 0.05 },  // dark accent only
    ];

    function generateGravelAlbedo() {
        const SIZE = 256;
        const { c, ctx } = makeCanvas(SIZE);

        // Layer 1: base colour from palette + FBM
        fillNoiseCanvas(ctx, SIZE, SIZE, GRAVEL_PALETTE, 0.04, 0.04);

        // Layer 2: broad luminance variation — source-over (no multiply!)
        ctx.globalCompositeOperation = 'source-over';
        const imgV = ctx.createImageData(SIZE, SIZE);
        const pxV  = imgV.data;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const n = smoothNoise(x * 0.015, y * 0.015);
                // Gentle brightness variation: darken slightly in valleys, lighten on peaks
                const dark = n < 0.5;
                const v = dark ? 0 : 255;
                const a = Math.abs(n - 0.5) * 0.15 * 255 | 0;  // max ~7.5% opacity
                const i = (y * SIZE + x) * 4;
                pxV[i] = pxV[i+1] = pxV[i+2] = v;
                pxV[i+3] = a;
            }
        }
        // Apply as overlay via putImageData + drawImage
        const tempC = document.createElement('canvas');
        tempC.width = tempC.height = SIZE;
        const tempCtx = tempC.getContext('2d');
        tempCtx.putImageData(imgV, 0, 0);
        ctx.globalAlpha = 1.0;
        ctx.drawImage(tempC, 0, 0);

        // Layer 3: stones — subtle lighter/darker spots (not dark-only)
        for (let i = 0; i < 30; i++) {
            const sx = seededRandom(i * 7 + 1) * SIZE;
            const sy = seededRandom(i * 7 + 2) * SIZE;
            const r  = 3 + seededRandom(i * 7 + 3) * 8;
            const rot = seededRandom(i * 7 + 4) * Math.PI;
            const bright = seededRandom(i * 7 + 5) > 0.5;
            const col = bright ? 'rgba(200,190,170,0.25)' : 'rgba(60,52,44,0.20)';
            const g  = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
            g.addColorStop(0,   col);
            g.addColorStop(0.7, col.replace(/[\d.]+\)$/, '0.08)'));
            g.addColorStop(1,   'rgba(0,0,0,0)');
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(rot);
            ctx.scale(1, 0.65);
            ctx.translate(-sx, -sy);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Layer 4: subtle wheel tracks — very light darkening only
        const trk = ctx.createLinearGradient(0, 0, SIZE, 0);
        trk.addColorStop(0,    'rgba(60,50,40,0)');
        trk.addColorStop(0.22, 'rgba(60,50,40,0.08)');
        trk.addColorStop(0.32, 'rgba(60,50,40,0)');
        trk.addColorStop(0.68, 'rgba(60,50,40,0)');
        trk.addColorStop(0.78, 'rgba(60,50,40,0.08)');
        trk.addColorStop(1,    'rgba(60,50,40,0)');
        ctx.fillStyle = trk;
        ctx.fillRect(0, 0, SIZE, SIZE);

        ctx.globalCompositeOperation = 'source-over';
        return makeTexture(c, 12, 12);
    }

    function generateGravelRoughness() {
        const SIZE = 256;
        const { c, ctx } = makeCanvas(SIZE);
        const img = ctx.createImageData(SIZE, SIZE);
        const px  = img.data;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                // Loose gravel edge ≈ 0.85, packed track center ≈ 0.55
                const n = 0.60 + fbm(x * 0.06, y * 0.06, 3) * 0.30;
                const v = n * 255 | 0;
                const i = (y * SIZE + x) * 4;
                px[i] = px[i+1] = px[i+2] = v;
                px[i+3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        const t = makeTexture(c, 12, 12);
        t.generateMipmaps = true;
        return t;
    }

    function generateGravelAO() {
        const SIZE = 256;
        const { c, ctx } = makeCanvas(SIZE);
        // Start light grey
        ctx.fillStyle = '#cccccc';
        ctx.fillRect(0, 0, SIZE, SIZE);
        // Cavity shadow at each stone (same seeded positions as albedo)
        for (let i = 0; i < 30; i++) {
            const sx = seededRandom(i * 7 + 1) * SIZE;
            const sy = seededRandom(i * 7 + 2) * SIZE;
            const r  = 5 + seededRandom(i * 7 + 3) * 10;
            const g  = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
            g.addColorStop(0,   'rgba(70,58,48,0.70)');
            g.addColorStop(0.5, 'rgba(70,58,48,0.25)');
            g.addColorStop(1,   'rgba(70,58,48,0)');
            ctx.fillStyle = g;
            // FIX A2: removed dead getImageData call (DOMException on negative coords)
            ctx.globalCompositeOperation = 'multiply';
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        return makeTexture(c, 12, 12);
    }

    // ── GRASS textures ────────────────────────────────────────────────────────
    const GRASS_PALETTE = [
        { hex: '#2d5a1b', weight: 0.30 },
        { hex: '#3a6e24', weight: 0.35 },
        { hex: '#4a7c2b', weight: 0.25 },
        { hex: '#6b9e3f', weight: 0.10 },
    ];

    function generateGrassAlbedo() {
        const SIZE = 256;
        const { c, ctx } = makeCanvas(SIZE);
        fillNoiseCanvas(ctx, SIZE, SIZE, GRASS_PALETTE, 0.07, 0.07);
        // Subtle blade streaks
        ctx.globalAlpha = 0.08;
        for (let i = 0; i < 60; i++) {
            const x0 = seededRandom(i * 5 + 10) * SIZE;
            const y0 = seededRandom(i * 5 + 11) * SIZE;
            const len = 4 + seededRandom(i * 5 + 12) * 10;
            const ang = (seededRandom(i * 5 + 13) - 0.5) * 0.8;
            ctx.strokeStyle = '#1e3d10';
            ctx.lineWidth   = 0.8;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x0 + Math.sin(ang) * len, y0 - Math.cos(ang) * len);
            ctx.stroke();
        }
        ctx.globalAlpha = 1.0;
        return makeTexture(c, 8, 8);
    }

    // ── ROCK textures ─────────────────────────────────────────────────────────
    const ROCK_PALETTE = [
        { hex: '#5F5E5A', weight: 0.40 },
        { hex: '#6E6D69', weight: 0.30 },
        { hex: '#888780', weight: 0.20 },
        { hex: '#9B9A93', weight: 0.10 },
    ];

    function generateRockAlbedo() {
        const SIZE = 256;
        const { c, ctx } = makeCanvas(SIZE);
        fillNoiseCanvas(ctx, SIZE, SIZE, ROCK_PALETTE, 0.035, 0.035);
        // Crack lines
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = '#3a3835';
        ctx.lineWidth   = 0.6;
        for (let i = 0; i < 12; i++) {
            ctx.beginPath();
            let x = seededRandom(i * 9 + 20) * SIZE;
            let y = seededRandom(i * 9 + 21) * SIZE;
            ctx.moveTo(x, y);
            for (let s = 0; s < 4; s++) {
                x += (seededRandom(i * 9 + s * 2 + 22) - 0.5) * 40;
                y += (seededRandom(i * 9 + s * 2 + 23) - 0.5) * 20;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 1.0;
        return makeTexture(c, 6, 6);
    }

    // ── MOSS texture ──────────────────────────────────────────────────────────
    const MOSS_PALETTE = [
        { hex: '#3E5F25', weight: 0.45 },
        { hex: '#526E30', weight: 0.35 },
        { hex: '#6E8F4E', weight: 0.20 },
    ];

    function generateMossAlbedo() {
        const SIZE = 128;
        const { c, ctx } = makeCanvas(SIZE);
        fillNoiseCanvas(ctx, SIZE, SIZE, MOSS_PALETTE, 0.10, 0.10);
        return makeTexture(c, 9, 9);
    }

    // ── TARMAC texture ────────────────────────────────────────────────────────
    const TARMAC_PALETTE = [
        { hex: '#2a2926', weight: 0.50 },
        { hex: '#363430', weight: 0.30 },
        { hex: '#444240', weight: 0.15 },
        { hex: '#595755', weight: 0.05 },
    ];

    function generateTarmacAlbedo() {
        const SIZE = 256;
        const { c, ctx } = makeCanvas(SIZE);
        fillNoiseCanvas(ctx, SIZE, SIZE, TARMAC_PALETTE, 0.05, 0.05);
        // Aggregate stones — light specks
        ctx.globalAlpha = 0.30;
        for (let i = 0; i < 80; i++) {
            const sx = seededRandom(i * 3 + 50) * SIZE;
            const sy = seededRandom(i * 3 + 51) * SIZE;
            const r  = 0.5 + seededRandom(i * 3 + 52) * 1.5;
            ctx.fillStyle = '#888680';
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1.0;
        return makeTexture(c, 10, 10);
    }

    // ── Public generatePlaceholderTextures() ─────────────────────────────────
    function generatePlaceholderTextures() {
        console.log('🎨 Generating procedural terrain textures...');
        const t = {
            gravel_alb: generateGravelAlbedo(),
            gravel_rgh: generateGravelRoughness(),
            gravel_ao:  generateGravelAO(),
            gravel_nrm: generateNeutralNormal(64),  // replaced by real normal later
            grass_alb:  generateGrassAlbedo(),
            grass_nrm:  generateNeutralNormal(64),
            rock_alb:   generateRockAlbedo(),
            rock_nrm:   generateNeutralNormal(64),
            moss_alb:   generateMossAlbedo(),
            tarmac_alb: generateTarmacAlbedo(),
            tarmac_nrm: generateNeutralNormal(64),
        };
        console.log('🎨 Procedural textures ready (' + Object.keys(t).length + ' maps)');
        return t;
    }

    // ── Expose namespace ──────────────────────────────────────────────────────
    window.terrainShaderUtils = {
        seededRandom,
        smoothNoise,
        fbm,
        hexToRgb,
        weightedColor,
        generatePlaceholderTextures,
        // Palettes exposed for external use
        GRAVEL_PALETTE,
        GRASS_PALETTE,
        ROCK_PALETTE,
        MOSS_PALETTE,
        TARMAC_PALETTE,
    };

})();
