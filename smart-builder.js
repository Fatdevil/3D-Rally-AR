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

// Injection bridge for arcade-scan-builder.js → allows scan-built roads
// to use the full executeSmartRoad() pipeline (terrain sculpting, barriers, paint)
window._injectSmartGreenPoints = function(points) {
    smartGreenPoints = points.slice();
};

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
    
    // ROAD mode: open path, auto-snap to previous road if clicking near it!
    if(window._smartBuilderType === 'ROAD' && typeof currentTool !== 'undefined' && currentTool === 'SMART_BUILDER') {
        if (smartGreenPoints.length === 0 && window._lastRoadEndPoint) {
            let dist = Math.sqrt((pt.x - window._lastRoadEndPoint.x)**2 + (pt.z - window._lastRoadEndPoint.z)**2);
            if (dist < 15.0) { // Snäpp fast om vi är inom 15 meter!
                smartGreenPoints.push(new THREE.Vector3(window._lastRoadEndPoint.x, window._lastRoadEndPoint.y, window._lastRoadEndPoint.z));
                if (window.showBuildToast) window.showBuildToast('🔗 Snapped to previous road!', '#fcd34d');
                return true;
            }
        }
        
        // ── ROAD SPLINE GUIDE: Min-distance guard ──
        let roadW = window._smartRoadWidth || 10;
        let minDist = roadW; // Don't allow points closer than road width
        if (smartGreenPoints.length > 0) {
            let last = smartGreenPoints[smartGreenPoints.length - 1];
            let d = Math.sqrt((pt.x - last.x)**2 + (pt.z - last.z)**2);
            if (d < minDist) {
                if (window.showBuildToast) window.showBuildToast('⚠️ Too close! Min ' + Math.round(minDist) + 'm between points', '#ef4444');
                return false;
            }
        }
        
        // ── ROAD SPLINE GUIDE: Tight angle warning ──
        if (smartGreenPoints.length >= 2) {
            let prev2 = smartGreenPoints[smartGreenPoints.length - 2];
            let prev1 = smartGreenPoints[smartGreenPoints.length - 1];
            // Vector from prev2 → prev1
            let ax = prev1.x - prev2.x, az = prev1.z - prev2.z;
            // Vector from prev1 → new point
            let bx = pt.x - prev1.x, bz = pt.z - prev1.z;
            let aLen = Math.sqrt(ax*ax + az*az);
            let bLen = Math.sqrt(bx*bx + bz*bz);
            if (aLen > 0.1 && bLen > 0.1) {
                let dot = (ax*bx + az*bz) / (aLen * bLen);
                dot = Math.max(-1, Math.min(1, dot));
                let angle = Math.acos(dot) * 180 / Math.PI; // degrees deviation
                if (angle > 120) {
                    // Very sharp U-turn — warn but allow
                    if (window.showBuildToast) window.showBuildToast('🔴 Hairpin (' + Math.round(angle) + '°) — use rally stakes for tight bends', '#ef4444');
                } else if (angle > 90) {
                    // Tight but fine with stakes
                    if (window.showBuildToast) window.showBuildToast('🟡 Sharp turn (' + Math.round(angle) + '°)', '#f59e0b');
                }
            }
        }
        
        smartGreenPoints.push(pt);
        return true;
    }
    
    // Magnet-snap: if >= 3 points and new click is within 10m of FIRST point → close shape
    if(smartGreenPoints.length >= 3) {
        let first = smartGreenPoints[0];
        let dist = Math.sqrt((pt.x - first.x)**2 + (pt.z - first.z)**2);
        if(dist < 8.0) {
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
    if(smartGreenLineMesh) { 
        window._arcadeScene.remove(smartGreenLineMesh); 
        if (smartGreenLineMesh.geometry) smartGreenLineMesh.geometry.dispose();
        if (smartGreenLineMesh.material) smartGreenLineMesh.material.dispose();
        smartGreenLineMesh = null; 
    }

    if (!window._sgPreviewSMat) {
        window._sgPreviewSMat = new THREE.MeshBasicMaterial({ color: 0x4ade80 });
        window._sgPreviewSMatFirst = new THREE.MeshBasicMaterial({ color: 0x38bdf8 }); // Blue = start point
        window._sgPreviewSGeo = new THREE.SphereGeometry(0.4, 8, 8);
        window._sgPreviewSGeoFirst = new THREE.SphereGeometry(0.6, 8, 8);
    }
    
    smartGreenPoints.forEach((pt, idx) => {
        let s = new THREE.Mesh(idx === 0 ? window._sgPreviewSGeoFirst : window._sgPreviewSGeo, idx === 0 ? window._sgPreviewSMatFirst : window._sgPreviewSMat);
        s.position.copy(pt);
        s.position.y += 0.5;
        window._arcadeScene.add(s);
        smartGreenSpheres.push(s);
    });

    if(smartGreenPoints.length > 1) {
        let shouldClose = !!window._smartShapeClosed;
        let curve = new THREE.CatmullRomCurve3(smartGreenPoints, shouldClose, 'centripetal');
        let curvePts = curve.getPoints(50 * smartGreenPoints.length);
        
        // ── ROAD mode: curvature-colored preview line ──
        if (isRoad && curvePts.length >= 3) {
            let lineGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
            let colors = new Float32Array(curvePts.length * 3);
            
            let roadW = window._smartRoadWidth || 10;
            let shoulderW = window._smartRoadShoulder || 4;
            let fenceOffset = roadW / 2 + shoulderW;
            
            for (let ci = 0; ci < curvePts.length; ci++) {
                let prev = curvePts[Math.max(0, ci - 2)];
                let curr = curvePts[ci];
                let next = curvePts[Math.min(curvePts.length - 1, ci + 2)];
                
                // Tangent vectors
                let t1x = curr.x - prev.x, t1z = curr.z - prev.z;
                let t2x = next.x - curr.x, t2z = next.z - curr.z;
                let l1 = Math.sqrt(t1x*t1x + t1z*t1z);
                let l2 = Math.sqrt(t2x*t2x + t2z*t2z);
                
                let r = 0, g = 0.8, b = 0.2; // Default: green
                
                if (l1 > 0.01 && l2 > 0.01) {
                    t1x /= l1; t1z /= l1;
                    t2x /= l2; t2z /= l2;
                    let dot = t1x*t2x + t1z*t2z;
                    dot = Math.max(-1, Math.min(1, dot));
                    let angleChange = Math.acos(dot);
                    let arcLen = l1 + l2;
                    let localRadius = arcLen > 0.01 ? arcLen / angleChange : 999;
                    
                    if (localRadius < fenceOffset) {
                        // Red: fence will gap here
                        r = 0.95; g = 0.15; b = 0.1;
                    } else if (localRadius < fenceOffset * 2.5) {
                        // Orange: tight but OK
                        let t = (localRadius - fenceOffset) / (fenceOffset * 1.5);
                        r = 0.95 - t * 0.55; g = 0.15 + t * 0.65; b = 0.1 + t * 0.1;
                    }
                }
                
                colors[ci * 3] = r;
                colors[ci * 3 + 1] = g;
                colors[ci * 3 + 2] = b;
            }
            
            lineGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            let lineMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 3 });
            smartGreenLineMesh = new THREE.Line(lineGeo, lineMat);
            smartGreenLineMesh.position.y += 0.5;
            window._arcadeScene.add(smartGreenLineMesh);
        } else {
            let lineGeo = new THREE.BufferGeometry().setFromPoints(curvePts);
            let lineColor = shouldClose ? 0xfbbf24 : 0x4ade80;
            let lineMat = new THREE.LineBasicMaterial({ color: lineColor, linewidth: 3 });
            smartGreenLineMesh = new THREE.Line(lineGeo, lineMat);
            smartGreenLineMesh.position.y += 0.5;
            window._arcadeScene.add(smartGreenLineMesh);
        }
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
    window._smartDraggingIdx = -1;
    let measEl = document.getElementById('sb-measure-hud');
    if(measEl) measEl.style.display = 'none';
    updateSmartGreenPreview();
};

// ── SPLINE POINT DRAG SYSTEM ──
// Allows dragging existing waypoints to reposition them
window._smartDraggingIdx = -1;

