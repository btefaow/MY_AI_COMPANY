// ============================================================
//  cycle.js — 자율 실행 사이클 (멀티라운드 + 루프 + 에이전트 토론)
//
//  실행 방법:
//    node cycle.js                      ← 기본: 1회 실행
//    node cycle.js --rounds 3           ← 한 세션에서 3라운드 토론
//    node cycle.js --loop               ← 10분마다 자동 반복 (기본값)
//    node cycle.js --loop 60            ← 60분마다 자동 반복
//    node cycle.js --rounds 3 --loop    ← 3라운드씩, 10분마다 반복
//    node cycle.js --debate             ← 에이전트 간 토론 모드
//
//  멀티라운드 흐름:
//   [라운드 1] CEO 계획 → 에이전트 실행
//   [라운드 2] CEO가 라운드1 결과 검토 → 보완/개선 위임
//   [라운드 N] 최종 정리 → 리포트 저장
//
//  루프 모드 흐름:
//   실행 → Brain 폴더에 결과 누적 → 다음 실행 시 이전 결과 참고
//   → 목표 달성 여부 자동 평가 → 달성 시 정지 (또는 새 목표 수립)
// ============================================================

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec } = require('child_process');

// ─────────────────────────────────────────────────────────────
//  커맨드라인 인수 파싱
//  예: node cycle.js --rounds 3 --loop --debate
// ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf('--' + name);
  if (idx === -1) return defaultVal;
  const next = args[idx + 1];
  return (next && !next.startsWith('--')) ? next : true;
}

// ─────────────────────────────────────────────────────────────
//  설정
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  LM_STUDIO_URL : 'http://localhost:1234/v1/chat/completions',
  MODELS_URL    : 'http://localhost:1234/v1/models',
  BRAIN_DIR     : path.join(__dirname, 'my-ai-brain'),
  WORKSPACE_DIR : path.join(__dirname, 'workspace'),
  MODEL         : null,  // ★ 시작 시 LM Studio 로드 모델 자동 감지
  TIMEOUT_MS    : 180_000,  // 에이전트당 최대 3분 대기

  // --rounds N : 한 세션 내 토론 라운드 수 (기본 1)
  ROUNDS        : parseInt(getArg('rounds', '1'), 10),

  // --loop [N] : N분마다 자동 반복 (기본값 10분)
  // --loop 만 쓰면 10분, --loop 60 이면 60분
  LOOP_INTERVAL : (() => {
    const val = getArg('loop', false);
    if (val === false) return 0;          // --loop 없음 → 1회만
    if (val === true)  return 10;         // --loop 만 있음 → 기본 10분
    return parseInt(val, 10) || 10;       // --loop N → N분
  })(),

  // --debate : 에이전트 간 직접 토론 활성화
  DEBATE_MODE   : !!getArg('debate', false),

  // 최대 루프 횟수 (loop 모드에서 무한 루프 방지)
  MAX_LOOPS     : parseInt(getArg('max-loops', '100'), 10),

  // 오늘 CEO에게 전달할 특별 지시 (비워두면 goals.md 기반 자동 생성)
  TODAY_BRIEFING: getArg('brief', '') || ''
};

