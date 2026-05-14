// ============================================================
// smart-builder.js — Smart Builder Module for Golf OS Arcade
// Extracted from arcade.html for maintainability
// All shared state accessed via window.* namespace
// ============================================================

// === SMART GREEN SPLINE STATE ===
// Using var for global accessibility from arcade.html event handlers
var smartGreenPoints = [];
var smartGreenSpheres = [];
var smartGreenLineMesh = null;

// === MOWING PATTERN PAINTER ===
// Paints stripe/checker/diamond patterns inside a polygon on the terrain canvas
// Called after the solid base fill for both greens and fairways
function paintMowingPattern(ctx, densePts, baseColor, patternType, stripeAngle) {
    if (!patternType || patternType === 'SOLID') return;

    var TS = window.TERRAIN_SIZE;
    var scale = 4096 / TS;

    // Parse base color → HSL for lighter/darker stripes
    var tempCanvas = document.createElement('canvas');
    tempCanvas.width = 1; tempCanvas.height = 1;
    var tc = tempCanvas.getContext('2d');
    tc.fillStyle = baseColor;
    tc.fillRect(0, 0, 1, 1);
    var px = tc.getImageData(0, 0, 1, 1).data;
    var r = px[0], g = px[1], b = px[2];

    // Lighter stripe color (+12 brightness, slight saturation shift)
    var lightR = Math.min(255, r + 14);
    var lightG = Math.min(255, g + 16);
    var lightB = Math.min(255, b + 8);
    var lightColor = 'rgb(' + lightR + ',' + lightG + ',' + lightB + ')';
    // Darker stripe color (base is already painted, so we only paint light stripes)

    // Bounding box of polygon in world coords
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var i = 0; i < densePts.length; i++) {
        if (densePts[i].x < minX) minX = densePts[i].x;
        if (densePts[i].x > maxX) maxX = densePts[i].x;
        if (densePts[i].z < minZ) minZ = densePts[i].z;
        if (densePts[i].z > maxZ) maxZ = densePts[i].z;
    }

    // Stripe width in world meters
    var stripeW = (patternType === 'CHECKERBOARD' || patternType === 'DIAMOND') ? 2.5 : 3.0;
    var stripeWpx = stripeW * scale;

    // Clip to polygon shape
    ctx.save();
    ctx.beginPath();
    for (var i = 0; i < densePts.length; i++) {
        var pxX = ((densePts[i].x + TS / 2) / TS) * 4096;
        var pxY = ((densePts[i].z + TS / 2) / TS) * 4096;
        if (i === 0) ctx.moveTo(pxX, pxY);
        else ctx.lineTo(pxX, pxY);
    }
    ctx.closePath();
    ctx.clip();

    // Compute rotation center in pixels
    var cx = ((minX + maxX) / 2 + TS / 2) / TS * 4096;
    var cz = ((minZ + maxZ) / 2 + TS / 2) / TS * 4096;

    // Auto-detect principal axis (longest direction) via 2D PCA
    // Compute centroid
    var centX = 0, centZ = 0;
    for (var i = 0; i < densePts.length; i++) { centX += densePts[i].x; centZ += densePts[i].z; }
    centX /= densePts.length; centZ /= densePts.length;
    // Covariance matrix [cxx, cxz; cxz, czz]
    var cxx = 0, cxz = 0, czz = 0;
    for (var i = 0; i < densePts.length; i++) {
        var dx = densePts[i].x - centX;
        var dz = densePts[i].z - centZ;
        cxx += dx * dx; cxz += dx * dz; czz += dz * dz;
    }
    // Principal eigenvector angle (largest eigenvalue direction)
    var angle = 0.5 * Math.atan2(2 * cxz, cxx - czz);
    if (patternType === 'DIAGONAL') angle += Math.PI / 4;
    if (patternType === 'DIAMOND') angle += Math.PI / 4;

    ctx.translate(cx, cz);
    ctx.rotate(angle);
    ctx.translate(-cx, -cz);

    // Draw range (expanded for rotation)
    var diagLen = Math.sqrt((maxX - minX) * (maxX - minX) + (maxZ - minZ) * (maxZ - minZ));
    var halfDiag = (diagLen / 2 + stripeW * 2) * scale;
    var startX = cx - halfDiag;
    var endX = cx + halfDiag;
    var startZ = cz - halfDiag;
    var endZ = cz + halfDiag;

    ctx.fillStyle = lightColor;

    if (patternType === 'STRIPES' || patternType === 'DIAGONAL') {
        // Alternating horizontal bands (every other stripe)
        for (var z = startZ; z < endZ; z += stripeWpx * 2) {
            ctx.fillRect(startX, z, (endX - startX), stripeWpx);
        }
    } else if (patternType === 'CHECKERBOARD' || patternType === 'DIAMOND') {
        // Realistic cross-mow: two perpendicular stripe passes
        // Pass 1: horizontal stripes (lighter)
        ctx.globalAlpha = 0.5;
        for (var z = startZ; z < endZ; z += stripeWpx * 2) {
            ctx.fillRect(startX, z, (endX - startX), stripeWpx);
        }
        // Pass 2: vertical stripes (lighter), creates woven crosshatch
        for (var x = startX; x < endX; x += stripeWpx * 2) {
            ctx.fillRect(x, startZ, stripeWpx, (endZ - startZ));
        }
        ctx.globalAlpha = 1.0;
    }

    ctx.restore(); // Removes clip + rotation
}
// === Anti-crossing utilities for Smart Builder ===
// Line segment intersection test (2D, using x/z)
function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
    let det = (bx-ax)*(dz-cz) - (bz-az)*(dx-cx);
    if(Math.abs(det) < 0.0001) return false; // parallel
    let t = ((cx-ax)*(dz-cz) - (cz-az)*(dx-cx)) / det;
    let u = ((cx-ax)*(bz-az) - (cz-az)*(bx-ax)) / det;
    return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

// Check if adding newPt at a specific index would cause self-intersection
function wouldCauseCrossing(pts, newPt, insertIdx) {
    if(pts.length < 2) return false;
    let testPts = pts.slice();
    testPts.splice(insertIdx, 0, newPt);
    // Check all pairs of non-adjacent segments
    let n = testPts.length;
    for(let i = 0; i < n; i++) {
        let a = testPts[i], b = testPts[(i+1) % n];
        for(let j = i+2; j < n; j++) {
            if(i === 0 && j === n-1) continue; // adjacent (closing segment)
            let cc = testPts[j], d = testPts[(j+1) % n];
            if(segmentsIntersect(a.x, a.z, b.x, b.z, cc.x, cc.z, d.x, d.z)) {
                return true;
            }
        }
    }
    return false;
}

// Find the nearest edge index to insert a point (returns index to splice at)
function findNearestEdge(pts, pt) {
    let bestDist = Infinity;
    let bestIdx = pts.length; // default: append
    for(let i = 0; i < pts.length; i++) {
        let a = pts[i];
        let b = pts[(i+1) % pts.length];
        // Project pt onto segment a→b
        let dx = b.x - a.x, dz = b.z - a.z;
        let len2 = dx*dx + dz*dz;
        if(len2 < 0.001) continue;
        let t = Math.max(0, Math.min(1, ((pt.x-a.x)*dx + (pt.z-a.z)*dz) / len2));
        let projX = a.x + t*dx, projZ = a.z + t*dz;
        let dist = Math.sqrt((pt.x-projX)**2 + (pt.z-projZ)**2);
        if(dist < bestDist) {
            bestDist = dist;
            bestIdx = i + 1; // insert AFTER point i
        }
    }
    return bestIdx;
}

// Smart point placement: always append, with magnet-snap to close the shape
function smartAddPoint(pt) {
    // If shape is already closed, don't add more points
    if(window._smartShapeClosed) return false;
    
    // Magnet-snap: if >= 3 points and new click is within 10m of FIRST point → close shape
    if(smartGreenPoints.length >= 3) {
        let first = smartGreenPoints[0];
        let dist = Math.sqrt((pt.x - first.x)**2 + (pt.z - first.z)**2);
        if(dist < 5.0) {
            // Snap! Close the shape (don't add the point — loop back to start)
            window._smartShapeClosed = true;
            window.showBuildToast('🔒 Shape closed! Press Build', '#4ade80');
            return true;
        }
    }
    
    smartGreenPoints.push(pt);
    return true;
}

function resortTeesForAimPoint(hole) {
    if (!hole.aimPoint) return;
    let ap = hole.aimPoint;
    let orderedKeys = ['red','yellow','white','black'];
    let existingTees = [];
    for(let k of orderedKeys) {
        if(hole.tees[k] && hole.teeMeshes[k]) existingTees.push(k);
    }
    if(existingTees.length >= 2) {
        let positions = existingTees.map(k => ({x: hole.tees[k].x, y: hole.tees[k].y, z: hole.tees[k].z}));
        positions.sort(function(a, b) {
            let da = (a.x-ap.x)*(a.x-ap.x) + (a.z-ap.z)*(a.z-ap.z);
            let db = (b.x-ap.x)*(b.x-ap.x) + (b.z-ap.z)*(b.z-ap.z);
            return da - db;
        });
        for(let i = 0; i < existingTees.length; i++) {
            let k = existingTees[i];
            let pos = positions[i];
            let rot = Math.atan2(ap.x - pos.x, ap.z - pos.z);
            hole.tees[k].x = pos.x; hole.tees[k].y = pos.y; hole.tees[k].z = pos.z;
            hole.tees[k].rot = rot;
            hole.teeMeshes[k].position.set(pos.x, pos.y, pos.z);
            hole.teeMeshes[k].rotation.y = rot;
        }
        let colorEmoji = { red: '🔴', yellow: '🟡', white: '⚪', black: '⬛' };
        let distText = existingTees.map(function(k) {
            let dx = hole.tees[k].x - ap.x;
            let dz = hole.tees[k].z - ap.z;
            return colorEmoji[k] + ' ' + Math.round(Math.sqrt(dx*dx + dz*dz)) + 'm';
        }).join('  ');
        window.showBuildToast('🔄 Tees sorted: ' + distText, '#a855f7');
    } else if(existingTees.length === 1) {
        let k = existingTees[0];
        let rot = Math.atan2(ap.x - hole.tees[k].x, ap.z - hole.tees[k].z);
        hole.tees[k].rot = rot;
        hole.teeMeshes[k].rotation.y = rot;
    }
}

