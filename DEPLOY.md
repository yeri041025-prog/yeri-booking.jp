# 규칙·사이트 자동 배포 (복붙 없이)

## 방법 A. 더블클릭 한 번 (가장 쉬움, 맥)
1. 한 번만 준비: Node.js 설치 (https://nodejs.org 에서 LTS)
2. 터미널에서 한 번만 로그인
   - `npx firebase-tools login`  (브라우저에서 구글 로그인: yeri041025@gmail.com)
   - `npx netlify-cli login` 후 `npx netlify-cli link` 에서 yerisclassbook 사이트 선택
3. 이후에는 이 폴더의 **deploy.command** 를 더블클릭하면 규칙 게시와 사이트 배포가 한 번에 끝납니다.
   (처음 한 번은 "확인되지 않은 개발자" 경고가 뜨면 우클릭 → 열기)

## 방법 B. 파일을 올리기만 하면 자동 (GitHub 연결)
1. GitHub 에 이 폴더를 저장소로 올립니다.
2. 저장소 Settings → Secrets and variables → Actions 에 3개를 넣습니다.
   - FIREBASE_SERVICE_ACCOUNT: Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성 → 받은 JSON 파일 내용 전체
   - NETLIFY_AUTH_TOKEN: Netlify → User settings → Applications → Personal access tokens
   - NETLIFY_SITE_ID: Netlify 사이트 → Site configuration → Site ID
3. 이후 main 브랜치에 올라오면 규칙과 사이트가 자동 배포됩니다. (.github/workflows/deploy.yml)
   서비스 계정 키는 프로젝트를 바꿀 수 있는 열쇠라서 GitHub Secrets 외에는 어디에도 붙여넣지 마세요.

## 사진·PDF 읽기 켜기 (처음 한 번)
관리자 페이지의 시간표/수강생 업로드에 사진이나 PDF를 올리면 AI가 읽어서 같은 미리보기로 보여줍니다. 켜려면:
1. https://console.anthropic.com 에서 가입하고, Billing 에서 결제 수단(크레딧)을 넣고, **API Keys** 에서 키를 하나 만듭니다. (월 지출 한도도 Limits 에서 걸어두세요)
2. 이 폴더의 **deploy-ai.command** 를 더블클릭 → 키를 붙여넣고 엔터 → 나머지는 자동입니다. (위의 방법 A 준비가 끝나 있어야 해요)
   키는 Firebase 서버 안에만 저장되고 사이트 파일이나 브라우저에는 들어가지 않습니다.
- 관리자 계정으로 로그인한 경우에만 쓸 수 있고, 하루 30회로 제한됩니다. (functions/index.js 의 DAILY_LIMIT)
- 사진은 Anthropic 의 AI 서비스로 전송됩니다. 개인정보가 많은 장부 사진은 필요한 부분만 잘라서 올리세요.
