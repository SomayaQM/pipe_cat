// Audio processor worklet - save this as audio-processor.js
const audioProcessorCode = `
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input.length > 0) {
      const pcmData = this.convertFloat32ToS16PCM(input[0]);
      this.port.postMessage({ pcmData }, [pcmData.buffer]);
    }
    return true;
  }

  convertFloat32ToS16PCM(input) {
    const length = input.length;
    const output = new Int16Array(length);
    for (let i = 0; i < length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output.buffer;
  }
}

registerProcessor('audio-processor', AudioProcessor);
`;

// Create a blob URL for the audio processor
const audioProcessorBlob = new Blob([audioProcessorCode], { type: 'application/javascript' });
const audioProcessorUrl = URL.createObjectURL(audioProcessorBlob);

// Performance monitoring
const perf = {
    start: {},
    end: {},
    measure: (name) => {
        perf.start[name] = performance.now();
    },
    endMeasure: (name) => {
        perf.end[name] = performance.now();
        console.log(`${name} took ${perf.end[name] - perf.start[name]}ms`);
    }
};

class PipecatWidget extends HTMLElement {
  constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      
      // Connection state
      this.ws = null;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 5;
      this.reconnectDelay = 1000;
      this.reconnectTimeout = null;
      this.isConnecting = false;
      
      // Audio processing state
      this.audioContext = null;
      this.audioWorkletNode = null;
      this.mediaStream = null;
      this.audioBuffer = [];
      this.isProcessingAudio = false;
      this.audioQueue = [];
      this.bufferSize = 5; // Number of audio chunks to buffer

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

          <div id="widget-icon">🤖</div>
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

      // Cache DOM elements
      this.widget = this.shadowRoot.querySelector('#widget-container');
      this.widgetIcon = this.shadowRoot.querySelector('#widget-icon');
      this.content = this.shadowRoot.querySelector('#widget-content');
      this.startBtn = this.shadowRoot.querySelector('#startAudioBtn');
      this.stopBtn = this.shadowRoot.querySelector('#stopAudioBtn');
      this.minimizeBtn = this.shadowRoot.querySelector('#minimizeBtn');
      this.closeBtn = this.shadowRoot.querySelector('#closeBtn');
      this.statusIndicator = this.shadowRoot.querySelector('#statusIndicator');
      this.progressText = this.shadowRoot.querySelector('#progressText');

      // Initialize audio context on user interaction
      this.initAudioContext();

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

  async initAudioContext() {
    perf.measure('audioContextInit');
    try {
      // Create audio context on user interaction
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
        latencyHint: 'interactive'
      });

      // Warm up the audio context
      await this.audioContext.resume();
      
      // Load audio worklet
      try {
        perf.measure('workletLoad');
        await this.audioContext.audioWorklet.addModule(audioProcessorUrl);
        perf.endMeasure('workletLoad');
        
        this.audioWorkletNode = new AudioWorkletNode(
          this.audioContext,
          'audio-processor',
          { 
            numberOfInputs: 1, 
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              sampleRate: 16000
            }
          }
        );
        
