/* =============================================================================
 * pilotRig.js  —  Driver för pilotens torso-lutning, huvud och hjälmöron
 * -----------------------------------------------------------------------------
 * pilot_rigged.glb har fyra animerbara ben:
 *   'torso' — pilotens överkropp (pivot vid midjan) → lutar in i kurvorna
 *   'head'  — hjälmhuvudet (barn till torso → följer lutningen + tittar)
 *   'earL' / 'earR' — hjälmöronen (barn till head → fladdrar)
 *
 *  ANVÄNDNING
 *  ----------
 *   import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
 *   new GLTFLoader().load('pilot_rigged.glb', (gltf) => {
 *     scene.add(gltf.scene);                 // detta ÄR planet + piloten
 *     pilot = setupPilot(gltf.scene);
 *   });
 *   // varje frame:
 *   updatePilot(pilot, dt, airspeed, turn);  // airspeed m/s, turn -1..1
 *
 *  turn = åt vilket håll planet svänger/rollar (-1..1). Koppla till din roll/
 *  sväng-input. airspeed till flygmodellens fart.
 * ============================================================================= */

export function setupPilot(model) {
  return {
    torso: model.getObjectByName('torso'),
    head:  model.getObjectByName('head'),
    earL:  model.getObjectByName('earL'),
    earR:  model.getObjectByName('earR'),
    t: 0,
  };
}

export function updatePilot(rig, dt, airspeed = 0, turn = 0) {
  rig.t += dt;
  const speed01 = Math.min(Math.max(airspeed, 0) / 60, 1);   // normaliserad fart (60 = toppfart)
  const k = 1 - Math.exp(-6 * dt);                            // mjuk följning

  // ── Överkroppen lutar in i kurvan ──
  if (rig.torso) {
    const targetLean = turn * 0.30;                          // ~17° vid full sväng (vänd tecken om fel håll)
    rig.torso.rotation.z += (targetLean - rig.torso.rotation.z) * k;
  }

  // ── Huvudet tittar in i kurvan (utöver torsons lutning) ──
  if (rig.head) {
    const targetYaw = -turn * 0.45;
    rig.head.rotation.y += (targetYaw - rig.head.rotation.y) * k;
  }

  // ── Hjälmöronen fladdrar — mer ju snabbare det går ──
  const amp  = 0.05 + 0.55 * speed01;
  const freq = 16 + 24 * speed01;
  if (rig.earL) rig.earL.rotation.z =  amp * Math.sin(rig.t * freq);
  if (rig.earR) rig.earR.rotation.z = -amp * Math.sin(rig.t * freq + 1.3);
}
