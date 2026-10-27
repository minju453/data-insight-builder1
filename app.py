import os
import glob
import json
import logging
import math
import re
import numpy as np
import pandas as pd
from flask import Flask, render_template, jsonify, request
from dotenv import load_dotenv
from google import genai
from google.genai.errors import APIError

from tools import TOOL_CATALOG, clean_num

# .env 환경변수 로드
load_dotenv()

# 로깅 설정
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("startup-navigator")

# 기본 경로 설정 (Vercel 서버리스 환경 호환)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static")
)

# 전역 데이터 저장소
DATASETS = {}

def get_gemini_client():
    """Gemini API 클라이언트 생성"""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise ValueError("API Key 미설정: .env 파일에 GEMINI_API_KEY를 설정해 주세요.")
    return genai.Client(api_key=api_key)

def clean_value_for_json(val):
    """NaN, Inf, -Inf 값을 JSON 규격에 맞게 None(null)으로 변환"""
    if val is None:
        return None
    if isinstance(val, (float, np.floating)):
        if math.isnan(val) or math.isinf(val):
            return None
        return round(float(val), 4)
    if isinstance(val, (int, np.integer)):
        return int(val)
    if pd.isna(val):
        return None
    return val

def clean_record_for_json(records):
    """딕셔너리 리스트 내 모든 특수 부동소수점 값을 정리"""
    cleaned = []
    for row in records:
        cleaned_row = {}
        for k, v in row.items():
            cleaned_row[k] = clean_value_for_json(v)
        cleaned.append(cleaned_row)
    return cleaned

def load_csv_safely(file_path):
    """여러 인코딩을 시도하여 CSV 파일을 안전하게 DataFrame으로 로드"""
    encodings = ['utf-8-sig', 'cp949', 'euc-kr', 'utf-8']
    for enc in encodings:
        try:
            df = pd.read_csv(file_path, encoding=enc)
            df.columns = [str(c).strip() for c in df.columns]
            logger.info(f"Loaded {os.path.basename(file_path)} with encoding '{enc}' ({df.shape[0]} rows, {df.shape[1]} cols)")
            return df
        except UnicodeDecodeError:
            continue
        except Exception as e:
            logger.warning(f"Failed loading {file_path} with {enc}: {e}")
            continue
    raise ValueError(f"모든 인코딩 시도 실패: {file_path}")

def load_all_datasets():
    """서버 기동 시 data/ 폴더 내 정적 CSV 파일들을 전역 메모리에 1회 로드"""
    global DATASETS
    data_dir = os.path.join(BASE_DIR, 'data')
    if not os.path.exists(data_dir):
        logger.error(f"Data directory not found: {data_dir}")
        return

    csv_files = glob.glob(os.path.join(data_dir, "*.csv"))
    logger.info(f"Loading {len(csv_files)} CSV datasets from {data_dir}...")

    key_patterns = {
        'business_100': '100대',
        'national_census': '전국사업체조사',
        'business_gender': '사업자현황_성별',
        'pension_region': '시구신고',
        'pension_gender': '가입종별',
        'establishment_extinction': '성립 및 소멸',
        'commercial_district': '상권 현황',
        'startup_revenue': '매출액',
        'startup_cost': '창업비용',
        'startup_location': '입지 현황',
        'global_indicators': '주요경제지표'
    }

    for fpath in csv_files:
        fname = os.path.basename(fpath)
        try:
            df = load_csv_safely(fpath)
            matched_key = None
            for key, pattern in key_patterns.items():
                if pattern in fname:
                    matched_key = key
                    break
            if not matched_key:
                matched_key = os.path.splitext(fname)[0]

            DATASETS[matched_key] = df
            DATASETS[fname] = df
        except Exception as e:
            logger.error(f"Error loading {fname}: {e}")

    logger.info(f"Successfully loaded {len(DATASETS)} dataset references.")

# 전역 데이터 즉시 로드
load_all_datasets()

@app.route("/")
@app.route("/api/index")
@app.route("/api/index/")
def index():
    logger.info("Serving index.html")
    return render_template("index.html")

@app.route("/health", methods=["GET"])
def health():
    """서버 상태와 Gemini API Key 설정 여부 반환 (키 노출 금지)"""
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    has_api_key = bool(api_key)
    
    return jsonify({
        "status": "ok",
        "has_api_key": has_api_key,
        "model": model_name,
        "loaded_datasets_count": len([k for k in DATASETS.keys() if not k.endswith('.csv')])
    })

