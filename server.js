require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const templateStorage = require('./template-storage');

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


// --- SCAN-TO-BUILD (Draw-to-World) API ---
const { GoogleGenerativeAI } = require('@google/generative-ai');

const RALLY_SCAN_PROMPT = `You are a WRC rally stage designer analyzing a hand-drawn map.

COLOR-CODING & STAMP RULES:
- The drawing uses specific colors and stamps. Interpret them exactly as follows:
  1. Opaque Brown strokes (#4a3728): This is the ROAD. Follow the brown path precisely to generate the coordinate nodes of the road. Ignore all other colors when tracing the road.
  2. Semi-transparent Green strokes (rgba(74, 140, 60, 0.7)): These are MOUNTAINS/HILLS. Do NOT output them in the "sculpts" or "trees" arrays (the engine automatically builds them from green pixels). Do NOT place trees on or near the green strokes.
  3. Semi-transparent Blue strokes (rgba(56, 189, 248, 0.7)): These are WATER features (lakes, ponds, rivers). Output them in the "water" array. Water features in the "water" array must have the shape: {"x": number, "z": number, "radius": number, "depth": number, "label": string}. Only output if a blue stroke is present.
  4. Tree Stamp (🌳): Only place trees in the "trees" array at coordinates where a 🌳 stamp is explicitly drawn. If no 🌳 stamps are drawn, the "trees" array MUST be empty []. Do NOT invent trees or forests. Each tree object should have the shape: {"x": number, "z": number, "type": "oak"|"pine"|"palm"|"cactus", "scale": number}.
  5. Start Flag Stamp (🏁): This is the start position of the race. Map this to "race.start".
  6. Checkpoint Stamp (⭕): These are checkpoints. Map them to "race.checkpoints" in the order of the track. If no ⭕ stamps are drawn, generate 4-8 checkpoints evenly spaced along the road.
  7. House Stamp (🏠): These are houses. Use them as background decoration or ignore.
  8. Yellow/Orange Triangles with labels 'S', 'M', or 'L': These are JUMP RAMPS. 'S' = small (height 2m, radius 8m), 'M' = medium (height 4m, radius 12m), 'L' = large (height 7m, radius 18m). Place a terrain sculpt at that position. Sculpt features in the "sculpts" array must have the shape: {"x": number, "z": number, "radius": number, "height": number, "falloff": "smooth"|"linear", "label": string}. Only output if explicit sculpt/hill stamps or jump ramps are present.

CRITICAL ROAD RULE:
- Output exactly ONE road in the "roads" array. Never split a continuous drawn path into multiple roads.
- There is always exactly ONE road and it must be a single continuous path. Even if there are gaps or breaks in the drawn road, you MUST bridge them and connect them into a single continuous sequence of nodes.
- If the drawing shows one continuous path, output it as a single road with many nodes.
- If the drawing shows a loop/circuit, the first and last node should be near each other.
- Use 15-30 nodes to capture the shape accurately. More nodes for complex paths.

COORDINATE SYSTEM:
- Map the ENTIRE drawing to a 900x900 meter grid centered at (0,0).
- Paper/canvas edges map to approximately -450..+450 in both X and Z.
- X axis = left-right on the paper. Z axis = top-bottom on the paper (top = negative Z, bottom = positive Z).

MANDATORY RACE SETUP (always do this, even if not drawn):
- ALWAYS place a start gate at the beginning of the road.
- ALWAYS place a finish gate at the end of the road.
- Set "heading" to the road direction angle in radians at that point.
- CLOSED LOOP / CIRCUIT TRACK RULE: If the track is a closed loop/circuit, you MUST set both "race.start" and "race.finish" to the EXACT SAME coordinates and heading (both pointing in the direction of travel). Do not place separate start and finish gates. Also, set "laps" to 3 for circuit tracks (and 1 for point-to-point tracks).

RALLY EXPERT ENHANCEMENTS (apply automatically):
1. BANKING: On curves tighter than 40m radius, add a terrain sculpt raising the outer edge by 1-2m.
2. JUMPS: On long straight sections (>80m), add a 3-5m crest with a 15m flat landing zone after it.
3. HAIRPINS: At very tight turns, widen the road to 12m and lower the inner edge by -2m.
4. SURFACE: Vary road material — use "asphalt" near start/finish, "gravel" in open areas, "dirt" in forest sections.
5. DIFFICULTY: Make the first third easier (gentle curves), middle technical (hairpins), final third fast (crests, straights).

OUTPUT: Return ONLY valid JSON (no markdown fences, no explanations). Use this exact schema:
{
  "biome": "GENERIC",
  "sculpts": [],
  "roads": [{"width":8,"material":"gravel","nodes":[{"x":0,"z":0}]}],
  "trees": [],
  "water": [],
  "race": {"start":{"x":0,"z":0,"heading":0},"finish":{"x":0,"z":0,"heading":0},"checkpoints":[],"laps":1}
}`;

