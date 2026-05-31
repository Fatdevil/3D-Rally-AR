// ================================================================
//  TERRAIN CHUNK MANAGER v3 — 8×8 grid + distance LOD + green detection
//
//  Master PlaneGeometry (invisible) = single source of truth.
//  Chunks render with per-chunk LOD based on:
//    1. Green detection (green chunks = higher base res)
//    2. Camera distance (far chunks = extra downsampled)
//  Skirt geometry hides cracks between different LOD levels.
// ================================================================
(function() {
    'use strict';

    const SKIRT_DEPTH = 5.0;

    // Distance LOD tiers (meters from camera to chunk center)
    const LOD_TIERS = [
        { maxDist: 120, multiplier: 1 },   // Close: base resolution
        { maxDist: 250, multiplier: 2 },   // Medium: half
        { maxDist: Infinity, multiplier: 4 } // Far: quarter
    ];

    class TerrainChunkManager {
        constructor(masterGeo, masterMesh, scene, material, gridSize, options) {
            this.masterGeo = masterGeo;
            this.masterMesh = masterMesh;
            this.scene = scene;
            this.material = material;
            this.gridSize = gridSize || 8;
            this.chunks = [];
            this.enabled = false;
            this._lodCheckFrame = 0;

            options = options || {};
            this.greenGrid = window.TERRAIN_SEGS;
            this.terrainGrid = options.terrainGrid || this.greenGrid;

            this._buildChunks();
        }

        // ─────────────────────────────────────────────────────────────
        //  PUBLIC API
        // ─────────────────────────────────────────────────────────────

        setEnabled(enabled) {
            this.enabled = enabled;
            for (let c of this.chunks) {
                if (enabled && !c.mesh.parent) this.scene.add(c.mesh);
                else if (!enabled && c.mesh.parent) this.scene.remove(c.mesh);
            }
            this.masterMesh.visible = !enabled;
            if (window._gridPlane) window._gridPlane.visible = !enabled;
        }

        syncAll() {
            this.masterGeo.computeVertexNormals();
            let mP = this.masterGeo.attributes.position.array;
            let mN = this.masterGeo.attributes.normal.array;
            let s = window.TERRAIN_SEGS + 1;
            for (let c of this.chunks) {
                this._syncFull(c, mP, mN, s);
                c.dirty = false;
            }
            if (window._terrainShells && window._terrainShells.quality !== 'OFF') {
                window._terrainShells.syncHeights();
            }
        }

        syncDirty() {
            let any = false;
            for (let c of this.chunks) if (c.dirty) { any = true; break; }
            if (!any) return;
            this.masterGeo.computeVertexNormals();
            let mP = this.masterGeo.attributes.position.array;
            let mN = this.masterGeo.attributes.normal.array;
            let s = window.TERRAIN_SEGS + 1;
            for (let c of this.chunks) {
                if (c.dirty) { this._syncFull(c, mP, mN, s); c.dirty = false; }
            }
            if (window._terrainShells && window._terrainShells.quality !== 'OFF') {
                window._terrainShells.syncHeights();
            }
        }

        syncDirtyPositions() {
            let mP = this.masterGeo.attributes.position.array;
            for (let c of this.chunks) {
                if (c.dirty) this._syncPos(c, mP);
            }
            if (window._terrainShells && window._terrainShells.quality !== 'OFF') {
                window._terrainShells.syncHeights();
            }
        }

        markDirty(worldX, worldZ, radius) {
            let size = window.TERRAIN_SIZE, segs = window.TERRAIN_SEGS;
            let half = size / 2, step = size / segs;
            for (let c of this.chunks) {
                if (c.dirty) continue;
                let x0 = -half + c.gxStart * step, x1 = -half + c.gxEnd * step;
                let z0 = -half + c.gzStart * step, z1 = -half + c.gzEnd * step;
                let cx = Math.max(x0, Math.min(worldX, x1));
                let cz = Math.max(z0, Math.min(worldZ, z1));
                if ((worldX-cx)*(worldX-cx) + (worldZ-cz)*(worldZ-cz) <= radius*radius)
                    c.dirty = true;
            }
        }

        markAllDirty() { for (let c of this.chunks) c.dirty = true; }

        updateLOD(terrainGrid) {
            terrainGrid = Math.min(terrainGrid, this.greenGrid);
            this.terrainGrid = terrainGrid;
            window._terrainGridSegs = terrainGrid;
            this._buildChunks();
            if (this.enabled) this.setEnabled(true);
        }

        rebuild(newGeo, newMesh) {
            this.masterGeo = newGeo;
            if (newMesh) this.masterMesh = newMesh;
            this.greenGrid = window.TERRAIN_SEGS;
            this._buildChunks();
            if (this.enabled) this.setEnabled(true);
        }

        refreshGreenDetection() {
            let changed = false;
            let segs = window.TERRAIN_SEGS, cs = Math.ceil(segs / this.gridSize);
            for (let c of this.chunks) {
                let g = this._hasGreen(c.cx * cs, c.cz * cs,
                    Math.min(c.cx * cs + cs, segs), Math.min(c.cz * cs + cs, segs));
                if (g !== c.isGreen) changed = true;
            }
            if (changed) { this._buildChunks(); if (this.enabled) this.setEnabled(true); }
        }

        /** Call in render loop — updates distance-based LOD (throttled internally) */
        updateDistanceLOD(camera) {
            // Only check every 30 frames (~0.5s at 60fps)
            if (++this._lodCheckFrame % 30 !== 0) return;
            if (!camera) return;

            // LOCK: skip LOD updates during ball flight to prevent physics stutter
            if (window.appMode === 'PLAY' || window.appMode === 'TEST') return;

            let size = window.TERRAIN_SIZE, segs = window.TERRAIN_SEGS;
            let half = size / 2, step = size / segs;
            let camX = camera.position.x, camZ = camera.position.z;

            // Hysteresis margins: upgrade (closer) uses normal threshold,
            // downgrade (farther) requires 20% beyond threshold to prevent flip-flop
            let HYSTERESIS = 1.2;
            let MAX_REBUILDS = 2; // Max geometry rebuilds per cycle
            let rebuilds = 0;

            for (let c of this.chunks) {
                if (rebuilds >= MAX_REBUILDS) break;

                let ccx = -half + ((c.gxStart + c.gxEnd) * 0.5) * step;
                let ccz = -half + ((c.gzStart + c.gzEnd) * 0.5) * step;
                let dx = camX - ccx, dz = camZ - ccz;
                let dist = Math.sqrt(dx * dx + dz * dz);

                // Determine target tier with hysteresis
                let tier = LOD_TIERS.length - 1;
                for (let t = 0; t < LOD_TIERS.length; t++) {
                    // Upgrading (going to higher detail = lower tier number)
                    if (t < c.lodTier) {
                        if (dist < LOD_TIERS[t].maxDist) { tier = t; break; }
                    }
                    // Same tier — stay
                    else if (t === c.lodTier) {
                        if (dist < LOD_TIERS[t].maxDist) { tier = t; break; }
                    }
                    // Downgrading (lower detail) — require hysteresis overshoot
                    else {
                        if (dist < LOD_TIERS[t - 1].maxDist * HYSTERESIS) { tier = t - 1; break; }
                        if (dist < LOD_TIERS[t].maxDist) { tier = t; break; }
                    }
                }

                if (tier !== c.lodTier) {
                    c.lodTier = tier;
                    this._rebuildChunkGeo(c);
                    rebuilds++;
                }
            }
        }

        getStats() {
            let hiRes = 0, loRes = 0, totalTris = 0;
            for (let c of this.chunks) {
                if (c.isGreen) hiRes++; else loRes++;
                totalTris += c.lodSegs * c.lodSegs * 2;
            }
            return { total: this.chunks.length, hiRes, loRes, totalTris,
                     greenGrid: this.greenGrid, terrainGrid: this.terrainGrid };
        }

        // ─────────────────────────────────────────────────────────────
        //  CHUNK BUILDING
        // ─────────────────────────────────────────────────────────────

        _buildChunks() {
            for (let c of this.chunks) {
                if (c.mesh.parent) this.scene.remove(c.mesh);
                c.geo.dispose();
            }
            this.chunks = [];

            let segs = window.TERRAIN_SEGS, gs = this.gridSize;
            let chunkSegs = Math.ceil(segs / gs);
            let lodRatio = Math.max(1, Math.round(this.greenGrid / this.terrainGrid));

            for (let cz = 0; cz < gs; cz++) {
                for (let cx = 0; cx < gs; cx++) {
                    let gxS = cx * chunkSegs, gzS = cz * chunkSegs;
                    let gxE = Math.min(gxS + chunkSegs, segs);
                    let gzE = Math.min(gzS + chunkSegs, segs);
                    let isGreen = this._hasGreen(gxS, gzS, gxE, gzE);
                    let baseLodStep = isGreen ? 1 : lodRatio;

                    let chunk = {
                        cx, cz, gxStart: gxS, gzStart: gzS, gxEnd: gxE, gzEnd: gzE,
                        isGreen, baseLodStep,
                        lodTier: 0, lodSegs: 0,
                        gridVertCount: 0, masterIndices: null,
                        skirtGridMap: null, skirtVertCount: 0,
                        geo: null, mesh: null, dirty: true
                    };

                    // Compute initial LOD segs
                    let masterSegs = Math.min(gxE - gxS, gzE - gzS);
                    let lodStep = baseLodStep * LOD_TIERS[0].multiplier;
                    chunk.lodSegs = Math.max(4, Math.round(masterSegs / lodStep));

                    // Build geometry
                    this._createChunkGeo(chunk);
                    this.chunks.push(chunk);
                }
            }

            this.syncAll();

            let stats = this.getStats();
            console.log('[TerrainChunks] Built', stats.total, 'chunks (' + this.gridSize + 'x' + this.gridSize + '):',
                stats.hiRes, 'hi-res,', stats.loRes, 'lo-res.',
                'Tris:', stats.totalTris.toLocaleString());
        }

        /** Rebuild a single chunk's geometry at its current LOD tier */
        _rebuildChunkGeo(chunk) {
            let masterSegs = Math.min(chunk.gxEnd - chunk.gxStart, chunk.gzEnd - chunk.gzStart);
            let lodStep = chunk.baseLodStep * LOD_TIERS[chunk.lodTier].multiplier;
            let newLodSegs = Math.max(4, Math.round(masterSegs / lodStep));

            if (newLodSegs === chunk.lodSegs) return; // No change needed
            chunk.lodSegs = newLodSegs;

            // Remove old
            let wasInScene = chunk.mesh && chunk.mesh.parent;
            if (wasInScene) this.scene.remove(chunk.mesh);
            if (chunk.geo) chunk.geo.dispose();

            // Build new
            this._createChunkGeo(chunk);

            // Re-add and sync
            if (wasInScene) this.scene.add(chunk.mesh);

            // Sync from master
            this.masterGeo.computeVertexNormals();
            let mP = this.masterGeo.attributes.position.array;
            let mN = this.masterGeo.attributes.normal.array;
            this._syncFull(chunk, mP, mN, window.TERRAIN_SEGS + 1);
            chunk.dirty = false;
        }

        /** Create geometry + mesh for a chunk at its current lodSegs */
        _createChunkGeo(chunk) {
            let segs = window.TERRAIN_SEGS;
            let masterStride = segs + 1;
            let mPos = this.masterGeo.attributes.position.array;
            let mUV = this.masterGeo.attributes.uv.array;

            let gxS = chunk.gxStart, gzS = chunk.gzStart;
            let gxE = chunk.gxEnd, gzE = chunk.gzEnd;
            let masterSegsX = gxE - gxS, masterSegsZ = gzE - gzS;
            let lodSegs = chunk.lodSegs;
            let cW = lodSegs + 1, cH = lodSegs + 1;
            let gridVertCount = cW * cH;

            // Precompute master index mapping
            let masterIndices = new Int32Array(gridVertCount);
            for (let lz = 0; lz < cH; lz++) {
                let mGz = gzS + Math.round(lz * masterSegsZ / lodSegs);
                for (let lx = 0; lx < cW; lx++) {
                    let mGx = gxS + Math.round(lx * masterSegsX / lodSegs);
                    masterIndices[lz * cW + lx] = mGz * masterStride + mGx;
                }
            }

            // Grid positions + UVs
            let positions = new Float32Array(gridVertCount * 3);
            let uvs = new Float32Array(gridVertCount * 2);
            for (let ci = 0; ci < gridVertCount; ci++) {
                let mi = masterIndices[ci];
                positions[ci*3] = mPos[mi*3]; positions[ci*3+1] = mPos[mi*3+1]; positions[ci*3+2] = mPos[mi*3+2];
                uvs[ci*2] = mUV[mi*2]; uvs[ci*2+1] = mUV[mi*2+1];
            }

            // Grid indices
            let gridIndices = [];
            for (let z = 0; z < lodSegs; z++) {
                for (let x = 0; x < lodSegs; x++) {
                    let a = z * cW + x, b = a + 1, c = a + cW, d = c + 1;
                    gridIndices.push(a, c, b, b, c, d);
                }
            }

            // Skirt
            let skirt = this._buildSkirt(lodSegs, cW, gridVertCount);

            // Merge
            let totalVerts = gridVertCount + skirt.vertCount;
            let fPos = new Float32Array(totalVerts * 3);
            let fUV = new Float32Array(totalVerts * 2);
            let fNorm = new Float32Array(totalVerts * 3);
            fPos.set(positions); fUV.set(uvs);

            for (let si = 0; si < skirt.vertCount; si++) {
                let gi = skirt.gridMap[si], vi = gridVertCount + si;
                fPos[vi*3] = positions[gi*3]; fPos[vi*3+1] = positions[gi*3+1];
                fPos[vi*3+2] = positions[gi*3+2] - SKIRT_DEPTH;
                fUV[vi*2] = uvs[gi*2]; fUV[vi*2+1] = uvs[gi*2+1];
            }

            let allIdx = gridIndices.concat(skirt.indices);
            let use32 = totalVerts > 65535;
            let idxArr = use32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);

            let geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
            geo.setAttribute('uv', new THREE.BufferAttribute(fUV, 2));
            geo.setAttribute('normal', new THREE.BufferAttribute(fNorm, 3));
            geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
            geo.attributes.position.setUsage(THREE.DynamicDrawUsage);

            let mesh = new THREE.Mesh(geo, this.material);
            mesh.rotation.x = -Math.PI / 2;
            mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            mesh.name = 'tc_' + chunk.cx + '_' + chunk.cz;

            chunk.geo = geo;
            chunk.mesh = mesh;
            chunk.gridVertCount = gridVertCount;
            chunk.masterIndices = masterIndices;
            chunk.skirtGridMap = skirt.gridMap;
            chunk.skirtVertCount = skirt.vertCount;
        }

        // ─────────────────────────────────────────────────────────────
        //  SKIRT
        // ─────────────────────────────────────────────────────────────

        _buildSkirt(lodSegs, cW, gvc) {
            let edge = [];
            for (let x = 0; x <= lodSegs; x++) edge.push(x);
            for (let x = 0; x <= lodSegs; x++) edge.push(lodSegs * cW + x);
            for (let z = 1; z < lodSegs; z++) edge.push(z * cW);
            for (let z = 1; z < lodSegs; z++) edge.push(z * cW + lodSegs);

            let vc = edge.length;
            let gridMap = new Int32Array(vc);
            for (let i = 0; i < vc; i++) gridMap[i] = edge[i];

            let indices = [], sb = gvc;
            let g2s = {};
            for (let si = 0; si < vc; si++) g2s[edge[si]] = si;

            function quad(g0, g1, s0, s1) {
                indices.push(g0, g1, sb + s0, g1, sb + s1, sb + s0);
            }
            for (let x = 0; x < lodSegs; x++) { let g0=x, g1=x+1; quad(g0,g1,g2s[g0],g2s[g1]); }
            for (let x = 0; x < lodSegs; x++) { let g0=lodSegs*cW+x, g1=g0+1; quad(g1,g0,g2s[g1],g2s[g0]); }
            for (let z = 0; z < lodSegs; z++) { let g0=z*cW, g1=(z+1)*cW; quad(g1,g0,g2s[g1],g2s[g0]); }
            for (let z = 0; z < lodSegs; z++) { let g0=z*cW+lodSegs, g1=(z+1)*cW+lodSegs; quad(g0,g1,g2s[g0],g2s[g1]); }

            return { vertCount: vc, gridMap, indices };
        }

        // ─────────────────────────────────────────────────────────────
        //  GREEN DETECTION
        // ─────────────────────────────────────────────────────────────

        _hasGreen(gxS, gzS, gxE, gzE) {
            if (this.terrainGrid >= this.greenGrid) return true;
            let biome = window.terrainBiomeData;
            if (!biome) return true;

            let cfg = window.CURRENT_BIOME_CONFIG || {};
            let gh = cfg.greenColor || '#98ce68', fh = cfg.foregreenColor || '#8bc45d';
            let gR = parseInt(gh.slice(1,3),16), gG = parseInt(gh.slice(3,5),16), gB = parseInt(gh.slice(5,7),16);
            let fR = parseInt(fh.slice(1,3),16), fG = parseInt(fh.slice(3,5),16), fB = parseInt(fh.slice(5,7),16);

            let segs = window.TERRAIN_SEGS;
            let pxS = Math.floor((gxS/segs)*4096), pxE = Math.ceil((gxE/segs)*4096);
            let pzS = Math.floor((gzS/segs)*4096), pzE = Math.ceil((gzE/segs)*4096);
            let step = Math.max(1, Math.floor((pxE - pxS) / 40));

            for (let pz = pzS; pz < pzE; pz += step) {
                for (let px = pxS; px < pxE; px += step) {
                    let idx = (pz * 4096 + px) * 4;
                    let r = biome[idx], g = biome[idx+1], b = biome[idx+2];
                    if ((r-gR)*(r-gR)+(g-gG)*(g-gG)+(b-gB)*(b-gB) < 500) return true;
                    if ((r-fR)*(r-fR)+(g-fG)*(g-fG)+(b-fB)*(b-fB) < 500) return true;
                }
            }
            return false;
        }

        // ─────────────────────────────────────────────────────────────
        //  SYNC
        // ─────────────────────────────────────────────────────────────

        _syncFull(c, mP, mN, stride) {
            let cP = c.geo.attributes.position.array;
            let cN = c.geo.attributes.normal.array;
            for (let ci = 0; ci < c.gridVertCount; ci++) {
                let mi = c.masterIndices[ci];
                cP[ci*3]=mP[mi*3]; cP[ci*3+1]=mP[mi*3+1]; cP[ci*3+2]=mP[mi*3+2];
                cN[ci*3]=mN[mi*3]; cN[ci*3+1]=mN[mi*3+1]; cN[ci*3+2]=mN[mi*3+2];
            }
            for (let si = 0; si < c.skirtVertCount; si++) {
                let gi = c.skirtGridMap[si], vi = c.gridVertCount + si;
                cP[vi*3]=cP[gi*3]; cP[vi*3+1]=cP[gi*3+1]; cP[vi*3+2]=cP[gi*3+2]-SKIRT_DEPTH;
                cN[vi*3]=cN[gi*3]; cN[vi*3+1]=cN[gi*3+1]; cN[vi*3+2]=cN[gi*3+2];
            }
            c.geo.attributes.position.needsUpdate = true;
            c.geo.attributes.normal.needsUpdate = true;
            c.geo.computeBoundingBox();
            c.geo.computeBoundingSphere();
        }

        _syncPos(c, mP) {
            let cP = c.geo.attributes.position.array;
            for (let ci = 0; ci < c.gridVertCount; ci++) {
                let mi = c.masterIndices[ci];
                cP[ci*3]=mP[mi*3]; cP[ci*3+1]=mP[mi*3+1]; cP[ci*3+2]=mP[mi*3+2];
            }
            for (let si = 0; si < c.skirtVertCount; si++) {
                let gi = c.skirtGridMap[si], vi = c.gridVertCount + si;
                cP[vi*3]=cP[gi*3]; cP[vi*3+1]=cP[gi*3+1]; cP[vi*3+2]=cP[gi*3+2]-SKIRT_DEPTH;
            }
            c.geo.attributes.position.needsUpdate = true;
        }
    }

    window.TerrainChunkManager = TerrainChunkManager;
})();
