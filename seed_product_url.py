#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
'카페24 상품명 이지어드민 상품명 매칭.xlsx' → Supabase public.product_url 시딩.
- ez_name(이지어드민 상품명)을 PK로 업서트.
- URL의 product_no를 추출해 브랜드 URL(https://ozkiz.com/product/detail.html?product_no=N)로 통일.
- 먼저 migrations/003_create_product_url.sql 을 Supabase SQL 에디터에서 실행해 테이블을 만들어 둘 것.
재실행 안전(merge-duplicates 업서트).
"""
import re, json, math, urllib.request
import pandas as pd

SB_URL = 'https://baucagnqmtmaqlybjyzc.supabase.co'
SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhdWNhZ25xbXRtYXFseWJqeXpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MTU5MjksImV4cCI6MjA5NTM5MTkyOX0.dSqKeeb52GqM2pkegadLhBiBzzqmcZ1vAVm5aBvr0pA'
HEADERS = {
    'apikey': SB_KEY,
    'Authorization': f'Bearer {SB_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=minimal',
}

def clean(v):
    if v is None: return None
    if isinstance(v, float) and math.isnan(v): return None
    s = str(v).strip()
    return s if s and s.lower() != 'nan' else None

df = pd.read_excel('카페24 상품명 이지어드민 상품명 매칭.xlsx', dtype=str)
df.columns = ['pcode', 'ez_name', 'cafe24_name', 'url']

rows, seen = [], set()
for _, r in df.iterrows():
    ez = clean(r['ez_name'])
    if not ez or ez in seen:   # ez_name이 PK라 중복 제거
        continue
    seen.add(ez)
    raw_url = clean(r['url'])
    product_no = None
    url = None
    if raw_url:
        m = re.search(r'product_no=(\d+)', raw_url)
        if m:
            product_no = int(m.group(1))
            url = f'https://ozkiz.com/product/detail.html?product_no={product_no}'
    rows.append({
        'ez_name': ez,
        'pcode': clean(r['pcode']),
        'product_no': product_no,
        'cafe24_name': clean(r['cafe24_name']),
        'url': url,
        'source': 'excel',
    })

with_url = sum(1 for x in rows if x['url'])
print(f'업서트 대상: {len(rows)}행 (URL 있음 {with_url} / 없음 {len(rows)-with_url})')

CHUNK = 500
for i in range(0, len(rows), CHUNK):
    chunk = rows[i:i+CHUNK]
    body = json.dumps(chunk, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(f'{SB_URL}/rest/v1/product_url', data=body, headers=HEADERS, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(f'  {i+len(chunk)}/{len(rows)} OK ({resp.status})')
    except urllib.error.HTTPError as e:
        print(f'  ERROR {e.code}: {e.read().decode("utf-8", "replace")[:300]}')
        break
print('완료')