@app.route("/datasets", methods=["GET"])
def get_datasets():
    """선택 가능한 지역/업종 필터 옵션 및 도구 카탈로그 목록 반환"""
    try:
        df_100 = DATASETS.get('business_100')
        if df_100 is None or df_100.empty:
            return jsonify({
                "success": False,
                "error": "데이터셋이 서버 메모리에 로드되지 않았습니다."
            }), 500

        sido_list = sorted([str(s) for s in df_100['시도'].dropna().unique() if str(s).strip()])
        
        sigungu_map = {}
        for sido in sido_list:
            sub = df_100[df_100['시도'] == sido]
            sigungus = sorted([str(g) for g in sub['시군구'].dropna().unique() if str(g).strip()])
            sigungu_map[sido] = sigungus

        industry_list = sorted([str(i) for i in df_100['업종'].dropna().unique() if str(i).strip()])

        # 도구 카탈로그 요약 목록
        tools_summary = [
            {"id": tid, "name": t["name"], "desc": t["desc"]}
            for tid, t in TOOL_CATALOG.items()
        ]

        logger.info(f"/datasets returned {len(sido_list)} sidos, {len(industry_list)} industries, {len(tools_summary)} tools")

        return jsonify({
            "success": True,
            "sido_list": sido_list,
            "sigungu_map": sigungu_map,
            "industry_list": industry_list,
            "tools": tools_summary
        })
    except Exception as e:
        logger.error(f"/datasets error: {e}")
        return jsonify({
            "success": False,
            "error": f"데이터셋 메타데이터 조회 중 오류 발생: {str(e)}"
        }), 500

@app.route("/inspect", methods=["POST"])
def inspect_data():
    """사용자가 선택한 조건(지역, 업종)으로 데이터를 필터링하고 8개 항목 진단 결과 JSON 반환"""
    try:
        req_data = request.get_json(silent=True) or {}
        sido = req_data.get("sido", "").strip()
        sigungu = req_data.get("sigungu", "").strip()
        industry = req_data.get("industry", "").strip()

        if not sido:
            return jsonify({"success": False, "error": "필수 선택값 누락: 지역(시/도)을 선택해 주세요."}), 400
        if not industry:
            return jsonify({"success": False, "error": "필수 선택값 누락: 업종을 선택해 주세요."}), 400

        df_100 = DATASETS.get('business_100')
        if df_100 is None or df_100.empty:
            return jsonify({"success": False, "error": "서버에 100대 생활업종 데이터셋이 없습니다."}), 500

        filtered_df = df_100.copy()
        filtered_df = filtered_df[filtered_df['시도'] == sido]

        if sigungu and sigungu != "전체":
            filtered_df = filtered_df[filtered_df['시군구'] == sigungu]

        filtered_df = filtered_df[filtered_df['업종'] == industry]

        warnings = []
        rows_count = len(filtered_df)
        cols_count = len(filtered_df.columns)

        if rows_count == 0:
            return jsonify({
                "success": False,
                "error": f"선택한 조건의 데이터 없음: [{sido} {sigungu} - {industry}] 조건에 부합하는 데이터가 존재하지 않습니다."
            }), 404

        if rows_count < 3:
            warnings.append(f"해당 조건의 점포 데이터 행 수가 {rows_count}개로 매우 적어 통계적 해석 시 주의가 필요합니다.")

        # 1. 숫자형/문자형 분류
        numeric_cols = filtered_df.select_dtypes(include=[np.number]).columns.tolist()
        categorical_cols = filtered_df.select_dtypes(exclude=[np.number]).columns.tolist()

        # 2. 결측치 분석
        missing_counts = {k: int(v) for k, v in filtered_df.isnull().sum().to_dict().items()}
        total_cells = rows_count * cols_count
        total_missing = sum(missing_counts.values())
        missing_ratio = round((total_missing / total_cells * 100), 2) if total_cells > 0 else 0.0

        if total_missing > 0:
            warnings.append(f"전체 데이터 중 결측치가 {total_missing}건({missing_ratio}%) 포함되어 있습니다.")

        # 3. 연도별/시점 데이터 충실도
        time_cols = [c for c in ['당월', '전월', '전년동월'] if c in filtered_df.columns]
        missing_time_cols = [c for c in ['당월', '전월', '전년동월'] if c not in filtered_df.columns]
        if missing_time_cols:
            warnings.append(f"주요 시점 컬럼({', '.join(missing_time_cols)})이 누락되었습니다.")

        # 4. 집계 행 비교 (전국 대비)
        national_df = df_100[df_100['업종'] == industry]
        national_total_stores = int(national_df['당월'].sum()) if '당월' in national_df.columns else 0
        local_total_stores = int(filtered_df['당월'].sum()) if '당월' in filtered_df.columns else 0

        aggregated_comparison = {
            "has_national_comparison": True,
            "national_total_stores": national_total_stores,
            "local_total_stores": local_total_stores,
            "local_share_pct": round((local_total_stores / national_total_stores * 100), 2) if national_total_stores > 0 else 0.0
        }

        preview_data = clean_record_for_json(filtered_df.head(10).to_dict(orient="records"))

        diagnosis = {
            "success": True,
            "selected_conditions": {
                "sido": sido,
                "sigungu": sigungu if sigungu else "전체",
                "industry": industry
            },
            "shape": {
                "rows": rows_count,
                "cols": cols_count
            },
            "column_types": {
                "numeric": numeric_cols,
                "categorical": categorical_cols
            },
            "missing_values": {
                "total_missing": total_missing,
                "missing_ratio_pct": missing_ratio,
                "per_column": missing_counts
            },
            "year_completeness": {
                "time_columns": time_cols,
                "is_complete": len(missing_time_cols) == 0,
                "notes": "국세청 100대 생활업종(당월, 전월, 전년동월) 데이터 기준"
            },
            "aggregated_comparison": aggregated_comparison,
            "preview_rows": preview_data,
            "warnings": warnings
        }

        logger.info(f"Inspection complete for {sido} {sigungu} {industry}: rows={rows_count}")
        return jsonify(diagnosis)

    except Exception as e:
        logger.error(f"/inspect error: {e}")
        return jsonify({
            "success": False,
            "error": f"데이터 진단 중 예기치 않은 오류가 발생했습니다: {str(e)}"
        }), 500