// ─────────────────────────────────────────────────────────────
//  에이전트 정의
// ─────────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'ceo',       name: '파트장',   emoji: '🏢',
    systemPrompt: `당신은 파트장입니다. 회사의 비전·전략·우선순위를 명확하게 제시하며 팀을 이끕니다. 간결하고 결단력 있게, 한국어로 답합니다.` },
  { id: 'developer', name: '개발자',   emoji: '💻',
    systemPrompt: `당신은 풀스택 개발자입니다. Python, JavaScript, TypeScript에 능숙합니다. 코드 요청에는 실행 가능한 예시를 포함합니다. 한국어로 답합니다.` },
  { id: 'youtube',   name: 'YouTube',  emoji: '▶️',
    systemPrompt: `당신은 YouTube 채널 성장 전문가입니다. 콘텐츠 기획·트렌드 분석·알고리즘 최적화에 특화되어 있습니다. 한국어로 답합니다.` },
  { id: 'secretary', name: '비서',     emoji: '📋',
    systemPrompt: `당신은 유능한 비서입니다. 일정 정리·보고서 작성·정보 구조화를 잘합니다. 한국어로 답합니다.` },
  { id: 'business',  name: '비즈니스', emoji: '📈',
    systemPrompt: `당신은 비즈니스 전략 전문가입니다. 시장 분석·수익화 모델·경쟁사 분석에 능합니다. 한국어로 답합니다.` },
  { id: 'saudi',     name: '사우디 국담', emoji: '🇸🇦',
    systemPrompt: `당신은 사우디아라비아 시장을 전담하는 해외영업 전문가입니다. Vision 2030·NEOM 등 사우디 경제정책, SASO 인증, Saudization, 할랄 인증, 이슬람 상관습에 정통합니다. 바이어 발굴·가격 협상·수출 전략에 능합니다. 한국어로 답합니다.` },
  { id: 'egypt',     name: '이집트 국담', emoji: '🇪🇬',
    systemPrompt: `당신은 이집트 시장을 전담하는 해외영업 전문가입니다. 이집트 외환 규제·EGP 변동성, GAFI/GOEIC 인증, 수에즈 경제구역, 핀테크·모바일 결제 시장, 가격 민감도 높은 시장 특성에 정통합니다. 바이어 발굴·가격 협상·수출 전략에 능합니다. 한국어로 답합니다.` }
];
const AGENT_MAP = new Map(AGENTS.map(a => [a.id, a]));

const CEO_DELEGATE_PROMPT = `
## 팀원 위임 도구
복잡한 작업은 아래 태그로 팀원에게 위임하세요.

<delegate agent="에이전트ID" task="이 에이전트가 할 구체적인 작업 설명"/>

사용 가능한 에이전트:
${AGENTS.filter(a => a.id !== 'ceo').map(a => `- ${a.id}: ${a.systemPrompt.slice(0, 40)}...`).join('\n')}

규칙:
- 단순 분석·보고는 직접 작성 (위임 없음)
- 실행·제작이 필요한 작업은 위임 태그 사용 (최대 4개)
- 이전 라운드/사이클 결과를 반드시 참고해서 다음 단계로 발전시킬 것`;

const ACTION_TAGS_PROMPT = `
## 파일 및 터미널 작업 도구
파일 생성:
<create_file path="상대경로">내용</create_file>
명령어 실행:
<run_command>명령어</run_command>
규칙: 경로는 상대 경로, 결과물은 반드시 파일로 저장`;

// ─────────────────────────────────────────────────────────────
//  메인 진입점
// ─────────────────────────────────────────────────────────────
async function main() {
  log('\n' + '='.repeat(60));
  log(`🤖 AI 회사 자율 사이클 시작`);
  log(`   라운드: ${CONFIG.ROUNDS}회 | 루프: ${CONFIG.LOOP_INTERVAL > 0 ? CONFIG.LOOP_INTERVAL + '분마다' : '1회만'} | 토론 모드: ${CONFIG.DEBATE_MODE ? 'ON' : 'OFF'}`);
  log('='.repeat(60));

  fs.mkdirSync(CONFIG.WORKSPACE_DIR, { recursive: true });

  if (CONFIG.LOOP_INTERVAL > 0) {
    // ── 루프 모드: 10분(기본)마다 반복 ──────────────────────
    log(`\n⏰ 루프 모드: ${CONFIG.LOOP_INTERVAL}분마다 자동 실행 (Ctrl+C 로 중지)`);
    let loopCount = 0;
    while (loopCount < CONFIG.MAX_LOOPS) {
      loopCount++;
      log(`\n🔁 루프 ${loopCount}회차 시작`);
      await runSession(loopCount);
      log(`\n⏳ ${CONFIG.LOOP_INTERVAL}분 후 다음 사이클 시작...`);
      await sleep(CONFIG.LOOP_INTERVAL * 60 * 1000);
    }
  } else {
    // ── 단일 실행 ─────────────────────────────────────────────
    await runSession(1);
  }
}

