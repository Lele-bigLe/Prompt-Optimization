use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const API_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const PROVIDERS: &[(&str, &str)] = &[
    ("codex", "已登录的 Codex"),
    ("claude", "已登录的 Claude Code"),
    ("deepseek", "DeepSeek"),
    ("anthropic", "Claude API"),
    ("openai-compatible", "OpenAI 兼容 API"),
];
pub const BILLING_URL: &str = "https://platform.openai.com/settings/organization/billing/overview";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_base_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub api_key_env: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub executable: String,
    #[serde(
        default = "default_token_parameter",
        skip_serializing_if = "String::is_empty"
    )]
    pub token_limit_parameter: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
fn default_token_parameter() -> String {
    "max_tokens".into()
}
impl Default for Connection {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "默认 Codex".into(),
            provider: "codex".into(),
            model: String::new(),
            reasoning_effort: "auto".into(),
            api_base_url: String::new(),
            api_key_env: String::new(),
            executable: String::new(),
            token_limit_parameter: "max_tokens".into(),
            extra: Default::default(),
        }
    }
}
impl Connection {
    pub fn clear_model_capabilities(&mut self) {
        self.extra.remove("modelMetadata");
        self.extra.insert("supportsImages".into(), json!(false));
    }
    pub fn is_api(&self) -> bool {
        matches!(
            self.provider.as_str(),
            "deepseek" | "anthropic" | "openai-compatible"
        )
    }
    pub fn validate(&self) -> Result<()> {
        if Uuid::parse_str(&self.id).is_err()
            || Uuid::parse_str(&self.id).is_ok_and(|id| id.to_string() != self.id)
            || self.name.trim().is_empty()
            || self.name.chars().count() > 80
            || self.name.chars().any(char::is_control)
        {
            bail!("供应商连接名称或 ID 不正确。");
        }
        if self.extra.keys().any(|key| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "key"
                    | "apikey"
                    | "password"
                    | "token"
                    | "accesstoken"
                    | "refreshtoken"
                    | "credentials"
            )
        }) {
            bail!("密钥不能保存在连接配置中。");
        }
        self.validate_transport()?;
        validate_model(&self.model, &self.reasoning_effort)?;
        if self.is_api() {
            if self.model.trim().is_empty() {
                bail!("请选择 API 连接的模型。");
            }
            if !["max_tokens", "max_completion_tokens"]
                .contains(&self.token_limit_parameter.as_str())
            {
                bail!("输出长度参数不正确。");
            }
        }
        Ok(())
    }
    // 查询目录不要求先命名连接或选定模型；保存时仍核对完整配置。
    pub fn validate_for_catalog(&self) -> Result<()> {
        self.validate_transport()?;
        if self.provider == "claude" && self.executable.is_empty() {
            bail!("请先为此连接填写 Claude Code 的 .exe 绝对路径。");
        }
        Ok(())
    }
    fn validate_transport(&self) -> Result<()> {
        if !PROVIDERS.iter().any(|(id, _)| *id == self.provider) {
            bail!("供应商类型不正确。");
        }
        if self.is_api() {
            self.endpoint()?;
            let valid = self.api_key_env.len() <= 100
                && self.api_key_env.bytes().enumerate().all(|(i, c)| {
                    c == b'_' || c.is_ascii_alphabetic() || i > 0 && c.is_ascii_digit()
                });
            if !valid {
                bail!("请填写 API 密钥的环境变量名，不要填写密钥本身。");
            }
        }
        if self.provider == "claude"
            && !self.executable.is_empty()
            && (!Path::new(&self.executable).is_absolute()
                || !self.executable.to_ascii_lowercase().ends_with(".exe")
                || self.executable.len() > 1024)
        {
            bail!("请填写 Claude Code 的 .exe 绝对路径。");
        }
        Ok(())
    }
    pub fn endpoint(&self) -> Result<reqwest::Url> {
        self.endpoint_for(if self.provider == "anthropic" {
            "messages"
        } else {
            "chat/completions"
        })
    }
    pub fn endpoint_for(&self, resource: &str) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&self.api_base_url).context("请填写有效的 API 地址。")?;
        let local = matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        );
        if self.api_base_url.len() > 2048
            || url.scheme() != "https" && !(url.scheme() == "http" && local)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("API 地址需要使用 HTTPS（本机可用 HTTP），且不能包含凭据或查询参数。");
        }
        let suffix = if self.provider == "anthropic" {
            "/messages"
        } else {
            "/chat/completions"
        };
        let path = url.path().trim_end_matches('/');
        let path = format!("{}/{}", path.strip_suffix(suffix).unwrap_or(path), resource);
        url.set_path(&path);
        Ok(url)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub model: String,
    pub reasoning_effort: String,
    pub connection: String,
    pub connections: Vec<Connection>,
    pub pool_revision: String,
    pub pool_fingerprint: String,
    pub local_revision: String,
    pub model_overrides: std::collections::BTreeMap<String, ModelChoice>,
    pub stored_api_keys: Vec<String>,
    pub context_enabled: bool,
    pub auto_apply: bool,
    pub recent_turns: usize,
    pub max_context_chars: usize,
    pub timeout_seconds: u64,
    pub template: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub model: String,
    pub reasoning_effort: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            model: String::new(),
            reasoning_effort: "auto".into(),
            connection: String::new(),
            connections: vec![],
            pool_revision: String::new(),
            pool_fingerprint: String::new(),
            local_revision: String::new(),
            model_overrides: Default::default(),
            stored_api_keys: Vec::new(),
            context_enabled: true,
            auto_apply: true,
            recent_turns: 8,
            max_context_chars: 24000,
            timeout_seconds: 90,
            template: "builtin-basic".into(),
        }
    }
}
impl Config {
    pub fn selected(&self) -> Connection {
        let mut profile = self
            .connections
            .iter()
            .find(|p| p.id == self.connection)
            .cloned()
            .unwrap_or_else(|| Connection {
                id: self.connection.clone(),
                name: "连接已删除，请重新选择".into(),
                provider: "unavailable".into(),
                ..Connection::default()
            });
        if let Some(choice) = self.model_overrides.get(&self.connection) {
            profile.model = choice.model.clone();
            profile.reasoning_effort = choice.reasoning_effort.clone();
        }
        profile
    }
    pub fn set_selected(&mut self, profile: Connection) {
        if self.connections.iter().any(|p| p.id == self.connection) {
            self.model_overrides.insert(
                self.connection.clone(),
                ModelChoice {
                    model: profile.model,
                    reasoning_effort: profile.reasoning_effort,
                },
            );
        }
    }
    pub fn validate(&self) -> Result<()> {
        validate_model(&self.model, &self.reasoning_effort)?;
        if !(1..=30).contains(&self.recent_turns)
            || !(1000..=100000).contains(&self.max_context_chars)
            || !(5..=300).contains(&self.timeout_seconds)
        {
            bail!("参考轮数、上下文字数或超时时间超出范围。");
        }
        if self.connections.len() > 100 {
            bail!("最多保存 100 个供应商连接。");
        }
        let mut ids = std::collections::HashSet::new();
        for profile in &self.connections {
            profile.validate()?;
            if !ids.insert(&profile.id) {
                bail!("供应商连接 ID 重复。");
            }
        }
        for choice in self.model_overrides.values() {
            validate_model(&choice.model, &choice.reasoning_effort)?;
        }
        if !templates().iter().any(|t| t["id"] == self.template) {
            bail!("优化模板不存在。");
        }
        Ok(())
    }
    pub fn load() -> Result<Self> {
        let _lock = crate::pool::Lock::acquire(&home(), "preferences-v2.lock")?;
        let preferences = home().join("preferences-v2.json");
        let persisted = read_json(&preferences)?;
        let migrating = persisted.is_none();
        let value = if migrating {
            read_json(&home().join("config.json"))?
        } else {
            persisted
        };
        let mut config: Self = value
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        if migrating {
            let source = crate::pool::source("cli", &home());
            let (pool, mapping) =
                crate::pool::Pool::import(&source, config.connections.clone(), Default::default())?;
            config.connection = if config.connection.is_empty() {
                crate::pool::DEFAULT_ID.into()
            } else {
                mapping
                    .get(&config.connection)
                    .cloned()
                    .unwrap_or(config.connection)
            };
            if !config.model.is_empty() || config.reasoning_effort != "auto" {
                config.model_overrides.insert(
                    crate::pool::DEFAULT_ID.into(),
                    ModelChoice {
                        model: config.model.clone(),
                        reasoning_effort: config.reasoning_effort.clone(),
                    },
                );
            }
            config.use_pool(pool)?;
        } else {
            config.refresh_pool()?;
        }
        if !config.model_overrides.contains_key(&config.connection) {
            let profile = config.selected();
            config.set_selected(profile);
        }
        config.validate()?;
        if migrating {
            config.local_revision = Uuid::new_v4().to_string();
            config.persist_preferences()?;
        }
        Ok(config)
    }
    pub fn refresh_pool(&mut self) -> Result<()> {
        let pool = crate::pool::Pool::read()?;
        self.use_pool(pool)
    }
    fn use_pool(&mut self, pool: crate::pool::Pool) -> Result<()> {
        self.stored_api_keys = pool.stored_keys()?;
        self.connections = pool.items;
        self.pool_revision = pool.revision;
        self.pool_fingerprint = pool_fingerprint(&self.connections)?;
        Ok(())
    }
    pub fn activate(&mut self, id: String) {
        self.connection = id;
        let profile = self.selected();
        self.set_selected(profile);
    }
    pub fn refresh_local_revision(&mut self) -> Result<()> {
        let value = read_json(&home().join("preferences-v2.json"))?.context("CLI 默认设置不存在。");
        self.local_revision = value?["localRevision"]
            .as_str()
            .context("CLI 默认设置版本不正确。")?
            .to_owned();
        Ok(())
    }
    pub fn request_snapshot(&self) -> Result<(Self, Option<String>)> {
        let (pool, key) = crate::pool::Pool::read_with_key(&self.connection)?;
        let mut config = self.clone();
        config.use_pool(pool)?;
        let profile = config.selected();
        profile.validate_for_catalog()?;
        if profile.is_api() && key.is_none() {
            bail!("此连接没有可用密钥，请在连接设置中填写 API Key，或提供密钥环境变量。");
        }
        Ok((config, key))
    }
    pub fn save(&mut self) -> Result<()> {
        self.save_with_keys(&Default::default())
    }
    pub fn save_with_keys(
        &mut self,
        keys: &std::collections::HashMap<String, String>,
    ) -> Result<()> {
        self.validate()?;
        let _lock = crate::pool::Lock::acquire(&home(), "preferences-v2.lock")?;
        let persisted = read_json(&home().join("preferences-v2.json"))?;
        if persisted.as_ref().and_then(|v| v["localRevision"].as_str())
            != Some(self.local_revision.as_str())
        {
            bail!("CLI 默认设置已在其他窗口修改；请重新打开设置后再保存。");
        }
        let changed = pool_fingerprint(&self.connections)? != self.pool_fingerprint;
        if changed || !keys.is_empty() {
            let pool =
                crate::pool::Pool::replace(&self.pool_revision, self.connections.clone(), keys)?;
            self.use_pool(pool)?;
        } else {
            self.refresh_pool()?;
        }
        if !self.connections.iter().any(|p| p.id == self.connection) {
            bail!("所选连接已删除，请重新选择后保存。");
        }
        self.local_revision = Uuid::new_v4().to_string();
        self.persist_preferences()
            .context("连接信息已更新，但 CLI 默认设置保存失败，请重新读取设置。")
    }
    fn persist_preferences(&self) -> Result<()> {
        let mut value = serde_json::to_value(self)?;
        for name in [
            "connections",
            "poolRevision",
            "poolFingerprint",
            "model",
            "reasoningEffort",
            "storedApiKeys",
        ] {
            value.as_object_mut().unwrap().remove(name);
        }
        write_json(&home().join("preferences-v2.json"), &value)
    }
}
fn pool_fingerprint(connections: &[Connection]) -> Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(connections)?)
    ))
}
fn validate_model(model: &str, effort: &str) -> Result<()> {
    if model.chars().count() > 200
        || model.chars().any(char::is_control)
        || effort.is_empty()
        || effort.len() > 30
        || !effort.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase() || i > 0 && (c.is_ascii_digit() || c == b'_' || c == b'-')
        })
    {
        bail!("模型 ID 或思考程度不正确。");
    }
    Ok(())
}
pub fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("USERPROFILE").unwrap_or_default()).join(".codex")
        })
}
pub fn home() -> PathBuf {
    env::var_os("CPO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| codex_home().join("prompt-optimizer-cli"))
}
pub fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "无法解析 {}。",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("无法读取配置或入口文件，请检查访问权限。"),
    }
}
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(value)?, || Ok(()))
}
pub fn atomic_write(path: &Path, bytes: &[u8], check: impl FnOnce() -> Result<()>) -> Result<()> {
    let parent = path.parent().context("文件目录不存在。")?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    check()?;
    file.persist(path)
        .map_err(|_| anyhow::anyhow!("无法原子写入文件，原文件保留。"))?;
    Ok(())
}
pub fn templates() -> Vec<Value> {
    serde_json::from_str(include_str!("../../core/templates.json")).expect("仓库内置模板格式不正确")
}
pub fn template_name(id: &str) -> String {
    templates()
        .iter()
        .find(|t| t["id"] == id)
        .and_then(|t| t["name"].as_str())
        .unwrap_or(id)
        .to_owned()
}
pub fn effort_name(id: &str) -> &str {
    match id {
        "auto" => "模型默认",
        "none" => "不额外思考",
        "minimal" => "很少思考",
        "low" => "简单思考",
        "medium" => "适中思考",
        "high" => "深入思考",
        "xhigh" => "更深入思考",
        "max" => "最大思考程度",
        "ultra" => "最高思考程度",
        _ => id,
    }
}
pub fn clean(text: &str) -> String {
    String::from_utf8_lossy(&strip_ansi_escapes::strip(text))
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn timestamp() -> String {
    let mut value: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe {
        windows_sys::Win32::System::SystemInformation::GetSystemTime(&mut value);
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.wYear,
        value.wMonth,
        value.wDay,
        value.wHour,
        value.wMinute,
        value.wSecond,
        value.wMilliseconds
    )
}
pub fn error_record(id: &str, message: &str) {
    if Uuid::parse_str(id).is_ok() {
        let _ = write_json(
            &home().join("errors").join(format!("{id}.json")),
            &json!({"at":timestamp(), "message":message}),
        );
    }
}
pub fn executable(override_path: Option<&str>) -> Result<PathBuf> {
    if let Some(value) = override_path {
        let path = PathBuf::from(value);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        bail!("--codex 需要官方 codex.exe 的有效绝对路径。");
    }
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("CODEX_CLI_PATH") {
        candidates.push(PathBuf::from(path));
    }
    let mut dirs: Vec<PathBuf> =
        env::split_paths(&env::var_os("PATH").unwrap_or_default()).collect();
    if let Ok(path) = env::current_exe() {
        if let Some(dir) = path.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    for dir in dirs {
        candidates.push(dir.join("codex.exe"));
        let base = dir.join("node_modules/@openai/codex");
        candidates.push(base.join(
            "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
        ));
        candidates.push(base.join("vendor/x86_64-pc-windows-msvc/bin/codex.exe"));
    }
    candidates
        .into_iter()
        .find(|p| p.is_absolute() && p.is_file())
        .context("未找到官方 Codex，请用 --codex 指定 codex.exe 的绝对路径。")
}
