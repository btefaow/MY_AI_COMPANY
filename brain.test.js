// ============================================================
//  brain.test.js — brain.js 자동 테스트 (첫 번째)
//
//  실행: npm test
//  jest가 이 파일(*.test.js)을 자동으로 찾아 실행합니다.
//
//  읽는 법:
//   describe(...) = 관련된 테스트 묶음 (제목)
//   test(...)     = 검산 1개
//   expect(A).toBe(B) = "A가 B와 같아야 한다"는 검산 규칙
// ============================================================

const brain = require('./brain.js');

describe('weightedProgress — 가중 평균 진행률 계산', () => {

  test('80%, 40% 두 목표(가중치 동일) → 평균 60%', () => {
    const children = [
      { progress: 80, weight: 0.5 },
      { progress: 40, weight: 0.5 },
    ];
    expect(brain.weightedProgress(children)).toBe(60);
  });

  test('가중치가 다르면 비중대로 반영 (80%×0.6 + 40%×0.4 = 64%)', () => {
    const children = [
      { progress: 80, weight: 0.6 },
      { progress: 40, weight: 0.4 },
    ];
    expect(brain.weightedProgress(children)).toBe(64);
  });

  test('자식이 없으면 0% 반환', () => {
    expect(brain.weightedProgress([])).toBe(0);
  });

  test('결과는 정수로 반올림된다 (33.33... → 33)', () => {
    const children = [
      { progress: 100, weight: 1 },
      { progress: 0,   weight: 2 },
    ]; // (100×1 + 0×2) / 3 = 33.33...
    expect(brain.weightedProgress(children)).toBe(33);
  });

});
