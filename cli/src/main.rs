#[cfg(not(windows))]
compile_error!("当前 CLI 接入仅适配 Windows；请使用 Windows Rust 工具链。");

mod bridge;
mod config;
mod credentials;
mod ipc;
mod optimizer;
mod pool;
mod process;
mod runtime;
mod ui;

use anyhow::{bail, Context, Result};
use clap::Parser;
use config::Config;
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::{path::PathBuf, process::Stdio};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Parser)]
#[command(
    version,
    about = "Codex 原生终端提示词优化器",
    after_help = "命令：start、launch、models、templates、config、sessions、settings、continue、undo、cancel、last-error、quota\nCodex 原生参数放在 -- 后。例如：prompt-optimizer launch -- resume\nCtrl+G 优化并回填；空草稿进入设置；不会自动发送。"
)]
struct Args {
    #[arg(default_value = "start")]
    command: String,
    #[arg(hide = true)]
    filename: Option<PathBuf>,
    #[arg(long)]
    codex: Option<String>,
    #[arg(long)]
    cwd: Option<PathBuf>,
    #[arg(long)]
    model: Option<String>,
    #[arg(long)]
    effort: Option<String>,
    #[arg(long,value_parser=["on","off"])]
    context: Option<String>,
    #[arg(long)]
    timeout: Option<u64>,
    #[arg(long)]
    template: Option<String>,
    #[arg(long,value_parser=["direct","preview"])]
    mode: Option<String>,
    #[arg(long)]
    session: Option<String>,
    #[arg(long)]
    instructions: Option<String>,
    #[arg(long)]
    json: bool,
    #[arg(last = true)]
    native: Vec<String>,
}
#[tokio::main]
async fn main() {
    if let Err(error) = run(Args::parse()).await {
        if let Some(exit) = error.downcast_ref::<NativeExit>() {
            std::process::exit(exit.0);
        }
        eprintln!("{}", config::clean(&error.to_string()));
        std::process::exit(1);
    }
}
#[derive(Debug)]
struct NativeExit(i32);
impl std::fmt::Display for NativeExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Codex 已退出（{}）。", self.0)
    }
}
impl std::error::Error for NativeExit {}
async fn run(args: Args) -> Result<()> {
    if args.command == "store" {
        return storage_command();
    }
    if args.command == "editor" {
        return ui::editor(args.filename.context("缺少 Codex 草稿文件。")?).await;
    }
    if args.filename.is_some() {
        bail!("Codex 原生参数请放在 -- 后。");
    }
    if args.command == "quota" {
        open_billing()?;
        println!("已请求打开官方 API 账单页：\n{}", config::BILLING_URL);
        return Ok(());
    }
    if args.command == "launch" {
        return launch(&args).await;
    }
    let mut config = Config::load()?;
    let mut profile = config.selected();
    if let Some(model) = &args.model {
        profile.model = model.clone();
    }
    if let Some(effort) = &args.effort {
        profile.reasoning_effort = effort.clone();
    }
    config.set_selected(profile);
    if let Some(context) = &args.context {
        config.context_enabled = context == "on";
    }
    if let Some(timeout) = args.timeout {
        config.timeout_seconds = timeout;
    }
    if let Some(template) = &args.template {
        config.template = template.clone();
    }
    if let Some(mode) = &args.mode {
        config.auto_apply = mode == "direct";
    }
    config.validate()?;
    if args.command == "start" {
        return start(&args, &args.native, config, false).await;
    }
    if !args.native.is_empty() {
        bail!("只有 start、launch 支持 -- 后的原生参数。");
    }
    match args.command.as_str() {
        "config" => {
            if args.model.is_some()
                || args.effort.is_some()
                || args.context.is_some()
                || args.timeout.is_some()
                || args.template.is_some()
                || args.mode.is_some()
            {
                config.save()?;
                if !args.json {
                    println!("已保存，下次启动生效；当前入口请在设置中修改。");
                }
            }
            if args.json {
                print_json(&config)?;
            } else {
                println!("{}", summary(&config));
            }
        }
        "templates" => {
            let values: Vec<Value> = config::templates()
                .into_iter()
                .map(|mut t| {
                    t.as_object_mut().unwrap().remove("systemPrompt");
                    t["active"] = json!(t["id"] == config.template);
                    t
                })
                .collect();
            if args.json {
                print_json(&values)?;
            } else {
                for t in values {
                    println!(
                        "{} {}（{}）\n  {}",
                        if t["active"] == true { "●" } else { "○" },
                        t["name"].as_str().unwrap_or(""),
                        t["id"].as_str().unwrap_or(""),
                        t["description"].as_str().unwrap_or("")
                    );
                }
            }
        }
        "models" => {
            let mut engine = optimizer::Engine::new(config::executable(args.codex.as_deref())?);
            let catalog = engine.catalog(&config.selected()).await?;
            if args.json {
                print_json(&catalog)?;
            } else {
                println!("{}", catalog["account"].as_str().unwrap_or(""));
                for m in catalog["models"].as_array().unwrap() {
                    let efforts = m["supportedReasoningEfforts"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v["reasoningEffort"].as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    println!("{}\t{efforts}", m["model"].as_str().unwrap_or(""));
                }
            }
        }
        "sessions" => {
            let runs = ipc::live().await?;
            if args.json {
                print_json(&runs.iter().map(|(_, s)| s).collect::<Vec<_>>())?;
            } else if runs.is_empty() {
                println!("没有正在运行的优化入口。");
            } else {
                for (_, status) in runs {
                    println!(
                        "{}",
                        config::clean(&format!(
                            "入口：{}\n目录：{}\n状态：{}\n模型：{}\n模板：{}\n",
                            status["id"].as_str().unwrap_or(""),
                            status["cwd"].as_str().unwrap_or("等待建立对话"),
                            if status["busy"] == true {
                                "正在处理"
                            } else if status["reviewing"] == true {
                                "面板已打开"
                            } else {
                                "等待 Ctrl+G"
                            },
                            status["model"].as_str().unwrap_or(""),
                            config::template_name(status["template"].as_str().unwrap_or(""))
                        ))
                    );
                }
            }
        }
        "last-error" => {
            let id = if let Some(id) = args.session {
                id
            } else {
                ipc::select(None).await?.id
            };
            ipc::pipe(&id)?;
            let error =
                config::read_json(&config::home().join("errors").join(format!("{id}.json")))?
                    .unwrap_or_else(|| json!({"message":"没有记录到错误。"}));
            if args.json {
                print_json(&error)?;
            } else {
                println!(
                    "{}",
                    config::clean(error["message"].as_str().unwrap_or("没有记录到错误。"))
                );
            }
        }
        action @ ("settings" | "continue" | "undo" | "cancel") => {
            let run = ipc::select(args.session.as_deref()).await?;
            let result = ipc::request(
                &run,
                json!({"action":action,"instructions":args.instructions.unwrap_or_default()}),
                None,
            )
            .await?;
            println!(
                "{}",
                config::clean(result["message"].as_str().unwrap_or(""))
            );
        }
        _ => bail!("不支持的命令，请运行 --help 查看。"),
    }
    Ok(())
}
fn storage_command() -> Result<()> {
    use std::io::{IsTerminal, Read};
    if std::io::stdin().is_terminal() || std::io::stdout().is_terminal() {
        bail!("共享连接服务仅供本机客户端通过管道调用。");
    }
    let result = (|| -> Result<Value> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 1024 * 1024 {
            bail!("共享连接请求过大。");
        }
        let request = serde_json::from_slice(&bytes).context("共享连接请求格式不正确。");
        pool::dispatch(request?)
    })();
    match result {
        Ok(value) => println!("{}", json!({"result":value})),
        Err(error) => println!("{}", json!({"error":config::clean(&error.to_string())})),
    };
    Ok(())
}
fn summary(config: &Config) -> String {
    let p = config.selected();
    config::clean(&format!(
        "供应商：{}\n模型：{}\n思考程度：{}\n模板：{}\n参考聊天：{}\n应用方式：{}\n超时：{} 秒",
        p.name,
        if p.model.is_empty() {
            "跟随客户端模型"
        } else {
            &p.model
        },
        config::effort_name(&p.reasoning_effort),
        config::template_name(&config.template),
        if config.context_enabled {
            "开启"
        } else {
            "关闭"
        },
        if config.auto_apply {
            "直接回填"
        } else {
            "先预览"
        },
        config.timeout_seconds
    ))
}
fn print_json(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
pub fn open_billing() -> Result<()> {
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", config::BILLING_URL])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .context("无法打开浏览器，请访问 OpenAI 官方 API 账单页。")?;
    Ok(())
}
fn unsupported(arg: &str) -> bool {
    [
        "--remote",
        "--remote-auth-token-env",
        "--no-daemon",
        "--worktree",
        "--profile",
    ]
    .iter()
    .any(|name| arg == *name || arg.starts_with(&format!("{name}=")))
        || arg == "-p"
        || arg.starts_with("-p") && !arg.starts_with("--")
}
fn interactive(args: &[String]) -> bool {
    let commands = [
        "agents",
        "exec",
        "e",
        "review",
        "login",
        "logout",
        "mcp",
        "plugin",
        "app-server",
        "remote-control",
        "app",
        "completion",
        "update",
        "doctor",
        "sandbox",
        "debug",
        "apply",
        "a",
        "queue",
        "archive",
        "delete",
        "migrate-rollouts",
        "migrate-nfs-db",
        "unarchive",
        "cloud",
        "exec-server",
        "features",
        "help",
    ];
    let values = [
        "-c",
        "--config",
        "--enable",
        "--disable",
        "--remote",
        "--remote-auth-token-env",
        "-i",
        "--image",
        "-m",
        "--model",
        "--local-provider",
        "-p",
        "--profile",
        "-s",
        "--sandbox",
        "-C",
        "--cd",
        "--add-dir",
        "-a",
        "--ask-for-approval",
    ];
    let mut index = 0;
    while index < args.len() {
        let a = &args[index];
        if a == "--" {
            return true;
        }
        if values.contains(&a.as_str()) {
            index += 2;
            continue;
        }
        if !a.starts_with('-') {
            return !commands.contains(&a.as_str());
        }
        index += 1;
    }
    true
}
async fn launch(args: &Args) -> Result<()> {
    let executable = config::executable(args.codex.as_deref())?;
    let mut native = args.native.clone();
    if native.first().is_some_and(|a| a == "--optimizer-off") {
        native.remove(0);
        return forward(&executable, &native).await;
    }
    let preview = native.first().is_some_and(|a| a == "--optimizer-preview");
    if preview {
        native.remove(0);
    }
    if native
        .iter()
        .any(|a| ["--help", "-h", "--version", "-V"].contains(&a.as_str()))
        || !interactive(&native)
    {
        return forward(&executable, &native).await;
    }
    if native.iter().any(|a| unsupported(a)) {
        eprintln!("本次参数暂未适配优化入口，转交官方 Codex；本次不接入优化快捷键。");
        return forward(&executable, &native).await;
    }
    let mut config = Config::load()?;
    if preview {
        config.auto_apply = false;
    }
    start(args, &native, config, true).await
}
async fn forward(executable: &std::path::Path, args: &[String]) -> Result<()> {
    let child = Command::new(executable)
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("无法启动官方 Codex。");
    let mut child = child?;
    loop {
        tokio::select! {status=child.wait()=>{let status=status?;if !status.success(){return Err(NativeExit(status.code().unwrap_or(1)).into());}return Ok(());},_=tokio::signal::ctrl_c()=>{}}
    }
}
struct Lease {
    run: ipc::Run,
    runtime: runtime::Runtime,
    bridge: bridge::Bridge,
    stop: CancellationToken,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.runtime.dispose();
        self.bridge.process.close();
        self.stop.cancel();
        ipc::remove_run(&self.run);
    }
}
async fn start(args: &Args, native: &[String], config: Config, quiet: bool) -> Result<()> {
    if std::env::var_os("CPO_RUN_ID").is_some() {
        bail!("已在增强入口环境中，不能嵌套启动。");
    }
    let executable = config::executable(args.codex.as_deref())?;
    let initial = args.cwd.clone().unwrap_or(std::env::current_dir()?);
    let initial = std::fs::canonicalize(initial).context("工作目录不可访问。");
    let initial = initial?;
    let mut cwd = initial.clone();
    let mut options = vec![];
    let mut index = 0;
    while index < native.len() {
        let a = &native[index];
        if unsupported(a) {
            bail!("增强入口暂不支持 remote、no-daemon、worktree、profile。");
        }
        if ["-c", "--config", "--enable", "--disable"].contains(&a.as_str()) {
            let value = native.get(index + 1).context("Codex 配置参数缺少值。");
            options.extend([a.clone(), value?.clone()]);
            index += 1;
        } else if ["--config=", "--enable=", "--disable="]
            .iter()
            .any(|prefix| a.starts_with(prefix))
        {
            options.push(a.clone());
        } else if a.starts_with("-c") && !a.starts_with("--") && a.len() > 2 {
            options.extend(["-c".into(), a[2..].into()]);
        } else if ["-C", "--cd"].contains(&a.as_str()) {
            cwd = initial.join(native.get(index + 1).context("--cd 缺少目录。")?);
            index += 1;
        } else if let Some(value) = a.strip_prefix("--cd=") {
            cwd = initial.join(value);
        } else if a.starts_with("-C") && a.len() > 2 {
            cwd = initial.join(&a[2..]);
        }
        index += 1;
    }
    let run = ipc::Run {
        id: Uuid::new_v4().to_string(),
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        pid: std::process::id(),
        cwd: cwd.to_string_lossy().into(),
        started_at: json!(config::timestamp()),
        runtime_version: env!("CARGO_PKG_VERSION").into(),
        runtime_path: std::env::current_exe()?.to_string_lossy().into(),
    };
    let (bridge, endpoint) =
        bridge::Bridge::start(&executable, &cwd, &options, run.token.clone()).await?;
    let runtime = runtime::Runtime::new(
        bridge.clone(),
        executable.clone(),
        config.clone(),
        run.id.clone(),
    );
    let stop = CancellationToken::new();
    let lease = Lease {
        run,
        runtime,
        bridge,
        stop,
    };
    ipc::serve(lease.runtime.clone(), lease.run.clone(), lease.stop.clone())?;
    ipc::save_run(&lease.run)?;
    let editor = format!("\"{}\" editor", std::env::current_exe()?.display());
    if !quiet {
        println!(
            "提示词优化入口：{}\nCtrl+G 优化并回填；空输入框进入设置。结果不会自动发送。",
            lease.run.id
        );
    }
    let child = Command::new(&executable)
        .args([
            "--remote",
            &endpoint,
            "--remote-auth-token-env",
            "CPO_TUI_TOKEN",
        ])
        .args(native)
        .current_dir(&initial)
        .env("CPO_HOME", config::home())
        .env("CPO_SHARED_HOME", pool::home())
        .env("CPO_RUN_ID", &lease.run.id)
        .env("CPO_TUI_TOKEN", &lease.run.token)
        .env("VISUAL", &editor)
        .env("EDITOR", &editor)
        .env_remove("CODEX_THREAD_ID")
        .env_remove("CODEX_SESSION_ID")
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("无法启动官方 Codex。");
    let mut child = child?;
    loop {
        tokio::select! {status=child.wait()=>{let status=status?;if !status.success(){return Err(NativeExit(status.code().unwrap_or(1)).into());}return Ok(());},_=tokio::signal::ctrl_c()=>{},_=lease.bridge.process.stopped().cancelled_owned()=>{let _=child.kill().await;bail!("Codex 主服务已中断，请通过 resume 重启入口。");}}
    }
}
