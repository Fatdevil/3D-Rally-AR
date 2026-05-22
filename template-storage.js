/**
 * template-storage.js — Server-side template plate storage
 * 
 * Manages terrain template files on disk under /templates/<id>/.
 * Each template folder contains:
 *   meta.json        — Template metadata
 *   heightmap.bin    — Raw binary heightmap data
 *   biome.jpg        — Biome canvas image
 *   mask.png         — 512px black/white drawable mask
 *   thumb.jpg        — 400px thumbnail
 *   trees.json       — Tree placement data
 *   environment.json — Biome/weather/fog settings
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// --- Helpers ---

/** Ensure the templates root and a specific template subfolder exist */
async function ensureDir(dirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
}

/** Safely read and parse a JSON file, returns null if missing */
async function readJSON(filePath) {
    try {
        const raw = await fsp.readFile(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

/** Check if a file exists */
async function fileExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// --- Public API ---

/**
 * List only active templates (meta.json where active !== false).
 * Returns an array of meta objects sorted by creation date (newest first).
 */
async function listTemplates() {
    const all = await listAllTemplates();
    return all.filter(m => m.active !== false);
}

/**
 * List ALL templates including inactive ones.
 * Returns an array of meta.json objects.
 */
async function listAllTemplates() {
    await ensureDir(TEMPLATES_DIR);

    let entries;
    try {
        entries = await fsp.readdir(TEMPLATES_DIR, { withFileTypes: true });
    } catch {
        return [];
    }

    const metas = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const metaPath = path.join(TEMPLATES_DIR, entry.name, 'meta.json');
        const meta = await readJSON(metaPath);
        if (meta) {
            metas.push(meta);
        }
    }

    // Sort newest first
    metas.sort((a, b) => {
        const da = new Date(b.created || 0).getTime();
        const db = new Date(a.created || 0).getTime();
        return da - db;
    });

    return metas;
}

/**
 * Get full template data for a given ID.
 * Returns { meta, heightmapUrl, biomeUrl, maskUrl, thumbUrl, trees, environment }
 * or null if the template doesn't exist.
 */
async function getTemplate(id) {
    const templateDir = path.join(TEMPLATES_DIR, id);
    const metaPath = path.join(templateDir, 'meta.json');

    const meta = await readJSON(metaPath);
    if (!meta) return null;

    // Build URL paths (relative to server root, served via express.static)
    const baseUrl = `/templates/${id}`;

    // Read JSON data files
    const trees = await readJSON(path.join(templateDir, 'trees.json')) || [];
    const environment = await readJSON(path.join(templateDir, 'environment.json')) || {};

    return {
        meta,
        heightmapUrl: `${baseUrl}/heightmap.bin`,
        biomeUrl:     `${baseUrl}/biome.jpg`,
        maskUrl:      `${baseUrl}/mask.png`,
        thumbUrl:     `${baseUrl}/thumb.jpg`,
        trees,
        environment
    };
}

/**
 * Save a template to disk. Creates or overwrites the template folder.
 * 
 * @param {string} id — Template ID (used as folder name)
 * @param {object} data — Template data:
 *   - meta       {object}  Metadata (id, name, category, biome, description, active, drawableArea, etc.)
 *   - heightmap  {Buffer}  Raw binary heightmap data
 *   - biome      {Buffer}  Biome canvas image (JPEG)
 *   - mask       {Buffer}  Drawable mask image (PNG)
 *   - thumb      {Buffer}  Thumbnail image (JPEG)
 *   - trees      {Array}   Tree placement array
 *   - environment {object} Environment settings
 */
async function saveTemplate(id, data) {
    const templateDir = path.join(TEMPLATES_DIR, id);
    await ensureDir(templateDir);

    const now = new Date().toISOString();

    // Build meta object — preserve existing created date on updates
    const existingMeta = await readJSON(path.join(templateDir, 'meta.json'));
    const meta = {
        id,
        name:         data.meta?.name || 'Untitled Template',
        category:     data.meta?.category || 'general',
        biome:        data.meta?.biome || 'GENERIC',
        description:  data.meta?.description || '',
        active:       data.meta?.active !== undefined ? data.meta.active : true,
        drawableArea: data.meta?.drawableArea || { percentage: 100 },
        created:      existingMeta?.created || now,
        updated:      now
    };

    // Write meta.json
    await fsp.writeFile(
        path.join(templateDir, 'meta.json'),
        JSON.stringify(meta, null, 2),
        'utf-8'
    );

    // Write binary files (only if provided — allows partial updates)
    if (data.heightmap) {
        await fsp.writeFile(path.join(templateDir, 'heightmap.bin'), data.heightmap);
    }
    if (data.biome) {
        await fsp.writeFile(path.join(templateDir, 'biome.jpg'), data.biome);
    }
    if (data.mask) {
        await fsp.writeFile(path.join(templateDir, 'mask.png'), data.mask);
    }
    if (data.thumb) {
        await fsp.writeFile(path.join(templateDir, 'thumb.jpg'), data.thumb);
    }

    // Write JSON data files
    if (data.trees !== undefined) {
        await fsp.writeFile(
            path.join(templateDir, 'trees.json'),
            JSON.stringify(data.trees || [], null, 2),
            'utf-8'
        );
    }
    if (data.environment !== undefined) {
        await fsp.writeFile(
            path.join(templateDir, 'environment.json'),
            JSON.stringify(data.environment || {}, null, 2),
            'utf-8'
        );
    }

    console.log(`📦 Template saved: ${id} — "${meta.name}"`);
    return meta;
}

/**
 * Delete a template folder and all its files.
 * Returns true if deleted, false if not found.
 */
async function deleteTemplate(id) {
    const templateDir = path.join(TEMPLATES_DIR, id);

    if (!(await fileExists(templateDir))) {
        return false;
    }

    await fsp.rm(templateDir, { recursive: true, force: true });
    console.log(`🗑️ Template deleted: ${id}`);
    return true;
}

/**
 * Returns the absolute path to the templates directory.
 */
function getTemplatesDir() {
    return TEMPLATES_DIR;
}

// --- Exports ---

module.exports = {
    listTemplates,
    listAllTemplates,
    getTemplate,
    saveTemplate,
    deleteTemplate,
    getTemplatesDir
};
