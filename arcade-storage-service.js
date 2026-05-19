// ================================================================
//  ARCADE STORAGE SERVICE — Centralized localStorage layer
//  All localStorage reads/writes go through these functions.
//
//  Extracted from arcade.html — Compatibility contract:
//  - window.ArcadeStorage namespace
//  - Handles JSON parse/stringify internally
//  - Pako decompression for compressed course data
// ================================================================
window.ArcadeStorage = {

    // ----- KEYS -----
    KEYS: {
        PRO_MODE:       'arcade_pro_mode',
        HUD_PREFS:      'golf_os_hud_prefs',
        CUSTOM_LEVEL:   'arcade_custom_level',
        CUSTOM_LEVEL_Z: 'arcade_custom_level_z',
        MY_DRAFTS:      'golf_os_my_drafts',
        TERRAIN_SNAP:   'rally_terrain_snapshot',  // heightmap + biomemap for rally.html
    },

    // ----- PRO MODE -----
    getProMode() {
        return localStorage.getItem(this.KEYS.PRO_MODE) === '1';
    },
    setProMode(enabled) {
        localStorage.setItem(this.KEYS.PRO_MODE, enabled ? '1' : '0');
    },

    // ----- HUD PREFERENCES -----
    getHudPrefs() {
        const raw = localStorage.getItem(this.KEYS.HUD_PREFS);
        return JSON.parse(raw || '["TOTAL_LENGTH", "CARRY", "BALL_SPEED", "CLUB_SPEED"]');
    },
    setHudPrefs(prefs) {
        localStorage.setItem(this.KEYS.HUD_PREFS, JSON.stringify(prefs));
    },

    // ----- CUSTOM LEVEL (targets + holes snapshot) -----
    saveCustomLevel(data) {
        localStorage.setItem(this.KEYS.CUSTOM_LEVEL, JSON.stringify(data));
    },
    loadCustomLevel() {
        const raw = localStorage.getItem(this.KEYS.CUSTOM_LEVEL);
        return raw ? JSON.parse(raw) : null;
    },
    removeCustomLevel() {
        localStorage.removeItem(this.KEYS.CUSTOM_LEVEL);
    },

    // ----- COMPRESSED LEVEL (pako) -----
    loadCompressedLevel() {
        const lsZ = localStorage.getItem(this.KEYS.CUSTOM_LEVEL_Z);
        if (!lsZ || typeof pako === 'undefined') return null;
        try {
            const binaryStr = atob(lsZ);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
            const jsonStr = pako.inflate(bytes, { to: 'string' });
            const parsed = JSON.parse(jsonStr);
            console.log('✅ Loaded COMPRESSED course (' + (lsZ.length / 1024).toFixed(1) + 'KB)');
            return parsed;
        } catch (e) {
            console.error('Decompression failed:', e);
            return null;
        }
    },

    // ----- TERRAIN SNAPSHOT (rally.html reads this) -----
    // Saves a compact heightmap (H16 format) + biome data URL so rally.html
    // can reconstruct the sculpted terrain without needing the server.
    saveTerrainSnapshot(heightmapH16, biomemapDataUrl, segs, saveId) {
        try {
            const snap = {
                terrain_heightmap: heightmapH16,
                terrain_biomemap: biomemapDataUrl,
                segs: segs || 600,   // segment count — used by rally.html to detect resample need
                _saveId: saveId || Date.now(),  // links to arcade_custom_level._saveId
                ts: Date.now()
            };
            localStorage.setItem(this.KEYS.TERRAIN_SNAP, JSON.stringify(snap));
            console.log('💾 Terrain snapshot saved (' + (JSON.stringify(snap).length / 1024).toFixed(1) + 'KB) segs=' + snap.segs);
            return true;
        } catch (e) {
            console.warn('⚠️ Terrain snapshot save failed (storage full?):', e.message);
            return false;
        }
    },
    loadTerrainSnapshot() {
        try {
            const raw = localStorage.getItem(this.KEYS.TERRAIN_SNAP);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            console.warn('Terrain snapshot parse failed:', e);
            return null;
        }
    },
    clearTerrainSnapshot() {
        localStorage.removeItem(this.KEYS.TERRAIN_SNAP);
    },

    // ----- DRAFTS -----
    getDrafts() {
        return JSON.parse(localStorage.getItem(this.KEYS.MY_DRAFTS) || '[]');
    },
    saveDrafts(drafts) {
        localStorage.setItem(this.KEYS.MY_DRAFTS, JSON.stringify(drafts));
    },
    addOrUpdateDraft(code, name) {
        const drafts = this.getDrafts();
        const existing = drafts.find(d => d.code === code);
        if (existing) {
            existing.name = name;
            existing.date = new Date().toISOString();
        } else {
            drafts.push({ code, name, date: new Date().toISOString() });
        }
        this.saveDrafts(drafts);
    }
};