// Auto-sort tees: reassign colors so Red=closest to flag, Black=furthest
function autoSortTees(hole) {
    if (!hole.flag) return;
    
    let colorOrder = ['red', 'yellow', 'white', 'black'];
    let colorHex = { red: 0xef4444, yellow: 0xfacc15, white: 0xffffff, black: 0x111111 };
    let colorEmoji = { red: '🔴', yellow: '🟡', white: '⚪', black: '⬛' };
    
    // Collect all placed tees (not range) with their positions + distances
    let placedTees = [];
    colorOrder.forEach(c => {
        if (hole.tees[c]) {
            let dx = hole.tees[c].x - hole.flag.x;
            let dz = hole.tees[c].z - hole.flag.z;
            let dist = Math.sqrt(dx*dx + dz*dz);
            placedTees.push({ 
                pos: { ...hole.tees[c] },  // Clone position
                dist: dist
            });
        }
    });
    
    if (placedTees.length < 2) return; // Nothing to sort with 0-1 tees
    
    // Sort by distance: closest first
    placedTees.sort((a, b) => a.dist - b.dist);
    
    // Check if already in correct order
    let alreadyCorrect = true;
    let existingColors = colorOrder.filter(c => hole.tees[c]);
    for (let i = 0; i < placedTees.length; i++) {
        let expectedColor = existingColors[i];
        if (!hole.tees[expectedColor]) continue;
        let dx = hole.tees[expectedColor].x - placedTees[i].pos.x;
        let dz = hole.tees[expectedColor].z - placedTees[i].pos.z;
        if (Math.sqrt(dx*dx + dz*dz) > 0.1) { alreadyCorrect = false; break; }
    }
    
    if (alreadyCorrect) {
        // Show distances anyway
        let distText = placedTees.map((t, i) => colorEmoji[existingColors[i]] + ' ' + Math.round(t.dist) + 'm').join('  ');
        window.showBuildToast('✅ Tees OK: ' + distText, '#22c55e');
        return;
    }
    
    // Reassign: closest position → first available color, etc.
    let assignedColors = colorOrder.filter(c => hole.tees[c]); // Only colors that were placed
    
    // Remove all existing tee meshes
    assignedColors.forEach(c => {
        if (hole.teeMeshes[c]) window._arcadeScene.remove(hole.teeMeshes[c]);
        hole.tees[c] = null;
        hole.teeMeshes[c] = null;
    });
    
    // Reassign positions to colors in order (closest = first color in order)
    for (let i = 0; i < placedTees.length; i++) {
        let color = assignedColors[i];
        hole.tees[color] = placedTees[i].pos;
        hole.teeMeshes[color] = window.createTeeObject(
            placedTees[i].pos.x, placedTees[i].pos.y, placedTees[i].pos.z, 
            colorHex[color]
        );
        // Restore rotation if it was saved
        if (placedTees[i].pos.rot) {
            hole.teeMeshes[color].rotation.y = placedTees[i].pos.rot;
        }
    }
    
    // Show result
    let distText = placedTees.map((t, i) => colorEmoji[assignedColors[i]] + ' ' + Math.round(t.dist) + 'm').join('  ');
    window.showBuildToast('🔄 Tees auto-sorted! ' + distText, '#a855f7');
}

// === SMART GREEN SPLINE PREVIEW (separate from regular SPLINE) ===
function updateSmartGreenPreview() {
    smartGreenSpheres.forEach(s => window._arcadeScene.remove(s));
    smartGreenSpheres = [];
    if(smartGreenLineMesh) { window._arcadeScene.remove(smartGreenLineMesh); smartGreenLineMesh = null; }

    let sMat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
    let sMatFirst = new THREE.MeshBasicMaterial({ color: 0x38bdf8 }); // Blue = start point
    let sGeo = new THREE.SphereGeometry(0.4, 8, 8);
    let sGeoFirst = new THREE.SphereGeometry(0.6, 8, 8);
    smartGreenPoints.forEach((pt, idx) => {
        let s = new THREE.Mesh(idx === 0 ? sGeoFirst : sGeo, idx === 0 ? sMatFirst : sMat);
        s.position.copy(pt);
        s.position.y += 0.5;
        window._arcadeScene.add(s);
        smartGreenSpheres.push(s);
    });

    if(smartGreenPoints.length > 1) {
        // Open spline while placing — closes when magnet-snapped to first point
        let shouldClose = !!window._smartShapeClosed;
        let curve = new THREE.CatmullRomCurve3(smartGreenPoints, shouldClose);
        let curvePts = curve.getPoints(50 * smartGreenPoints.length);
        let lineGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
        // Gold line when closed, green when open
        let lineColor = shouldClose ? 0xfbbf24 : 0x4ade80;
        let lineMat = new THREE.LineBasicMaterial({ color: lineColor, linewidth: 3 });
        smartGreenLineMesh = new THREE.Line(lineGeo, lineMat);
        smartGreenLineMesh.position.y += 0.5;
        window._arcadeScene.add(smartGreenLineMesh);
    }

    let pnl = document.getElementById('smart-green-action-panel');
    let buildBtn = document.getElementById('sb-build-btn');
    if(pnl) {
        if(window.currentTool === 'SMART_BUILDER') pnl.style.display = 'block';
        else pnl.style.display = 'none';
    }
    // Ensure build button is always clickable (build functions check point count internally)
    if(buildBtn) {
        buildBtn.disabled = false;
        buildBtn.style.opacity = '1';
        buildBtn.style.cursor = 'pointer';
    }
    window._arcadeRenderer.render(scene, window._arcadeCamera);

    // === LIVE MEASUREMENTS ===
    let measEl = document.getElementById('sb-measure-hud');
    if(measEl) {
        if(smartGreenPoints.length >= 2) {
            let pts = smartGreenPoints;
            // Bounding box (width × length)
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for(let p of pts) {
                if(p.x < minX) minX = p.x; if(p.x > maxX) maxX = p.x;
                if(p.z < minZ) minZ = p.z; if(p.z > maxZ) maxZ = p.z;
            }
            let w = maxX - minX;
            let h = maxZ - minZ;
            // Perimeter (sum of segment lengths along spline)
            let perim = 0;
            for(let i = 0; i < pts.length; i++) {
                let next = (i + 1) % pts.length;
                let dx = pts[next].x - pts[i].x;
                let dz = pts[next].z - pts[i].z;
                perim += Math.sqrt(dx*dx + dz*dz);
            }
            // Area (Shoelace formula)
            let area = 0;
            for(let i = 0; i < pts.length; i++) {
                let next = (i + 1) % pts.length;
                area += pts[i].x * pts[next].z;
                area -= pts[next].x * pts[i].z;
            }
            area = Math.abs(area) / 2;
            // Last segment length
            let lastSeg = 0;
            if(pts.length >= 2) {
                let a = pts[pts.length-2], b = pts[pts.length-1];
                lastSeg = Math.sqrt((b.x-a.x)*(b.x-a.x) + (b.z-a.z)*(b.z-a.z));
            }
            measEl.style.display = 'block';
            measEl.innerHTML = '<span style="color:#fbbf24">📐 ' + Math.round(w) + 'm × ' + Math.round(h) + 'm</span>' +
                '<span style="color:#94a3b8; margin-left:6px">Area: ~' + Math.round(area) + 'm²</span>' +
                '<br><span style="color:#64748b; font-size:9px">Perimeter: ' + Math.round(perim) + 'm · Last: ' + lastSeg.toFixed(1) + 'm · Points: ' + pts.length + '</span>';
        } else {
            measEl.style.display = 'none';
        }
    }
}

window.clearSmartGreen = function() {
    smartGreenPoints = [];
    window._smartShapeClosed = false; // Reset magnet-snap state
    let measEl = document.getElementById('sb-measure-hud');
    if(measEl) measEl.style.display = 'none';
    updateSmartGreenPreview();
};

// === SHARED: Uniform polygon offset using edge normals ===
// Produces a polygon expanded by 'dist' meters with uniform border width
function offsetPolygon(densePts, dist) {
    let n = densePts.length;
    let result = [];
    for(let i = 0; i < n; i++) {
        // Adjacent edges
        let prev = (i - 1 + n) % n;
        let next = (i + 1) % n;
        // Edge vectors
        let e1x = densePts[i].x - densePts[prev].x;
        let e1z = densePts[i].z - densePts[prev].z;
        let e2x = densePts[next].x - densePts[i].x;
        let e2z = densePts[next].z - densePts[i].z;
        // Outward normals (perpendicular, pointing outward for CW winding)
        let len1 = Math.sqrt(e1x*e1x + e1z*e1z) + 0.0001;
        let n1x = -e1z / len1, n1z = e1x / len1;
        let len2 = Math.sqrt(e2x*e2x + e2z*e2z) + 0.0001;
        let n2x = -e2z / len2, n2z = e2x / len2;
        // Average normal at vertex
        let nx = n1x + n2x, nz = n1z + n2z;
        let nLen = Math.sqrt(nx*nx + nz*nz) + 0.0001;
        nx /= nLen; nz /= nLen;
        // Miter length to maintain uniform width at corners
        let dot = nx * n1x + nz * n1z;
        let miter = dot > 0.25 ? dist / dot : dist * 1.2; // Tight clamp at sharp corners
        result.push({ x: densePts[i].x + nx * miter, z: densePts[i].z + nz * miter });
    }
    // Check winding: if the offset went INWARD instead of outward, flip
    // Simple test: compare area of original vs offset
    let areaOrig = 0, areaOff = 0;
    for(let i = 0; i < n; i++) {
        let j = (i + 1) % n;
        areaOrig += densePts[i].x * densePts[j].z - densePts[j].x * densePts[i].z;
        areaOff += result[i].x * result[j].z - result[j].x * result[i].z;
    }
    if(Math.abs(areaOff) < Math.abs(areaOrig)) {
        // Offset went inward — flip direction
        result = [];
        for(let i = 0; i < n; i++) {
            let prev = (i - 1 + n) % n;
            let next = (i + 1) % n;
            let e1x = densePts[i].x - densePts[prev].x;
            let e1z = densePts[i].z - densePts[prev].z;
            let e2x = densePts[next].x - densePts[i].x;
            let e2z = densePts[next].z - densePts[i].z;
            let len1 = Math.sqrt(e1x*e1x + e1z*e1z) + 0.0001;
            let n1x = e1z / len1, n1z = -e1x / len1;
            let len2 = Math.sqrt(e2x*e2x + e2z*e2z) + 0.0001;
            let n2x = e2z / len2, n2z = -e2x / len2;
            let nx = n1x + n2x, nz = n1z + n2z;
            let nLen = Math.sqrt(nx*nx + nz*nz) + 0.0001;
            nx /= nLen; nz /= nLen;
            let dot = nx * n1x + nz * n1z;
            let miter = dot > 0.25 ? dist / dot : dist * 1.2;
            result.push({ x: densePts[i].x + nx * miter, z: densePts[i].z + nz * miter });
        }
    }
    return result;
}