// Check if a world-space point is near an existing waypoint. Returns index or -1.
window.smartFindNearPoint = function(hitPt, threshold) {
    threshold = threshold || 3.0;
    let bestIdx = -1, bestDist = threshold;
    for (let i = 0; i < smartGreenPoints.length; i++) {
        let dx = hitPt.x - smartGreenPoints[i].x;
        let dz = hitPt.z - smartGreenPoints[i].z;
        let d = Math.sqrt(dx * dx + dz * dz);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
};

// Start dragging a waypoint
window.smartStartDrag = function(hitPt) {
    let idx = window.smartFindNearPoint(hitPt, 3.0);
    if (idx >= 0) {
        window._smartDraggingIdx = idx;
        return true;
    }
    return false;
};

// Move the dragged waypoint to a new position
window.smartMoveDrag = function(hitPt) {
    let idx = window._smartDraggingIdx;
    if (idx < 0 || idx >= smartGreenPoints.length) return;
    smartGreenPoints[idx].x = hitPt.x;
    smartGreenPoints[idx].y = hitPt.y;
    smartGreenPoints[idx].z = hitPt.z;
    updateSmartGreenPreview();
};

// End drag
window.smartEndDrag = function() {
    if (window._smartDraggingIdx >= 0) {
        window._smartDraggingIdx = -1;
        updateSmartGreenPreview();
        return true;
    }
    return false;
};

// Remove last point (called by right-click)
window.smartRemoveLastPoint = function() {
    if (smartGreenPoints.length === 0) return false;
    smartGreenPoints.pop();
    if (smartGreenPoints.length === 0) window._smartShapeClosed = false;
    updateSmartGreenPreview();
    if (window.showBuildToast) {
        let remaining = smartGreenPoints.length;
        window.showBuildToast('↩️ Point removed (' + remaining + ' remaining)', '#64748b');
    }
    return true;
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

    let waterGeo = window._arcadeWaterGeo;
    let wPosArray = waterGeo ? waterGeo.attributes.position.array : null;

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

    // === PASS 1: DIGGING ===
    // Dig the bunker relative to the terrain, using continuous blend distances and shapes (FLAT / BOWL)
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            let isInside = pointInPolygon(vx, vz, densePts);
            if(!isInside) continue; // ONLY dig inside the polygon

            // Remove water inside the bunker
            if (wPosArray) {
                wPosArray[idx*3 + 2] = -99.0;
                if (window.waterBaseZ) {
                    window.waterBaseZ[idx] = -99.0;
                }
            }

            let distEdge = distToPolygon(vx, vz, densePts);
            let currentH = positions[idx*3+2];

            // Determine dig depth based on shape (FLAT or BOWL)
            let digDepth = depth;
            if (shape === 'BOWL') {
                let distCenter = Math.sqrt((vx - cx)**2 + (vz - cz)**2);
                let normalizedDist = distCenter / (maxDist + 0.001);
                let bowlFactor = 1.0 - Math.min(1.0, normalizedDist * normalizedDist);
                // Bowl is deeper in center (100% of depth) and shallower at edges (40% of depth)
                digDepth = depth * (0.4 + 0.6 * bowlFactor);
            }

            let targetHeight = currentH - digDepth;

            // Continuous blend distance calculation based on angle to face direction
            let relX = vx - cx;
            let relZ = vz - cz;
            let faceDot = relX * faceDx + relZ * faceDz;
            let distCenter = Math.sqrt(relX*relX + relZ*relZ);
            let cosTheta = distCenter > 0 ? (faceDot / distCenter) : 0;
            let t = (cosTheta + 1.0) / 2.0; // range [0, 1]
            
            // Smoothly vary blendDist between 2.5m (back side) and 5.0m (face side)
            let blendDist = 2.5 + (5.0 - 2.5) * t;
            let edgeBlend = Math.min(1.0, distEdge / blendDist);
            
            // Cubic smoothstep transition
            edgeBlend = edgeBlend * edgeBlend * (3.0 - 2.0 * edgeBlend);

            // Dig down towards target
            let blendedDig = currentH + (targetHeight - currentH) * edgeBlend;

            // Phase 2: LIP — raise edge on green-facing side (relative to local terrain)
            if (lipHeight > 0) {
                let normalized = faceDot / (faceLen + 0.001);
                let edgeProximity = 1.0 - Math.min(1.0, distEdge / 5.0); // 5m lip zone
                if (normalized > 0 && edgeProximity > 0) {
                    // Quadratic falloff + directional alignment
                    let lipInfluence = edgeProximity * edgeProximity * Math.min(1.0, normalized);
                    let lipAdd = lipHeight * lipInfluence;
                    blendedDig += lipAdd;
                }
            }

            positions[idx*3+2] = blendedDig;
        }
    }

    // === PASS 2: AUTO-SMOOTH EDGES ===
    // Run 5 passes of unbiased Laplacian smoothing on the transition zone (creases at bunker edges)
    let _smoothStride = window.TERRAIN_SEGS + 1;
    let smGxStart = Math.max(0, gxStart - 3);
    let smGxEnd = Math.min(window.TERRAIN_SEGS, gxEnd + 3);
    let smGzStart = Math.max(0, gzStart - 3);
    let smGzEnd = Math.min(window.TERRAIN_SEGS, gzEnd + 3);

    for(let smPass = 0; smPass < 5; smPass++) {
        // Copy current heights to a temp buffer for unbiased smoothing
        let tempHeights = new Float32Array(positions.length / 3);
        for (let i = 0; i < tempHeights.length; i++) {
            tempHeights[i] = positions[i*3 + 2];
        }

        for(let gz = smGzStart; gz <= smGzEnd; gz++) {
            for(let gx = smGxStart; gx <= smGxEnd; gx++) {
                let idx = gz * _smoothStride + gx;
                let vx = positions[idx*3];
                let vz = -positions[idx*3+1];

                let isInside = pointInPolygon(vx, vz, densePts);
                let distEdge = distToPolygon(vx, vz, densePts);

                // Smooth inside the bunker, and a margin outside (up to 2.5m) to blend the edges nicely
                if (isInside || distEdge < 2.5) {
                    let nCount = 0;
                    let nSum = 0;
                    if (gz > 0) { nSum += tempHeights[(gz-1)*_smoothStride + gx]; nCount++; }
                    if (gz < window.TERRAIN_SEGS) { nSum += tempHeights[(gz+1)*_smoothStride + gx]; nCount++; }
                    if (gx > 0) { nSum += tempHeights[gz*_smoothStride + gx-1]; nCount++; }
                    if (gx < window.TERRAIN_SEGS) { nSum += tempHeights[gz*_smoothStride + gx+1]; nCount++; }
                    
                    if (nCount > 0) {
                        let localAvg = nSum / nCount;
                        // Strength: strong at edge to remove jaggedness, milder further away
                        let smoothStrength = 0.6;
                        if (isInside && distEdge > 2.0) smoothStrength = 0.15; // Keep center shape intact
                        if (!isInside && distEdge > 1.5) smoothStrength = 0.25; // Fade out smoothing outside
                        
                        positions[idx*3 + 2] += (localAvg - tempHeights[idx]) * smoothStrength;
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

    if (wPosArray && window.rebuildWaterMask) {
        waterGeo.attributes.position.needsUpdate = true;
        window.rebuildWaterMask(false);
    }

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

// ═══════════════════════════════════════════════════════════
// ═══  RALLY RACE TOOLS  ═══════════════════════════════════
// ═══════════════════════════════════════════════════════════

// ── Helper: Create a gate mesh (start=green, finish=checkered) ──
function createRallyGate(x, y, z, type) {
    let gate = new THREE.Group();
    gate.name = type === 'start' ? 'RallyStart' : (type === 'start_finish' ? 'RallyStartFinish' : 'RallyFinish');
    
    let roadW = window._smartRoadWidth || 10;
    let halfW = roadW / 2;
    let poleH = 5;
    
    // Pole color
    let poleColor = (type === 'start' || type === 'start_finish') ? 0x22cc44 : 0xeeeeee;
    let poleMat = new THREE.MeshLambertMaterial({ color: poleColor });
    let poleGeo = new THREE.CylinderGeometry(0.15, 0.15, poleH, 8);
    
    let leftPole = new THREE.Mesh(poleGeo, poleMat);
    leftPole.position.set(-halfW, poleH / 2, 0);
    gate.add(leftPole);
    
    let rightPole = new THREE.Mesh(poleGeo, poleMat);
    rightPole.position.set(halfW, poleH / 2, 0);
    gate.add(rightPole);
    
    // Top beam
    let beamMat = (type === 'start' || type === 'start_finish') 
        ? new THREE.MeshLambertMaterial({ color: 0x22cc44 })
        : new THREE.MeshLambertMaterial({ color: 0x111111 });
    let beam = new THREE.Mesh(
        new THREE.BoxGeometry(roadW + 0.3, 0.5, 0.5),
        beamMat
    );
    beam.position.set(0, poleH, 0);
    gate.add(beam);
    
    // Banner (start=green with START text, finish=checkered, start_finish=split green/checkered)
    let bannerGeo = new THREE.PlaneGeometry(roadW * 0.8, 1.2);
    let bannerCanvas = document.createElement('canvas');
    bannerCanvas.width = 256; bannerCanvas.height = 64;
    let bCtx = bannerCanvas.getContext('2d');
    
    if (type === 'start') {
        bCtx.fillStyle = '#22cc44';
        bCtx.fillRect(0, 0, 256, 64);
        bCtx.fillStyle = '#fff';
        bCtx.font = 'bold 40px Arial';
        bCtx.textAlign = 'center';
        bCtx.fillText('START', 128, 46);
    } else if (type === 'start_finish') {
        // Left half green
        bCtx.fillStyle = '#22cc44';
        bCtx.fillRect(0, 0, 128, 64);
        
        // Right half checkered
        let sq = 8;
        for (let row = 0; row < 64 / sq; row++) {
            for (let col = 128 / sq; col < 256 / sq; col++) {
                bCtx.fillStyle = (row + col) % 2 === 0 ? '#fff' : '#111';
                bCtx.fillRect(col * sq, row * sq, sq, sq);
            }
        }
        
        // Text on left half
        bCtx.fillStyle = '#fff';
        bCtx.font = 'bold 28px Arial';
        bCtx.textAlign = 'center';
        bCtx.fillText('START', 64, 44);
        
        // Text on right half
        bCtx.fillStyle = '#fff';
        bCtx.strokeStyle = '#111';
        bCtx.lineWidth = 4;
        bCtx.font = 'bold 26px Arial';
        bCtx.strokeText('FINISH', 192, 44);
        bCtx.fillText('FINISH', 192, 44);
    } else {
        // Checkered pattern
        let sq = 16;
        for (let row = 0; row < 64 / sq; row++) {
            for (let col = 0; col < 256 / sq; col++) {
                bCtx.fillStyle = (row + col) % 2 === 0 ? '#fff' : '#111';
                bCtx.fillRect(col * sq, row * sq, sq, sq);
            }
        }
        bCtx.fillStyle = '#111';
        bCtx.font = 'bold 32px Arial';
        bCtx.textAlign = 'center';
        bCtx.fillText('FINISH', 128, 44);
    }
    
    let bannerTex = new THREE.CanvasTexture(bannerCanvas);
    let bannerFront = new THREE.Mesh(
        bannerGeo,
        new THREE.MeshBasicMaterial({ map: bannerTex, side: THREE.FrontSide })
    );
    bannerFront.position.set(0, poleH - 1.0, 0.02);
    bannerFront.rotation.y = Math.PI; // Rotated so the front faces oncoming driver
    gate.add(bannerFront);
    
    let bannerBack = new THREE.Mesh(
        bannerGeo,
        new THREE.MeshBasicMaterial({ map: bannerTex, side: THREE.FrontSide })
    );
    bannerBack.position.set(0, poleH - 1.0, -0.02);
    gate.add(bannerBack);
    
    gate.position.set(x, y, z);
    return gate;
}

// ── ROAD SPLINE SNAPPING ──
// Finds the nearest point on any built road spline and returns the point + tangent direction.
window.getNearestRoadPoint = function(hitPt) {
    if (!window._builtRoads || window._builtRoads.length === 0) return null;
    let closestPt = null;
    let minDist = Infinity;
    let closestTangent = new THREE.Vector3(0,0,1);
    let cRoadId = null;
    let cIndex = -1;
    
    window._builtRoads.forEach(road => {
        if (!road.sampledPoints || road.sampledPoints.length < 2) return;
        for (let i = 0; i < road.sampledPoints.length; i++) {
            let p = road.sampledPoints[i];
            let dist = Math.sqrt((p.x - hitPt.x)**2 + (p.z - hitPt.z)**2);
            if (dist < minDist) {
                minDist = dist;
                closestPt = { x: p.x, y: p.y, z: p.z };
                cRoadId = road.id;
                cIndex = i;
                
                let n = road.sampledPoints.length;
                let isClosed = !!road.closed;
                let pPrev, pNext;
                if (isClosed) {
                    pPrev = road.sampledPoints[(i - 1 + n) % n];
                    pNext = road.sampledPoints[(i + 1) % n];
                } else {
                    pPrev = i > 0 ? road.sampledPoints[i-1] : p;
                    pNext = i < n - 1 ? road.sampledPoints[i+1] : p;
                }
                
                // If consecutive points are too close/identical, look further to get a stable direction vector
                let look = 1;
                while (isClosed && Math.sqrt((pNext.x - pPrev.x)**2 + (pNext.z - pPrev.z)**2) < 0.2 && look < 15) {
                    look++;
                    pPrev = road.sampledPoints[(i - look + n) % n];
                    pNext = road.sampledPoints[(i + look) % n];
                }
                while (!isClosed && Math.sqrt((pNext.x - pPrev.x)**2 + (pNext.z - pPrev.z)**2) < 0.2 && look < 15) {
                    look++;
                    pPrev = road.sampledPoints[Math.max(0, i - look)];
                    pNext = road.sampledPoints[Math.min(n - 1, i + look)];
                }

                if (pPrev.x === pNext.x && pPrev.z === pNext.z) {
                    closestTangent.set(0, 0, 1);
                } else {
                    closestTangent.set(pNext.x - pPrev.x, 0, pNext.z - pPrev.z).normalize();
                }
            }
        }
    });
    
    // Snap radius: 30 meters
    if (minDist > 30) return null;
    
    return { point: new THREE.Vector3(closestPt.x, closestPt.y, closestPt.z), tangent: closestTangent, distance: minDist, roadId: cRoadId, splineIndex: cIndex };
};

// ── RALLY START: Single click to place start gate ──
window.executeSmartStartClick = function(cx, cy, cz, angle) {
    window.saveUndoState();
    
    let roadId = null, splineIndex = -1;
    let snapData = window.getNearestRoadPoint(new THREE.Vector3(cx, cy, cz));
    if (snapData) {
        cx = snapData.point.x;
        cy = snapData.point.y;
        cz = snapData.point.z;
        if (!window._rallyGateManualRotation) {
            angle = Math.atan2(snapData.tangent.x, snapData.tangent.z);
        }
        roadId = snapData.roadId;
        splineIndex = snapData.splineIndex;
    } else {
        if (typeof window.localGetTerrainAt === 'function') {
            let t = window.localGetTerrainAt(cx, -cz);
            cy = t ? t.z : cy;
        }
    }
    
    if (window.raceConfig.startMesh) {
        window._arcadeScene.remove(window.raceConfig.startMesh);
    }
    
    let gate = createRallyGate(cx, cy, cz, 'start');
    gate.rotation.y = angle || 0;
    window._arcadeScene.add(gate);
    
    window.raceConfig.start = { x: cx, y: cy, z: cz, rotation: angle || 0, roadId: roadId, splineIndex: splineIndex };
    window.raceConfig.startMesh = gate;
    
    let hole = window.courseHoles[0];
    if (hole) {
        hole.tees.yellow = { x: cx, y: cy, z: cz };
        if (angle) hole.tees.yellow.rot = angle;
    }
    
    window.saveLevel();
    if (window.showBuildToast) window.showBuildToast('🏁 START placed!', '#22cc44');
};

// ── RALLY FINISH: Single click to place finish gate ──
window.executeSmartFinishClick = function(cx, cy, cz, angle) {
    window.saveUndoState();
    
    let roadId = null, splineIndex = -1;
    let snapData = window.getNearestRoadPoint(new THREE.Vector3(cx, cy, cz));
    if (snapData) {
        cx = snapData.point.x;
        cy = snapData.point.y;
        cz = snapData.point.z;
        if (!window._rallyGateManualRotation) {
            angle = Math.atan2(snapData.tangent.x, snapData.tangent.z);
        }
        roadId = snapData.roadId;
        splineIndex = snapData.splineIndex;
    } else {
        if (typeof window.localGetTerrainAt === 'function') {
            let t = window.localGetTerrainAt(cx, -cz);
            cy = t ? t.z : cy;
        }
    }
    
    if (window.raceConfig.finishMesh) {
        window._arcadeScene.remove(window.raceConfig.finishMesh);
    }
    
    let gate = createRallyGate(cx, cy, cz, 'finish');
    gate.rotation.y = angle || 0;
    window._arcadeScene.add(gate);
    
    window.raceConfig.finish = { x: cx, y: cy, z: cz, rotation: angle || 0, roadId: roadId, splineIndex: splineIndex };
    window.raceConfig.finishMesh = gate;
    
    let hole = window.courseHoles[0];
    if (hole) {
        hole.flag = { x: cx, y: cy, z: cz };
    }
    
    window.saveLevel();
    if (window.showBuildToast) window.showBuildToast('🏁 FINISH placed!', '#111111');
};

// ── RALLY START/FINISH: Single click to place combined start/finish gate ──
window.executeSmartStartFinishClick = function(cx, cy, cz, angle) {
    window.saveUndoState();
    
    let roadId = null, splineIndex = -1;
    let snapData = window.getNearestRoadPoint(new THREE.Vector3(cx, cy, cz));
    if (snapData) {
        cx = snapData.point.x;
        cy = snapData.point.y;
        cz = snapData.point.z;
        if (!window._rallyGateManualRotation) {
            angle = Math.atan2(snapData.tangent.x, snapData.tangent.z);
        }
        roadId = snapData.roadId;
        splineIndex = snapData.splineIndex;
    } else {
        if (typeof window.localGetTerrainAt === 'function') {
            let t = window.localGetTerrainAt(cx, -cz);
            cy = t ? t.z : cy;
        }
    }
    
    // Clear any existing start and finish meshes
    if (window.raceConfig.startMesh) {
        window._arcadeScene.remove(window.raceConfig.startMesh);
        window.raceConfig.startMesh = null;
    }
    if (window.raceConfig.finishMesh) {
        window._arcadeScene.remove(window.raceConfig.finishMesh);
        window.raceConfig.finishMesh = null;
    }
    
    let gate = createRallyGate(cx, cy, cz, 'start_finish');
    gate.rotation.y = angle || 0;
    window._arcadeScene.add(gate);
    
    // Save the same details to both start and finish
    let gateConfig = { x: cx, y: cy, z: cz, rotation: angle || 0, roadId: roadId, splineIndex: splineIndex };
    window.raceConfig.start = gateConfig;
    window.raceConfig.finish = JSON.parse(JSON.stringify(gateConfig)); // unique copy
    
    window.raceConfig.startMesh = gate;
    window.raceConfig.finishMesh = null; // Rebuilt from loader as combined
    
    let hole = window.courseHoles[0];
    if (hole) {
        hole.tees.yellow = { x: cx, y: cy, z: cz };
        if (angle) hole.tees.yellow.rot = angle;
        hole.flag = { x: cx, y: cy, z: cz };
    }
    
    window.saveLevel();
    if (window.showBuildToast) window.showBuildToast('🏁 START / FINISH placed!', '#8b5cf6');
};

// ── RALLY CHECKPOINT: Single click → place checkpoint ring ──
window.placeCheckpoint = function(hitPt) {
    if (!hitPt) return;
    
    window.saveUndoState();
    
    let cx = hitPt.x, cy = hitPt.y, cz = hitPt.z;
    let roadId = null, splineIndex = -1;
    let angle = 0;
    
    let snapData = window.getNearestRoadPoint(hitPt);
    if (snapData) {
        cx = snapData.point.x;
        cy = snapData.point.y;
        cz = snapData.point.z;
        angle = Math.atan2(snapData.tangent.x, snapData.tangent.z);
        roadId = snapData.roadId;
        splineIndex = snapData.splineIndex;
    } else {
        if (typeof window.localGetTerrainAt === 'function') {
            let t = window.localGetTerrainAt(cx, -cz);
            cy = t ? t.z : cy;
        }
    }
    
    let cpIndex = window.raceConfig.checkpoints.length;
    let radius = 10;
    
    // Create checkpoint ring (torus)
    let ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * 0.5, 0.25, 8, 24),
        new THREE.MeshLambertMaterial({ color: 0xfacc15, transparent: true, opacity: 0.7 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, cy + 3, cz);
    window._arcadeScene.add(ring);
    
    // Number label
    let labelCanvas = document.createElement('canvas');
    labelCanvas.width = 64; labelCanvas.height = 64;
    let lCtx = labelCanvas.getContext('2d');
    lCtx.fillStyle = '#facc15';
    lCtx.beginPath(); lCtx.arc(32, 32, 28, 0, Math.PI * 2); lCtx.fill();
    lCtx.fillStyle = '#111';
    lCtx.font = 'bold 36px Arial';
    lCtx.textAlign = 'center';
    lCtx.fillText(String(cpIndex + 1), 32, 44);
    let labelTex = new THREE.CanvasTexture(labelCanvas);
    let labelMat = new THREE.SpriteMaterial({ map: labelTex });
    let label = new THREE.Sprite(labelMat);
    label.scale.set(3, 3, 1);
    label.position.set(cx, cy + 7, cz);
    window._arcadeScene.add(label);
    
    // Store
    window.raceConfig.checkpoints.push({ x: cx, y: cy, z: cz, radius: radius, roadId: roadId, splineIndex: splineIndex });
    window.raceConfig.checkpointMeshes.push({ ring: ring, label: label });
    
    window.saveLevel();
    if (window.showBuildToast) window.showBuildToast('📍 Checkpoint ' + (cpIndex + 1) + ' placed!', '#facc15');
};

// ── Remove last checkpoint ──
window.removeLastCheckpoint = function() {
    if (window.raceConfig.checkpoints.length === 0) return;
    
    window.saveUndoState();
    
    let last = window.raceConfig.checkpointMeshes.pop();
    if (last) {
        if (last.ring) { window._arcadeScene.remove(last.ring); last.ring.geometry.dispose(); last.ring.material.dispose(); }
        if (last.label) { window._arcadeScene.remove(last.label); last.label.material.map.dispose(); last.label.material.dispose(); }
    }
    window.raceConfig.checkpoints.pop();
    
    window.saveLevel();
    if (window.showBuildToast) window.showBuildToast('📍 Checkpoint removed', '#94a3b8');
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

    // === PASS 1: EXTENDED PLATEAU FLATTENING ===
    // We flatten the green + foregreen, and taper down to original terrain over a transition zone
    let taperDist = 5.0;
    if (window._raisedGreenActive && surroundHeight > 0) {
        taperDist = surroundRadius;
    }
    
    // Save original heights of the bounding box before modifying
    let origHeights = new Float32Array((gxEnd - gxStart + 1) * (gzEnd - gzStart + 1));
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let oi = (gz - gzStart) * (gxEnd - gxStart + 1) + (gx - gxStart);
            origHeights[oi] = positions[idx*3+2];
        }
    }

    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            let isInside = pointInPolygon(vx, vz, densePts);
            let distEdge = distToPolygon(vx, vz, densePts);
            let signedDist = isInside ? -distEdge : distEdge;

            // Skip vertices too far outside
            if (signedDist > foregreenWidth + taperDist) continue;

            // Define target height on the plateau (including tilt if active)
            let tiltVal = 0;
            if (tiltEnabled) {
                let proj = (vx - polyCentX) * tiltDirX + (vz - polyCentZ) * tiltDirZ;
                tiltVal = (proj / tiltMaxDist) * tiltMaxDist * tiltPct;
            }
            let targetH = baseH + surroundHeight + tiltVal;

            let oi = (gz - gzStart) * (gxEnd - gxStart + 1) + (gx - gxStart);
            let originalH = origHeights[oi];

            // Calculate flattening influence based on distance
            let influence = 0;
            if (signedDist <= foregreenWidth) {
                // Inside green and foregreen: 100% flattened to plateau
                influence = 1.0;
            } else if (signedDist <= foregreenWidth + taperDist) {
                // Taper zone outside foregreen: smooth fade to original terrain
                let t = (signedDist - foregreenWidth) / taperDist;
                influence = 1.0 - t;
                influence = influence * influence * (3.0 - 2.0 * influence); // cubic smoothstep
            }

            if (influence > 0) {
                positions[idx*3+2] = originalH + (targetH - originalH) * influence;
            }
        }
    }

    // === PASS 2: AUTO-SMOOTH PLATEAU EDGES ===
    // Run unbiased Laplacian smoothing on the transition zone (creases at plateau edge and taper end)
    let _smoothStride = window.TERRAIN_SEGS + 1;
    let smGxStart = Math.max(0, gxStart - 2);
    let smGxEnd = Math.min(window.TERRAIN_SEGS, gxEnd + 2);
    let smGzStart = Math.max(0, gzStart - 2);
    let smGzEnd = Math.min(window.TERRAIN_SEGS, gzEnd + 2);

    for(let smPass = 0; smPass < 5; smPass++) {
        // Copy current heights to a temp buffer for unbiased smoothing
        let tempHeights = new Float32Array(positions.length / 3);
        for (let i = 0; i < tempHeights.length; i++) {
            tempHeights[i] = positions[i*3 + 2];
        }

        for(let gz = smGzStart; gz <= smGzEnd; gz++) {
            for(let gx = smGxStart; gx <= smGxEnd; gx++) {
                let idx = gz * _smoothStride + gx;
                let vx = positions[idx*3];
                let vz = -positions[idx*3+1];

                let isInside = pointInPolygon(vx, vz, densePts);
                let distEdge = distToPolygon(vx, vz, densePts);
                let signedDist = isInside ? -distEdge : distEdge;

                // Smooth from 2.0m inside green to 2.0m outside the taper zone
                if (signedDist > -2.0 && signedDist < foregreenWidth + taperDist + 2.0) {
                    let nCount = 0;
                    let nSum = 0;
                    if (gz > 0) { nSum += tempHeights[(gz-1)*_smoothStride + gx]; nCount++; }
                    if (gz < window.TERRAIN_SEGS) { nSum += tempHeights[(gz+1)*_smoothStride + gx]; nCount++; }
                    if (gx > 0) { nSum += tempHeights[gz*_smoothStride + gx-1]; nCount++; }
                    if (gx < window.TERRAIN_SEGS) { nSum += tempHeights[gz*_smoothStride + gx+1]; nCount++; }
                    
                    if (nCount > 0) {
                        let localAvg = nSum / nCount;
                        let smoothStrength = 0.5;
                        positions[idx*3 + 2] += (localAvg - tempHeights[idx]) * smoothStrength;
                    }
                }
            }
        }
    }

    // === PASS 3: APPLY GREEN CONTOURS & UNDULATIONS ===
    // Add difficulty-based hills inside the green polygon, blending to 0 at green boundary
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * (window.TERRAIN_SEGS+1) + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            let isInside = pointInPolygon(vx, vz, densePts);
            if (!isInside) continue;

            let undulation = 0;
            let seedX = vx + window._sgSeedOffsetX;
            let seedZ = vz + window._sgSeedOffsetZ;

            if(difficulty === 'EASY') {
                undulation += Math.sin(seedX * 0.1) * Math.cos(seedZ * 0.1) * 0.10;
            } else if(difficulty === 'MED') {
                undulation += Math.sin(seedX * 0.12) * Math.cos(seedZ * 0.12) * 0.18;
                undulation += Math.sin(seedX * 0.07 + seedZ * 0.05) * 0.08;
            } else if(difficulty === 'HARD') {
                undulation += Math.sin(seedX * 0.15) * Math.cos(seedZ * 0.12) * 0.22
                            + Math.sin(seedZ * 0.25 + seedX * 0.08) * 0.06
                            + Math.cos(seedX * 0.20) * Math.sin(seedZ * 0.18) * 0.05;
            }

            // Blend undulation near green boundary to make it fade out at foregreen edge
            let distEdge = distToPolygon(vx, vz, densePts);
            let blendWidth = 2.5; 
            if (distEdge < blendWidth) {
                let t = distEdge / blendWidth;
                let smoothT = t * t * (3 - 2 * t);
                positions[idx*3+2] += undulation * smoothT;
            } else {
                positions[idx*3+2] += undulation;
            }
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


    // Auto-place Flag at centroid (or fallback inside if centroid is outside/near boundary)
    let cx = 0, cz = 0;
    for(let pt of smartGreenPoints) { cx += pt.x; cz += pt.z; }
    cx /= smartGreenPoints.length;
    cz /= smartGreenPoints.length;

    // Helper functions for Point-in-Polygon (PIP) and Distance-to-Boundary using densePts (smooth curve)
    function isPointInGreenPoly(x, z, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            let xi = poly[i].x, zi = poly[i].z;
            let xj = poly[j].x, zj = poly[j].z;
            if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    function distToGreenBoundary(px, pz, poly) {
        let minDist = Infinity;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            let ax = poly[j].x, az = poly[j].z;
            let bx = poly[i].x, bz = poly[i].z;
            let dx = bx - ax, dz = bz - az;
            let len2 = dx * dx + dz * dz;
            let t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
            let projx = ax + t * dx;
            let projz = az + t * dz;
            let dist = Math.hypot(px - projx, pz - projz);
            if (dist < minDist) minDist = dist;
        }
        return minDist;
    }

    let flagX = cx;
    let flagZ = cz;

    // Verify if centroid is inside and sufficiently far from green boundary (at least 2.5 meters)
    if (!isPointInGreenPoly(cx, cz, densePts) || distToGreenBoundary(cx, cz, densePts) < 2.5) {
        let candidates = [];

        // Candidate 1: Centroid (if inside, even if close to boundary)
        if (isPointInGreenPoly(cx, cz, densePts)) {
            candidates.push({ x: cx, z: cz });
        }

        // Candidates 2: 15x15 uniform grid inside bounding box of green
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let pt of densePts) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.z < minZ) minZ = pt.z;
            if (pt.z > maxZ) maxZ = pt.z;
        }

        let steps = 15;
        for (let ix = 0; ix <= steps; ix++) {
            let px = minX + (maxX - minX) * (ix / steps);
            for (let iz = 0; iz <= steps; iz++) {
                let pz = minZ + (maxZ - minZ) * (iz / steps);
                if (isPointInGreenPoly(px, pz, densePts)) {
                    candidates.push({ x: px, z: pz });
                }
            }
        }

        // Candidates 3: Midpoints between centroid and each user-clicked point
        for (let pt of smartGreenPoints) {
            let mx = (cx + pt.x) / 2;
            let mz = (cz + pt.z) / 2;
            if (isPointInGreenPoly(mx, mz, densePts)) {
                candidates.push({ x: mx, z: mz });
            }
        }

        // Select the candidate furthest from any boundary (pole of inaccessibility)
        let bestCandidate = null;
        let maxDist = -1;
        for (let cand of candidates) {
            let d = distToGreenBoundary(cand.x, cand.z, densePts);
            if (d > maxDist) {
                maxDist = d;
                bestCandidate = cand;
            }
        }

        if (bestCandidate) {
            flagX = bestCandidate.x;
            flagZ = bestCandidate.z;
            console.log("⛳ Auto-shifted flag to optimal green position:", flagX, flagZ, "dist to boundary:", maxDist);
        } else {
            // Fallback: pick the first vertex shifted slightly towards the centroid
            if (smartGreenPoints.length > 0) {
                let first = smartGreenPoints[0];
                let dx = cx - first.x, dz = cz - first.z;
                let len = Math.hypot(dx, dz) + 0.001;
                flagX = first.x + (dx / len) * 3;
                flagZ = first.z + (dz / len) * 3;
            }
        }
    }

    let surf = window.localGetTerrainAt(flagX, -flagZ);
    let cy = surf ? surf.z : baseH;

    hole = window.courseHoles[window.currentHoleIndex];
    if (hole.flagMesh) window._arcadeScene.remove(hole.flagMesh);
    hole.flag = { x: flagX, y: cy, z: flagZ };
    hole.flagMesh = window.createFlagObject(flagX, cy, flagZ);
    
    if(!hole.pins) hole.pins = {};
    hole.pins.easy = { x: flagX, y: cy, z: flagZ };
    hole.pins.medium = { x: flagX, y: cy, z: flagZ };
    hole.pins.hard = { x: flagX, y: cy, z: flagZ };

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
        
        // Rally mode: show race status instead of hole info
        if (window.EDITOR_MODE === 'rally') {
            // Hide hole navigator, show race status
            let holeNav = document.getElementById('sb-hole-nav');
            if (holeNav) holeNav.style.display = 'none';
            let raceStatus = document.getElementById('sb-race-status');
            if (raceStatus) raceStatus.style.display = 'block';
            let cpCtrl = document.getElementById('sb-cp-controls');
            if (cpCtrl) cpCtrl.style.display = 'block';
            let rRules = document.getElementById('sb-rally-rules');
            if (rRules) rRules.style.display = 'block';
            
            // Hide FAIRWAY (Track) button since ROAD is the primary tool for Rally
            let fairwayBtn = document.getElementById('sb-type-fairway');
            if (fairwayBtn) fairwayBtn.style.display = 'none';
            
            
            let rc = window.raceConfig;
            let startOk = rc && rc.start ? '✓' : '✗';
            let finishOk = rc && rc.finish ? '✓' : '✗';
            let cpCount = rc ? rc.checkpoints.length : 0;
            let statusText = document.getElementById('sb-race-status-text');
            if (statusText) {
                statusText.innerHTML = startOk + ' Start &nbsp; ' + finishOk + ' Finish &nbsp; ' + cpCount + ' CP';
                statusText.style.color = (rc && rc.start && rc.finish) ? '#4ade80' : '#fbbf24';
            }
            
            // Sync rule dropdown
            let ruleEl = document.getElementById('sb-cp-rule');
            if (ruleEl && rc) ruleEl.value = rc.missedCheckpointRule || 'PENALTY_5S';
            return;
        }
        
        // Golf mode: original hole display
        let fairwayBtn = document.getElementById('sb-type-fairway');
        if (fairwayBtn) fairwayBtn.style.display = '';
        
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
            // Rally mode: TEE → START gate (handled by click event now)
            if (window.EDITOR_MODE !== 'rally') {
                executeSmartTee();
            }
        } else if(window._smartBuilderType === 'ROAD') {
            window.executeSmartRoad();
        } else {
            // GREEN → FINISH in rally mode (handled by click event now)
            if (window.EDITOR_MODE !== 'rally') {
                executeSplineSmartGreen();
            }
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

    // === PROPS POLYGON FILL: Fill a defined polygon with props ===
    window.executePropsPolygon = function() {
        if(typeof smartGreenPoints === 'undefined' || smartGreenPoints.length < 3) return;
        if(!window.currentNatureType) {
            if (window.showBuildToast) window.showBuildToast('⚠️ Select an asset first!', '#f59e0b');
            return;
        }
        
        window.saveUndoState();

        // Build closed curve from points
        let curve = new THREE.CatmullRomCurve3(smartGreenPoints, true);
        let numSamples = Math.max(200, smartGreenPoints.length * 40);
        let densePts = curve.getPoints(numSamples);

        // Find bounding box
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        densePts.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z;
            if (p.z > maxZ) maxZ = p.z;
        });

        // Determine spacing: manual override > model-based auto > category defaults
        let spacing = 3.5;
        if (window._polySpacingOverride) {
            spacing = window._polySpacingOverride;
        } else {
            // Auto-calculate from model bounding box
            let model = window.customModels && window.customModels[window.currentNatureType];
            if (model && model.isObject3D) {
                let box = new THREE.Box3().setFromObject(model);
                let size = box.getSize(new THREE.Vector3());
                let maxWidth = Math.max(size.x, size.z);
                // Params scale affects final size
                let params = window.getPlacementParams(window.currentNatureType);
                let s = params ? params.scale : 1.0;
                spacing = Math.max(maxWidth * s * 1.2, 1.5);  // 1.2x width for slight gaps
            } else {
                // Fallback: category-based
                let isDense = false;
                if (document.getElementById('cat-btn-ROCKS') && document.getElementById('cat-btn-ROCKS').classList.contains('active')) isDense = true;
                if (document.getElementById('cat-btn-PLANTS') && document.getElementById('cat-btn-PLANTS').classList.contains('active')) isDense = true;
                if (isDense) spacing = 1.5;
            }
        }

        // Point in polygon test
        function pointInPoly(px, pz, polyPts) {
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

        let estimatedCount = 0;
        let validPoints = [];
        for (let z = minZ; z <= maxZ; z += spacing) {
            for (let x = minX; x <= maxX; x += spacing) {
                let randX = x + (Math.random() - 0.5) * spacing * 0.8;
                let randZ = z + (Math.random() - 0.5) * spacing * 0.8;

                if (pointInPoly(randX, randZ, densePts)) {
                    // Check biomes if respect biomes is checked
                    let canPlace = true;
                    if (window.forestRespectBiomes && window.terrainBiomeData) {
                        let pxX = Math.floor(((randX + window.TERRAIN_SIZE/2) / window.TERRAIN_SIZE) * 4096);
                        let pxZ = Math.floor(((randZ + window.TERRAIN_SIZE/2) / window.TERRAIN_SIZE) * 4096);
                        pxX = Math.max(0, Math.min(4095, pxX));
                        pxZ = Math.max(0, Math.min(4095, pxZ));
                        let idx4 = (pxZ * 4096 + pxX) * 4;
                        let r = window.terrainBiomeData[idx4];
                        let g = window.terrainBiomeData[idx4+1];
                        if(g > 150 && r < 180) canPlace = false; // Green/Fairway/Tee biomes
                        if(r > 190 && g > 180) canPlace = false; // Bunker/Sand biomes
                    }
                    
                    // Check water
                    if (canPlace) {
                        let surf = window.localGetTerrainAt(randX, -randZ);
                        if (surf) {
                            let waterH = window.getWaterHeightAt ? window.getWaterHeightAt(randX, -randZ) : -99;
                            if (waterH > surf.z) canPlace = false;
                        }
                    }

                    if (canPlace) {
                        validPoints.push({x: randX, z: randZ});
                        estimatedCount++;
                    }
                }
            }
        }

        if (estimatedCount > 300) {
            let proceed = window.confirm(`⚠️ WARNING: You are about to place ${estimatedCount} props at once!\n\nThis may cause severe lag or freeze the browser depending on the 3D model complexity.\n\nDo you want to proceed?`);
            if (!proceed) {
                if (window.showBuildToast) window.showBuildToast('❌ Polygon fill cancelled.', '#ef4444');
                return; // Cancel placement
            }
        }

        let placedCount = 0;
        let placedTypes = new Set();
        for (let i = 0; i < validPoints.length; i++) {
            let p = validPoints[i];
            let randX = p.x;
            let randZ = p.z;
            let params = window.getPlacementParams(window.currentNatureType);
            if (params && params.type) {
                if (typeof window.createTree === 'function') {
                    window.createTree(params.type, randX, randZ, params.scale, params.rot, '#ffffff', '#ffffff', params.yOffset, params.brightness, true);
                    placedTypes.add(params.type);
                    placedCount++;
                }
            } else if (placedCount === 0 && !window._warnedPolyProps) {
                // No valid placement params — warn once
                if (window.showBuildToast) window.showBuildToast('⚠️ Asset not loaded yet — try again!', '#f59e0b');
                window._warnedPolyProps = true;
                setTimeout(() => window._warnedPolyProps = false, 3000);
            }
        }

        // Rebuild visual pools once after all props are placed
        placedTypes.forEach(type => {
            if (typeof window.rebuildInstancePool === 'function') {
                window.rebuildInstancePool(type);
            }
        });

        if (window.showBuildToast) window.showBuildToast('🌳 Filled ' + placedCount + ' props (spacing: ' + spacing.toFixed(1) + 'm)', '#4ade80');
        
        // Clear polygon
        if (typeof clearSmartGreen === 'function') clearSmartGreen();
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
                    if (Math.abs(h) > 0.05) hasData = true;
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

// === SMART ROAD: Foundation — Terrain-hugging spline with max-grade constraint ===
window.executeSmartRoad = function() {
    if(smartGreenPoints.length < 2) {
        window.showBuildToast('🛣️ Place at least 2 points for a road', '#ef4444');
        return;
    }
    window.saveUndoState();

    let roadWidth = window._smartRoadWidth || 10;
    let halfW = roadWidth / 2;
    let shoulderW = window._smartRoadShoulder || 4;

    let surface = window._smartRoadSurface || 'NONE';
    let doFoundation = window._smartRoadFoundation !== false;
    let edgeL = window._smartRoadEdgeL || 'NONE';
    let edgeR = window._smartRoadEdgeR || 'NONE';
    let edgeW = 4.0; // Width of the physical edge (ditch/berm)
    
    if (surface === 'GAP') {
        doFoundation = false;
        edgeL = 'NONE';
        edgeR = 'NONE';
    }
    // Build spline (closed loop if shape was closed)
    let curve = new THREE.CatmullRomCurve3(smartGreenPoints, !!window._smartShapeClosed, 'centripetal');
    let numSamples = Math.min(600, Math.max(200, smartGreenPoints.length * 50));
    let splinePts = curve.getPoints(numSamples);

    let positions = window._arcadePlaneGeo.attributes.position.array;
    let step = window.TERRAIN_SIZE / window.TERRAIN_SEGS;
    let stride = window.TERRAIN_SEGS + 1;

    // ── SPATIAL GRID for O(1) nearest-road-point lookup ──
    // Instead of O(n) linear search per vertex, bucket roadData into a grid
    let _gridCellSize = 5.0; // 5m cells
    let _gridCols = Math.ceil(window.TERRAIN_SIZE / _gridCellSize) + 2;
    let _gridRows = _gridCols;
    let _gridArray = new Array(_gridCols * _gridRows);

    // === STEP 1: Sample ACTUAL terrain height at every spline point ===
    let rawTerrainH = new Float32Array(splinePts.length);
    let arcLens = new Float32Array(splinePts.length); // cumulative arc length
    arcLens[0] = 0;

    for(let i = 0; i < splinePts.length; i++) {
        let pt = splinePts[i];
        // Bilinear terrain height sample
        let fx = (pt.x + window.TERRAIN_SIZE/2) / step;
        let fz = (pt.z + window.TERRAIN_SIZE/2) / step;
        let gxi = Math.floor(fx), gzi = Math.floor(fz);
        gxi = Math.max(0, Math.min(window.TERRAIN_SEGS-1, gxi));
        gzi = Math.max(0, Math.min(window.TERRAIN_SEGS-1, gzi));
        let tx = fx - gxi, tz = fz - gzi;
        let h00 = positions[(gzi * stride + gxi) * 3 + 2];
        let h10 = positions[(gzi * stride + gxi+1) * 3 + 2];
        let h01 = positions[((gzi+1) * stride + gxi) * 3 + 2];
        let h11 = positions[((gzi+1) * stride + gxi+1) * 3 + 2];
        rawTerrainH[i] = h00*(1-tx)*(1-tz) + h10*tx*(1-tz) + h01*(1-tx)*tz + h11*tx*tz;

        if(i > 0) {
            let dx = splinePts[i].x - splinePts[i-1].x;
            let dz = splinePts[i].z - splinePts[i-1].z;
            arcLens[i] = arcLens[i-1] + Math.sqrt(dx*dx + dz*dz);
        }
    }
    let totalArc = arcLens[splinePts.length - 1];

    // === STEP 2-3: Minimal Displacement — grade first, selective smooth ===
    // Philosophy: follow natural terrain maximally, only intervene where needed.
    let roadH;
    if(doFoundation) {
        // Variable grade: downhill allows steeper (gravity helps), uphill stricter
        let gradeDown = typeof window._smartRoadGradeDown === 'number' ? window._smartRoadGradeDown : 0.70;   // 70% max downhill (~35°) — aggressive rally terrain
        let gradeUp   = typeof window._smartRoadGradeUp === 'number' ? window._smartRoadGradeUp : 0.55;   // 55% max uphill (~29°) — engine+traction limit
        
        roadH = new Float32Array(rawTerrainH); // Start from RAW terrain (no pre-smoothing!)
        
        // Track which points were displaced (for selective smoothing later)
        let displaced = new Uint8Array(roadH.length); // 0 = natural, 1 = displaced
        
        // 2 rounds of constraint → smooth for stable convergence
        for (let round = 0; round < 2; round++) {
            if (window._smartShapeClosed) {
                let avg = (roadH[0] + roadH[roadH.length - 1]) / 2;
                roadH[0] = avg;
                roadH[roadH.length - 1] = avg;
            }

            // Forward pass: enforce max grade start → end
            for(let i = 1; i < roadH.length; i++) {
                let dist = arcLens[i] - arcLens[i-1];
                if(dist < 0.01) continue;
                let diff = roadH[i] - roadH[i-1];
                let isUphill = diff > 0;
                let limit = isUphill ? gradeUp : gradeDown;
                let maxRise = dist * limit;
                if(diff > maxRise) { roadH[i] = roadH[i-1] + maxRise; displaced[i] = 1; }
                else if(diff < -maxRise) { roadH[i] = roadH[i-1] - maxRise; displaced[i] = 1; }
            }

            if (window._smartShapeClosed) {
                let avg = (roadH[0] + roadH[roadH.length - 1]) / 2;
                roadH[0] = avg;
                roadH[roadH.length - 1] = avg;
            }

            // Backward pass: enforce max grade end → start
            for(let i = roadH.length - 2; i >= 0; i--) {
                let dist = arcLens[i+1] - arcLens[i];
                if(dist < 0.01) continue;
                let diff = roadH[i] - roadH[i+1];
                let isUphill = diff > 0;
                let limit = isUphill ? gradeUp : gradeDown;
                let maxRise = dist * limit;
                if(diff > maxRise) { roadH[i] = roadH[i+1] + maxRise; displaced[i] = 1; }
                else if(diff < -maxRise) { roadH[i] = roadH[i+1] - maxRise; displaced[i] = 1; }
            }
            
            // Selective smooth: only smooth displaced points + their neighbors
            // This prevents abrupt transitions at constraint boundaries
            if (round < 1) { // Only on first round
                let tmp = new Float32Array(roadH);
                for(let i = 1; i < roadH.length - 1; i++) {
                    // Smooth if this point OR any neighbor was displaced
                    if (displaced[i] || displaced[Math.max(0,i-1)] || displaced[Math.min(roadH.length-1,i+1)]) {
                        tmp[i] = roadH[i-1] * 0.25 + roadH[i] * 0.5 + roadH[i+1] * 0.25;
                    }
                }
                roadH = tmp;
            }
        }
        
        if (!window._smartShapeClosed) {
            // Blend pinning to raw terrain over the first and last N nodes to avoid sudden cliffs
            let blendCount = Math.min(15, Math.floor(roadH.length / 10));
            for (let i = 0; i < blendCount; i++) {
                let t = i / blendCount; // 0 at endpoint, 1 at blend boundary
                // First points blend between rawTerrainH and solved roadH
                roadH[i] = rawTerrainH[i] * (1 - t) + roadH[i] * t;
                
                // Last points blend between rawTerrainH and solved roadH
                let idx = roadH.length - 1 - i;
                roadH[idx] = rawTerrainH[idx] * (1 - t) + roadH[idx] * t;
            }
        } else {
            // Keep loop endpoints exactly matched
            let avg = (roadH[0] + roadH[roadH.length - 1]) / 2;
            roadH[0] = avg;
            roadH[roadH.length - 1] = avg;
        }
    } else {
        roadH = rawTerrainH;
    }
    // === STEP 4: Build road centerline data ===
    let maxBankingPercent = window._smartRoadBanking || 0;
    let bankMultiplier = (maxBankingPercent / 100) * 20.0; // Max multiplier
    
    // Calculate raw turn rates (curvature)
    let rawTurnRates = new Float32Array(splinePts.length);
    for(let i = 1; i < splinePts.length - 1; i++) {
        let prevX = splinePts[i].x - splinePts[i-1].x;
        let prevZ = splinePts[i].z - splinePts[i-1].z;
        let nextX = splinePts[i+1].x - splinePts[i].x;
        let nextZ = splinePts[i+1].z - splinePts[i].z;
        let lenP = Math.sqrt(prevX*prevX + prevZ*prevZ);
        let lenN = Math.sqrt(nextX*nextX + nextZ*nextZ);
        if(lenP > 0.001 && lenN > 0.001) {
            let px = prevX/lenP, pz = prevZ/lenP;
            let nx = nextX/lenN, nz = nextZ/lenN;
            let sinTheta = pz * nx - px * nz; // Flipped sign: positive = left turn, negative = right turn
            let angle = Math.asin(Math.max(-1, Math.min(1, sinTheta)));
            rawTurnRates[i] = angle / ((lenP + lenN) * 0.5); // rad per meter
        }
    }
    
    // Smooth turn rates (running average over 20 points) to anticipate curves
    let smoothTurnRates = new Float32Array(splinePts.length);
    let bankWindow = 20;
    for(let i = 0; i < splinePts.length; i++) {
        let sum = 0, count = 0;
        let lo = Math.max(0, i - bankWindow);
        let hi = Math.min(splinePts.length - 1, i + bankWindow);
        for(let j = lo; j <= hi; j++) {
            sum += rawTurnRates[j];
            count++;
        }
        smoothTurnRates[i] = sum / count;
    }

    let roadData = [];
    for(let i = 0; i < splinePts.length; i++) {
        let pt = splinePts[i];
        let nx, nz;

        // Tangent (forward direction)
        let prev = splinePts[Math.max(0, i-1)];
        let next = splinePts[Math.min(splinePts.length-1, i+1)];
        let tx = next.x - prev.x;
        let tz = next.z - prev.z;
        let tLen = Math.sqrt(tx*tx + tz*tz);
        
        if (tLen < 0.001) {
            if (i > 0) {
                tx = roadData[i-1].tx;
                tz = roadData[i-1].tz;
                nx = roadData[i-1].nx;
                nz = roadData[i-1].nz;
            } else {
                tx = 1;
                tz = 0;
                nx = 0;
                nz = 1;
            }
        } else {
            tx /= tLen;
            tz /= tLen;
            nx = -tz;
            nz = tx;
        }

        // Auto-banking based on curvature. Max cap at ~45 degrees (0.785 rad)
        let currentBankRad = smoothTurnRates[i] * bankMultiplier;
        currentBankRad = Math.max(-0.785, Math.min(0.785, currentBankRad));

        roadData.push({ x: pt.x, z: pt.z, roadH: roadH[i], nx, nz, idx: i, tx: tx, tz: tz, bankRad: currentBankRad });
    }

    // ── Populate spatial grid for fast nearest-road lookups ──
    for (let r = 0; r < roadData.length; r++) {
        let rd = roadData[r];
        let cx = Math.floor((rd.x + window.TERRAIN_SIZE/2) / _gridCellSize);
        let cz = Math.floor((rd.z + window.TERRAIN_SIZE/2) / _gridCellSize);
        if (cx >= 0 && cx < _gridCols && cz >= 0 && cz < _gridRows) {
            let idx = cz * _gridCols + cx;
            if (!_gridArray[idx]) _gridArray[idx] = [];
            _gridArray[idx].push(r);
        }
    }

    // Fast nearest-road lookup using spatial grid
    let _searchRadius = halfW + shoulderW + edgeW + 4;
    let _cellsToCheck = Math.ceil(_searchRadius / _gridCellSize) + 1;
    function findNearestRoad(vx, vz) {
        let cellX = Math.floor((vx + window.TERRAIN_SIZE/2) / _gridCellSize);
        let cellZ = Math.floor((vz + window.TERRAIN_SIZE/2) / _gridCellSize);
        let bestDistSq = Infinity, bestIdx = -1;
        for (let dcy = -_cellsToCheck; dcy <= _cellsToCheck; dcy++) {
            for (let dcx = -_cellsToCheck; dcx <= _cellsToCheck; dcx++) {
                let cx = cellX + dcx;
                let cz = cellZ + dcy;
                if (cx >= 0 && cx < _gridCols && cz >= 0 && cz < _gridRows) {
                    let bucket = _gridArray[cz * _gridCols + cx];
                    if (bucket) {
                        for (let bi = 0; bi < bucket.length; bi++) {
                            let rd = roadData[bucket[bi]];
                            let dx = vx - rd.x, dz = vz - rd.z;
                            let d2 = dx * dx + dz * dz;
                            if (d2 < bestDistSq) { bestDistSq = d2; bestIdx = bucket[bi]; }
                        }
                    }
                }
            }
        }
        return bestIdx;
    }

    // === STEP 5: Bounding box for terrain vertex iteration ===
    let pathMinX = Infinity, pathMaxX = -Infinity;
    let pathMinZ = Infinity, pathMaxZ = -Infinity;
    for(let rd of roadData) {
        let expand = halfW + shoulderW + edgeW + 4;
        if(rd.x - expand < pathMinX) pathMinX = rd.x - expand;
        if(rd.x + expand > pathMaxX) pathMaxX = rd.x + expand;
        if(rd.z - expand < pathMinZ) pathMinZ = rd.z - expand;
        if(rd.z + expand > pathMaxZ) pathMaxZ = rd.z + expand;
    }

    let gxStart = Math.max(0, Math.floor((pathMinX + window.TERRAIN_SIZE/2) / step));
    let gxEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxX + window.TERRAIN_SIZE/2) / step));
    let gzStart = Math.max(0, Math.floor((pathMinZ + window.TERRAIN_SIZE/2) / step));
    let gzEnd = Math.min(window.TERRAIN_SEGS, Math.ceil((pathMaxZ + window.TERRAIN_SIZE/2) / step));

    // Cache to prevent redundant findNearestRoad lookups (reused in step 6, 7 and 9)
    let nearestCacheW = gxEnd - gxStart + 1;
    let nearestCacheH = gzEnd - gzStart + 1;
    let nearestCache = new Int32Array(nearestCacheW * nearestCacheH);
    nearestCache.fill(-2); // -2 = uncomputed

    function getNearestRoadCached(gx, gz, vx, vz) {
        let cx = gx - gxStart;
        let cz = gz - gzStart;
        if (cx < 0 || cx >= nearestCacheW || cz < 0 || cz >= nearestCacheH) {
            return findNearestRoad(vx, vz);
        }
        let cacheIdx = cz * nearestCacheW + cx;
        let val = nearestCache[cacheIdx];
        if (val !== -2) return val;
        let res = findNearestRoad(vx, vz);
        nearestCache[cacheIdx] = res;
        return res;
    }

    let maxCut = 0, maxFill = 0;
    if(doFoundation) {
    // === STEP 6: Sculpt terrain ===
    let modified = 0;
    for(let gz = gzStart; gz <= gzEnd; gz++) {
        for(let gx = gxStart; gx <= gxEnd; gx++) {
            let idx = gz * stride + gx;
            let vx = positions[idx*3];
            let vz = -positions[idx*3+1];

            // Find closest road center point (spatial grid — O(1) amortized, cached)
            let bestRIdx = getNearestRoadCached(gx, gz, vx, vz);
            
            // Refine using true line-segment distance for perfectly smooth edges
            let bestDistSq = Infinity;
            let bestRD = null;
            if(bestRIdx >= 0) {
                let lo = Math.max(0, bestRIdx - 4);
                let hi = Math.min(roadData.length-2, bestRIdx + 3);
                for(let r = lo; r <= hi; r++) {
                    let r1 = roadData[r];
                    let r2 = roadData[r+1];
                    let l2 = (r2.x - r1.x)*(r2.x - r1.x) + (r2.z - r1.z)*(r2.z - r1.z);
                    let t = 0;
                    if(l2 > 0) {
                        t = ((vx - r1.x)*(r2.x - r1.x) + (vz - r1.z)*(r2.z - r1.z)) / l2;
                        t = Math.max(0, Math.min(1, t));
                    }
                    let prx = r1.x + t * (r2.x - r1.x);
                    let prz = r1.z + t * (r2.z - r1.z);
                    let dSq = (vx - prx)*(vx - prx) + (vz - prz)*(vz - prz);
                    
                    if(dSq < bestDistSq) {
                        bestDistSq = dSq;
                        bestRD = {
                            x: prx, z: prz,
                            nx: r1.nx + t*(r2.nx - r1.nx),
                            nz: r1.nz + t*(r2.nz - r1.nz),
                            roadH: r1.roadH + t*(r2.roadH - r1.roadH),
                            bankRad: r1.bankRad + t*(r2.bankRad - r1.bankRad)
                        };
                    }
                }
            }
            if(!bestRD) continue;

            let perpDist = Math.sqrt(bestDistSq);
            if(perpDist > halfW + shoulderW) continue;

            let currentH = positions[idx*3+2];
            
            // Apply banking offset (pivot around INNER edge so it never digs down)
            let dx = vx - bestRD.x;
            let dz = vz - bestRD.z;
            let signedDist = dx * bestRD.nx + dz * bestRD.nz; // Negative on left, positive on right
            
            let tanBank = Math.tan(bestRD.bankRad);
            let lowestOffset = Math.abs(tanBank * halfW); // Shift road up so inner edge stays at ground level
            let bankOffset = (tanBank * signedDist) + lowestOffset;
            
            let targetH = bestRD.roadH + bankOffset;

            // Track cut/fill stats
            let delta = targetH - currentH;
            if(delta < 0 && -delta > maxCut) maxCut = -delta;
            if(delta > 0 && delta > maxFill) maxFill = delta;

            if(perpDist <= halfW) {
                // === INSIDE ROAD: set to road height ===
                let crossSlope = (vx - bestRD.x) * bestRD.nx + (vz - bestRD.z) * bestRD.nz;
                let crossH = crossSlope * 0.015; // 1.5% cross-slope
                positions[idx*3+2] = targetH + crossH;
                modified++;
            } else {
                // === SHOULDER: smoothstep blend to original terrain ===
                let t = (perpDist - halfW) / shoulderW;
                t = t * t * (3 - 2 * t);
                
                let noiseVal = 0;
                if(window._smartRoadShoulderNoise) {
                    // Skapa oregelbunden "stenig" noise med världskoordinaterna
                    let nx = vx * 0.4;
                    let nz = vz * 0.4;
                    let rawNoise = Math.sin(nx)*Math.cos(nz) 
                                 + 0.5 * Math.sin(nx*2.3 + 2.0)*Math.cos(nz*2.5 + 1.0)
                                 + 0.25 * Math.sin(nx*5.1 - 1.0)*Math.cos(nz*5.3 - 2.0);
                                 
                    // Tona in noisen så den är noll precis vid vägkanten (t=0) och noll vid marken (t=1)
                    let noiseMask = Math.sin(t * Math.PI); 
                    noiseVal = rawNoise * noiseMask * 1.5; 
                }
                
                positions[idx*3+2] = targetH + (currentH - targetH) * t + noiseVal;
                modified++;
            }
        }
    }

    // === STEP 7: Smooth pass (shoulder zone only - protect road surface) ===
    for(let smPass = 0; smPass < 4; smPass++) {
        for(let gz = Math.max(1, gzStart); gz <= Math.min(window.TERRAIN_SEGS-1, gzEnd); gz++) {
            for(let gx = Math.max(1, gxStart); gx <= Math.min(window.TERRAIN_SEGS-1, gxEnd); gx++) {
                let idx = gz * stride + gx;
                let vx = positions[idx*3];
                let vz = -positions[idx*3+1];

                let _ni7 = getNearestRoadCached(gx, gz, vx, vz);
                if (_ni7 < 0) continue;
                let dx7 = vx - roadData[_ni7].x, dz7 = vz - roadData[_ni7].z;
                let distSq7 = dx7*dx7 + dz7*dz7;
                
                // Skip if outside influence zone
                if (distSq7 >= (halfW + shoulderW + 2) * (halfW + shoulderW + 2)) continue;
                
                // PROTECT road surface: do not smooth inside the road!
                if (distSq7 <= halfW * halfW) continue;

                let nSum = 0, nCount = 0;
                nSum += positions[((gz-1)*stride + gx)*3+2]; nCount++;
                nSum += positions[((gz+1)*stride + gx)*3+2]; nCount++;
                nSum += positions[(gz*stride + gx-1)*3+2]; nCount++;
                nSum += positions[(gz*stride + gx+1)*3+2]; nCount++;
                let avg = nSum / nCount;
                positions[idx*3+2] += (avg - positions[idx*3+2]) * 0.4;
            }
        }
    }

    // Update geometry
    window._arcadePlaneGeo.attributes.position.needsUpdate = true;
    window._arcadePlaneGeo.computeVertexNormals();
    window._arcadePlaneGeo.computeBoundingBox();
    window._arcadePlaneGeo.computeBoundingSphere();
    // Deferred snap - do not block the build thread
    setTimeout(function() { if (window.snapObjectsToGround) window.snapObjectsToGround(); }, 50);

    if(window.slopeOverlayActive) window.updateSlopeOverlay();
    if(window.contourLinesActive) window.updateContourLines();
    if(window.elevationHeatmapActive) window.updateElevationHeatmap();

    } // end doFoundation sculpting

    let cutFillMsg = ' | Cut: ' + maxCut.toFixed(1) + 'm, Fill: ' + maxFill.toFixed(1) + 'm';

    // === STEP 8: Surface painting + micro-terrain ===
    if(surface !== 'NONE' && surface !== 'GAP' && window._arcadePCtx) {
        let ctx = window._arcadePCtx;
        let ts = window.TERRAIN_SIZE;
        let canvasRes = 4096;
        let scaleC = canvasRes / ts;
        let leftEdge = [];
        let rightEdge = [];
        for(let i = 0; i < roadData.length; i += 2) {
            let rd = roadData[i];
            leftEdge.push({ px: (rd.x + rd.nx * halfW + ts/2) * scaleC, py: (rd.z + rd.nz * halfW + ts/2) * scaleC });
            rightEdge.push({ px: (rd.x - rd.nx * halfW + ts/2) * scaleC, py: (rd.z - rd.nz * halfW + ts/2) * scaleC });
        }
        function traceRoadPoly() {
            ctx.beginPath();
            for(let i = 0; i < leftEdge.length; i++) {
                if(i === 0) ctx.moveTo(leftEdge[i].px, leftEdge[i].py);
                else ctx.lineTo(leftEdge[i].px, leftEdge[i].py);
            }
            for(let i = rightEdge.length - 1; i >= 0; i--) ctx.lineTo(rightEdge[i].px, rightEdge[i].py);
            ctx.closePath();
        }
        ctx.save();
        if(surface === 'GRAVEL') {
            let gravelBase = '#C2AF7C';
            let stoneColor = '#9A8B60';
            let stoneDensity = (window._smartRoadStoneDensity || 50) / 100;
            traceRoadPoly(); ctx.fillStyle = gravelBase; ctx.fill();
            traceRoadPoly(); ctx.clip();
            let cMinX = Infinity, cMaxX = 0, cMinY = Infinity, cMaxY = 0;
            leftEdge.concat(rightEdge).forEach(function(p) {
                if(p.px < cMinX) cMinX = p.px; if(p.px > cMaxX) cMaxX = p.px;
                if(p.py < cMinY) cMinY = p.py; if(p.py > cMaxY) cMaxY = p.py;
            });
            cMinX = Math.max(0, Math.floor(cMinX) - 2); cMaxX = Math.min(canvasRes, Math.ceil(cMaxX) + 2);
            cMinY = Math.max(0, Math.floor(cMinY) - 2); cMaxY = Math.min(canvasRes, Math.ceil(cMaxY) + 2);
            let regionW = cMaxX - cMinX, regionH = cMaxY - cMinY;
            if(regionW > 0 && regionH > 0) {
                let imgData = ctx.getImageData(cMinX, cMinY, regionW, regionH);
                let pxdata = imgData.data;
                let sR = parseInt(stoneColor.slice(1,3), 16), sG2 = parseInt(stoneColor.slice(3,5), 16), sB = parseInt(stoneColor.slice(5,7), 16);
                let gR = parseInt(gravelBase.slice(1,3), 16);
                function stoneNoise(snx, sny) {
                    let sn = Math.sin(snx * 127.1 + sny * 311.7) * 43758.5453; sn = sn - Math.floor(sn);
                    let sn2 = Math.sin(snx * 0.3 * 269.5 + sny * 0.3 * 183.3) * 28461.2; sn2 = sn2 - Math.floor(sn2);
                    return sn * 0.6 + sn2 * 0.4;
                }
                let threshold = 1.0 - stoneDensity;
                for(let spy = 0; spy < regionH; spy += 2) {
                    for(let spx = 0; spx < regionW; spx += 2) {
                        let noise = stoneNoise(cMinX + spx, cMinY + spy);
                        if(noise > threshold) {
                            let blend = Math.min(1, (noise - threshold) / (1 - threshold) * 1.5);
                            let idx4 = (spy * regionW + spx) * 4;
                            if(pxdata[idx4+3] > 0 && Math.abs(pxdata[idx4] - gR) < 30) {
                                pxdata[idx4] = Math.round(pxdata[idx4] + (sR - pxdata[idx4]) * blend);
                                pxdata[idx4+1] = Math.round(pxdata[idx4+1] + (sG2 - pxdata[idx4+1]) * blend);
                                pxdata[idx4+2] = Math.round(pxdata[idx4+2] + (sB - pxdata[idx4+2]) * blend);
                                if(spx+1<regionW){let i2=(spy*regionW+spx+1)*4;pxdata[i2]=pxdata[idx4];pxdata[i2+1]=pxdata[idx4+1];pxdata[i2+2]=pxdata[idx4+2];}
                                if(spy+1<regionH){let i3=((spy+1)*regionW+spx)*4;pxdata[i3]=pxdata[idx4];pxdata[i3+1]=pxdata[idx4+1];pxdata[i3+2]=pxdata[idx4+2];}
                                if(spx+1<regionW&&spy+1<regionH){let i4=((spy+1)*regionW+spx+1)*4;pxdata[i4]=pxdata[idx4];pxdata[i4+1]=pxdata[idx4+1];pxdata[i4+2]=pxdata[idx4+2];}
                            }
                        }
                    }
                }
                ctx.putImageData(imgData, cMinX, cMinY);
            }
        } else if(surface === 'ASPHALT') {
            traceRoadPoly(); ctx.fillStyle = '#7DB952'; ctx.fill();
        } else if(surface === 'DIRT') {
            traceRoadPoly(); ctx.fillStyle = '#2D4C1A'; ctx.fill();
        }
        ctx.restore();
        window._arcadeMapTex.needsUpdate = true;
        window.terrainBiomeData = ctx.getImageData(0, 0, canvasRes, canvasRes).data;
    }
    // === STEP 9: Physical Shoulder Bumps (Straffzon) ===
    if (doFoundation) {
        let bumpAmp = 0.35;
        let hasBumps = false;
        for(let bgz = gzStart; bgz <= gzEnd; bgz++) {
            for(let bgx = gxStart; bgx <= gxEnd; bgx++) {
                let vidx = bgz * stride + bgx;
                let bvx = positions[vidx*3], bvz = -positions[vidx*3+1];
                let bDistSq = Infinity;
                let bNearIdx = getNearestRoadCached(bgx, bgz, bvx, bvz);
                if (bNearIdx >= 0) {
                    let ddx = bvx - roadData[bNearIdx].x, ddz = bvz - roadData[bNearIdx].z;
                    bDistSq = ddx*ddx + ddz*ddz;
                }
                let dist = Math.sqrt(bDistSq);
                if(dist > halfW && dist < halfW + shoulderW) {
                    let t = (dist - halfW) / shoulderW;
                    let blend = 1.0 - Math.pow(Math.abs(t - 0.5) * 2, 2);
                    if(blend > 0) {
                        let bn = Math.sin(bvx*2.1 + bvz*1.3) * Math.cos(bvx*1.8 - bvz*2.7);
                        bn += Math.sin(bvx*4.3 + bvz*3.1) * 0.4;
                        positions[vidx*3+2] += bn * bumpAmp * blend;
                        hasBumps = true;
                    }
                }
            }
        }
        if (hasBumps) {
            window._arcadePlaneGeo.attributes.position.needsUpdate = true;
            window._arcadePlaneGeo.computeVertexNormals();
        }
    }

    // === STEP 10: Place 3D Barriers ===
    let barrierL = window._smartRoadBarrierL || 'NONE';
    let barrierR = window._smartRoadBarrierR || 'NONE';
    
    if (barrierL !== 'NONE' || barrierR !== 'NONE') {
        let fenceGroup = new THREE.Group();
        window._arcadeScene.add(fenceGroup);
        
        let woodMat = new THREE.MeshLambertMaterial({ color: 0x5c4033 });
        let steelMat = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.8, roughness: 0.4 });
        let stoneMat = new THREE.MeshLambertMaterial({ color: 0x8a8070 });
        let stoneMat2 = new THREE.MeshLambertMaterial({ color: 0x7a7060 });
        
        // Spacing set per-type before buildFencePath call
        let spacing = 1.0;
        // With foundation: barriers at outer shoulder edge
        // Without foundation: barriers tight to road edge (1m margin)
        let offsetDist = doFoundation ? (halfW + shoulderW - 0.2) : (halfW + 1.0);
        
        // ── STEP 10a: Smooth normals to prevent jitter ──
        // Breed smoothing-fönster (±W samples) ger stabila normaler
        let smoothW = Math.min(15, Math.floor(roadData.length / 10));
        if (smoothW < 3) smoothW = 3;
        let smoothNx = new Float32Array(roadData.length);
        let smoothNz = new Float32Array(roadData.length);
        for (let r = 0; r < roadData.length; r++) {
            let snx = 0, snz = 0;
            let lo = Math.max(0, r - smoothW);
            let hi = Math.min(roadData.length - 1, r + smoothW);
            for (let k = lo; k <= hi; k++) {
                snx += roadData[k].nx;
                snz += roadData[k].nz;
            }
            let sLen = Math.sqrt(snx * snx + snz * snz);
            if (sLen > 0.001) { smoothNx[r] = snx / sLen; smoothNz[r] = snz / sLen; }
            else { smoothNx[r] = roadData[r].nx; smoothNz[r] = roadData[r].nz; }
        }
        
        // ── STEP 10b: Walk centerline at fixed spacing, offset once per post ──
        // Key insight: walk the CENTERLINE at fence-spacing intervals,
        // offset perpendicularly ONCE per post. This can never self-intersect.
        let buildFencePath = (side) => {
            let posts = [];
            
            // Compute cumulative arc-length along centerline
            let arcLens = new Float32Array(roadData.length);
            arcLens[0] = 0;
            for (let r = 1; r < roadData.length; r++) {
                let ddx = roadData[r].x - roadData[r-1].x;
                let ddz = roadData[r].z - roadData[r-1].z;
                arcLens[r] = arcLens[r-1] + Math.sqrt(ddx * ddx + ddz * ddz);
            }
            let totalArcLen = arcLens[roadData.length - 1];
            if (totalArcLen < 1) return posts;
            
            // Walk centerline at uniform arc-length steps
            let numPosts = Math.max(2, Math.floor(totalArcLen / spacing) + 1);
            let rIdx = 0; // current roadData index for binary-search-free walk
            
            for (let pi = 0; pi < numPosts; pi++) {
                let targetArc = (pi / (numPosts - 1)) * totalArcLen;
                
                // Advance rIdx to find the segment containing targetArc
                while (rIdx < roadData.length - 2 && arcLens[rIdx + 1] < targetArc) rIdx++;
                
                // Interpolate position along segment
                let segLen = arcLens[rIdx + 1] - arcLens[rIdx];
                let t = segLen > 0.001 ? (targetArc - arcLens[rIdx]) / segLen : 0;
                t = Math.max(0, Math.min(1, t));
                
                let r0 = roadData[rIdx];
                let r1 = roadData[Math.min(rIdx + 1, roadData.length - 1)];
                
                let cx = r0.x + (r1.x - r0.x) * t;
                let cz = r0.z + (r1.z - r0.z) * t;
                let ch = r0.roadH + (r1.roadH - r0.roadH) * t;
                let cBank = r0.bankRad + (r1.bankRad - r0.bankRad) * t;
                
                // Interpolate smoothed normal
                let snx = smoothNx[rIdx] + (smoothNx[Math.min(rIdx + 1, roadData.length - 1)] - smoothNx[rIdx]) * t;
                let snz = smoothNz[rIdx] + (smoothNz[Math.min(rIdx + 1, roadData.length - 1)] - smoothNz[rIdx]) * t;
                let nLen = Math.sqrt(snx * snx + snz * snz);
                if (nLen > 0.001) { snx /= nLen; snz /= nLen; }
                
                // Offset perpendicular to centerline
                let ox = cx + snx * offsetDist * side;
                let oz = cz + snz * offsetDist * side;
                
                // Check for cusp: does the offset point back-track?
                if (posts.length > 0) {
                    let lastPost = posts[posts.length - 1];
                    if (lastPost) {
                        // Direction from last post to this one
                        let pdx = ox - lastPost.x;
                        let pdz = oz - lastPost.z;
                        
                        // Direction of the centerline tangent at this point
                        let ttx = r0.tx + (r1.tx - r0.tx) * t;
                        let ttz = r0.tz + (r1.tz - r0.tz) * t;
                        
                        // Dot product: positive = moving forward, negative = back-tracking (cusp)
                        let forwardDot = pdx * ttx + pdz * ttz;
                        
                        if (forwardDot < -0.01) {
                            // Backtracking → skip this post (inner cusp)
                            posts.push(null); // Gap marker
                            continue;
                        }
                    }
                }
                
                let h = window.getTerrainHeight ? window.getTerrainHeight(ox, oz) : ch;
                if (doFoundation) {
                    let tanBank = Math.tan(cBank);
                    let lowestOffset = Math.abs(tanBank * halfW);
                    let bankOffset = (tanBank * offsetDist * side) + lowestOffset;
                    h = ch + bankOffset;
                }
                posts.push({ x: ox, z: oz, h: h });
            }
            
            return posts;
        };
        
        let placeFences = (posts, type) => {
            if (type === 'NONE' || posts.length < 2) return;
            
            // Filter valid segments first to count instances
            let validSegments = [];
            for (let i = 0; i < posts.length - 1; i++) {
                let a = posts[i], b = posts[i + 1];
                if (!a || !b) continue;
                let dx = b.x - a.x, dz = b.z - a.z, dy = b.h - a.h;
                let hLen = Math.sqrt(dx * dx + dz * dz);
                if (hLen < 0.05) continue;
                validSegments.push({ a, b, dx, dy, dz, fLen: Math.sqrt(dx * dx + dy * dy + dz * dz), i });
            }
            if (validSegments.length === 0) return;
            
            let dummy = new THREE.Object3D();
            
            // === STAKES: individual vertical pins — breakable ===
            if (type === 'STAKES') {
                let stakeMat = new THREE.MeshLambertMaterial({ color: 0xdd2222 });
                let stakeMatWhite = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
                let stakeGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6);
                let tipGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.3, 6);
                
                let validPosts = posts.filter(p => p !== null);
                let imStake = new THREE.InstancedMesh(stakeGeo, stakeMat, validPosts.length);
                let imTip = new THREE.InstancedMesh(tipGeo, stakeMatWhite, validPosts.length);
                
                for (let i = 0; i < validPosts.length; i++) {
                    let p = validPosts[i];
                    dummy.position.set(p.x, p.h + 0.7, p.z);
                    dummy.updateMatrix();
                    imStake.setMatrixAt(i, dummy.matrix);
                    
                    dummy.position.set(p.x, p.h + 1.55, p.z);
                    dummy.updateMatrix();
                    imTip.setMatrixAt(i, dummy.matrix);
                }
                
                imStake.userData = { isBarrier: true, barrierType: 'STAKES', isTip: false, breakable: true, solid: false };
                imTip.userData = { isBarrier: true, barrierType: 'STAKES', isTip: true, breakable: true, solid: false };
                fenceGroup.add(imStake);
                fenceGroup.add(imTip);
                return;
            }
            
            // === STONE: 45cm blocks — solid, stops the car ===
            if (type === 'STONE') {
                let stoneH = 0.7;  // wall height
                let stoneW = 0.5;  // wall thickness
                let blockGeo = new THREE.BoxGeometry(stoneW, 1.0, 1.0); // Unit height and length
                
                let imStone1 = new THREE.InstancedMesh(blockGeo, stoneMat, validSegments.length);
                let imStone2 = new THREE.InstancedMesh(blockGeo, stoneMat2, validSegments.length);
                let count1 = 0, count2 = 0;
                
                for (let s of validSegments) {
                    let mx = (s.a.x + s.b.x) / 2;
                    let mz = (s.a.z + s.b.z) / 2;
                    let my = (s.a.h + s.b.h) / 2;
                    
                    let hVar = stoneH + (Math.sin(s.i * 7.3) * 0.08);
                    
                    dummy.position.set(mx, my + hVar / 2, mz);
                    dummy.lookAt(s.b.x, s.b.h + hVar / 2, s.b.z);
                    dummy.scale.set(1, hVar, Math.max(0.2, s.fLen));
                    dummy.updateMatrix();
                    
                    if (s.i % 3 === 0) {
                        imStone2.setMatrixAt(count2++, dummy.matrix);
                    } else {
                        imStone1.setMatrixAt(count1++, dummy.matrix);
                    }
                }
                
                imStone1.count = count1;
                imStone2.count = count2;
                imStone1.userData = { isBarrier: true, barrierType: 'STONE', breakable: false, solid: true };
                imStone2.userData = { isBarrier: true, barrierType: 'STONE', breakable: false, solid: true };
                if (count1 > 0) fenceGroup.add(imStone1);
                if (count2 > 0) fenceGroup.add(imStone2);
                return;
            }
            
            // === WOOD / STEEL: segment-based barriers ===
            let isWood = type === 'WOOD';
            let geo = isWood ? new THREE.BoxGeometry(0.2, 1.2, 1.0) : new THREE.BoxGeometry(0.4, 0.8, 1.0);
            let mat = isWood ? woodMat : steelMat;
            let halfHeight = isWood ? 0.6 : 0.4;
            
            let imMesh = new THREE.InstancedMesh(geo, mat, validSegments.length);
            
            for (let i = 0; i < validSegments.length; i++) {
                let s = validSegments[i];
                let mx = (s.a.x + s.b.x) / 2;
                let mz = (s.a.z + s.b.z) / 2;
                let my = (s.a.h + s.b.h) / 2;
                
                dummy.position.set(mx, my + halfHeight, mz);
                dummy.lookAt(s.b.x, s.b.h + halfHeight, s.b.z);
                dummy.scale.set(1, 1, s.fLen);
                dummy.updateMatrix();
                
                imMesh.setMatrixAt(i, dummy.matrix);
            }
            
            imMesh.userData = { isBarrier: true, barrierType: type, breakable: isWood, solid: true };
            fenceGroup.add(imMesh);
        };
        
        // Spacing per type: STONE 0.45m (tight blocks), STAKES 1.5m, WOOD/STEEL 1.0m
        if (barrierL !== 'NONE') {
            spacing = barrierL === 'STAKES' ? 1.5 : (barrierL === 'STONE' ? 0.45 : 1.0);
            let leftPosts = buildFencePath(-1);
            placeFences(leftPosts, barrierL);
        }
        if (barrierR !== 'NONE') {
            spacing = barrierR === 'STAKES' ? 1.5 : (barrierR === 'STONE' ? 0.45 : 1.0);
            let rightPosts = buildFencePath(1);
            placeFences(rightPosts, barrierR);
        }
        
        // Spåra för UNDO
        if (!window.courseHoles[window.currentHoleIndex].envObjects) {
            window.courseHoles[window.currentHoleIndex].envObjects = [];
        }
        window.courseHoles[window.currentHoleIndex].envObjects.push({
            id: 'fences_' + Date.now(),
            type: 'fences',
            mesh: fenceGroup
        });
    }

    // ── ROAD PIPELINE FIX: Register road data for save/load ──
    // Stores road geometry so arcade.html can serialize it into rally config.
    // rally.html uses this to rebuild vertex colors + road decal meshes.
    if (!window._builtRoads) window._builtRoads = [];
    let materialMap = { GRAVEL: 'GRAVEL', ASPHALT: 'TARMAC', DIRT: 'MUD' };
    let rsMaterial = materialMap[surface] || 'GRAVEL';
    if (surface !== 'GAP') {
        let roadEntry = {
            id: 'road_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6),
            nodes: smartGreenPoints.map(function(p) { return { worldX: p.x, worldY: p.y, worldZ: p.z }; }),
            width: roadWidth,
            material: rsMaterial,
            closed: !!window._smartShapeClosed,
            sampledPoints: splinePts.map(function(p) { return { x: p.x, y: p.y || 0, z: p.z }; })
        };
        window._builtRoads.push(roadEntry);
        
        // Sync with rally-roads.js road system (if loaded)
        if (window.roadSystem && typeof window.roadSystem.registerExternalRoad === 'function') {
            window.roadSystem.registerExternalRoad(roadEntry);
        }
    }

    let surfMsg = surface !== 'NONE' ? ' | ' + surface : '';
    if (window.showBuildToast) window.showBuildToast('🛣️ Road Built' + surfMsg, '#38bdf8');
    
    // Spara sista punkten så att vi kan snäppa nästa väg mot den
    if (smartGreenPoints.length > 0) {
        let lastPt = smartGreenPoints[smartGreenPoints.length - 1];
        window._lastRoadEndPoint = { x: lastPt.x, y: lastPt.y, z: lastPt.z };
    }
    clearSmartGreen();
};


