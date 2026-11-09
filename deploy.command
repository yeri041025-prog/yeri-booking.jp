#!/bin/bash
# 더블클릭하면 규칙 게시 + 사이트 배포를 한 번에 합니다. (맥 전용, 처음 한 번만 로그인)
cd "$(dirname "$0")"
echo "== 1/2 Firestore 보안 규칙 게시 =="
npx --yes firebase-tools@13 deploy --only firestore:rules --project yeris-class-book || { echo "규칙 게시 실패"; read -p "엔터를 누르면 닫힙니다"; exit 1; }
echo "== 2/2 사이트 배포 =="
npx --yes netlify-cli@17 deploy --dir=site --prod || { echo "사이트 배포 실패"; read -p "엔터를 누르면 닫힙니다"; exit 1; }
echo "끝났습니다."
read -p "엔터를 누르면 닫힙니다"
