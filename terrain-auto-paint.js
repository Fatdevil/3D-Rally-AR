// ================================================================
// terrain-auto-paint.js — Slope/Height-based Natural Terrain Coloring
// Paints rock, cliff, dirt, peak colors on the biome canvas based on
// terrain slope and height analysis. Uses arcade-perlin.js fbm().
// Zero shader dependencies — works with MeshLambertMaterial pipeline.
// Exposes: window.terrainAutoPaint
// ================================================================
(function () {
    'use strict';

    // ── Presets — biome-adaptive terrain palettes ─────────────────────────────
    const PRESETS = {
        NORDIC:  { dirt: '#A09060', rock: '#7A7A6E', cliff: '#656059', peak: '#95908A', name: '🌲 Nordisk' },
        ALPINE:  { dirt: '#9B8B70', rock: '#8A8478', cliff: '#706860', peak: '#C0B8A8', name: '🏔️ Alpin' },
        DESERT:  { dirt: '#C4A870', rock: '#B89E78', cliff: '#8B7355', peak: '#D4C4A0', name: '🏜️ Öken' },
        VOLCANO: { dirt: '#6B5E50', rock: '#4A4540', cliff: '#2D2825', peak: '#5A5550', name: '🌋 Vulkan' },
        FOREST:  { dirt: '#708A4D', rock: '#3E5D2A', cliff: '#1E3618', peak: '#90A872', name: '🌲 Grönskande kulle' },
        HEATHER: { dirt: '#8C866B', rock: '#596643', cliff: '#323D25', peak: '#9E8394', name: '🪻 Ljung & Hed' },
        JUNGLE:  { dirt: '#608038', rock: '#2A521E', cliff: '#0E250A', peak: '#85AD42', name: '🌴 Djungel' },
    };

    // ── Helpers ───────────────────────────────────────────────────────────────
    function hexToRGB(hex) {
        return [
            parseInt(hex.slice(1, 3), 16),
            parseInt(hex.slice(3, 5), 16),
            parseInt(hex.slice(5, 7), 16)
        ];
    }

    function colorDistSq(r1, g1, b1, r2, g2, b2) {
        return (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function smoothstep(edge0, edge1, x) {
        const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    }

    // ── Build heightmap cache (512×512) for fast slope computation ────────────
    function buildHeightMap(getHeight, terrainSize, hmSize) {
        const hm = new Float32Array(hmSize * hmSize);
        for (let y = 0; y < hmSize; y++) {
            for (let x = 0; x < hmSize; x++) {
                const wx = (x / hmSize - 0.5) * terrainSize;
                const wz = (y / hmSize - 0.5) * terrainSize;
                hm[y * hmSize + x] = getHeight(wx, wz) || 0;
            }
        }
        return hm;
    }

    // ── Sample heightmap with bilinear interpolation ─────────────────────────
    function sampleHM(hm, hmSize, u, v) {
        const fx = u * (hmSize - 1);
        const fy = v * (hmSize - 1);
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const dx = fx - ix;
        const dy = fy - iy;
        const ix1 = Math.min(ix + 1, hmSize - 1);
        const iy1 = Math.min(iy + 1, hmSize - 1);
        const h00 = hm[iy * hmSize + ix];
        const h10 = hm[iy * hmSize + ix1];
        const h01 = hm[iy1 * hmSize + ix];
        const h11 = hm[iy1 * hmSize + ix1];
        return h00 * (1 - dx) * (1 - dy) + h10 * dx * (1 - dy) +
               h01 * (1 - dx) * dy + h11 * dx * dy;
    }

    // ── Compute slope from heightmap at UV coordinate ────────────────────────
    function computeSlope(hm, hmSize, u, v, terrainSize) {
        const step = 1.0 / hmSize;
        const hL = sampleHM(hm, hmSize, Math.max(0, u - step), v);
        const hR = sampleHM(hm, hmSize, Math.min(1, u + step), v);
        const hU = sampleHM(hm, hmSize, u, Math.max(0, v - step));
        const hD = sampleHM(hm, hmSize, u, Math.min(1, v + step));
        const worldStep = terrainSize / hmSize;
        const dzdx = (hR - hL) / (2 * worldStep);
        const dzdy = (hD - hU) / (2 * worldStep);
        return Math.sqrt(dzdx * dzdx + dzdy * dzdy);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  MAIN: paintNaturalTerrain
    // ══════════════════════════════════════════════════════════════════════════
    function paintNaturalTerrain(options) {
        options = options || {};
        const pCtx        = window.pCtx || window._arcadePCtx;
        const mapTex      = window.mapTex || window._arcadeMapTex;
        const getHeight   = window.getTerrainHeight;
        const terrainSize = window.TERRAIN_SIZE || 900;
        const fbm         = window.fbm;  // from arcade-perlin.js

        if (!pCtx || !mapTex || !getHeight) {
            console.warn('🏔️ terrainAutoPaint: missing pCtx, mapTex, or getTerrainHeight');
            return;
        }
        if (!fbm) {
            console.warn('🏔️ terrainAutoPaint: missing window.fbm (arcade-perlin.js)');
            return;
        }

        // ── Undo support ─────────────────────────────────────────────────────
        if (typeof window.pushUndoState === 'function') {
            window.pushUndoState();
        }

        const preset   = PRESETS[options.preset || 'NORDIC'] || PRESETS.NORDIC;
        const canvasW  = pCtx.canvas.width;
        const canvasH  = pCtx.canvas.height;

        // ── Read terrain colors from BIOME CONFIG (not presets!) ─────────────
        // This ensures recolorTerrain can correctly remap these pixels on biome switch
        const biome = window.CURRENT_BIOME_CONFIG;
        const grassHex = (biome && biome.roughColor) || '#4a782b';
        const grassRGB = hexToRGB(grassHex);
        const protectThreshold = options.protectThreshold || 3500; // color dist² max

        // ── Use PRESET colors (biome-independent) for terrain painting ────
        // These are fixed, season-proof colors that won't shift with biome changes.
        // The recolorTerrain function in arcade.html will skip these pixels
        // because they don't match any golf-surface color.
        const dirtRGB  = hexToRGB(preset.dirt);
        const rockRGB  = hexToRGB(preset.rock);
        const cliffRGB = hexToRGB(preset.cliff);
        const peakRGB  = hexToRGB(preset.peak);

        // ── Slope/height thresholds (configurable) ───────────────────────────
        const slopeDirt  = options.slopeDirt  || 0.30;
        const slopeRock  = options.slopeRock  || 0.50;
        const slopeCliff = options.slopeCliff || 0.70;
        let   peakHeight = options.peakHeight || 20.0;  // will be overridden for tall mountains
        const minHeight  = options.minHeight  || 2.0;  // skip flat ground

        console.log('🏔️ Auto-terrain paint: preset=' + (options.preset || 'NORDIC') +
                    ', canvas=' + canvasW + '×' + canvasH);
        const t0 = performance.now();

        // ── Step 1: Build heightmap cache ─────────────────────────────────────
        const HM_SIZE = 512;
        const hm = buildHeightMap(getHeight, terrainSize, HM_SIZE);

        // ── Step 1b: Aim Point → flood-fill mountain mask ─────────────────────
        // If aimPoint is given, flood-fill from click to find connected mountain
        let mtnMaxH = 0; // Declared OUTSIDE if-block so dynamic peak height works
        let mountainMask = null;
        if (options.aimPoint) {
            const ap = options.aimPoint; // { x, z } in world coords
            // Convert world → heightmap index
            const hmX = Math.round(((ap.x / terrainSize) + 0.5) * (HM_SIZE - 1));
            const hmZ = Math.round(((ap.z / terrainSize) + 0.5) * (HM_SIZE - 1));
            const startIdx = Math.max(0, Math.min(HM_SIZE - 1, hmZ)) * HM_SIZE +
                             Math.max(0, Math.min(HM_SIZE - 1, hmX));
            const startH = hm[startIdx];
            // Flood fill threshold: use minHeight to capture the entire mountain base.
            // The mask is generous — slope logic handles the visual fadeout.
            const floodThresh = minHeight;  // typically 2m — captures everything above flat ground
            mountainMask = new Uint8Array(HM_SIZE * HM_SIZE);
            const stack = [startIdx];
            mountainMask[startIdx] = 1;
            while (stack.length > 0) {
                const idx = stack.pop();
                const ix = idx % HM_SIZE;
                const iz = (idx - ix) / HM_SIZE;
                const neighbors = [
                    iz > 0 ? idx - HM_SIZE : -1,           // north
                    iz < HM_SIZE - 1 ? idx + HM_SIZE : -1, // south
                    ix > 0 ? idx - 1 : -1,                 // west
                    ix < HM_SIZE - 1 ? idx + 1 : -1        // east
                ];
                for (let n = 0; n < 4; n++) {
                    const ni = neighbors[n];
                    if (ni < 0 || mountainMask[ni]) continue;
                    if (hm[ni] >= floodThresh) {
                        mountainMask[ni] = 1;
                        stack.push(ni);
                    }
                }
            }
            // Count mountain pixels & find max height for dynamic peak threshold
            let mtnPx = 0;
            for (let i = 0; i < mountainMask.length; i++) {
                if (mountainMask[i]) {
                    mtnPx++;
                    if (hm[i] > mtnMaxH) mtnMaxH = hm[i];
                }
            }
            console.log('🎯 Mountain detected: ' + mtnPx + ' heightmap pixels, threshold=' +
                        floodThresh.toFixed(1) + 'm, click height=' + startH.toFixed(1) + 'm, max=' + mtnMaxH.toFixed(1) + 'm');
        }

        // ── Dynamic peak height: user-controlled via Peak Coverage slider ──────
        // _mtnPeakRatio controls how high up the peak color starts (lower = more peak)
        if (mountainMask && typeof mtnMaxH !== 'undefined' && mtnMaxH > peakHeight) {
            const peakRatio = window._mtnPeakRatio || 0.45;
            peakHeight = mtnMaxH * peakRatio;
            console.log('🏔️ Dynamic peakHeight: ' + peakHeight.toFixed(1) + 'm (' + Math.round(peakRatio*100) + '% of ' + mtnMaxH.toFixed(1) + 'm)');
        }

        // ── Step 2: Process canvas pixels ─────────────────────────────────────
        const imgData = pCtx.getImageData(0, 0, canvasW, canvasH);
        const px = imgData.data;
        let painted = 0;

        for (let cy = 0; cy < canvasH; cy++) {
            const v = cy / canvasH;  // 0..1 UV

            for (let cx = 0; cx < canvasW; cx++) {
                const u = cx / canvasW;  // 0..1 UV
                const offset = (cy * canvasW + cx) * 4;

                // ── Mountain mask filter (Aim Point mode) ─────────────────
                let maskBlend = 1.0; // 1.0 = fully inside mountain
                if (mountainMask) {
                    // Map canvas pixel → heightmap (with feathered edge)
                    const hmFx = u * (HM_SIZE - 1);
                    const hmFz = v * (HM_SIZE - 1);
                    const hmX = Math.round(hmFx);
                    const hmZ = Math.round(hmFz);
                    const hmIdx = hmZ * HM_SIZE + hmX;
                    if (!mountainMask[hmIdx]) continue; // not on this mountain
                    
                    // Feather: check neighbors to detect edge pixels
                    let neighbors = 0;
                    let total = 0;
                    for (let dy = -4; dy <= 4; dy++) {
                        for (let dx = -4; dx <= 4; dx++) {
                            const nx = hmX + dx;
                            const nz = hmZ + dy;
                            if (nx >= 0 && nx < HM_SIZE && nz >= 0 && nz < HM_SIZE) {
                                total++;
                                if (mountainMask[nz * HM_SIZE + nx]) neighbors++;
                            }
                        }
                    }
                    maskBlend = neighbors / total; // 0.0–1.0, soft at edges
                } else if (!options.overwriteAll) {
                    // Normal mode: protect already-painted terrain + non-grass colors
                    const pr = px[offset], pg = px[offset + 1], pb = px[offset + 2];
                    const isRock  = colorDistSq(pr, pg, pb, rockRGB[0],  rockRGB[1],  rockRGB[2])  < 2000;
                    const isCliff = colorDistSq(pr, pg, pb, cliffRGB[0], cliffRGB[1], cliffRGB[2]) < 2000;
                    const isDirt  = colorDistSq(pr, pg, pb, dirtRGB[0],  dirtRGB[1],  dirtRGB[2])  < 2000;
                    const isPeak  = colorDistSq(pr, pg, pb, peakRGB[0],  peakRGB[1],  peakRGB[2])  < 2000;
                    if (isRock || isCliff || isDirt || isPeak) continue;

                    const isGrass = colorDistSq(pr, pg, pb, grassRGB[0], grassRGB[1], grassRGB[2]) < protectThreshold;
                    if (!isGrass) continue;
                }

                // ── Sample height and slope ──────────────────────────────────
                const height = sampleHM(hm, HM_SIZE, u, v);
                const slope  = computeSlope(hm, HM_SIZE, u, v, terrainSize);

                // ── Noise-modulated thresholds (breaks up ring) ──────────────
                const edgeNoise = fbm(cx * 0.2, cy * 0.2, 3, 2.0, 0.5);  // visible at mountain scale
                const localDirt  = slopeDirt + edgeNoise * 0.22;  // ±0.22 = very ragged grass→rock edge
                const localRock  = slopeRock + edgeNoise * 0.14;
                const localCliff = slopeCliff + edgeNoise * 0.08;

                // ── Height-based fade: low areas keep more grass ─────────────
                const heightFade = smoothstep(2.0, 8.0, height);

                // ── Noise-modulated peak line (breaks up the straight band) ──
                const edgeRoughness = window._mtnEdgeRoughness || 5.0;
                const peakNoise = fbm(cx * 0.08, cy * 0.08, 3, 2.0, 0.5);
                const localPeakHeight = peakHeight + peakNoise * edgeRoughness;

                // ── Skip flat/low terrain ────────────────────────────────────
                if (slope < localDirt && height < localPeakHeight) continue;

                // ── Determine zone and blend ─────────────────────────────────
                let zoneR, zoneG, zoneB;
                
                // Read ACTUAL pixel color for edge blending (not hardcoded grass)
                const existR = px[offset], existG = px[offset + 1], existB = px[offset + 2];

                if (height >= localPeakHeight) {
                    const peakBlend = smoothstep(localPeakHeight - 3, localPeakHeight + 3, height);
                    if (slope >= localDirt) {
                        zoneR = peakRGB[0]; zoneG = peakRGB[1]; zoneB = peakRGB[2];
                    } else {
                        zoneR = lerp(dirtRGB[0], peakRGB[0], peakBlend);
                        zoneG = lerp(dirtRGB[1], peakRGB[1], peakBlend);
                        zoneB = lerp(dirtRGB[2], peakRGB[2], peakBlend);
                    }
                } else if (slope >= localCliff) {
                    zoneR = cliffRGB[0]; zoneG = cliffRGB[1]; zoneB = cliffRGB[2];
                } else if (slope >= localRock) {
                    const t = smoothstep(localRock - 0.08, localCliff + 0.08, slope);
                    zoneR = lerp(rockRGB[0], cliffRGB[0], t);
                    zoneG = lerp(rockRGB[1], cliffRGB[1], t);
                    zoneB = lerp(rockRGB[2], cliffRGB[2], t);
                } else {
                    // Transition zone — existing terrain → earth
                    const t = smoothstep(localDirt - 0.05, localRock + 0.05, slope);
                    zoneR = lerp(existR, dirtRGB[0], t);
                    zoneG = lerp(existG, dirtRGB[1], t);
                    zoneB = lerp(existB, dirtRGB[2], t);
                }

                // ── Edge blend: existing terrain → zone (smooth transition at mountain foot)
                if (slope < localDirt + 0.15 && height < peakHeight) {
                    const edgeBlend = smoothstep(localDirt - 0.08, localDirt + 0.15, slope);
                    const finalBlend = edgeBlend * heightFade;
                    zoneR = lerp(existR, zoneR, finalBlend);
                    zoneG = lerp(existG, zoneG, finalBlend);
                    zoneB = lerp(existB, zoneB, finalBlend);
                }

                // ── Apply flammig noise variation ─────────────────────────────
                const n1 = fbm(cx * 0.12, cy * 0.12, 3, 2.0, 0.5);   // coarse
                const n2 = fbm(cx * 0.45, cy * 0.45, 2, 2.0, 0.5);   // fine
                const noiseR = n1 * 18 + n2 * 7;
                const noiseG = n1 * 16 + n2 * 6;
                const noiseB = n1 * 13 + n2 * 5;

                px[offset]     = Math.max(0, Math.min(255, Math.round(zoneR + noiseR)));
                px[offset + 1] = Math.max(0, Math.min(255, Math.round(zoneG + noiseG)));
                px[offset + 2] = Math.max(0, Math.min(255, Math.round(zoneB + noiseB)));
                
                // Apply mask feather at mountain edges (blend with existing pixel)
                if (maskBlend < 1.0) {
                    px[offset]     = Math.round(lerp(existR, px[offset],     maskBlend));
                    px[offset + 1] = Math.round(lerp(existG, px[offset + 1], maskBlend));
                    px[offset + 2] = Math.round(lerp(existB, px[offset + 2], maskBlend));
                }
                
                // Alpha unchanged (255)
                painted++;
            }
        }

        // ── Step 3: Commit to canvas ──────────────────────────────────────────
        pCtx.putImageData(imgData, 0, 0);
        mapTex.needsUpdate = true;

        // Update terrainBiomeData cache if it exists
        if (window.terrainBiomeData) {
            const fresh = pCtx.getImageData(0, 0, canvasW, canvasH).data;
            if (window.terrainBiomeData.length === fresh.length) {
                window.terrainBiomeData.set(fresh);
            } else {
                window.terrainBiomeData = fresh;
            }
        }

        // Update road base snapshot so roads survive after auto-paint
        if (window.roadSystem && typeof window.roadSystem.updateBaseAfterPaint === 'function') {
            window.roadSystem.updateBaseAfterPaint();
        }

        // Mark that auto-paint was used (changeBiome will re-run after recolorTerrain)
        window._terrainAutoPainted = true;

        const ms = (performance.now() - t0).toFixed(0);
        const areaInfo = (options.center && options.radius > 0)
            ? ' (target r=' + Math.round(options.radius) + 'm)'
            : ' (full terrain)';
        console.log('🏔️ Auto-terrain paint done: ' + painted + ' pixels in ' + ms + 'ms' + areaInfo);
        if (window.showBuildToast) {
            window.showBuildToast('🏔️ Mountain painted (' + ms + 'ms)', '#7A7A6E');
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  NOISY BRUSH — For manual painting with rock/cliff/earth
    // ══════════════════════════════════════════════════════════════════════════
    function paintNoisyBrush(ctx, centerX, centerY, radius, baseHex, shape) {
        const fbm = window.fbm;
        if (!fbm) return false;

        const rgb = hexToRGB(baseHex);
        const r = Math.ceil(radius);
        const x0 = Math.max(0, Math.floor(centerX - r));
        const y0 = Math.max(0, Math.floor(centerY - r));
        const x1 = Math.min(ctx.canvas.width,  Math.ceil(centerX + r));
        const y1 = Math.min(ctx.canvas.height, Math.ceil(centerY + r));
        const w = x1 - x0;
        const h = y1 - y0;
        if (w <= 0 || h <= 0) return false;

        const imgData = ctx.getImageData(x0, y0, w, h);
        const px = imgData.data;
        const rSq = radius * radius;

        for (let py = 0; py < h; py++) {
            for (let px2 = 0; px2 < w; px2++) {
                const worldX = x0 + px2;
                const worldY = y0 + py;
                const dx = worldX - centerX;
                const dy = worldY - centerY;

                // Shape test
                let inside;
                if (shape === 'SQUARE') {
                    inside = Math.abs(dx) <= radius && Math.abs(dy) <= radius;
                } else {
                    inside = (dx * dx + dy * dy) <= rSq;
                }
                if (!inside) continue;

                // Noise variation
                const n = fbm(worldX * 0.3, worldY * 0.3, 3, 2.0, 0.5);
                const fine = fbm(worldX * 0.8, worldY * 0.8, 2, 2.0, 0.5);
                const offset = (py * w + px2) * 4;
                px[offset]     = Math.max(0, Math.min(255, rgb[0] + Math.round(n * 15 + fine * 6)));
                px[offset + 1] = Math.max(0, Math.min(255, rgb[1] + Math.round(n * 13 + fine * 5)));
                px[offset + 2] = Math.max(0, Math.min(255, rgb[2] + Math.round(n * 11 + fine * 4)));
                px[offset + 3] = 255;
            }
        }

        ctx.putImageData(imgData, x0, y0);
        return true;
    }

    // ── Check if a color hex is a rock/cliff/earth terrain color ──────────────
    function isTerrainPaintColor(hexColor) {
        if (!hexColor) return false;
        const biome = window.CURRENT_BIOME_CONFIG;
        if (!biome) return false;
        const check = hexColor.toUpperCase();
        return check === (biome.rockColor  || '').toUpperCase() ||
               check === (biome.cliffColor || '').toUpperCase() ||
               check === (biome.earthColor || '').toUpperCase();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  SNOW LAYER — procedural snow for WINTER biome
    // ══════════════════════════════════════════════════════════════════════════

    let _preSnowSnapshot = null;  // saved canvas ImageData before snow

    function applySnowLayer(level) {
        level = (typeof level === 'number') ? Math.max(0.01, Math.min(1, level)) : 1.0;
        const pCtx     = window.pCtx || window._arcadePCtx;
        const mapTex   = window.mapTex || window._arcadeMapTex;
        const getHeight = window.getTerrainHeight;
        const terrainSize = window.TERRAIN_SIZE || 900;
        const fbm      = window.fbm;

        if (!pCtx || !mapTex || !getHeight || !fbm) {
            console.warn('❄️ Snow layer: missing deps');
            return;
        }

        const canvasW = pCtx.canvas.width;
        const canvasH = pCtx.canvas.height;

        // Save pre-snow snapshot (so we can remove snow later)
        _preSnowSnapshot = pCtx.getImageData(0, 0, canvasW, canvasH);

        const t0 = performance.now();

        // Build heightmap
        const HM_SIZE = 512;
        const hm = buildHeightMap(getHeight, terrainSize, HM_SIZE);

        // Find max height for relative snow calculations
        let maxH = 0;
        for (let i = 0; i < hm.length; i++) { if (hm[i] > maxH) maxH = hm[i]; }
        if (maxH < 2) { console.log('❄️ No significant terrain for snow'); return; }

        // Snow parameters — scaled by level using power curve for better slider feel
        // level 0.10: snow line at ~90% of max height (barely visible frost)
        // level 0.25: snow line at ~75% (peaks)
        // level 0.50: snow line at ~45% (half mountain)
        // level 0.75: snow line at ~20% (most of mountain)
        // level 1.00: snow line at 0m (flat ground gets snow too)
        const snowLineFraction = 1.0 - Math.pow(level, 0.6); // power curve: slower start, faster end
        const snowBaseHeight = maxH * snowLineFraction;
        const snowColor  = [250, 252, 255]; // near-white
        const snowShadow = [210, 220, 235]; // blue-grey shadow

        const imgData = pCtx.getImageData(0, 0, canvasW, canvasH);
        const px = imgData.data;
        let painted = 0;

        for (let cy = 0; cy < canvasH; cy++) {
            const v = cy / canvasH;
            for (let cx = 0; cx < canvasW; cx++) {
                const u = cx / canvasW;
                const offset = (cy * canvasW + cx) * 4;

                const height = sampleHM(hm, HM_SIZE, u, v);
                const slope  = computeSlope(hm, HM_SIZE, u, v, terrainSize);

                // ── Noise-modulated snow line ─────────────────────────────
                const snowNoise = fbm(cx * 0.06, cy * 0.06, 3, 2.0, 0.5);
                const localSnowLine = snowBaseHeight + snowNoise * 4.0; // varies -2.5 to 5.5m

                // Skip below snow line
                if (height < localSnowLine) continue;

                // ── Slope factor: snow on all surfaces, less on steep ─────
                // Even steep cliffs get some snow (trapped in crevices)
                const slopeFactor = 1.0 - smoothstep(0.2, 1.2, slope); // gradual: 0.2=full, 1.2=zero
                const minSnowOnSlope = 0.05 + level * 0.15; // more snow on slopes at higher levels
                const adjustedSlope = Math.max(minSnowOnSlope, slopeFactor);

                // ── Height-based: higher = more snow (scaled by level) ───
                const relativeHeight = height / maxH; // 0..1
                // At low levels: snow only on upper terrain. At high levels: everywhere
                const heightMin = lerp(0.4, -0.1, level); // 0.4 at 0%, -0.1 at 100%
                const heightBoost = smoothstep(heightMin, heightMin + 0.3, relativeHeight);
                // At level 1.0: heightMin = -0.1, so heightBoost = 1.0 for ALL terrain

                // ── Strong height override: top of mountains always snowy ─
                const peakSnow = smoothstep(0.5, 0.8, relativeHeight); // 0..1, strong above 60%

                // ── Patchy noise (irregular, not uniform) ─────────────────
                const patchNoise = fbm(cx * 0.15, cy * 0.15, 2, 2.0, 0.5);
                // At high levels, reduce patchiness (more uniform coverage)
                const patchThreshold = lerp(0.3, -0.8, level); // generous at high levels
                const patchiness = smoothstep(-0.5, patchThreshold, patchNoise);

                // ── Final snow amount ─────────────────────────────────────
                // At high levels: base amount floors at level*0.5 so ground gets coverage
                let snowAmount = adjustedSlope * Math.max(heightBoost, level * 0.6) * patchiness;
                // Peak override: above 60% height, add strong snow regardless
                snowAmount = Math.max(snowAmount, peakSnow * (0.5 + level * 0.5));
                snowAmount = Math.min(1.0, snowAmount);

                if (snowAmount < 0.03) continue;

                // ── Snow color with subtle noise variation ────────────────
                const colorNoise = fbm(cx * 0.4, cy * 0.4, 2, 2.0, 0.5);
                const t = smoothstep(-0.5, 0.5, colorNoise);
                const sr = lerp(snowShadow[0], snowColor[0], t);
                const sg = lerp(snowShadow[1], snowColor[1], t);
                const sb = lerp(snowShadow[2], snowColor[2], t);

                // ── Blend snow onto existing pixel ────────────────────────
                px[offset]     = Math.round(lerp(px[offset],     sr, snowAmount));
                px[offset + 1] = Math.round(lerp(px[offset + 1], sg, snowAmount));
                px[offset + 2] = Math.round(lerp(px[offset + 2], sb, snowAmount));
                painted++;
            }
        }

        pCtx.putImageData(imgData, 0, 0);
        mapTex.needsUpdate = true;

        // Update biome data cache
        if (window.terrainBiomeData) {
            const fresh = pCtx.getImageData(0, 0, canvasW, canvasH).data;
            if (window.terrainBiomeData.length === fresh.length) {
                window.terrainBiomeData.set(fresh);
            } else {
                window.terrainBiomeData = fresh;
            }
        }

        window._snowLayerActive = true;
        const ms = (performance.now() - t0).toFixed(0);
        const totalPx = canvasW * canvasH;
        const pct = (painted / totalPx * 100).toFixed(1);
        console.log('❄️ Snow: level=' + Math.round(level*100) + '% | snowLine=' + snowBaseHeight.toFixed(1) + 'm/' + maxH.toFixed(0) + 'm | ' + painted + ' px (' + pct + '%) in ' + ms + 'ms');
        if (window.showBuildToast) {
            window.showBuildToast('❄️ Snow applied (' + ms + 'ms)', '#E8ECF0');
        }
    }

    function removeSnowLayer() {
        if (!_preSnowSnapshot) return;

        const pCtx   = window.pCtx || window._arcadePCtx;
        const mapTex = window.mapTex || window._arcadeMapTex;
        if (!pCtx || !mapTex) return;

        // Restore pre-snow canvas
        pCtx.putImageData(_preSnowSnapshot, 0, 0);
        mapTex.needsUpdate = true;

        // Update biome data cache
        if (window.terrainBiomeData) {
            const fresh = pCtx.getImageData(0, 0, pCtx.canvas.width, pCtx.canvas.height).data;
            if (window.terrainBiomeData.length === fresh.length) {
                window.terrainBiomeData.set(fresh);
            } else {
                window.terrainBiomeData = fresh;
            }
        }

        _preSnowSnapshot = null;
        window._snowLayerActive = false;
        console.log('❄️ Snow layer removed');
    }

    // ── Expose ────────────────────────────────────────────────────────────────
    window.terrainAutoPaint = {
        paintNaturalTerrain: paintNaturalTerrain,
        paintNoisyBrush:     paintNoisyBrush,
        isTerrainPaintColor: isTerrainPaintColor,
        applySnowLayer:      applySnowLayer,
        removeSnowLayer:     removeSnowLayer,
        PRESETS:              PRESETS,
    };

})();
