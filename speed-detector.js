/**
 * Speed Detector - Motion tracking and speed calculation
 * Uses frame differencing and blob tracking to estimate object speed
 */

class SpeedDetector {
    constructor(options = {}) {
        // Detection settings
        this.sensitivity = options.sensitivity || 50;
        this.minSpeedFilter = options.minSpeedFilter || 5;

        // Frame rate measurement
        this.frameRate = 30; // Will be measured dynamically
        this.lastFrameTime = 0;
        this.frameRateHistory = [];
        this.frameRateHistorySize = 10;

        // Calibration (pixels per foot)
        this.pixelsPerFoot = options.pixelsPerFoot || null;
        this.calibrationDistance = options.calibrationDistance || 12; // default lane width

        // Canvas contexts for processing
        this.prevFrame = null;
        this.processingCanvas = null;
        this.processingCtx = null;

        // Tracking data
        this.trackedObjects = [];
        this.currentSpeed = 0;
        this.maxSpeed = 0;
        this.speedHistory = [];
        this.historySize = 5; // frames to average

        // Detection zone (percentage of frame)
        this.detectionZone = {
            x: 0.02,
            y: 0.02,
            width: 0.96,
            height: 0.96
        };

        // Motion detection thresholds - lower = more sensitive
        this.motionThreshold = 20;
        this.minBlobSize = 100; // minimum pixels for a valid object
        this.maxBlobSize = 200000; // maximum pixels (to filter noise)

        // Debug stats
        this.debugStats = {
            motionPixels: 0,
            blobsFound: 0,
            trackedCount: 0
        };
    }

    /**
     * Initialize processing canvases
     */
    init(width, height) {
        this.width = width;
        this.height = height;

        // Create processing canvas
        this.processingCanvas = document.createElement('canvas');
        this.processingCanvas.width = width;
        this.processingCanvas.height = height;
        this.processingCtx = this.processingCanvas.getContext('2d', { willReadFrequently: true });

        // Previous frame canvas
        this.prevCanvas = document.createElement('canvas');
        this.prevCanvas.width = width;
        this.prevCanvas.height = height;
        this.prevCtx = this.prevCanvas.getContext('2d', { willReadFrequently: true });

        // Diff canvas
        this.diffCanvas = document.createElement('canvas');
        this.diffCanvas.width = width;
        this.diffCanvas.height = height;
        this.diffCtx = this.diffCanvas.getContext('2d', { willReadFrequently: true });

        // Load saved calibration
        this.loadCalibration();

        console.log('SpeedDetector initialized:', width, 'x', height);
    }

    /**
     * Update sensitivity setting
     */
    setSensitivity(value) {
        this.sensitivity = value;
        // Adjust motion threshold inversely to sensitivity
        this.motionThreshold = Math.max(10, 50 - (value * 0.4));
        this.minBlobSize = Math.max(100, 1000 - (value * 10));
    }

    /**
     * Set calibration from pixel distance and real-world distance
     */
    setCalibration(pixelDistance, realDistanceFeet) {
        this.pixelsPerFoot = pixelDistance / realDistanceFeet;
        this.calibrationDistance = realDistanceFeet;
        this.saveCalibration();
        console.log('Calibration set:', this.pixelsPerFoot, 'pixels/foot');
    }

    /**
     * Auto-calibrate using default assumptions
     * Assumes typical lane width in view is 60% of frame width
     */
    autoCalibrate() {
        const assumedLaneWidthInFrame = this.width * 0.6;
        const typicalLaneWidthFeet = 12;
        this.pixelsPerFoot = assumedLaneWidthInFrame / typicalLaneWidthFeet;
        this.calibrationDistance = typicalLaneWidthFeet;
        console.log('Auto-calibrated:', this.pixelsPerFoot, 'pixels/foot (assuming 12ft lane)');
    }

    /**
     * Save calibration to localStorage
     */
    saveCalibration() {
        const data = {
            pixelsPerFoot: this.pixelsPerFoot,
            calibrationDistance: this.calibrationDistance,
            timestamp: Date.now()
        };
        localStorage.setItem('speedCam_calibration', JSON.stringify(data));
    }

