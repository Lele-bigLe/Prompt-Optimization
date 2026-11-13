use crate::{
    config::{self, Connection},
    credentials,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const DEFAULT_ID: &str = "00000000-0000-4000-8000-000000000001";
pub fn home() -> PathBuf {
    let path = std::env::var_os("CPO_SHARED_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default())
                    .join("AppData/Local")
                    .into_os_string()
            }))
            .join("CodexPromptOptimizer")
        });
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}
pub struct Lock {
    _file: File,
}
impl Lock {
    pub fn acquire(directory: &Path, name: &str) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(0)
                .open(directory.join(name))
            {
                Ok(file) => return Ok(Self { _file: file }),
                Err(error)
                    if matches!(error.raw_os_error(), Some(32 | 33))
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Err(_) => bail!("其他窗口正在保存连接，请稍后重试。"),
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Pool {
    pub version: u32,
    pub revision: String,
    pub items: Vec<Connection>,
    #[serde(default)]
    pub imports: BTreeMap<String, BTreeMap<String, String>>,
}
impl Default for Pool {
    fn default() -> Self {
        Self {
            version: 1,
            revision: Uuid::new_v4().to_string(),
            items: vec![Connection {
                id: DEFAULT_ID.into(),
                ..Connection::default()
            }],
            imports: BTreeMap::new(),
        }
    }
}
impl Pool {
    fn load() -> Result<Self> {
        let pool: Self = config::read_json(&home().join("connections.json"))?
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        if pool.version != 1 || Uuid::parse_str(&pool.revision).is_err() || pool.items.len() > 100 {
            bail!("共享供应商池格式不正确。");
        }
        let mut ids = HashSet::new();
        for profile in &pool.items {
            profile.validate()?;
            if !ids.insert(&profile.id) {
                bail!("共享供应商池的连接 ID 重复。");
            }
        }
        Ok(pool)
    }
    fn commit(&mut self) -> Result<()> {
        self.revision = Uuid::new_v4().to_string();
        config::write_json(&home().join("connections.json"), self)
    }
    fn expected(&self, expected: &str) -> Result<()> {
        if self.revision != expected {
            bail!("供应商池已在其他窗口修改，请重新读取后再保存。");
        }
        Ok(())
    }
    pub fn read() -> Result<Self> {
        let _lock = Lock::acquire(&home(), "connections.lock")?;
        let pool = Self::load()?;
        if !home().join("connections.json").exists() {
            config::write_json(&home().join("connections.json"), &pool)?;
        }
        Ok(pool)
    }
    pub fn stored_keys(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for profile in &self.items {
            if profile.is_api() && credentials::read(&profile.id)?.is_some() {
                ids.push(profile.id.clone());
            }
        }
        Ok(ids)
    }
    pub fn replace(
        expected: &str,
        mut items: Vec<Connection>,
        keys: &HashMap<String, String>,
    ) -> Result<Self> {
        let _lock = Lock::acquire(&home(), "connections.lock")?;
        let mut pool = Self::load()?;
        pool.expected(expected)?;
        if items.len() > 100 {
            bail!("最多保存 100 个共享连接。");
        }
        let mut ids = HashSet::new();
        for p in &items {
            p.validate()?;
            if !ids.insert(&p.id) {
                bail!("连接 ID 重复。");
            }
        }
        for (id, key) in keys {
            credentials::validate_key(key)?;
            if !items
                .iter()
                .any(|profile| profile.id == *id && profile.is_api())
            {
                bail!("密钥只能保存到对应的 API 连接。");
            }
        }
        if pool.items != items || !keys.is_empty() {
            let mut changes = Vec::new();
            for profile in &mut items {
                let previous = pool.items.iter().find(|p| p.id == profile.id);
                let transport_changed = previous.is_some_and(|old| !same_transport(old, profile));
                let env_changed = previous.is_none_or(|old| old.api_key_env != profile.api_key_env);
                if let Some(key) = keys.get(&profile.id) {
                    changes.push((profile.id.clone(), Some(key.clone())));
                    profile.api_key_env.clear();
                    profile
                        .extra
                        .insert("revision".into(), json!(Uuid::new_v4().to_string()));
                } else if profile.is_api() && (transport_changed || env_changed) {
                    let key = std::env::var(&profile.api_key_env)
                        .ok()
                        .filter(|key| !key.trim().is_empty());
                    if transport_changed
                        && (key.is_none()
                            || previous.is_some_and(|old| old.api_key_env == profile.api_key_env))
                    {
                        bail!("更换 API 地址或服务类型后，请填写新地址的 API Key，或提供密钥环境变量。");
                    }
                    if let Some(key) = key {
                        changes.push((profile.id.clone(), Some(key)));
                    }
                } else if previous.is_some_and(|old| old.is_api()) && !profile.is_api() {
                    changes.push((profile.id.clone(), None));
                }
            }
            for previous in &pool.items {
                if !items.iter().any(|p| p.id == previous.id) {
                    changes.push((previous.id.clone(), None));
                }
            }
            let mut rollback = Vec::new();
            for (id, key) in changes {
                let old = match credentials::read(&id) {
                    Ok(key) => key,
                    Err(error) => {
                        rollback_keys(rollback)?;
                        return Err(error);
                    }
                };
                let result = if let Some(key) = key {
                    credentials::write(&id, &key)
                } else {
                    credentials::remove(&id)
                };
                if let Err(error) = result {
                    rollback_keys(rollback)?;
                    return Err(error);
                }
                rollback.push((id, old));
            }
            pool.items = items;
            if let Err(error) = pool.commit() {
                rollback_keys(rollback)?;
                return Err(error);
            }
        }
        Ok(pool)
    }
    pub fn read_with_key(id: &str) -> Result<(Self, Option<String>)> {
        let _lock = Lock::acquire(&home(), "connections.lock")?;
        let pool = Self::load()?;
        let profile = pool
            .items
            .iter()
            .find(|p| p.id == id)
            .context("所选连接已删除，请重新选择。");
        let key = credentials::key(profile?)?;
        Ok((pool, key))
    }
    pub fn catalog_key(profile: &Connection) -> Result<Option<String>> {
        let _lock = Lock::acquire(&home(), "connections.lock")?;
        let pool = Self::load()?;
        if pool.items.iter().any(|saved| {
            saved.id == profile.id
                && !same_transport(saved, profile)
                && saved.api_key_env == profile.api_key_env
        }) {
            bail!("更换 API 地址或服务类型后，请填写新地址的 API Key，或提供新的密钥环境变量。");
        }
        if let Some(saved) = pool.items.iter().find(|p| {
            p.id == profile.id && same_transport(p, profile) && p.api_key_env == profile.api_key_env
        }) {
            credentials::key(saved)
        } else {
            Ok(std::env::var(&profile.api_key_env)
                .ok()
                .filter(|key| !key.trim().is_empty()))
        }
    }
    pub fn import(
        source: &str,
        items: Vec<Connection>,
        keys: HashMap<String, String>,
    ) -> Result<(Self, BTreeMap<String, String>)> {
        if source.is_empty() || source.len() > 512 {
            bail!("迁移来源不正确。");
        }
        let _lock = Lock::acquire(&home(), "connections.lock")?;
        let mut pool = Self::load()?;
        if let Some(mapping) = pool.imports.get(source).cloned() {
            return Ok((pool, mapping));
        }
        let mut mapping = BTreeMap::new();
        let mut pending = Vec::<(String, String)>::new();
        for mut profile in items {
            let old_id = profile.id.clone();
            profile.id = Uuid::parse_str(&old_id)
                .context("迁移连接的 ID 不正确。")?
                .to_string();
            profile.validate()?;
            let supplied = keys
                .get(&old_id)
                .filter(|key| !key.trim().is_empty())
                .cloned()
                .or_else(|| {
                    if profile.api_key_env.is_empty() {
                        None
                    } else {
                        std::env::var(&profile.api_key_env)
                            .ok()
                            .filter(|key| !key.trim().is_empty())
                    }
                });
            let mut matching = None;
            for existing in &pool.items {
                if same_profile(existing, &profile)
                    && (!profile.is_api() || supplied.is_some())
                    && credentials::key(existing)? == supplied
                {
                    matching = Some(existing.id.clone());
                    break;
                }
            }
            if let Some(id) = matching {
                mapping.insert(old_id, id);
                continue;
            }
            if pool.items.iter().any(|p| p.id == profile.id) {
                profile.id = Uuid::new_v4().to_string();
            }
            if pool.items.iter().any(|p| p.name == profile.name) {
                let suffix = if source.starts_with("cli:") {
                    "（CLI 迁移）"
                } else {
                    "（VS Code 迁移）"
                };
                profile.name = format!(
                    "{}{}",
                    profile.name.chars().take(60).collect::<String>(),
                    suffix
                );
            }
            if pool.items.len() >= 100 {
                bail!("迁移后超过 100 个连接，原配置保留。");
            }
            if let Some(key) = supplied {
                pending.push((profile.id.clone(), key));
            }
            mapping.insert(old_id, profile.id.clone());
            pool.items.push(profile);
        }
        let mut written = Vec::new();
        for (id, key) in &pending {
            let old = match credentials::read(id) {
                Ok(key) => key,
                Err(error) => {
                    rollback_keys(written)?;
                    return Err(error);
                }
            };
            if let Err(error) = credentials::write(id, key) {
                rollback_keys(written)?;
                return Err(error);
            }
            written.push((id.clone(), old));
        }
        pool.imports.insert(source.into(), mapping.clone());
        if let Err(error) = pool.commit() {
            rollback_keys(written)?;
            return Err(error);
        }
        Ok((pool, mapping))
    }
    fn snapshot(&self) -> Result<Value> {
        let mut items = Vec::new();
        for profile in &self.items {
            let mut value = serde_json::to_value(profile)?;
            value["hasKey"] = json!(credentials::key(profile)?.is_some());
            items.push(value);
        }
        Ok(json!({"version":1,"revision":self.revision,"items":items,"imports":self.imports}))
    }
}
fn same_profile(a: &Connection, b: &Connection) -> bool {
    let extras = |p: &Connection| {
        let mut extra = p.extra.clone();
        extra.remove("revision");
        extra.remove("hasKey");
        extra
    };
    a.name == b.name
        && same_transport(a, b)
        && a.model == b.model
        && a.reasoning_effort == b.reasoning_effort
        && a.token_limit_parameter == b.token_limit_parameter
        && extras(a) == extras(b)
}
pub(crate) fn same_transport(a: &Connection, b: &Connection) -> bool {
    if a.provider != b.provider {
        return false;
    }
    if a.is_api() {
        return matches!((a.endpoint(),b.endpoint()),(Ok(a),Ok(b)) if a==b);
    }
    a.provider != "claude" || a.executable == b.executable
}
pub fn source(label: &str, path: &Path) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{label}:{:x}",
        Sha256::digest(path.to_string_lossy().to_lowercase().as_bytes())
    )
}

