/**
 * Softball Swing Analyzer — Application Controller
 *
 * Handles multi-video upload, per-video outcome tagging,
 * analysis orchestration, comparison, and result rendering.
 */

(function () {
    'use strict';

    // ---- DOM Elements ----
    const $ = (sel) => document.querySelector(sel);
    const uploadSection = $('#upload-section');
    const queueSection = $('#queue-section');
    const progressSection = $('#progress-section');
    const resultsSection = $('#results-section');

    const dropZone = $('#drop-zone');
    const videoInput = $('#video-input');
    const videoQueue = $('#video-queue');
    const analyzeAllBtn = $('#analyze-all-btn');
    const addMoreBtn = $('#add-more-btn');
    const clearQueueBtn = $('#clear-queue-btn');
    const newAnalysisBtn = $('#new-analysis-btn');

    const progressTitle = $('#progress-title');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');

    const comparisonBar = $('#comparison-bar');
    const comparisonTabs = $('#comparison-tabs');
    const comparisonGrid = $('#comparison-grid');
    const singleResult = $('#single-result');

    const resultTitle = $('#result-title');
    const overallScoreEl = $('#overall-score');
    const scoreSummary = $('#score-summary');
    const phaseTimeline = $('#phase-timeline');
    const phaseFrames = $('#phase-frames');
    const metricsGrid = $('#metrics-grid');
    const frameCanvas = $('#frame-canvas');
    const frameLabel = $('#frame-label');
    const frameAnnotations = $('#frame-annotations');
    const prevFrameBtn = $('#prev-frame');
    const nextFrameBtn = $('#next-frame');
    const coachingTipsEl = $('#coaching-tips');
    const drillSuggestionsEl = $('#drill-suggestions');

    // ---- State ----
    let videoFiles = [];       // Array of { file, outcome, id }
    let allResults = [];       // Array of { name, outcome, result, config }
    let currentFrameIdx = 0;
    let activeResultIdx = 0;
    let nextId = 1;

    // ---- Section Management ----

    function showSection(section) {
        uploadSection.classList.toggle('hidden', section !== 'upload');
        queueSection.classList.toggle('hidden', section !== 'queue');
        progressSection.classList.toggle('hidden', section !== 'progress');
        resultsSection.classList.toggle('hidden', section !== 'results');
    }

    // ---- File Upload ----

    dropZone.addEventListener('click', (e) => {
        // Prevent re-triggering when the input's click bubbles back up
        if (e.target === videoInput) return;
        videoInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files).filter(isVideoFile);
        if (files.length > 0) {
            addFiles(files);
        }
    });

    videoInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files).filter(isVideoFile);
        if (files.length > 0) {
            addFiles(files);
        }
        videoInput.value = '';
    });

    function isVideoFile(file) {
        if (file.type.startsWith('video/')) return true;
        // Fallback: check extension for files where MIME type is missing (common on mobile)
        const ext = file.name.split('.').pop().toLowerCase();
        return ['mp4', 'mov', 'webm', 'avi', 'm4v', 'mkv'].includes(ext);
    }

    function addFiles(files) {
        for (const file of files) {
            if (file.size > 200 * 1024 * 1024) {
                alert(`"${file.name}" is too large (max 200MB). Skipping.`);
                continue;
            }
            videoFiles.push({
                file,
                outcome: 'hit',
                id: nextId++,
            });
        }
        renderQueue();
        showSection('queue');
    }

    addMoreBtn.addEventListener('click', () => videoInput.click());

    clearQueueBtn.addEventListener('click', () => {
        videoFiles = [];
        showSection('upload');
    });

    newAnalysisBtn.addEventListener('click', () => {
        videoFiles = [];
        allResults = [];
        showSection('upload');
    });

    // ---- Queue Rendering ----

    function renderQueue() {
        videoQueue.innerHTML = '';

        videoFiles.forEach((entry, idx) => {
            const item = document.createElement('div');
            item.className = 'queue-item';

            // Thumbnail
            const thumb = document.createElement('video');
            thumb.className = 'queue-thumb';
            thumb.src = URL.createObjectURL(entry.file);
            thumb.muted = true;
            thumb.preload = 'metadata';
            thumb.onloadeddata = () => { thumb.currentTime = 0.5; };

            // Info
            const info = document.createElement('div');
            info.className = 'queue-info';
            const sizeMB = (entry.file.size / (1024 * 1024)).toFixed(1);
            info.innerHTML = `
                <div class="queue-name">${entry.file.name}</div>
                <div class="queue-meta">${sizeMB} MB</div>
            `;

            // Outcome selector
            const outcomeWrap = document.createElement('div');
            outcomeWrap.className = 'queue-outcome';
            const select = document.createElement('select');
            select.innerHTML = `
                <option value="hit">Hit</option>
                <option value="miss">Swing & Miss</option>
                <option value="foul">Foul Ball</option>
                <option value="ball">Ball (Took)</option>
            `;
            select.value = entry.outcome;
            select.addEventListener('change', () => {
                entry.outcome = select.value;
            });
            const label = document.createElement('div');
            label.style.cssText = 'font-size:0.75rem;color:#6b7280;margin-bottom:2px;';
            label.textContent = 'Outcome';
            outcomeWrap.appendChild(label);
            outcomeWrap.appendChild(select);

            // Remove button
            const removeBtn = document.createElement('button');
            removeBtn.className = 'queue-remove';
            removeBtn.innerHTML = '&times;';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', () => {
                videoFiles.splice(idx, 1);
                if (videoFiles.length === 0) {
                    showSection('upload');
                } else {
                    renderQueue();
                }
            });

            item.appendChild(thumb);
            item.appendChild(info);
            item.appendChild(outcomeWrap);
            item.appendChild(removeBtn);
            videoQueue.appendChild(item);
        });

        // Update button text
        analyzeAllBtn.textContent = videoFiles.length === 1
            ? 'Analyze Swing'
            : `Analyze All ${videoFiles.length} Swings`;
    }

    // ---- Analysis ----

    analyzeAllBtn.addEventListener('click', async () => {
        if (videoFiles.length === 0) return;

        showSection('progress');
        allResults = [];

        const sharedConfig = {
            handedness: $('#handedness').value,
            ageGroup: $('#age-group').value,
        };

        for (let i = 0; i < videoFiles.length; i++) {
            const entry = videoFiles[i];
            const videoNum = i + 1;
            const total = videoFiles.length;

            progressTitle.textContent = total > 1
                ? `Analyzing Swing ${videoNum} of ${total}...`
                : 'Analyzing Swing...';

            const config = {
                ...sharedConfig,
                outcome: entry.outcome,
                pitchType: 'general',
            };

            try {
                // Create a temporary video element for analysis
                const videoEl = document.createElement('video');
                videoEl.src = URL.createObjectURL(entry.file);
                videoEl.muted = true;
                videoEl.preload = 'auto';

                await new Promise((resolve, reject) => {
                    videoEl.onloadedmetadata = resolve;
                    videoEl.onerror = reject;
                    videoEl.load();
                });

                const result = await SwingAnalyzer.analyze(
                    videoEl,
                    config,
                    (fraction, msg) => {
                        const overallFraction = (i + fraction) / total;
                        updateProgress(overallFraction, `Video ${videoNum}/${total}: ${msg}`);
                    }
                );

                allResults.push({
                    name: entry.file.name,
                    outcome: entry.outcome,
                    result,
                    config,
                });

                // Clean up
                URL.revokeObjectURL(videoEl.src);
            } catch (err) {
                console.error(`Error analyzing ${entry.file.name}:`, err);
                alert(`Error analyzing "${entry.file.name}": ${err.message}`);
            }
        }

        if (allResults.length > 0) {
            activeResultIdx = 0;
            renderAllResults();
            showSection('results');
        } else {
            showSection('queue');
        }
    });

    function updateProgress(fraction, message) {
        progressBar.style.width = Math.round(fraction * 100) + '%';
        progressText.textContent = message;
    }

    // ---- Render Results ----

    function renderAllResults() {
        if (allResults.length > 1) {
            renderComparison();
            comparisonBar.classList.remove('hidden');
        } else {
            comparisonBar.classList.add('hidden');
        }

        renderSingleResult(activeResultIdx);
    }

    function renderComparison() {
        // Tabs
        comparisonTabs.innerHTML = '';
        allResults.forEach((r, idx) => {
            const tab = document.createElement('div');
            tab.className = 'comparison-tab' + (idx === activeResultIdx ? ' active' : '');

            const outcomeLabel = SwingAnalyzer.OUTCOMES[r.outcome]
                ? SwingAnalyzer.OUTCOMES[r.outcome].label
                : 'Hit';
            const scoreColor = r.result.overallScore >= 70 ? '#10b981'
                : r.result.overallScore >= 50 ? '#3b82f6' : '#f59e0b';

            tab.innerHTML = `Swing ${idx + 1}
                <span class="tab-score" style="background:${scoreColor}">${r.result.overallScore}</span>`;
            tab.title = `${r.name} — ${outcomeLabel}`;

            tab.addEventListener('click', () => {
                activeResultIdx = idx;
                renderAllResults();
            });
            comparisonTabs.appendChild(tab);
        });

        // Comparison grid — show key metrics across all videos
        comparisonGrid.innerHTML = '';
        const metricKeys = ['batSpeed', 'swingTime', 'hipRotation', 'smoothness', 'levelSwing', 'headStability'];

        metricKeys.forEach(key => {
            const div = document.createElement('div');
            div.className = 'comparison-metric';

            const firstMetric = allResults[0].result.metrics[key];
            if (!firstMetric) return;

            // Find the best value
            let bestIdx = 0;
            let bestRating = 0;
            allResults.forEach((r, idx) => {
                const rating = ratingToNum(r.result.metrics[key].rating);
                if (rating > bestRating) {
                    bestRating = rating;
                    bestIdx = idx;
                }
            });

            let valuesHtml = allResults.map((r, idx) => {
                const m = r.result.metrics[key];
                const isBest = idx === bestIdx && allResults.length > 1;
                return `<span class="cm-value${isBest ? ' best' : ''}">#${idx + 1}: ${m.value}</span>`;
            }).join('');

            div.innerHTML = `
                <div class="cm-label">${firstMetric.name}</div>
                <div class="cm-values">${valuesHtml}</div>
            `;
            comparisonGrid.appendChild(div);
        });
    }

    function ratingToNum(rating) {
        return { excellent: 4, good: 3, fair: 2, poor: 1 }[rating] || 2;
    }

    function renderSingleResult(idx) {
        const { name, outcome, result, config } = allResults[idx];
        const outcomeLabel = SwingAnalyzer.OUTCOMES[outcome]
            ? SwingAnalyzer.OUTCOMES[outcome].label
            : 'Hit';

        if (allResults.length > 1) {
            resultTitle.textContent = `Swing ${idx + 1}: ${name} (${outcomeLabel})`;
        } else {
            resultTitle.textContent = `Swing Score (${outcomeLabel})`;
        }

        renderOverallScore(result.overallScore);
        renderPhaseTimeline(result.phaseEvals);
        renderMetrics(result.metrics);
        renderFrameViewer(result.annotatedFrames);
        renderCoachingTips(result.coachingTips);
        renderDrills(result.drills);
    }

    // -- Overall Score --
    function renderOverallScore(score) {
        const scoreNum = overallScoreEl.querySelector('.score-number');
        scoreNum.textContent = score;

        overallScoreEl.className = 'score-circle';
        if (score >= 80) overallScoreEl.classList.add('score-excellent');
        else if (score >= 60) overallScoreEl.classList.add('score-good');
        else if (score >= 40) overallScoreEl.classList.add('score-fair');
        else overallScoreEl.classList.add('score-needs-work');

        let summaryTitle, summaryText;
        if (score >= 80) {
            summaryTitle = 'Excellent Swing!';
            summaryText = 'The swing mechanics are strong across all phases. Focus on maintaining consistency and fine-tuning the small details to reach the next level.';
        } else if (score >= 60) {
            summaryTitle = 'Good Foundation';
            summaryText = 'Solid swing fundamentals with room to improve in a few key areas. The coaching tips below highlight the best opportunities for improvement.';
        } else if (score >= 40) {
            summaryTitle = 'Making Progress';
            summaryText = 'The swing has good elements but needs work in several areas. Focus on the top 2-3 coaching tips — don\'t try to fix everything at once.';
        } else {
            summaryTitle = 'Building the Basics';
            summaryText = 'There are several fundamental areas to work on. Start with stance and load — getting a good foundation will improve everything else. Check the drills below for practice ideas.';
        }

        scoreSummary.innerHTML = `<h3>${summaryTitle}</h3><p>${summaryText}</p>`;
    }

    // -- Phase Timeline --
    function renderPhaseTimeline(phaseEvals) {
        phaseTimeline.innerHTML = '';
        phaseFrames.innerHTML = '';

        phaseEvals.forEach((eval_, idx) => {
            const seg = document.createElement('div');
            seg.className = `phase-segment phase-${eval_.phase.id}`;
            seg.textContent = eval_.phase.name;
            seg.addEventListener('click', () => showPhaseDetail(idx, phaseEvals));
            phaseTimeline.appendChild(seg);
        });

        if (phaseEvals.length > 0) {
            showPhaseDetail(0, phaseEvals);
        }
    }

    function showPhaseDetail(idx, phaseEvals) {
        const eval_ = phaseEvals[idx];
        const segments = phaseTimeline.querySelectorAll('.phase-segment');
        segments.forEach((s, i) => s.classList.toggle('active', i === idx));

        const scoreColor = eval_.score >= 70 ? '#10b981' : eval_.score >= 50 ? '#f59e0b' : '#ef4444';

        let html = `<div class="phase-detail">`;
        html += `<h3>${eval_.phase.name}</h3>`;
        html += `<span class="phase-score" style="background: ${scoreColor}">${eval_.score} / 100</span>`;

        if (eval_.observations.good.length > 0) {
            html += `<ul>`;
            eval_.observations.good.forEach(obs => {
                html += `<li class="good">&#10003; ${obs}</li>`;
            });
            html += `</ul>`;
        }

        if (eval_.observations.improve.length > 0) {
            html += `<ul>`;
            eval_.observations.improve.forEach(obs => {
                html += `<li class="improve">&#9888; ${obs}</li>`;
            });
            html += `</ul>`;
        }

        html += `</div>`;
        phaseFrames.innerHTML = html;
    }

    // -- Metrics --
    function renderMetrics(metrics) {
        metricsGrid.innerHTML = '';

        for (const [key, metric] of Object.entries(metrics)) {
            const card = document.createElement('div');
            card.className = 'metric-card';

            const ratingClass = `rating-${metric.rating}`;
            const ratingLabel = metric.rating.charAt(0).toUpperCase() + metric.rating.slice(1);

            card.innerHTML = `
                <div class="metric-name">${metric.name}</div>
                <div class="metric-value">${metric.value}</div>
                <span class="metric-rating ${ratingClass}">${ratingLabel}</span>
            `;

            metricsGrid.appendChild(card);
        }
    }

    // -- Frame Viewer --
    function renderFrameViewer(annotatedFrames) {
        if (!annotatedFrames || annotatedFrames.length === 0) return;

        currentFrameIdx = 0;
        drawFrame(annotatedFrames, 0);

        prevFrameBtn.onclick = () => {
            if (currentFrameIdx > 0) {
                currentFrameIdx--;
                drawFrame(annotatedFrames, currentFrameIdx);
            }
        };

        nextFrameBtn.onclick = () => {
            if (currentFrameIdx < annotatedFrames.length - 1) {
                currentFrameIdx++;
                drawFrame(annotatedFrames, currentFrameIdx);
            }
        };
    }

    function drawFrame(annotatedFrames, idx) {
        const frame = annotatedFrames[idx];
        frameCanvas.width = frame.canvas.width;
        frameCanvas.height = frame.canvas.height;
        const ctx = frameCanvas.getContext('2d');
        ctx.drawImage(frame.canvas, 0, 0);

        frameLabel.textContent = `Frame ${idx + 1} / ${annotatedFrames.length} — ${frame.phase.name}`;

        frameAnnotations.innerHTML = `
            <p><strong>Phase:</strong> ${frame.phase.name}</p>
            <p><strong>Time:</strong> ${frame.time.toFixed(2)}s into video</p>
        `;
    }

    // -- Coaching Tips --
    function renderCoachingTips(tips) {
        coachingTipsEl.innerHTML = '';

        if (tips.length === 0) {
            coachingTipsEl.innerHTML = '<p>Great swing! No major areas for improvement detected.</p>';
            return;
        }

        tips.forEach(tip => {
            const div = document.createElement('div');
            div.className = `coaching-tip priority-${tip.priority}`;
            div.innerHTML = `
                <div class="tip-icon">${tip.icon}</div>
                <div class="tip-content">
                    <h4>${tip.title}</h4>
                    <p>${tip.detail}</p>
                </div>
            `;
            coachingTipsEl.appendChild(div);
        });
    }

    // -- Drills --
    function renderDrills(drills) {
        drillSuggestionsEl.innerHTML = '';

        drills.forEach(drill => {
            const div = document.createElement('div');
            div.className = 'drill-card';
            let stepsHtml = drill.steps.map(s => `<li>${s}</li>`).join('');
            div.innerHTML = `
                <h4>${drill.name}</h4>
                <p class="drill-purpose">${drill.purpose}</p>
                <ol class="drill-steps">${stepsHtml}</ol>
            `;
            drillSuggestionsEl.appendChild(div);
        });
    }

})();
