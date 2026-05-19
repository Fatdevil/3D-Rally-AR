require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' })); // För att tillåta stora base64-höjdkartor/bilder

// --- DATABAS ANSLUTNING ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') 
       ? { rejectUnauthorized: false } 
       : false
});
pool.on('error', (err) => {
  console.warn('⚠️ Postgres pool unexpected error:', err.message);
});

// --- SCHEMA INITIALIZERING (Kan köras en gång) ---
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS courses (
                id SERIAL PRIMARY KEY,
                share_code VARCHAR(20) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                author VARCHAR(255) DEFAULT 'Anonymous',
                holes JSONB NOT NULL,
                targets JSONB DEFAULT '[]',
                trees JSONB DEFAULT '[]',
                terrain_heightmap TEXT,
                terrain_biomemap TEXT,
                theme_data JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Uppdatera existerande tabell om den saknar kolumnen
        try {
            await pool.query(`ALTER TABLE courses ADD COLUMN theme_data JSONB DEFAULT '{}';`);
            console.log("Database Migration: Added theme_data to courses");
        } catch (e) {
            // Kolumnen finns troligen redan
        }
        
        // Tabell för anpassade 3D-modeller (Assets)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS custom_assets (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                category VARCHAR(50) NOT NULL,
                subcategory VARCHAR(50) NOT NULL,
                icon VARCHAR(10),
                file_data TEXT NOT NULL,
                config JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tabell för dynamiska miljöinställningar (Biomes)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS biomes (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                config JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        try {
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS likes INT DEFAULT 0;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_draft BOOLEAN DEFAULT false;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_range BOOLEAN DEFAULT false;`);
        } catch(e) {}

        // --- Platform v2: Users & Ownership ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                display_name VARCHAR(255) DEFAULT 'Golfer',
                email VARCHAR(255),
                auth_provider VARCHAR(20) DEFAULT 'device',
                is_premium BOOLEAN DEFAULT false,
                premium_plan VARCHAR(20),
                premium_until TIMESTAMP,
                builder_score INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        try {
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_id VARCHAR(50);`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS play_count INT DEFAULT 0;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS hole_count INT;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS total_par INT;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS cover_image TEXT;`);
        } catch(e) {}

        // Leaderboard table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS course_records (
                id SERIAL PRIMARY KEY,
                course_code VARCHAR(20) NOT NULL,
                course_version INT DEFAULT 1,
                player_id VARCHAR(50),
                player_name VARCHAR(255),
                input_mode VARCHAR(20) NOT NULL DEFAULT 'SWING_METER',
                lm_device VARCHAR(50),
                total_score INT,
                score_vs_par INT,
                hole_scores JSONB,
                stats JSONB,
                flagged BOOLEAN DEFAULT false,
                tournament_id VARCHAR(20),
                played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Tournaments table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tournaments (
                id VARCHAR(20) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                course_code VARCHAR(20) NOT NULL,
                created_by VARCHAR(50),
                input_mode VARCHAR(20) DEFAULT 'ANY',
                starts_at TIMESTAMP NOT NULL,
                ends_at TIMESTAMP NOT NULL,
                max_players INT DEFAULT 0,
                is_public BOOLEAN DEFAULT true,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Migration for existing course_records without tournament_id
        try {
            await pool.query(`ALTER TABLE course_records ADD COLUMN IF NOT EXISTS tournament_id VARCHAR(20);`);
        } catch(e) {}

        // --- HCP System migrations ---
        try {
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS handicap_index DECIMAL(4,1);`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS handicap_rounds INT DEFAULT 0;`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS handicap_history JSONB DEFAULT '[]';`);
            await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS handicap_updated TIMESTAMP;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS course_rating DECIMAL(4,1);`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS slope_rating INT DEFAULT 113;`);
            await pool.query(`ALTER TABLE courses ADD COLUMN IF NOT EXISTS stroke_index JSONB;`);
            await pool.query(`ALTER TABLE course_records ADD COLUMN IF NOT EXISTS handicap_at_play DECIMAL(4,1);`);
            await pool.query(`ALTER TABLE course_records ADD COLUMN IF NOT EXISTS score_differential DECIMAL(5,1);`);
            await pool.query(`ALTER TABLE course_records ADD COLUMN IF NOT EXISTS net_score INT;`);
            await pool.query(`ALTER TABLE course_records ADD COLUMN IF NOT EXISTS stableford_points INT;`);
        } catch(e) { console.log('HCP migration note:', e.message); }

        console.log("✅ Database schema ready (v3 — HCP system)");
    } catch(err) {
        console.error("❌ Database schema error:", err);
    }
}

