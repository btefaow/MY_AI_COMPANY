// ============================================================
//  나만의 AI 회사 — VS Code 확장 본체
//
//  핵심 동작:
//   1) 자율 루프 — 확장 시작 시 파트장이 자동 브리핑하고, 한 세션 안에서
//      여러 라운드로 목표를 평가·개선한 뒤 설정 간격마다 다음 세션을 재시작
//   2) delegate 위임 — 파트장이 <delegate agent="..." task="..."/> 태그로
//      팀원에게 작업을 분배 (태그가 없으면 산문 지시를 태그로 자동 변환)
//   3) 목표 계층 관리 — 목표관리자가 연→월→주→일 가중 분해, 진행률 자동 롤업
//   4) 의사결정 결재함 — 파트장이 <ask_user>로 물으면 팀 자동 투표 후
//      사용자가 대시보드에서 승인/보류
//   5) 코드 검증 루프 — 생성된 코드를 실행해 오류 시 개발자가 자동 수정
//
//  단순 질문(파트장 외 탭) → 1개 에이전트 직접 라우팅(classifyAgent)
// ============================================================

const vscode   = require('vscode');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec } = require('child_process');

const { AGENTS, AGENT_MAP, DEFAULT_AGENT_ID } = require('./agents');
const brain = require('./brain');

const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';
const MODELS_URL    = 'http://localhost:1234/v1/models';
const MAX_TURNS     = 20;

// ★ LM Studio에 로드된 실제 모델 ID (시작 시 자동 감지)
//   'local-model'은 유효한 식별자가 아니라 400 오류를 유발하므로,
//   /v1/models 를 조회해 실제 로드된 모델 이름을 사용한다.
let MODEL_ID = null;

async function detectModel() {
  try {
    const res = await fetch(MODELS_URL);
    if (!res.ok) return MODEL_ID;
    const data = await res.json();
    const ids = (data.data || [])
      .map(m => m.id)
      .filter(id => id && !/embed/i.test(id));  // 임베딩 모델 제외
    if (ids.length > 0) MODEL_ID = ids[0];
  } catch { /* LM Studio 미실행 — 다음 호출에서 재시도 */ }
  return MODEL_ID;
}

// 모델 ID가 아직 없으면 감지한 뒤 반환 (없으면 첫 번째 채팅 모델로 폴백)
async function ensureModel() {
  if (MODEL_ID) return MODEL_ID;
  await detectModel();
  return MODEL_ID || 'local-model';
}

// ★ 자율 루프 설정
const MAX_ROUNDS        = 5;   // 한 세션 내 최대 개선 라운드 (안전장치)
let   LOOP_INTERVAL_MIN = 10;  // 세션 종료 후 다음 세션까지 대기(분) — 시작 시 brain.js에서 로드

// ★ 결과물 검증 루프 설정
const MAX_FIX_ATTEMPTS  = 3;       // 코드 자동 수정 최대 시도 횟수
const VERIFY_TIMEOUT_MS = 20_000;  // 코드 실행 제한 시간 (서버 등 장시간 실행 방지)
// 확장자 → 실행기 매핑 (이 목록에 있는 파일만 자동 검증)
const FILE_RUNNERS = {
  '.py' : { cmd: 'python',  label: 'Python' },
  '.js' : { cmd: 'node',    label: 'Node.js' }
};

const ACTION_TAGS_PROMPT = `
## 파일 및 터미널 작업 도구

파일 생성:
<create_file path="파일경로">
내용
</create_file>

파일 읽기:
<read_file path="파일경로"/>

파일 수정 (찾아 바꾸기):
<edit_file path="파일경로">
<search>찾을 텍스트</search>
<replace>바꿀 텍스트</replace>
</edit_file>

명령어 실행:
<run_command>명령어</run_command>

파일 목록 조회:
<list_files path="디렉토리경로/"/>

규칙: 경로는 항상 상대 경로, 코드 생성 시 반드시 create_file 사용

## 파일 형식 규칙 (중요)

당신은 텍스트만 생성할 수 있습니다. 내용 종류에 맞는 형식으로 저장하세요:

| 내용 | 확장자 | 비고 |
|------|--------|------|
| 보고서·분석·전략·기획·문서 | **.md** | 기본값. 제목(#)·표(\|)·목록(-)으로 구조화 |
| 표 형태의 순수 데이터 | **.csv** | 쉼표 구분. 엑셀에서 그대로 열림 |
| 설정·구조화 데이터 | **.json** | |
| 코드 | .py / .js / .ts 등 | 해당 언어 확장자 |

⛔ **절대 만들지 말 것: .xlsx / .pdf / .docx / .pptx**
이들은 압축된 바이너리 형식이라 텍스트로 만들면 **열리지 않는 깨진 파일**이 됩니다.
- 표 데이터가 필요하면 → **.csv** 또는 **.md 표**로 저장하세요.
- 실제 엑셀/PDF/워드 파일이 꼭 필요하면 → 직접 만들지 말고 사람에게 요청하세요:
  <need_human type="action" reason="엑셀 파일 변환은 제가 못 합니다" request="이 CSV를 엑셀로 변환해 주세요"/>

기본적으로 문서는 **.md로 저장**하는 것을 원칙으로 합니다.`;

// ★ 모든 에이전트 공통 — 환각(거짓 지어내기) 방지 + 사람 요청 트리거 규칙
const ANTI_HALLUCINATION_PROMPT = `
## 정직 규칙과 사람 도움 요청 (매우 중요)

당신은 인터넷에 접속할 수 없고, 실시간 정보를 모르며, 외부 시스템(이메일·결제·API·실제 바이어 연락)을 직접 실행할 수 없습니다.
모르는 사실을 **절대 지어내지 마세요.** 그럴듯한 가짜 숫자·회사명·연락처는 회사에 해롭습니다.

### ✋ 반드시 사람에게 요청할 것 (<need_human> 사용)
아래에 해당하면 지어내지 말고 요청하세요:
1. **실시간·최신·구체 수치** — 시장 규모, 점유율, 통계, 환율, 가격, 경쟁사 최신 동향, 실제 연락처
2. **외부 실행** — 이메일/메시지 발송, 업로드, 결제, 실제 바이어·기관 연락, 외부 API 호출
3. **사실 검증이 꼭 필요한 핵심 데이터** — 틀리면 의사결정을 망칠 숫자·규제·인증 정보
4. **내가 못 읽는 자료** — PDF/엑셀/이미지 등의 실제 내용

<need_human type="data|action|file|verify" reason="왜 사람이 필요한지" request="사람에게 부탁하는 구체적 내용"/>
예: <need_human type="data" reason="실시간 시장 데이터는 조사가 필요" request="2025년 사우디 핀테크 시장 규모와 상위 3개 기업"/>

### 🙅 요청하지 말고 직접 할 것 (사소한 일로 사람을 귀찮게 하지 말 것)
- 일반 지식으로 가능한 분석·정리·초안 작성 (문서·코드·기획안)
- 이미 위 '사람이 제공한 자료'에 있는 데이터로 할 수 있는 일
- 형식·구조·표현 같은 내부 결정 → 합리적 가정을 세우고 그냥 진행 (가정은 명시)
- 의사결정을 좌우하지 않는 사소한 수치 → 요청하지 말고 "[추정: 약 OO]" 형태로 명확히 표시하고 진행

### ⚖️ 요청 vs 추정 판단 기준
- 이 숫자가 틀리면 큰 결정을 망치는가? → 예: <need_human>으로 요청 / 아니오: [추정]으로 진행
- 한 번에 너무 많이 요청하지 말 것. 꼭 필요한 핵심 1~2개로 좁히세요.

원칙: **"되돌릴 수 있고 내가 아는 걸로 가능"하면 직접·추정, "결정을 좌우하는 실시간 사실·외부 실행"이면 요청.**`;

// ★ 7단계: CEO 전용 — 팀원 위임 태그 사용법
// JSON 플래너보다 훨씬 안정적. LLM이 응답 텍스트 안에 자연스럽게 포함 가능.
const CEO_DELEGATE_PROMPT = `
## 팀원 위임 도구 (가장 중요)

팀원에게 일을 시키려면 **반드시 아래 태그를 사용**해야 합니다.
"개발팀은 ~하십시오", "비즈니스팀은 ~하세요" 같은 **말(산문)로만 지시하면 시스템은 아무도 실행하지 않습니다.**
지시할 팀이 있으면 그 수만큼 delegate 태그를 응답에 직접 써넣으세요.

<delegate agent="에이전트ID" task="이 에이전트가 할 구체적인 작업 설명"/>

사용 가능한 에이전트 (agent에는 반드시 아래 영문 ID만 사용):
${AGENTS.filter(a => a.id !== 'ceo').map(a => `- ${a.id}: ${a.role}`).join('\n')}

올바른 예시 (이렇게 태그로 작성):
<delegate agent="developer" task="VS Code 확장과 LM Studio 간 최소 통신 프로토콜과 기본 상태관리 로직 구현"/>
<delegate agent="business" task="KSA/이집트 중소기업의 구체적 Pain Point 3건 이상 수집·기록"/>
<delegate agent="secretary" task="Knowledge Base 템플릿 작성 착수 및 산출물 정리"/>

잘못된 예시 (이렇게 쓰면 실행 안 됨): "개발팀은 MVP를 구현하십시오. 비즈니스팀은 데이터를 수집하세요."

## 사용자 의견 요청 도구

애매한 결정은 사용자에게 물어보세요.

<ask_user question="이집트 결제 시스템으로 어떤 것을 사용할까요?"
           options="Stripe,PayPal,로컬 결제"
           priority="high"
           recommended="Stripe"/>

속성:
- question (필수): 사용자에게 물어볼 질문
- options (필수): 쉼표로 구분된 선택지 (최대 4개)
- priority (선택): high|medium|low
- recommended (선택): 팀이 추천하는 옵션

예시:
<ask_user question="YouTube 콘텐츠 배포 전략은?" options="주 3회,주 5회,매일" recommended="주 3회"/>

## 대표님께 제안하는 도구 (당신이 '필터' 역할)

당신 자신 또는 팀원의 아이디어·개선점 중 **중요한 것만** 골라 대표님께 올립니다. 당신은 사소한 것과 중요한 것을 거르는 필터입니다.

📌 **대표님께 올릴 것 (<suggest> 사용)** — 아래 중 하나라도 해당하면:
- **돈·예산**: 비용 지출, 수익 모델 변경, 가격 정책
- **전략·방향 전환**: 회사 목표·우선순위·시장 진입 방향을 바꾸는 것
- **대표님 승인 필요**: 회사 외부에 드러나거나, 법적·윤리적 판단이 필요한 것

🙅 **당신이 직접 처리할 것 (제안하지 말 것)**:
- 되돌릴 수 있고 저비용인 내부 작업 (문서·코드·조사 초안, 작업 분배, 우선순위 미세조정)
- → 이런 건 그냥 <delegate>로 실행하세요. 대표님을 귀찮게 하지 마세요.

<suggest title="짧은 제목" category="budget|strategy|approval" detail="제안 내용과 근거" impact="기대 효과 또는 리스크"/>

예시:
<suggest title="이집트보다 사우디 먼저 집중" category="strategy" detail="사우디 Vision 2030으로 핀테크 예산이 크고 진입장벽이 낮음. 이집트는 외환규제로 6개월 후 진입 권장" impact="초기 리소스를 한 시장에 집중해 성과를 빨리 검증"/>

## 자료요청 검토 도구 (당신이 폭주를 거르는 필터)

팀이 올린 '자료요청 검토 큐'를 보고, 대표님께는 **정말 중요한 것만 최대 5건** 올립니다.
- 중복·겹침·사소함·추정 가능 → 폐기: <drop_request id="요청ID"/>
- 의사결정에 치명적인 핵심 데이터만 → 승격: <escalate_request id="요청ID" priority="high|medium|low"/>
대표님이 39건에 묻히지 않도록 가차없이 거르세요. 애매하면 폐기가 기본입니다.

## 목표 관리 도구 (당신이 회사 목표의 관리자입니다)

회사 비전(goals.md)을 바탕으로 목표를 **연간→월간→주간→일간으로 유기적으로 연결(계층)**해서 관리합니다.
상위 목표는 하위 목표의 '가중 합'으로 달성됩니다 (모든 하위는 부모에 연결, 같은 부모의 가중치 합 = 1.0).

**목표 설계·재구성이 필요하면 직접 하지 말고 '목표관리자'(goal_manager)에게 위임**하는 것을 권장합니다:
<delegate agent="goal_manager" task="현재 추적 목표를 연→월→주→일 계층으로 정리하고 가중치를 차등 배분해 주세요"/>

간단한 진행률 갱신은 당신이 직접 해도 됩니다:
<set_progress id="목표ID" progress="0~100" note="갱신 근거"/>

직접 목표를 만들 경우 (계층·가중치 포함):
<add_goal level="annual|monthly|weekly|daily" title="구체적·측정가능 목표" parent="부모ID" weight="0.4" type="lead|lag"/>
<update_goal id="목표ID" weight="0.5" parent="부모ID"/>
<delete_goal id="목표ID"/>

규칙:
- 추적 목표가 비어 있으면 목표관리자에게 위임해 비전을 4단계 계층으로 분해시킨다
- 진행률은 lead(주간/일간 행동) 위주로, 실제 팀 작업 결과를 근거로만 갱신한다
- 상위(월간/연간) 진행률은 자동 집계되므로 직접 입력하지 않는다

## 목표 완료 판단 도구 (중요)

당신은 지금 '자율 개선 루프' 안에서 일하고 있습니다.
팀이 작업을 마치면 그 결과를 평가하고, 아래 태그로 진행 여부를 반드시 표시하세요.

<goal_status state="done" reason="목표 달성 이유"/>     ← 이번 목표가 충분히 달성됨 (루프 정지)
<goal_status state="continue" reason="아직 부족한 점"/>  ← 더 개선/추가 작업 필요 (다음 라운드 진행)

규칙:
- 단순 분석/판단은 직접 답한다
- 실행/제작이 필요하면 delegate를 사용한다
- 전략/방향 결정이 필요하면 ask_user를 사용한다
- 매 응답 끝에 goal_status 태그를 반드시 1개 포함한다
- continue일 때는 반드시 구체적인 다음 작업을 delegate로 지시한다`;

// ============================================================
//  activate
// ============================================================
function activate(context) {
  detectModel();  // ★ LM Studio 로드 모델 미리 감지 (비동기, 자동 브리핑 전 완료)
  LOOP_INTERVAL_MIN = brain.getLoopInterval();  // ★ brain.js에서 저장된 자율 루프 간격 로드
  const provider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('my-agent-chat-view', provider)
  );
}

