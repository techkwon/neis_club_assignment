// 확장 프로그램 아이콘 클릭 시 사이드바 열기
chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ tabId: tab.id });
});

// 사이드 패널 설정
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
