// ================================================================
//  AUTUMN LEAVES ENGINE — 3D falling + grounded leaf system
//  Uses InstancedMesh: falling leaves + ground carpet = 2 draw calls.
//
//  Depends on: THREE (global), window.currentWindMph, window.currentWindDir
//
//  Exposes:
//  - window.AutumnLeaves.init(scene, camera)
//  - window.AutumnLeaves.activate()   — start spawning
//  - window.AutumnLeaves.deactivate() — remove all leaves
//  - window.AutumnLeaves.update(dt)   — call every frame
//  - window.AutumnLeaves.isActive()
// ================================================================
(function() {
    'use strict';

    let _scene = null;
    let _camera = null;
    let _active = false;
    let _initialized = false;

    // --- CONFIG ---
    const MAX_FALLING   = 80;      // Active falling leaves
    const MAX_GROUND    = 500;     // Landed leaves on ground
    const PRE_SPAWN     = 350;     // Pre-placed on activation
    const SPAWN_RADIUS  = 100;     // Spawn radius around camera
    const SPAWN_HEIGHT  = [25, 50]; // Y range for spawning
    const FALL_SPEED    = [0.8, 2.0]; // m/s fall speed range
    const TUMBLE_SPEED  = [1.5, 4.0]; // Rotation speed
    const GROUND_Y      = 0.15;    // Slightly above ground to avoid z-fight
    const LEAF_SCALE    = [0.3, 0.7]; // Scale range for leaves

    // Autumn leaf colors (tints applied to base leaf material)
    const LEAF_COLORS = [
        [0.85, 0.30, 0.08],  // Deep red
        [0.92, 0.50, 0.10],  // Orange
        [0.95, 0.70, 0.15],  // Golden
        [0.80, 0.60, 0.12],  // Amber
        [0.70, 0.20, 0.05],  // Dark crimson
        [0.90, 0.80, 0.20],  // Yellow
    ];

    // --- STATE ---
    let _fallingMesh = null;  // InstancedMesh for falling leaves
    let _groundMesh  = null;  // InstancedMesh for grounded leaves
    let _fallingData = [];    // Per-leaf state: { x, y, z, vx, vy, vz, rx, ry, rz, rvx, rvy, rvz, scale, colorIdx }
    let _groundData  = [];    // Grounded leaves: { x, y, z, rx, ry, rz, scale, colorIdx }
    let _groundIdx   = 0;     // Ring buffer index for ground leaves
    let _leafGeo     = null;
    let _leafMat     = null;
    let _dummy       = null;

    // Reusable THREE objects
    let _pos = null;
    let _quat = null;
    let _scl = null;
    let _euler = null;
    let _color = null;

    // ---------------------------------------------------------------
    // CREATE LEAF GEOMETRY — flat diamond/oval shape
    // ---------------------------------------------------------------
    function _createLeafGeometry() {
        // Simple leaf shape: elongated diamond with slight asymmetry
        let shape = new THREE.Shape();
        shape.moveTo(0, -0.5);
        shape.bezierCurveTo(0.15, -0.25, 0.25, 0.0, 0.2, 0.2);
        shape.bezierCurveTo(0.15, 0.35, 0.05, 0.45, 0, 0.5);
        shape.bezierCurveTo(-0.05, 0.45, -0.15, 0.35, -0.2, 0.2);
        shape.bezierCurveTo(-0.25, 0.0, -0.15, -0.25, 0, -0.5);

        let geo = new THREE.ShapeGeometry(shape, 4);
        // Slight bend: push center vertices up on Y for 3D curl
        let posAttr = geo.attributes.position;
        for (let i = 0; i < posAttr.count; i++) {
            let x = posAttr.getX(i);
            let y = posAttr.getY(i);
            // Curl the leaf slightly upward at edges
            let curl = (0.25 - x * x) * 0.3;
            posAttr.setZ(i, curl);
        }
        posAttr.needsUpdate = true;
        geo.computeVertexNormals();
        return geo;
    }

    // ---------------------------------------------------------------
    // INIT
    // ---------------------------------------------------------------
    function init(scene, camera) {
        _scene = scene;
        _camera = camera;
        _initialized = true;
        _dummy = new THREE.Object3D();
        _pos = new THREE.Vector3();
        _quat = new THREE.Quaternion();
        _scl = new THREE.Vector3();
        _euler = new THREE.Euler();
        _color = new THREE.Color();
        console.log('[AutumnLeaves] Initialized ✅');
    }

    // ---------------------------------------------------------------
    // ACTIVATE — build meshes, start spawning
    // ---------------------------------------------------------------
    function activate() {
        if (!_initialized || _active) return;
        _active = true;

        _leafGeo = _createLeafGeometry();
        _leafMat = new THREE.MeshLambertMaterial({
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
            depthWrite: false
        });

        // Falling leaves mesh
        _fallingMesh = new THREE.InstancedMesh(_leafGeo, _leafMat, MAX_FALLING);
        _fallingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        _fallingMesh.frustumCulled = false;
        _fallingMesh.renderOrder = 99;
        _scene.add(_fallingMesh);

        // Ground leaves mesh
        _groundMesh = new THREE.InstancedMesh(_leafGeo, _leafMat, MAX_GROUND);
        _groundMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        _groundMesh.frustumCulled = false;
        _groundMesh.renderOrder = 5; // Below trees, above terrain
        _scene.add(_groundMesh);

        // Initialize instance colors
        for (let i = 0; i < MAX_FALLING; i++) {
            _fallingMesh.setColorAt(i, new THREE.Color(0, 0, 0));
        }
        for (let i = 0; i < MAX_GROUND; i++) {
            _groundMesh.setColorAt(i, new THREE.Color(0, 0, 0));
            // Hide all ground instances initially (scale 0)
            _dummy.position.set(0, -100, 0);
            _dummy.scale.set(0, 0, 0);
            _dummy.updateMatrix();
            _groundMesh.setMatrixAt(i, _dummy.matrix);
        }
        _groundMesh.instanceMatrix.needsUpdate = true;
        _groundMesh.instanceColor.needsUpdate = true;

        // Spawn initial batch of falling leaves
        _fallingData = [];
        _groundData = [];
        _groundIdx = 0;
        for (let i = 0; i < MAX_FALLING; i++) {
            _fallingData.push(_spawnFallingLeaf(true));
        }

        // Pre-spawn ground leaves for instant carpet effect
        _preSpawnGroundLeaves();

        console.log('[AutumnLeaves] Activated 🍂 | Falling:', MAX_FALLING, '| Ground pre-spawned:', _groundIdx, '/', MAX_GROUND);
    }

    // ---------------------------------------------------------------
    // PRE-SPAWN ground leaves — instant carpet at activation
    // Only on rough, semi-rough, fescue (not fairway/green/bunker/water)
    // ---------------------------------------------------------------
    function _preSpawnGroundLeaves() {
        if (!_groundMesh || !_camera) return;

        // Get terrain data to check surface type
        let terrainData = window.terrainBiomeData; // RGBA pixel data of 4096x4096 canvas
        let TERRAIN_SIZE = window.TERRAIN_SIZE || 200;
        let biomeConfig = window.CURRENT_BIOME_CONFIG;

        // Build list of "leafy" surface colors (rough, semi, fescue, OB)
        let leafySurfaces = [];
        if (biomeConfig) {
            ['rough', 'semi', 'fescue', 'ob'].forEach(k => {
                let hex = biomeConfig[k + 'Color'];
                if (hex) {
                    let rgb = _hexToRgb(hex);
                    if (rgb) leafySurfaces.push(rgb);
                }
            });
        }

        let cx = _camera.position.x;
        let cz = _camera.position.z;
        let placed = 0;
        let attempts = 0;
        let maxAttempts = PRE_SPAWN * 4; // Allow some failures

        while (placed < PRE_SPAWN && attempts < maxAttempts) {
            attempts++;

            // Random position across the whole terrain (not just camera radius)
            let x = (Math.random() - 0.5) * TERRAIN_SIZE * 0.9;
            let z = (Math.random() - 0.5) * TERRAIN_SIZE * 0.9;

            // Check terrain type at this position
            if (terrainData && leafySurfaces.length > 0) {
                let px = Math.floor(((x + TERRAIN_SIZE / 2) / TERRAIN_SIZE) * 4096);
                let pz = Math.floor(((z + TERRAIN_SIZE / 2) / TERRAIN_SIZE) * 4096);
                px = Math.max(0, Math.min(4095, px));
                pz = Math.max(0, Math.min(4095, pz));

                let idx = (pz * 4096 + px) * 4;
                let pr = terrainData[idx];
                let pg = terrainData[idx + 1];
                let pb = terrainData[idx + 2];

                // Check if this pixel is close to a "leafy" surface
                let isLeafy = false;
                for (let s = 0; s < leafySurfaces.length; s++) {
                    let dr = pr - leafySurfaces[s].r;
                    let dg = pg - leafySurfaces[s].g;
                    let db = pb - leafySurfaces[s].b;
                    if (dr * dr + dg * dg + db * db < 3000) {
                        isLeafy = true;
                        break;
                    }
                }

                if (!isLeafy) continue; // Skip fairway/green/bunker/water
            }

            // Get terrain height
            let groundY = GROUND_Y;
            if (window.getTerrainHeight) {
                let h = window.getTerrainHeight(x, z);
                if (h !== undefined && h !== null) groundY = h + 0.08;
            }

            let scale = LEAF_SCALE[0] + Math.random() * (LEAF_SCALE[1] - LEAF_SCALE[0]);
            let colorIdx = Math.floor(Math.random() * LEAF_COLORS.length);

            let slotIdx = _groundIdx % MAX_GROUND;
            _groundIdx++;

            // Flat on ground with random rotation
            _euler.set(Math.PI / 2 + (Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, 0);
            _quat.setFromEuler(_euler);
            _pos.set(x, groundY, z);
            _scl.set(scale, scale, scale);

            _dummy.position.copy(_pos);
            _dummy.quaternion.copy(_quat);
            _dummy.scale.copy(_scl);
            _dummy.updateMatrix();
            _groundMesh.setMatrixAt(slotIdx, _dummy.matrix);

            let col = LEAF_COLORS[colorIdx];
            _color.setRGB(col[0], col[1], col[2]);
            _groundMesh.setColorAt(slotIdx, _color);

            placed++;
        }

        _groundMesh.instanceMatrix.needsUpdate = true;
        _groundMesh.instanceColor.needsUpdate = true;
    }

    function _hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length !== 6) return null;
        return {
            r: parseInt(hex.substr(0, 2), 16),
            g: parseInt(hex.substr(2, 2), 16),
            b: parseInt(hex.substr(4, 2), 16)
        };
    }

    // ---------------------------------------------------------------
    // DEACTIVATE — remove everything
    // ---------------------------------------------------------------
    function deactivate() {
        if (!_active) return;
        _active = false;

        if (_fallingMesh) {
            _scene.remove(_fallingMesh);
            _fallingMesh.geometry.dispose();
            _fallingMesh.dispose();
            _fallingMesh = null;
        }
        if (_groundMesh) {
            _scene.remove(_groundMesh);
            _groundMesh.geometry.dispose();
            _groundMesh.dispose();
            _groundMesh = null;
        }
        if (_leafGeo) { _leafGeo.dispose(); _leafGeo = null; }
        if (_leafMat) { _leafMat.dispose(); _leafMat = null; }

        _fallingData = [];
        _groundData = [];
        _groundIdx = 0;

        console.log('[AutumnLeaves] Deactivated');
    }

    // ---------------------------------------------------------------
    // SPAWN a new falling leaf
    // ---------------------------------------------------------------
    function _spawnFallingLeaf(randomY) {
        let cx = _camera ? _camera.position.x : 0;
        let cz = _camera ? _camera.position.z : 0;

        let angle = Math.random() * Math.PI * 2;
        let dist = Math.random() * SPAWN_RADIUS;

        let x = cx + Math.cos(angle) * dist;
        let z = cz + Math.sin(angle) * dist;
        let y = randomY
            ? SPAWN_HEIGHT[0] + Math.random() * (SPAWN_HEIGHT[1] - SPAWN_HEIGHT[0])
            : SPAWN_HEIGHT[1] + Math.random() * 5;

        let speed = FALL_SPEED[0] + Math.random() * (FALL_SPEED[1] - FALL_SPEED[0]);

        // Wind influence
        let windMph = window.currentWindMph || 0;
        let windDirRad = (window.currentWindDir || 0) * Math.PI / 180;
        let windDrift = windMph * 0.05;

        let scale = LEAF_SCALE[0] + Math.random() * (LEAF_SCALE[1] - LEAF_SCALE[0]);
        let colorIdx = Math.floor(Math.random() * LEAF_COLORS.length);

        return {
            x, y, z,
            vx: (Math.random() - 0.5) * 0.5 + Math.sin(windDirRad) * windDrift,
            vy: -speed,
            vz: (Math.random() - 0.5) * 0.5 - Math.cos(windDirRad) * windDrift,
            // Rotation
            rx: Math.random() * Math.PI * 2,
            ry: Math.random() * Math.PI * 2,
            rz: Math.random() * Math.PI * 2,
            // Tumble speeds
            rvx: (Math.random() - 0.5) * TUMBLE_SPEED[1],
            rvy: (Math.random() - 0.5) * TUMBLE_SPEED[0],
            rvz: (Math.random() - 0.5) * TUMBLE_SPEED[0],
            scale,
            colorIdx,
            // Oscillation phase for side-to-side flutter
            phase: Math.random() * Math.PI * 2
        };
    }

    // ---------------------------------------------------------------
    // LAND a leaf on the ground
    // ---------------------------------------------------------------
    function _landLeaf(leaf) {
        // Get terrain height at this position
        let groundY = GROUND_Y;
        if (window.getTerrainHeight) {
            let h = window.getTerrainHeight(leaf.x, leaf.z);
            if (h !== undefined && h !== null) groundY = h + 0.08;
        }

        let idx = _groundIdx % MAX_GROUND;
        _groundIdx++;

        // Flat on ground with random rotation
        _euler.set(Math.PI / 2 + (Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, 0);
        _quat.setFromEuler(_euler);
        _pos.set(leaf.x, groundY, leaf.z);
        _scl.set(leaf.scale, leaf.scale, leaf.scale);

        _dummy.position.copy(_pos);
        _dummy.quaternion.copy(_quat);
        _dummy.scale.copy(_scl);
        _dummy.updateMatrix();
        _groundMesh.setMatrixAt(idx, _dummy.matrix);

        let col = LEAF_COLORS[leaf.colorIdx];
        _color.setRGB(col[0], col[1], col[2]);
        _groundMesh.setColorAt(idx, _color);

        _groundMesh.instanceMatrix.needsUpdate = true;
        _groundMesh.instanceColor.needsUpdate = true;
    }

    // ---------------------------------------------------------------
    // UPDATE — call every frame
    // ---------------------------------------------------------------
    function update(dt) {
        if (!_active || !_fallingMesh || !_camera) return;

        // Cap dt to avoid physics explosion after tab-switch
        if (dt > 0.1) dt = 0.1;

        let cx = _camera.position.x;
        let cz = _camera.position.z;

        // Wind for this frame
        let windMph = window.currentWindMph || 0;
        let windDirRad = (window.currentWindDir || 0) * Math.PI / 180;
        let windForceX = Math.sin(windDirRad) * windMph * 0.03;
        let windForceZ = -Math.cos(windDirRad) * windMph * 0.03;

        for (let i = 0; i < _fallingData.length; i++) {
            let leaf = _fallingData[i];

            // Physics
            leaf.vx += windForceX * dt;
            leaf.vz += windForceZ * dt;

            // Side-to-side flutter (sine wave)
            leaf.phase += dt * 2.5;
            let flutter = Math.sin(leaf.phase) * 0.8 * dt;
            leaf.x += leaf.vx * dt + flutter;
            leaf.y += leaf.vy * dt;
            leaf.z += leaf.vz * dt;

            // Tumble rotation
            leaf.rx += leaf.rvx * dt;
            leaf.ry += leaf.rvy * dt;
            leaf.rz += leaf.rvz * dt;

            // Check if landed
            let terrainY = 0;
            if (window.getTerrainHeight) {
                let h = window.getTerrainHeight(leaf.x, leaf.z);
                if (h !== undefined && h !== null) terrainY = h;
            }

            if (leaf.y <= terrainY + 0.1) {
                // Land this leaf on the ground
                _landLeaf(leaf);
                // Respawn as new falling leaf
                _fallingData[i] = _spawnFallingLeaf(false);
                leaf = _fallingData[i];
            }

            // Too far from camera? Respawn closer
            let dx = leaf.x - cx;
            let dz = leaf.z - cz;
            if (dx * dx + dz * dz > SPAWN_RADIUS * SPAWN_RADIUS * 1.5) {
                _fallingData[i] = _spawnFallingLeaf(true);
                leaf = _fallingData[i];
            }

            // Update instance matrix
            _euler.set(leaf.rx, leaf.ry, leaf.rz);
            _quat.setFromEuler(_euler);
            _pos.set(leaf.x, leaf.y, leaf.z);
            _scl.set(leaf.scale, leaf.scale, leaf.scale);

            _dummy.position.copy(_pos);
            _dummy.quaternion.copy(_quat);
            _dummy.scale.copy(_scl);
            _dummy.updateMatrix();
            _fallingMesh.setMatrixAt(i, _dummy.matrix);

            // Color
            let col = LEAF_COLORS[leaf.colorIdx];
            _color.setRGB(col[0], col[1], col[2]);
            _fallingMesh.setColorAt(i, _color);
        }

        _fallingMesh.instanceMatrix.needsUpdate = true;
        _fallingMesh.instanceColor.needsUpdate = true;
    }

    function isActive() { return _active; }

    // ---------------------------------------------------------------
    // PUBLIC API
    // ---------------------------------------------------------------
    window.AutumnLeaves = {
        init,
        activate,
        deactivate,
        update,
        isActive
    };

})();
