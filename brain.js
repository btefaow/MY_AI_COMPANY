// ============================================================
//  brain.js — 뇌(Brain) 폴더 관리
//
//  뇌 폴더는 에이전트들의 기억과 회사 정보를 영구 저장하는 공간입니다.
//  VS Code가 꺼졌다가 다시 켜져도 대화 맥락이 유지됩니다.
//
//  폴더 구조:
//   My_AI_Company/my-ai-brain/
//     company/
//       identity.md       ← 회사 이름, 미션, 말투 (사용자가 직접 편집)
//       goals.md          ← 연간/월간 목표 (사용자가 직접 편집)
//     agents/
//       <agentId>/
//         memory.md       ← 에이전트가 대화에서 학습한 내용 (자동 누적)
//     conversations/
//       YYYY-MM-DD.md     ← 일별 대화 로그 (자동 저장)
//
//  이 파일은 파일 I/O만 담당합니다. LLM 호출은 extension.js에서 합니다.
// ============================================================

const fs   = require('fs');
const path = require('path');

// 뇌 폴더 루트 경로
// __dirname = 이 파일(brain.js)이 있는 폴더 → My_AI_Company/my-ai-brain
const BRAIN_DIR = path.join(__dirname, 'my-ai-brain');

// ============================================================
//  initBrain: 뇌 폴더 구조를 초기화합니다
//
//  처음 실행 시 폴더와 기본 파일을 생성합니다.
//  이미 있는 파일은 덮어쓰지 않습니다.
//
//  매개변수:
//   - agentIds: ['ceo', 'developer', ...] — agents.js의 에이전트 ID 목록
// ============================================================
function initBrain(agentIds) {
  // 필요한 디렉토리 일괄 생성 (이미 있으면 무시)
  const dirs = [
    BRAIN_DIR,
    path.join(BRAIN_DIR, 'company'),
    path.join(BRAIN_DIR, 'conversations'),
    ...agentIds.map(id => path.join(BRAIN_DIR, 'agents', id))
  ];
  dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));

  // identity.md — 없을 때만 기본값으로 생성 (사용자가 수정할 파일)
  const identityPath = path.join(BRAIN_DIR, 'company', 'identity.md');
  if (!fs.existsSync(identityPath)) {
    fs.writeFileSync(identityPath, `# 회사 정체성

**회사 이름**: 나의 AI 회사
**미션**: AI를 활용해 1인 기업의 가능성을 무한히 확장한다
**말투**: 전문적이고 친근하게, 항상 한국어로 답한다
**금기사항**: 거짓 정보 제공 금지 / 개인정보 수집 금지

> 이 파일을 자유롭게 수정하세요. 에이전트가 모든 대화에서 참고합니다.
`, 'utf8');
  }

  // goals.md — 없을 때만 기본값으로 생성
  const goalsPath = path.join(BRAIN_DIR, 'company', 'goals.md');
  if (!fs.existsSync(goalsPath)) {
    fs.writeFileSync(goalsPath, `# 회사 목표

## 2026년 연간 목표
- AI 멀티 에이전트 시스템 완성
- 자동화된 콘텐츠 파이프라인 구축
- 해외 시장 진출 기반 마련

## 이번 달 목표
- VS Code 확장 개발 완료
- LM Studio 연동 안정화
- 에이전트별 역할 분담 체계 확립

> 이 파일을 자유롭게 수정하세요. 에이전트가 모든 대화에서 참고합니다.
`, 'utf8');
  }

  // 각 에이전트의 memory.md — 없을 때만 빈 파일 생성
  agentIds.forEach(id => {
    const memPath = path.join(BRAIN_DIR, 'agents', id, 'memory.md');
    if (!fs.existsSync(memPath)) {
      fs.writeFileSync(memPath, `# ${id} 에이전트 메모리\n\n> 대화를 통해 학습한 내용이 여기에 자동으로 기록됩니다.\n`, 'utf8');
    }
  });

  // goals.json — 구조화된 목표(연간/월간/주간/일간) 추적용. 없을 때만 생성
  const goalsJsonPath = path.join(BRAIN_DIR, 'company', 'goals.json');
  if (!fs.existsSync(goalsJsonPath)) {
    fs.writeFileSync(goalsJsonPath, JSON.stringify(
      { annual: [], monthly: [], weekly: [], daily: [] }, null, 2), 'utf8');
  }
}