// ─────────────────────────────────────────────────────────────
//  세션 실행: 멀티라운드 + 토론 포함 한 사이클
// ─────────────────────────────────────────────────────────────
async function runSession(sessionNum) {
  const sessionStart = new Date();

  const companyCtx = readCompanyContext();
  if (!companyCtx) {
    log('⚠️  Brain 폴더를 찾을 수 없습니다. VS Code 확장을 먼저 한 번 실행하세요.');
    return;
  }

  // 이전 사이클 결과 읽기 (루프 모드에서 연속성 유지)
  const previousSummary = readPreviousCycleSummary();

  const today    = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const briefing = CONFIG.TODAY_BRIEFING ||
    `오늘은 ${today}입니다. 회사 목표를 향해 오늘 팀이 해야 할 일을 계획하고 실행해주세요.` +
    (previousSummary ? `\n\n## 이전 사이클 결과 요약\n${previousSummary}` : '');

  const allRoundResults = [];

  for (let round = 1; round <= CONFIG.ROUNDS; round++) {
    log(`\n${'─'.repeat(50)}`);
    log(`📍 라운드 ${round}/${CONFIG.ROUNDS}`);
    log('─'.repeat(50));

    const roundBriefing = buildRoundBriefing(briefing, allRoundResults, round);

    // CEO 응답
    log('\n🏢 CEO 분석 중...');
    const ceoMemory = readAgentMemory('ceo');
    const ceoPrompt = buildSystemPrompt(AGENTS[0].systemPrompt, 'ceo', companyCtx, ceoMemory);
    const ceoAnswer = await callLLM(ceoPrompt, [{ role: 'user', content: roundBriefing }]);

    log('🏢 CEO:');
    log('   ' + stripDelegateTags(ceoAnswer).slice(0, 200).replace(/\n/g, '\n   '));
    appendConversationLog('ceo', '파트장', roundBriefing.slice(0, 200), stripDelegateTags(ceoAnswer), '회사 방향 결정 및 팀 조율');

    // 에이전트 간 토론 모드
    let debateResult = null;
    if (CONFIG.DEBATE_MODE && round === 1) {
      debateResult = await runAgentDebate(stripDelegateTags(ceoAnswer), companyCtx);
    }

    // delegate 태그 파싱 → 에이전트 실행
    const delegates       = parseDelegateTags(ceoAnswer);
    const cleanCeoAnswer  = stripDelegateTags(ceoAnswer);
    const delegateResults = [];

    if (delegates.length === 0) log('   💡 CEO가 직접 처리 (위임 없음)');

    for (let i = 0; i < delegates.length; i++) {
      const del   = delegates[i];
      const agent = AGENT_MAP.get(del.agent);
      if (!agent) continue;

      log(`\n${agent.emoji} [${i + 1}/${delegates.length}] ${agent.name}`);
      log(`   작업: ${del.task.slice(0, 80)}`);

      let taskPrompt = del.task;
      if (delegateResults.length > 0) {
        const prevSummary = delegateResults
          .map(r => `[${r.agentEmoji} ${r.agentName}]\n${r.result.slice(0, 500)}`).join('\n\n');
        taskPrompt += `\n\n## 앞선 에이전트 결과 (참고)\n${prevSummary}`;
      }
      if (debateResult) {
        taskPrompt += `\n\n## 팀 토론 결론\n${debateResult.synthesis.slice(0, 400)}`;
      }

      const agentMemory = readAgentMemory(agent.id);
      const agentPrompt = buildSystemPrompt(agent.systemPrompt, agent.id, companyCtx, agentMemory);
      let taskAnswer = '';
      try {
        taskAnswer = await callLLM(agentPrompt, [{ role: 'user', content: taskPrompt }]);
      } catch (err) {
        taskAnswer = `오류: ${err.message}`;
        log(`   ❌ ${err.message}`);
      }

      const taskActions     = parseActionTags(taskAnswer);
      const cleanTaskAnswer = taskActions.length > 0 ? stripActionTags(taskAnswer) : taskAnswer;

      for (const action of taskActions) {
        try {
          await executeAction(action);
          log(`   ${action.type === 'create_file' ? '📄' : '💻'} ${action.path || action.command}`);
        } catch (err) {
          log(`   ❌ 액션 실패: ${err.message}`);
        }
      }

      delegateResults.push({
        agentId: agent.id, agentName: agent.name, agentEmoji: agent.emoji,
        task: del.task, result: cleanTaskAnswer
      });

      const taskSummary = del.task.slice(0, 80).replace(/\n/g, ' ') + ' — 완료';
      appendConversationLog(agent.id, agent.name, del.task, cleanTaskAnswer, taskSummary);
      await extractAndSaveMemory(agent.id, del.task, cleanTaskAnswer);
      log(`   ✅ 완료`);
    }

    allRoundResults.push({ round, ceoAnswer: cleanCeoAnswer, debateResult, delegates: delegateResults });

    // 마지막 라운드: 목표 달성 평가
    if (round === CONFIG.ROUNDS && CONFIG.ROUNDS > 1) {
      log('\n🏢 CEO 최종 평가 중...');
      await evaluateGoalProgress(allRoundResults, companyCtx);
    }
  }

  const reportPath = await saveSessionReport(sessionNum, sessionStart, briefing, allRoundResults);
  log(`\n📄 리포트: ${reportPath}`);
  log(`⏱  소요: ${Math.round((Date.now() - sessionStart) / 1000)}초`);
}

