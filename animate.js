    function animate() {
        requestAnimationFrame(animate);
        if (window.animateStars) window.animateStars();
        if (window.ParticleEngine) window.ParticleEngine.update(0.016);
        if (window.WindSway) window.WindSway.update(performance.now() * 0.001);
        if (window.AutumnLeaves) window.AutumnLeaves.update(0.016);

        // Panning movement (WASD) — Builder camera controls
        if(moveDir) {
            let altOffset = Math.max(0, camera.position.y - 10);
            let speed = 0.4 + (altOffset * 0.03);
            if (speed > 15.0) speed = 15.0;
            
            let forward = new THREE.Vector3();
            camera.getWorldDirection(forward);
            forward.y = 0;
            if(forward.lengthSq() > 0) forward.normalize();
            else forward.set(0,0,-1);
            
            let right = new THREE.Vector3();
            right.crossVectors(forward, camera.up).normalize();
            
            let shift = new THREE.Vector3();
            if(moveDir === 'W') shift.copy(forward).multiplyScalar(speed);
            else if(moveDir === 'S') shift.copy(forward).multiplyScalar(-speed);
            else if(moveDir === 'A') shift.copy(right).multiplyScalar(-speed);
            else if(moveDir === 'D') shift.copy(right).multiplyScalar(speed);
            
            controls.target.add(shift);
            camera.position.add(shift);
        }
        
        controls.update();

        applySculpting();

        if (typeof waterGeo !== 'undefined' && waterGeo && waterGeo.attributes && waterGeo.attributes.position) {
            let wArr = waterGeo.attributes.position.array;
            let windMph = window.currentWindMph || 0;
            let windRad = (window.currentWindDir || 0) * Math.PI / 180;
            let amp = Math.min(windMph * 0.004, 0.15);
            let t = performance.now() * 0.001;
            
            if (amp > 0.001) {
                let wdx = Math.cos(windRad);
                let wdy = Math.sin(windRad);
                let wSegsL = waterGeo.parameters ? waterGeo.parameters.widthSegments : 50;
                let tSegsL = window.TERRAIN_SEGS || 600;
                let halfL = (waterGeo.parameters ? waterGeo.parameters.width : (window.TERRAIN_SIZE || 900)) / 2;
                let wStepL = halfL * 2 / wSegsL;
                let tStepL = halfL * 2 / tSegsL;
                for (let wz = 0; wz <= wSegsL; wz++) {
                    for (let wx = 0; wx <= wSegsL; wx++) {
                        let vi = (wz * (wSegsL + 1) + wx) * 3;
                        let worldX = -halfL + wx * wStepL;
                        let worldZ = -halfL + wz * wStepL;
                        let txI = Math.min(tSegsL, Math.max(0, Math.round((worldX + halfL) / tStepL)));
                        let tzI = Math.min(tSegsL, Math.max(0, Math.round((worldZ + halfL) / tStepL)));
                        let tIdx = tzI * (tSegsL + 1) + txI;
                        let baseZ = window.waterBaseZ[tIdx];
                        if (baseZ > -90) {
                            let phase = wArr[vi] * wdx + wArr[vi + 1] * wdy;
                            wArr[vi + 2] = baseZ + Math.sin(t * 2.5 + phase * 0.3) * amp;
                        }
                    }
                }
                waterGeo.attributes.position.needsUpdate = true;
            }
        }

        renderer.clear();
        renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
        renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);
    }
    
    // Initialize auth before loading level
    if (window.GolfAuth) {
        window.GolfAuth.init().then(() => {
            console.log('🔑 Auth initialized, loading level...');
            loadLevel();
        }).catch(() => {
            console.warn('Auth init failed, loading level anyway...');
            loadLevel();
        });
    } else {
        // No auth module — load directly
        loadLevel();
    }