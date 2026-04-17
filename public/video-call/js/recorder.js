/**
 * recorder.js v2 — 자동 녹화 + R2 업로드 + DB 연동
 *
 * 변경: 커스텀 헤더 제거, URL 쿼리 파라미터로 메타데이터 전송
 * 엔드포인트: /api/recordings/complete?recording_id=X&room_id=Y&duration_ms=Z
 */

let _mediaRecorder = null;
let _recordingChunks = [];
let _recordingStream = null;
let _recordingStartedAt = 0;
let _recordingMime = '';
let _recordingId = null;

const RECORDING_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4'
];

function pickSupportedMime() {
  for (const m of RECORDING_MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function startRecording(options) {
  options = options || {};
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    console.warn('[recorder] 이미 녹화 중입니다.');
    return false;
  }

  var stream = options.stream || (typeof localStream !== 'undefined' ? localStream : null);
  if (!stream || stream.getTracks().length === 0) {
    console.error('[recorder] 녹화할 스트림이 없습니다.');
    return false;
  }

  var mimeType = pickSupportedMime();
  if (!mimeType) {
    console.error('[recorder] MediaRecorder를 지원하지 않습니다.');
    return false;
  }

  _initAndStart(stream, mimeType, options);
  return true;
}

async function _initAndStart(stream, mimeType, options) {
  var rid = (typeof roomId !== 'undefined' && roomId) ? roomId : 'default';
  var uname = (typeof username !== 'undefined' && username) ? username : '';

  try {
    var startRes = await fetch('/api/recordings/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: rid,
        teacher_id: uname || rid,
        teacher_name: uname,
        participant_ids: [],
        participant_names: []
      })
    }).then(function(r) { return r.json(); });

    if (!startRes.ok) {
      console.error('[recorder] 녹화 메타 생성 실패:', startRes);
      return;
    }
    _recordingId = startRes.recording_id;

    _mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond || 2500000,
      audioBitsPerSecond: options.audioBitsPerSecond || 128000
    });
    _recordingChunks = [];
    _recordingStream = stream;
    _recordingStartedAt = Date.now();
    _recordingMime = mimeType;

    _mediaRecorder.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) _recordingChunks.push(e.data);
    };
    _mediaRecorder.onerror = function(e) { console.error('[recorder] 에러:', e); };
    _mediaRecorder.start(options.timeslice || 5000);

    console.log('[recorder] 녹화 시작', { recordingId: _recordingId, mime: mimeType });
    _dispatch('recording:started', { mimeType: mimeType, recordingId: _recordingId });
  } catch (err) {
    console.error('[recorder] 초기화 실패:', err);
  }
}

function stopRecording() {
  return new Promise(function(resolve) {
    if (!_mediaRecorder || _mediaRecorder.state === 'inactive') {
      resolve({ success: false, error: '녹화 중이 아닙니다.' });
      return;
    }

    var savedRecordingId = _recordingId;
    var savedStartedAt = _recordingStartedAt;
    var savedMime = _recordingMime;

    _mediaRecorder.onstop = async function() {
      var baseType = savedMime.split(';')[0];
      var blob = new Blob(_recordingChunks, { type: baseType });
      var durationMs = Date.now() - savedStartedAt;
      var rid = (typeof roomId !== 'undefined' && roomId) ? roomId : 'default';

      console.log('[recorder] 녹화 종료: ' + (blob.size / 1048576).toFixed(2) + 'MB, ' + Math.round(durationMs / 1000) + 's');
      _dispatch('recording:stopped', { size: blob.size, durationMs: durationMs });

      // 청크 정리
      _recordingChunks = [];
      _mediaRecorder = null;
      _recordingId = null;

      var uploadRes = null;
      try {
        // URL 쿼리 파라미터로 메타데이터 전송 (커스텀 헤더 없음)
        var params = '?recording_id=' + encodeURIComponent(savedRecordingId || '') +
                     '&room_id=' + encodeURIComponent(rid) +
                     '&duration_ms=' + durationMs;

        console.log('[recorder] R2 업로드 시작...', {
          url: '/api/recordings/complete' + params,
          blobSize: blob.size,
          blobType: blob.type
        });

        uploadRes = await fetch('/api/recordings/complete' + params, {
          method: 'POST',
          body: blob
        });

        console.log('[recorder] 서버 응답 상태:', uploadRes.status);
        var uploadData = await uploadRes.json();
        console.log('[recorder] 업로드 결과:', JSON.stringify(uploadData));

        if (uploadData.ok) {
          var result = { success: true, key: uploadData.key, url: uploadData.url, recordingId: savedRecordingId, size: blob.size };
          _dispatch('recording:uploaded', result);
          resolve(result);
        } else {
          console.error('[recorder] 서버 에러:', uploadData.error, uploadData.debug);
          _callStop(savedRecordingId, durationMs, blob.size, 'SERVER:' + (uploadData.error || '') + '|' + (uploadData.debug || ''));
          _dispatch('recording:upload-failed', { error: uploadData.error });
          resolve({ success: false, error: uploadData.error });
        }
      } catch (err) {
        console.error('[recorder] 업로드 fetch 실패:', err);
        _callStop(savedRecordingId, durationMs, blob.size, 'FETCH:status=' + (uploadRes ? uploadRes.status : 'none') + ':' + (err.message || err));
        _dispatch('recording:upload-failed', { error: err.message });
        resolve({ success: false, error: err.message });
      }
    };

    _mediaRecorder.stop();
  });
}

// DB 종료 처리 (업로드 실패 시 폴백) — 에러 원인도 DB에 기록
function _callStop(recId, durationMs, sizeBytes, errorInfo) {
  if (!recId) return;
  fetch('/api/recordings/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recording_id: recId,
      duration_ms: durationMs || 0,
      size_bytes: sizeBytes || 0,
      file_url: 'CLIENT_ERR:' + (errorInfo || 'unknown'),
      storage: 'error'
    })
  }).catch(function(e) { console.error('[recorder] stop 폴백 실패:', e); });
}

function pauseRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') { _mediaRecorder.pause(); _dispatch('recording:paused'); return true; }
  return false;
}
function resumeRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'paused') { _mediaRecorder.resume(); _dispatch('recording:resumed'); return true; }
  return false;
}
function isRecording() { return !!_mediaRecorder && _mediaRecorder.state !== 'inactive'; }
function getRecordingStream() { return _recordingStream; }
function _dispatch(name, detail) { try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (_) {} }

window.startRecording = startRecording;
window.stopRecording = stopRecording;
window.pauseRecording = pauseRecording;
window.resumeRecording = resumeRecording;
window.isRecording = isRecording;
window.getRecordingStream = getRecordingStream;