pub fn dispatch(message: Value) -> Result<Value> {
    let action = message["action"].as_str().unwrap_or("");
    if action == "read" {
        return Pool::read()?.snapshot();
    }
    if action == "import" {
        let items =
            serde_json::from_value(message["items"].clone()).context("迁移连接格式不正确。");
        let keys = serde_json::from_value(message.get("keys").cloned().unwrap_or(json!({})))
            .context("迁移凭据格式不正确。");
        let (pool, mapping) =
            Pool::import(message["source"].as_str().unwrap_or(""), items?, keys?)?;
        return Ok(json!({"pool":pool.snapshot()?,"mapping":mapping}));
    }
    let _lock = Lock::acquire(&home(), "connections.lock")?;
    let mut pool = Pool::load()?;
    if action == "key" {
        let profile = pool
            .items
            .iter()
            .find(|p| Some(p.id.as_str()) == message["id"].as_str())
            .context("连接已删除，请重新选择。");
        let profile = profile?;
        let expected: Connection = serde_json::from_value(message["profile"].clone())
            .context("读取凭据需要对应的连接快照。")?;
        if profile.id != expected.id || !same_transport(profile, &expected) {
            bail!("连接已在其他窗口修改，请重新读取后再优化。");
        }
        return Ok(json!({"key":credentials::key(profile)?}));
    }
    pool.expected(message["revision"].as_str().unwrap_or(""))?;
    let id = message["id"].as_str().unwrap_or("");
    if action == "save" {
        let mut profile: Connection = serde_json::from_value(message["profile"].clone())?;
        let previous = pool.items.iter().position(|p| p.id == profile.id);
        if previous.is_none() && !profile.id.is_empty() {
            bail!("连接已删除，请重新读取。");
        }
        if previous.is_none() {
            profile.id = Uuid::new_v4().to_string();
            if pool.items.len() >= 100 {
                bail!("最多保存 100 个共享连接。");
            }
        }
        profile.validate()?;
        let prior_key = credentials::read(&profile.id)?;
        if previous.is_some_and(|index| !same_transport(&pool.items[index], &profile))
            && profile.is_api()
            && message["key"].as_str().is_none_or(str::is_empty)
        {
            bail!("更换 API 地址或服务类型后，请提供新地址的密钥。");
        }
        if let Some(key) = message.get("key") {
            if let Some(key) = key.as_str() {
                if key.is_empty() {
                    credentials::remove(&profile.id)?;
                    profile.api_key_env.clear();
                } else {
                    credentials::write(&profile.id, key)?;
                }
            } else {
                bail!("密钥格式不正确。");
            }
        }
        let saved_id = profile.id.clone();
        profile
            .extra
            .insert("revision".into(), json!(Uuid::new_v4().to_string()));
        if let Some(index) = previous {
            pool.items[index] = profile;
        } else {
            pool.items.push(profile);
        }
        if let Err(error) = pool.commit() {
            restore_key(&saved_id, prior_key)?;
            return Err(error);
        }
        return Ok(json!({"id":saved_id,"revision":pool.revision}));
    }
    let index = pool
        .items
        .iter()
        .position(|p| p.id == id)
        .context("连接已删除，请重新选择。");
    let index = index?;
    let key = credentials::read(id)?;
    match action {
        "remove" => {
            credentials::remove(id)?;
            pool.items.remove(index);
        }
        "clear-key" => {
            credentials::remove(id)?;
            pool.items[index].api_key_env.clear();
        }
        _ => bail!("不支持的共享连接操作。"),
    }
    if let Err(error) = pool.commit() {
        restore_key(id, key)?;
        return Err(error);
    }
    Ok(json!({"revision":pool.revision}))
}
fn restore_key(id: &str, key: Option<String>) -> Result<()> {
    if let Some(key) = key {
        credentials::write(id, &key)
    } else {
        credentials::remove(id)
    }
    .context("连接保存失败且凭据恢复失败，请检查 Windows 凭据访问权限。")
}
fn rollback_keys(changes: Vec<(String, Option<String>)>) -> Result<()> {
    for (id, key) in changes.into_iter().rev() {
        restore_key(&id, key)?;
    }
    Ok(())
}
