/**
 * Softball Swing Analysis Engine
 *
 * Extracts frames from uploaded video, performs motion analysis by tracking
 * brightness/movement across regions, and evaluates swing mechanics against
 * proper softball hitting fundamentals for each swing phase.
 */

const SwingAnalyzer = (() => {

    // ---- Swing Phase Definitions ----
    // Contact phase name is overridden at runtime based on swing outcome
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
        hit:  { label: 'Hit',          contactPhase: 'Contact' },
        miss: { label: 'Swing & Miss', contactPhase: 'Swing-Through' },
        foul: { label: 'Foul Ball',    contactPhase: 'Foul Contact' },
        ball: { label: 'Ball (Took)',  contactPhase: 'Check Swing / Hold' },
    };

    // ---- Age-group specific ideal metrics ----
    const AGE_BENCHMARKS = {
        '8u':      { swingTime: [0.6, 0.9],  batAngle: [30, 50], strideLength: [0.3, 0.5], hipRotation: [30, 50] },
        '10u':     { swingTime: [0.5, 0.8],  batAngle: [25, 45], strideLength: [0.35, 0.55], hipRotation: [35, 55] },
        '12u':     { swingTime: [0.4, 0.7],  batAngle: [20, 45], strideLength: [0.4, 0.6], hipRotation: [40, 60] },
        '14u':     { swingTime: [0.35, 0.6], batAngle: [15, 40], strideLength: [0.4, 0.65], hipRotation: [45, 65] },
        '16u':     { swingTime: [0.3, 0.55], batAngle: [10, 35], strideLength: [0.45, 0.7], hipRotation: [50, 70] },
        'college': { swingTime: [0.25, 0.5], batAngle: [10, 30], strideLength: [0.5, 0.75], hipRotation: [55, 75] },
    };

    // ---- Frame Extraction ----

    /**
     * Extract evenly-spaced frames from a video element.
     * Returns an array of { canvas, time } objects.
     */
    function extractFrames(videoEl, numFrames = 24, onProgress) {
        return new Promise((resolve, reject) => {
            const duration = videoEl.duration;
            if (!duration || duration === Infinity) {
                reject(new Error('Cannot determine video duration'));
                return;
            }

            const frames = [];
            const times = [];
            // Skip first and last 5% to avoid black/slate frames
            const start = duration * 0.05;
            const end = duration * 0.95;
            const step = (end - start) / (numFrames - 1);

            for (let i = 0; i < numFrames; i++) {
                times.push(start + step * i);
            }

            let idx = 0;

            function seekNext() {
                if (idx >= times.length) {
                    resolve(frames);
                    return;
                }
                videoEl.currentTime = times[idx];
            }

            videoEl.onseeked = () => {
                const canvas = document.createElement('canvas');
                canvas.width = videoEl.videoWidth;
                canvas.height = videoEl.videoHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

                frames.push({ canvas, time: times[idx] });
                idx++;
                if (onProgress) {
                    onProgress(idx / times.length, 'Extracting frames...');
                }
                // Small delay to allow UI update
                requestAnimationFrame(seekNext);
            };

            videoEl.onerror = () => reject(new Error('Error seeking video'));
            seekNext();
        });
    }

    // ---- Motion Analysis ----

    /**
     * Compute overall pixel-difference "motion score" between two canvases.
     */
    function motionBetween(canvasA, canvasB) {
        const w = canvasA.width;
        const h = canvasA.height;
        const ctxA = canvasA.getContext('2d');
        const ctxB = canvasB.getContext('2d');
        const dataA = ctxA.getImageData(0, 0, w, h).data;
        const dataB = ctxB.getImageData(0, 0, w, h).data;

        let diff = 0;
        const step = 16; // Sample every 16th pixel for speed
        for (let i = 0; i < dataA.length; i += 4 * step) {
            diff += Math.abs(dataA[i] - dataB[i]);       // R
            diff += Math.abs(dataA[i + 1] - dataB[i + 1]); // G
            diff += Math.abs(dataA[i + 2] - dataB[i + 2]); // B
        }
        const totalPixels = (dataA.length / 4) / step;
        return diff / (totalPixels * 3 * 255); // Normalize 0-1
    }

    /**
     * Compute motion scores in specific regions of the frame.
     * Regions: upper (bat/hands), middle (torso/hips), lower (legs/feet)
     */
    function regionMotion(canvasA, canvasB) {
        const w = canvasA.width;
        const h = canvasA.height;
        const ctxA = canvasA.getContext('2d');
        const ctxB = canvasB.getContext('2d');

        const regions = {
            upper: { y1: 0, y2: Math.floor(h * 0.33) },
            middle: { y1: Math.floor(h * 0.33), y2: Math.floor(h * 0.66) },
            lower: { y1: Math.floor(h * 0.66), y2: h },
        };

        const result = {};

        for (const [name, { y1, y2 }] of Object.entries(regions)) {
            const regionH = y2 - y1;
            const dataA = ctxA.getImageData(0, y1, w, regionH).data;
            const dataB = ctxB.getImageData(0, y1, w, regionH).data;

            let diff = 0;
            const step = 12;
            for (let i = 0; i < dataA.length; i += 4 * step) {
                diff += Math.abs(dataA[i] - dataB[i]);
                diff += Math.abs(dataA[i + 1] - dataB[i + 1]);
                diff += Math.abs(dataA[i + 2] - dataB[i + 2]);
            }
            const totalPx = (dataA.length / 4) / step;
            result[name] = diff / (totalPx * 3 * 255);
        }

        return result;
    }

    /**
     * Analyze horizontal center-of-mass shift (approximate weight transfer).
     */
    function horizontalShift(canvasA, canvasB) {
        function centerOfBrightness(canvas) {
            const w = canvas.width;
            const h = canvas.height;
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, w, h).data;
            let totalWeight = 0;
            let weightedX = 0;
            const step = 20;
            for (let y = 0; y < h; y += step) {
                for (let x = 0; x < w; x += step) {
                    const i = (y * w + x) * 4;
                    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    // Invert: darker regions (the batter) carry more weight
                    const weight = 255 - brightness;
                    totalWeight += weight;
                    weightedX += weight * x;
                }
            }
            return totalWeight > 0 ? weightedX / totalWeight / w : 0.5;
        }

        const cxA = centerOfBrightness(canvasA);
        const cxB = centerOfBrightness(canvasB);
        return cxB - cxA; // Positive = moved right
    }

    // ---- Phase Detection ----

    /**
     * Given motion scores per frame, classify each frame into a swing phase.
     * outcome: 'hit' | 'miss' | 'foul' | 'ball'
     * For 'ball' (took the pitch), we shorten/skip the swing and contact phases.
     */
    function detectPhases(motionScores, regionScores, outcome) {
        const n = motionScores.length;
        const phases = new Array(n).fill(0);

        // Find the frame with maximum motion (likely contact/swing)
        let maxMotion = 0;
        let peakIdx = 0;
        for (let i = 0; i < n; i++) {
            if (motionScores[i] > maxMotion) {
                maxMotion = motionScores[i];
                peakIdx = i;
            }
        }

        // Find the onset of major motion (load start)
        const threshold = maxMotion * 0.15;
        let motionStart = 0;
        for (let i = 0; i < peakIdx; i++) {
            if (motionScores[i] > threshold) {
                motionStart = i;
                break;
            }
        }

        let loadEnd, strideEnd, swingEnd, contactEnd;

        if (outcome === 'ball') {
            // Ball taken — there's minimal or no swing
            // Mostly stance/load, possibly a small stride or check swing
            loadEnd = motionStart + Math.floor((peakIdx - motionStart) * 0.5);
            strideEnd = peakIdx;
            swingEnd = peakIdx;       // No real swing
            contactEnd = peakIdx;     // No contact
        } else {
            // Hit, miss, or foul — full swing happened
            loadEnd = motionStart + Math.floor((peakIdx - motionStart) * 0.3);
            strideEnd = motionStart + Math.floor((peakIdx - motionStart) * 0.6);
            swingEnd = peakIdx;
            contactEnd = Math.min(peakIdx + Math.floor((n - peakIdx) * 0.25), n - 1);
        }

        for (let i = 0; i < n; i++) {
            if (i < motionStart) phases[i] = 0;        // stance
            else if (i < loadEnd) phases[i] = 1;       // load
            else if (i < strideEnd) phases[i] = 2;     // stride
            else if (i < swingEnd) phases[i] = 3;      // swing
            else if (i <= contactEnd) phases[i] = 4;    // contact / swing-through
            else phases[i] = 5;                         // follow-through
        }

        return { phases, peakIdx, motionStart, loadEnd, strideEnd, swingEnd, contactEnd, outcome };
    }

    // ---- Metric Computation ----

    function computeMetrics(frames, motionScores, regionScores, phaseData, config) {
        const { phases, peakIdx, motionStart } = phaseData;
        const benchmarks = AGE_BENCHMARKS[config.ageGroup] || AGE_BENCHMARKS['12u'];
        const duration = frames[frames.length - 1].time - frames[0].time;
        const frameDuration = duration / frames.length;

        // Swing time: from load start to contact
        const swingFrames = peakIdx - motionStart;
        const swingTime = swingFrames * frameDuration;

        // Bat speed proxy: max upper-region motion
        const upperMotions = regionScores.map(r => r.upper);
        const maxBatSpeed = Math.max(...upperMotions);

        // Hip rotation proxy: middle-region motion during swing phase
        const hipMotions = regionScores
            .map((r, i) => phases[i] === 3 ? r.middle : 0)
            .filter(v => v > 0);
        const avgHipRotation = hipMotions.length > 0
            ? hipMotions.reduce((a, b) => a + b, 0) / hipMotions.length
            : 0;

        // Weight transfer: horizontal shift from stance to contact
        const stanceFrame = frames[0].canvas;
        const contactFrame = frames[peakIdx] ? frames[peakIdx].canvas : frames[frames.length - 1].canvas;
        const weightTransfer = Math.abs(horizontalShift(stanceFrame, contactFrame));

        // Smoothness: standard deviation of motion scores during swing
        const swingMotions = motionScores.slice(motionStart, peakIdx + 1);
        const meanSwing = swingMotions.reduce((a, b) => a + b, 0) / swingMotions.length;
        const swingVariance = swingMotions.reduce((a, b) => a + (b - meanSwing) ** 2, 0) / swingMotions.length;
        const smoothness = 1 - Math.min(Math.sqrt(swingVariance) / meanSwing, 1);

        // Level swing: compare upper vs lower motion during swing
        const swingUpperAvg = regionScores
            .slice(motionStart, peakIdx + 1)
            .reduce((a, r) => a + r.upper, 0) / swingFrames;
        const swingLowerAvg = regionScores
            .slice(motionStart, peakIdx + 1)
            .reduce((a, r) => a + r.lower, 0) / swingFrames;
        const levelSwing = 1 - Math.abs(swingUpperAvg - swingLowerAvg) / Math.max(swingUpperAvg, swingLowerAvg, 0.001);

        // Head stability: motion in top 20% of frame during swing
        // (approximated from upper region)
        const headStability = 1 - (swingUpperAvg * 2); // Less upper motion = more stable head

        // Follow-through completeness: total motion after contact
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
                rating: rateValue(weightTransfer, [0.01, 0.03, 0.06]),
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
                value: Math.round(Math.max(0, headStability) * 100) + '%',
                raw: Math.max(0, headStability),
                name: 'Head Stability',
                rating: rateValue(Math.max(0, headStability), [0.3, 0.5, 0.7]),
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

    // ---- Phase Evaluation ----

    function evaluatePhases(frames, motionScores, regionScores, phaseData, metrics, config) {
        const { phases, peakIdx, motionStart, loadEnd, strideEnd, swingEnd, contactEnd } = phaseData;
        const outcome = config.outcome || 'hit';
        const evaluations = [];

        // Stance
        const stanceMotions = motionScores.slice(0, motionStart);
        const stanceStill = stanceMotions.length > 0
            ? stanceMotions.reduce((a, b) => a + b, 0) / stanceMotions.length
            : 0;
        const stanceScore = Math.round(Math.max(0, (1 - stanceStill * 20)) * 100);
        evaluations.push({
            phase: PHASES[0],
            score: stanceScore,
            observations: buildStanceObservations(stanceStill, stanceScore),
        });

        // Load
        const loadMotions = motionScores.slice(motionStart, loadEnd);
        const loadRegions = regionScores.slice(motionStart, loadEnd);
        const loadUpperAvg = loadRegions.reduce((a, r) => a + r.upper, 0) / Math.max(loadRegions.length, 1);
        const loadScore = Math.round(Math.min(100, 40 + loadUpperAvg * 800));
        evaluations.push({
            phase: PHASES[1],
            score: loadScore,
            observations: buildLoadObservations(loadUpperAvg, loadScore),
        });

        // Stride
        const strideRegions = regionScores.slice(loadEnd, strideEnd);
        const strideLowerAvg = strideRegions.reduce((a, r) => a + r.lower, 0) / Math.max(strideRegions.length, 1);
        const strideScore = Math.round(Math.min(100, 40 + strideLowerAvg * 600));
        evaluations.push({
            phase: PHASES[2],
            score: strideScore,
            observations: buildStrideObservations(strideLowerAvg, strideScore),
        });

        // Swing
        const swingScore = Math.round(
            (ratingToNum(metrics.batSpeed.rating) * 0.3 +
             ratingToNum(metrics.smoothness.rating) * 0.3 +
             ratingToNum(metrics.levelSwing.rating) * 0.4) * 25
        );
        evaluations.push({
            phase: PHASES[3],
            score: swingScore,
            observations: buildSwingObservations(metrics, swingScore),
        });

        // Contact / Swing-Through — adapts based on outcome
        const outcomeInfo = OUTCOMES[outcome] || OUTCOMES.hit;
        const contactPhase = { ...PHASES[4], name: outcomeInfo.contactPhase };

        if (outcome === 'ball') {
            // Ball taken — evaluate discipline instead of contact
            const disciplineScore = Math.round(
                (ratingToNum(metrics.headStability.rating) * 0.5 +
                 ratingToNum(metrics.smoothness.rating) * 0.5) * 25
            );
            evaluations.push({
                phase: contactPhase,
                score: disciplineScore,
                observations: buildBallTakenObservations(metrics, disciplineScore),
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
                observations: buildContactObservations(metrics, contactScore, outcome),
            });
        }

        // Follow-through
        const ftScore = Math.round(
            (ratingToNum(metrics.followThrough.rating) * 0.5 +
             ratingToNum(metrics.hipRotation.rating) * 0.5) * 25
        );
        evaluations.push({
            phase: PHASES[5],
            score: ftScore,
            observations: buildFollowThroughObservations(metrics, ftScore),
        });

        return evaluations;
    }

    function ratingToNum(rating) {
        return { excellent: 4, good: 3, fair: 2, poor: 1 }[rating] || 2;
    }

    // ---- Observation Builders ----

    function buildStanceObservations(stillness, score) {
        const good = [];
        const improve = [];

        if (score >= 70) {
            good.push('Good pre-swing stillness — balanced and ready');
        } else {
            improve.push('Too much movement before the pitch — focus on being still and balanced');
        }

        if (score >= 80) {
            good.push('Appears to have a solid athletic base');
        }

        if (score < 50) {
            improve.push('Work on keeping weight evenly distributed on balls of feet');
            improve.push('Hands should be near the back shoulder, bat at roughly 45 degrees');
        } else if (score < 70) {
            improve.push('Try to relax the upper body while maintaining a ready position');
        }

        return { good, improve };
    }

    function buildLoadObservations(upperMotion, score) {
        const good = [];
        const improve = [];

        if (score >= 70) {
            good.push('Good loading action detected — hands and weight shift back');
        } else if (score >= 50) {
            good.push('Some loading motion present');
            improve.push('Try a more deliberate load: shift weight slightly to back foot, hands back');
        } else {
            improve.push('Minimal load detected — the load creates power for the swing');
            improve.push('Practice "loading the gun": shift hands and weight to back side before swing');
        }

        if (upperMotion > 0.06) {
            improve.push('Load may be too big — keep it compact and controlled');
        }

        return { good, improve };
    }

    function buildStrideObservations(lowerMotion, score) {
        const good = [];
        const improve = [];

        if (score >= 70) {
            good.push('Good stride toward the pitcher — front foot lands softly');
        } else if (score >= 50) {
            good.push('Stride is present but could be more controlled');
            improve.push('Stride should be short and soft — "walk on thin ice"');
        } else {
            improve.push('Stride needs work — should be a short, controlled step toward pitcher');
            improve.push('Landing on the ball of the front foot keeps the hands back and body loaded');
        }

        if (lowerMotion > 0.08) {
            improve.push('Stride may be too long — a shorter stride keeps you balanced');
        }

        return { good, improve };
    }

    function buildSwingObservations(metrics, score) {
        const good = [];
        const improve = [];

        if (metrics.batSpeed.rating === 'excellent' || metrics.batSpeed.rating === 'good') {
            good.push('Good bat speed through the zone');
        } else {
            improve.push('Work on generating more bat speed — start with the hips, not the hands');
        }

        if (metrics.levelSwing.rating === 'excellent' || metrics.levelSwing.rating === 'good') {
            good.push('Swing path is level through the hitting zone');
        } else {
            improve.push('Swing path could be more level — avoid chopping down or uppercutting');
        }

        if (metrics.smoothness.rating === 'excellent' || metrics.smoothness.rating === 'good') {
            good.push('Smooth, fluid swing mechanics');
        } else {
            improve.push('Swing could be smoother — jerky swings lose power and consistency');
        }

        if (metrics.hipRotation.rating === 'poor') {
            improve.push('More hip rotation needed — "squish the bug" with the back foot to drive rotation');
        } else if (metrics.hipRotation.rating === 'excellent') {
            good.push('Strong hip rotation generating power');
        }

        return { good, improve };
    }

    function buildContactObservations(metrics, score, outcome) {
        const good = [];
        const improve = [];

        if (metrics.headStability.rating === 'excellent' || metrics.headStability.rating === 'good') {
            good.push('Good head stability — eyes stay on the ball');
        } else {
            improve.push('Head is moving too much — focus on keeping your head still and eyes on the ball');
        }

        if (outcome === 'miss') {
            improve.push('Swing and miss — the swing mechanics still matter even without contact');
            improve.push('On a miss, check: were eyes tracking the ball all the way? Was timing early or late?');
            if (metrics.levelSwing.rating === 'poor' || metrics.levelSwing.rating === 'fair') {
                improve.push('A more level swing path stays in the hitting zone longer, giving more margin for contact');
            }
        } else if (outcome === 'foul') {
            improve.push('Foul ball — close to making solid contact');
            if (score >= 60) {
                good.push('Swing mechanics look reasonable — the timing or pitch location may need adjustment');
            } else {
                improve.push('Check if the bat is getting to the contact zone too early (pulling off) or too late');
            }
        } else {
            // Hit
            if (score >= 70) {
                good.push('Contact point appears to be out in front with arms extended');
            } else {
                improve.push('Work on contacting the ball out in front of the plate');
                improve.push('Arms should be extended but not fully locked at contact');
            }
        }

        return { good, improve };
    }

    function buildBallTakenObservations(metrics, score) {
        const good = [];
        const improve = [];

        good.push('Good plate discipline — chose not to swing');

        if (metrics.headStability.rating === 'excellent' || metrics.headStability.rating === 'good') {
            good.push('Head stayed still while tracking the pitch');
        } else {
            improve.push('Even when taking a pitch, keep the head still and eyes level to track the ball');
        }

        if (score >= 60) {
            good.push('Stayed balanced and in a ready position');
        } else {
            improve.push('Work on staying balanced in your stance when taking a pitch — stay ready for the next one');
        }

        return { good, improve };
    }

    function buildFollowThroughObservations(metrics, score) {
        const good = [];
        const improve = [];

        if (metrics.followThrough.rating === 'excellent' || metrics.followThrough.rating === 'good') {
            good.push('Full follow-through — bat finishes high over the front shoulder');
        } else {
            improve.push('Follow-through is short — let the bat finish its natural path');
            improve.push('A full follow-through means you accelerated through the ball, not at it');
        }

        if (score >= 70) {
            good.push('Good weight transfer to the front side on follow-through');
        } else {
            improve.push('Transfer your weight fully to the front foot after contact');
        }

        return { good, improve };
    }

    // ---- Overall Score ----

    function computeOverallScore(metrics, phaseEvals) {
        const metricWeights = {
            batSpeed: 0.15,
            swingTime: 0.10,
            hipRotation: 0.10,
            weightTransfer: 0.10,
            smoothness: 0.15,
            levelSwing: 0.15,
            headStability: 0.15,
            followThrough: 0.10,
        };

        let metricScore = 0;
        for (const [key, weight] of Object.entries(metricWeights)) {
            if (metrics[key]) {
                metricScore += ratingToNum(metrics[key].rating) * 25 * weight;
            }
        }

        const phaseAvg = phaseEvals.reduce((a, e) => a + e.score, 0) / phaseEvals.length;

        return Math.round(metricScore * 0.5 + phaseAvg * 0.5);
    }

    // ---- Coaching Tips Generator ----

    function generateCoachingTips(metrics, phaseEvals, config) {
        const tips = [];
        const outcome = config.outcome || 'hit';

        // Identify weakest areas
        const weakMetrics = Object.entries(metrics)
            .filter(([, m]) => m.rating === 'poor' || m.rating === 'fair')
            .sort((a, b) => ratingToNum(a[1].rating) - ratingToNum(b[1].rating));

        const weakPhases = [...phaseEvals]
            .sort((a, b) => a.score - b.score);

        // Outcome-specific tips
        if (outcome === 'miss') {
            tips.push({
                priority: 'high',
                icon: '👀',
                title: 'Track the Ball All the Way',
                detail: 'On a swing and miss, the most common cause is losing sight of the ball. Practice keeping your eye on the ball from the pitcher\'s hand all the way to the bat. A common cue is "see the ball hit the bat." Soft toss and tee work help build this habit.',
            });
        } else if (outcome === 'foul') {
            tips.push({
                priority: 'medium',
                icon: '🔧',
                title: 'Timing Adjustment',
                detail: 'A foul ball often means the timing or bat angle is slightly off. If fouling to the pull side, you may be early — try waiting a fraction longer. If fouling to the opposite field, you may be late — start the swing a bit earlier.',
            });
        } else if (outcome === 'ball') {
            tips.push({
                priority: 'low',
                icon: '👏',
                title: 'Good Pitch Recognition',
                detail: 'Taking a ball shows pitch discipline. Continue to develop the ability to recognize ball vs. strike early out of the pitcher\'s hand. This is one of the most valuable skills in softball.',
            });
        }

        // Hip rotation
        if (metrics.hipRotation.rating === 'poor' || metrics.hipRotation.rating === 'fair') {
            tips.push({
                priority: 'high',
                icon: '🔄',
                title: 'Improve Hip Rotation',
                detail: 'Power in softball comes from the ground up through the hips. Focus on "squishing the bug" — rotate the back foot as your hips fire open toward the pitcher. The hands follow the hips, not the other way around.',
            });
        }

        // Bat speed
        if (metrics.batSpeed.rating === 'poor' || metrics.batSpeed.rating === 'fair') {
            tips.push({
                priority: 'high',
                icon: '⚡',
                title: 'Increase Bat Speed',
                detail: 'Bat speed starts with a strong load and explosive hip rotation. Keep your hands inside the ball and take a direct path to contact. Avoid "casting" — swinging the bat in a wide arc away from your body.',
            });
        }

        // Level swing
        if (metrics.levelSwing.rating === 'poor' || metrics.levelSwing.rating === 'fair') {
            tips.push({
                priority: 'high',
                icon: '📐',
                title: 'Level Out Your Swing Path',
                detail: 'A slight upswing (launch angle) is ideal in softball. Avoid chopping down at the ball or extreme uppercuts. Think about swinging through a "tunnel" where the bat stays in the hitting zone as long as possible.',
            });
        }

        // Head stability
        if (metrics.headStability.rating === 'poor' || metrics.headStability.rating === 'fair') {
            tips.push({
                priority: 'medium',
                icon: '👁',
                title: 'Keep Your Head Still',
                detail: 'Your head is moving during the swing, which makes it harder to track the ball. Practice keeping your chin tucked and eyes level. Your head should turn to follow the ball, but should not move up/down or forward/back.',
            });
        }

        // Smoothness
        if (metrics.smoothness.rating === 'poor' || metrics.smoothness.rating === 'fair') {
            tips.push({
                priority: 'medium',
                icon: '🌊',
                title: 'Smooth Out Your Swing',
                detail: 'A smooth, fluid swing is more consistent and powerful. Start relaxed in your stance, let the load flow naturally into the stride, and the swing should be one connected motion — not a series of separate movements.',
            });
        }

        // Follow-through
        if (metrics.followThrough.rating === 'poor' || metrics.followThrough.rating === 'fair') {
            tips.push({
                priority: 'medium',
                icon: '🏌',
                title: 'Complete Your Follow-Through',
                detail: 'A short follow-through means you decelerated before contact. Swing through the ball, not at it. The bat should finish over your front shoulder with your chest facing the pitcher.',
            });
        }

        // Weight transfer
        if (metrics.weightTransfer.rating === 'poor') {
            tips.push({
                priority: 'medium',
                icon: '⚖',
                title: 'Improve Weight Transfer',
                detail: 'Good hitters transfer weight from back foot to front foot during the swing. Practice a rhythmic load (back) and stride (forward) to get your body moving into the ball.',
            });
        }

        // Phase-specific weak areas
        if (weakPhases[0] && weakPhases[0].score < 50) {
            const phase = weakPhases[0];
            tips.push({
                priority: 'low',
                icon: '🎯',
                title: `Focus Area: ${phase.phase.name}`,
                detail: `Your ${phase.phase.name.toLowerCase()} phase scored lowest. Spend extra time on drills that isolate this part of your swing. Break the swing into parts and practice each one slowly before putting it together.`,
            });
        }

        // Age-specific encouragement
        if (['8u', '10u'].includes(config.ageGroup)) {
            tips.push({
                priority: 'low',
                icon: '⭐',
                title: 'Keep Having Fun!',
                detail: 'At this age, the most important thing is developing a love for the game. Focus on one improvement at a time and celebrate progress. Mechanics will naturally improve with practice and repetition.',
            });
        }

        return tips;
    }

    // ---- Drill Suggestions ----

    function generateDrills(metrics, phaseEvals, config) {
        const drills = [];

        if (metrics.hipRotation.rating !== 'excellent') {
            drills.push({
                name: 'Fence Drill',
                purpose: 'Teaches proper hip rotation and hand path',
                steps: [
                    'Stand with your back about 6 inches from a fence or net',
                    'Take your normal stance facing the fence with your bat',
                    'Take dry swings — if you hit the fence, your swing is too wide',
                    'Focus on firing the hips first and keeping hands inside',
                    'Do 3 sets of 10 swings',
                ],
            });
        }

        if (metrics.batSpeed.rating !== 'excellent') {
            drills.push({
                name: 'Overload / Underload Training',
                purpose: 'Builds bat speed through variable resistance',
                steps: [
                    'Take 10 swings with a heavier bat or donut on your bat',
                    'Immediately switch to your game bat and take 10 swings',
                    'The lighter bat will feel faster, training your fast-twitch muscles',
                    'Repeat for 3 rounds',
                    'Rest 1-2 minutes between rounds',
                ],
            });
        }

        if (metrics.levelSwing.rating !== 'excellent') {
            drills.push({
                name: 'High Tee / Low Tee Drill',
                purpose: 'Develops a consistent level swing path at different pitch heights',
                steps: [
                    'Set a tee at belt height and hit 10 balls focusing on a level swing',
                    'Move the tee to low strike zone — hit 10 more with the same path',
                    'Move the tee to high strike zone — hit 10 more',
                    'Focus on adjusting with your legs, not your swing plane',
                    'Hit line drives, not fly balls or grounders',
                ],
            });
        }

        if (metrics.headStability.rating !== 'excellent') {
            drills.push({
                name: 'Balance Beam Tee Drill',
                purpose: 'Improves head stability and balance throughout the swing',
                steps: [
                    'Place a 2x4 board on the ground (or use a line)',
                    'Stand on the board in your batting stance',
                    'Hit off a tee while staying balanced on the board',
                    'If you fall off, you\'re moving your head/body too much',
                    'Do 3 sets of 10 swings',
                ],
            });
        }

        if (metrics.smoothness.rating !== 'excellent') {
            drills.push({
                name: 'Slow Motion Swings',
                purpose: 'Builds muscle memory for a fluid, connected swing',
                steps: [
                    'Take your stance and go through your swing in ultra slow motion',
                    'Take 10 seconds for each swing — feel every position',
                    'Check each phase: stance, load, stride, swing, contact, follow-through',
                    'Gradually speed up while maintaining the same feel',
                    'Do 5 slow, 5 medium, 5 full speed',
                ],
            });
        }

        drills.push({
            name: 'Front Toss / Soft Toss',
            purpose: 'General timing and contact practice',
            steps: [
                'Have a partner kneel to the side and toss balls into the strike zone',
                'Focus on seeing the ball early and making solid contact',
                'Hit each ball back up the middle',
                'Do 3 rounds of 15 swings',
                'Alternate between inside, middle, and outside pitches',
            ],
        });

        if (config.ageGroup === '14u' || config.ageGroup === '16u' || config.ageGroup === 'college') {
            drills.push({
                name: 'Opposite Field Hitting',
                purpose: 'Develops bat control and ability to use the whole field',
                steps: [
                    'Set up a tee on the outside part of the plate',
                    'Focus on hitting the ball to the opposite field',
                    'Keep your front shoulder closed and hands inside the ball',
                    'Let the ball travel deeper before making contact',
                    'Do 3 sets of 10, alternating with middle and pull-side swings',
                ],
            });
        }

        return drills;
    }

    // ---- Draw Annotations on Frame ----

    function annotateFrame(canvas, frameIdx, phaseData, regionScores, motionScores, outcome) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const phaseIdx = phaseData.phases[frameIdx];
        let phase = PHASES[phaseIdx];

        // Override contact phase name based on outcome
        if (phaseIdx === 4 && outcome) {
            const info = OUTCOMES[outcome] || OUTCOMES.hit;
            phase = { ...phase, name: info.contactPhase };
        }

        // Scale font sizes relative to video resolution
        const scale = Math.max(w / 640, 1);
        const labelFontSize = Math.round(18 * scale);
        const numberFontSize = Math.round(28 * scale);
        const smallFontSize = Math.round(12 * scale);
        const pad = Math.round(10 * scale);

        // Draw region grid overlay
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(0, h * 0.33);
        ctx.lineTo(w, h * 0.33);
        ctx.moveTo(0, h * 0.66);
        ctx.lineTo(w, h * 0.66);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw motion heatmap bars on the right side
        if (regionScores[frameIdx]) {
            const regions = regionScores[frameIdx];
            const barWidth = Math.round(10 * scale);
            const barX = w - barWidth - pad;

            const drawBar = (yStart, yEnd, value) => {
                const maxH = yEnd - yStart;
                const barH = value * maxH * 10;
                ctx.fillStyle = `rgba(255, ${Math.round(255 - value * 2550)}, 0, 0.7)`;
                ctx.fillRect(barX, yEnd - barH, barWidth, barH);
            };

            drawBar(0, h * 0.33, regions.upper);
            drawBar(h * 0.33, h * 0.66, regions.middle);
            drawBar(h * 0.66, h, regions.lower);
        }

        // ---- Phase number badge (top-left circle) ----
        const badgeRadius = Math.round(22 * scale);
        const badgeX = pad + badgeRadius;
        const badgeY = pad + badgeRadius;
        ctx.beginPath();
        ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
        ctx.fillStyle = phase.color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.fillStyle = 'white';
        ctx.font = `bold ${numberFontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(phaseIdx + 1), badgeX, badgeY);

        // ---- Phase name label (next to badge) ----
        ctx.font = `bold ${labelFontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const labelText = phase.name;
        const textMetrics = ctx.measureText(labelText);
        const labelX = badgeX + badgeRadius + pad;
        const labelY = pad;
        const labelPadH = Math.round(6 * scale);
        const labelPadW = Math.round(10 * scale);
        const labelH = labelFontSize + labelPadH * 2;
        const labelW = textMetrics.width + labelPadW * 2;

        // Background pill
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        const pillRadius = Math.round(6 * scale);
        ctx.beginPath();
        ctx.moveTo(labelX + pillRadius, labelY);
        ctx.lineTo(labelX + labelW - pillRadius, labelY);
        ctx.quadraticCurveTo(labelX + labelW, labelY, labelX + labelW, labelY + pillRadius);
        ctx.lineTo(labelX + labelW, labelY + labelH - pillRadius);
        ctx.quadraticCurveTo(labelX + labelW, labelY + labelH, labelX + labelW - pillRadius, labelY + labelH);
        ctx.lineTo(labelX + pillRadius, labelY + labelH);
        ctx.quadraticCurveTo(labelX, labelY + labelH, labelX, labelY + labelH - pillRadius);
        ctx.lineTo(labelX, labelY + pillRadius);
        ctx.quadraticCurveTo(labelX, labelY, labelX + pillRadius, labelY);
        ctx.closePath();
        ctx.fill();

        // Colored left accent bar
        ctx.fillStyle = phase.color;
        ctx.fillRect(labelX, labelY, Math.round(4 * scale), labelH);

        // Text
        ctx.fillStyle = 'white';
        ctx.fillText(labelText, labelX + labelPadW, labelY + labelPadH);

        // ---- Motion score bar at bottom ----
        const motion = motionScores[frameIdx] || 0;
        const barH = Math.round(20 * scale);
        const mBarW = Math.min(motion * w * 5, w - pad * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(pad, h - barH - pad, w - pad * 2, barH);
        ctx.fillStyle = phase.color;
        ctx.fillRect(pad, h - barH - pad, mBarW, barH);
        ctx.fillStyle = 'white';
        ctx.font = `${smallFontSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('Motion: ' + (motion * 100).toFixed(1), pad + 5, h - barH / 2 - pad);

        // Reset text alignment
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
    }

    // ---- Main Analysis Pipeline ----

    async function analyze(videoEl, config, onProgress) {
        onProgress(0, 'Preparing video...');

        // Step 1: Extract frames
        const frames = await extractFrames(videoEl, 24, (p, msg) => {
            onProgress(p * 0.4, msg);
        });

        if (frames.length < 6) {
            throw new Error('Could not extract enough frames. Try a longer video.');
        }

        onProgress(0.4, 'Analyzing motion...');

        // Step 2: Compute motion between consecutive frames
        const motionScores = [0];
        const regionScores = [{ upper: 0, middle: 0, lower: 0 }];

        for (let i = 1; i < frames.length; i++) {
            motionScores.push(motionBetween(frames[i - 1].canvas, frames[i].canvas));
            regionScores.push(regionMotion(frames[i - 1].canvas, frames[i].canvas));
            onProgress(0.4 + (i / frames.length) * 0.2, 'Analyzing motion...');
        }

        onProgress(0.6, 'Detecting swing phases...');

        // Step 3: Detect phases
        const outcome = config.outcome || 'hit';
        const phaseData = detectPhases(motionScores, regionScores, outcome);

        onProgress(0.7, 'Computing metrics...');

        // Step 4: Compute metrics
        const metrics = computeMetrics(frames, motionScores, regionScores, phaseData, config);

        onProgress(0.8, 'Evaluating swing phases...');

        // Step 5: Evaluate each phase
        const phaseEvals = evaluatePhases(frames, motionScores, regionScores, phaseData, metrics, config);

        onProgress(0.85, 'Generating coaching tips...');

        // Step 6: Overall score
        const overallScore = computeOverallScore(metrics, phaseEvals);

        // Step 7: Generate coaching tips and drills
        const coachingTips = generateCoachingTips(metrics, phaseEvals, config);
        const drills = generateDrills(metrics, phaseEvals, config);

        onProgress(0.9, 'Preparing annotated frames...');

        // Step 8: Annotate key frames
        const keyFrameIndices = [
            0,                          // Stance
            phaseData.motionStart,      // Load start
            phaseData.loadEnd,          // Stride start
            phaseData.strideEnd,        // Swing start
            phaseData.peakIdx,          // Contact
            Math.min(phaseData.contactEnd + 1, frames.length - 1), // Follow-through
        ];

        const annotatedFrames = keyFrameIndices.map(idx => {
            const frame = frames[idx];
            // Create a copy to annotate
            const annotCanvas = document.createElement('canvas');
            annotCanvas.width = frame.canvas.width;
            annotCanvas.height = frame.canvas.height;
            const ctx = annotCanvas.getContext('2d');
            ctx.drawImage(frame.canvas, 0, 0);
            annotateFrame(annotCanvas, idx, phaseData, regionScores, motionScores, outcome);
            return {
                canvas: annotCanvas,
                time: frame.time,
                phase: PHASES[phaseData.phases[idx]],
                frameIdx: idx,
            };
        });

        onProgress(1.0, 'Analysis complete!');

        return {
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
        };
    }

    // ---- Public API ----
    return {
        analyze,
        PHASES,
        OUTCOMES,
    };

})();
