# ============================================================
#  schedule_setup.ps1 — Windows 작업 스케줄러 등록
#
#  실행 방법 (PowerShell 관리자 권한):
#    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#    .\schedule_setup.ps1
#
#  이 스크립트가 하는 일:
#   - 매일 오전 9시에 cycle.js 를 자동 실행하는 예약 작업 등록
#   - LM Studio 서버가 켜져 있어야 실행됩니다
# ============================================================

$TaskName    = "MyAICompany_DailyCycle"
$ScriptPath  = "$PSScriptRoot\cycle.js"
$NodePath    = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $NodePath) {
    Write-Host "❌ Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 설치하세요." -ForegroundColor Red
    exit 1
}

Write-Host "✅ Node.js 경로: $NodePath" -ForegroundColor Green
Write-Host "✅ 스크립트 경로: $ScriptPath" -ForegroundColor Green

# 기존 작업이 있으면 삭제
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "🔄 기존 작업 삭제됨" -ForegroundColor Yellow
}

# 30분마다 반복 트리거 (오전 9시부터 시작)
$Trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 30) `
           -Once -At "09:00"

# node cycle.js --loop (30분 간격 루프 모드로 실행)
$Action  = New-ScheduledTaskAction -Execute $NodePath -Argument "$ScriptPath --loop" -WorkingDirectory $PSScriptRoot

# 현재 사용자 권한으로 실행 (로그인 여부 무관)
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit  (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable  `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName  $TaskName `
    -Trigger   $Trigger `
    -Action    $Action `
    -Settings  $Settings `
    -RunLevel  Highest `
    -Force | Out-Null

Write-Host ""
Write-Host "✅ 작업 스케줄러 등록 완료!" -ForegroundColor Green
Write-Host "   작업 이름: $TaskName"
Write-Host "   실행 시간: 매일 오전 9:00"
Write-Host "   스크립트:  $ScriptPath"
Write-Host ""
Write-Host "지금 바로 테스트하려면:" -ForegroundColor Cyan
Write-Host "   node `"$ScriptPath`""
Write-Host ""
Write-Host "작업 스케줄러에서 확인하려면:" -ForegroundColor Cyan
Write-Host "   시작 메뉴 → '작업 스케줄러' 검색 → 작업 스케줄러 라이브러리"
