// ================================================================
//  TEMPLATE MASK — 512×512 drawable/blocked region mask for the
//  arcade terrain builder.
//
//  Green pixels  = drawable (kids can paint roads here)
//  Black pixels  = blocked  (admin terrain features — mountains, etc.)
//
//  Exposes: window.TemplateMask
//
//  Usage:
//    TemplateMask.init();
//    TemplateMask.paint(worldX, worldZ, radius, 0, terrainSize); // block
//    TemplateMask.isDrawable(worldX, worldZ, terrainSize);       // query
//    TemplateMask.createOverlay(terrainSize, scene);             // visualize
// ================================================================
(function () {
    'use strict';

    var MASK_SIZE = 512;
    var maskCanvas = null;
    var maskCtx = null;
    var overlayMesh = null;  // THREE.js mesh for visual overlay
    var isInitialized = false;

    // ---- helpers ----

    /** Clamp value between lo and hi (inclusive). */
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    /**
     * Convert world-space X/Z to mask pixel coordinates.
     * World runs from -half to +half; mask runs 0 → MASK_SIZE-1.
     */
    function worldToMask(worldX, worldZ, terrainSize) {
        var half = terrainSize / 2;
        return {
            px: clamp(((worldX + half) / terrainSize) * MASK_SIZE, 0, MASK_SIZE - 1),
            py: clamp(((worldZ + half) / terrainSize) * MASK_SIZE, 0, MASK_SIZE - 1)
        };
    }

    /** Safely dispose a THREE.js mesh + geometry + material + maps. */
    function disposeMesh(mesh, scene) {
        if (!mesh) return;
        if (scene) scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
            if (mesh.material.map) mesh.material.map.dispose();
            mesh.material.dispose();
        }
    }

    // ---- public API ----

    window.TemplateMask = {

        /** Read-only constant — mask resolution in pixels. */
        MASK_SIZE: MASK_SIZE,

        // ----- Lifecycle -----

        /**
         * Create the internal 512×512 canvas. Safe to call multiple times —
         * subsequent calls are no-ops.  Default fill: all-green (fully drawable).
         */
        init: function () {
            if (isInitialized) return;
            maskCanvas = document.createElement('canvas');
            maskCanvas.width  = MASK_SIZE;
            maskCanvas.height = MASK_SIZE;
            maskCtx = maskCanvas.getContext('2d');
            // Default state: everything is drawable
            maskCtx.fillStyle = '#00ff00';
            maskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
            isInitialized = true;
        },

        /** Returns true once init() has run. */
        isInit: function () { return isInitialized; },

        /** Get the raw canvas (for advanced / external use). */
        getCanvas: function () { return maskCanvas; },

        /** Get the 2D context (for advanced / external use). */
        getContext: function () { return maskCtx; },

        // ----- Painting -----

        /**
         * Paint a circular region on the mask.
         *
         * @param {number} worldX     – world-space X coordinate (center)
         * @param {number} worldZ     – world-space Z coordinate (center)
         * @param {number} radius     – brush radius in world units
         * @param {number} value      – 1 = drawable (green), 0 = blocked (black)
         * @param {number} terrainSize – total terrain side length (e.g. 600)
         */
        paint: function (worldX, worldZ, radius, value, terrainSize) {
            if (!isInitialized) this.init();
            if (!terrainSize || terrainSize <= 0) {
                console.warn('[TemplateMask] paint() called with invalid terrainSize:', terrainSize);
                return;
            }
            var m  = worldToMask(worldX, worldZ, terrainSize);
            var pr = Math.max(1, (radius / terrainSize) * MASK_SIZE);

            maskCtx.beginPath();
            maskCtx.arc(m.px, m.py, pr, 0, Math.PI * 2);
            maskCtx.fillStyle = value > 0.5 ? '#00ff00' : '#000000';
            maskCtx.fill();
        },

        // ----- Querying -----

        /**
         * Check whether a world position is drawable.
         *
         * @param  {number} worldX
         * @param  {number} worldZ
         * @param  {number} terrainSize
         * @return {number} 1 = drawable, 0 = blocked
         */
        isDrawable: function (worldX, worldZ, terrainSize) {
            if (!isInitialized) return 1;  // no mask → everything drawable
            if (!terrainSize || terrainSize <= 0) return 1;

            var m  = worldToMask(worldX, worldZ, terrainSize);
            var px = Math.floor(m.px);
            var py = Math.floor(m.py);
            if (px < 0 || px >= MASK_SIZE || py < 0 || py >= MASK_SIZE) return 0;

            var pixel = maskCtx.getImageData(px, py, 1, 1).data;
            return pixel[1] > 128 ? 1 : 0;  // green channel decides
        },

        // ----- Fill helpers -----

        /** Reset the mask — everything drawable (green). */
        clear: function () {
            if (!isInitialized) this.init();
            maskCtx.fillStyle = '#00ff00';
            maskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
        },

        /** Fill entire mask as blocked (black). */
        fillBlocked: function () {
            if (!isInitialized) this.init();
            maskCtx.fillStyle = '#000000';
            maskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
        },

        // ----- Statistics -----

        /**
         * Percentage of pixels that are drawable (0–100).
         * Scans every green channel; may be slow on hot paths.
         */
        getDrawablePercent: function () {
            if (!isInitialized) return 100;
            var data = maskCtx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
            var drawable = 0;
            // Green channel sits at offset 1, stride 4
            for (var i = 1; i < data.length; i += 4) {
                if (data[i] > 128) drawable++;
            }
            return Math.round((drawable / (MASK_SIZE * MASK_SIZE)) * 100);
        },

        // ----- Import / Export -----

        /**
         * Export the mask as a PNG Blob (async).
         * @return {Promise<Blob>}
         */
        exportPNG: function () {
            if (!isInitialized) this.init();
            return new Promise(function (resolve, reject) {
                try {
                    maskCanvas.toBlob(function (blob) {
                        if (blob) resolve(blob);
                        else reject(new Error('toBlob returned null'));
                    }, 'image/png');
                } catch (err) {
                    reject(err);
                }
            });
        },

        /**
         * Export the mask as a base-64 data URL (sync).
         * @return {string}
         */
        exportDataURL: function () {
            if (!isInitialized) this.init();
            return maskCanvas.toDataURL('image/png');
        },

        /**
         * Import a mask image from any URL or data-URL.
         * The image is stretched/fit to 512×512.
         *
         * @param  {string} url
         * @return {Promise<void>}
         */
        importFromURL: function (url) {
            var self = this;
            if (!isInitialized) self.init();
            return new Promise(function (resolve, reject) {
                if (!url) { reject(new Error('importFromURL: url is required')); return; }
                var img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = function () {
                    maskCtx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
                    maskCtx.drawImage(img, 0, 0, MASK_SIZE, MASK_SIZE);
                    console.log('[TemplateMask] Imported mask from URL (' + img.naturalWidth + '×' + img.naturalHeight + ')');
                    resolve();
                };
                img.onerror = function () {
                    reject(new Error('importFromURL: failed to load ' + url));
                };
                img.src = url;
            });
        },

        // ----- THREE.js overlay -----

        /**
         * Create (or recreate) a semi-transparent THREE.js plane that
         * visualises the mask on top of the terrain.
         *
         *   Green tint → drawable
         *   Red tint   → blocked
         *
         * @param  {number}       terrainSize
         * @param  {THREE.Scene}  scene
         * @return {THREE.Mesh}   the overlay mesh (also stored internally)
         */
        createOverlay: function (terrainSize, scene) {
            if (!isInitialized) this.init();
            if (typeof THREE === 'undefined') {
                console.warn('[TemplateMask] THREE.js not available — skipping overlay');
                return null;
            }

            // Dispose previous overlay cleanly
            disposeMesh(overlayMesh, scene);
            overlayMesh = null;

            // Build a colour-coded RGBA canvas from the mask data
            var overlayCanvas = document.createElement('canvas');
            overlayCanvas.width  = MASK_SIZE;
            overlayCanvas.height = MASK_SIZE;
            var octx = overlayCanvas.getContext('2d');

            var srcData = maskCtx.getImageData(0, 0, MASK_SIZE, MASK_SIZE);
            var outData = octx.createImageData(MASK_SIZE, MASK_SIZE);
            var src = srcData.data;
            var dst = outData.data;

            for (var i = 0; i < src.length; i += 4) {
                var drawable = src[i + 1] > 128;  // green channel
                dst[i]     = drawable ? 0   : 200; // R
                dst[i + 1] = drawable ? 180 : 0;   // G
                dst[i + 2] = 0;                     // B
                dst[i + 3] = 80;                    // A — semi-transparent
            }
            octx.putImageData(outData, 0, 0);

            var texture = new THREE.CanvasTexture(overlayCanvas);
            var geo = new THREE.PlaneGeometry(terrainSize, terrainSize);
            geo.rotateX(-Math.PI / 2);

            var mat = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
                polygonOffset: true,
                polygonOffsetFactor: -3,
                polygonOffsetUnits: -12
            });

            overlayMesh = new THREE.Mesh(geo, mat);
            overlayMesh.position.y = 0.5;   // float slightly above terrain
            overlayMesh.renderOrder = 999;
            overlayMesh.name = 'TemplateMaskOverlay';

            if (scene) scene.add(overlayMesh);
            return overlayMesh;
        },

        /**
         * Show or hide the overlay.
         * @param {boolean} show
         */
        toggleOverlay: function (show) {
            if (overlayMesh) overlayMesh.visible = !!show;
        },

        /**
         * Rebuild the overlay texture after the mask has changed.
         * Shorthand for createOverlay with the same scene/size.
         */
        refreshOverlay: function (terrainSize, scene) {
            if (overlayMesh) this.createOverlay(terrainSize, scene);
        },

        /**
         * Remove the overlay from the scene and free GPU resources.
         * @param {THREE.Scene} [scene]
         */
        removeOverlay: function (scene) {
            disposeMesh(overlayMesh, scene);
            overlayMesh = null;
        }
    };
})();
