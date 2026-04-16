/**
 * mango-rec.js — 화상 수업 녹화 (교사 클라이언트 사이드)
 *  - canvas로 모든 영상 타일을 합성 + WebAudio로 모든 오디오 믹스
 *  - MediaRecorder(webm/vp8+opus)로 녹화
 *  - 녹화 시작/종료 시 D1에 메타데이터 저장, blob은 로컬 다운로드
 *  - 미동의 참가자가 있으면 빨간 경고 표시
 */
(function () {
  if (!window.MangoV3) return console.warn('mango.js 먼저 로드되어야 합니다');
  const M = window.MangoV3;

  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingId = null;
  let startedAt = 0;
  let composeCanvas = null;
  let composeCtx = null;
  let composeRafId = null;
  let audioCtx = null;
  let audioDest = null;
  let recBadge = null;

  function getRoomMembers() {
    const myId = (typeof vcUserId !== 'undefined' ? vcUserId : 'me');
    const myName = (typeof vcUsername !== 'undefined' ? vcUsername : '교사');
    const peers = (typeof vcPeerConnections !== 'undefined' ? vcPeerConnections : {}) || {};
    const ids = [myId, ...Object.keys(peers)];
    const names = { [myId]: myName };
    Object.keys(peers).forEach(uid => {
      const labelEl = document.getElementById(`vc-label-${uid}`);
      names[uid] = labelEl ? labelEl.textContent.replace(/\s*\(.*\)$/, '') : uid;
    });
    return { ids, names };
  }

  function collectVideos() {
    // 현재 표시되는 모든 video 엘리먼트
    const els = [];
    const local = document.getElementById('vc-local-video');
    if (local && local.srcObject) els.push({ el: local, label: '나' });
    document.querySelectorAll('video[id^="vc-video-"]').forEach(v => {
      if (v.srcObject) {
        const uid = v.id.replace('vc-video-', '');
        const labelEl = document.getElementById(`vc-label-${uid}`);
        els.push({ el: v, label: labelEl ? labelEl.textContent : uid });
      }
    });
    return els;
  }

  function collectAudioTracks() {
    const tracks = [];
    if (typeof vcLocalStream !== 'undefined' && vcLocalStream) {
      vcLocalStream.getAudioTracks().forEach(t => tracks.push({ stream: vcLocalStream, track: t }));
    }
    const peers = (typeof vcPeerConnections !== 'undefined' ? vcPeerConnections : {}) || {};
    Object.values(peers).forEach(pc => {
      pc.getReceivers().forEach(r => {
        if (r.track && r.track.kind === 'audio') {
          tracks.push({ stream: new MediaStream([r.track]), track: r.track });
        }
      });
    });
    return tracks;
  }

  function startCanvasCompose() {
    composeCanvas = document.createElement('canvas');
    composeCanvas.width = 1280;
    composeCanvas.height = 720;
    composeCtx = composeCanvas.getContext('2d');

    function draw() {
      const videos = collectVideos();
      composeCtx.fillStyle = '#000';
      composeCtx.fillRect(0, 0, composeCanvas.width, composeCanvas.height);
      if (videos.length === 0) {
        composeCtx.fillStyle = '#fff';
        composeCtx.font = '24px sans-serif';
        composeCtx.fillText('대기 중...', 40, 40);
      } else {
        // 격자 배치
        const cols = Math.ceil(Math.sqrt(videos.length));
        const rows = Math.ceil(videos.length / cols);
        const tileW = composeCanvas.width / cols;
        const tileH = composeCanvas.height / rows;
        videos.forEach((v, i) => {
          const cx = (i % cols) * tileW;
          const cy = Math.floor(i / cols) * tileH;
          try {
            composeCtx.drawImage(v.el, cx, cy, tileW, tileH);
            composeCtx.fillStyle = 'rgba(0,0,0,0.6)';
            composeCtx.fillRect(cx, cy + tileH - 30, tileW, 30);
            composeCtx.fillStyle = '#fff';
            composeCtx.font = '16px -apple-system,"맑은 고딕",sans-serif';
            composeCtx.fillText(v.label, cx + 8, cy + tileH - 10);
          } catch (e) { /* readyState 부족 등 */ }
        });
      }
      // 시간 + 녹화 표시
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      composeCtx.fillStyle = 'rgba(220,38,38,0.9)';
      composeCtx.fillRect(composeCanvas.width - 140, 10, 130, 32);
      composeCtx.fillStyle = '#fff';
      composeCtx.font = 'bold 14px sans-serif';
      composeCtx.fillText('● REC ' + mm + ':' + ss, composeCanvas.width - 130, 31);
      composeRafId = requestAnimationFrame(draw);
    }
    draw();
    return composeCanvas.captureStream(15); // 15fps
  }

  function startAudioMix() {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    audioDest = audioCtx.createMediaStreamDestination();
    collectAudioTracks().forEach(({ stream }) => {
      try {
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(audioDest);
      } catch (e) { console.warn('오디오 믹스 실패', e); }
    });
    return audioDest.stream;
  }

  function showRecBadge() {
    if (recBadge) return;
    recBadge = document.createElement('div');
    recBadge.id = 'mango-rec-badge';
    recBadge.style.cssText = 'position:fixed;top:60px;right:16px;background:#dc2626;color:#fff;padding:8px 14px;border-radius:20px;font-weight:600;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(220,38,38,0.4);display:flex;align-items:center;gap:6px;';
    recBadge.innerHTML = '<span style="width:8px;height:8px;background:#fff;border-radius:50%;animation:mango-rec-blink 1s infinite;"></span><span id="mango-rec-time">REC 00:00</span>';
    document.body.appendChild(recBadge);
    if (!document.getElementById('mango-rec-style')) {
      const s = document.createElement('style');
      s.id = 'mango-rec-style';
      s.textContent = '@keyframes mango-rec-blink{0%,100%{opacity:1}50%{opacity:0.3}}';
      document.head.appendChild(s);
    }
    setInterval(() => {
      if (!isRecording) return;
      const t = document.getElementById('mango-rec-time');
      if (t) {
        const e = Math.floor((Date.now() - startedAt) / 1000);
        t.textContent = 'REC ' + String(Math.floor(e / 60)).padStart(2, '0') + ':' + String(e % 60).padStart(2, '0');
      }
    }, 1000);
  }
  function hideRecBadge() {
    if (recBadge) { recBadge.remove(); recBadge = null; }
  }

  async function startRecording() {
    if (isRecording) return;
    if (M.getRole() !== 'teacher') {
      alert('녹화는 교사만 시작할 수 있습니다.');
      return;
    }
    const { ids, names } = getRoomMembers();
    if (ids.length < 1) {
      alert('참가자가 없습니다.');
      return;
    }

    // 동의 확인
    const startRes = await M.api('/api/recordings/start', {
      room_id: (typeof vcRoomId !== 'undefined' ? vcRoomId : ''),
      teacher_id: M.getUserId(),
      teacher_name: (typeof vcUsername !== 'undefined' ? vcUsername : ''),
      participant_ids: ids,
      participant_names: ids.map(id => names[id])
    });

    if (!startRes?.ok) {
      alert('녹화 시작 실패');
      return;
    }
    const nonConsented = startRes.non_consented || [];
    const myId = M.getUserId();
    const realNonConsented = nonConsented.filter(id => id !== myId);
    if (realNonConsented.length > 0) {
      const nonNames = realNonConsented.map(id => names[id] || id).join(', ');
      const proceed = confirm(`⚠️ 다음 참가자가 녹화에 동의하지 않았습니다:\n\n${nonNames}\n\n그래도 녹화를 시작하시겠습니까?\n(법적 책임은 교사에게 있습니다)`);
      if (!proceed) {
        await M.api('/api/recordings/stop', { recording_id: startRes.recording_id, duration_ms: 0, size_bytes: 0 });
        return;
      }
    }

    recordingId = startRes.recording_id;
    startedAt = Date.now();
    recordedChunks = [];

    // 참가자에게 녹화 알림
    try {
      const conn = (typeof vcConn !== 'undefined' ? vcConn : null);
      if (conn && conn.readyState === 1) {
        conn.send(JSON.stringify({
          type: 'chat-message',
          data: { username: '시스템', message: '🔴 녹화가 시작되었습니다. (동의: ' + startRes.consented_count + '/' + startRes.total_participants + '명)' }
        }));
      }
    } catch (_) {}

    const videoStream = startCanvasCompose();
    const audioStream = startAudioMix();
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks()
    ]);

    let mime = 'video/webm;codecs=vp8,opus';
    if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
    mediaRecorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const duration = Date.now() - startedAt;
      // 다운로드
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mango_rec_${(typeof vcRoomId !== 'undefined' ? vcRoomId : 'room')}_${new Date(startedAt).toISOString().slice(0,19).replace(/[:T]/g,'-')}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // 메타데이터 종료 기록
      await M.api('/api/recordings/stop', {
        recording_id: recordingId,
        duration_ms: duration,
        size_bytes: blob.size
      });
      alert('녹화 완료\n파일명: ' + a.download + '\n용량: ' + (blob.size / (1024 * 1024)).toFixed(1) + 'MB\n시간: ' + Math.round(duration / 1000) + '초\n\n파일이 다운로드되었습니다.');
    };
    mediaRecorder.start(1000);
    isRecording = true;
    showRecBadge();
    updateRecButton();
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    if (composeRafId) cancelAnimationFrame(composeRafId);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (audioCtx) try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
    audioDest = null;
    composeCanvas = null;
    composeCtx = null;
    hideRecBadge();
    updateRecButton();
    try {
      const conn = (typeof vcConn !== 'undefined' ? vcConn : null);
      if (conn && conn.readyState === 1) {
        conn.send(JSON.stringify({
          type: 'chat-message',
          data: { username: '시스템', message: '⏹ 녹화가 종료되었습니다.' }
        }));
      }
    } catch (_) {}
  }

  function updateRecButton() {
    const btn = document.getElementById('mango-rec-btn');
    if (!btn) return;
    btn.textContent = isRecording ? '⏹' : '🔴';
    btn.title = isRecording ? '녹화 중지' : '녹화 시작';
    btn.style.background = isRecording ? '#dc2626' : '';
    btn.style.color = isRecording ? '#fff' : '';
  }

  function injectRecButton() {
    if (M.getRole() !== 'teacher') return;
    const toolbar = document.querySelector('#view-videocall-call .toolbar-center');
    if (!toolbar || toolbar.querySelector('#mango-rec-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'mango-rec-btn';
    btn.className = 'ctrl-btn on';
    btn.title = '녹화 시작';
    btn.textContent = '🔴';
    btn.onclick = () => { isRecording ? stopRecording() : startRecording(); };
    toolbar.appendChild(btn);
  }

  // 기존 vcJoinRoom 래핑에 추가
  const origInjectToolbar = M._injectExtra || (() => {});
  M._injectRec = injectRecButton;

  // 주기적으로 툴바 확인
  setInterval(() => {
    const view = document.getElementById('view-videocall-call');
    if (view && view.style.display !== 'none' && view.classList.contains('view') && document.body.classList.contains('vc-in-call')) {
      injectRecButton();
    }
    // 학생이 떠나면 자동 종료 X (교사가 명시적으로 중지)
  }, 2000);

  M.startRecording = startRecording;
  M.stopRecording = stopRecording;
})();
