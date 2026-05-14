// ================================================================
//  WIND SWAY ENGINE — Physics-Driven Tree & Vegetation Animation
//  Uses the SAME wind data as ball physics (window.currentWindMph,
//  window.currentWindDir) to animate InstancedMesh trees.
//
//  Approach: Per-frame vertex displacement via onBeforeCompile
//  shader injection. Each tree's canopy vertices sway proportionally
//  to their height above ground. Trunk stays stable.
//
//  Depends on: THREE (global), window.instancePools, window.ASSET_REGISTRY
//
//  Exposes:
//  - window.WindSway.init(scene)
//  - window.WindSway.update(time)      — call in animate()
//  - window.WindSway.setEnabled(bool)
//  - window.WindSway.isEnabled()
// ================================================================
(function() {
    'use strict';

    let _scene = null;
    let _enabled = true;
    let _initialized = false;
    let _patchedMaterials = new Set();

    // Restore from localStorage
    try {
        let saved = localStorage.getItem('golfos_windsway');
        if (saved) {
            let data = JSON.parse(saved);
            if (typeof data.enabled === 'boolean') _enabled = data.enabled;
        }
    } catch(e) {}

    function _save() {
        try {
            localStorage.setItem('golfos_windsway', JSON.stringify({ enabled: _enabled }));
        } catch(e) {}
    }

    // ---------------------------------------------------------------
    // GLSL: Vertex shader wind displacement
    // Injected into existing MeshStandardMaterial / MeshPhongMaterial
    // ---------------------------------------------------------------
    const WIND_UNIFORMS = {
        uWindTime:      { value: 0.0 },
        uWindStrength:  { value: 0.0 },   // 0–1 normalized (0 = calm, 1 = storm)
        uWindDirX:      { value: 0.0 },   // Wind direction X component
        uWindDirZ:      { value: 0.0 },   // Wind direction Z component
        uSwayEnabled:   { value: 1.0 }    // 1.0 = on, 0.0 = off
    };

    // GLSL code injected BEFORE the vertex transform
    const WIND_VERTEX_PARS = `
        uniform float uWindTime;
        uniform float uWindStrength;
        uniform float uWindDirX;
        uniform float uWindDirZ;
        uniform float uSwayEnabled;
    `;

    // GLSL code injected INTO the vertex shader (after position is computed)
    // position.y = height above root. Higher = more sway.
    const WIND_VERTEX_CODE = `
        if (uSwayEnabled > 0.5 && uWindStrength > 0.001) {
            // Get world-space info from instanceMatrix
            vec4 worldPos4 = instanceMatrix * vec4(position, 1.0);
            vec4 rootPos4 = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            
            // Calculate model scale from instanceMatrix (how many world-units per model-unit)
            float modelScaleY = length(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]));
            
            // Normalized height (0=root, 1=top) using raw model position
            float rawMaxY = 1.0;
            float normalizedHeight = clamp(position.y / rawMaxY, 0.0, 1.5);
            // Root anchored, trunk bends gradually, canopy full sway
            float heightFactor = smoothstep(0.0, 0.8, normalizedHeight);
            
            // Per-instance variation
            float instanceHash = fract(sin(rootPos4.x * 12.9898 + rootPos4.z * 78.233) * 43758.5453);
            
            // Oscillation (same as before)
            float sway1 = sin(uWindTime * 1.2 + instanceHash * 6.28) * 0.7;
            float sway2 = sin(uWindTime * 3.1 + instanceHash * 12.56 + position.x * 0.5) * 0.3;
            float flutter = sin(uWindTime * 7.0 + normalizedHeight * 2.0 + instanceHash * 20.0) * 0.1;
            
            float oscillation = (sway1 + sway2 + flutter) * heightFactor * uWindStrength;
            
            // Target: max 1.5 meters world-space sway at peak wind.
            // Convert to model-space by dividing by scale.
            float maxSwayWorld = 3.0;
            float swayModelSpace = oscillation * maxSwayWorld / max(modelScaleY, 0.1);
            
            transformed.x += uWindDirX * swayModelSpace;
            transformed.z += uWindDirZ * swayModelSpace;
            transformed.y -= abs(swayModelSpace) * 0.03;
        }
    `;

    // For non-instanced meshes (legacy treesGroup), use modelMatrix instead
    const WIND_VERTEX_CODE_NOINSTANCE = `
        if (uSwayEnabled > 0.5 && uWindStrength > 0.001) {
            float heightFactor = smoothstep(1.0, 6.0, position.y);
            
            vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
            float instanceHash = fract(sin(worldPos4.x * 12.9898 + worldPos4.z * 78.233) * 43758.5453);
            
            float sway1 = sin(uWindTime * 1.2 + instanceHash * 6.28) * 0.7;
            float sway2 = sin(uWindTime * 3.1 + instanceHash * 12.56 + position.x * 0.5) * 0.3;
            float flutter = sin(uWindTime * 7.0 + position.y * 2.0 + instanceHash * 20.0) * 0.1;
            
            float totalSway = (sway1 + sway2 + flutter) * heightFactor * uWindStrength;
            
            transformed.x += uWindDirX * totalSway;
            transformed.z += uWindDirZ * totalSway;
            transformed.y -= abs(totalSway) * 0.05;
        }
    `;

    // ---------------------------------------------------------------
    // INIT: Patch materials on existing tree InstancedMeshes
    // ---------------------------------------------------------------
    function init(scene) {
        _scene = scene;
        _initialized = true;
        
        // Patch existing materials
        _patchAllTreeMaterials();
        
        console.log('[WindSway] Initialized ✅ | Patched materials:', _patchedMaterials.size);
    }

    function _patchAllTreeMaterials() {
        if (!window.instancePools) return;

        for (let type in window.instancePools) {
            let reg = window.ASSET_REGISTRY ? window.ASSET_REGISTRY[type] : null;
            // Only patch trees, bushes, plants (not rocks, flags, etc.)
            let isVegetation = reg && (reg.subcat === 'TREES' || reg.subcat === 'BUSHES' || reg.subcat === 'PLANTS');
            if (!isVegetation && type !== 'TREE' && type !== 'PINE' && type !== 'BUSH') continue;

            let pool = window.instancePools[type];
            if (!pool || !pool.meshes) continue;

            pool.meshes.forEach((iMesh, idx) => {
                _patchMaterial(iMesh.material, true);
            });
        }
    }

    function _patchMaterial(material, isInstanced) {
        if (!material || _patchedMaterials.has(material.uuid)) return;

        let originalOnBeforeCompile = material.onBeforeCompile;

        material.onBeforeCompile = function(shader) {
            // Call original if it existed
            if (originalOnBeforeCompile) originalOnBeforeCompile.call(this, shader);

            // Add our uniforms
            shader.uniforms.uWindTime = WIND_UNIFORMS.uWindTime;
            shader.uniforms.uWindStrength = WIND_UNIFORMS.uWindStrength;
            shader.uniforms.uWindDirX = WIND_UNIFORMS.uWindDirX;
            shader.uniforms.uWindDirZ = WIND_UNIFORMS.uWindDirZ;
            shader.uniforms.uSwayEnabled = WIND_UNIFORMS.uSwayEnabled;

            // Inject uniform declarations
            shader.vertexShader = shader.vertexShader.replace(
                '#include <common>',
                '#include <common>\n' + WIND_VERTEX_PARS
            );

            // Inject displacement code AFTER the position transform
            let vertexCode = isInstanced ? WIND_VERTEX_CODE : WIND_VERTEX_CODE_NOINSTANCE;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\n' + vertexCode
            );
        };

        // Force shader recompilation
        material.needsUpdate = true;
        _patchedMaterials.add(material.uuid);
    }

    // ---------------------------------------------------------------
    // UPDATE: Called every frame from animate loop
    // ---------------------------------------------------------------
    function update(time) {
        if (!_initialized || !_enabled) return;

        // Read wind from physics system
        let windMph = window.currentWindMph || 0;
        let windDirDeg = window.currentWindDir || 0;

        // Normalize wind strength: 0 = calm, 1.0 = extreme (35+ mph)
        // Proportional mapping so 5 mph = subtle, 15 mph = clear, 30+ mph = heavy
        let strength = Math.min(1.0, windMph / 35.0);

        // Square curve for more natural feel (light wind = barely visible)
        strength = strength * strength;

        // Wind direction → unit vector
        let dirRad = windDirDeg * Math.PI / 180;
        let dirX = Math.sin(dirRad);
        let dirZ = -Math.cos(dirRad);

        // Update shared uniforms (all patched materials read from these)
        WIND_UNIFORMS.uWindTime.value = time;
        WIND_UNIFORMS.uWindStrength.value = strength;
        WIND_UNIFORMS.uWindDirX.value = dirX;
        WIND_UNIFORMS.uWindDirZ.value = dirZ;
        WIND_UNIFORMS.uSwayEnabled.value = _enabled ? 1.0 : 0.0;

        // Re-patch any new materials that were added since init
        // (e.g., new tree types loaded via GLTF)
        if (window._windSwayRepatch) {
            _patchAllTreeMaterials();
            window._windSwayRepatch = false;
        }
    }

    // ---------------------------------------------------------------
    // CONTROLS
    // ---------------------------------------------------------------
    function setEnabled(val) {
        _enabled = !!val;
        WIND_UNIFORMS.uSwayEnabled.value = _enabled ? 1.0 : 0.0;
        _save();

        // Sync UI
        ['hb-toggle-windsway', 'ir-windsway-enabled'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.checked = _enabled;
        });
    }

    function isEnabled() { return _enabled; }

    // Force re-patch (call after loading new tree models)
    function repatch() {
        window._windSwayRepatch = true;
    }

    // ---------------------------------------------------------------
    // PUBLIC API
    // ---------------------------------------------------------------
    window.WindSway = {
        init,
        update,
        setEnabled,
        isEnabled,
        repatch
    };

})();
