use crate::process::Process;
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{mpsc, watch},
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        Message,
    },
};

#[derive(Clone, Debug)]
pub struct Binding {
    pub id: String,
    pub cwd: String,
    pub model: String,
    pub busy: bool,
    pub detached: bool,
    pub empty: bool,
    pub generation: u64,
}
struct Tracked {
    request: Value,
    generation: u64,
    previous: Option<Binding>,
    selects: bool,
}
#[derive(Default)]
struct State {
    binding: Option<Binding>,
    generation: u64,
    initialized: Option<Value>,
    tracked: HashMap<String, Tracked>,
    front: Option<mpsc::Sender<Value>>,
    reason: String,
}
#[derive(Clone)]
pub struct Bridge {
    pub process: Process,
    state: Arc<Mutex<State>>,
    pub changed: watch::Sender<u64>,
    connected: Arc<AtomicBool>,
}
impl Bridge {
    pub async fn start(
        executable: &Path,
        cwd: &Path,
        config: &[String],
        token: String,
    ) -> Result<(Self, String)> {
        let mut args = config.to_vec();
        args.extend(["app-server".into(), "--listen".into(), "stdio://".into()]);
        let process = Process::spawn(executable, &args, cwd, false, &[])?;
        let (changed, _) = watch::channel(0);
        let bridge = Self {
            process,
            state: Arc::new(Mutex::new(State::default())),
            changed,
            connected: Arc::new(AtomicBool::new(false)),
        };
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("ws://{}", listener.local_addr()?);
        let mut events = bridge.process.subscribe();
        let backend = bridge.clone();
        let stop = backend.process.stopped();
        tokio::spawn(async move {
            loop {
                tokio::select! { _ = stop.cancelled() => break, event = events.recv() => match event { Ok(value) => backend.receive(value), Err(_) => { backend.process.close(); break; } } }
            }
            backend.invalidate("Codex 主服务已中断");
        });
        let server = bridge.clone();
        let stop = server.process.stopped();
        tokio::spawn(async move {
            loop {
                tokio::select! { _ = stop.cancelled() => break, accepted = listener.accept() => {
                    let Ok((socket, _)) = accepted else { break };
                    let peer = server.clone(); let token = token.clone();
                    tokio::spawn(async move {
                    let occupied = peer.connected.clone();
                    let reserved = Arc::new(AtomicBool::new(false));
                    let reservation = reserved.clone();
                        let handshake = accept_hdr_async(socket, move |request: &Request, response: Response| -> std::result::Result<Response, ErrorResponse> {
                            let expected = format!("Bearer {token}");
                            let supplied = request.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
                            if request.headers().contains_key("origin") || !bool::from(supplied.as_bytes().ct_eq(expected.as_bytes())) || occupied.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                                let mut rejected = ErrorResponse::new(Some("Forbidden".into()));
                                *rejected.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                                return Err(rejected);
                            }
                            reservation.store(true, Ordering::SeqCst);
                            Ok(response)
                        });
                        // 握手超时不能占住唯一连接；成功后的连接拥有完整生命周期。
                    let websocket = match tokio::time::timeout(std::time::Duration::from_secs(10), handshake).await { Ok(Ok(ws)) => ws, _ => { if reserved.load(Ordering::SeqCst) { peer.connected.store(false, Ordering::SeqCst); } return; } };
                        let (mut sink, mut stream) = websocket.split();
                        let (tx, mut rx) = mpsc::channel::<Value>(256);
                        peer.state.lock().unwrap().front = Some(tx);
                        let stop = peer.process.stopped(); let mut cached_initialize = false;
                        loop { tokio::select! {
                            _ = stop.cancelled() => break,
                            outgoing = rx.recv() => { let Some(value) = outgoing else { break }; if sink.send(Message::Text(value.to_string().into())).await.is_err() { break; } },
                            incoming = stream.next() => {
                                let Some(Ok(message)) = incoming else { break };
                                match message {
                                    Message::Text(text) if text.len() <= 32 * 1024 * 1024 => {
                                        let Ok(value) = serde_json::from_str::<Value>(&text) else { break };
                                        if !value.is_object() { break; }
                                        let cached = { let state = peer.state.lock().unwrap(); if value["method"] == "initialize" { state.initialized.clone() } else { None } };
                                        if let Some(result) = cached { cached_initialize = true; if sink.send(Message::Text(json!({"id":value["id"],"result":result}).to_string().into())).await.is_err() { break; } continue; }
                                        if cached_initialize && value["method"] == "initialized" { continue; }
                                        peer.track(&value);
                                        if peer.process.send(value).await.is_err() { break; }
                                    },
                                    Message::Ping(data) => { if sink.send(Message::Pong(data)).await.is_err() { break; } },
                                    Message::Pong(_) => {}, _ => break,
                                }
                            }
                        }}
                        peer.state.lock().unwrap().front = None;
                        peer.connected.store(false, Ordering::SeqCst);
                        peer.invalidate("原生终端连接已断开");
                    });
                }}
            }
        });
        Ok((bridge, endpoint))
    }
    fn advance(&self, state: &mut State) {
        state.generation += 1;
        let _ = self.changed.send_replace(state.generation);
    }
    pub fn invalidate(&self, reason: &str) {
        let mut state = self.state.lock().unwrap();
        state.binding = None;
        state.reason = reason.into();
        state.tracked.clear();
        self.advance(&mut state);
    }
    fn track(&self, value: &Value) {
        if value.get("id").is_none() || value.get("method").is_none() {
            return;
        }
        let method = value["method"].as_str().unwrap_or("");
        let selects = ["thread/start", "thread/resume", "thread/fork"].contains(&method)
            && value["params"]["ephemeral"] != true;
        let mut state = self.state.lock().unwrap();
        if selects {
            state.binding = None;
            state.reason = "正在创建或切换对话".into();
            self.advance(&mut state);
        }
        let same = state
            .binding
            .as_ref()
            .is_some_and(|b| value["params"]["threadId"] == b.id);
        let previous = if same && method == "turn/start" {
            state.binding.clone()
        } else {
            None
        };
        if same && ["turn/start", "thread/unsubscribe", "thread/revert"].contains(&method) {
            let binding = state.binding.as_mut().unwrap();
            if method == "turn/start" {
                binding.busy = true;
                binding.empty = false;
                if let Some(model) = value["params"]["model"].as_str() {
                    binding.model = model.into();
                }
            } else if method == "thread/unsubscribe" {
                binding.detached = true;
            }
            self.advance(&mut state);
        }
        let generation = state.generation;
        state.tracked.insert(
            value["id"].to_string(),
            Tracked {
                request: value.clone(),
                generation,
                previous,
                selects,
            },
        );
    }
    fn receive(&self, value: Value) {
        let mut state = self.state.lock().unwrap();
        if value.get("id").is_some() && value.get("method").is_none() {
            if let Some(tracked) = state.tracked.remove(&value["id"].to_string()) {
                let request = tracked.request;
                if request["method"] == "initialize" && value.get("result").is_some() {
                    state.initialized = Some(value["result"].clone());
                }
                if request["method"] == "turn/start"
                    && value.get("error").is_some()
                    && tracked.generation == state.generation
                    && state
                        .binding
                        .as_ref()
                        .is_some_and(|b| request["params"]["threadId"] == b.id)
                {
                    if let Some(previous) = tracked.previous {
                        state.binding = Some(previous);
                        self.advance(&mut state);
                    }
                }
                let result = &value["result"];
                let thread = &result["thread"];
                if tracked.selects
                    && tracked.generation == state.generation
                    && thread["ephemeral"] != true
                {
                    if let Some(id) = thread["id"].as_str() {
                        state.binding = Some(Binding {
                            id: id.into(),
                            cwd: result["cwd"]
                                .as_str()
                                .or(thread["cwd"].as_str())
                                .unwrap_or("")
                                .into(),
                            model: result["model"].as_str().unwrap_or("").into(),
                            busy: thread["status"]["type"] == "active",
                            detached: thread["status"]["type"] == "notLoaded",
                            empty: request["method"] == "thread/start"
                                && thread["turns"].as_array().is_some_and(Vec::is_empty),
                            generation: 0,
                        });
                        self.advance(&mut state);
                    }
                }
            }
        }
        if state
            .binding
            .as_ref()
            .is_some_and(|b| value["params"]["threadId"] == b.id)
        {
            let method = value["method"].as_str().unwrap_or("");
            let mut changed = true;
            match method {
                "thread/archived" | "thread/deleted" => {
                    state.binding = None;
                    state.reason = "当前对话已归档或删除".into();
                }
                "thread/closed" => state.binding.as_mut().unwrap().detached = true,
                "turn/started" | "turn/completed" | "thread/compacted" => {
                    let b = state.binding.as_mut().unwrap();
                    if method != "thread/compacted" {
                        b.busy = method == "turn/started";
                        b.empty = false;
                    }
                    // 已在执行的任务正常结束，不代表用户切换了对话或提交了新草稿。
                    changed = method != "turn/completed";
                }
                "thread/reverted" => {}
                "thread/status/changed" => {
                    let b = state.binding.as_mut().unwrap();
                    let busy = value["params"]["status"]["type"] == "active";
                    let detached = b.detached || value["params"]["status"]["type"] == "notLoaded";
                    changed = (!b.busy && busy) || b.detached != detached;
                    b.busy = busy;
                    b.detached = detached;
                }
                _ => changed = false,
            }
            if changed {
                self.advance(&mut state);
            }
        }
        if let Some(front) = &state.front {
            if front.try_send(value).is_err() {
                self.process.close();
            }
        }
    }
    pub fn peek(&self) -> Option<Binding> {
        let state = self.state.lock().unwrap();
        state.binding.clone().map(|mut b| {
            b.generation = state.generation;
            b
        })
    }
    pub fn current(&self) -> Result<Binding> {
        self.peek()
            .context("尚未准确绑定当前对话，请先新建或恢复会话。")
    }
    pub async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        if self.state.lock().unwrap().initialized.is_none()
            || !self.connected.load(Ordering::SeqCst)
        {
            bail!("Codex 尚未完成当前会话连接。");
        }
        self.process.call(method, params, 15).await
    }
    pub async fn current_ready(&self) -> Result<Binding> {
        let before = self
            .peek()
            .context("尚未准确绑定当前对话。")
            .and_then(|b| Ok(b))?;
        if !before.empty {
            let result = self
                .rpc(
                    "thread/read",
                    json!({"threadId":before.id,"includeTurns":false}),
                )
                .await?;
            let status = result["thread"]["status"]["type"].as_str().unwrap_or("");
            if result["thread"]["id"] != before.id
                || !["notLoaded", "idle", "active", "systemError"].contains(&status)
            {
                bail!("无法确认原对话状态，草稿未改动。");
            }
            let mut state = self.state.lock().unwrap();
            if !state.binding.as_ref().is_some_and(|b| b.id == before.id) {
                bail!("核对期间当前对话已切换，草稿未改动。");
            }
            if state.generation == before.generation {
                let b = state.binding.as_mut().unwrap();
                if b.detached || status == "active" {
                    b.busy = status == "active";
                }
            }
        }
        self.current()
    }
}
