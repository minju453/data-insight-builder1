/**
 * Startup Market Navigator - Vanilla JavaScript Client
 * Chart.js 통합 및 단계별 비동기 API 통신
 */

// 전역 앱 상태 객체 (오류 발생 시 AI에게 전달하기 위한 상태 저장소)
window.APP_STATE = {
    server: { status: 'unknown', has_api_key: false, model: '' },
    selected: { sido: '', sigungu: '전체', industry: '' },
    datasets_meta: null,
    diagnosis: null,
    suggestions: [],
    current_run: { tool_id: '', result: null },
    latest_report: null,
    logs: []
};

// 활성 Chart.js 인스턴스
let currentChart = null;

// 로거 헬퍼 (콘솔 및 화면 로그 패널에 동시 기록)
function logMessage(level, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const logItem = `[${timestamp}] [${level}] ${message}`;
    
    // 브라우저 개발자 콘솔 출력
    if (level === 'ERROR') {
        console.error(logItem, data || '');
    } else if (level === 'WARN') {
        console.warn(logItem, data || '');
    } else {
        console.log(logItem, data || '');
    }

    // 상태 저장소에 보관 (최근 50개 유지)
    window.APP_STATE.logs.push({ timestamp, level, message, data });
    if (window.APP_STATE.logs.length > 50) {
        window.APP_STATE.logs.shift();
    }

    // 화면 내 로그 스트림 엘리먼트 업데이트
    const stream = document.getElementById('log-stream');
    if (stream) {
        const line = document.createElement('div');
        line.textContent = logItem + (data ? ` | ${JSON.stringify(data).slice(0, 120)}` : '');
        stream.appendChild(line);
        stream.scrollTop = stream.scrollHeight;
    }
}

// 로딩 스피너 제어
function showLoading(message = '처리 중입니다...') {
    const overlay = document.getElementById('loading-overlay');
    const msgEl = document.getElementById('loading-message');
    if (overlay && msgEl) {
        msgEl.textContent = message;
        overlay.classList.remove('hidden');
    }
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}

// 알림 표시 헬퍼
function showUserError(msg) {
    logMessage('ERROR', msg);
    alert('⚠️ ' + msg);
}

// 간단한 마크다운을 HTML로 변환하는 경량 파서
function parseMarkdownToHtml(md) {
    if (!md) return '';
    let html = md
        // HTML 특수문자 이스케이프
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // 헤더
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        // 굵은 글씨
        .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
        // 기울임
        .replace(/\*(.*?)\*/gim, '<em>$1</em>')
        // 순서 없는 목록
        .replace(/^\s*\*\s+(.*$)/gim, '<li>$1</li>')
        .replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>')
        // 줄바꿈 단락
        .replace(/\n\n+/g, '</p><p>')
        .replace(/\n/g, '<br>');

    // li 태그를 ul로 감싸기
    html = html.replace(/(<li>.*?<\/li>)+/gs, '<ul>$&</ul>');
    return `<p>${html}</p>`;
}

// -----------------------------------------------------------------------------
// 초기화 및 데이터 로드 (Step 1)
// -----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    logMessage('INFO', '🚀 Startup Market Navigator 초기화 시작');
    setupEventListeners();
    await checkHealth();
    await loadDatasets();
});

function setupEventListeners() {
    // 시도 변경 시 시군구 드롭다운 업데이트
    const sidoSelect = document.getElementById('select-sido');
    sidoSelect.addEventListener('change', (e) => {
        updateSigunguDropdown(e.target.value);
    });

    // 1단계 진단 버튼
    document.getElementById('btn-inspect').addEventListener('click', handleInspect);

    // 1단계 초기화 버튼
    document.getElementById('btn-reset').addEventListener('click', resetAll);

    // 2단계 도구 제안 버튼
    document.getElementById('btn-suggest').addEventListener('click', handleSuggest);

    // 4단계 전략 보고서 생성 버튼
    document.getElementById('btn-explain').addEventListener('click', handleExplain);

    // 디버그 상태 복사 버튼
    document.getElementById('btn-copy-debug').addEventListener('click', copyDebugState);

    // 로그 패널 토글 버튼
    document.getElementById('btn-toggle-log').addEventListener('click', () => {
        const panel = document.getElementById('log-panel');
        panel.classList.toggle('hidden');
    });

    // 로그 지우기 버튼
    document.getElementById('btn-clear-log').addEventListener('click', () => {
        const stream = document.getElementById('log-stream');
        if (stream) stream.innerHTML = '';
        window.APP_STATE.logs = [];
    });
}

