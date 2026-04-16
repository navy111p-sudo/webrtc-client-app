/**
 * WebRTCShare — 화면 공유 + DataChannel 동기화 모듈
 *
 * 사용법:
 *   HTML:
 *     <script src="webrtc-share-sync.js"></script>
 *     <button id="screenShareBtn">🖥️ 화면 공유</button>
 *     <video id="sharedVideo" autoplay playsinline></video>
 *
 *   JS (방을 만든 쪽 — offer 쪽):
 *     const pc = new RTCPeerConnection(config);
 *     WebRTCShare.createDataChannel(pc, userId);
 *
 *   JS (받는 쪽 — answer 쪽):
 *     const pc = new RTCPeerConnection(config);
 *     WebRTCShare.listenForDataChannel(pc, userId);
 *
 *   자동 바인딩:
 *     window.addEventListener('DOMContentLoaded', WebRTCShare.wireUpControls);
 */
const WebRTCShare = (() => {

    /* ── 상태 ── */
    let screenStream = null;       // getDisplayMedia 스트림
    let sharing = false;           // 현재 공유 중?
    const dataChannels = {};       // { peerId: RTCDataChannel }
    let localStream = null;        // 복원용 카메라 스트림 참조
    let peerConnections = {};      // 외부 PC 맵 참조

    /* ── DataChannel 이름 ── */
    const CH_NAME = 'share-sync';

    /* ──────────────────────────────
       1. DataChannel 생성 / 수신
    ────────────────────────────── */

    /**
     * 방을 만든(offer) 쪽에서 호출.
     * DataChannel을 생성하고 메시지 핸들러를 등록합니다.
     */
    function createDataChannel(pc, peerId) {
        if (!pc || pc.connectionState === 'closed') return;
        try {
            const ch = pc.createDataChannel(CH_NAME);
            _setupChannel(ch, peerId);
            console.log('[WebRTCShare] DataChannel 생성:', peerId);
        } catch (e) {
            console.warn('[WebRTCShare] createDataChannel 실패:', peerId, e);
        }
    }

    /**
     * 받는(answer) 쪽에서 호출.
     * ondatachannel 이벤트를 리슨하여 수신된 채널에 핸들러를 등록합니다.
     */
    function listenForDataChannel(pc, peerId) {
        if (!pc) return;
        pc.addEventListener('datachannel', (event) => {
            if (event.channel.label === CH_NAME) {
                _setupChannel(event.channel, peerId);
                console.log('[WebRTCShare] DataChannel 수신:', peerId);
            }
        });
    }

    /** 채널 공통 셋업 */
    function _setupChannel(ch, peerId) {
        dataChannels[peerId] = ch;

        ch.onopen = () => {
            console.log('[WebRTCShare] channel open:', peerId);
            // 현재 공유 중이면 새 피어에게 알림
            if (sharing) {
                _sendTo(ch, { type: 'share-started' });
            }
        };

        ch.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                _handleMessage(msg, peerId);
            } catch (e) {
                console.warn('[WebRTCShare] 메시지 파싱 실패:', e);
            }
        };

        ch.onclose = () => {
            console.log('[WebRTCShare] channel close:', peerId);
            delete dataChannels[peerId];
        };

        ch.onerror = (e) => {
            console.warn('[WebRTCShare] channel error:', peerId, e);
        };
    }

    /** 메시지 수신 처리 */
    function _handleMessage(msg, fromPeerId) {
        switch (msg.type) {
            case 'share-started':
                console.log('[WebRTCShare] 상대방 화면 공유 시작:', fromPeerId);
                _showSharedVideo(fromPeerId);
                break;

            case 'share-stopped':
                console.log('[WebRTCShare] 상대방 화면 공유 종료:', fromPeerId);
                _hideSharedVideo();
                break;
        }
    }

    /* ──────────────────────────────
       2. 화면 공유 시작 / 중지
    ────────────────────────────── */

    async function startShare() {
        if (sharing) { stopShare(); return; }

        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: true
            });
            sharing = true;

            const screenTrack = screenStream.getVideoTracks()[0];

            // 로컬 프리뷰
            const localVid = document.getElementById('vc-local-video');
            if (localVid) {
                localVid.srcObject = screenStream;
            }
            const localLabel = document.getElementById('vc-local-label');
            if (localLabel) {
                localLabel.textContent = (window.vcUsername || '나') + ' (화면 공유)';
            }

            // 모든 PeerConnection의 video sender를 화면 트랙으로 교체
            const pcs = window.vcPeerConnections || peerConnections;
            Object.keys(pcs).forEach(uid => {
                const pc = pcs[uid];
                if (!pc || pc.connectionState === 'closed') return;
                const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(screenTrack).catch(e =>
                        console.warn('[WebRTCShare] replaceTrack 실패:', uid, e)
                    );
                }
            });

            // DataChannel로 "공유 시작" 알림
            _broadcast({ type: 'share-started' });

            // 버튼 상태
            _updateBtn(true);

            // 사용자가 브라우저에서 "공유 중지" 클릭 시
            screenTrack.onended = () => stopShare();

            console.log('[WebRTCShare] 화면 공유 시작');
        } catch (e) {
            console.warn('[WebRTCShare] 화면 공유 취소/실패:', e);
        }
    }

    function stopShare() {
        if (!sharing) return;
        sharing = false;

        // 화면 공유 스트림 정리
        if (screenStream) {
            screenStream.getTracks().forEach(t => t.stop());
            screenStream = null;
        }

        // 카메라로 복원
        const camStream = window.vcLocalStream || localStream;
        if (camStream) {
            const localVid = document.getElementById('vc-local-video');
            if (localVid) localVid.srcObject = camStream;

            const localLabel = document.getElementById('vc-local-label');
            if (localLabel) {
                localLabel.textContent = (window.vcUsername || '나') + ' (나)';
            }

            const camTrack = camStream.getVideoTracks()[0];
            if (camTrack) {
                const pcs = window.vcPeerConnections || peerConnections;
                Object.keys(pcs).forEach(uid => {
                    const pc = pcs[uid];
                    if (!pc || pc.connectionState === 'closed') return;
                    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        videoSender.replaceTrack(camTrack).catch(e =>
                            console.warn('[WebRTCShare] 카메라 복원 실패:', uid, e)
                        );
                    }
                });
            }
        }

        // DataChannel로 "공유 종료" 알림
        _broadcast({ type: 'share-stopped' });

        // 공유 비디오 숨기기
        _hideSharedVideo();

        // 버튼 상태 복원
        _updateBtn(false);

        console.log('[WebRTCShare] 화면 공유 종료');
    }

    /* ──────────────────────────────
       3. 공유 비디오 표시 / 숨김
    ────────────────────────────── */

    function _showSharedVideo(fromPeerId) {
        const sharedVid = document.getElementById('sharedVideo');
        if (!sharedVid) return;

        // 해당 피어의 원격 비디오에서 스트림 가져오기
        const remoteVid = document.querySelector(`#vc-video-${fromPeerId} video`);
        if (remoteVid && remoteVid.srcObject) {
            sharedVid.srcObject = remoteVid.srcObject;
            sharedVid.play().catch(() => {});
        }

        sharedVid.style.display = 'block';

        // 컨테이너도 표시
        const container = document.getElementById('sharedVideoContainer');
        if (container) container.style.display = 'block';
    }

    function _hideSharedVideo() {
        const sharedVid = document.getElementById('sharedVideo');
        if (sharedVid) {
            sharedVid.srcObject = null;
            sharedVid.style.display = 'none';
        }
        const container = document.getElementById('sharedVideoContainer');
        if (container) container.style.display = 'none';
    }

    /* ──────────────────────────────
       4. UI 바인딩
    ────────────────────────────── */

    /** DOMContentLoaded 후 호출 — 버튼에 이벤트 바인딩 */
    function wireUpControls() {
        const btn = document.getElementById('screenShareBtn');
        if (btn) {
            btn.addEventListener('click', () => startShare());
            console.log('[WebRTCShare] screenShareBtn 바인딩 완료');
        }

        // sharedVideo 초기 숨김
        const sharedVid = document.getElementById('sharedVideo');
        if (sharedVid) sharedVid.style.display = 'none';

        const container = document.getElementById('sharedVideoContainer');
        if (container) container.style.display = 'none';
    }

    function _updateBtn(isSharing) {
        // 툴바 버튼 (기존)
        const toolbarBtn = document.getElementById('vc-btn-screen');
        if (toolbarBtn) {
            toolbarBtn.className = isSharing ? 'ctrl-btn off' : 'ctrl-btn on';
            toolbarBtn.textContent = isSharing ? '⏹️' : '🖥️';
            toolbarBtn.title = isSharing ? '공유 중지' : '화면 공유';
        }
        // screenShareBtn (새로 추가된)
        const shareBtn = document.getElementById('screenShareBtn');
        if (shareBtn) {
            shareBtn.textContent = isSharing ? '⏹️ 공유 중지' : '🖥️ 화면 공유';
            shareBtn.classList.toggle('sharing', isSharing);
        }
    }

    /* ──────────────────────────────
       5. 유틸리티
    ────────────────────────────── */

    function _broadcast(msg) {
        const data = JSON.stringify(msg);
        Object.keys(dataChannels).forEach(pid => {
            const ch = dataChannels[pid];
            if (ch && ch.readyState === 'open') {
                try { ch.send(data); } catch (e) {
                    console.warn('[WebRTCShare] 전송 실패:', pid, e);
                }
            }
        });
    }

    function _sendTo(ch, msg) {
        if (ch && ch.readyState === 'open') {
            try { ch.send(JSON.stringify(msg)); } catch (e) {}
        }
    }

    /** 피어 제거 시 채널 정리 */
    function removePeer(peerId) {
        if (dataChannels[peerId]) {
            try { dataChannels[peerId].close(); } catch (_) {}
            delete dataChannels[peerId];
        }
    }

    /** 전체 정리 (방 나갈 때) */
    function cleanup() {
        if (sharing) stopShare();
        Object.keys(dataChannels).forEach(pid => {
            try { dataChannels[pid].close(); } catch (_) {}
        });
        Object.keys(dataChannels).forEach(k => delete dataChannels[k]);
        screenStream = null;
        sharing = false;
    }

    /* ── 외부 참조 설정 ── */
    function setLocalStream(stream) { localStream = stream; }
    function setPeerConnections(pcs) { peerConnections = pcs; }

    /* ── Public API ── */
    return {
        createDataChannel,
        listenForDataChannel,
        wireUpControls,
        startShare,
        stopShare,
        removePeer,
        cleanup,
        setLocalStream,
        setPeerConnections,
        get isSharing() { return sharing; }
    };

})();