    /**
     * Load calibration from localStorage
     */
    loadCalibration() {
        try {
            const data = JSON.parse(localStorage.getItem('speedCam_calibration'));
            if (data && data.pixelsPerFoot) {
                this.pixelsPerFoot = data.pixelsPerFoot;
                this.calibrationDistance = data.calibrationDistance;
                console.log('Loaded calibration:', this.pixelsPerFoot, 'pixels/foot');
                return true;
            }
        } catch (e) {
            console.log('No saved calibration found');
        }

        // Auto-calibrate if no saved data
        this.autoCalibrate();
        return false;
    }

    /**
     * Process a video frame and detect speed
     * @param {HTMLVideoElement} video - Source video element
     * @param {CanvasRenderingContext2D} outputCtx - Canvas for drawing overlays
     * @returns {Object} Detection results
     */
    processFrame(video, outputCtx) {
        if (!this.processingCtx) return { speed: 0, objects: [], debug: this.debugStats };

        // Measure actual frame rate
        const now = performance.now();
        if (this.lastFrameTime > 0) {
            const deltaMs = now - this.lastFrameTime;
            const instantFps = 1000 / deltaMs;
            this.frameRateHistory.push(instantFps);
            if (this.frameRateHistory.length > this.frameRateHistorySize) {
                this.frameRateHistory.shift();
            }
            // Use average FPS
            this.frameRate = this.frameRateHistory.reduce((a, b) => a + b, 0) / this.frameRateHistory.length;
        }
        this.lastFrameTime = now;

        // Draw current frame to processing canvas (scaled down for performance)
        this.processingCtx.drawImage(video, 0, 0, this.width, this.height);

        // Get current frame data
        const currentFrame = this.processingCtx.getImageData(0, 0, this.width, this.height);

        // Skip if no previous frame
        if (!this.prevFrame) {
            this.prevFrame = currentFrame;
            this.prevCtx.putImageData(currentFrame, 0, 0);
            return { speed: 0, objects: [], debug: this.debugStats };
        }

        // Compute frame difference
        const diffData = this.computeFrameDiff(this.prevFrame, currentFrame);

        // Find motion blobs
        const blobs = this.findMotionBlobs(diffData);
        this.debugStats.blobsFound = blobs.length;

        // Track objects and calculate speed
        const trackedObjects = this.trackObjects(blobs);
        this.debugStats.trackedCount = trackedObjects.length;

        // Calculate average speed from tracked objects
        let maxObjectSpeed = 0;
        trackedObjects.forEach(obj => {
            if (obj.speed > maxObjectSpeed && obj.speed > this.minSpeedFilter) {
                maxObjectSpeed = obj.speed;
            }
        });

        // Smooth speed reading
        this.speedHistory.push(maxObjectSpeed);
        if (this.speedHistory.length > this.historySize) {
            this.speedHistory.shift();
        }

        // Use median for stability
        const sortedHistory = [...this.speedHistory].sort((a, b) => a - b);
        this.currentSpeed = sortedHistory[Math.floor(sortedHistory.length / 2)];

        // Update max speed
        if (this.currentSpeed > this.maxSpeed) {
            this.maxSpeed = this.currentSpeed;
        }

        // Draw visualization
        this.drawOverlay(outputCtx, trackedObjects);

        // Store current frame as previous
        this.prevFrame = currentFrame;
        this.prevCtx.putImageData(currentFrame, 0, 0);

        return {
            speed: Math.round(this.currentSpeed),
            maxSpeed: Math.round(this.maxSpeed),
            objects: trackedObjects,
            debug: {
                ...this.debugStats,
                fps: Math.round(this.frameRate),
                pixelsPerFoot: Math.round(this.pixelsPerFoot || 0)
            }
        };
    }