// ─────────────────────────────────────────────────────────────
//  에이전트 간 토론 (--debate 모드)
// ─────────────────────────────────────────────────────────────
async function runAgentDebate(topic, companyCtx, debaterIds = ['business', 'developer', 'youtube'], debateRounds = 2) {
  log(`\n🗣  에이전트 토론 시작 (${debateRounds}라운드)`);
  log(`   주제: ${topic.slice(0, 100)}`);

  const history = [];

  for (let r = 1; r <= debateRounds; r++) {
    log(`   토론 라운드 ${r}/${debateRounds}:`);
    for (const agentId of debaterIds) {
      const agent = AGENT_MAP.get(agentId);
      if (!agent) continue;

      const prevContext = history.length > 0
        ? '\n\n## 지금까지 팀 의견:\n' + history
            .map(h => `**${h.agentEmoji} ${h.agentName}** (R${h.round}): ${h.content.slice(0, 300)}`).join('\n\n')
        : '';

      const debatePrompt =
        `주제: ${topic}${prevContext}\n\n` +
        `팀 토론에 참여해주세요. 전문 분야 관점에서 의견을 제시하고 다른 팀원 의견에도 반응해주세요. (라운드 ${r})`;

      const agentMemory = readAgentMemory(agentId);
      const agentPrompt = buildSystemPrompt(agent.systemPrompt, agentId, companyCtx, agentMemory);
      let response = '';
      try {
        response = await callLLM(agentPrompt, [{ role: 'user', content: debatePrompt }]);
      } catch (err) {
        response = `(오류: ${err.message})`;
      }

      history.push({ agentId, agentName: agent.name, agentEmoji: agent.emoji, content: response, round: r });
      log(`     ${agent.emoji} ${agent.name}: ${response.slice(0, 80)}...`);
      const firstSentence = response.match(/^.+?[.!?]/)?.[0] || response.slice(0, 100);
      appendConversationLog(agentId, agent.name + '(토론)', debatePrompt.slice(0, 100), response, firstSentence);
    }
  }

  // CEO 최종 결론
  log(`   🏢 CEO 결론 정리 중...`);
  const fullDebate = history.map(h => `**${h.agentEmoji} ${h.agentName}** (R${h.round}): ${h.content}`).join('\n\n---\n\n');
  const ceoMemory  = readAgentMemory('ceo');
  const ceoPrompt  = buildSystemPrompt(AGENTS[0].systemPrompt, 'ceo', companyCtx, ceoMemory);
  const synthesis  = await callLLM(ceoPrompt, [{
    role: 'user',
    content: `다음 팀 토론을 종합해서 실행 가능한 결론과 다음 단계를 제시해주세요.\n\n주제: ${topic}\n\n${fullDebate}`
  }]);

  log(`   🏢 CEO 결론: ${synthesis.slice(0, 100)}...`);
  return { history, synthesis };
}

