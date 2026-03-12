document.addEventListener('DOMContentLoaded', () => {
    const csvFileInput = document.getElementById('csvFileInput');
    const fileChosenText = document.getElementById('fileChosenText');
    const btnDownloadTemplate = document.getElementById('btnDownloadTemplate');
    const btnStartAutoAssign = document.getElementById('btnStartAutoAssign');
    const btnPauseResume = document.getElementById('btnPauseResume');
    const btnStop = document.getElementById('btnStop');
    const btnResetFile = document.getElementById('btnResetFile');
    const statusMessage = document.getElementById('statusMessage');
    const progressText = document.getElementById('progressText');
    const progressBar = document.getElementById('progressBar');
    const pageStatusBanner = document.getElementById('pageStatusBanner');
    const pageStatusIcon = document.getElementById('pageStatusIcon');
    const pageStatusText = document.getElementById('pageStatusText');
    const logContainer = document.getElementById('logContainer');
    const btnClearLog = document.getElementById('btnClearLog');
    // Summary elements
    const summaryCard = document.getElementById('summaryCard');
    const statSuccess = document.getElementById('statSuccess');
    const statFail = document.getElementById('statFail');
    const statPending = document.getElementById('statPending');
    const statByNumber = document.getElementById('statByNumber');
    const failedListWrapper = document.getElementById('failedListWrapper');
    const failedList = document.getElementById('failedList');
    const numberMatchWrapper = document.getElementById('numberMatchWrapper');
    const numberMatchList = document.getElementById('numberMatchList');
    const toggleSort = document.getElementById('toggleSort');
    const toggleWakeLock = document.getElementById('toggleWakeLock');

    let parsedData = [];
    let isPaused = false;

    // 작업 통계 추적
    let stats = { success: 0, fail: 0, pending: 0, byNumber: 0 };
    let failedItems = [];      // { name, club, grade, cls, error }
    let numberMatchItems = []; // { name, number, club, grade, cls }

    // === 페이지 검증 ===
    checkCurrentPage();

    async function checkCurrentPage() {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length === 0) { setPageStatus('error', '❌', '활성 탭을 찾을 수 없습니다.'); return; }
            const tab = tabs[0];
            if (!tab.url) { setPageStatus('warning', '⚠️', '페이지 URL을 확인할 수 없습니다.'); return; }
            if (!tab.url.includes('neis.go.kr')) {
                setPageStatus('error', '❌', '나이스(NEIS) 사이트가 아닙니다.');
                return;
            }
            chrome.tabs.sendMessage(tab.id, { action: 'checkPage' }, (response) => {
                if (chrome.runtime.lastError) {
                    setPageStatus('warning', '⚠️', '나이스 페이지를 새로고침 해주세요.');
                    return;
                }
                if (response && response.isClubPage) {
                    setPageStatus('success', '✅', '동아리 부서배정 화면 연결됨');
                } else {
                    setPageStatus('warning', '⚠️', '부서배정 탭을 열어주세요.');
                }
            });
        } catch(e) {
            setPageStatus('error', '❌', '페이지 확인 실패');
        }
    }

    function setPageStatus(type, icon, text) {
        pageStatusBanner.className = `banner banner-${type}`;
        pageStatusIcon.textContent = icon;
        pageStatusText.textContent = text;
    }

    // === 로그 기능 ===
    function addLog(type, text) {
        const empty = logContainer.querySelector('.log-empty');
        if (empty) empty.remove();
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        const icons = { success: '✅', error: '❌', info: 'ℹ️', number: '🔢' };
        const now = new Date();
        const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
        entry.innerHTML = `
            <span class="log-icon">${icons[type] || 'ℹ️'}</span>
            <span class="log-text">${text}</span>
            <span class="log-time">${time}</span>
        `;
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    btnClearLog.addEventListener('click', () => {
        logContainer.innerHTML = '<div class="log-empty">배정을 시작하면 여기에 결과가 표시됩니다.</div>';
    });

    // === CSV 템플릿 다운로드 (번호 열 추가) ===
    btnDownloadTemplate.addEventListener('click', () => {
        const header = ["학년", "반", "번호", "이름", "동아리명", "부서구분"];
        const sampleRow = ["1", "3", "15", "홍길동", "농구1-A", "동아리활동"];
        const csvContent = header.join(",") + "\n" + sampleRow.join(",");
        
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute("download", "나이스_동아리_배정양식.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        addLog('info', 'CSV 템플릿 다운로드 완료');
    });

    // === 파일 초기화 ===
    btnResetFile.addEventListener('click', () => {
        resetState();
        addLog('info', '파일 초기화됨');
    });

    // === CSV 파일 업로드 및 파싱 ===
    csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) { resetState(); return; }

        fileChosenText.textContent = file.name;
        btnResetFile.style.display = 'block';
        setStatus('파일 읽는 중...', 'var(--text-muted)');
        btnStartAutoAssign.disabled = true;

        const reader = new FileReader();
        reader.onload = function(event) {
            const text = event.target.result;
            if (text.includes('\ufffd') || text.includes('ï¿½')) {
                const euckrReader = new FileReader();
                euckrReader.onload = function(e2) { parseCSV(e2.target.result); };
                euckrReader.readAsText(file, "EUC-KR");
            } else {
                parseCSV(text);
            }
        };
        reader.readAsText(file, "UTF-8");

        function parseCSV(csvString) {
            setStatus('파일 파싱 중...', 'var(--text-muted)');
            Papa.parse(csvString, {
                header: true,
                skipEmptyLines: true,
                complete: function(results) {
                    const data = results.data;
                    const { formattedData, isError, errorMsg } = formatParsedData(data);
                    
                    if (isError) {
                        setStatus('데이터 양식 오류', 'var(--error)');
                        addLog('error', errorMsg);
                        progressText.textContent = `0 명`;
                        btnStartAutoAssign.disabled = true;
                        return;
                    }

                    if (formattedData.length > 0) {
                        parsedData = formattedData;
                        setStatus('CSV 로드 완료', 'var(--primary)');
                        progressText.textContent = `총 ${parsedData.length} 명의 데이터 확인됨`;
                        btnStartAutoAssign.disabled = false;
                        addLog('success', `${file.name} 로드 완료 (${parsedData.length}명)`);
                    } else {
                        setStatus('유효한 데이터 없음', 'var(--error)');
                        progressText.textContent = `0 명`;
                    }
                },
                error: function(err) {
                    setStatus('CSV 파싱 오류', 'var(--error)');
                    addLog('error', 'CSV 파싱 실패: ' + err.message);
                }
            });
        }
    });

    // === 데이터 정제 (번호 열 포함) ===
    function formatParsedData(flatData) {
        const formatted = [];
        if (flatData.length === 0) {
            return { formattedData: [], isError: true, errorMsg: "데이터가 비어있습니다." };
        }
        const sampleRow = flatData[0];
        const hasValidHeaders = ('학년' in sampleRow) && ('반' in sampleRow) && 
                              (('이름' in sampleRow) || ('학생이름' in sampleRow) || ('성명' in sampleRow)) &&
                              (('동아리명' in sampleRow) || ('동아리' in sampleRow) || ('부서명' in sampleRow) || ('부서' in sampleRow));
        if (!hasValidHeaders) {
            return { 
                formattedData: [], isError: true, 
                errorMsg: "CSV 헤더 양식 불일치. '학년', '반', '이름', '동아리명' 열이 필요합니다." 
            };
        }

        flatData.forEach((row) => {
            const grade = row['학년'] || '';
            const cls = row['반'] || '';
            const name = row['이름'] || row['학생이름'] || row['성명'] || '';
            const club = row['동아리명'] || row['동아리'] || row['부서명'] || row['부서'] || '';
            const number = row['번호'] || row['출석번호'] || '';
            const clubCategory = row['부서구분'] || row['동아리구분'] || '';
            if (grade && cls && name && club) {
                formatted.push({ 
                    grade: grade.toString().trim(), 
                    cls: cls.toString().trim(), 
                    name: name.trim(), 
                    club: club.trim(),
                    number: number.toString().trim(),
                    clubCategory: clubCategory.trim()
                });
            }
        });
        
        if (formatted.length === 0) {
            return { formattedData: [], isError: true, errorMsg: "유효한 학생 데이터가 없습니다." };
        }
        return { formattedData: formatted, isError: false, errorMsg: "" };
    }

    // === 통계 초기화 ===
    function resetStats() {
        stats = { success: 0, fail: 0, pending: 0, byNumber: 0 };
        failedItems = [];
        numberMatchItems = [];
        summaryCard.style.display = 'none';
    }

    // === 통계 요약 표시 ===
    function showSummary(total, processedCount) {
        stats.pending = total - processedCount;
        statSuccess.textContent = stats.success;
        statFail.textContent = stats.fail;
        statPending.textContent = stats.pending;
        statByNumber.textContent = stats.byNumber;

        // 실패 목록
        if (failedItems.length > 0) {
            failedListWrapper.style.display = 'block';
            failedList.innerHTML = failedItems.map(item => `
                <div class="failed-item">
                    <span class="fail-info">${item.grade}학년 ${item.cls}반 ${item.name} → ${item.club}</span>
                    <span class="fail-reason">${item.error}</span>
                </div>
            `).join('');
        } else {
            failedListWrapper.style.display = 'none';
        }

        // 번호 매칭 목록
        if (numberMatchItems.length > 0) {
            numberMatchWrapper.style.display = 'block';
            numberMatchList.innerHTML = numberMatchItems.map(item => `
                <div class="number-item">
                    🔢 ${item.grade}학년 ${item.cls}반 ${item.number}번 (이름: ${item.name}) → ${item.club}
                </div>
            `).join('');
        } else {
            numberMatchWrapper.style.display = 'none';
        }

        summaryCard.style.display = 'block';
    }

    // === 자동 배정 시작 ===
    btnStartAutoAssign.addEventListener('click', async () => {
        if (!parsedData || parsedData.length === 0) return;
        try {
            const activeTab = await getActiveTab();
            if (!activeTab) return;

            setStatus('자동 배정 시작...', 'var(--primary)');
            progressBar.style.width = '0%';
            resetStats();
            
            // 정렬 옵션 적용
            let dataToSend = [...parsedData];
            if (toggleSort.checked) {
                dataToSend.sort((a, b) => {
                    const gradeA = parseInt(a.grade) || 0;
                    const gradeB = parseInt(b.grade) || 0;
                    if (gradeA !== gradeB) return gradeA - gradeB;
                    const clsA = parseInt(a.cls) || 0;
                    const clsB = parseInt(b.cls) || 0;
                    if (clsA !== clsB) return clsA - clsB;
                    const numA = parseInt(a.number) || 0;
                    const numB = parseInt(b.number) || 0;
                    return numA - numB;
                });
                addLog('info', '📊 학년·반·번호 순 정렬 적용됨');
            }
            
            btnStartAutoAssign.style.display = 'none';
            btnPauseResume.style.display = 'block';
            btnStop.style.display = 'block';
            btnPauseResume.textContent = '⏸ 일시정지';
            isPaused = false;

            addLog('info', `배정 시작 (총 ${dataToSend.length}명)`);

            chrome.tabs.sendMessage(activeTab.id, { 
                action: 'startAssignment', data: dataToSend, useWakeLock: toggleWakeLock.checked 
            }, handleResponse);
        } catch (err) {
            handleError(err);
        }
    });

    btnPauseResume.addEventListener('click', async () => {
        const activeTab = await getActiveTab();
        if (!activeTab) return;
        isPaused = !isPaused;
        btnPauseResume.textContent = isPaused ? '▶️ 계속하기' : '⏸ 일시정지';
        setStatus(isPaused ? '일시정지 대기 중...' : '다시 시작하는 중...', 'var(--primary)');
        addLog('info', isPaused ? '일시정지됨' : '재개됨');
        chrome.tabs.sendMessage(activeTab.id, { action: isPaused ? 'pauseAssignment' : 'resumeAssignment' });
    });

    btnStop.addEventListener('click', async () => {
        const activeTab = await getActiveTab();
        if (!activeTab) return;
        setStatus('정지 요청...', 'var(--error)');
        chrome.tabs.sendMessage(activeTab.id, { action: 'stopAssignment' });
        addLog('error', '사용자에 의해 작업 중지됨');
        resetUIButtons();
    });

    async function getActiveTab() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) throw new Error("활성 탭 없음");
        const activeTab = tabs[0];
        if (!activeTab.url || !activeTab.url.includes("neis.go.kr")) {
             addLog('error', '나이스(NEIS) 사이트에서 실행해주세요.');
             return null;
        }
        return activeTab;
    }

    function handleResponse(response) {
        if (chrome.runtime.lastError) {
            addLog('error', '나이스 페이지와 연결 실패. 새로고침 후 재시도해주세요.');
            setStatus('연결 실패', 'var(--error)');
            resetUIButtons();
            return;
        }
        if (response && response.success) {
            setStatus('작업 진행 중...', 'var(--success)');
        } else {
            setStatus('에러 발생', 'var(--error)');
            addLog('error', '처리 에러: ' + (response ? response.error : '알 수 없음'));
            resetUIButtons();
        }
    }

    function handleError(err) {
        console.error(err);
        setStatus('실행 실패', 'var(--error)');
        addLog('error', err.message);
        resetUIButtons();
    }

    function resetUIButtons() {
        btnStartAutoAssign.style.display = 'block';
        btnStartAutoAssign.disabled = false;
        btnPauseResume.style.display = 'none';
        btnStop.style.display = 'none';
        isPaused = false;
    }

    function setStatus(msg, color) {
        statusMessage.textContent = msg;
        statusMessage.style.color = color;
    }

    function resetState() {
        fileChosenText.textContent = "파일을 선택하거나 드래그하세요";
        csvFileInput.value = '';
        parsedData = [];
        progressText.textContent = "0 / 0 명";
        setStatus("대기 중...", "var(--primary)");
        progressBar.style.width = '0%';
        resetUIButtons();
        resetStats();
        btnStartAutoAssign.disabled = true;
        btnResetFile.style.display = 'none';
    }
    
    // === Content script로부터의 메시지 수신 ===
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'updateProgress') {
            const { current, total, name } = request;
            progressText.textContent = `[${current}/${total}] ${name}`;
            const pct = Math.round((current / total) * 100);
            progressBar.style.width = `${pct}%`;
            if (!isPaused) setStatus(`진행 중... (${pct}%)`, 'var(--primary)');
        } else if (request.action === 'assignResult') {
            const { name, club, success, error, matchedByNumber, number, grade, cls } = request;
            if (success) {
                stats.success++;
                if (matchedByNumber) {
                    stats.byNumber++;
                    numberMatchItems.push({ name, number, club, grade, cls });
                    addLog('number', `${grade}-${cls} ${number}번(${name}) → ${club} [번호매칭]`);
                } else {
                    addLog('success', `${name} → ${club}`);
                }
            } else {
                stats.fail++;
                failedItems.push({ name, club, grade, cls, error: error || '알 수 없음' });
                addLog('error', `${name} → ${club} 실패: ${error || '알 수 없음'}`);
            }
        } else if (request.action === 'jobComplete') {
            const total = request.total;
            progressText.textContent = `총 ${total} 명 처리 완료`;
            progressBar.style.width = '100%';
            setStatus('🎉 모든 배정 완료!', 'var(--success)');
            addLog('success', `전체 ${total}명 배정 완료!`);
            showSummary(total, total);
            resetUIButtons();
        } else if (request.action === 'jobError') {
            setStatus('작업 중지됨', 'var(--error)');
            addLog('error', request.error);
            resetUIButtons();
        } else if (request.action === 'jobPaused') {
             setStatus('일시정지 됨', 'var(--text-muted)');
        } else if (request.action === 'jobStopped') {
             setStatus('작업 강제 종료됨', 'var(--error)');
             showSummary(parsedData.length, stats.success + stats.fail);
             resetUIButtons();
        }
    });

    // 탭 전환 시 페이지 상태 재확인
    chrome.tabs.onActivated.addListener(() => { checkCurrentPage(); });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.status === 'complete') checkCurrentPage();
    });
});