// 서버 상태 및 API Key 확인
async function checkHealth() {
    try {
        logMessage('INFO', 'GET /health 호출 중...');
        const res = await fetch('/health');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        
        window.APP_STATE.server = data;
        logMessage('INFO', '서버 상태 정상 수신', data);

        const statusBadge = document.getElementById('server-status-badge');
        const apiBadge = document.getElementById('api-key-badge');

        if (statusBadge) {
            statusBadge.textContent = `● 서버 가동 중 (${data.loaded_datasets_count || 11}개 데이터셋)`;
            statusBadge.className = 'status-indicator online';
        }

        if (apiBadge) {
            if (data.has_api_key) {
                apiBadge.textContent = `● Gemini API 연결됨 (${data.model || 'Flash'})`;
                apiBadge.className = 'status-indicator online';
            } else {
                apiBadge.textContent = '▲ Gemini API 키 미설정 (.env 확인 필요)';
                apiBadge.className = 'status-indicator warning';
            }
        }
    } catch (err) {
        logMessage('ERROR', '서버 헬스체크 실패', err.message);
        const statusBadge = document.getElementById('server-status-badge');
        if (statusBadge) {
            statusBadge.textContent = '× 서버 연결 불가 (Flask 서버 실행 확인)';
            statusBadge.className = 'status-indicator warning';
        }
    }
}

// 데이터셋 필터 옵션 로드
async function loadDatasets() {
    showLoading('공공데이터 목록을 로드하는 중입니다...');
    try {
        logMessage('INFO', 'GET /datasets 호출 중...');
        const res = await fetch('/datasets');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data.success) {
            throw new Error(data.error || '데이터셋 정보를 가져올 수 없습니다.');
        }

        window.APP_STATE.datasets_meta = data;
        logMessage('INFO', `/datasets 로드 완료: 시도 ${data.sido_list.length}개, 업종 ${data.industry_list.length}개`);

        // 시도 드롭다운 채우기
        const sidoSelect = document.getElementById('select-sido');
        sidoSelect.innerHTML = '<option value="">-- 시·도 선택 --</option>';
        data.sido_list.forEach((sido) => {
            const opt = document.createElement('option');
            opt.value = sido;
            opt.textContent = sido;
            sidoSelect.appendChild(opt);
        });

        // 업종 드롭다운 채우기
        const industrySelect = document.getElementById('select-industry');
        industrySelect.innerHTML = '<option value="">-- 업종 선택 (100대 생활업종) --</option>';
        data.industry_list.forEach((ind) => {
            const opt = document.createElement('option');
            opt.value = ind;
            opt.textContent = ind;
            industrySelect.appendChild(opt);
        });

        // 기본 추천 선택 (예: 서울특별시 / 강남구 / 커피음료점)
        if (data.sido_list.includes('서울특별시')) {
            sidoSelect.value = '서울특별시';
            updateSigunguDropdown('서울특별시');
            const sigunguSelect = document.getElementById('select-sigungu');
            if (sigunguSelect) sigunguSelect.value = '강남구';
        }
        if (data.industry_list.includes('커피음료점')) {
            industrySelect.value = '커피음료점';
        }

    } catch (err) {
        showUserError('데이터셋 목록 로드 실패: ' + err.message);
    } finally {
        hideLoading();
    }
}

