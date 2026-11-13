use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>>;
struct Inner {
    tx: mpsc::Sender<Value>,
    pending: Pending,
    events: broadcast::Sender<Value>,
    stop: CancellationToken,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
#[derive(Clone)]
pub struct Process(Arc<Inner>);
struct RequestGuard {
    id: String,
    pending: Pending,
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

impl Process {
    pub fn spawn(
        executable: &Path,
        args: &[String],
        cwd: &Path,
        optimizer: bool,
        environment: &[(&str, &str)],
    ) -> Result<Self> {
        std::fs::create_dir_all(cwd)?;
        let mut command = Command::new(executable);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .creation_flags(0x08000000);
        command
            .env_remove("CODEX_THREAD_ID")
            .env_remove("CODEX_SESSION_ID");
        for (key, value) in environment {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .context("无法启动模型客户端，请检查程序路径和权限。")?;
        let mut stdin = child.stdin.take().context("无法连接客户端输入。")?;
        let stdout = child.stdout.take().context("无法连接客户端输出。")?;
        let (tx, mut rx) = mpsc::channel::<Value>(128);
        let (events, _) = broadcast::channel(1024);
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let stop = CancellationToken::new();
        let writer_stop = stop.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = writer_stop.cancelled() => break,
                    value = rx.recv() => {
                        let Some(value) = value else { break };
                        let mut bytes = value.to_string().into_bytes(); bytes.push(b'\n');
                        if stdin.write_all(&bytes).await.is_err() { break; }
                    }
                }
            }
            writer_stop.cancel();
        });
        let reader_stop = stop.clone();
        let reader_pending = pending.clone();
        let reader_events = events.clone();
        let reply = tx.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                tokio::select! {
                    _ = reader_stop.cancelled() => break,
                    read = reader.read_line(&mut line) => {
                        if !matches!(read, Ok(n) if n > 0) || line.len() > 32 * 1024 * 1024 { break; }
                        let Ok(value) = serde_json::from_str::<Value>(&line) else { break };
                        if value.get("id").is_some() && value.get("method").is_none() {
                            let id = value["id"].to_string();
                            let waiter = reader_pending.lock().unwrap().remove(&id);
                            if let Some(waiter) = waiter {
                                let result = if value.get("error").is_some() { Err(format!("客户端请求失败（{}），请检查登录、模型权限及配置。", value["error"]["code"])) } else { Ok(value["result"].clone()) };
                                let _ = waiter.send(result); continue;
                            }
                            if value["id"].as_str().is_some_and(|id| id.starts_with("cpo-rs:")) { continue; }
                        }
                        if optimizer && value.get("id").is_some() && value.get("method").is_some() {
                            let response = if value["method"] == "currentTime/read" { json!({"id":value["id"],"result":{"currentTimeAt":crate::config::now()}}) } else { json!({"id":value["id"],"error":{"code":-32601,"message":"Prompt optimizer does not accept tool or credential requests."}}) };
                            if reply.send(response).await.is_err() { break; }
                        } else { let _ = reader_events.send(value); }
                    }
                }
            }
            reader_stop.cancel();
            let _ = child.kill().await;
            for (_, waiter) in reader_pending.lock().unwrap().drain() {
                let _ = waiter.send(Err("模型客户端连接已结束。".into()));
            }
        });
        Ok(Self(Arc::new(Inner {
            tx,
            pending,
            events,
            stop,
        })))
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.0.events.subscribe()
    }
    pub fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
    pub fn stopped(&self) -> CancellationToken {
        self.0.stop.clone()
    }
    pub fn close(&self) {
        self.0.stop.cancel();
    }
    pub async fn send(&self, value: Value) -> Result<()> {
        tokio::select! { _ = self.0.stop.cancelled() => bail!("模型客户端已结束。"), result = self.0.tx.send(value) => result.context("模型客户端输入已断开。") }
    }
    pub async fn call(&self, method: &str, params: Value, seconds: u64) -> Result<Value> {
        let id = format!("cpo-rs:{}", Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        let key = json!(id).to_string();
        self.0.pending.lock().unwrap().insert(key.clone(), tx);
        let _guard = RequestGuard {
            id: key,
            pending: self.0.pending.clone(),
        };
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::select! {
            _ = self.0.stop.cancelled() => bail!("模型客户端已结束。"),
            result = tokio::time::timeout(Duration::from_secs(seconds), rx) => {
                match result { Ok(Ok(Ok(value))) => Ok(value), Ok(Ok(Err(message))) => bail!("{message}"), Ok(Err(_)) => bail!("客户端请求已结束。"), Err(_) => bail!("客户端 {method} 响应超时。") }
            }
        }
    }
}
