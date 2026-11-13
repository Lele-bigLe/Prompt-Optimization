use crate::{config, runtime::Runtime};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{ClientOptions, ServerOptions},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub token: String,
    pub pid: u32,
    pub cwd: String,
    pub started_at: Value,
    #[serde(default)]
    pub runtime_version: String,
    #[serde(default)]
    pub runtime_path: String,
}
pub fn pipe(id: &str) -> Result<String> {
    Uuid::parse_str(id).context("入口 ID 不正确，请运行 sessions 查看。")?;
    Ok(format!(r"\\.\pipe\prompt-optimizer-{id}"))
}
pub fn load(id: &str) -> Result<Run> {
    pipe(id)?;
    let value = config::read_json(&config::home().join("runs").join(format!("{id}.json")))?
        .context("未找到这个入口，请运行 sessions 查看。");
    let run: Run = serde_json::from_value(value?)?;
    if run.id != id || run.token.is_empty() {
        bail!("入口文件不正确。");
    }
    Ok(run)
}
async fn line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    maximum: usize,
) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    let count = reader
        .take(maximum as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .await?;
    if count == 0 {
        return Ok(None);
    }
    if count > maximum || bytes.last() != Some(&b'\n') {
        bail!("本地消息过大或不完整。");
    }
    Ok(Some(
        serde_json::from_slice(&bytes).context("本地消息格式不正确。")?,
    ))
}
pub async fn request(
    run: &Run,
    mut message: Value,
    events: Option<mpsc::Sender<Value>>,
) -> Result<Value> {
    let name = pipe(&run.id)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut client = loop {
        match ClientOptions::new().open(&name) {
            Ok(pipe) => break pipe,
            Err(e) if e.raw_os_error() == Some(231) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(30)).await
            }
            Err(_) => bail!("无法连接对应入口，请确认终端仍在运行。"),
        }
    };
    message["token"] = json!(run.token);
    client.write_all(format!("{message}\n").as_bytes()).await?;
    let mut reader = BufReader::new(client);
    loop {
        let read = line(&mut reader, 2 * 1024 * 1024);
        let value = if events.is_some() {
            read.await?
        } else {
            tokio::time::timeout(Duration::from_secs(360), read)
                .await
                .context("优化器响应超时。")??
        }
        .context("优化器连接已结束，草稿保留。");
        let value = value?;
        if let Some(event) = value.get("event") {
            if let Some(events) = &events {
                events
                    .send(event.clone())
                    .await
                    .context("终端界面已关闭。")?;
            }
            continue;
        }
        if let Some(error) = value["error"].as_str() {
            bail!("{error}");
        }
        return value
            .get("result")
            .cloned()
            .context("优化器没有返回完整结果。");
    }
}
pub async fn live() -> Result<Vec<(Run, Value)>> {
    let dir = config::home().join("runs");
    let mut runs = vec![];
    let files = match std::fs::read_dir(&dir) {
        Ok(files) => files,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(runs),
        Err(e) => return Err(e.into()),
    };
    for file in files {
        let path = file?.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if Uuid::parse_str(id).is_err() {
            continue;
        }
        if let Ok(run) = load(id) {
            if let Ok(Ok(status)) = tokio::time::timeout(
                Duration::from_secs(2),
                request(&run, json!({"action":"status"}), None),
            )
            .await
            {
                runs.push((run, status));
            }
        }
    }
    Ok(runs)
}
pub async fn select(id: Option<&str>) -> Result<Run> {
    if let Some(id) = id {
        return load(id);
    }
    let mut runs = live().await?;
    if runs.len() != 1 {
        bail!("请运行 sessions 查看入口，并使用 --session 指定唯一入口 ID。");
    }
    Ok(runs.remove(0).0)
}
pub fn serve(runtime: Runtime, run: Run, stop: CancellationToken) -> Result<()> {
    let name = pipe(&run.id)?;
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&name)?;
    tokio::spawn(async move {
        loop {
            tokio::select! {_=stop.cancelled()=>break,result=server.connect()=>{if result.is_err(){break;}}}
            let next = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&name)
            {
                Ok(next) => next,
                Err(_) => break,
            };
            let connected = std::mem::replace(&mut server, next);
            let runtime = runtime.clone();
            let token = run.token.clone();
            let shutdown = stop.clone();
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(connected);
                let mut reader = BufReader::new(read);
                let message = match tokio::time::timeout(
                    Duration::from_secs(10),
                    line(&mut reader, 2 * 1024 * 1024),
                )
                .await
                {
                    Ok(Ok(Some(message))) => message,
                    _ => return,
                };
                let supplied = message["token"].as_str().unwrap_or("");
                if !bool::from(supplied.as_bytes().ct_eq(token.as_bytes())) {
                    let _ = write
                        .write_all("{\"error\":\"连接认证失败。\"}\n".as_bytes())
                        .await;
                    return;
                }
                let result: Result<Value>;
                if message["action"] == "review" {
                    let cancel = CancellationToken::new();
                    let (tx, mut events) = mpsc::channel(256);
                    let path = std::path::PathBuf::from(message["filename"].as_str().unwrap_or(""));
                    let review =
                        runtime.open_review(&path, message["direct"] == true, tx, cancel.clone());
                    tokio::pin!(review);
                    let mut byte = [0u8; 1];
                    let mut events_open = true;
                    loop {
                        tokio::select! {
                            _=shutdown.cancelled()=>{cancel.cancel();result=Err(anyhow::anyhow!("入口已关闭。"));break;},
                            _=reader.read(&mut byte)=>{cancel.cancel();let _=review.await;return;},
                            event=events.recv(),if events_open=>{if let Some(event)=event{let bytes=format!("{}\n",json!({"event":event}));if write.write_all(bytes.as_bytes()).await.is_err(){cancel.cancel();let _=review.await;return;}}else{events_open=false;}},
                            finished=&mut review=>{result=finished;break;},
                        }
                    }
                } else {
                    result = tokio::select! {_=shutdown.cancelled()=>Err(anyhow::anyhow!("入口已关闭。")),result=dispatch(&runtime,&message)=>result};
                }
                let response = match result {
                    Ok(value) => json!({"result":value}),
                    Err(error) => json!({"error":error.to_string()}),
                };
                let _ = write.write_all(format!("{response}\n").as_bytes()).await;
                let _ = write.shutdown().await;
            });
        }
    });
    Ok(())
}
async fn dispatch(runtime: &Runtime, message: &Value) -> Result<Value> {
    match message["action"].as_str().unwrap_or("") {
        "status" => Ok(runtime.status()),
        "review-action" => runtime.action(message.clone()),
        "review-models" => runtime.model_options(message).await,
        "cancel" => Ok(runtime.cancel()),
        action @ ("undo" | "continue" | "settings") => {
            runtime.queue(action, message["instructions"].as_str().unwrap_or(""))
        }
        _ => bail!("不支持的操作。"),
    }
}
pub fn save_run(run: &Run) -> Result<()> {
    config::write_json(
        &config::home().join("runs").join(format!("{}.json", run.id)),
        run,
    )
}
pub fn remove_run(run: &Run) {
    let _ = std::fs::remove_file(config::home().join("runs").join(format!("{}.json", run.id)));
}