window.executeRidgeMountain = function() {
    if (!window.splinePoints || window.splinePoints.length < 2) {
        if (window.showBuildToast) window.showBuildToast('Requires at least 2 points', '#ef4444');
        return;
    }
    
    window.saveUndoState();
    if (window.showBuildToast) window.showBuildToast('Building mountain ridge...', '#38bdf8');
    
    let targetHeight = parseFloat(document.getElementById('sculpt-strength').value) || 20.0;
    
    // Auto width based on height (slope ratio 1:2.5)
    let ridgeWidth = Math.abs(targetHeight) * 2.5;
    if (ridgeWidth < 12) ridgeWidth = 12;
    
    const positions = window.terrainGeometry.attributes.position.array;
    let modified = false;
    
    function distToSegment(p, v, w) {
        const l2 = (v.x - w.x)**2 + (v.z - w.z)**2;
        if (l2 == 0) return Math.sqrt((p.x - v.x)**2 + (p.z - v.z)**2);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
        t = Math.max(0, Math.min(1, t));
        const proj = { x: v.x + t * (w.x - v.x), z: v.z + t * (w.z - v.z) };
        return Math.sqrt((p.x - proj.x)**2 + (p.z - proj.z)**2);
    }
    
    for (let i = 0; i < positions.length; i += 3) {
        let vx = positions[i];
        let vy = positions[i+1];
        let vz = positions[i+2];
        
        let p = { x: vx, z: vz };
        let minDist = Infinity;
        
        for (let j = 0; j < window.splinePoints.length - 1; j++) {
            let v1 = window.splinePoints[j];
            let v2 = window.splinePoints[j+1];
            let d = distToSegment(p, v1, v2);
            if (d < minDist) minDist = d;
        }
        
        if (minDist < ridgeWidth) {
            let nDist = minDist / ridgeWidth;
            let baseFalloff = (Math.cos(nDist * Math.PI) + 1) * 0.5; // Cosine falloff 1 to 0
            
            // Add varied noise
            let noiseVal = 0;
            if (typeof noise2D !== 'undefined') {
                noiseVal += noise2D(vx * 0.04, vz * 0.04) * 0.6;
                noiseVal += noise2D(vx * 0.1, vz * 0.1) * 0.3;
            } else {
                noiseVal = (Math.random() - 0.5) * 0.4;
            }
            
            // Taper noise at edges
            let noiseMod = noiseVal * targetHeight * 0.35 * baseFalloff;
            let newY = vy + (targetHeight * baseFalloff) + noiseMod;
            
            positions[i+1] = newY;
            modified = true;
        }
    }
    
    if (modified) {
        window.terrainGeometry.attributes.position.needsUpdate = true;
        window.terrainGeometry.computeVertexNormals();
        if(window.updateTerrainCollider) window.updateTerrainCollider();
    }
    
    clearSmartGreen();
};