// 시군구 드롭다운 업데이트
function updateSigunguDropdown(sido) {
    const sigunguSelect = document.getElementById('select-sigungu');
    sigunguSelect.innerHTML = '<option value="전체">전체 (시·도 전체 합산)</option>';
    if (!sido || !window.APP_STATE.datasets_meta) return;

    const sigungus = window.APP_STATE.datasets_meta.sigungu_map[sido] || [];
    sigungus.forEach((sig) => {
        const opt = document.createElement('option');
        opt.value = sig;
        opt.textContent = sig;
        sigunguSelect.appendChild(opt);
    });
    logMessage('INFO', `${sido} 하위 ${sigungus.length}개 시군구 옵션 갱신`);
}

// -----------------------------------------------------------------------------
// 1단계 ➔ 2단계: 데이터 진단 (/inspect)
// -----------------------------------------------------------------------------
async function handleInspect() {
    const sido = document.getElementById('select-sido').value.trim();
    const sigungu = document.getElementById('select-sigungu').value.trim();
    const industry = document.getElementById('select-industry').value.trim();

    if (!sido) {
        showUserError('필수 선택값 누락: 분석할 시·도를 선택해 주세요.');
        return;
    }
    if (!industry) {
        showUserError('필수 선택값 누락: 분석할 업종을 선택해 주세요.');
        return;
    }

    window.APP_STATE.selected = { sido, sigungu: sigungu || '전체', industry };
    logMessage('INFO', 'POST /inspect 요청 시작', window.APP_STATE.selected);
    showLoading(`[${sido} ${sigungu} - ${industry}] 데이터 상태 진단 중...`);

    try {
        const res = await fetch('/inspect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(window.APP_STATE.selected)
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || '데이터 진단에 실패했습니다.');
        }

        window.APP_STATE.diagnosis = data;
        logMessage('INFO', '진단 결과 성공 수신', data);

        // 2단계 섹션 렌더링
        renderDiagnosisSection(data);

        // 후속 단계 섹션 숨기기 (새 진단 시)
        document.getElementById('suggest-section').classList.add('hidden');
        document.getElementById('run-section').classList.add('hidden');
        document.getElementById('report-section').classList.add('hidden');

    } catch (err) {
        showUserError('데이터 진단 오류: ' + err.message);
    } finally {
        hideLoading();
    }
}

function renderDiagnosisSection(data) {
    const inspectSec = document.getElementById('inspect-section');
    inspectSec.classList.remove('hidden');

    // 조건 태그
    const sel = data.selected_conditions;
    document.getElementById('inspect-condition-tag').textContent = `${sel.sido} ${sel.sigungu} · ${sel.industry}`;

    // 요약 메트릭
    document.getElementById('metric-rows').textContent = `${data.shape.rows.toLocaleString()}행`;
    document.getElementById('metric-cols').textContent = `${data.shape.cols}개 열 (숫자형 ${data.column_types.numeric.length}개)`;

    const agg = data.aggregated_comparison;
    document.getElementById('metric-local-stores').textContent = `${agg.local_total_stores.toLocaleString()}개`;
    document.getElementById('metric-share').textContent = `전국 대비 ${agg.local_share_pct}%`;
    document.getElementById('metric-national-stores').textContent = `${agg.national_total_stores.toLocaleString()}개`;

    document.getElementById('metric-missing').textContent = `${data.missing_values.missing_ratio_pct}%`;
    document.getElementById('metric-missing-count').textContent = `${data.missing_values.total_missing}건 누락`;

    // 경고 박스
    const warnBox = document.getElementById('inspect-warnings');
    if (data.warnings && data.warnings.length > 0) {
        warnBox.innerHTML = `<strong>⚠️ 데이터 진단 경고 (${data.warnings.length}건):</strong><br>` + 
            data.warnings.map(w => `• ${w}`).join('<br>');
        warnBox.classList.remove('hidden');
    } else {
        warnBox.classList.add('hidden');
    }

    // 미리보기 테이블 렌더링
    renderPreviewTable(data.preview_rows);

    // 스크롤 이동
    inspectSec.scrollIntoView({ behavior: 'smooth' });
}