    /**
     * Compute difference between two frames
     */
    computeFrameDiff(prevFrame, currentFrame) {
        const diff = this.diffCtx.createImageData(this.width, this.height);
        const prev = prevFrame.data;
        const curr = currentFrame.data;
        const out = diff.data;
        let motionPixelCount = 0;

        // Detection zone boundaries
        const zoneX1 = Math.floor(this.width * this.detectionZone.x);
        const zoneX2 = Math.floor(this.width * (this.detectionZone.x + this.detectionZone.width));
        const zoneY1 = Math.floor(this.height * this.detectionZone.y);
        const zoneY2 = Math.floor(this.height * (this.detectionZone.y + this.detectionZone.height));

        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const i = (y * this.width + x) * 4;

                // Only process within detection zone
                if (x < zoneX1 || x > zoneX2 || y < zoneY1 || y > zoneY2) {
                    out[i] = out[i + 1] = out[i + 2] = 0;
                    out[i + 3] = 255;
                    continue;
                }

                // Calculate luminance difference
                const prevLum = prev[i] * 0.299 + prev[i + 1] * 0.587 + prev[i + 2] * 0.114;
                const currLum = curr[i] * 0.299 + curr[i + 1] * 0.587 + curr[i + 2] * 0.114;
                const diff_val = Math.abs(currLum - prevLum);

                // Threshold
                if (diff_val > this.motionThreshold) {
                    out[i] = out[i + 1] = out[i + 2] = 255;
                    motionPixelCount++;
                } else {
                    out[i] = out[i + 1] = out[i + 2] = 0;
                }
                out[i + 3] = 255;
            }
        }

        this.debugStats.motionPixels = motionPixelCount;
        this.diffCtx.putImageData(diff, 0, 0);
        return diff;
    }

    /**
     * Find connected motion blobs using simple flood fill
     */
    findMotionBlobs(diffData) {
        const data = diffData.data;
        const visited = new Uint8Array(this.width * this.height);
        const blobs = [];

        for (let y = 0; y < this.height; y += 4) { // Skip pixels for performance
            for (let x = 0; x < this.width; x += 4) {
                const i = y * this.width + x;
                const pi = i * 4;

                if (data[pi] > 0 && !visited[i]) {
                    // Found unvisited motion pixel, flood fill to find blob
                    const blob = this.floodFill(data, visited, x, y);

                    if (blob.size >= this.minBlobSize && blob.size <= this.maxBlobSize) {
                        blobs.push(blob);
                    }
                }
            }
        }

        return blobs;
    }

    /**
     * Simple flood fill to find connected region
     */
    floodFill(data, visited, startX, startY) {
        const stack = [[startX, startY]];
        let minX = startX, maxX = startX;
        let minY = startY, maxY = startY;
        let sumX = 0, sumY = 0;
        let size = 0;

        while (stack.length > 0) {
            const [x, y] = stack.pop();

            if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;

            const i = y * this.width + x;
            if (visited[i]) continue;

            const pi = i * 4;
            if (data[pi] === 0) continue;

            visited[i] = 1;
            size++;
            sumX += x;
            sumY += y;

            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);

            // Add neighbors (use larger step for performance)
            stack.push([x + 2, y], [x - 2, y], [x, y + 2], [x, y - 2]);
        }

        return {
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
            centerX: sumX / size,
            centerY: sumY / size,
            size: size * 4 // Approximate (we skipped pixels)
        };
    }

    /**
     * Track objects between frames and calculate speed
     */
    trackObjects(blobs) {
        const newTracked = [];
        const usedPrev = new Set();

        for (const blob of blobs) {
            // Find closest previous object
            let bestMatch = null;
            let bestDist = Infinity;

            for (let i = 0; i < this.trackedObjects.length; i++) {
                if (usedPrev.has(i)) continue;

                const prev = this.trackedObjects[i];
                const dx = blob.centerX - prev.centerX;
                const dy = blob.centerY - prev.centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                // Match if close enough and similar size
                const sizeRatio = blob.size / prev.size;
                if (dist < 150 && sizeRatio > 0.5 && sizeRatio < 2.0 && dist < bestDist) {
                    bestDist = dist;
                    bestMatch = { index: i, prev, dx, dy, dist };
                }
            }

            if (bestMatch) {
                usedPrev.add(bestMatch.index);

                // Calculate speed in MPH
                const pixelsPerSecond = bestMatch.dist * this.frameRate;
                const feetPerSecond = this.pixelsPerFoot ?
                    pixelsPerSecond / this.pixelsPerFoot :
                    pixelsPerSecond / 50; // fallback rough estimate
                const mph = feetPerSecond * 0.681818; // ft/s to mph

                newTracked.push({
                    ...blob,
                    id: bestMatch.prev.id,
                    speed: Math.abs(mph),
                    dx: bestMatch.dx,
                    dy: bestMatch.dy,
                    frames: bestMatch.prev.frames + 1
                });
            } else {
                // New object
                newTracked.push({
                    ...blob,
                    id: Date.now() + Math.random(),
                    speed: 0,
                    dx: 0,
                    dy: 0,
                    frames: 1
                });
            }
        }

        this.trackedObjects = newTracked;
        return newTracked;
    }

    /**
     * Draw tracking visualization on canvas
     */
    drawOverlay(ctx, objects) {
        ctx.clearRect(0, 0, this.width, this.height);

        // Draw detection zone outline
        ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 10]);
        ctx.strokeRect(
            this.width * this.detectionZone.x,
            this.height * this.detectionZone.y,
            this.width * this.detectionZone.width,
            this.height * this.detectionZone.height
        );
        ctx.setLineDash([]);

        // Draw debug info in corner
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(10, 10, 160, 80);
        ctx.fillStyle = '#00d4ff';
        ctx.font = '12px monospace';
        ctx.fillText(`FPS: ${Math.round(this.frameRate)}`, 20, 28);
        ctx.fillText(`Motion: ${this.debugStats.motionPixels}px`, 20, 44);
        ctx.fillText(`Blobs: ${this.debugStats.blobsFound}`, 20, 60);
        ctx.fillText(`Tracked: ${objects.length}`, 20, 76);

        // Draw tracked objects - show ALL detected blobs
        objects.forEach(obj => {
            // Color based on tracking state and speed
            let color = 'rgba(0, 255, 136, 0.6)'; // Green for new/untracked
            if (obj.frames >= 2) {
                color = 'rgba(0, 212, 255, 0.8)'; // Cyan for tracked
                if (obj.speed > 35) {
                    color = 'rgba(255, 68, 68, 0.8)'; // Red for fast
                } else if (obj.speed > 25) {
                    color = 'rgba(255, 170, 0, 0.8)'; // Orange for medium
                }
            }

            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);

            // Show speed label for tracked objects
            if (obj.frames >= 2 && obj.speed > 0) {
                ctx.fillStyle = color;
                ctx.font = 'bold 14px sans-serif';
                ctx.fillText(
                    `${Math.round(obj.speed)} MPH`,
                    obj.x,
                    obj.y - 6
                );

                // Motion direction arrow
                if (Math.abs(obj.dx) > 3 || Math.abs(obj.dy) > 3) {
                    const arrowLen = Math.min(40, Math.sqrt(obj.dx * obj.dx + obj.dy * obj.dy) * 2);
                    const angle = Math.atan2(obj.dy, obj.dx);
                    const endX = obj.centerX + Math.cos(angle) * arrowLen;
                    const endY = obj.centerY + Math.sin(angle) * arrowLen;

                    ctx.beginPath();
                    ctx.moveTo(obj.centerX, obj.centerY);
                    ctx.lineTo(endX, endY);
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.stroke();

                    // Arrow head
                    ctx.beginPath();
                    ctx.arc(endX, endY, 4, 0, Math.PI * 2);
                    ctx.fillStyle = color;
                    ctx.fill();
                }
            }
        });
    }

    /**
     * Reset tracking data
     */
    reset() {
        this.trackedObjects = [];
        this.currentSpeed = 0;
        this.speedHistory = [];
        this.prevFrame = null;
        this.lastFrameTime = 0;
        this.frameRateHistory = [];
    }

    /**
     * Reset max speed
     */
    resetMaxSpeed() {
        this.maxSpeed = 0;
    }

    /**
     * Get current calibration info
     */
    getCalibrationInfo() {
        return {
            pixelsPerFoot: this.pixelsPerFoot,
            calibrationDistance: this.calibrationDistance,
            isCalibrated: this.pixelsPerFoot !== null
        };
    }
}

// Export for use in app.js
window.SpeedDetector = SpeedDetector;
