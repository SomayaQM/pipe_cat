class PipecatWidget extends HTMLElement {
  constructor() {
      super();
      this.attachShadow({ mode: 'open' });

      // HTML structure
      this.shadowRoot.innerHTML = `
          <style>
              #widget-icon { position: fixed; bottom:20px; right:20px; width:50px; height:50px;
                  background:#4a6bff; border-radius:50%; display:flex; justify-content:center; align-items:center;
                  color:white; font-size:24px; cursor:pointer; z-index:9999; transition:0.3s; box-shadow:0 2px 10px rgba(0,0,0,0.2);}
              #widget-icon:hover { transform: scale(1.1); box-shadow:0 4px 15px rgba(0,0,0,0.3);}
              #widget-container { position:fixed; bottom:20px; right:20px; width:350px; z-index:10000; display:none;}
              #widget-header { background:#4a6bff; color:white; padding:10px 15px; border-radius:10px 10px 0 0;
                  display:flex; justify-content:space-between; align-items:center; cursor:move;}
              #widget-content { background:white; border:1px solid #ddd; border-top:none; border-radius:0 0 10px 10px; padding:15px;}
              .status-indicator { display:inline-block; width:10px; height:10px; border-radius:50%; background:#ccc; margin-left:8px;}
              .status-indicator.connected { background:#4CAF50; box-shadow:0 0 10px #4CAF50;}
              .button-group { display:flex; gap:10px; margin-top:15px;}
              button { padding:8px 15px; border:none; border-radius:5px; cursor:pointer; font-weight:bold;}
              #startAudioBtn { background:#4a6bff; color:white;}
              #stopAudioBtn { background:#f44336; color:white;}
              #minimizeBtn,#closeBtn { background:none; color:white; font-size:16px; padding:0 8px;}
              .hidden { display:none !important;}
          </style>

          <div id="widget-icon">🎤</div>
          <div id="widget-container">
              <div id="widget-header">
                  <div><span>Pipecat Widget</span><span id="statusIndicator" class="status-indicator"></span></div>
                  <div><button id="minimizeBtn">−</button><button id="closeBtn">×</button></div>
              </div>
              <div id="widget-content">
                  <div id="progressText">Loading, please wait...</div>
                  <div class="button-group">
                      <button id="startAudioBtn" disabled>Start Audio</button>
                      <button id="stopAudioBtn" disabled>Stop Audio</button>
                  </div>
              </div>
          </div>
      `;

      this.widget = this.shadowRoot.querySelector('#widget-container');
      this.widgetIcon = this.shadowRoot.querySelector('#widget-icon');
      this.content = this.shadowRoot.querySelector('#widget-content');
      this.startBtn = this.shadowRoot.querySelector('#startAudioBtn');
      this.stopBtn = this.shadowRoot.querySelector('#stopAudioBtn');
      this.minimizeBtn = this.shadowRoot.querySelector('#minimizeBtn');
      this.closeBtn = this.shadowRoot.querySelector('#closeBtn');
      this.statusIndicator = this.shadowRoot.querySelector('#statusIndicator');
      this.progressText = this.shadowRoot.querySelector('#progressText');

      this.SAMPLE_RATE = 16000;
      this.NUM_CHANNELS = 1;
      this.PLAY_TIME_RESET_THRESHOLD_MS = 1.0;
      this.Frame = null;
      this.ws = null;
      this.audioContext = null;
      this.microphoneStream = null;
      this.source = null;
      this.scriptProcessor = null;
      this.playTime = 0;
      this.lastMessageTime = 0;
      this.isPlaying = false;

      this.isDragging = false;
      this.offsetX = 0;
      this.offsetY = 0;
  }

  connectedCallback() {
      const protoUrl = 'https://cdn.jsdelivr.net/gh/SomayaQM/pipe_cat@main/frames.proto';
      protobuf.load(protoUrl, (err, root) => {
          if (err) {
              this.progressText.textContent = 'Error loading protobuf';
              console.error('Proto load error:', err);
              return;
          }
          this.Frame = root.lookupType('pipecat.Frame');
          this.progressText.textContent = 'Ready! Click Start Audio';
          this.startBtn.disabled = false;
      });

      this.widgetIcon.addEventListener('click', () => {
          this.widget.style.display = 'block';
          this.widgetIcon.style.display = 'none';
      });
      this.closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.widget.style.display = 'none';
          this.widgetIcon.style.display = 'flex';
      });
      this.minimizeBtn.addEventListener('click', () => {
          this.content.classList.toggle('hidden');
          this.minimizeBtn.textContent = this.content.classList.contains('hidden') ? '+' : '−';
      });
      this.startBtn.addEventListener('click', () => this.startAudio());
      this.stopBtn.addEventListener('click', () => this.stopAudio(true));

      const header = this.shadowRoot.querySelector('#widget-header');
      header.addEventListener('mousedown', (e) => {
          this.isDragging = true;
          this.offsetX = e.clientX - this.widget.getBoundingClientRect().left;
          this.offsetY = e.clientY - this.widget.getBoundingClientRect().top;
          this.widget.style.cursor = 'grabbing';
      });
      document.addEventListener('mousemove', (e) => {
          if (!this.isDragging) return;
          this.widget.style.left = (e.clientX - this.offsetX) + 'px';
          this.widget.style.top = (e.clientY - this.offsetY) + 'px';
          this.widget.style.right = 'auto';
          this.widget.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => {
          this.isDragging = false;
          this.widget.style.cursor = 'default';
      });
  }

  startAudio() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          alert('getUserMedia not supported');
          return;
      }
      this.startBtn.disabled = true;
      this.stopBtn.disabled = false;

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
          latencyHint: 'interactive',
          sampleRate: this.SAMPLE_RATE
      });

      this.isPlaying = true;
      this.initWebSocket();
  }

  stopAudio(closeWebsocket) {
      this.playTime = 0;
      this.isPlaying = false;
      this.startBtn.disabled = false;
      this.stopBtn.disabled = true;

      if (this.ws && closeWebsocket) {
          this.ws.close();
          this.ws = null;
      }
      if (this.scriptProcessor) this.scriptProcessor.disconnect();
      if (this.source) this.source.disconnect();
  }

  initWebSocket() {
      const serverUrl = this.getAttribute('server-url') || 'ws://localhost:8765';
      this.ws = new WebSocket(serverUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.addEventListener('open', () => {
          this.statusIndicator.classList.add('connected');
          navigator.mediaDevices.getUserMedia({ audio: { sampleRate: this.SAMPLE_RATE, channelCount: this.NUM_CHANNELS } })
              .then(stream => {
                  this.microphoneStream = stream;
                  this.scriptProcessor = this.audioContext.createScriptProcessor(512, 1, 1);
                  this.source = this.audioContext.createMediaStreamSource(stream);
                  this.source.connect(this.scriptProcessor);
                  this.scriptProcessor.connect(this.audioContext.destination);

                  this.scriptProcessor.onaudioprocess = (event) => {
                      if (!this.ws) return;
                      const audioData = event.inputBuffer.getChannelData(0);
                      const pcmS16Array = this.convertFloat32ToS16PCM(audioData);
                      const pcmByteArray = new Uint8Array(pcmS16Array.buffer);

                      const frame = this.Frame.create({
                          audio: {
                              audio: Array.from(pcmByteArray),
                              sampleRate: this.SAMPLE_RATE,
                              numChannels: this.NUM_CHANNELS
                          }
                      });
                      const encodedFrame = new Uint8Array(this.Frame.encode(frame).finish());
                      this.ws.send(encodedFrame);
                  };
              }).catch(err => console.error('Microphone error:', err));
      });

      this.ws.addEventListener('message', (event) => {
          if (this.isPlaying) this.enqueueAudioFromProto(event.data);
      });

      this.ws.addEventListener('close', () => {
          this.statusIndicator.classList.remove('connected');
          this.stopAudio(false);
      });
      this.ws.addEventListener('error', e => console.error('WebSocket error:', e));
  }

  enqueueAudioFromProto(arrayBuffer) {
      const parsedFrame = this.Frame.decode(new Uint8Array(arrayBuffer));
      if (!parsedFrame?.audio) return;

      const diffTime = this.audioContext.currentTime - this.lastMessageTime;
      if (this.playTime === 0 || diffTime > this.PLAY_TIME_RESET_THRESHOLD_MS)
          this.playTime = this.audioContext.currentTime;
      this.lastMessageTime = this.audioContext.currentTime;

      const audioVector = Array.from(parsedFrame.audio.audio);
      const audioArray = new Uint8Array(audioVector);

      this.audioContext.decodeAudioData(audioArray.buffer, (buffer) => {
          const source = new AudioBufferSourceNode(this.audioContext);
          source.buffer = buffer;
          source.start(this.playTime);
          source.connect(this.audioContext.destination);
          this.playTime += buffer.duration;
      });
  }

  convertFloat32ToS16PCM(float32Array) {
      const int16Array = new Int16Array(float32Array.length);
      for (let i = 0; i < float32Array.length; i++) {
          const clamped = Math.max(-1, Math.min(1, float32Array[i]));
          int16Array[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      }
      return int16Array;
  }
}

customElements.define('pipecat-widget', PipecatWidget);
