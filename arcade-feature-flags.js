// ================================================================
//  ARCADE FEATURE FLAGS — Configurable free/premium gating
//  Zero-toolchain module. Loaded via <script> tag AFTER arcade-auth.js.
//
//  To change what's free or premium, edit the flags below.
//  No code changes needed anywhere else.
//
//  Usage:
//    if (window.canUseFeature('TRACER_NEON')) { ... }
//    window.showPremiumUpsell('tracers');
// ================================================================

window.FEATURE_FLAGS = {
    // ── Gameplay Modes × Input Source ──────────────────────
    RANGE_SWING_METER:          { premium: false },
    RANGE_LAUNCH_MONITOR:       { premium: false },
    GAMEPLAY_SWING_METER:       { premium: false },
    GAMEPLAY_LAUNCH_MONITOR:    { premium: true },
    MINIGOLF_SWING_METER:       { premium: true },
    MINIGOLF_LAUNCH_MONITOR:    { premium: true },

    // ── Tracer Styles ─────────────────────────────────────
    TRACER_CLASSIC:             { premium: false },
    TRACER_PHANTOM:             { premium: false },
    TRACER_PRO_DOT:             { premium: false },
    TRACER_NEON:                { premium: true },
    TRACER_FIRE:                { premium: true },
    TRACER_ICE:                 { premium: true },
    TRACER_RAINBOW:             { premium: true },

    // ── Course Building ───────────────────────────────────
    BUILD_COURSE:               { premium: false },
    PUBLISH_COURSE:             { premium: false, freeLimit: 1 },
    MAX_DRAFTS:                 { premium: false, freeLimit: 3, premiumLimit: 99 },
    UNLISTED_COURSE:            { premium: true },

    // ── Gameplay Features ─────────────────────────────────
    NIGHT_MODE:                 { premium: false },
    TOURNAMENT_MODE:            { premium: true },

    // ── Analytics & Export ─────────────────────────────────
    DETAILED_STATS:             { premium: true },
    BUILDER_ANALYTICS:          { premium: true },
    EXPORT_SCORECARD:           { premium: true },
};

/**
 * Check if current user can use a feature.
 * @param {string} featureKey — key from FEATURE_FLAGS
 * @returns {boolean}
 */
window.canUseFeature = function(featureKey) {
    const flag = window.FEATURE_FLAGS[featureKey];
    if (!flag) return true; // Unknown feature = allowed
    if (!flag.premium) return true; // Not a premium feature
    return window.GolfAuth?.isPremium || false;
};

/**
 * Get the limit for a feature (e.g. max drafts).
 * @param {string} featureKey
 * @returns {number}
 */
window.getFeatureLimit = function(featureKey) {
    const flag = window.FEATURE_FLAGS[featureKey];
    if (!flag) return Infinity;
    const isPremium = window.GolfAuth?.isPremium || false;
    if (isPremium) return flag.premiumLimit || Infinity;
    return flag.freeLimit || Infinity;
};

/**
 * Show premium upsell modal.
 * @param {string} context — what triggered the upsell (for messaging)
 */
window.showPremiumUpsell = function(context) {
    let modal = document.getElementById('premium-upsell-modal');
    if (!modal) {
        // Create modal on first call
        modal = document.createElement('div');
        modal.id = 'premium-upsell-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(11,15,25,0.95);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(10px);';
        modal.innerHTML = `
            <div style="background:#1e293b;border-radius:24px;padding:40px;max-width:450px;width:90%;text-align:center;border:1px solid rgba(255,255,255,0.1);box-shadow:0 20px 50px rgba(0,0,0,0.5);animation:modalIn 0.3s cubic-bezier(0.175,0.885,0.32,1.275);">
                <div style="font-size:48px;margin-bottom:16px;">⭐</div>
                <h2 style="font-family:Inter,sans-serif;font-size:28px;font-weight:900;color:#fde047;margin:0 0 12px 0;">PREMIUM</h2>
                <p id="upsell-message" style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px 0;">
                    Uppgradera till Premium för att låsa upp denna funktion.
                </p>
                <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
                    <button onclick="window.location.href='pricing.html'" style="background:#eab308;color:#0f172a;border:none;padding:14px 28px;border-radius:12px;font-weight:900;font-size:15px;cursor:pointer;text-transform:uppercase;">
                        Se priser
                    </button>
                    <button onclick="document.getElementById('premium-upsell-modal').style.display='none'" style="background:rgba(255,255,255,0.1);color:#94a3b8;border:1px solid rgba(255,255,255,0.1);padding:14px 28px;border-radius:12px;font-weight:700;font-size:15px;cursor:pointer;">
                        Stäng
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    // Context-specific messages
    const messages = {
        tracers: 'Premium-tracers som Neon, Fire och Rainbow ingår i Premium.',
        lm: 'Anslut din Launch Monitor (SkyTrak, Trackman m.fl.) med Premium.',
        publish: 'Du har nått gränsen för gratis-publiceringar. Uppgradera för obegränsade banor.',
        drafts: 'Du har nått max antal drafts. Uppgradera för obegränsad lagring.',
        stats: 'Detaljerad statistik med putts, GIR och längsta drive ingår i Premium.',
        tournament: 'Turneringsläge med 8+ spelare ingår i Premium.',
        analytics: 'Se hur många som spelar dina banor med Builder Analytics.',
        default: 'Uppgradera till Premium för att låsa upp denna funktion.'
    };

    let msgEl = document.getElementById('upsell-message');
    if (msgEl) msgEl.textContent = messages[context] || messages.default;
    modal.style.display = 'flex';
};
