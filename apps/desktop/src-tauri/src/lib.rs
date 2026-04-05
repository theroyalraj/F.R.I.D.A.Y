//! OpenClaw desktop shell — setup wizard and config persistence.
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPayload {
    pub anthropic_api_key: String,
    pub openai_api_key: Option<String>,
    pub gmail_address: Option<String>,
    pub gmail_app_password: Option<String>,
    pub friday_tts_voice: Option<String>,
    pub friday_user_name: Option<String>,
    pub friday_user_city: Option<String>,
}

fn openclaw_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".openclaw"))
}

/// Writes `~/.openclaw/config.json` for the Node/Python stack to consume (merge in launcher scripts).
#[tauri::command]
fn save_openclaw_config(payload: ConfigPayload) -> Result<(), String> {
    if payload.anthropic_api_key.trim().is_empty() {
        return Err("Anthropic API key is required".into());
    }

    let dir = openclaw_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let db_path = dir.join("openclaw.db");
    let json_path = dir.join("config.json");

    let mut map = serde_json::Map::new();
    if json_path.exists() {
        if let Ok(raw) = fs::read_to_string(&json_path) {
            if let Ok(Value::Object(existing)) = serde_json::from_str::<Value>(&raw) {
                map.extend(existing);
            }
        }
    }

    let secret = map
        .get("PC_AGENT_SECRET")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .unwrap_or_else(|| Uuid::new_v4().simple().to_string());

    map.insert(
        "ANTHROPIC_API_KEY".into(),
        Value::String(payload.anthropic_api_key.trim().to_string()),
    );
    if let Some(ref o) = payload.openai_api_key {
        if !o.trim().is_empty() {
            map.insert("OPENAI_API_KEY".into(), Value::String(o.trim().to_string()));
        }
    }
    if let Some(ref g) = payload.gmail_address {
        if !g.trim().is_empty() {
            map.insert("GMAIL_ADDRESS".into(), Value::String(g.trim().to_string()));
        }
    }
    if let Some(ref g) = payload.gmail_app_password {
        if !g.trim().is_empty() {
            map.insert("GMAIL_APP_PWD".into(), Value::String(g.trim().to_string()));
        }
    }
    map.insert(
        "FRIDAY_TTS_VOICE".into(),
        Value::String(
            payload
                .friday_tts_voice
                .as_deref()
                .unwrap_or("en-US-EmmaMultilingualNeural")
                .to_string(),
        ),
    );
    map.insert(
        "FRIDAY_USER_NAME".into(),
        Value::String(payload.friday_user_name.as_deref().unwrap_or("there").to_string()),
    );
    map.insert(
        "FRIDAY_USER_CITY".into(),
        Value::String(payload.friday_user_city.as_deref().unwrap_or("").to_string()),
    );
    map.insert("OPENCLAW_DIRECT_INTAKE".into(), Value::String("true".into()));
    map.insert(
        "OPENCLAW_SQLITE_PATH".into(),
        Value::String(db_path.to_string_lossy().into_owned()),
    );
    map.insert(
        "PC_AGENT_URL".into(),
        Value::String("http://127.0.0.1:3847".into()),
    );
    map.insert(
        "GATEWAY_INTERNAL_SELF_URL".into(),
        Value::String("http://127.0.0.1:3848".into()),
    );
    map.insert("PC_AGENT_SECRET".into(), Value::String(secret.clone()));
    map.insert("N8N_WEBHOOK_SECRET".into(), Value::String(secret));

    let json = Value::Object(map);
    fs::write(
        &json_path,
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_openclaw_config])
        .run(tauri::generate_context!())
        .expect("error while running OpenClaw");
}
