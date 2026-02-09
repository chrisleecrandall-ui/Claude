/**
 * Softball Swing Analyzer — Application Controller
 *
 * Handles UI interactions, video upload, analysis orchestration,
 * and rendering of results.
 */

(function () {
    'use strict';

    // ---- DOM Elements ----
    const $ = (sel) => document.querySelector(sel);
    const uploadSection = $('#upload-section');
    const previewSection = $('#preview-section');
    const progressSection = $('#progress-section');
    const resultsSection = $('#results-section');

    const dropZone = $('#drop-zone');
    const videoInput = $('#video-input');
    const videoPlayer = $('#video-player');
    const analyzeBtn = $('#analyze-btn');
    const changeVideoBtn = $('#change-video-btn');
    const newAnalysisBtn = $('#new-analysis-btn');

    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');

    const overallScoreEl = $('#overall-score');
    const scoreSummary = $('#score-summary');
    const phaseTimeline = $('#phase-timeline');
    const phaseFrames = $('#phase-frames');
    const metricsGrid = $('#metrics-grid');
    const frameCanvas = $('#frame-canvas');
    const frameControls = $('#frame-controls');
    const frameLabel = $('#frame-label');
    const frameAnnotations = $('#frame-annotations');
    const prevFrameBtn = $('#prev-frame');
    const nextFrameBtn = $('#next-frame');
    const coachingTips = $('#coaching-tips');
    const drillSuggestions = $('#drill-suggestions');

    // ---- State ----
    let currentVideoFile = null;
    let analysisResult = null;
    let currentFrameIdx = 0;

    // ---- File Upload ----

    dropZone.addEventListener('click', () => videoInput.click());

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
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    });

    videoInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFile(e.target.files[0]);
        }
    });

    function handleFile(file) {
        if (!file.type.startsWith('video/')) {
            alert('Please select a video file.');
            return;
        }

        if (file.size > 200 * 1024 * 1024) {
            alert('File is too large. Please select a video under 200MB.');
            return;
        }

        currentVideoFile = file;
        const url = URL.createObjectURL(file);
        videoPlayer.src = url;

        showSection('preview');
    }

    // ---- Section Management ----

    function showSection(section) {
        uploadSection.classList.toggle('hidden', section !== 'upload');
        previewSection.classList.toggle('hidden', section !== 'preview');
        progressSection.classList.toggle('hidden', section !== 'progress');
        resultsSection.classList.toggle('hidden', section !== 'results');
    }

    changeVideoBtn.addEventListener('click', () => {
        videoPlayer.src = '';
        currentVideoFile = null;
        videoInput.value = '';
        showSection('upload');
    });

    newAnalysisBtn.addEventListener('click', () => {
        videoPlayer.src = '';
        currentVideoFile = null;
        videoInput.value = '';
        analysisResult = null;
        showSection('upload');
    });

    // ---- Analysis ----

    analyzeBtn.addEventListener('click', async () => {
        if (!currentVideoFile) return;

        showSection('progress');
        updateProgress(0, 'Loading video...');

        // Ensure video metadata is loaded
        await new Promise((resolve) => {
            if (videoPlayer.readyState >= 1) {
                resolve();
            } else {
                videoPlayer.onloadedmetadata = resolve;
                videoPlayer.load();
            }
        });

        const config = {
            handedness: $('#handedness').value,
            pitchType: $('#pitch-type').value,
            ageGroup: $('#age-group').value,
        };

        try {
            analysisResult = await SwingAnalyzer.analyze(
                videoPlayer,
                config,
                updateProgress
            );

            renderResults(analysisResult, config);
            showSection('results');
        } catch (err) {
            console.error('Analysis error:', err);
            alert('Error analyzing video: ' + err.message);
            showSection('preview');
        }
    });

    function updateProgress(fraction, message) {
        progressBar.style.width = Math.round(fraction * 100) + '%';
        progressText.textContent = message;
    }

    // ---- Render Results ----

    function renderResults(result, config) {
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

        // Color based on score
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
            // Timeline segment
            const seg = document.createElement('div');
            seg.className = `phase-segment phase-${eval_.phase.id}`;
            seg.textContent = eval_.phase.name;
            seg.addEventListener('click', () => showPhaseDetail(idx, phaseEvals));
            phaseTimeline.appendChild(seg);
        });

        // Show first phase by default
        if (phaseEvals.length > 0) {
            showPhaseDetail(0, phaseEvals);
        }
    }

    function showPhaseDetail(idx, phaseEvals) {
        const eval_ = phaseEvals[idx];

        // Update active state
        const segments = phaseTimeline.querySelectorAll('.phase-segment');
        segments.forEach((s, i) => s.classList.toggle('active', i === idx));

        // Build detail view
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
        coachingTips.innerHTML = '';

        if (tips.length === 0) {
            coachingTips.innerHTML = '<p>Great swing! No major areas for improvement detected.</p>';
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
            coachingTips.appendChild(div);
        });
    }

    // -- Drills --
    function renderDrills(drills) {
        drillSuggestions.innerHTML = '';

        drills.forEach(drill => {
            const div = document.createElement('div');
            div.className = 'drill-card';
            let stepsHtml = drill.steps.map(s => `<li>${s}</li>`).join('');
            div.innerHTML = `
                <h4>${drill.name}</h4>
                <p class="drill-purpose">${drill.purpose}</p>
                <ol class="drill-steps">${stepsHtml}</ol>
            `;
            drillSuggestions.appendChild(div);
        });
    }

})();