// Kör initDB om DATABASE_URL finns
if(process.env.DATABASE_URL) {
    initDB();
}

// --- HEALTH & DB CHECK ---
let DB_AVAILABLE = false;

// Check DB connectivity once at startup
if (process.env.DATABASE_URL) {
    pool.query('SELECT 1').then(() => {
        DB_AVAILABLE = true;
        console.log('✅ Database connection confirmed');
    }).catch(err => {
        DB_AVAILABLE = false;
        console.warn('⚠️ Database not reachable, running in local dev mode (empty API responses)');
    });
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db_connected: DB_AVAILABLE });
});

// Middleware: If no database, return graceful empty responses
function requireDB(req, res, next) {
    if (!DB_AVAILABLE) {
        // Return empty arrays for GET, error for POST
        if (req.method === 'GET') return res.json([]);
        return res.status(503).json({ error: 'No database configured (local dev mode)' });
    }
    next();
}

// Auth middleware: extract user ID from header
function authMiddleware(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) {
        return res.status(401).json({ error: 'Missing x-user-id header' });
    }
    req.userId = userId;
    next();
}

// Optional auth: sets req.userId if present but doesn't block
function optionalAuth(req, res, next) {
    req.userId = req.headers['x-user-id'] || null;
    next();
}

// --- AUTH ENDPOINTS ---

