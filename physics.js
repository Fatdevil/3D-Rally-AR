/**
 * GolfBallPhysicsEngine V1
 * En hög-presterande, SI-baserad aerodynamisk simulator
 * Använder numerisk Runge-Kutta 4 (RK4) integration i lokala 3D-kordinater.
 */

window.GolfPhysics = (function() {
    
    // Konstanter (SI Enheter: kg, m, s, rad)
    const GRAVITY = -9.81; // m/s^2
    const MASS = 0.04593; // 45.93 gram (Golfboll standard)
    const RADIUS = 0.021335; // 42.67mm diameter
    const AREA = Math.PI * RADIUS * RADIUS;

    const GROUND = {
        restitution: 0.20,
        bounceFriction: 0.30,
        rollingDecel: 1.18, // Default FAIRWAY (mu=0.12 × 9.81)
        spinDampingPerBounce: 0.85, // Ändrad från 0.75. Mindre direkt spin-död, gör att wedgar spinner mer på greenen (GSPro-stil)
        minBounceVerticalSpeed: 1.0,
        stopSpeed: 0.05 // Sänkt från 0.50. 0.50 kapade av rullningen alldeles för tidigt (~1.1 mph). 0.05 låter bollen rulla ut naturligt.
    };

    // Hjälpfunktioner för miljö och vektorer
    function calculateAirDensity(altFeet, tempC) {
        // Trackman gillar Referens: 0 fot, 25°C -> RHO ≈ 1.184
        let hMeters = altFeet * 0.3048;
        let tempK = tempC + 273.15;
        let p = 101325 * Math.pow(1 - 2.25577e-5 * hMeters, 5.25588);
        return p / (287.05 * tempK);
    }
    
    function vecAdd(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
    function vecSub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
    function vecScale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
    function vecCross(a, b) {
        return [
            a[1]*b[2] - a[2]*b[1],
            a[2]*b[0] - a[0]*b[2],
            a[0]*b[1] - a[1]*b[0]
        ];
    }
    function vecMag(v) { return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); }
    function vecNorm(v) {
        let m = vecMag(v);
        return m === 0 ? [0,0,0] : [v[0]/m, v[1]/m, v[2]/m];
    }

    // Helper för linjär interpolering
    function lerp(a, b, t) {
        return a + (b - a) * Math.max(0, Math.min(1, t));
    }

    // Aerodynamiska koefficient-kurvor (Trackman Data)
    function getDragCoefficient(vMag, spinRateRpm) {
        let cd = 0.235;
        
        // Drag Crisis Re-kurva (Kalibrerad mot Trackman)
        // Fix 4: Surgical C_D curve for each speed bracket:
        //   Driver (55+ m/s): 0.235 → carry 215 yds
        //   Iron (40-55 m/s): 0.24  → carry 185 yds  
        //   Wedge/Lob (<40):  0.26  → carry via C_L balance
        if (vMag > 55) cd = 0.235;
        else if (vMag > 40) cd = lerp(0.26, 0.24, (vMag - 40) / 15);
        else cd = 0.26;
        
        // Spin-dependent drag — Bearman & Harvey (1976) windtunnel data
        // Spin ratio = ω×r / v — higher spin ratio = more drag
        // Driver (2000rpm/130mph): spinRatio ≈ 0.18 → minimal effect
        // Wedge (9000rpm/103mph): spinRatio ≈ 0.44 → significant drag increase
        let omega = (spinRateRpm * 2 * Math.PI) / 60;
        let spinRatio = (omega * RADIUS) / Math.max(vMag, 0.1);
        
        // Activate above spinRatio 0.10 to avoid disturbing low-spin shots
        let cdSpin = spinRatio > 0.10
            ? 0.18 * (spinRatio - 0.10)
            : 0;
        
        return Math.min(cd + cdSpin, 0.55); // Cap against unreasonable values
    }

    function getLiftCoefficient(vMag, spinParam, spinRateRpm) {
        // Världsnyhet: Reverse Magnus Effect
        // Inträffar vid v < 20 m/s och backspin < 2250 rpm
        if (vMag < 20.0 && spinRateRpm > 0 && spinRateRpm <= 2250) {
            // Skapar upp till -0.10 negativt lyft
            let intensity = lerp(1.0, 0.0, spinRateRpm / 2250.0);
            return -0.10 * intensity;
        }
        
        // Trackmans Spin Factor kurva för lift kalibrering
        // Kalibrerad: driver 216y, 7-iron 180y, wedge 130y, lob 75y
        if (spinParam <= 0.08) return lerp(0.00, 0.20, spinParam / 0.08);         // Driver
        if (spinParam <= 0.13) return lerp(0.20, 0.28, (spinParam - 0.08) / 0.05);  // Långa järn
        if (spinParam <= 0.20) return lerp(0.28, 0.32, (spinParam - 0.13) / 0.07);  // Mellanjärn
        if (spinParam <= 0.28) return lerp(0.32, 0.30, (spinParam - 0.20) / 0.08);  // 7-iron → pitch
        if (spinParam <= 0.40) return lerp(0.30, 0.18, (spinParam - 0.28) / 0.12);  // Wedgar
        if (spinParam <= 0.55) return lerp(0.18, 0.06, (spinParam - 0.40) / 0.15);  // Lob
        
        // Extremt spin (>0.55)
        return 0.04;
    }

    function evaluateState(state, dt, dv) {
        let currentV = vecAdd(state.vel, vecScale(dv, dt));
        
        // Stäng av aerodynamik under glid/rullfasen (drivs bara av markens rullmotstånd & lutning)
        if (state.phase === "roll" || state.phase === "skid") {
            let N = state.terrainNormal || [0,0,1];
            let G = [0, 0, GRAVITY];
            let gDotN = G[0]*N[0] + G[1]*N[1] + G[2]*N[2]; // Negativt värde typiskt (-9.81)
            
            // Acceleration down the slope due to gravity component
            let gParallel = [
                G[0] - gDotN * N[0],
                G[1] - gDotN * N[1],
                G[2] - gDotN * N[2]
            ];
            
            let vSpeed = vecMag(currentV);
            let normalForceMag = Math.abs(gDotN); // m/s^2 trycket mot marken
            
            // Rullfriktion härleds antingen från statisk kod (Fairway/Rough) eller dynamisk Stimp (Green)
            let mu = 0.5; // Standard/Fallback
            if (state.terrainType === 'GREEN' && typeof window !== 'undefined' && window.GREEN_STIMP) {
                // Werner & Greig empirisk ekvation + USGA Fysik korrektion (a = mu * g)
                // Stimp 10 (feet) kräver acceleration på ~0.55m/s^2, vilket ger mu = 0.056
                let stimp = window.GREEN_STIMP;
                if (stimp < 6) stimp = 6; if (stimp > 14) stimp = 14;
                mu = 0.056 * (10.0 / stimp); // Spot-on Trackman/USGA matematik
            } else {
                // Omvandla den inkodade rullbromsen (rollingDecel) tillbaka till ett mu-värde för kompatibilitet.
                let currentDecel = state.rollingDecel !== undefined ? state.rollingDecel : GROUND.rollingDecel;
                mu = currentDecel / 9.81;
            }

            let spinTractionMag = 0;

            // Fix 2: Spin-induced roll braking (applies in both roll and skid phases)
            // Determine if spin is backspin or topspin relative to travel direction
            let v_spin = [-state.spin[1] * RADIUS, state.spin[0] * RADIUS, 0];
            let dirXY = vSpeed > 0.001 ? [currentV[0]/vSpeed, currentV[1]/vSpeed] : [0,0];
            let spinDotDir = v_spin[0] * dirXY[0] + v_spin[1] * dirXY[1];
            
            // If spinDotDir > 0, the contact point is moving forward faster than pure sliding -> BACKSPIN
            if (spinDotDir > 0.5) { // Only apply aggressive braking for noticeable backspin
                let spinBrake = Math.min(spinDotDir * 0.50, 8.0);
                spinTractionMag = -spinBrake; // Negative means it adds to effective friction
            } else if (spinDotDir < -0.5) {
                // Topspin could theoretically push the ball forward if slipping
                // For now, just don't brake it artificially.
                spinTractionMag = 0;
            }

            // Kinetisk glidfas ("Skid") har ungefär 50-80% högre friktion än rullfriktion
            if (state.phase === "skid") {
                mu *= 1.7; 
            }
            
            let frictionAccelMag = mu * normalForceMag;
            
            // Skydda mot okontrollerad Topspin-boost - friktionen får aldrig bli negativ
            let effectiveFriction = Math.max(0, frictionAccelMag - spinTractionMag);
            
            // Friktion verkar rakt mot rörelseriktningen parallellt med marken
            let dir = vSpeed > 0.001 ? vecScale(currentV, 1/vSpeed) : [0,0,0];
            let frictionAccel = vecScale(dir, -effectiveFriction);

            // GRASS GRAIN (Pseudorandom vector based on X/Y position)
            if (state.terrainType === 'GREEN') {
                // Skapa en svag ström baserat på position
                let sx = Math.sin(state.pos[0] * 0.3 + state.pos[1] * 0.2);
                let sy = Math.cos(state.pos[1] * 0.3 - state.pos[0] * 0.2);
                let currentStimp = (typeof window !== 'undefined' && window.GREEN_STIMP) ? window.GREEN_STIMP : 10.0;
                let grainAccelScale = 0.03 * (10.0 / currentStimp); // Grain påverkar mer på tröga greener
                
                // Endast tillämpa grain horisontellt (x/y)
                let gl = Math.sqrt(sx*sx + sy*sy + 1e-6);
                frictionAccel[0] += (sx / gl) * grainAccelScale;
                frictionAccel[1] += (sy / gl) * grainAccelScale;
            }
            
            let totalAccel = vecAdd(gParallel, frictionAccel);
            
            if (vSpeed < 0.05 && vecMag(gParallel) < frictionAccelMag) {
                // Farten är nära noll och gravitationssluttningen är för svag för att övervinna friktionen => STILLA
                return { dp: currentV, dv: vecScale(currentV, -1 / dt) }; // Tvingar hastighet till exakt 0
            }
            
            return { dp: currentV, dv: totalAccel };
        }
        // Wind gradient: logarithmic boundary layer profile
        // Higher altitude = stronger wind. Reference height = 10m.
        // At 30m apex: ~27% more wind. At 5m punch: ~20% less wind.
        let heightM = Math.max(0.03, state.pos[2]); // Current ball height
        let z0 = 0.03;   // Surface roughness (grass = 0.03m)
        let refH = 10.0; // Reference measurement height
        let windScale = Math.log(heightM / z0) / Math.log(refH / z0);
        windScale = Math.max(0.0, Math.min(2.0, windScale)); // Clamp 0–2×
        let heightWind = [state.wind[0] * windScale, state.wind[1] * windScale, 0];
        
        let vRel = vecSub(currentV, heightWind); // Relativ hastighet mot luften
        let vRelMag = vecMag(vRel);

        // Vid stillastående verkar bara gravitationen
        if (vRelMag < 0.1) {
            return { dp: currentV, dv: [0, 0, GRAVITY] };
        }

        let spinRate = vecMag(state.spin);
        let spinParam = (RADIUS * spinRate) / Math.max(vRelMag, 1.0); // Förhindra Magnus-singularitet vid låg fart under studsar
        let spinRateRpm = (spinRate * 60) / (2 * Math.PI); // rad/s till rpm

        let Cd = getDragCoefficient(vRelMag, spinRateRpm);
        let Cl = getLiftCoefficient(vRelMag, spinParam, spinRateRpm);

        let activeRho = state.rho || 1.184;

        // Drag Force (F_D)
        let fDragMag = 0.5 * activeRho * AREA * Cd * vRelMag * vRelMag;
        let vRelNorm = vecNorm(vRel);
        let fDrag = vecScale(vRelNorm, -fDragMag);

        // Magnus Force (Lift) (F_L)
        let magnusDir = vecNorm(vecCross(state.spin, vRel));
        let fLiftMag = 0.5 * activeRho * AREA * Cl * vRelMag * vRelMag;
        let fLift = vecScale(magnusDir, fLiftMag);

        // Totalkraft
        let fGravity = [0, 0, MASS * GRAVITY];
        let fTotal = vecAdd(fDrag, vecAdd(fLift, fGravity));

        // Acceleration = F / m
        let accel = vecScale(fTotal, 1/MASS);

        return {
            dp: currentV,
            dv: accel
        };
    }

    function stepRK4(state, dt) {
        let a = evaluateState(state, 0, [0,0,0]);
        let b = evaluateState(state, dt*0.5, a.dv);
        let c = evaluateState(state, dt*0.5, b.dv);
        let d = evaluateState(state, dt, c.dv);

        let dp = vecScale(vecAdd(a.dp, vecAdd(vecScale(b.dp, 2), vecAdd(vecScale(c.dp, 2), d.dp))), 1.0/6.0);
        let dv = vecScale(vecAdd(a.dv, vecAdd(vecScale(b.dv, 2), vecAdd(vecScale(c.dv, 2), d.dv))), 1.0/6.0);

        state.pos = vecAdd(state.pos, vecScale(dp, dt));
        state.vel = vecAdd(state.vel, vecScale(dv, dt));
        
        // Fix 1: Spin decay — increased minimum from 2.8% to 5.0% per second
        // Old: 2.8%-7.0% range gave only 3.6% average → 79% spin at impact (too high)
        // New: 5.0%-7.0% range gives ~6% average → 63% spin at impact (matches Trackman)
        // Verification: 9000 × e^(-0.060 × 6.62) = 9000 × 0.672 = 6048 rpm at landing
        let speedMs = vecMag(state.vel);
        let t_speed = Math.max(0, Math.min(1, (speedMs - 13.4) / (67.0 - 13.4)));
        let decayRate = 0.050 + t_speed * (0.070 - 0.050);
        
        state.spin = vecScale(state.spin, Math.exp(-decayRate * dt)); 
    }

    /**
     * Konverterar mänsklig input (Simulatordata) till matematisk 3D flight path
     * @param {Object} input - { ballSpeedMph, launchAngleDeg, totalSpinRpm, spinAxisDeg, azimDeg }
     * @param {Object} envCtx - { checkCollisionCallback }
     */
    function simulateFlight(input, envCtx) {
        let startPosXZY = input.startPos || [0, 0, 0];
        
        // RISK-01 FIX: Never guess units. Require explicit ballSpeedMph.
        // Old fallback (input.vMag || 0) was dangerous: a vMag in m/s would be
        // treated as mph → 68 m/s driver → 30 m/s → 75 yards instead of 215.
        // If ballSpeedMph is missing, log a clear error and abort with 0 speed.
        let baseSpeedMph = input.ballSpeedMph;
        if (baseSpeedMph === undefined || baseSpeedMph === null) {
            console.warn('[physics] ballSpeedMph saknas i input. Kontrollera att LM-bryggan skickar ballSpeedMph (mph). Använder 0.');
            baseSpeedMph = 0;
        }
        
        // Legacy fields — kept as fallbacks but explicitly documented:
        // spinTotal: old internal field, always in rpm. Safe fallback.
        // vLa, vHla, spinAxis: old internal fields. Safe fallbacks.
        let baseSpinRpm = input.totalSpinRpm !== undefined ? input.totalSpinRpm : (input.spinTotal || 2500);
        let vla = input.launchAngleDeg !== undefined ? input.launchAngleDeg : (input.vLa || 0);
        let azimDegIn = input.azimDeg !== undefined ? input.azimDeg : (input.vHla || 0);
        let spinAxisIn = input.spinAxisDeg !== undefined ? input.spinAxisDeg : (input.spinAxis || 0);
        
        let lieType = 'FAIRWAY';
        if (envCtx) {
            if (envCtx.getTerrainAt) {
                let li = envCtx.getTerrainAt(startPosXZY[0], startPosXZY[1], startPosXZY[2]);
                if (li && li.type) lieType = li.type;
            } else if (envCtx.checkCollisionCallback) {
                let li = envCtx.checkCollisionCallback(0, 0, 0); // Check precisely at origin
                if (li && li.type) lieType = li.type;
            }
        }
        
        let speedMult = 1.0;
        let spinMult = 1.0;
        
        if (!input.isLiveData) {
            // TEE SHOT OVERRIDE: First shot is always perfectly teed up, regardless of terrain color under it.
            if (input.isTeeShot) lieType = 'FAIRWAY';
            
            if (lieType === 'ROUGH') {
                let vlaFactor = Math.max(0, Math.min(1, (vla - 10) / 35)); 
                if (Math.random() < 0.15 && vla > 15) {
                    speedMult = 1.02; spinMult = 0.40;
                    console.log("💥 TRACKMAN FLYER-LIE DETECTED! Zero spin, hot velocity.");
                } else {
                    // Milder penalty for Arcade: max 15% speed loss for Driver, 5% for Wedge
                    speedMult = 1.0 - (0.15 - (0.10 * vlaFactor)); 
                    spinMult = 1.0 - (0.40 - (0.30 * vlaFactor));
                }
            } else if (lieType === 'SEMI-ROUGH') {
                speedMult = 0.98; spinMult = 0.95; 
            } else if (lieType === 'FESCUE') {
                // Fescue: stiff wiry grass wraps clubface — ball exits hot but spinless (flyer-lie)
                let vlaFactor = Math.max(0, Math.min(1, (vla - 10) / 35));
                speedMult = 1.0 - (0.20 - (0.10 * vlaFactor)); // 20% loss driver, 10% wedge (milder than DEEP ROUGH)
                spinMult = 1.0 - (0.65 - (0.45 * vlaFactor));  // 65% spin loss driver, 20% wedge (harder than DEEP ROUGH)
            } else if (lieType === 'DEEP ROUGH') {
                let vlaFactor = Math.max(0, Math.min(1, (vla - 10) / 35)); 
                if (Math.random() < 0.25 && vla > 20) {
                    speedMult = 1.03; spinMult = 0.30;
                    console.log("💥 TRACKMAN FLYER-LIE DETECTED (DEEP ROUGH)! Zero spin, hot velocity.");
                } else {
                    speedMult = 1.0 - (0.25 - (0.15 * vlaFactor));
                    spinMult = 1.0 - (0.60 - (0.40 * vlaFactor));
                }
            } else if (lieType === 'SAND') {
                let vlaFactor = Math.max(0, Math.min(1, (vla - 20) / 30)); 
                speedMult = 1.0 - (0.20 - (0.15 * vlaFactor));
                spinMult = 1.0 - (0.30 - (0.20 * vlaFactor));
            }
        }
        
        let speedMS = (baseSpeedMph * speedMult) * 0.44704; // mph -> m/s
        let spinFinal = baseSpinRpm * spinMult;
        
        let launchRads = vla * Math.PI / 180;
        let azimRads = azimDegIn * Math.PI / 180;
        
        // === SLOPE LAUNCH CORRECTION (Trackman/GSPro parity) ===
        // ALL launch monitors (SkyTrak, Trackman, Mevo, etc.) measure the ball
        // on a FLAT mat — they cannot detect virtual terrain slope.
        // Slope correction must ALWAYS apply to simulate the effect of the
        // virtual lie on the launch conditions.
        let terrainNormal = [0, 0, 1]; // Default: flat
        if (envCtx && envCtx.getTerrainAt) {
            let tStart = envCtx.getTerrainAt(startPosXZY[0], startPosXZY[1], startPosXZY[2]);
            if (tStart && tStart.normal) terrainNormal = tStart.normal;
        }
        
        let slopeForwardDeg = 0;
        let slopeSideDeg = 0;
        
        if (terrainNormal[0] !== 0 || terrainNormal[1] !== 0) {
            // Shot direction in XY plane (normalized)
            let shotDirX = Math.sin(azimRads);
            let shotDirY = Math.cos(azimRads);
            
            // EFFECT 1: Forward/backward slope → launch angle correction
            // Project terrain normal onto shot direction
            // Positive = uphill, negative = downhill
            let slopeForward = terrainNormal[0] * shotDirX + terrainNormal[1] * shotDirY;
            slopeForwardDeg = Math.asin(Math.max(-0.99, Math.min(0.99, -slopeForward))) * 180 / Math.PI;
            // Trackman data: 10% slope (~5.7°) → ~5.9° LA change ≈ 1:1 ratio
            let correctedLaunchDeg = (launchRads * 180 / Math.PI) + slopeForwardDeg;
            correctedLaunchDeg = Math.max(0.5, correctedLaunchDeg); // Floor at 0.5° (can't launch underground)
            launchRads = correctedLaunchDeg * Math.PI / 180;
            
            // EFFECT 2: Side slope → sidespin bias (D-plane lie angle geometry)
            // Perpendicular to shot direction
            let slopeSideX = -shotDirY;
            let slopeSideY =  shotDirX;
            let slopeSide = terrainNormal[0] * slopeSideX + terrainNormal[1] * slopeSideY;
            slopeSideDeg = Math.asin(Math.max(-0.99, Math.min(0.99, slopeSide))) * 180 / Math.PI;
            // Positive slopeSideDeg = ball above feet (RH: draw tendency → negative spinAxis)
            // Negative slopeSideDeg = ball below feet (RH: fade tendency → positive spinAxis)
            // Coefficient 0.65 from D-plane geometry: lie angle tilt × sin(loft)
            spinAxisIn += (-slopeSideDeg * 0.65);
            
            // EFFECT 3: Speed factor from gravity component (marginal)
            // Downhill: +1% per 5° (gravity assist). Uphill: -1% per 5°. Max ±3%.
            let slopeSpeedFactor = 1.0 + Math.max(-0.03, Math.min(0.03, slopeForwardDeg * 0.002));
            speedMS *= slopeSpeedFactor;
            
            console.log(`⛰️ SLOPE LAUNCH: forward=${slopeForwardDeg.toFixed(1)}° side=${slopeSideDeg.toFixed(1)}° | LA: ${vla.toFixed(1)}°→${(launchRads*180/Math.PI).toFixed(1)}° | spinAxis: ${(spinAxisIn - (-slopeSideDeg*0.65)).toFixed(1)}°→${spinAxisIn.toFixed(1)}° | speed×${slopeSpeedFactor.toFixed(3)}`);
        }
        
        // Start hastighetsvektor
        // Y: framåt, X: höger, Z: upp
        let vX = speedMS * Math.cos(launchRads) * Math.sin(azimRads);
        let vY = speedMS * Math.cos(launchRads) * Math.cos(azimRads);
        let vZ = speedMS * Math.sin(launchRads);
        let vel = [vX, vY, vZ];

        // Start spinnvektor (KOMPLETT rotation med azimuth)
        // Backspin-axeln: VINKELRÄT mot flygriktning i XY-planet → ger vertikal Magnus-lyft.
        // Sidespin-axeln: PARALLELL med flygriktning i XY-planet → ger lateral Magnus-krökning.
        // Båda måste roteras med azimuth så att Magnus-krafter alltid är relativa till skottets riktning.
        let wRads = spinFinal * 2 * Math.PI / 60;       // rpm → rad/s
        let spinAxisRads = spinAxisIn * Math.PI / 180;   // deg → rad
        let sBackspin = wRads * Math.cos(spinAxisRads);  // backspin-komponent
        let sSidespin = wRads * Math.sin(spinAxisRads);  // sidespin-komponent (draw/fade)
        
        // Backspin: axel vinkelrät mot flygriktning i XY → ger vertikal Magnus-lyft
        let sX =  sBackspin * Math.cos(azimRads);
        let sY = -sBackspin * Math.sin(azimRads);
        
        // Sidespin: axel parallell med flygriktning i XY → ger lateral krökning
        // RELATIVT skottets riktning, inte world-space. Tecken negeras så att
        // Trackman positiv spinAxis (slice) → höger krökning via Magnus cross-produkt.
        sX -= sSidespin * Math.sin(azimRads);
        sY -= sSidespin * Math.cos(azimRads);
        
        let sZ = 0; // All spin hanteras i roterade XY-komponenter
        let spin = [sX, sY, sZ];
        
        let altFt = (envCtx && envCtx.altitudeFeet !== undefined) ? envCtx.altitudeFeet : 0;
        // Fallback 15°C = USGA/Trackman standard (59°F). Matches matchSettings.temperatureC default.
        // Was 25°C — inconsistent with matchSettings which defaults to 15°C since the temperature fix.
        let tCelsius = (envCtx && envCtx.temperatureC !== undefined) ? envCtx.temperatureC : 15;
        let windVec = (envCtx && envCtx.wind) ? envCtx.wind : [0, 0, 0];
        
        let state = {
            phase: "flight",
            pos: [startPosXZY[0], startPosXZY[1], startPosXZY[2]], 
            vel: vel,
            spin: spin,
            wind: windVec,
            rho: calculateAirDensity(altFt, tCelsius)
        };

        const dt = 0.005; // Intern tick-rate 5ms
        const sampleRate = 0.005; // MÅSTE vara 5ms för att matcha Animation Loops Time-step (100ms kraschade Trackman Look-ahead kameran)
        
        let path = [];
        path.push({ 
            x: startPosXZY[0], y: startPosXZY[1], z: startPosXZY[2], 
            vx: vel[0], vy: vel[1], vz: vel[2],
            time: 0, phase: 'flight' 
        });
        
        let metrics = {
            carryMeters: 0,
            totalMeters: 0,
            apexMeters: 0,
            flightTime: 0,
            totalTime: 0,
            bounceCount: 0,
            finalTerrainType: 'FAIRWAY' // Default
        };

        let t = 0;
        let _dbgFirstGroundHit = false;
        let _dbgTreeHitCount = 0;
        
        // === FORENSICS: Scan terrain heights ahead of ball ===
        if (envCtx && envCtx.getTerrainAt) {
            let scanLog = [];
            let fwdX = vel[0] / (vecMag(vel) || 1);
            let fwdY = vel[1] / (vecMag(vel) || 1);
            for (let d = 0; d <= 250; d += 10) {
                let px = startPosXZY[0] + fwdX * d;
                let py = startPosXZY[1] + fwdY * d;
                let ti = envCtx.getTerrainAt(px, py);
                scanLog.push({ dist: d, terrainZ: ti ? ti.z.toFixed(2) : 'N/A', type: ti ? ti.type : '?' });
            }
            console.log('🔬 TERRAIN SCAN (every 10m ahead):', JSON.stringify(scanLog));
            console.log('🔬 BALL START Z:', startPosXZY[2].toFixed(3), 'TERRAIN AT START Z:', (envCtx.getTerrainAt(startPosXZY[0], startPosXZY[1]) || {z:0}).z.toFixed(3));
        }
        
        // lastSampleTime utfasas till förmån för direkta dt-ticks i path.
        // Simulator-loop
        while (state.phase !== "stopped" && state.phase !== "holed" && t < 25.0) { // Safety break efter max 25 sek in-miljö
            
            // Kolla luft-kollisioner (Träd) innan vi flyttar oss
            // SPAWN IMMUNITY: Give the ball 0.2s to escape a bad lie or tree trunk
            if (t > 0.20 && envCtx && envCtx.checkCollisionCallback && state.phase === "flight") {
                let terrain = envCtx.checkCollisionCallback(state.pos[0], state.pos[1], state.pos[2]);
                if (terrain) {
                    if (terrain.type === 'ROCK' || terrain.type === 'CACTUS' || terrain.part === 'TRUNK') {
                        // Solid krock!
                        console.log(`🏌️‍♂️🪨 SOLID KROCK! Bollen träffade ett hårt objekt (${terrain.type} ${terrain.part || ''})`);
                        
                        // Anti-clipping: Tvinga ut bollen från kollisionshöljet
                        if (terrain.safePos) {
                            state.pos[0] = terrain.safePos[0];
                            state.pos[1] = terrain.safePos[1];
                        }

                        // Trigonometrisk Reflektion (Studs) mot fallets normal
                        if (terrain.n) {
                            let n = terrain.n; // [nx, ny, nz]
                            let vDotN = state.vel[0]*n[0] + state.vel[1]*n[1] + state.vel[2]*n[2];
                            
                            // Studsa enbart om vi fysiskt rör oss in i hindret (dot-product < 0)
                            if (vDotN < 0) {
                                let cor = 0.4; // 40% Bevarad rörelseenergi efter studs
                                state.vel[0] -= (1 + cor) * vDotN * n[0];
                                state.vel[1] -= (1 + cor) * vDotN * n[1];
                                state.vel[2] -= (1 + cor) * vDotN * n[2];
                                
                                // Drag-absorbering från ojämna ytor
                                state.vel[0] *= 0.8;
                                state.vel[1] *= 0.8;
                                state.vel[2] *= 0.8;
                            }
                        } else {
                            // Fallback för ofullständig objekt-data
                            state.vel[0] *= -0.2; 
                            state.vel[1] *= -0.2; 
                        }
                        
                        // Spinn dör tvärt mot solida ytor
                        state.spin = [0,0,0];
                    } else if (terrain.type === 'BUSH') {
                        // Segt buskage drar ner farten sekventiellt (Ej solid)
                        let speedXZ = Math.sqrt(state.vel[0]*state.vel[0] + state.vel[1]*state.vel[1]);
                        if (speedXZ > 2.0 && Math.random() < 0.6) {
                            console.log(`🏌️‍♂️🌿 Bollen rasslade rakt in i en tjock buske!`);
                            state.vel[0] *= 0.4;
                            state.vel[1] *= 0.4;
                            state.vel[2] *= 0.5;
                        }
                    } else if (terrain.type === 'TREE' && terrain.part === 'CANOPY') {
                        let treeHeight = terrain.height || 15.0;
                        if (state.pos[2] < treeHeight && state.pos[2] > 0.1) {
                            let speed = vecMag(state.vel);
                            let distTraveled = speed * dt;
                            
                            // Lövverk: ren volymetrisk sannolikhet
                            let hitProbabilityPerMeter = 0.40; 
                            let currentTickRisk = distTraveled * hitProbabilityPerMeter;
                            
                            _dbgTreeHitCount++;
                            let distFromStart = Math.sqrt((state.pos[0]-startPosXZY[0])**2 + (state.pos[1]-startPosXZY[1])**2);
                            if (_dbgTreeHitCount <= 5) {
                                console.log(`🌲 CANOPY CHECK #${_dbgTreeHitCount}: dist=${distFromStart.toFixed(1)}m, ballZ=${state.pos[2].toFixed(1)}m, treeH=${treeHeight.toFixed(1)}m, risk=${currentTickRisk.toFixed(4)}, speed=${speed.toFixed(1)}m/s`);
                            }
                            
                            if (Math.random() < currentTickRisk) {
                                console.log(`🏌️‍♂️🌲 KROCK! Bollen fastnade i lövverket på höjd: ${state.pos[2].toFixed(1)}m, dist=${distFromStart.toFixed(1)}m, treeHeight=${treeHeight.toFixed(1)}m`);
                                state.vel[0] *= 0.1;
                                state.vel[1] *= 0.1;
                                state.vel[2] = -2.0; // Bollen dröser neråt ruffen
                                state.spin = [0,0,0]; 
                            }
                        }
                    }
                }
            }
            
            // Lägg in en hook för att hämta terränginformation varje tick!
            let tInfo = { z: 0, normal: [0,0,1], type: 'FAIRWAY' };
            if (envCtx && envCtx.getTerrainAt) {
                tInfo = envCtx.getTerrainAt(state.pos[0], state.pos[1], state.pos[2]);
            }
            state.terrainNormal = tInfo.normal;
            
            let prevPos = [...state.pos];
            let prevVel = [...state.vel];
            
            stepRK4(state, dt);
            
            // NYTT: Kolla väggkollision (Sargar)
            if (envCtx && envCtx.checkWallCollision) {
                let wallRes = envCtx.checkWallCollision(prevPos, state.pos, state.vel, dt);
                if (wallRes) {
                    state.pos = wallRes.pos;
                    state.vel = wallRes.vel;
                    if (wallRes.spin) state.spin = wallRes.spin;
                    // Låt phase vara kvar (roll/skid/flight)
                }
            }
            
            // Mark-spinn decay (spin dör ut under Skid/Roll fas tills den matchar rörelsen)
            // Speed-dependent: fast ball sheds spin quickly, slow ball retains spin for braking
            if (state.phase === "skid" || state.phase === "roll") {
                 let rollSpeed = vecMag(state.vel);
                 let decayFactor = 0.3 + Math.min(rollSpeed / 10.0, 1.0) * 0.9; // 0.3 at rest, 1.2 at 10+ m/s
                 let spinDecay = 1.0 - (dt * decayFactor);
                 if (spinDecay < 0) spinDecay = 0;
                 state.spin[0] *= spinDecay;
                 state.spin[1] *= spinDecay;
                 state.spin[2] *= spinDecay;
            }
            
            if (state.phase === "roll" || state.phase === "skid") {
                // BYPASS KOPPEN FÖR ATT INTE TVINGAS TILL GRÄS-YTAN I HÅLET
                let insideCup = false;
                if (envCtx && envCtx.cupPositionLocal) {
                    let dX = state.pos[0] - envCtx.cupPositionLocal[0];
                    let dY = state.pos[1] - envCtx.cupPositionLocal[1];
                    if (dX*dX + dY*dY < 0.054*0.054) insideCup = true;
                }

                if (!insideCup) {
                    // Tvinga bollen att "hug the ground" och uppdatera hastighetsvektor så den är parallell!
                    let freshT = envCtx && envCtx.getTerrainAt ? envCtx.getTerrainAt(state.pos[0], state.pos[1], state.pos[2]) : tInfo;
                    state.pos[2] = freshT.z;
                    
                    let vDotN = state.vel[0]*freshT.normal[0] + state.vel[1]*freshT.normal[1] + state.vel[2]*freshT.normal[2];
                    state.vel[0] -= vDotN * freshT.normal[0];
                    state.vel[1] -= vDotN * freshT.normal[1];
                    state.vel[2] -= vDotN * freshT.normal[2];
                }
            }
            
            t += dt;
            
            // Evaluera Apex
            if (state.pos[2] > metrics.apexMeters) metrics.apexMeters = state.pos[2];

            // Identifiera om vi svävar över koppen
            let overCup = false;
            if (envCtx && envCtx.cupPositionLocal) {
                let dX = state.pos[0] - envCtx.cupPositionLocal[0];
                let dY = state.pos[1] - envCtx.cupPositionLocal[1];
                if (dX*dX + dY*dY < 0.054*0.054) overCup = true;
            }

            // Markkontakt och Fysik-övergång via 3D Slopes (Bypass om vi är över koppen!)
            // Only trigger collision physics if we are falling/bouncing. If already skidding/rolling, we hug the ground naturally.
            if (state.pos[2] <= tInfo.z && (state.phase === "flight" || state.phase === "bounce") && !overCup) {
                
                // === FORENSICS: Log first ground collision ===
                if (!_dbgFirstGroundHit && state.phase === 'flight') {
                    _dbgFirstGroundHit = true;
                    let distFromStart = Math.sqrt((state.pos[0]-startPosXZY[0])**2 + (state.pos[1]-startPosXZY[1])**2);
                    console.log('🔬 FIRST GROUND HIT:', JSON.stringify({
                        time: t.toFixed(3),
                        distFromStartM: distFromStart.toFixed(1),
                        distFromStartYds: (distFromStart * 1.09361).toFixed(1),
                        ballZ: state.pos[2].toFixed(3),
                        terrainZ: tInfo.z.toFixed(3),
                        prevBallZ: prevPos[2].toFixed(3),
                        terrainType: tInfo.type,
                        ballPos: { x: state.pos[0].toFixed(2), y: state.pos[1].toFixed(2) },
                        velZ: state.vel[2].toFixed(2),
                        treeHitsBeforeGround: _dbgTreeHitCount
                    }));
                }
                
                // 1. Beräkna den exakta tidpunkten då bollen dök igenom z-kartan
                let travelZ = prevPos[2] - state.pos[2];
                let f = travelZ > 0.0001 ? (prevPos[2] - tInfo.z) / travelZ : 0; 
                
                // 2. Interpolera en exakt nerslagspunkt
                let impactPos = [
                    prevPos[0] + (state.pos[0] - prevPos[0]) * f,
                    prevPos[1] + (state.pos[1] - prevPos[1]) * f,
                    tInfo.z
                ];
                let impactVel = [
                    prevVel[0] + (state.vel[0] - prevVel[0]) * f,
                    prevVel[1] + (state.vel[1] - prevVel[1]) * f,
                    prevVel[2] + (state.vel[2] - prevVel[2]) * f
                ];
                
                let rawUncorrectedZ = state.pos[2];

                state.pos = [...impactPos];
                state.vel = [...impactVel];
                
                if (metrics.bounceCount === 0 && state.phase === 'flight') {
                    metrics.carryMeters = Math.sqrt((state.pos[0]-startPosXZY[0])*(state.pos[0]-startPosXZY[0]) + (state.pos[1]-startPosXZY[1])*(state.pos[1]-startPosXZY[1]));
                }
                
                // Bestäm markens fysikegenskaper
                let impactTerrainType = tInfo.type || 'FAIRWAY';
                if (envCtx && envCtx.checkCollisionCallback) {
                    // BUG-03 FIX: Pass actual impact height (was hardcoded 0) so
                    // cylinder/sphere/tree physics use correct height for collision.
                    let impactRes = envCtx.checkCollisionCallback(impactPos[0], impactPos[1], impactPos[2]);
                    if (impactRes && impactRes.type) impactTerrainType = impactRes.type;
                }
                
                // Beräkna infallsvinkel (0° = lodrätt, 90° = horisontell längs marken)
                let N = tInfo.normal;
                let vMagImpact = vecMag(impactVel);
                let vDotN_impact = impactVel[0]*N[0] + impactVel[1]*N[1] + impactVel[2]*N[2];
                let incidenceAngleDeg = 90.0;
                if (vMagImpact > 0.001) {
                    incidenceAngleDeg = 90.0 - Math.acos(Math.abs(vDotN_impact) / vMagImpact) * (180.0/Math.PI);
                }
                
                let baseCor = GROUND.restitution;
                let cFriction = GROUND.bounceFriction;
                let cRollingDecel = GROUND.rollingDecel;
                
                if (impactTerrainType === 'GREEN') {
                    // Mjukhet baserad på inställningar
                    let firmness = (typeof window !== 'undefined' && window.matchSettings) ? window.matchSettings.greenFirmness : 'NORMAL';
                    if (firmness === 'SOFT') {
                        baseCor = 0.52; cFriction = 0.20; cRollingDecel = 0.5;
                    } else if (firmness === 'FIRM') {
                        baseCor = 0.72; cFriction = 0.10; cRollingDecel = 0.5;
                    } else {
                        // NORMAL fallback
                        baseCor = 0.62; cFriction = 0.15; cRollingDecel = 0.5;
                    }
                } else if (impactTerrainType === 'TEE' || impactTerrainType === 'FAIRWAY') {
                    baseCor = 0.58; cFriction = 0.15; cRollingDecel = 1.18; // roll_mu 0.12
                } else if (impactTerrainType === 'FOREGREEN') {
                    baseCor = 0.60; cFriction = 0.14; cRollingDecel = 0.88; // Between green and fairway (apron cut)
                } else if (impactTerrainType === 'SEMI-ROUGH') {
                    baseCor = 0.50; cFriction = 0.20; cRollingDecel = 2.16; // roll_mu 0.22
                } else if (impactTerrainType === 'ROUGH') {
                    baseCor = 0.43; cFriction = 0.25; cRollingDecel = 3.92; // roll_mu 0.40
                } else if (impactTerrainType === 'FESCUE') {
                    baseCor = 0.38; cFriction = 0.30; cRollingDecel = 4.50; // roll_mu 0.46 — between rough and deep rough
                } else if (impactTerrainType === 'DEEP ROUGH') {
                    baseCor = 0.35; cFriction = 0.35; cRollingDecel = 5.89; // roll_mu 0.60
                } else if (impactTerrainType === 'SAND') {
                    baseCor = 0.30; cFriction = 0.50; cRollingDecel = 6.38; // roll_mu 0.65
                } else if (impactTerrainType === 'WASTE') {
                    baseCor = 0.32; cFriction = 0.25; cRollingDecel = 2.16; // roll_mu 0.22
                }
                
                // Variabel COR-ekvation (Sports Engineering 2023)
                // En brant infallsvinkel (0-20°) droppar COR. Flack vinkel (60-90°) behåller hastigheten.
                let cRestitution = Math.max(0.05, baseCor - 0.004 * incidenceAngleDeg);
                
                if (impactTerrainType === 'WATER') {
                    // WATER SKIMMING TRACKMAN MACKA!
                    let vZ = state.vel[2];
                    let vXY = Math.sqrt(state.vel[0]*state.vel[0] + state.vel[1]*state.vel[1]);
                    // Bollen måste sjunka för att landAngle ska räknas
                    let landAngleRad = vZ < 0 ? Math.atan2(Math.abs(vZ), vXY) : 1.0; 
                    let landAngleDeg = landAngleRad * 180 / Math.PI;
                    let vMagImpact = Math.sqrt(vXY*vXY + vZ*vZ);
                    
                    // Om inkommande vinkel är extremt låg (<15°) och farten är hög (>18 m/s), skimmar vi på vattnet
                    if (landAngleDeg < 15.0 && vMagImpact > 18.0 && state.phase === "flight") {
                        console.log(`💦 VATTENSKIMMING! Vinkel in: ${landAngleDeg.toFixed(1)}°. Fart: ${vMagImpact.toFixed(1)} m/s`);
                        // Deflektera hårt (massive energiförlust)
                        cRestitution = 0.15; 
                        cFriction = 0.90; // Vattnet greppar bollen och dödar all spinn omedelbart
                        cRollingDecel = 30.0;
                    } else {
                        state.phase = "stopped";
                        metrics.finalTerrainType = 'WATER';
                        continue; // Plask!
                    }
                } else if (impactTerrainType === 'OB') {
                    state.phase = "stopped";
                    metrics.finalTerrainType = 'OB';
                    continue; // Död (Utanför banan)!
                }
                
                state.rollingDecel = cRollingDecel;
                metrics.finalTerrainType = impactTerrainType;
                state.terrainType = impactTerrainType; // Spara ner det i staten
                
                if (state.phase === "flight" || state.phase === "bounce") {
                    if (state.phase === "flight") {
                        metrics.carryMeters = Math.sqrt((state.pos[0]-startPosXZY[0])*(state.pos[0]-startPosXZY[0]) + (state.pos[1]-startPosXZY[1])*(state.pos[1]-startPosXZY[1]));
                        metrics.flightTime = t - dt + f * dt;
                        
                        console.log(`⛳ IMPACT DATA (${impactTerrainType}) ⛳`);
                        console.log("Impact Vel Z: " + state.vel[2].toFixed(2) + " m/s");
                        console.log("Spinn vid impact: " + ((vecMag(state.spin)*60)/(2*Math.PI)).toFixed(0) + " RPM");
                    }
                    
                    // 3D Vektor Reflektion mot lutningen (tInfo.normal)
                    let N = tInfo.normal;
                    let V = [...impactVel];
                    let vDotN = V[0]*N[0] + V[1]*N[1] + V[2]*N[2];
                    
                    let vPerp = vecScale(N, vDotN);  // Vektor rakt in i marken
                    let vTan = vecSub(V, vPerp);     // Hastighet längs ytan
                    
                    // Angle-dependent tangential restitution (Sports Engineering 2023)
                    // Steep impacts lose more tangential speed than shallow ones
                    // Values account for coexistence with Penner spin-bite model (line 702+)
                    // Green firmness affects tangential retention:
                    //   SOFT: ball digs in → less tangential speed retained
                    //   FIRM: ball skips off → more tangential speed retained
                    let greenE_T = 0.50; // NORMAL default (squared curve: at 35° → e_t=0.697)
                    if (impactTerrainType === 'GREEN') {
                        let firmness = (typeof window !== 'undefined' && window.matchSettings) ? window.matchSettings.greenFirmness : 'NORMAL';
                        if (firmness === 'SOFT') greenE_T = 0.38;   // More absorption
                        else if (firmness === 'FIRM') greenE_T = 0.60; // More skip
                    }
                    const E_T_BASE = {
                        'GREEN': greenE_T, 'FOREGREEN': 0.55, 'FAIRWAY': 0.58, 'TEE': 0.58,
                        'SEMI-ROUGH': 0.45, 'ROUGH': 0.35, 'DEEP ROUGH': 0.25, 'FESCUE': 0.25,
                        'SAND': 0.20, 'WASTE': 0.52
                    };
                    let e_t_base = E_T_BASE[impactTerrainType] || 0.78;
                    // Shallow angles (putts) should retain nearly all tangential speed
                    // At 0° (pure roll): e_t = 1.0 (no energy loss)
                    // At 45° (steep impact): e_t = e_t_base (full restitution effect)
                    // Squared curve: gentle at low angles, aggressive at high angles
                    let angleFactor = Math.min(1.0, incidenceAngleDeg / 45.0);
                    angleFactor = angleFactor * angleFactor; // Squared: gentle for putts, steep for wedges
                    let e_t = 1.0 - angleFactor * (1.0 - e_t_base);
                    // Floor: 0.40 for most surfaces, 0.15 for fescue (steep angles check the ball hard)
                    let e_t_floor = (impactTerrainType === 'FESCUE') ? 0.15 : 0.40;
                    e_t = Math.max(e_t_floor, e_t);
                    // Putt 1.5°:  factor=0.001 → e_t=0.999 (zero loss)
                    // Chip 10°:   factor=0.049 → e_t=0.988
                    // 7-iron 25°: factor=0.309 → e_t=0.932 (fairway 0.88→0.963)
                    // Wedge 35°:  factor=0.605 → e_t=0.849 (green 0.75→0.849)
                    // Driver 38°: factor=0.713 → e_t=0.914 (fairway 0.88→0.914)
                    
                    // Bounce Physics
                    let bounceVel = vecAdd(
                        vecScale(vPerp, -cRestitution),  // Normal forces push out
                        vecScale(vTan, e_t)              // Angle-dependent tangential restitution
                    );

                    // Fysiskt korrekt spin-bite på lutningar inspirerat av Penner
                    // Green firmness affects grip: SOFT grips more (spin bites deeper)
                    let GRIP = 0.85; // Non-green default
                    if (impactTerrainType === 'GREEN') {
                        let firmness = (typeof window !== 'undefined' && window.matchSettings) ? window.matchSettings.greenFirmness : 'NORMAL';
                        if (firmness === 'SOFT') GRIP = 1.0;        // Maximum grip — ball digs in
                        else if (firmness === 'FIRM') GRIP = 0.92;  // Less grip — ball skips
                        else GRIP = 0.98;                           // NORMAL
                    }
                    let vContactY = V[1] + (state.spin[0] * RADIUS);
                    let vContactX = V[0] - (state.spin[1] * RADIUS);
                    
                    // Energi överförs mellan translation (spinoff) och rotation (bite)
                    let deltaVY = -(vContactY) / 3.5 * GRIP;
                    let deltaVX = -(vContactX) / 3.5 * GRIP;

                    bounceVel[1] += deltaVY;
                    bounceVel[0] += deltaVX;

                    state.spin[0] += (2.5 * deltaVY / RADIUS);
                    state.spin[1] -= (2.5 * deltaVX / RADIUS); 

                    state.vel = bounceVel;
                    // Green firmness affects spin retention per bounce:
                    //   SOFT: more spin survives (ball embeds slightly, gentler impact)
                    //   FIRM: less spin survives (harder impact kills spin faster)
                    let spinDamp = GROUND.spinDampingPerBounce; // 0.85 default
                    if (impactTerrainType === 'GREEN') {
                        let firmness = (typeof window !== 'undefined' && window.matchSettings) ? window.matchSettings.greenFirmness : 'NORMAL';
                        if (firmness === 'SOFT') spinDamp = 0.90;   // More spin retained
                        else if (firmness === 'FIRM') spinDamp = 0.78; // Less spin retained
                    }
                    state.spin = vecScale(state.spin, spinDamp);
                    
                    // Är studsen för mjuk uppåt längs ytan? => Rullfas
                    let bounceZMag = vecMag(vecScale(vPerp, -cRestitution));
                    if (bounceZMag < GROUND.minBounceVerticalSpeed || impactTerrainType === 'SAND') {
                        // Greener genererar mer skid eftersom kinetisk gräsfriktion måste överkommas först
                        if (impactTerrainType === 'GREEN') {
                            state.phase = "skid"; 
                        } else {
                            state.phase = "roll";
                        }
                        
                        // Tvinga hastigheten att vara helt parallell med ytan (nolla vDotN lokalt)
                        let newVDotN = state.vel[0]*N[0] + state.vel[1]*N[1] + state.vel[2]*N[2];
                        state.vel = [
                            state.vel[0] - newVDotN * N[0],
                            state.vel[1] - newVDotN * N[1],
                            state.vel[2] - newVDotN * N[2]
                        ];
                    } else {
                        state.phase = "bounce";
                        metrics.bounceCount++;
                    }
                }
                // (Skid/roll transitions handled below)
            } // END COLLISION BLOCK

            // Phase transitions for ground movement
            if (state.phase === "skid" || state.phase === "roll") {
                // Tvinga bollen att "hug the ground" under rullning (följa backar)
                let freshT = envCtx && envCtx.getTerrainAt ? envCtx.getTerrainAt(state.pos[0], state.pos[1], state.pos[2]) : tInfo;
                
                // Om vi svävar exakt över koppen, låt bli att tvinga upp den till marknivå
                let overCup = false;
                if (envCtx && envCtx.cupPositionLocal) {
                    let dX = state.pos[0] - envCtx.cupPositionLocal[0];
                    let dY = state.pos[1] - envCtx.cupPositionLocal[1];
                    if (dX*dX + dY*dY < 0.054*0.054) overCup = true;
                }

                if (!overCup) {
                    // WATER HAZARD CHECK: Ball rolling/skidding into water = splash!
                    if (freshT.type === 'WATER') {
                        state.phase = "stopped";
                        state.vel = [0, 0, 0];
                        metrics.finalTerrainType = 'WATER';
                        console.log(`💦 WATER HAZARD! Ball rolled into water at [${state.pos[0].toFixed(1)}, ${state.pos[1].toFixed(1)}]`);
                        continue;
                    }
                    
                    state.pos[2] = freshT.z; // Fix: Clamp to ground
                    
                    // Projicera hastigheten längs markens lutning
                    let dot = state.vel[0]*freshT.normal[0] + state.vel[1]*freshT.normal[1] + state.vel[2]*freshT.normal[2];
                    state.vel[0] -= dot * freshT.normal[0];
                    state.vel[1] -= dot * freshT.normal[1];
                    state.vel[2] -= dot * freshT.normal[2];
                }

                let speedXY = vecMag(state.vel);
                
                // Övergång Skid -> Roll
                // BUG-05 FIX: Surface-specific skid→roll threshold.
                // Previous universal 2.0 m/s was too high for fast greens (Stimp 12+).
                if (state.phase === "skid") {
                    // Så länge forward speed skiljer sig drastiskt från spinn-speed, sladdar vi!
                    let spinSpeed = Math.sqrt(state.spin[0]*state.spin[0] + state.spin[1]*state.spin[1]) * RADIUS;
                    const SKID_TO_ROLL_THRESHOLD = {
                        'GREEN':      0.8,  // Fast surface: low threshold
                        'TEE':        1.0,
                        'FAIRWAY':    1.5,
                        'SEMI-ROUGH': 1.8,
                        'ROUGH':      2.0,
                        'DEEP ROUGH': 2.5,
                        'SAND':       2.5,
                        'WASTE':      1.5,
                    };
                    let skidThreshold = SKID_TO_ROLL_THRESHOLD[state.terrainType] || 1.5;
                    if (Math.abs(speedXY - spinSpeed) < skidThreshold || speedXY < skidThreshold) {
                        state.phase = "roll"; // Hjulet har fått fäste!
                    }
                }

                if (speedXY < GROUND.stopSpeed) {
                    state.phase = "stopped";
                    state.vel = [0, 0, 0];
                }
            }

            // --- KOLLA HÅLET (CUP INTERACTION - 3D RATTLE) ---
            if (envCtx && envCtx.cupPositionLocal && (state.phase === 'roll' || state.phase === 'skid' || state.phase === 'flight')) {
                // Hålets golv ligger vanligtvis ca 10.8 cm (0.108m) under ytan
                let cupBottomZ = tInfo.z - 0.108;
                let isBelowGround = state.pos[2] < tInfo.z;
                let isInsideCupVolume = state.pos[2] >= cupBottomZ;

                let dX = state.pos[0] - envCtx.cupPositionLocal[0];
                let dY = state.pos[1] - envCtx.cupPositionLocal[1];
                let distToCenter = Math.sqrt(dX*dX + dY*dY);

                // Är vi i närheten av koppen ovanifrån (margin of error för hopp)
                if (state.pos[2] <= (tInfo.z + 0.08) && !isBelowGround && distToCenter < 0.054) {
                    let speedXY = vecMag([state.vel[0], state.vel[1], 0]);
                    let offsetFactor = distToCenter / 0.054; 
                    
                    let captureThreshold = 1.63 - (offsetFactor * 0.7); 
                    
                    if (speedXY <= captureThreshold || (state.phase !== 'roll' && state.phase !== 'skid' && state.vel[2] < 0)) {
                        // Vi ramlar i hålet! Tillåt gravitation att verka
                        state.phase = "flight"; 
                        // Tryck bollen nedåt direkt för att undvika konstig lip-hanging
                        if (state.vel[2] >= 0) state.vel[2] = -0.5;
                    } else if (speedXY > captureThreshold && speedXY <= 2.2 && offsetFactor > 0.3) {
                        // LIP OUT!
                        console.log("😥 LIP OUT! Fart: " + speedXY.toFixed(2) + " m/s, Offset: " + offsetFactor.toFixed(2));
                        state.vel[0] = state.vel[0] * 0.4 + (dX * 18.0);
                        state.vel[1] = state.vel[1] * 0.4 + (dY * 18.0);
                        state.pos[0] += (dX / distToCenter) * 0.02;
                        state.pos[1] += (dY / distToCenter) * 0.02;
                        // BUG-06 FIX: A ball in skid phase gliding into the cup should
                        // not receive an upward vel[2] = +0.5 bounce — it is already
                        // ground-hugging. Only apply the upward kick for flight/bounce phases.
                        if (state.phase !== 'skid') {
                            state.vel[2] = 0.5;
                            state.phase = "bounce";
                        } else {
                            // Skid lip-out: tangential deflection only, stay on ground
                            state.phase = "roll";
                        }
                    }
                } 
                // Om vi redan ÄR nere i hålet (under markytan Z)
                else if (isBelowGround && isInsideCupVolume && distToCenter < 0.055) {
                    let dX = state.pos[0] - envCtx.cupPositionLocal[0];
                    let dY = state.pos[1] - envCtx.cupPositionLocal[1];
                    let distToCenter = Math.sqrt(dX*dX + dY*dY);

                    // Studs mot hålets plastiga innervägg (radie 54mm = 0.054)
                    if (distToCenter > 0.032) { // Bollen (radie 21mm) träffar väggen när centrum är ca 32mm från center
                        // Rebound mot väggen (elastisk collision)
                        let nX = dX / distToCenter;
                        let nY = dY / distToCenter;
                        
                        let vDotN = state.vel[0]*nX + state.vel[1]*nY;
                        if (vDotN > 0) {
                            state.vel[0] -= 1.6 * vDotN * nX; // Studs (restitution 0.6)
                            state.vel[1] -= 1.6 * vDotN * nY;
                            // Sänk fart och drag in den lätt mot mitten
                            state.vel[0] *= 0.8;
                            state.vel[1] *= 0.8;
                        }
                        // Dra tillbaka innanför väggen
                        state.pos[0] = envCtx.cupPositionLocal[0] + nX * 0.031;
                        state.pos[1] = envCtx.cupPositionLocal[1] + nY * 0.031;
                    }
                    
                    // Slutligen, om bollen ligger på botten
                    if (state.pos[2] <= cupBottomZ + 0.021) { // 21mm bollradie
                        state.pos[2] = cupBottomZ + 0.021;
                        metrics.holed = true;
                        state.phase = "holed";
                        state.vel = [0,0,0];
                        state.spin = [0,0,0];
                        console.log("⛳ HÅLAD (Till botten)!");
                    } else {
                        state.phase = "flight"; // Fortsätt falla fritt mellan väggarna
                    }
                }
            }

            path.push({ 
                x: state.pos[0], y: state.pos[1], z: state.pos[2], 
                vx: state.vel[0], vy: state.vel[1], vz: state.vel[2],
                time: t, phase: state.phase 
            });
        }

        
        metrics.totalMeters = Math.sqrt((state.pos[0]-startPosXZY[0])*(state.pos[0]-startPosXZY[0]) + (state.pos[1]-startPosXZY[1])*(state.pos[1]-startPosXZY[1]));
        metrics.totalTime = t;

        return { path: path, metrics: metrics };
    }

    return {
        simulateFlight: simulateFlight
    };
})();