// ─────────────────────────────────────────────────────────────
//  목표 달성 평가 (멀티라운드 마지막에 실행)
// ─────────────────────────────────────────────────────────────
async function evaluateGoalProgress(allRoundResults, companyCtx) {
  const resultsSummary = allRoundResults.map(r =>
    `[라운드 ${r.round}]\nCEO: ${r.ceoAnswer.slice(0, 300)}\n` +
    `에이전트: ${r.delegates.map(d => d.result.slice(0, 200)).join(' | ')}`
  ).join('\n\n');

  const goalsPath = path.join(CONFIG.BRAIN_DIR, 'company', 'goals.md');
  const goalsText = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '';
  const ceoMemory = readAgentMemory('ceo');
  const ceoPrompt = buildSystemPrompt(AGENTS[0].systemPrompt, 'ceo', companyCtx, ceoMemory);

  const evalPrompt =
    `## 현재 목표\n${goalsText}\n\n## 오늘 실행 결과\n${resultsSummary}\n\n` +
    `목표 달성 현황을 평가하고, 다음 사이클에서 집중해야 할 점 1~3가지를 간결하게 제시해주세요.`;

  try {
    const evaluation = await callLLM(ceoPrompt, [{ role: 'user', content: evalPrompt }]);
    log('\n📊 목표 진행 평가:');
    log('   ' + evaluation.slice(0, 200).replace(/\n/g, '\n   '));
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    appendAgentMemory('ceo', `[${ts}] 목표 진행 평가: ${evaluation.slice(0, 300)}`);
  } catch (err) {
    log(`   ❌ 평가 실패: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
//  라운드 브리핑 생성
// ─────────────────────────────────────────────────────────────
function buildRoundBriefing(baseBriefing, prevResults, currentRound) {
  if (currentRound === 1 || prevResults.length === 0) return baseBriefing;

  const prevSummary = prevResults.map(r => {
    const agentWork = r.delegates.map(d =>
      `  • ${d.agentEmoji} ${d.agentName}: ${d.result.slice(0, 300)}`).join('\n');
    return `### 라운드 ${r.round} 결과\n**CEO:** ${r.ceoAnswer.slice(0, 300)}\n**에이전트:**\n${agentWork}`;
  }).join('\n\n');

  return `${baseBriefing}\n\n## 이전 라운드 결과 (반드시 참고하고 더 발전시킬 것)\n${prevSummary}\n\n` +
    `라운드 ${currentRound}: 위 결과를 바탕으로 부족한 부분을 보완하거나 다음 단계로 나아가세요.`;
}

