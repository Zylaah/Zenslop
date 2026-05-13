// Chrome-process side. Receives the WebRTC offer from the content actor and
// hands the resulting MediaStream to the chrome window's ZenPiPController.
//
// Reliability: any signal that the source is gone (ICE failure, track end,
// explicit child stop, actor destroy) routes through _handleStop so the UI
// hides immediately instead of leaving a frozen frame.

export class ZenSidebarPiPParent extends JSWindowActorParent {
  async receiveMessage(msg) {
    if (msg.name === "ZenPiP:Debug") {
      console.log(...(msg.data?.args || []));
      return;
    }
    console.log("[Zenslop/parent]", msg.name);
    const win = this.browsingContext.topChromeWindow;
    if (!win) return;

    switch (msg.name) {
      case "ZenPiP:Offer": {
        // Renegotiation from the same actor: drop the old PC before answering.
        if (this._pc) this._closePc();

        const pc = new win.RTCPeerConnection();
        this._pc = pc;
        this._win = win;

        pc.ontrack = (e) => {
          console.log("[Zenslop/parent] ontrack kind=", e.track.kind, "readyState=", e.track.readyState, "muted=", e.track.muted);
          const stream = e.streams[0] || new win.MediaStream([e.track]);
          // If the remote track ends (tab closed, capture stopped), hide.
          e.track.addEventListener("ended", () => this._handleStop());
          // Force the receiver to render frames as soon as they arrive.
          // Without these hints the jitter buffer adapts upward over the
          // first few seconds, which presents as "fps ramping up".
          try {
            if (e.receiver) {
              e.receiver.playoutDelayHint = 0;
              e.receiver.jitterBufferTarget = 0;
            }
          } catch (_) {}
          if (win.ZenPiPController) {
            console.log("[Zenslop/parent] calling showVideo, tracks=", stream.getVideoTracks().length);
            win.ZenPiPController.showVideo(stream, this.browsingContext);
          } else {
            console.log("[Zenslop/parent] ZenPiPController missing on win");
          }
        };

        pc.onicecandidate = (e) => {
          if (!e.candidate) return;
          this.sendAsyncMessage("ZenPiP:IceParent", {
            candidate: e.candidate.toJSON(),
          });
        };

        pc.oniceconnectionstatechange = () => {
          const s = pc.iceConnectionState;
          if (s === "failed" || s === "disconnected" || s === "closed") {
            this._handleStop();
          }
        };

        try {
          await pc.setRemoteDescription(new win.RTCSessionDescription(msg.data.offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendAsyncMessage("ZenPiP:Answer", {
            answer: { type: answer.type, sdp: answer.sdp },
          });
        } catch (e) {
          this._handleStop();
        }
        break;
      }

      case "ZenPiP:IceChild": {
        if (this._pc && msg.data.candidate) {
          try {
            await this._pc.addIceCandidate(new win.RTCIceCandidate(msg.data.candidate));
          } catch (e) {}
        }
        break;
      }

      case "ZenPiP:VideoStopped": {
        this._handleStop();
        break;
      }
    }
  }

  _handleStop() {
    this._closePc();
    const win = this._win;
    if (win && win.ZenPiPController) {
      win.ZenPiPController.hideVideo();
    }
  }

  _closePc() {
    if (this._pc) {
      try {
        this._pc.close();
      } catch (e) {}
      this._pc = null;
    }
  }

  didDestroy() {
    this._handleStop();
  }
}
