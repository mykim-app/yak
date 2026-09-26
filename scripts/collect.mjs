// 식약처 「의약품 제품 허가정보」 API 전체를 받아 검색용 색인(data/drugs.json)을 만든다.
// 주성분 API는 성분명으로 검색하는 기능이 없어서, 전체를 미리 받아 두고 화면에서 찾는 방식을 쓴다.
// 실행: DATA_GO_KR_KEY=발급받은_인증키 node scripts/collect.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const KEY = process.env.DATA_GO_KR_KEY;
const BASE = process.env.API_BASE || 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService07';
const ROWS = 100;          // 한 번에 받을 수 있는 최대 건수
const PAUSE_MS = 150;      // 초당 호출 제한을 피하기 위한 간격
const KEEP_CANCELLED = process.env.KEEP_CANCELLED === '1';

if (!KEY) {
  console.error('DATA_GO_KR_KEY 환경변수가 없습니다. 공공데이터포털 인증키(Decoding)를 넣어 주세요.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (o, ...names) => {
  for (const n of names) if (o[n] != null && String(o[n]).trim() !== '') return String(o[n]).trim();
  return '';
};

// 인증키가 Encoding 키(%가 들어 있음)이면 그대로, Decoding 키이면 인코딩해서 붙인다.
const keyParam = KEY.includes('%') ? KEY : encodeURIComponent(KEY);

async function fetchPage(op, pageNo) {
  const url = `${BASE}/${op}?serviceKey=${keyParam}&type=json&numOfRows=${ROWS}&pageNo=${pageNo}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`JSON 아님: ${text.slice(0, 200)}`); }
      const err = json?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (err) {
        const fatal = ['SERVICE_KEY_IS_NOT_REGISTERED_ERROR', 'SERVICE_ACCESS_DENIED_ERROR',
          'DEADLINE_HAS_EXPIRED_ERROR', 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR'];
        if (fatal.includes(err.errMsg)) {
          console.error(`API 오류(재시도하지 않음): ${err.errMsg} ${err.returnAuthMsg || ''}`);
          process.exit(1);
        }
        throw new Error(`${err.errMsg} ${err.returnAuthMsg || ''}`);
      }
      const code = json?.header?.resultCode;
      if (code && code !== '00') throw new Error(`resultCode ${code} ${json?.header?.resultMsg || ''}`);
      const body = json.body || {};
      let items = body.items ?? [];
      if (!Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
      return { total: Number(body.totalCount || 0), items };
    } catch (e) {
      console.warn(`  ${op} ${pageNo}쪽 실패(${attempt}/5): ${e.message}`);
      await sleep(1000 * attempt * attempt);
    }
  }
  throw new Error(`${op} ${pageNo}쪽을 끝내 받지 못했습니다.`);
}

async function fetchAll(op, label) {
  const first = await fetchPage(op, 1);
  const pages = Math.ceil(first.total / ROWS);
  console.log(`[${label}] 전체 ${first.total.toLocaleString()}건, ${pages}쪽`);
  if (first.items[0]) console.log(`[${label}] 항목 이름: ${Object.keys(first.items[0]).join(', ')}`);
  const all = [...first.items];
  for (let p = 2; p <= pages; p++) {
    await sleep(PAUSE_MS);
    const { items } = await fetchPage(op, p);
    all.push(...items);
    if (p % 100 === 0) console.log(`  ${p}/${pages}쪽`);
  }
  // 누락 확인: 받은 건수가 전체 건수와 1% 넘게 차이 나면 중단한다(기존 자료를 망가뜨리지 않도록).
  if (Math.abs(all.length - first.total) > first.total * 0.01) {
    throw new Error(`[${label}] 받은 건수 ${all.length}건이 전체 ${first.total}건과 맞지 않습니다.`);
  }
  return all;
}

function normQnt(q) {
  const s = String(q ?? '').trim().replace(/,/g, '');
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : s;
}

async function main() {
  const t0 = Date.now();
  const list = await fetchAll('getDrugPrdtPrmsnInq07', '제품 목록');
  const mcpn = await fetchAll('getDrugPrdtMcpnDtlInq07', '주성분');

  // 1) 제품 정보 정리
  const products = new Map(); // ITEM_SEQ → 정보
  let cancelled = 0;
  for (const it of list) {
    const seq = pick(it, 'ITEM_SEQ');
    if (!seq) continue;
    const cancelName = pick(it, 'CANCEL_NAME');
    const isCancelled = cancelName !== '' && cancelName !== '정상';
    if (isCancelled) cancelled++;
    const kind = pick(it, 'SPCLTY_PBLC', 'ETC_OTC_CODE', 'ETC_OTC_NAME');
    products.set(seq, {
      name: pick(it, 'ITEM_NAME'),
      company: pick(it, 'ENTP_NAME'),
      date: pick(it, 'ITEM_PERMIT_DATE').replace(/\D/g, '').slice(0, 8),
      kind: kind.includes('전문') ? 1 : kind.includes('일반') ? 2 : 0,
      cancelled: isCancelled,
    });
  }
  if (products.size === 0) throw new Error('제품 목록이 비어 있습니다. 항목 이름(ITEM_SEQ 등)을 확인해 주세요.');

  // 2) 성분 정리 (같은 성분이 총량 순번 때문에 여러 줄 나오는 경우는 하나로 합친다)
  const ingIndex = new Map(); const ingList = [];
  const unitIndex = new Map(); const unitList = [];
  const comp = new Map(); // ITEM_SEQ → Set("성분번호:함량:단위번호")
  for (const r of mcpn) {
    const seq = pick(r, 'ITEM_SEQ');
    const name = pick(r, 'MTRAL_NM');
    const code = pick(r, 'MTRAL_CODE') || name;
    if (!seq || !code) continue;
    if (!ingIndex.has(code)) { ingIndex.set(code, ingList.length); ingList.push([code, name]); }
    const unit = pick(r, 'INGD_UNIT_CD');
    if (!unitIndex.has(unit)) { unitIndex.set(unit, unitList.length); unitList.push(unit); }
    if (!comp.has(seq)) comp.set(seq, new Set());
    comp.get(seq).add(`${ingIndex.get(code)}:${normQnt(pick(r, 'QNT'))}:${unitIndex.get(unit)}`);
    // 목록에 없는 제품은 주성분 쪽 이름으로 채운다.
    if (!products.has(seq)) {
      products.set(seq, { name: pick(r, 'PRDUCT', 'ITEM_NAME'), company: pick(r, 'ENTRPS', 'ENTP_NAME'),
        date: '', kind: 0, cancelled: false });
    }
  }

  // 3) 색인 만들기: 성분 정보가 있는 제품만, 기본은 취소·취하 제품 제외
  const p = []; const c = [];
  for (const [seq, info] of products) {
    const set = comp.get(seq);
    if (!set || set.size === 0) continue;
    if (info.cancelled && !KEEP_CANCELLED) continue;
    const key = [...set].sort((a, b) => {
      const [ai, aq] = a.split(':'); const [bi, bq] = b.split(':');
      return (+ai - +bi) || aq.localeCompare(bq);
    }).join(';');
    p.push([seq, info.name, info.company, info.date, info.kind]);
    c.push(key);
  }

  const out = { v: 1, updated: new Date().toISOString(), ing: ingList, units: unitList, p, c };
  await mkdir('data', { recursive: true });
  await writeFile('data/drugs.json', JSON.stringify(out));
  await writeFile('data/meta.json', JSON.stringify({
    updated: out.updated, products: p.length, ingredients: ingList.length,
    sourceList: list.length, sourceIngredientRows: mcpn.length, cancelledExcluded: KEEP_CANCELLED ? 0 : cancelled,
  }, null, 2));
  console.log(`완료: 제품 ${p.length.toLocaleString()}개, 성분 ${ingList.length.toLocaleString()}종, ${((Date.now() - t0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
