// 식약처 「의약품 제품 허가정보」 API 전체를 받아 검색용 색인(data/drugs.json)을 만든다.
// 주성분 API는 성분명으로 검색하는 기능이 없어서, 전체를 미리 받아 두고 화면에서 찾는 방식을 쓴다.
// 실행: DATA_GO_KR_KEY=발급받은_인증키 node scripts/collect.mjs
import { writeFile, mkdir, rm } from 'node:fs/promises';

// 붙여 넣을 때 섞여 들어간 앞뒤 공백·줄바꿈을 없앤다.
const KEY = (process.env.DATA_GO_KR_KEY || '').replace(/\s+/g, '');
const BASE = process.env.API_BASE || 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService08';
// e약은요: 일반의약품 가운데 실제 공급 실적이 있는 제품 목록 (활용신청을 따로 해야 함, 없으면 건너뜀)
const EASY_BASE = process.env.EASY_BASE || 'https://apis.data.go.kr/1471000/DrbEasyDrugInfoService';
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

class OptionalSkip extends Error {}

async function fetchPage(op, pageNo, base = BASE, optional = false, rows = ROWS, timeoutMs = 30000, tries = 5) {
  const url = `${base}/${op}?serviceKey=${keyParam}&type=json&numOfRows=${rows}&pageNo=${pageNo}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error(`JSON 아님: ${text.slice(0, 200)}`); }
      const err = json?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (err) {
        const fatal = ['SERVICE_KEY_IS_NOT_REGISTERED_ERROR', 'SERVICE_ACCESS_DENIED_ERROR',
          'DEADLINE_HAS_EXPIRED_ERROR', 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR'];
        if (fatal.includes(err.errMsg)) {
          if (optional) throw new OptionalSkip(err.errMsg);
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
      if (e instanceof OptionalSkip) throw e;
      console.warn(`  ${op} ${pageNo}쪽 실패(${attempt}/${tries}): ${e.message}`);
      await sleep(1000 * attempt * attempt);
    }
  }
  throw new Error(`${op} ${pageNo}쪽을 끝내 받지 못했습니다.`);
}

async function fetchAll(op, label, base = BASE, optional = false) {
  const first = await fetchPage(op, 1, base, optional);
  const pages = Math.ceil(first.total / ROWS);
  console.log(`[${label}] 전체 ${first.total.toLocaleString()}건, ${pages}쪽`);
  if (first.items[0]) console.log(`[${label}] 항목 이름: ${Object.keys(first.items[0]).join(', ')}`);
  const all = [...first.items];
  for (let p = 2; p <= pages; p++) {
    await sleep(PAUSE_MS);
    const { items } = await fetchPage(op, p, base, optional);
    all.push(...items);
    if (p % 100 === 0) console.log(`  ${p}/${pages}쪽`);
  }
  // 누락 확인: 받은 건수가 전체 건수와 1% 넘게 차이 나면 중단한다(기존 자료를 망가뜨리지 않도록).
  if (Math.abs(all.length - first.total) > first.total * 0.01) {
    throw new Error(`[${label}] 받은 건수 ${all.length}건이 전체 ${first.total}건과 맞지 않습니다.`);
  }
  return all;
}

// ── 효능·부작용 요약용 ──
const ENT = { nbsp: ' ', lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", middot: '·' };
const unesc = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const clean = (t) => unesc(String(t || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const cdata = (xml) => [...String(xml || '').matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => clean(m[1])).filter(Boolean);
const articles = (xml) => [...String(xml || '').matchAll(/<ARTICLE title="([^"]*)"[^>]*>([\s\S]*?)<\/ARTICLE>/g)]
  .map((m) => ({ title: clean(m[1]), paras: cdata(m[2]) }));
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
function shorten(t, n) {
  t = squash(t);
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다.'), cut.lastIndexOf(', '));
  return (at > n * 0.5 ? cut.slice(0, at + 1) : cut).trim() + '…';
}
// ── 짧게 줄이기 ──
// 임상시험 설명·통계 문장은 부작용 목록이 아니므로 뺀다.
const META = /임상\s*시험|명의?\s*환자|환자(의|들|에게|에서)|\bn\s*=|투여하였|투여 ?받|위약|대조군|발생률|발생빈도|빈도의 정의|시판\s*후|조사|분석|평가|인과관계|보고되었|관찰되었|나타내었|%/;
const FREQ = /^(매우\s*드물게|매우\s*흔하게|드물게|때때로|자주|흔하게|흔히|간혹|가끔|빈도\s*불명)\s*[:：]?\s*/;
function listItems(txt) {
  return String(txt).replace(/\([^)]*\)|\[[^\]]*\]/g, '').split(/[,，、ㆍ]|\s및\s|\s또는\s|\s(?=(?:매우\s*)?(?:드물게|때때로|자주|흔하게|간혹)\s)/)
    .map((x) => x.trim().replace(FREQ, '').replace(/\s*등(의|이|과|을)?(\s.*)?$/, '').replace(/\s*이\s*(나타날|있을|보고).*$/, '').replace(/[.。\-–\s]+$/, '').trim())
    .filter((x) => x && x !== '매우' && x.length <= 14 && !/[:：;]/.test(x) && !META.test(x) && !/[0-9]{2,}/.test(x) && !/(며|고|다|음|함|됨|것)$/.test(x));
}
function uniq(a) { return [...new Set(a)]; }
// 부작용 문단들 → "소화기계: 구역, 설사 / 신경계: 두통" 또는 "흔한 부작용: …"
function summarizeSE(paras) {
  const text = squash(paras.join(' '));
  if (!text) return '';
  const common = text.match(/(?:가장\s*)?흔(?:한|하게\s*(?:보고된|나타난|발생한))\s*이상반응\s*(?:\([^)]*\)\s*)?(?:은|으로는|으로)\s*([^.]{4,220}?)(?:이었다|였다|이다|이었으며|였으며|으로|등)/);
  if (common) { const it = uniq(listItems(common[1])); if (it.length >= 2) return `흔한 부작용: ${it.slice(0, 6).join(', ')}`; }
  const groups = [];
  for (const seg of text.split(/\s(?=\d+\)\s)|\s(?=\(\d+\)\s)|\s(?=[•·]\s)|\s(?=(?:[가-힣·]{1,10}계|피부|전신|눈|귀|과민증|감염)\s*[:：])/)) {
    const m = seg.replace(/^(\d+\)|\(\d+\)|[•·])\s*/, '').match(/^([가-힣·\s]{1,12}?)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const label = m[1].trim();
    if (!/(계|피부|전신|눈|귀|기타|과민증|감각기|감염)$/.test(label) || META.test(label)) continue;
    const it = uniq(listItems(m[2])).slice(0, 4);
    if (it.length) groups.push(`${label}: ${it.join(', ')}`);
    if (groups.length >= 4) break;
  }
  if (groups.length) return groups.join(' / ');
  // "…에서 일어난 다른 이상반응 : 관절통, 천식, …" 형태
  const other = [...text.matchAll(/이상반응\s*[:：]\s*([^:：]{4,200})/g)].flatMap((m) => listItems(m[1]));
  if (other.length >= 2) return `보고된 부작용: ${uniq(other).slice(0, 7).join(', ')}`;
  // 마지막 수단: 증상이 쉼표로 나열된 짧은 문장
  const sent = text.split(/(?<=다\.)\s+/).find((x) => !META.test(x) && x.length <= 160 && (x.match(/,/g) || []).length >= 2 && !/할 것|주의/.test(x));
  return sent || '';
}
// e약은요 문장: "…, …, … 등이 나타나는 경우 복용을 즉각 중지…" → 증상만
function summarizeEasySE(t) {
  t = squash(t);
  const m = t.match(/^(.*?)(?:\s*등(?:의)?\s*(?:이|의\s*증상이)?\s*(?:나타나|나타날|생길|있을)|이\s*나타나는\s*경우)/);
  if (m) { const it = uniq(listItems(m[1])); if (it.length) return it.slice(0, 7).join(', ') + (it.length > 7 ? ' 등' : ''); }
  return shorten(t, 130);
}
const cleanEff = (t) => {
  t = squash(t).replace(/^[\s:：○●·•￮\-–]+/, '').replace(/\s[:：]\s/g, ' ').replace(/\s[￮○●•]\s?/g, ' ');
  const first = t.match(/^(.{8,140}?[^0-9]\.)\s/); // 첫 문장이 짧으면 그것만
  return first ? first[1] : shorten(t, 140);
};

// 허가사항 문서에서 효능과 주요 부작용을 짧게 뽑는다.
function fromPermitDoc(it) {
  const eff = cleanEff(cdata(it.EE_DOC_DATA).join(' '));
  const arts = articles(it.NB_DOC_DATA);
  let se = '';
  const adverse = arts.find((a) => /이상반응|부작용/.test(a.title));
  if (adverse) se = summarizeSE(adverse.paras);
  if (!se) {
    const stop = arts.find((a) => /(즉각|즉시)[^.]*중지/.test(a.title));
    if (stop) se = summarizeSE(stop.paras);
  }
  return [eff, shorten(se, 150)];
}
// 조합 번호 → 조각 파일 번호 (화면에서 같은 계산을 한다)
const SHARDS = 128;
const shardOf = (key) => { let h = 5381; for (const ch of key) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h % SHARDS; };

async function fetchEach(op, label, onItems, conc = 3) {
  const first = await fetchPage(op, 1);
  const pages = Math.ceil(first.total / ROWS);
  console.log(`[${label}] 전체 ${first.total.toLocaleString()}건, ${pages}쪽 (동시 ${conc}개)`);
  onItems(first.items);
  let next = 2, done = 1, skipped = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next <= pages) {
      const pg = next++;
      await sleep(PAUSE_MS);
      try {
        const { items } = await fetchPage(op, pg, BASE, false, ROWS, 90000, 3);
        onItems(items);
      } catch {
        // 문서가 큰 쪽은 20건씩 나눠 받는다. 그래도 안 되는 부분은 건너뛴다.
        const per = 20, sub = ROWS / per;
        for (let s = 1; s <= sub; s++) {
          try { const { items } = await fetchPage(op, (pg - 1) * sub + s, BASE, false, per, 90000, 3); onItems(items); }
          catch { skipped += per; console.warn(`  ${pg}쪽 일부(${per}건)를 건너뜁니다.`); }
        }
      }
      if (++done % 50 === 0) console.log(`  ${done}/${pages}쪽`);
    }
  }));
  if (skipped) console.warn(`[${label}] 받지 못한 ${skipped}건은 다음 갱신 때 다시 시도합니다.`);
}

function normQnt(q) {
  const s = String(q ?? '').trim().replace(/,/g, '');
  if (s === '') return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : s;
}

async function main() {
  const t0 = Date.now();
  const list = await fetchAll('getDrugPrdtPrmsnInq08', '제품 목록');
  const mcpn = await fetchAll('getDrugPrdtMcpnDtlInq08', '주성분');
  let supplied = null; // 공급 실적이 있는 일반의약품 품목번호
  const easyText = new Map(); // 품목번호 → [효능, 부작용] (쉬운 말)
  try {
    const easy = await fetchAll('getDrbEasyDrugList', 'e약은요(공급 실적 있는 일반의약품)', EASY_BASE, true);
    supplied = new Set(easy.map((it) => pick(it, 'itemSeq', 'ITEM_SEQ')).filter(Boolean));
    for (const it of easy) {
      const seq = pick(it, 'itemSeq', 'ITEM_SEQ');
      if (seq) easyText.set(seq, [cleanEff(pick(it, 'efcyQesitm')), summarizeEasySE(pick(it, 'seQesitm'))]);
    }
  } catch (e) {
    console.warn(`e약은요 자료를 받지 못해 일반의약품 유통 여부는 표시하지 않습니다(${e.message}). 공공데이터포털에서 '식품의약품안전처_의약품개요정보(e약은요)'를 활용신청하면 적용됩니다.`);
  }

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

  // 같은 성분이 함량 있는 줄과 빈 줄로 두 번 들어간 경우 빈 줄은 뺀다.
  for (const set of comp.values()) {
    const withQty = new Set([...set].filter((x) => x.split(':')[1] !== '').map((x) => x.split(':')[0]));
    for (const x of [...set]) { const [i, q] = x.split(':'); if (q === '' && withQty.has(i)) set.delete(x); }
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
    // 표시값: 1 = 수출용(국내 판매 안 함), 2 = 공급 실적 확인(e약은요에 있음)
    const flag = (/수출용/.test(info.name) ? 1 : 0) | (supplied && supplied.has(seq) ? 2 : 0);
    p.push([seq, info.name, info.company, info.date, info.kind, flag]);
    c.push(key);
  }

  // 4) 효능·부작용: 같은 성분 조합끼리 하나로 묶어 조각 파일로 저장
  const keyOf = new Map(p.map((row, k) => [row[0], c[k]]));
  const info = new Map(); // 조합 → [효능, 부작용, 출처(1=e약은요, 2=허가사항)]
  const put = (key, eff, se, src) => {
    if (!eff && !se) return;
    const cur = info.get(key);
    const score = (src === 1 ? 4 : 0) + (eff ? 2 : 0) + (se ? 1 : 0);
    if (!cur || score > cur[3]) info.set(key, [eff, se, src, score]);
  };
  for (const [seq, [eff, se]] of easyText) { const k = keyOf.get(seq); if (k) put(k, eff, se, 1); }
  if (process.env.SKIP_DETAIL !== '1') {
    try {
      await fetchEach('getDrugPrdtPrmsnDtlInq08', '허가사항(효능·주의사항)', (items) => {
        for (const it of items) {
          const k = keyOf.get(pick(it, 'ITEM_SEQ'));
          if (!k) continue;
          const [eff, se] = fromPermitDoc(it);
          put(k, eff, se, 2);
        }
      });
    } catch (e) {
      console.warn(`허가사항을 끝까지 받지 못했습니다(${e.message}). 받은 만큼만 저장합니다.`);
    }
  }
  await rm('data/info', { recursive: true, force: true });
  await mkdir('data/info', { recursive: true });
  const shards = Array.from({ length: SHARDS }, () => ({}));
  for (const [k, [eff, se, src]] of info) shards[shardOf(k)][k] = [eff, se, src];
  await Promise.all(shards.map((o, n) => writeFile(`data/info/${n}.json`, JSON.stringify(o))));
  console.log(`효능·부작용: 성분 조합 ${info.size.toLocaleString()}개`);

  const out = { v: 2, updated: new Date().toISOString(), otcSupply: !!supplied, ing: ingList, units: unitList, p, c };
  await mkdir('data', { recursive: true });
  await writeFile('data/drugs.json', JSON.stringify(out));
  await writeFile('data/meta.json', JSON.stringify({
    updated: out.updated, products: p.length, ingredients: ingList.length,
    sourceList: list.length, sourceIngredientRows: mcpn.length, cancelledExcluded: KEEP_CANCELLED ? 0 : cancelled, otcSupplied: supplied ? supplied.size : null, infoCombos: info.size,
  }, null, 2));
  console.log(`완료: 제품 ${p.length.toLocaleString()}개, 성분 ${ingList.length.toLocaleString()}종, ${((Date.now() - t0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