// === SMART BUNKER: Sand Fill + Dig Down + Lip ===
window.executeSmartBunker = function() {
    if(smartGreenPoints.length < 3) return;
    window.saveUndoState();

    let cfg = window.CURRENT_BIOME_CONFIG;
    let sandColor = cfg.bunkerColor || '#e0d8a4';
    
    // Read sliders
    let depthSlider = document.getElementById('sb-bunker-depth');
    let lipSlider = document.getElementById('sb-bunker-lip');
    let depth = depthSlider ? parseFloat(depthSlider.value) : 0.8;
    let lipHeight = lipSlider ? parseFloat(lipSlider.value) : 0.3;
    let shape = window._smartBunkerShape || 'BOWL';

    // Build closed curve
    let curve = new THREE.CatmullRomCurve3(smartGreenPoints, true);
    let numSamples = Math.max(200, smartGreenPoints.length * 40);
    let densePts = curve.getPoints(numSamples);

    // === 1. PAINT: Sand fill ===
    window._arcadePCtx.save();
    
    // Edge sharpness
    let sharpSlider = document.getElementById('sg-edge-sharpness');
    let sharpness = sharpSlider ? parseInt(sharpSlider.value) : 100;
    if(sharpness < 100) {
        let blurPx = Math.round((100 - sharpness) * 0.06);
        if(blurPx > 0) window._arcadePCtx.filter = 'blur(' + blurPx + 'px)';
    }

    window._arcadePCtx.beginPath();
    densePts.forEach((pt, i) => {
        let pxX = ((pt.x + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
        let pxY = ((pt.z + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
        if(i === 0) window._arcadePCtx.moveTo(pxX, pxY);
        else window._arcadePCtx.lineTo(pxX, pxY);
    });
    window._arcadePCtx.closePath();
    window._arcadePCtx.fillStyle = sandColor;
    window._arcadePCtx.fill();
    window._arcadePCtx.filter = 'none';
    window._arcadePCtx.restore();
    window._arcadeMapTex.needsUpdate = true;
    window.terrainBiomeData = window._arcadePCtx.getImageData(0, 0, 4096, 4096).data;

    // === 2. TERRAIN SCULPTING: Dig + Bowl + Lip ===
    let positions = window._arcadePlaneGeo.attributes.position.array;
    let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;

    // Bounding box
    let pathMinX = Infinity, pathMaxX = -Infinity, pathMinZ = Infinity, pathMaxZ = -Infinity;
    for(let pt of densePts) {
        if(pt.x < pathMinX) pathMinX = pt.x;
        if(pt.x > pathMaxX) pathMaxX = pt.x;
        if(pt.z < pathMinZ) pathMinZ = pt.z;
        if(pt.z > pathMaxZ) pathMaxZ = pt.z;
    }
    let margin = 0; // Bunker: NO outside influence

    let gxStart = Math.max(0, Math.floor((pathMinX - 1 + window.TERRAIN_SIZE/2) / step));
    let gxEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxX + 1 + window.TERRAIN_SIZE/2) / step));
    let gzStart = Math.max(0, Math.floor((pathMinZ - 1 + window.TERRAIN_SIZE/2) / step));
    let gzEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxZ + 1 + window.TERRAIN_SIZE/2) / step));

    // Read actual terrain height at each control point from vertex buffer directly
    let baseH = 0;
    let minEdgeH = Infinity;
    for(let pt of smartGreenPoints) {
        let gxi = Math.round((pt.x + window.TERRAIN_SIZE/2) / step);
        let gzi = Math.round((pt.z + window.TERRAIN_SIZE/2) / step);
        gxi = Math.max(0, Math.min(window.TERRAIN_SEGS, gxi));
        gzi = Math.max(0, Math.min(window.TERRAIN_SEGS, gzi));
        let vidx = gzi * (window.TERRAIN_SEGS+1) + gxi;
        let h = positions[vidx * 3 + 2];
        baseH += h;
        if (h < minEdgeH) minEdgeH = h;
    }
    baseH /= smartGreenPoints.length;

    // Face direction: first point = face (lip side)
    let facePt = smartGreenPoints[0];
    let cx = 0, cz = 0;
    for(let pt of smartGreenPoints) { cx += pt.x; cz += pt.z; }
    cx /= smartGreenPoints.length;
    cz /= smartGreenPoints.length;
    let faceDx = facePt.x - cx;
    let faceDz = facePt.z - cz;
    let faceLen = Math.sqrt(faceDx*faceDx + faceDz*faceDz) + 0.001;
    faceDx /= faceLen; faceDz /= faceLen;

    // Reuse helpers from Smart Green
    function pointInPolygon(px, pz, polyPts) {
        let inside = false;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let xi = polyPts[i].x, zi = polyPts[i].z;
            let xj = polyPts[j].x, zj = polyPts[j].z;
            if(((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    function distToPolygon(px, pz, polyPts) {
        let minDist = Infinity;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let ax = polyPts[j].x, az = polyPts[j].z;
            let bx = polyPts[i].x, bz = polyPts[i].z;
            let dx = bx - ax, dz = bz - az;
            let len2 = dx*dx + dz*dz;
            let t = len2 > 0 ? Math.max(0, Math.min(1, ((px-ax)*dx + (pz-az)*dz) / len2)) : 0;
            let projX = ax + t*dx, projZ = az + t*dz;
            let d = Math.sqrt((px-projX)**2 + (pz-projZ)**2);
            if(d < minDist) minDist = d;
        }
        return minDist;
    }

    // Max distance from center to edge (for bowl normalization)
    let maxDist = 0;
    for(let pt of densePts) {
        let d = Math.sqrt((pt.x - cx)**2 + (pt.z - cz)**2);
        if(d > maxDist) maxDist = d;
    }

    // Save original heights BEFORE digging (for post-smooth enforcement)
    let origHeights = new Float32Array((gxEnd - gxStart + 1) * (gzEnd - gzStart + 1));
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let oi = (gz - gzStart) * (gxEnd - gxStart + 1) + (gx - gxStart);
            origHeights[oi] = positions[idx*3+2];
        }
    }

    // Single pass for performance
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            let isInside = pointInPolygon(vx, vz, densePts);
            if(!isInside) continue; // ONLY affect terrain inside polygon

            let distEdge = distToPolygon(vx, vz, densePts);

            let currentH = positions[idx*3+2];

            // HYBRID dig: flat floor + per-vertex, whichever is LOWER
            // - Flat floor (minEdgeH - depth): always below the LOWEST edge → visible from all sides
            // - Per-vertex (currentH - depth): extra dig on high-side
            // Math.min picks the deeper cut → proper bunker on all terrain
            let digDepth = depth;
            let flatFloor = minEdgeH - depth;

            // Bowl shape: deeper in center, shallower at edges
            if(shape === 'BOWL') {
                let distCenter = Math.sqrt((vx - cx)**2 + (vz - cz)**2);
                let normalizedDist = distCenter / (maxDist + 0.001);
                let bowlFactor = 1.0 - normalizedDist * normalizedDist;
                digDepth = depth * (0.4 + 0.6 * bowlFactor);
                flatFloor = minEdgeH - depth * (0.4 + 0.6 * bowlFactor);
            }

            // Pick the deeper of flat-floor vs per-vertex
            let targetHeight = Math.min(flatFloor, currentH - digDepth);

            // Directional edge blend: wider ramp on face/lip side for gentle slope
            let relX = vx - cx;
            let relZ = vz - cz;
            let faceDot = relX * faceDx + relZ * faceDz;
            let isFaceSide = faceDot > 0;
            
            // Face side: 10m gentle slope for natural walk-in, back side: 3.5m steep bowl wall
            let blendDist = isFaceSide ? 10.0 : 3.5;
            let edgeBlend = Math.min(1.0, distEdge / blendDist);
            
            // Use smoothstep for even smoother transition (S-curve instead of linear)
            edgeBlend = edgeBlend * edgeBlend * (3.0 - 2.0 * edgeBlend);

            // Apply: blend from current terrain to target
            let blendedDig = currentH + (targetHeight - currentH) * edgeBlend;
            
            // Phase 2: LIP — raise edge on face side (allowed to raise, but only where needed)
            if(lipHeight > 0) {
                let normalized = faceDot / (faceLen + 0.001);
                
                let edgeProximity = 1.0 - Math.min(1.0, distEdge / 5.0); // Wider lip zone (5m)
                if(normalized > 0 && edgeProximity > 0) {
                    let lipTarget = baseH + lipHeight;
                    // Only add lip if terrain is BELOW the lip target
                    if (currentH < lipTarget) {
                        // Quadratic falloff for softer, more natural lip transition
                        let lipInfluence = edgeProximity * edgeProximity * Math.min(1.0, normalized);
                        let lipAdd = (lipTarget - currentH) * lipInfluence;
                        blendedDig += lipAdd;
                    }
                }
            }
            
            positions[idx*3+2] = blendedDig;
        }
    }
    // === AUTO-SMOOTH PASS (golden backup values) ===
    // 6 passes, tight margin, proven strengths
    let _smoothStride = window.TERRAIN_SEGS + 1;
    let smGxStart = Math.max(0, gxStart - 3);
    let smGxEnd = Math.min(window.TERRAIN_SEGS, gxEnd + 3);
    let smGzStart = Math.max(0, gzStart - 3);
    let smGzEnd = Math.min(window.TERRAIN_SEGS, gzEnd + 3);

    for(let smPass = 0; smPass < 6; smPass++) {
        for(let gz = smGzStart; gz <= smGzEnd; gz++) {
            for(let gx = smGxStart; gx <= smGxEnd; gx++) {
                let idx = gz * _smoothStride + gx;
                let vx = positions[idx*3];
                let vz = -positions[idx*3+1];

                let isInside = pointInPolygon(vx, vz, densePts);
                let distEdge = distToPolygon(vx, vz, densePts);
                
                // Smooth inside the bunker, and a margin outside to blend the lip
                if(isInside || distEdge < 2.5) {
                    let nCount = 0;
                    let nSum = 0;
                    if (gz > 0) { nSum += positions[((gz-1)*_smoothStride + gx)*3 + 2]; nCount++; }
                    if (gz < window.TERRAIN_SEGS) { nSum += positions[((gz+1)*_smoothStride + gx)*3 + 2]; nCount++; }
                    if (gx > 0) { nSum += positions[(gz*_smoothStride + gx-1)*3 + 2]; nCount++; }
                    if (gx < window.TERRAIN_SEGS) { nSum += positions[(gz*_smoothStride + gx+1)*3 + 2]; nCount++; }
                    
                    if (nCount > 0) {
                        let localAvg = nSum / nCount;
                        // Strength: strong at edge to remove jaggedness, milder further away
                        let smoothStrength = 0.7; 
                        if(isInside && distEdge > 1.5) smoothStrength = 0.2; // Keep center bowl shape intact
                        if(!isInside && distEdge > 1.5) smoothStrength = 0.3; // Fade out smoothing outside
                        
                        positions[idx*3 + 2] += (localAvg - positions[idx*3 + 2]) * smoothStrength;
                    }
                }
            }
        }
    }


    window._arcadePlaneGeo.attributes.position.needsUpdate = true;
    window._arcadePlaneGeo.computeVertexNormals();
    window._arcadePlaneGeo.computeBoundingBox();
    window._arcadePlaneGeo.computeBoundingSphere();
    window.snapObjectsToGround();

    if(window.slopeOverlayActive) window.updateSlopeOverlay();
    if(window.contourLinesActive) window.updateContourLines();
    if(window.elevationHeatmapActive) window.updateElevationHeatmap();

    clearSmartGreen();
};

