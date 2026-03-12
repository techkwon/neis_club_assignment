document.addEventListener('DOMContentLoaded', () => {
    const csvFileInput = document.getElementById('csvFileInput');
    const fileChosenText = document.getElementById('fileChosenText');
    const btnDownloadTemplate = document.getElementById('btnDownloadTemplate');
    const btnStartAutoAssign = document.getElementById('btnStartAutoAssign');
    const btnPauseResume = document.getElementById('btnPauseResume');
    const btnStop = document.getElementById('btnStop');
    const statusMessage = document.getElementById('statusMessage');
    const progressText = document.getElementById('progressText');

    let parsedData = []; // 파싱된 전체 데이터 보관
    let isPaused = false;

    // --- 1. CSV 템플릿 다운로드 ---
    btnDownloadTemplate.addEventListener('click', () => {
        const header = ["학년", "반", "이름", "동아리명"];
        const sampleRow = ["1", "3", "홍길동", "농구1-A"];
        const csvContent = header.join(",") + "\n" + sampleRow.join(",");
        
        // UTF-8 BOM을 확실히 추가하여 엑셀에서 한글이 깨지지 않게 함
        const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
        const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement("a");
        link.href = url;
        link.setAttribute("download", "나이스_동아리_배정양식.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    // --- 2. CSV 파일 업로드 및 파싱 (온디바이스) ---
    csvFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) {
            resetState();
            return;
        }

        fileChosenText.textContent = file.name;
        setStatus('파일 읽는 중...', 'var(--text-muted)');
        btnStartAutoAssign.disabled = true;

        // 인코딩 문제(한글 깨짐) 해결을 위한 파일 읽기
        const reader = new FileReader();
        reader.onload = function(event) {
            const text = event.target.result;
            // UTF-8로 읽었을 때 한글이 깨져서 '' (U+FFFD) 가 포함되어 있다면 EUC-KR로 다시 읽기
            if (text.includes('') || text.includes('ï¿½')) {
                const euckrReader = new FileReader();
                euckrReader.onload = function(e2) {
                    parseCSV(e2.target.result);
                };
                euckrReader.readAsText(file, "EUC-KR"); // 엑셀에서 저장된 기본 CSV 대응
            } else {
                parseCSV(text);
            }
        };
        reader.readAsText(file, "UTF-8"); // 우선 UTF-8로 시도

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
                        alert(errorMsg);
                        progressText.textContent = `0 명`;
                        btnStartAutoAssign.disabled = true;
                        return;
                    }

                    if (formattedData.length > 0) {
                        parsedData = formattedData;
                        setStatus('CSV 로드 완료', 'var(--primary)');
                        progressText.textContent = `총 ${parsedData.length} 명의 데이터 확인됨`;
                        btnStartAutoAssign.disabled = false;
                    } else {
                        setStatus('유효한 데이터 없음', 'var(--error)');
                        progressText.textContent = `0 명`;
                    }
                },
                error: function(err) {
                    setStatus('CSV 파싱 오류', 'var(--error)');
                    console.error(err);
                }
            });
        }
    });

    // --- 3. 데이터 정제 ---
    function formatParsedData(flatData) {
        const formatted = [];
        let isError = false;
        let errorMsg = '';

        if (flatData.length === 0) {
            return { formattedData: [], isError: true, errorMsg: "데이터가 비어있습니다." };
        }

        // Check if headers match the template
        const sampleRow = flatData[0];
        const hasValidHeaders = ('학년' in sampleRow) && ('반' in sampleRow) && 
                              (('이름' in sampleRow) || ('학생이름' in sampleRow) || ('성명' in sampleRow)) &&
                              (('동아리명' in sampleRow) || ('동아리' in sampleRow) || ('부서명' in sampleRow) || ('부서' in sampleRow));

        if (!hasValidHeaders) {
            return { 
                formattedData: [], 
                isError: true, 
                errorMsg: "CSV 파일의 1번째 줄(헤더) 양식이 맞지 않습니다.\n'학년', '반', '이름', '동아리명' 열이 모두 포함되어 있는지 확인해주세요." 
            };
        }

        flatData.forEach((row, index) => {
            // 다양한 헤더명 가능성 대응
            const grade = row['학년'] || '';
            const cls = row['반'] || '';
            const name = row['이름'] || row['학생이름'] || row['성명'] || '';
            const club = row['동아리명'] || row['동아리'] || row['부서명'] || row['부서'] || '';

            if (grade && cls && name && club) {
                formatted.push({ 
                    grade: grade.toString().trim(), 
                    cls: cls.toString().trim(), 
                    name: name.trim(), 
                    club: club.trim() 
                });
            } else {
                console.warn(`Row ${index + 2} skipped due to missing data:`, row);
            }
        });
        
        if (formatted.length === 0) {
            return { formattedData: [], isError: true, errorMsg: "양식은 맞으나 배정할 유효한 학생 데이터가 없습니다." };
        }

        return { formattedData: formatted, isError: false, errorMsg: "" };
    }

    // --- 4. Content Script로 메시지 전송 (자동 배정 시작) ---
    btnStartAutoAssign.addEventListener('click', async () => {
        if (!parsedData || parsedData.length === 0) return;

        try {
            const activeTab = await getActiveTab();
            if (!activeTab) return;

            setStatus('자동 배정 시작 요청 중...', 'var(--primary)');
            
            // UI Update
            btnStartAutoAssign.style.display = 'none';
            btnPauseResume.style.display = 'block';
            btnStop.style.display = 'block';
            btnPauseResume.textContent = '일시정지';
            isPaused = false;

            chrome.tabs.sendMessage(activeTab.id, { 
                action: 'startAssignment', 
                data: parsedData 
            }, handleResponse);
            
        } catch (err) {
            handleError(err);
        }
    });

    btnPauseResume.addEventListener('click', async () => {
        const activeTab = await getActiveTab();
        if (!activeTab) return;

        isPaused = !isPaused;
        btnPauseResume.textContent = isPaused ? '▶️ 계속하기' : '일시정지';
        setStatus(isPaused ? '일시정지 대기 중...' : '다시 시작하는 중...', 'var(--primary)');

        chrome.tabs.sendMessage(activeTab.id, { 
            action: isPaused ? 'pauseAssignment' : 'resumeAssignment'
        });
    });

    btnStop.addEventListener('click', async () => {
        const activeTab = await getActiveTab();
        if (!activeTab) return;

        setStatus('정지 요청 중...', 'var(--error)');
        chrome.tabs.sendMessage(activeTab.id, { action: 'stopAssignment' });
        
        resetUIButtons();
    });

    async function getActiveTab() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) throw new Error("활성화된 탭 없음");
        const activeTab = tabs[0];
        if (!activeTab.url || (!activeTab.url.includes("goe.neis.go.kr") && !activeTab.url.includes("neis.go.kr"))) {
             alert("나이스(NEIS) 사이트의 동아리 배정 화면에서 실행해주세요.");
             return null;
        }
        return activeTab;
    }

    function handleResponse(response) {
        if (chrome.runtime.lastError) {
            console.error("Messaging Error:", chrome.runtime.lastError);
            alert("나이스 화면과 연결되지 않았습니다.\n나이스 화면을 새로고침 한 후 다시 시도해주세요.");
            setStatus('연결 실패', 'var(--error)');
            resetUIButtons();
            return;
        }
        if (response && response.success) {
            setStatus('작업 지시 완료!', 'var(--success)');
        } else {
            setStatus('에러 발생', 'var(--error)');
            alert("처리 중 에러: " + (response ? response.error : "알 수 없음"));
            resetUIButtons();
        }
    }

    function handleError(err) {
        console.error(err);
        setStatus('실행 실패', 'var(--error)');
        resetUIButtons();
    }

    function resetUIButtons() {
        btnStartAutoAssign.style.display = 'block';
        btnStartAutoAssign.disabled = false;
        btnPauseResume.style.display = 'none';
        btnStop.style.display = 'none';
        isPaused = false;
    }

    // --- 유틸리티 ---
    function setStatus(msg, color) {
        statusMessage.textContent = msg;
        statusMessage.style.color = color;
    }

    function resetState() {
        fileChosenText.textContent = "파일을 선택하거나 드래그하세요";
        parsedData = [];
        progressText.textContent = "0 / 0 명";
        setStatus("대기 중...", "var(--primary)");
        resetUIButtons();
        btnStartAutoAssign.disabled = true;
    }
    
    // Content script 로부터의 UI 업데이트 수신용 리스너 (원한다면)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if(request.action === 'updateProgress') {
            const { current, total, name } = request;
            progressText.textContent = `[${current}/${total}] - ${name} 배정 중`;
            if(!isPaused) setStatus('진행 중...', 'var(--primary)');
        } else if (request.action === 'jobComplete') {
            progressText.textContent = `총 ${request.total} 명 처리 완료`;
            setStatus('모든 배정 완료!', 'var(--success)');
            resetUIButtons();
        } else if (request.action === 'jobError') {
            setStatus('작업 중지됨', 'var(--error)');
            alert(request.error);
            resetUIButtons();
        } else if (request.action === 'jobPaused') {
             setStatus('일시정지 됨', 'var(--text-muted)');
        } else if (request.action === 'jobStopped') {
             setStatus('작업 강제 종료됨', 'var(--error)');
             resetUIButtons();
        }
    });

});
