// ============================================================
// rally-roads.js — Smart Roads Spline System for 3D-Rally-AR
// Editor-only module (loaded in arcade.html, NOT rally.html)
// Paints roads on the biome canvas (pCtx) for visual + physics
// ============================================================
(function() {
'use strict';

// ROAD SYSTEM — Biome colors that classifyBiomeColor() maps to correct rally surfaces
const ROAD_BIOME_COLORS = {
    GRAVEL: '#C2AF7C',   // → WASTE → GRAVEL (grip 0.62)
    TARMAC: '#7DB952',    // → FAIRWAY → ASPHALT (grip 0.97)
    MUD:    '#2D4C1A',    // → FESCUE → MUD (grip 0.38)
};

// ROAD SYSTEM — Configuration
const ROAD_CFG = {
    DEFAULT_WIDTH:    8.0,     // meters
    BLEND_WIDTH:      0.0,     // meters — hard edge for correct physics (no alpha-mix artifacts)
    SAMPLE_DENSITY:   2.0,     // meters per sample point (was 0.5 — 4x fewer calcs, same visual)
    MIN_NODES:        2,       // minimum nodes to form a road
    MAX_NODES:        200,     // performance cap
    NODE_SPHERE_R:    0.5,     // node marker radius (meters)
    PREVIEW_COLOR:    0xff4444,// spline preview line color
    NODE_COLOR:       0xfbbf24,// yellow node markers
    NODE_ACTIVE_COLOR:0x38bdf8,// blue for active/hovered node
};

// ── Internal state ──
let _scene = null;
let _planeGeo = null;
let _pCtx = null;
let _mapTex = null;
let _getTerrainHeight = null;
let _canvasSize = 4096;
let _terrainSize = 900;

// Base canvas snapshot (road-free state) for undo/delete restoration
let _baseCanvasData = null;

// 3D helper objects
let _previewLine = null;
let _previewGeo = null;
let _nodeSpheres = [];
let _nodeGroup = null;

// ── Road data model ──
// Each road: { id, nodes: [{worldX, worldY, worldZ}], width, material, sampledPoints }
let _roads = [];
let _activeNodes = [];  // Nodes of road currently being drawn
let _activeWidth = ROAD_CFG.DEFAULT_WIDTH;
let _activeMaterial = 'GRAVEL';

// ── UUID generator ──
function uuid() {
    return 'road_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
}

// ── Spline computation ──
function buildSpline(nodes) {
    if (nodes.length < 2) return null;
    let points = nodes.map(n => new THREE.Vector3(n.worldX, n.worldY, n.worldZ));
    // Use catmullrom with 0.5 tension for smooth curves
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
}

function sampleSpline(curve, sampleDensity) {
    if (!curve) return [];
    let length = curve.getLength();
    let count = Math.max(2, Math.ceil(length / sampleDensity));
    let points = [];
    for (let i = 0; i <= count; i++) {
        let t = i / count;
        let pos = curve.getPoint(t);
        // Conform to terrain height
        if (_getTerrainHeight) {
            let h = _getTerrainHeight(pos.x, pos.z);
            if (typeof h === 'number' && isFinite(h)) {
                pos.y = h + 0.04; // Tiny Y offset to prevent z-fighting on preview
            }
        }
        points.push(pos);
    }
    return points;
}

// ── Canvas painting ──

function captureBaseCanvas() {
    // ROAD SYSTEM — Snapshot the canvas BEFORE any roads are painted
    // Used to restore road-free state on undo/delete
    if (!_pCtx) return;
    _baseCanvasData = _pCtx.getImageData(0, 0, _canvasSize, _canvasSize);
}

function restoreBaseCanvas() {
    // ROAD SYSTEM — Restore road-free canvas state
    if (!_pCtx || !_baseCanvasData) return;
    _pCtx.putImageData(_baseCanvasData, 0, 0);
}

function worldToCanvas(worldX, worldZ) {
    // Convert world coordinates to canvas pixel coordinates
    // World: -terrainSize/2 to +terrainSize/2
    // Canvas: 0 to canvasSize
    let cx = (worldX / _terrainSize + 0.5) * _canvasSize;
    let cy = (worldZ / _terrainSize + 0.5) * _canvasSize;
    return { x: cx, y: cy };
}

function paintRoad(road) {
    // ROAD SYSTEM — Paint a single road onto the biome canvas
    if (!_pCtx || !road.sampledPoints || road.sampledPoints.length < 2) return;

    let color = ROAD_BIOME_COLORS[road.material] || ROAD_BIOME_COLORS.GRAVEL;
    let canvasWidth = (road.width / _terrainSize) * _canvasSize;

    // ── DEBUG: Canvas road coverage ──
    let sp = road.sampledPoints;
    let canvasLen = 0;
    for (let i = 1; i < sp.length; i++) {
        canvasLen += Math.sqrt((sp[i].x - sp[i-1].x) ** 2 + (sp[i].z - sp[i-1].z) ** 2);
    }
    console.log('🎨 CANVAS ROAD DEBUG:');
    console.log('  sampledPoints:', sp.length);
    console.log('  First: x=' + sp[0].x.toFixed(1) + ' z=' + sp[0].z.toFixed(1));
    console.log('  Last:  x=' + sp[sp.length-1].x.toFixed(1) + ' z=' + sp[sp.length-1].z.toFixed(1));
    console.log('  Total length:', canvasLen.toFixed(1) + 'm');
    console.log('  lineCap: round → extends ' + (road.width/2).toFixed(1) + 'm at each end');
    // ── END DEBUG ──

    // Paint core road (full opacity, hard edge — correct physics across entire width)
    _pCtx.save();
    _pCtx.globalAlpha = 1.0;
    _pCtx.strokeStyle = color;
    _pCtx.lineWidth = canvasWidth;
    _pCtx.lineCap = 'round';
    _pCtx.lineJoin = 'round';
    _pCtx.beginPath();
    road.sampledPoints.forEach(function(p, i) {
        let c = worldToCanvas(p.x, p.z);
        if (i === 0) _pCtx.moveTo(c.x, c.y);
        else _pCtx.lineTo(c.x, c.y);
    });
    _pCtx.stroke();
    _pCtx.restore();
}

function bakeAllRoads() {
    // ROAD SYSTEM — Repaint all roads on canvas
    // Preserves manual paint strokes by NOT restoring base if paint has been done
    
    // Strategy: restore base → paint roads → update texture
    // If roads exist and we need a clean repaint, restore base first
    // The base snapshot includes manual paint (updated after each paint stroke)
    restoreBaseCanvas();
    for (let i = 0; i < _roads.length; i++) {
        paintRoad(_roads[i]);
    }
    if (_mapTex) _mapTex.needsUpdate = true;

    // PHASE 2 — bake road mask into vertex colors (R-channel) for ShaderMaterial
    if (window.terrainShaderGeo && _planeGeo) {
        window.terrainShaderGeo.bakeRoadVertexColors(_roads, _planeGeo, _terrainSize);
    }

    // Road decal meshes — rebuild gravel strip overlays
    if (window.roadDecal && _scene) {
        window.roadDecal.rebuildAll(_roads, _scene);
    }

    // Update terrainBiomeData cache if it exists
    if (window.terrainBiomeData && _pCtx) {
        let imgData = _pCtx.getImageData(0, 0, _canvasSize, _canvasSize);
        // terrainBiomeData is a Uint8ClampedArray reference — overwrite its contents
        if (window.terrainBiomeData.length === imgData.data.length) {
            window.terrainBiomeData.set(imgData.data);
        } else {
            window.terrainBiomeData = imgData.data;
        }
    }
}

// Update base snapshot to include current manual paint strokes
// Call this after PAINT tool mouseup so paint survives road rebakes
function updateBaseAfterPaint() {
    if (!_pCtx || _roads.length === 0) {
        // No roads — just snapshot current canvas directly
        captureBaseCanvas();
        return;
    }
    // Canvas currently has: base + paint + roads
    // We need base = current canvas WITHOUT roads
    // Strategy: save current, restore old base, apply paint diff, snapshot, repaint roads
    
    // Simpler approach: just snapshot current state (includes road paint)
    // When bakeAllRoads restores + repaints, roads double-paint same pixels = visually identical
    captureBaseCanvas();
}

// ── 3D preview & node visualization ──

function createNodeGroup() {
    if (_nodeGroup) return;
    _nodeGroup = new THREE.Group();
    _nodeGroup.name = 'roadNodeGroup';
    if (_scene) _scene.add(_nodeGroup);
}

function clearNodeSpheres() {
    for (let i = 0; i < _nodeSpheres.length; i++) {
        if (_nodeGroup) _nodeGroup.remove(_nodeSpheres[i]);
        _nodeSpheres[i].geometry.dispose();
        _nodeSpheres[i].material.dispose();
    }
    _nodeSpheres.length = 0;
}

function rebuildNodeSpheres() {
    clearNodeSpheres();
    createNodeGroup();
    for (let i = 0; i < _activeNodes.length; i++) {
        let n = _activeNodes[i];
        let geo = new THREE.SphereGeometry(ROAD_CFG.NODE_SPHERE_R, 12, 8);
        let mat = new THREE.MeshBasicMaterial({ color: ROAD_CFG.NODE_COLOR, depthTest: false });
        let sphere = new THREE.Mesh(geo, mat);
        sphere.position.set(n.worldX, n.worldY + 0.3, n.worldZ);
        sphere.renderOrder = 999;
        _nodeGroup.add(sphere);
        _nodeSpheres.push(sphere);
    }
}

function updatePreviewLine() {
    if (!_scene) return;

    // Remove old preview
    if (_previewLine) {
        _scene.remove(_previewLine);
        if (_previewGeo) _previewGeo.dispose();
        _previewLine.material.dispose();
        _previewLine = null;
        _previewGeo = null;
    }

    if (_activeNodes.length < 2) return;

    // Build spline from active nodes
    let curve = buildSpline(_activeNodes);
    if (!curve) return;
    let sampled = sampleSpline(curve, ROAD_CFG.SAMPLE_DENSITY);
    if (sampled.length < 2) return;

    // Create line geometry
    let positions = new Float32Array(sampled.length * 3);
    for (let i = 0; i < sampled.length; i++) {
        positions[i * 3]     = sampled[i].x;
        positions[i * 3 + 1] = sampled[i].y + 0.15; // Slight lift for visibility
        positions[i * 3 + 2] = sampled[i].z;
    }

    _previewGeo = new THREE.BufferGeometry();
    _previewGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    let mat = new THREE.LineBasicMaterial({
        color: ROAD_CFG.PREVIEW_COLOR,
        linewidth: 2,
        depthTest: false
    });
    _previewLine = new THREE.Line(_previewGeo, mat);
    _previewLine.renderOrder = 998;
    _previewLine.name = 'roadPreviewLine';
    _scene.add(_previewLine);
}

function cleanupPreview() {
    // Remove preview line
    if (_previewLine && _scene) {
        _scene.remove(_previewLine);
        if (_previewGeo) _previewGeo.dispose();
        _previewLine.material.dispose();
        _previewLine = null;
        _previewGeo = null;
    }
    // Remove node spheres
    clearNodeSpheres();
    if (_nodeGroup && _scene) {
        _scene.remove(_nodeGroup);
        _nodeGroup = null;
    }
}

// ── Serialization ──

function dumpRoads() {
    return _roads.map(function(road) {
        return {
            id: road.id,
            nodes: road.nodes.map(function(n) {
                return { worldX: n.worldX, worldY: n.worldY, worldZ: n.worldZ };
            }),
            width: road.width,
            material: road.material
        };
    });
}

function loadRoads(data) {
    if (!data || !Array.isArray(data)) return;
    _roads.length = 0;
    for (let i = 0; i < data.length; i++) {
        let rd = data[i];
        if (!rd.nodes || rd.nodes.length < ROAD_CFG.MIN_NODES) continue;

        // Re-conform Y to current terrain
        let nodes = rd.nodes.map(function(n) {
            let y = n.worldY || 0;
            if (_getTerrainHeight) {
                let h = _getTerrainHeight(n.worldX, n.worldZ);
                if (typeof h === 'number' && isFinite(h)) y = h;
            }
            return { worldX: n.worldX, worldY: y, worldZ: n.worldZ };
        });

        let curve = buildSpline(nodes);
        let sampled = curve ? sampleSpline(curve, ROAD_CFG.SAMPLE_DENSITY) : [];

        _roads.push({
            id: rd.id || uuid(),
            nodes: nodes,
            width: rd.width || ROAD_CFG.DEFAULT_WIDTH,
            material: rd.material || 'GRAVEL',
            sampledPoints: sampled
        });
    }
    // Bake all loaded roads onto canvas
    bakeAllRoads();
}

// ── Public API ──

window.roadSystem = {
    roads: _roads,

    init: function(scene, planeGeo, pCtx, mapTex, getTerrainHeight) {
        _scene = scene;
        _planeGeo = planeGeo;
        _pCtx = pCtx;
        _mapTex = mapTex;
        _getTerrainHeight = getTerrainHeight;
        _terrainSize = window.TERRAIN_SIZE || 900;
        _canvasSize = pCtx ? pCtx.canvas.width : 4096;

        // Capture road-free canvas state
        captureBaseCanvas();
        console.log('🛣️ Road system initialized (canvas ' + _canvasSize + 'px, terrain ' + _terrainSize + 'm)');
    },

    // ROAD SYSTEM — Take a fresh base snapshot (call when activating ROAD tool)
    refreshBaseSnapshot: function() {
        // Only capture if no roads are currently painted
        // If roads exist, we need to restore base first, capture, then repaint
        if (_roads.length > 0) {
            restoreBaseCanvas();
            captureBaseCanvas();
            bakeAllRoads();
        } else {
            captureBaseCanvas();
        }
    },

    // Update base canvas to include manual paint strokes
    // Call after PAINT tool mouseup so paint survives road rebakes
    updateBaseAfterPaint: function() {
        updateBaseAfterPaint();
    },

    addNode: function(hitPoint) {
        if (!hitPoint) return false;
        if (_activeNodes.length >= ROAD_CFG.MAX_NODES) return false;

        let y = hitPoint.y || 0;
        if (_getTerrainHeight) {
            let h = _getTerrainHeight(hitPoint.x, hitPoint.z);
            if (typeof h === 'number' && isFinite(h)) y = h;
        }

        _activeNodes.push({
            worldX: hitPoint.x,
            worldY: y,
            worldZ: hitPoint.z
        });

        rebuildNodeSpheres();
        updatePreviewLine();
        return true;
    },

    removeLastNode: function() {
        if (_activeNodes.length === 0) return false;
        _activeNodes.pop();
        rebuildNodeSpheres();
        updatePreviewLine();
        return true;
    },

    finishRoad: function() {
        if (_activeNodes.length < ROAD_CFG.MIN_NODES) {
            console.warn('🛣️ Need at least ' + ROAD_CFG.MIN_NODES + ' nodes to create a road');
            return false;
        }

        let curve = buildSpline(_activeNodes);
        if (!curve) return false;
        let sampled = sampleSpline(curve, ROAD_CFG.SAMPLE_DENSITY);

        let road = {
            id: uuid(),
            nodes: _activeNodes.slice(), // Copy
            width: _activeWidth,
            material: _activeMaterial,
            sampledPoints: sampled
        };

        _roads.push(road);

        // ROAD SYSTEM — bake ALL roads from clean base (fixes overlap alpha artifacts)
        bakeAllRoads();

        // Clear active drawing state
        _activeNodes.length = 0;
        cleanupPreview();

        console.log('🛣️ Road baked (' + road.material + ', ' + road.width.toFixed(1) + 'm wide, ' + sampled.length + ' samples)');
        return true;
    },

    clearActiveRoad: function() {
        _activeNodes.length = 0;
        cleanupPreview();
    },

    deleteRoad: function(index) {
        if (index < 0 || index >= _roads.length) return false;
        _roads.splice(index, 1);
        // ROAD SYSTEM — Restore base canvas and repaint all remaining roads
        bakeAllRoads();
        return true;
    },

    deleteLastRoad: function() {
        if (_roads.length === 0) return false;
        return this.deleteRoad(_roads.length - 1);
    },

    deleteAllRoads: function() {
        _roads.length = 0;
        // ROAD SYSTEM — Restore to road-free canvas
        restoreBaseCanvas();
        if (_mapTex) _mapTex.needsUpdate = true;
        // PHASE 2 — clear vertex color R-channel (road mask)
        if (window.terrainShaderGeo && _planeGeo) {
            window.terrainShaderGeo.bakeRoadVertexColors([], _planeGeo, _terrainSize);
        }
        // Road decal meshes — remove all
        if (window.roadDecal && _scene) {
            window.roadDecal.clearAllRoadMeshes(_scene);
        }
        // Update terrainBiomeData
        if (window.terrainBiomeData && _pCtx && _baseCanvasData) {
            if (window.terrainBiomeData.length === _baseCanvasData.data.length) {
                window.terrainBiomeData.set(_baseCanvasData.data);
            } else {
                window.terrainBiomeData = new Uint8ClampedArray(_baseCanvasData.data);
            }
        }
    },

    bakeAllRoads: bakeAllRoads,

    setWidth: function(w) {
        _activeWidth = Math.max(4, Math.min(16, parseFloat(w) || ROAD_CFG.DEFAULT_WIDTH));
    },

    setMaterial: function(type) {
        if (ROAD_BIOME_COLORS[type]) _activeMaterial = type;
    },

    getWidth: function() { return _activeWidth; },
    getMaterial: function() { return _activeMaterial; },
    getActiveNodeCount: function() { return _activeNodes.length; },
    getRoadCount: function() { return _roads.length; },
    isDrawing: function() { return _activeNodes.length > 0; },

    dumpRoads: dumpRoads,
    loadRoads: loadRoads,

    cleanup: function() {
        cleanupPreview();
        _activeNodes.length = 0;
    },

    // Expose config for UI
    CFG: ROAD_CFG,
    MATERIALS: Object.keys(ROAD_BIOME_COLORS),
    getRoads: function() { return _roads; },
    getScene: function() { return _scene; }
};

})();
