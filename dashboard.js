// dashboard.js — 대시보드 WebView 클라이언트 스크립트
// extension.js의 _getHtml()이 vscode-resource: URI로 로드합니다.
// 인라인 <script> 블록 대신 외부 파일로 분리해 VS Code CSP 제한을 우회합니다.

(function () {
  // JS 실행 확인: 실행되면 경고 div 즉시 숨김
  const jsCheck = document.getElementById('jsCheck');
  if (jsCheck) jsCheck.style.display = 'none';

  const vscode = acquireVsCodeApi();

  function refresh() { vscode.postMessage({ type: 'refresh' }); }

  function applyActivityState() {
    const btn = document.getElementById('actMoreBtn');
    const hiddens = document.querySelectorAll('.act-hidden');
    const expanded = (vscode.getState() || {}).actExpanded === true;
    hiddens.forEach(el => { el.style.display = expanded ? 'block' : 'none'; });
    if (btn) {
      const count = Number(btn.dataset.hidden || hiddens.length);
      btn.textContent = expanded ? '▲ 접기' : ('▼ 더 보기 (' + count + '개 더)');
    }
  }

  function toggleActivities() {
    const prev = (vscode.getState() || {});
    vscode.setState(Object.assign({}, prev, { actExpanded: !prev.actExpanded }));
    applyActivityState();
  }

  function toggleGeminiSettings() {
    const p = document.getElementById('geminiPanel');
    if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
  }

  function saveGeminiKey() {
    const key = document.getElementById('geminiKeyInput').value.trim();
    if (!key) { alert('API 키를 입력해 주세요.'); return; }
    vscode.postMessage({ type: 'set_gemini_key', key });
  }

  function geminiResolve(id, question) {
    const gbtn = document.getElementById('gbtn-' + id);
    const status = document.getElementById('gstatus-' + id);
    if (gbtn) { gbtn.disabled = true; gbtn.textContent = '🤖 조사 중...'; }
    if (status) { status.className = 'gemini-status loading'; status.textContent = '⏳ Gemini가 Google 검색으로 조사 중...'; }
    vscode.postMessage({ type: 'gemini_resolve', requestId: id, question });
  }

  function fulfillRequest(id) {
    const el = document.getElementById('req-' + id);
    const response = el ? el.value.trim() : '';
    if (!response) { alert('제공할 자료/결과를 입력하거나 📎 파일을 첨부해 주세요.'); return; }
    vscode.postMessage({ type: 'fulfill_request', requestId: id, response });
    refresh();
  }

  function attachFile(id) { vscode.postMessage({ type: 'open_file_picker', requestId: id }); }

  function dismissRequest(id) {
    vscode.postMessage({ type: 'dismiss_request', requestId: id });
    refresh();
  }

  // 통합 클릭 핸들러 — 모든 버튼을 이벤트 위임으로 처리
  document.addEventListener('click', function (e) {
    const fileRow = e.target.closest('.file-row.clickable');
    if (fileRow && fileRow.dataset.path) {
      vscode.postMessage({ type: 'open_file', path: fileRow.dataset.path });
      return;
    }
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    const id = t.dataset.id;

    switch (action) {
      case 'refresh':                refresh(); break;
      case 'toggle-gemini-settings': toggleGeminiSettings(); break;
      case 'save-gemini-key':        saveGeminiKey(); break;
      case 'open-brain':             vscode.postMessage({ type: 'open_brain' }); break;
      case 'open-folder':            vscode.postMessage({ type: 'open_folder', path: t.dataset.path }); break;
      case 'toggle-activities':      toggleActivities(); break;
      case 'toggle-prompt': {
        const pb = document.getElementById('pb-' + id);
        if (pb) pb.style.display = pb.style.display === 'none' ? 'block' : 'none';
        break;
      }
      case 'copy-prompt': {
        const pt = document.getElementById('pt-' + id);
        const ok = document.getElementById('copy-ok-' + id);
        if (pt) {
          navigator.clipboard.writeText(pt.value).then(() => {
            if (ok) { ok.style.display = 'inline'; setTimeout(() => { ok.style.display = 'none'; }, 2500); }
          }).catch(() => {
            // clipboard API 실패 시 레거시 방식으로 폴백
            pt.select();
            document.execCommand('copy');
            if (ok) { ok.style.display = 'inline'; setTimeout(() => { ok.style.display = 'none'; }, 2500); }
          });
        }
        break;
      }
      case 'gemini':                 geminiResolve(id, t.dataset.question || ''); break;
      case 'attach':                 attachFile(id); break;
      case 'fulfill':                fulfillRequest(id); break;
      case 'dismiss-req':            dismissRequest(id); break;
      case 'approve': {
        const opt = t.dataset.option;
        vscode.postMessage({ type: 'approve_decision', decisionId: t.dataset.decisionId, chosenValue: opt });
        refresh();
        break;
      }
      case 'reject': {
        vscode.postMessage({ type: 'reject_decision', decisionId: t.dataset.decisionId, reason: '' });
        refresh();
        break;
      }
      case 'accept-suggestion': {
        vscode.postMessage({ type: 'accept_suggestion', suggestionId: t.dataset.suggestionId, note: '' });
        refresh();
        break;
      }
      case 'dismiss-suggestion': {
        vscode.postMessage({ type: 'dismiss_suggestion', suggestionId: t.dataset.suggestionId, note: '' });
        refresh();
        break;
      }
    }
  });

  applyActivityState();

  window.addEventListener('message', function (e) {
    const msg = e.data;
    if (msg.type === 'file_loaded') {
      const el = document.getElementById('req-' + msg.requestId);
      if (el) el.value = msg.content;
      const hint = document.getElementById('hint-' + msg.requestId);
      if (hint) hint.textContent = '📎 ' + msg.fileName + ' (' + msg.content.length + '자) 불러옴 — 확인 후 제공하기를 눌러주세요';
    }
    if (msg.type === 'gemini_done') {
      const el = document.getElementById('req-' + msg.requestId);
      if (el) el.value = msg.answer;
      const gbtn = document.getElementById('gbtn-' + msg.requestId);
      if (gbtn) { gbtn.disabled = false; gbtn.textContent = '🤖 Gemini 조사'; }
      const status = document.getElementById('gstatus-' + msg.requestId);
      if (status) { status.className = 'gemini-status done'; status.textContent = '✅ Gemini 조사 완료 — 내용 확인 후 제공하기를 눌러주세요'; }
    }
    if (msg.type === 'gemini_error') {
      const gbtn = document.getElementById('gbtn-' + msg.requestId);
      if (gbtn) { gbtn.disabled = false; gbtn.textContent = '🤖 Gemini 조사'; }
      const status = document.getElementById('gstatus-' + msg.requestId);
      if (status) { status.className = 'gemini-status error'; status.textContent = '❌ ' + msg.error; }
    }
    if (msg.type === 'gemini_key_saved') {
      const m = document.getElementById('geminiSavedMsg');
      if (m) { m.textContent = '✅ 저장됨 (' + msg.masked + ')'; setTimeout(() => { if (m) m.textContent = ''; }, 3000); }
      setTimeout(() => refresh(), 500);
    }
  });
})();
