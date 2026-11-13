use crate::{
    config::{self, Config, Connection},
    ipc::{self, Run},
};
use anyhow::{bail, Context, Result};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEventKind,
    },
    execute,
    terminal::{self, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::StreamExt;
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, IsTerminal},
    path::PathBuf,
    time::Duration,
};
use tokio::sync::mpsc;
use tui_textarea::TextArea;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
use uuid::Uuid;
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetStdHandle, SetConsoleMode, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};

const ACCENT: Color = Color::Cyan;
#[derive(Clone, Copy, PartialEq)]
enum Screen {
    Preview,
    Settings,
    Picker,
    Form,
    Input,
    Error,
}
#[derive(Clone, Copy, PartialEq)]
enum Pick {
    Connection,
    Manage,
    Model,
    FormModel,
    Effort,
    Template,
    Provider,
    FormEffort,
    Token,
}
struct Item {
    id: String,
    name: String,
    description: String,
}
struct Picker {
    kind: Pick,
    title: String,
    items: Vec<Item>,
    selected: usize,
    current: String,
    query: String,
    visible: Vec<usize>,
}
impl Picker {
    fn is_model(&self) -> bool {
        matches!(self.kind, Pick::Model | Pick::FormModel)
    }
    fn filter(&mut self) {
        let current = self.visible.get(self.selected).copied();
        let query = self.query.to_lowercase();
        let words = query.split_whitespace().collect::<Vec<_>>();
        self.visible = self
            .items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| {
                let text = format!("{} {}", item.id, item.name).to_lowercase();
                words
                    .iter()
                    .all(|word| text.contains(word))
                    .then_some(index)
            })
            .collect();
        self.selected = current
            .and_then(|index| {
                self.visible
                    .iter()
                    .position(|candidate| *candidate == index)
            })
            .unwrap_or(0);
    }
    fn selected_item(&self) -> Option<&Item> {
        self.visible
            .get(self.selected)
            .and_then(|index| self.items.get(*index))
    }
}
#[derive(Clone, Copy)]
enum Edit {
    Instructions,
    Field(usize),
    ApiKey,
}
struct Input {
    kind: Edit,
    area: TextArea<'static>,
    title: String,
}
struct Ui {
    run: Run,
    tx: mpsc::Sender<Value>,
    screen: Screen,
    shown: bool,
    busy: bool,
    direct: bool,
    review: String,
    revision: u64,
    original: String,
    candidate: String,
    stream: String,
    notice: String,
    progress: String,
    config: Config,
    saved: Config,
    setting: usize,
    picker: Option<Picker>,
    form: Option<Connection>,
    form_key: Option<String>,
    api_keys: HashMap<String, String>,
    form_row: usize,
    input: Option<Input>,
    original_tab: bool,
    original_scroll: usize,
    result_scroll: usize,
    follow: bool,
    page: usize,
    original_max: usize,
    result_max: usize,
    catalog_request: u64,
    catalog_cache: Option<(String, Value)>,
    cycle: Option<isize>,
    loading: bool,
    tick: usize,
    fatal: Option<String>,
    empty: bool,
}
struct Console {
    input_mode: Option<u32>,
    output_mode: Option<u32>,
    terminal: Option<Terminal<CrosstermBackend<io::Stdout>>>,
    raw: bool,
    screen: bool,
}
impl Console {
    fn new() -> Result<Self> {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("优化器需要交互式终端，请在 Codex 中按 Ctrl+G。");
        }
        let read_mode = |kind| {
            let mut value = 0;
            unsafe {
                if GetConsoleMode(GetStdHandle(kind), &mut value) != 0 {
                    Some(value)
                } else {
                    None
                }
            }
        };
        let mut console = Self {
            input_mode: read_mode(STD_INPUT_HANDLE),
            output_mode: read_mode(STD_OUTPUT_HANDLE),
            terminal: None,
            raw: false,
            screen: false,
        };
        terminal::enable_raw_mode()?;
        console.raw = true;
        execute!(io::stdout(), EnableBracketedPaste)?;
        Ok(console)
    }
    fn open(&mut self) -> Result<()> {
        if self.terminal.is_none() {
            self.screen = true;
            execute!(io::stdout(), EnterAlternateScreen, EnableMouseCapture, Hide)?;
            self.terminal = Some(Terminal::new(CrosstermBackend::new(io::stdout()))?);
        }
        Ok(())
    }
}
impl Drop for Console {
    fn drop(&mut self) {
        if self.screen {
            let _ = execute!(
                io::stdout(),
                DisableMouseCapture,
                Show,
                LeaveAlternateScreen
            );
        }
        let _ = execute!(io::stdout(), DisableBracketedPaste);
        if self.raw {
            let _ = terminal::disable_raw_mode();
        }
        // 精确还原进入编辑器前的控制台模式，避免把父 Codex 的 raw 模式改成行输入。
        unsafe {
            if let Some(mode) = self.input_mode {
                SetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), mode);
            }
            if let Some(mode) = self.output_mode {
                SetConsoleMode(GetStdHandle(STD_OUTPUT_HANDLE), mode);
            }
        }
    }
}
pub async fn editor(filename: PathBuf) -> Result<()> {
    let id = std::env::var("CPO_RUN_ID").context("缺少优化入口，请从 Rust launch 启动 Codex。");
    let id = id?;
    let run = ipc::load(&id)?;
    let mut console = Console::new()?;
    let mut keys = EventStream::new();
    let (tx, mut events) = mpsc::channel(256);
    let worker_run = run.clone();
    let worker_tx = tx.clone();
    let worker = tokio::spawn(async move {
        let result = async {
            let status = tokio::time::timeout(
                Duration::from_secs(10),
                ipc::request(&worker_run, json!({"action":"status"}), None),
            )
            .await
            .context("读取入口状态超时。")??;
            if status["editorProtocol"] != 8 {
                bail!("此窗口仍在使用旧运行版本，请保存草稿后重新打开 Codex。");
            }
            ipc::request(
                &worker_run,
                json!({"action":"review","filename":filename,"direct":status["autoApply"]==true}),
                Some(worker_tx.clone()),
            )
            .await
        }
        .await;
        let event = match result {
            Ok(value) => json!({"type":"finished","result":value}),
            Err(error) => json!({"type":"fatal","message":error.to_string()}),
        };
        let _ = worker_tx.send(event).await;
    });
    let mut ui = Ui {
        run,
        tx,
        screen: Screen::Preview,
        shown: false,
        busy: true,
        direct: true,
        review: String::new(),
        revision: 0,
        original: String::new(),
        candidate: String::new(),
        stream: String::new(),
        notice: String::new(),
        progress: "正在连接…".into(),
        config: Config::default(),
        saved: Config::default(),
        setting: 0,
        picker: None,
        form: None,
        form_key: None,
        api_keys: HashMap::new(),
        form_row: 0,
        input: None,
        original_tab: false,
        original_scroll: 0,
        result_scroll: 0,
        follow: true,
        page: 1,
        original_max: 0,
        result_max: 0,
        catalog_request: 0,
        catalog_cache: None,
        cycle: None,
        loading: false,
        tick: 0,
        fatal: None,
        empty: false,
    };
    let mut dirty = true;
    let mut interval = tokio::time::interval(Duration::from_millis(40));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = loop {
        tokio::select! {
            event=events.recv()=>{let Some(event)=event else{break Err(anyhow::anyhow!("优化器事件通道已关闭。"))};match ui.receive(event){Ok(true)=>break Ok(()),Ok(false)=>dirty=true,Err(e)=>{ui.fatal=Some(e.to_string());ui.screen=Screen::Error;ui.shown=true;ui.busy=false;dirty=true;}}},
            key=keys.next()=>{match key{Some(Ok(event))=>{match ui.event(event){Ok(true)=>{break if let Some(error)=ui.fatal.take(){Err(anyhow::anyhow!(error))}else{Ok(())};},Ok(false)=>dirty=true,Err(error)=>{ui.notice=error.to_string();dirty=true;}}},Some(Err(error))=>break Err(error.into()),None=>break Err(anyhow::anyhow!("终端输入已结束。"))}},
            _=interval.tick()=>{ui.tick=ui.tick.wrapping_add(1);if ui.shown&&(dirty||(ui.busy||ui.loading)&&ui.tick%5==0){console.open()?;if let Some(terminal)=&mut console.terminal{terminal.draw(|frame|ui.draw(frame))?;}dirty=false;}},
        }
    };
    worker.abort();
    drop(keys);
    drop(console);
    if let Err(error) = &result {
        config::error_record(&id, &error.to_string());
    }
    result
}
impl Ui {
    fn send(&mut self, choice: &str, extra: Value) {
        self.busy = true;
        self.notice.clear();
        let run = self.run.clone();
        let tx = self.tx.clone();
        let mut message = json!({"action":"review-action","reviewId":self.review,"revision":self.revision,"choice":choice});
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                message[key] = value.clone();
            }
        }
        tokio::spawn(async move {
            if let Err(error) = ipc::request(&run, message, None).await {
                let _ = tx
                    .send(json!({"type":"command-error","message":error.to_string()}))
                    .await;
            }
        });
    }
    fn cancel(&self) {
        let run = self.run.clone();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            if let Err(error) = ipc::request(&run, json!({"action":"cancel"}), None).await {
                let _ = tx
                    .send(json!({"type":"command-error","message":error.to_string()}))
                    .await;
            }
        });
    }
    fn receive(&mut self, event: Value) -> Result<bool> {
        match event["type"].as_str().unwrap_or("") {
            "opened" => {
                self.review = event["reviewId"].as_str().unwrap_or("").into();
                self.revision = event["revision"].as_u64().unwrap_or(0);
                self.original = event["original"].as_str().unwrap_or("").into();
                self.direct = event["direct"] == true;
                self.empty = event["empty"] == true;
                self.config = serde_json::from_value(event["config"].clone())?;
                self.saved = self.config.clone();
                self.shown = !self.direct;
            }
            "progress" => {
                self.busy = true;
                self.progress = event["message"].as_str().unwrap_or("").into();
                self.stream.clear();
                self.screen = Screen::Preview;
                self.follow = true;
            }
            "text" => {
                if !self.direct {
                    if event["reset"] == true {
                        self.stream.clear();
                    }
                    if let Some(text) = event["text"].as_str() {
                        if self.stream.len() + text.len() <= 400000 {
                            self.stream.push_str(text);
                        }
                    }
                }
            }
            "ready" => {
                if event["configurationSaved"] == true {
                    self.api_keys.clear();
                }
                self.shown = true;
                self.direct = false;
                self.busy = false;
                self.loading = false;
                self.revision = event["revision"].as_u64().unwrap_or(self.revision);
                self.candidate = event["candidate"].as_str().unwrap_or("").into();
                self.stream.clear();
                self.notice = event["error"]
                    .as_str()
                    .or(event["message"].as_str())
                    .unwrap_or("")
                    .into();
                self.saved = serde_json::from_value(event["config"].clone())?;
                self.config = self.saved.clone();
                self.input = None;
                if event["options"].is_object() {
                    if event["options"]["draftConfig"].is_object() {
                        self.config =
                            serde_json::from_value(event["options"]["draftConfig"].clone())?;
                    }
                    self.screen = Screen::Settings;
                } else if self.empty {
                    self.send("discard", json!({}));
                } else {
                    self.screen = Screen::Preview;
                }
            }
            "catalog" => {
                if event["request"].as_u64() != Some(self.catalog_request) {
                    return Ok(false);
                }
                self.loading = false;
                if let Some(error) = event["error"].as_str() {
                    self.cycle = None;
                    self.notice = error.into();
                    return Ok(false);
                }
                let kind = match event["purpose"].as_str() {
                    Some("model") => Pick::Model,
                    Some("form") => Pick::FormEffort,
                    Some("form-model") => Pick::FormModel,
                    _ => Pick::Effort,
                };
                self.catalog_cache = Some((
                    event["cacheKey"].as_str().unwrap_or("").into(),
                    event["catalog"].clone(),
                ));
                self.catalog_picker(kind, &event["catalog"])?;
                self.finish_cycle()?;
            }
            "command-error" => {
                self.busy = false;
                self.notice = event["message"].as_str().unwrap_or("操作失败。").into();
            }
            "finished" => return Ok(true),
            "fatal" => {
                self.fatal = Some(event["message"].as_str().unwrap_or("优化未完成。").into());
                self.shown = true;
                self.busy = false;
                self.screen = Screen::Error;
            }
            _ => {}
        }
        Ok(false)
    }
    fn event(&mut self, event: Event) -> Result<bool> {
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => self.key(key),
            Event::Paste(text) if self.screen == Screen::Picker => {
                if let Some(picker) = self.picker.as_mut().filter(|picker| picker.is_model()) {
                    let remaining = 200usize.saturating_sub(picker.query.chars().count());
                    picker.query.extend(
                        config::clean(&text)
                            .replace(['\r', '\n', '\t'], " ")
                            .chars()
                            .take(remaining),
                    );
                    picker.filter();
                }
                Ok(false)
            }
            Event::Paste(text) if self.screen == Screen::Input => {
                if let Some(input) = &mut self.input {
                    let secret = matches!(input.kind, Edit::ApiKey);
                    let text = if secret {
                        text.trim().to_owned()
                    } else if matches!(input.kind, Edit::Instructions) {
                        config::clean(&text)
                    } else {
                        config::clean(&text).replace(['\r', '\n', '\t'], " ")
                    };
                    if secret && text.chars().any(char::is_control) {
                        bail!("API Key 不能包含换行或控制字符。");
                    }
                    let fits = if secret {
                        input.area.lines().join("\n").len() + text.len() <= 2560
                    } else {
                        input.area.lines().join("\n").chars().count() + text.chars().count() <= 4000
                    };
                    if fits {
                        input.area.insert_str(text);
                    } else {
                        self.notice = if secret {
                            "API Key 最多 2560 字节。"
                        } else {
                            "输入最多 4000 字。"
                        }
                        .into();
                    }
                }
                Ok(false)
            }
            Event::Mouse(mouse) if self.screen == Screen::Preview => {
                match mouse.kind {
                    MouseEventKind::ScrollUp => self.scroll(-3),
                    MouseEventKind::ScrollDown => self.scroll(3),
                    _ => {}
                }
                Ok(false)
            }
            _ => Ok(false),
        }
    }
    fn key(&mut self, key: KeyEvent) -> Result<bool> {
        let escape = key.code == KeyCode::Esc
            || key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c');
        if self.screen == Screen::Error {
            return Ok(escape || key.code == KeyCode::Enter);
        }
        if self.review.is_empty() {
            return Ok(escape);
        }
        if self.loading {
            if escape {
                self.cycle = None;
                self.catalog_request += 1;
                self.loading = false;
                self.cancel();
            } else if let Some(cycle) = &mut self.cycle {
                match key.code {
                    KeyCode::Left => *cycle = cycle.saturating_sub(1),
                    KeyCode::Right => *cycle = cycle.saturating_add(1),
                    _ => {}
                }
            }
            return Ok(false);
        }
        if self.busy {
            if escape {
                self.cancel();
            } else if key.code == KeyCode::Char('s') {
                self.send("settings", json!({}));
            } else if self.shown {
                self.scroll_key(key);
            }
            return Ok(false);
        }
        if self.screen == Screen::Input {
            return self.input_key(key, escape);
        }
        if escape {
            match self.screen {
                Screen::Settings => {
                    self.api_keys.clear();
                    self.form_key = None;
                    self.send(if self.empty { "discard" } else { "back" }, json!({}))
                }
                Screen::Picker => {
                    let kind = self.picker.as_ref().map(|p| p.kind);
                    self.screen = if matches!(
                        kind,
                        Some(Pick::Provider | Pick::FormModel | Pick::FormEffort | Pick::Token)
                    ) {
                        Screen::Form
                    } else {
                        Screen::Settings
                    };
                }
                Screen::Form => {
                    self.form = None;
                    self.form_key = None;
                    self.screen = Screen::Settings;
                }
                _ => self.send("discard", json!({})),
            }
            return Ok(false);
        }
        match self.screen {
            Screen::Preview => {
                if self.scroll_key(key) {
                    return Ok(false);
                }
                match key.code {
                    KeyCode::Tab => self.original_tab = !self.original_tab,
                    KeyCode::Char('a') if !self.candidate.is_empty() => {
                        self.send("apply", json!({}))
                    }
                    KeyCode::Char('r') if !self.candidate.is_empty() => {
                        self.edit(Edit::Instructions, "修改要求", "")
                    }
                    KeyCode::Char('o') => self.send("optimize", json!({})),
                    KeyCode::Char('u') => self.send("restore", json!({})),
                    KeyCode::Char('s') => self.send("settings", json!({})),
                    KeyCode::Char('v') => self.original_tab = true,
                    KeyCode::Char('p') => self.original_tab = false,
                    _ => {}
                }
            }
            Screen::Settings => match key.code {
                KeyCode::Up => self.setting = self.setting.saturating_sub(1),
                KeyCode::Down => self.setting = (self.setting + 1).min(8),
                KeyCode::Enter => self.setting_enter()?,
                KeyCode::Left => self.shift_value(-1, false)?,
                KeyCode::Right => self.shift_value(1, false)?,
                KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => self.save(),
                _ => {}
            },
            Screen::Picker => {
                if let Some(p) = &mut self.picker {
                    if p.is_model() {
                        let mut changed = true;
                        match key.code {
                            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                                p.query.clear()
                            }
                            KeyCode::Char(c)
                                if !key
                                    .modifiers
                                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                                    && !c.is_control() =>
                            {
                                if p.query.chars().count() < 200 {
                                    p.query.push(c);
                                }
                            }
                            KeyCode::Backspace => {
                                if let Some((index, _)) = p.query.grapheme_indices(true).next_back()
                                {
                                    p.query.truncate(index);
                                }
                            }
                            _ => changed = false,
                        }
                        if changed {
                            p.filter();
                            return Ok(false);
                        }
                    }
                    match key.code {
                        KeyCode::Up => p.selected = p.selected.saturating_sub(1),
                        KeyCode::Down => {
                            p.selected = (p.selected + 1).min(p.visible.len().saturating_sub(1))
                        }
                        KeyCode::Home => p.selected = 0,
                        KeyCode::End => p.selected = p.visible.len().saturating_sub(1),
                        KeyCode::PageUp => p.selected = p.selected.saturating_sub(self.page),
                        KeyCode::PageDown => {
                            p.selected =
                                (p.selected + self.page).min(p.visible.len().saturating_sub(1))
                        }
                        _ => {}
                    }
                }
                if key.code == KeyCode::Enter {
                    self.pick()?;
                }
            }
            Screen::Form => {
                let len = self.form_rows().len();
                match key.code {
                    KeyCode::Up => self.form_row = self.form_row.saturating_sub(1),
                    KeyCode::Down => self.form_row = (self.form_row + 1).min(len.saturating_sub(1)),
                    KeyCode::Enter => self.form_enter()?,
                    KeyCode::Left => self.shift_value(-1, true)?,
                    KeyCode::Right => self.shift_value(1, true)?,
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(false)
    }
    fn scroll_key(&mut self, key: KeyEvent) -> bool {
        let step = match key.code {
            KeyCode::Up => -1,
            KeyCode::Down => 1,
            KeyCode::PageUp => -(self.page as isize),
            KeyCode::PageDown => self.page as isize,
            KeyCode::Home => isize::MIN,
            KeyCode::End => isize::MAX,
            _ => return false,
        };
        self.scroll(step);
        true
    }
    fn scroll(&mut self, step: isize) {
        let (offset, max) = if self.original_tab {
            (&mut self.original_scroll, self.original_max)
        } else {
            (&mut self.result_scroll, self.result_max)
        };
        *offset = offset.saturating_add_signed(step).min(max);
        if !self.original_tab {
            self.follow = step == isize::MAX;
        }
    }
    fn edit(&mut self, kind: Edit, title: &str, value: &str) {
        let mut area = TextArea::from(value.split('\n').map(str::to_owned).collect::<Vec<_>>());
        area.set_cursor_line_style(Style::default());
        area.set_cursor_style(Style::default().add_modifier(Modifier::REVERSED));
        if matches!(kind, Edit::ApiKey) {
            area.set_mask_char('•');
        }
        area.set_block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(ACCENT))
                .title(title.to_owned()),
        );
        self.input = Some(Input {
            kind,
            area,
            title: title.into(),
        });
        self.screen = Screen::Input;
        self.notice.clear();
    }
    fn input_key(&mut self, key: KeyEvent, escape: bool) -> Result<bool> {
        if escape {
            let kind = self.input.take().unwrap().kind;
            self.screen = if matches!(kind, Edit::Field(_) | Edit::ApiKey) {
                Screen::Form
            } else {
                Screen::Preview
            };
            return Ok(false);
        }
        let instructions = matches!(self.input.as_ref().unwrap().kind, Edit::Instructions);
        let submit = key.code == KeyCode::Enter
            && (!instructions || key.modifiers.contains(KeyModifiers::CONTROL))
            || instructions
                && key.code == KeyCode::Char('s')
                && key.modifiers.contains(KeyModifiers::CONTROL);
        if submit {
            if matches!(self.input.as_ref().unwrap().kind, Edit::ApiKey) {
                let value = self.input.as_ref().unwrap().area.lines().join("\n");
                if !value.trim().is_empty() {
                    crate::credentials::validate_key(value.trim())?;
                }
            }
            let input = self.input.take().unwrap();
            let value = input.area.lines().join("\n");
            if value.chars().count() > 4000 {
                bail!("输入最多 4000 字。");
            }
            match input.kind {
                Edit::Instructions => {
                    self.screen = Screen::Preview;
                    self.send("continue", json!({"instructions":value}));
                }
                Edit::Field(field) => {
                    let p = self.form.as_mut().unwrap();
                    match field {
                        0 => p.name = value.trim().into(),
                        4 => {
                            if p.api_base_url != value.trim() {
                                p.clear_model_capabilities();
                                self.form_key = None;
                                self.catalog_cache = None;
                            }
                            p.api_base_url = value.trim().into();
                        }
                        5 => {
                            p.api_key_env = value.trim().into();
                            self.catalog_cache = None;
                        }
                        6 => {
                            if p.executable != value.trim() {
                                p.clear_model_capabilities();
                            }
                            p.executable = value.trim().into();
                            self.catalog_cache = None;
                        }
                        _ => {}
                    }
                    self.screen = Screen::Form;
                }
                Edit::ApiKey => {
                    if !value.trim().is_empty() {
                        self.form_key = Some(value.trim().to_owned());
                        self.catalog_cache = None;
                    }
                    self.screen = Screen::Form;
                }
            }
            return Ok(false);
        }
        let input = self.input.as_mut().unwrap();
        let secret = matches!(input.kind, Edit::ApiKey);
        let before = input.area.lines().to_vec();
        input.area.input(key);
        if (if secret {
            input.area.lines().join("\n").len() > 2560
        } else {
            input.area.lines().join("\n").chars().count() > 4000
        }) || !instructions && input.area.lines().len() > 1
        {
            input.area = TextArea::from(before);
            if secret {
                input.area.set_mask_char('•');
            }
            input.area.set_block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(input.title.clone()),
            );
            self.notice = if secret {
                "API Key 需为单行，最多 2560 字节。"
            } else {
                "输入最多 4000 字。"
            }
            .into();
        }
        Ok(false)
    }
    fn picker(&mut self, kind: Pick, title: &str, items: Vec<Item>, current: String) {
        let selected = items.iter().position(|i| i.id == current).unwrap_or(0);
        self.picker = Some(Picker {
            kind,
            title: title.into(),
            visible: (0..items.len()).collect(),
            items,
            selected,
            current,
            query: String::new(),
        });
        self.screen = Screen::Picker;
    }
    fn connections(&mut self, manage: bool) {
        let mut items = Vec::new();
        items.extend(self.config.connections.iter().map(|p| Item {
            id: p.id.clone(),
            name: p.name.clone(),
            description: format!(
                "{} · {}",
                provider_name(&p.provider),
                if p.model.is_empty() {
                    "客户端默认"
                } else {
                    &p.model
                }
            ),
        }));
        if manage {
            items.push(Item {
                id: "new".into(),
                name: "新增连接".into(),
                description: String::new(),
            });
            if self
                .config
                .connections
                .iter()
                .any(|p| p.id == self.config.connection)
            {
                items.push(Item {
                    id: "edit".into(),
                    name: "编辑当前连接".into(),
                    description: self.config.selected().name,
                });
            }
        }
        self.picker(
            if manage {
                Pick::Manage
            } else {
                Pick::Connection
            },
            "供应商连接",
            items,
            self.config.connection.clone(),
        );
    }
    fn setting_enter(&mut self) -> Result<()> {
        let p = self.config.selected();
        match self.setting {
            0 => self.connections(false),
            1 => self.load_catalog("model")?,
            2 => {
                if p.is_api() {
                    self.efforts(Pick::Effort, &p);
                } else {
                    self.load_catalog("effort")?;
                }
            }
            3 => self.picker(
                Pick::Template,
                "优化模板",
                config::templates()
                    .into_iter()
                    .map(|v| Item {
                        id: v["id"].as_str().unwrap_or("").into(),
                        name: v["name"].as_str().unwrap_or("").into(),
                        description: v["description"].as_str().unwrap_or("").into(),
                    })
                    .collect(),
                self.config.template.clone(),
            ),
            4 => self.config.context_enabled = !self.config.context_enabled,
            5 => self.config.auto_apply = !self.config.auto_apply,
            6 => self.connections(true),
            7 => {
                crate::open_billing()?;
                self.notice = "已请求打开官方 API 账单页。".into();
            }
            8 => self.save(),
            _ => {}
        }
        Ok(())
    }
    fn shift_value(&mut self, direction: isize, form: bool) -> Result<()> {
        if form {
            if !self
                .form_rows()
                .get(self.form_row)
                .is_some_and(|(field, _, _)| matches!(field, 1 | 2 | 3 | 7))
            {
                return Ok(());
            }
        } else {
            match self.setting {
                4 => {
                    self.config.context_enabled = direction > 0;
                    self.notice.clear();
                    return Ok(());
                }
                5 => {
                    self.config.auto_apply = direction > 0;
                    self.notice.clear();
                    return Ok(());
                }
                0..=3 => {}
                _ => return Ok(()),
            }
        }
        self.cycle = Some(direction);
        let result = if form {
            self.form_enter()
        } else {
            self.setting_enter()
        };
        if let Err(error) = result {
            self.cycle = None;
            return Err(error);
        }
        if !self.loading {
            self.finish_cycle()?;
        }
        Ok(())
    }
    fn finish_cycle(&mut self) -> Result<()> {
        let Some(direction) = self.cycle.take() else {
            return Ok(());
        };
        let Some(picker) = self.picker.as_mut() else {
            return Ok(());
        };
        if direction == 0 || picker.visible.is_empty() {
            self.screen = if matches!(
                picker.kind,
                Pick::Provider | Pick::FormModel | Pick::FormEffort | Pick::Token
            ) {
                Screen::Form
            } else {
                Screen::Settings
            };
            self.picker = None;
            return Ok(());
        }
        picker.selected = (picker.selected
            + direction.rem_euclid(picker.visible.len() as isize) as usize)
            % picker.visible.len();
        self.pick()
    }
    fn save(&mut self) {
        if let Err(error) = self.config.validate() {
            self.notice = error.to_string();
            return;
        }
        let config = serde_json::to_value(&self.config).unwrap();
        self.send(
            "configure",
            json!({"config":config,"apiKeys":self.api_keys}),
        );
    }
    fn efforts(&mut self, kind: Pick, profile: &Connection) {
        let mut levels = vec!["auto"];
        levels.extend(config::API_EFFORTS.iter().copied().filter(|e| {
            if profile.provider == "anthropic" {
                *e != "minimal"
            } else if profile.provider == "deepseek" {
                ["none", "low", "high", "max"].contains(e)
            } else {
                true
            }
        }));
        self.picker(
            kind,
            "思考程度",
            levels
                .iter()
                .map(|e| Item {
                    id: (*e).into(),
                    name: config::effort_name(e).into(),
                    description: String::new(),
                })
                .collect(),
            profile.reasoning_effort.clone(),
        );
    }
    fn load_catalog(&mut self, purpose: &str) -> Result<()> {
        let mut config = self.config.clone();
        if purpose.starts_with("form") {
            let profile = self.form.clone().context("没有正在编辑的连接。");
            let profile = profile?;
            config.connections.retain(|p| p.id != profile.id);
            config.connection = profile.id.clone();
            config.model_overrides.remove(&profile.id);
            config.connections.push(profile);
        }
        config.selected().validate_for_catalog()?;
        let profile = config.selected();
        let cache_key = json!([
            profile.id,
            profile.provider,
            profile.api_base_url,
            profile.api_key_env,
            profile.executable,
            profile.extra.get("revision")
        ])
        .to_string();
        if self.cycle.is_some() {
            if let Some((key, catalog)) = &self.catalog_cache {
                if *key == cache_key {
                    let catalog = catalog.clone();
                    return self.catalog_picker(
                        match purpose {
                            "model" => Pick::Model,
                            "form-model" => Pick::FormModel,
                            "form" => Pick::FormEffort,
                            _ => Pick::Effort,
                        },
                        &catalog,
                    );
                }
            }
        }
        if !profile.is_api() {
            let mut query_profile = profile;
            query_profile.model.clear();
            config.set_selected(query_profile);
        }
        let api_key = if purpose.starts_with("form") {
            self.form_key.clone()
        } else {
            self.api_keys.get(&config.connection).cloned()
        };
        self.catalog_cache = None;
        self.loading = true;
        self.notice.clear();
        self.catalog_request += 1;
        let request = self.catalog_request;
        let run = self.run.clone();
        let tx = self.tx.clone();
        let review = self.review.clone();
        let purpose = purpose.to_owned();
        tokio::spawn(async move {
            let result = ipc::request(
                &run,
                json!({"action":"review-models","reviewId":review,"config":config,"apiKey":api_key}),
                None,
            )
            .await;
            let event = match result {
                Ok(catalog) => {
                    json!({"type":"catalog","request":request,"purpose":purpose,"cacheKey":cache_key,"catalog":catalog})
                }
                Err(error) => {
                    json!({"type":"catalog","request":request,"purpose":purpose,"error":error.to_string()})
                }
            };
            let _ = tx.send(event).await;
        });
        Ok(())
    }
    fn catalog_picker(&mut self, kind: Pick, catalog: &Value) -> Result<()> {
        let profile = if matches!(kind, Pick::FormModel | Pick::FormEffort) {
            self.form.as_ref().unwrap().clone()
        } else {
            self.config.selected()
        };
        let models = catalog["models"].as_array().context("模型目录格式不正确。");
        let models = models?;
        if matches!(kind, Pick::Model | Pick::FormModel) {
            if models.is_empty() {
                bail!("当前连接没有返回可选模型。");
            }
            let mut items = vec![];
            if !profile.is_api() {
                items.push(Item {
                    id: String::new(),
                    name: "跟随客户端模型".into(),
                    description: catalog["effectiveModel"].as_str().unwrap_or("").into(),
                });
            }
            items.extend(models.iter().filter_map(|m| {
                m["model"].as_str().map(|id| Item {
                    id: id.into(),
                    name: config::clean(m["displayName"].as_str().unwrap_or(id)),
                    description: if m["displayName"].as_str().is_some_and(|name| name != id) {
                        config::clean(id)
                    } else {
                        String::new()
                    },
                })
            }));
            self.picker(kind, "优化模型", items, profile.model);
        } else {
            let effective = if profile.model.is_empty() {
                catalog["effectiveModel"].as_str().unwrap_or("")
            } else {
                &profile.model
            };
            let mut levels = vec!["auto".to_string()];
            if let Some(model) = models.iter().find(|m| m["model"] == effective) {
                if let Some(efforts) = model["supportedReasoningEfforts"].as_array() {
                    levels.extend(
                        efforts
                            .iter()
                            .filter_map(|e| e["reasoningEffort"].as_str())
                            .filter(|e| *e != "auto")
                            .map(str::to_owned),
                    );
                }
            }
            self.picker(
                kind,
                "思考程度",
                levels
                    .into_iter()
                    .map(|id| Item {
                        name: config::effort_name(&id).into(),
                        id,
                        description: String::new(),
                    })
                    .collect(),
                profile.reasoning_effort,
            );
        }
        Ok(())
    }
    fn pick(&mut self) -> Result<()> {
        let p = self.picker.as_ref().context("没有可选项目。")?;
        let Some(item) = p.selected_item() else {
            return Ok(());
        };
        let id = item.id.clone();
        let kind = p.kind;
        self.picker = None;
        self.screen = Screen::Settings;
        match kind {
            Pick::Connection | Pick::Manage => {
                if id == "new" || id == "edit" {
                    self.form = Some(if id == "edit" {
                        self.config.selected()
                    } else {
                        Connection {
                            id: Uuid::new_v4().to_string(),
                            name: String::new(),
                            ..Connection::default()
                        }
                    });
                    self.form_key = self.api_keys.get(&self.form.as_ref().unwrap().id).cloned();
                    self.form_row = 0;
                    self.screen = Screen::Form;
                } else {
                    self.config.activate(id);
                }
            }
            Pick::Model => {
                let mut p = self.config.selected();
                if p.model != id {
                    p.model = id;
                    p.reasoning_effort = "auto".into();
                    self.config.set_selected(p);
                }
            }
            Pick::Effort => {
                let mut p = self.config.selected();
                p.reasoning_effort = id;
                self.config.set_selected(p);
            }
            Pick::FormModel => {
                let profile = self.form.as_mut().unwrap();
                if profile.model != id {
                    profile.clear_model_capabilities();
                    profile.model = id;
                    profile.reasoning_effort = "auto".into();
                }
                self.screen = Screen::Form;
            }
            Pick::Template => self.config.template = id,
            Pick::Provider => {
                let p = self.form.as_mut().unwrap();
                if p.provider != id {
                    self.catalog_cache = None;
                    self.form_key = None;
                    p.clear_model_capabilities();
                    p.provider = id;
                    p.model.clear();
                    p.reasoning_effort = "auto".into();
                    p.api_base_url = match p.provider.as_str() {
                        "deepseek" => "https://api.deepseek.com",
                        "anthropic" => "https://api.anthropic.com/v1",
                        "openai-compatible" => "https://api.openai.com/v1",
                        _ => "",
                    }
                    .into();
                    p.api_key_env = match p.provider.as_str() {
                        "deepseek" => "DEEPSEEK_API_KEY",
                        "anthropic" => "ANTHROPIC_API_KEY",
                        "openai-compatible" => "OPENAI_API_KEY",
                        _ => "",
                    }
                    .into();
                    p.executable.clear();
                }
                self.screen = Screen::Form;
            }
            Pick::FormEffort => {
                self.form.as_mut().unwrap().reasoning_effort = id;
                self.screen = Screen::Form;
            }
            Pick::Token => {
                self.form.as_mut().unwrap().token_limit_parameter = id;
                self.screen = Screen::Form;
            }
        }
        Ok(())
    }
    fn form_rows(&self) -> Vec<(usize, String, String)> {
        let Some(p) = &self.form else { return vec![] };
        let mut rows = vec![
            (0, "连接名称".into(), p.name.clone()),
            (1, "供应商类型".into(), provider_name(&p.provider).into()),
        ];
        if p.is_api() {
            let stored = self.saved.stored_api_keys.contains(&p.id)
                && self
                    .saved
                    .connections
                    .iter()
                    .any(|saved| saved.id == p.id && crate::pool::same_transport(saved, p));
            rows.extend([
                (4, "API 地址".into(), p.api_base_url.clone()),
                (
                    9,
                    "API Key".into(),
                    if self.form_key.is_some() {
                        "已填写（待保存）"
                    } else if stored {
                        "已保存（留空保留）"
                    } else {
                        "未保存"
                    }
                    .into(),
                ),
                (5, "环境变量（可选）".into(), p.api_key_env.clone()),
            ]);
        }
        if p.provider == "claude" {
            rows.push((6, "Claude Code 路径".into(), p.executable.clone()));
        }
        rows.push((2, "模型".into(), p.model.clone()));
        rows.push((
            3,
            "思考程度".into(),
            config::effort_name(&p.reasoning_effort).into(),
        ));
        if p.provider == "openai-compatible" {
            rows.push((7, "输出长度参数".into(), p.token_limit_parameter.clone()));
        }
        rows.push((8, "完成编辑".into(), String::new()));
        rows
    }
    fn form_enter(&mut self) -> Result<()> {
        let rows = self.form_rows();
        let Some((field, name, value)) = rows.get(self.form_row) else {
            return Ok(());
        };
        let field = *field;
        let name = name.clone();
        let value = value.clone();
        let p = self.form.as_ref().unwrap().clone();
        match field {
            9 => self.edit(Edit::ApiKey, "API Key", ""),
            2 => self.load_catalog("form-model")?,
            1 => self.picker(
                Pick::Provider,
                "供应商类型",
                config::PROVIDERS
                    .iter()
                    .map(|(id, name)| Item {
                        id: (*id).into(),
                        name: (*name).into(),
                        description: String::new(),
                    })
                    .collect(),
                p.provider,
            ),
            3 => {
                if p.is_api() {
                    self.efforts(Pick::FormEffort, &p);
                } else {
                    self.load_catalog("form")?;
                }
            }
            7 => self.picker(
                Pick::Token,
                "输出长度参数",
                ["max_tokens", "max_completion_tokens"]
                    .iter()
                    .map(|id| Item {
                        id: (*id).into(),
                        name: (*id).into(),
                        description: String::new(),
                    })
                    .collect(),
                p.token_limit_parameter,
            ),
            8 => {
                p.validate()?;
                let mut config = self.config.clone();
                config.connections.retain(|c| c.id != p.id);
                config.connection = p.id.clone();
                config.connections.push(p.clone());
                config.set_selected(p.clone());
                config.validate()?;
                if p.is_api() {
                    if let Some(key) = self.form_key.take() {
                        self.api_keys.insert(p.id.clone(), key);
                    } else {
                        self.api_keys.remove(&p.id);
                    }
                } else {
                    self.api_keys.remove(&p.id);
                }
                self.config = config;
                self.screen = Screen::Settings;
                self.form = None;
            }
            _ => self.edit(Edit::Field(field), &name, &value),
        }
        Ok(())
    }
    fn settings_rows(&self) -> Vec<(String, String)> {
        let p = self.config.selected();
        vec![
            ("供应商".into(), p.name),
            (
                "模型".into(),
                if p.model.is_empty() {
                    "跟随客户端模型".into()
                } else {
                    p.model
                },
            ),
            (
                "思考程度".into(),
                config::effort_name(&p.reasoning_effort).into(),
            ),
            (
                "优化模板".into(),
                config::template_name(&self.config.template),
            ),
            (
                "参考聊天".into(),
                if self.config.context_enabled {
                    "开启"
                } else {
                    "关闭"
                }
                .into(),
            ),
            (
                "应用方式".into(),
                if self.config.auto_apply {
                    "直接回填"
                } else {
                    "先预览"
                }
                .into(),
            ),
            ("管理连接".into(), String::new()),
            ("API 账单 ↗".into(), String::new()),
            ("保存并返回".into(), String::new()),
        ]
    }
    fn footer(&self) -> &'static str {
        if self.loading {
            return "正在读取模型目录…  Esc 取消";
        }
        if self.busy {
            return "S 设置并停止生成    Esc 取消";
        }
        match self.screen {
            Screen::Preview if self.candidate.is_empty() => "Tab 原文/结果  S 设置\nO 重新生成  U 恢复原文  ↑↓ 滚动  Esc 返回",
            Screen::Preview => "A 回填  R 继续优化  Tab 原文/结果  S 设置\nO 重新生成  U 恢复原文  ↑↓ 滚动  Esc 返回",
            Screen::Settings => "↑↓ 选择  ←→ 切换  Enter 打开  Ctrl+S 保存并返回  Esc 放弃",
            Screen::Form => "↑↓ 选择  ←→ 切换选项  Enter 编辑  Esc 返回",
            Screen::Picker if self.picker.as_ref().is_some_and(Picker::is_model)=>"输入筛选  ↑↓ 选择  Enter 确认  Ctrl+U 清空  Esc 返回",
            Screen::Picker => "↑↓ 选择  Enter 确认  Esc 返回",
            Screen::Input if matches!(self.input.as_ref().map(|i| i.kind), Some(Edit::Instructions)) => "Enter 换行  Ctrl+S 继续优化  Esc 返回",
            Screen::Input => "Enter 确认  Esc 返回",
            Screen::Error => "Enter / Esc 返回 Codex",
        }
    }
    fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        if area.width < 30 || area.height < 10 {
            frame.render_widget(Paragraph::new("请放大终端窗口\nEsc 返回"), area);
            return;
        }
        let footer = wrap_text(self.footer(), area.width as usize);
        let footer_height = footer.len().min(area.height.saturating_sub(5) as usize) as u16;
        let notice = wrap_text(&self.notice, area.width as usize);
        let notice_height = if self.notice.is_empty() {
            0
        } else {
            (notice.len() + 1).min(area.height.saturating_sub(5 + footer_height) as usize) as u16
        };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Min(3),
                Constraint::Length(notice_height),
                Constraint::Length(footer_height),
            ])
            .split(area);
        let title = match self.screen {
            Screen::Settings => format!(
                "优化设置{}",
                if self.config != self.saved || !self.api_keys.is_empty() {
                    " · 未保存"
                } else {
                    ""
                }
            ),
            Screen::Form => "供应商连接".into(),
            Screen::Picker => self
                .picker
                .as_ref()
                .map(|p| p.title.clone())
                .unwrap_or_default(),
            Screen::Error => "提示词优化未完成".into(),
            _ => "提示词优化".into(),
        };
        let p = self.config.selected();
        let subtitle = if self.busy {
            format!(
                "{} {}",
                ["⠋", "⠙", "⠹", "⠸"][self.tick / 5 % 4],
                config::clean(&self.progress)
            )
        } else {
            format!(
                "{} · {}",
                p.name,
                if p.model.is_empty() {
                    "跟随客户端模型"
                } else {
                    &p.model
                }
            )
        };
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    title,
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                )),
                Line::from(subtitle),
            ]),
            rows[0],
        );
        match self.screen {
            Screen::Settings => {
                let list = self.settings_rows();
                draw_list(frame, rows[1], &list, self.setting);
            }
            Screen::Form => {
                let rows_data = self.form_rows();
                let list = rows_data
                    .iter()
                    .map(|(_, name, value)| (name.clone(), value.clone()))
                    .collect::<Vec<_>>();
                draw_list(frame, rows[1], &list, self.form_row);
            }
            Screen::Picker => {
                if let Some(p) = &self.picker {
                    let zones = Layout::vertical([
                        Constraint::Length(if p.is_model() { 1 } else { 0 }),
                        Constraint::Min(1),
                        Constraint::Length(3),
                    ])
                    .split(rows[1]);
                    if p.is_model() {
                        frame.render_widget(
                            Paragraph::new(format!(
                                "筛选：{}  ({}/{})",
                                p.query,
                                p.visible.len(),
                                p.items.len()
                            ))
                            .style(Style::default().fg(ACCENT)),
                            zones[0],
                        );
                    }
                    let list = p
                        .visible
                        .iter()
                        .map(|index| {
                            let i = &p.items[*index];
                            (
                                format!(
                                    "{}{}",
                                    if i.id == p.current { "● " } else { "  " },
                                    i.name
                                ),
                                String::new(),
                            )
                        })
                        .collect::<Vec<_>>();
                    if list.is_empty() {
                        frame.render_widget(
                            Paragraph::new(if p.is_model() {
                                "没有匹配的模型"
                            } else {
                                "暂无可选项"
                            }),
                            zones[1],
                        );
                    } else {
                        draw_list(frame, zones[1], &list, p.selected);
                    }
                    if let Some(item) = p.selected_item() {
                        frame.render_widget(
                            Paragraph::new(config::clean(&item.description))
                                .wrap(Wrap { trim: false }),
                            zones[2],
                        );
                    }
                    self.page = zones[1].height.saturating_sub(2).max(1) as usize;
                }
            }
            Screen::Error => {
                frame.render_widget(
                    Paragraph::new(config::clean(
                        self.fatal.as_deref().unwrap_or("优化未完成。"),
                    ))
                    .wrap(Wrap { trim: false })
                    .block(Block::default().borders(Borders::TOP)),
                    rows[1],
                );
            }
            Screen::Input => {
                let kind = self.input.as_ref().map(|i| i.kind);
                let zones = Layout::vertical([
                    Constraint::Min(1),
                    Constraint::Length(if matches!(kind, Some(Edit::Instructions)) {
                        7
                    } else {
                        3
                    }),
                ])
                .split(rows[1]);
                if matches!(kind, Some(Edit::Instructions)) {
                    self.preview(frame, zones[0]);
                }
                if let Some(input) = &self.input {
                    frame.render_widget(&input.area, zones[1]);
                }
            }
            _ => self.preview(frame, rows[1]),
        }
        frame.render_widget(
            Paragraph::new(
                notice
                    .iter()
                    .take(notice_height.saturating_sub(1) as usize)
                    .map(|s| Line::from(s.as_str()))
                    .collect::<Vec<_>>(),
            ),
            rows[2],
        );
        frame.render_widget(
            Paragraph::new(
                footer
                    .iter()
                    .map(|s| Line::from(s.as_str()))
                    .collect::<Vec<_>>(),
            ),
            rows[3],
        );
        if self.screen == Screen::Form {
            let fields = self.form_rows();
            if fields.get(self.form_row).is_some_and(|(id, _, _)| *id == 5) && rows[1].height > 12 {
                let hint = Rect::new(
                    rows[1].x + 2,
                    rows[1].bottom() - 2,
                    rows[1].width.saturating_sub(4),
                    2,
                );
                frame.render_widget(Clear, hint);
                frame.render_widget(
                    Paragraph::new("只填写环境变量名；在启动入口前设置，不输入 API Key。")
                        .wrap(Wrap { trim: false }),
                    hint,
                );
            }
        }
    }
    fn preview(&mut self, frame: &mut Frame, area: Rect) {
        let text = if self.busy && !self.stream.is_empty() {
            self.stream.clone()
        } else if !self.candidate.is_empty() {
            self.candidate.clone()
        } else if self.busy {
            self.progress.clone()
        } else {
            "尚无完整优化结果。".into()
        };
        if area.width >= 110 {
            let panes =
                Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)])
                    .split(area);
            self.original_max = draw_text(
                frame,
                panes[0],
                "原始输入",
                &self.original,
                &mut self.original_scroll,
                false,
                self.original_tab,
            );
            self.result_max = draw_text(
                frame,
                panes[1],
                "优化结果",
                &text,
                &mut self.result_scroll,
                self.busy && self.follow,
                !self.original_tab,
            );
            self.page = area.height.saturating_sub(2).max(1) as usize;
        } else {
            if self.original_tab {
                self.original_max = draw_text(
                    frame,
                    area,
                    "[原文]  结果",
                    &self.original,
                    &mut self.original_scroll,
                    false,
                    true,
                );
            } else {
                self.result_max = draw_text(
                    frame,
                    area,
                    "原文  [结果]",
                    &text,
                    &mut self.result_scroll,
                    self.busy && self.follow,
                    true,
                );
            }
            self.page = area.height.saturating_sub(2).max(1) as usize;
        }
    }
}
fn provider_name(id: &str) -> &str {
    config::PROVIDERS
        .iter()
        .find(|(p, _)| *p == id)
        .map(|(_, name)| *name)
        .unwrap_or(id)
}
fn draw_list(frame: &mut Frame, area: Rect, rows: &[(String, String)], selected: usize) {
    let items = rows
        .iter()
        .map(|(name, value)| {
            ListItem::new(Line::from(vec![
                Span::raw(format!(
                    "{name}{}",
                    " ".repeat(16usize.saturating_sub(UnicodeWidthStr::width(name.as_str())))
                )),
                Span::styled(
                    config::clean(value),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    let widget = List::new(items)
        .block(Block::default().borders(Borders::TOP))
        .highlight_symbol("› ")
        .highlight_style(Style::default().fg(ACCENT).add_modifier(Modifier::BOLD));
    let mut state = ListState::default().with_selected(Some(selected));
    frame.render_stateful_widget(widget, area, &mut state);
}
fn draw_text(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    text: &str,
    offset: &mut usize,
    follow: bool,
    focused: bool,
) -> usize {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(title)
        .border_style(if focused {
            Style::default().fg(ACCENT)
        } else {
            Style::default()
        });
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines = wrap_text(text, inner.width.max(1) as usize);
    let max = lines.len().saturating_sub(inner.height as usize);
    *offset = if follow { max } else { (*offset).min(max) };
    let text = lines
        .iter()
        .skip(*offset)
        .take(inner.height as usize)
        .map(|s| Line::from(s.as_str()))
        .collect::<Vec<_>>();
    frame.render_widget(Paragraph::new(text), inner);
    max
}
fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let clean = config::clean(text);
    let mut lines = Vec::new();
    let width = width.max(1);
    for source in clean.split('\n') {
        let mut line = String::new();
        let mut used = 0;
        for grapheme in source.graphemes(true) {
            let cell = if grapheme == "\t" { "  " } else { grapheme };
            let size = UnicodeWidthStr::width(cell);
            if used + size > width && !line.is_empty() {
                lines.push(line);
                line = String::new();
                used = 0;
            }
            line.push_str(cell);
            used += size;
        }
        lines.push(line);
    }
    lines
}
