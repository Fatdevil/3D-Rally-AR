// ================================================================
//  TERRAIN SHELL MANAGER v7 — Mask-texture based (no color matching)
//
//  Near:  Full 3D shell layers with FBM silhouettes (discard-based)
//  Far:   Single flat tint layer darkens rough areas (alpha blend)
//  Result: Rough looks different at ALL distances, 3D up close
//
//  v7: Uses separate rough mask texture instead of fragile color
//      matching. Immune to noise, blending, and texture filtering.
//      Shells render on the MASTER terrain mesh directly.
// ================================================================
(function() {
    'use strict';

    const _isMobile = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);

    const QUALITY = {
        OFF:  { layers: 0, maxDist: 0 },
        LOW:  { layers: 3, maxDist: 60 },
        MED:  { layers: 5, maxDist: 120 },
        HIGH: { layers: 8, maxDist: 250 }
    };

    // ─── GLSL: 3D Shell Shader ──────────────────────────────────

    const VERT = `
        uniform float uLayer;
        uniform float uLayers;
        uniform float uMaxHeight;
        uniform vec2  uWindDir;
        uniform float uWindStr;
        uniform float uTime;

        varying vec2 vUv;
        varying float vL;
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        varying float vSlope;
        varying float vCamDist;

        void main() {
            vUv = uv;
            vL  = uLayer / max(uLayers, 1.0);
            vSlope = 1.0 - abs(normal.z);
            vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);

            // Adaptive displacement:
            // Flat → world-up (clean from above)
            // Slopes → follow terrain normal (layers hidden from side)
            // Normal clamped to max ~60° to prevent spikes at bunker edges
            vec3 up = vec3(0.0, 0.0, 1.0);
            vec3 clampedN = normalize(vec3(normal.xy * 0.7, max(normal.z, 0.4)));
            float slope = 1.0 - abs(normal.z); // 0=flat, 1=vertical
            vec3 dir = mix(up, clampedN, smoothstep(0.10, 0.50, slope));
            // Minimum displacement bias on slopes: ensures even layer 0 sits above terrain
            float slopeBias = smoothstep(0.10, 0.40, slope) * 0.015;
            float layerDisp = max(vL * uMaxHeight, slopeBias);
            vec3 p = position + dir * layerDisp;

            // Wind sway (disabled for visual stability and performance)
            /*
            float sway = vL * vL * uWindStr * 0.6;
            float w1 = sin(uTime * 1.4 + p.x * 0.06 + p.y * 0.04);
            float w2 = sin(uTime * 2.1 + p.y * 0.09 + p.x * 0.03);
            p.x += uWindDir.x * sway * (w1 * 0.6 + w2 * 0.4);
            p.y -= uWindDir.y * sway * (w1 * 0.6 + w2 * 0.4);
            */

            vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
            vCamDist = distance(vWorldPos, cameraPosition);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
    `;

    const FRAG = `
        uniform sampler2D uRoughMask;
        uniform vec3  uRoughCol;
        uniform vec3  uDeepCol;
        uniform vec3  uSemiCol;
        uniform vec3  uForeCol;
        uniform vec3  uSandCol;
        uniform float uRoughH;
        uniform float uDeepH;
        uniform float uMaxHeight;
        uniform float uMaxDist;
        uniform vec2  uWindDir;

        // Dynamic light uniforms synced with scene
        uniform vec3  uLightDir;
        uniform vec3  uDirColor;
        uniform vec3  uAmbColor;

        varying vec2  vUv;
        varying float vL;
        varying vec3  vWorldPos;
        varying vec3  vWorldNormal;
        varying float vSlope;
        varying float vCamDist;

        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
                mix(hash(i), hash(i + vec2(1,0)), f.x),
                mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
                f.y
            );
        }
        float fbm(vec2 p) {
            return 0.45 * vnoise(p) +
                   0.30 * vnoise(p * 2.5) +
                   0.15 * vnoise(p * 6.0) +
                   0.10 * vnoise(p * 13.0);
        }

        void main() {
            // Distance check & dither fade
            if (vCamDist > uMaxDist) discard;
            float distFade = 1.0 - smoothstep(uMaxDist * 0.75, uMaxDist, vCamDist);
            if (hash(vWorldPos.xz * 37.0) > distFade) discard;

            // ── Biome mask: R=rough, G=deep ──
            vec3 mask = texture2D(uRoughMask, vUv).rgb;
            float isRough = step(0.75, mask.r);                    // R=1.0
            float isDeep  = step(0.75, mask.g);                    // G=1.0
            float roughness = max(isRough, isDeep);
            if (roughness < 0.1) discard;

            // Pick color and height based on dominant biome channel
            vec3 baseCol;
            float targetH;
            float tipBright;
            if (isDeep > 0.5) {
                baseCol = uDeepCol;
                targetH = uDeepH;
                tipBright = 0.05;
            } else {
                baseCol = uRoughCol;
                targetH = uRoughH;
                tipBright = 0.25;
            }

            // Height-proportional layer culling with soft fade
            float eL = vL * (uMaxHeight / max(targetH, 0.001));
            float heightFade = 1.0 - smoothstep(0.85, 1.05, eL);
            if (heightFade < 0.05) discard;

            vec2 wXZ = vWorldPos.xz;

            // Grass: standard FBM tufts
            float clump = fbm(wXZ * 0.8);
            float tuft = fbm(wXZ * 4.0 + 50.0);
            float blade = vnoise(wXZ * 15.0 + 100.0);
            float grass = clump * 0.3 + tuft * 0.4 + blade * 0.3;

            // Gentle threshold: bottom layers keep ~90% pixels, top ~60%
            // On slopes: bottom layers are fully solid to prevent terrain showing through
            float slopeCompensation = smoothstep(0.10, 0.40, vSlope);
            float baseThreshold = eL * eL * 0.40;
            float threshold = baseThreshold * (1.0 - slopeCompensation * (1.0 - eL));
            if (grass < threshold) discard;

            // Softer edge fade at biome boundaries
            float edgeThreshold = threshold + (1.0 - roughness) * 0.15;
            if (grass < edgeThreshold) discard;

            // AO: warm bottom, tips highlighted per biome
            float aoBase = mix(0.85, 0.95, slopeCompensation);
            float ao = mix(aoBase, 1.10, eL);
            vec3 col = baseCol * ao;
            col += baseCol * tipBright * eL;

            float colorVar = vnoise(vUv * 80.0 + 33.0);
            col *= 0.95 + 0.10 * colorVar;

            // Apply dynamic diffuse lighting matching the terrain
            vec3 N = normalize(vWorldNormal);
            vec3 L = uLightDir;
            float dotNL = max(0.0, dot(N, L));
            vec3 lightColor = uAmbColor + uDirColor * dotNL;
            col *= lightColor;

            gl_FragColor = vec4(col, 1.0);
        }
    `;

    // ─── Manager ─────────────────────────────────────────────────

    class TerrainShellManager {
        constructor(masterGeo, masterMesh, scene, biomeTex, roughMaskTex) {
            this.masterGeo = masterGeo;
            this.masterMesh = masterMesh;
            this.scene = scene;
            this.biomeTex = biomeTex;
            this.roughMaskTex = roughMaskTex || null;
            this.quality = 'OFF';
            this.shells = [];   // { layer, mesh, mat }
            this._frame = 0;

            this.roughHeight = 0.30;
            this.deepHeight  = 0.60;

            this._roughCol = new THREE.Vector3();
            this._deepCol  = new THREE.Vector3();
            this._semiCol  = new THREE.Vector3();
            this._foreCol  = new THREE.Vector3();
            this._sandCol  = new THREE.Vector3();
            this._updateColors();

            // Track hex colors to auto-update on biome change
            let cfg = window.CURRENT_BIOME_CONFIG || {};
            this._lastRoughHex = cfg.roughColor || '#4a782b';
            this._lastDeepHex = cfg.fescueColor || '#2d4c1a';
            this._lastSemiHex = cfg.semiColor || '#6b9e3d';
            this._lastForeHex = cfg.foregreenColor || '#8bc45d';
            this._lastSandHex = cfg.bunkerColor || '#e0d8a4';
        }

        setQuality(q) {
            if (this.quality === q) return;
            this.quality = q;
            this._rebuild();
            console.log('[Shells] Quality:', q,
                q !== 'OFF' ? '(' + QUALITY[q].layers + ' layers)' : '');
        }

        update(time, camera) {
            if (this.shells.length === 0) return;

            // Track and update colors if CURRENT_BIOME_CONFIG changed (for Autumn, Winter, custom color picker)
            let cfg = window.CURRENT_BIOME_CONFIG || {};
            let rHex = cfg.roughColor || '#4a782b';
            let dHex = cfg.fescueColor || '#2d4c1a';
            let sHex = cfg.semiColor || '#6b9e3d';
            let fHex = cfg.foregreenColor || '#8bc45d';
            let bHex = cfg.bunkerColor || '#e0d8a4';
            if (rHex !== this._lastRoughHex || dHex !== this._lastDeepHex || sHex !== this._lastSemiHex || fHex !== this._lastForeHex || bHex !== this._lastSandHex) {
                this._lastRoughHex = rHex;
                this._lastDeepHex = dHex;
                this._lastSemiHex = sHex;
                this._lastForeHex = fHex;
                this._lastSandHex = bHex;
                this.updateColors();
            }

            // Sync dynamic scene lighting
            let G = window.G || {};
            let al = G.ambientLight;
            let dl = G.dirLight;

            let ambR = 0.5, ambG = 0.5, ambB = 0.5;
            if (al) {
                let ai = al.intensity;
                ambR = al.color.r * ai;
                ambG = al.color.g * ai;
                ambB = al.color.b * ai;
            }

            let dirR = 1.0, dirG = 1.0, dirB = 1.0;
            let lx = 50.0, ly = 100.0, lz = 50.0;
            if (dl) {
                let di = dl.intensity;
                dirR = dl.color.r * di;
                dirG = dl.color.g * di;
                dirB = dl.color.b * di;
                lx = dl.position.x;
                ly = dl.position.y;
                lz = dl.position.z;
            }

            // Normalize light direction
            let len = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1.0;
            lx /= len; ly /= len; lz /= len;

            for (let s of this.shells) {
                s.mat.uniforms.uTime.value = time;
                s.mat.uniforms.uLightDir.value.set(lx, ly, lz);
                s.mat.uniforms.uDirColor.value.set(dirR, dirG, dirB);
                s.mat.uniforms.uAmbColor.value.set(ambR, ambG, ambB);

                // Dynamic maxDist: desktop build=unlimited, mobile play=reduced
                let isPlayMode = window.terrainShaderUniforms && window.terrainShaderUniforms.uPlayMode.value > 0.5;
                let preset = QUALITY[this.quality];
                if (!preset) continue;
                if (_isMobile && isPlayMode) {
                    s.mat.uniforms.uMaxDist.value = preset.maxDist * 0.6;
                } else if (!_isMobile && !isPlayMode) {
                    s.mat.uniforms.uMaxDist.value = 9999;  // Desktop build: no limit
                } else {
                    s.mat.uniforms.uMaxDist.value = preset.maxDist;
                }
            }
        }

        updateColors() {
            this._updateColors();
            for (let s of this.shells) {
                s.mat.uniforms.uRoughCol.value.copy(this._roughCol);
                s.mat.uniforms.uDeepCol.value.copy(this._deepCol);
                s.mat.uniforms.uSemiCol.value.copy(this._semiCol);
                s.mat.uniforms.uForeCol.value.copy(this._foreCol);
                s.mat.uniforms.uSandCol.value.copy(this._sandCol);
            }
        }

        updateWind() {
            let ws = (window.windSpeed || 0) / 30;
            let wa = (window.windAngle || 0) * Math.PI / 180;
            for (let s of this.shells) {
                s.mat.uniforms.uWindStr.value = ws;
                s.mat.uniforms.uWindDir.value.set(Math.cos(wa), Math.sin(wa));
            }
        }

        /** Call after updateTerrainResolution to swap in new geometry */
        updateGeometry(newGeo) {
            this.masterGeo = newGeo;
            // Geometry is now decoupled from masterGeo. Rebuild to pick up any slider changes.
            this._rebuild();
        }

        syncHeights() {
            if (this.shells.length === 0) return;
            this._resampleFromMaster();
        }

        _resampleFromMaster() {
            if (!this.masterGeo || !this.customGeo) return;

            let mPos = this.masterGeo.attributes.position.array;
            let mNorm = this.masterGeo.attributes.normal.array;
            let mSegs = window.TERRAIN_SEGS || 600;
            let mStride = mSegs + 1;

            let cPos = this.customGeo.attributes.position.array;
            let cNorm = this.customGeo.attributes.normal.array;

            let size = window.TERRAIN_SIZE || 600;
            let half = size / 2;

            let shellSegs = this.customGeo.parameters.widthSegments;
            let cStride = shellSegs + 1;
            let step = size / shellSegs;

            function sampleAttribs(worldX, worldZ) {
                let oldStep = size / mSegs;
                let gx = (worldX + half) / oldStep;
                let gz = (worldZ + half) / oldStep;
                gx = Math.max(0, Math.min(mSegs - 1, gx));
                gz = Math.max(0, Math.min(mSegs - 1, gz));
                let ix = Math.floor(gx), iz = Math.floor(gz);
                let fx = gx - ix, fz = gz - iz;

                let i00 = (iz * mStride + ix) * 3;
                let i10 = (iz * mStride + (ix + 1)) * 3;
                let i01 = ((iz + 1) * mStride + ix) * 3;
                let i11 = ((iz + 1) * mStride + (ix + 1)) * 3;

                let h00 = mPos[i00 + 2] || 0, h10 = mPos[i10 + 2] || 0;
                let h01 = mPos[i01 + 2] || 0, h11 = mPos[i11 + 2] || 0;
                let z = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz;

                let n00x = mNorm[i00] || 0, n00y = mNorm[i00 + 1] || 0, n00z = mNorm[i00 + 2] || 1;
                let n10x = mNorm[i10] || 0, n10y = mNorm[i10 + 1] || 0, n10z = mNorm[i10 + 2] || 1;
                let n01x = mNorm[i01] || 0, n01y = mNorm[i01 + 1] || 0, n01z = mNorm[i01 + 2] || 1;
                let n11x = mNorm[i11] || 0, n11y = mNorm[i11 + 1] || 0, n11z = mNorm[i11 + 2] || 1;

                let nx = n00x * (1 - fx) * (1 - fz) + n10x * fx * (1 - fz) + n01x * (1 - fx) * fz + n11x * fx * fz;
                let ny = n00y * (1 - fx) * (1 - fz) + n10y * fx * (1 - fz) + n01y * (1 - fx) * fz + n11y * fx * fz;
                let nz = n00z * (1 - fx) * (1 - fz) + n10z * fx * (1 - fz) + n01z * (1 - fx) * fz + n11z * fx * fz;

                let len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
                return { z, nx: nx / len, ny: ny / len, nz: nz / len };
            }

            for (let i = 0; i <= shellSegs; i++) {
                for (let j = 0; j <= shellSegs; j++) {
                    let localX = -half + j * step;
                    let localY = half - i * step;
                    let worldX = localX;
                    let worldZ = -localY;

                    let idx = (i * cStride + j) * 3;
                    let sample = sampleAttribs(worldX, worldZ);

                    cPos[idx + 2] = sample.z;
                    cNorm[idx] = sample.nx;
                    cNorm[idx + 1] = sample.ny;
                    cNorm[idx + 2] = sample.nz;
                }
            }

            this.customGeo.attributes.position.needsUpdate = true;
            this.customGeo.attributes.normal.needsUpdate = true;
            this.customGeo.computeBoundingBox();
            this.customGeo.computeBoundingSphere();
        }

        refresh() { this._rebuild(); }

        getStats() {
            let visible = 0, tris = 0;
            let segs = window.TERRAIN_SEGS || 100;
            for (let s of this.shells) {
                if (s.mesh.visible) {
                    visible++;
                    tris += segs * segs * 2;
                }
            }
            return { total: this.shells.length, visible, extraTris: tris };
        }

        // ── Internal ────────────────────────────────────────────

        _rebuild() {
            // Dispose old shells
            for (let s of this.shells) {
                if (s.mesh.parent) this.scene.remove(s.mesh);
                s.mat.dispose();
            }
            this.shells = [];

            let preset = QUALITY[this.quality];
            if (!preset || preset.layers === 0) return;

            this._updateColors();
            let maxH = Math.max(this.roughHeight, this.deepHeight);
            
            // Decouple from Green Grid! Cap 3D grass resolution at max 200.
            let shellSegs = Math.min(window._terrainGridSegs || 200, 200);
            if (this.customGeo) this.customGeo.dispose();
            this.customGeo = new THREE.PlaneGeometry(window.TERRAIN_SIZE || 400, window.TERRAIN_SIZE || 400, shellSegs, shellSegs);
            this.customGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
            this._resampleFromMaster();
            let geo = this.customGeo;

            // ── N 3D shell layers (opaque, discard) ──
            for (let layer = 1; layer <= preset.layers; layer++) {
                let mat = this._makeMat(layer, preset.layers, maxH);
                let mesh = new THREE.Mesh(geo, mat);
                mesh.rotation.x = -Math.PI / 2;
                mesh.frustumCulled = true;
                mesh.visible = true;
                mesh.renderOrder = 100 + layer;
                this.scene.add(mesh);
                this.shells.push({ layer, mesh, mat });
            }
            console.log('[Shells] Built', this.shells.length,
                'meshes (' + preset.layers + ' 3D layers) on master geo');
        }

        _makeMat(layer, total, maxH) {
            let preset = QUALITY[this.quality] || { maxDist: 250 };
            let maxDist = preset.maxDist || 250;
            return new THREE.ShaderMaterial({
                uniforms: {
                    uLayer:    { value: layer },
                    uLayers:   { value: total },
                    uMaxHeight:{ value: maxH },
                    uRoughH:   { value: this.roughHeight },
                    uDeepH:    { value: this.deepHeight },
                    uWindDir:  { value: new THREE.Vector2(1, 0) },
                    uWindStr:  { value: 0.3 },
                    uTime:     { value: 0 },
                    uRoughMask:{ value: this.roughMaskTex },
                    uRoughCol: { value: this._roughCol.clone() },
                    uDeepCol:  { value: this._deepCol.clone() },
                    uSemiCol:  { value: this._semiCol.clone() },
                    uForeCol:  { value: this._foreCol.clone() },
                    uSandCol:  { value: this._sandCol.clone() },
                    uMaxDist:  { value: maxDist },
                    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
                    uDirColor: { value: new THREE.Vector3(1, 1, 1) },
                    uAmbColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) }
                },
                vertexShader: VERT,
                fragmentShader: FRAG,
                side: THREE.DoubleSide,
                depthWrite: false,
                depthTest: true,
                polygonOffset: true,
                polygonOffsetFactor: -(1 + layer * 0.5),
                polygonOffsetUnits: -(4 + layer * 2)
            });
        }

        _updateColors() {
            let cfg = window.CURRENT_BIOME_CONFIG || {};
            this._hexToVec(cfg.roughColor || '#4a782b', this._roughCol);
            this._hexToVec(cfg.fescueColor || '#2d4c1a', this._deepCol);
            this._hexToVec(cfg.semiColor || '#6b9e3d', this._semiCol);
            this._hexToVec(cfg.foregreenColor || '#8bc45d', this._foreCol);
            this._hexToVec(cfg.bunkerColor || '#e0d8a4', this._sandCol);
        }

        _hexToVec(hex, v) {
            v.set(
                parseInt(hex.slice(1,3), 16) / 255,
                parseInt(hex.slice(3,5), 16) / 255,
                parseInt(hex.slice(5,7), 16) / 255
            );
        }
    }

    window.TerrainShellManager = TerrainShellManager;
})();