const GOLF_SCAN_PROMPT = `You are a professional golf course architect analyzing a hand-drawn course layout.

COLOR-CODING & STAMP RULES:
- The drawing uses specific colors and stamps. Interpret them exactly as follows:
  1. Opaque Brown strokes (#4a3728): This is the FAIRWAY path. Follow the brown path to define the "fairway_path" of each hole.
  2. Semi-transparent Green strokes (rgba(74, 140, 60, 0.7)): These are HILLS/MOUNTAINS. Do NOT output them in the "sculpts" or "trees" arrays (the engine automatically builds them from green pixels). Do NOT place trees on or near the green strokes.
  3. Semi-transparent Blue strokes (rgba(56, 189, 248, 0.7)): These are WATER hazards. Output them in the "water" array. Each water hazard object should have the shape: {"x": number, "z": number, "radius": number, "depth": number, "label": string}. Only output if blue strokes are present.
  4. Tree Stamp (🌳): Only place trees in the "trees" array at coordinates where a 🌳 stamp is explicitly drawn. If no 🌳 stamps are drawn, the "trees" array MUST be empty []. Do NOT invent trees or forests. Each tree object should have the shape: {"x": number, "z": number, "type": "oak"|"pine"|"palm"|"cactus", "scale": number}.
  5. Start Flag Stamp (🏁): This is the Tee Box. Map this to "tee" in the "holes" array.
  6. Checkpoint Stamp (⭕): This is the Green and Hole/Pin location. Map this to "pin" and "green" in the "holes" array.
  7. House Stamp (🏠): This is a building (clubhouse or decoration).

COORDINATE SYSTEM:
- Map the ENTIRE drawing to a 900x900 meter grid centered at (0,0).
- Paper/canvas edges map to approximately -450..+450 in both X and Z.

GOLF EXPERT ENHANCEMENTS:
1. GREEN CONTOURING: Add subtle 0.3-0.8m sculpt undulation near greens.
2. STRATEGIC BUNKERS: Place greenside bunkers on the approach side if not explicitly drawn.
3. PAR CALCULATION: Auto-calculate par from tee-to-pin distance (<180m=3, 180-380m=4, >380m=5).
4. ELEVATION: Add gentle rolling hills (2-5m) between holes for visual interest (not on the green or fairway).

OUTPUT: Return ONLY valid JSON (no markdown fences, no explanations). Use this exact schema:
{
  "biome": "GENERIC",
  "sculpts": [],
  "trees": [],
  "water": [],
  "holes": [{"number":1,"par":4,"tee":{"x":0,"z":0,"heading":0},"green":{"x":0,"z":0,"radius":12},"pin":{"x":0,"z":0},"fairway_path":[{"x":0,"z":0}],"bunkers":[]}],
  "paint_zones": []
}`;