// ============================================================
//  ChatViewProvider
// ============================================================
class ChatViewProvider {
  constructor(context) {
    this.context        = context;
    this.currentAgentId = DEFAULT_AGENT_ID;
    this.histories      = {};
    this._briefingDone  = false;  // ★ 자동 브리핑 한 번만 실행
    AGENTS.forEach(a => { this.histories[a.id] = []; });
    brain.initBrain(AGENTS.map(a => a.id));
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html    = this.getHtml();

    // ★ 확장 시작 시 1초 후 CEO 자동 브리핑 (한 번만)
    if (!this._briefingDone) {
      this._briefingDone = true;
      setTimeout(() => this._startAutoBriefing(webviewView), 1000);
    }

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ask') {
        if (this.currentAgentId === 'ceo') {
          // ★ 7단계: CEO 탭 → 플래너 경유
          await this._handleCeoWithPlan(msg.text, webviewView);
        } else {
          await this._handleDirectChat(msg.text, webviewView);
        }
      } else if (msg.type === 'switchAgent') {
        this.currentAgentId = msg.agentId;
      } else if (msg.type === 'clear') {
        this.histories[this.currentAgentId] = [];
      } else if (msg.type === 'open_brain') {
        vscode.window.showTextDocument(
          vscode.Uri.file(path.join(brain.BRAIN_DIR, 'company', 'identity.md'))
        );
      } else if (msg.type === 'open_dashboard') {
        // ★ 대시보드 패널 열기
        DashboardPanel.createOrShow(this.context);
      } else if (msg.type === 'open_goals') {
        // ★ 목표 관리 대시보드 열기
        GoalDashboardPanel.createOrShow(this.context);
      } else if (msg.type === 'stop_loop') {
        // ★ 자율 루프 정지
        this._stopAutonomousLoop(webviewView);
      } else if (msg.type === 'start_loop') {
        // ★ 자율 루프 재시작
        if (!this._loopActive) {
          this._loopActive = true;
          this._runAutonomousLoop(webviewView);
        }
      } else if (msg.type === 'set_loop_interval') {
        // ★ 자율 세션 간격 변경 (다음 세션부터 적용 — 진행 중 세션엔 영향 없음)
        LOOP_INTERVAL_MIN = brain.setLoopInterval(msg.minutes);
        webviewView.webview.postMessage({
          type: 'loop_status',
          text: `⏱️ 자율 세션 간격: ${LOOP_INTERVAL_MIN}분 (다음 세션부터 적용)`
        });
      }
    });

    // 사이드바가 닫히면 자율 루프 타이머 정리 (좀비 타이머 방지)
    webviewView.onDidDispose(() => {
      this._loopActive = false;
      if (this._sessionTimer) { clearTimeout(this._sessionTimer); this._sessionTimer = null; }
    });
  }

  // ─────────────────────────────────────────────────────────
  //  ★ CEO(파트장) 흐름: delegate 태그 방식
  //
  //  JSON 계획 대신 delegate 태그를 쓰는 이유: 로컬 LLM은 순수 JSON을
  //  잘 못 만들어 실패가 잦음. 파트장이 응답 텍스트 안에 XML 태그를
  //  포함하면 시스템이 파싱해서 해당 에이전트를 자동 실행한다.
  //
  //  흐름:
  //  1) CEO 응답 스트리밍 (delegate 태그 포함 가능)
  //  2) delegate 태그 발견 → 순서대로 에이전트 실행 (앞 결과를 다음에 전달)
  //  3) 각 에이전트의 XML 액션 태그도 실행 (파일 생성, 명령어 등)
  // ─────────────────────────────────────────────────────────

  // ★ 자율 루프: 확장 시작 시 파트장이 업무를 시작하고
  //   한 세션 안에서 여러 라운드 개선 → 간격 후 다음 세션 재시작
  async _startAutoBriefing(webviewView) {
    this._loopActive = true;
    await this._runAutonomousLoop(webviewView);
  }

  // ── 자율 루프 본체 (한 세션 = 최대 MAX_ROUNDS 라운드) ──────────
  async _runAutonomousLoop(webviewView) {
    this.currentAgentId = 'ceo';
    this._sessionCount  = (this._sessionCount || 0) + 1;
    let prevResults = [];

    // ★ 세션마다 파트장 대화 기록 초기화 (메아리 방지)
    //   누적되면 파트장이 자기 과거 메시지를 보고 똑같은 선언을 반복함.
    //   필요한 맥락(목표·결정·이전 기록)은 브리핑이 매번 새로 주입한다.
    this.histories['ceo'] = [];

    // ★ 세션 시작 → 카운트다운 종료 신호
    webviewView.webview.postMessage({ type: 'session_running' });

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      if (!this._loopActive) {  // 사용자가 정지를 눌렀으면 중단
        webviewView.webview.postMessage({ type: 'loop_status', text: '⏸ 자율 루프 정지됨' });
        return;
      }

      webviewView.webview.postMessage({
        type: 'loop_status',
        text: `🔄 세션 ${this._sessionCount} · 라운드 ${round}/${MAX_ROUNDS} 진행 중`
      });

      // 라운드 1은 초기 브리핑, 이후는 이전 결과 평가 브리핑
      const briefing = round === 1
        ? this._getBriefingPrompt()
        : this._getRoundBriefing(round, prevResults);

      let result;
      try {
        result = await this._handleCeoWithPlan(briefing, webviewView, round);
      } catch (err) {
        webviewView.webview.postMessage({ type: 'error', text: _errMsg(err) });
        break;
      }

      prevResults = (result && result.delegateResults) || [];
      const status = result && result.status;

      // ★ 파트장이 '완료'로 판단하면 세션 종료
      if (status && status.state === 'done') {
        webviewView.webview.postMessage({
          type: 'loop_status',
          text: `✅ 파트장 판단: 목표 달성 — ${status.reason || ''} (세션 ${this._sessionCount} 종료)`
        });
        break;
      }

      // 위임도 없고 완료 신호도 없으면 더 진행할 게 없음 → 종료
      if (prevResults.length === 0 && (!status || status.state !== 'continue')) {
        webviewView.webview.postMessage({ type: 'loop_status', text: '💤 추가 작업 없음 — 세션 종료' });
        break;
      }
    }

    // 세션 종료 → 간격 후 다음 세션 자동 재시작 예약
    this._scheduleNextSession(webviewView);
  }

  // ── 다음 세션 예약 (LOOP_INTERVAL_MIN 분 후) ──────────────────
  _scheduleNextSession(webviewView) {
    if (this._sessionTimer) clearTimeout(this._sessionTimer);
    if (!this._loopActive) return;

    // ★ 다음 세션 시작 시각 — webview에서 실시간 카운트다운 표시용
    const nextAt = Date.now() + LOOP_INTERVAL_MIN * 60 * 1000;
    webviewView.webview.postMessage({ type: 'next_session', at: nextAt, intervalMin: LOOP_INTERVAL_MIN });

    this._sessionTimer = setTimeout(() => {
      if (this._loopActive) this._runAutonomousLoop(webviewView);
    }, LOOP_INTERVAL_MIN * 60 * 1000);
  }

  // ── 라운드 N 브리핑: 이전 결과를 파트장에게 평가시킴 ───────────
  _getRoundBriefing(round, prevResults) {
    const summary = prevResults.length > 0
      ? prevResults.map(r => `[${r.agentEmoji} ${r.agentName}]\n${r.result.slice(0, 600)}`).join('\n\n')
      : '(이전 라운드 산출물 없음)';

    return `자율 실행 루프 라운드 ${round}. 방금 팀이 만든 산출물입니다.

## 팀 산출물
${summary}

---

이 산출물을 보고 **다음 한 걸음**을 진행하세요. (평가만 늘어놓지 말 것)

1. 산출물로 목표가 전진했으면 **진행률을 올리세요**:
   <set_progress id="목표ID" progress="해당값" note="이 산출물로 무엇이 진전됐는지"/>
2. 더 필요하면 **이전과 다른 다음 작업**을 위임하세요 (이미 시킨 일 반복 금지):
   <delegate agent="..." task="구체적인 다음 단계"/>
3. 이번 세션에서 의미 있는 전진을 충분히 했으면 종료:
   <goal_status state="done" reason="이번 세션 성과 요약"/>

⚠️ 규칙:
- 직전 라운드와 **똑같은 지시·선언을 반복하지 마세요.** 매 라운드 실제로 다른 단계로 나아가야 합니다.
- 태그(<set_progress>/<delegate>/<goal_status>) 없이 말로만 하면 아무 일도 일어나지 않습니다.`;
  }

  // ── 자율 루프 정지 (사용자가 ⏸ 버튼 클릭) ─────────────────────
  _stopAutonomousLoop(webviewView) {
    this._loopActive = false;
    if (this._sessionTimer) { clearTimeout(this._sessionTimer); this._sessionTimer = null; }
    webviewView.webview.postMessage({ type: 'loop_status', text: '⏸ 자율 루프 정지됨 (▶ 버튼으로 재시작)' });
  }

  _getBriefingPrompt() {
    const now        = new Date();
    const todayStr   = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const workspaceDir = getWorkspaceRoot();
    const reportsDir = path.join(workspaceDir, 'reports');
    let previousReport = '';
    if (fs.existsSync(reportsDir)) {
      const reports = fs.readdirSync(reportsDir)
        .filter(f => f.endsWith('_cycle_report.md'))
        .sort()
        .reverse();
      if (reports.length > 0) {
        previousReport = fs.readFileSync(path.join(reportsDir, reports[0]), 'utf8').slice(0, 1500);
      }
    }
    const goalsPath = path.join(brain.BRAIN_DIR, 'company', 'goals.md');
    let goalsText = '';
    if (fs.existsSync(goalsPath)) {
      goalsText = fs.readFileSync(goalsPath, 'utf8').slice(0, 1000);
    }

    // ★ A) 오늘 승인된 결정 읽기
    const approvedDecisions = brain.getApprovedDecisions();
    const decisionsSummary = approvedDecisions.length > 0
      ? approvedDecisions
          .map(d => `- ${d.question} → 선택: **${d.chosenValue}**`)
          .join('\n')
      : '(오늘 승인된 결정 없음)';

    // ★ 구조화된 목표(연간/월간/주간/일간) — ID 포함, 진행률 갱신용
    const goalsSummary = brain.getGoalsSummary();

    // ★ 사람이 제공해준 자료 (need_human 응답) — 에이전트가 실제 데이터로 활용
    const fulfilled = brain.getFulfilledRequests();
    const fulfilledSummary = fulfilled.length > 0
      ? fulfilled.map(r => `- 요청: ${r.request}\n  → 사람이 제공: ${r.userResponse}`).join('\n')
      : '(아직 없음)';

    // ★ 대표님이 채택한 제안 — 파트장이 실행에 옮겨야 함
    const accepted = brain.getAcceptedSuggestions();
    const acceptedSummary = accepted.length > 0
      ? accepted.map(s => `- 채택: ${s.title}${s.userNote ? ` (대표님 메모: ${s.userNote})` : ''}`).join('\n')
      : '(아직 없음)';

    // ★ 팀이 올린 자료요청 검토 큐 (파트장이 선별 → 대표님께 최대 5건)
    const triage = brain.getTriageRequests();
    const pendingCount = brain.countPendingRequests();
    const slots = Math.max(0, brain.MAX_PENDING_REQUESTS - pendingCount);
    const triageSummary = triage.length > 0
      ? triage.slice(0, 20).map(r => `- [${r.id}] (${r.requestType}/${r.requestedBy}) ${r.request}`).join('\n')
      : '(검토할 요청 없음)';

    return `당신은 스타트업 파트장입니다. 지금은 ${todayStr}, 자율 실행 세션 ${this._sessionCount || 1}회차입니다.

## 회사 비전
${goalsText || '(목표가 설정되지 않았습니다)'}

## 추적 목표 (진행률·페이스 포함, 각 [목표ID]로 갱신 가능)
${goalsSummary}

## 오늘 승인된 결정
${decisionsSummary}

## 사람이 제공한 자료 (실제 데이터 — 적극 활용, 이건 사실임)
${fulfilledSummary}

## 대표님이 채택한 제안 (실행에 옮길 것)
${acceptedSummary}

## 팀이 올린 자료요청 — 검토 후 선별 (대표님 처리함 빈자리: ${slots}/${brain.MAX_PENDING_REQUESTS})
${triageSummary}

## 이전 실행 기록 (참고용 — 반복하지 말 것)
${previousReport ? previousReport : '(이전 기록이 없습니다)'}

---

# 0. 먼저: 위 '자료요청 검토'를 처리하세요 (대표님이 폭주에 묻히지 않게)

당신은 대표님께 올라갈 요청을 거르는 '필터'입니다. 위 검토 큐를 보고:
- **중복·겹치는 요청은 통합**하거나 폐기: <drop_request id="요청ID"/>
- **사소하거나 추정 가능한 것도 폐기**: <drop_request id="요청ID"/> (팀에겐 "추정으로 진행하라")
- **정말 중요한 것만** 우선순위를 매겨 대표님께 올림 (빈자리 ${slots}건까지만):
  <escalate_request id="요청ID" priority="high|medium|low"/>
- 대표님 처리함은 최대 ${brain.MAX_PENDING_REQUESTS}건. 넘치면 올리지 말고 다음 기회에.

# 임무: 전략 선언 금지, 실제 한 걸음 전진

⛔ 전략·계획은 이미 충분합니다. **"전략을 완성했다", "실행 단계로 전환한다", "모든 팀은 즉시 행동하라" 같은 선언·요약·구호를 절대 반복하지 마세요.** 그런 문장은 아무것도 바꾸지 못합니다. 위 '이전 실행 기록'과 똑같은 말을 반복하면 실패입니다.

✅ 대신 이번 세션에서 목표를 **실제로 전진**시키세요:

1. 위 추적 목표 중 **⚠️지연이거나 진행률이 낮은 목표 1~2개**를 고른다.
2. 그 목표를 전진시킬 **작고 구체적인 작업**을 팀원에게 즉시 위임한다 (반드시 태그):
   <delegate agent="business" task="사우디 핀테크 시장 규모와 주요 경쟁사 3곳을 조사해 표로 정리"/>
   <delegate agent="secretary" task="이집트 SME Pain Point 3건을 Knowledge Base 템플릿에 입력"/>
3. 목표가 중복되거나 어수선하면 목표관리자에게 정리를 맡긴다:
   <delegate agent="goal_manager" task="중복 목표를 통합하고 연→월→주→일 계층으로 재정리, 가중치 배분"/>

규칙:
- 추상적 지시("데이터를 수집하라") 금지 → 구체적으로("무엇의 무엇을 어떤 형식으로").
- 한 번에 1~3개 작업만. 거창한 선언 한 문단보다 작은 위임 하나가 낫다.
- 반드시 <delegate> 태그로 위임한다. 말로만 하면 아무도 실행하지 않는다.
- 새 결정이 필요할 때만 <ask_user>를 쓴다.
- 실시간 정보·외부 실행 등 AI가 할 수 없는 일이면 **지어내지 말고** 사람에게 요청한다:
  <need_human type="data" reason="실시간 시장 데이터는 조사 필요" request="2025 사우디 핀테크 시장 규모와 상위 3사를 알려주세요"/>`;
  }

  // ─────────────────────────────────────────────────────────
  // ★ C) 자동 투표: 에이전트들이 의사결정 항목에 투표
  // ─────────────────────────────────────────────────────────
  async runAgentVoting(question, options) {
    const votingAgents = ['developer', 'youtube', 'business', 'saudi', 'egypt'];
    const votes = {};  // { optionName: count, ... }
    const opinions = [];  // 각 에이전트의 의견

    for (const optionName of options) votes[optionName] = 0;

    for (const agentId of votingAgents) {
      const agent = AGENT_MAP.get(agentId);
      if (!agent) continue;

      try {
        const votingPrompt = `당신은 "${question}"에 대해 투표해야 합니다.

선택지: ${options.join(', ')}

당신의 전문 분야를 고려해서 가장 좋은 선택이 무엇인지 **1줄로** 말씀해 주세요.
반드시 위 선택지 중 하나를 고르고, 그 이유를 간단히 설명하세요.

예: "Stripe 추천. 수수료가 가장 저렴하고 한국 결제 지원이 좋습니다."`;

        const agentMemory = brain.getAgentMemory(agentId);
        const agentPrompt = buildSystemPrompt(agent.systemPrompt, agentId, brain.getCompanyContext(), agentMemory);

        const response = await fetch(LM_STUDIO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: await ensureModel(),
            messages: [{ role: 'system', content: agentPrompt }, { role: 'user', content: votingPrompt }],
            temperature: 0.5,
            max_tokens: 150,
            stream: false
          })
        });

        if (response.ok) {
          const data = await response.json();
          const opinion = (data.choices[0]?.message?.content ?? '').trim();

          if (opinion) {
            opinions.push({ agentId, agentName: agent.name, opinion });

            // 선택지 자동 인식 (의견에서 선택지가 언급된 경우)
            for (const option of options) {
              if (opinion.includes(option)) {
                votes[option]++;
                break;
              }
            }
          }
        }
      } catch (err) {
        // 투표 실패는 조용히 무시
      }

      // 에이전트 간 요청 딜레이
      await new Promise(r => setTimeout(r, 500));
    }

    // 투표 결과 정렬 (가장 많은 투표 순)
    const sortedVotes = Object.entries(votes)
      .sort((a, b) => b[1] - a[1])
      .map(([option, count]) => ({ option, count }));

    return {
      question,
      opinions,
      votes: sortedVotes,
      recommendation: sortedVotes.length > 0 ? sortedVotes[0].option : null,
      summary: sortedVotes.map(v => `${v.option} (${v.count}표)`).join(', ')
    };
  }

  // ─────────────────────────────────────────────────────────
  // ★ C) 결과물 검증 루프
  //   생성된 .py/.js 파일을 실행 → 에러 시 개발자가 자동 수정 → 재실행
  // ─────────────────────────────────────────────────────────
  async _verifyAndFix(relPath, webviewView) {
    const runner = getRunner(relPath);
    if (!runner) return null;  // 검증 대상 아님 (html, md 등)

    const workspaceRoot = getWorkspaceRoot();

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      webviewView.webview.postMessage({
        type: 'verify_status',
        text: `🔍 ${runner.label} 검증 중: ${relPath} (시도 ${attempt}/${MAX_FIX_ATTEMPTS})`
      });

      const result = await runFileOnce(relPath, workspaceRoot);

      // ── 통과 ──
      if (result.ok) {
        const msg = result.timedOut
          ? `✅ ${relPath} 실행됨 (장시간 실행 — 통과)`
          : `✅ ${relPath} 검증 통과`;
        webviewView.webview.postMessage({ type: 'verify_status', text: msg });
        brain.appendConversationLog('developer', '개발자(검증)', `검증: ${relPath}`, msg, '파일 검증 및 테스트 통과');
        if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
        return { ok: true, attempts: attempt };
      }

      // ── 에러 → 개발자에게 수정 요청 ──
      webviewView.webview.postMessage({
        type: 'verify_status',
        text: `🔧 에러 발견 → 개발자 수정 중 (${attempt}/${MAX_FIX_ATTEMPTS})`
      });

      let currentCode = '';
      try { currentCode = fs.readFileSync(safePath(relPath, workspaceRoot), 'utf8'); } catch {}

      const fixPrompt = `다음 ${runner.label} 코드를 실행했더니 에러가 발생했습니다. 원인을 분석하고 **수정된 전체 코드**를 같은 경로로 다시 저장하세요.

## 파일 경로
${relPath}

## 현재 코드
\`\`\`
${currentCode.slice(0, 4000)}
\`\`\`

## 실행 에러
\`\`\`
${result.output}
\`\`\`

반드시 <create_file path="${relPath}">수정된 전체 코드</create_file> 형식으로 전체 코드를 다시 작성하세요. 설명은 짧게.`;

      const fixAnswer  = await this._callAgentOnce('developer', fixPrompt);
      const fixActions = parseActionTags(fixAnswer)
        .filter(a => a.type === 'create_file' && a.path === relPath);

      if (fixActions.length === 0) {
        const msg = `⚠️ ${relPath} 수정 실패 (개발자가 수정 코드를 제출하지 않음)`;
        webviewView.webview.postMessage({ type: 'verify_status', text: msg });
        brain.appendConversationLog('developer', '개발자(검증)', `검증: ${relPath}`, msg, '파일 검증 및 테스트 통과');
        if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
        return { ok: false, attempts: attempt };
      }

      try { await executeAction(fixActions[0], workspaceRoot); } catch {}
    }

    const failMsg = `❌ ${relPath} ${MAX_FIX_ATTEMPTS}회 시도 후에도 실패 — 사람 확인 필요`;
    webviewView.webview.postMessage({ type: 'verify_status', text: failMsg });
    brain.appendConversationLog('developer', '개발자(검증)', `검증: ${relPath}`, failMsg);
    return { ok: false, attempts: MAX_FIX_ATTEMPTS };
  }

  // 에이전트 1회 비스트리밍 호출 (검증 수정용)
  async _callAgentOnce(agentId, userPrompt) {
    const agent = AGENT_MAP.get(agentId);
    if (!agent) return '';
    try {
      const res = await fetch(LM_STUDIO_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: await ensureModel(),
          messages: [
            { role: 'system', content: buildSystemPrompt(agent.systemPrompt, agentId) },
            { role: 'user',   content: userPrompt }
          ],
          temperature: 0.3, stream: false
        })
      });
      if (!res.ok) return '';
      return ((await res.json()).choices[0]?.message?.content ?? '').trim();
    } catch { return ''; }
  }

  async _handleCeoWithPlan(userText, webviewView, round = 0) {
    const ceoAgent = AGENT_MAP.get('ceo');

    // Step 1: CEO 버블 먼저 표시
    webviewView.webview.postMessage({
      type : 'routing_done',
      agent: { id: ceoAgent.id, name: ceoAgent.name, emoji: ceoAgent.emoji, color: ceoAgent.color }
    });

    // CEO 기록에 사용자 메시지 추가
    const ceoHistory = this.histories['ceo'];
    ceoHistory.push({ role: 'user', content: userText });
    if (ceoHistory.length > MAX_TURNS * 2) this.histories['ceo'] = ceoHistory.slice(-MAX_TURNS * 2);

    // Step 2: CEO 응답 스트리밍 (delegate 태그 포함 가능)
    let ceoAnswer = '';
    try {
      await streamLmStudio(
        buildSystemPrompt(ceoAgent.systemPrompt, 'ceo'), // CEO_DELEGATE_PROMPT 포함됨
        this.histories['ceo'],
        chunk => { ceoAnswer += chunk; webviewView.webview.postMessage({ type: 'chunk', text: chunk }); },
        async () => {}
      );
    } catch (err) {
      webviewView.webview.postMessage({ type: 'error', text: _errMsg(err) });
      return;
    }

    // Step 3: CEO 응답에서 위임/질문/완료판단/목표관리/사람요청/제안/검토 태그 파싱
    let   delegates    = parseDelegateTags(ceoAnswer);
    const askUsers     = parseAskUserTags(ceoAnswer);
    const goalStatus   = parseGoalStatus(ceoAnswer);   // ★ 완료 판단
    const needHumans   = parseNeedHuman(ceoAnswer);    // ★ 사람 도움 요청
    const suggestions  = parseSuggest(ceoAnswer);      // ★ 대표님께 제안
    const escalates    = parseEscalateRequests(ceoAnswer); // ★ 요청 승격
    const drops        = parseDropRequests(ceoAnswer);     // ★ 요청 폐기
    const hasReviewTags = escalates.length || drops.length;
    const hasGoalTags  = /<(add_goal|set_progress|update_goal|delete_goal)\b/.test(ceoAnswer);
    let cleanCeoAnswer = ceoAnswer;

    if (delegates.length || askUsers.length || goalStatus || needHumans.length || suggestions.length || hasReviewTags || hasGoalTags) {
      cleanCeoAnswer = stripReviewTags(stripSuggest(stripNeedHuman(stripGoalTags(stripGoalStatus(stripDelegateTags(stripAskUserTags(ceoAnswer)))))));
      webviewView.webview.postMessage({ type: 'update_bubble', text: cleanCeoAnswer });
    }

    // ★ 목표 관리 태그 적용 (수립/진행률/수정/제거 — 계층·가중치 포함)
    for (const gm of applyGoalTags(ceoAnswer)) {
      webviewView.webview.postMessage({ type: 'loop_status', text: gm });
    }

    // ★ 파트장의 요청 검토: 중복 폐기 → 중요한 것만 승격(상한 5건)
    for (const id of drops) {
      if (brain.dropRequest(id)) webviewView.webview.postMessage({ type: 'loop_status', text: `🗑 요청 폐기(중복/사소): ${id}` });
    }
    for (const esc of escalates) {
      const res = brain.escalateRequest(esc.id, esc.priority);
      if (res && res.capped) {
        webviewView.webview.postMessage({ type: 'loop_status', text: `⛔ 대표님 처리함 상한(${brain.MAX_PENDING_REQUESTS}건) — 승격 보류` });
        break;
      } else if (res) {
        webviewView.webview.postMessage({ type: 'loop_status', text: `⬆️ 대표님께 올림: ${(res.request || '').slice(0, 40)}` });
      }
    }

    // ★ 사람 도움 요청 → 검토 대기(triage)로 (파트장이 나중에 선별해 대표님께 승격)
    for (const nh of needHumans) {
      const reqItem = brain.saveRequest({ ...nh, requestedBy: '파트장' });
      if (reqItem) webviewView.webview.postMessage({ type: 'loop_status', text: `📥 검토 대기 등록: ${nh.request.slice(0, 50)}` });
    }

    // ★ 파트장의 제안 → 대표님 처리함에 쌓기
    for (const sg of suggestions) {
      const sgItem = brain.saveSuggestion({ ...sg, requestedBy: '파트장' });
      if (sgItem) webviewView.webview.postMessage({ type: 'loop_status', text: `💡 대표님께 제안: ${sg.title}` });
    }

    // ★ 결정 항목 저장 (C) 자동 투표 포함) 및 UI에 알림
    for (const ask of askUsers) {
      // C) 자동 투표: 에이전트들이 의견 제시
      webviewView.webview.postMessage({ type: 'update_bubble', text: '팀 투표 중...' });
      const voteResults = await runAgentVoting(ask.question, ask.options);

      const decision = brain.saveDecision({
        question: ask.question,
        options: ask.options,
        priority: ask.priority,
        recommended: ask.recommended,
        requestedBy: '파트장',
        voteResults  // ★ 투표 결과 저장
      });
      if (decision) {
        webviewView.webview.postMessage({ type: 'new_decision', decision });
      }
    }

    // CEO 기록에 응답 저장
    this.histories['ceo'].push({ role: 'assistant', content: cleanCeoAnswer });
    brain.appendConversationLog('ceo', '파트장', userText, cleanCeoAnswer, '회사 방향 결정 및 팀 조율');
    // ★ 대시보드 갱신
    if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
    extractAndSaveMemory('ceo', userText, cleanCeoAnswer, () => {
      webviewView.webview.postMessage({ type: 'memory_saved' });
    }).catch(() => {});

    // ★ 폴백: 파트장이 위임 태그 없이 '산문'으로만 지시한 경우 → 태그로 자동 변환
    //   (로컬 LLM이 <delegate> 형식을 못 지켜 팀이 멈추는 문제 방지)
    //   자율 루프(round>=1)에서만 작동 — 수동 채팅은 예측 가능하게 유지
    if (round >= 1 && delegates.length === 0 && askUsers.length === 0 && (!goalStatus || goalStatus.state !== 'done')) {
      webviewView.webview.postMessage({ type: 'loop_status', text: '🔁 파트장 지시를 실행 가능한 위임으로 변환 중…' });
      const recovered = await extractDelegatesFromProse(cleanCeoAnswer);
      if (recovered.length > 0) {
        delegates = recovered;
        webviewView.webview.postMessage({
          type: 'loop_status',
          text: `🔁 산문 지시 → ${recovered.length}건 위임으로 변환: ${recovered.map(d => AGENT_MAP.get(d.agent)?.name || d.agent).join(', ')}`
        });
      }
    }

    // 위임 없으면 종료 (루프 호출자에게 상태 반환)
    if (delegates.length === 0) {
      webviewView.webview.postMessage({ type: 'done' });
      return { delegateResults: [], status: goalStatus };
    }

    // Step 4: 위임된 에이전트들을 순서대로 실행
    const delegateResults = [];

    for (let i = 0; i < delegates.length; i++) {
      const del   = delegates[i];
      const agent = AGENT_MAP.get(del.agent);

      webviewView.webview.postMessage({
        type : 'task_start',
        index: i,
        agent: { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color }
      });

      // 이전 에이전트 결과를 현재 작업 컨텍스트에 추가 (유기적 연결)
      let taskPrompt = del.task;
      if (delegateResults.length > 0) {
        const prevSummary = delegateResults
          .map(r => `[${r.agentEmoji} ${r.agentName}의 결과]\n${r.result.slice(0, 600)}`)
          .join('\n\n');
        taskPrompt += `\n\n## 앞선 에이전트 작업 결과 (참고)\n${prevSummary}`;
      }

      const sessionHistory = [{ role: 'user', content: taskPrompt }];
      let taskAnswer = '';

      try {
        await streamLmStudio(
          buildSystemPrompt(agent.systemPrompt, agent.id),
          sessionHistory,
          chunk => {
            taskAnswer += chunk;
            webviewView.webview.postMessage({ type: 'task_chunk', text: chunk });
          },
          async () => {}
        );
      } catch (err) {
        taskAnswer = `오류: ${String(err)}`;
      }

      // ★ 목표관리자 에이전트의 응답이면 목표 관리 태그(수립/가중치/진행률) 적용
      if (agent.id === 'goal_manager') {
        for (const gm of applyGoalTags(taskAnswer)) {
          webviewView.webview.postMessage({ type: 'loop_status', text: gm });
        }
        taskAnswer = stripGoalTags(taskAnswer);
        if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
      }

      // ★ 어느 에이전트든 "혼자 못 함, 사람 필요"를 표시하면 대표님 처리함에 쌓기
      const agentNeeds = parseNeedHuman(taskAnswer);
      if (agentNeeds.length > 0) {
        for (const nh of agentNeeds) {
          const reqItem = brain.saveRequest({ ...nh, requestedBy: agent.name });
          if (reqItem) webviewView.webview.postMessage({ type: 'loop_status', text: `🙋 ${agent.name} 사람 도움 요청: ${nh.request.slice(0, 50)}` });
        }
        taskAnswer = stripNeedHuman(taskAnswer);
        if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
      }

      // 에이전트 응답의 XML 액션 태그 실행 (파일 생성, 명령어 등)
      const taskActions   = parseActionTags(taskAnswer);
      const cleanTaskAnswer = taskActions.length > 0 ? stripActionTags(taskAnswer) : taskAnswer;

      if (taskActions.length > 0) {
        webviewView.webview.postMessage({ type: 'update_task_bubble', text: cleanTaskAnswer });
        const workspaceRoot = getWorkspaceRoot();
        for (const action of taskActions) {
          try {
            webviewView.webview.postMessage({ type: 'action_result', result: await executeAction(action, workspaceRoot) });
            // ★ 생성된 코드 파일이면 실행 검증 + 자동 수정
            if (action.type === 'create_file' && getRunner(action.path)) {
              await this._verifyAndFix(action.path, webviewView);
            }
          } catch (err) {
            webviewView.webview.postMessage({ type: 'action_result', result: { type: action.type, path: action.path || '', error: String(err) } });
          }
        }
      }

      delegateResults.push({
        agentId   : agent.id,
        agentName : agent.name,
        agentEmoji: agent.emoji,
        task      : del.task,
        result    : cleanTaskAnswer
      });

      const taskSummary = del.task.slice(0, 80).replace(/\n/g, ' ') + ' — 완료';
      brain.appendConversationLog(agent.id, agent.name, del.task.slice(0, 300), cleanTaskAnswer, taskSummary);
      // ★ 위임 작업도 기억으로 저장 (자율 위임 에이전트의 기억이 쌓이도록)
      await extractAndSaveMemory(agent.id, del.task, cleanTaskAnswer, () => {
        webviewView.webview.postMessage({ type: 'memory_saved' });
      }).catch(() => {});
      if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
      webviewView.webview.postMessage({ type: 'task_done', index: i });
    }

    webviewView.webview.postMessage({ type: 'done' });
    // ★ 루프 호출자에게 이번 라운드 결과 + 완료 상태 반환
    return { delegateResults, status: goalStatus };
  }

  // ── CEO 단일 라우팅 (폴백 + 직접 호출용으로 유지) ────────────
  async _handleCeoRouting(userText, webviewView) {
    webviewView.webview.postMessage({ type: 'routing_start' });
    let agentId;
    try   { agentId = await classifyAgent(userText); }
    catch { agentId = 'ceo'; }
    const agent = AGENT_MAP.get(agentId);
    webviewView.webview.postMessage({
      type : 'routing_done',
      agent: { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color }
    });
    const history = this.histories[agentId];
    history.push({ role: 'user', content: userText });
    if (history.length > MAX_TURNS * 2) this.histories[agentId] = history.slice(-MAX_TURNS * 2);
    let fullAnswer = '';
    try {
      await streamLmStudio(
        buildSystemPrompt(agent.systemPrompt, agentId),
        this.histories[agentId],
        chunk => { fullAnswer += chunk; webviewView.webview.postMessage({ type: 'chunk', text: chunk }); },
        async () => { await this._onStreamDone(fullAnswer, agentId, userText, webviewView); }
      );
    } catch (err) {
      webviewView.webview.postMessage({ type: 'error', text: _errMsg(err) });
    }
  }

  // ── 직접 대화 ──────────────────────────────────────────────
  async _handleDirectChat(userText, webviewView) {
    const agentId = this.currentAgentId;
    const agent   = AGENT_MAP.get(agentId);
    const history = this.histories[agentId];
    history.push({ role: 'user', content: userText });
    if (history.length > MAX_TURNS * 2) this.histories[agentId] = history.slice(-MAX_TURNS * 2);
    let fullAnswer = '';
    try {
      await streamLmStudio(
        buildSystemPrompt(agent.systemPrompt, agentId),
        history,
        chunk => { fullAnswer += chunk; webviewView.webview.postMessage({ type: 'chunk', text: chunk }); },
        async () => { await this._onStreamDone(fullAnswer, agentId, userText, webviewView); }
      );
    } catch (err) {
      webviewView.webview.postMessage({ type: 'error', text: _errMsg(err) });
    }
  }

  // ── 스트리밍 완료 공통 처리 ────────────────────────────────
  async _onStreamDone(fullAnswer, agentId, userText, webviewView) {
    const agent   = AGENT_MAP.get(agentId);
    this.histories[agentId].push({ role: 'assistant', content: fullAnswer });
    const actions   = parseActionTags(fullAnswer);
    const cleanText = actions.length > 0 ? stripActionTags(fullAnswer) : fullAnswer;
    if (actions.length > 0) {
      webviewView.webview.postMessage({ type: 'update_bubble', text: cleanText });
      const workspaceRoot = getWorkspaceRoot();
      for (const action of actions) {
        try {
          webviewView.webview.postMessage({ type: 'action_result', result: await executeAction(action, workspaceRoot) });
          // ★ 생성된 코드 파일이면 실행 검증 + 자동 수정
          if (action.type === 'create_file' && getRunner(action.path)) {
            await this._verifyAndFix(action.path, webviewView);
          }
        } catch (err) {
          webviewView.webview.postMessage({ type: 'action_result', result: { type: action.type, path: action.path || '', error: String(err) } });
        }
      }
    }
    // 첫 문장을 요약으로 (마침표/물음표/느낌표 기준)
    const firstSentence = cleanText.match(/^.+?[.!?]/)?.[0] || cleanText.slice(0, 100);
    brain.appendConversationLog(agentId, agent.name, userText, cleanText, firstSentence);
    // ★ 대시보드 갱신 (새 활동 표시)
    if (DashboardPanel.currentPanel) DashboardPanel.currentPanel._update();
    extractAndSaveMemory(agentId, userText, cleanText, () => {
      webviewView.webview.postMessage({ type: 'memory_saved' });
    }).catch(() => {});
    webviewView.webview.postMessage({ type: 'done' });
  }

  // ── HTML ────────────────────────────────────────────────────
  getHtml() {
    const agentsJson = JSON.stringify(AGENTS.map(({ id, name, emoji, color, role }) => ({ id, name, emoji, color, role })));
    const defaultId  = DEFAULT_AGENT_ID;
    const brainPath  = brain.BRAIN_DIR;

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; font-family: sans-serif; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  body { display: flex; flex-direction: column; padding: 8px; gap: 6px; }

  /* ── 탭 ── */
  #agentTabs { display: flex; gap: 4px; flex-wrap: wrap; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-input-border, #555); }
  .agent-tab { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; background: transparent; color: var(--vscode-foreground); font-size: 12px; white-space: nowrap; transition: background 0.15s; }
  .agent-tab:hover { background: var(--vscode-list-hoverBackground); }
  .agent-tab.active { border-color: var(--tab-color); background: color-mix(in srgb, var(--tab-color) 15%, transparent); color: var(--tab-color); font-weight: 600; }
  .agent-tab[data-id="ceo"]::after { content: 'PLAN'; font-size: 9px; padding: 1px 4px; background: color-mix(in srgb, var(--tab-color, #f0c040) 30%, transparent); border-radius: 3px; margin-left: 2px; }

  /* ── 정보 바 ── */
  #agentInfo { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .info-btns { display: flex; gap: 5px; }

  /* ── 자율 세션 간격 조절 ── */
  .loop-config { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; margin-top: 10px; }
  .loop-config-title { font-size: 12px; font-weight: 700; color: #c9d1d9; margin-bottom: 8px; }
  .loop-config-row { display: flex; align-items: center; gap: 8px; }
  .loop-slider { flex: 1; height: 6px; background: #21262d; border: none; border-radius: 3px; cursor: pointer; accent-color: #58a6ff; }
  .loop-value { font-size: 14px; font-weight: 700; color: #58a6ff; min-width: 28px; text-align: right; }
  .loop-unit { font-size: 12px; color: #8b949e; }
  .loop-config-hint { font-size: 11px; color: #6e7681; margin-top: 6px; }
  .next-session { font-size: 11px; color: #6e7681; margin-top: 6px; }
  .next-session.counting { color: #58a6ff; font-weight: 600; }
  .next-session.running { color: #3fb950; font-weight: 600; }
  .mini-btn { padding: 2px 7px; cursor: pointer; background: transparent; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-input-border, #555); border-radius: 4px; font-size: 11px; }
  .mini-btn:hover { opacity: 0.8; }
  #loopStatus { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 3px 8px; min-height: 16px; opacity: 0.85; }
  #loopStatus:empty { display: none; }

  /* ── 메시지 ── */
  #log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .msg { padding: 8px 10px; border-radius: 8px; line-height: 1.6; word-break: break-word; font-size: 13px; }
  .me { background: var(--vscode-input-background); align-self: flex-end; max-width: 90%; }
  .ai { background: var(--vscode-editor-inactiveSelectionBackground); align-self: flex-start; max-width: 95%; }
  .system { text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px; align-self: center; }
  .agent-header { font-size: 11px; font-weight: 600; padding-bottom: 5px; margin-bottom: 5px; border-bottom: 1px solid rgba(128,128,128,0.25); }
  .bubble-text { white-space: pre-wrap; word-break: break-word; }

  /* ── 라우팅 카드 (단일 에이전트용) ── */
  .routing-card { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 12px; font-size: 12px; align-self: flex-start; border: 1px solid var(--vscode-input-border, #555); background: var(--vscode-editor-inactiveSelectionBackground); }
  .routing-card .r-from { color: #f0c040; font-weight: 600; }
  .routing-card .r-arrow { color: var(--vscode-descriptionForeground); }
  .routing-card .r-to { font-weight: 600; }
  .routing-card.analyzing .r-to { animation: rpulse 1.2s ease-in-out infinite; }

  /* ★ 7단계: 플랜 카드 ── */
  .plan-card { padding: 10px 12px; border-radius: 8px; font-size: 12px; border: 1px solid #f0c040; background: color-mix(in srgb, #f0c040 6%, var(--vscode-editor-inactiveSelectionBackground)); align-self: flex-start; max-width: 95%; }
  .plan-card.planning { border-color: var(--vscode-input-border, #555); }
  .plan-header { font-weight: 700; color: #f0c040; margin-bottom: 5px; font-size: 13px; }
  .plan-brief { margin-bottom: 8px; color: var(--vscode-foreground); }
  .plan-tasks { display: flex; flex-direction: column; gap: 4px; }
  .plan-task { display: flex; align-items: baseline; gap: 6px; padding: 3px 6px; border-radius: 4px; }
  .plan-task.active { background: color-mix(in srgb, var(--task-color, #fff) 12%, transparent); }
  .task-num { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 14px; }
  .task-agent { font-weight: 600; white-space: nowrap; }
  .task-desc { flex: 1; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-status { font-size: 12px; margin-left: auto; min-width: 16px; text-align: right; }
  .plan-divider { border: none; border-top: 1px solid rgba(128,128,128,0.2); margin: 6px 0; }

  /* ── 액션 결과 카드 ── */
  .action-card { padding: 8px 12px; border-radius: 6px; font-size: 12px; border-left: 3px solid #4ec9b0; background: color-mix(in srgb, #4ec9b0 8%, transparent); align-self: flex-start; max-width: 95%; }
  .action-card.err-card { border-left-color: #f44747; background: color-mix(in srgb, #f44747 8%, transparent); }
  .action-card strong { display: block; margin-bottom: 3px; }
  .action-card code { font-family: monospace; font-size: 11px; background: rgba(0,0,0,0.25); padding: 1px 5px; border-radius: 3px; }
  .action-card pre { margin: 6px 0 0; font-size: 11px; font-family: monospace; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 6px; border-radius: 4px; }
  .action-card pre.stderr { color: #f44747; }

  /* ── 토스트 ── */
  #memToast { position: fixed; bottom: 60px; right: 8px; font-size: 11px; padding: 4px 10px; border-radius: 6px; background: color-mix(in srgb, #4ec9b0 20%, transparent); border: 1px solid #4ec9b0; color: #4ec9b0; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
  #memToast.show { opacity: 1; }

  /* ── 커서 ── */
  .cursor { display: inline-block; width: 2px; height: 1em; background: currentColor; vertical-align: text-bottom; animation: blink 0.8s step-end infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes rpulse { 0%,100%{opacity:0.3} 50%{opacity:1} }

  /* ── 입력 ── */
  .input-row { display: flex; gap: 6px; align-items: flex-end; }
  #box { flex: 1; padding: 6px 8px; resize: none; overflow-y: auto; min-height: 36px; max-height: 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 6px; font-family: inherit; font-size: inherit; line-height: 1.5; }
  #box:focus { outline: 1px solid var(--vscode-focusBorder); }
  #sendBtn { padding: 6px 12px; cursor: pointer; white-space: nowrap; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; }
  #sendBtn:hover { opacity: 0.9; }
  #sendBtn:disabled { opacity: 0.45; cursor: not-allowed; }
  .hint { font-size: 10px; color: var(--vscode-descriptionForeground); text-align: right; }
</style>
</head>
<body>
  <div id="agentTabs"></div>
  <div id="agentInfo">
    <span id="agentRole"></span>
    <div class="info-btns">
      <button class="mini-btn" id="dashBtn">📊 대시보드</button>
      <button class="mini-btn" id="goalBtn">🎯 목표</button>
      <button class="mini-btn" id="brainBtn" title="${brainPath}">🧠 뇌 폴더</button>
      <button class="mini-btn" id="loopBtn">⏸ 자율정지</button>
      <button class="mini-btn" id="clearBtn">초기화</button>
    </div>
  </div>
  <div id="loopStatus"></div>

  <!-- ★ 자율 세션 간격 조절 -->
  <div class="loop-config">
    <div class="loop-config-title">⏱️ 자율 세션 간격</div>
    <div class="loop-config-row">
      <input type="range" id="loopIntervalSlider" min="1" max="180" value="${LOOP_INTERVAL_MIN}" class="loop-slider"/>
      <span id="loopIntervalValue" class="loop-value">${LOOP_INTERVAL_MIN}</span>
      <span class="loop-unit">분</span>
    </div>
    <div id="nextSession" class="next-session">Local LLM으로 무제한 테스트 가능</div>
  </div>

  <div id="log"></div>
  <div id="memToast">🧠 기억 저장됨</div>
  <div class="input-row">
    <textarea id="box" rows="1" placeholder="메시지 입력… (Enter: 전송 / Shift+Enter: 줄바꿈)"></textarea>
    <button id="sendBtn">보내기</button>
  </div>
  <div class="hint">Enter 전송 · Shift+Enter 줄바꿈</div>

<script>
  const AGENTS    = ${agentsJson};
  const AGENT_MAP = new Map(AGENTS.map(a => [a.id, a]));
  let   currentId = '${defaultId}';

  const vscode    = acquireVsCodeApi();
  const log       = document.getElementById('log');
  const box       = document.getElementById('box');
  const sendBtn   = document.getElementById('sendBtn');
  const clearBtn  = document.getElementById('clearBtn');
  const brainBtn  = document.getElementById('brainBtn');
  const agentTabs = document.getElementById('agentTabs');
  const agentRole = document.getElementById('agentRole');
  const memToast  = document.getElementById('memToast');

  let streaming        = false;
  let currentAiBubble  = null; // 단일 에이전트 응답 + CEO 종합
  let currentTaskBubble= null; // 멀티에이전트 개별 태스크
  let routingCard      = null;
  let planCard         = null; // ★ 7단계: 플랜 카드

  // ── 탭 생성 ────────────────────────────────────────────────
  AGENTS.forEach(agent => {
    const btn = document.createElement('button');
    btn.className  = 'agent-tab';
    btn.dataset.id = agent.id;
    btn.style.setProperty('--tab-color', agent.color);
    btn.innerHTML  = agent.emoji + ' ' + agent.name;
    btn.addEventListener('click', () => switchAgent(agent.id));
    agentTabs.appendChild(btn);
  });

  function switchAgent(agentId) {
    if (agentId === currentId) return;
    currentId = agentId;
    const agent = AGENT_MAP.get(agentId);
    document.querySelectorAll('.agent-tab').forEach(b => b.classList.toggle('active', b.dataset.id === agentId));
    agentRole.textContent = agentId === 'ceo'
      ? agent.emoji + ' CEO — 복잡한 작업을 계획하고 팀에 분배합니다'
      : agent.emoji + ' ' + agent.name + ' — ' + agent.role;
    const notice = document.createElement('div');
    notice.className   = 'msg system';
    notice.textContent = '── ' + agent.emoji + ' ' + agent.name + '와(과) 대화를 시작합니다 ──';
    log.appendChild(notice);
    scrollBottom();
    vscode.postMessage({ type: 'switchAgent', agentId });
  }

  (function initUI() {
    const agent = AGENT_MAP.get(currentId);
    document.querySelectorAll('.agent-tab').forEach(b => b.classList.toggle('active', b.dataset.id === currentId));
    agentRole.textContent = agent.emoji + ' CEO — 복잡한 작업을 계획하고 팀에 분배합니다';
    const welcome = document.createElement('div');
    welcome.className = 'msg ai';
    const wt = document.createElement('div');
    wt.className   = 'bubble-text';
    wt.textContent = agent.emoji + ' 안녕하세요! CEO입니다.\\n복잡한 요청은 팀원들에게 나눠서 처리하고 종합 보고를 드립니다.\\n\\n뇌 폴더: ${brainPath}';
    welcome.appendChild(wt);
    log.appendChild(welcome);
  })();

  function scrollBottom() { log.scrollTop = log.scrollHeight; }

  function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── AI 말풍선 생성 헬퍼 ────────────────────────────────────
  function createAiBubble(agent) {
    const bubble   = document.createElement('div');
    bubble.className = 'msg ai';
    if (agent) {
      const header = document.createElement('div');
      header.className   = 'agent-header';
      header.style.color = agent.color;
      header.textContent = agent.emoji + ' ' + agent.name;
      bubble.appendChild(header);
    }
    const textArea = document.createElement('div');
    textArea.className = 'bubble-text';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    textArea.appendChild(cursor);
    bubble.appendChild(textArea);
    log.appendChild(bubble);
    scrollBottom();
    return bubble;
  }

  // 액션 결과 카드
  function createActionCard(result) {
    const card = document.createElement('div');
    card.className = 'action-card';
    if (result.error) {
      card.className += ' err-card';
      card.innerHTML = '<strong>❌ 오류 — ' + esc(result.type) + '</strong><code>' + esc(result.path) + '</code><pre class="stderr">' + esc(result.error) + '</pre>';
      return card;
    }
    switch (result.type) {
      case 'create_file': card.innerHTML = '<strong>📄 파일 생성됨</strong><code>' + esc(result.path) + '</code>'; break;
      case 'edit_file'  : card.innerHTML = '<strong>✏️ 파일 수정됨</strong><code>' + esc(result.path) + '</code>'; break;
      case 'read_file'  : card.innerHTML = '<strong>📖 파일 읽기</strong> <code>' + esc(result.path) + '</code><pre>' + esc(result.content.slice(0,3000)) + '</pre>'; break;
      case 'list_files' : card.innerHTML = '<strong>📁 파일 목록</strong> <code>' + esc(result.path) + '</code><pre>' + esc(result.entries.join('\\n')) + '</pre>'; break;
      case 'run_command': card.innerHTML = '<strong>💻 명령어 실행</strong><br><code>$ ' + esc(result.command) + '</code><pre class="' + (result.isError?'stderr':'') + '">' + esc(result.output) + '</pre>'; break;
    }
    return card;
  }

  box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight,120)+'px'; });

  // ── 전송 ───────────────────────────────────────────────────
  function ask() {
    const text = box.value.trim();
    if (!text || streaming) return;
    const meBubble = document.createElement('div');
    meBubble.className = 'msg me';
    const mt = document.createElement('div');
    mt.className = 'bubble-text'; mt.textContent = text;
    meBubble.appendChild(mt); log.appendChild(meBubble); scrollBottom();
    box.value = ''; box.style.height = 'auto';
    // CEO 모드: planning_start/routing_done/plan_ready 이벤트에서 버블 생성
    if (currentId !== 'ceo') {
      currentAiBubble = createAiBubble(null);
    }
    streaming = true; sendBtn.disabled = true;
    vscode.postMessage({ type: 'ask', text });
  }

  sendBtn.addEventListener('click', ask);
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });

  clearBtn.addEventListener('click', () => {
    const agent = AGENT_MAP.get(currentId);
    log.innerHTML = '';
    const msg = document.createElement('div'); msg.className = 'msg ai';
    const t = document.createElement('div'); t.className = 'bubble-text';
    t.textContent = agent.emoji + ' 대화가 초기화됐어요!';
    msg.appendChild(t); log.appendChild(msg);
    vscode.postMessage({ type: 'clear' });
  });

  // ★ 자율 세션 간격 조절 슬라이더
  const loopSlider = document.getElementById('loopIntervalSlider');
  const loopValue = document.getElementById('loopIntervalValue');
  if (loopSlider) {
    // 드래그 중에는 숫자만 갱신 (메시지 폭주 방지)
    loopSlider.addEventListener('input', (e) => {
      loopValue.textContent = e.target.value;
    });
    // 손을 뗄 때만 실제로 저장
    loopSlider.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'set_loop_interval', minutes: Number(e.target.value) });
    });
  }

  brainBtn.addEventListener('click', () => vscode.postMessage({ type: 'open_brain' }));
  document.getElementById('dashBtn').addEventListener('click', () => vscode.postMessage({ type: 'open_dashboard' }));
  document.getElementById('goalBtn').addEventListener('click', () => vscode.postMessage({ type: 'open_goals' }));

  // ★ 자율 루프 정지/재시작 토글
  let loopRunning = true;
  const loopBtn = document.getElementById('loopBtn');
  loopBtn.addEventListener('click', () => {
    if (loopRunning) {
      vscode.postMessage({ type: 'stop_loop' });
      loopBtn.textContent = '▶ 자율시작';
      loopRunning = false;
    } else {
      vscode.postMessage({ type: 'start_loop' });
      loopBtn.textContent = '⏸ 자율정지';
      loopRunning = true;
    }
  });

  function showMemToast() { memToast.classList.add('show'); setTimeout(() => memToast.classList.remove('show'), 2000); }

  // ── 다음 자율 세션 카운트다운 ──────────────────────────────
  let nextSessionAt = 0;
  let countdownTimer = null;
  function fmtRemain(ms) {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    return mm + '분 ' + String(ss).padStart(2, '0') + '초';
  }
  function renderCountdown() {
    const el = document.getElementById('nextSession');
    if (!el) return;
    const remain = nextSessionAt - Date.now();
    if (remain <= 0) {
      el.className = 'next-session running';
      el.textContent = '▶ 곧 다음 세션 시작…';
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
      return;
    }
    el.className = 'next-session counting';
    el.textContent = '⏳ 다음 자율 세션까지 ' + fmtRemain(remain);
  }
  function startCountdown(at) {
    nextSessionAt = at;
    if (countdownTimer) clearInterval(countdownTimer);
    renderCountdown();
    countdownTimer = setInterval(renderCountdown, 1000);
  }
  function stopCountdown(runningText) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    const el = document.getElementById('nextSession');
    if (el) {
      el.className = 'next-session running';
      el.textContent = runningText || '🔄 자율 세션 진행 중…';
    }
  }

  // ── 메시지 처리 ────────────────────────────────────────────
  window.addEventListener('message', event => {
    const msg = event.data;

    // ★ 다음 세션 카운트다운 시작
    if (msg.type === 'next_session') {
      startCountdown(msg.at);
      return;
    }
    // ★ 세션 시작 → 카운트다운 종료
    if (msg.type === 'session_running') {
      stopCountdown();
      return;
    }

    // ★ 자율 루프 / 검증 상태 표시
    if (msg.type === 'loop_status' || msg.type === 'verify_status') {
      const ls = document.getElementById('loopStatus');
      if (ls) ls.textContent = msg.text;
      return;
    }

    // 단일 라우팅
    if (msg.type === 'routing_start') {
      routingCard = document.createElement('div');
      routingCard.className = 'routing-card analyzing';
      routingCard.innerHTML = '<span class="r-from">🏢 CEO</span><span class="r-arrow">→</span><span class="r-to">분석 중...</span>';
      log.appendChild(routingCard); scrollBottom();

    } else if (msg.type === 'routing_done') {
      if (routingCard) {
        routingCard.classList.remove('analyzing');
        routingCard.querySelector('.r-to').innerHTML = '<span style="color:' + msg.agent.color + '">' + msg.agent.emoji + ' ' + msg.agent.name + '</span>';
      }
      currentAiBubble = createAiBubble(msg.agent);

    // ★ 7단계: 플래너 시작
    } else if (msg.type === 'planning_start') {
      planCard = document.createElement('div');
      planCard.className = 'plan-card planning';
      planCard.innerHTML = '<div class="plan-header">🏢 CEO 작업 계획 수립 중...</div>';
      log.appendChild(planCard); scrollBottom();

    // ★ 7단계: 계획 완성 → 플랜 카드 업데이트
    } else if (msg.type === 'plan_ready') {
      if (planCard) {
        planCard.classList.remove('planning');
        const nums = ['①','②','③','④'];
        const tasksHtml = msg.tasks.map((t, i) =>
          '<div class="plan-task" data-index="' + i + '" style="--task-color:' + t.agentColor + '">' +
          '<span class="task-num">' + (nums[i]||i+1) + '</span>' +
          '<span class="task-agent" style="color:' + t.agentColor + '">' + t.agentEmoji + ' ' + t.agentName + '</span>' +
          '<span class="task-desc">' + esc(t.task.slice(0,50)) + '</span>' +
          '<span class="task-status">○</span>' +
          '</div>'
        ).join('');
        planCard.innerHTML =
          '<div class="plan-header">🏢 CEO 작업 계획</div>' +
          '<div class="plan-brief">' + esc(msg.brief) + '</div>' +
          '<div class="plan-tasks">' + tasksHtml + '</div>';
      }

    // ★ 7단계: 개별 태스크 시작
    } else if (msg.type === 'task_start') {
      if (planCard) {
        // 이전 active 제거
        planCard.querySelectorAll('.plan-task.active').forEach(el => el.classList.remove('active'));
        const taskEl = planCard.querySelector('.plan-task[data-index="' + msg.index + '"]');
        if (taskEl) {
          taskEl.classList.add('active');
          taskEl.querySelector('.task-status').textContent = '⏳';
        }
      }
      currentTaskBubble = createAiBubble(msg.agent);

    // ★ 7단계: 태스크 스트리밍
    } else if (msg.type === 'task_chunk') {
      if (currentTaskBubble) {
        const textArea = currentTaskBubble.querySelector('.bubble-text');
        const cursor   = textArea?.querySelector('.cursor');
        if (cursor) cursor.insertAdjacentText('beforebegin', msg.text);
        else if (textArea) textArea.textContent += msg.text;
        scrollBottom();
      }

    // ★ 수정: 태스크 말풍선 XML 제거 (action_result 카드로 교체)
    } else if (msg.type === 'update_task_bubble') {
      if (currentTaskBubble) {
        const textArea = currentTaskBubble.querySelector('.bubble-text');
        const cursor   = textArea?.querySelector('.cursor');
        if (cursor) cursor.remove();
        if (textArea) textArea.textContent = msg.text;
      }

    // ★ 7단계: 태스크 완료
    } else if (msg.type === 'task_done') {
      if (currentTaskBubble) {
        const cursor = currentTaskBubble.querySelector('.cursor');
        if (cursor) cursor.remove();
        currentTaskBubble = null;
      }
      if (planCard) {
        const taskEl = planCard.querySelector('.plan-task[data-index="' + msg.index + '"]');
        if (taskEl) {
          taskEl.classList.remove('active');
          taskEl.classList.add('done');
          taskEl.querySelector('.task-status').textContent = '✅';
        }
      }

    // ★ 7단계: CEO 종합 시작
    } else if (msg.type === 'synthesis_start') {
      if (planCard) {
        const divider = document.createElement('hr');
        divider.className = 'plan-divider';
        planCard.appendChild(divider);
        const label = document.createElement('div');
        label.style.cssText = 'font-size:11px;color:#f0c040;margin-top:4px';
        label.textContent   = '🏢 CEO 종합 보고 작성 중...';
        planCard.appendChild(label);
      }
      currentAiBubble = createAiBubble(AGENT_MAP.get('ceo'));

    // ★ 7단계: CEO 종합 스트리밍
    } else if (msg.type === 'synthesis_chunk') {
      if (currentAiBubble) {
        const textArea = currentAiBubble.querySelector('.bubble-text');
        const cursor   = textArea?.querySelector('.cursor');
        if (cursor) cursor.insertAdjacentText('beforebegin', msg.text);
        else if (textArea) textArea.textContent += msg.text;
        scrollBottom();
      }

    // 단일 에이전트 스트리밍
    } else if (msg.type === 'chunk') {
      if (currentAiBubble) {
        const textArea = currentAiBubble.querySelector('.bubble-text');
        const cursor   = textArea?.querySelector('.cursor');
        if (cursor) cursor.insertAdjacentText('beforebegin', msg.text);
        else if (textArea) textArea.textContent += msg.text;
        scrollBottom();
      }

    } else if (msg.type === 'update_bubble') {
      if (currentAiBubble) {
        const textArea = currentAiBubble.querySelector('.bubble-text');
        const cursor   = textArea?.querySelector('.cursor');
        if (cursor) cursor.remove();
        if (textArea) textArea.textContent = msg.text;
      }

    } else if (msg.type === 'action_result') {
      log.appendChild(createActionCard(msg.result)); scrollBottom();

    } else if (msg.type === 'done') {
      [currentAiBubble, currentTaskBubble].forEach(b => {
        if (b) { const c = b.querySelector('.cursor'); if (c) c.remove(); }
      });
      currentAiBubble = currentTaskBubble = routingCard = planCard = null;
      streaming = false; sendBtn.disabled = false; box.focus();

    } else if (msg.type === 'error') {
      const target = currentAiBubble || currentTaskBubble;
      if (target) {
        const textArea = target.querySelector('.bubble-text');
        const cursor   = textArea?.querySelector('.cursor');
        if (cursor) cursor.remove();
        if (textArea) textArea.textContent = msg.text;
      }
      currentAiBubble = currentTaskBubble = routingCard = planCard = null;
      streaming = false; sendBtn.disabled = false;

    } else if (msg.type === 'memory_saved') {
      showMemToast();
    }
  });
</script>
</body>
</html>`;
  }
}

// ============================================================
//  buildSystemPrompt, extractAndSaveMemory, parseActionTags,
//  stripActionTags, executeAction, getWorkspaceRoot, safePath,
//  classifyAgent, streamLmStudio
// ============================================================

function buildSystemPrompt(agentSystemPrompt, agentId) {
  let prompt = agentSystemPrompt;
  const companyCtx  = brain.getCompanyContext();
  const agentMemory = brain.getAgentMemory(agentId);
  if (companyCtx)  prompt += '\n\n## 우리 회사 정보\n'              + companyCtx;
  if (agentMemory) prompt += '\n\n## 내가 기억하는 것 (과거 대화)\n' + agentMemory;
  // ★ 모든 에이전트 공통 — 환각 방지 가드레일
  prompt += '\n\n' + ANTI_HALLUCINATION_PROMPT;
  // CEO에게만 팀원 위임 태그 사용법을 추가
  if (agentId === 'ceo') prompt += '\n\n' + CEO_DELEGATE_PROMPT;
  prompt += '\n\n' + ACTION_TAGS_PROMPT;
  return prompt;
}

// ──────────────────────────────────────────────────────────────
//  parseDelegateTags: CEO 응답에서 <delegate> 태그를 순서대로 추출
// ──────────────────────────────────────────────────────────────
function parseDelegateTags(text) {
  const found = [];
  const regex = /<delegate\s+agent="([^"]+)"\s+task="([^"]+)"\s*\/>/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const agentId = m[1].trim();
    const task    = m[2].trim();
    if (AGENT_MAP.has(agentId) && agentId !== 'ceo' && task) {
      found.push({ agent: agentId, task });
    }
  }
  return found;
}

// ──────────────────────────────────────────────────────────────
//  extractDelegatesFromProse: 파트장이 <delegate> 태그 없이 산문으로만
//  지시했을 때, 그 계획을 LLM으로 한 번 더 호출해 위임 태그로 변환한다.
//  (로컬 LLM이 형식을 못 지켜 팀이 실행되지 않는 문제의 폴백)
// ──────────────────────────────────────────────────────────────
async function extractDelegatesFromProse(proseText) {
  if (!proseText || proseText.trim().length < 10) return [];
  const agentList = AGENTS.filter(a => a.id !== 'ceo')
    .map(a => `- ${a.id}: ${a.role}`).join('\n');
  try {
    const response = await fetch(LM_STUDIO_URL, {
      method : 'POST', headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        model: await ensureModel(),
        messages: [
          { role: 'system', content:
`당신은 파트장의 업무 지시를 시스템이 실행할 수 있는 '위임 태그'로 변환하는 변환기입니다.
아래 계획을 읽고, 각 담당자에게 줄 작업을 다음 형식의 태그로만 출력하세요.
인사말·설명·번호·코드블록 없이 태그만, 한 줄에 하나씩 출력합니다.

<delegate agent="에이전트ID" task="구체적이고 실행 가능한 작업 지시"/>

반드시 아래 에이전트ID 중에서만 사용하세요 (한국어 팀 이름 매핑 포함):
${agentList}
- "개발팀"→developer, "비즈니스팀"→business, "비서팀"→secretary

각 작업의 task에는 그 담당자가 바로 착수할 수 있도록 충분히 구체적인 지시를 적으세요.
실제로 위임할 작업이 전혀 없으면 아무것도 출력하지 마세요.` },
          { role: 'user', content: proseText.slice(0, 2000) }
        ],
        temperature: 0.1, max_tokens: 600, stream: false
      })
    });
    if (!response.ok) return [];
    const text = ((await response.json()).choices[0]?.message?.content ?? '');
    return parseDelegateTags(text);
  } catch { return []; }
}

// ──────────────────────────────────────────────────────────────
//  parseAskUserTags: CEO 응답에서 <ask_user> 태그를 추출
// ──────────────────────────────────────────────────────────────
function parseAskUserTags(text) {
  const found = [];
  const regex = /<ask_user\s+question="([^"]+)"\s+options="([^"]+)"(?:\s+priority="([^"]+)")?(?:\s+recommended="([^"]+)")?\s*\/>/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const question    = m[1].trim();
    const optionsStr  = m[2].trim();
    const priority    = m[3] ? m[3].trim() : 'medium';
    const recommended = m[4] ? m[4].trim() : null;
    const options     = optionsStr.split(',').map(o => o.trim()).filter(o => o);
    if (question && options.length >= 2) {
      found.push({ question, options, priority, recommended });
    }
  }
  return found;
}

// ──────────────────────────────────────────────────────────────
//  stripAskUserTags: CEO 말풍선 표시용 — ask_user 태그 제거
// ──────────────────────────────────────────────────────────────
function stripAskUserTags(text) {
  return text.replace(/<ask_user\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  parseNeedHuman: 에이전트가 "혼자 못 함, 사람이 필요" 표시 <need_human>
//  반환: [{ requestType, reason, request }]
// ──────────────────────────────────────────────────────────────
function parseNeedHuman(text) {
  const found = [];
  const r = /<need_human\s+[^>]*?\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const tag     = m[0];
    const request = _attr(tag, 'request');
    if (!request) continue;  // 부탁 내용 없으면 무시
    found.push({
      requestType: _attr(tag, 'type') || 'data',
      reason:      _attr(tag, 'reason') || '',
      request
    });
  }
  return found;
}
function stripNeedHuman(text) {
  return text.replace(/<need_human\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  parseSuggest: 파트장이 대표님께 올리는 제안 <suggest>
//  반환: [{ title, category, detail, impact }]
// ──────────────────────────────────────────────────────────────
function parseSuggest(text) {
  const found = [];
  const r = /<suggest\s+[^>]*?\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const tag    = m[0];
    const title  = _attr(tag, 'title');
    const detail = _attr(tag, 'detail');
    if (!title && !detail) continue;
    found.push({
      title:    title || '(제목 없음)',
      category: _attr(tag, 'category') || 'other',
      detail:   detail || '',
      impact:   _attr(tag, 'impact') || ''
    });
  }
  return found;
}
function stripSuggest(text) {
  return text.replace(/<suggest\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  파트장의 요청 검토 도구: triage 요청을 승격/폐기
//  <escalate_request id="reqID" priority="high|medium|low"/>
//  <drop_request id="reqID"/>
// ──────────────────────────────────────────────────────────────
function parseEscalateRequests(text) {
  const found = [];
  const r = /<escalate_request\s+[^>]*?\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const id = _attr(m[0], 'id');
    if (id) found.push({ id, priority: _attr(m[0], 'priority') || 'medium' });
  }
  return found;
}
function parseDropRequests(text) {
  const found = [];
  const r = /<drop_request\s+id="([^"]+)"\s*\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) { if (m[1].trim()) found.push(m[1].trim()); }
  return found;
}
function stripReviewTags(text) {
  return text.replace(/<escalate_request\s+[^>]*\/>/g, '').replace(/<drop_request\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  parseGoalStatus: 파트장 응답에서 <goal_status> 태그 추출
//  반환: { state: 'done'|'continue', reason: string } | null
// ──────────────────────────────────────────────────────────────
function parseGoalStatus(text) {
  const m = /<goal_status\s+state="([^"]+)"(?:\s+reason="([^"]*)")?\s*\/>/.exec(text);
  if (!m) return null;
  const state = m[1].trim().toLowerCase();
  return { state: state === 'done' ? 'done' : 'continue', reason: m[2] ? m[2].trim() : '' };
}

function stripGoalStatus(text) {
  return text.replace(/<goal_status\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  parseSetProgress: 파트장 응답에서 <set_progress> 태그 추출
//  반환: [{ id, progress, note }]
// ──────────────────────────────────────────────────────────────
function parseSetProgress(text) {
  const found = [];
  const r = /<set_progress\s+id="([^"]+)"\s+progress="([^"]+)"(?:\s+note="([^"]*)")?\s*\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const id = m[1].trim();
    const progress = parseInt(m[2], 10);
    if (id && !isNaN(progress)) found.push({ id, progress, note: m[3] ? m[3].trim() : undefined });
  }
  return found;
}

function stripSetProgress(text) {
  return text.replace(/<set_progress\s+[^>]*\/>/g, '');
}

// 태그 문자열에서 개별 속성 추출 (속성 순서 무관)
function _attr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1].trim() : undefined;
}

// ──────────────────────────────────────────────────────────────
//  parseAddGoal: 목표 수립 <add_goal level/period title parent weight type/>
//  반환: [{ level, title, parentId, weight, type }]
// ──────────────────────────────────────────────────────────────
const GOAL_PERIOD_SET = new Set(['annual', 'monthly', 'weekly', 'daily']);
function parseAddGoal(text) {
  const found = [];
  const r = /<add_goal\s+[^>]*?\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const tag    = m[0];
    const level  = _attr(tag, 'level') || _attr(tag, 'period');  // period: 구버전 호환
    const title  = _attr(tag, 'title');
    if (!GOAL_PERIOD_SET.has(level) || !title) continue;
    const parentId = _attr(tag, 'parent') || null;
    const wRaw     = _attr(tag, 'weight');
    const weight   = wRaw !== undefined ? parseFloat(wRaw) : undefined;
    const type     = _attr(tag, 'type');
    found.push({ level, title, parentId, weight, type });
  }
  return found;
}
function stripAddGoal(text) {
  return text.replace(/<add_goal\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  parseUpdateGoal: 목표 메타 수정 <update_goal id weight parent title type/>
//  반환: [{ id, fields }]
// ──────────────────────────────────────────────────────────────
function parseUpdateGoal(text) {
  const found = [];
  const r = /<update_goal\s+[^>]*?\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const tag = m[0];
    const id  = _attr(tag, 'id');
    if (!id) continue;
    const fields = {};
    const weight = _attr(tag, 'weight');   if (weight !== undefined) fields.weight = parseFloat(weight);
    const parent = _attr(tag, 'parent');   if (parent !== undefined) fields.parentId = parent || null;
    const title  = _attr(tag, 'title');    if (title  !== undefined) fields.title = title;
    const type   = _attr(tag, 'type');     if (type   !== undefined) fields.type = type;
    const note   = _attr(tag, 'note');     if (note   !== undefined) fields.note = note;
    if (Object.keys(fields).length) found.push({ id, fields });
  }
  return found;
}
function stripUpdateGoal(text) {
  return text.replace(/<update_goal\s+[^>]*\/>/g, '');
}

// parseDeleteGoal: 더 이상 유효하지 않은 목표 제거 <delete_goal>
function parseDeleteGoal(text) {
  const found = [];
  const r = /<delete_goal\s+id="([^"]+)"\s*\/>/g;
  let m;
  while ((m = r.exec(text)) !== null) {
    const id = m[1].trim();
    if (id) found.push(id);
  }
  return found;
}
function stripDeleteGoal(text) {
  return text.replace(/<delete_goal\s+[^>]*\/>/g, '');
}

// ──────────────────────────────────────────────────────────────
//  applyGoalTags: 한 응답 텍스트에서 목표 관리 태그를 모두 적용
//  (파트장·목표관리자 공용) → 적용된 변경 메시지 배열 반환
// ──────────────────────────────────────────────────────────────
function applyGoalTags(text) {
  const msgs = [];
  const levelLabel = { annual: '연간', monthly: '월간', weekly: '주간', daily: '일간' };

  for (const ag of parseAddGoal(text)) {
    const created = brain.addGoal(ag.level, ag.title, { parentId: ag.parentId, weight: ag.weight, type: ag.type });
    if (created) msgs.push(`🎯 목표 수립: [${levelLabel[ag.level]}] ${created.title}${ag.parentId ? ' (상위 연결)' : ''}`);
  }
  for (const ps of parseSetProgress(text)) {
    const updated = brain.updateGoalById(ps.id, { progress: ps.progress, note: ps.note });
    if (updated) msgs.push(`🎯 진행률: ${updated.title} → ${updated.progress}%`);
  }
  for (const ug of parseUpdateGoal(text)) {
    const updated = brain.updateGoalById(ug.id, ug.fields);
    if (updated) msgs.push(`🎯 목표 수정: ${updated.title}`);
  }
  for (const id of parseDeleteGoal(text)) {
    if (brain.deleteGoal(id)) msgs.push(`🎯 목표 제거: ${id}`);
  }
  return msgs;
}

// 응답 텍스트에서 모든 목표 관리 태그 제거 (말풍선 표시용)
function stripGoalTags(text) {
  return stripDeleteGoal(stripUpdateGoal(stripAddGoal(stripSetProgress(text))));
}

// ──────────────────────────────────────────────────────────────
//  stripDelegateTags: CEO 말풍선 표시용 — delegate 태그 제거
// ──────────────────────────────────────────────────────────────
function stripDelegateTags(text) {
  return text
    .replace(/<delegate\s+[^>]*\/>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractAndSaveMemory(agentId, userText, aiText, onSaved) {
  try {
    const response = await fetch(LM_STUDIO_URL, {
      method : 'POST', headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        model: await ensureModel(),
        messages: [
          { role: 'system', content: '다음 대화에서 기억할 중요한 사실·결정·선호도를 1~3줄로 요약하세요. 없으면 "없음"만 반환하세요.' },
          { role: 'user',   content: `사용자: ${userText.slice(0,300)}\n에이전트: ${aiText.slice(0,500)}` }
        ],
        temperature: 0.1, max_tokens: 150, stream: false
      })
    });
    const memory = ((await response.json()).choices[0]?.message?.content ?? '').trim();
    if (memory && memory !== '없음' && memory.length > 5) {
      const ts = new Date().toISOString().slice(0,16).replace('T',' ');
      brain.appendAgentMemory(agentId, `[${ts}] ${memory}`);
      if (typeof onSaved === 'function') onSaved();
    }
  } catch { /* 무시 */ }
}

function parseActionTags(text) {
  const found = [];
  function scan(regex, transform) {
    const r = new RegExp(regex.source, regex.flags); let m;
    while ((m = r.exec(text)) !== null) found.push({ index: m.index, action: transform(m) });
  }
  scan(/<create_file\s+path="([^"]+)">([\s\S]*?)<\/create_file>/g, m => ({ type:'create_file', path:m[1], content:m[2] }));
  scan(/<read_file\s+path="([^"]+)"\s*\/?>/g,  m => ({ type:'read_file',  path:m[1] }));
  scan(/<list_files\s+path="([^"]+)"\s*\/?>/g, m => ({ type:'list_files', path:m[1] }));
  scan(/<run_command>([\s\S]*?)<\/run_command>/g, m => ({ type:'run_command', command:m[1].trim() }));
  scan(/<edit_file\s+path="([^"]+)">([\s\S]*?)<\/edit_file>/g, m => {
    const s = /<search>([\s\S]*?)<\/search>/.exec(m[2]);
    const r = /<replace>([\s\S]*?)<\/replace>/.exec(m[2]);
    return { type:'edit_file', path:m[1], search:s?.[1]??'', replace:r?.[1]??'' };
  });
  found.sort((a,b) => a.index - b.index);
  return found.map(f => f.action);
}

function stripActionTags(text) {
  return text
    .replace(/<create_file[^>]*>[\s\S]*?<\/create_file>/g,'')
    .replace(/<edit_file[^>]*>[\s\S]*?<\/edit_file>/g,'')
    .replace(/<read_file[^>]*\/?>/g,'')
    .replace(/<list_files[^>]*\/?>/g,'')
    .replace(/<run_command>[\s\S]*?<\/run_command>/g,'')
    .replace(/\n{3,}/g,'\n\n').trim();
}

// ★ 깨진 바이너리 파일 방지: 텍스트 모델은 .xlsx/.pdf/.docx를 못 만든다.
//   이런 확장자로 저장하려 하면 안전하게 텍스트 형식으로 바꿔준다.
function safeFileExtension(relPath) {
  const m = relPath.match(/\.([a-zA-Z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : '';
  // 표 형식 바이너리 → .csv, 문서 바이너리 → .md
  if (ext === 'xlsx' || ext === 'xls') return relPath.replace(/\.[a-zA-Z0-9]+$/, '.csv');
  if (ext === 'docx' || ext === 'doc' || ext === 'pdf' || ext === 'pptx' || ext === 'ppt')
    return relPath.replace(/\.[a-zA-Z0-9]+$/, '.md');
  // 확장자 없는 문서성 파일은 .md로
  if (ext === '') return relPath + '.md';
  return relPath;
}

async function executeAction(action, workspaceRoot) {
  switch (action.type) {
    case 'create_file': { const safePathRel=safeFileExtension(action.path); const f=safePath(safePathRel,workspaceRoot); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,action.content,'utf8'); return {type:'create_file',path:safePathRel}; }
    case 'edit_file':   { const f=safePath(action.path,workspaceRoot); let c=fs.readFileSync(f,'utf8'); if(!c.includes(action.search)) throw new Error('찾을 텍스트 없음: '+action.search.slice(0,80)); fs.writeFileSync(f,c.replace(action.search,action.replace),'utf8'); return {type:'edit_file',path:action.path}; }
    case 'read_file':   { const f=safePath(action.path,workspaceRoot); return {type:'read_file',path:action.path,content:fs.readFileSync(f,'utf8').slice(0,8000)}; }
    case 'list_files':  { const f=safePath(action.path,workspaceRoot); return {type:'list_files',path:action.path,entries:fs.readdirSync(f,{withFileTypes:true}).map(e=>(e.isDirectory()?'📁 ':'📄 ')+e.name)}; }
    case 'run_command': return await new Promise(resolve => exec(action.command,{cwd:workspaceRoot,encoding:'utf8',timeout:30_000},(e,o,r)=>resolve({type:'run_command',command:action.command,output:(o+r).slice(0,5000)||'(출력 없음)',isError:!!e})));
    default: throw new Error('알 수 없는 액션: ' + action.type);
  }
}

// ──────────────────────────────────────────────────────────────
//  결과물 검증: 생성된 파일을 실제로 실행해 본다
// ──────────────────────────────────────────────────────────────

// 파일 확장자로 실행기 결정 (.py/.js만 검증 대상)
function getRunner(relPath) {
  const ext = path.extname(relPath || '').toLowerCase();
  return FILE_RUNNERS[ext] || null;
}

// 파일 1회 실행 → { ok, timedOut, output }
function runFileOnce(relPath, workspaceRoot) {
  const runner = getRunner(relPath);
  if (!runner) return Promise.resolve({ ok: true, timedOut: false, output: '(실행 대상 아님)' });

  return new Promise(resolve => {
    exec(
      `${runner.cmd} "${relPath}"`,
      { cwd: workspaceRoot, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const output = ((stdout || '') + (stderr || '')).slice(0, 3000);
        if (err && err.killed) {
          // 제한 시간 초과 = 크래시 없이 계속 실행 중 (서버 등) → 통과로 간주
          resolve({ ok: true, timedOut: true, output });
        } else if (err) {
          resolve({ ok: false, timedOut: false, output: output || String(err) });
        } else {
          resolve({ ok: true, timedOut: false, output: output || '(출력 없음)' });
        }
      }
    );
  });
}

function getWorkspaceRoot() {
  // __dirname = extension.js 가 위치한 폴더 = My_AI_Company
  // 항상 My_AI_Company/workspace/ 를 반환 (워크스페이스 열림 여부 무관)
  const wsRoot = path.join(__dirname, 'workspace');
  if (!fs.existsSync(wsRoot)) fs.mkdirSync(wsRoot, { recursive: true });
  return wsRoot;
}

function safePath(relPath, workspaceRoot) {
  const full = path.resolve(workspaceRoot, relPath);
  if (!full.startsWith(workspaceRoot)) throw new Error('보안: 워크스페이스 외부 차단 → ' + relPath);
  const blocked = ['/etc','/System','/usr/bin','/bin','/sbin','/dev','C:\\Windows','C:\\Program Files'];
  if (blocked.some(b => full.startsWith(b))) throw new Error('보안: 시스템 경로 차단 → ' + relPath);
  return full;
}

async function classifyAgent(userText) {
  const model = await ensureModel();
  const agentList = AGENTS.filter(a=>a.id!=='ceo').map(a=>`${a.id}: ${a.role}`).join('\n');
  const response = await fetch(LM_STUDIO_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ model, messages:[{role:'system',content:`아래 목록 중 가장 적합한 ID 하나만 반환하세요. ID만.\n\n${agentList}`},{role:'user',content:userText}], temperature:0.1, max_tokens:20, stream:false })
  });
  if (!response.ok) throw new Error('분류기 실패: ' + response.status);
  const raw = ((await response.json()).choices[0]?.message?.content??'').trim().toLowerCase();
  const validIds = AGENTS.filter(a=>a.id!=='ceo').map(a=>a.id);
  return validIds.find(id=>raw.includes(id)) ?? 'ceo';
}

async function streamLmStudio(systemPrompt, history, onChunk, onDone) {
  const model = await ensureModel();
  const response = await fetch(LM_STUDIO_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ model, messages:[{role:'system',content:systemPrompt},...history], temperature:0.7, stream:true })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('서버 응답 오류: ' + response.status + (detail ? ' — ' + detail.slice(0, 300) : ''));
  }
  const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='';
  while (true) {
    const {done,value}=await reader.read(); if(done)break;
    buffer+=decoder.decode(value,{stream:true});
    const lines=buffer.split('\n'); buffer=lines.pop();
    for(const line of lines){
      if(!line.startsWith('data: '))continue;
      const data=line.slice(6).trim();
      if(data==='[DONE]'){await onDone();return;}
      try{const c=JSON.parse(data).choices?.[0]?.delta?.content; if(c)onChunk(c);}catch{}
    }
  }
  await onDone();
}

function _errMsg(err) {
  return '⚠️ LM Studio에 연결하지 못했어요.\n\n1) LM Studio가 켜져 있나요?\n2) 모델을 로드했나요?\n3) Start Server를 눌렀나요?\n\n오류: ' + String(err);
}

// ============================================================
//  getDashboardData: Brain 폴더·workspace 에서 현황 데이터 수집
// ============================================================
function getDashboardData() {
  const brainDir     = brain.BRAIN_DIR;
  const workspaceDir = getWorkspaceRoot();
  const now          = new Date();
  // 오늘 날짜 문자열 (파일명 비교용)
  const todayStr     = now.toISOString().slice(0, 10); // 예: 2026-06-03

  // ── 오늘 대화 로그 파싱 (에이전트 활동 시간 추적) ─────────────
  const convDir   = path.join(brainDir, 'conversations');
  const convFiles = fs.existsSync(convDir)
    ? fs.readdirSync(convDir).filter(f => f.endsWith('.md')).sort().reverse()
    : [];

  // agentLastActivity: { agentId: Date } — 오늘 로그에서 추출
  const agentLastActivity = {};
  // recentActivities: 오늘 활동 목록 (오늘 파일이 없으면 빈 배열)
  const recentActivities  = [];
  const todayFile         = `${todayStr}.md`;
  const hasTodayLog       = convFiles.includes(todayFile);

  if (hasTodayLog) {
    const logContent = fs.readFileSync(path.join(convDir, todayFile), 'utf8');
    // 블록 단위 파싱: 시간, 라벨, 본문(다음 heading 전까지)
    const blockRe = /## \[(\d{2}:\d{2})\] ([^\n]+)\n([\s\S]*?)(?=\n## \[|$)/g;
    let m;
    while ((m = blockRe.exec(logContent)) !== null) {
      const timeStr  = m[1]; // "14:30"
      const label    = m[2].trim(); // "CEO", "개발자(토론)" 등
      const body     = m[3] || '';
      const baseName = label.replace(/\s*[\(\（].*[\)\）]/g, '').trim(); // 괄호 제거

      // 에이전트 이름으로 ID 매핑
      const matched = AGENTS.find(a => baseName === a.name || baseName.startsWith(a.name));
      if (matched) {
        const [hh, mm]  = timeStr.split(':').map(Number);
        const actDate   = new Date(now);
        actDate.setHours(hh, mm, 0, 0);
        if (!agentLastActivity[matched.id] || actDate > agentLastActivity[matched.id]) {
          agentLastActivity[matched.id] = actDate;
        }
      }

      // ★ 작업 요약 추출: **요약:** 라인이 있으면 그것을 사용 (없으면 본문 발췌)
      let work = '';
      const summaryMatch = body.match(/^\s*\*\*요약:\*\*\s*(.+?)(?=\n|$)/m);
      if (summaryMatch && summaryMatch[1]) {
        // **요약:** 라인이 있으면 그 내용 (완전한 한 문장 요약)
        work = summaryMatch[1].trim();
      } else {
        // 없으면 기존 방식: 마지막 "**이름:**" 뒤 텍스트 발췌 (폴백)
        const idx = body.lastIndexOf(':**');
        work = idx >= 0 ? body.slice(idx + 3) : body;
        work = work.replace(/-{3,}/g, '').replace(/\s+/g, ' ').trim();
      }

      // ★ 요약 정리: 영문 괄호 제거 + 70자 제한 + 자연스러운 끝맺음
      work = work
        .replace(/\([^)]*?\)/g, '')  // (영문 설명) 제거
        .replace(/\s+/g, ' ')         // 공백 정규화
        .trim();
      // 70자 제한 + 마침표로 명확하게 마무리
      if (work.length > 70) {
        work = work.slice(0, 68).trim();
      }
      // "완료"로 이미 끝나면 그대로, 아니면 마침표 추가
      if (!work.endsWith('완료') && !work.endsWith('.')) {
        work += '.';
      }

      // 에이전트 이모지
      const emoji = matched ? matched.emoji : '•';

      recentActivities.push({ time: timeStr, label: label.slice(0, 40), emoji, work });
    }

    // 최신순 (가장 최근이 위로) — 전체 보관 (최대 50개)
    recentActivities.reverse();
    if (recentActivities.length > 50) recentActivities.length = 50;
  }

  // ── 에이전트 현황 ─────────────────────────────────────────────
  // ★ 수정: memory.md 수정 시간 대신 오늘 대화 로그의 활동 시간을 우선 사용
  const agentStats = AGENTS.map(agent => {
    const memPath   = path.join(brainDir, 'agents', agent.id, 'memory.md');
    let   memLines  = 0;

    if (fs.existsSync(memPath)) {
      const content = fs.readFileSync(memPath, 'utf8');
      memLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>')).length;
    }

    // 오늘 대화 로그에서 마지막 활동 시간 가져오기 (없으면 null)
    const lastActive = agentLastActivity[agent.id] ?? null;

    // 상태 판정: 30분 이내 = 활성, 3시간 이내 = 최근, 그 외 = 대기
    let status = 'idle';
    if (lastActive) {
      const diffMin = (now - lastActive) / 60000;
      if (diffMin < 30)  status = 'active';
      else if (diffMin < 180) status = 'recent';
    }

    return { id: agent.id, name: agent.name, emoji: agent.emoji, color: agent.color, status, lastActive, memLines };
  });

  // ── workspace 최근 파일 ─────────────────────────────────────
  const recentFiles = [];
  function walkDir(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'reports') walkDir(full);
      else if (entry.isFile()) recentFiles.push({ name: entry.name, rel: path.relative(workspaceDir, full), abs: full, mtime: fs.statSync(full).mtime });
    });
  }
  walkDir(workspaceDir);
  recentFiles.sort((a, b) => b.mtime - a.mtime);

  const identityPath = path.join(brainDir, 'company', 'identity.md');
  const goalsPath    = path.join(brainDir, 'company', 'goals.md');
  const companyName  = fs.existsSync(identityPath)
    ? (fs.readFileSync(identityPath, 'utf8').match(/\*\*회사 이름\*\*:?\s*(.+)/)?.[1]?.trim() ?? 'AI 회사')
    : 'AI 회사';

  // ★ 결정 대기 항목
  const pendingDecisions  = brain.getPendingDecisions();
  const pendingRequests   = brain.getPendingRequests();
  const pendingSuggestions = brain.getPendingSuggestions();
  const triageCount        = brain.getTriageRequests().length;
  const geminiKey          = brain.getGeminiKey();
  const geminiKeySet       = geminiKey.length > 0;
  const geminiKeyMasked    = geminiKeySet ? ('●●●●' + geminiKey.slice(-4)) : '';

  return { agentStats, convCount: convFiles.length, recentActivities, recentFiles: recentFiles.slice(0, 8), companyName, brainDir, workspaceDir, pendingDecisions, pendingRequests, pendingSuggestions, triageCount, geminiKeySet, geminiKeyMasked };
}

// ============================================================
//  DashboardPanel: 회사 현황 대시보드 webview 패널
// ============================================================
class DashboardPanel {
  static currentPanel = null;

  static createOrShow(context) {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      DashboardPanel.currentPanel._update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiCompanyDashboard', '🏢 AI 회사 대시보드',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, context);
  }

  constructor(panel, context) {
    this._panel   = panel;
    this._context = context;
    this._update();

    // 30초마다 자동 새로고침
    // ★ 처리함에 처리할 항목이 있을 땐 자동 새로고침을 멈춤
    //   (입력 중인 내용이 30초마다 지워지는 문제 방지)
    this._timer = setInterval(() => {
      const data = getDashboardData();
      const hasInbox = data.pendingDecisions.length + data.pendingRequests.length + data.pendingSuggestions.length > 0;
      if (!hasInbox) this._update();
    }, 30_000);

    this._panel.onDidDispose(() => {
      clearInterval(this._timer);
      DashboardPanel.currentPanel = null;
    });
    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'refresh')            this._update();
      if (msg.type === 'open_brain')         vscode.window.showTextDocument(vscode.Uri.file(path.join(brain.BRAIN_DIR, 'company', 'identity.md')));
      if (msg.type === 'open_folder')        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
      if (msg.type === 'open_file')          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path), vscode.ViewColumn.Beside);
      if (msg.type === 'approve_decision')   brain.approveDecision(msg.decisionId, msg.chosenValue);
      if (msg.type === 'reject_decision')    brain.rejectDecision(msg.decisionId, msg.reason);
      if (msg.type === 'fulfill_request')    brain.fulfillRequest(msg.requestId, msg.response);
      if (msg.type === 'open_file_picker') {
        // VS Code 네이티브 파일 선택창 → 텍스트 읽어 webview로 전달
        vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { '텍스트·문서': ['txt', 'md', 'csv', 'json', 'pdf'] },
          title: '자료 파일 선택 (텍스트·마크다운·CSV 권장)'
        }).then(uris => {
          if (!uris || !uris[0]) return;
          try {
            const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
            const content = raw.slice(0, 8000); // 너무 긴 파일은 앞부분만
            this._panel.webview.postMessage({
              type: 'file_loaded',
              requestId: msg.requestId,
              fileName: path.basename(uris[0].fsPath),
              content
            });
          } catch {
            vscode.window.showWarningMessage('파일을 읽지 못했습니다. 텍스트 파일(.txt .md .csv)을 선택해 주세요.');
          }
        });
      }
      if (msg.type === 'dismiss_request')    brain.dismissRequest(msg.requestId);
      if (msg.type === 'accept_suggestion')  brain.acceptSuggestion(msg.suggestionId, msg.note);
      if (msg.type === 'dismiss_suggestion') brain.dismissSuggestion(msg.suggestionId, msg.note);

      // ★ Gemini API 키 저장
      if (msg.type === 'set_gemini_key') {
        brain.setGeminiKey(msg.key);
        this._panel.webview.postMessage({ type: 'gemini_key_saved', masked: '****' + msg.key.slice(-4) });
      }

      // ★ Gemini로 요청 자동 해결 (버튼 클릭 시 수동 트리거)
      if (msg.type === 'gemini_resolve') {
        const apiKey = brain.getGeminiKey();
        this._panel.webview.postMessage({ type: 'gemini_loading', requestId: msg.requestId });
        callGemini(msg.question, apiKey)
          .then(answer => {
            this._panel.webview.postMessage({ type: 'gemini_done', requestId: msg.requestId, answer });
          })
          .catch(err => {
            this._panel.webview.postMessage({ type: 'gemini_error', requestId: msg.requestId, error: err.message });
          });
      }
    });
  }

  _update() {
    try {
      const data = getDashboardData();
      this._panel.webview.html = this._getHtml(data);
    } catch (err) {
      this._panel.webview.html = `<body style="color:white;padding:20px">❌ 오류: ${err.message}</body>`;
    }
  }

  _getHtml(data) {
    const nonce = require('crypto').randomBytes(16).toString('hex');
    const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    const statusLabel  = { active: '🟢 활성', recent: '🟡 최근', idle: '⚫ 대기' };
    const statusColor  = { active: '#3fb950', recent: '#e3b341', idle: '#6e7681' };

    const agentCards = data.agentStats.map(a => `
      <div class="agent-card">
        <div class="agent-emoji">${a.emoji}</div>
        <div class="agent-name">${a.name}</div>
        <div class="agent-status" style="color:${statusColor[a.status]}">${statusLabel[a.status]}</div>
        <div class="agent-meta">${a.memLines > 0 ? `🧠 ${a.memLines}개 기억` : '기억 없음'}</div>
        ${a.lastActive ? `<div class="agent-meta">${_timeAgo(a.lastActive)}</div>` : ''}
      </div>`).join('');

    // 오늘 날짜 표시 (오늘 로그가 없으면 안내 메시지)
    const todayLabel    = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    const ACT_VISIBLE   = 8;  // 기본 노출 개수
    const activityRows = data.recentActivities.length > 0
      ? data.recentActivities.map((a, i) =>
          `<div class="activity-row ${i >= ACT_VISIBLE ? 'act-hidden' : ''}">
             <div class="act-head">
               <span class="act-time">${a.time}</span>
               <span class="act-label">${a.emoji ? a.emoji + ' ' : ''}${_esc(a.label)}</span>
             </div>
             ${a.work ? `<div class="act-work">${_esc(a.work)}</div>` : ''}
           </div>`
        ).join('')
      : `<div class="activity-row muted">오늘(${todayLabel}) 아직 활동 없음<br><small>VS Code 채팅 또는 cycle.js 실행 후 갱신됩니다</small></div>`;

    // 8개 초과 시 "더 보기" 토글 버튼 (data 속성으로 숨김 개수 전달)
    const activityHidden = data.recentActivities.length - ACT_VISIBLE;
    const activityToggle = activityHidden > 0
      ? `<button class="more-btn" id="actMoreBtn" data-action="toggle-activities" data-hidden="${activityHidden}">▼ 더 보기 (${activityHidden}개 더)</button>`
      : '';

    const fileRows = data.recentFiles.length > 0
      ? data.recentFiles.map(f => `<div class="file-row clickable" title="클릭하여 열기: ${_esc(f.rel)}" data-path="${_esc(f.abs)}"><span class="file-icon">📄</span><span class="file-name">${_esc(f.name)}</span><span class="file-time">${_timeAgo(f.mtime)}</span></div>`).join('')
      : '<div class="file-row muted">생성된 파일 없음</div>';

    // ★ 결재함 카드 (우선순위 + 팀 투표 막대 + 의견 + 승인/보류)
    const priorityColor = { high: '#f85149', medium: '#d29922', low: '#3fb950' };
    const priorityIcon  = { high: '🔴 긴급', medium: '🟡 보통', low: '🟢 낮음' };

    const decisionCards = data.pendingDecisions.length > 0
      ? data.pendingDecisions.map(d => {
          // 옵션별 득표 맵 + 최다 득표 계산
          const voteMap = {};
          let maxVote = 0, totalVotes = 0;
          if (d.voteResults && Array.isArray(d.voteResults.votes)) {
            d.voteResults.votes.forEach(v => { voteMap[v.option] = v.count; totalVotes += v.count; if (v.count > maxVote) maxVote = v.count; });
          }
          const topOption = d.voteResults && d.voteResults.recommendation;

          // 투표 막대 (옵션별)
          const voteBars = d.voteResults ? d.options.map(opt => {
            const c = voteMap[opt] || 0;
            const pct = maxVote > 0 ? Math.round(c / maxVote * 100) : 0;
            const isTop = opt === topOption && c > 0;
            return `
              <div class="vote-row">
                <span class="vote-opt ${isTop ? 'top' : ''}">${isTop ? '👑 ' : ''}${_esc(opt)}</span>
                <span class="vote-bar-track"><span class="vote-bar-fill ${isTop ? 'top' : ''}" style="width:${pct}%"></span></span>
                <span class="vote-count">${c}표</span>
              </div>`;
          }).join('') : '';

          // 에이전트 의견 (참고용)
          const opinions = (d.voteResults && d.voteResults.opinions && d.voteResults.opinions.length > 0)
            ? `<details class="vote-opinions"><summary>🗣️ 팀원 의견 ${d.voteResults.opinions.length}건 보기</summary>
                ${d.voteResults.opinions.map(o => `<div class="op-line"><b>${_esc(o.agentName)}</b>: ${_esc(o.opinion.slice(0, 160))}</div>`).join('')}
               </details>`
            : '';

          // 승인 버튼 (옵션별, 득표 표시) — 최다 득표는 강조
          const approveBtns = d.options.map(opt => {
            const c = voteMap[opt] || 0;
            const isTop = opt === topOption && c > 0;
            return `<button class="appr-btn ${isTop ? 'top' : ''}" data-action="approve" data-decision-id="${_esc(d.id)}" data-option="${_esc(opt)}">✓ ${_esc(opt)}${d.voteResults ? ` (${c})` : ''}</button>`;
          }).join('');

          return `
        <div class="decision-card" style="border-left: 4px solid ${priorityColor[d.priority] || '#6e7681'}">
          <div class="decision-header">
            <span class="dh-priority" style="color:${priorityColor[d.priority]}">${priorityIcon[d.priority] || '⚪'}</span>
            <span class="dh-by">📨 ${_esc(d.requestedBy)} 요청</span>
            <span class="dh-time">${d.timestamp ? _timeAgo(d.timestamp) : ''}</span>
          </div>
          <div class="decision-question">${_esc(d.question)}</div>
          ${d.recommended ? `<div class="decision-recommend">💡 팀 추천: <strong>${_esc(d.recommended)}</strong></div>` : ''}
          ${d.voteResults ? `<div class="vote-box">
            <div class="vote-title">📊 팀 투표 결과 (총 ${totalVotes}표)</div>
            ${voteBars}
            ${opinions}
          </div>` : '<div class="no-vote">투표 없이 요청된 결재 항목</div>'}
          <div class="appr-row">
            <span class="appr-label">승인할 안 선택 →</span>
            ${approveBtns}
            <button class="reject-btn" data-action="reject" data-decision-id="${_esc(d.id)}">✕ 보류</button>
          </div>
        </div>`;
        }).join('')
      : '<div class="decision-empty">결재할 항목이 없습니다.</div>';

    // ★ 사람 도움 요청 카드 (need_human) — 입력창으로 자료/결과 제공
    const reqTypeLabel = { data: '📊 자료', action: '⚡ 실행', file: '📎 파일', verify: '🔍 검증' };
    const requestCards = (data.pendingRequests || []).length > 0
      ? data.pendingRequests.map(r => `
        <div class="request-card" style="border-left: 4px solid ${priorityColor[r.priority] || '#a371f7'}">
          <div class="req-header">
            <span class="req-type">${reqTypeLabel[r.requestType] || '📊 자료'}</span>
            <span class="req-by">🙋 ${_esc(r.requestedBy)} 요청</span>
            <span class="req-time">${r.timestamp ? _timeAgo(r.timestamp) : ''}</span>
          </div>
          <div class="req-ask">${_esc(r.request)}</div>
          ${r.reason ? `<div class="req-reason">왜: ${_esc(r.reason)}</div>` : ''}
          <div class="gemini-status" id="gstatus-${_esc(r.id)}"></div>
          <textarea class="req-input" id="req-${_esc(r.id)}" placeholder="여기에 직접 입력하거나, 📎 파일 첨부 또는 🤖 Gemini로 자동 조사..."></textarea>
          <div class="req-file-hint" id="hint-${_esc(r.id)}"></div>
          <div class="req-actions">
            <button class="req-gemini" id="gbtn-${_esc(r.id)}"
              data-action="gemini" data-id="${_esc(r.id)}" data-question="${_esc(r.request)}">🤖 Gemini 조사</button>
            <button class="req-attach"
              data-action="attach" data-id="${_esc(r.id)}">📎 파일 첨부</button>
            <button class="req-submit"
              data-action="fulfill" data-id="${_esc(r.id)}">✓ 제공하기</button>
            <button class="req-dismiss"
              data-action="dismiss-req" data-id="${_esc(r.id)}">✕ 무시</button>
          </div>
        </div>`).join('')
      : '<div class="decision-empty">AI가 도움을 요청하면 여기에 표시됩니다.</div>';

    // ★ 제안 카드 (suggestion) — 파트장이 올린 중요 제안, 채택/반려
    const catLabel = { budget: '💰 예산', strategy: '🧭 전략', approval: '✅ 승인필요', other: '💡 기타' };
    const suggestionCards = (data.pendingSuggestions || []).length > 0
      ? data.pendingSuggestions.map(s => `
        <div class="suggest-card" style="border-left: 4px solid ${priorityColor[s.priority] || '#3fb950'}">
          <div class="sug-header">
            <span class="sug-cat">${catLabel[s.category] || '💡 기타'}</span>
            <span class="sug-by">💡 ${_esc(s.requestedBy)} 제안</span>
            <span class="sug-time">${s.timestamp ? _timeAgo(s.timestamp) : ''}</span>
          </div>
          <div class="sug-title">${_esc(s.title)}</div>
          ${s.detail ? `<div class="sug-detail">${_esc(s.detail)}</div>` : ''}
          ${s.impact ? `<div class="sug-impact">📈 기대효과/리스크: ${_esc(s.impact)}</div>` : ''}
          <div class="sug-actions">
            <button class="sug-accept" data-action="accept-suggestion" data-suggestion-id="${_esc(s.id)}">✓ 채택</button>
            <button class="sug-dismiss" data-action="dismiss-suggestion" data-suggestion-id="${_esc(s.id)}">✕ 반려</button>
          </div>
        </div>`).join('')
      : '<div class="decision-empty">파트장이 중요한 제안을 올리면 여기에 표시됩니다.</div>';

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0d1117; color: #e6edf3; }

  /* ── 헤더 ── */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #21262d; }
  .header-title { font-size: 20px; font-weight: 700; }
  .header-sub { font-size: 13px; color: #8b949e; margin-top: 2px; }
  .header-right { display: flex; gap: 8px; align-items: center; }
  .refresh-time { font-size: 11px; color: #8b949e; }
  .btn { padding: 6px 14px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9;
         border-radius: 6px; cursor: pointer; font-size: 12px; }
  .btn:hover { background: #30363d; }
  .btn-primary { background: #238636; border-color: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }

  /* ── 섹션 ── */
  .section { margin-bottom: 24px; }
  .section-title { font-size: 14px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }

  /* ── 에이전트 카드 ── */
  .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
  .agent-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 12px; text-align: center; transition: border-color 0.2s; }
  .agent-card:hover { border-color: #58a6ff; }
  .agent-emoji { font-size: 28px; margin-bottom: 6px; }
  .agent-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
  .agent-status { font-size: 12px; margin-bottom: 6px; }
  .agent-meta { font-size: 11px; color: #8b949e; line-height: 1.6; }

  /* ── 2컬럼 레이아웃 ── */
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 600px) { .two-col { grid-template-columns: 1fr; } }

  /* ── 패널 ── */
  .panel { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px; }
  .panel-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }

  /* ── Brain 통계 ── */
  .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-val { font-weight: 600; color: #58a6ff; }

  /* ── 활동 피드 ── */
  .activity-row { padding: 7px 0; font-size: 12px; border-bottom: 1px solid #21262d; }
  .activity-row:last-child { border-bottom: none; }
  .act-head { display: flex; gap: 10px; align-items: baseline; }
  .act-time { color: #8b949e; white-space: nowrap; min-width: 40px; }
  .act-label { color: #c9d1d9; font-weight: 600; }
  .act-work { color: #8b949e; font-size: 11px; margin: 3px 0 0 50px; line-height: 1.5;
              display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .act-hidden { display: none; }
  .more-btn { width: 100%; margin-top: 8px; padding: 6px; background: #21262d; color: #58a6ff;
              border: 1px solid #30363d; border-radius: 5px; cursor: pointer; font-size: 11px; }
  .more-btn:hover { background: #30363d; }

  /* ── 파일 목록 ── */
  .file-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12px; border-bottom: 1px solid #21262d; }
  .file-row:last-child { border-bottom: none; }
  .file-icon { flex-shrink: 0; }
  .file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #58a6ff; }
  .file-time { color: #8b949e; white-space: nowrap; font-size: 11px; }
  .file-row.clickable { cursor: pointer; border-radius: 4px; padding-left: 4px; padding-right: 4px; }
  .file-row.clickable:hover { background: #1f2937; }
  .file-row.clickable:hover .file-name { text-decoration: underline; }
  .muted { color: #8b949e; }

  /* ── 결재함 ── */
  .decision-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
  .decision-header { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
  .dh-priority { font-size: 12px; font-weight: 700; }
  .dh-by { font-size: 11px; color: #8b949e; }
  .dh-time { font-size: 11px; color: #6e7681; margin-left: auto; }
  .decision-question { font-weight: 600; font-size: 14px; margin-bottom: 6px; color: #e6edf3; }
  .decision-recommend { font-size: 12px; color: #3fb950; margin-bottom: 10px; }

  /* 투표 결과 */
  .vote-box { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 10px; margin-bottom: 10px; }
  .vote-title { font-size: 11px; color: #8b949e; margin-bottom: 8px; font-weight: 600; }
  .vote-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .vote-opt { font-size: 12px; color: #c9d1d9; min-width: 90px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vote-opt.top { color: #f0c040; font-weight: 700; }
  .vote-bar-track { flex: 1; height: 10px; background: #21262d; border-radius: 5px; overflow: hidden; }
  .vote-bar-fill { display: block; height: 100%; background: #30538a; border-radius: 5px; transition: width .3s; }
  .vote-bar-fill.top { background: #f0c040; }
  .vote-count { font-size: 11px; color: #8b949e; min-width: 28px; text-align: right; }
  .vote-opinions { margin-top: 8px; }
  .vote-opinions summary { font-size: 11px; color: #58a6ff; cursor: pointer; }
  .op-line { font-size: 11px; color: #8b949e; padding: 3px 0 3px 8px; }
  .no-vote { font-size: 11px; color: #6e7681; margin-bottom: 10px; font-style: italic; }

  /* 승인/보류 */
  .appr-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding-top: 8px; border-top: 1px dashed #21262d; }
  .appr-label { font-size: 11px; color: #8b949e; margin-right: 2px; }
  .appr-btn { padding: 6px 12px; background: #238636; color: #fff; border: 1px solid #2ea043; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .appr-btn:hover { background: #2ea043; }
  .appr-btn.top { background: #1a7f37; border-color: #f0c040; box-shadow: 0 0 0 1px #f0c040; }
  .reject-btn { padding: 6px 12px; background: transparent; color: #f85149; border: 1px solid #6e2a2a; border-radius: 5px; cursor: pointer; font-size: 12px; margin-left: auto; }
  .reject-btn:hover { background: #5a1f1f; }
  .decision-empty { color: #8b949e; font-size: 12px; padding: 12px; text-align: center; }

  /* ── 처리함 소제목 + 요청(need_human) 카드 ── */
  .inbox-sub { font-size: 12px; font-weight: 600; color: #c9d1d9; margin: 4px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #21262d; }
  .request-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .req-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .req-type { font-size: 11px; font-weight: 700; color: #a371f7; }
  .req-by { font-size: 11px; color: #8b949e; }
  .req-time { font-size: 11px; color: #6e7681; margin-left: auto; }
  .req-ask { font-size: 13px; font-weight: 600; color: #e6edf3; margin-bottom: 4px; }
  .req-reason { font-size: 11px; color: #8b949e; margin-bottom: 8px; }
  .req-input { width: 100%; min-height: 56px; padding: 7px 9px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; font-size: 12px; font-family: inherit; resize: vertical; margin-bottom: 8px; }
  .req-actions { display: flex; gap: 6px; }
  .req-submit { padding: 6px 12px; background: #8957e5; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .req-submit:hover { background: #a371f7; }
  .req-dismiss { padding: 6px 12px; background: transparent; color: #f85149; border: 1px solid #6e2a2a; border-radius: 5px; cursor: pointer; font-size: 12px; margin-left: auto; }
  .req-dismiss:hover { background: #5a1f1f; }
  .req-attach { padding: 6px 10px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 5px; cursor: pointer; font-size: 12px; }
  .req-attach:hover { background: #30363d; }
  .req-file-hint { font-size: 11px; color: #3fb950; margin-bottom: 6px; min-height: 0; }
  .req-gemini { padding: 6px 12px; background: #1a3a5c; color: #58a6ff; border: 1px solid #1f6feb; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .req-gemini:hover { background: #1f6feb; color: #fff; }
  .req-gemini:disabled { opacity: 0.5; cursor: not-allowed; }
  .gemini-status { font-size: 11px; margin-bottom: 6px; min-height: 0; }
  .gemini-status.loading { color: #d29922; }
  .gemini-status.error { color: #f85149; }
  .gemini-status.done { color: #3fb950; }

  /* Gemini 설정 패널 */
  .gemini-panel { background: #161b22; border: 1px solid #1f6feb; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .gemini-panel-title { font-size: 13px; font-weight: 700; color: #58a6ff; margin-bottom: 4px; }
  .gemini-panel-desc { font-size: 11px; color: #8b949e; margin-bottom: 10px; }
  .gemini-panel-row { display: flex; gap: 8px; align-items: center; }
  .gemini-key-input { flex: 1; padding: 6px 10px; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 5px; font-size: 12px; font-family: monospace; }
  .gemini-save-btn { padding: 6px 14px; background: #1f6feb; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .gemini-save-btn:hover { background: #388bfd; }
  .gemini-saved-msg { font-size: 11px; color: #3fb950; }
  .gemini-settings-btn { font-size: 11px; }

  /* ── 제안(suggestion) 카드 ── */
  .suggest-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .sug-header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .sug-cat { font-size: 11px; font-weight: 700; color: #3fb950; }
  .sug-by { font-size: 11px; color: #8b949e; }
  .sug-time { font-size: 11px; color: #6e7681; margin-left: auto; }
  .sug-title { font-size: 13px; font-weight: 600; color: #e6edf3; margin-bottom: 5px; }
  .sug-detail { font-size: 12px; color: #c9d1d9; line-height: 1.5; margin-bottom: 6px; }
  .sug-impact { font-size: 11px; color: #d29922; margin-bottom: 8px; }
  .sug-actions { display: flex; gap: 6px; }
  .sug-accept { padding: 6px 14px; background: #238636; color: #fff; border: none; border-radius: 5px; cursor: pointer; font-size: 12px; font-weight: 500; }
  .sug-accept:hover { background: #2ea043; }
  .sug-dismiss { padding: 6px 12px; background: transparent; color: #f85149; border: 1px solid #6e2a2a; border-radius: 5px; cursor: pointer; font-size: 12px; margin-left: auto; }
  .sug-dismiss:hover { background: #5a1f1f; }

  /* ── 하단 바 ── */
  .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #21262d; display: flex; gap: 10px; flex-wrap: wrap; }
</style>
</head>
<body>

  <div class="header">
    <div>
      <div class="header-title">🏢 ${_esc(data.companyName)} 대시보드</div>
      <div class="header-sub">AI 에이전트 팀 현황</div>
    </div>
    <div class="header-right">
      <span class="refresh-time">마지막 갱신: ${now}</span>
      <button class="btn gemini-settings-btn" id="geminiSettingsBtn" data-action="toggle-gemini-settings">🤖 Gemini ${data.geminiKeySet ? '<span style="color:#3fb950">●</span>' : '<span style="color:#f85149">○</span>'}</button>
      <button class="btn" data-action="refresh">🔄 새로고침</button>
    </div>
  </div>

  <!-- Gemini API 키 설정 패널 (접었다 폈다) -->
  <div class="gemini-panel" id="geminiPanel" style="display:none">
    <div class="gemini-panel-title">🤖 Gemini API 설정</div>
    <div class="gemini-panel-desc">API 키는 로컬 settings.json에만 저장됩니다 (GitHub 미업로드).</div>
    <div class="gemini-panel-row">
      <input class="gemini-key-input" id="geminiKeyInput" type="password"
             placeholder="API 키 입력 (AQ.Ab8RN6I8U1sj...)"
             value="${data.geminiKeyMasked || ''}"/>
      <button class="gemini-save-btn" id="geminiSaveBtn" data-action="save-gemini-key">저장</button>
      <span class="gemini-saved-msg" id="geminiSavedMsg"></span>
    </div>
  </div>

  <!-- 대표님 처리함 (결재 + 사람 도움 요청) -->
  ${(() => {
    const dCount = data.pendingDecisions.length;
    const rCount = (data.pendingRequests || []).length;
    const sCount = (data.pendingSuggestions || []).length;
    const total  = dCount + rCount + sCount;
    const active = total > 0;
    return `
  <div class="section" style="background: ${active ? '#1f6feb22' : '#161b22'}; border: 1px solid ${active ? '#1f6feb' : '#21262d'}; border-radius: 8px; padding: 14px; margin-bottom: 24px;">
    <div class="section-title">📥 대표님 처리함 ${active ? `<span style="color:#f0c040">(${total}건 대기)</span>` : ''}</div>

    <div class="inbox-sub">🗳️ 결재 — 결정해 주세요 ${dCount > 0 ? `(${dCount})` : ''}</div>
    ${decisionCards}

    <div class="inbox-sub" style="margin-top:14px;">🙋 요청 — AI가 못 하는 일, 채워 주세요 ${rCount > 0 ? `(${rCount})` : ''}${data.triageCount > 0 ? `<span style="color:#8b949e;font-weight:400;font-size:11px;"> · 파트장 검토 중 ${data.triageCount}건</span>` : ''}</div>
    ${requestCards}

    <div class="inbox-sub" style="margin-top:14px;">💡 제안 — 파트장이 올린 중요 제안 ${sCount > 0 ? `(${sCount})` : ''}</div>
    ${suggestionCards}
  </div>`;
  })()}

  <!-- 에이전트 현황 -->
  <div class="section">
    <div class="section-title">에이전트 현황</div>
    <div class="agent-grid">${agentCards}</div>
  </div>

  <!-- Brain 통계 + 최근 활동 -->
  <div class="two-col section">
    <div class="panel">
      <div class="panel-title">🧠 Brain 현황</div>
      <div class="stat-row"><span>회사 이름</span><span class="stat-val">${_esc(data.companyName)}</span></div>
      <div class="stat-row"><span>대화 로그</span><span class="stat-val">${data.convCount}일치</span></div>
      <div class="stat-row"><span>에이전트</span><span class="stat-val">${data.agentStats.length}명</span></div>
      <div class="stat-row"><span>활성 에이전트</span><span class="stat-val" style="color:#3fb950">${data.agentStats.filter(a=>a.status==='active').length}명</span></div>
    </div>
    <div class="panel">
      <div class="panel-title">⚡ 오늘 활동 <span style="font-weight:400;color:#8b949e;font-size:11px">${todayLabel}</span></div>
      ${activityRows}
      ${activityToggle}
    </div>
  </div>

  <!-- workspace 파일 -->
  <div class="section">
    <div class="section-title">📁 최근 생성 파일</div>
    <div class="panel">
      ${fileRows}
    </div>
  </div>

  <div class="footer">
    <button class="btn" data-action="open-brain">🧠 뇌 폴더 편집</button>
    <button class="btn" data-action="open-folder" data-path="${_esc(data.workspaceDir)}">📁 workspace 열기</button>
    <button class="btn btn-primary" data-action="open-folder" data-path="${_esc(path.join(data.workspaceDir, 'reports'))}">📄 리포트 보기</button>
  </div>

<script nonce="${nonce}">
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
    if (confirm('이 요청을 무시할까요?')) {
      vscode.postMessage({ type: 'dismiss_request', requestId: id });
      refresh();
    }
  }

  // 통합 클릭 핸들러 — 모든 버튼을 이벤트 위임으로 처리 (nonce CSP 환경에서도 동작)
  document.addEventListener('click', function(e) {
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
      case 'refresh':               refresh(); break;
      case 'toggle-gemini-settings': toggleGeminiSettings(); break;
      case 'save-gemini-key':       saveGeminiKey(); break;
      case 'open-brain':            vscode.postMessage({ type: 'open_brain' }); break;
      case 'open-folder':           vscode.postMessage({ type: 'open_folder', path: t.dataset.path }); break;
      case 'toggle-activities':     toggleActivities(); break;
      case 'gemini':                geminiResolve(id, t.dataset.question || ''); break;
      case 'attach':                attachFile(id); break;
      case 'fulfill':               fulfillRequest(id); break;
      case 'dismiss-req':           dismissRequest(id); break;
      case 'approve': {
        const opt = t.dataset.option;
        if (confirm('이 안으로 승인하시겠습니까?\n\n선택: ' + opt)) {
          vscode.postMessage({ type: 'approve_decision', decisionId: t.dataset.decisionId, chosenValue: opt });
          refresh();
        }
        break;
      }
      case 'reject': {
        const reason = prompt('보류/반려 사유 (선택):', '');
        if (reason !== null) {
          vscode.postMessage({ type: 'reject_decision', decisionId: t.dataset.decisionId, reason });
          refresh();
        }
        break;
      }
      case 'accept-suggestion': {
        const note = prompt('채택합니다. 파트장에게 전할 메모 (선택):', '');
        if (note !== null) {
          vscode.postMessage({ type: 'accept_suggestion', suggestionId: t.dataset.suggestionId, note });
          refresh();
        }
        break;
      }
      case 'dismiss-suggestion': {
        const note = prompt('반려 사유 (선택):', '');
        if (note !== null) {
          vscode.postMessage({ type: 'dismiss_suggestion', suggestionId: t.dataset.suggestionId, note });
          refresh();
        }
        break;
      }
    }
  });

  applyActivityState();

  window.addEventListener('message', e => {
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
</script>
</body>
</html>`;
  }
}

// ============================================================
//  GoalDashboardPanel: 회사 목표 관리 대시보드 (연간/월간/주간/일간)
// ============================================================
class GoalDashboardPanel {
  static currentPanel = null;

  static createOrShow(context) {
    if (GoalDashboardPanel.currentPanel) {
      GoalDashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      GoalDashboardPanel.currentPanel._update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiCompanyGoals', '🎯 목표 관리',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    GoalDashboardPanel.currentPanel = new GoalDashboardPanel(panel, context);
  }

  constructor(panel, context) {
    this._panel   = panel;
    this._context = context;
    this._update();

    this._panel.onDidDispose(() => { GoalDashboardPanel.currentPanel = null; });
    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'add_goal')      brain.addGoal(msg.level || msg.period, msg.title, { parentId: msg.parentId, weight: msg.weight, type: msg.type });
      if (msg.type === 'update_goal')   brain.updateGoalById(msg.id, msg.fields);
      if (msg.type === 'delete_goal')   brain.deleteGoal(msg.id);
      if (msg.type === 'refresh_goals') { /* 아래 _update로 갱신 */ }
      this._update();
    });
  }

  _update() {
    try {
      this._panel.webview.html = this._getHtml(brain.getGoalsTree(), brain.getGoals());
    } catch (err) {
      this._panel.webview.html = `<body style="color:white;padding:20px">❌ 오류: ${_esc(err.message)}</body>`;
    }
  }

  _getHtml(tree, goalsFlat) {
    const LEVEL = {
      annual:  { label: '연간', emoji: '📅', accent: '#f0883e', child: 'monthly' },
      monthly: { label: '월간', emoji: '🗓️', accent: '#58a6ff', child: 'weekly' },
      weekly:  { label: '주간', emoji: '📆', accent: '#3fb950', child: 'daily' },
      daily:   { label: '일간', emoji: '☀️', accent: '#d29922', child: null }
    };
    const PACE = {
      ahead:    { label: '⏫ 앞섬',  cls: 'pace-ahead' },
      on_track: { label: '✅ 정상',  cls: 'pace-on' },
      behind:   { label: '⚠️ 지연',  cls: 'pace-behind' },
      done:     { label: '🏁 완료',  cls: 'pace-done' }
    };
    const barColor = p => p >= 100 ? '#3fb950' : p >= 60 ? '#58a6ff' : p >= 30 ? '#d29922' : '#f85149';

    // 재귀 노드 렌더링
    const renderNode = (node, depth) => {
      const lv = LEVEL[node.level] || LEVEL.daily;
      const pace = PACE[node.pace] || PACE.on_track;
      const krText = (node.keyResults || []).map(k => `${_esc(k.metric)} ${k.current}/${k.target}`).join(' · ');
      const weightBadge = node.parentId ? `<span class="badge weight" title="부모 기여 가중치">⚖ ${Math.round((node.weight || 0) * 100)}%</span>` : '';
      const typeBadge = `<span class="badge type-${node.type}">${node.type === 'lead' ? 'lead·행동' : 'lag·결과'}</span>`;
      const titleJson = JSON.stringify(_esc(node.title)).replace(/"/g, '&quot;');

      // 자식이 있으면(자동 집계) 슬라이더 숨김, 없으면(리프) 진행률 직접 조정
      const progControl = node.isParent
        ? `<span class="auto-tag">자동 집계 (자식 가중합)</span>`
        : `<button class="g-btn" onclick="bump('${node.id}', ${Math.max(0, node.progress - 10)})">−10</button>
           <button class="g-btn" onclick="bump('${node.id}', ${Math.min(100, node.progress + 10)})">+10</button>
           <input class="g-slider" type="range" min="0" max="100" value="${node.progress}" onchange="bump('${node.id}', this.value)"/>`;

      const addChildBtn = lv.child
        ? `<button class="g-btn add" onclick="addChild('${node.id}','${lv.child}')">+ ${LEVEL[lv.child].label} 하위</button>`
        : '';

      const childrenHtml = (node.children || []).map(c => renderNode(c, depth + 1)).join('');

      return `
        <div class="node" style="margin-left:${depth * 20}px">
          <div class="goal-card ${node.status === 'done' ? 'done' : ''}" style="border-left:3px solid ${lv.accent}">
            <div class="goal-top">
              <span class="badge lvl" style="background:${lv.accent}22;color:${lv.accent}">${lv.emoji} ${lv.label}</span>
              ${typeBadge}
              <span class="goal-title">${node.status === 'done' ? '✅ ' : ''}${_esc(node.title)}</span>
              ${weightBadge}
              <span class="badge ${pace.cls}">${pace.label}</span>
              <span class="goal-pct" style="color:${barColor(node.progress)}">${node.progress}%</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${node.progress}%;background:${barColor(node.progress)}"></div>
              <div class="elapsed-mark" style="left:${node.elapsedPct}%" title="기간 경과 ${node.elapsedPct}%"></div>
            </div>
            ${krText ? `<div class="goal-kr">🎯 KR: ${krText}</div>` : ''}
            ${node.note ? `<div class="goal-note">📝 ${_esc(node.note)}</div>` : ''}
            <div class="goal-actions">
              ${progControl}
              <button class="g-btn" onclick="editWeight('${node.id}', ${Math.round((node.weight || 0) * 100)})" title="가중치 조정">⚖</button>
              <button class="g-btn edit" onclick="editGoal('${node.id}', ${titleJson})" title="제목 수정">✏️</button>
              ${addChildBtn}
              <button class="g-btn del" onclick="delGoal('${node.id}')" title="삭제">🗑</button>
            </div>
          </div>
          ${childrenHtml}
        </div>`;
    };

    const treeHtml = tree.length > 0
      ? tree.map(n => renderNode(n, 0)).join('')
      : '<div class="goal-empty">아직 목표가 없습니다. 아래에서 연간 목표를 추가하거나, 파트장에게 "목표를 수립해줘"라고 요청하세요.</div>';

    // 요약 통계
    const all = [...goalsFlat.annual, ...goalsFlat.monthly, ...goalsFlat.weekly, ...goalsFlat.daily];
    const annualAvg = goalsFlat.annual.length > 0 ? Math.round(goalsFlat.annual.reduce((s, g) => s + g.progress, 0) / goalsFlat.annual.length) : 0;
    const doneCount = all.filter(g => g.status === 'done').length;
    const behindCount = tree.flatMap(function f(n){ return [n, ...(n.children||[]).flatMap(f)]; }).filter(n => n.pace === 'behind').length;

    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<style>
  *,*::before,*::after { box-sizing: border-box; }
  body { margin:0; padding:20px; font-family:-apple-system,'Segoe UI',sans-serif; background:#0d1117; color:#e6edf3; }
  .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:16px; border-bottom:1px solid #21262d; }
  .header-title { font-size:20px; font-weight:700; }
  .header-sub { font-size:13px; color:#8b949e; margin-top:2px; }
  .summary { display:flex; gap:24px; margin:16px 0 20px; padding:14px 18px; background:#161b22; border:1px solid #21262d; border-radius:10px; }
  .sum-item { font-size:13px; color:#8b949e; }
  .sum-val { font-size:22px; font-weight:700; color:#58a6ff; display:block; }
  .legend { font-size:11px; color:#6e7681; margin-bottom:14px; display:flex; gap:14px; flex-wrap:wrap; }
  .node { }
  .goal-card { background:#161b22; border:1px solid #21262d; border-radius:8px; padding:10px 12px; margin-bottom:8px; }
  .goal-card.done { opacity:0.65; }
  .goal-top { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .goal-title { font-size:13px; font-weight:600; flex:1; min-width:120px; }
  .goal-pct { font-size:14px; font-weight:700; white-space:nowrap; }
  .badge { font-size:10px; padding:1px 6px; border-radius:10px; white-space:nowrap; font-weight:600; }
  .badge.lvl { }
  .badge.type-lead { background:#1f6feb22; color:#58a6ff; }
  .badge.type-lag  { background:#8957e522; color:#a371f7; }
  .badge.weight { background:#30363d; color:#d29922; }
  .pace-ahead  { background:#3fb95022; color:#3fb950; }
  .pace-on     { background:#1f6feb22; color:#58a6ff; }
  .pace-behind { background:#f8514922; color:#f85149; }
  .pace-done   { background:#30363d; color:#8b949e; }
  .bar-track { position:relative; height:7px; background:#21262d; border-radius:4px; margin:8px 0 6px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:4px; transition:width .3s; }
  .elapsed-mark { position:absolute; top:-2px; width:2px; height:11px; background:#e6edf3; opacity:0.55; }
  .goal-kr { font-size:11px; color:#d29922; margin-bottom:4px; }
  .goal-note { font-size:11px; color:#8b949e; margin-bottom:6px; }
  .goal-actions { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
  .g-btn { padding:2px 7px; font-size:11px; background:#21262d; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; cursor:pointer; }
  .g-btn:hover { background:#30363d; }
  .g-btn.del:hover { background:#7d1f1f; }
  .g-btn.add:hover { background:#1a7f37; }
  .g-slider { flex:1; min-width:60px; max-width:160px; accent-color:#58a6ff; }
  .auto-tag { font-size:11px; color:#8b949e; font-style:italic; }
  .goal-empty { color:#6e7681; font-size:13px; padding:30px; text-align:center; background:#161b22; border:1px dashed #30363d; border-radius:10px; }
  .add-root { display:flex; gap:6px; margin-top:16px; padding-top:14px; border-top:1px solid #21262d; }
  .add-input { flex:1; padding:6px 9px; background:#0d1117; color:#e6edf3; border:1px solid #30363d; border-radius:5px; font-size:12px; }
  .add-sel { padding:6px; background:#0d1117; color:#e6edf3; border:1px solid #30363d; border-radius:5px; font-size:12px; }
  .add-btn { padding:6px 12px; background:#238636; color:#fff; border:none; border-radius:5px; cursor:pointer; font-size:12px; }
  .add-btn:hover { background:#2ea043; }
  .btn { padding:6px 14px; border:1px solid #30363d; background:#21262d; color:#c9d1d9; border-radius:6px; cursor:pointer; font-size:12px; }
  .btn:hover { background:#30363d; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="header-title">🎯 목표 관리 대시보드 (계층·가중치)</div>
      <div class="header-sub">연간→월간→주간→일간 유기적 연결 · 상위 진행률은 하위의 가중 합으로 자동 집계</div>
    </div>
    <button class="btn" onclick="refresh()">🔄 새로고침</button>
  </div>

  <div class="summary">
    <div class="sum-item"><span class="sum-val" style="color:#f0883e">${annualAvg}%</span>연간 목표 평균</div>
    <div class="sum-item"><span class="sum-val">${all.length}</span>전체 목표 수</div>
    <div class="sum-item"><span class="sum-val" style="color:#3fb950">${doneCount}</span>완료</div>
    <div class="sum-item"><span class="sum-val" style="color:${behindCount > 0 ? '#f85149' : '#8b949e'}">${behindCount}</span>⚠️ 지연 목표</div>
  </div>

  <div class="legend">
    <span>⚖ = 부모 기여 가중치</span>
    <span>lead = 통제 가능한 행동</span>
    <span>lag = 결과 지표</span>
    <span>│ 흰 세로선 = 기간 경과 위치 (진행률이 이보다 왼쪽이면 지연)</span>
  </div>

  <div class="tree">${treeHtml}</div>

  <div class="add-root">
    <select class="add-sel" id="rootLevel">
      <option value="annual">📅 연간</option>
      <option value="monthly">🗓️ 월간</option>
      <option value="weekly">📆 주간</option>
      <option value="daily">☀️ 일간</option>
    </select>
    <input class="add-input" id="rootTitle" placeholder="최상위 목표 추가 (부모 없음)..." onkeydown="if(event.key==='Enter')addRoot()"/>
    <button class="add-btn" onclick="addRoot()">+ 추가</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  function refresh() { vscode.postMessage({ type: 'refresh_goals' }); }
  function addRoot() {
    const level = document.getElementById('rootLevel').value;
    const title = document.getElementById('rootTitle').value.trim();
    if (!title) return;
    vscode.postMessage({ type: 'add_goal', level, title });
  }
  function addChild(parentId, childLevel) {
    const title = prompt(childLevel + ' 하위 목표 제목:');
    if (title && title.trim()) {
      vscode.postMessage({ type: 'add_goal', level: childLevel, title: title.trim(), parentId });
    }
  }
  function bump(id, progress) {
    vscode.postMessage({ type: 'update_goal', id, fields: { progress: Number(progress) } });
  }
  function delGoal(id) {
    if (confirm('이 목표를 삭제할까요? (자식은 상위로 승계됩니다)')) {
      vscode.postMessage({ type: 'delete_goal', id });
    }
  }
  function editGoal(id, current) {
    const next = prompt('목표 수정:', current);
    if (next !== null && next.trim()) {
      vscode.postMessage({ type: 'update_goal', id, fields: { title: next.trim() } });
    }
  }
  function editWeight(id, currentPct) {
    const next = prompt('부모 기여 가중치 (0~100%):', currentPct);
    if (next !== null && next.trim() !== '') {
      const pct = Math.max(0, Math.min(100, Number(next)));
      vscode.postMessage({ type: 'update_goal', id, fields: { weight: pct / 100 } });
    }
  }
</script>
</body>
</html>`;
  }
}

// ─────────────────────────────────────────────────────────────
//  callGemini: Gemini API (Google Search 그라운딩)로 자료 요청 자동 해결
//  - 실시간 웹 검색 결과를 바탕으로 답변 생성
//  - 무료 티어: gemini-1.5-flash, 분당 15건, 일 1M 토큰
// ─────────────────────────────────────────────────────────────
async function callGemini(question, apiKey) {
  if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다.');

  const systemPrompt = `당신은 비즈니스 시장조사 전문가입니다.
아래 질문에 대해 최신 정보를 바탕으로 명확하고 구체적으로 답변하세요.
숫자·통계가 있으면 반드시 출처(기관명 또는 연도)를 명시하세요.
확실하지 않은 정보는 "[추정]" 또는 "[출처 미확인]"으로 표시하세요.
답변은 한국어로, 마크다운 형식으로 작성하세요.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: question }] }],
    tools: [{ google_search: {} }]  // Google Search 그라운딩 활성화
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Gemini API 오류: ${msg}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini 응답이 비어있습니다.');

  // 검색 소스가 있으면 하단에 출처 목록 추가
  const grounds = data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (grounds && grounds.length > 0) {
    const sources = grounds
      .filter(g => g.web?.uri)
      .slice(0, 5)
      .map(g => `- [${g.web.title || g.web.uri}](${g.web.uri})`)
      .join('\n');
    return `${text}\n\n---\n**참고 출처:**\n${sources}`;
  }
  return text;
}

function _timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date)) / 60000);
  if (diff < 1)   return '방금';
  if (diff < 60)  return `${diff}분 전`;
  if (diff < 1440) return `${Math.floor(diff / 60)}시간 전`;
  return `${Math.floor(diff / 1440)}일 전`;
}
function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function deactivate() {}
module.exports = { activate, deactivate };