@app.route("/suggest", methods=["POST"])
def suggest_tools():
    """진단 결과를 Gemini에 전달하고, 도구 카탈로그 중 적합한 창업 분석 도구 3~5개를 JSON으로 제안받음"""
    try:
        req_data = request.get_json(silent=True) or {}
        diagnosis = req_data.get("diagnosis")
        if not diagnosis:
            return jsonify({"success": False, "error": "필수 선택값 누락: 진단(diagnosis) 데이터가 전달되지 않았습니다."}), 400

        # 도구 목록 생성 (카탈로그에 있는 도구만 제안 가능)
        catalog_items = [
            {"tool_id": tid, "name": t["name"], "description": t["desc"]}
            for tid, t in TOOL_CATALOG.items()
        ]

        prompt = f"""
당신은 청년 창업가를 위한 시장 데이터 분석 AI 컨설턴트입니다.
아래의 [데이터 진단 결과]를 바탕으로, 제공된 [도구 카탈로그]에서 청년 창업가에게 가장 유익한 분석 도구를 3개에서 5개 선정하여 추천해 주세요.

[절대 규칙]
1. 반드시 아래 도구 카탈로그에 존재하는 tool_id만 제안해야 합니다. 임의의 도구를 지어내지 마세요.
2. 제안 개수는 반드시 3개 이상 5개 이하이어야 합니다.
3. 데이터 진단 결과에 나타난 업종과 지역 특성, 데이터 품질(행 수, 결측치 등)을 고려하여 추천 이유(reason)를 청년 창업가 눈높이에 맞게 구체적으로 작성하세요.
4. 출력은 다른 설명 없이 오직 순수한 JSON 형식만 반환하세요.

[도구 카탈로그]:
{json.dumps(catalog_items, ensure_ascii=False, indent=2)}

[데이터 진단 결과]:
{json.dumps(diagnosis, ensure_ascii=False, indent=2)}

[반환 JSON 형식 예시]:
{{
  "suggested_tools": [
    {{
      "tool_id": "market_saturation_index",
      "tool_name": "2. 레드오션 과밀 포화도 지수",
      "reason": "해당 지역의 점포 과밀도를 전국 평균과 비교하여 레드오션 여부를 판별하기 위해 필수적입니다."
    }}
  ]
}}
"""
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        client = get_gemini_client()

        logger.info(f"Calling Gemini /suggest with model {model_name}...")
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
        )

        res_text = response.text.strip()
        # 마크다운 코드블록 제거
        res_text = re.sub(r"^```(?:json)?\s*", "", res_text)
        res_text = re.sub(r"\s*```$", "", res_text)

        try:
            suggest_data = json.loads(res_text)
        except json.JSONDecodeError as jde:
            logger.error(f"JSON 파싱 실패: {jde}. Raw text: {res_text}")
            return jsonify({
                "success": False,
                "error": f"JSON 파싱 실패: Gemini가 유효한 JSON을 반환하지 않았습니다. ({str(jde)})"
            }), 500

        # 도구 ID 검증 필터
        valid_tools = []
        for st in suggest_data.get("suggested_tools", []):
            tid = st.get("tool_id")
            if tid in TOOL_CATALOG:
                st["tool_name"] = TOOL_CATALOG[tid]["name"]
                valid_tools.append(st)

        if not valid_tools:
            # 기본 추천 폴백 (카탈로그 내 도구)
            valid_tools = [
                {"tool_id": "industry_growth_trend", "tool_name": TOOL_CATALOG["industry_growth_trend"]["name"], "reason": "최근 점포수 증감 추이를 확인하여 업종 성장성을 파악합니다."},
                {"tool_id": "market_saturation_index", "tool_name": TOOL_CATALOG["market_saturation_index"]["name"], "reason": "전국 평균 대비 해당 지역의 레드오션 포화도를 진단합니다."},
                {"tool_id": "initial_cost_estimate", "tool_name": TOOL_CATALOG["initial_cost_estimate"]["name"], "reason": "창업에 필요한 초기 투자비용과 구성 항목을 검토합니다."}
            ]

        logger.info(f"/suggest successfully recommended {len(valid_tools)} tools")
        return jsonify({
            "success": True,
            "suggested_tools": valid_tools
        })

    except APIError as ae:
        logger.error(f"Gemini API Error in /suggest: {ae}")
        return jsonify({"success": False, "error": f"API 인증 실패 또는 서비스 오류: {str(ae)}"}), 500
    except Exception as e:
        logger.error(f"/suggest error: {e}")
        return jsonify({"success": False, "error": f"도구 추천 처리 중 오류: {str(e)}"}), 500

