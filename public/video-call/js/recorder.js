/**
 * recorder.js — MediaRecorder 기반 수업 녹화 + R2 업로드
 *
 * 사용 전제:
 *  - 전역 `localStream` (로컬 카메라/마이크 MediaStream) 이 webrtc.js 에서 이미 생성되어 있음
 *  - 전역 `roomId` 가 app.js 에서 설정되어 있음
 *  - 서버 엔드포인트: POST /api/recordings/blob/upload
 */

let _mediaRecorder = null;
let _recordingChunks = [];
let _recordingStream = null;
let _recordingStartedAt = 0;
let _recordingMime = '';

const RECORDING_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
  'video/mp4'
];

function pickSupportedMime() {
  for (const m of RECORDING_MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return '';
}

function startRecording(options = {}) {
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    console.warn('[recorder] 이미 녹화 중입니다.');
    return false;
  }

  const stream = options.stream || (typeof localStream !== 'undefined' ? localStream : null);
  if (!stream) {
    console.error('[recorder] 녹화할 스트림이 없습니다.');
    return false;
  }

  const mimeType = pickSupportedMime();
  if (!mimeType) {
    console.error('[recorder] 이 브라우저는 MediaRecorder를 지원하지 않습니다.');
    return false;
  }

  try {
    _mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: options.videoBitsPerSecond ?? 2500000,
      audioBitsPerSecond: options.audioBitsPerSecond ?? 128000
    });
  } catch (e) {
    console.error('[recorder] MediaRecorder 생성 실패:', e);
    return false;
  }

  _recordingChunks = [];
  _recordingStream = stream;
  _recordingStartedAt = Date.now();
  _recordingMime = mimeType;

  _mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) _recordingChunks.push(e.data);
  };
  _mediaRecorder.onerror = (e) => console.error('[recorder] MediaRecorder 에러:', e);

  _mediaRecorder.start(options.timeslice ?? 2000);
  console.log('[recorder] 녹화 시작 (mime=' + mimeType + ')');
  _dispatch('recording:started', { mimeType });
  return true;
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!_mediaRecorder || _mediaRecorder.state === 'inactive') {
      resolve({ success: false, error: '녹화 중이 아닙니다.' });
      return;
    }

    _mediaRecorder.onstop = async () => {
      const blob = new Blob(_recordingChunks, { type: _recordingMime.split(';')[0] });
      const durationMs = Date.now() - _recordingStartedAt;
      console.log('[recorder] 녹화 종료: ' + (blob.size / 1024 / 1024).toFixed(2) + 'MB, ' + Math.round(durationMs / 1000) + 's');
      _dispatch('recording:stopped', { size: blob.size, durationMs });

      try {
        const result = await uploadRecording(blob);
        _dispatch('recording:uploaded', result);
        resolve({ success: true, ...result });
      } catch (err) {
        console.error('[recorder] 업로드 실패:', err);
        _dispatch('recording:upload-failed', { error: err.message });
        resolve({ success: false, error: err.message });
      } finally {
        _recordingChunks = [];
        _mediaRecorder = null;
      }
    };

    _mediaRecorder.stop();
  });
}

function pauseRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _mediaRecorder.pause();
    _dispatch('recording:paused');
    return true;
  }
  return false;
}

function resumeRecording() {
  if (_mediaRecorder && _mediaRecorder.state === 'paused') {
    _mediaRecorder.resume();
    _dispatch('recording:resumed');
    return true;
  }
  return false;
}

function isRecording() {
  return !!_mediaRecorder && _mediaRecorder.state !== 'inactive';
}

function getRecordingStream() {
  return _recordingStream;
}

async function uploadRecording(blob) {
  const rid = (typeof roomId !== 'undefined' && roomId) ? roomId : 'default';
  const filename = 'recording-' + new Date().toISOString().replace(/[:.]/g, '-') + '.webm';

  const res = await fetch('/api/recordings/blob/upload', {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'video/webm',
      'X-Room-Id': rid,
      'X-Filename': filename
    },
    body: blob
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ': ' + text);
  }

  const data = await res.json();
  console.log('[recorder] 업로드 성공:', data);
  return data;
}

function _dispatch(name, detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch (_) {}
}

window.startRecording = startRecording;
window.stopRecording = stopRecording;
window.pauseRecording = pauseRecording;
window.resumeRecording = resumeRecording;
window.isRecording = isRecording;
window.getRecordingStream = getRecordingStream;
