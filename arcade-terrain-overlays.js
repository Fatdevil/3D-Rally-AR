// ================================================================
//  TERRAIN OVERLAYS — Slope, Contour Lines, Elevation Heatmap
//  Uses window.G for scene/terrain access.
//
//  Exposes:
//  - window.updateSlopeOverlay()
//  - window.toggleSlopeOverlay()
//  - window.updateContourLines()
//  - window.toggleContourLines()
//  - window.updateElevationHeatmap()
//  - window.toggleElevationHeatmap()
//  - window.slopeOverlayActive, contourLinesActive, elevationHeatmapActive
// ================================================================
(function() {
    // Deferred init — wait for G.scene to be ready
    function init() {
        const G = window.G;
        if (!G || !G.scene || !G.planeGeo) {
            setTimeout(init, 100);
            return;
        }

        const TERRAIN_SIZE = G.TERRAIN_SIZE;
        const TERRAIN_SEGS = G.TERRAIN_SEGS;
        const scene = G.scene;
        const planeGeo = G.planeGeo;

        // === SLOPE OVERLAY ===
        let slopeOverlayGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
        slopeOverlayGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        let slopeColors = new Float32Array((TERRAIN_SEGS+1)*(TERRAIN_SEGS+1)*3);
        slopeOverlayGeo.setAttribute('color', new THREE.BufferAttribute(slopeColors, 3));
        let slopeOverlayMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
        let slopeOverlayMesh = new THREE.Mesh(slopeOverlayGeo, slopeOverlayMat);
        slopeOverlayMesh.rotation.x = -Math.PI / 2;
        slopeOverlayMesh.renderOrder = 1;
        slopeOverlayMesh.visible = false;
        scene.add(slopeOverlayMesh);

        // === CONTOUR LINES ===
        let contourCanvas = document.createElement('canvas');
        contourCanvas.width = 2048; contourCanvas.height = 2048;
        let contourCtx = contourCanvas.getContext('2d');
        let contourTex = new THREE.CanvasTexture(contourCanvas);
        contourTex.minFilter = THREE.LinearFilter;
        let contourGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
        contourGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        let contourMat = new THREE.MeshBasicMaterial({ map: contourTex, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
        let contourMesh = new THREE.Mesh(contourGeo, contourMat);
        contourMesh.rotation.x = -Math.PI / 2;
        contourMesh.renderOrder = 2;
        contourMesh.visible = false;
        scene.add(contourMesh);

        // === ELEVATION HEATMAP ===
        let elevHeatGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS);
        elevHeatGeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        let elevHeatColors = new Float32Array((TERRAIN_SEGS+1)*(TERRAIN_SEGS+1)*3);
        elevHeatGeo.setAttribute('color', new THREE.BufferAttribute(elevHeatColors, 3));
        let elevHeatMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -6 });
        let elevHeatMesh = new THREE.Mesh(elevHeatGeo, elevHeatMat);
        elevHeatMesh.rotation.x = -Math.PI / 2;
        elevHeatMesh.renderOrder = 1;
        elevHeatMesh.visible = false;
        scene.add(elevHeatMesh);

        // --- STATE ---
        window.slopeOverlayActive = false;
        window.contourLinesActive = false;
        window.elevationHeatmapActive = false;

        // --- UPDATE FUNCTIONS ---
        window.updateSlopeOverlay = function() {
            let pos = planeGeo.attributes.position.array;
            let sPos = slopeOverlayGeo.attributes.position.array;
            let cols = slopeOverlayGeo.attributes.color.array;
            let segs = TERRAIN_SEGS;
            let step = TERRAIN_SIZE / segs;

            for(let i = 0; i < sPos.length; i++) sPos[i] = pos[i];
            for(let i = 2; i < sPos.length; i += 3) sPos[i] = pos[i] + 0.1;

            for(let z = 0; z <= segs; z++) {
                for(let x = 0; x <= segs; x++) {
                    let idx = z * (segs+1) + x;
                    let h = pos[idx*3+2];
                    let hR = (x < segs) ? pos[(z*(segs+1)+(x+1))*3+2] : h;
                    let hL = (x > 0)    ? pos[(z*(segs+1)+(x-1))*3+2] : h;
                    let hU = (z > 0)    ? pos[((z-1)*(segs+1)+x)*3+2] : h;
                    let hD = (z < segs) ? pos[((z+1)*(segs+1)+x)*3+2] : h;
                    let dx = (hR - hL) / (2 * step);
                    let dz = (hD - hU) / (2 * step);
                    let slopePct = Math.sqrt(dx*dx + dz*dz) * 100;

                    let r, g, b;
                    if(slopePct < 3) {
                        let t = slopePct / 3;
                        r = t * 1.0; g = 0.85; b = 0.1 * t;
                    } else if(slopePct < 8) {
                        let t = (slopePct - 3) / 5;
                        r = 1.0; g = 0.85 * (1-t); b = 0;
                    } else {
                        r = 1.0; g = 0; b = 0;
                    }
                    cols[idx*3] = r; cols[idx*3+1] = g; cols[idx*3+2] = b;
                }
            }
            slopeOverlayGeo.attributes.position.needsUpdate = true;
            slopeOverlayGeo.attributes.color.needsUpdate = true;
        };

        window.updateContourLines = function() {
            let ctx = contourCtx;
            ctx.clearRect(0, 0, 2048, 2048);
            let pos = planeGeo.attributes.position.array;
            let cPos = contourGeo.attributes.position.array;
            let segs = TERRAIN_SEGS;
            let res = 2048;
            let ratio = res / (segs + 1);

            for(let i = 0; i < pos.length; i++) cPos[i] = pos[i];
            for(let i = 2; i < cPos.length; i += 3) cPos[i] = pos[i] + 0.05;
            contourGeo.attributes.position.needsUpdate = true;

            let hMin = Infinity, hMax = -Infinity;
            for(let i = 2; i < pos.length; i += 3) {
                if(pos[i] < hMin) hMin = pos[i];
                if(pos[i] > hMax) hMax = pos[i];
            }
            if(hMax - hMin < 0.1) { contourTex.needsUpdate = true; return; }

            let interval = 0.5;
            if(hMax - hMin > 20) interval = 1.0;
            if(hMax - hMin > 40) interval = 2.0;
            if(hMax - hMin > 80) interval = 5.0;
            let majorInterval = interval * 5;

            for(let level = Math.ceil(hMin / interval) * interval; level <= hMax; level += interval) {
                let isMajor = Math.abs(level % majorInterval) < 0.01;
                ctx.strokeStyle = isMajor ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.4)';
                ctx.lineWidth = isMajor ? 3.0 : 1.5;
                ctx.beginPath();
                let hasSegment = false;

                for(let z = 0; z < segs; z++) {
                    for(let x = 0; x < segs; x++) {
                        let idx00 = z * (segs+1) + x;
                        let idx10 = z * (segs+1) + (x+1);
                        let idx01 = (z+1) * (segs+1) + x;
                        let idx11 = (z+1) * (segs+1) + (x+1);
                        let h00 = pos[idx00*3+2], h10 = pos[idx10*3+2];
                        let h01 = pos[idx01*3+2], h11 = pos[idx11*3+2];

                        let pts = [];
                        if((h00 - level) * (h10 - level) < 0) {
                            let t = (level - h00) / (h10 - h00);
                            pts.push([(x + t) * ratio, z * ratio]);
                        }
                        if((h01 - level) * (h11 - level) < 0) {
                            let t = (level - h01) / (h11 - h01);
                            pts.push([(x + t) * ratio, (z+1) * ratio]);
                        }
                        if((h00 - level) * (h01 - level) < 0) {
                            let t = (level - h00) / (h01 - h00);
                            pts.push([x * ratio, (z + t) * ratio]);
                        }
                        if((h10 - level) * (h11 - level) < 0) {
                            let t = (level - h10) / (h11 - h10);
                            pts.push([(x+1) * ratio, (z + t) * ratio]);
                        }
                        if(pts.length >= 2) {
                            ctx.moveTo(pts[0][0], pts[0][1]);
                            ctx.lineTo(pts[1][0], pts[1][1]);
                            hasSegment = true;
                        }
                    }
                }
                if(hasSegment) ctx.stroke();

                // Height labels on major lines
                if(isMajor && hasSegment) {
                    for(let z = Math.floor(segs/2); z < Math.floor(segs/2)+5; z++) {
                        for(let x = 0; x < segs; x++) {
                            let idx00 = z * (segs+1) + x;
                            let idx10 = z * (segs+1) + (x+1);
                            let h00 = pos[idx00*3+2], h10 = pos[idx10*3+2];
                            if((h00 - level) * (h10 - level) < 0) {
                                let t = (level - h00) / (h10 - h00);
                                let lx = (x + t) * ratio;
                                let ly = z * ratio;
                                ctx.font = 'bold 18px Arial';
                                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                                ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                                ctx.lineWidth = 3;
                                let txt = level.toFixed(1) + 'm';
                                ctx.strokeText(txt, lx + 5, ly - 5);
                                ctx.fillText(txt, lx + 5, ly - 5);
                                break;
                            }
                        }
                        break;
                    }
                }
            }
            contourTex.needsUpdate = true;
        };

        window.updateElevationHeatmap = function() {
            let pos = planeGeo.attributes.position.array;
            let ePos = elevHeatGeo.attributes.position.array;
            let cols = elevHeatGeo.attributes.color.array;
            let total = (TERRAIN_SEGS+1)*(TERRAIN_SEGS+1);

            for(let i = 0; i < pos.length; i++) ePos[i] = pos[i];
            for(let i = 2; i < ePos.length; i += 3) ePos[i] = pos[i] + 0.08;
            elevHeatGeo.attributes.position.needsUpdate = true;

            let heights = [];
            for(let i = 2; i < pos.length; i += 3) heights.push(pos[i]);
            heights.sort((a,b) => a - b);
            let median = heights[Math.floor(heights.length / 2)];
            let sensitivity = 1.5;
            let rangeMin = median - sensitivity;
            let rangeMax = median + sensitivity;
            let range = rangeMax - rangeMin;
            if(range < 0.01) range = 1;

            for(let idx = 0; idx < total; idx++) {
                let h = pos[idx*3+2];
                let t = Math.max(0, Math.min(1, (h - rangeMin) / range));
                let r, g, b;
                if(t < 0.5) {
                    let s = t * 2;
                    r = 0; g = s * 0.9; b = (1 - s) * 0.9;
                } else {
                    let s = (t - 0.5) * 2;
                    r = s * 1.0; g = (1 - s) * 0.9; b = 0;
                }
                cols[idx*3] = r; cols[idx*3+1] = g; cols[idx*3+2] = b;
            }
            elevHeatGeo.attributes.color.needsUpdate = true;
        };

        // --- TOGGLE FUNCTIONS ---
        window.toggleSlopeOverlay = function() {
            window.slopeOverlayActive = !window.slopeOverlayActive;
            slopeOverlayMesh.visible = window.slopeOverlayActive;
            ['btn-slope-overlay', 'gr-slope'].forEach(id => {
                let btn = document.getElementById(id);
                if(btn) { btn.style.borderColor = window.slopeOverlayActive ? '#4ade80' : '#475569'; btn.style.color = window.slopeOverlayActive ? '#4ade80' : '#94a3b8'; }
            });
            if(window.slopeOverlayActive) window.updateSlopeOverlay();
        };

        window.toggleContourLines = function() {
            window.contourLinesActive = !window.contourLinesActive;
            contourMesh.visible = window.contourLinesActive;
            ['btn-contour-lines', 'gr-contour'].forEach(id => {
                let btn = document.getElementById(id);
                if(btn) { btn.style.borderColor = window.contourLinesActive ? '#4ade80' : '#475569'; btn.style.color = window.contourLinesActive ? '#4ade80' : '#94a3b8'; }
            });
            if(window.contourLinesActive) window.updateContourLines();
        };

        window.toggleElevationHeatmap = function() {
            window.elevationHeatmapActive = !window.elevationHeatmapActive;
            elevHeatMesh.visible = window.elevationHeatmapActive;
            ['btn-elevation-heatmap', 'gr-elev'].forEach(id => {
                let btn = document.getElementById(id);
                if(btn) { btn.style.borderColor = window.elevationHeatmapActive ? '#38bdf8' : '#475569'; btn.style.color = window.elevationHeatmapActive ? '#38bdf8' : '#94a3b8'; }
            });
            if(window.elevationHeatmapActive) window.updateElevationHeatmap();
        };
    }

    // Boot when DOM and G are ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
