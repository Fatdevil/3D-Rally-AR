// ============================================================
// rally-jump-tool.js — Jump Calculator & Trajectory Preview
// Adds a JUMP tool to the builder for designing ramps with
// real-time physics preview (parabolic arc, landing zone, stats)
// ============================================================
(function() {
'use strict';

// ── Physics Constants ──
const G = 9.81;              // Gravity (m/s²)
const AIR_GRAVITY = G * 1.4; // Rally vehicle air gravity (heavier feel)
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ── State ──
let jumpActive = false;
let jumpMeshes = [];         // 3D preview objects in scene
let jumpHUD = null;          // DOM panel
let lastCalc = null;         // Last calculation result

// Default parameters
let jumpSpeed = 80;          // km/h
let rampAngle = 25;          // degrees
let landingSlope = 0;        // degrees (auto from terrain)

// ── Core Physics: Projectile on slope ──
function calculateJump(speedKmh, angleDeg, landSlopeDeg) {
    let v = speedKmh / 3.6;              // m/s
    let theta = angleDeg * DEG;           // ramp angle in rad
    let phi = landSlopeDeg * DEG;         // landing slope in rad
    let g = AIR_GRAVITY;

    let vx = v * Math.cos(theta);
    let vy = v * Math.sin(theta);

    // Time of flight (solve y = vy*t - 0.5*g*t² = x*tan(phi))
    // With slope: t = 2*(vy - vx*tan(phi)) / g
    let tanPhi = Math.tan(phi);
    let tFlight = 2 * (vy - vx * tanPhi) / g;
    
    // Clamp: if we get negative or insane time, slope is too steep to land ahead of ramp
    // BUG-09 fix: sätt invalid-flagga istället för att tyst returnera 0.1s
    let invalid = false;
    if (tFlight <= 0) { tFlight = 0.01; invalid = true; }
    if (tFlight > 10) tFlight = 10;

    // Horizontal distance
    let distX = vx * tFlight;

    // Max height (apex)
    let tApex = vy / g;
    let maxH = (vy * vy) / (2 * g);

    // Landing angle = angle of velocity vector at landing
    let vyLand = vy - g * tFlight;
    let landAngle = Math.atan2(-vyLand, vx) * RAD; // positive = steep

    // Generate trajectory points (every 0.02s)
    let points = [];
    let steps = Math.ceil(tFlight / 0.02);
    for (let i = 0; i <= steps; i++) {
        let t = (i / steps) * tFlight;
        let x = vx * t;
        let y = vy * t - 0.5 * g * t * t;
        points.push({ x: x, y: Math.max(0, y) });
    }

    return {
        speed: speedKmh,
        angle: angleDeg,
        landSlope: landSlopeDeg,
        airTime: tFlight,
        distance: distX,
        maxHeight: maxH,
        landAngle: landAngle,
        points: points,
        invalid: invalid // BUG-09: true = landningssluttning brantare än hoppet
    };
}

// ── Rating: Color-code the jump ──
function rateJump(calc) {
    let a = Math.abs(calc.landAngle);
    if (a < 25) return { label: 'SMOOTH', color: '#4ade80', emoji: '🟢' };
    if (a < 40) return { label: 'HARD',   color: '#fbbf24', emoji: '🟡' };
    return                   { label: 'DANGER', color: '#ef4444', emoji: '🔴' };
}

function rateRamp(angleDeg) {
    if (angleDeg >= 15 && angleDeg <= 35) return { color: '#4ade80', text: 'Optimal' };
    if (angleDeg >= 10 && angleDeg <= 45) return { color: '#fbbf24', text: 'Steep' };
    return { color: '#ef4444', text: 'Extreme' };
}

// ── 3D Preview: Parabolic arc in scene ──
function renderTrajectory(calc, startPos, direction) {
    clearPreview();
    if (!window.scene || !calc || !calc.points.length) return;

    let scene = window.scene;
    let dir = direction.clone().normalize();

    // Build 3D points along trajectory
    let pts3D = calc.points.map(p => {
        let pos = startPos.clone();
        pos.addScaledVector(dir, p.x);
        pos.y += p.y;
        return pos;
    });

    // ── Trajectory line (gradient: green → yellow → red) ──
    let positions = new Float32Array(pts3D.length * 3);
    let colors = new Float32Array(pts3D.length * 3);
    let rating = rateJump(calc);

    for (let i = 0; i < pts3D.length; i++) {
        positions[i * 3]     = pts3D[i].x;
        positions[i * 3 + 1] = pts3D[i].y;
        positions[i * 3 + 2] = pts3D[i].z;

        // Color gradient: green at start → rating color at landing
        let t = i / (pts3D.length - 1);
        let startC = new THREE.Color(0x4ade80);
        let endC = new THREE.Color(rating.color);
        let c = startC.clone().lerp(endC, t);
        colors[i * 3]     = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
    }

    let lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    let lineMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2 });
    let line = new THREE.Line(lineGeo, lineMat);
    line.name = '_jumpPreview';
    scene.add(line);
    jumpMeshes.push(line);

    // ── Landing zone ring ──
    let landPos = pts3D[pts3D.length - 1].clone();
    // Snap to terrain
    if (window.localGetTerrainAt) {
        let surf = window.localGetTerrainAt(landPos.x, -landPos.z);
        if (surf) landPos.y = surf.z + 0.1;
    }

    let ringGeo = new THREE.RingGeometry(2.5, 4.0, 32);
    let ringMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(rating.color),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5
    });
    let ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(landPos);
    ring.name = '_jumpLandZone';
    scene.add(ring);
    jumpMeshes.push(ring);

    // ── Apex marker ──
    let apexIdx = 0;
    let maxY = 0;
    for (let i = 0; i < pts3D.length; i++) {
        let relY = pts3D[i].y - startPos.y;
        if (relY > maxY) { maxY = relY; apexIdx = i; }
    }
    let apexPos = pts3D[apexIdx];
    let apexGeo = new THREE.SphereGeometry(0.5, 8, 8);
    let apexMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.7 });
    let apexMesh = new THREE.Mesh(apexGeo, apexMat);
    apexMesh.position.copy(apexPos);
    apexMesh.name = '_jumpApex';
    scene.add(apexMesh);
    jumpMeshes.push(apexMesh);

    // ── Dashed vertical lines at apex and landing ──
    let dashMat = new THREE.LineDashedMaterial({ color: 0x94a3b8, dashSize: 0.5, gapSize: 0.3 });

    // Apex vertical
    let apexTerrY = startPos.y;
    if (window.localGetTerrainAt) {
        let s = window.localGetTerrainAt(apexPos.x, -apexPos.z);
        if (s) apexTerrY = s.z;
    }
    let vLineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(apexPos.x, apexTerrY, apexPos.z),
        new THREE.Vector3(apexPos.x, apexPos.y, apexPos.z)
    ]);
    let vLine = new THREE.Line(vLineGeo, dashMat);
    vLine.computeLineDistances();
    vLine.name = '_jumpDash';
    scene.add(vLine);
    jumpMeshes.push(vLine);
}

