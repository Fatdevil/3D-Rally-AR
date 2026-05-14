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

        // === WIND-DRIVEN WATER WAVES ===
        if (typeof waterGeo !== 'undefined' && waterGeo && waterGeo.attributes && waterGeo.attributes.position) {
            let wArr = waterGeo.attributes.position.array;
            let windMph = window.currentWindMph || 0;
            let windRad = (window.currentWindDir || 0) * Math.PI / 180;
            let amp = Math.min(windMph * 0.004, 0.15);
            let t = performance.now() * 0.001;
            
            if (amp > 0.001) {
                let wdx = Math.cos(windRad);
                let wdy = Math.sin(windRad);
                for (let i = 0; i < wArr.length; i += 3) {
                    let baseZ = window.waterBaseZ[i / 3];
                    if (baseZ > -90) {
                        let phase = wArr[i] * wdx + wArr[i + 1] * wdy;
                        wArr[i + 2] = baseZ + Math.sin(t * 2.5 + phase * 0.3) * amp;
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