// ============================================================
//  getCompanyContext: 회사 정체성 + 목표를 문자열로 반환
//
//  LLM 시스템 프롬프트에 주입해서 에이전트가 회사 맥락을 알도록 합니다.
//  파일이 없거나 읽기 실패 시 빈 문자열 반환 (에러 발생 안 함)
// ============================================================
function getCompanyContext() {
  try {
    const identityPath = path.join(BRAIN_DIR, 'company', 'identity.md');
    const goalsPath    = path.join(BRAIN_DIR, 'company', 'goals.md');

    let context = '';
    if (fs.existsSync(identityPath)) {
      context += fs.readFileSync(identityPath, 'utf8').slice(0, 1200);
    }
    if (fs.existsSync(goalsPath)) {
      context += '\n\n' + fs.readFileSync(goalsPath, 'utf8').slice(0, 1200);
    }
    return context.trim();
  } catch {
    return ''; // 파일 읽기 실패 시 조용히 무시
  }
}

// ============================================================
//  getAgentMemory: 에이전트의 memory.md를 읽어서 반환
//
//  LLM 시스템 프롬프트에 주입해서 에이전트가 과거 학습 내용을 기억하도록 합니다.
//  너무 길면 최근 내용만 유지 (최대 2000자)
// ============================================================
function getAgentMemory(agentId) {
  try {
    const memPath = path.join(BRAIN_DIR, 'agents', agentId, 'memory.md');
    if (!fs.existsSync(memPath)) return '';
    const content = fs.readFileSync(memPath, 'utf8');
    // 파일이 길면 끝부분(최근 내용)만 가져옴
    return content.slice(-2000).trim();
  } catch {
    return '';
  }
}

// ============================================================
//  appendAgentMemory: 에이전트 메모리에 새 내용을 추가
//
//  extractAndSaveMemory(extension.js)가 LLM으로 추출한 핵심 사실을
//  타임스탬프와 함께 memory.md에 누적합니다.
// ============================================================
function appendAgentMemory(agentId, content) {
  try {
    const memPath  = path.join(BRAIN_DIR, 'agents', agentId, 'memory.md');
    const existing = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf8') : '';
    fs.writeFileSync(memPath, existing.trimEnd() + '\n\n' + content + '\n', 'utf8');
  } catch {
    // 메모리 저장 실패는 조용히 무시
  }
}

// ============================================================
//  appendConversationLog: 오늘 날짜 대화 로그에 대화 한 쌍을 추가
//
//  conversations/YYYY-MM-DD.md 파일에 누적합니다.
//  파일이 없으면 새로 생성하고, 있으면 뒤에 이어 씁니다.
// ============================================================
function appendConversationLog(agentId, agentName, userText, aiText, summary) {
  try {
    const today   = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const logPath = path.join(BRAIN_DIR, 'conversations', today + '.md');

    // 현재 시각 (시:분)
    const time = new Date().toLocaleTimeString('ko-KR', {
      hour  : '2-digit',
      minute: '2-digit',
      hour12: false
    });

    const lines = ['', `## [${time}] ${agentName}`, ''];
    // ★ 작업 요약(한 문장) — 대시보드 '오늘 활동'에 표시됨
    if (summary) { lines.push(`**요약:** ${summary.slice(0, 200)}`, ''); }
    lines.push(
      `**사용자:** ${userText.slice(0, 500)}`,   // 너무 긴 메시지는 앞부분만
      '',
      `**${agentName}:** ${aiText.slice(0, 1000)}`, // AI 응답도 앞부분만
      '',
      '---'
    );
    const entry = lines.join('\n');

    if (!fs.existsSync(logPath)) {
      // 파일 첫 생성 시 헤더 추가
      fs.writeFileSync(logPath, `# 대화 로그 — ${today}\n${entry}`, 'utf8');
    } else {
      fs.appendFileSync(logPath, entry, 'utf8');
    }
  } catch {
    // 로그 저장 실패는 조용히 무시
  }
}

// ============================================================
//  openBrainDir: OS 파일 탐색기에서 뇌 폴더를 엽니다
//  (extension.js에서 vscode.commands와 함께 사용)
// ============================================================
function getBrainDir() {
  return BRAIN_DIR;
}

// ============================================================
//  getPendingDecisions: 결정 대기 중인 항목 목록 반환
// ============================================================
function getPendingDecisions() {
  try {
    const decisionsDir = path.join(BRAIN_DIR, 'decisions');
    if (!fs.existsSync(decisionsDir)) return [];

    return fs.readdirSync(decisionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const content = fs.readFileSync(path.join(decisionsDir, f), 'utf8');
          return JSON.parse(content);
        } catch { return null; }
      })
      // kind 'request'(사람 도움 요청)는 제외 — 여긴 '결재(선택)'만
      .filter(d => d && d.status === 'waiting' && d.kind !== 'request');
  } catch {
    return [];
  }
}