app.post('/api/scan', async (req, res) => {
    try {
        const { image_base64, mode, style, aspectRatio, road_image_base64 } = req.body;
        if (!image_base64) return res.status(400).json({ error: 'Missing image data' });
        if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI not configured — add GEMINI_API_KEY to .env' });

        console.log('🎨 Scan-to-Build request received — mode:', mode || 'rally', ', style:', style || 'enhance');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

        // Select prompt based on mode
        let prompt = (mode === 'golf') ? GOLF_SCAN_PROMPT : RALLY_SCAN_PROMPT;

        // Inject dynamic grid dimensions based on canvas aspect ratio
        if (aspectRatio && aspectRatio > 0) {
            let gridW = Math.round(900 * Math.max(1, aspectRatio));
            let gridH = Math.round(900 * Math.max(1, 1 / aspectRatio));
            let halfW = Math.round(gridW / 2) - 50;
            let halfH = Math.round(gridH / 2) - 50;
            prompt = prompt.replace('900x900 meter grid', gridW + 'x' + gridH + ' meter grid');
            prompt = prompt.replace('-400..+400 in both X and Z', '-' + halfW + '..+' + halfW + ' in X and -' + halfH + '..+' + halfH + ' in Z');
        }

        // Remove expert enhancements in trace mode (they conflict with "do not add elements")
        if (style === 'trace') {
            prompt = prompt.replace(/RALLY EXPERT ENHANCEMENTS[\s\S]*?(?=OUTPUT:)/, '');
            prompt = prompt.replace(/GOLF EXPERT ENHANCEMENTS[\s\S]*?(?=OUTPUT:)/, '');
        }

        // Add style modifier
        if (style === 'trace') {
            prompt += '\n\nSTYLE: TRACE MODE — Copy the drawing as precisely as possible. Minimal enhancements. Do NOT add elements that are not in the drawing. Absolutely NO arbitrary trees, water, or other features. If no 🌳 stamps are drawn, the "trees" array MUST be empty: [].';
        } else if (style === 'generate') {
            prompt += '\n\nSTYLE: GENERATE MODE — Use the drawing as loose inspiration. Create a complete, professional-quality course/track. Add many more elements than drawn. Be creative and generous with details. You are allowed to add decorative tree clusters, forests, and other natural features even if not drawn.';
        } else {
            // Default 'enhance' style
            prompt += '\n\nSTYLE: ENHANCE MODE — Clean up and improve the layout of the drawn elements (smoothen paths, fix curves). Do NOT add arbitrary trees or water that are not in the drawing. If no 🌳 stamps are drawn, the "trees" array MUST be empty: [].';
        }

        // Strip data URI prefix if present
        let imageData = image_base64;
        if (imageData.startsWith('data:')) {
            imageData = imageData.split(',')[1];
        }

        // Build multi-modal content array
        let contentParts = [
            { text: prompt },
            { inlineData: { mimeType: 'image/png', data: imageData } }
        ];
        // Add road-only canvas for cleaner road tracing (if available)
        if (road_image_base64) {
            let roadData = road_image_base64;
            if (roadData.startsWith('data:')) roadData = roadData.split(',')[1];
            contentParts.push(
                { text: '\n\nADDITIONAL IMAGE: This second image shows ONLY the road strokes (brown on white), without mountains, water, trees or stamps. Use this for more precise road node extraction.' },
                { inlineData: { mimeType: 'image/png', data: roadData } }
            );
        }

        const result = await model.generateContent(contentParts);

        const text = result.response.text();
        
        // Extract JSON — handle various AI response formats
        let buildPlan;
        try {
            // Try direct parse first
            buildPlan = JSON.parse(text);
        } catch(e) {
            // Try extracting from markdown code fences (greedy — get last/largest block)
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*)```/);
            if (jsonMatch) {
                buildPlan = JSON.parse(jsonMatch[1].trim());
            } else {
                // Try finding the first { to last }
                const start = text.indexOf('{');
                const end = text.lastIndexOf('}');
                if (start >= 0 && end > start) {
                    buildPlan = JSON.parse(text.substring(start, end + 1));
                } else {
                    throw new Error('Could not extract JSON from AI response');
                }
            }
        }

        // --- VALIDATE AI OUTPUT: sanitize non-numeric coordinates ---
        function sanitizeCoord(val) {
            if (typeof val === 'number' && Number.isFinite(val)) return val;
            let n = parseFloat(val);
            return Number.isFinite(n) ? n : 0;
        }
        if (buildPlan.roads) {
            for (let r of buildPlan.roads) {
                if (Array.isArray(r.nodes)) {
                    r.nodes = r.nodes.filter(n => n && (typeof n.x !== 'undefined') && (typeof n.z !== 'undefined'))
                        .map(n => ({ x: sanitizeCoord(n.x), z: sanitizeCoord(n.z) }));
                }
            }
        }
        if (buildPlan.sculpts) {
            buildPlan.sculpts = buildPlan.sculpts.filter(s => s && Number.isFinite(sanitizeCoord(s.x)))
                .map(s => ({ ...s, x: sanitizeCoord(s.x), z: sanitizeCoord(s.z), radius: sanitizeCoord(s.radius) || 20, height: sanitizeCoord(s.height) || 5 }));
        }
        if (buildPlan.trees) {
            buildPlan.trees = buildPlan.trees.filter(t => t && Number.isFinite(sanitizeCoord(t.x)))
                .map(t => ({ ...t, x: sanitizeCoord(t.x), z: sanitizeCoord(t.z) }));
        }
        if (buildPlan.water) {
            buildPlan.water = buildPlan.water.filter(w => w && Number.isFinite(sanitizeCoord(w.x)))
                .map(w => ({ ...w, x: sanitizeCoord(w.x), z: sanitizeCoord(w.z), radius: sanitizeCoord(w.radius) || 20 }));
        }

        // --- POST-PROCESSING FOR RALLY MODE ---
        if (mode === 'rally' && buildPlan && Array.isArray(buildPlan.roads)) {
            // 1. Filter and stitch multiple roads together
            let roadsPool = buildPlan.roads.filter(r => r && Array.isArray(r.nodes) && r.nodes.length > 0);
            if (roadsPool.length > 0) {
                let currentRoad = roadsPool.shift();
                let mergedNodes = [...currentRoad.nodes];
                let width = currentRoad.width || 8;
                let material = currentRoad.material || 'gravel';
                
                while (roadsPool.length > 0) {
                    let bestDist = Infinity;
                    let bestIndex = -1;
                    let bestType = ''; // 'append', 'append-reversed', 'prepend', 'prepend-reversed'
                    
                    let startNode = mergedNodes[0];
                    let endNode = mergedNodes[mergedNodes.length - 1];
                    
                    for (let i = 0; i < roadsPool.length; i++) {
                        let rNodes = roadsPool[i].nodes;
                        let rStart = rNodes[0];
                        let rEnd = rNodes[rNodes.length - 1];
                        
                        let d1 = Math.hypot(endNode.x - rStart.x, endNode.z - rStart.z);
                        if (d1 < bestDist) { bestDist = d1; bestIndex = i; bestType = 'append'; }
                        
                        let d2 = Math.hypot(endNode.x - rEnd.x, endNode.z - rEnd.z);
                        if (d2 < bestDist) { bestDist = d2; bestIndex = i; bestType = 'append-reversed'; }
                        
                        let d3 = Math.hypot(startNode.x - rEnd.x, startNode.z - rEnd.z);
                        if (d3 < bestDist) { bestDist = d3; bestIndex = i; bestType = 'prepend'; }
                        
                        let d4 = Math.hypot(startNode.x - rStart.x, startNode.z - rStart.z);
                        if (d4 < bestDist) { bestDist = d4; bestIndex = i; bestType = 'prepend-reversed'; }
                    }
                    
                    if (bestIndex !== -1) {
                        let nextRoad = roadsPool.splice(bestIndex, 1)[0];
                        let nextNodes = [...nextRoad.nodes];
                        if (bestType === 'append') {
                            mergedNodes = mergedNodes.concat(nextNodes);
                        } else if (bestType === 'append-reversed') {
                            mergedNodes = mergedNodes.concat(nextNodes.reverse());
                        } else if (bestType === 'prepend') {
                            mergedNodes = nextNodes.concat(mergedNodes);
                        } else if (bestType === 'prepend-reversed') {
                            mergedNodes = nextNodes.reverse().concat(mergedNodes);
                        }
                    } else {
                        break;
                    }
                }
                
                buildPlan.roads = [{
                    width: width,
                    material: material,
                    nodes: mergedNodes
                }];

                // Dedup near-identical consecutive nodes (from stitching overlaps)
                let dedupNodes = [mergedNodes[0]];
                for (let i = 1; i < mergedNodes.length; i++) {
                    let prev = dedupNodes[dedupNodes.length - 1];
                    let curr = mergedNodes[i];
                    let d = Math.hypot(prev.x - curr.x, prev.z - curr.z);
                    if (d > 3) dedupNodes.push(curr); // Skip nodes closer than 3m
                }
                buildPlan.roads[0].nodes = dedupNodes;
            }
            
            // 2. Loop detection, loop closing, and start/finish unification
            if (buildPlan.roads[0] && Array.isArray(buildPlan.roads[0].nodes) && buildPlan.roads[0].nodes.length >= 2) {
                let nodes = buildPlan.roads[0].nodes;
                let startNode = nodes[0];
                let endNode = nodes[nodes.length - 1];
                let dist = Math.hypot(startNode.x - endNode.x, startNode.z - endNode.z);
                
                // Determine loop: either AI wants multiple laps OR endpoints are within 250m
                let isLoop = (buildPlan.race && buildPlan.race.laps > 1) || (dist < 80);
                
                if (!buildPlan.race) {
                    buildPlan.race = { checkpoints: [], laps: isLoop ? 3 : 1 };
                }
                
                if (isLoop) {
                    console.log(`🔄 ENFORCING LOOP: closing road loop programmatically (distance: ${dist.toFixed(1)}m)`);
                    
                    // Close the road loop by appending the start node if distance is substantial
                    if (dist > 5) {
                        nodes.push({ x: startNode.x, z: startNode.z });
                    }
                    
                    // Force laps to 3 if not already set > 1
                    if (buildPlan.race.laps <= 1) {
                        buildPlan.race.laps = 3;
                    }
                    
                    // Calculate heading rotation angle from node 0 to node 1
                    let dx = nodes[1].x - nodes[0].x;
                    let dz = nodes[1].z - nodes[0].z;
                    let heading = Math.atan2(dx, dz);
                    
                    // Unify start and finish gate to startNode
                    buildPlan.race.start = {
                        x: startNode.x,
                        z: startNode.z,
                        heading: heading
                    };
                    buildPlan.race.finish = {
                        x: startNode.x,
                        z: startNode.z,
                        heading: heading
                    };
                } else {
                    console.log(`🛣️ ENFORCING POINT-TO-POINT: start and finish at different points (distance: ${dist.toFixed(1)}m)`);
                    
                    // Point-to-point track: Ensure start and finish are separate and placed at endpoints
                    let dxStart = nodes[1].x - nodes[0].x;
                    let dzStart = nodes[1].z - nodes[0].z;
                    let startHeading = Math.atan2(dxStart, dzStart);
                    
                    buildPlan.race.start = {
                        x: startNode.x,
                        z: startNode.z,
                        heading: startHeading
                    };
                    
                    let lastIdx = nodes.length - 1;
                    let dxEnd = nodes[lastIdx].x - nodes[lastIdx - 1].x;
                    let dzEnd = nodes[lastIdx].z - nodes[lastIdx - 1].z;
                    let endHeading = Math.atan2(dxEnd, dzEnd);
                    
                    buildPlan.race.finish = {
                        x: endNode.x,
                        z: endNode.z,
                        heading: endHeading
                    };
                    
                    buildPlan.race.laps = 1;
                }
            }
        }
        
        // --- POST-PROCESSING FOR GOLF MODE ---
        if (mode === 'golf' && buildPlan && Array.isArray(buildPlan.holes)) {
            buildPlan.holes = buildPlan.holes.filter(h => h && h.tee && h.pin);
            buildPlan.holes.forEach((h, i) => {
                if (!h.par || h.par < 3 || h.par > 5) {
                    // Auto-calculate par from distance
                    let dist = Math.hypot((h.pin.x || 0) - (h.tee.x || 0), (h.pin.z || 0) - (h.tee.z || 0));
                    h.par = dist < 180 ? 3 : dist > 380 ? 5 : 4;
                }
                h.number = i + 1;
            });
            console.log(`⛳ Golf post-processing: ${buildPlan.holes.length} valid holes`);
        }

        // --- CLAMP all coordinates to grid bounds ---
        const HALF = 450;
        function clampCoord(v) { return Math.max(-HALF, Math.min(HALF, v)); }
        if (buildPlan.roads) {
            for (let r of buildPlan.roads) {
                if (Array.isArray(r.nodes)) {
                    r.nodes.forEach(n => { n.x = clampCoord(n.x); n.z = clampCoord(n.z); });
                }
            }
        }
        if (buildPlan.sculpts) buildPlan.sculpts.forEach(s => { s.x = clampCoord(s.x); s.z = clampCoord(s.z); });
        if (buildPlan.trees) buildPlan.trees.forEach(t => { t.x = clampCoord(t.x); t.z = clampCoord(t.z); });
        if (buildPlan.water) buildPlan.water.forEach(w => { w.x = clampCoord(w.x); w.z = clampCoord(w.z); });

        // Count elements for preview
        const summary = {
            sculpts: (buildPlan.sculpts || []).length,
            roads: (buildPlan.roads || []).length,
            trees: (buildPlan.trees || []).length,
            water: (buildPlan.water || []).length,
            holes: (buildPlan.holes || []).length,
            checkpoints: buildPlan.race ? (buildPlan.race.checkpoints || []).length : 0
        };

        console.log('🎨 Scan result:', JSON.stringify(summary));
        res.json({ success: true, plan: buildPlan, summary: summary });
    } catch (err) {
        console.error('🎨 Scan error:', err.message);
        res.status(500).json({ error: 'AI processing failed: ' + err.message });
    }
});

// --- TEMPLATE PLATES API ---

// Multer config: store uploaded files in memory as Buffers
const templateUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB per file
});

// List active templates
app.get('/api/templates', async (req, res) => {
    try {
        const includeAll = req.query.all === 'true';
        const templates = includeAll
            ? await templateStorage.listAllTemplates()
            : await templateStorage.listTemplates();
        res.json(templates);
    } catch (err) {
        console.error('GET /api/templates error:', err);
        res.status(500).json({ error: 'Failed to list templates' });
    }
});

// Get full template data by ID
app.get('/api/templates/:id', async (req, res) => {
    try {
        const template = await templateStorage.getTemplate(req.params.id);
        if (!template) {
            return res.status(404).json({ error: 'Template not found' });
        }
        res.json(template);
    } catch (err) {
        console.error('GET /api/templates/:id error:', err);
        res.status(500).json({ error: 'Failed to load template' });
    }
});

// Save template (admin auth required)
// Accepts multipart/form-data with binary files + JSON fields
app.post('/api/templates', templateUpload.fields([
    { name: 'heightmap', maxCount: 1 },
    { name: 'biome', maxCount: 1 },
    { name: 'mask', maxCount: 1 },
    { name: 'thumb', maxCount: 1 }
]), async (req, res) => {
    try {
        // Admin auth check
        if (req.body.password !== 'golfadmin123') {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Parse meta from JSON string in form field
        let meta;
        try {
            meta = typeof req.body.meta === 'string' ? JSON.parse(req.body.meta) : req.body.meta;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid meta JSON' });
        }

        if (!meta || !meta.id) {
            return res.status(400).json({ error: 'Missing template meta or id' });
        }

        // Parse trees and environment from JSON strings
        let trees, environment;
        try {
            trees = req.body.trees ? (typeof req.body.trees === 'string' ? JSON.parse(req.body.trees) : req.body.trees) : undefined;
            environment = req.body.environment ? (typeof req.body.environment === 'string' ? JSON.parse(req.body.environment) : req.body.environment) : undefined;
        } catch (e) {
            return res.status(400).json({ error: 'Invalid trees or environment JSON' });
        }

        // Build save data from uploaded files + parsed JSON
        const saveData = {
            meta,
            heightmap: req.files?.heightmap?.[0]?.buffer || null,
            biome:     req.files?.biome?.[0]?.buffer || null,
            mask:      req.files?.mask?.[0]?.buffer || null,
            thumb:     req.files?.thumb?.[0]?.buffer || null,
            trees,
            environment
        };

        const savedMeta = await templateStorage.saveTemplate(meta.id, saveData);
        res.json({ success: true, meta: savedMeta });
    } catch (err) {
        console.error('POST /api/templates error:', err);
        res.status(500).json({ error: 'Failed to save template' });
    }
});

// Delete template (admin auth via query param)
app.delete('/api/templates/:id', async (req, res) => {
    try {
        if (req.query.password !== 'golfadmin123') {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const deleted = await templateStorage.deleteTemplate(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Template not found' });
        }
        res.json({ success: true, deleted: req.params.id });
    } catch (err) {
        console.error('DELETE /api/templates/:id error:', err);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// --- SERVING STATIC FILES (För Railway Deploy) ---
// Serve template files (heightmap.bin, biome.jpg, etc.) directly
app.use('/templates', express.static(path.join(__dirname, 'templates')));

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