// === SMART FAIRWAY: Fairway Fill + Semi-Rough Ring + Rolling Terrain ===
window.executeSmartFairway = function() {
    if(smartGreenPoints.length < 3) return;
    window.saveUndoState();

    let cfg = window.CURRENT_BIOME_CONFIG;
    let fairwayColor = cfg.fairwayColor || '#7db952';
    let semiRoughColor = cfg.semiColor || '#6b9e3d';
    let difficulty = window._fairwayDifficulty || 'FLAT';

    // Random seed for unique terrain per build
    let seedX = (Math.random() - 0.5) * 200;
    let seedZ = (Math.random() - 0.5) * 200;

    // Semi-rough width from slider
    let srSlider = document.getElementById('sf-semirough-width');
    let semiRoughWidth = srSlider ? parseFloat(srSlider.value) : 2.0;

    // Build closed curve
    let curve = new THREE.CatmullRomCurve3(smartGreenPoints, true);
    let numSamples = Math.max(200, smartGreenPoints.length * 40);
    let densePts = curve.getPoints(numSamples);

    // === 1. PAINT: Semi-rough ring + Fairway fill ===
    window._arcadePCtx.save();

    // Edge sharpness
    let sharpSlider = document.getElementById('sg-edge-sharpness');
    let sharpness = sharpSlider ? parseInt(sharpSlider.value) : 100;
    if(sharpness < 100) {
        let blurPx = Math.round((100 - sharpness) * 0.06);
        if(blurPx > 0) window._arcadePCtx.filter = 'blur(' + blurPx + 'px)';
    }

    // Polygon center (still needed for Smart Green center ref)
    let cx = 0, cz = 0;
    for(let pt of densePts) { cx += pt.x; cz += pt.z; }
    cx /= densePts.length;
    cz /= densePts.length;

    // Draw rough ring (outermost): only if checkbox is checked
    let roughCb = document.getElementById('sf-rough-cb');
    let roughSlider = document.getElementById('sf-rough-width');
    let roughWidth = (roughCb && roughCb.checked && roughSlider) ? parseFloat(roughSlider.value) : 0;
    // Shared path function for fairway boundary
    function traceFairwayPath() {
        window._arcadePCtx.beginPath();
        densePts.forEach((pt, i) => {
            let pxX = ((pt.x + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
            let pxY = ((pt.z + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
            if(i === 0) window._arcadePCtx.moveTo(pxX, pxY);
            else window._arcadePCtx.lineTo(pxX, pxY);
        });
        window._arcadePCtx.closePath();
    }

    // Draw rough ring (outermost) using thick stroke to avoid self-intersection spikes
    let roughColor = cfg.roughColor || '#3d6b2b';
    if(roughWidth > 0) {
        traceFairwayPath();
        window._arcadePCtx.lineWidth = (semiRoughWidth + roughWidth) * 2 * (4096 / window.TERRAIN_SIZE);
        window._arcadePCtx.strokeStyle = roughColor;
        window._arcadePCtx.lineJoin = 'round';
        window._arcadePCtx.stroke();
        window._arcadePCtx.fillStyle = roughColor; // Fill interior to prevent gaps
        window._arcadePCtx.fill();
    }

    // Draw semi-rough ring using thick stroke
    if(semiRoughWidth > 0) {
        traceFairwayPath();
        window._arcadePCtx.lineWidth = semiRoughWidth * 2 * (4096 / window.TERRAIN_SIZE);
        window._arcadePCtx.strokeStyle = semiRoughColor;
        window._arcadePCtx.lineJoin = 'round';
        window._arcadePCtx.stroke();
        window._arcadePCtx.fillStyle = semiRoughColor; // Fill interior
        window._arcadePCtx.fill();
    }

    // Draw fairway fill (inner polygon, on top)
    traceFairwayPath();
    window._arcadePCtx.fillStyle = fairwayColor;
    window._arcadePCtx.fill();

    // === MOWING PATTERN OVERLAY (Fairway) ===
    let mowPattern = window._smartMowPattern || 'SOLID';
    if (mowPattern !== 'SOLID') {
        paintMowingPattern(window._arcadePCtx, densePts, fairwayColor, mowPattern);
    }

    window._arcadePCtx.filter = 'none';
    window._arcadePCtx.restore();
    window._arcadeMapTex.needsUpdate = true;
    window.terrainBiomeData = window._arcadePCtx.getImageData(0, 0, 4096, 4096).data;

    // === 2. TERRAIN SCULPTING: Rolling undulations ===
    // FLAT/NATURAL = paint only, preserve natural terrain contours
    if(difficulty !== 'FLAT') {
    let positions = window._arcadePlaneGeo.attributes.position.array;
    let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;

    // Bounding box
    let pathMinX = Infinity, pathMaxX = -Infinity, pathMinZ = Infinity, pathMaxZ = -Infinity;
    for(let pt of densePts) {
        if(pt.x < pathMinX) pathMinX = pt.x;
        if(pt.x > pathMaxX) pathMaxX = pt.x;
        if(pt.z < pathMinZ) pathMinZ = pt.z;
        if(pt.z > pathMaxZ) pathMaxZ = pt.z;
    }
    let margin = semiRoughWidth + roughWidth + 8;

    let gxStart = Math.max(0, Math.floor((pathMinX - margin + window.TERRAIN_SIZE/2) / step));
    let gxEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxX + margin + window.TERRAIN_SIZE/2) / step));
    let gzStart = Math.max(0, Math.floor((pathMinZ - margin + window.TERRAIN_SIZE/2) / step));
    let gzEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxZ + margin + window.TERRAIN_SIZE/2) / step));

    // Average height as base
    let baseH = 0;
    for(let pt of smartGreenPoints) {
        let surf = window.localGetTerrainAt(pt.x, -pt.z);
        baseH += surf ? surf.z : 0;
    }
    baseH /= smartGreenPoints.length;

    // Point-in-polygon
    function pointInPolygon(px, pz, polyPts) {
        let inside = false;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let xi = polyPts[i].x, zi = polyPts[i].z;
            let xj = polyPts[j].x, zj = polyPts[j].z;
            if(((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    function distToPolygon(px, pz, polyPts) {
        let minDist = Infinity;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let ax = polyPts[j].x, az = polyPts[j].z;
            let bx = polyPts[i].x, bz = polyPts[i].z;
            let dx = bx - ax, dz = bz - az;
            let len2 = dx*dx + dz*dz;
            let t = len2 > 0 ? Math.max(0, Math.min(1, ((px-ax)*dx + (pz-az)*dz) / len2)) : 0;
            let projX = ax + t*dx, projZ = az + t*dz;
            let d = Math.sqrt((px-projX)**2 + (pz-projZ)**2);
            if(d < minDist) minDist = d;
        }
        return minDist;
    }

    // Single pass for performance
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            let isInside = pointInPolygon(vx, vz, densePts);
            let distEdge = distToPolygon(vx, vz, densePts);

            if(!isInside && distEdge > margin) continue;

            // Fairway rolling terrain: large-scale, soft, natural mounds
            // Low-frequency sin waves = long rolling hills
            let sx = vx + seedX;
            let sz = vz + seedZ;
            let targetHeight = baseH;

            if(difficulty === 'EASY') {
                // Gentle rolls ~0.3m amplitude, very long wavelength
                targetHeight += Math.sin(sx * 0.025) * Math.cos(sz * 0.03) * 0.30;
            } else if(difficulty === 'MED') {
                // Medium rolls ~0.6m, two overlapping waves
                targetHeight += Math.sin(sx * 0.03) * Math.cos(sz * 0.025) * 0.45;
                targetHeight += Math.sin(sx * 0.015 + sz * 0.02) * 0.20;
            } else if(difficulty === 'HARD') {
                // Strong undulations ~1.0m, multi-frequency
                targetHeight += Math.sin(sx * 0.035) * Math.cos(sz * 0.03) * 0.55;
                targetHeight += Math.sin(sx * 0.02 + sz * 0.025) * 0.30;
                targetHeight += Math.cos(sx * 0.05) * Math.sin(sz * 0.04) * 0.15;
            }

            let currentH = positions[idx*3+2];
            let influence;

            if(isInside) {
                influence = 1.0;
            } else {
                influence = 1.0 - (distEdge / margin);
                influence = Math.max(0, influence * influence * (3 - 2 * influence));
            }

            positions[idx*3+2] = currentH + (targetHeight - currentH) * influence;
        }
    }
    } // end if(difficulty !== 'FLAT')

    window._arcadePlaneGeo.attributes.position.needsUpdate = true;
    window._arcadePlaneGeo.computeVertexNormals();
    window._arcadePlaneGeo.computeBoundingBox();
    window._arcadePlaneGeo.computeBoundingSphere();
    window.snapObjectsToGround();

    if(window.slopeOverlayActive) window.updateSlopeOverlay();
    if(window.contourLinesActive) window.updateContourLines();
    if(window.elevationHeatmapActive) window.updateElevationHeatmap();

    clearSmartGreen();
};