// ============================================================
//  saveDecision: 새로운 결정 항목 저장 (kind: 'decision')
// ============================================================
function saveDecision(decision) {
  try {
    const decisionsDir = path.join(BRAIN_DIR, 'decisions');
    fs.mkdirSync(decisionsDir, { recursive: true });

    const id = decision.id || Date.now().toString();
    const timestamp = new Date().toISOString();

    const item = {
      id,
      kind: 'decision',  // ★ 결재(선택) — request와 구분
      timestamp,
      status: 'waiting',  // waiting | approved | rejected
      question: decision.question,
      options: decision.options,
      priority: decision.priority || 'medium',  // high | medium | low
      recommended: decision.recommended,
      requestedBy: decision.requestedBy,  // 파트장 | developer 등
      voteResults: decision.voteResults || null,  // ★ C) 에이전트 투표 결과
      chosenBy: null,  // 사용자 선택 시 입력
      chosenValue: null
    };

    fs.writeFileSync(
      path.join(decisionsDir, `${id}.json`),
      JSON.stringify(item, null, 2),
      'utf8'
    );

    return item;
  } catch (err) {
    console.error('결정 저장 실패:', err);
    return null;
  }
}

// ============================================================
//  getApprovedDecisions: 오늘 승인된 결정만 반환
// ============================================================
function getApprovedDecisions() {
  try {
    const decisionsDir = path.join(BRAIN_DIR, 'decisions');
    if (!fs.existsSync(decisionsDir)) return [];

    const today = new Date().toISOString().slice(0, 10);
    return fs.readdirSync(decisionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const content = fs.readFileSync(path.join(decisionsDir, f), 'utf8');
          const item = JSON.parse(content);
          // 오늘 승인된 항목만
          return item.status === 'approved' && item.approvedAt?.startsWith(today) ? item : null;
        } catch { return null; }
      })
      .filter(d => d);
  } catch {
    return [];
  }
}

