// 나이스 동아리 배정 전용 Content Script
// 팝업에서 전달받은 CSV 데이터를 바탕으로 화면 DOM을 조작하여 자동 배정을 수행합니다.

if (typeof window.neisClubExtInjected === 'undefined') {
    window.neisClubExtInjected = true;
  
    // 글로벌 제어 변수
    let isPaused = false;
    let isStopped = false;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'startAssignment') {
            const data = request.data;
            if (!data || data.length === 0) {
                sendResponse({ success: false, error: "데이터가 없습니다." });
                return true;
            }
            
            isPaused = false;
            isStopped = false;
            sendResponse({ success: true, message: "배정 시작" });
            processAssignments(data, request.useWakeLock);
            return true;
        } else if (request.action === 'pauseAssignment') {
            isPaused = true;
            chrome.runtime.sendMessage({ action: 'jobPaused' });
        } else if (request.action === 'resumeAssignment') {
            isPaused = false;
        } else if (request.action === 'stopAssignment') {
            isStopped = true;
            isPaused = false;
            chrome.runtime.sendMessage({ action: 'jobStopped' });
        } else if (request.action === 'checkPage') {
            // 부서배정 페이지 여부 확인 (그리드나 콤보박스 존재 여부로 판단)
            const hasCombo = document.querySelector('div[role="combobox"]');
            const hasGrid = document.querySelector('.cl-grid');
            sendResponse({ isClubPage: !!(hasCombo && hasGrid) });
            return true;
        }
    });
  
    // 딜레이용 헬퍼 함수 (일시정지 중지 고려)
    const sleep = async (ms) => {
        for(let i=0; i < ms; i+=100) {
           if(isStopped) break;
           await new Promise(resolve => setTimeout(resolve, 100));
        }
    };

    // 일시정지 대기용 함수
    const checkPause = async () => {
        while(isPaused && !isStopped) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    };
  
    // Wake Lock: 작업 중 화면 꺼짐/절전 방지
    let wakeLock = null;
    async function acquireWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
                console.log('[나이스] Wake Lock 활성화 - 화면 꺼짐 방지');
            }
        } catch(e) {
            console.warn('[나이스] Wake Lock 실패:', e);
        }
    }
    async function releaseWakeLock() {
        if (wakeLock) {
            await wakeLock.release();
            wakeLock = null;
            console.log('[나이스] Wake Lock 해제');
        }
    }

    // 메인 프로세스 로직 (순차 처리)
    async function processAssignments(dataArray, useWakeLock) {
        if (useWakeLock) await acquireWakeLock();
        let currentGrade = null;
        let currentClass = null;

        for (let i = 0; i < dataArray.length; i++) {
            if (isStopped) {
                console.log("작업이 사용자에 의해 중지되었습니다.");
                break;
            }

            await checkPause(); // 매 학생 처리 전 일시정지 상태 확인

            const item = dataArray[i];
            const { grade, cls, name, club, number, clubCategory } = item;

            try {
                chrome.runtime.sendMessage({ 
                    action: 'updateProgress', 
                    current: i + 1, 
                    total: dataArray.length, 
                    name: name 
                });

                // 1. 학년 / 반 변경이 필요한 경우 처리
                if (grade !== currentGrade || cls !== currentClass) {
                    await changeGradeAndClass(grade, cls);
                    if (isStopped) break;
                    
                    currentGrade = grade;
                    currentClass = cls;
                    await sleep(2000); 
                    await checkPause();
                }

                // 2. 학생 선택 (이름 우선 → 번호 폴백)
                let studentSelected = await selectStudent(name);
                let matchedByNumber = false;
                
                if (!studentSelected && number) {
                    // 이름으로 못 찾으면 번호로 시도
                    console.log(`'${name}' 이름 매칭 실패, 번호 ${number}으로 시도...`);
                    studentSelected = await selectStudentByNumber(number);
                    if (studentSelected) matchedByNumber = true;
                }
                
                if (!studentSelected) {
                    console.warn(`학생 '${name}'(번호: ${number || '없음'}) 찾기 실패.`);
                    chrome.runtime.sendMessage({ action: 'assignResult', name, club, grade, cls, success: false, error: '학생 못찾음' });
                    continue;
                }
                
                await sleep(500);
                await checkPause();
                if (isStopped) break;

                // 3. 동아리 선택 (부서구분 포함)
                const clubSelected = await selectClub(club, clubCategory);
                if (!clubSelected) {
                    chrome.runtime.sendMessage({ action: 'assignResult', name, club, grade, cls, success: false, error: '동아리 못찾음' });
                    continue;
                }

                await sleep(500);
                await checkPause();
                if (isStopped) break;

                // 4. 저장 버튼 클릭
                const saveOk = await clickSaveButton();
                if(!saveOk) {
                    chrome.runtime.sendMessage({ action: 'assignResult', name, club, grade, cls, success: false, error: '저장 실패' });
                } else {
                    chrome.runtime.sendMessage({ action: 'assignResult', name, club, grade, cls, success: true, matchedByNumber, number });
                }
                
                await sleep(1500);

            } catch (err) {
                console.error(`Error processing ${name}:`, err);
                chrome.runtime.sendMessage({ action: 'assignResult', name, club, success: false, error: err.toString() });
                chrome.runtime.sendMessage({ action: 'jobError', error: err.toString() });
                return;
            }
        }

        if (!isStopped) {
            chrome.runtime.sendMessage({ action: 'jobComplete', total: dataArray.length });
        }
        await releaseWakeLock(); // 작업 종료 시 Wake Lock 해제
    }
  
    // --- 세부 액션 함수들 ---

    /**
     * 나이스 eXbuilder6 콤보박스 옵션 선택 함수 (검증 완료)
     * @param {string} labelPart "학년" 또는 "반" (aria-label 기준)
     * @param {string} targetText 선택할 값 (예: "1", "2", "3")
     */
    async function selectNeisCombobox(labelPart, targetText) {
        // 1. 기존에 열려있는 팝업을 닫기
        document.body.click();
        await sleep(300);
        if (isStopped) return false;

        // 2. 보이는 콤보박스 중 aria-label이 "학년," 또는 "반,"으로 시작하는 요소 찾기
        const combos = Array.from(document.querySelectorAll('div[role="combobox"]'));
        const combobox = combos.find(el => 
            (el.getAttribute('aria-label') || '').startsWith(labelPart + ',') && el.offsetHeight > 0
        );

        if (!combobox) {
            console.error(`[나이스] ${labelPart} 콤보박스를 찾을 수 없습니다.`);
            return false;
        }

        // 3. 콤보박스 자체를 직접 클릭 (nextElementSibling 사용하지 않음!)
        combobox.click();
        console.log(`[나이스] ${labelPart} 리스트 여는 중...`);
        await sleep(800); // 리스트 렌더링 대기
        if (isStopped) return false;

        // 4. 보이는 .cl-combobox-item 중 텍스트가 일치하는 항목 찾기
        const allItems = Array.from(document.querySelectorAll('.cl-combobox-item'));
        const targetItem = allItems.find(el => 
            el.innerText.trim() === String(targetText).trim() && el.offsetHeight > 0
        );
        
        if (!targetItem) {
            // 폴백: 모든 역할 옵션 요소에서도 찾기
            const fallbackItems = Array.from(document.querySelectorAll('.cl-list-item, div[role="option"]'));
            const fbItem = fallbackItems.find(el => 
                el.innerText.trim() === String(targetText).trim() && el.offsetHeight > 0
            );
            if (fbItem) {
                fbItem.click();
                console.log(`[나이스] ${labelPart} → '${targetText}' (폴백) 변경 성공`);
                await sleep(800);
                return true;
            }
            console.error(`[나이스] ${labelPart}의 옵션 '${targetText}' 찾기 실패`, 
                allItems.filter(e => e.offsetHeight > 0).map(e => e.innerText.trim()));
            document.body.click();
            return false;
        }

        // 5. 항목 직접 클릭
        targetItem.click();
        console.log(`[나이스] ${labelPart} → '${targetText}' 변경 성공!`);
        await sleep(800);
        return true;
    }

    /**
     * 학년과 반 콤보박스를 찾아 변경합니다.
     */
    async function changeGradeAndClass(targetGrade, targetClass) {
        console.log(`학년/반 변경 시도: ${targetGrade}학년 ${targetClass}반`);
        
        // 학년 변경
        await selectNeisCombobox('학년', targetGrade);
        
        // 학년 변경 후 반 목록을 서버에서 불러오는 딜레이 (나이스는 꽤 느릴 수 있음)
        await sleep(1000); 
        if (isStopped) return;
        
        // 조회 버튼 클릭 (학년 바꾼 직후 반 리스트 활성화를 위해 필수적일 수 있음)
        setTimeout(() => {
            const searchBtn = document.querySelector('div[aria-label="조회"]');
            if (searchBtn) searchBtn.click();
        }, 300);
        await sleep(2000); // 명단 갱신 대기

        // 반 변경
        let classSuccess = await selectNeisCombobox('반', targetClass);
        if (!classSuccess) {
            console.log("반 변경 1차 실패, 대기 후 재시도...");
            await sleep(1000);
            await selectNeisCombobox('반', targetClass);
        }
        
        // 최종 조회 클릭
        setTimeout(() => {
            const searchBtn = document.querySelector('div[aria-label="조회"]');
            if (searchBtn) searchBtn.click();
        }, 500);
    }

    /**
     * 학생 목록 그리드에서 학생 이름을 찾아 체크박스를 클릭합니다.
     */
    async function selectStudent(name) {
        // eXbuilder6의 좌측 그리드는 uuid-1j6로 파악되었으나, 변동될 수 있습니다.
        // 좀 더 안전하게 '.cl-grid-row' 들을 전부 뒤져서 '이름'이 있는 부분을 좁혀볼 수 있습니다.
        const grids = document.querySelectorAll('.cl-grid, .cl-control');
        const studentGrid = document.getElementById('uuid-1j6') || Array.from(grids).find(g => g.innerText.includes('성명') || g.innerText.includes('이름'));
        
        if(!studentGrid) {
            console.error("학생 그리드를 찾지 못했습니다.");
            return false;
        }

        const rows = studentGrid.querySelectorAll('.cl-grid-row');
        let targetRow = null;
        for (let r of rows) {
            if (r.innerText.includes(name)) {
                targetRow = r;
                break;
            }
        }

        if (targetRow) {
            const checkbox = targetRow.querySelector('.cl-checkbox-icon') || targetRow.querySelector('.cl-checkbox');
            if (checkbox) {
                // 이미 체크되어 있는지 판단 (나이스는 aria-checked 로 판단)
                const parentCb = checkbox.closest('.cl-checkbox');
                if (parentCb && parentCb.getAttribute('aria-checked') === 'true') {
                    console.log(`학생 ${name}은(는) 이미 선택되어 있습니다.`);
                    return true;
                }

                checkbox.click();
                return true;
            }
        }
        return false;
    }

    /**
     * 학생 목록 그리드에서 번호(출석번호)로 학생을 찾아 체크박스를 클릭합니다.
     * NEIS 그리드 열 순서: [0]체크박스, [1]반, [2]번호, [3]성명, [4]배정수
     */
    async function selectStudentByNumber(number) {
        const grids = document.querySelectorAll('.cl-grid, .cl-control');
        const studentGrid = document.getElementById('uuid-1j6') || Array.from(grids).find(g => g.innerText.includes('성명') || g.innerText.includes('이름'));
        
        if(!studentGrid) {
            console.error("학생 그리드를 찾지 못했습니다.");
            return false;
        }

        const rows = studentGrid.querySelectorAll('.cl-grid-row');
        const targetNum = parseInt(number, 10); // "01" → 1, "15" → 15
        
        if (isNaN(targetNum)) {
            console.error(`유효하지 않은 번호: ${number}`);
            return false;
        }
        
        for (let r of rows) {
            const cells = r.querySelectorAll('.cl-grid-cell');
            // 번호는 인덱스 2번 셀 (0=체크박스, 1=반, 2=번호)
            if (cells.length > 2) {
                const cellText = (cells[2].innerText || '').trim();
                const cellNum = parseInt(cellText, 10);
                if (cellNum === targetNum) {
                    const checkbox = r.querySelector('.cl-checkbox-icon') || r.querySelector('.cl-checkbox');
                    if (checkbox) {
                        const parentCb = checkbox.closest('.cl-checkbox');
                        if (parentCb && parentCb.getAttribute('aria-checked') === 'true') {
                            return true;
                        }
                        checkbox.click();
                        console.log(`[나이스] 번호 ${targetNum}번 학생 선택 성공`);
                        return true;
                    }
                }
            }
        }
        console.warn(`[나이스] 번호 ${targetNum}번 학생을 찾지 못했습니다.`);
        return false;
    }

    /**
     * 동아리 목록 그리드에서 동아리명을 찾아 체크박스를 클릭합니다.
     * NEIS 그리드 열 순서: [0]체크박스, [1]부서구분, [2]부서명, [3]배정학생수
     * clubCategory가 있으면 부서구분도 함께 비교하여 동명 동아리를 구분합니다.
     */
    async function selectClub(clubName, clubCategory) {
        const grids = document.querySelectorAll('.cl-grid, .cl-control');
        const clubGrid = document.getElementById('uuid-1jr') || Array.from(grids).find(g => g.innerText.includes('부서명') || g.innerText.includes('동아리'));
        
        if(!clubGrid) {
            console.error("동아리 그리드를 찾지 못했습니다.");
            return false;
        }

        const rows = clubGrid.querySelectorAll('.cl-grid-row');
        let targetRow = null;
        let candidates = []; // 이름 일치하는 후보 행들
        
        for (let r of rows) {
            const cells = r.querySelectorAll('.cl-grid-cell');
            if (cells.length < 3) continue;
            
            const rowCategory = (cells[1].innerText || '').trim();
            const rowClubName = (cells[2].innerText || '').trim();
            
            if (rowClubName.includes(clubName) || clubName.includes(rowClubName)) {
                candidates.push({ row: r, category: rowCategory, name: rowClubName });
            }
        }
        
        if (candidates.length === 0) {
            console.warn(`동아리 '${clubName}'를 찾을 수 없습니다.`);
            return false;
        }
        
        if (candidates.length === 1) {
            // 후보가 1개면 바로 선택
            targetRow = candidates[0].row;
        } else if (clubCategory) {
            // 동명 동아리가 여러 개일 때 부서구분으로 구분
            const match = candidates.find(c => c.category.includes(clubCategory) || clubCategory.includes(c.category));
            if (match) {
                targetRow = match.row;
                console.log(`[나이스] 동명 동아리 ${candidates.length}개 중 '부서구분: ${clubCategory}'으로 구분 선택`);
            } else {
                // 부서구분으로도 못 찾으면 첫 번째 선택
                targetRow = candidates[0].row;
                console.warn(`[나이스] '부서구분: ${clubCategory}' 일치 없음, 첫 번째 '${candidates[0].name}' 선택`);
            }
        } else {
            // 부서구분 정보 없으면 첫 번째
            targetRow = candidates[0].row;
        }

        if (targetRow) {
            const checkbox = targetRow.querySelector('.cl-checkbox-icon') || targetRow.querySelector('.cl-checkbox');
            if (checkbox) {
                 const parentCb = checkbox.closest('.cl-checkbox');
                 if (parentCb && parentCb.getAttribute('aria-checked') === 'true') {
                     console.log(`동아리 ${clubName}은(는) 이미 선택되어 있습니다.`);
                     return true;
                 }

                checkbox.click();
                return true;
            }
        }
        return false;
    }

    /**
     * 나이스 확인 대화상자의 '확인' 버튼을 클릭합니다.
     */
    async function clickConfirmDialog() {
        const confirmBtns = document.querySelectorAll('.cl-button');
        let confirmBtn = Array.from(confirmBtns).find(btn => 
            (btn.innerText.trim() === '확인' || btn.textContent.trim() === '확인') 
            && btn.offsetWidth > 0
        );
        if (confirmBtn) {
            confirmBtn.click();
            console.log('[나이스] 확인 버튼 클릭 완료');
            return true;
        }
        // 폴백
        const fb = document.querySelector('div[aria-label="확인"]');
        if (fb && fb.offsetHeight > 0) {
            fb.click();
            console.log('[나이스] 확인 버튼 (폴백) 클릭 완료');
            return true;
        }
        return false;
    }

    /**
     * 화면 상단의 '저장' 버튼을 클릭하고, 확인 대화상자도 처리합니다.
     */
    async function clickSaveButton() {
        const btns = document.querySelectorAll('div[aria-label="저장"], .btn-primary, button');
        let saveBtn = Array.from(btns).find(b => 
            b.getAttribute('aria-label') === '저장' || 
            b.innerText.trim() === '저장'
        );

        if (saveBtn) {
            saveBtn.click();
            // 1차: "저장하시겠습니까?" 확인 버튼
            await sleep(500);
            await clickConfirmDialog();
            
            // 2차: "저장이 완료되었습니다." 확인 버튼
            await sleep(1000);
            await clickConfirmDialog();
            
            return true;
        }
        
        console.error("저장 버튼을 찾을 수 없습니다.");
        return false;
    }
}
