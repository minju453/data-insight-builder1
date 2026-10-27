import sys
import os

# 프로젝트 루트 디렉토리를 모듈 검색 경로에 추가
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

# Flask 앱 엔트리포인트 노출
from app import app