// ============================================================
//  approveDecision: 결정 항목 승인
// ============================================================
function approveDecision(decisionId, chosenValue) {
  try {
    const decisionsDir = path.join(BRAIN_DIR, 'decisions');
    const filepath = path.join(decisionsDir, `${decisionId}.json`);

    if (!fs.existsSync(filepath)) return null;

    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'approved';
    item.chosenValue = chosenValue;
    item.approvedAt = new Date().toISOString();

    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// ============================================================
//  rejectDecision: 결정 항목 거부
// ============================================================
function rejectDecision(decisionId, reason) {
  try {
    const decisionsDir = path.join(BRAIN_DIR, 'decisions');
    const filepath = path.join(decisionsDir, `${decisionId}.json`);

    if (!fs.existsSync(filepath)) return null;

    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'rejected';
    item.rejectionReason = reason;
    item.rejectedAt = new Date().toISOString();

    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// ============================================================
//  사람 도움 요청 (need_human) — 결재함과 같은 저장소, kind='request'
//
//  결재(decision) = "둘 중 뭘 고를까요?" (선택)
//  요청(request)  = "이건 제가 못 해요, 채워/해주세요" (사람이 자료·작업 제공)
// ============================================================
const REQUEST_TYPES = ['data', 'action', 'file', 'verify'];
const MAX_PENDING_REQUESTS = 5;  // ★ 대표님 처리함에 동시 노출되는 요청 상한

// 에이전트/파트장의 요청은 먼저 'triage'(검토 대기)로 들어간다.
// 파트장이 검토해 중복은 버리고, 중요한 것만 우선순위 매겨 'waiting'으로 승격(escalate).
function saveRequest(req) {
  try {
    const dir = path.join(BRAIN_DIR, 'decisions');
    fs.mkdirSync(dir, { recursive: true });

    const id = req.id || ('req' + Date.now().toString(36) + Math.floor(Math.random() * 100).toString(36));
    const item = {
      id,
      kind: 'request',  // ★ 사람 도움 요청
      timestamp: new Date().toISOString(),
      status: 'triage',  // triage(검토대기) → waiting(대표님께) | dropped | fulfilled | dismissed
      requestType: REQUEST_TYPES.includes(req.requestType) ? req.requestType : 'data',
      reason: (req.reason || '').slice(0, 500),       // 왜 사람이 필요한지
      request: (req.request || '').slice(0, 500),     // 사람에게 부탁하는 구체 내용
      requestedBy: req.requestedBy || '파트장',
      priority: req.priority || 'medium',
      userResponse: null
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

function _readRequests() {
  const dir = path.join(BRAIN_DIR, 'decisions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(r => r && r.kind === 'request');
}

// 대표님 처리함에 보이는 요청 (파트장이 승격한 것만)
function getPendingRequests() {
  try { return _readRequests().filter(r => r.status === 'waiting'); } catch { return []; }
}

// 파트장이 검토할 대기 큐 (아직 대표님께 안 올라간 것)
function getTriageRequests() {
  try {
    return _readRequests()
      .filter(r => r.status === 'triage')
      .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  } catch { return []; }
}

function countPendingRequests() {
  try { return _readRequests().filter(r => r.status === 'waiting').length; } catch { return 0; }
}

// 파트장이 triage 요청을 대표님께 승격 (상한 초과면 거부)
function escalateRequest(id, priority) {
  try {
    if (countPendingRequests() >= MAX_PENDING_REQUESTS) return { capped: true };
    const filepath = path.join(BRAIN_DIR, 'decisions', `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (item.status !== 'triage') return null;
    item.status = 'waiting';
    if (['high', 'medium', 'low'].includes(priority)) item.priority = priority;
    item.escalatedAt = new Date().toISOString();
    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// 파트장이 중복·사소한 triage 요청을 버림
function dropRequest(id) {
  try {
    const filepath = path.join(BRAIN_DIR, 'decisions', `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'dropped';
    item.droppedAt = new Date().toISOString();
    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// 요청에 사람이 응답(자료/작업 결과 제공) → 에이전트가 이걸로 작업 재개
function fulfillRequest(id, userResponse) {
  try {
    const filepath = path.join(BRAIN_DIR, 'decisions', `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'fulfilled';
    item.userResponse = (userResponse || '').slice(0, 2000);
    item.fulfilledAt = new Date().toISOString();
    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// 요청 무시(필요 없어짐)
function dismissRequest(id) {
  try {
    const filepath = path.join(BRAIN_DIR, 'decisions', `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'dismissed';
    item.dismissedAt = new Date().toISOString();
    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// 오늘 사람이 응답해준 요청들 → 브리핑에 주입 (에이전트가 실제 자료로 활용)
function getFulfilledRequests() {
  try {
    const dir = path.join(BRAIN_DIR, 'decisions');
    if (!fs.existsSync(dir)) return [];
    const today = new Date().toISOString().slice(0, 10);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(r => r && r.kind === 'request' && r.status === 'fulfilled' && (r.fulfilledAt || '').startsWith(today));
  } catch { return []; }
}

// ============================================================
//  제안 (suggestion) — 파트장이 중요한 아이디어를 대표님께 올림, kind='suggestion'
//
//  결재(decision) = 선택 / 요청(request) = 사람이 채움 / 제안(suggestion) = 채택 여부
//  파트장이 필터: 사소하면 직접 처리, 중요하면(돈·전략·승인) 제안으로 올림
// ============================================================
const SUGGEST_CATEGORIES = ['budget', 'strategy', 'approval', 'other'];

function saveSuggestion(s) {
  try {
    const dir = path.join(BRAIN_DIR, 'decisions');
    fs.mkdirSync(dir, { recursive: true });
    const id = s.id || ('sug' + Date.now().toString(36) + Math.floor(Math.random() * 100).toString(36));
    const item = {
      id,
      kind: 'suggestion',  // ★ 제안
      timestamp: new Date().toISOString(),
      status: 'waiting',  // waiting | accepted | dismissed
      title: (s.title || '').slice(0, 120),
      category: SUGGEST_CATEGORIES.includes(s.category) ? s.category : 'other',
      detail: (s.detail || '').slice(0, 800),    // 제안 내용·근거
      impact: (s.impact || '').slice(0, 400),    // 기대 효과/리스크
      requestedBy: s.requestedBy || '파트장',
      priority: s.priority || 'medium',
      userNote: null
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

function getPendingSuggestions() {
  try {
    const dir = path.join(BRAIN_DIR, 'decisions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(s => s && s.kind === 'suggestion' && s.status === 'waiting');
  } catch { return []; }
}

function acceptSuggestion(id, note) {
  try {
    const filepath = path.join(BRAIN_DIR, 'decisions', `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'accepted';
    item.userNote = (note || '').slice(0, 500);
    item.acceptedAt = new Date().toISOString();
    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

function dismissSuggestion(id, note) {
  try {
    const filepath = path.join(BRAIN_DIR, 'decisions', `${id}.json`);
    if (!fs.existsSync(filepath)) return null;
    const item = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    item.status = 'dismissed';
    item.userNote = (note || '').slice(0, 500);
    item.dismissedAt = new Date().toISOString();
    fs.writeFileSync(filepath, JSON.stringify(item, null, 2), 'utf8');
    return item;
  } catch { return null; }
}

// 오늘 대표님이 채택한 제안 → 브리핑에 주입 (파트장이 실행에 옮기도록)
function getAcceptedSuggestions() {
  try {
    const dir = path.join(BRAIN_DIR, 'decisions');
    if (!fs.existsSync(dir)) return [];
    const today = new Date().toISOString().slice(0, 10);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(s => s && s.kind === 'suggestion' && s.status === 'accepted' && (s.acceptedAt || '').startsWith(today));
  } catch { return []; }
}

// ============================================================
//  목표 관리 (goals.json) — 연간/월간/주간/일간 + 진행률
//
//  구조:
//   { annual:[item], monthly:[item], weekly:[item], daily:[item] }
//   item = { id, title, progress(0~100), status:'active'|'done', note, updatedAt }
// ============================================================
const GOAL_PERIODS = ['annual', 'monthly', 'weekly', 'daily'];
const GOAL_LABELS  = { annual: '연간', monthly: '월간', weekly: '주간', daily: '일간' };
// 부모-자식 레벨 (자식 레벨 → 바로 위 부모 레벨)
const PARENT_OF_LEVEL = { daily: 'weekly', weekly: 'monthly', monthly: 'annual', annual: null };
const GOAL_LIMITS     = { annual: 5, monthly: 7, weekly: 10, daily: 14 };

function _goalsPath() {
  return path.join(BRAIN_DIR, 'company', 'goals.json');
}

function _newGoalId() {
  return 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

function _clamp(min, max, v) { return Math.max(min, Math.min(max, v)); }
function _clampWeight(w) {
  const n = parseFloat(w);
  if (isNaN(n)) return 0;
  return Math.round(_clamp(0, 1, n) * 100) / 100;
}

// 한 목표 항목에 계층 필드 기본값 보정 (지연 마이그레이션)
function _ensureGoalFields(item, level) {
  if (item.level     === undefined) item.level     = level;
  if (item.parentId  === undefined) item.parentId  = null;
  if (item.weight    === undefined) item.weight    = 0;
  if (!Array.isArray(item.keyResults)) item.keyResults = [];
  if (item.type      === undefined) item.type      = (level === 'daily' || level === 'weekly') ? 'lead' : 'lag';
  if (item.progress  === undefined) item.progress  = 0;
  if (item.status    === undefined) item.status    = 'active';
  if (item.note      === undefined) item.note      = '';
  if (item.deadline  === undefined) item.deadline  = null;
  if (item.startDate === undefined) item.startDate = null;
  return item;
}

// 구조 그대로(저장된 진실) — 필드 보정만 적용
function getGoalsRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(_goalsPath(), 'utf8'));
    GOAL_PERIODS.forEach(p => { if (!Array.isArray(data[p])) data[p] = []; });
    GOAL_PERIODS.forEach(p => data[p].forEach(it => _ensureGoalFields(it, p)));
    return data;
  } catch {
    return { annual: [], monthly: [], weekly: [], daily: [] };
  }
}

function saveGoals(goals) {
  try {
    GOAL_PERIODS.forEach(p => { if (!Array.isArray(goals[p])) goals[p] = []; });
    fs.writeFileSync(_goalsPath(), JSON.stringify(goals, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function _findGoalRaw(goals, id) {
  for (const p of GOAL_PERIODS) { const g = goals[p].find(x => x.id === id); if (g) return g; }
  return null;
}
function _flat(goals) { const a = []; GOAL_PERIODS.forEach(p => goals[p].forEach(g => a.push(g))); return a; }
function _childrenMap(goals) {
  const m = {};
  _flat(goals).forEach(g => { if (g.parentId) (m[g.parentId] = m[g.parentId] || []).push(g); });
  return m;
}

// ── 자동 링크: 부모 레벨에 목표가 '정확히 1개'면 고아 자식을 그것에 연결 (보수적 마이그레이션)
function autoLinkOrphans(goals) {
  const pairs = [['monthly', 'annual'], ['weekly', 'monthly'], ['daily', 'weekly']];
  for (const [childLvl, parentLvl] of pairs) {
    if (goals[parentLvl].length === 1) {
      const pid = goals[parentLvl][0].id;
      goals[childLvl].forEach(g => { if (!g.parentId) g.parentId = pid; });
    }
  }
}

// ── 가중치 정규화: 같은 부모의 자식들 weight 합이 1.0이 되도록
function normalizeWeights(goals) {
  const cm = _childrenMap(goals);
  for (const pid in cm) {
    const kids = cm[pid];
    const sum = kids.reduce((s, k) => s + (k.weight || 0), 0);
    if (sum <= 0) {
      const w = Math.round((1 / kids.length) * 100) / 100;
      kids.forEach(k => k.weight = w);
    } else if (Math.abs(sum - 1) > 0.01) {
      kids.forEach(k => k.weight = Math.round(((k.weight || 0) / sum) * 100) / 100);
    }
  }
}

// ── 가중 평균 진행률 (순수 함수): Σ(progress×weight) / Σ(weight), 반올림
//   children = [{ progress, weight }, ...] → 0~100 정수 반환
//   (순수 함수라 파일/날짜에 의존하지 않아 테스트하기 쉽다)
function weightedProgress(children) {
  if (!Array.isArray(children) || children.length === 0) return 0;
  const sumW = children.reduce((s, k) => s + (k.weight || 0), 0) || 1;
  const sum  = children.reduce((s, k) => s + (k.progress || 0) * (k.weight || 0), 0);
  return Math.round(sum / sumW);
}

// ── 가중 롤업: 자식이 있는 목표의 progress = 자식들의 가중 평균. 바텀업.
function recomputeRollup(goals) {
  const cm = _childrenMap(goals);
  for (const level of ['daily', 'weekly', 'monthly', 'annual']) {  // 바텀업 순서
    for (const g of goals[level]) {
      const kids = cm[g.id];
      if (kids && kids.length) {
        g.progress = weightedProgress(kids);
        g.status = g.progress >= 100 ? 'done' : (g.status === 'done' ? 'active' : g.status);
        g.isParent = true;
      } else {
        g.isParent = false;
      }
    }
  }
}

// ── 기간 경과 비율(0~1): 페이스 판정용
// goal 옵션 전달 시 startDate+deadline 기반으로 계산 (더 정확)
function getElapsedRatio(level, goal) {
  const now = new Date();
  if (goal && goal.startDate && goal.deadline) {
    const s = new Date(goal.startDate);
    const e = new Date(goal.deadline);
    if (!isNaN(s) && !isNaN(e) && e > s) return _clamp(0, 1, (now - s) / (e - s));
  }
  if (level === 'daily') {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    return _clamp(0, 1, (now - s) / (24 * 3600 * 1000));
  }
  if (level === 'weekly') {
    const day = (now.getDay() + 6) % 7;  // 월요일=0
    const s = new Date(now); s.setHours(0, 0, 0, 0); s.setDate(now.getDate() - day);
    return _clamp(0, 1, (now - s) / (7 * 24 * 3600 * 1000));
  }
  if (level === 'monthly') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return _clamp(0, 1, (now - s) / (e - s));
  }
  const s = new Date(now.getFullYear(), 0, 1);
  const e = new Date(now.getFullYear() + 1, 0, 1);
  return _clamp(0, 1, (now - s) / (e - s));
}

// ── 페이스: 진행률 vs 경과율 (±10%p 기준)
function getPace(goal) {
  if (goal.status === 'done' || goal.status === 'archived') return 'done';
  const elapsed = getElapsedRatio(goal.level, goal);
  const prog = (goal.progress || 0) / 100;
  if (prog >= elapsed + 0.1) return 'ahead';
  if (prog <= elapsed - 0.1) return 'behind';
  return 'on_track';
}

// 표시·요약용: 마이그레이션 + 자동링크 + 정규화 + 롤업까지 적용한 결과 (저장 안 함, 항상 결정적)
function getGoals() {
  const goals = getGoalsRaw();
  autoLinkOrphans(goals);
  normalizeWeights(goals);
  recomputeRollup(goals);
  return goals;
}

// 대시보드용: 부모-자식 중첩 트리 + 페이스/경과율 포함
function getGoalsTree() {
  const goals = getGoals();
  // archived 제외 — 별도 getArchivedGoals() 로 조회
  const flat = _flat(goals).filter(g => g.status !== 'archived');
  const byId = new Map(flat.map(g => [g.id, g]));
  const cm   = {};
  flat.forEach(g => { if (g.parentId) (cm[g.parentId] = cm[g.parentId] || []).push(g); });
  const roots = flat.filter(g => !g.parentId || !byId.has(g.parentId));
  function build(g) {
    const kids = cm[g.id] || [];
    return Object.assign({}, g, {
      pace:       getPace(g),
      elapsedPct: Math.round(getElapsedRatio(g.level, g) * 100),
      isParent:   kids.length > 0,
      children:   kids.map(build)
    });
  }
  roots.sort((a, b) => GOAL_PERIODS.indexOf(a.level) - GOAL_PERIODS.indexOf(b.level));
  return roots.map(build);
}

// 목표 추가 (opts: parentId, weight, type, keyResults)
function addGoal(level, title, opts = {}) {
  if (!GOAL_PERIODS.includes(level) || !title) return null;
  const goals = getGoalsRaw();

  // 레벨별 목표 상한 (archived 제외, skipLimitCheck 옵션으로 우회 가능)
  if (!opts.skipLimitCheck) {
    const activeCount = goals[level].filter(g => g.status !== 'archived').length;
    if (activeCount >= GOAL_LIMITS[level]) {
      return { error: `${GOAL_LABELS[level]} 목표는 최대 ${GOAL_LIMITS[level]}개까지 추가할 수 있습니다. 기존 목표를 완료하거나 보관한 뒤 추가해 주세요.`, code: 'LIMIT_EXCEEDED' };
    }
  }

  const parentId = opts.parentId && _findGoalRaw(goals, opts.parentId) ? opts.parentId : null;
  const today = new Date().toISOString().slice(0, 10);
  const item = _ensureGoalFields({
    id: _newGoalId(),
    level,
    title:      String(title).slice(0, 200),
    parentId,
    weight:     opts.weight !== undefined ? _clampWeight(opts.weight) : 0,
    keyResults: Array.isArray(opts.keyResults) ? opts.keyResults.slice(0, 5) : [],
    type:       (opts.type === 'lead' || opts.type === 'lag') ? opts.type : undefined,
    deadline:   opts.deadline || null,
    startDate:  opts.startDate || today,
    progress: 0, status: 'active', note: '', updatedAt: new Date().toISOString()
  }, level);
  goals[level].push(item);
  saveGoals(goals);
  return item;
}

// ID로 목표 수정 (title/note/progress/status/parentId/weight/type/keyResults)
function updateGoalById(id, fields) {
  if (!id) return null;
  const goals = getGoalsRaw();
  for (const level of GOAL_PERIODS) {
    const item = goals[level].find(g => g.id === id);
    if (item) {
      if (fields.title    !== undefined) item.title = String(fields.title).slice(0, 200);
      if (fields.note     !== undefined) item.note  = String(fields.note).slice(0, 500);
      if (fields.progress !== undefined) {
        const p = _clamp(0, 100, parseInt(fields.progress, 10) || 0);
        item.progress = p;
        if (p >= 100) item.status = 'done';
        else if (item.status === 'done') item.status = 'active';
      }
      if (fields.status !== undefined) item.status = fields.status;
      if (fields.parentId !== undefined) {
        item.parentId = (fields.parentId && fields.parentId !== id && _findGoalRaw(goals, fields.parentId)) ? fields.parentId : null;
      }
      if (fields.weight !== undefined) item.weight = _clampWeight(fields.weight);
      if (fields.type !== undefined && (fields.type === 'lead' || fields.type === 'lag')) item.type = fields.type;
      if (Array.isArray(fields.keyResults)) item.keyResults = fields.keyResults.slice(0, 5);
      if ('deadline'  in fields) item.deadline  = fields.deadline  || null;
      if ('startDate' in fields) item.startDate = fields.startDate || null;
      item.updatedAt = new Date().toISOString();
      saveGoals(goals);
      return item;
    }
  }
  return null;
}

// 목표 삭제 (자식은 고아가 되지 않도록 부모를 한 단계 위로 승계)
function deleteGoal(id) {
  if (!id) return false;
  const goals = getGoalsRaw();
  const target = _findGoalRaw(goals, id);
  if (!target) return false;
  const newParent = target.parentId || null;
  _flat(goals).forEach(g => { if (g.parentId === id) g.parentId = newParent; });
  for (const level of GOAL_PERIODS) {
    goals[level] = goals[level].filter(g => g.id !== id);
  }
  saveGoals(goals);
  return true;
}

// LLM 브리핑용 요약 (계층/가중치/페이스/KR 포함 → 파트장·목표관리자가 참조·갱신)
function getGoalsSummary() {
  const tree = getGoalsTree();  // archived 제외됨
  if (tree.length === 0) return '(등록된 구조화 목표 없음)';
  const paceLabel = { ahead: '⏫앞섬', on_track: '✅정상', behind: '⚠️지연', done: '🏁완료' };
  let out = '';
  function render(node, depth) {
    const indent = '  '.repeat(depth);
    const w   = node.parentId ? ` ·가중치${Math.round((node.weight || 0) * 100)}%` : '';
    const kr  = (node.keyResults || []).map(k => `${k.metric} ${k.current}/${k.target}`).join(', ');
    const dl  = node.deadline ? ` ·마감${node.deadline}` : '';
    out += `${indent}- [${node.id}] (${GOAL_LABELS[node.level]}/${node.type}) ${node.title} · 진행률 ${node.progress}%${w}${dl} · ${paceLabel[node.pace] || ''}${kr ? ` · KR: ${kr}` : ''}${node.note ? ` · 메모: ${node.note}` : ''}\n`;
    (node.children || []).forEach(c => render(c, depth + 1));
  }
  tree.forEach(n => render(n, 0));
  // 레벨별 목표 수 현황
  const goals = getGoalsRaw();
  const counts = GOAL_PERIODS.map(p => {
    const active = goals[p].filter(g => g.status !== 'archived').length;
    return `${GOAL_LABELS[p]}:${active}/${GOAL_LIMITS[p]}`;
  }).join(', ');
  return `[목표 수: ${counts}]\n` + out.trim();
}

// 보관함: archived 상태 목표 목록
function getArchivedGoals() {
  const goals = getGoals();
  return _flat(goals).filter(g => g.status === 'archived');
}

// 중복 의심 목표 그룹 (Jaccard ≥ threshold)
function getDuplicateCandidates(threshold = 0.38) {
  const goals = getGoals();
  const flat  = _flat(goals).filter(g => g.status !== 'archived');
  const stopWords = new Set(['및', '을', '를', '이', '가', '은', '는', '의', '에', '로', '으로', '위한', '통한', '대한', '관련', '의한', '에서', '에게', '까지', '부터']);

  function tokenize(title) {
    return title
      .replace(/[()[\]·&,]/g, ' ')
      .split(/\s+/)
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length > 1 && !stopWords.has(w));
  }

  function jaccard(a, b) {
    const sa = new Set(tokenize(a));
    const sb = new Set(tokenize(b));
    const inter = [...sa].filter(t => sb.has(t)).length;
    const union = new Set([...sa, ...sb]).size;
    return union === 0 ? 0 : inter / union;
  }

  const groups = [];
  const used   = new Set();
  for (let i = 0; i < flat.length; i++) {
    if (used.has(flat[i].id)) continue;
    const group = [flat[i]];
    for (let j = i + 1; j < flat.length; j++) {
      if (used.has(flat[j].id)) continue;
      if (flat[i].level === flat[j].level && jaccard(flat[i].title, flat[j].title) >= threshold) {
        group.push(flat[j]);
        used.add(flat[j].id);
      }
    }
    if (group.length > 1) {
      used.add(flat[i].id);
      groups.push(group);
    }
  }
  return groups;
}

// ============================================================
//  자율 루프 간격 설정 (분)
// ============================================================
function _settingsPath() {
  return path.join(BRAIN_DIR, 'company', 'settings.json');
}

function getLoopInterval() {
  try {
    if (!fs.existsSync(_settingsPath())) return 10; // 기본값 10분
    const settings = JSON.parse(fs.readFileSync(_settingsPath(), 'utf8'));
    return settings.loopIntervalMin || 10;
  } catch { return 10; }
}

function setLoopInterval(minutes) {
  try {
    const settingsPath = _settingsPath();
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    settings.loopIntervalMin = Math.max(1, Math.min(180, Number(minutes) || 10));
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return settings.loopIntervalMin;
  } catch { return 30; }
}

// ── Gemini API 키 (settings.json에 저장 — gitignore 대상이라 GitHub 노출 없음)
function getGeminiKey() {
  try {
    if (!fs.existsSync(_settingsPath())) return '';
    return JSON.parse(fs.readFileSync(_settingsPath(), 'utf8')).geminiApiKey || '';
  } catch { return ''; }
}

function setGeminiKey(key) {
  try {
    const p = _settingsPath();
    const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    s.geminiApiKey = (key || '').trim();
    fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

module.exports = {
  BRAIN_DIR,
  initBrain,
  getCompanyContext,
  getAgentMemory,
  appendAgentMemory,
  appendConversationLog,
  getBrainDir,
  getPendingDecisions,
  getApprovedDecisions,
  saveDecision,
  approveDecision,
  rejectDecision,
  saveRequest,
  getPendingRequests,
  getTriageRequests,
  countPendingRequests,
  escalateRequest,
  dropRequest,
  fulfillRequest,
  dismissRequest,
  getFulfilledRequests,
  MAX_PENDING_REQUESTS,
  saveSuggestion,
  getPendingSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  getAcceptedSuggestions,
  getGoals,
  getGoalsTree,
  getGoalsRaw,
  saveGoals,
  addGoal,
  updateGoalById,
  deleteGoal,
  getGoalsSummary,
  getArchivedGoals,
  getDuplicateCandidates,
  GOAL_LIMITS,
  getPace,
  getElapsedRatio,
  weightedProgress,
  getLoopInterval,
  setLoopInterval,
  getGeminiKey,
  setGeminiKey
};
