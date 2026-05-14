// ================================================================
//  PARTICLE ENGINE — Dual-Layer: Biome + Weather
//  Zero polygons. Uses THREE.Points (GPU-instanced vertices).
//
//  Two independent particle systems run simultaneously:
//    BIOME layer: Driven by terrain theme (AUTUMN leaves, DESERT sand, etc.)
//    WEATHER layer: Driven by weather setting (RAIN, STORM, etc.)
//
//  Depends on: THREE (global)
//
//  Exposes:
//  - window.ParticleEngine.init(scene, camera)
//  - window.ParticleEngine.setEnabled(bool)
//  - window.ParticleEngine.isEnabled()
//  - window.ParticleEngine.setIntensity(0–1)
//  - window.ParticleEngine.getIntensity()
//  - window.ParticleEngine.activateBiome(biomeKey)
//  - window.ParticleEngine.setWeather(weatherKey)
//  - window.ParticleEngine.getWeather()
//  - window.ParticleEngine.update(deltaTime)
//  - window.ParticleEngine.dispose()
// ================================================================
(function() {
    'use strict';

    let _scene       = null;
    let _camera      = null;
    let _enabled     = true;
    let _intensity   = 0.6;
    let _sizeMultiplier = 1.0;  // 0.3 = tiny, 1.0 = normal, 3.0 = huge
    let _clock       = 0;
    let _initialized = false;

    // === DUAL LAYER STATE ===
    // Biome layer (leaves, pollen, sand, etc.)
    let _biomeLayer  = null;   // { key, preset, mesh, positions, velocities, colors, sizes, count }
    // Weather layer (rain, storm, etc.)
    let _weatherLayer = null;
    let _activeWeather = 'CLEAR';

    const MAX_BIOME_PARTICLES  = 500;
    const MAX_WEATHER_PARTICLES = 600;

    // ---------------------------------------------------------------
    // BIOME PARTICLE PRESETS (terrain-driven)
    // ---------------------------------------------------------------
    const BIOME_PARTICLES = {
        AUTUMN: {
            type: 'falling',
            colors: [[0.85, 0.45, 0.10], [0.95, 0.65, 0.15], [0.75, 0.25, 0.05], [0.90, 0.30, 0.10], [0.80, 0.55, 0.20]],
            sizeMin: 1.5, sizeMax: 3.5,
            speedMin: 0.3, speedMax: 1.0,
            drift: 0.6, spin: true,
            spawnHeight: [30, 60],
            label: '🍂 Falling Leaves'
        },
        SNOW: {
            type: 'falling',
            colors: [[1.0, 1.0, 1.0], [0.9, 0.95, 1.0], [0.85, 0.90, 0.98]],
            sizeMin: 1.0, sizeMax: 2.5,
            speedMin: 0.15, speedMax: 0.5,
            drift: 0.3, spin: false,
            spawnHeight: [40, 80],
            label: '❄️ Snowfall'
        },
        WINTER: {
            type: 'falling',
            colors: [[1.0, 1.0, 1.0], [0.9, 0.95, 1.0]],
            sizeMin: 1.0, sizeMax: 2.0,
            speedMin: 0.2, speedMax: 0.6,
            drift: 0.4, spin: false,
            spawnHeight: [40, 80],
            label: '❄️ Snow'
        },
        TROPICAL: {
            type: 'floating',
            colors: [[1.0, 1.0, 0.6], [0.8, 1.0, 0.5], [1.0, 0.9, 0.4]],
            sizeMin: 0.8, sizeMax: 1.5,
            speedMin: 0.05, speedMax: 0.15,
            drift: 0.8, spin: false,
            spawnHeight: [2, 20],
            label: '✨ Pollen'
        },
        ISLAND: {
            type: 'floating',
            colors: [[1.0, 1.0, 0.7], [0.9, 1.0, 0.6]],
            sizeMin: 0.6, sizeMax: 1.2,
            speedMin: 0.05, speedMax: 0.15,
            drift: 0.6, spin: false,
            spawnHeight: [2, 15],
            label: '✨ Sea Breeze'
        },
        DESERT: {
            type: 'floating',
            colors: [[0.85, 0.75, 0.55], [0.9, 0.80, 0.60], [0.75, 0.65, 0.45]],
            sizeMin: 0.5, sizeMax: 1.5,
            speedMin: 0.1, speedMax: 0.4,
            drift: 1.2, spin: false,
            spawnHeight: [1, 10],
            label: '🏜️ Sand Dust'
        },
        MOON: {
            type: 'floating',
            colors: [[0.4, 0.5, 0.7], [0.3, 0.4, 0.6], [0.5, 0.6, 0.8]],
            sizeMin: 0.5, sizeMax: 1.0,
            speedMin: 0.02, speedMax: 0.08,
            drift: 0.2, spin: false,
            spawnHeight: [2, 25],
            label: '🌙 Moon Dust'
        },
        CANDY: {
            type: 'floating',
            colors: [[1.0, 0.4, 0.6], [0.4, 0.8, 1.0], [1.0, 0.9, 0.2], [0.6, 1.0, 0.5], [0.8, 0.4, 1.0]],
            sizeMin: 1.0, sizeMax: 2.5,
            speedMin: 0.05, speedMax: 0.2,
            drift: 0.5, spin: true,
            spawnHeight: [3, 25],
            label: '🍬 Sparkle'
        },
        FIREFLY: {
            type: 'firefly',
            colors: [[0.4, 1.0, 0.2], [0.6, 1.0, 0.1], [0.3, 0.9, 0.3]],
            sizeMin: 1.5, sizeMax: 3.0,
            speedMin: 0.05, speedMax: 0.2,
            drift: 1.0, spin: false,
            spawnHeight: [1, 8],
            label: '🌟 Fireflies'
        },
        VOLCANO: {
            type: 'rising',
            colors: [[1.0, 0.5, 0.0], [1.0, 0.3, 0.0], [1.0, 0.7, 0.2], [0.8, 0.2, 0.0]],
            sizeMin: 1.0, sizeMax: 2.5,
            speedMin: 0.3, speedMax: 0.8,
            drift: 0.4, spin: false,
            spawnHeight: [0, 5],
            label: '🌋 Embers'
        }
    };

    // ---------------------------------------------------------------
    // WEATHER PARTICLE PRESETS (sky-driven, independent of biome)
    // ---------------------------------------------------------------
    const WEATHER_PARTICLES = {
        CLEAR: null,  // No weather particles
        OVERCAST: null,  // Just dimmer light, no particles
        RAIN: {
            type: 'streak',
            colors: [[0.6, 0.7, 0.85], [0.5, 0.6, 0.8], [0.55, 0.65, 0.82]],
            sizeMin: 0.5, sizeMax: 1.5,
            speedMin: 5.0, speedMax: 8.0,
            drift: 0.3, spin: false,
            spawnHeight: [50, 90],
            label: '🌧️ Rain',
            fogMultiplier: 1.3,
            lightDimming: 0.7
        },
        STORM: {
            type: 'streak',
            colors: [[0.45, 0.55, 0.7], [0.4, 0.5, 0.65], [0.5, 0.55, 0.70]],
            sizeMin: 0.8, sizeMax: 2.0,
            speedMin: 8.0, speedMax: 14.0,
            drift: 1.5, spin: false,
            spawnHeight: [50, 100],
            label: '⛈️ Storm',
            fogMultiplier: 1.8,
            lightDimming: 0.4
        },
        DRIZZLE: {
            type: 'streak',
            colors: [[0.65, 0.72, 0.85], [0.6, 0.68, 0.82]],
            sizeMin: 0.3, sizeMax: 0.8,
            speedMin: 3.0, speedMax: 5.0,
            drift: 0.15, spin: false,
            spawnHeight: [40, 70],
            label: '🌦️ Drizzle',
            fogMultiplier: 1.1,
            lightDimming: 0.85
        },
        FOG: {
            type: null, // No particles, just fog effect
            label: '🌫️ Dense Fog',
            fogMultiplier: 3.0,
            lightDimming: 0.6
        }
    };

    // Restore from localStorage
    try {
        let saved = localStorage.getItem('golfos_particles');
        if (saved) {
            let data = JSON.parse(saved);
            if (typeof data.enabled === 'boolean') _enabled = data.enabled;
            if (typeof data.intensity === 'number') _intensity = data.intensity;
            if (typeof data.sizeMultiplier === 'number') _sizeMultiplier = data.sizeMultiplier;
        }
    } catch(e) {}

    function _save() {
        try {
            localStorage.setItem('golfos_particles', JSON.stringify({ enabled: _enabled, intensity: _intensity, sizeMultiplier: _sizeMultiplier }));
        } catch(e) {}
    }

    // ---------------------------------------------------------------
    // INIT
    // ---------------------------------------------------------------
    function init(scene, camera) {
        _scene = scene;
        _camera = camera;
        _initialized = true;
        console.log('[ParticleEngine] Initialized ✅');
    }

    // ---------------------------------------------------------------
    // GENERIC: Build a particle layer from a preset
    // Returns { key, preset, mesh, positions, velocities, colors, sizes, count }
    // ---------------------------------------------------------------
    function _buildLayer(preset, maxCount, tag) {
        let count = Math.floor(maxCount * _intensity);
        if (count < 10) count = 10;

        let positions  = new Float32Array(count * 3);
        let velocities = new Float32Array(count * 3);
        let colors     = new Float32Array(count * 3);
        let sizes      = new Float32Array(count);

        let spawnRadius = 120;
        for (let i = 0; i < count; i++) {
            _respawnParticle(i, preset, spawnRadius, true, positions, velocities, colors, sizes);
        }

        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

        let material = new THREE.PointsMaterial({
            size: (preset.type === 'streak' ? 1.0 : 2.0) * _sizeMultiplier,
            vertexColors: true,
            transparent: true,
            opacity: preset.type === 'streak' ? 0.5 : 0.8,
            depthWrite: false,
            sizeAttenuation: true,
            blending: preset.type === 'firefly' ? THREE.AdditiveBlending : THREE.NormalBlending,
            fog: true
        });

        let mesh = new THREE.Points(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = tag === 'weather' ? 101 : 100;
        _scene.add(mesh);

        if (!_enabled) mesh.visible = false;

        return { preset, mesh, positions, velocities, colors, sizes, count };
    }

    function _disposeLayer(layer) {
        if (!layer || !layer.mesh) return;
        _scene.remove(layer.mesh);
        layer.mesh.geometry.dispose();
        layer.mesh.material.dispose();
    }

    function _respawnParticle(i, preset, radius, randomY, positions, velocities, colors, sizes) {
        let cx = _camera ? _camera.position.x : 0;
        let cz = _camera ? _camera.position.z : 0;

        let angle = Math.random() * Math.PI * 2;
        let dist = Math.random() * radius;
        positions[i*3]     = cx + Math.cos(angle) * dist;
        positions[i*3 + 2] = cz + Math.sin(angle) * dist;

        let yMin = preset.spawnHeight[0];
        let yMax = preset.spawnHeight[1];
        positions[i*3 + 1] = randomY
            ? yMin + Math.random() * (yMax - yMin)
            : yMax + Math.random() * 5;

        let speed = preset.speedMin + Math.random() * (preset.speedMax - preset.speedMin);
        // Wind bias: particles spawn already drifting with the wind
        let windMph = window.currentWindMph || 0;
        let windDirRad = (window.currentWindDir || 0) * Math.PI / 180;
        let windBias = windMph * 0.04;  // Lateral speed from wind
        
        if (preset.type === 'falling' || preset.type === 'streak') {
            velocities[i*3]     = (Math.random() - 0.5) * preset.drift + Math.sin(windDirRad) * windBias;
            velocities[i*3 + 1] = -speed;
            velocities[i*3 + 2] = (Math.random() - 0.5) * preset.drift - Math.cos(windDirRad) * windBias;
        } else if (preset.type === 'rising') {
            velocities[i*3]     = (Math.random() - 0.5) * preset.drift + Math.sin(windDirRad) * windBias;
            velocities[i*3 + 1] = speed;
            velocities[i*3 + 2] = (Math.random() - 0.5) * preset.drift - Math.cos(windDirRad) * windBias;
        } else {
            velocities[i*3]     = (Math.random() - 0.5) * preset.drift * 0.5 + Math.sin(windDirRad) * windBias;
            velocities[i*3 + 1] = (Math.random() - 0.5) * speed * 0.5;
            velocities[i*3 + 2] = (Math.random() - 0.5) * preset.drift * 0.5 - Math.cos(windDirRad) * windBias;
        }

        let col = preset.colors[Math.floor(Math.random() * preset.colors.length)];
        colors[i*3]     = col[0];
        colors[i*3 + 1] = col[1];
        colors[i*3 + 2] = col[2];

        sizes[i] = preset.sizeMin + Math.random() * (preset.sizeMax - preset.sizeMin);
    }

    // ---------------------------------------------------------------
    // ACTIVATE BIOME — Biome particle layer
    // ---------------------------------------------------------------
    function activateBiome(biomeKey) {
        if (!_initialized || !_scene) return;
        
        _disposeLayer(_biomeLayer);
        _biomeLayer = null;

        if (!biomeKey || biomeKey === 'ALL' || biomeKey === 'GLOBAL') {
            biomeKey = 'DEFAULT';
        }

        let preset = BIOME_PARTICLES[biomeKey.toUpperCase()];
        if (!preset) {
            let key = Object.keys(BIOME_PARTICLES).find(k => biomeKey.toUpperCase().includes(k));
            if (key) preset = BIOME_PARTICLES[key];
        }
        
        if (!preset) {
            console.log('[ParticleEngine] No biome particles for:', biomeKey);
            return;
        }

        _biomeLayer = _buildLayer(preset, MAX_BIOME_PARTICLES, 'biome');
        _biomeLayer.key = biomeKey.toUpperCase();
        console.log('[ParticleEngine] Biome:', preset.label, '| Count:', _biomeLayer.count);
    }

    // ---------------------------------------------------------------
    // SET WEATHER — Weather particle layer (independent of biome)
    // ---------------------------------------------------------------
    function setWeather(weatherKey) {
        if (!_initialized || !_scene) return;
        
        weatherKey = (weatherKey || 'CLEAR').toUpperCase();
        _activeWeather = weatherKey;

        // Dispose existing weather layer
        _disposeLayer(_weatherLayer);
        _weatherLayer = null;

        // Update global for save/load
        window.ACTIVE_WEATHER = weatherKey;

        let weatherPreset = WEATHER_PARTICLES[weatherKey];
        
        // Apply fog/light effects regardless of particles
        _applyWeatherAtmosphere(weatherPreset);

        // Build weather particles if the preset has a type
        if (weatherPreset && weatherPreset.type) {
            _weatherLayer = _buildLayer(weatherPreset, MAX_WEATHER_PARTICLES, 'weather');
            _weatherLayer.key = weatherKey;
            console.log('[ParticleEngine] Weather:', weatherPreset.label, '| Count:', _weatherLayer.count);
        } else {
            console.log('[ParticleEngine] Weather:', weatherKey, '(no particles)');
        }

        // Sync UI
        let sel = document.getElementById('set-weather');
        if (sel) sel.value = weatherKey;
        let irSel = document.getElementById('ir-weather');
        if (irSel) irSel.value = weatherKey;
    }

    function _applyWeatherAtmosphere(weatherPreset) {
        if (!weatherPreset) {
            // CLEAR — reset to normal
            if (window.updateFogDensity) {
                let fogSlider = document.getElementById('set-fog-env');
                let currentFog = fogSlider ? parseFloat(fogSlider.value) : 1.0;
                window.updateFogDensity(currentFog);
            }
            return;
        }

        // Apply fog multiplier
        if (weatherPreset.fogMultiplier && window.updateFogDensity) {
            let fogSlider = document.getElementById('set-fog-env');
            let baseFog = fogSlider ? parseFloat(fogSlider.value) : 1.0;
            window.updateFogDensity(baseFog * weatherPreset.fogMultiplier);
        }

        // Apply light dimming (ambient)
        if (weatherPreset.lightDimming && window.G && window.G.scene) {
            window.G.scene.traverse(obj => {
                if (obj.isAmbientLight) {
                    // Store original if not stored
                    if (obj._originalIntensity === undefined) obj._originalIntensity = obj.intensity;
                    obj.intensity = obj._originalIntensity * weatherPreset.lightDimming;
                }
            });
        }
    }

    function getWeather() { return _activeWeather; }

    // ---------------------------------------------------------------
    // UPDATE — Called every frame, updates BOTH layers
    // ---------------------------------------------------------------
    function _updateLayer(layer, dt) {
        if (!layer || !layer.mesh) return;

        let preset = layer.preset;
        let spawnRadius = 120;
        let cx = _camera ? _camera.position.x : 0;
        let cz = _camera ? _camera.position.z : 0;
        let pos = layer.positions;
        let vel = layer.velocities;

        // === WIND INFLUENCE — same data as ball physics ===
        let windMph = window.currentWindMph || 0;
        let windDirDeg = window.currentWindDir || 0;
        let windDirRad = windDirDeg * Math.PI / 180;
        // Convert mph to a per-frame push (meters/sec, scaled for visual feel)
        // 30 mph → 1.8 units/sec push (clearly visible lateral drift)
        let windForce = windMph * 0.06;
        let windPushX = Math.sin(windDirRad) * windForce * dt;
        let windPushZ = -Math.cos(windDirRad) * windForce * dt;

        for (let i = 0; i < layer.count; i++) {
            let ix = i * 3;
            let iy = i * 3 + 1;
            let iz = i * 3 + 2;

            pos[ix] += vel[ix] * dt + windPushX;
            pos[iy] += vel[iy] * dt;
            pos[iz] += vel[iz] * dt + windPushZ;

            if (preset.spin) {
                pos[ix] += Math.sin(_clock * 2.0 + i * 0.7) * 0.02;
                pos[iz] += Math.cos(_clock * 1.5 + i * 1.1) * 0.02;
            }

            if (preset.type === 'firefly') {
                pos[ix] += Math.sin(_clock * 0.8 + i * 3.7) * 0.03;
                pos[iy] += Math.sin(_clock * 0.5 + i * 2.1) * 0.01;
                pos[iz] += Math.cos(_clock * 0.6 + i * 4.3) * 0.03;
                layer.sizes[i] = preset.sizeMin + (preset.sizeMax - preset.sizeMin) * 
                    (0.5 + 0.5 * Math.sin(_clock * 2.0 + i * 5.0));
            }

            if (preset.type === 'floating') {
                pos[ix] += Math.sin(_clock * 0.3 + i * 1.3) * 0.005;
                pos[iz] += Math.cos(_clock * 0.25 + i * 0.9) * 0.005;
            }

            let needsRespawn = false;
            if (preset.type === 'falling' || preset.type === 'streak') {
                if (pos[iy] < -2) needsRespawn = true;
            } else if (preset.type === 'rising') {
                if (pos[iy] > preset.spawnHeight[1] + 20) needsRespawn = true;
            }

            let dx = pos[ix] - cx;
            let dz = pos[iz] - cz;
            if (dx*dx + dz*dz > spawnRadius * spawnRadius * 1.5) {
                needsRespawn = true;
            }

            if (needsRespawn) {
                _respawnParticle(i, preset, spawnRadius,
                    preset.type === 'floating' || preset.type === 'firefly',
                    pos, vel, layer.colors, layer.sizes);
            }
        }

        layer.mesh.geometry.attributes.position.needsUpdate = true;
        if (preset.type === 'firefly') {
            layer.mesh.geometry.attributes.size.needsUpdate = true;
        }
    }

    function update(dt) {
        if (!_initialized || !_enabled) return;
        _clock += dt;
        _updateLayer(_biomeLayer, dt);
        _updateLayer(_weatherLayer, dt);
    }

    // ---------------------------------------------------------------
    // CONTROLS
    // ---------------------------------------------------------------
    function setEnabled(val) {
        _enabled = !!val;
        if (_biomeLayer && _biomeLayer.mesh) _biomeLayer.mesh.visible = _enabled;
        if (_weatherLayer && _weatherLayer.mesh) _weatherLayer.mesh.visible = _enabled;
        _save();

        ['hb-toggle-particles', 'ir-particles-enabled'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.checked = _enabled;
        });
    }

    function setIntensity(val) {
        _intensity = Math.max(0, Math.min(1, parseFloat(val) || 0));
        _save();

        ['set-particle-intensity', 'ir-particle-intensity'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.value = _intensity;
        });
        ['particle-int-label', 'ir-particle-int-label'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.innerText = Math.round(_intensity * 100) + '%';
        });

        // Rebuild both layers with new intensity
        if (_biomeLayer) {
            let newCount = Math.floor(MAX_BIOME_PARTICLES * _intensity);
            if (Math.abs(newCount - _biomeLayer.count) > 20) {
                activateBiome(_biomeLayer.key);
            }
        }
        if (_weatherLayer) {
            let newCount = Math.floor(MAX_WEATHER_PARTICLES * _intensity);
            if (Math.abs(newCount - _weatherLayer.count) > 20) {
                setWeather(_activeWeather);
            }
        }
    }

    function isEnabled() { return _enabled; }
    function getIntensity() { return _intensity; }
    function getSize() { return _sizeMultiplier; }

    function setSize(val) {
        _sizeMultiplier = Math.max(0.2, Math.min(4.0, parseFloat(val) || 1.0));
        _save();

        // Update material size on both layers
        if (_biomeLayer && _biomeLayer.mesh) {
            let baseSize = _biomeLayer.preset.type === 'streak' ? 1.0 : 2.0;
            _biomeLayer.mesh.material.size = baseSize * _sizeMultiplier;
        }
        if (_weatherLayer && _weatherLayer.mesh) {
            let baseSize = _weatherLayer.preset.type === 'streak' ? 1.0 : 2.0;
            _weatherLayer.mesh.material.size = baseSize * _sizeMultiplier;
        }

        // Sync UI
        ['set-particle-size', 'ir-particle-size'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.value = _sizeMultiplier;
        });
        ['particle-size-label', 'ir-particle-size-label'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.innerText = _sizeMultiplier.toFixed(1) + '×';
        });
    }

    function dispose() {
        _disposeLayer(_biomeLayer);
        _disposeLayer(_weatherLayer);
        _biomeLayer = null;
        _weatherLayer = null;
        _initialized = false;
    }

    // ---------------------------------------------------------------
    // PUBLIC API
    // ---------------------------------------------------------------
    window.ParticleEngine = {
        init,
        setEnabled,
        isEnabled,
        setIntensity,
        getIntensity,
        setSize,
        getSize,
        activateBiome,
        setWeather,
        getWeather,
        update,
        dispose,
        BIOME_PARTICLES,
        WEATHER_PARTICLES
    };

})();