// === SMART TEE: Flat Tee Box + Auto-Place Markers ===
window.executeSmartTee = function() {
    if(smartGreenPoints.length < 3) return;

    // GATE: Require AimPoint before ANY tee work (paint + markers)
    let _hole = window.courseHoles[window.currentHoleIndex];
    if(!_hole.aimPoint) {
        window.showBuildToast('🎯 Set Aim Point first! Click AIM → click on landing zone.', '#ef4444');
        setTimeout(function() { setSmartBuilderType('AIM'); }, 300);
        return; // Don't clear points — user can retry after setting aim
    }

    window.saveUndoState();

    let cfg = window.CURRENT_BIOME_CONFIG;
    let teeColor = cfg.teeColor || '#7cb54c';

    // Build closed curve
    let curve = new THREE.CatmullRomCurve3(smartGreenPoints, true);
    let numSamples = Math.max(200, smartGreenPoints.length * 40);
    let densePts = curve.getPoints(numSamples);

    // === 1. PAINT: Tee box color ===
    window._arcadePCtx.save();
    let sharpSlider = document.getElementById('sg-edge-sharpness');
    let sharpness = sharpSlider ? parseInt(sharpSlider.value) : 100;
    if(sharpness < 100) {
        let blurPx = Math.round((100 - sharpness) * 0.06);
        if(blurPx > 0) window._arcadePCtx.filter = 'blur(' + blurPx + 'px)';
    }

    window._arcadePCtx.beginPath();
    densePts.forEach((pt, i) => {
        let pxX = ((pt.x + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
        let pxY = ((pt.z + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
        if(i === 0) window._arcadePCtx.moveTo(pxX, pxY);
        else window._arcadePCtx.lineTo(pxX, pxY);
    });
    window._arcadePCtx.closePath();
    window._arcadePCtx.fillStyle = teeColor;
    window._arcadePCtx.fill();

    // === MOWING PATTERN OVERLAY (Tee) ===
    let mowPattern = window._smartMowPattern || 'SOLID';
    if (mowPattern !== 'SOLID') {
        paintMowingPattern(window._arcadePCtx, densePts, teeColor, mowPattern);
    }

    window._arcadePCtx.filter = 'none';
    window._arcadePCtx.restore();
    window._arcadeMapTex.needsUpdate = true;
    window.terrainBiomeData = window._arcadePCtx.getImageData(0, 0, 4096, 4096).data;

    // === 2. TERRAIN: Completely flat ===
    let positions = window._arcadePlaneGeo.attributes.position.array;
    let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;

    let pathMinX = Infinity, pathMaxX = -Infinity, pathMinZ = Infinity, pathMaxZ = -Infinity;
    for(let pt of densePts) {
        if(pt.x < pathMinX) pathMinX = pt.x;
        if(pt.x > pathMaxX) pathMaxX = pt.x;
        if(pt.z < pathMinZ) pathMinZ = pt.z;
        if(pt.z > pathMaxZ) pathMaxZ = pt.z;
    }
    let margin = 6;

    let gxStart = Math.max(0, Math.floor((pathMinX - margin + window.TERRAIN_SIZE/2) / step));
    let gxEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxX + margin + window.TERRAIN_SIZE/2) / step));
    let gzStart = Math.max(0, Math.floor((pathMinZ - margin + window.TERRAIN_SIZE/2) / step));
    let gzEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxZ + margin + window.TERRAIN_SIZE/2) / step));

    let baseH = 0;
    for(let pt of smartGreenPoints) {
        let surf = window.localGetTerrainAt(pt.x, -pt.z);
        baseH += surf ? surf.z : 0;
    }
    baseH /= smartGreenPoints.length;

    function pointInPolygon(px, pz, polyPts) {
        let inside = false;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let xi = polyPts[i].x, zi = polyPts[i].z;
            let xj = polyPts[j].x, zj = polyPts[j].z;
            if(((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }
    function distToPolygon(px, pz, polyPts) {
        let minDist = Infinity;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let ax = polyPts[j].x, az = polyPts[j].z;
            let bx = polyPts[i].x, bz = polyPts[i].z;
            let dx = bx - ax, dz = bz - az;
            let len2 = dx*dx + dz*dz;
            let t = len2 > 0 ? Math.max(0, Math.min(1, ((px-ax)*dx + (pz-az)*dz) / len2)) : 0;
            let projX = ax + t*dx, projZ = az + t*dz;
            let d = Math.sqrt((px-projX)**2 + (pz-projZ)**2);
            if(d < minDist) minDist = d;
        }
        return minDist;
    }

    // Single pass for performance
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];
            let isInside = pointInPolygon(vx, vz, densePts);
            let distEdge = distToPolygon(vx, vz, densePts);
            if(!isInside && distEdge > margin) continue;
            let currentH = positions[idx*3+2];
            let influence;
            if(isInside) {
                influence = 1.0;
            } else {
                influence = 1.0 - (distEdge / margin);
                influence = Math.max(0, influence * influence * (3 - 2 * influence));
            }
            // Always flat — target = baseH
            positions[idx*3+2] = currentH + (baseH - currentH) * influence;
        }
    }

    window._arcadePlaneGeo.attributes.position.needsUpdate = true;
    window._arcadePlaneGeo.computeVertexNormals();
    window._arcadePlaneGeo.computeBoundingBox();
    window._arcadePlaneGeo.computeBoundingSphere();
    window.snapObjectsToGround();

    // === 3. AUTO-PLACE TEE MARKERS ===
    // Determine which tees to place
    let teesToPlace = [];
    // Order: back to front = black, white, yellow, red
    if(document.getElementById('st-tee-black') && document.getElementById('st-tee-black').checked) teesToPlace.push({type: 'black', color: 0x111111});
    if(document.getElementById('st-tee-white') && document.getElementById('st-tee-white').checked) teesToPlace.push({type: 'white', color: 0xffffff});
    if(document.getElementById('st-tee-yellow') && document.getElementById('st-tee-yellow').checked) teesToPlace.push({type: 'yellow', color: 0xfacc15});
    if(document.getElementById('st-tee-red') && document.getElementById('st-tee-red').checked) teesToPlace.push({type: 'red', color: 0xef4444});

    let hole = window.courseHoles[window.currentHoleIndex];

    // AimPoint already verified at top of function

    // Clear unchecked tees ONLY if they are INSIDE this tee box polygon
    // (preserves tees on other tee boxes for multi-stage building)
    let placingTypes = teesToPlace.map(t => t.type);
    ['red','yellow','white','black'].forEach(function(tt) {
        if(!placingTypes.includes(tt) && hole.tees[tt]) {
            let isInsideThisTeeBox = pointInPolygon(hole.tees[tt].x, hole.tees[tt].z, densePts);
            if(isInsideThisTeeBox) {
                if(hole.teeMeshes[tt]) window._arcadeScene.remove(hole.teeMeshes[tt]);
                hole.teeMeshes[tt] = null;
                hole.tees[tt] = null;
            }
        }
    });

    if(teesToPlace.length > 0) {
        // Polygon centroid
        let cx = 0, cz = 0;
        for(let pt of smartGreenPoints) { cx += pt.x; cz += pt.z; }
        cx /= smartGreenPoints.length;
        cz /= smartGreenPoints.length;

        // Direction: always use aimPoint (required above)
        let dirX = hole.aimPoint.x - cx;
        let dirZ = hole.aimPoint.z - cz;
        let dirLen = Math.sqrt(dirX*dirX + dirZ*dirZ) + 0.001;
        dirX /= dirLen; dirZ /= dirLen;

        // Project all points onto aim direction to find extent
        let minProj = Infinity, maxProj = -Infinity;
        for(let pt of smartGreenPoints) {
            let dx = pt.x - cx;
            let dz = pt.z - cz;
            let proj = dx * dirX + dz * dirZ;
            if(proj < minProj) minProj = proj;
            if(proj > maxProj) maxProj = proj;
        }
        let totalLen = maxProj - minProj;
        if(totalLen < 2) totalLen = dirLen * 2;

        let spacing = totalLen / (teesToPlace.length + 1);
        let startX = cx + dirX * minProj;
        let startZ = cz + dirZ * minProj;

        // PRE-FLIGHT CHECK: Would all markers fit inside the polygon?
        let outsideCount = 0;
        for(let i = 0; i < teesToPlace.length; i++) {
            let dist = spacing * (i + 1);
            let tx = startX + dirX * dist;
            let tz = startZ + dirZ * dist;
            if(!pointInPolygon(tx, tz, densePts)) outsideCount++;
        }

        if(outsideCount > 0) {
            window.showBuildToast('⚠️ Tee box too small for ' + teesToPlace.length + ' markers! Make it bigger or uncheck some tees.', '#ef4444');
            return; // Abort — keep points so user can adjust
        }

        // All markers fit — calculate all positions first
        let teeRot = Math.atan2(dirX, dirZ);
        let teePositions = [];
        for(let i = 0; i < teesToPlace.length; i++) {
            let dist = spacing * (i + 1);
            let tx = startX + dirX * dist;
            let tz = startZ + dirZ * dist;
            let surf = window.localGetTerrainAt(tx, -tz);
            let ty = surf ? surf.z : baseH;
            teePositions.push({x: tx, y: ty, z: tz});
        }

        // Sort positions: FURTHEST from aim/flag FIRST (back of tee box)
        // teesToPlace is already in back-to-front order: [black, white, yellow, red]
        // So position[0] (furthest) → teesToPlace[0] (black), etc.
        let targetX = cx, targetZ = cz;
        if(hole.aimPoint) { targetX = hole.aimPoint.x; targetZ = hole.aimPoint.z; }
        else if(hole.flag) { targetX = hole.flag.x; targetZ = hole.flag.z; }
        teePositions.sort(function(a, b) {
            let da = (a.x-targetX)*(a.x-targetX) + (a.z-targetZ)*(a.z-targetZ);
            let db = (b.x-targetX)*(b.x-targetX) + (b.z-targetZ)*(b.z-targetZ);
            return db - da; // FURTHEST first
        });

        // Direct 1:1 mapping — works with any subset of tees (1, 2, 3, or 4)
        for(let i = 0; i < teesToPlace.length; i++) {
            let t = teesToPlace[i];
            let pos = teePositions[i];

            if(hole.teeMeshes[t.type]) window._arcadeScene.remove(hole.teeMeshes[t.type]);

            hole.tees[t.type] = { x: pos.x, y: pos.y, z: pos.z, rot: teeRot };
            hole.teeMeshes[t.type] = window.createTeeObject(pos.x, pos.y, pos.z, t.color);
            hole.teeMeshes[t.type].rotation.y = teeRot;
        }
    }

    if(window.slopeOverlayActive) window.updateSlopeOverlay();
    if(window.contourLinesActive) window.updateContourLines();
    if(window.elevationHeatmapActive) window.updateElevationHeatmap();

    clearSmartGreen();
    window.saveLevel();

    // Auto-switch to AIM mode so user can set/adjust aim point for tee orientation
    if(!hole.aimPoint) {
        setTimeout(function() {
            setSmartBuilderType('AIM');
            window.showBuildToast('🎯 Click to set Aim Point — tees will auto-sort', '#f59e0b');
        }, 300);
    } else {
        // AimPoint exists — re-sort tees relative to it
        resortTeesForAimPoint(hole);
        window.autoAdvanceHole();
    }
};

window.buildFenceMesh = function(pathType, splinePoints) {
    let curve = new THREE.CatmullRomCurve3(splinePoints);
    let len = curve.getLength();
    
    let spacing = pathType === 'WOOD_FENCE' ? 3.0 : (pathType === 'STONE_WALL' ? 2.0 : 5.0);
    let count = Math.max(2, Math.floor(len / spacing));
    let pts = curve.getSpacedPoints(count);
    
    let pMesh = new THREE.Group();
    let bigSphere = new THREE.Sphere(new THREE.Vector3(0,0,0), 99999);
    
    if (pathType === 'OB_STAKES') {
        let geo = new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8);
        geo.translate(0, 0.6, 0); // Origin at bottom
        let mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
        let instMesh = new THREE.InstancedMesh(geo, mat, pts.length);
        instMesh.castShadow = true;
        instMesh.receiveShadow = true;
        instMesh.boundingSphere = bigSphere;
        
        let dummy = new THREE.Object3D();
        for(let i=0; i<pts.length; i++) {
            let pt = pts[i];
            let surf = window.localGetTerrainAt(pt.x, -pt.z);
            pt.y = surf ? surf.z : 0;
            
            dummy.position.copy(pt);
            dummy.rotation.set(0,0,0);
            dummy.scale.set(1,1,1);
            dummy.updateMatrix();
            instMesh.setMatrixAt(i, dummy.matrix);
        }
        instMesh.instanceMatrix.needsUpdate = true;
        pMesh.add(instMesh);
        
    } else if (pathType === 'WOOD_FENCE') {
        let postGeo = new THREE.BoxGeometry(0.12, 1.2, 0.12);
        postGeo.translate(0, 0.6, 0);
        let woodMat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
        let postMesh = new THREE.InstancedMesh(postGeo, woodMat, pts.length);
        postMesh.castShadow = true;
        postMesh.receiveShadow = true;
        postMesh.boundingSphere = bigSphere;
        
        let beamGeo = new THREE.BoxGeometry(0.05, 0.12, 1.0); // 1.0 length on Z axis
        let beamMesh = new THREE.InstancedMesh(beamGeo, woodMat, pts.length - 1);
        beamMesh.castShadow = true;
        beamMesh.receiveShadow = true;
        beamMesh.boundingSphere = bigSphere;
        
        let dummy = new THREE.Object3D();
        for(let i=0; i<pts.length; i++) {
            let pt = pts[i].clone(); // clone so we don't modify the curve points array
            let surf = window.localGetTerrainAt(pt.x, -pt.z);
            pt.y = surf ? surf.z : 0;
            
            dummy.position.copy(pt);
            dummy.rotation.set(0,0,0);
            dummy.scale.set(1,1,1);
            dummy.updateMatrix();
            postMesh.setMatrixAt(i, dummy.matrix);
            
            if (i < pts.length - 1) {
                let nextPt = pts[i+1].clone();
                let nextSurf = window.localGetTerrainAt(nextPt.x, -nextPt.z);
                nextPt.y = nextSurf ? nextSurf.z : 0;
                
                let midPt = pt.clone().lerp(nextPt, 0.5);
                let dist = pt.distanceTo(nextPt);
                
                dummy.position.copy(midPt);
                dummy.position.y += 0.85; // Beam height
                
                // LookAt aligns local Z axis towards target
                dummy.lookAt(nextPt.x, nextPt.y + 0.85, nextPt.z);
                dummy.scale.set(1, 1, dist); // Stretch beam to fill the gap exactly
                dummy.updateMatrix();
                beamMesh.setMatrixAt(i, dummy.matrix);
            }
        }
        postMesh.instanceMatrix.needsUpdate = true;
        beamMesh.instanceMatrix.needsUpdate = true;
        pMesh.add(postMesh);
        pMesh.add(beamMesh);
    } else if (pathType === 'STONE_WALL') {
        // Build procedural neat cut-stone wall
        let stoneGeo = new THREE.BoxGeometry(1, 1, 1); 
        let stoneMat = new THREE.MeshLambertMaterial({ color: 0xaaaaaa }); 
        
        // Calculate total stones needed
        let totalStones = 0;
        let segmentData = [];
        for(let i=0; i<pts.length - 1; i++) {
            let pt = pts[i].clone();
            let nextPt = pts[i+1].clone();
            
            let surf = window.localGetTerrainAt(pt.x, -pt.z);
            pt.y = surf ? surf.z : 0;
            let nextSurf = window.localGetTerrainAt(nextPt.x, -nextPt.z);
            nextPt.y = nextSurf ? nextSurf.z : 0;
            
            let dist = pt.distanceTo(nextPt);
            
            let layers = 4; // 3 base layers + 1 cap layer
            let stoneLength = 0.6;
            let stonesPerLayer = Math.max(1, Math.floor(dist / stoneLength));
            
            totalStones += layers * stonesPerLayer;
            segmentData.push({ pt, nextPt, dist, layers, stonesPerLayer });
        }
        
        let stoneMesh = new THREE.InstancedMesh(stoneGeo, stoneMat, totalStones);
        stoneMesh.castShadow = true;
        stoneMesh.receiveShadow = true;
        stoneMesh.boundingSphere = bigSphere;
        
        let dummy = new THREE.Object3D();
        let colorDummy = new THREE.Color();
        let stoneIdx = 0;
        
        for(let segIdx=0; segIdx<segmentData.length; segIdx++) {
            let seg = segmentData[segIdx];
            let dir = seg.nextPt.clone().sub(seg.pt).normalize();
            
            // --- Stones ---
            for(let L=0; L<seg.layers; L++) {
                let isCapLayer = (L === seg.layers - 1);
                
                // Base stones: 0.21 high. Cap stone: 0.15 high
                let stoneH = isCapLayer ? 0.15 : 0.21;
                
                let yOffset = (L * 0.21) + (stoneH / 2); // Stack perfectly on top
                
                // Offset every other base layer by half a stone for running bond pattern
                let layerOffsetRatio = (!isCapLayer && L % 2 === 1) ? 0.5 : 0;
                
                for(let s=0; s<seg.stonesPerLayer; s++) {
                    let progress = (s + layerOffsetRatio) / seg.stonesPerLayer;
                    if(progress >= 1.0) progress -= 1.0;
                    
                    let pos = seg.pt.clone().lerp(seg.nextPt, progress);
                    pos.y += yOffset;
                    
                    // Very subtle rotations to simulate imperfect hand-carved blocks
                    let rotY = (Math.random() - 0.5) * 0.05;
                    let rotX = (Math.random() - 0.5) * 0.02;
                    let rotZ = (Math.random() - 0.5) * 0.02;
                    
                    // Cap layer is slightly wider than base layers
                    let baseWidth = isCapLayer ? 0.45 : 0.35;
                    
                    let scaleX = baseWidth + (Math.random() - 0.5) * 0.02; // width
                    let scaleY = stoneH + (Math.random() - 0.5) * 0.01; // height
                    
                    dummy.position.copy(pos);
                    dummy.lookAt(pos.clone().add(dir));
                    dummy.rotateX(rotX);
                    dummy.rotateY(rotY);
                    dummy.rotateZ(rotZ);
                    
                    // Stretch Z to fill the segment, but leave a 2% gap for crevice shadows
                    let exactZ = seg.dist / seg.stonesPerLayer;
                    let scaleZ = exactZ * 0.98;
                    
                    dummy.scale.set(scaleX, scaleY, scaleZ);
                    
                    dummy.updateMatrix();
                    stoneMesh.setMatrixAt(stoneIdx, dummy.matrix);
                    
                    // Lighter, warmer classic stone colors
                    let shade = 0.65 + Math.random() * 0.2; 
                    let r = shade;
                    let g = shade * 0.95; // slightly less green
                    let b = shade * 0.9;  // less blue for warm tone
                    colorDummy.setRGB(r, g, b);
                    stoneMesh.setColorAt(stoneIdx, colorDummy);
                    
                    stoneIdx++;
                }
            }
        }
        stoneMesh.instanceMatrix.needsUpdate = true;
        if (stoneMesh.instanceColor) stoneMesh.instanceColor.needsUpdate = true;
        pMesh.add(stoneMesh);
    }
    
    pMesh.userData.collisionPts = pts.map(p => ({x:p.x, y:p.y, z:p.z}));
    return pMesh;
};

