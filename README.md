# 약 이름으로 성분·카피약 찾기

제품 이름(예: 타이레놀)을 넣으면 주성분·함량과, 주성분과 함량이 같은 다른 제품(카피약) 목록을 보여 주는 페이지입니다.

## 동작 방식

- 식약처 「의약품 제품 허가정보」 API는 **성분 이름으로 제품을 찾는 기능이 없습니다.** 그래서 GitHub Actions가 매주 한 번 전체 자료를 받아 `data/drugs.json`으로 저장하고, 페이지는 이 파일 안에서 바로 찾습니다.
- 인증키는 GitHub 비밀값(Secret)에만 저장되고 페이지에는 드러나지 않습니다. 별도 서버(Supabase 등)는 필요 없습니다.
- 취소·취하된 제품은 뺍니다.

## 처음 설정 순서

1. **인증키 받기**: 공공데이터포털(data.go.kr)에서 `식품의약품안전처_의약품 제품 허가정보` 활용신청 → 개발계정은 자동 승인(하루 10,000회). 마이페이지에서 **일반 인증키(Decoding)** 를 복사합니다. 발급 직후에는 1~2시간 동안 "등록되지 않은 서비스키" 오류가 날 수 있습니다.
2. **저장소 만들기**: GitHub에 새 공개 저장소(`mykim-app/yak`)를 만들고 이 폴더의 파일을 모두 올립니다. `.github` 폴더가 빠지지 않게 주의합니다.
3. **인증키 등록**: 저장소 Settings → Secrets and variables → Actions → New repository secret
   - 이름: `DATA_GO_KR_KEY`
   - 값: 1번에서 복사한 인증키
4. **자료 받기(처음 한 번)**: Actions 탭 → "의약품 자료 갱신" → Run workflow. 10~20분 정도 걸립니다. 끝나면 `data/drugs.json`이 자동으로 올라옵니다.
   - 실패하면서 권한 오류가 나오면 Settings → Actions → General → Workflow permissions를 "Read and write permissions"로 바꿉니다.
5. **게시**: Settings → Pages → Source를 "Deploy from a branch", Branch를 `main` / `(root)`로 지정합니다. 주소는 `https://mykim-app.github.io/yak/` 입니다.

이후에는 매주 월요일 새벽 3시(한국시간)에 자동으로 갱신됩니다.

## 호출량

한 번 갱신할 때 주성분 약 1,300회, 제품 목록 수백~천여 회를 호출합니다. 개발계정 한도(하루 10,000회) 안에 들어갑니다.

## 파일

| 파일 | 역할 |
|---|---|
| `index.html` | 조회 화면 |
| `scripts/collect.mjs` | 식약처 API 전체 수집, 색인 생성 |
| `.github/workflows/update-data.yml` | 매주 자동 갱신 |
| `data/drugs.json` | 검색용 자료(자동 생성) |
| `data/meta.json` | 갱신일·건수(자동 생성) |

## 같은 약으로 묶는 기준

- **같은 성분·같은 함량**: 주성분 코드와 함량·단위가 모두 같은 제품
- **같은 성분·다른 함량**: 주성분 구성은 같고 함량만 다른 제품
- 제형(정제·주사 등)은 기준에 들어가지 않으므로 제품명으로 확인해야 합니다. 같은 성분이라도 염(예: 베실산염·캄실산염)이 다르면 다른 성분으로 봅니다.