window.executeSplineMountain = function() {
    if (!window.splinePoints || window.splinePoints.length < 3) {
        if (window.showBuildToast) {
            window.showBuildToast('⚠️ Draw at least 3 points to create a mountain!', '#f59e0b');
        } else {
            alert('Draw at least 3 points to create a mountain!');
        }
        return;
    }

    // Spara undo-tillstånd
    if (typeof window.saveUndoState === 'function') {
        window.saveUndoState();
    }

    let mtnHeight = parseFloat(document.getElementById('mtn-spline-height').value) || 25;

    // Skapa en stängd kurva och sampla tätt
    let curve = new THREE.CatmullRomCurve3(window.splinePoints, true);
    let numSamples = Math.max(150, window.splinePoints.length * 30);
    let densePts = curve.getPoints(numSamples);

    // Hitta 2D bounding box
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    densePts.forEach(pt => {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.z < minZ) minZ = pt.z;
        if (pt.z > maxZ) maxZ = pt.z;
    });

    let segs = window.TERRAIN_SEGS;
    let size = window.TERRAIN_SIZE;
    let step = size / segs;
    let gxMin = Math.max(0, Math.floor((minX + (size / 2)) / step) - 2);
    let gxMax = Math.min(segs, Math.ceil((maxX + (size / 2)) / step) + 2);
    let gzMin = Math.max(0, Math.floor((minZ + (size / 2)) / step) - 2);
    let gzMax = Math.min(segs, Math.ceil((maxZ + (size / 2)) / step) + 2);

    // Hjälpfunktioner för point-in-polygon och avstånd
    function pointInPolygon(x, z, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            let xi = polygon[i].x, zi = polygon[i].z;
            let xj = polygon[j].x, zj = polygon[j].z;
            let intersect = ((zi > z) !== (zj > z))
                && (x < (xj - xi) * (z - zi) / (zj - zi + 0.00001) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function distanceToSegmentSq(px, pz, ax, az, bx, bz) {
        let dx = bx - ax;
        let dz = bz - az;
        let l2 = dx * dx + dz * dz;
        if (l2 === 0) return (px - ax) * (px - ax) + (pz - az) * (pz - az);
        let t = ((px - ax) * dx + (pz - az) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        let projX = ax + t * dx;
        let projZ = az + t * dz;
        let rx = px - projX;
        let rz = pz - projZ;
        return rx * rx + rz * rz;
    }

    function minDistanceToPolygon(x, z, polygon) {
        let minDistSq = Infinity;
        for (let i = 0; i < polygon.length; i++) {
            let next = (i + 1) % polygon.length;
            let dSq = distanceToSegmentSq(x, z, polygon[i].x, polygon[i].z, polygon[next].x, polygon[next].z);
            if (dSq < minDistSq) minDistSq = dSq;
        }
        return Math.sqrt(minDistSq);
    }

    // Samla vertexer inuti
    let insideVertices = [];
    let maxD = 0;
    let positions = window._arcadePlaneGeo.attributes.position.array;
    let stride = segs + 1;

    for (let gz = gzMin; gz <= gzMax; gz++) {
        for (let gx = gxMin; gx <= gxMax; gx++) {
            let idx = gz * stride + gx;
            let vx = positions[idx * 3];
            let vz = -positions[idx * 3 + 1];
            let origH = positions[idx * 3 + 2];

            if (pointInPolygon(vx, vz, densePts)) {
                let d = minDistanceToPolygon(vx, vz, densePts);
                if (d > maxD) maxD = d;
                insideVertices.push({ idx: idx, x: vx, z: vz, origH: origH, d: d });
            }
        }
    }

    if (insideVertices.length === 0 || maxD === 0) {
        if (window.showBuildToast) window.showBuildToast('⚠️ No terrain found inside the shape!', '#f59e0b');
        return;
    }

    let fbm = window.fbm || function(x, y) { return 0; };

    let jaggedMultiplier = 1.0;
    let jaggedSlider = document.getElementById('mtn-spline-jagged');
    if (jaggedSlider) {
        jaggedMultiplier = parseFloat(jaggedSlider.value) / 50.0;
    }

    // Höj terrängen inuti formen
    insideVertices.forEach(v => {
        let t = v.d / maxD;
        // Smoothstep falloff
        let falloff = t * t * (3 - 2 * t);
        
        // FBM noise med frekvens och dämpning, skalat med jaggedMultiplier
        let noiseVal = fbm(v.x * 0.1, v.z * 0.1, 3, 2.0, 0.5) * (mtnHeight * 0.15) * jaggedMultiplier;
        
        // Slutlig höjdändring
        let targetH = v.origH + (mtnHeight + noiseVal) * falloff;
        positions[v.idx * 3 + 2] = targetH;
    });

    // Uppdatera geometri
    window._arcadePlaneGeo.attributes.position.needsUpdate = true;
    window._arcadePlaneGeo.computeVertexNormals();
    window._arcadePlaneGeo.computeBoundingBox();
    window._arcadePlaneGeo.computeBoundingSphere();

    // Uppdatera skuggor/snäppning/vatten
    if (typeof window.snapObjectsToGround === 'function') window.snapObjectsToGround();
    if (typeof window.rebuildWaterMask === 'function') window.rebuildWaterMask(true);

    // Rensa spline-punkter
    if (typeof window.clearSpline === 'function') {
        window.clearSpline();
    }

    if (window.showBuildToast) window.showBuildToast('⛰️ Mountain built!', '#38bdf8');
};

})();
