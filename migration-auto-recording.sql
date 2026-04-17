-- D1 마이그레이션: recordings 테이블에 file_url 컬럼이 없다면 추가
-- (LiveKit 브릿지 코드에서 이미 쓰고 있으므로 대부분 존재하지만, 혹시 없으면 실행)
-- 이유: R2 object key를 저장해야 /api/recordings/stream/{id} 에서 재생 가능

ALTER TABLE recordings ADD COLUMN file_url TEXT;

-- 인덱스 (선택) — 대시보드 조회 성능
CREATE INDEX IF NOT EXISTS idx_recordings_teacher_started
  ON recordings (teacher_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_recordings_status_storage
  ON recordings (status, storage);