@app.route("/run", methods=["POST"])
def run_tool():
    """선택된 도구를 Pandas로만 실행, 계산 결과 + Chart.js용 차트 데이터 반환"""
    try:
        req_data = request.get_json(silent=True) or {}
        tool_id = req_data.get("tool_id", "").strip()
        sido = req_data.get("sido", "서울특별시").strip()
        sigungu = req_data.get("sigungu", "강남구").strip()
        industry = req_data.get("industry", "커피음료점").strip()
        base_period = req_data.get("base_period", "당월").strip()
        exclude_aggregated = req_data.get("exclude_aggregated", True)

        if not tool_id:
            return jsonify({"success": False, "error": "필수 선택값 누락: 실행할 도구 ID(tool_id)를 지정해 주세요."}), 400

        if tool_id not in TOOL_CATALOG:
            return jsonify({"success": False, "error": f"도구 카탈로그에 존재하지 않는 도구입니다: {tool_id}"}), 400

        tool_entry = TOOL_CATALOG[tool_id]
        func = tool_entry["func"]

        logger.info(f"Running tool '{tool_id}' for {sido} {sigungu} {industry}...")
        
        # 순수 Pandas 연산 수행 (Gemini에게 계산을 절대 시키지 않음)
        calc_result = func(
            DATASETS,
            sido=sido,
            sigungu=sigungu,
            industry=industry,
            base_period=base_period,
            exclude_aggregated=exclude_aggregated
        )

        return jsonify({
            "success": True,
            "result": calc_result
        })

    except ValueError as ve:
        logger.warning(f"/run validation error: {ve}")
        return jsonify({"success": False, "error": str(ve)}), 400
    except Exception as e:
        logger.error(f"/run execution error: {e}")
        return jsonify({"success": False, "error": f"도구 연산 중 오류 발생: {str(e)}"}), 500

