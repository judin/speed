/**
 * Speed Camera PWA - Main Application
 */

class SpeedCameraApp {
    constructor() {
        // DOM Elements
        this.video = document.getElementById('video');
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.speedValue = document.getElementById('speedValue');
        this.speedDisplay = document.querySelector('.speed-display');
        this.maxSpeedDisplay = document.getElementById('maxSpeed');

        // Buttons
        this.startBtn = document.getElementById('startBtn');
        this.calibrateBtn = document.getElementById('calibrateBtn');
        this.resetMaxBtn = document.getElementById('resetMaxBtn');
        this.settingsBtn = document.getElementById('settingsBtn');
        this.retryBtn = document.getElementById('retryBtn');

        // Screens
        this.loadingScreen = document.getElementById('loadingScreen');
        this.loadingMessage = document.getElementById('loadingMessage');
        this.errorScreen = document.getElementById('errorScreen');
        this.errorMessage = document.getElementById('errorMessage');

        // Modal
        this.settingsModal = document.getElementById('settingsModal');
        this.closeSettingsBtn = document.getElementById('closeSettings');

        // Settings
        this.sensitivitySlider = document.getElementById('sensitivitySlider');
        this.sensitivityValue = document.getElementById('sensitivityValue');
        this.cameraSelect = document.getElementById('cameraSelect');
        this.minSpeedFilter = document.getElementById('minSpeedFilter');
        this.soundAlert = document.getElementById('soundAlert');
        this.speedThreshold = document.getElementById('speedThreshold');

        // Calibration
        this.calibrationOverlay = document.getElementById('calibrationOverlay');
        this.calibrationLine = document.getElementById('calibrationLine');
        this.knownDistance = document.getElementById('knownDistance');
        this.confirmCalibration = document.getElementById('confirmCalibration');
        this.detectionZone = document.getElementById('detectionZone');

        // State
        this.isRunning = false;
        this.isCalibrating = false;
        this.stream = null;
        this.animationId = null;
        this.lastAlertTime = 0;

        // Speed detector
        this.detector = new SpeedDetector();

        // Audio context for alerts
        this.audioCtx = null;

        // Calibration line state
        this.calibrationLineStart = 0.2;
        this.calibrationLineEnd = 0.8;

        // Initialize
        this.init();
    }

    async init() {
        this.loadSettings();
        this.bindEvents();
        await this.setupCamera();
        this.registerServiceWorker();
    }

    /**
     * Load saved settings from localStorage
     */
    loadSettings() {
        try {
            const settings = JSON.parse(localStorage.getItem('speedCam_settings'));
            if (settings) {
                this.sensitivitySlider.value = settings.sensitivity || 50;
                this.sensitivityValue.textContent = settings.sensitivity || 50;
                this.cameraSelect.value = settings.camera || 'environment';
                this.minSpeedFilter.value = settings.minSpeed || 5;
                this.soundAlert.checked = settings.soundAlert !== false;
                this.speedThreshold.value = settings.threshold || 25;

                this.detector.setSensitivity(settings.sensitivity || 50);
                this.detector.minSpeedFilter = settings.minSpeed || 5;
            }
        } catch (e) {
            console.log('No saved settings');
        }
    }

    /**
     * Save settings to localStorage
     */
    saveSettings() {
        const settings = {
            sensitivity: parseInt(this.sensitivitySlider.value),
            camera: this.cameraSelect.value,
            minSpeed: parseInt(this.minSpeedFilter.value),
            soundAlert: this.soundAlert.checked,
            threshold: parseInt(this.speedThreshold.value)
        };
        localStorage.setItem('speedCam_settings', JSON.stringify(settings));
    }

