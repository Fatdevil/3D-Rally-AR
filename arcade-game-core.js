/**
 * GOLF OS CORE ENGINE
 * Headless State Machine and Rules Engine for Golf OS.
 * Decoupled from Three.js and DOM elements. Communicates via Events.
 */

const GameEvent = {
    STATE_CHANGED: 'GolfEvent_StateChanged',
    BALL_LANDED: 'GolfEvent_BallLanded',
    HOLED_OUT: 'GolfEvent_HoledOut',
    GIMME_AWARDED: 'GolfEvent_GimmeAwarded',
    PENALTY_APPLIED: 'GolfEvent_PenaltyApplied',
    OUT_OF_BOUNDS: 'GolfEvent_OutOfBounds',
    TURN_CHANGED: 'GolfEvent_TurnChanged',
    MATCH_COMPLETED: 'GolfEvent_MatchCompleted'
};

const GolfEngine = (function() {
    
    // --- STATE ---
    let state = {
        playState: 'IDLE', // 'IDLE', 'ROUND_IDLE', 'ROUND_FLYING'
        players: [],
        activePlayerIndex: 0,
        holeIndex: 0,
        isFlying: false,
        settings: {
            gimmeDist: 10, // ft
            autoPutt: 'TOUR_PRO',
            autoConcede: 99
        }
    };

    // --- EVENT DISPATCHER ---
    function emit(eventName, payload = {}) {
        const event = new CustomEvent(eventName, { detail: payload });
        window.dispatchEvent(event);
        console.log(`[GolfEngine] Emitted: ${eventName}`, payload);
    }

    // --- STATE MUTATORS ---
    function setPlayState(newState) {
        if (state.playState === newState) return;
        state.playState = newState;
        emit(GameEvent.STATE_CHANGED, { playState: state.playState });
    }

    function initPlayers(playerData) {
        state.players = playerData.map(sp => ({
            id: sp.id,
            name: sp.name,
            color: sp.color,
            strokes: 0,
            penaltyStrokes: 0,
            scores: [],
            totalScore: 0,
            holedOut: false,
            lie: { x: 0, y: 0, z: 0, type: 'TEE' }
        }));
        state.activePlayerIndex = 0;
    }

    function getActivePlayer() {
        return state.players[state.activePlayerIndex];
    }

    function updateSettings(newSettings) {
        if (newSettings) {
            state.settings = { ...state.settings, ...newSettings };
        }
    }

    // --- RULES ENGINE ---
    function handleShotResult(player, distanceToPinFt, isGreen, isFringe, isHoled, holePar, finalTerrain, penaltyEntryPoint, penaltyPrevLie) {
        // OB / Water Check
        if (isHoled === false) { // Don't penalize if it's magically in the hole
            if (finalTerrain === 'WATER') {
                player.penaltyStrokes++;
                emit(GameEvent.PENALTY_APPLIED, { player, type: 'WATER', entryPoint: penaltyEntryPoint, previousLie: penaltyPrevLie });
                return;
            }
            if (finalTerrain === 'OB') {
                player.penaltyStrokes++;
                emit(GameEvent.PENALTY_APPLIED, { player, type: 'OB', previousLie: penaltyPrevLie });
                return;
            }
        }
        
        // Auto Concede check
        let maxConcede = state.settings.autoConcede;
        let maxScore = holePar + maxConcede;
        let shouldConcede = (player.strokes + player.penaltyStrokes) >= maxScore && maxConcede !== 99;

        if (isHoled) {
            player.holedOut = true;
            let total = player.strokes + player.penaltyStrokes;
            emit(GameEvent.HOLED_OUT, { 
                player, total, par: holePar, isHoleInOne: (total === 1), distanceToPinFt 
            });
            return;
        }

        if (shouldConcede) {
            player.holedOut = true;
            player.strokes = maxScore - player.penaltyStrokes;
            emit(GameEvent.MATCH_COMPLETED, { player, reason: 'CONCEDE', maxScore });
            return;
        }

        // Gimme check
        if (isGreen && distanceToPinFt <= state.settings.gimmeDist) {
            player.strokes += 1;
            player.holedOut = true;
            emit(GameEvent.GIMME_AWARDED, { player, distanceToPinFt, putts: 1, type: 'GIMME' });
            return;
        }

        // Auto-Putt check
        let mode = state.settings.autoPutt;
        if ((isGreen || isFringe) && mode !== 'OFF') {
            let putts = 2;
            if (mode === 'TOUR_PRO') {
                let p1 = Math.max(0, 100 - (distanceToPinFt * 6.2));
                let p3 = distanceToPinFt > 30 ? (distanceToPinFt - 30) * 0.15 : 0;
                let rand = Math.random() * 100;
                if (rand < p1) putts = 1;
                else if (rand > (100 - p3)) putts = 3;
                else putts = 2;
            } else {
                putts = distanceToPinFt < 10 ? 1 : (distanceToPinFt < 40 ? 2 : 3);
            }
            player.strokes += putts;
            player.holedOut = true;
            emit(GameEvent.GIMME_AWARDED, { player, distanceToPinFt, putts, type: 'AUTO-PUTT' });
            return;
        }

        // Normal stop (not holed, no gimme)
        emit(GameEvent.BALL_STOPPED, { player, distanceToPinFt, isGreen, mode });
    }

    // --- PUBLIC API ---
    return {
        GameEvent,
        getState: () => state,
        setPlayState,
        initPlayers,
        getActivePlayer,
        updateSettings,
        handleShotResult,
        emit
    };

})();

window.GolfEngine = GolfEngine;
window.GameEvent = GameEvent;
