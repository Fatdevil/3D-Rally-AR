// ================================================================
// terrain-shader-material.js — PHASE 2: GLSL shaders + ShaderMaterial builder
// Requires: terrain-shader-utils.js loaded first
// Exposes: window.terrainShaderMaterial
// ================================================================
(function () {
    'use strict';

    // ── Vertex Shader ─────────────────────────────────────────────────────────
    const TERRAIN_VERT = /* glsl */`
varying vec2  vUv;
varying vec3  vNormal;
varying vec3  vColor;
varying float vFogDepth;
varying vec3  vWorldPos;

void main() {
    vUv      = uv;
    vNormal  = normalize(vec3(modelMatrix * vec4(normal, 0.0)));
    vColor   = color.rgb;

    vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
    vWorldPos      = worldPos4.xyz;

    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vFogDepth  = -mvPos.z;

    gl_Position = projectionMatrix * mvPos;
}
`;

    // ── Fragment Shader ───────────────────────────────────────────────────────
    const TERRAIN_FRAG = /* glsl */`
uniform sampler2D u_splat;
uniform sampler2D u_grass_alb;
uniform sampler2D u_grass_nrm;
uniform sampler2D u_gravel_alb;
uniform sampler2D u_gravel_nrm;
uniform sampler2D u_gravel_rgh;
uniform sampler2D u_gravel_ao;
uniform sampler2D u_tarmac_alb;
uniform sampler2D u_tarmac_nrm;
uniform sampler2D u_rock_alb;
uniform sampler2D u_rock_nrm;
uniform sampler2D u_moss_alb;

uniform vec3  u_sunDir;
uniform vec3  u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_terrainMaxHeight;
uniform float u_playMode;
uniform float u_ambientIntensity;
uniform float u_sunIntensity;
uniform vec3  u_sunColor;
uniform float u_headlightIntensity;
uniform vec3  u_headlight1Pos;
uniform vec3  u_headlight1Dir;
uniform vec3  u_headlight2Pos;
uniform vec3  u_headlight2Dir;

varying vec2  vUv;
varying vec3  vNormal;
varying vec3  vColor;
varying float vFogDepth;
varying vec3  vWorldPos;

// Triplanar UV — prevents UV-stretching on steep slopes
vec2 triplanarUV(vec3 wpos, vec3 n, float scale) {
    vec3 blend = abs(n);
    blend = pow(blend, vec3(6.0));
    float s = blend.x + blend.y + blend.z + 0.001;
    return (wpos.zy * blend.x + wpos.xz * blend.y + wpos.xy * blend.z) / (s * scale);
}

vec3 unpackNormal(vec4 s) {
    return normalize(s.rgb * 2.0 - 1.0);
}

void main() {
    // ── 1. Splat map ──────────────────────────────────────────────────────────
    vec4  splat   = texture2D(u_splat, vUv);
    float wGravel = splat.r;
    float wTarmac = splat.g;
    float wMud    = splat.b;
    float wGrassB = splat.a;           // A = grassVeto from biome
    float wGrass  = max(0.0, 1.0 - wGravel - wTarmac - wMud);

    // ── 2. Slope-based rock ───────────────────────────────────────────────────
    float slope      = 1.0 - smoothstep(0.45, 0.80, vNormal.y);
    float heightT    = clamp(vWorldPos.y / max(u_terrainMaxHeight, 1.0), 0.0, 1.0);
    // grassVeto: vertex G-channel OR splat A-channel (biome-painted grass areas)
    float grassVeto  = max(vColor.g, wGrassB);
    float autoRock   = slope * (1.0 - grassVeto);
    float heightGate = smoothstep(5.0, 12.0, vWorldPos.y);
    float rockMask   = autoRock * heightGate;

    // ── 3. Triplanar UVs ──────────────────────────────────────────────────────
    vec2 gravelUV = triplanarUV(vWorldPos, vNormal, 12.0);
    vec2 grassUV  = triplanarUV(vWorldPos, vNormal,  8.0);
    vec2 rockUV   = triplanarUV(vWorldPos, vNormal,  6.0);

    // ── 4. Albedo samples ─────────────────────────────────────────────────────
    vec4 cGravel = texture2D(u_gravel_alb, gravelUV);
    vec4 cTarmac = texture2D(u_tarmac_alb, gravelUV * 0.7);
    vec4 cGrass  = texture2D(u_grass_alb,  grassUV);
    vec4 cRock   = texture2D(u_rock_alb,   rockUV);
    vec4 cMoss   = texture2D(u_moss_alb,   rockUV * 1.5);
    float mossW  = (1.0 - heightT) * 0.5 * rockMask;
    vec4 cRockF  = mix(cRock, cMoss, mossW);

    // ── 5. Terrain base colour ────────────────────────────────────────────────
    vec4 mudTint  = cGravel * vec4(0.55, 0.40, 0.30, 1.0);
    vec4 baseColor = cGrass  * wGrass
                   + cGravel * wGravel
                   + cTarmac * wTarmac
                   + mudTint  * wMud;
    baseColor = mix(baseColor, cRockF, smoothstep(0.2, 0.7, rockMask));

    // ── 6. OB hide in PLAY mode ───────────────────────────────────────────────
    // OB pixels: high gravel (R=1), low tarmac+mud — render as grass
    if (u_playMode > 0.5) {
        float isOB = step(0.85, wGravel) * (1.0 - step(0.1, wTarmac + wMud));
        baseColor  = mix(baseColor, cGrass, isOB);
    }

    // ── 7. Road mask (vertex R-channel) ──────────────────────────────────────
    float roadMask  = vColor.r;
    float roadSmooth = smoothstep(0.0, 1.0, roadMask);
    float roadAO    = texture2D(u_gravel_ao, gravelUV).r;
    
    // Dynamically calculate road texture based on underlying splat weights
    vec4  roadBase = cGravel * wGravel + cTarmac * wTarmac + mudTint * wMud;
    float roadWeightSum = wGravel + wTarmac + wMud;
    if (roadWeightSum > 0.001) {
        roadBase = roadBase / roadWeightSum;
    } else {
        roadBase = cGravel;
    }
    
    vec4  roadColor = roadBase * roadAO;
    // Tire tracks darken via B-channel
    float tireTracks = vColor.b * roadMask;
    roadColor.rgb   *= (1.0 - tireTracks * 0.30);
    vec4 terrainColor = mix(baseColor, roadColor, roadSmooth);

    // ── 8. Normal maps ────────────────────────────────────────────────────────
    vec3 nGravel = unpackNormal(texture2D(u_gravel_nrm, gravelUV));
    vec3 nGrass  = unpackNormal(texture2D(u_grass_nrm,  grassUV));
    vec3 nRock   = unpackNormal(texture2D(u_rock_nrm,   rockUV));
    float wNGravel = clamp(wGravel + roadMask, 0.0, 1.0);
    vec3 detailN = normalize(nGrass * wGrass + nGravel * wNGravel + nRock * rockMask);
    vec3 finalN  = normalize(vNormal + detailN * 0.35);

    // ── 9. Lighting ───────────────────────────────────────────────────────────
    float diff    = max(dot(finalN, normalize(u_sunDir)), 0.0);
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
                float normalAtten = max(dot(finalN, -toLight1Dir), 0.0);
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
                float normalAtten = max(dot(finalN, -toLight2Dir), 0.0);
                totalLight += vec3(1.0, 0.98, 0.90) * coneAtten * distAtten * normalAtten * 2.8 * u_headlightIntensity;
            }
        }
    }

    vec4 litColor = vec4(terrainColor.rgb * totalLight, terrainColor.a);

    // ── 10. Distance fog ──────────────────────────────────────────────────────
    float fogT = smoothstep(u_fogNear, u_fogFar, vFogDepth);
    vec3  final = mix(litColor.rgb, u_fogColor, fogT);

    gl_FragColor = vec4(final, 1.0);
}
`;

    // ── buildTerrainMaterial ──────────────────────────────────────────────────
    function buildTerrainMaterial(textures, opts) {
        opts = opts || {};
        const sunDir = opts.sunDir || new THREE.Vector3(0.6, 0.8, 0.4).normalize();
        return new THREE.ShaderMaterial({
            uniforms: {
                u_splat:            { value: opts.splatTex   || null },
                u_grass_alb:        { value: textures.grass_alb  },
                u_grass_nrm:        { value: textures.grass_nrm  },
                u_gravel_alb:       { value: textures.gravel_alb },
                u_gravel_nrm:       { value: textures.gravel_nrm },
                u_gravel_rgh:       { value: textures.gravel_rgh },
                u_gravel_ao:        { value: textures.gravel_ao  },
                u_tarmac_alb:       { value: textures.tarmac_alb },
                u_tarmac_nrm:       { value: textures.tarmac_nrm },
                u_rock_alb:         { value: textures.rock_alb   },
                u_rock_nrm:         { value: textures.rock_nrm   },
                u_moss_alb:         { value: textures.moss_alb   },
                u_sunDir:           { value: sunDir },
                u_fogColor:         { value: new THREE.Color(opts.fogColor || 0x87ceeb) },
                u_fogNear:          { value: opts.fogNear  !== undefined ? opts.fogNear  : 200.0  },
                u_fogFar:           { value: opts.fogFar   !== undefined ? opts.fogFar   : 1800.0 },
                u_terrainMaxHeight: { value: opts.terrainMaxHeight || 120.0 },
                u_playMode:         { value: 0.0 },
                u_ambientIntensity: { value: 0.38 },
                u_sunIntensity:     { value: 1.0 },
                u_sunColor:         { value: new THREE.Color(0xffffff) },
                u_headlightIntensity: { value: 0.0 },
                u_headlight1Pos:     { value: new THREE.Vector3() },
                u_headlight1Dir:     { value: new THREE.Vector3() },
                u_headlight2Pos:     { value: new THREE.Vector3() },
                u_headlight2Dir:     { value: new THREE.Vector3() },
            },
            vertexShader:   TERRAIN_VERT,
            fragmentShader: TERRAIN_FRAG,
            vertexColors:   true,
        });
    }

    // ── Expose ────────────────────────────────────────────────────────────────
    window.terrainShaderMaterial = {
        buildTerrainMaterial,
        TERRAIN_VERT,
        TERRAIN_FRAG,
    };

})();
