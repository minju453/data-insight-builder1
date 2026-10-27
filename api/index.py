import sys
import os

# 프로젝트 루트 디렉토리를 모듈 검색 경로에 추가
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from app import app as flask_app

class VercelPathMiddleware:
    """
    Vercel Serverless 환경에서 rewrites로 인해 
    PATH_INFO가 '/api/index'로 변조되는 현상을 원본 경로로 자동 복원하는 WSGI 미들웨어
    """
    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        path = environ.get('PATH_INFO', '')
        
        # 1. /api/index 접두사 제거
        if path.startswith('/api/index'):
            corrected = path[len('/api/index'):]
            environ['PATH_INFO'] = corrected if corrected else '/'
        elif path == '/api' or path == '/api/':
            environ['PATH_INFO'] = '/'

        # 2. Vercel 원본 요청 경로 헤더(x-matched-path)가 있는 경우 우선 반영
        matched = environ.get('HTTP_X_MATCHED_PATH')
        if matched and matched not in ('/api/index', '/api'):
            environ['PATH_INFO'] = matched

        return self.wsgi_app(environ, start_response)

# Vercel이 인식하는 최종 WSGI 애플리케이션 객체
app = VercelPathMiddleware(flask_app)
