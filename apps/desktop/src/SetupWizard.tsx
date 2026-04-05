import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

type Step = 1 | 2 | 3;

export function SetupWizard() {
  const [step, setStep] = useState<Step>(1);
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [gmailUser, setGmailUser] = useState('');
  const [gmailAppPwd, setGmailAppPwd] = useState('');
  const [voice, setVoice] = useState('en-US-EmmaMultilingualNeural');
  const [userName, setUserName] = useState('');
  const [city, setCity] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  async function save(): Promise<void> {
    setStatus('Saving…');
    try {
      await invoke('save_openclaw_config', {
        payload: {
          anthropicApiKey: anthropicKey.trim(),
          openaiApiKey: openaiKey.trim(),
          gmailAddress: gmailUser.trim(),
          gmailAppPassword: gmailAppPwd.trim(),
          fridayTtsVoice: voice.trim(),
          fridayUserName: userName.trim() || 'there',
          fridayUserCity: city.trim(),
        },
      });
      setStatus('Saved. You can start services from the menu bar.');
    } catch (e) {
      setStatus(String(e));
    }
  }

  return (
    <div className="wizard">
      <header>
        <h1>OpenClaw</h1>
        <p className="muted">First-run setup — local agent &amp; voice</p>
      </header>

      {step === 1 && (
        <section>
          <h2>API keys</h2>
          <label>
            Anthropic API key (required)
            <input
              type="password"
              autoComplete="off"
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              placeholder="sk-ant-…"
            />
          </label>
          <label>
            OpenAI API key (optional — premium TTS)
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
            />
          </label>
          <label>
            Gmail address (optional)
            <input type="email" value={gmailUser} onChange={(e) => setGmailUser(e.target.value)} />
          </label>
          <label>
            Gmail app password (optional)
            <input
              type="password"
              value={gmailAppPwd}
              onChange={(e) => setGmailAppPwd(e.target.value)}
            />
          </label>
          <div className="actions">
            <button type="button" onClick={() => setStep(2)} disabled={!anthropicKey.trim()}>
              Next
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section>
          <h2>Voice &amp; profile</h2>
          <label>
            Edge TTS voice id
            <input value={voice} onChange={(e) => setVoice(e.target.value)} />
          </label>
          <p className="hint small">
            Default respects repo voice blocklist — e.g. en-US-EmmaMultilingualNeural
          </p>
          <label>
            Your name
            <input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Alex" />
          </label>
          <label>
            City (optional)
            <input value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" onClick={() => setStep(3)}>
              Next
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2>Permissions</h2>
          <p className="muted">
            macOS will ask for microphone access when you start the listen daemon. Allow it for voice
            commands.
          </p>
          <p className="muted small">
            Config is written to <code>~/.openclaw/config.json</code> and env vars are merged at
            startup. Secrets: prefer FileVault; otherwise restrict permissions on that file
            (chmod 600).
          </p>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setStep(2)}>
              Back
            </button>
            <button type="button" onClick={() => void save()}>
              Save configuration
            </button>
          </div>
          {status && <p className="status">{status}</p>}
        </section>
      )}
    </div>
  );
}