function renderPreviewTable(rows) {
    const thead = document.querySelector('#preview-table thead');
    const tbody = document.querySelector('#preview-table tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="100%">미리보기 데이터가 없습니다.</td></tr>';
        return;
    }

    const headers = Object.keys(rows[0]);
    const trHead = document.createElement('tr');
    headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);

    rows.forEach(r => {
        const tr = document.createElement('tr');
        headers.forEach(h => {
            const td = document.createElement('td');
            const val = r[h];
            td.textContent = (val !== null && val !== undefined) ? val : '-';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

// -----------------------------------------------------------------------------
// 2단계 ➔ 3단계: 도구 추천 (/suggest)
// -----------------------------------------------------------------------------
async function handleSuggest() {
    if (!window.APP_STATE.diagnosis) {
        showUserError('먼저 데이터 진단을 완료해 주세요.');
        return;
    }

    logMessage('INFO', 'POST /suggest 요청 시작 (Gemini 도구 추천)');
    showLoading('Gemini가 최적의 분석 도구를 선별하고 있습니다...');

    try {
        const res = await fetch('/suggest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ diagnosis: window.APP_STATE.diagnosis })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || '도구 추천에 실패했습니다.');
        }

        window.APP_STATE.suggestions = data.suggested_tools;
        logMessage('INFO', '추천 도구 목록 수신', data.suggested_tools);

        // 3단계 섹션 렌더링
        renderSuggestSection(data.suggested_tools);

    } catch (err) {
        showUserError('Gemini 도구 제안 오류: ' + err.message);
    } finally {
        hideLoading();
    }
}

function renderSuggestSection(tools) {
    const suggestSec = document.getElementById('suggest-section');
    suggestSec.classList.remove('hidden');

    const container = document.getElementById('suggested-tools-container');
    container.innerHTML = '';

    tools.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'tool-card';
        card.innerHTML = `
            <div>
                <div class="tool-card-title">${t.tool_name || t.tool_id}</div>
                <div class="tool-card-reason"><strong>AI 추천 이유:</strong> ${t.reason || '상권 분석 필수 지표'}</div>
            </div>
            <div class="tool-card-action">
                <button class="btn btn-primary" style="width: 100%;" onclick="executeTool('${t.tool_id}')">
                    ▶ 이 도구로 분석 실행 (/run)
                </button>
            </div>
        `;
        container.appendChild(card);
    });

    suggestSec.scrollIntoView({ behavior: 'smooth' });
}

// -----------------------------------------------------------------------------
// 3단계 ➔ 4단계: 도구 실행 (/run - Pandas 전담 연산 및 차트 시각화)
// -----------------------------------------------------------------------------
async function executeTool(toolId) {
    const sel = window.APP_STATE.selected;
    logMessage('INFO', `POST /run 요청: 도구 ID [${toolId}] 실행 시작`, sel);
    showLoading(`Pandas가 [${toolId}] 데이터를 정밀 계산 중입니다...`);

    try {
        const res = await fetch('/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tool_id: toolId,
                sido: sel.sido,
                sigungu: sel.sigungu,
                industry: sel.industry,
                base_period: '당월',
                exclude_aggregated: true
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || '도구 실행 및 계산에 실패했습니다.');
        }

        window.APP_STATE.current_run = {
            tool_id: toolId,
            result: data.result
        };
        logMessage('INFO', 'Pandas 연산 완료 결과 수신', data.result);

        // 4단계 시각화 렌더링
        renderRunSection(data.result);

        // 5단계 리포트 섹션 숨기기 (새 실행 시)
        document.getElementById('report-section').classList.add('hidden');

    } catch (err) {
        showUserError('도구 실행 오류: ' + err.message);
    } finally {
        hideLoading();
    }
}

function renderRunSection(result) {
    const runSec = document.getElementById('run-section');
    runSec.classList.remove('hidden');

    // 메타 정보 헤더
    document.getElementById('run-tool-title').textContent = `4단계: ${result.tool_name} (/run)`;
    document.getElementById('run-base-period').textContent = `기준 시점: ${result.base_period}`;
    document.getElementById('run-sample-rows').textContent = `사용한 행 수: ${result.used_rows.toLocaleString()}행`;
    document.getElementById('run-excluded-rows').textContent = `제외 행 수: ${result.excluded_rows.toLocaleString()}행 (${result.exclusion_reason || '조건 외 분리'})`;

    // 요약 지표 박스
    const summaryBox = document.getElementById('run-summary-box');
    summaryBox.innerHTML = '';
    if (result.summary_metrics) {
        Object.entries(result.summary_metrics).forEach(([k, v]) => {
            const item = document.createElement('div');
            item.className = 'summary-item';
            item.innerHTML = `<strong>${k.replace(/_/g, ' ')}:</strong> ${v}`;
            summaryBox.appendChild(item);
        });
    }

    // 차트 렌더링
    renderChart(result.chart_data);

    // 상세 데이터 테이블 렌더링
    renderRunTable(result.table_data);

    // 주의사항 박스
    const notesBox = document.getElementById('run-notes-box');
    if (result.notes && result.notes.length > 0) {
        notesBox.innerHTML = '<strong>📌 분석 유의사항:</strong><br>' + result.notes.map(n => `• ${n}`).join('<br>');
        notesBox.classList.remove('hidden');
    } else {
        notesBox.classList.add('hidden');
    }

    runSec.scrollIntoView({ behavior: 'smooth' });
}

// Chart.js 렌더링 헬퍼
function renderChart(chartData) {
    const canvas = document.getElementById('resultChart');
    if (!canvas) return;

    // 기존 차트 파괴 (캔버스 재사용 오류 방지)
    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }

    if (!chartData) {
        logMessage('WARN', '차트 데이터가 없습니다.');
        return;
    }

    const ctx = canvas.getContext('2d');
    const chartType = chartData.type || 'bar';

    const config = {
        type: chartType,
        data: {
            labels: chartData.labels || [],
            datasets: chartData.datasets || []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    enabled: true
                }
            }
        }
    };

    // 산점도나 숫자형 축 보정
    if (chartType === 'scatter') {
        config.options.scales = {
            x: {
                type: 'linear',
                position: 'bottom',
                title: { display: true, text: '소득 수준 (원)' }
            },
            y: {
                title: { display: true, text: '점포 수 (개)' }
            }
        };
    }

    currentChart = new Chart(ctx, config);
    logMessage('INFO', `Chart.js [${chartType}] 차트 렌더링 완료`);
}

