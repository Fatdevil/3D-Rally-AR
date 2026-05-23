// ================================================================
// terrain-shader-geo.js — PHASE 2: Splat map, vertex colors, road baking
// Requires: terrain-shader-utils.js loaded first
// Exposes: window.terrainShaderGeo
// ================================================================
(function () {
    'use strict';

    // ── distToSegment2D ───────────────────────────────────────────────────────
    // Returns min distance from point (px,pz) to segment (ax,az)→(bx,bz)
    function distToSegment2D(px, pz, ax, az, bx, bz) {
        const dx = bx - ax, dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 0.0001) {
            const ex = px - ax, ez = pz - az;
            return Math.sqrt(ex * ex + ez * ez);
        }
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
        const cx = ax + t * dx - px;
        const cz = az + t * dz - pz;
        return Math.sqrt(cx * cx + cz * cz);
    }

    // ── buildSplatMap ─────────────────────────────────────────────────────────
    // biomeCanvas : HTMLCanvasElement (pCtx.canvas in arcade, _biomeCanvas in rally)
    // classifyFn  : function(r,g,b) → biome-type string
    // Returns THREE.CanvasTexture 512×512 RGBA:
    //   R = gravel/waste/sand   G = tarmac/fairway/green   B = mud/fescue   A = grassVeto
    function buildSplatMap(biomeCanvas, classifyFn) {
        const SIZE = 512;
        const dst  = document.createElement('canvas');
        dst.width  = dst.height = SIZE;
        const dctx = dst.getContext('2d');

        // Downsample biome canvas → 512×512
        dctx.drawImage(biomeCanvas, 0, 0, SIZE, SIZE);
        const imgData = dctx.getImageData(0, 0, SIZE, SIZE);
        const px      = imgData.data;

        for (let i = 0; i < px.length; i += 4) {
            const type = classifyFn(px[i], px[i + 1], px[i + 2]);
            let r = 0, g = 0, b = 0, a = 0;
            switch (type) {
                case 'WASTE':
                case 'SAND':
                case 'BUNKER':
                    r = 255; break;                   // gravel channel

                case 'GREEN':
                case 'TEE':
                case 'FOREGREEN':
                case 'FAIRWAY':
                    g = 255; break;                   // tarmac/short-grass channel

                case 'FESCUE':
                case 'DEEP ROUGH':
                    b = 255; break;                   // mud channel

                // Grass-veto biomes — prevent slope-rock on designer-painted grass
                case 'ROUGH':
                case 'SEMI-ROUGH':
                    a = 255; break;                   // grassVeto channel

                default:                              // OB, WATER, unknown → zeros
                    break;
            }
            px[i]     = r;
            px[i + 1] = g;
            px[i + 2] = b;
            px[i + 3] = a;
        }

        dctx.putImageData(imgData, 0, 0);
        const tex     = new THREE.CanvasTexture(dst);
        tex.premultiplyAlpha = false;   // FIX A1: prevent alpha pre-multiplication
        tex.needsUpdate = true;
        return tex;
    }

    // ── initVertexColors ──────────────────────────────────────────────────────
    // Adds 'color' BufferAttribute to geometry.
    // Default: (0, 0, 0) = no road, no grassVeto, no tire tracks
    // Note: grassVeto (G-channel) is driven by splat.a, not vertex colors,
    //       so 0 default is correct — vertex G reserved for future manual paint.
    function initVertexColors(geometry) {
        const count  = geometry.attributes.position.count;
        const colors = new Float32Array(count * 3);
        // Default 0,0,0 — shader reads splat.a for grassVeto
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.attributes.color.setUsage(THREE.DynamicDrawUsage);
    }

    // ── bakeRoadVertexColors ──────────────────────────────────────────────────
    // Writes road mask into vertex color R-channel.
    // roads: array of { sampledPoints: [{x, z}], width: number }
    // CORRECTS for mobile: uses window.TERRAIN_SEGS (not hard-coded 600)
    function bakeRoadVertexColors(roads, geometry, terrainSize) {
        if (!geometry.attributes.color) {
            console.warn('bakeRoadVertexColors: no color attribute — call initVertexColors first');
            return;
        }

        const positions = geometry.attributes.position.array;
        const colors    = geometry.attributes.color.array;
        const count     = geometry.attributes.position.count;

        // ── Clear R-channel only ──────────────────────────────────────────────
        for (let i = 0; i < count; i++) {
            colors[i * 3] = 0.0;   // R = road mask
            // G and B preserved (manual paint + tire tracks)
        }

        if (!roads || roads.length === 0) {
            geometry.attributes.color.needsUpdate = true;
            return;
        }

        for (const road of roads) {
            const pts = road.sampledPoints;
            if (!pts || pts.length < 2) continue;

            const half  = road.width / 2;
            const outer = half + 2.0;   // 2m soft transition
            const fade  = Math.max(outer - half, 0.001);

            for (let i = 0; i < count; i++) {
                // PlaneGeometry: positions[i*3]=localX, [i*3+1]=localY, [i*3+2]=height
                // After rotation -90°X: localX=worldX, localY=-worldZ
                // sampledPoints use worldZ, so we negate localY to match
                const vx = positions[i * 3];
                const vz = -positions[i * 3 + 1]; // localY = -worldZ → negate to get worldZ

                let minDist = Infinity;
                for (let j = 0; j < pts.length - 1; j++) {
                    const d = distToSegment2D(vx, vz, pts[j].x, pts[j].z,
                                                       pts[j + 1].x, pts[j + 1].z);
                    if (d < minDist) minDist = d;
                }

                // smoothstep from outer → inner gives 0 at edge, 1 at center
                const mask = 1.0 - Math.max(0, Math.min(1, (minDist - half) / fade));

                if (mask > colors[i * 3]) {
                    colors[i * 3] = mask;   // keep max across overlapping roads
                }
            }
        }

        geometry.attributes.color.needsUpdate = true;
    }

    // ── paintTireTrack ────────────────────────────────────────────────────────
    // Writes tire-track intensity into vertex color B-channel.
    // Called per-wheel per-frame during drift in rally-vehicle.js.
    // Uses window.TERRAIN_SEGS — NOT hardcoded 600.
    function paintTireTrack(worldX, worldZ, intensity, geometry, terrainSize) {
        if (!geometry || !geometry.attributes.color) return;

        const colors  = geometry.attributes.color.array;
        const segs    = window.TERRAIN_SEGS || 600;  // PHASE 2 FIX: mobile-safe
        const stride  = segs + 1;

        // World → grid index
        const gx0 = (worldX / terrainSize + 0.5) * segs;
        const gz0 = (worldZ / terrainSize + 0.5) * segs;
        const radius = 2;

        for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const gx = Math.round(gx0 + dx);
                const gz = Math.round(gz0 + dz);
                if (gx < 0 || gx >= stride || gz < 0 || gz >= stride) continue;

                const dist = Math.sqrt(dx * dx + dz * dz) / radius;
                if (dist > 1.0) continue;

                const vi  = (gz * stride + gx) * 3;
                const str = (1.0 - dist) * intensity * 0.12;
                colors[vi + 2] = Math.min(1.0, (colors[vi + 2] || 0) + str); // B
            }
        }
        geometry.attributes.color.needsUpdate = true;
    }

    // ── Convenience: arcade.html biome classifier wrapper ────────────────────
    // arcade.html doesn't have classifyBiomeColor — it uses CURRENT_BIOME_CONFIG.
    // This wrapper builds a nearest-color classifier from that config.
    function makeArcadeClassifyFn() {
        return function (r, g, b) {
            const cfg = window.CURRENT_BIOME_CONFIG;
            if (!cfg) return 'ROUGH';
            const names = {
                ob: 'OB', bunker: 'BUNKER', waste: 'WASTE', tee: 'TEE',
                green: 'GREEN', foregreen: 'FOREGREEN', fairway: 'FAIRWAY',
                semi: 'SEMI-ROUGH', rough: 'ROUGH', fescue: 'DEEP ROUGH',
            };
            let best = 'ROUGH', bestDist = Infinity;
            for (const key in names) {
                const hex = cfg[key + 'Color'];
                if (!hex) continue;
                const cr = parseInt(hex.slice(1, 3), 16);
                const cg = parseInt(hex.slice(3, 5), 16);
                const cb = parseInt(hex.slice(5, 7), 16);
                const d  = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
                if (d < bestDist) { bestDist = d; best = names[key]; }
            }
            
            if (bestDist < 100) {
                return best;
            }
            
            bestDist = Infinity;
            const vr = 1.0, vg = 1.1, vb = 0.75;
            const vLenSq = 2.7725;
            
            for (const key in names) {
                const hex = cfg[key + 'Color'];
                if (!hex) continue;
                const cr = parseInt(hex.slice(1, 3), 16);
                const cg = parseInt(hex.slice(3, 5), 16);
                const cb = parseInt(hex.slice(5, 7), 16);
                
                let dr = r - cr, dg = g - cg, db = b - cb;
                let distSq = dr*dr + dg*dg + db*db;
                
                if (key !== 'water' && key !== 'ob') {
                    let t = (dr * vr + dg * vg + db * vb) / vLenSq;
                    t = Math.max(-35, Math.min(35, t));
                    let diffR = dr - t * vr;
                    let diffG = dg - t * vg;
                    let diffB = db - t * vb;
                    let distProjSq = diffR*diffR + diffG*diffG + diffB*diffB;
                    if (distProjSq < distSq) {
                        distSq = distProjSq;
                    }
                }
                
                if (distSq < bestDist) {
                    bestDist = distSq;
                    best = names[key];
                }
            }
            return best;
        };
    }

    // ── Throttled splat update (for PAINT tool) ───────────────────────────────
    let _splatPending = false;
    function scheduleSplatUpdate(biomeCanvas, classifyFn, material) {
        if (_splatPending) return;
        _splatPending = true;
        setTimeout(function () {
            if (material && material.uniforms && material.uniforms.u_splat) {
                // FIX A5: dispose old splat texture before replacing (memory leak)
                const old = material.uniforms.u_splat.value;
                material.uniforms.u_splat.value = buildSplatMap(biomeCanvas, classifyFn);
                if (old && old.dispose) old.dispose();
            }
            _splatPending = false;
        }, 500);
    }

    // ── Expose ────────────────────────────────────────────────────────────────
    window.terrainShaderGeo = {
        buildSplatMap,
        initVertexColors,
        bakeRoadVertexColors,
        paintTireTrack,
        distToSegment2D,
        makeArcadeClassifyFn,
        scheduleSplatUpdate,
    };

})();