// ─────────────────────────────────────────────────────────────
//  이전 사이클 요약 읽기
// ─────────────────────────────────────────────────────────────
function readPreviousCycleSummary() {
  try {
    const reportsDir = path.join(CONFIG.WORKSPACE_DIR, 'reports');
    if (!fs.existsSync(reportsDir)) return '';
    const reports = fs.readdirSync(reportsDir)
      .filter(f => f.endsWith('_cycle_report.md')).sort().reverse();
    if (reports.length === 0) return '';
    return fs.readFileSync(path.join(reportsDir, reports[0]), 'utf8').slice(0, 1500);
  } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────
//  리포트 저장
// ─────────────────────────────────────────────────────────────
async function saveSessionReport(sessionNum, startTime, briefing, allRoundResults) {
  const stamp      = startTime.toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportDir  = path.join(CONFIG.WORKSPACE_DIR, 'reports');
  const reportPath = path.join(reportDir, `${stamp}_cycle_report.md`);
  fs.mkdirSync(reportDir, { recursive: true });

  const roundSections = allRoundResults.map(r => {
    const delegateSection = r.delegates.length > 0
      ? r.delegates.map(d => `#### ${d.agentEmoji} ${d.agentName}\n**작업:** ${d.task}\n\n${d.result.slice(0, 800)}`).join('\n\n---\n\n')
      : '위임 없이 CEO가 직접 처리';
    const debateSection  = r.debateResult
      ? `\n\n**팀 토론 결론:** ${r.debateResult.synthesis.slice(0, 400)}` : '';
    return `## 라운드 ${r.round}\n\n### CEO 분석\n${r.ceoAnswer}\n${debateSection}\n\n### 에이전트 작업\n${delegateSection}`;
  }).join('\n\n---\n\n');

  fs.writeFileSync(reportPath, `# 자율 사이클 리포트

**세션:** #${sessionNum} | **라운드:** ${CONFIG.ROUNDS} | **토론:** ${CONFIG.DEBATE_MODE ? 'ON' : 'OFF'}
**시작:** ${startTime.toLocaleString('ko-KR')} | **소요:** ${Math.round((Date.now() - startTime) / 1000)}초

## 브리핑
${briefing.slice(0, 500)}

${roundSections}

---
*생성: cycle.js 자율 실행*
`, 'utf8');

  return reportPath;
}

// ─────────────────────────────────────────────────────────────
//  LLM 호출 / 시스템 프롬프트 / Brain I/O / 태그 파싱
// ─────────────────────────────────────────────────────────────

// ★ LM Studio에 로드된 실제 모델 ID 자동 감지 ('local-model'은 400 유발)
async function ensureModel() {
  if (CONFIG.MODEL) return CONFIG.MODEL;
  try {
    const res = await fetch(CONFIG.MODELS_URL);
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id).filter(id => id && !/embed/i.test(id));
      if (ids.length > 0) CONFIG.MODEL = ids[0];
    }
  } catch { /* 미실행 시 다음 호출에서 재시도 */ }
  return CONFIG.MODEL || 'local-model';
}

async function callLLM(systemPrompt, messages) {
  const model      = await ensureModel();
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);
  try {
    const response = await fetch(CONFIG.LM_STUDIO_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model, temperature: 0.7, stream: false,
        messages: [{ role: 'system', content: systemPrompt }, ...messages] })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`서버 오류 ${response.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
    }
    return ((await response.json()).choices[0]?.message?.content ?? '').trim();
  } finally { clearTimeout(timeoutId); }
}

function buildSystemPrompt(agentPrompt, agentId, companyCtx, agentMemory) {
  let p = agentPrompt;
  if (companyCtx)  p += '\n\n## 우리 회사 정보\n' + companyCtx;
  if (agentMemory) p += '\n\n## 내가 기억하는 것\n' + agentMemory;
  if (agentId === 'ceo') p += '\n\n' + CEO_DELEGATE_PROMPT;
  p += '\n\n' + ACTION_TAGS_PROMPT;
  return p;
}

function readCompanyContext() {
  try {
    const ip = path.join(CONFIG.BRAIN_DIR, 'company', 'identity.md');
    const gp = path.join(CONFIG.BRAIN_DIR, 'company', 'goals.md');
    if (!fs.existsSync(ip)) return null;
    let ctx = fs.readFileSync(ip, 'utf8').slice(0, 1200);
    if (fs.existsSync(gp)) ctx += '\n\n' + fs.readFileSync(gp, 'utf8').slice(0, 1200);
    return ctx.trim();
  } catch { return null; }
}
function readAgentMemory(id) {
  try {
    const mp = path.join(CONFIG.BRAIN_DIR, 'agents', id, 'memory.md');
    return fs.existsSync(mp) ? fs.readFileSync(mp, 'utf8').slice(-2000).trim() : '';
  } catch { return ''; }
}
function appendConversationLog(agentId, agentName, userText, aiText, summary) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const lp    = path.join(CONFIG.BRAIN_DIR, 'conversations', today + '.md');
    const time  = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const lines = [`\n## [${time}] ${agentName}`, ''];
    // ★ 작업 요약(한 문장) — 대시보드 '오늘 활동'에 표시됨
    if (summary) { lines.push(`**요약:** ${summary.slice(0, 200)}`, ''); }
    lines.push(
      `**지시:** ${userText.slice(0, 200)}`,
      '',
      `**${agentName}:** ${aiText.slice(0, 600)}`,
      '',
      '---'
    );
    const entry = lines.join('\n');
    if (!fs.existsSync(lp)) fs.writeFileSync(lp, `# 대화 로그 — ${today}\n${entry}`, 'utf8');
    else fs.appendFileSync(lp, entry, 'utf8');
  } catch { /* 무시 */ }
}
function appendAgentMemory(id, content) {
  try {
    const mp  = path.join(CONFIG.BRAIN_DIR, 'agents', id, 'memory.md');
    const old = fs.existsSync(mp) ? fs.readFileSync(mp, 'utf8') : '';
    fs.writeFileSync(mp, old.trimEnd() + '\n\n' + content + '\n', 'utf8');
  } catch { /* 무시 */ }
}
async function extractAndSaveMemory(agentId, userText, aiText) {
  try {
    const response = await fetch(CONFIG.LM_STUDIO_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: await ensureModel(), temperature: 0.1, max_tokens: 100, stream: false,
        messages: [
          { role: 'system', content: '다음 대화에서 기억할 중요한 사실·결정을 1~2줄로 요약하세요. 없으면 "없음"만 반환하세요.' },
          { role: 'user', content: `지시: ${userText.slice(0,200)}\n결과: ${aiText.slice(0,300)}` }
        ] })
    });
    const memory = ((await response.json()).choices[0]?.message?.content ?? '').trim();
    if (memory && memory !== '없음' && memory.length > 5) {
      const ts = new Date().toISOString().slice(0,16).replace('T',' ');
      appendAgentMemory(agentId, `[${ts}] ${memory}`);
    }
  } catch { /* 무시 */ }
}