    /**
     * Bind UI event handlers
     */
    bindEvents() {
        // Main controls
        this.startBtn.addEventListener('click', () => this.toggleDetection());
        this.calibrateBtn.addEventListener('click', () => this.startCalibration());
        this.resetMaxBtn.addEventListener('click', () => this.resetMaxSpeed());

        // Settings
        this.settingsBtn.addEventListener('click', () => this.openSettings());
        this.closeSettingsBtn.addEventListener('click', () => this.closeSettings());

        this.sensitivitySlider.addEventListener('input', (e) => {
            this.sensitivityValue.textContent = e.target.value;
            this.detector.setSensitivity(parseInt(e.target.value));
            this.saveSettings();
        });

        this.cameraSelect.addEventListener('change', () => {
            this.saveSettings();
            this.switchCamera();
        });

        this.minSpeedFilter.addEventListener('change', (e) => {
            this.detector.minSpeedFilter = parseInt(e.target.value);
            this.saveSettings();
        });

        this.soundAlert.addEventListener('change', () => this.saveSettings());
        this.speedThreshold.addEventListener('change', () => this.saveSettings());

        // Calibration
        this.confirmCalibration.addEventListener('click', () => this.finishCalibration());
        this.setupCalibrationDrag();

        // Retry button
        this.retryBtn.addEventListener('click', () => this.setupCamera());

        // Handle visibility change (pause when hidden)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this.isRunning) {
                this.stopDetection();
            }
        });

        // Handle resize
        window.addEventListener('resize', () => this.handleResize());
    }

    /**
     * Setup camera access
     */
    async setupCamera() {
        this.showLoading('Requesting camera access...');

        try {
            // Stop existing stream
            if (this.stream) {
                this.stream.getTracks().forEach(track => track.stop());
            }

            // Request camera
            const facingMode = this.cameraSelect.value;
            const constraints = {
                video: {
                    facingMode: facingMode,
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                },
                audio: false
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            this.video.srcObject = this.stream;

            // Wait for video to be ready
            await new Promise((resolve) => {
                this.video.onloadedmetadata = () => {
                    this.video.play();
                    resolve();
                };
            });

            // Set canvas size
            this.handleResize();

            // Initialize detector
            this.detector.init(this.canvas.width, this.canvas.height);

            // Hide loading
            this.hideLoading();

            console.log('Camera ready:', this.video.videoWidth, 'x', this.video.videoHeight);

        } catch (error) {
            console.error('Camera error:', error);
            this.showError(this.getCameraErrorMessage(error));
        }
    }

    /**
     * Get user-friendly error message
     */
    getCameraErrorMessage(error) {
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            return 'Camera access was denied. Please allow camera access in your browser settings and try again.';
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
            return 'No camera found. Please ensure your device has a camera.';
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
            return 'Camera is in use by another application. Please close other apps using the camera.';
        } else if (error.name === 'OverconstrainedError') {
            return 'Camera does not support required settings. Try switching cameras.';
        } else if (error.name === 'NotSupportedError') {
            return 'Camera access is not supported in this browser. Try Chrome or Safari.';
        }
        return `Camera error: ${error.message || error.name}`;
    }

    /**
     * Switch between front/back camera
     */
    async switchCamera() {
        if (this.isRunning) {
            this.stopDetection();
        }
        await this.setupCamera();
    }

    /**
     * Handle window resize
     */
    handleResize() {
        const container = document.querySelector('.camera-container');
        const rect = container.getBoundingClientRect();

        // Match canvas to container
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;

        // Reinit detector with new size if needed
        if (this.detector.width !== this.canvas.width) {
            this.detector.init(this.canvas.width, this.canvas.height);
        }
    }

    /**
     * Toggle speed detection on/off
     */
    toggleDetection() {
        if (this.isRunning) {
            this.stopDetection();
        } else {
            this.startDetection();
        }
    }

    /**
     * Start speed detection
     */
    startDetection() {
        if (this.isCalibrating) return;

        this.isRunning = true;
        this.startBtn.textContent = 'Stop Detection';
        this.startBtn.classList.add('active');
        this.detectionZone.classList.add('active');

        // Reset detector
        this.detector.reset();

        // Start detection loop
        this.detectLoop();

        console.log('Detection started');
    }

    /**
     * Stop speed detection
     */
    stopDetection() {
        this.isRunning = false;
        this.startBtn.textContent = 'Start Detection';
        this.startBtn.classList.remove('active');
        this.detectionZone.classList.remove('active');

        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        console.log('Detection stopped');
    }

    /**
     * Main detection loop
     */
    detectLoop() {
        if (!this.isRunning) return;

        // Process frame
        const result = this.detector.processFrame(this.video, this.ctx);

        // Update display
        this.updateSpeedDisplay(result.speed);

        // Check for alert
        if (result.speed > 0) {
            this.maxSpeedDisplay.textContent = `Max: ${result.maxSpeed} MPH`;
            this.checkSpeedAlert(result.speed);
        }

        // Continue loop
        this.animationId = requestAnimationFrame(() => this.detectLoop());
    }

    /**
     * Update speed display with color coding
     */
    updateSpeedDisplay(speed) {
        this.speedValue.textContent = speed;

        const threshold = parseInt(this.speedThreshold.value);

        // Remove existing classes
        this.speedValue.classList.remove('warning', 'danger');
        this.speedDisplay.classList.remove('warning', 'danger');

        // Add appropriate class
        if (speed > threshold + 10) {
            this.speedValue.classList.add('danger');
            this.speedDisplay.classList.add('danger');
        } else if (speed > threshold) {
            this.speedValue.classList.add('warning');
            this.speedDisplay.classList.add('warning');
        }
    }

    /**
     * Check if speed exceeds threshold and play alert
     */
    checkSpeedAlert(speed) {
        const threshold = parseInt(this.speedThreshold.value);
        const now = Date.now();

        if (this.soundAlert.checked && speed > threshold && now - this.lastAlertTime > 2000) {
            this.playAlertSound();
            this.lastAlertTime = now;
        }
    }

    /**
     * Play alert beep sound
     */
    playAlertSound() {
        try {
            if (!this.audioCtx) {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            const oscillator = this.audioCtx.createOscillator();
            const gainNode = this.audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(this.audioCtx.destination);

            oscillator.frequency.value = 880;
            oscillator.type = 'sine';

            gainNode.gain.setValueAtTime(0.3, this.audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.3);

            oscillator.start(this.audioCtx.currentTime);
            oscillator.stop(this.audioCtx.currentTime + 0.3);
        } catch (e) {
            console.log('Could not play alert sound');
        }
    }

    /**
     * Reset max speed
     */
    resetMaxSpeed() {
        this.detector.resetMaxSpeed();
        this.maxSpeedDisplay.textContent = 'Max: 0 MPH';
    }

    /**
     * Start calibration mode
     */
    startCalibration() {
        if (this.isRunning) {
            this.stopDetection();
        }

        this.isCalibrating = true;
        this.calibrationOverlay.classList.remove('hidden');

        // Load existing calibration distance if available
        const info = this.detector.getCalibrationInfo();
        if (info.calibrationDistance) {
            this.knownDistance.value = info.calibrationDistance;
        }
    }

    /**
     * Setup draggable calibration line
     */
    setupCalibrationDrag() {
        let isDragging = false;
        let dragPoint = null;

        const getPosition = (e) => {
            const touch = e.touches ? e.touches[0] : e;
            const rect = this.calibrationOverlay.getBoundingClientRect();
            return {
                x: (touch.clientX - rect.left) / rect.width,
                y: (touch.clientY - rect.top) / rect.height
            };
        };

        const updateLine = () => {
            const left = this.calibrationLineStart * 100;
            const width = (this.calibrationLineEnd - this.calibrationLineStart) * 100;
            this.calibrationLine.style.left = `${left}%`;
            this.calibrationLine.style.width = `${width}%`;
        };

        const onStart = (e) => {
            const pos = getPosition(e);
            const startDist = Math.abs(pos.x - this.calibrationLineStart);
            const endDist = Math.abs(pos.x - this.calibrationLineEnd);

            if (startDist < 0.1) {
                isDragging = true;
                dragPoint = 'start';
            } else if (endDist < 0.1) {
                isDragging = true;
                dragPoint = 'end';
            }
        };

        const onMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();

            const pos = getPosition(e);

            if (dragPoint === 'start') {
                this.calibrationLineStart = Math.max(0.05, Math.min(pos.x, this.calibrationLineEnd - 0.1));
            } else {
                this.calibrationLineEnd = Math.min(0.95, Math.max(pos.x, this.calibrationLineStart + 0.1));
            }

            updateLine();
        };

        const onEnd = () => {
            isDragging = false;
            dragPoint = null;
        };

        this.calibrationOverlay.addEventListener('mousedown', onStart);
        this.calibrationOverlay.addEventListener('touchstart', onStart, { passive: true });

        document.addEventListener('mousemove', onMove);
        document.addEventListener('touchmove', onMove, { passive: false });

        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchend', onEnd);
    }

    /**
     * Finish calibration and save
     */
    finishCalibration() {
        const realDistance = parseFloat(this.knownDistance.value);
        if (isNaN(realDistance) || realDistance <= 0) {
            alert('Please enter a valid distance');
            return;
        }

        // Calculate pixel distance of calibration line
        const pixelDistance = (this.calibrationLineEnd - this.calibrationLineStart) * this.canvas.width;

        // Set calibration
        this.detector.setCalibration(pixelDistance, realDistance);

        // Hide overlay
        this.calibrationOverlay.classList.add('hidden');
        this.isCalibrating = false;

        console.log('Calibration saved:', pixelDistance, 'pixels =', realDistance, 'feet');
    }

    /**
     * Open settings modal
     */
    openSettings() {
        this.settingsModal.classList.remove('hidden');
    }

    /**
     * Close settings modal
     */
    closeSettings() {
        this.settingsModal.classList.add('hidden');
    }

    /**
     * Show loading screen
     */
    showLoading(message) {
        this.loadingMessage.textContent = message;
        this.loadingScreen.classList.remove('hidden');
        this.errorScreen.classList.add('hidden');
    }

    /**
     * Hide loading screen
     */
    hideLoading() {
        this.loadingScreen.classList.add('hidden');
    }

    /**
     * Show error screen
     */
    showError(message) {
        this.errorMessage.textContent = message;
        this.errorScreen.classList.remove('hidden');
        this.loadingScreen.classList.add('hidden');
    }

    /**
     * Register service worker for PWA
     */
    async registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('service-worker.js');
                console.log('Service Worker registered:', registration.scope);
            } catch (error) {
                console.log('Service Worker registration failed:', error);
            }
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SpeedCameraApp();
});