// Register or fetch user by device ID
app.post('/api/auth/register', requireDB, async (req, res) => {
    try {
        const { device_id, display_name } = req.body;
        if (!device_id) return res.status(400).json({ error: 'Missing device_id' });

        // Try to find existing user
        let result = await pool.query('SELECT * FROM users WHERE id = $1', [device_id]);
        
        if (result.rows.length > 0) {
            // Existing user — return profile
            return res.json(result.rows[0]);
        }

        // New user — create
        result = await pool.query(
            `INSERT INTO users (id, display_name, auth_provider) VALUES ($1, $2, 'device') RETURNING *`,
            [device_id, display_name || 'Golfer']
        );
        console.log('👤 New user registered:', device_id.substring(0, 8) + '...');
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Auth register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get user profile
app.get('/api/users/:id', requireDB, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, display_name, is_premium, builder_score, created_at FROM users WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Update display name
app.put('/api/users/:id', requireDB, authMiddleware, async (req, res) => {
    try {
        if (req.userId !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
        const { display_name } = req.body;
        if (!display_name) return res.status(400).json({ error: 'Missing display_name' });
        
        const name = display_name.trim().substring(0, 30);
        await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [name, req.params.id]);
        res.json({ success: true, display_name: name });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- HCP API ---
app.get('/api/users/:id/handicap', requireDB, async (req, res) => {
    try {
        const user = await pool.query('SELECT handicap_index, handicap_rounds, handicap_updated FROM users WHERE id = $1', [req.params.id]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const rounds = await pool.query(
            `SELECT score_differential, total_score, score_vs_par, course_code, played_at FROM course_records WHERE player_id = $1 AND flagged = false AND score_differential IS NOT NULL ORDER BY played_at DESC LIMIT 20`,
            [req.params.id]
        );
        res.json({ handicap_index: user.rows[0].handicap_index, rounds_counted: user.rows[0].handicap_rounds, last_updated: user.rows[0].handicap_updated, recent_rounds: rounds.rows });
    } catch(err) { console.error('HCP fetch error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/courses', requireDB, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT share_code, name, author, likes, hole_count, total_par, play_count, owner_id, version, created_at, cover_image 
            FROM courses 
            WHERE (is_draft = false OR is_draft IS NULL) 
              AND (is_range = false OR is_range IS NULL)
              AND (is_hidden = false OR is_hidden IS NULL)
            ORDER BY created_at DESC 
            LIMIT 50
        `);
        res.json(result.rows);
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/courses/:share_code/like', requireDB, async (req, res) => {
    try {
        const code = req.params.share_code.toUpperCase();
        const result = await pool.query(`
            UPDATE courses 
            SET likes = COALESCE(likes, 0) + 1 
            WHERE share_code = $1 
            RETURNING likes
        `, [code]);
        res.json({ success: true, likes: result.rows[0] ? result.rows[0].likes : 0 });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- LEADERBOARD API ---

// Submit round result
app.post('/api/courses/:code/results', requireDB, optionalAuth, async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const { total_score, score_vs_par, hole_scores, input_mode, lm_device, stats, player_name } = req.body;
        
        if (!total_score && total_score !== 0) return res.status(400).json({ error: 'Missing total_score' });
        
        // Get current course version + hole_count for sanity check
        const courseResult = await pool.query(
            'SELECT version, hole_count, owner_id FROM courses WHERE share_code = $1', [code]
        );
        if (courseResult.rows.length === 0) return res.status(404).json({ error: 'Course not found' });
        
        const course = courseResult.rows[0];
        const courseVersion = course.version || 1;
        const holeCount = course.hole_count || 18;
        
        // Sanity check: flag suspicious scores
        let flagged = false;
        if (total_score < holeCount) flagged = true;          // Under 1 per hole = suspicious
        if (total_score > holeCount * 10) flagged = true;     // Over 10 per hole = suspicious
        
        // === HCP: Calculate differential ===
        let scoreDifferential = null, playerHcpAtPlay = null, netScore = null;
        if (req.userId && req.userId !== 'anonymous') {
            const hcpRes = await pool.query('SELECT handicap_index FROM users WHERE id = $1', [req.userId]);
            if (hcpRes.rows.length > 0) playerHcpAtPlay = hcpRes.rows[0].handicap_index;
            const ratRes = await pool.query('SELECT course_rating, slope_rating FROM courses WHERE share_code = $1', [code]);
            if (ratRes.rows.length > 0 && ratRes.rows[0].course_rating) {
                const cr = parseFloat(ratRes.rows[0].course_rating), sr = parseInt(ratRes.rows[0].slope_rating) || 113;
                scoreDifferential = calculateScoreDifferential(total_score, cr, sr);
                if (playerHcpAtPlay !== null) netScore = total_score - Math.round(playerHcpAtPlay * (sr / 113));
            }
        }
        
        // Save result
        const result = await pool.query(
            `INSERT INTO course_records 
            (course_code, course_version, player_id, player_name, input_mode, lm_device, total_score, score_vs_par, hole_scores, stats, flagged, handicap_at_play, score_differential, net_score)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id`,
            [
                code, courseVersion,
                req.userId || 'anonymous',
                player_name || req.body.player_name || 'Anonymous',
                input_mode || 'SWING_METER',
                lm_device || null,
                total_score,
                score_vs_par || 0,
                JSON.stringify(hole_scores || []),
                JSON.stringify(stats || {}),
                flagged,
                playerHcpAtPlay, scoreDifferential, netScore
            ]
        );
        
        // Update HCP
        let newHcp = null;
        if (req.userId && req.userId !== 'anonymous' && !flagged) {
            newHcp = await updateHandicapIndex(req.userId, pool);
        }
        
        // Increment play_count on course
        await pool.query(
            'UPDATE courses SET play_count = COALESCE(play_count, 0) + 1 WHERE share_code = $1', [code]
        );
        
        // Increment builder_score for course owner
        if (course.owner_id) {
            await pool.query(
                'UPDATE users SET builder_score = builder_score + 1 WHERE id = $1', [course.owner_id]
            );
        }
        
        // Return leaderboard position
        const posResult = await pool.query(
            `SELECT COUNT(*) + 1 as position FROM course_records 
             WHERE course_code = $1 AND course_version = $2 AND total_score < $3 AND flagged = false`,
            [code, courseVersion, total_score]
        );
        
        res.json({ 
            success: true, 
            record_id: result.rows[0].id,
            position: parseInt(posResult.rows[0].position),
            flagged: flagged,
            handicap: { previous: playerHcpAtPlay, new: newHcp, differential: scoreDifferential }
        });
    } catch(err) {
        console.error('Error saving result:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get leaderboard for a course
app.get('/api/courses/:code/leaderboard', requireDB, async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        const mode = req.query.mode;      // 'LAUNCH_MONITOR' | 'SWING_METER' | undefined (all)
        const period = req.query.period;  // 'month' | 'all' | undefined (all)
        
        let filters = ['course_code = $1', 'flagged = false'];
        let params = [code];
        let paramIdx = 2;
        
        // Filter by current version
        const vResult = await pool.query('SELECT version FROM courses WHERE share_code = $1', [code]);
        if (vResult.rows.length > 0) {
            filters.push(`course_version = $${paramIdx}`);
            params.push(vResult.rows[0].version || 1);
            paramIdx++;
        }
        
        // Filter by input mode
        if (mode && (mode === 'LAUNCH_MONITOR' || mode === 'SWING_METER')) {
            filters.push(`input_mode = $${paramIdx}`);
            params.push(mode);
            paramIdx++;
        }
        
        // Filter by time period
        if (period === 'month') {
            filters.push(`played_at > NOW() - INTERVAL '30 days'`);
        }
        
        const result = await pool.query(`
            SELECT player_name, total_score, score_vs_par, input_mode, lm_device, 
                   hole_scores, played_at, player_id
            FROM course_records 
            WHERE ${filters.join(' AND ')}
            ORDER BY total_score ASC
            LIMIT 50
        `, params);
        
        // Get total count of rounds played
        const countResult = await pool.query(
            'SELECT COUNT(*) as total FROM course_records WHERE course_code = $1 AND flagged = false', [code]
        );
        
        res.json({
            leaderboard: result.rows,
            total_rounds: parseInt(countResult.rows[0].total)
        });
    } catch(err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Generera en slumpmässig share_code
function generateShareCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// === HCP SYSTEM: Helper Functions ===

function calculateCourseRating(holes, totalPar) {
    let totalLength = 0;
    let playableHoles = 0;
    const holesArr = typeof holes === 'string' ? JSON.parse(holes) : holes;
    holesArr.forEach(h => {
        if (h.flag && h.tees) {
            let tee = h.tees.yellow || h.tees.white || h.tees.red || h.tees.black;
            if (tee) {
                totalLength += Math.hypot(h.flag.x - tee.x, h.flag.z - tee.z);
                playableHoles++;
            }
        }
    });
    if (playableHoles === 0) return totalPar || 36;
    let expectedLength = playableHoles * 300;
    let lengthDiff = (totalLength - expectedLength) / 400;
    let cr = (totalPar || playableHoles * 4) + Math.max(-2, Math.min(4, lengthDiff));
    return Math.round(cr * 10) / 10;
}

function calculateSlopeRating(holes) {
    const holesArr = typeof holes === 'string' ? JSON.parse(holes) : holes;
    let totalLength = 0;
    let par5Count = 0;
    let playable = 0;
    holesArr.forEach(h => {
        if (h.flag && h.tees) {
            let tee = h.tees.yellow || h.tees.white || h.tees.red || h.tees.black;
            if (tee) {
                totalLength += Math.hypot(h.flag.x - tee.x, h.flag.z - tee.z);
                playable++;
                if (h.par >= 5) par5Count++;
            }
        }
    });
    if (playable === 0) return 113;
    let avgLength = totalLength / playable;
    let slope = 113 + Math.round((avgLength - 300) / 50 * 8) + (par5Count * 3);
    return Math.max(55, Math.min(155, slope));
}

function calculateStrokeIndex(holes) {
    const holesArr = typeof holes === 'string' ? JSON.parse(holes) : holes;
    let lengths = [];
    holesArr.forEach((h, i) => {
        let len = 0;
        if (h.flag && h.tees) {
            let tee = h.tees.yellow || h.tees.white || h.tees.red || h.tees.black;
            if (tee) len = Math.hypot(h.flag.x - tee.x, h.flag.z - tee.z);
        }
        lengths.push({ index: i, length: len });
    });
    lengths.sort((a, b) => b.length - a.length);
    let si = new Array(holesArr.length).fill(0);
    lengths.forEach((item, rank) => { si[item.index] = rank + 1; });
    return si;
}

function calculateScoreDifferential(adjustedScore, courseRating, slopeRating) {
    if (!courseRating || !slopeRating || slopeRating === 0) return null;
    return Math.round(((113 / slopeRating) * (adjustedScore - courseRating)) * 10) / 10;
}

async function updateHandicapIndex(playerId, dbPool) {
    try {
        const result = await dbPool.query(
            `SELECT score_differential FROM course_records 
             WHERE player_id = $1 AND flagged = false AND score_differential IS NOT NULL
             ORDER BY played_at DESC LIMIT 20`,
            [playerId]
        );
        const rounds = result.rows.map(r => parseFloat(r.score_differential));
        if (rounds.length < 3) return null;
        
        let useCount;
        if (rounds.length <= 5) useCount = 1;
        else if (rounds.length <= 8) useCount = 2;
        else if (rounds.length <= 11) useCount = 3;
        else if (rounds.length <= 14) useCount = 5;
        else if (rounds.length <= 16) useCount = 6;
        else if (rounds.length <= 18) useCount = 7;
        else useCount = 8;
        
        rounds.sort((a, b) => a - b);
        const best = rounds.slice(0, useCount);
        const avg = best.reduce((s, v) => s + v, 0) / best.length;
        const handicapIndex = Math.round(avg * 0.96 * 10) / 10;
        const clampedHI = Math.max(0, Math.min(54.0, handicapIndex));
        
        await dbPool.query(
            `UPDATE users SET handicap_index = $1, handicap_rounds = $2, handicap_updated = NOW() WHERE id = $3`,
            [clampedHI, rounds.length, playerId]
        );
        return clampedHI;
    } catch(e) {
        console.error('HCP update error:', e.message);
        return null;
    }
}

app.post('/api/courses', requireDB, optionalAuth, async (req, res) => {
    try {
        const { name, author, holes, targets, trees, terrain_heightmap, terrain_biomemap, terrain_watermask, is_draft, is_range, edit_code, theme_data, hole_count, total_par, new_version, cover_image } = req.body;
        
        // Validering
        if (!holes) return res.status(400).json({ error: 'Missing holes data' });

        const draftStatus = is_draft === true;
        const rangeStatus = is_range === true;
        const c_name = name || 'My Golf Course';
        const c_author = author || 'Anonymous';
        const c_theme_data = theme_data || {};
        const c_hole_count = hole_count || null;
        const c_total_par = total_par || null;

        if (edit_code) {
            // Check ownership before allowing edit
            const ownerCheck = await pool.query('SELECT owner_id FROM courses WHERE share_code = $1', [edit_code.toUpperCase()]);
            if (ownerCheck.rows.length > 0 && ownerCheck.rows[0].owner_id) {
                // Course has an owner — require matching auth
                if (!req.userId) {
                    return res.status(401).json({ error: 'Authentication required to edit this course' });
                }
                if (ownerCheck.rows[0].owner_id !== req.userId) {
                    return res.status(403).json({ error: 'You are not the owner of this course' });
                }
            }

            // Version bump if re-publishing a published course
            let versionBump = '';
            if (new_version && !draftStatus) {
                versionBump = ', version = version + 1, play_count = 0';
            }

            const updateResult = await pool.query(
                `UPDATE courses 
                 SET name=$1, author=$2, holes=$3, targets=$4, trees=$5, terrain_heightmap=$6, terrain_biomemap=$7, 
                     is_draft=$8, theme_data=$10, is_range=$11, hole_count=$12, total_par=$13, cover_image=$14,
                     updated_at=CURRENT_TIMESTAMP ${versionBump}
                 WHERE share_code=$9 
                 RETURNING share_code, version`,
                [
                    c_name, c_author, 
                    JSON.stringify(holes), JSON.stringify(targets || []), JSON.stringify(trees || []), 
                    terrain_heightmap, terrain_biomemap, draftStatus, 
                    edit_code.toUpperCase(), JSON.stringify(c_theme_data), rangeStatus,
                    c_hole_count, c_total_par, cover_image || null
                ]
            );
            
            if (updateResult.rows.length > 0) {
                return res.json({ success: true, share_code: updateResult.rows[0].share_code, version: updateResult.rows[0].version });
            }
        }

        const share_code = generateShareCode();

        const result = await pool.query(
            `INSERT INTO courses 
            (share_code, name, author, holes, targets, trees, terrain_heightmap, terrain_biomemap, is_draft, theme_data, is_range, owner_id, hole_count, total_par, course_rating, slope_rating, stroke_index, cover_image) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING share_code`,
            [
                share_code, c_name, c_author, 
                JSON.stringify(holes), JSON.stringify(targets || []), JSON.stringify(trees || []), 
                terrain_heightmap, terrain_biomemap, draftStatus, JSON.stringify(c_theme_data), rangeStatus,
                req.userId || null, c_hole_count, c_total_par,
                calculateCourseRating(holes, c_total_par), calculateSlopeRating(holes), JSON.stringify(calculateStrokeIndex(holes)), cover_image || null
            ]
        );

        res.json({ success: true, share_code: result.rows[0].share_code });
    } catch(err) {
        console.error("Error saving course:", err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/courses/:share_code', requireDB, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM courses WHERE share_code = $1", [req.params.share_code.toUpperCase()]);
        if(result.rows.length === 0) {
            return res.status(404).json({ error: 'Course not found' });
        }
        res.json(result.rows[0]);
    } catch(err) {
        console.error("Error fetching course:", err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a course (owner only)
app.delete('/api/courses/:code', requireDB, authMiddleware, async (req, res) => {
    try {
        const code = req.params.code.toUpperCase();
        
        // Check ownership
        const course = await pool.query('SELECT owner_id FROM courses WHERE share_code = $1', [code]);
        if (course.rows.length === 0) {
            return res.status(404).json({ error: 'Course not found' });
        }
        if (course.rows[0].owner_id && course.rows[0].owner_id !== req.userId) {
            return res.status(403).json({ error: 'You are not the owner of this course' });
        }
        
        // Delete leaderboard records first (foreign key integrity)
        await pool.query('DELETE FROM course_records WHERE course_code = $1', [code]);
        
        // Delete the course
        await pool.query('DELETE FROM courses WHERE share_code = $1', [code]);
        
        console.log('🗑️ Course deleted:', code, 'by user:', req.userId.substring(0, 8) + '...');
        res.json({ success: true, deleted: code });
    } catch(err) {
        console.error('Error deleting course:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- RANGES API ---
app.get('/api/ranges', requireDB, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT share_code, name, author, likes, created_at 
            FROM courses 
            WHERE is_range = true AND (is_draft = false OR is_draft IS NULL)
            ORDER BY created_at DESC 
            LIMIT 50
        `);
        res.json(result.rows);
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// --- ASSET MANAGER API ---

// Hämta alla custom assets (Mindre payload, exkluderar den tunga file_data vid lista)
app.get('/api/assets', requireDB, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, name, category, subcategory, icon, config, created_at 
            FROM custom_assets 
            ORDER BY created_at DESC
        `);
        res.json(result.rows);
    } catch(err) {
        console.error("Error fetching assets:", err);
        res.status(500).json({ error: 'Database error' });
    }
});

// Hämta en specifik custom asset INKLUSIVE base64-filen
app.get('/api/assets/:id/download', requireDB, async (req, res) => {
    try {
        const result = await pool.query("SELECT file_data FROM custom_assets WHERE id = $1", [req.params.id]);
        if(result.rows.length === 0) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        res.json({ file_data: result.rows[0].file_data });
    } catch(err) {
        console.error("Error downloading asset:", err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Spara/Uppdatera en custom asset
app.post('/api/assets', requireDB, async (req, res) => {
    try {
        const { id, name, category, subcategory, icon, file_data, config, password } = req.body;
        
        // Enkelt lösenordsskydd för admin-verktyget
        if (password !== 'golfadmin123') {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!id || !file_data) {
            return res.status(400).json({ error: 'Missing id or file_data' });
        }

        const result = await pool.query(
            `INSERT INTO custom_assets (id, name, category, subcategory, icon, file_data, config) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET 
                name = EXCLUDED.name,
                category = EXCLUDED.category,
                subcategory = EXCLUDED.subcategory,
                icon = EXCLUDED.icon,
                file_data = EXCLUDED.file_data,
                config = EXCLUDED.config
             RETURNING id`,
            [id, name, category, subcategory, icon, file_data, config]
        );

        res.json({ success: true, id: result.rows[0].id });
    } catch(err) {
        console.error("Error saving asset:", err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Ta bort en custom asset (kräver lösenord)
app.delete('/api/assets/:id', requireDB, async (req, res) => {
    try {
        const { password } = req.body;
        if (password !== 'golfadmin123') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const result = await pool.query("DELETE FROM custom_assets WHERE id = $1 RETURNING id", [req.params.id]);
        if(result.rows.length === 0) {
            return res.status(404).json({ error: 'Asset not found' });
        }
        res.json({ success: true, deleted_id: result.rows[0].id });
    } catch(err) {
        console.error("Error deleting asset:", err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- BIOMES API ---
app.get('/api/biomes', requireDB, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, config FROM biomes");
        res.json(result.rows);
    } catch(err) {
        console.error("GET /api/biomes Error:", err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/biomes', requireDB, async (req, res) => {
    try {
        const { adminPassword, id, name, config } = req.body;
        if(adminPassword !== 'golfadmin123') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        if(!id || !config) return res.status(400).json({ error: 'Missing required fields' });
        
        await pool.query(`
            INSERT INTO biomes (id, name, config) 
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO UPDATE SET config = $3, name = $2, updated_at = CURRENT_TIMESTAMP
        `, [id, name || id, config]);
        
        res.json({ success: true, id: id });
    } catch(err) {
        console.error("POST /api/biomes Error:", err);
        res.status(500).json({ error: 'Database error' });
    }
});


// --- SERVING STATIC FILES (För Railway Deploy) ---
// Disable cache for HTML files during development
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
    next();
});
app.use(express.static(__dirname));

// Fallback för allt annat (Catch-all)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'rally_hub.html'));
});

// --- START SERVER ---
app.listen(port, () => {
    console.log(`🏎️ Rally AR Backend running on port ${port}`);
});