        // Handle audio data from worklet with buffering
        this.audioWorkletNode.port.onmessage = (event) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.bufferAudioData(event.data.pcmData);
          }
        };
        
        // Connect the worklet to the destination
        this.audioWorkletNode.connect(this.audioContext.destination);
        
        perf.endMeasure('audioContextInit');
      } catch (e) {
        console.error('AudioWorklet error:', e);
        this.progressText.textContent = 'Audio processing error. Please refresh the page.';
        throw e; // Don't fall back to ScriptProcessor
      }
    } catch (e) {
      console.error('AudioContext error:', e);
      this.progressText.textContent = 'Audio not supported in this browser';
      throw e;
    }
  }
  
  // Buffer audio data to handle network latency
  bufferAudioData(audioData) {
    this.audioBuffer.push(audioData);
    
    // If we're not already processing the buffer and have enough data, start processing
    if (!this.isProcessingAudio && this.audioBuffer.length >= this.bufferSize) {
      this.processAudioBuffer();
    }
  }
  
  async processAudioBuffer() {
    if (this.audioBuffer.length === 0) {
      this.isProcessingAudio = false;
      return;
    }
    
    this.isProcessingAudio = true;
    const chunk = this.audioBuffer.shift();
    
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(chunk);
      }
      
      // Process next chunk on next tick to avoid blocking
      requestAnimationFrame(() => this.processAudioBuffer());
    } catch (e) {
      console.error('Error sending audio data:', e);
      this.isProcessingAudio = false;
    }
  }

  // Removed fallbackToScriptProcessor as it's deprecated

  async connectedCallback() {
    try {
      // Load protobuf
      const protoUrl = 'https://cdn.jsdelivr.net/gh/SomayaQM/pipe_cat@main/frames.proto';
      this.Frame = await new Promise((resolve, reject) => {
        protobuf.load(protoUrl, (err, root) => {
          if (err) return reject(err);
          resolve(root.lookupType('pipecat.Frame'));
        });
      });
      
      this.progressText.textContent = 'Ready! Click Start Audio';
      this.startBtn.disabled = false;
    } catch (err) {
      console.error('Proto load error:', err);
      this.progressText.textContent = 'Error loading required resources';
    }

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

  async startAudio() {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Audio recording not supported in this browser');
      return;
    }

    try {
      this.startBtn.disabled = true;
      this.stopBtn.disabled = false;
      this.progressText.textContent = 'Connecting...';

      // Resume audio context if it was suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Get microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Connect audio stream to worklet/processor
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      if (this.audioWorkletNode) {
        source.connect(this.audioWorkletNode);
        this.audioWorkletNode.connect(this.audioContext.destination);
      } else if (this.scriptProcessor) {
        source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.audioContext.destination);
      }

      // Initialize WebSocket connection
      await this.initWebSocket();
      this.progressText.textContent = 'Connected! Speak now...';
      
    } catch (error) {
      console.error('Error starting audio:', error);
      this.progressText.textContent = `Error: ${error.message}`;
      this.stopAudio();
    }
  }

  stopAudio(closeWebsocket = true) {
    this.isPlaying = false;
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    
    // Stop all audio tracks
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    // Close WebSocket connection
    if (this.ws && closeWebsocket) {
      this.ws.close();
      this.ws = null;
    }
    
    // Clean up audio nodes
    if (this.audioWorkletNode) {
      this.audioWorkletNode.disconnect();
    }
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
    }
    
    this.progressText.textContent = 'Ready! Click Start Audio';
  }

  initWebSocket() {
    return new Promise((resolve, reject) => {
      try {
        this.ws.close();
      } catch (e) {
        console.warn('Error closing WebSocket:', e);
        reject(error);
      }
    });
  }
  
  handleAudioResponse(audioData) {
    if (!this.isPlaying) return;
    
    try {
      const parsedFrame = this.Frame.decode(new Uint8Array(audioData));
      if (!parsedFrame?.audio) return;
      
      const audioVector = Array.from(parsedFrame.audio.audio);
      const audioArray = new Uint8Array(audioVector);
      
      this.audioContext.decodeAudioData(audioArray.buffer, (buffer) => {
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);
        source.start(0);
      });
    } catch (error) {
      console.error('Error processing audio response:', error);
    }
  }
  
  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      this.progressText.textContent = 'Connection lost. Please refresh the page.';
      return;
    }
    
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    console.log(`Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
    this.progressText.textContent = `Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`;
    
    setTimeout(() => {
      if (this.isPlaying) {
        this.initWebSocket().catch(console.error);
      }
    }, delay);
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

  // Clean up resources when element is removed
  disconnectedCallback() {
    this.stopAudio();
    if (this.audioContext) {
      this.audioContext.close();
    }
    // Revoke the blob URL to prevent memory leaks
    URL.revokeObjectURL(audioProcessorUrl);
  }
}

customElements.define('pipecat-widget', PipecatWidget);