function parseDelegateTags(text) {
  const found = []; const r = /<delegate\s+agent="([^"]+)"\s+task="([^"]+)"\s*\/>/g; let m;
  while ((m = r.exec(text)) !== null) {
    const id = m[1].trim();
    if (AGENT_MAP.has(id) && id !== 'ceo') found.push({ agent: id, task: m[2].trim() });
  }
  return found;
}
function stripDelegateTags(t) { return t.replace(/<delegate\s+[^>]*\/>/g,'').replace(/\n{3,}/g,'\n\n').trim(); }
function parseActionTags(text) {
  const found = [];
  function scan(re, fn) { const r=new RegExp(re.source,re.flags); let m; while((m=r.exec(text))!==null) found.push({index:m.index,action:fn(m)}); }
  scan(/<create_file\s+path="([^"]+)">([\s\S]*?)<\/create_file>/g, m=>({type:'create_file',path:m[1],content:m[2]}));
  scan(/<run_command>([\s\S]*?)<\/run_command>/g, m=>({type:'run_command',command:m[1].trim()}));
  found.sort((a,b)=>a.index-b.index); return found.map(f=>f.action);
}
function stripActionTags(t) {
  return t.replace(/<create_file[^>]*>[\s\S]*?<\/create_file>/g,'')
          .replace(/<run_command>[\s\S]*?<\/run_command>/g,'')
          .replace(/\n{3,}/g,'\n\n').trim();
}
async function executeAction(action) {
  if (action.type === 'create_file') {
    const full = safePath(action.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, action.content, 'utf8');
    return { type: 'create_file', path: action.path };
  }
  if (action.type === 'run_command') {
    return await new Promise(resolve => exec(action.command, { cwd: CONFIG.WORKSPACE_DIR, encoding: 'utf8', timeout: 30_000 },
      (e,o,r) => resolve({ type:'run_command', command:action.command, output:(o+r).slice(0,2000), isError:!!e })));
  }
  throw new Error('알 수 없는 액션: ' + action.type);
}
function safePath(relPath) {
  const full = path.resolve(CONFIG.WORKSPACE_DIR, relPath);
  if (!full.startsWith(CONFIG.WORKSPACE_DIR)) throw new Error('보안: 워크스페이스 외부 차단');
  return full;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) {
  const t = new Date().toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  console.log(`[${t}] ${msg}`);
}

main().catch(err => { console.error('\n❌ 오류:', err.message); process.exit(1); });