@app.route("/explain", methods=["POST"])
def explain_result():
    """Gemini 보고서 생성 (모드 A: 진단 요약만 전달 / 모드 B: Pandas 계산 결과만 전달하여 정밀 해석)"""
    try:
        req_data = request.get_json(silent=True) or {}
        mode = req_data.get("mode", "B").upper()
        diagnosis = req_data.get("diagnosis", {})
        calc_result = req_data.get("calculation_result", {})

        model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        client = get_gemini_client()

        if mode == "A":
            # [모드 A (비교용)]: 진단 요약만 전달하고 보고서 요청. 계산 결과 주지 않음.
            prompt = f"""
당신은 청년 창업 데이터 분석가입니다.
아래는 사용자가 선택한 지역/업종 데이터의 기본 진단 요약입니다. (상세 수치 계산 결과는 제공되지 않았습니다.)
일반적인 관점에서 이 시장에 대한 개략적인 안내와 데이터 진단 시 유의사항을 마크다운 보고서로 작성해 주세요.

[데이터 진단 요약]:
{json.dumps(diagnosis, ensure_ascii=False, indent=2)}

작성 시 주의사항:
- 계산된 정밀 통계 수치가 없으므로 일반적인 상권 상식 수준에서 서술하세요.
- 데이터 부족이나 한계점을 명시하세요.
"""
        else:
            # [모드 B (정식)]: Pandas 계산 결과만 전달하고 엄격한 규칙 준수
            if not calc_result:
                return jsonify({"success": False, "error": "필수 선택값 누락: 모드 B에서는 Pandas 계산 결과(calculation_result)가 필요합니다."}), 400

            prompt = f"""
당신은 대한민국 청년 창업가를 위한 시장 데이터 전문 전략 컨설턴트입니다.
Python Pandas가 공공데이터를 기반으로 정밀 계산한 아래의 [계산 결과]만을 기반으로 창업 전략 보고서를 작성하세요.

[절대 규칙 - 엄격 준수]
1. 제공된 계산 결과(표, 요약 수치, 기준시점, 행 수)에 명시된 숫자만 사용하세요. 임의로 숫자를 지어내거나 추정하지 마세요.
2. 기준 시점과 분석에 사용/제외된 행 수를 본문에 반드시 명시하세요.
3. 해당 업종/지역이 레드오션인지 블루오션인지 명확히 판정하고, 초기 투자비용 대비 실익과 리스크를 냉철하게 평가하세요.
4. 수치적 근거를 바탕으로 청년 창업가를 위한 구체적이고 차별화된 시장 진입 전략을 제안하세요.
5. 계산되지 않은 정보(예: 개별 매장 인기도, 유동인구 성향 등)는 "이 데이터로는 알 수 없는 것" 섹션에 솔직히 기록하세요.

[반드시 준수할 출력 헤더 형식]:
## 데이터 출처
## 기준 시점과 데이터 품질
## 핵심 수치 결과
## 시장 진단
## 비용 및 리스크 점검
## 차별화된 전략 제안
## 이 데이터로는 알 수 없는 것

[Pandas 계산 결과]:
{json.dumps(calc_result, ensure_ascii=False, indent=2)}

[참고용 진단 정보]:
{json.dumps(diagnosis.get("selected_conditions", {}), ensure_ascii=False)}
"""

        logger.info(f"Calling Gemini /explain with mode={mode}, model={model_name}...")
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
        )

        report_markdown = response.text.strip()
        logger.info(f"/explain generated {len(report_markdown)} chars report.")

        return jsonify({
            "success": True,
            "mode": mode,
            "report": report_markdown
        })

    except APIError as ae:
        logger.error(f"Gemini API Error in /explain: {ae}")
        return jsonify({"success": False, "error": f"API 인증 실패 또는 호출 오류: {str(ae)}"}), 500
    except Exception as e:
        logger.error(f"/explain error: {e}")
        return jsonify({"success": False, "error": f"전략 해석 보고서 생성 중 오류: {str(e)}"}), 500

if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_DEBUG", "true").lower() in ("true", "1")
    logger.info(f"Starting Flask server on port 5000 (debug={debug_mode})")
    app.run(host="127.0.0.1", port=5000, debug=debug_mode)