function renderRunTable(tableData) {
    const thead = document.querySelector('#run-data-table thead');
    const tbody = document.querySelector('#run-data-table tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    if (!tableData || tableData.length === 0) {
        tbody.innerHTML = '<tr><td>표시할 계산 표 데이터가 없습니다.</td></tr>';
        return;
    }

    const headers = Object.keys(tableData[0]);
    const trHead = document.createElement('tr');
    headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        trHead.appendChild(th);
    });
    thead.appendChild(trHead);

    tableData.forEach(r => {
        const tr = document.createElement('tr');
        headers.forEach(h => {
            const td = document.createElement('td');
            const val = r[h];
            td.textContent = (val !== null && val !== undefined) ? val : '-';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

// -----------------------------------------------------------------------------
// 4단계 ➔ 5단계: Gemini 보고서 생성 (/explain)
// -----------------------------------------------------------------------------
async function handleExplain() {
    const runState = window.APP_STATE.current_run;
    if (!runState || !runState.result) {
        showUserError('먼저 도구 실행(계산)을 완료해 주세요.');
        return;
    }

    // 라디오 버튼 선택된 모드 (A: 비교용, B: 정식)
    const modeEl = document.querySelector('input[name="explain-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'B';

    logMessage('INFO', `POST /explain 요청 시작 (모드 ${mode})`);
    showLoading(`Gemini가 [모드 ${mode}] 전략 보고서를 작성하고 있습니다...`);

    try {
        const res = await fetch('/explain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: mode,
                diagnosis: window.APP_STATE.diagnosis,
                calculation_result: runState.result
            })
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || '보고서 생성에 실패했습니다.');
        }

        window.APP_STATE.latest_report = data;
        logMessage('INFO', `보고서 수신 완료 (${data.report.length}자)`);

        // 5단계 섹션 렌더링
        renderReportSection(data.report, mode);

    } catch (err) {
        showUserError('Gemini 보고서 생성 오류: ' + err.message);
    } finally {
        hideLoading();
    }
}

function renderReportSection(reportMarkdown, mode) {
    const reportSec = document.getElementById('report-section');
    reportSec.classList.remove('hidden');

    const modeTag = document.getElementById('report-mode-tag');
    if (mode === 'A') {
        modeTag.textContent = '모드 A (비교용: 계산 결과 미제공)';
        modeTag.style.background = '#fef3c7';
        modeTag.style.color = '#b45309';
    } else {
        modeTag.textContent = '모드 B (정식: Pandas 정밀 수치 검증 완료)';
        modeTag.style.background = '#dcfce7';
        modeTag.style.color = '#15803d';
    }

    const contentDiv = document.getElementById('report-content');
    contentDiv.innerHTML = parseMarkdownToHtml(reportMarkdown);

    reportSec.scrollIntoView({ behavior: 'smooth' });
}

// -----------------------------------------------------------------------------
// 디버그 및 에러 상태 복사 기능 (AI 디버깅 도우미)
// -----------------------------------------------------------------------------
function copyDebugState() {
    const statePayload = {
        app_version: "Startup Market Navigator 1.0",
        timestamp: new Date().toISOString(),
        server_status: window.APP_STATE.server,
        selected_conditions: window.APP_STATE.selected,
        diagnosis_summary: window.APP_STATE.diagnosis ? {
            shape: window.APP_STATE.diagnosis.shape,
            missing: window.APP_STATE.diagnosis.missing_values,
            warnings: window.APP_STATE.diagnosis.warnings
        } : null,
        current_tool: window.APP_STATE.current_run.tool_id,
        current_metrics: window.APP_STATE.current_run.result ? window.APP_STATE.current_run.result.summary_metrics : null,
        recent_logs: window.APP_STATE.logs.slice(-20)
    };

    const textToCopy = "```json\n" + JSON.stringify(statePayload, null, 2) + "\n```";

    navigator.clipboard.writeText(textToCopy).then(() => {
        alert('📋 현재 상태 및 디버그 로그가 클립보드에 복사되었습니다!\n오류 발생 시 AI 채팅창에 그대로 붙여넣기(Ctrl+V)하세요.');
        logMessage('INFO', '디버그 상태 클립보드 복사 완료');
    }).catch(err => {
        logMessage('ERROR', '클립보드 복사 실패', err);
        prompt('아래 텍스트를 복사하세요:', textToCopy);
    });
}

// 초기화
function resetAll() {
    if (currentChart) {
        currentChart.destroy();
        currentChart = null;
    }
    window.APP_STATE.diagnosis = null;
    window.APP_STATE.suggestions = [];
    window.APP_STATE.current_run = { tool_id: '', result: null };
    window.APP_STATE.latest_report = null;

    document.getElementById('inspect-section').classList.add('hidden');
    document.getElementById('suggest-section').classList.add('hidden');
    document.getElementById('run-section').classList.add('hidden');
    document.getElementById('report-section').classList.add('hidden');

    logMessage('INFO', '분석 상태 초기화 완료');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 전역 함수 노출 (인라인 onclick 지원)
window.executeTool = executeTool;
