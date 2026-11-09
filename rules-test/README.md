# 보안 규칙 + 동시 접속 시험 (내 컴퓨터에서 실행)

실제 Firebase에 접속하지 않고, 내 컴퓨터 안에서 Firebase 에뮬레이터로 `../firestore.rules` 를 그대로 실행합니다. 운영 데이터는 건드리지 않습니다.

## 준비 (한 번만)
1. 자바 설치: 터미널에 `brew install --cask temurin` (또는 https://adoptium.net 에서 설치)
2. Node.js 18 이상 (`node -v` 로 확인)

## 실행
```
cd rules-test
npm install
npm test
```
끝에 `NN passed, 0 failed` 가 나오면 규칙과 동시 접속(200명) 시험이 모두 통과한 것입니다.
FAIL 줄이 나오면 그 줄 전체를 복사해서 보내주세요.
