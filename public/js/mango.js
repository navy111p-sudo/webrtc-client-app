/**
 * mango.js — v3 명세서 신규 기능 (출석/VAD/카카오/보상)
 * 기존 코드 변경 없이 vcJoinRoom/vcLeaveRoom을 래핑하는 방식으로 동작.
 */
(function () {
  const M = {};
  window.MangoV3 = M;

  // ===== 상태 =====
  let attendanceId = null;
  let joinTs = 0;
  let disconnectCount = 0;
  let activeMs = 0;       // VAD 활성 시간
  let sessionMs = 0;      // 총 세션 시간
  let vadAudioCtx = null;
  let vadAnalyzer = null;
  let vadSource = null;
  let vadRafId = null;
  let vadLastTs = 0;
  let vadActiveSince = 0;
  let heartbeatTimer = null;
  let speakingTimer = null;
  let kakaoBtnEl = null;
  let rewardWidgetEl = null;
  let disconnectTimer = null;

  // role: localStorage에서 가져오거나 기본값
  function getRole() {
    return localStorage.getItem('mango_role') || 'student';
  }
  function setRole(r) {
    localStorage.setItem('mango_role', r);
  }
  function getUserId() {
    let uid = localStorage.getItem('mango_user_id');
    if (!uid) {
      uid = 'u_' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem('mango_user_id', uid);
    }
    return uid;
  }

  M.getRole = getRole;
  M.setRole = setRole;
  M.getUserId = getUserId;

  // ===== API =====
  async function api(path, body, method) {
    try {
      const r = await fetch(path, {
        method: method || (body ? 'POST' : 'GET'),
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      return await r.json();
    } catch (e) {
      console.warn('mango api fail', path, e);
      return null;
    }
  }
  M.api = api;

  // ===== 출석 트래킹 =====
  async function startAttendance(roomId, username) {
    joinTs = Date.now();
    disconnectCount = 0;
    activeMs = 0;
    sessionMs = 0;
    const res = await api('/api/attendance/join', {
      room_id: roomId,
      user_id: getUserId(),
      username: username,
      role: getRole()
    });
    attendanceId = res?.attendance_id || null;

    // 30초 heartbeat + WebRTC 상태 모니터링
    heartbeatTimer = setInterval(() => {
      api('/api/attendance/heartbeat', { room_id: roomId, user_id: getUserId() });
      // P2P 연결 상태 점검
      try {
        const peers = (typeof vcPeerConnections !== "undefined" ? vcPeerConnections : {}) || {};
        const states = Object.values(peers).map(pc => pc.connectionState || pc.iceConnectionState);
        const allBad = states.length > 0 && states.every(s => s === 'disconnected' || s === 'failed' || s === 'closed');
        if (allBad) onConnectionState('disconnected');
        else if (states.some(s => s === 'connected' || s === 'completed')) onConnectionState('connected');
      } catch (_) {}
    }, 10000);
  }

  async function endAttendance(roomId) {
    sessionMs = Date.now() - joinTs;
    // VAD가 active 상태였다면 마무리
    if (vadActiveSince > 0) {
      activeMs += Date.now() - vadActiveSince;
      vadActiveSince = 0;
    }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (speakingTimer) { clearInterval(speakingTimer); speakingTimer = null; }
    await api('/api/attendance/leave', {
      room_id: roomId,
      user_id: getUserId(),
      total_active_ms: activeMs,
      total_session_ms: sessionMs,
      disconnect_count: disconnectCount,
      status: 'left'
    });
    attendanceId = null;
  }
  M.startAttendance = startAttendance;
  M.endAttendance = endAttendance;

  // ===== VAD (Voice Activity Detection) =====
  function startVAD(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      vadAudioCtx = new AC();
      vadSource = vadAudioCtx.createMediaStreamSource(stream);
      vadAnalyzer = vadAudioCtx.createAnalyser();
      vadAnalyzer.fftSize = 512;
      vadSource.connect(vadAnalyzer);
      const buf = new Uint8Array(vadAnalyzer.fftSize);
      vadLastTs = performance.now();

      const VAD_THRESHOLD = 18; // 0~128 (RMS)
      function tick() {
        vadAnalyzer.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i] - 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const isActive = rms > VAD_THRESHOLD;
        if (isActive && vadActiveSince === 0) {
          vadActiveSince = Date.now();
        } else if (!isActive && vadActiveSince > 0) {
          activeMs += Date.now() - vadActiveSince;
          vadActiveSince = 0;
        }
        vadRafId = requestAnimationFrame(tick);
      }
      tick();

      // 60초마다 서버에 발화 시간 전송
      speakingTimer = setInterval(() => {
        const ms = activeMs + (vadActiveSince > 0 ? (Date.now() - vadActiveSince) : 0);
        api('/api/speaking-time', {
          room_id: (typeof vcRoomId!=="undefined"?vcRoomId:""),
          user_id: getUserId(),
          total_active_ms: ms,
          total_session_ms: Date.now() - joinTs
        });
      }, 60000);
    } catch (e) {
      console.warn('VAD start failed', e);
    }
  }

  function stopVAD() {
    if (vadRafId) cancelAnimationFrame(vadRafId);
    vadRafId = null;
    if (vadSource) try { vadSource.disconnect(); } catch (_) {}
    if (vadAudioCtx) try { vadAudioCtx.close(); } catch (_) {}
    vadAudioCtx = null;
    vadAnalyzer = null;
    vadSource = null;
  }
  M.startVAD = startVAD;
  M.stopVAD = stopVAD;

  // ===== 비상 카카오 버튼 =====
  async function showKakaoButton() {
    if (kakaoBtnEl) return;
    const teachers = await api('/api/kakao-id/teachers');
    const list = (teachers || []).filter(t => t.kakao_id);
    if (list.length === 0) {
      // 등록된 교사 카카오 ID 없음 — 안내만
      alert('연결이 끊겼습니다. 카카오 ID가 등록된 교사가 없어 비상 연락처를 표시할 수 없습니다.');
      return;
    }

    kakaoBtnEl = document.createElement('div');
    kakaoBtnEl.id = 'mango-kakao-btn';
    kakaoBtnEl.innerHTML = `
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                  background:#fff;border-radius:16px;padding:24px;z-index:99999;
                  box-shadow:0 10px 40px rgba(0,0,0,0.3);max-width:90%;width:360px;
                  font-family:-apple-system,'맑은 고딕',sans-serif;">
        <div style="text-align:center;font-size:48px;margin-bottom:8px;">⚠️</div>
        <h3 style="text-align:center;margin:0 0 8px;color:#dc2626;">연결이 끊어졌습니다</h3>
        <p style="text-align:center;color:#6b7280;font-size:14px;margin:0 0 16px;">
          아래 버튼으로 교사에게 카카오톡으로 연락하세요.
        </p>
        <div id="mango-teacher-list" style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;"></div>
        <button onclick="MangoV3.hideKakaoButton()"
          style="width:100%;margin-top:12px;padding:10px;border:none;border-radius:8px;background:#e5e7eb;cursor:pointer;">
          닫기
        </button>
      </div>
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;"
           onclick="MangoV3.hideKakaoButton()"></div>
    `;
    document.body.appendChild(kakaoBtnEl);

    const listEl = kakaoBtnEl.querySelector('#mango-teacher-list');
    list.forEach(t => {
      const btn = document.createElement('a');
      btn.href = `https://qr.kakao.com/talk/${encodeURIComponent(t.kakao_id)}`;
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px;background:#fee500;border-radius:8px;text-decoration:none;color:#000;font-weight:600;';
      btn.innerHTML = `<span style="font-size:24px;">💬</span>
        <div style="flex:1;"><div>${t.username || '교사'}</div>
        <div style="font-size:12px;color:#666;font-weight:400;">${t.kakao_id}</div></div>`;
      btn.onclick = () => {
        api('/api/emergency', {
          room_id: (typeof vcRoomId!=="undefined"?vcRoomId:""),
          user_id: getUserId(),
          target_user_id: t.user_id,
          event_type: 'kakao_button',
          meta: { teacher_kakao: t.kakao_id }
        });
      };
      listEl.appendChild(btn);
    });

    // 이벤트 로깅
    api('/api/emergency', {
      room_id: (typeof vcRoomId!=="undefined"?vcRoomId:""),
      user_id: getUserId(),
      event_type: 'kakao_shown'
    });
  }

  function hideKakaoButton() {
    if (kakaoBtnEl) { kakaoBtnEl.remove(); kakaoBtnEl = null; }
  }
  M.showKakaoButton = showKakaoButton;
  M.hideKakaoButton = hideKakaoButton;

  // 연결 상태 모니터링: 30초간 disconnected이면 자동 표시
  function onConnectionState(state) {
    if (state === 'disconnected' || state === 'failed') {
      disconnectCount++;
      if (!disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          if (getRole() === 'student') showKakaoButton();
        }, 30000);
      }
    } else if (state === 'connected') {
      if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    }
  }
  M.onConnectionState = onConnectionState;

  // ===== 보상 UI (교사용) =====
  function showRewardWidget(roomMembers) {
    if (getRole() !== 'teacher') return;
    if (rewardWidgetEl) rewardWidgetEl.remove();

    const members = (roomMembers || []).filter(u => u.userId !== (typeof vcUserId!=="undefined"?vcUserId:""));
    if (members.length === 0) {
      alert('보상을 줄 학생이 없습니다.');
      return;
    }

    rewardWidgetEl = document.createElement('div');
    rewardWidgetEl.innerHTML = `
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                  background:#fff;border-radius:16px;padding:24px;z-index:99999;
                  box-shadow:0 10px 40px rgba(0,0,0,0.3);width:380px;max-width:90%;
                  font-family:-apple-system,'맑은 고딕',sans-serif;">
        <h3 style="margin:0 0 16px;">🎁 보상 발급</h3>
        <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">학생 선택</label>
        <select id="mango-rwd-student" style="width:100%;padding:8px;margin-bottom:12px;border:1px solid #d1d5db;border-radius:6px;">
          ${members.map(m => `<option value="${m.userId}">${m.username || m.userId}</option>`).join('')}
        </select>
        <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">유형</label>
        <select id="mango-rwd-type" style="width:100%;padding:8px;margin-bottom:12px;border:1px solid #d1d5db;border-radius:6px;">
          <option value="sticker">⭐ 스티커</option>
          <option value="coupon">🎟️ 쿠폰</option>
          <option value="badge">🏅 뱃지</option>
        </select>
        <label style="display:block;font-size:13px;color:#6b7280;margin-bottom:4px;">메시지 (선택)</label>
        <input id="mango-rwd-msg" type="text" placeholder="잘했어요!" style="width:100%;padding:8px;margin-bottom:16px;border:1px solid #d1d5db;border-radius:6px;">
        <div style="display:flex;gap:8px;">
          <button onclick="MangoV3.hideRewardWidget()" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;">취소</button>
          <button onclick="MangoV3.submitReward()" style="flex:2;padding:10px;border:none;border-radius:8px;background:#f59e0b;color:#fff;font-weight:600;cursor:pointer;">발급</button>
        </div>
        <div id="mango-rwd-feedback" style="margin-top:8px;font-size:12px;text-align:center;"></div>
      </div>
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;"
           onclick="MangoV3.hideRewardWidget()"></div>
    `;
    document.body.appendChild(rewardWidgetEl);
  }
  function hideRewardWidget() {
    if (rewardWidgetEl) { rewardWidgetEl.remove(); rewardWidgetEl = null; }
  }
  async function submitReward() {
    const studentId = document.getElementById('mango-rwd-student').value;
    const type = document.getElementById('mango-rwd-type').value;
    const message = document.getElementById('mango-rwd-msg').value;
    const fb = document.getElementById('mango-rwd-feedback');
    fb.textContent = '발급 중...';
    fb.style.color = '#6b7280';
    const res = await api('/api/reward', {
      teacher_id: getUserId(),
      student_id: studentId,
      room_id: (typeof vcRoomId!=="undefined"?vcRoomId:""),
      type, message
    });
    if (res?.ok) {
      fb.style.color = '#10b981';
      fb.textContent = `✓ 발급 완료 (오늘 남은 횟수: ${res.daily_remaining})`;
      // 학생에게 채팅으로 알림
      try {
        const conn = (typeof vcConn !== "undefined" ? vcConn : null);
        if (conn && conn.readyState === 1) {
          conn.send(JSON.stringify({
            type: 'chat-message',
            data: { username: '시스템', message: `🎁 ${type === 'sticker' ? '스티커' : type === 'coupon' ? '쿠폰' : '뱃지'} 보상이 지급되었습니다! ${message ? '— ' + message : ''}` }
          }));
        }
      } catch (_) {}
      setTimeout(hideRewardWidget, 1500);
    } else {
      fb.style.color = '#dc2626';
      fb.textContent = res?.error === 'daily_limit_exceeded'
        ? `오늘 발급 한도(${res.limit}회)를 초과했습니다.`
        : '발급 실패';
    }
  }
  M.showRewardWidget = showRewardWidget;
  M.hideRewardWidget = hideRewardWidget;
  M.submitReward = submitReward;

  // ===== 학생용 보상함 =====
  async function showMyRewards() {
    const list = await api(`/api/rewards/student/${encodeURIComponent(getUserId())}`);
    const items = list || [];
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                  background:#fff;border-radius:16px;padding:24px;z-index:99999;
                  box-shadow:0 10px 40px rgba(0,0,0,0.3);width:380px;max-width:90%;
                  font-family:-apple-system,'맑은 고딕',sans-serif;">
        <h3 style="margin:0 0 16px;">🎁 내 보상함 (${items.length}개)</h3>
        <div style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;">
          ${items.length === 0 ? '<p style="text-align:center;color:#9ca3af;">아직 받은 보상이 없어요</p>'
            : items.map(r => `
              <div style="padding:12px;background:#fef3c7;border-radius:8px;">
                <div style="font-weight:600;">${r.type === 'sticker' ? '⭐ 스티커' : r.type === 'coupon' ? '🎟️ 쿠폰' : '🏅 뱃지'}</div>
                ${r.message ? `<div style="font-size:13px;color:#92400e;margin-top:4px;">"${r.message}"</div>` : ''}
                <div style="font-size:11px;color:#9ca3af;margin-top:4px;">${new Date(r.issued_at).toLocaleDateString('ko-KR')}</div>
              </div>
            `).join('')}
        </div>
        <button onclick="this.parentElement.parentElement.remove()" style="width:100%;margin-top:12px;padding:10px;border:none;border-radius:8px;background:#e5e7eb;cursor:pointer;">닫기</button>
      </div>
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;"
           onclick="this.parentElement.remove()"></div>
    `;
    document.body.appendChild(el);
  }
  M.showMyRewards = showMyRewards;

  // ===== 카카오 ID 등록 (교사용) =====
  function showKakaoIdSetup() {
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                  background:#fff;border-radius:16px;padding:24px;z-index:99999;
                  box-shadow:0 10px 40px rgba(0,0,0,0.3);width:380px;max-width:90%;
                  font-family:-apple-system,'맑은 고딕',sans-serif;">
        <h3 style="margin:0 0 8px;">💬 비상 연락처 등록</h3>
        <p style="font-size:13px;color:#6b7280;margin:0 0 16px;">
          학생이 연결 끊김 시 이 카카오 ID로 연락할 수 있습니다.
        </p>
        <label style="display:block;font-size:13px;margin-bottom:4px;">이름</label>
        <input id="mango-kk-name" type="text" style="width:100%;padding:8px;margin-bottom:12px;border:1px solid #d1d5db;border-radius:6px;">
        <label style="display:block;font-size:13px;margin-bottom:4px;">카카오톡 ID</label>
        <input id="mango-kk-id" type="text" placeholder="예: mango_teacher" style="width:100%;padding:8px;margin-bottom:16px;border:1px solid #d1d5db;border-radius:6px;">
        <div style="display:flex;gap:8px;">
          <button onclick="this.parentElement.parentElement.parentElement.remove()" style="flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;">취소</button>
          <button onclick="MangoV3._saveKakao()" style="flex:2;padding:10px;border:none;border-radius:8px;background:#fee500;font-weight:600;cursor:pointer;">저장</button>
        </div>
      </div>
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99998;"
           onclick="this.parentElement.remove()"></div>
    `;
    document.body.appendChild(el);
  }
  M.showKakaoIdSetup = showKakaoIdSetup;
  M._saveKakao = async function () {
    const name = document.getElementById('mango-kk-name').value.trim();
    const kid = document.getElementById('mango-kk-id').value.trim();
    if (!kid) { alert('카카오 ID를 입력하세요'); return; }
    const res = await api('/api/kakao-id', {
      user_id: getUserId(),
      role: getRole(),
      username: name,
      kakao_id: kid
    });
    if (res?.ok) {
      alert('등록되었습니다');
      document.querySelectorAll('div').forEach(d => {
        if (d.querySelector && d.querySelector('#mango-kk-id')) {
          d.parentElement && d.parentElement.remove();
        }
      });
    }
  };

  // ===== 로비 UI 강화 =====
  function injectLobbyUI() {
    const lobby = document.getElementById('view-videocall-lobby');
    if (!lobby || lobby.querySelector('#mango-lobby-extra')) return;
    const lobbyBox = lobby.querySelector('.lobby-box');
    if (!lobbyBox) return;

    const extra = document.createElement('div');
    extra.id = 'mango-lobby-extra';
    extra.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb;';
    extra.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;font-size:14px;">
        <span>역할:</span>
        <label><input type="radio" name="mango-role" value="student" ${getRole()==='student'?'checked':''}> 학생</label>
        <label><input type="radio" name="mango-role" value="teacher" ${getRole()==='teacher'?'checked':''}> 교사</label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" onclick="MangoV3.showMyRewards()" style="flex:1;padding:8px;border:1px solid #f59e0b;border-radius:6px;background:#fff;color:#f59e0b;cursor:pointer;font-size:13px;">🎁 내 보상함</button>
        <button type="button" onclick="MangoV3.showKakaoIdSetup()" style="flex:1;padding:8px;border:1px solid #fee500;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;">💬 카카오 등록</button>
      </div>
      <div style="text-align:center;margin-top:8px;display:flex;justify-content:center;gap:12px;">
        <a href="/admin" target="_blank" style="font-size:12px;color:#6b7280;">📊 관리 대시보드</a>
        <a href="javascript:MangoV3.showConsentModal()" style="font-size:12px;color:#6b7280;">📝 동의 변경</a>
        <a href="javascript:MangoV3.withdrawConsent()" style="font-size:12px;color:#dc2626;">동의 철회</a>
      </div>
    `;
    lobbyBox.appendChild(extra);

    extra.querySelectorAll('input[name="mango-role"]').forEach(el => {
      el.onchange = (e) => setRole(e.target.value);
    });
  }

  // ===== 통화 화면 툴바 (교사: 보상 / 학생: SOS) =====
  function injectCallToolbar() {
    const toolbar = document.querySelector('#view-videocall-call .toolbar-center');
    if (!toolbar) return;
    // 학생: SOS 버튼
    if (getRole() === 'student' && !toolbar.querySelector('#mango-sos-btn')) {
      const sos = document.createElement('button');
      sos.id = 'mango-sos-btn';
      sos.className = 'ctrl-btn on';
      sos.title = '교사에게 카카오로 연락';
      sos.textContent = '🆘';
      sos.style.background = '#fee500';
      sos.onclick = showKakaoButton;
      toolbar.appendChild(sos);
    }
    if (toolbar.querySelector('#mango-rwd-btn')) return;
    if (getRole() !== 'teacher') return;
    const btn = document.createElement('button');
    btn.id = 'mango-rwd-btn';
    btn.className = 'ctrl-btn on';
    btn.title = '보상 발급';
    btn.textContent = '🎁';
    btn.onclick = () => {
      // 현재 방 멤버 = 본인 + vcPeerConnections 키들
      const members = Object.keys((typeof vcPeerConnections!=="undefined"?vcPeerConnections:{}) || {}).map(uid => ({
        userId: uid,
        username: (document.getElementById(`vc-label-${uid}`)?.textContent) || uid
      }));
      showRewardWidget(members);
    };
    toolbar.appendChild(btn);
  }

  // ===== 동의(Consent) =====
  const CONSENT_VERSION = 'v1.0';

  async function hasValidConsent() {
    // 로컬 캐시 우선
    const local = localStorage.getItem('mango_consent');
    if (local) {
      try {
        const c = JSON.parse(local);
        if (c.version === CONSENT_VERSION) return c;
      } catch (_) {}
    }
    // 서버 조회
    const server = await api(`/api/consents/${encodeURIComponent(getUserId())}`);
    if (server && server.consent_version === CONSENT_VERSION) {
      localStorage.setItem('mango_consent', JSON.stringify({
        version: server.consent_version,
        consented_at: server.consented_at,
        items: {
          recording: !!server.recording_consent,
          voice_analysis: !!server.voice_analysis_consent,
          attendance: !!server.attendance_consent,
          reward: !!server.reward_consent,
          kakao: !!server.kakao_consent
        }
      }));
      return server;
    }
    return null;
  }

  function showConsentModal() {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.id = 'mango-consent-modal';
      el.innerHTML = `
        <div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99998;"></div>
        <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
                    background:#fff;border-radius:16px;padding:28px;z-index:99999;
                    width:480px;max-width:92%;max-height:90vh;overflow-y:auto;
                    box-shadow:0 20px 60px rgba(0,0,0,0.3);
                    font-family:-apple-system,'맑은 고딕','Malgun Gothic',sans-serif;">
          <h2 style="margin:0 0 4px;font-size:20px;">개인정보 수집·이용 동의</h2>
          <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">
            망고아이 화상 시스템 v3.0 · 동의 버전 ${CONSENT_VERSION}<br>
            서비스 이용을 위해 아래 항목에 동의해 주세요.
          </p>

          <div style="background:#f9fafb;border-radius:8px;padding:12px;margin-bottom:16px;">
            <label style="display:block;font-size:13px;margin-bottom:4px;color:#374151;font-weight:600;">학생 나이 (만)</label>
            <input id="mango-cns-age" type="number" min="5" max="100" value="14"
                   style="width:80px;padding:6px;border:1px solid #d1d5db;border-radius:6px;">
            <span id="mango-cns-age-warn" style="margin-left:8px;font-size:12px;color:#dc2626;display:none;">
              ⚠ 만 14세 미만은 법정대리인 동의 필요
            </span>
          </div>

          <div id="mango-cns-items" style="display:flex;flex-direction:column;gap:10px;">
            ${[
              ['recording', '수업 영상 자동 녹화', '대상: 학생 본인(만 14세 이상) / 법정대리인 · 보관: 1개월 후 자동 파기'],
              ['voice_analysis', '음성 분석(말하기 참여도)', '원음은 즉시 폐기, 분석 결과만 보관'],
              ['attendance', '출결 기록 보관', '수강 종료 후 3년 보관 후 자동 파기'],
              ['reward', '보상(쿠폰/스티커) 사용 내역', '전자상거래법 5년 보관'],
              ['kakao', '비상 카카오 연결용 ID', '탈퇴 시 즉시 파기 · 별도 옵트인']
            ].map(([k, t, d]) => `
              <label style="display:flex;align-items:flex-start;gap:10px;padding:10px;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;">
                <input type="checkbox" data-cns="${k}" style="margin-top:3px;width:18px;height:18px;">
                <div style="flex:1;">
                  <div style="font-weight:600;font-size:14px;">${t} <span style="color:#dc2626;">*</span></div>
                  <div style="font-size:12px;color:#6b7280;margin-top:2px;">${d}</div>
                </div>
              </label>
            `).join('')}
          </div>

          <div style="display:flex;gap:6px;margin-top:14px;">
            <button id="mango-cns-all" style="flex:1;padding:8px;border:1px solid #f59e0b;background:#fff;color:#f59e0b;border-radius:6px;cursor:pointer;font-size:13px;">전체 동의</button>
            <button id="mango-cns-clear" style="flex:1;padding:8px;border:1px solid #e5e7eb;background:#fff;color:#6b7280;border-radius:6px;cursor:pointer;font-size:13px;">전체 해제</button>
          </div>

          <div style="margin-top:16px;padding:12px;background:#fef3c7;border-radius:8px;font-size:12px;color:#92400e;">
            ※ 동의 후에도 마이페이지에서 언제든 철회할 수 있으며, 철회 시 관련 데이터는 즉시 파기됩니다.<br>
            ※ 필수 항목 미동의 시 일부 서비스(녹화·발화 측정·보상 등)가 제한될 수 있습니다.
          </div>

          <div style="display:flex;gap:8px;margin-top:18px;">
            <button id="mango-cns-cancel" style="flex:1;padding:12px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">취소</button>
            <button id="mango-cns-submit" style="flex:2;padding:12px;border:none;background:#f59e0b;color:#fff;border-radius:8px;cursor:pointer;font-weight:600;">동의하고 계속</button>
          </div>
        </div>
      `;
      document.body.appendChild(el);

      const ageInput = el.querySelector('#mango-cns-age');
      const ageWarn = el.querySelector('#mango-cns-age-warn');
      ageInput.oninput = () => {
        const v = parseInt(ageInput.value, 10);
        ageWarn.style.display = (v && v < 14) ? 'inline' : 'none';
      };

      el.querySelector('#mango-cns-all').onclick = () => {
        el.querySelectorAll('input[data-cns]').forEach(i => i.checked = true);
      };
      el.querySelector('#mango-cns-clear').onclick = () => {
        el.querySelectorAll('input[data-cns]').forEach(i => i.checked = false);
      };
      el.querySelector('#mango-cns-cancel').onclick = () => {
        el.remove();
        resolve(null);
      };
      el.querySelector('#mango-cns-submit').onclick = async () => {
        const items = {};
        el.querySelectorAll('input[data-cns]').forEach(i => {
          items[i.dataset.cns] = i.checked;
        });
        // 최소 출결은 동의해야 시스템 사용 가능
        if (!items.attendance) {
          alert('출결 기록 보관에는 동의해야 화상수업을 이용할 수 있습니다.');
          return;
        }
        const age = parseInt(ageInput.value, 10) || 0;
        const guardianRequired = age > 0 && age < 14;
        if (guardianRequired) {
          const ok = confirm('만 14세 미만은 법정대리인 동의가 필요합니다.\n\n현재는 우선 잠정 동의로 처리되며, 추후 보호자 동의 절차가 진행될 예정입니다.\n계속하시겠습니까?');
          if (!ok) return;
        }

        const payload = {
          user_id: getUserId(),
          username: (typeof vcUsername !== "undefined" ? vcUsername : null),
          role: getRole(),
          consent_version: CONSENT_VERSION,
          recording: items.recording,
          voice_analysis: items.voice_analysis,
          attendance: items.attendance,
          reward: items.reward,
          kakao: items.kakao,
          guardian_required: guardianRequired,
          guardian_status: guardianRequired ? 'provisional' : 'not_required',
          age: age
        };
        const res = await api('/api/consents', payload);
        if (res?.ok) {
          localStorage.setItem('mango_consent', JSON.stringify({
            version: CONSENT_VERSION,
            consented_at: res.consented_at,
            items
          }));
          el.remove();
          resolve({ ok: true, items });
        } else {
          alert('동의 저장에 실패했습니다. 다시 시도해주세요.');
        }
      };
    });
  }

  async function ensureConsent() {
    const existing = await hasValidConsent();
    if (existing) return existing;
    return await showConsentModal();
  }
  M.ensureConsent = ensureConsent;
  M.showConsentModal = showConsentModal;
  M.withdrawConsent = async function () {
    if (!confirm('모든 동의를 철회하시겠습니까? 관련 데이터(출결·발화 분석·보상 내역 등)는 즉시 파기 처리됩니다.')) return;
    await api('/api/consents/withdraw', { user_id: getUserId() });
    localStorage.removeItem('mango_consent');
    alert('동의가 철회되었습니다.');
  };

  // ===== 기존 vcJoinRoom / vcLeaveRoom 래핑 =====
  // 주의: vcJoinRoom/vcLeaveRoom은 함수 선언으로 정의돼 있어 window에 노출됨.
  function wrap() {
    if (typeof window.vcJoinRoom === 'function' && !window._mangoWrapped) {
      const origJoin = window.vcJoinRoom;
      window.vcJoinRoom = async function () {
        // 입장 전 동의 확인
        const consent = await ensureConsent();
        if (!consent) {
          alert('서비스 이용을 위해 동의가 필요합니다.');
          return;
        }
        await origJoin.apply(this, arguments);
        setTimeout(async () => {
          const rid = (typeof vcRoomId !== "undefined" ? vcRoomId : "");
          const uname = (typeof vcUsername !== "undefined" ? vcUsername : "");
          const stream = (typeof vcLocalStream !== "undefined" ? vcLocalStream : null);
          await startAttendance(rid, uname);
          if (stream) startVAD(stream);
          injectCallToolbar();
        }, 500);
      };

      const origLeave = window.vcLeaveRoom;
      window.vcLeaveRoom = async function () {
        const rid = (typeof vcRoomId !== "undefined" ? vcRoomId : "");
        try { await endAttendance(rid); } catch (_) {}
        stopVAD();
        hideKakaoButton();
        const btn = document.getElementById('mango-rwd-btn');
        if (btn) btn.remove();
        return origLeave && origLeave.apply(this, arguments);
      };

      window._mangoWrapped = true;
    }
  }

  // 페이지 unload 시 출석 종료
  window.addEventListener('beforeunload', () => {
    if (attendanceId) {
      // 동기 전송 (sendBeacon)
      const data = JSON.stringify({
        room_id: (typeof vcRoomId!=="undefined"?vcRoomId:""),
        user_id: getUserId(),
        total_active_ms: activeMs,
        total_session_ms: Date.now() - joinTs,
        disconnect_count: disconnectCount,
        status: 'closed'
      });
      navigator.sendBeacon('/api/attendance/leave', new Blob([data], { type: 'application/json' }));
    }
  });

  // 초기화
  function init() {
    injectLobbyUI();
    wrap();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // 늦게 로드되는 함수들을 위해 한번 더 시도
  setTimeout(() => { wrap(); injectLobbyUI(); }, 1000);
  setTimeout(() => { wrap(); injectLobbyUI(); }, 3000);
})();
