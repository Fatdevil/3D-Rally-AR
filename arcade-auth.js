// ================================================================
//  ARCADE AUTH SERVICE — User identity & authentication
//  Zero-toolchain module. Loaded via <script> tag.
//
//  Architecture:
//  - Auto-generates a Device UUID on first visit (localStorage)
//  - Registers with backend to create/fetch user record
//  - Exposes window.GolfAuth for all modules to check auth state
//  - Optional Google linking (future Phase)
//
//  Usage:
//    await window.GolfAuth.init();
//    if (window.GolfAuth.isPremium) { ... }
//    window.GolfAuth.userId  // "a1b2c3d4-..."
// ================================================================

window.GolfAuth = {
    userId: null,
    user: null,
    isPremium: false,
    isReady: false,

    /**
     * Initialize auth — call once at boot.
     * Creates or fetches user from backend.
     */
    async init() {
        // 1. Get or create Device ID
        let deviceId = localStorage.getItem('golf_os_device_id');
        if (!deviceId) {
            deviceId = this._generateUUID();
            localStorage.setItem('golf_os_device_id', deviceId);
        }
        this.userId = deviceId;

        // 2. Get display name from localStorage (user can set this)
        let displayName = localStorage.getItem('golf_os_display_name') || 'Golfer';

        // 3. Register / fetch user from backend
        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    device_id: deviceId,
                    display_name: displayName
                })
            });
            if (res.ok) {
                this.user = await res.json();
                this.isPremium = this.user.is_premium || false;
                // Sync display name from server (may have been set on another device)
                if (this.user.display_name && this.user.display_name !== 'Golfer') {
                    localStorage.setItem('golf_os_display_name', this.user.display_name);
                }
            } else {
                console.warn('Auth: Backend unavailable, running in offline mode');
                this.user = { id: deviceId, display_name: displayName, is_premium: false };
            }
        } catch (e) {
            console.warn('Auth: Network error, running in offline mode');
            this.user = { id: deviceId, display_name: displayName, is_premium: false };
        }

        this.isReady = true;

        // Expose on game context if available
        if (window.G) window.G.auth = this;

        console.log('🔑 Auth ready:', this.userId.substring(0, 8) + '...', 
                     this.isPremium ? '⭐ PREMIUM' : '🆓 FREE');
    },

    /**
     * Update display name (local + server)
     */
    async setDisplayName(name) {
        if (!name || name.trim().length === 0) return;
        name = name.trim().substring(0, 30); // Max 30 chars
        localStorage.setItem('golf_os_display_name', name);
        if (this.user) this.user.display_name = name;

        try {
            await fetch('/api/users/' + this.userId, {
                method: 'PUT',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-user-id': this.userId
                },
                body: JSON.stringify({ display_name: name })
            });
        } catch (e) {
            // Offline — name saved locally, will sync later
        }
    },

    /**
     * Get auth headers for API calls
     */
    getHeaders() {
        return {
            'Content-Type': 'application/json',
            'x-user-id': this.userId || ''
        };
    },

    /**
     * Check if a specific feature is available
     * (delegates to FeatureFlags if loaded)
     */
    canUse(featureKey) {
        if (typeof window.canUseFeature === 'function') {
            return window.canUseFeature(featureKey);
        }
        return true; // No feature flags loaded = everything allowed
    },

    /**
     * Generate UUID v4
     */
    _generateUUID() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        // Fallback for older browsers
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
};
