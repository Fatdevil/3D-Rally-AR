/* =============================================================================
 * toonClouds.js  —  Cartoonish moln i Shinkai-stil (rim-ljus + färgad skugga)
 * -----------------------------------------------------------------------------
 * Innehåller:
 *   • makeToonCloudMaterial(opts)  -> material för klumpiga 3D-moln (flyg förbi dem)
 *   • makePuffTexture(type)        -> procedurell mjuk molntextur (4 varianter)
 *   • CloudField                   -> sprider ut moln i lager (billboards + 3D-klumpar)
 * ============================================================================= */

(function() {
  'use strict';

  const CLOUD_PRESETS = {
    brightNoon: {
      lit: '#ffffff', shadow: '#7d9fd6', rim: '#fff4d8', rimStrength: 0.6,
    },
    goldenAfternoon: {                       // DEFAULT
      lit: '#fff2da', shadow: '#6f7fc4', rim: '#ffd9a0', rimStrength: 1.0,
    },
    pinkDusk: {
      lit: '#ffe6e0', shadow: '#6a5a9a', rim: '#ffc0d0', rimStrength: 1.3,
    },
    stormyNight: {                           // Presets för natt/storm
      lit: '#4a4d6b', shadow: '#1a1b2e', rim: '#313552', rimStrength: 0.2,
    }
  };

  /* ---------------------------------------------------------------------------
   * Toon-material för klumpiga 3D-moln (icosaeder-kluster)
   * ------------------------------------------------------------------------- */
  function makeToonCloudMaterial(opts = {}) {
    const uniforms = {
      uSunDir:      { value: (opts.sunDir   || new THREE.Vector3(0.55,0.42,-0.6)).clone().normalize() },
      uLit:         { value: new THREE.Color(opts.lit    || '#fff2da') },
      uShadow:      { value: new THREE.Color(opts.shadow || '#6f7fc4') },
      uRim:         { value: new THREE.Color(opts.rim    || '#ffd9a0') },
      uRimPower:    { value: opts.rimPower    ?? 2.5 },
      uRimStrength: { value: opts.rimStrength ?? 1.0 },
      uFogColor:    { value: new THREE.Color(opts.fogColor || '#ffd9a0') },
      uFogNear:     { value: opts.fogNear ?? 600 },
      uFogFar:      { value: opts.fogFar  ?? 3000 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV; varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld  = wp.xyz;
          vN      = normalize(mat3(modelMatrix) * normal);
          vV      = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3  uSunDir, uLit, uShadow, uRim, uFogColor;
        uniform float uRimPower, uRimStrength, uFogNear, uFogFar;
        varying vec3  vN; varying vec3 vV; varying vec3 vWorld;

        // Enkel brusfunktion för att ge skuggkanterna en "målad" pensel-karaktär
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float vnoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0,0.0)), f.x),
            mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), f.x),
            f.y
          );
        }

        void main() {
          vec3 N = normalize(vN);
          vec3 V = normalize(vV);
          vec3 L = normalize(uSunDir);

          // Reducerat brus för att framhäva låg-poly fasetterna och ge krispiga triangulära skuggor
          float noise = vnoise(vWorld.xz * 0.15 + vWorld.y * 0.1) * 0.04 - 0.02;
          float ndl   = dot(N, L) * 0.5 + 0.5 + noise;
          
          // Krispig tvåtons-ramp för cel-shaded low-poly utseende
          float ramp  = smoothstep(0.35, 0.40, ndl) * 0.45
                      + smoothstep(0.55, 0.60, ndl) * 0.55;
          vec3 col    = mix(uShadow, uLit, ramp);

          // Rim-/kantljus — starkast på kanter, boostat när solen är BAKOM molnet
          float edge     = pow(1.0 - max(dot(N, V), 0.0), uRimPower);
          float backlit  = max(dot(-V, L), 0.0);            // tittar mot solen genom kanten
          float rim      = edge * (0.35 + 0.65 * backlit) * uRimStrength;
          col += uRim * rim;

          // Atmosfärisk fade mot horisontfärgen
          float dist = length(cameraPosition - vWorld);
          float f    = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
          col = mix(col, uFogColor, f);

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    material.userData.uniforms = uniforms;
    return material;
  }

  /* ---------------------------------------------------------------------------
   * Procedurell mjuk molntextur (radiell soft puff) — 4 varianter för variation
   * ------------------------------------------------------------------------- */
  function makePuffTexture(type = 0, size = 256) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, size, size);

    // Olika former beroende på typ
    if (type === 0) {
      // Standard fluffigt cumulus-moln (4-6 blobbar)
      const blobs = 5 + Math.floor(Math.random() * 2);
      for (let i = 0; i < blobs; i++) {
        const x = size * (0.35 + 0.3 * Math.random());
        const y = size * (0.45 + 0.2 * Math.random());
        const r = size * (0.16 + 0.14 * Math.random());
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
        g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
        g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    } else if (type === 1) {
      // Puffs i grupp (mindre utsträckt, fluffigare form)
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const x = size * (0.35 + 0.3 * (i / (steps - 1)));
        const y = size * (0.46 + 0.06 * (Math.random() - 0.5));
        const r = size * (0.15 + 0.08 * Math.random()) * (1.0 - Math.abs(i - steps/2) / steps);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.3);
        g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
        g.addColorStop(0.55, 'rgba(255,255,255,0.85)');
        g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    } else if (type === 2) {
      // Höghöjdsmoln (Cirrocumulus, många små puffar)
      const puffs = 12;
      for (let i = 0; i < puffs; i++) {
        const x = size * (0.2 + 0.6 * Math.random());
        const y = size * (0.3 + 0.4 * Math.random());
        const r = size * (0.05 + 0.05 * Math.random());
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.6, 'rgba(255,255,255,0.7)');
        g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    } else {
      // Högt/tornande moln (Cumulus Congestus)
      const layers = 5;
      for (let i = 0; i < layers; i++) {
        const x = size * (0.4 + 0.2 * Math.random());
        const y = size * (0.7 - 0.1 * i - 0.05 * Math.random());
        const r = size * (0.15 + 0.1 * Math.random()) * (1.0 - i * 0.15);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.3);
        g.addColorStop(0.0, 'rgba(255,255,255,1.0)');
        g.addColorStop(0.6, 'rgba(255,255,255,0.85)');
        g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------------------------------------------------------------------------
   * Billboard-molnmaterial: projektiv belysning baserad på solens 3D-riktning
   * ------------------------------------------------------------------------- */
  function makeBillboardCloudMaterial(tex, opts = {}) {
    const uniforms = {
      uMap:      { value: tex },
      uSunDir:   { value: (opts.sunDir || new THREE.Vector3(0.55,0.42,-0.6)).clone().normalize() },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp:    { value: new THREE.Vector3(0, 1, 0) },
      uLit:      { value: new THREE.Color(opts.lit    || '#fff2da') },
      uShadow:   { value: new THREE.Color(opts.shadow || '#9fb0e0') },
      uFogColor: { value: new THREE.Color(opts.fogColor || '#ffd9a0') },
      uFogNear:  { value: opts.fogNear ?? 900 },
      uFogFar:   { value: opts.fogFar  ?? 4000 },
    };

    const m = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
        varying vec2 vUv; varying vec3 vWorld;
        void main() {
          vUv = uv;
          vWorld = (modelMatrix * vec4(position,1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uMap; 
        uniform vec3 uSunDir, uCamRight, uCamUp, uLit, uShadow, uFogColor;
        uniform float uFogNear, uFogFar;
        varying vec2 vUv; varying vec3 vWorld;

        void main() {
          vec4 t = texture2D(uMap, vUv);
          if (t.a < 0.02) discard;

          // Projicera solriktningen på kamerans Right- och Up-vektorer för att
          // räkna ut exakt var solen träffar billboard-planets 2D-yta.
          vec3 L = normalize(uSunDir);
          float lightX = dot(normalize(uCamRight), L);
          float lightY = dot(normalize(uCamUp), L);

          // Flytta ljus/skugggradienten i molnet baserat på projicerat solljus
          vec2 centerUv = vUv - vec2(0.5);
          float lightFactor = dot(centerUv, vec2(lightX, lightY)) * 2.0;

          // Skuggan på undersidan/baksidan får en svalare, målad karaktär
          vec3 col = mix(uShadow, uLit, smoothstep(-0.4, 0.4, lightFactor + 0.15));

          // Atmosfärisk fade mot horisontfärgen
          float dist = length(cameraPosition - vWorld);
          float f = clamp((dist - uFogNear)/(uFogFar - uFogNear), 0.0, 1.0);
          col = mix(col, uFogColor, f);

          gl_FragColor = vec4(col, t.a);
        }
      `,
    });
    m.userData.uniforms = uniforms;
    return m;
  }

  /* ---------------------------------------------------------------------------
   * CloudField — Hanterar molnfältet med position-wrapping, belysningssynk
   * och weather/density-styrning.
   * ------------------------------------------------------------------------- */
  class CloudField {
    constructor(scene, opts = {}) {
      this.scene = scene;
      this.group = new THREE.Group();
      scene.add(this.group);

      this.cfg = {
        count:       opts.count       ?? 6,     // Mycket färre moln (från 10) för dramatiska öppna ytor
        billboards:  opts.billboards  ?? 12,    // Färre bakgrundspuffar (från 16)
        areaRadius:  opts.areaRadius  ?? 1800,  // Hur långt molnen sprider sig
        minAlt:      opts.minAlt      ?? 140,   // Molnhöjd min
        maxAlt:      opts.maxAlt      ?? 380,   // Molnhöjd max
        drift:       opts.drift       ?? new THREE.Vector3(2.0, 0, 0), // Långsam drift i m/s
        sunDir:      (opts.sunDir || new THREE.Vector3(0.55,0.42,-0.6)).clone().normalize(),
        fogColor:    new THREE.Color(opts.fogColor || '#ffd9a0'),
      };

      // Skapa material
      this.toonMat = makeToonCloudMaterial({ sunDir: this.cfg.sunDir, fogColor: this.cfg.fogColor });
      
      // Skapa material och texturer för billboards (variera med 4 olika procedurella former)
      this.bbTextures = [
        makePuffTexture(0),
        makePuffTexture(1),
        makePuffTexture(2),
        makePuffTexture(3),
      ];

      // Arrayer för att hålla reda på molnen
      this._volumeClouds = [];
      this._billboards = [];
      this._bbMaterials = [];

      this._buildVolumeClouds();
      this._buildBillboards();
      
      this.applyPreset(opts.preset || 'goldenAfternoon');
      this.currentDensity = 1.0;
    }

    // Skapar ett tornande kluster av låg-poly fasetterade sfärer (cumulonimbus)
    _makeCloudCluster() {
      const cloud = new THREE.Group();
      
      // Skapa en icke-indexerad icosaeder för att få platta, skarpa fasetter (flat shading)
      const baseIndexed = new THREE.IcosahedronGeometry(1, 1);
      const baseGeo = baseIndexed.toNonIndexed();
      baseGeo.computeVertexNormals();
      baseIndexed.dispose(); // Städa upp temporär geometri

      // Vi bygger molnet i 3 vertikala nivåer (Tiers) för att få en tornande cumulonimbus-form
      const baseScale = 45 + Math.random() * 15;

      // Tier 0: Bas-nivå (stora runda sfärer som ligger i botten och breder ut sig)
      const baseLobes = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < baseLobes; i++) {
        const m = new THREE.Mesh(baseGeo, this.toonMat);
        const s = baseScale * (0.85 + Math.random() * 0.3);
        // Baslobberna är runda och fylliga (ingen platt X/Y-skevning)
        m.scale.set(
          s * (1.1 + Math.random() * 0.2),
          s * (0.85 + Math.random() * 0.15),
          s * (1.0 + Math.random() * 0.2)
        );
        // Placera ut i en cirkel i botten
        const angle = (i / baseLobes) * Math.PI * 2 + Math.random() * 0.5;
        const dist = baseScale * (0.25 + Math.random() * 0.25);
        m.position.set(
          Math.cos(angle) * dist,
          s * 0.1,
          Math.sin(angle) * dist
        );
        m.rotation.set(Math.random() * 0.2, Math.random() * Math.PI, Math.random() * 0.2);
        cloud.add(m);
      }

      // Tier 1: Mellan-nivå (medelstora sfärer staplade ovanpå basen, närmare mitten)
      const midLobes = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < midLobes; i++) {
        const m = new THREE.Mesh(baseGeo, this.toonMat);
        const s = baseScale * (0.6 + Math.random() * 0.2);
        m.scale.set(
          s * (0.95 + Math.random() * 0.15),
          s * (1.0 + Math.random() * 0.2), // Något högre/ovalare vertikalt
          s * (0.95 + Math.random() * 0.15)
        );
        const angle = (i / midLobes) * Math.PI * 2 + Math.random() * 0.5;
        const dist = baseScale * (0.15 + Math.random() * 0.15);
        m.position.set(
          Math.cos(angle) * dist,
          baseScale * (0.45 + Math.random() * 0.2), // Höjdläge
          Math.sin(angle) * dist
        );
        m.rotation.set(Math.random() * 0.2, Math.random() * Math.PI, Math.random() * 0.2);
        cloud.add(m);
      }

      // Tier 2: Topp-nivå (små kronande sfärer som skapar toppen av molntornet)
      const topLobes = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < topLobes; i++) {
        const m = new THREE.Mesh(baseGeo, this.toonMat);
        const s = baseScale * (0.35 + Math.random() * 0.15);
        m.scale.set(s, s * (1.0 + Math.random() * 0.1), s);
        m.position.set(
          (Math.random() - 0.5) * baseScale * 0.2,
          baseScale * (0.85 + Math.random() * 0.15), // Peak-höjd
          (Math.random() - 0.5) * baseScale * 0.2
        );
        m.rotation.set(Math.random() * 0.2, Math.random() * Math.PI, Math.random() * 0.2);
        cloud.add(m);
      }

      return cloud;
    }

    _buildVolumeClouds() {
      for (let i = 0; i < this.cfg.count; i++) {
        const cloud = this._makeCloudCluster();
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * this.cfg.areaRadius;
        cloud.position.set(
          Math.cos(a) * r,
          this.cfg.minAlt + Math.random() * (this.cfg.maxAlt - this.cfg.minAlt),
          Math.sin(a) * r
        );
        this.group.add(cloud);
        this._volumeClouds.push(cloud);
      }
    }

    _buildBillboards() {
      const geo = new THREE.PlaneGeometry(1, 1);

      for (let i = 0; i < this.cfg.billboards; i++) {
        // Slumpa en av de 4 procedurella formerna
        const texIndex = Math.floor(Math.random() * this.bbTextures.length);
        const tex = this.bbTextures[texIndex];

        // Skapa ett unikt material per texturtyp
        const mat = makeBillboardCloudMaterial(tex, { sunDir: this.cfg.sunDir, fogColor: this.cfg.fogColor });
        this._bbMaterials.push(mat);

        const m = new THREE.Mesh(geo, mat);
        const s = 400 + Math.random() * 500; // DUBBLERAD STORLEK (från 180+random*320)
        m.scale.set(s * 1.5, s * 0.65, 1); // Gör bomullstuss-molnen mer utsträckta och avlånga horisontellt

        const a = Math.random() * Math.PI * 2;
        const r = this.cfg.areaRadius * (0.6 + Math.random() * 0.8); // Placera längre ut
        m.position.set(
          Math.cos(a) * r,
          this.cfg.minAlt + Math.random() * (this.cfg.maxAlt - this.cfg.minAlt) + 50,
          Math.sin(a) * r
        );
        
        this.group.add(m);
        this._billboards.push(m);
      }
    }

    applyPreset(name) {
      const p = CLOUD_PRESETS[name];
      if (!p) { console.warn('Okänt cloud-preset:', name); return; }

      // Uppdatera 3D-molnens material
      const tu = this.toonMat.userData.uniforms;
      tu.uLit.value.set(p.lit);
      tu.uShadow.value.set(p.shadow);
      tu.uRim.value.set(p.rim);
      tu.uRimStrength.value = p.rimStrength;

      // Uppdatera alla billboard-material
      for (const mat of this._bbMaterials) {
        const bu = mat.userData.uniforms;
        bu.uLit.value.set(p.lit);
        bu.uShadow.value.set(p.shadow);
      }

      this.preset = name;
      return this;
    }

    // Styr hur många moln som ska ritas (0.0 till 1.0)
    setDensity(factor) {
      this.currentDensity = factor;
      
      const active3D = Math.round(this._volumeClouds.length * factor);
      this._volumeClouds.forEach((c, idx) => {
        c.visible = idx < active3D;
      });

      const activeBB = Math.round(this._billboards.length * factor);
      this._billboards.forEach((m, idx) => {
        m.visible = idx < activeBB;
      });

      // Synka reglaget i gränssnittet om det finns
      const slider = document.getElementById('set-cloud-density');
      if (slider) {
        slider.value = factor;
        const valSpan = document.getElementById('cloud-val');
        if (valSpan) valSpan.textContent = Math.round(factor * 100) + '%';
      }
    }

    // Anpassar molntyp, färg och mängd efter vädret (bevara valfri användardensitet om önskat)
    setWeatherPreset(weatherType, preserveDensity = false) {
      if (weatherType === 'CLEAR') {
        if (!preserveDensity) this.setDensity(0.35); // Glesare, finare moln
        this.applyPreset(this.preset || 'goldenAfternoon'); // Standard ljus färg
      } else if (weatherType === 'OVERCAST' || weatherType === 'RAIN' || weatherType === 'STORM') {
        if (!preserveDensity) this.setDensity(1.0);  // Max täthet
        this.applyPreset('stormyNight'); // Mörkare, lila/gråa moln
      } else if (weatherType === 'FOG' || weatherType === 'DRIZZLE') {
        if (!preserveDensity) this.setDensity(0.6);  // Medellager som smälter in
        this.applyPreset(this.preset || 'goldenAfternoon');
      }
    }

    // Synka mot himlens belysning och dimma
    setSun(sunDir) {
      this.toonMat.userData.uniforms.uSunDir.value.copy(sunDir).normalize();
      for (const mat of this._bbMaterials) {
        mat.userData.uniforms.uSunDir.value.copy(sunDir).normalize();
      }
    }

    setFogColor(color) {
      this.cfg.fogColor.copy(color);
      this.toonMat.userData.uniforms.uFogColor.value.copy(color);
      for (const mat of this._bbMaterials) {
        mat.userData.uniforms.uFogColor.value.copy(color);
      }
    }

    update(dt, camera) {
      // 1. Långsam drift i fältet
      this.group.position.addScaledVector(this.cfg.drift, dt);

      // 2. Position-wrapping: förhindra att molnen driver iväg för alltid
      const halfArea = this.cfg.areaRadius;
      
      this._volumeClouds.forEach(c => {
        // Räkna ut global position med hänsyn till gruppförflyttning
        const globalX = c.position.x + this.group.position.x;
        if (globalX > halfArea) {
          c.position.x -= halfArea * 2;
          c.position.z = (Math.random() - 0.5) * halfArea * 1.5;
        } else if (globalX < -halfArea) {
          c.position.x += halfArea * 2;
          c.position.z = (Math.random() - 0.5) * halfArea * 1.5;
        }
      });

      // Extrahera kamerans bas-vektorer för att projicera solljus på billboards
      let camRight, camUp;
      if (camera) {
        camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        camUp    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      }

      this._billboards.forEach(m => {
        // Wrapping
        const globalX = m.position.x + this.group.position.x;
        if (globalX > halfArea) {
          m.position.x -= halfArea * 2;
          m.position.z = (Math.random() - 0.5) * halfArea * 2;
        } else if (globalX < -halfArea) {
          m.position.x += halfArea * 2;
          m.position.z = (Math.random() - 0.5) * halfArea * 2;
        }

        // Vänd billboards mot kameran
        if (camera) {
          m.quaternion.copy(camera.quaternion);
          // Skicka in kamerans Right och Up-vektorer för ljusberäkningen i shader
          m.material.uniforms.uCamRight.value.copy(camRight);
          m.material.uniforms.uCamUp.value.copy(camUp);
        }
      });
    }

    dispose() {
      this.scene.remove(this.group);
      this.toonMat.dispose();
      for (const mat of this._bbMaterials) mat.dispose();
      for (const tex of this.bbTextures) tex.dispose();
    }
  }

  window.CLOUD_PRESETS = CLOUD_PRESETS;
  window.CloudField = CloudField;
})();