function clearPreview() {
    if (!window.scene) return;
    jumpMeshes.forEach(m => {
        window.scene.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    });
    jumpMeshes = [];
}

// ── HUD Panel ──
function createHUD() {
    if (jumpHUD) return;

    jumpHUD = document.createElement('div');
    jumpHUD.id = 'jump-calculator-hud';
    jumpHUD.style.cssText = `
        position: fixed; bottom: 60px; left: 50%; transform: translateX(-50%);
        background: rgba(15,23,42,0.95); border: 1px solid #475569;
        border-radius: 16px; padding: 16px 22px; z-index: 1100;
        backdrop-filter: blur(12px); min-width: 420px;
        font-family: 'Inter','Segoe UI',sans-serif;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        transition: opacity 0.3s;
    `;

    jumpHUD.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
            <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:18px;">🏁</span>
                <span style="color:#fff; font-weight:900; font-size:14px; letter-spacing:1px;">JUMP CALCULATOR</span>
            </div>
            <span id="jump-rating-badge" style="background:#4ade80; color:#0f172a; padding:3px 10px; border-radius:20px; font-weight:800; font-size:11px;">🟢 SMOOTH</span>
        </div>

        <div style="display:flex; gap:16px; margin-bottom:14px;">
            <div style="flex:1;">
                <label style="color:#94a3b8; font-size:9px; text-transform:uppercase; display:block; margin-bottom:4px;">Fart vid rampen</label>
                <div style="display:flex; align-items:center; gap:6px;">
                    <input type="range" id="jump-speed" min="30" max="160" value="80" step="1" style="flex:1; accent-color:#dc2626;">
                    <span id="jump-speed-val" style="color:#fff; font-weight:900; font-size:14px; min-width:55px; text-align:right;">80 km/h</span>
                </div>
            </div>
        </div>

        <div style="display:flex; gap:16px; margin-bottom:14px;">
            <div style="flex:1;">
                <label style="color:#94a3b8; font-size:9px; text-transform:uppercase; display:block; margin-bottom:4px;">Rampvinkel</label>
                <div style="display:flex; align-items:center; gap:6px;">
                    <input type="range" id="jump-angle" min="5" max="55" value="25" step="1" style="flex:1; accent-color:#fbbf24;">
                    <span id="jump-angle-val" style="color:#fff; font-weight:900; font-size:14px; min-width:35px; text-align:right;">25°</span>
                    <span id="jump-angle-rating" style="font-size:9px; padding:2px 6px; border-radius:8px; font-weight:700;">Optimal</span>
                </div>
            </div>
        </div>

        <div style="display:flex; gap:16px; margin-bottom:14px;">
            <div style="flex:1;">
                <label style="color:#94a3b8; font-size:9px; text-transform:uppercase; display:block; margin-bottom:4px;">Landningsslutning</label>
                <div style="display:flex; align-items:center; gap:6px;">
                    <input type="range" id="jump-land-slope" min="-30" max="10" value="0" step="1" style="flex:1; accent-color:#38bdf8;">
                    <span id="jump-land-slope-val" style="color:#fff; font-weight:900; font-size:14px; min-width:35px; text-align:right;">0°</span>
                </div>
            </div>
        </div>

        <div style="height:1px; background:#334155; margin:10px 0;"></div>

        <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:8px; text-align:center;">
            <div style="background:#1e293b; border-radius:10px; padding:8px 4px;">
                <div style="color:#94a3b8; font-size:8px; text-transform:uppercase;">Lufttid</div>
                <div id="jump-stat-airtime" style="color:#fff; font-size:18px; font-weight:900;">1.7s</div>
            </div>
            <div style="background:#1e293b; border-radius:10px; padding:8px 4px;">
                <div style="color:#94a3b8; font-size:8px; text-transform:uppercase;">Hopplängd</div>
                <div id="jump-stat-dist" style="color:#fff; font-size:18px; font-weight:900;">34m</div>
            </div>
            <div style="background:#1e293b; border-radius:10px; padding:8px 4px;">
                <div style="color:#94a3b8; font-size:8px; text-transform:uppercase;">Maxhöjd</div>
                <div id="jump-stat-height" style="color:#38bdf8; font-size:18px; font-weight:900;">4m</div>
            </div>
            <div style="background:#1e293b; border-radius:10px; padding:8px 4px;">
                <div style="color:#94a3b8; font-size:8px; text-transform:uppercase;">Landningsvinkel</div>
                <div id="jump-stat-land" style="color:#4ade80; font-size:18px; font-weight:900;">23°</div>
            </div>
        </div>

        <div style="margin-top:10px; text-align:center;">
            <span id="jump-advice" style="color:#64748b; font-size:11px; font-style:italic;">Klicka på terrängen för att placera hoppet</span>
        </div>
    `;

    document.body.appendChild(jumpHUD);

    // Bind sliders
    document.getElementById('jump-speed').addEventListener('input', function() {
        jumpSpeed = parseInt(this.value);
        document.getElementById('jump-speed-val').textContent = jumpSpeed + ' km/h';
        recalculate();
    });
    document.getElementById('jump-angle').addEventListener('input', function() {
        rampAngle = parseInt(this.value);
        document.getElementById('jump-angle-val').textContent = rampAngle + '°';
        let r = rateRamp(rampAngle);
        let badge = document.getElementById('jump-angle-rating');
        badge.textContent = r.text;
        badge.style.color = r.color;
        badge.style.background = r.color + '22';
        recalculate();
    });
    document.getElementById('jump-land-slope').addEventListener('input', function() {
        landingSlope = parseInt(this.value);
        document.getElementById('jump-land-slope-val').textContent = landingSlope + '°';
        recalculate();
    });
}

function showHUD() {
    if (!jumpHUD) createHUD();
    jumpHUD.style.display = 'block';
    jumpHUD.style.opacity = '1';
    recalculate();
}

function hideHUD() {
    if (jumpHUD) {
        jumpHUD.style.opacity = '0';
        setTimeout(() => { if (jumpHUD) jumpHUD.style.display = 'none'; }, 300);
    }
    clearPreview();
}

// ── Recalculate & update display ──
function recalculate() {
    lastCalc = calculateJump(jumpSpeed, rampAngle, landingSlope);
    let rating = rateJump(lastCalc);

    // Update stats
    let el = (id, val) => { let e = document.getElementById(id); if (e) e.textContent = val; };

    // BUG-09 fix: om hoppet är ogiltigt (negativ flygtid) visa tydlig varning
    if (lastCalc.invalid) {
        el('jump-stat-airtime', '—');
        el('jump-stat-dist',    '—');
        el('jump-stat-height',  '—');
        el('jump-stat-land',    '—');
        let badge = document.getElementById('jump-rating-badge');
        if (badge) { badge.textContent = '⚠️ OGILTIG'; badge.style.background = '#ef4444'; badge.style.color = '#fff'; }
        let advice = document.getElementById('jump-advice');
        if (advice) {
            advice.textContent = '⚠️ Landningssluttningen är brantare än hoppets uppgångsvinkel — bilen landar bakom rampen. Minska landningssluttningen eller öka rampvinkeln.';
            advice.style.color = '#ef4444';
        }
        if (window._jumpPlacementPos && window._jumpPlacementDir) {
            clearPreview(); // Visa ingen 3D-förhandsgranskning för ogiltiga hopp
        }
        return;
    }

    el('jump-stat-airtime', lastCalc.airTime.toFixed(1) + 's');
    el('jump-stat-dist', Math.round(lastCalc.distance) + 'm');
    el('jump-stat-height', lastCalc.maxHeight.toFixed(1) + 'm');
    el('jump-stat-land', Math.abs(lastCalc.landAngle).toFixed(0) + '°');

    // Color the landing angle
    let landEl = document.getElementById('jump-stat-land');
    if (landEl) landEl.style.color = rating.color;

    // Update rating badge
    let badge = document.getElementById('jump-rating-badge');
    if (badge) {
        badge.textContent = rating.emoji + ' ' + rating.label;
        badge.style.background = rating.color;
        badge.style.color = '#0f172a';
    }

    // Advice text
    let advice = document.getElementById('jump-advice');
    if (advice) {
        if (Math.abs(lastCalc.landAngle) > 40) {
            advice.textContent = '⚠️ Landningen är för brant — bilen kraschar. Minska vinkeln eller öka farten.';
            advice.style.color = '#ef4444';
        } else if (Math.abs(lastCalc.landAngle) > 25) {
            advice.textContent = '⚡ Hård landning — spelbar men bilen tappar kontroll en stund.';
            advice.style.color = '#fbbf24';
        } else if (rampAngle > 45) {
            advice.textContent = '🚀 Extrem rampvinkel! Bilen tappar markkontakt. Rekommenderat: 20–35°.';
            advice.style.color = '#fbbf24';
        } else {
            advice.textContent = '✅ Bra hopp! Smidig landning, spelaren behåller kontroll.';
            advice.style.color = '#4ade80';
        }
    }

    // Update 3D preview if we have a placement point
    if (window._jumpPlacementPos && window._jumpPlacementDir) {
        renderTrajectory(lastCalc, window._jumpPlacementPos, window._jumpPlacementDir);
    }
}

// ── Tool Integration: click terrain to place jump ──
window._jumpPlacementPos = null;
window._jumpPlacementDir = null;

window.onJumpToolClick = function(hitPoint) {
    if (!jumpActive) return;
    if (!hitPoint) return;

    window._jumpPlacementPos = new THREE.Vector3(hitPoint.x, hitPoint.y, hitPoint.z);

    // Direction: use camera forward (projected onto XZ plane)
    let cam = window.camera;
    if (cam) {
        let dir = new THREE.Vector3();
        cam.getWorldDirection(dir);
        dir.y = 0;
        dir.normalize();
        window._jumpPlacementDir = dir;
    } else {
        window._jumpPlacementDir = new THREE.Vector3(0, 0, -1);
    }

    // Auto-detect landing slope from terrain
    if (window.localGetTerrainAt && lastCalc) {
        let landX = hitPoint.x + window._jumpPlacementDir.x * lastCalc.distance;
        let landZ = hitPoint.z + window._jumpPlacementDir.z * lastCalc.distance;
        let surf = window.localGetTerrainAt(landX, -landZ);
        let rampSurf = window.localGetTerrainAt(hitPoint.x, -hitPoint.z);
        if (surf && rampSurf) {
            let dh = surf.z - rampSurf.z;
            let autoSlope = Math.atan2(dh, lastCalc.distance) * RAD;
            landingSlope = Math.round(autoSlope);
            let slider = document.getElementById('jump-land-slope');
            if (slider) slider.value = landingSlope;
            let valEl = document.getElementById('jump-land-slope-val');
            if (valEl) valEl.textContent = landingSlope + '°';
        }
    }

    recalculate();
};

// onJumpToolHover: reserved for future terrain-slope assist preview

// ── Activate / Deactivate ──
window.activateJumpTool = function() {
    jumpActive = true;
    showHUD();
};

window.deactivateJumpTool = function() {
    jumpActive = false;
    hideHUD();
    window._jumpPlacementPos = null;
    window._jumpPlacementDir = null;
};

window.isJumpToolActive = function() { return jumpActive; };

console.log('🏁 Jump Calculator tool loaded');
})();
