// ================================================================
// road-decal.js — Gravel-textured strip mesh overlay for roads
// Renders a thin 3D mesh on top of terrain with procedural gravel
// shader. Works alongside classic MeshLambertMaterial terrain.
// Requires: terrain-shader-utils.js (for texture generators)
// Exposes: window.roadDecal
// ================================================================
(function () {
    'use strict';

    // ── Shader: Road Decal Vertex ─────────────────────────────────────────────
    const ROAD_VERT = /* glsl */`
varying vec2  vRoadUV;
varying vec3  vWorldPos;
varying vec3  vNormal;
varying float vFogDepth;

void main() {
    vRoadUV   = uv;
    vNormal   = normalize(vec3(modelMatrix * vec4(normal, 0.0)));
    vec4 wp   = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vec4 mvp  = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mvp.z;
    gl_Position = projectionMatrix * mvp;
}
`;

    // ── Old ROAD_FRAG removed — replaced by ROAD_FRAG_MULTI with u_tileScale/u_brightness ──

    // ── Material system: one ShaderMaterial per road surface type ──────────────
    const _materials = {};  // keyed by material name: 'GRAVEL', 'TARMAC', 'MUD'

    // Texture definitions per road material type
    const ROAD_TEX_SETS = {
        GRAVEL: {
            base: 'Ground_062_textures/',
            color:  'Ground062S_1K-JPG_Color.jpg',
            normal: 'Ground062S_1K-JPG_NormalGL.jpg',
            ao:     'Ground062S_1K-JPG_AmbientOcclusion.jpg',
            tileScale: 0.33,   // tile every ~3m
            brightness: 1.18,  // exposure boost
            tint: [1.0, 1.0, 1.0],
        },
        TARMAC: {
            base: 'Kullersten_textures/ground_tiles_01_1k/',
            color:  'ground_tiles_01_color_1k.png',
            normal: 'ground_tiles_01_normal_gl_1k.png',
            ao:     'ground_tiles_01_ambient_occlusion_1k.png',
            tileScale: 0.25,   // tile every ~4m (larger stones)
            brightness: 1.50,  // cobblestone is dark, strong lift needed
            tint: [1.0, 1.0, 1.0],
        },
        MUD: {
            base: 'Ground_062_textures/',
            color:  'Ground062S_1K-JPG_Color.jpg',
            normal: 'Ground062S_1K-JPG_NormalGL.jpg',
            ao:     'Ground062S_1K-JPG_AmbientOcclusion.jpg',
            tileScale: 0.33,
            brightness: 0.75,  // darker mud look
            tint: [0.55, 0.40, 0.30], // brownish tint matching terrain mud
        },
    };

    // Helper functions to generate procedural canvas-based textures (bypasses CORS on file:///)
    function createProceduralCanvas(materialType, mapType) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (mapType === 'color') {
            if (materialType === 'TARMAC') {
                // Dark grey cobblestone/asphalt
                ctx.fillStyle = '#444444';
                ctx.fillRect(0, 0, 128, 128);
                ctx.strokeStyle = '#222222';
                ctx.lineWidth = 2;
                for (let i = 0; i <= 128; i += 16) {
                    ctx.beginPath();
                    ctx.moveTo(i, 0); ctx.lineTo(i, 128);
                    ctx.moveTo(0, i); ctx.lineTo(128, i);
                    ctx.stroke();
                }
            } else if (materialType === 'MUD') {
                // Mud/dirt color
                ctx.fillStyle = '#4a3525';
                ctx.fillRect(0, 0, 128, 128);
                for (let i = 0; i < 200; i++) {
                    ctx.fillStyle = Math.random() > 0.5 ? '#3c2b1e' : '#58402c';
                    ctx.fillRect(Math.random() * 128, Math.random() * 128, 4, 4);
                }
            } else {
                // Gravel color
                ctx.fillStyle = '#a69575';
                ctx.fillRect(0, 0, 128, 128);
                for (let i = 0; i < 400; i++) {
                    ctx.fillStyle = Math.random() > 0.5 ? '#7b6c50' : '#c4b595';
                    ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
                }
            }
        } else if (mapType === 'normal') {
            // Flat/neutral normal
            ctx.fillStyle = 'rgb(128, 128, 255)';
            ctx.fillRect(0, 0, 128, 128);
        } else {
            // AO map: pure white
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 128, 128);
        }
        return canvas;
    }

    function createProceduralRoadTexture(materialType, mapType) {
        const canvas = createProceduralCanvas(materialType, mapType);
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        return tex;
    }

    // Fragment shader with configurable brightness + tile scale via uniforms
    const ROAD_FRAG_MULTI = /* glsl */`
uniform sampler2D u_gravel_alb;
uniform sampler2D u_gravel_normal;
uniform sampler2D u_gravel_ao;
uniform vec3  u_sunDir;
uniform vec3  u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_tileScale;
uniform float u_brightness;
uniform vec3  u_tint;
uniform float u_ambientIntensity;
uniform float u_sunIntensity;
uniform vec3  u_sunColor;
uniform float u_headlightIntensity;
uniform vec3  u_headlight1Pos;
uniform vec3  u_headlight1Dir;
uniform vec3  u_headlight2Pos;
uniform vec3  u_headlight2Dir;

varying vec2  vRoadUV;
varying vec3  vWorldPos;
varying vec3  vNormal;
varying float vFogDepth;

void main() {
    // World-space UV for texture tiling
    vec2 texUV = vWorldPos.xz * u_tileScale;

    // PBR textures
    vec3 albedo  = texture2D(u_gravel_alb, texUV).rgb;
    vec3 nMap    = texture2D(u_gravel_normal, texUV).rgb;
    float ao     = texture2D(u_gravel_ao, texUV).r;

    // Apply tint color multiplier
    albedo *= u_tint;

    // Perturb normal with normal map (tangent-space approx for flat road)
    vec3 nTan = nMap * 2.0 - 1.0;
    vec3 N = normalize(vNormal + vec3(nTan.x, 0.0, nTan.y) * 0.5);

    // Lambert lighting with normal map detail
    float diff  = max(dot(N, normalize(u_sunDir)), 0.0);
    float ambient = u_ambientIntensity;
    float sunLight = ambient + (1.0 - ambient) * diff * u_sunIntensity;
    vec3  totalLight = sunLight * u_sunColor;

    // Headlight spotlight calculation
    if (u_headlightIntensity > 0.01) {
        // Headlight 1
        vec3 toLight1 = vWorldPos - u_headlight1Pos;
        float dist1 = length(toLight1);
        if (dist1 < 50.0) {
            vec3 toLight1Dir = normalize(toLight1);
            float dotSpot1 = dot(toLight1Dir, u_headlight1Dir);
            if (dotSpot1 > 0.82) {
                float coneAtten = smoothstep(0.82, 0.95, dotSpot1);
                float distAtten = 1.0 - (dist1 / 50.0);
                float normalAtten = max(dot(N, -toLight1Dir), 0.0);
                totalLight += vec3(1.0, 0.98, 0.90) * coneAtten * distAtten * normalAtten * 2.8 * u_headlightIntensity;
            }
        }
        
        // Headlight 2
        vec3 toLight2 = vWorldPos - u_headlight2Pos;
        float dist2 = length(toLight2);
        if (dist2 < 50.0) {
            vec3 toLight2Dir = normalize(toLight2);
            float dotSpot2 = dot(toLight2Dir, u_headlight2Dir);
            if (dotSpot2 > 0.82) {
                float coneAtten = smoothstep(0.82, 0.95, dotSpot2);
                float distAtten = 1.0 - (dist2 / 50.0);
                float normalAtten = max(dot(N, -toLight2Dir), 0.0);
                totalLight += vec3(1.0, 0.98, 0.90) * coneAtten * distAtten * normalAtten * 2.8 * u_headlightIntensity;
            }
        }
    }

    // Apply AO gently (30% strength)
    float aoMix = mix(1.0, ao, 0.3);
    vec3 lit    = albedo * totalLight * aoMix;

    // Exposure boost
    lit *= u_brightness;

    // Shoulder fade: edges → alpha 0
    float edgeDist = min(vRoadUV.x, 1.0 - vRoadUV.x);
    float shoulder = 0.10;
    float alpha    = smoothstep(0.0, shoulder, edgeDist);

    // Distance fog
    float fogT = smoothstep(u_fogNear, u_fogFar, vFogDepth);
    vec3 final = mix(lit, u_fogColor, fogT);

    gl_FragColor = vec4(final, alpha);
}
`;

    function ensureMaterial(materialType) {
        const key = materialType || 'GRAVEL';
        if (_materials[key]) return _materials[key];

        const texSet = ROAD_TEX_SETS[key] || ROAD_TEX_SETS.GRAVEL;
        const isLocalFile = window.location.protocol === 'file:';

        let colorTex, normalTex, aoTex;

        if (isLocalFile) {
            console.log('🌐 Bypassing CORS on file:// protocol for road ' + key + ' using procedural textures');
            colorTex = createProceduralRoadTexture(key, 'color');
            normalTex = createProceduralRoadTexture(key, 'normal');
            aoTex = createProceduralRoadTexture(key, 'ao');
        } else {
            const loader = new THREE.TextureLoader();
            colorTex = loader.load(texSet.base + texSet.color, 
                function() {
                    console.log('🪨 Road ' + key + ' color texture loaded');
                },
                undefined,
                function(err) {
                    console.warn('⚠️ Failed to load color texture for ' + key + ', falling back to procedural:', err);
                    colorTex.image = createProceduralCanvas(key, 'color');
                    colorTex.needsUpdate = true;
                }
            );
            colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;

            normalTex = loader.load(texSet.base + texSet.normal,
                undefined,
                undefined,
                function(err) {
                    console.warn('⚠️ Failed to load normal texture for ' + key + ', falling back to procedural:', err);
                    normalTex.image = createProceduralCanvas(key, 'normal');
                    normalTex.needsUpdate = true;
                }
            );
            normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping;

            aoTex = loader.load(texSet.base + texSet.ao,
                undefined,
                undefined,
                function(err) {
                    console.warn('⚠️ Failed to load AO texture for ' + key + ', falling back to procedural:', err);
                    aoTex.image = createProceduralCanvas(key, 'ao');
                    aoTex.needsUpdate = true;
                }
            );
            aoTex.wrapS = aoTex.wrapT = THREE.RepeatWrapping;
        }

        const mat = new THREE.ShaderMaterial({
            uniforms: {
                u_gravel_alb:    { value: colorTex },
                u_gravel_normal: { value: normalTex },
                u_gravel_ao:     { value: aoTex },
                u_sunDir:        { value: new THREE.Vector3(0.6, 0.8, 0.4).normalize() },
                u_fogColor:      { value: new THREE.Color(0x87ceeb) },
                u_fogNear:       { value: 200.0 },
                u_fogFar:        { value: 1800.0 },
                u_tileScale:     { value: texSet.tileScale },
                u_brightness:    { value: texSet.brightness },
                u_tint:          { value: new THREE.Color(texSet.tint[0], texSet.tint[1], texSet.tint[2]) },
                u_ambientIntensity: { value: 0.38 },
                u_sunIntensity:     { value: 1.0 },
                u_sunColor:         { value: new THREE.Color(0xffffff) },
                u_headlightIntensity: { value: 0.0 },
                u_headlight1Pos:     { value: new THREE.Vector3() },
                u_headlight1Dir:     { value: new THREE.Vector3() },
                u_headlight2Pos:     { value: new THREE.Vector3() },
                u_headlight2Dir:     { value: new THREE.Vector3() },
            },
            vertexShader:   ROAD_VERT,
            fragmentShader: ROAD_FRAG_MULTI,
            transparent:    true,
            depthWrite:     false,
            side:           THREE.DoubleSide,
            polygonOffset:       true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits:  -4,
        });

        _materials[key] = mat;
        return mat;
    }

    // ── Geometry: build strip from road sampledPoints ─────────────────────────
    function buildRoadStripGeo(road) {
        let pts = road.sampledPoints;
        if (!pts || pts.length < 2) return null;

        const halfW    = road.width / 2;
        const shoulder = 1.5;                      // shoulder width in meters (covers canvas lineJoin:round at curves)
        const totalHalf = halfW + shoulder;         // total half-width including shoulder
        const getH     = window.getTerrainHeight;
        const yOffset  = 0.02;                     // meters above terrain (prevents poke-through on sculpted slopes)

        // Extend mesh beyond first/last point to match canvas lineCap:'round'
        // Canvas lineCap:'round' adds a semicircle of radius = lineWidth/2 at each end
        // We add multiple extension points for a smooth rounded cap
        const ext = road.width;  // full road width extension (generous)
        const firstDir = {
            x: pts[1].x - pts[0].x,
            z: pts[1].z - pts[0].z
        };
        const firstLen = Math.sqrt(firstDir.x * firstDir.x + firstDir.z * firstDir.z) || 1;
        const fwdStartX = firstDir.x / firstLen, fwdStartZ = firstDir.z / firstLen;
        
        const lastDir = {
            x: pts[pts.length - 1].x - pts[pts.length - 2].x,
            z: pts[pts.length - 1].z - pts[pts.length - 2].z
        };
        const lastLen = Math.sqrt(lastDir.x * lastDir.x + lastDir.z * lastDir.z) || 1;
        const fwdEndX = lastDir.x / lastLen, fwdEndZ = lastDir.z / lastLen;

        // ── DEBUG: Log coverage before extension ──
        const origFirst = pts[0];
        const origLast = pts[pts.length - 1];
        let origTotalLen = 0;
        for (let i = 1; i < pts.length; i++) {
            origTotalLen += Math.sqrt(
                (pts[i].x - pts[i-1].x) ** 2 + (pts[i].z - pts[i-1].z) ** 2
            );
        }
        console.log('🛣️ ROAD DECAL DEBUG:');
        console.log('  sampledPoints:', pts.length);
        console.log('  First point: x=' + origFirst.x.toFixed(1) + ' z=' + origFirst.z.toFixed(1));
        console.log('  Last point:  x=' + origLast.x.toFixed(1) + ' z=' + origLast.z.toFixed(1));
        console.log('  Spline coverage:', origTotalLen.toFixed(1) + 'm');
        console.log('  Extension per end:', ext.toFixed(1) + 'm');
        // ── END DEBUG ──

        // Create extended points array with cap points
        pts = [
            { x: pts[0].x - fwdStartX * ext,       z: pts[0].z - fwdStartZ * ext },
            { x: pts[0].x - fwdStartX * ext * 0.5,  z: pts[0].z - fwdStartZ * ext * 0.5 },
            ...pts,
            { x: origLast.x + fwdEndX * ext * 0.5,  z: origLast.z + fwdEndZ * ext * 0.5 },
            { x: origLast.x + fwdEndX * ext,        z: origLast.z + fwdEndZ * ext },
        ];

        // ── DEBUG: Log extended mesh bounds ──
        const extFirst = pts[0];
        const extLast = pts[pts.length - 1];
        console.log('  Extended first: x=' + extFirst.x.toFixed(1) + ' z=' + extFirst.z.toFixed(1));
        console.log('  Extended last:  x=' + extLast.x.toFixed(1) + ' z=' + extLast.z.toFixed(1));
        console.log('  Total pts (with caps):', pts.length);
        // ── END DEBUG ──

        const n           = pts.length;
        const vertsPerRow = 4;                     // outer-left, inner-left, inner-right, outer-right
        const vertCount   = n * vertsPerRow;
        const triCount    = (n - 1) * (vertsPerRow - 1) * 2;

        const positions = new Float32Array(vertCount * 3);
        const uvs       = new Float32Array(vertCount * 2);
        const normals   = new Float32Array(vertCount * 3);
        const indices   = new Uint32Array(triCount * 3);

        // U positions: 0=outer-left, shoulder/(totalHalf*2)=inner-left, etc.
        const sU = shoulder / (totalHalf * 2);
        const uPositions = [0.0, sU, 1.0 - sU, 1.0];
        // Lateral offsets from center in meters
        const lateralOffsets = [-totalHalf, -halfW, halfW, totalHalf];

        let cumulativeLen = 0;

        for (let i = 0; i < n; i++) {
            // Direction: forward tangent
            let dx, dz;
            if (i === 0) {
                dx = pts[1].x - pts[0].x;
                dz = pts[1].z - pts[0].z;
            } else if (i === n - 1) {
                dx = pts[n - 1].x - pts[n - 2].x;
                dz = pts[n - 1].z - pts[n - 2].z;
            } else {
                dx = pts[i + 1].x - pts[i - 1].x;
                dz = pts[i + 1].z - pts[i - 1].z;
            }
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            // Perpendicular (left = -fwdZ, fwdX)
            const perpX = -dz / len, perpZ = dx / len;

            // Cumulative V coordinate (along-road)
            if (i > 0) {
                const segDx = pts[i].x - pts[i - 1].x;
                const segDz = pts[i].z - pts[i - 1].z;
                cumulativeLen += Math.sqrt(segDx * segDx + segDz * segDz);
            }
            const vCoord = cumulativeLen / 8.0; // tile every 8m

            for (let j = 0; j < vertsPerRow; j++) {
                const vi = i * vertsPerRow + j;
                const wx = pts[i].x + perpX * lateralOffsets[j];
                const wz = pts[i].z + perpZ * lateralOffsets[j];
                let wy = 0;
                if (getH) {
                    // Sample terrain at multiple nearby points and take MAX
                    // This prevents terrain poking through on sculpted slopes
                    // where bilinear interpolation underestimates the GPU mesh height
                    const probe = 1.5;  // probe distance in meters
                    const h0 = getH(wx, wz) || 0;
                    const h1 = getH(wx + probe, wz) || 0;
                    const h2 = getH(wx - probe, wz) || 0;
                    const h3 = getH(wx, wz + probe) || 0;
                    const h4 = getH(wx, wz - probe) || 0;
                    wy = Math.max(h0, h1, h2, h3, h4);
                    if (!isFinite(wy)) wy = 0;
                }
                wy += yOffset;

                positions[vi * 3]     = wx;
                positions[vi * 3 + 1] = wy;
                positions[vi * 3 + 2] = wz;
                uvs[vi * 2]           = uPositions[j];
                uvs[vi * 2 + 1]       = vCoord;
                normals[vi * 3]       = 0;
                normals[vi * 3 + 1]   = 1;
                normals[vi * 3 + 2]   = 0;
            }
        }

        // Indices: quad-strip between consecutive rows
        let idx = 0;
        for (let i = 0; i < n - 1; i++) {
            for (let j = 0; j < vertsPerRow - 1; j++) {
                const a = i * vertsPerRow + j;
                const b = a + 1;
                const c = a + vertsPerRow;
                const d = c + 1;
                // Two triangles per quad
                indices[idx++] = a; indices[idx++] = c; indices[idx++] = b;
                indices[idx++] = b; indices[idx++] = c; indices[idx++] = d;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setIndex(new THREE.BufferAttribute(indices, 1));
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geo.computeVertexNormals(); // smooth normals from actual geometry
        return geo;
    }

    // ── Road mesh management ─────────────────────────────────────────────────
    let _roadMeshes = [];
    let _roadGroup  = null;

    function ensureGroup(scene) {
        if (!_roadGroup) {
            _roadGroup = new THREE.Group();
            _roadGroup.name = 'roadDecalGroup';
            scene.add(_roadGroup);
        }
        return _roadGroup;
    }

    function clearAllRoadMeshes(scene) {
        if (_roadGroup) {
            while (_roadGroup.children.length > 0) {
                const child = _roadGroup.children[0];
                _roadGroup.remove(child);
                if (child.geometry) child.geometry.dispose();
            }
        }
        _roadMeshes = [];
    }

    function buildAllRoadMeshes(roads, scene) {
        if (!scene || !roads) return;
        const group = ensureGroup(scene);

        for (let i = 0; i < roads.length; i++) {
            const road = roads[i];
            const geo  = buildRoadStripGeo(road);
            if (!geo) continue;

            // Pick material based on road surface type
            const mat  = ensureMaterial(road.material || 'GRAVEL');
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name  = 'roadDecal_' + (road.id || i);
            mesh.renderOrder = 1; // Render after terrain to avoid z-fighting
            group.add(mesh);
            _roadMeshes.push(mesh);
        }
    }

    function rebuildAll(roads, scene) {
        clearAllRoadMeshes(scene);
        buildAllRoadMeshes(roads, scene);
    }

    // ── Sync fog with scene ──────────────────────────────────────────────────
    function syncFog(scene) {
        if (!scene || !scene.fog) return;
        // Sync all material variants
        for (const key in _materials) {
            const mat = _materials[key];
            if (!mat || !mat.uniforms) continue;
            mat.uniforms.u_fogColor.value.copy(scene.fog.color);
            if (scene.fog.near !== undefined) mat.uniforms.u_fogNear.value = scene.fog.near;
            if (scene.fog.far  !== undefined) mat.uniforms.u_fogFar.value  = scene.fog.far;
        }
    }

    // ── Expose ────────────────────────────────────────────────────────────────
    window.roadDecal = {
        buildAllRoadMeshes: buildAllRoadMeshes,
        clearAllRoadMeshes: clearAllRoadMeshes,
        rebuildAll:         rebuildAll,
        syncFog:            syncFog,
        ensureMaterial:     ensureMaterial,
        materials:          _materials,
    };

})();