window.executeSplinePath = function(pathType) {
    if(splinePoints.length < 2) return;
    window.saveUndoState();
    
    let pMesh = window.buildFenceMesh(pathType, splinePoints);
    
    let rObj = {
        id: Math.random().toString(36).substr(2, 9),
        type: pathType,
        mesh: pMesh,
        splineData: splinePoints.map(p => ({x:p.x, y:p.y, z:p.z})),
        collisionData: pMesh.userData.collisionPts || []
    };
    window._arcadeScene.add(pMesh);
    if (!window.courseHoles[window.currentHoleIndex].envObjects) window.courseHoles[window.currentHoleIndex].envObjects = [];
    window.courseHoles[window.currentHoleIndex].envObjects.push(rObj);
    
    window.clearSpline();
};

window.executeSplineSmartGreen = function() {
    if(smartGreenPoints.length < 3) return;
    window.saveUndoState();

    let cfg = window.CURRENT_BIOME_CONFIG;
    let greenColor = cfg.greenColor || '#98ce68';
    let foregreenColor = cfg.foregreenColor || '#8bc45d';
    let difficulty = window.greenDifficulty || 'FLAT';
    
    // Random seed offset for unique contours per green build
    window._sgSeedOffsetX = (Math.random() - 0.5) * 200;
    window._sgSeedOffsetZ = (Math.random() - 0.5) * 200;

    // Get foregreen width from slider (default 1.0m)
    let fgSlider = document.getElementById('sg-foregreen-width');
    let foregreenWidth = fgSlider ? parseFloat(fgSlider.value) : 1.0;

    // Get surround hill settings (only when Raised Green is toggled on)
    let surroundHeight = 0;
    let surroundRadius = 8;
    if (window._raisedGreenActive) {
        let shSlider = document.getElementById('sg-surround-height');
        surroundHeight = shSlider ? parseFloat(shSlider.value) : 0;
        let srSlider = document.getElementById('sg-surround-radius');
        surroundRadius = srSlider ? parseFloat(srSlider.value) : 8;
    }

    // Get tilt settings (auto-enabled when Raised Green is on + aimPoint exists)
    let tiltEnabled = false;
    let tiltPct = 0.02;
    let hole = window.courseHoles[window.currentHoleIndex];
    if (window._raisedGreenActive && hole && hole.aimPoint) {
        tiltEnabled = true;
        let tiltSlider = document.getElementById('sg-tilt-pct');
        tiltPct = tiltSlider ? parseFloat(tiltSlider.value) / 100 : 0.02;
    }

    // Build closed curve from points using closed=true for smooth loop at first point
    let curve = new THREE.CatmullRomCurve3(smartGreenPoints, true);
    let numSamples = Math.max(200, smartGreenPoints.length * 40);
    let densePts = curve.getPoints(numSamples);

    // === 1. PAINT: Foregreen ring (expanded polygon) + Green fill ===
    window._arcadePCtx.save();

    // Edge sharpness: 100 = pixel-perfect sharp (default), 0 = soft feathered edge
    let sharpSlider = document.getElementById('sg-edge-sharpness');
    let sharpness = sharpSlider ? parseInt(sharpSlider.value) : 100;
    
    if(sharpness < 100) {
        // Soft edge: subtle blur (max 6px on 4096px canvas = ~0.15% feather)
        let blurPx = Math.round((100 - sharpness) * 0.06); // 0-6px blur range
        if(blurPx > 0) window._arcadePCtx.filter = 'blur(' + blurPx + 'px)';
    }

    // Draw foregreen ring: uniform-width offset polygon
    if(foregreenWidth > 0) {
        let expandedPts = offsetPolygon(densePts, foregreenWidth);
        window._arcadePCtx.beginPath();
        expandedPts.forEach((pt, i) => {
            let pxX = ((pt.x + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
            let pxY = ((pt.z + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
            if(i === 0) window._arcadePCtx.moveTo(pxX, pxY);
            else window._arcadePCtx.lineTo(pxX, pxY);
        });
        window._arcadePCtx.closePath();
        window._arcadePCtx.fillStyle = foregreenColor;
        window._arcadePCtx.fill();
    }

    // Draw green fill (inner polygon, on top)
    window._arcadePCtx.beginPath();
    densePts.forEach((pt, i) => {
        let pxX = ((pt.x + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
        let pxY = ((pt.z + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
        if(i === 0) window._arcadePCtx.moveTo(pxX, pxY);
        else window._arcadePCtx.lineTo(pxX, pxY);
    });
    window._arcadePCtx.closePath();
    window._arcadePCtx.fillStyle = greenColor;
    window._arcadePCtx.fill();

    // === MOWING PATTERN OVERLAY ===
    let mowPattern = window._smartMowPattern || 'SOLID';
    if (mowPattern !== 'SOLID') {
        paintMowingPattern(window._arcadePCtx, densePts, greenColor, mowPattern);
    }

    window._arcadePCtx.filter = 'none'; // Reset filter

    window._arcadePCtx.restore();
    window._arcadeMapTex.needsUpdate = true;
    window.terrainBiomeData = window._arcadePCtx.getImageData(0, 0, 4096, 4096).data;

    // === 2. TERRAIN SCULPTING: Flatten + Difficulty Contours ===
    let positions = window._arcadePlaneGeo.attributes.position.array;
    let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;

    // Build bounding box for early exit
    let pathMinX = Infinity, pathMaxX = -Infinity, pathMinZ = Infinity, pathMaxZ = -Infinity;
    for(let pt of densePts) {
        if(pt.x < pathMinX) pathMinX = pt.x;
        if(pt.x > pathMaxX) pathMaxX = pt.x;
        if(pt.z < pathMinZ) pathMinZ = pt.z;
        if(pt.z > pathMaxZ) pathMaxZ = pt.z;
    }
    let margin = foregreenWidth + Math.max(8, surroundRadius + 2); // Include surround hill area

    let gxStart = Math.max(0, Math.floor((pathMinX - margin + window.TERRAIN_SIZE/2) / step));
    let gxEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxX + margin + window.TERRAIN_SIZE/2) / step));
    let gzStart = Math.max(0, Math.floor((pathMinZ - margin + window.TERRAIN_SIZE/2) / step));
    let gzEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxZ + margin + window.TERRAIN_SIZE/2) / step));

    // Calculate average height of spline points as base plateau height
    let baseH = 0;
    for(let pt of smartGreenPoints) {
        let surf = window.localGetTerrainAt(pt.x, -pt.z);
        baseH += surf ? surf.z : 0;
    }
    baseH /= smartGreenPoints.length;

    // Point-in-polygon test (ray casting)
    function pointInPolygon(px, pz, polyPts) {
        let inside = false;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let xi = polyPts[i].x, zi = polyPts[i].z;
            let xj = polyPts[j].x, zj = polyPts[j].z;
            if(((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Distance from point to nearest polygon edge
    function distToPolygon(px, pz, polyPts) {
        let minDist = Infinity;
        for(let i = 0, j = polyPts.length - 1; i < polyPts.length; j = i++) {
            let ax = polyPts[j].x, az = polyPts[j].z;
            let bx = polyPts[i].x, bz = polyPts[i].z;
            let dx = bx - ax, dz = bz - az;
            let len2 = dx*dx + dz*dz;
            let t = len2 > 0 ? Math.max(0, Math.min(1, ((px-ax)*dx + (pz-az)*dz) / len2)) : 0;
            let projX = ax + t*dx, projZ = az + t*dz;
            let d = Math.sqrt((px-projX)**2 + (pz-projZ)**2);
            if(d < minDist) minDist = d;
        }
        return minDist;
    }

    // Compute tilt direction vector (from centroid toward aimPoint)
    let tiltDirX = 0, tiltDirZ = 0, tiltMaxDist = 1;
    let polyCentX = 0, polyCentZ = 0;
    for (let p of densePts) { polyCentX += p.x; polyCentZ += p.z; }
    polyCentX /= densePts.length; polyCentZ /= densePts.length;
    if (tiltEnabled) {
        tiltDirX = hole.aimPoint.x - polyCentX;
        tiltDirZ = hole.aimPoint.z - polyCentZ;
        let len = Math.sqrt(tiltDirX * tiltDirX + tiltDirZ * tiltDirZ);
        if (len > 0) { tiltDirX /= len; tiltDirZ /= len; }
        // Max distance from centroid to any polygon edge (for scaling)
        tiltMaxDist = 0;
        for (let p of densePts) {
            let d = (p.x - polyCentX) * tiltDirX + (p.z - polyCentZ) * tiltDirZ;
            if (Math.abs(d) > tiltMaxDist) tiltMaxDist = Math.abs(d);
        }
        if (tiltMaxDist < 1) tiltMaxDist = 1;
    }

    // Build expanded foregreen polygon for surround hill start
    let expandedFG = foregreenWidth > 0 ? offsetPolygon(densePts, foregreenWidth) : densePts;

    // === PASS 1: SURROUND HILL (raise terrain around green — distance-based, no jagged edges) ===
    if (surroundHeight > 0) {
        let totalSpread = foregreenWidth + surroundRadius;
        for(let gz = gzStart; gz <= gzEnd; gz++) {
            for(let gx = gxStart; gx <= gxEnd; gx++) {
                let idx = gz * (window.TERRAIN_SEGS+1) + gx;
                let vx = positions[idx*3];
                let vz = -positions[idx*3+1];

                // Use signed distance: negative = inside green, positive = outside
                let isInside = pointInPolygon(vx, vz, densePts);
                let distEdge = distToPolygon(vx, vz, densePts);
                let signedDist = isInside ? -distEdge : distEdge;

                // Skip vertices too far outside
                if (signedDist > totalSpread) continue;

                let currentH = positions[idx*3+2];
                let hillH = 0;

                if (signedDist <= 0) {
                    // Inside green polygon: full height
                    hillH = surroundHeight;
                } else if (signedDist <= foregreenWidth) {
                    // Foregreen zone: full height (smooth transition handled naturally)
                    hillH = surroundHeight;
                } else {
                    // Surround zone: smooth cosine falloff from foregreen edge
                    let distFromFG = signedDist - foregreenWidth;
                    let t = distFromFG / surroundRadius;
                    hillH = surroundHeight * 0.5 * (1 + Math.cos(t * Math.PI));
                }

                // Apply tilt
                if (tiltEnabled && signedDist > 0) {
                    let proj = (vx - polyCentX) * tiltDirX + (vz - polyCentZ) * tiltDirZ;
                    let tiltFade = Math.min(1, signedDist / totalSpread);
                    hillH += (proj / tiltMaxDist) * tiltMaxDist * tiltPct * (1 - tiltFade);
                }

                if (hillH > 0.01) {
                    positions[idx*3+2] = currentH + hillH;
                }
            }
        }
    }

    // === PASS 2: FLATTEN GREEN + CONTOURS (on top of raised terrain) ===
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            let isInside = pointInPolygon(vx, vz, densePts);
            if (!isInside) continue; // Only flatten the actual green polygon

            let targetHeight = baseH + surroundHeight;
            let seedX = vx + window._sgSeedOffsetX;
            let seedZ = vz + window._sgSeedOffsetZ;
            if(difficulty === 'EASY') {
                targetHeight += Math.sin(seedX * 0.1) * Math.cos(seedZ * 0.1) * 0.10;
            } else if(difficulty === 'MED') {
                targetHeight += Math.sin(seedX * 0.12) * Math.cos(seedZ * 0.12) * 0.18;
                targetHeight += Math.sin(seedX * 0.07 + seedZ * 0.05) * 0.08;
            } else if(difficulty === 'HARD') {
                targetHeight += Math.sin(seedX * 0.15) * Math.cos(seedZ * 0.12) * 0.22
                              + Math.sin(seedZ * 0.25 + seedX * 0.08) * 0.06
                              + Math.cos(seedX * 0.20) * Math.sin(seedZ * 0.18) * 0.05;
            }

            // Apply tilt
            if (tiltEnabled) {
                let proj = (vx - polyCentX) * tiltDirX + (vz - polyCentZ) * tiltDirZ;
                targetHeight += (proj / tiltMaxDist) * tiltMaxDist * tiltPct;
            }

            let currentH = positions[idx*3+2];
            positions[idx*3+2] = currentH + (targetHeight - currentH) * 0.95;
        }
    }

    window._arcadePlaneGeo.attributes.position.needsUpdate = true;
    window._arcadePlaneGeo.computeVertexNormals();
    window._arcadePlaneGeo.computeBoundingBox();
    window._arcadePlaneGeo.computeBoundingSphere();
    window.snapObjectsToGround();

    // Refresh overlays
    if(window.slopeOverlayActive) window.updateSlopeOverlay();
    if(window.contourLinesActive) window.updateContourLines();
    if(window.elevationHeatmapActive) window.updateElevationHeatmap();


    // Auto-place Flag at centroid
    let cx = 0, cz = 0;
    for(let pt of smartGreenPoints) { cx += pt.x; cz += pt.z; }
    cx /= smartGreenPoints.length;
    cz /= smartGreenPoints.length;
    let surf = window.localGetTerrainAt(cx, -cz);
    let cy = surf ? surf.z : baseH;

    hole = window.courseHoles[window.currentHoleIndex];
    if (hole.flagMesh) window._arcadeScene.remove(hole.flagMesh);
    hole.flag = { x: cx, y: cy, z: cz };
    hole.flagMesh = window.createFlagObject(cx, cy, cz);
    
    if(!hole.pins) hole.pins = {};
    hole.pins.easy = { x: cx, y: cy, z: cz };
    hole.pins.medium = { x: cx, y: cy, z: cz };
    hole.pins.hard = { x: cx, y: cy, z: cz };

    // After green is built, auto-switch to AIM if tees exist but no aim point
    if((hole.tees.yellow || hole.tees.red || hole.tees.white || hole.tees.black) && !hole.aimPoint) {
        setTimeout(function() {
            setSmartBuilderType('AIM');
            window.showBuildToast('🎯 Click to set Aim Point — tees will auto-sort', '#f59e0b');
        }, 300);
    }

    clearSmartGreen();
    window.saveLevel();
    window.autoAdvanceHole();

    // Prevent double-click from starting a new shape immediately
    window._smartBuildCooldown = true;
    setTimeout(function() { window._smartBuildCooldown = false; }, 500);
};

    // Update hole display in Smart Builder panel
    window.updateSBHoleDisplay = function() {
        let el = document.getElementById('sb-hole-display');
        if(!el) return;
        let hole = window.courseHoles[window.currentHoleIndex];
        let hasTee = hole.tees.yellow || hole.tees.red || hole.tees.white || hole.tees.black;
        let hasFlag = hole.flag;
        let hasAim = hole.aimPoint;
        let status = '○'; // empty
        if(hasTee && hasFlag && hasAim) status = '✅'; // complete
        else if(hasTee || hasFlag) status = '⚠️'; // partial
        el.textContent = 'Hole ' + (window.currentHoleIndex + 1) + ' (Par ' + hole.par + ') ' + status;
        // Also sync HOLE tool display
        let holeNum = document.getElementById('hole-ui-num');
        if(holeNum) holeNum.innerText = 'Hole ' + (window.currentHoleIndex + 1);
        let holePar = document.getElementById('hole-ui-par');
        if(holePar) holePar.innerText = 'Par ' + hole.par;
    };

    // Auto-advance to next incomplete hole
    window.autoAdvanceHole = function() {
        let hole = window.courseHoles[window.currentHoleIndex];
        let hasTee = hole.tees.yellow || hole.tees.red || hole.tees.white || hole.tees.black;
        let hasFlag = hole.flag;
        let hasAim = hole.aimPoint;
        if(hasTee && hasFlag && hasAim) {
            // Find next incomplete hole
            let nextIdx = -1;
            for(let i = window.currentHoleIndex + 1; i < window.MAX_HOLES; i++) {
                let h = window.courseHoles[i];
                let ht = h.tees.yellow || h.tees.red || h.tees.white || h.tees.black;
                if(!ht || !h.flag || !h.aimPoint) { nextIdx = i; break; }
            }
            if(nextIdx >= 0) {
                window.showBuildToast('✅ Hole ' + (window.currentHoleIndex+1) + ' Complete! → Hole ' + (nextIdx+1), '#4ade80');
                setTimeout(function() {
                    window.currentHoleIndex = nextIdx;
                    updateSBHoleDisplay();
                }, 1500);
            } else {
                window.showBuildToast('🏆 All holes configured!', '#fbbf24');
            }
        }
        updateSBHoleDisplay();
    };

    function executeSmartBuilder() {
        if(window._smartBuildCooldown) return;
        if(window._smartBuilderType === 'BUNKER') {
            executeSmartBunker();
        } else if(window._smartBuilderType === 'FAIRWAY') {
            executeSmartFairway();
        } else if(window._smartBuilderType === 'TEE') {
            executeSmartTee();
        } else if(window._smartBuilderType === 'PAINT') {
            window.executeSmartPaint();
        } else {
            executeSplineSmartGreen();
        }
    }

    // === SMART PAINT: Precision polygon surface painting ===
    window.executeSmartPaint = function() {
        if(smartGreenPoints.length < 3) return;
        window.saveUndoState();

        // Re-read color from CURRENT biome config to prevent stale colors
        // This is the core fix: always derive color from active biome + selected surface
        let surface = window._smartPaintSurface || 'foregreen';
        let cfg = window.CURRENT_BIOME_CONFIG;
        var liveColorMap = {
            foregreen: cfg.foregreenColor || '#8bc45d',
            fairway: cfg.fairwayColor || '#7db952',
            semi: cfg.semiColor || '#6b9e3d',
            rough: cfg.roughColor || '#4a782b',
            fescue: cfg.fescueColor || '#2d4c1a',
            green: cfg.greenColor || '#98ce68',
            bunker: cfg.bunkerColor || '#e0d8a4',
            waste: cfg.wasteColor || '#c2af7c',
            water: cfg.waterColor || '#38bdf8',
            ob: cfg.obColor || '#ef4444'
        };
        let color;
        if (surface === 'custom') {
            let customEl = document.getElementById('sp-custom-color');
            color = customEl ? customEl.value : (window._smartPaintColor || '#8bc45d');
        } else {
            color = liveColorMap[surface] || window._smartPaintColor || '#8bc45d';
        }

        // Build closed curve from points
        let curve = new THREE.CatmullRomCurve3(smartGreenPoints, true);
        let numSamples = Math.max(200, smartGreenPoints.length * 40);
        let densePts = curve.getPoints(numSamples);

        // Paint onto terrain canvas
        window._arcadePCtx.save();

        // Edge sharpness support (shared slider with GREEN/FAIRWAY)
        let sharpSlider = document.getElementById('sg-edge-sharpness');
        let sharpness = sharpSlider ? parseInt(sharpSlider.value) : 100;
        if(sharpness < 100) {
            let blurPx = Math.round((100 - sharpness) * 0.06);
            if(blurPx > 0) window._arcadePCtx.filter = 'blur(' + blurPx + 'px)';
        }

        window._arcadePCtx.beginPath();
        densePts.forEach((pt, i) => {
            let pxX = ((pt.x + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
            let pxY = ((pt.z + (window.TERRAIN_SIZE/2)) / window.TERRAIN_SIZE) * 4096;
            if(i === 0) window._arcadePCtx.moveTo(pxX, pxY);
            else window._arcadePCtx.lineTo(pxX, pxY);
        });
        window._arcadePCtx.closePath();
        window._arcadePCtx.fillStyle = color;
        window._arcadePCtx.fill();

        // No mowing pattern for PAINT — patterns are exclusive to GREEN/FAIRWAY

        window._arcadePCtx.filter = 'none';
        window._arcadePCtx.restore();
        window._arcadeMapTex.needsUpdate = true;
        window.terrainBiomeData = window._arcadePCtx.getImageData(0, 0, 4096, 4096).data;

        // Show feedback toast
        let nameMap = {foregreen:'Foregreen', fairway:'Fairway', semi:'Semi-rough', rough:'Rough', fescue:'Deep Rough', green:'Green', bunker:'Sand', waste:'Waste', water:'Water', ob:'OB', custom:'Custom'};
        if (window.showBuildToast) window.showBuildToast('🎨 Painted ' + (nameMap[surface] || surface), '#a78bfa');

        // Clear spline
        clearSmartGreen();
    };

// ================================================================
//  TERRAIN STAMP SYSTEM
//  Capture terrain heightmaps and stamp them elsewhere.
//  Storage: localStorage (admin will later save to DB)
// ================================================================

(function() {
    // Load stamp library from localStorage
    window._stampLibrary = [];
    try {
        let saved = localStorage.getItem('terrainStamps');
        if (saved) window._stampLibrary = JSON.parse(saved);
    } catch(e) { console.warn('Could not load stamps:', e); }

    // Active stamp index for placement
    window._activeStampIndex = -1;
    window._stampScale = 1.0;
    window._stampRotation = 0;
    window._stampAmplitude = 1.0;

    // === CAPTURE: Save terrain heightmap within radius ===
    window.captureTerrainStamp = function(centerX, centerZ, captureRadius, stampName) {
        let positions = window._arcadePlaneGeo.attributes.position.array;
        let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;
        let stride = window.TERRAIN_SEGS + 1;

        // Grid radius in vertex units
        let gridRadius = Math.ceil(captureRadius / step);
        let gridSize = gridRadius * 2 + 1;

        // Center vertex indices
        let cGx = Math.round((centerX + window.TERRAIN_SIZE / 2) / step);
        let cGz = Math.round((centerZ + window.TERRAIN_SIZE / 2) / step);

        // Calculate base height from edge ring (MINIMUM to prevent negative deltas on slopes)
        let edgeMin = Infinity, edgeCount = 0;
        for (let dz = -gridRadius; dz <= gridRadius; dz++) {
            for (let dx = -gridRadius; dx <= gridRadius; dx++) {
                let dist = Math.sqrt(dx * dx + dz * dz) * step;
                if (dist > captureRadius * 0.85 && dist <= captureRadius) {
                    let gx = cGx + dx, gz = cGz + dz;
                    if (gx >= 0 && gx < stride && gz >= 0 && gz < stride) {
                        let h = positions[(gz * stride + gx) * 3 + 2];
                        if (h < edgeMin) edgeMin = h;
                        edgeCount++;
                    }
                }
            }
        }
        let baseHeight = edgeCount > 0 ? edgeMin : 0;

        // Capture height deltas
        let heights = new Array(gridSize * gridSize);
        let hasData = false;
        for (let dz = -gridRadius; dz <= gridRadius; dz++) {
            for (let dx = -gridRadius; dx <= gridRadius; dx++) {
                let dist = Math.sqrt(dx * dx + dz * dz) * step;
                let gx = cGx + dx, gz = cGz + dz;
                let arrIdx = (dz + gridRadius) * gridSize + (dx + gridRadius);

                if (dist <= captureRadius && gx >= 0 && gx < stride && gz >= 0 && gz < stride) {
                    let h = positions[(gz * stride + gx) * 3 + 2] - baseHeight;
                    // No edge-fade here — apply-side falloff handles it (prevents double-fade)
                    heights[arrIdx] = Math.round(h * 100) / 100; // 1cm precision
                    if (Math.abs(h) > 0.1) hasData = true;
                } else {
                    heights[arrIdx] = null;
                }
            }
        }

        if (!hasData) {
            if (window.showBuildToast) window.showBuildToast('⚠️ No terrain variation to capture!', '#ef4444');
            return null;
        }

        // Generate thumbnail (64x64 heightmap visualization)
        let thumbSize = 64;
        let thumbCanvas = document.createElement('canvas');
        thumbCanvas.width = thumbSize;
        thumbCanvas.height = thumbSize;
        let tCtx = thumbCanvas.getContext('2d');
        tCtx.fillStyle = '#1e293b';
        tCtx.fillRect(0, 0, thumbSize, thumbSize);

        // Find height range for color mapping
        let minH = Infinity, maxH = -Infinity;
        for (let i = 0; i < heights.length; i++) {
            if (heights[i] != null) {
                if (heights[i] < minH) minH = heights[i];
                if (heights[i] > maxH) maxH = heights[i];
            }
        }
        let hRange = Math.max(0.1, maxH - minH);

        for (let py = 0; py < thumbSize; py++) {
            for (let px = 0; px < thumbSize; px++) {
                let sx = Math.floor((px / thumbSize) * gridSize);
                let sy = Math.floor((py / thumbSize) * gridSize);
                let h = heights[sy * gridSize + sx];
                if (h != null) {
                    let norm = (h - minH) / hRange;
                    let r = Math.floor(40 + norm * 120);
                    let g = Math.floor(80 + norm * 160);
                    let b = Math.floor(40 + norm * 60);
                    tCtx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
                    tCtx.fillRect(px, py, 1, 1);
                }
            }
        }

        let stamp = {
            name: stampName || ('Stamp ' + (window._stampLibrary.length + 1)),
            radius: captureRadius,
            gridSize: gridSize,
            step: step,
            heights: heights,
            thumbnail: thumbCanvas.toDataURL('image/png', 0.8),
            createdAt: new Date().toISOString()
        };

        window._stampLibrary.push(stamp);
        _saveStampLibrary();

        if (window.showBuildToast) window.showBuildToast('📷 Captured "' + stamp.name + '" (' + gridSize + 'x' + gridSize + ')', '#4ade80');
        window.renderStampLibrary();
        return stamp;
    };

    // === APPLY: Stamp terrain at target position ===
    window.applyTerrainStamp = function(stampIndex, centerX, centerZ) {
        let stamp = window._stampLibrary[stampIndex];
        if (!stamp) return;

        window.saveUndoState();

        let positions = window._arcadePlaneGeo.attributes.position.array;
        let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;
        let stride = window.TERRAIN_SEGS + 1;

        let scale = window._stampScale || 1.0;
        let rotation = (window._stampRotation || 0) * Math.PI / 180; // degrees to radians
        let amplitude = window._stampAmplitude || 1.0;

        let cGx = Math.round((centerX + window.TERRAIN_SIZE / 2) / step);
        let cGz = Math.round((centerZ + window.TERRAIN_SIZE / 2) / step);

        let scaledRadius = Math.ceil((stamp.radius * scale) / step) + 1;
        let halfGrid = Math.floor(stamp.gridSize / 2);
        let cosR = Math.cos(-rotation);
        let sinR = Math.sin(-rotation);

        for (let dz = -scaledRadius; dz <= scaledRadius; dz++) {
            for (let dx = -scaledRadius; dx <= scaledRadius; dx++) {
                let gx = cGx + dx, gz = cGz + dz;
                if (gx < 0 || gx >= stride || gz < 0 || gz >= stride) continue;

                // Rotate + scale to find sample position in stamp space
                let sx = (dx * cosR + dz * sinR) / scale + halfGrid;
                let sz = (-dx * sinR + dz * cosR) / scale + halfGrid;

                // Bilinear interpolation for smooth sampling
                let ix = Math.floor(sx), iz = Math.floor(sz);
                let fx = sx - ix, fz = sz - iz;

                if (ix < 0 || ix >= stamp.gridSize - 1 || iz < 0 || iz >= stamp.gridSize - 1) continue;

                let h00 = stamp.heights[iz * stamp.gridSize + ix];
                let h10 = stamp.heights[iz * stamp.gridSize + ix + 1];
                let h01 = stamp.heights[(iz + 1) * stamp.gridSize + ix];
                let h11 = stamp.heights[(iz + 1) * stamp.gridSize + ix + 1];

                // Skip if any corner is outside capture area
                if (h00 == null || h10 == null || h01 == null || h11 == null) continue;

                let h = (h00 * (1 - fx) * (1 - fz)) + (h10 * fx * (1 - fz)) +
                        (h01 * (1 - fx) * fz) + (h11 * fx * fz);

                // Soft edge falloff (last 30% of radius fades out)
                let worldDist = Math.sqrt(dx * dx + dz * dz) * step;
                let maxDist = stamp.radius * scale;
                let falloff = 1.0;
                if (worldDist > maxDist * 0.7) {
                    falloff = 1.0 - ((worldDist - maxDist * 0.7) / (maxDist * 0.3));
                    falloff = Math.max(0, Math.min(1, falloff));
                    falloff = falloff * falloff * (3 - 2 * falloff); // Smoothstep
                }

                let idx = gz * stride + gx;
                positions[idx * 3 + 2] += h * amplitude * falloff;
            }
        }

        // Update terrain
        window._arcadePlaneGeo.attributes.position.needsUpdate = true;
        window._arcadePlaneGeo.computeVertexNormals();
        window._arcadePlaneGeo.computeBoundingBox();
        window._arcadePlaneGeo.computeBoundingSphere();
        if (window.snapObjectsToGround) window.snapObjectsToGround();
        if (window.slopeOverlayActive) window.updateSlopeOverlay();
        if (window.contourLinesActive) window.updateContourLines();
        if (window.elevationHeatmapActive) window.updateElevationHeatmap();

        if (window.showBuildToast) window.showBuildToast('🔨 Stamped "' + stamp.name + '"', '#38bdf8');
    };

    // === DELETE: Remove stamp from library ===
    window.deleteTerrainStamp = function(index) {
        if (index >= 0 && index < window._stampLibrary.length) {
            let name = window._stampLibrary[index].name;
            window._stampLibrary.splice(index, 1);
            _saveStampLibrary();
            if (window._activeStampIndex >= window._stampLibrary.length) {
                window._activeStampIndex = window._stampLibrary.length - 1;
            }
            window.renderStampLibrary();
            if (window.showBuildToast) window.showBuildToast('🗑️ Deleted "' + name + '"', '#ef4444');
        }
    };

    // === RENDER: Build stamp library HTML ===
    window.renderStampLibrary = function() {
        let container = document.getElementById('stamp-library-list');
        if (!container) return;

        if (window._stampLibrary.length === 0) {
            container.innerHTML = '<div style="color:#475569; font-size:9px; text-align:center; padding:8px;">No stamps yet. Sculpt terrain, then capture!</div>';
            return;
        }

        let html = '';
        for (let i = 0; i < window._stampLibrary.length; i++) {
            let s = window._stampLibrary[i];
            let isActive = (i === window._activeStampIndex);
            let border = isActive ? '2px solid #4ade80' : '1px solid #334155';
            let bg = isActive ? '#1e3a5f' : '#0f172a';
            html += '<div onclick="window._activeStampIndex=' + i + '; window.renderStampLibrary();" style="display:flex; align-items:center; gap:6px; padding:5px; border-radius:5px; cursor:pointer; border:' + border + '; background:' + bg + '; margin-bottom:3px;">';
            html += '<img src="' + s.thumbnail + '" style="width:36px; height:36px; border-radius:4px; image-rendering:pixelated;">';
            html += '<div style="flex:1; min-width:0;">';
            html += '<div style="color:#e2e8f0; font-size:10px; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + s.name + '</div>';
            html += '<div style="color:#64748b; font-size:8px;">' + Math.round(s.radius) + 'm radius</div>';
            html += '</div>';
            html += '<button onclick="event.stopPropagation(); window.deleteTerrainStamp(' + i + ');" style="background:none; border:none; color:#ef4444; cursor:pointer; font-size:12px; padding:2px 4px;" title="Delete">✕</button>';
            html += '</div>';
        }
        container.innerHTML = html;
    };

    function _saveStampLibrary() {
        try {
            localStorage.setItem('terrainStamps', JSON.stringify(window._stampLibrary));
        } catch (e) {
            console.warn('Could not save stamps (storage full?):', e);
            if (window.showBuildToast) window.showBuildToast('⚠️ Storage full! Delete some stamps.', '#ef4444');
        }
    }
})();
