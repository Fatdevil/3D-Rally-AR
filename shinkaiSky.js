/* =============================================================================
 * shinkaiSky.js  —  Gradient-himmel i Makoto Shinkai-stil
 * -----------------------------------------------------------------------------
 * En sky-dome med custom shader: vertikal flerstegsgradient, solglöd och
 * horisontdis. Detta är ~halva looken — översaturerad, lysande himmel.
 * ============================================================================= */

(function() {
  'use strict';

  const SKY_PRESETS = {
    // Klarblå middag — hög sol, djupblått, krispigt
    brightNoon: {
      zenith:   '#1f6fd6', horizon: '#bfe6ff', ground: '#6f8aa0',
      sunColor: '#fff6e0', sunDir: [0.2, 0.95, 0.25],
      sunSize: 900, sunIntensity: 0.9, horizonGlow: 0.5,
    },
    // Gyllene eftermiddag — DEFAULT, varm, låg sol, glödande horisont
    goldenAfternoon: {
      zenith:   '#2a6bc4', horizon: '#ffd9a0', ground: '#8a7560',
      sunColor: '#ffdca0', sunDir: [0.55, 0.42, -0.6],
      sunSize: 350, sunIntensity: 1.4, horizonGlow: 1.0,
    },
    // Rosa skymning — låg sol, persika/rosa/lila, drömskt
    pinkDusk: {
      zenith:   '#3a4a9c', horizon: '#ffb6c8', ground: '#5a4a6a',
      sunColor: '#ffc6b0', sunDir: [0.7, 0.18, -0.5],
      sunSize: 220, sunIntensity: 1.7, horizonGlow: 1.3,
    },
  };

  const VERT = /* glsl */`
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);          // domen centreras på kameran -> riktning = position
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uZenith;
    uniform vec3  uHorizon;
    uniform vec3  uGround;
    uniform vec3  uSunColor;
    uniform vec3  uSunDir;
    uniform float uSunSize;       // högre = mindre, skarpare sol
    uniform float uSunIntensity;
    uniform float uHorizonGlow;
    varying vec3  vDir;

    void main() {
      vec3 dir = normalize(vDir);
      float h  = dir.y;                                   // -1 (ner) .. 1 (upp)

      // Vertikal gradient horisont -> zenit (biasad så horisonten får mer plats)
      float t   = pow(clamp(h, 0.0, 1.0), 0.55);
      vec3 sky  = mix(uHorizon, uZenith, t);

      // Under horisonten -> marktonen
      sky = mix(sky, uGround, clamp(-h * 3.0, 0.0, 1.0));

      // Horisontdis, koncentrerad mot solsidan
      vec3  L     = normalize(uSunDir);
      float band  = exp(-abs(h) * 6.0);                   // tunn band vid horisonten
      float toSun = max(dot(normalize(vec3(dir.x, 0.0, dir.z)),
                            normalize(vec3(L.x, 0.0, L.z))), 0.0);
      sky += uSunColor * band * uHorizonGlow * (0.35 + 0.65 * toSun);

      // Solglöd
      float sd   = max(dot(dir, L), 0.0);
      float glow = pow(sd, uSunSize);
      sky += uSunColor * glow * uSunIntensity;
      // Mjuk halo runt solen
      sky += uSunColor * pow(sd, 8.0) * 0.25 * uSunIntensity;

      gl_FragColor = vec4(sky, 1.0);
    }
  `;

  class ShinkaiSky {
    constructor(scene, opts = {}) {
      this.scene  = scene;
      this.radius = opts.radius || 4000;
      this.sunDir = new THREE.Vector3(0.55, 0.42, -0.6).normalize();

      this.uniforms = {
        uZenith:       { value: new THREE.Color('#2a6bc4') },
        uHorizon:      { value: new THREE.Color('#ffd9a0') },
        uGround:       { value: new THREE.Color('#8a7560') },
        uSunColor:     { value: new THREE.Color('#ffdca0') },
        uSunDir:       { value: this.sunDir },
        uSunSize:      { value: 350 },
        uSunIntensity: { value: 1.4 },
        uHorizonGlow:  { value: 1.0 },
      };

      const mat = new THREE.ShaderMaterial({
        vertexShader:   VERT,
        fragmentShader: FRAG,
        uniforms:       this.uniforms,
        side:           THREE.BackSide,
        depthWrite:     false,            // ritas alltid bakom allt annat
        fog:            false,
      });

      const geo = new THREE.SphereGeometry(this.radius, 32, 16);
      this.mesh = new THREE.Mesh(geo, mat);
      this.mesh.renderOrder = -1;
      scene.add(this.mesh);

      this.applyPreset(opts.preset || 'goldenAfternoon');
    }

    applyPreset(name) {
      const p = SKY_PRESETS[name];
      if (!p) { console.warn('Okänt sky-preset:', name); return; }
      this.uniforms.uZenith.value.set(p.zenith);
      this.uniforms.uHorizon.value.set(p.horizon);
      this.uniforms.uGround.value.set(p.ground);
      this.uniforms.uSunColor.value.set(p.sunColor);
      this.sunDir.fromArray(p.sunDir).normalize();
      this.uniforms.uSunSize.value      = p.sunSize;
      this.uniforms.uSunIntensity.value = p.sunIntensity;
      this.uniforms.uHorizonGlow.value  = p.horizonGlow;
      this.preset = name;
      return this;
    }

    // Håll domen centrerad på kameran
    update(camera) {
      if (camera) this.mesh.position.copy(camera.position);
    }

    // Bekväm åtkomst för molnmodulen (matcha ljus + horisontfärg)
    get horizonColor() { return this.uniforms.uHorizon.value; }
    get sunColor()     { return this.uniforms.uSunColor.value; }

    dispose() {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
  }

  window.SKY_PRESETS = SKY_PRESETS;
  window.ShinkaiSky = ShinkaiSky;
})();
