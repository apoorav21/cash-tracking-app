// Cashflow backend bridge.
//
// Exposes window.CashflowBackend to the React UI. Cleanly separates all cloud
// access (Cognito, Amazon Transcribe streaming, Bedrock parse, DynamoDB) from
// the rendering layer, and degrades gracefully to fully-offline behaviour when
// window.CASHFLOW_CONFIG is not filled in.
//
// AWS SDK v3 is loaded as ES modules from a CDN (esm.sh). The Android WebView
// has internet + a secure (https) origin, so getUserMedia and these imports work.

const CFG = window.CASHFLOW_CONFIG || {};
const cloudConfigured = !!(CFG.region && CFG.identityPoolId);
const apiConfigured = !!(CFG.apiBaseUrl);

let _aws = null;
// Lazily import the AWS SDK only when cloud features are actually used.
async function aws() {
  if (_aws) return _aws;
  const [transcribe, creds] = await Promise.all([
    import('https://esm.sh/@aws-sdk/client-transcribe-streaming@3.620.0'),
    import('https://esm.sh/@aws-sdk/credential-providers@3.620.0'),
  ]);
  _aws = {
    TranscribeStreamingClient: transcribe.TranscribeStreamingClient,
    StartStreamTranscriptionCommand: transcribe.StartStreamTranscriptionCommand,
    fromCognitoIdentityPool: creds.fromCognitoIdentityPool,
  };
  return _aws;
}

/* -------------------- Microphone → PCM16 @ 16kHz -------------------- */
// Captures mic audio and yields little-endian 16-bit PCM chunks for Transcribe.
function micPcmStream() {
  const SAMPLE_RATE = 16000;
  let audioCtx, source, processor, mediaStream;
  let closed = false;
  const queue = [];
  let resolveNext = null;

  function push(chunk) {
    if (resolveNext) { resolveNext({ value: chunk, done: false }); resolveNext = null; }
    else queue.push(chunk);
  }

  const downsample = (input, inRate) => {
    if (inRate === SAMPLE_RATE) return input;
    const ratio = inRate / SAMPLE_RATE;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
    return out;
  };
  const toPcm16 = (floats) => {
    const buf = new ArrayBuffer(floats.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < floats.length; i++) {
      const s = Math.max(-1, Math.min(1, floats[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  };

  async function start() {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaStreamSource(mediaStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => {
      if (closed) return;
      const floats = downsample(e.inputBuffer.getChannelData(0), audioCtx.sampleRate);
      push(toPcm16(floats));
    };
    source.connect(processor);
    processor.connect(audioCtx.destination);
  }

  function stop() {
    if (closed) return;
    closed = true;
    try { processor && (processor.onaudioprocess = null, processor.disconnect()); } catch {}
    try { source && source.disconnect(); } catch {}
    try { audioCtx && audioCtx.close(); } catch {}
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
    if (resolveNext) { resolveNext({ value: undefined, done: true }); resolveNext = null; }
  }

  const audioIterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { resolveNext = res; });
        },
      };
    },
  };

  return { start, stop, audioIterable, sampleRate: SAMPLE_RATE };
}

/* -------------------- Speech-to-text (record → OpenAI transcription) -------------------- */
// startTranscribe({ onStatus, onFinal, onError }) -> Promise<{ stop() }>
// Records a short voice note with MediaRecorder; on stop() it uploads the audio
// to our OpenAI-backed transcription Lambda, which auto-detects Hindi/English and
// returns the text. onStatus('recording'|'transcribing') drives the UI; onFinal
// gets the transcript. Falls back to the device SpeechRecognition API, then to the
// app's built-in demo dictation (unavailable:true) when nothing is available.
const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = reject;
  r.readAsDataURL(blob);
});

async function transcribeBlob(blob) {
  if (!CFG.transcribeUrl) return null;
  const audio = await blobToBase64(blob);
  if (!audio) return null;
  const resp = await fetch(CFG.transcribeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio, mime: blob.type || 'audio/webm' }),
  });
  if (!resp.ok) throw new Error('transcribe ' + resp.status);
  const j = await resp.json();
  if (j && j.error) throw new Error(j.error);
  return (j && j.text) || '';
}

