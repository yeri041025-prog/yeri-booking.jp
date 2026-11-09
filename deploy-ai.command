#!/bin/bash
# 사진·PDF 읽기 기능을 켭니다. (처음 한 번, 그리고 functions 폴더를 고쳤을 때만)
cd "$(dirname "$0")"
echo "== 1/3 AI 키 저장 (붙여넣고 엔터. 화면에는 보이지 않아요) =="
npx --yes firebase-tools@13 functions:secrets:set ANTHROPIC_API_KEY --project yeris-class-book || { read -p "실패. 엔터를 누르면 닫힙니다"; exit 1; }
echo "== 2/3 필요한 파일 설치 =="
npm --prefix functions install || { read -p "실패. 엔터를 누르면 닫힙니다"; exit 1; }
echo "== 3/3 서버 기능 배포 (처음엔 몇 분 걸리고, 필요한 구글 서비스를 켜도 되냐고 물으면 Y) =="
npx --yes firebase-tools@13 deploy --only functions --project yeris-class-book || { read -p "실패. 엔터를 누르면 닫힙니다"; exit 1; }
echo "끝났습니다. 관리자 페이지에서 사진을 올려 시험해보세요."
read -p "엔터를 누르면 닫힙니다"
