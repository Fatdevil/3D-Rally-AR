// ================================================================
//  AUDIO ENGINE — Procedural Golf Sounds via Web Audio API
//  Zero audio files. All sounds synthesized in real-time.
//
//  Depends on: window.matchSettings, window.ACTIVE_BIOME
//
//  Exposes:
//  - window.AudioEngine.init()          — Must call after user gesture
//  - window.AudioEngine.setEnabled(bool)
//  - window.AudioEngine.setVolume(0–1)
//  - window.AudioEngine.isEnabled()
//  - window.AudioEngine.getVolume()
//  - window.AudioEngine.playSwing(clubKey)   — 'DRIVER'|'I7'|'PUTT' etc.
//  - window.AudioEngine.playImpact(clubKey)  — Ball strike
//  - window.AudioEngine.playBounce()         — Ball hits ground
//  - window.AudioEngine.playHoled(scoreText) — Ball in hole
//  - window.AudioEngine.playApplause()       — Crowd reaction
//  - window.AudioEngine.playClick()          — UI tap
//  - window.AudioEngine.startAmbient(biome)  — Looping ambient
//  - window.AudioEngine.stopAmbient()
//  - window.AudioEngine.updateAmbientForBiome(biome)
// ================================================================
(function() {
    'use strict';

    let _ctx        = null;   // AudioContext (lazy-init on first user gesture)
    let _enabled    = true;
    let _volume     = 0.6;
    let _ambientGain = null;
    let _masterGain  = null;
    let _ambientNodes = [];   // Active ambient oscillators/sources
    let _ambientBiome = null;
    let _initialized = false;

    // Restore from localStorage
    try {
        let saved = localStorage.getItem('golfos_audio');
        if (saved) {
            let data = JSON.parse(saved);
            if (typeof data.enabled === 'boolean') _enabled = data.enabled;
            if (typeof data.volume  === 'number')  _volume  = data.volume;
        }
    } catch(e) {}

    function _save() {
        try {
            localStorage.setItem('golfos_audio', JSON.stringify({ enabled: _enabled, volume: _volume }));
        } catch(e) {}
    }

    // ---------------------------------------------------------------
    // INIT — Creates AudioContext. Must be called from a user gesture
    // (click/touch) to satisfy browser autoplay policy.
    // Safe to call multiple times — only initializes once.
    // ---------------------------------------------------------------
    function init() {
        if (_initialized) return;
        try {
            _ctx = new (window.AudioContext || window.webkitAudioContext)();
            _masterGain = _ctx.createGain();
            _masterGain.gain.value = _enabled ? _volume : 0;
            _masterGain.connect(_ctx.destination);

            _ambientGain = _ctx.createGain();
            _ambientGain.gain.value = 0.25; // Ambient is quieter than effects
            _ambientGain.connect(_masterGain);

            _initialized = true;
            console.log('[AudioEngine] Initialized ✅');

            // Resume context if suspended (iOS Safari requirement)
            if (_ctx.state === 'suspended') {
                _ctx.resume();
            }
        } catch(e) {
            console.warn('[AudioEngine] Web Audio not available:', e);
        }
    }

    function _ensureCtx() {
        if (!_initialized) init();
        if (!_ctx) return false;
        if (_ctx.state === 'suspended') _ctx.resume();
        return _enabled && _initialized;
    }

    // ---------------------------------------------------------------
    // UTILITY: Create noise buffer (white noise source)
    // ---------------------------------------------------------------
    function _noiseBuffer(duration) {
        let len = Math.floor(_ctx.sampleRate * duration);
        let buf = _ctx.createBuffer(1, len, _ctx.sampleRate);
        let data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        return buf;
    }

    // ---------------------------------------------------------------
    // UTILITY: Quick envelope helper
    // ---------------------------------------------------------------
    function _env(param, attacks, t0) {
        let t = t0;
        for (let i = 0; i < attacks.length; i += 2) {
            let val = attacks[i];
            let dur = attacks[i+1];
            param.linearRampToValueAtTime(val, t + dur);
            t += dur;
        }
        return t;
    }

    // ---------------------------------------------------------------
    // SWING WHOOSH — Filtered noise burst with pitch sweep
    // Driver = longer, deeper. Putter = short, soft.
    // ---------------------------------------------------------------
    function playSwing(clubKey) {
        if (!_ensureCtx()) return;
        let now = _ctx.currentTime;

        // Club-specific parameters
        let duration, filterStart, filterEnd, volume;
        if (clubKey === 'PUTT') {
            duration = 0.15; filterStart = 800; filterEnd = 400; volume = 0.15;
        } else if (clubKey === 'DRIVER' || clubKey === 'W3') {
            duration = 0.35; filterStart = 600; filterEnd = 2500; volume = 0.5;
        } else {
            duration = 0.25; filterStart = 700; filterEnd = 2000; volume = 0.4;
        }

        let noise = _ctx.createBufferSource();
        noise.buffer = _noiseBuffer(duration + 0.1);

        let filter = _ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(filterStart, now);
        filter.frequency.linearRampToValueAtTime(filterEnd, now + duration * 0.7);
        filter.Q.value = 2.0;

        let gain = _ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volume, now + duration * 0.3);
        gain.gain.linearRampToValueAtTime(volume * 0.8, now + duration * 0.7);
        gain.gain.linearRampToValueAtTime(0, now + duration);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(_masterGain);

        noise.start(now);
        noise.stop(now + duration + 0.1);
    }

    // ---------------------------------------------------------------
    // BALL IMPACT — Sharp attack + resonant body
    // Iron = crisp click. Driver = deep thump. Putt = soft tap.
    // ---------------------------------------------------------------
    function playImpact(clubKey) {
        if (!_ensureCtx()) return;
        let now = _ctx.currentTime;

        let freq, decay, vol, clickVol;
        if (clubKey === 'PUTT') {
            freq = 1800; decay = 0.08; vol = 0.20; clickVol = 0.15;
        } else if (clubKey === 'DRIVER' || clubKey === 'W3') {
            freq = 220; decay = 0.25; vol = 0.45; clickVol = 0.5;
        } else if (clubKey === 'SW' || clubKey === 'LW') {
            freq = 1200; decay = 0.12; vol = 0.30; clickVol = 0.35;
        } else {
            freq = 800; decay = 0.15; vol = 0.35; clickVol = 0.4;
        }

        // Body tone
        let osc = _ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.5, now + decay);

        let gain = _ctx.createGain();
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + decay);

        osc.connect(gain);
        gain.connect(_masterGain);
        osc.start(now);
        osc.stop(now + decay + 0.05);

        // Click transient (noise burst)
        let click = _ctx.createBufferSource();
        click.buffer = _noiseBuffer(0.02);
        let clickGain = _ctx.createGain();
        clickGain.gain.setValueAtTime(clickVol, now);
        clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);

        let clickFilter = _ctx.createBiquadFilter();
        clickFilter.type = 'highpass';
        clickFilter.frequency.value = 3000;

        click.connect(clickFilter);
        clickFilter.connect(clickGain);
        clickGain.connect(_masterGain);
        click.start(now);
        click.stop(now + 0.03);
    }

    // ---------------------------------------------------------------
    // BOUNCE — Quick thud when ball hits ground
    // ---------------------------------------------------------------
    function playBounce() {
        if (!_ensureCtx()) return;
        let now = _ctx.currentTime;

        let osc = _ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.06);

        let gain = _ctx.createGain();
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        osc.connect(gain);
        gain.connect(_masterGain);
        osc.start(now);
        osc.stop(now + 0.1);
    }

    // ---------------------------------------------------------------
    // HOLED — Celebratory sound! Ascending arpeggio + shimmer
    // scoreText hints: 'HOLE IN ONE', 'EAGLE', 'BIRDIE', etc.
    // ---------------------------------------------------------------
    function playHoled(scoreText) {
        if (!_ensureCtx()) return;
        let now = _ctx.currentTime;

        // Cup drop: low thunk
        let cupOsc = _ctx.createOscillator();
        cupOsc.type = 'triangle';
        cupOsc.frequency.setValueAtTime(300, now);
        cupOsc.frequency.exponentialRampToValueAtTime(100, now + 0.15);
        let cupGain = _ctx.createGain();
        cupGain.gain.setValueAtTime(0.4, now);
        cupGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        cupOsc.connect(cupGain);
        cupGain.connect(_masterGain);
        cupOsc.start(now);
        cupOsc.stop(now + 0.25);

        // Celebration arpeggio
        let isSpecial = scoreText && (scoreText.includes('EAGLE') || scoreText.includes('HOLE IN ONE') || scoreText.includes('ALBATROSS'));
        let notes = isSpecial
            ? [523, 659, 784, 1047, 1319]   // C5-E5-G5-C6-E6 (major triumph)
            : [392, 494, 587, 784];          // G4-B4-D5-G5 (nice arpeggio)

        notes.forEach((freq, i) => {
            let delay = 0.08 + i * 0.10;
            let osc = _ctx.createOscillator();
            osc.type = isSpecial ? 'triangle' : 'sine';
            osc.frequency.value = freq;

            let g = _ctx.createGain();
            g.gain.setValueAtTime(0, now + delay);
            g.gain.linearRampToValueAtTime(0.25, now + delay + 0.03);
            g.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.5);

            osc.connect(g);
            g.connect(_masterGain);
            osc.start(now + delay);
            osc.stop(now + delay + 0.55);
        });

        // Shimmer (high noise burst for excitement)
        if (isSpecial) {
            let shimmer = _ctx.createBufferSource();
            shimmer.buffer = _noiseBuffer(0.8);
            let sFilter = _ctx.createBiquadFilter();
            sFilter.type = 'bandpass';
            sFilter.frequency.value = 6000;
            sFilter.Q.value = 5;
            let sGain = _ctx.createGain();
            sGain.gain.setValueAtTime(0, now + 0.2);
            sGain.gain.linearRampToValueAtTime(0.12, now + 0.4);
            sGain.gain.exponentialRampToValueAtTime(0.001, now + 1.0);
            shimmer.connect(sFilter);
            sFilter.connect(sGain);
            sGain.connect(_masterGain);
            shimmer.start(now + 0.2);
            shimmer.stop(now + 1.1);
        }
    }

    // ---------------------------------------------------------------
    // APPLAUSE — Filtered noise with envelope (crowd reaction)
    // ---------------------------------------------------------------
    function playApplause() {
        if (!_ensureCtx()) return;
        let now = _ctx.currentTime;

        let noise = _ctx.createBufferSource();
        noise.buffer = _noiseBuffer(3.0);

        let filter = _ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 2000;
        filter.Q.value = 0.5;

        // Modulate the noise to sound like clapping
        let lfo = _ctx.createOscillator();
        lfo.frequency.value = 7; // ~7 claps per second
        let lfoGain = _ctx.createGain();
        lfoGain.gain.value = 0.3;
        lfo.connect(lfoGain);

        let gain = _ctx.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.20, now + 0.3);
        gain.gain.setValueAtTime(0.20, now + 1.5);
        gain.gain.linearRampToValueAtTime(0, now + 2.8);

        // Connect modulation
        lfoGain.connect(gain.gain);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(_masterGain);

        lfo.start(now);
        noise.start(now);
        noise.stop(now + 3.0);
        lfo.stop(now + 3.0);
    }

    // ---------------------------------------------------------------
    // UI CLICK — Tiny satisfying tap sound
    // ---------------------------------------------------------------
    function playClick() {
        if (!_ensureCtx()) return;
        let now = _ctx.currentTime;

        let osc = _ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = 1200;

        let gain = _ctx.createGain();
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

        osc.connect(gain);
        gain.connect(_masterGain);
        osc.start(now);
        osc.stop(now + 0.05);
    }

    // ---------------------------------------------------------------
    // AMBIENT — Looping environmental sounds (biome-aware)
    // Uses oscillators + filtered noise for nature sounds.
    // ---------------------------------------------------------------
    function _stopAmbientNodes() {
        _ambientNodes.forEach(n => {
            try { n.stop(); } catch(e) {}
            try { n.disconnect(); } catch(e) {}
        });
        _ambientNodes = [];
    }

    function startAmbient(biome) {
        if (!_ensureCtx()) return;
        _stopAmbientNodes();
        _ambientBiome = biome || 'DEFAULT';

        // Wind (always present, subtle)
        _startWind();

        // Biome-specific
        let b = (biome || '').toUpperCase();
        if (b === 'SNOW' || b === 'WINTER' || b === 'ARCTIC') {
            // Wind only — sparse, cold
            _ambientGain.gain.value = 0.20;
        } else if (b === 'DESERT' || b === 'ARID') {
            // Minimal — occasional gust
            _ambientGain.gain.value = 0.15;
        } else if (b === 'TROPICAL' || b === 'ISLAND') {
            _startBirds('tropical');
            _ambientGain.gain.value = 0.25;
        } else {
            // Default: temperate forest
            _startBirds('forest');
            _ambientGain.gain.value = 0.25;
        }
    }

    function stopAmbient() {
        _stopAmbientNodes();
        _ambientBiome = null;
    }

    function updateAmbientForBiome(biome) {
        if (!_ambientBiome && !biome) return;
        if (biome !== _ambientBiome) {
            startAmbient(biome);
        }
    }

    // --- WIND: Filtered noise, gentle ---
    function _startWind() {
        if (!_ctx) return;
        let now = _ctx.currentTime;

        let noise = _ctx.createBufferSource();
        noise.buffer = _noiseBuffer(10);
        noise.loop = true;

        let filter = _ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 400;
        filter.Q.value = 1.0;

        // Slow LFO for gusting effect
        let lfo = _ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.15; // Very slow gust cycle
        let lfoGain = _ctx.createGain();
        lfoGain.gain.value = 150; // Modulate filter frequency
        lfo.connect(lfoGain);
        lfoGain.connect(filter.frequency);

        let gain = _ctx.createGain();
        gain.gain.value = 0.08;

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(_ambientGain);

        noise.start(now);
        lfo.start(now);

        _ambientNodes.push(noise, lfo);
    }

    // --- BIRDS: Oscillator chirps at random intervals ---
    function _startBirds(type) {
        if (!_ctx) return;

        let isTropical = type === 'tropical';

        // Schedule random chirps using setTimeout loop
        function chirp() {
            if (!_enabled || !_ctx || _ctx.state === 'closed') return;
            let now = _ctx.currentTime;

            // 2-3 note chirp
            let noteCount = 2 + Math.floor(Math.random() * 2);
            let baseFreq = isTropical
                ? 1800 + Math.random() * 1200   // Higher tropical birds
                : 1200 + Math.random() * 800;   // Temperate songbirds

            for (let i = 0; i < noteCount; i++) {
                let delay = i * (0.06 + Math.random() * 0.04);
                let freq = baseFreq * (1 + (Math.random() - 0.5) * 0.3);

                let osc = _ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, now + delay);
                osc.frequency.linearRampToValueAtTime(freq * (0.85 + Math.random() * 0.3), now + delay + 0.06);

                let g = _ctx.createGain();
                g.gain.setValueAtTime(0, now + delay);
                g.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.04, now + delay + 0.01);
                g.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.08);

                osc.connect(g);
                g.connect(_ambientGain);
                osc.start(now + delay);
                osc.stop(now + delay + 0.1);
            }

            // Next chirp: random interval 2-6 seconds
            let nextDelay = 2000 + Math.random() * 4000;
            if (isTropical) nextDelay *= 0.7; // Tropical = more frequent
            _birdTimer = setTimeout(chirp, nextDelay);
        }

        // Start first chirp after a short delay
        _birdTimer = setTimeout(chirp, 1000 + Math.random() * 2000);
    }

    let _birdTimer = null;

    // Override stopAmbient to also clear bird timer
    let _origStop = _stopAmbientNodes;
    _stopAmbientNodes = function() {
        if (_birdTimer) { clearTimeout(_birdTimer); _birdTimer = null; }
        _origStop();
    };

    // ---------------------------------------------------------------
    // VOLUME / ENABLE controls
    // ---------------------------------------------------------------
    function setEnabled(val) {
        _enabled = !!val;
        if (_masterGain) {
            _masterGain.gain.setValueAtTime(_enabled ? _volume : 0, _ctx.currentTime);
        }
        if (!_enabled) {
            _stopAmbientNodes();
        }
        _save();

        // Sync all UI checkboxes
        ['set-sound-enabled', 'ir-sound-enabled', 'hb-toggle-sound'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.checked = _enabled;
        });
    }

    function setVolume(val) {
        _volume = Math.max(0, Math.min(1, parseFloat(val) || 0));
        if (_masterGain && _enabled) {
            _masterGain.gain.setValueAtTime(_volume, _ctx.currentTime);
        }
        _save();

        // Sync all UI sliders
        ['set-sound-volume', 'ir-sound-volume'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.value = _volume;
        });
        // Sync volume label
        ['sound-vol-label', 'ir-sound-vol-label'].forEach(id => {
            let el = document.getElementById(id);
            if (el) el.innerText = Math.round(_volume * 100) + '%';
        });
    }

    function isEnabled() { return _enabled; }
    function getVolume() { return _volume; }

    // ---------------------------------------------------------------
    // PUBLIC API
    // ---------------------------------------------------------------
    window.AudioEngine = {
        init,
        setEnabled,
        setVolume,
        isEnabled,
        getVolume,
        playSwing,
        playImpact,
        playBounce,
        playHoled,
        playApplause,
        playClick,
        startAmbient,
        stopAmbient,
        updateAmbientForBiome
    };

})();