async function startTranscribe({ onStatus, onPartial, onFinal, onError }) {
  // Preferred path: record audio, then send to OpenAI (best Hindi/English detect).
  const hasRecorder = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (CFG.transcribeUrl && hasRecorder) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Pick a mime the browser actually supports.
      const pick = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
        .find((m) => window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) || '';
      const rec = pick ? new MediaRecorder(stream, { mimeType: pick }) : new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

      // Voice-activity detection: measure mic energy while recording. If the user
      // never actually spoke, we skip transcription entirely — otherwise the model
      // hallucinates a sentence out of silence.
      let peakRms = 0, voicedFrames = 0, audioCtx = null, vadTimer = null;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const srcNode = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        srcNode.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        vadTimer = setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
          const rms = Math.sqrt(sum / buf.length);
          if (rms > peakRms) peakRms = rms;
          if (rms > 0.02) voicedFrames++;   // ~speech-level energy
        }, 80);
      } catch (e) { /* VAD unavailable — fall back to always transcribing */ }
      const stopVad = () => { if (vadTimer) clearInterval(vadTimer); vadTimer = null; if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; } };

      let done = false;
      rec.onstop = async () => {
        stopVad();
        stream.getTracks().forEach((t) => t.stop());
        if (done) return; done = true;
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || pick || 'audio/webm' });
          if (!blob.size) { onFinal && onFinal(''); return; }
          // No speech detected (silence) → don't transcribe; avoids hallucinations.
          // (Only gate when VAD actually ran, i.e. peakRms > 0.)
          if (peakRms > 0 && peakRms < 0.025 && voicedFrames < 3) { onStatus && onStatus('silent'); onFinal && onFinal(''); return; }
          onStatus && onStatus('transcribing');
          const text = await transcribeBlob(blob);
          onFinal && onFinal((text || '').trim());
        } catch (err) { onError && onError(err); onFinal && onFinal(''); }
      };
      rec.start();
      onStatus && onStatus('recording');
      return { stop() { try { rec.stop(); } catch (e) { stopVad(); onError && onError(e); } } };
    } catch (err) {
      onError && onError(err);
      // fall through to device STT
    }
  }

  // Fallback: device SpeechRecognition (desktop browsers / some WebViews).
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    onStatus && onStatus('recording');
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t; else interim += t;
      }
      onPartial && onPartial((finalText + ' ' + interim).trim());
    };
    rec.onerror = (ev) => onError && onError(new Error(ev.error || 'speech error'));
    rec.onend = () => onFinal && onFinal(finalText.trim());
    try { rec.start(); } catch (e) { onError && onError(e); }
    return { stop() { try { rec.stop(); } catch {} } };
  }

  // No STT available — tell the UI to run its built-in demo dictation.
  return { stop() {}, unavailable: true };
}

/* -------------------- Bedrock parse (streamed) -------------------- */
// parseText(text, onToken) -> Promise<draft|null>. Streams the model's JSON,
// invoking onToken(accumulatedText) as it arrives. Returns null on failure so
// the UI can fall back to its offline regex parser.
async function parseText(text, onToken) {
  if (!CFG.parseUrl) return null;
  try {
    const resp = await fetch(CFG.parseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok || !resp.body) return null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      if (acc.includes('__ERROR__')) return null;
      onToken && onToken(acc);
    }
    const match = acc.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/* -------------------- Accounting assistant (streamed) -------------------- */
// chatText({messages, transactions, today}, onToken) -> Promise<string|null>.
// Streams the assistant's reply, invoking onToken(accumulatedText) as it arrives.
// Returns the full text, or a string starting with "__ERROR__" / null on failure
// so the UI can show a friendly fallback (e.g. Bedrock daily-quota 429).
async function chatText({ messages, transactions, today }, onToken) {
  if (!CFG.chatUrl) return null;
  try {
    const resp = await fetch(CFG.chatUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, transactions, today }),
    });
    if (!resp.ok || !resp.body) return null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      onToken && onToken(acc);
    }
    return acc;
  } catch {
    return null;
  }
}

/* -------------------- Authentication (Cognito User Pool) -------------------- */
const COG = CFG.cognito || {};
const authConfigured = !!(COG.userPoolId && COG.clientId);
let _cognito = null; // { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute, pool }
let _idToken = null; // cached id token (JWT) for API calls

async function cognito() {
  if (_cognito) return _cognito;
  const m = await import('https://esm.sh/amazon-cognito-identity-js@6.3.12');
  const pool = new m.CognitoUserPool({ UserPoolId: COG.userPoolId, ClientId: COG.clientId });
  _cognito = { ...m, pool };
  return _cognito;
}
const userOf = (c, email) => new c.CognitoUser({ Username: email, Pool: c.pool });

