use crate::{
    bridge::{Binding, Bridge},
    config::{self, Config},
    optimizer::{self, Engine, Session},
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone)]
struct Entry {
    original: String,
    candidate: String,
    context_hash: String,
    config_hash: String,
    session: Session,
    model: String,
    model_ms: u128,
    reused: bool,
    template_name: String,
    updated_at: String,
}
struct Review {
    id: String,
    revision: u64,
    generation: Option<u64>,
    actions: mpsc::Sender<Value>,
    cancel: CancellationToken,
    job: Option<CancellationToken>,
    waiting: bool,
    writing: bool,
    interrupt_settings: bool,
}
struct Pending {
    action: String,
    instructions: String,
    thread: String,
    generation: u64,
}
struct State {
    config: Config,
    entries: VecDeque<(String, Entry)>,
    review: Option<Review>,
    next: Option<Pending>,
}
struct Work {
    id: String,
    filename: PathBuf,
    draft: String,
    original: String,
    binding: Option<Binding>,
    context_turn_ids: Option<Vec<String>>,
    entry: Option<Entry>,
    previous: Option<Entry>,
    retained: bool,
}
#[derive(Clone)]
pub struct Runtime {
    bridge: Bridge,
    state: Arc<Mutex<State>>,
    engine: Arc<tokio::sync::Mutex<Engine>>,
    id: String,
}
impl Runtime {
    pub fn new(bridge: Bridge, executable: PathBuf, config: Config, id: String) -> Self {
        let runtime = Self {
            bridge,
            state: Arc::new(Mutex::new(State {
                config,
                entries: VecDeque::new(),
                review: None,
                next: None,
            })),
            engine: Arc::new(tokio::sync::Mutex::new(Engine::new(executable))),
            id,
        };
        let mut changed = runtime.bridge.changed.subscribe();
        let observed = runtime.clone();
        let stop = runtime.bridge.process.stopped();
        tokio::spawn(async move {
            loop {
                tokio::select! { _ = stop.cancelled() => { observed.dispose(); break; }, result = changed.changed() => {
                    if result.is_err() { break; }
                    let generation = *changed.borrow_and_update();
                    if let Some(review) = &observed.state.lock().unwrap().review { if review.generation.is_some_and(|v| v != generation) { review.cancel.cancel(); if let Some(job) = &review.job { job.cancel(); } } }
                }}
            }
        });
        runtime
    }
    pub fn status(&self) -> Value {
        let state = self.state.lock().unwrap();
        let profile = state.config.selected();
        let binding = self.bridge.peek();
        json!({"id":self.id,"editorProtocol":8,"implementation":"rust","autoApply":state.config.auto_apply,"cwd":binding.as_ref().map(|b|&b.cwd),"threadId":binding.as_ref().map(|b|&b.id),"busy":state.review.as_ref().is_some_and(|r|r.job.is_some()),"reviewing":state.review.is_some(),"provider":profile.provider,"connectionName":profile.name,"model":if profile.model.is_empty(){binding.as_ref().map(|b|b.model.clone()).filter(|m|!m.is_empty()).unwrap_or_else(||"跟随客户端模型".into())}else{profile.model},"reasoningEffort":profile.reasoning_effort,"template":state.config.template,"pendingAction":state.next.as_ref().map(|p|p.action.as_str()).unwrap_or("optimize")})
    }
    pub fn queue(&self, action: &str, instructions: &str) -> Result<Value> {
        if instructions.chars().count() > 4000 {
            bail!("修改要求不能超过 4000 字。");
        }
        let binding = if action == "settings" {
            None
        } else {
            Some(self.bridge.current()?)
        };
        let mut state = self.state.lock().unwrap();
        if state.review.is_some() {
            bail!("面板已打开，请直接在面板操作。");
        }
        if let Some(binding) = &binding {
            if !state.entries.iter().any(|(id, _)| *id == binding.id) {
                bail!("这个对话还没有可继续或恢复的优化。");
            }
        }
        state.next = Some(Pending {
            action: action.into(),
            instructions: instructions.into(),
            thread: binding.as_ref().map(|b| b.id.clone()).unwrap_or_default(),
            generation: binding.map(|b| b.generation).unwrap_or(0),
        });
        Ok(json!({"message":"已准备操作，请回到对应 Codex 按 Ctrl+G。"}))
    }
    fn assert_current(&self, work: &Work) -> Result<()> {
        let state = self.state.lock().unwrap();
        let review = state
            .review
            .as_ref()
            .filter(|r| r.id == work.id)
            .context("预览已结束。");
        let review = review?;
        if review.cancel.is_cancelled() {
            bail!("预览已取消或当前对话发生变化，草稿未改动。");
        }
        if let Some(binding) = &work.binding {
            if self.bridge.current()?.generation != binding.generation {
                bail!("当前对话已变化，请重新按 Ctrl+G。");
            }
        }
        Ok(())
    }
    async fn job<T>(&self, work: &Work, future: impl Future<Output = Result<T>>) -> Result<T> {
        self.assert_current(work)?;
        let token = CancellationToken::new();
        let (review_cancel, seconds) = {
            let mut state = self.state.lock().unwrap();
            let seconds = state.config.timeout_seconds;
            let review = state.review.as_mut().context("面板已结束。");
            let review = review?;
            if review.job.is_some() {
                bail!("已有请求正在处理。");
            }
            review.job = Some(token.clone());
            (review.cancel.clone(), seconds)
        };
        let result = tokio::select! {
            _ = token.cancelled() => Err(anyhow::anyhow!("优化已取消；草稿未改动。")),
            _ = review_cancel.cancelled() => Err(anyhow::anyhow!("会话已变化或面板已关闭；草稿未改动。")),
            result = tokio::time::timeout(std::time::Duration::from_secs(seconds), future) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("优化超时；草稿未改动。"))),
        };
        if let Some(review) = self
            .state
            .lock()
            .unwrap()
            .review
            .as_mut()
            .filter(|r| r.id == work.id)
        {
            review.job = None;
        }
        result
    }
    async fn context(
        &self,
        binding: &Binding,
        config: &Config,
        engine: &mut Engine,
        turn_ids: Option<&[String]>,
    ) -> Result<(Vec<Value>, String, Vec<String>)> {
        if !config.context_enabled {
            return Ok((vec![], hash("context-disabled"), vec![]));
        }
        if binding.empty {
            return Ok((vec![], hash("[]"), vec![]));
        }
        // 多读一轮，原任务结束后仍能核对优化开始时选中的历史，不让新回复挤掉边界。
        let limit = config.recent_turns + usize::from(binding.busy);
        let params = json!({"threadId":binding.id,"limit":limit,"sortDirection":"desc","itemsView":"full"});
        let page = match self.bridge.rpc("thread/turns/list", params.clone()).await {
            Ok(page) => page,
            Err(error) if error.to_string().contains("-32601") => {
                let agent = engine.codex().await?;
                let metadata = agent
                    .process
                    .call(
                        "thread/read",
                        json!({"threadId":binding.id,"includeTurns":false}),
                        30,
                    )
                    .await?;
                if metadata["thread"]["id"] != binding.id {
                    bail!("历史对话 ID 不一致。");
                }
                if metadata["thread"]["historyMode"] == "legacy" {
                    let full = agent
                        .process
                        .call(
                            "thread/read",
                            json!({"threadId":binding.id,"includeTurns":true}),
                            30,
                        )
                        .await?;
                    if full["thread"]["id"] != binding.id {
                        bail!("历史对话 ID 不一致。");
                    }
                    json!({"data":full["thread"]["turns"].as_array().context("历史记录不完整。")?.iter().rev().take(limit).cloned().collect::<Vec<_>>()})
                } else {
                    agent.process.call("thread/turns/list", params, 30).await?
                }
            }
            Err(error) => return Err(error),
        };
        let turns = page["data"]
            .as_array()
            .context("Codex 未返回可用聊天记录。");
        let turns: Vec<&Value> = turns?
            .iter()
            .filter(|turn| match turn_ids {
                Some(ids) => turn["id"]
                    .as_str()
                    .is_some_and(|id| ids.iter().any(|saved| saved == id)),
                None => !binding.busy || turn["status"] == "completed",
            })
            .take(config.recent_turns)
            .collect();
        let selected_ids = turns
            .iter()
            .map(|turn| {
                turn["id"]
                    .as_str()
                    .map(str::to_owned)
                    .context("历史轮次缺少 ID。")
            })
            .collect::<Result<Vec<_>>>()?;
        if turn_ids.is_some_and(|ids| ids != selected_ids.as_slice()) {
            bail!("本次参考的历史轮次已变化，请重新优化。");
        }
        let mut messages = vec![];
        for turn in turns.iter().rev() {
            let items = turn["items"]
                .as_array()
                .context("聊天记录未包含完整消息。")?;
            for item in items {
                let message = if item["type"] == "userMessage" {
                    Some((
                        "user",
                        item["content"]
                            .as_array()
                            .context("用户消息格式不正确。")?
                            .iter()
                            .filter_map(|p| match p["type"].as_str() {
                                Some("text") => p["text"].as_str().map(str::to_owned),
                                Some("image" | "localImage") => {
                                    Some("[对话中有图片，本次未读取原图]".into())
                                }
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ))
                } else if item["type"] == "agentMessage"
                    && (item["phase"].is_null() || item["phase"] == "final_answer")
                {
                    Some(("assistant", item["text"].as_str().unwrap_or("").into()))
                } else {
                    None
                };
                if let Some((role, text)) = message {
                    if !text.trim().is_empty() {
                        messages.push(json!({"role":role,"text":text}));
                    }
                }
            }
        }
        let mut remaining = config.max_context_chars;
        let mut selected = std::collections::BTreeMap::<usize, Value>::new();
        for (role, budget) in [
            ("user", config.max_context_chars / 2),
            ("assistant", config.max_context_chars),
            ("user", config.max_context_chars),
        ] {
            let mut available = remaining.min(budget);
            for (index, message) in messages.iter().enumerate().rev() {
                if message["role"] != role || available == 0 {
                    continue;
                }
                let text = message["text"].as_str().unwrap_or("");
                let retained = selected
                    .get(&index)
                    .and_then(|v| v["text"].as_str())
                    .map(|s| s.encode_utf16().count())
                    .unwrap_or(0);
                let count = (text.encode_utf16().count() - retained).min(available);
                if count == 0 {
                    continue;
                }
                selected.insert(
                    index,
                    json!({"role":role,"text":tail_utf16(text,retained+count)}),
                );
                available -= count;
                remaining -= count;
            }
        }
        let messages: Vec<Value> = selected.into_values().collect();
        let digest = hash(&serde_json::to_string(&messages)?);
        Ok((messages, digest, selected_ids))
    }
    async fn generate(
        &self,
        work: &mut Work,
        continuing: bool,
        instructions: &str,
        notify: &mpsc::Sender<Value>,
    ) -> Result<()> {
        let (config, api_key) = {
            let mut state = self.state.lock().unwrap();
            let snapshot = state.config.request_snapshot()?;
            state.config = snapshot.0.clone();
            snapshot
        };
        let mut session = Session::default();
        let mut context_turn_ids = work.context_turn_ids.clone();
        let generated = self.job(work, async {
            let binding = work.binding.as_ref().context("还没有绑定聊天。"); let binding = binding?;
            let mut engine = self.engine.lock().await;
            notify.send(json!({"type":"progress","message":if binding.busy {"正在读取已完成的参考聊天…"} else {"正在读取参考聊天…"}})).await.ok();
            let (context,context_hash,turn_ids) = self.context(binding,&config,&mut engine,context_turn_ids.as_deref()).await?;
            if binding.busy && config.context_enabled { context_turn_ids = Some(turn_ids); }
            let mut profile = config.selected();
            if profile.provider == "codex" {
                let agent = engine.codex().await?; if agent.models.is_empty() { agent.catalog().await?; }
                if profile.model.is_empty() { profile.model = if !binding.model.is_empty() { binding.model.clone() } else if !agent.configured.is_empty() { agent.configured.clone() } else { agent.models.iter().find(|m|m["isDefault"] == true).and_then(|m|m["model"].as_str()).unwrap_or("").into() }; }
            }
            let mut fingerprint = serde_json::to_value(&config)?;for name in ["autoApply","connections","poolRevision","poolFingerprint","localRevision","modelOverrides","storedApiKeys"]{fingerprint.as_object_mut().unwrap().remove(name);}fingerprint["effectiveConnection"] = serde_json::to_value(&profile)?;
            let config_hash = hash(&fingerprint.to_string());
            let reused = continuing && work.entry.as_ref().is_some_and(|e|e.context_hash == context_hash && e.config_hash == config_hash);
            if reused { session = work.entry.as_ref().unwrap().session.clone(); }
            let revision = if continuing { work.entry.as_ref().map(|e|(e.candidate.as_str(),instructions)) } else { None };
            let prepared = optimizer::prepare(&work.original,&context,&config.template,revision)?;
            notify.send(json!({"type":"progress","generating":true,"message":format!("正在优化 · {} · {}",profile.model,config::template_name(&config.template))})).await.ok();
            let output = engine.optimize(&prepared,&config,&profile,api_key.as_deref(),&mut session,notify).await?;
            if markers(&output.text) != markers(&work.draft) { bail!("模型改变了图片附件占位，草稿未改动。"); }
            if self.context(binding,&config,&mut engine,context_turn_ids.as_deref()).await?.1 != context_hash { bail!("优化期间参考聊天发生变化，请重新优化。"); }
            self.assert_current(work)?; unchanged(work)?;
            Ok(Entry { original:work.original.clone(),candidate:output.text,context_hash,config_hash,session:session.clone(),model:output.model,model_ms:output.milliseconds,reused:output.reused,template_name:config::template_name(&config.template),updated_at:config::timestamp() })
        }).await;
        match generated {
            Ok(entry) => {
                work.context_turn_ids = context_turn_ids;
                if let Some(old) = work.entry.as_mut() {
                    if !same_session(&old.session, &entry.session) {
                        old.session.release();
                    }
                }
                work.entry = Some(entry);
                Ok(())
            }
            Err(error) => {
                session.release();
                self.engine.lock().await.reset();
                Err(error)
            }
        }
    }
    async fn apply(&self, work: &mut Work, restore: bool) -> Result<Value> {
        self.bridge.current_ready().await?;
        self.assert_current(work)?;
        let text = if restore {
            work.original.clone()
        } else {
            work.entry
                .as_ref()
                .context("还没有可应用的结果。")?
                .candidate
                .clone()
        };
        let config = self.state.lock().unwrap().config.clone();
        if !restore && text != work.draft {
            let mut engine = self.engine.lock().await;
            if self
                .context(
                    work.binding.as_ref().unwrap(),
                    &config,
                    &mut engine,
                    work.context_turn_ids.as_deref(),
                )
                .await?
                .1
                != work.entry.as_ref().unwrap().context_hash
            {
                bail!("参考聊天或上下文设置已变化，请重新优化。");
            }
        }
        unchanged(work)?;
        let mut backups = serde_json::Map::new();
        {
            let state = self.state.lock().unwrap();
            for (id, entry) in &state.entries {
                backups.insert(id.clone(),json!({"original":entry.original,"candidate":entry.candidate,"model":entry.model,"updatedAt":entry.updated_at}));
            }
        }
        let binding = work.binding.as_ref().unwrap();
        backups.insert(binding.id.clone(),json!({"original":work.original,"candidate":if restore {&work.draft}else{&text},"restoredTo":if restore{Some(&text)}else{None},"updatedAt":config::timestamp()}));
        config::write_json(
            &config::home()
                .join("backups")
                .join(format!("{}.json", self.id)),
            &backups,
        )?;
        config::atomic_write(&work.filename, text.as_bytes(), || {
            self.assert_current(work)?;
            unchanged(work)
        })?;
        let mut state = self.state.lock().unwrap();
        if let Some(index) = state.entries.iter().position(|(id, _)| *id == binding.id) {
            let (_, mut old) = state.entries.remove(index).unwrap();
            if restore
                || !work
                    .entry
                    .as_ref()
                    .is_some_and(|e| same_session(&old.session, &e.session))
            {
                old.session.release();
            }
        }
        if restore {
            if let Some(entry) = work.entry.as_mut() {
                entry.session.release();
            }
        } else {
            state
                .entries
                .push_back((binding.id.clone(), work.entry.clone().unwrap()));
            work.retained = true;
            if state.entries.len() > 8 {
                if let Some((_, mut entry)) = state.entries.pop_front() {
                    entry.session.release();
                }
            }
        }
        Ok(
            json!({"applied":true,"restored":restore,"message":if restore{"已恢复原文，尚未发送。"}else{"已填回草稿，尚未发送。"}}),
        )
    }
    pub fn action(&self, message: Value) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        let review = state.review.as_mut().context("预览已结束。");
        let review = review?;
        if message["reviewId"] != review.id
            || message["revision"].as_u64() != Some(review.revision)
            || review.cancel.is_cancelled()
        {
            bail!("预览已更新，请使用当前面板。");
        }
        if message["choice"] == "settings" && review.job.is_some() {
            review.interrupt_settings = true;
            review.job.as_ref().unwrap().cancel();
            return Ok(json!({"accepted":true}));
        }
        if review.job.is_some() || !review.waiting {
            bail!("正在处理，请稍候或按 Esc 取消。");
        }
        let choice = message["choice"].as_str().unwrap_or("");
        if ![
            "optimize",
            "continue",
            "apply",
            "restore",
            "discard",
            "settings",
            "configure",
            "back",
        ]
        .contains(&choice)
        {
            bail!("不支持的面板操作。");
        }
        if message["instructions"]
            .as_str()
            .unwrap_or("")
            .chars()
            .count()
            > 4000
        {
            bail!("修改要求不能超过 4000 字。");
        }
        review
            .actions
            .try_send(message)
            .context("面板操作已结束。")?;
        // 一次只接受一个操作；状态推进后再次发出 ready。
        review.waiting = false;
        Ok(json!({"accepted":true}))
    }
    pub fn cancel(&self) -> Value {
        let mut state = self.state.lock().unwrap();
        if let Some(review) = &state.review {
            if review.writing {
                return json!({"message":"正在写回，请等待草稿显示。"});
            }
            if let Some(job) = &review.job {
                job.cancel();
            } else if review.waiting {
                let _ = review.actions.try_send(json!({"choice":"discard"}));
            }
        } else {
            state.next = None;
        }
        json!({"message":"已请求取消，尚未写回的草稿保留。"})
    }
    pub async fn model_options(&self, message: &Value) -> Result<Value> {
        let config: Config = serde_json::from_value(message["config"].clone())?;
        let profile = config.selected();
        profile.validate_for_catalog()?;
        let api_key = message["apiKey"].as_str();
        if let Some(key) = api_key {
            crate::credentials::validate_key(key)?;
            if !profile.is_api() {
                bail!("此连接不使用 API Key。");
            }
        }
        let work = {
            let state = self.state.lock().unwrap();
            let review = state
                .review
                .as_ref()
                .filter(|r| {
                    Some(r.id.as_str()) == message["reviewId"].as_str()
                        && r.waiting
                        && r.job.is_none()
                })
                .context("面板状态已变化。");
            let review = review?;
            Work {
                id: review.id.clone(),
                filename: PathBuf::new(),
                draft: String::new(),
                original: String::new(),
                binding: if review.generation.is_some() {
                    self.bridge.peek()
                } else {
                    None
                },
                context_turn_ids: None,
                entry: None,
                previous: None,
                retained: false,
            }
        };
        self.job(&work, async {
            let mut engine = self.engine.lock().await;
            let mut catalog = engine.catalog_with_key(&profile, api_key).await?;
            catalog["effectiveModel"] = json!(if !profile.model.is_empty() {
                profile.model
            } else if profile.provider == "codex" {
                self.bridge
                    .peek()
                    .map(|b| b.model)
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| catalog["configuredModel"].as_str().unwrap_or("").into())
            } else {
                String::new()
            });
            Ok(catalog)
        })
        .await
    }
    async fn configure(
        &self,
        work: &Work,
        mut config: Config,
        keys: std::collections::HashMap<String, String>,
    ) -> Result<()> {
        {
            let state = self.state.lock().unwrap();
            config.pool_fingerprint = state.config.pool_fingerprint.clone();
            config.pool_revision = state.config.pool_revision.clone();
            config.local_revision = state.config.local_revision.clone();
        }
        config.validate()?;
        let profile = config.selected();
        profile.validate()?;
        let old = self.state.lock().unwrap().config.selected();
        if profile != old && !profile.is_api() {
            let catalog = self
                .job(work, async {
                    self.engine.lock().await.catalog(&profile).await
                })
                .await?;
            let models = catalog["models"].as_array().context("模型目录不正确。");
            let models = models?;
            let effective = if !profile.model.is_empty() {
                profile.model.clone()
            } else if profile.provider == "codex" {
                work.binding
                    .as_ref()
                    .map(|b| b.model.clone())
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| catalog["configuredModel"].as_str().unwrap_or("").into())
            } else {
                String::new()
            };
            let model = models.iter().find(|m| m["model"] == effective);
            if model.is_none()
                && !(profile.provider == "claude"
                    && effective.is_empty()
                    && profile.reasoning_effort == "auto")
            {
                bail!("请选择模型目录中的可用模型。");
            }
            if profile.reasoning_effort != "auto"
                && !model.is_some_and(|m| {
                    m["supportedReasoningEfforts"].as_array().is_some_and(|e| {
                        e.iter()
                            .any(|e| e["reasoningEffort"] == profile.reasoning_effort)
                    })
                })
            {
                bail!("当前模型不支持这个思考程度。");
            }
        }
        if profile.is_api()
            && profile.reasoning_effort != "auto"
            && !config::API_EFFORTS.contains(&profile.reasoning_effort.as_str())
        {
            bail!("API 不支持这个思考档位。");
        }
        self.assert_current(work)?;
        config.save_with_keys(&keys)?;
        let mut state = self.state.lock().unwrap();
        if profile != old {
            for (_, entry) in &mut state.entries {
                entry.session.release();
            }
        }
        state.config = config;
        Ok(())
    }
    pub async fn open_review(
        &self,
        filename: &Path,
        direct: bool,
        notify: mpsc::Sender<Value>,
        cancel: CancellationToken,
    ) -> Result<Value> {
        let id = Uuid::new_v4().to_string();
        let (actions, mut receiver) = mpsc::channel(4);
        {
            let mut state = self.state.lock().unwrap();
            if state.review.is_some() {
                bail!("这个入口已有面板，请先关闭原面板。");
            }
            state.review = Some(Review {
                id: id.clone(),
                revision: 0,
                generation: None,
                actions,
                cancel: cancel.clone(),
                job: None,
                waiting: false,
                writing: false,
                interrupt_settings: false,
            });
        }
        let mut work = Work {
            id,
            filename: PathBuf::new(),
            draft: String::new(),
            original: String::new(),
            binding: None,
            context_turn_ids: None,
            entry: None,
            previous: None,
            retained: false,
        };
        let result = self
            .review_loop(&mut work, filename, direct, &notify, &cancel, &mut receiver)
            .await;
        if !work.retained {
            if let Some(entry) = work.entry.as_mut() {
                if !work
                    .previous
                    .as_ref()
                    .is_some_and(|p| same_session(&p.session, &entry.session))
                {
                    entry.session.release();
                }
            }
        }
        self.state.lock().unwrap().review = None;
        result
    }
    async fn review_loop(
        &self,
        work: &mut Work,
        filename: &Path,
        mut direct: bool,
        notify: &mpsc::Sender<Value>,
        cancel: &CancellationToken,
        receiver: &mut mpsc::Receiver<Value>,
    ) -> Result<Value> {
        let root = std::fs::canonicalize(config::codex_home().join("editor"))
            .context("Codex 草稿目录不可访问。");
        let root = root?;
        let actual = std::fs::canonicalize(filename).context("草稿文件不可访问。");
        let actual = actual?;
        let metadata = std::fs::metadata(&actual)?;
        if !filename.is_absolute()
            || !actual.starts_with(&root)
            || actual == root
            || actual
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| !e.eq_ignore_ascii_case("md"))
                .unwrap_or(true)
            || !metadata.is_file()
            || metadata.len() > 400000
        {
            bail!("只接受 Codex 临时编辑目录中的 Markdown 草稿。");
        }
        work.filename = actual;
        work.draft = std::fs::read_to_string(&work.filename)?;
        if work.draft.encode_utf16().count() > 100000 {
            bail!("草稿超过单次长度限制。");
        }
        let empty = work.draft.trim().is_empty();
        if !empty {
            work.binding = Some(self.bridge.current_ready().await?);
        }
        let (pending, config) = {
            let mut state = self.state.lock().unwrap();
            state.review.as_mut().unwrap().generation = work.binding.as_ref().map(|b| b.generation);
            state.config.refresh_pool()?;
            state.config.refresh_local_revision()?;
            if let Some(binding) = &work.binding {
                work.previous = state
                    .entries
                    .iter()
                    .find(|(id, _)| *id == binding.id)
                    .map(|(_, e)| e.clone());
            }
            (state.next.take(), state.config.clone())
        };
        self.assert_current(work)?;
        if let Some(pending) = &pending {
            if !empty
                && pending.action != "settings"
                && !work
                    .binding
                    .as_ref()
                    .is_some_and(|b| b.id == pending.thread && b.generation == pending.generation)
            {
                bail!("准备操作后对话已变化，请重新选择。");
            }
        }
        work.entry = work.previous.clone().filter(|e| e.candidate == work.draft);
        if !empty
            && pending.as_ref().is_some_and(|p| p.action != "settings")
            && work.entry.is_none()
        {
            bail!("草稿已经改变，请重新优化。");
        }
        work.original = work
            .entry
            .as_ref()
            .map(|e| e.original.clone())
            .unwrap_or_else(|| work.draft.clone());
        direct = direct && !empty && !pending.as_ref().is_some_and(|p| p.action == "settings");
        notify.send(json!({"type":"opened","reviewId":work.id,"revision":0,"draft":work.draft,"original":work.original,"empty":empty,"direct":direct,"config":config})).await.context("面板已关闭。")?;
        let mut action = json!({"choice":if empty || pending.as_ref().is_some_and(|p|p.action == "settings"){"settings"}else if let Some(p) = &pending { if p.action == "undo" {"restore"}else{"continue"} }else if work.entry.is_some(){if direct{"continue"}else{"back"}}else{"optimize"},"instructions":pending.as_ref().map(|p|p.instructions.as_str()).unwrap_or("")});
        loop {
            self.assert_current(work)?;
            let choice = action["choice"].as_str().unwrap_or("back");
            let mut error = None;
            let mut message = None;
            let mut options = None;
            let execution = async {
                match choice {
                    "discard" => {
                        return Ok(Some(
                            json!({"applied":false,"message":"已返回 Codex，草稿未改动。"}),
                        ))
                    }
                    "optimize" | "continue" => {
                        if empty {
                            bail!("输入框为空，请返回 Codex 填写草稿。");
                        }
                        if choice == "continue" && work.entry.is_none() {
                            bail!("请先生成优化结果。");
                        }
                        self.generate(
                            work,
                            choice == "continue",
                            action["instructions"].as_str().unwrap_or(""),
                            notify,
                        )
                        .await?;
                    }
                    "settings" => options = Some(json!({"templates":config::templates()})),
                    "configure" => {
                        self.configure(
                            work,
                            serde_json::from_value(action["config"].clone())?,
                            serde_json::from_value(
                                action.get("apiKeys").cloned().unwrap_or(json!({})),
                            )
                            .context("API Key 请求格式不正确。")?,
                        )
                        .await?;
                        work.context_turn_ids = None;
                        message = Some("已保存；应用方式在下次 Ctrl+G 生效。".to_string());
                    }
                    _ => {}
                }
                if choice == "apply" || choice == "restore" || direct {
                    self.state.lock().unwrap().review.as_mut().unwrap().writing = true;
                    let result = self.apply(work, choice == "restore").await;
                    self.state.lock().unwrap().review.as_mut().unwrap().writing = false;
                    return result.map(Some);
                }
                Ok(None)
            }
            .await;
            match execution {
                Ok(Some(result)) => return Ok(result),
                Ok(None) => {}
                Err(failure) => {
                    if cancel.is_cancelled() {
                        return Err(failure);
                    }
                    let interrupted = {
                        let mut state = self.state.lock().unwrap();
                        let review = state.review.as_mut().unwrap();
                        let flag = review.interrupt_settings;
                        review.interrupt_settings = false;
                        flag
                    };
                    if interrupted {
                        direct = false;
                        action = json!({"choice":"settings"});
                        continue;
                    }
                    let failure = failure.to_string();
                    config::error_record(&self.id, &failure);
                    if direct {
                        if failure.starts_with("优化已取消") {
                            return Ok(json!({"applied":false,"cancelled":true,"message":failure}));
                        }
                        bail!("{failure}");
                    }
                    if choice == "configure" {
                        options = Some(
                            json!({"templates":config::templates(),"draftConfig":action["config"]}),
                        );
                    }
                    error = Some(failure);
                }
            }
            self.assert_current(work)?;
            let (revision, config) = {
                let mut state = self.state.lock().unwrap();
                let review = state.review.as_mut().unwrap();
                review.revision += 1;
                review.waiting = true;
                (review.revision, state.config.clone())
            };
            notify.send(json!({"type":"ready","reviewId":work.id,"revision":revision,"candidate":work.entry.as_ref().map(|e|&e.candidate),"model":work.entry.as_ref().map(|e|&e.model),"modelMs":work.entry.as_ref().map(|e|e.model_ms),"sessionReused":work.entry.as_ref().map(|e|e.reused),"templateName":work.entry.as_ref().map(|e|&e.template_name),"empty":empty,"config":config,"error":error,"message":message,"options":options,"configurationSaved":choice=="configure"&&error.is_none()})).await.context("面板已关闭。")?;
            action = tokio::select! { _ = cancel.cancelled() => bail!("面板已关闭，草稿未改动。"), value = receiver.recv() => value.context("面板已关闭。")? };
        }
    }
    pub fn dispose(&self) {
        let mut state = self.state.lock().unwrap();
        if let Some(review) = &state.review {
            review.cancel.cancel();
            if let Some(job) = &review.job {
                job.cancel();
            }
        }
        for (_, entry) in &mut state.entries {
            entry.session.release();
        }
    }
}
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn tail_utf16(text: &str, limit: usize) -> String {
    let mut used = 0;
    text.chars()
        .rev()
        .take_while(|c| {
            used += c.len_utf16();
            used <= limit
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}
fn unchanged(work: &Work) -> Result<()> {
    if std::fs::read_to_string(&work.filename)? != work.draft {
        bail!("草稿文件已经改变，没有覆盖。");
    }
    Ok(())
}
fn markers(text: &str) -> Vec<String> {
    text.match_indices("[Image #")
        .filter_map(|(i, _)| {
            let rest = &text[i + 8..];
            let end = rest.find(']')?;
            if end > 0 && rest[..end].bytes().all(|c| c.is_ascii_digit()) {
                Some(text[i..i + 8 + end + 1].into())
            } else {
                None
            }
        })
        .collect()
}
fn same_session(a: &Session, b: &Session) -> bool {
    a.codex
        .as_ref()
        .zip(b.codex.as_ref())
        .is_some_and(|((pa, ta), (pb, tb))| ta == tb && pa.same(pb))
        || a.claude
            .as_ref()
            .zip(b.claude.as_ref())
            .is_some_and(|(a, b)| a.same(b))
}
