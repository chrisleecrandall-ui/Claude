/**
 * Softball Swing Analysis Engine
 *
 * Designed for real-world game footage (GameChanger-style behind-home-plate videos).
 * Scans full at-bat videos to find individual pitch/swing events, isolates the
 * batter zone, and analyzes swing mechanics for each detected swing.
 *
 * Handles: title card detection & skip, tight batter zone, multi-pitch at-bats.
 */

const SwingAnalyzer = (() => {

    // ---- Swing Phase Definitions ----
    const PHASES = [
        { id: 'stance',  name: 'Stance / Setup',   color: '#6366f1' },
        { id: 'load',    name: 'Load / Coil',      color: '#8b5cf6' },
        { id: 'stride',  name: 'Stride',            color: '#a855f7' },
        { id: 'swing',   name: 'Swing / Rotation',  color: '#d946ef' },
        { id: 'contact', name: 'Contact',            color: '#ec4899' },
        { id: 'follow',  name: 'Follow-Through',     color: '#f43f5e' },
    ];

    // Swing outcome types
    const OUTCOMES = {
        hit:       { label: 'Hit',           contactPhase: 'Contact' },
        miss:      { label: 'Swing & Miss',  contactPhase: 'Swing-Through' },
        foul:      { label: 'Foul Ball',     contactPhase: 'Foul Contact' },
        ball:      { label: 'Ball (Took)',   contactPhase: 'Check Swing / Hold' },
        out:       { label: 'Out',           contactPhase: 'Contact' },
        walk:      { label: 'Walk',          contactPhase: 'Check Swing / Hold' },
        strikeout: { label: 'Strikeout',     contactPhase: 'Swing-Through' },
        homerun:   { label: 'Home Run',      contactPhase: 'Contact' },
        error:     { label: 'Error',         contactPhase: 'Contact' },
        single:    { label: 'Single',        contactPhase: 'Contact' },
        double:    { label: 'Double',        contactPhase: 'Contact' },
        triple:    { label: 'Triple',        contactPhase: 'Contact' },
    };

    const AGE_BENCHMARKS = {
        '8u':      { swingTime: [0.6, 0.9],  batAngle: [30, 50], strideLength: [0.3, 0.5], hipRotation: [30, 50] },
        '10u':     { swingTime: [0.5, 0.8],  batAngle: [25, 45], strideLength: [0.35, 0.55], hipRotation: [35, 55] },
        '12u':     { swingTime: [0.4, 0.7],  batAngle: [20, 45], strideLength: [0.4, 0.6], hipRotation: [40, 60] },
        '14u':     { swingTime: [0.35, 0.6], batAngle: [15, 40], strideLength: [0.4, 0.65], hipRotation: [45, 65] },
        '16u':     { swingTime: [0.3, 0.55], batAngle: [10, 35], strideLength: [0.45, 0.7], hipRotation: [50, 70] },
        'college': { swingTime: [0.25, 0.5], batAngle: [10, 30], strideLength: [0.5, 0.75], hipRotation: [55, 75] },
    };

    // ---- Filename Parsing ----

    function parseFilename(filename) {
        const name = filename.replace(/\.[^.]+$/, '');

        let outcome = 'hit';
        let description = name;

        const outcomePatterns = [
            { pattern: /home\s*run/i,                outcome: 'homerun' },
            { pattern: /triple/i,                    outcome: 'triple' },
            { pattern: /double/i,                    outcome: 'double' },
            { pattern: /single/i,                    outcome: 'single' },
            { pattern: /strikeout|struck\s*out|strike\s*out/i, outcome: 'strikeout' },
            { pattern: /walk|base\s*on\s*balls|bb/i, outcome: 'walk' },
            { pattern: /foul/i,                      outcome: 'foul' },
            { pattern: /batter\s*out|fly\s*out|ground\s*out|pop\s*out|line\s*out/i, outcome: 'out' },
            { pattern: /hit\s*by\s*pitch|hbp/i,      outcome: 'ball' },
            { pattern: /error/i,                     outcome: 'error' },
            { pattern: /hit|base\s*hit/i,            outcome: 'hit' },
            { pattern: /miss/i,                      outcome: 'miss' },
            { pattern: /ball/i,                      outcome: 'ball' },
        ];

        for (const { pattern, outcome: o } of outcomePatterns) {
            if (pattern.test(name)) {
                outcome = o;
                break;
            }
        }

        const atMatch = name.match(/@\s*(.+)/);
        const opponent = atMatch ? atMatch[1].trim() : null;

        return { outcome, description, opponent };
    }

    // ---- Frame Extraction ----

    function extractFrameAt(videoEl, time) {
        return new Promise((resolve, reject) => {
            videoEl.currentTime = time;
            videoEl.onseeked = () => {
                const canvas = document.createElement('canvas');
                canvas.width = videoEl.videoWidth;
                canvas.height = videoEl.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
                resolve({ canvas, time });
            };
            videoEl.onerror = () => reject(new Error('Error seeking video'));
        });
    }

    // ---- Brightness / Title Card Detection ----

    /**
     * Compute average brightness of a canvas (0-1 scale).
     * GameChanger title cards have dark backgrounds (~0.05-0.15).
     * Gameplay frames are much brighter (~0.3-0.7 for outdoor fields).
     */
    function computeBrightness(canvas) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h).data;

        let sum = 0;
        let count = 0;
        const step = 32; // sample every 32nd pixel for speed

        for (let i = 0; i < data.length; i += 4 * step) {
            sum += data[i] + data[i + 1] + data[i + 2];
            count++;
        }

        return sum / (count * 3 * 255);
    }

    /**
     * Detect where the GameChanger title card ends.
     * Returns the index into the samples array where gameplay begins.
     *
     * Strategy: Title cards are dark (brightness < 0.25). Gameplay is bright.
     * We look for the transition from dark to bright frames.
     * Also handles videos with no title card (returns 0).
     */
    function detectTitleCardEnd(samples) {
        if (samples.length < 3) return 0;

        // Check if early frames are dark (title card)
        const earlyCount = Math.min(8, Math.floor(samples.length * 0.3));
        const earlyBrightness = samples.slice(0, earlyCount).map(s => s.brightness);
        const avgEarlyBrightness = earlyBrightness.reduce((a, b) => a + b, 0) / earlyBrightness.length;

        // If early frames are already bright, there's no title card
        if (avgEarlyBrightness > 0.25) return 0;

        // Find the first frame where brightness jumps above the threshold
        // indicating the transition from title card to gameplay
        const brightnessThreshold = 0.25;

        for (let i = 0; i < samples.length; i++) {
            if (samples[i].brightness > brightnessThreshold) {
                // Found the transition — skip a couple extra frames to clear
                // any transition animation/fade
                return Math.min(i + 2, samples.length - 1);
            }
        }

        // If the whole video is dark, just start from the beginning
        return 0;
    }

    // ---- Motion Scanning ----

    /**
     * Quick-scan the video at regular intervals to build a motion + brightness timeline.
     * Returns array of { time, motion, batterMotion, brightness, canvas }
     */
    async function scanVideoMotion(videoEl, sampleInterval, onProgress) {
        const duration = videoEl.duration;
        if (!duration || duration === Infinity) {
            throw new Error('Cannot determine video duration');
        }

        const samples = [];
        const times = [];
        const start = 0.3;
        const end = Math.max(duration - 0.3, start + 1);

        for (let t = start; t <= end; t += sampleInterval) {
            times.push(t);
        }

        let prevCanvas = null;
        for (let i = 0; i < times.length; i++) {
            const frame = await extractFrameAt(videoEl, times[i]);
            const brightness = computeBrightness(frame.canvas);

            if (prevCanvas) {
                const fullMotion = motionBetween(prevCanvas, frame.canvas);
                const batterMotion = batterZoneMotion(prevCanvas, frame.canvas);
                samples.push({
                    time: times[i],
                    motion: fullMotion,
                    batterMotion: batterMotion,
                    brightness: brightness,
                    canvas: frame.canvas,
                });
            } else {
                samples.push({
                    time: times[i],
                    motion: 0,
                    batterMotion: 0,
                    brightness: brightness,
                    canvas: frame.canvas,
                });
            }
            prevCanvas = frame.canvas;

            if (onProgress) {
                onProgress(i / times.length);
            }
        }

        return samples;
    }

    // ---- Batter Zone Detection ----

    /**
     * For behind-home-plate GameChanger view, the batter is in the
     * lower-center of the frame, near home plate.
     *
     * Tight batter zone:
     *   - Width:  25% to 65% of frame (the batter's box area)
     *   - Height: 50% to 92% of frame (bottom portion where batter stands)
     *
     * This is much tighter than before to avoid picking up fielders,
     * the pitcher, or the title card text area.
     */
    function batterZoneMotion(canvasA, canvasB) {
        const w = canvasA.width;
        const h = canvasA.height;

        // Tight batter zone for behind-plate view
        const zoneX = Math.floor(w * 0.25);
        const zoneW = Math.floor(w * 0.40); // 25% to 65%
        const zoneY = Math.floor(h * 0.50);
        const zoneH = Math.floor(h * 0.42); // 50% to 92%

        const ctxA = canvasA.getContext('2d');
        const ctxB = canvasB.getContext('2d');
        const dataA = ctxA.getImageData(zoneX, zoneY, zoneW, zoneH).data;
        const dataB = ctxB.getImageData(zoneX, zoneY, zoneW, zoneH).data;

        let diff = 0;
        const step = 8;
        for (let i = 0; i < dataA.length; i += 4 * step) {
            diff += Math.abs(dataA[i] - dataB[i]);
            diff += Math.abs(dataA[i + 1] - dataB[i + 1]);
            diff += Math.abs(dataA[i + 2] - dataB[i + 2]);
        }
        const totalPx = (dataA.length / 4) / step;
        return diff / (totalPx * 3 * 255);
    }

    /**
     * Compute motion in sub-regions of the batter zone (left/right/upper/lower).
     * Uses the same tight batter zone coordinates.
     */
    function batterRegionMotion(canvasA, canvasB) {
        const w = canvasA.width;
        const h = canvasA.height;
        const ctxA = canvasA.getContext('2d');
        const ctxB = canvasB.getContext('2d');

        // Same tight batter zone
        const zX = Math.floor(w * 0.25);
        const zW = Math.floor(w * 0.40);
        const zY = Math.floor(h * 0.50);
        const zH = Math.floor(h * 0.42);

        const regions = {
            upper: { x: zX, y: zY, w: zW, h: Math.floor(zH * 0.45) },
            lower: { x: zX, y: zY + Math.floor(zH * 0.45), w: zW, h: zH - Math.floor(zH * 0.45) },
            left:  { x: zX, y: zY, w: Math.floor(zW * 0.5), h: zH },
            right: { x: zX + Math.floor(zW * 0.5), y: zY, w: zW - Math.floor(zW * 0.5), h: zH },
        };

        const result = {};
        for (const [name, r] of Object.entries(regions)) {
            const dA = ctxA.getImageData(r.x, r.y, r.w, r.h).data;
            const dB = ctxB.getImageData(r.x, r.y, r.w, r.h).data;
            let diff = 0;
            const step = 12;
            for (let i = 0; i < dA.length; i += 4 * step) {
                diff += Math.abs(dA[i] - dB[i]);
                diff += Math.abs(dA[i + 1] - dB[i + 1]);
                diff += Math.abs(dA[i + 2] - dB[i + 2]);
            }
            const px = (dA.length / 4) / step;
            result[name] = diff / (px * 3 * 255);
        }
        return result;
    }

    // ---- Pitch/Swing Event Detection ----

    /**
     * Detect individual swing/pitch events from the motion timeline.
     * Only searches within gameplay frames (after title card).
     *
     * A swing event is a sharp spike in batter-zone motion.
     * Returns array of { peakTime, startTime, endTime, peakMotion, sampleIndices }
     */
    function detectSwingEvents(samples, minGapSeconds, gameplayStartIdx) {
        // Only look at gameplay frames
        const gameplay = samples.slice(gameplayStartIdx);
        if (gameplay.length < 3) return [];

        const motions = gameplay.map(s => s.batterMotion);

        // Compute adaptive threshold: mean + 1.5 * stddev of batter motion
        const mean = motions.reduce((a, b) => a + b, 0) / motions.length;
        const variance = motions.reduce((a, b) => a + (b - mean) ** 2, 0) / motions.length;
        const stddev = Math.sqrt(variance);
        const threshold = Math.max(mean + 1.5 * stddev, mean * 2, 0.012);

        // Find peaks above threshold
        const peaks = [];
        for (let i = 1; i < motions.length - 1; i++) {
            if (motions[i] > threshold && motions[i] >= motions[i - 1] && motions[i] >= motions[i + 1]) {
                peaks.push({
                    idx: i + gameplayStartIdx, // map back to original index
                    motion: motions[i],
                    time: gameplay[i].time,
                });
            }
        }

        // Also check for above-threshold even if not a local max (plateaus)
        if (peaks.length === 0) {
            let maxI = 0;
            let maxM = 0;
            for (let i = 0; i < motions.length; i++) {
                if (motions[i] > maxM) {
                    maxM = motions[i];
                    maxI = i;
                }
            }
            if (maxM > 0) {
                peaks.push({
                    idx: maxI + gameplayStartIdx,
                    motion: maxM,
                    time: gameplay[maxI].time,
                });
            }
        }

        // Merge peaks that are too close together (part of the same swing)
        const merged = [];
        for (const peak of peaks) {
            if (merged.length > 0) {
                const last = merged[merged.length - 1];
                if (peak.time - last.time < minGapSeconds) {
                    if (peak.motion > last.motion) {
                        merged[merged.length - 1] = peak;
                    }
                    continue;
                }
            }
            merged.push(peak);
        }

        // Build swing events with context window
        const events = merged.map(peak => {
            const windowBefore = 1.2;
            const windowAfter = 1.2;
            const startTime = Math.max(peak.time - windowBefore, samples[gameplayStartIdx].time);
            const endTime = Math.min(peak.time + windowAfter, samples[samples.length - 1].time);

            const sampleIndices = [];
            for (let i = 0; i < samples.length; i++) {
                if (samples[i].time >= startTime && samples[i].time <= endTime) {
                    sampleIndices.push(i);
                }
            }

            return {
                peakTime: peak.time,
                peakMotion: peak.motion,
                startTime,
                endTime,
                sampleIndices,
                peakIdx: peak.idx,
            };
        });

        return events;
    }

    // ---- Full Motion Between Two Canvases ----

    function motionBetween(canvasA, canvasB) {
        const w = canvasA.width;
        const h = canvasA.height;
        const ctxA = canvasA.getContext('2d');
        const ctxB = canvasB.getContext('2d');
        const dataA = ctxA.getImageData(0, 0, w, h).data;
        const dataB = ctxB.getImageData(0, 0, w, h).data;

        let diff = 0;
        const step = 16;
        for (let i = 0; i < dataA.length; i += 4 * step) {
            diff += Math.abs(dataA[i] - dataB[i]);
            diff += Math.abs(dataA[i + 1] - dataB[i + 1]);
            diff += Math.abs(dataA[i + 2] - dataB[i + 2]);
        }
        const totalPixels = (dataA.length / 4) / step;
        return diff / (totalPixels * 3 * 255);
    }

    // ---- Extract Detailed Frames Around a Swing Event ----

    async function extractSwingFrames(videoEl, event, numFrames) {
        const frames = [];
        const step = (event.endTime - event.startTime) / (numFrames - 1);

        for (let i = 0; i < numFrames; i++) {
            const t = event.startTime + step * i;
            const frame = await extractFrameAt(videoEl, t);
            frames.push(frame);
        }
        return frames;
    }

    // ---- Phase Detection (works on extracted swing frames) ----

    function detectPhases(motionScores, regionScores, outcome) {
        const n = motionScores.length;
        const phases = new Array(n).fill(0);

        let maxMotion = 0;
        let peakIdx = 0;
        for (let i = 0; i < n; i++) {
            if (motionScores[i] > maxMotion) {
                maxMotion = motionScores[i];
                peakIdx = i;
            }
        }

        const threshold = maxMotion * 0.15;
        let motionStart = 0;
        for (let i = 0; i < peakIdx; i++) {
            if (motionScores[i] > threshold) {
                motionStart = i;
                break;
            }
        }

        let loadEnd, strideEnd, swingEnd, contactEnd;
        const isNoSwing = outcome === 'ball' || outcome === 'walk';

        if (isNoSwing) {
            loadEnd = motionStart + Math.floor((peakIdx - motionStart) * 0.5);
            strideEnd = peakIdx;
            swingEnd = peakIdx;
            contactEnd = peakIdx;
        } else {
            loadEnd = motionStart + Math.floor((peakIdx - motionStart) * 0.3);
            strideEnd = motionStart + Math.floor((peakIdx - motionStart) * 0.6);
            swingEnd = peakIdx;
            contactEnd = Math.min(peakIdx + Math.floor((n - peakIdx) * 0.25), n - 1);
        }

        for (let i = 0; i < n; i++) {
            if (i < motionStart) phases[i] = 0;
            else if (i < loadEnd) phases[i] = 1;
            else if (i < strideEnd) phases[i] = 2;
            else if (i < swingEnd) phases[i] = 3;
            else if (i <= contactEnd) phases[i] = 4;
            else phases[i] = 5;
        }

        return { phases, peakIdx, motionStart, loadEnd, strideEnd, swingEnd, contactEnd, outcome };
    }

    // ---- Metric Computation ----

    function computeMetrics(frames, motionScores, regionScores, phaseData, config) {
        const { phases, peakIdx, motionStart } = phaseData;
        const benchmarks = AGE_BENCHMARKS[config.ageGroup] || AGE_BENCHMARKS['12u'];
        const duration = frames[frames.length - 1].time - frames[0].time;
        const frameDuration = duration / Math.max(frames.length, 1);

        const swingFrames = Math.max(peakIdx - motionStart, 1);
        const swingTime = swingFrames * frameDuration;

        const upperMotions = regionScores.map(r => r.upper || 0);
        const maxBatSpeed = Math.max(...upperMotions);

        const hipMotions = regionScores
            .map((r, i) => phases[i] === 3 ? (r.lower || 0) : 0)
            .filter(v => v > 0);
        const avgHipRotation = hipMotions.length > 0
            ? hipMotions.reduce((a, b) => a + b, 0) / hipMotions.length
            : 0;

        const leftMotions = regionScores.map(r => r.left || 0);
        const rightMotions = regionScores.map(r => r.right || 0);
        const leftTotal = leftMotions.reduce((a, b) => a + b, 0);
        const rightTotal = rightMotions.reduce((a, b) => a + b, 0);
        const weightTransfer = Math.abs(leftTotal - rightTotal) / Math.max(leftTotal + rightTotal, 0.001);

        const swingMotions = motionScores.slice(motionStart, peakIdx + 1);
        const meanSwing = swingMotions.length > 0
            ? swingMotions.reduce((a, b) => a + b, 0) / swingMotions.length
            : 0;
        const swingVariance = swingMotions.length > 0
            ? swingMotions.reduce((a, b) => a + (b - meanSwing) ** 2, 0) / swingMotions.length
            : 0;
        const smoothness = meanSwing > 0
            ? 1 - Math.min(Math.sqrt(swingVariance) / meanSwing, 1)
            : 0.5;

        const swingUpperAvg = regionScores
            .slice(motionStart, peakIdx + 1)
            .reduce((a, r) => a + (r.upper || 0), 0) / swingFrames;
        const swingLowerAvg = regionScores
            .slice(motionStart, peakIdx + 1)
            .reduce((a, r) => a + (r.lower || 0), 0) / swingFrames;
        const levelSwing = 1 - Math.abs(swingUpperAvg - swingLowerAvg) / Math.max(swingUpperAvg, swingLowerAvg, 0.001);

        const headStability = Math.max(0, 1 - (swingUpperAvg * 2));

        const followMotions = motionScores.slice(peakIdx + 1);
        const followThrough = followMotions.length > 0
            ? followMotions.reduce((a, b) => a + b, 0) / followMotions.length
            : 0;

        return {
            swingTime: {
                value: swingTime.toFixed(2) + 's',
                raw: swingTime,
                name: 'Swing Time',
                rating: rateMetric(swingTime, benchmarks.swingTime, true),
            },
            batSpeed: {
                value: Math.round(maxBatSpeed * 100),
                raw: maxBatSpeed,
                name: 'Bat Speed (relative)',
                rating: rateValue(maxBatSpeed, [0.02, 0.05, 0.08]),
            },
            hipRotation: {
                value: Math.round(avgHipRotation * 1000) + '',
                raw: avgHipRotation,
                name: 'Hip Rotation',
                rating: rateValue(avgHipRotation, [0.01, 0.03, 0.05]),
            },
            weightTransfer: {
                value: Math.round(weightTransfer * 100) + '%',
                raw: weightTransfer,
                name: 'Weight Transfer',
                rating: rateValue(weightTransfer, [0.05, 0.15, 0.25]),
            },
            smoothness: {
                value: Math.round(smoothness * 100) + '%',
                raw: smoothness,
                name: 'Swing Smoothness',
                rating: rateValue(smoothness, [0.4, 0.6, 0.8]),
            },
            levelSwing: {
                value: Math.round(levelSwing * 100) + '%',
                raw: levelSwing,
                name: 'Level Swing Path',
                rating: rateValue(levelSwing, [0.4, 0.6, 0.8]),
            },
            headStability: {
                value: Math.round(headStability * 100) + '%',
                raw: headStability,
                name: 'Head Stability',
                rating: rateValue(headStability, [0.3, 0.5, 0.7]),
            },
            followThrough: {
                value: Math.round(followThrough * 1000) + '',
                raw: followThrough,
                name: 'Follow-Through',
                rating: rateValue(followThrough, [0.01, 0.02, 0.04]),
            },
        };
    }

    function rateMetric(value, [low, high], lowerIsBetter = false) {
        if (lowerIsBetter) {
            if (value <= low) return 'excellent';
            if (value <= high) return 'good';
            if (value <= high * 1.3) return 'fair';
            return 'poor';
        }
        if (value >= high) return 'excellent';
        if (value >= low) return 'good';
        if (value >= low * 0.7) return 'fair';
        return 'poor';
    }

    function rateValue(value, [poor, fair, good]) {
        if (value >= good) return 'excellent';
        if (value >= fair) return 'good';
        if (value >= poor) return 'fair';
        return 'poor';
    }

    function ratingToNum(rating) {
        return { excellent: 4, good: 3, fair: 2, poor: 1 }[rating] || 2;
    }

    // ---- Phase Evaluation ----

    function evaluatePhases(frames, motionScores, regionScores, phaseData, metrics, config) {
        const { phases, peakIdx, motionStart, loadEnd, strideEnd } = phaseData;
        const outcome = config.outcome || 'hit';
        const isNoSwing = outcome === 'ball' || outcome === 'walk';
        const evaluations = [];

        const stanceMotions = motionScores.slice(0, Math.max(motionStart, 1));
        const stanceStill = stanceMotions.reduce((a, b) => a + b, 0) / Math.max(stanceMotions.length, 1);
        const stanceScore = Math.round(Math.max(0, (1 - stanceStill * 20)) * 100);
        evaluations.push({
            phase: PHASES[0],
            score: Math.min(100, stanceScore),
            observations: buildStanceObs(stanceStill, stanceScore),
        });

        const loadRegions = regionScores.slice(motionStart, Math.max(loadEnd, motionStart + 1));
        const loadUpperAvg = loadRegions.reduce((a, r) => a + (r.upper || 0), 0) / Math.max(loadRegions.length, 1);
        const loadScore = Math.round(Math.min(100, 40 + loadUpperAvg * 800));
        evaluations.push({
            phase: PHASES[1],
            score: loadScore,
            observations: buildLoadObs(loadUpperAvg, loadScore),
        });

        const strideRegions = regionScores.slice(loadEnd, Math.max(strideEnd, loadEnd + 1));
        const strideLowerAvg = strideRegions.reduce((a, r) => a + (r.lower || 0), 0) / Math.max(strideRegions.length, 1);
        const strideScore = Math.round(Math.min(100, 40 + strideLowerAvg * 600));
        evaluations.push({
            phase: PHASES[2],
            score: strideScore,
            observations: buildStrideObs(strideLowerAvg, strideScore),
        });

        const swingScore = Math.round(
            (ratingToNum(metrics.batSpeed.rating) * 0.3 +
             ratingToNum(metrics.smoothness.rating) * 0.3 +
             ratingToNum(metrics.levelSwing.rating) * 0.4) * 25
        );
        evaluations.push({
            phase: PHASES[3],
            score: swingScore,
            observations: buildSwingObs(metrics, swingScore),
        });

        const outcomeInfo = OUTCOMES[outcome] || OUTCOMES.hit;
        const contactPhase = { ...PHASES[4], name: outcomeInfo.contactPhase };

        if (isNoSwing) {
            const discScore = Math.round(
                (ratingToNum(metrics.headStability.rating) * 0.5 +
                 ratingToNum(metrics.smoothness.rating) * 0.5) * 25
            );
            evaluations.push({
                phase: contactPhase,
                score: discScore,
                observations: { good: ['Good plate discipline'], improve: [] },
            });
        } else {
            const contactScore = Math.round(
                (ratingToNum(metrics.batSpeed.rating) * 0.4 +
                 ratingToNum(metrics.levelSwing.rating) * 0.3 +
                 ratingToNum(metrics.headStability.rating) * 0.3) * 25
            );
            evaluations.push({
                phase: contactPhase,
                score: contactScore,
                observations: buildContactObs(metrics, contactScore, outcome),
            });
        }

        const ftScore = Math.round(
            (ratingToNum(metrics.followThrough.rating) * 0.5 +
             ratingToNum(metrics.hipRotation.rating) * 0.5) * 25
        );
        evaluations.push({
            phase: PHASES[5],
            score: ftScore,
            observations: buildFollowObs(metrics, ftScore),
        });

        return evaluations;
    }

    // ---- Observation Builders ----

    function buildStanceObs(stillness, score) {
        const good = [], improve = [];
        if (score >= 70) good.push('Good pre-swing stillness — balanced and ready');
        else improve.push('Too much movement before the pitch — focus on being still and balanced');
        if (score >= 80) good.push('Solid athletic base');
        if (score < 50) {
            improve.push('Keep weight evenly distributed on balls of feet');
            improve.push('Hands should be near back shoulder, bat at roughly 45 degrees');
        }
        return { good, improve };
    }

    function buildLoadObs(upperMotion, score) {
        const good = [], improve = [];
        if (score >= 70) good.push('Good loading action — hands and weight shift back');
        else if (score >= 50) {
            good.push('Some loading motion present');
            improve.push('Try a more deliberate load: shift weight to back foot, hands back');
        } else {
            improve.push('Minimal load detected — the load creates power for the swing');
        }
        if (upperMotion > 0.06) improve.push('Load may be too big — keep it compact');
        return { good, improve };
    }

    function buildStrideObs(lowerMotion, score) {
        const good = [], improve = [];
        if (score >= 70) good.push('Good stride toward the pitcher');
        else if (score >= 50) {
            good.push('Stride is present but could be more controlled');
            improve.push('Stride should be short and soft');
        } else {
            improve.push('Stride needs work — short, controlled step toward pitcher');
        }
        if (lowerMotion > 0.08) improve.push('Stride may be too long');
        return { good, improve };
    }

    function buildSwingObs(metrics, score) {
        const good = [], improve = [];
        if (metrics.batSpeed.rating === 'excellent' || metrics.batSpeed.rating === 'good')
            good.push('Good bat speed through the zone');
        else improve.push('Work on generating more bat speed — start with the hips');
        if (metrics.levelSwing.rating === 'excellent' || metrics.levelSwing.rating === 'good')
            good.push('Level swing path through the hitting zone');
        else improve.push('Swing path could be more level');
        if (metrics.smoothness.rating === 'excellent' || metrics.smoothness.rating === 'good')
            good.push('Smooth, fluid swing mechanics');
        else improve.push('Swing could be smoother');
        if (metrics.hipRotation.rating === 'excellent') good.push('Strong hip rotation');
        else if (metrics.hipRotation.rating === 'poor') improve.push('More hip rotation needed — "squish the bug"');
        return { good, improve };
    }

    function buildContactObs(metrics, score, outcome) {
        const good = [], improve = [];
        if (metrics.headStability.rating === 'excellent' || metrics.headStability.rating === 'good')
            good.push('Good head stability — eyes on the ball');
        else improve.push('Head moving too much — keep eyes on the ball');

        if (outcome === 'miss' || outcome === 'strikeout') {
            improve.push('Swing and miss — check timing and eye tracking');
            if (metrics.levelSwing.rating === 'poor' || metrics.levelSwing.rating === 'fair')
                improve.push('A more level swing stays in the zone longer');
        } else if (outcome === 'foul') {
            improve.push('Foul ball — close to solid contact, check timing');
        } else if (outcome === 'out') {
            if (score >= 60) good.push('Made contact — check pitch selection and placement');
            else improve.push('Work on making harder contact');
        } else {
            if (score >= 70) good.push('Solid contact out front with arms extended');
            else improve.push('Work on contacting the ball out in front');
        }
        return { good, improve };
    }

    function buildFollowObs(metrics, score) {
        const good = [], improve = [];
        if (metrics.followThrough.rating === 'excellent' || metrics.followThrough.rating === 'good')
            good.push('Full follow-through');
        else {
            improve.push('Follow-through is short — let the bat finish its path');
            improve.push('Swing through the ball, not at it');
        }
        if (score >= 70) good.push('Good weight transfer to front side');
        else improve.push('Transfer weight fully to front foot after contact');
        return { good, improve };
    }

    // ---- Overall Score ----

    function computeOverallScore(metrics, phaseEvals) {
        const metricWeights = {
            batSpeed: 0.15, swingTime: 0.10, hipRotation: 0.10, weightTransfer: 0.10,
            smoothness: 0.15, levelSwing: 0.15, headStability: 0.15, followThrough: 0.10,
        };
        let metricScore = 0;
        for (const [key, weight] of Object.entries(metricWeights)) {
            if (metrics[key]) metricScore += ratingToNum(metrics[key].rating) * 25 * weight;
        }
        const phaseAvg = phaseEvals.reduce((a, e) => a + e.score, 0) / phaseEvals.length;
        return Math.round(metricScore * 0.5 + phaseAvg * 0.5);
    }

    // ---- Coaching Tips ----

    function generateCoachingTips(metrics, phaseEvals, config) {
        const tips = [];
        const outcome = config.outcome || 'hit';

        if (outcome === 'miss' || outcome === 'strikeout') {
            tips.push({ priority: 'high', icon: '👀', title: 'Track the Ball',
                detail: 'On a miss, the most common cause is losing the ball. Practice "see the ball hit the bat." Soft toss and tee work build this habit.' });
        } else if (outcome === 'foul') {
            tips.push({ priority: 'medium', icon: '🔧', title: 'Timing Adjustment',
                detail: 'A foul ball means timing or bat angle is slightly off. Fouling pull-side = early, opposite-field = late.' });
        } else if (outcome === 'ball' || outcome === 'walk') {
            tips.push({ priority: 'low', icon: '👏', title: 'Good Pitch Recognition',
                detail: 'Taking a ball shows discipline. Continue developing the ability to read ball vs. strike out of the hand.' });
        }

        if (metrics.hipRotation.rating === 'poor' || metrics.hipRotation.rating === 'fair')
            tips.push({ priority: 'high', icon: '🔄', title: 'Improve Hip Rotation',
                detail: 'Power comes from the ground up through the hips. "Squish the bug" — rotate the back foot as hips fire open.' });
        if (metrics.batSpeed.rating === 'poor' || metrics.batSpeed.rating === 'fair')
            tips.push({ priority: 'high', icon: '⚡', title: 'Increase Bat Speed',
                detail: 'Start with explosive hip rotation. Keep hands inside the ball, take a direct path to contact.' });
        if (metrics.levelSwing.rating === 'poor' || metrics.levelSwing.rating === 'fair')
            tips.push({ priority: 'high', icon: '📐', title: 'Level Your Swing Path',
                detail: 'Swing through a "tunnel" — keep the bat in the hitting zone as long as possible.' });
        if (metrics.headStability.rating === 'poor' || metrics.headStability.rating === 'fair')
            tips.push({ priority: 'medium', icon: '👁', title: 'Keep Head Still',
                detail: 'Head movement makes it harder to track the ball. Keep chin tucked, eyes level.' });
        if (metrics.smoothness.rating === 'poor' || metrics.smoothness.rating === 'fair')
            tips.push({ priority: 'medium', icon: '🌊', title: 'Smooth Out Your Swing',
                detail: 'The swing should be one connected motion. Start relaxed, let load flow into stride into swing.' });
        if (metrics.followThrough.rating === 'poor' || metrics.followThrough.rating === 'fair')
            tips.push({ priority: 'medium', icon: '🏌', title: 'Complete Follow-Through',
                detail: 'A short follow-through means deceleration before contact. Bat should finish over front shoulder.' });

        if (['8u', '10u'].includes(config.ageGroup))
            tips.push({ priority: 'low', icon: '⭐', title: 'Keep Having Fun!',
                detail: 'Focus on one improvement at a time. Mechanics improve naturally with repetition and love of the game.' });

        return tips;
    }

    // ---- Drills ----

    function generateDrills(metrics, phaseEvals, config) {
        const drills = [];

        if (metrics.hipRotation.rating !== 'excellent')
            drills.push({ name: 'Fence Drill', purpose: 'Teaches hip rotation and hand path',
                steps: ['Stand 6 inches from a fence', 'Take dry swings — don\'t hit the fence', 'Fire hips first, keep hands inside', '3 sets of 10'] });
        if (metrics.batSpeed.rating !== 'excellent')
            drills.push({ name: 'Overload/Underload Training', purpose: 'Builds bat speed',
                steps: ['10 swings with a heavier bat', 'Switch to game bat for 10 swings', 'Repeat 3 rounds', 'Rest 1-2 min between rounds'] });
        if (metrics.levelSwing.rating !== 'excellent')
            drills.push({ name: 'High/Low Tee Drill', purpose: 'Consistent swing path at all heights',
                steps: ['Hit 10 at belt height', 'Hit 10 at low zone', 'Hit 10 at high zone', 'Adjust with legs, not swing plane'] });
        if (metrics.headStability.rating !== 'excellent')
            drills.push({ name: 'Balance Beam Tee', purpose: 'Head stability and balance',
                steps: ['Stand on a 2x4 board in batting stance', 'Hit off tee while balanced', 'If you fall off, too much movement', '3 sets of 10'] });

        drills.push({ name: 'Front Toss / Soft Toss', purpose: 'Timing and contact',
            steps: ['Partner tosses into strike zone from the side', 'Focus on solid contact up the middle', '3 rounds of 15 swings'] });

        return drills;
    }

    // ---- Frame Annotation ----

    function annotateFrame(canvas, phaseIdx, phaseName, phaseColor, motionScore, outcome, pitchNum) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;

        const scale = Math.max(w / 640, 1);
        const labelFontSize = Math.round(18 * scale);
        const numberFontSize = Math.round(28 * scale);
        const smallFontSize = Math.round(12 * scale);
        const pad = Math.round(10 * scale);

        // Draw the tight batter zone outline
        const zoneX = Math.floor(w * 0.25);
        const zoneW = Math.floor(w * 0.40);
        const zoneY = Math.floor(h * 0.50);
        const zoneH = Math.floor(h * 0.42);
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(zoneX, zoneY, zoneW, zoneH);
        ctx.setLineDash([]);

        // Phase badge (numbered circle)
        const badgeR = Math.round(22 * scale);
        const bx = pad + badgeR;
        const by = pad + badgeR;
        ctx.beginPath();
        ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = phaseColor;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.fillStyle = 'white';
        ctx.font = `bold ${numberFontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(phaseIdx + 1), bx, by);

        // Phase label
        ctx.font = `bold ${labelFontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const labelX = bx + badgeR + pad;
        const labelY = pad;
        const tm = ctx.measureText(phaseName);
        const lPad = Math.round(8 * scale);
        const lH = labelFontSize + lPad * 2;
        const lW = tm.width + lPad * 2;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(labelX, labelY, lW, lH);
        ctx.fillStyle = phaseColor;
        ctx.fillRect(labelX, labelY, Math.round(4 * scale), lH);
        ctx.fillStyle = 'white';
        ctx.fillText(phaseName, labelX + lPad, labelY + lPad);

        // Pitch number (if multi-pitch)
        if (pitchNum !== undefined) {
            const pitchLabel = `Pitch ${pitchNum}`;
            ctx.font = `bold ${smallFontSize}px sans-serif`;
            ctx.textAlign = 'right';
            const pw = ctx.measureText(pitchLabel).width + lPad * 2;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
            ctx.fillRect(w - pad - pw, pad, pw, smallFontSize + lPad * 2);
            ctx.fillStyle = '#fbbf24';
            ctx.fillText(pitchLabel, w - pad - lPad, pad + lPad + smallFontSize * 0.8);
        }

        // Motion bar at bottom
        const barH = Math.round(20 * scale);
        const mBarW = Math.min(motionScore * w * 5, w - pad * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(pad, h - barH - pad, w - pad * 2, barH);
        ctx.fillStyle = phaseColor;
        ctx.fillRect(pad, h - barH - pad, mBarW, barH);
        ctx.fillStyle = 'white';
        ctx.font = `${smallFontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('Batter Motion: ' + (motionScore * 100).toFixed(1), pad + 5, h - barH / 2 - pad);

        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
    }

    // ---- Main Analysis Pipeline ----

    async function analyze(videoEl, config, onProgress) {
        onProgress(0, 'Scanning video for swing events...');

        const duration = videoEl.duration;
        const sampleInterval = duration > 10 ? 0.3 : 0.15;

        // Step 1: Scan the entire video for motion + brightness
        const samples = await scanVideoMotion(videoEl, sampleInterval, (p) => {
            onProgress(p * 0.3, 'Scanning video for swing events...');
        });

        onProgress(0.3, 'Detecting title card...');

        // Step 2: Detect and skip GameChanger title card
        const gameplayStartIdx = detectTitleCardEnd(samples);
        const gameplayStartTime = samples[gameplayStartIdx] ? samples[gameplayStartIdx].time : 0;

        onProgress(0.32, gameplayStartIdx > 0
            ? `Skipped title card (${gameplayStartTime.toFixed(1)}s). Detecting pitch events...`
            : 'No title card detected. Detecting pitch events...');

        // Step 3: Find swing/pitch events (only in gameplay frames)
        const minGapBetweenPitches = 2.0;
        const events = detectSwingEvents(samples, minGapBetweenPitches, gameplayStartIdx);

        if (events.length === 0) {
            // Fallback: use the highest-motion gameplay frame
            const gameplay = samples.slice(gameplayStartIdx);
            if (gameplay.length > 0) {
                const sorted = [...gameplay].sort((a, b) => b.batterMotion - a.batterMotion);
                const peakTime = sorted[0].time;
                events.push({
                    peakTime,
                    peakMotion: sorted[0].batterMotion,
                    startTime: Math.max(peakTime - 1.5, gameplayStartTime),
                    endTime: Math.min(peakTime + 1.5, duration),
                    peakIdx: samples.indexOf(sorted[0]),
                    sampleIndices: [],
                });
            }
        }

        onProgress(0.35, `Found ${events.length} pitch event(s). Analyzing...`);

        // Step 4: Analyze each swing event
        const pitchResults = [];

        for (let e = 0; e < events.length; e++) {
            const event = events[e];
            const pitchNum = e + 1;
            const pctBase = 0.35 + (e / events.length) * 0.55;
            const pctEach = 0.55 / events.length;

            onProgress(pctBase, `Analyzing pitch ${pitchNum} of ${events.length}...`);

            const frames = await extractSwingFrames(videoEl, event, 16);

            const motionScores = [0];
            const regionScores = [{ upper: 0, lower: 0, left: 0, right: 0 }];

            for (let i = 1; i < frames.length; i++) {
                motionScores.push(batterZoneMotion(frames[i - 1].canvas, frames[i].canvas));
                regionScores.push(batterRegionMotion(frames[i - 1].canvas, frames[i].canvas));
            }

            const isLastPitch = (e === events.length - 1);
            const pitchOutcome = isLastPitch ? (config.outcome || 'hit') : 'ball';

            const phaseData = detectPhases(motionScores, regionScores, pitchOutcome);
            const metrics = computeMetrics(frames, motionScores, regionScores, phaseData, config);
            const phaseEvals = evaluatePhases(frames, motionScores, regionScores, phaseData, metrics,
                { ...config, outcome: pitchOutcome });
            const overallScore = computeOverallScore(metrics, phaseEvals);
            const coachingTips = isLastPitch
                ? generateCoachingTips(metrics, phaseEvals, { ...config, outcome: pitchOutcome })
                : [];
            const drills = isLastPitch ? generateDrills(metrics, phaseEvals, config) : [];

            const keyIndices = [
                0,
                phaseData.motionStart,
                Math.min(phaseData.loadEnd, frames.length - 1),
                Math.min(phaseData.strideEnd, frames.length - 1),
                Math.min(phaseData.peakIdx, frames.length - 1),
                Math.min(phaseData.contactEnd + 1, frames.length - 1),
            ];
            const uniqueIndices = [...new Set(keyIndices)].sort((a, b) => a - b);

            const outcomeInfo = OUTCOMES[pitchOutcome] || OUTCOMES.hit;
            const annotatedFrames = uniqueIndices.map(idx => {
                const frame = frames[idx];
                const ac = document.createElement('canvas');
                ac.width = frame.canvas.width;
                ac.height = frame.canvas.height;
                const ctx = ac.getContext('2d');
                ctx.drawImage(frame.canvas, 0, 0);

                const pi = phaseData.phases[idx];
                let phaseName = PHASES[pi].name;
                if (pi === 4) phaseName = outcomeInfo.contactPhase;
                const phaseColor = PHASES[pi].color;
                const motion = motionScores[idx] || 0;

                annotateFrame(ac, pi, phaseName, phaseColor, motion, pitchOutcome,
                    events.length > 1 ? pitchNum : undefined);

                return {
                    canvas: ac,
                    time: frame.time,
                    phase: { ...PHASES[pi], name: phaseName },
                    frameIdx: idx,
                };
            });

            onProgress(pctBase + pctEach, `Pitch ${pitchNum} analyzed.`);

            pitchResults.push({
                pitchNum,
                outcome: pitchOutcome,
                outcomeLabel: outcomeInfo.label,
                peakTime: event.peakTime,
                overallScore,
                metrics,
                phaseEvals,
                coachingTips,
                drills,
                annotatedFrames,
                motionScores,
                regionScores,
                phaseData,
                frames,
            });
        }

        onProgress(0.95, 'Finalizing...');

        const mainResult = pitchResults[pitchResults.length - 1];

        onProgress(1.0, 'Analysis complete!');

        return {
            overallScore: mainResult.overallScore,
            metrics: mainResult.metrics,
            phaseEvals: mainResult.phaseEvals,
            coachingTips: mainResult.coachingTips,
            drills: mainResult.drills,
            annotatedFrames: mainResult.annotatedFrames,
            motionScores: mainResult.motionScores,
            regionScores: mainResult.regionScores,
            phaseData: mainResult.phaseData,
            frames: mainResult.frames,
            pitchResults,
            pitchCount: pitchResults.length,
            gameplayStartTime,
            titleCardSkipped: gameplayStartIdx > 0,
        };
    }

    // ---- Public API ----
    return {
        analyze,
        parseFilename,
        PHASES,
        OUTCOMES,
    };

})();