// Sign up with email + password + display name. Cognito emails a 6-digit code.
async function signUp({ email, password, name }) {
  const c = await cognito();
  const attrs = [new c.CognitoUserAttribute({ Name: 'name', Value: name || email.split('@')[0] })];
  return new Promise((resolve, reject) => {
    c.pool.signUp(email, password, attrs, null, (err, res) => err ? reject(err) : resolve(res));
  });
}
async function confirmSignUp({ email, code }) {
  const c = await cognito();
  return new Promise((resolve, reject) => {
    userOf(c, email).confirmRegistration(code, true, (err, res) => err ? reject(err) : resolve(res));
  });
}
async function resendCode({ email }) {
  const c = await cognito();
  return new Promise((resolve, reject) => {
    userOf(c, email).resendConfirmationCode((err, res) => err ? reject(err) : resolve(res));
  });
}
// Sign in; resolves to a profile { sub, email, name, idToken }.
async function signIn({ email, password }) {
  const c = await cognito();
  const user = userOf(c, email);
  const details = new c.AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => { _idToken = session.getIdToken().getJwtToken(); resolve(profileFromSession(session)); },
      onFailure: (err) => reject(err),
    });
  });
}
// Change password for the signed-in user (needs the current password).
async function changePassword({ oldPassword, newPassword }) {
  const c = await cognito();
  const user = c.pool.getCurrentUser();
  if (!user) throw new Error('Not signed in');
  return new Promise((resolve, reject) => {
    user.getSession((err, session) => {
      if (err || !session) { reject(err || new Error('No session')); return; }
      user.changePassword(oldPassword, newPassword, (e, res) => e ? reject(e) : resolve(res));
    });
  });
}
async function forgotPassword({ email }) {
  const c = await cognito();
  return new Promise((resolve, reject) => {
    userOf(c, email).forgotPassword({ onSuccess: resolve, onFailure: reject });
  });
}
async function confirmForgotPassword({ email, code, password }) {
  const c = await cognito();
  return new Promise((resolve, reject) => {
    userOf(c, email).confirmPassword(code, password, { onSuccess: () => resolve(true), onFailure: reject });
  });
}
function profileFromSession(session) {
  const p = session.getIdToken().decodePayload();
  return { sub: p.sub, email: p.email, name: p.name || (p.email || '').split('@')[0], idToken: session.getIdToken().getJwtToken() };
}
// Restore an existing session on app load (refreshes tokens if needed).
async function currentUser() {
  if (!authConfigured) return null;
  const c = await cognito();
  const user = c.pool.getCurrentUser();
  if (!user) return null;
  return new Promise((resolve) => {
    user.getSession((err, session) => {
      if (err || !session || !session.isValid()) { resolve(null); return; }
      _idToken = session.getIdToken().getJwtToken();
      resolve(profileFromSession(session));
    });
  });
}
async function signOut() {
  _idToken = null;
  if (!authConfigured) return;
  const c = await cognito();
  const user = c.pool.getCurrentUser();
  if (user) user.signOut();
}
// Hosted-UI URL for "Continue with Google".
function googleSignInUrl(redirectUri) {
  if (!COG.domain) return null;
  const ru = redirectUri || (location.origin + location.pathname);
  const q = new URLSearchParams({ identity_provider: 'Google', client_id: COG.clientId, response_type: 'code', scope: 'email openid profile', redirect_uri: ru });
  return `${COG.domain}/oauth2/authorize?${q.toString()}`;
}
// Exchange an OAuth `code` (from the Google redirect) for tokens.
async function exchangeCode(code, redirectUri) {
  const ru = redirectUri || (location.origin + location.pathname);
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: COG.clientId, code, redirect_uri: ru });
  const r = await fetch(`${COG.domain}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('token exchange failed');
  const t = await r.json();
  _idToken = t.id_token;
  // Decode the id token payload for the profile.
  const p = JSON.parse(atob(t.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return { sub: p.sub, email: p.email, name: p.name || (p.email || '').split('@')[0], idToken: t.id_token };
}

/* -------------------- Transactions (DynamoDB via HTTP API) -------------------- */
const apiHeaders = () => {
  const h = { 'content-type': 'application/json' };
  if (_idToken) h.authorization = `Bearer ${_idToken}`;
  else h['x-user-id'] = CFG.userId || 'demo-user';
  return h;
};

async function listTxns() {
  if (!apiConfigured) return null;
  const r = await fetch(`${CFG.apiBaseUrl}/txns`, { headers: apiHeaders() });
  if (!r.ok) throw new Error('list failed');
  const j = await r.json();
  // Map stored shape -> UI shape (txnId -> id).
  return (j.transactions || []).map((t) => ({ ...t, id: t.txnId }));
}

async function addTxn(txn) {
  if (!apiConfigured) return null;
  const r = await fetch(`${CFG.apiBaseUrl}/txns`, {
    method: 'POST', headers: apiHeaders(), body: JSON.stringify(txn),
  });
  if (!r.ok) throw new Error('add failed');
  const j = await r.json();
  return { ...j.transaction, id: j.transaction.txnId };
}

async function deleteTxn(id) {
  if (!apiConfigured) return null;
  const r = await fetch(`${CFG.apiBaseUrl}/txns/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: apiHeaders(),
  });
  if (!r.ok) throw new Error('delete failed');
  return true;
}

window.CashflowBackend = {
  cloudConfigured,
  apiConfigured,
  authConfigured,
  googleEnabled: !!COG.googleEnabled,
  startTranscribe,
  parseText,
  chatText,
  listTxns,
  addTxn,
  deleteTxn,
  // auth
  signUp,
  confirmSignUp,
  resendCode,
  signIn,
  signOut,
  changePassword,
  forgotPassword,
  confirmForgotPassword,
  currentUser,
  googleSignInUrl,
  exchangeCode,
};
