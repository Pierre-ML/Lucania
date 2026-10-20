//! Journaux de diagnostic, dans `%LOCALAPPDATA%\com.lucania.desktop\logs-crash` :
//!
//! - `session.log` : journal de la session en cours (écrasé à chaque démarrage, 2 Mo au plus) :
//!   version, backend, périphériques, chargements de modèles, générations (sans leur contenu),
//!   erreurs du moteur, avertissements et erreurs de llama.cpp/ggml ;
//! - `crash-AAAAMMJJ-HHMMSS.log` : rapport écrit sur panique Rust, arrêt de ggml (GGML_ASSERT),
//!   `abort()` (SIGABRT) ou exception native Windows non gérée (violation d'accès…). Les 20 plus
//!   récents sont conservés.
//!
//! Les 200 dernières lignes du journal restent en mémoire et terminent chaque rapport. Ni le
//! contenu des conversations ni le jeton Hugging Face n'y figurent.
//!
//! Gestionnaires natifs : formatage sans allocation dans un tampon statique ; seuls le nom et
//! l'ouverture du fichier allouent quelques octets.

use std::collections::VecDeque;
use std::ffi::{CStr, c_char, c_void};
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, Once, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const DIR_NAME: &str = "logs-crash";
const SESSION_FILE: &str = "session.log";
const RING_LINES: usize = 200;
const SESSION_MAX: u64 = 2 * 1024 * 1024;
const MAX_REPORTS: usize = 20;
/// Tampon des rapports écrits par les gestionnaires natifs.
const REPORT_BUF: usize = 96 * 1024;

struct Config {
  dir: PathBuf,
  version: String,
}

static CONFIG: OnceLock<Config> = OnceLock::new();

struct Journal {
  file: Option<File>,
  written: u64,
  ring: VecDeque<String>,
}

static JOURNAL: Mutex<Journal> = Mutex::new(Journal { file: None, written: 0, ring: VecDeque::new() });

fn journal() -> MutexGuard<'static, Journal> {
  JOURNAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn build_backend() -> &'static str {
  if cfg!(feature = "cuda") { "cuda" } else { "cpu" }
}

fn profile() -> &'static str {
  if cfg!(debug_assertions) { "debug" } else { "release" }
}

// ---------------------------------------------------------------------------------------------
// Dates (sans dépendance)
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Stamp {
  y: u32,
  mo: u32,
  d: u32,
  h: u32,
  mi: u32,
  s: u32,
  ms: u32,
}

/// Jour civil (proleptique grégorien) à partir du nombre de jours depuis 1970-01-01.
fn civil(days: i64) -> (u32, u32, u32) {
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
  let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
  let y = (yoe + era * 400 + i64::from(m <= 2)) as u32;
  (y, m, d)
}

fn utc(t: SystemTime) -> Stamp {
  let dur = t.duration_since(UNIX_EPOCH).unwrap_or_default();
  let secs = dur.as_secs() as i64;
  let (y, mo, d) = civil(secs.div_euclid(86_400));
  let rem = secs.rem_euclid(86_400) as u32;
  Stamp { y, mo, d, h: rem / 3600, mi: rem / 60 % 60, s: rem % 60, ms: dur.subsec_millis() }
}

/// Heure locale (Windows) ; UTC ailleurs.
fn now() -> Stamp {
  #[cfg(windows)]
  {
    let mut st = win::SystemTime::default();
    unsafe { win::GetLocalTime(&mut st) };
    Stamp {
      y: st.year.into(),
      mo: st.month.into(),
      d: st.day.into(),
      h: st.hour.into(),
      mi: st.minute.into(),
      s: st.second.into(),
      ms: st.milliseconds.into(),
    }
  }
  #[cfg(not(windows))]
  utc(SystemTime::now())
}

/// Date ISO 8601 en UTC : 2026-10-18T00:48:12Z
pub fn iso8601(t: SystemTime) -> String {
  let s = utc(t);
  format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", s.y, s.mo, s.d, s.h, s.mi, s.s)
}

// ---------------------------------------------------------------------------------------------
// Journal de session
// ---------------------------------------------------------------------------------------------

/// Ajoute une ligne horodatée au journal (mémoire et `session.log`).
pub fn note(msg: &str) {
  let t = now();
  let line = format!("{:02}:{:02}:{:02}.{:03} {}", t.h, t.mi, t.s, t.ms, msg.trim_end());
  let mut guard = journal();
  let j = &mut *guard;
  if let Some(file) = j.file.as_mut() {
    let bytes = line.len() as u64 + 1;
    if j.written + bytes <= SESSION_MAX {
      if file.write_all(line.as_bytes()).and_then(|_| file.write_all(b"\n")).is_ok() {
        j.written += bytes;
      }
    } else {
      let _ = file.write_all("… journal plafonné à 2 Mo : la suite n'est plus écrite (dernières lignes dans les rapports de plantage)\n".as_bytes());
      j.file = None;
    }
  }
  if j.ring.len() >= RING_LINES {
    j.ring.pop_front();
  }
  j.ring.push_back(line);
}

/// Dossier des journaux (`None` avant `init`).
pub fn dir() -> Option<&'static Path> {
  CONFIG.get().map(|c| c.dir.as_path())
}

/// Dossier par défaut : `%LOCALAPPDATA%\<identifiant>\logs-crash` (même base que
/// `app_local_data_dir` de Tauri sous Windows), calculable avant la création de l'app.
pub fn default_dir(identifier: &str) -> PathBuf {
  std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .filter(|p| p.is_absolute())
    .unwrap_or_else(std::env::temp_dir)
    .join(identifier)
    .join(DIR_NAME)
}

/// Installe les gestionnaires de plantage. À appeler tout au début de `run()`. Le journal de
/// session n'est ouvert que par `start_session` (instance principale seulement : une deuxième
/// instance ne doit pas écraser le journal de la première).
pub fn init(dir: PathBuf, version: &str) {
  let _ = std::fs::create_dir_all(&dir);
  if CONFIG.set(Config { dir, version: version.to_string() }).is_err() {
    return;
  }
  install_panic_hook();
  install_llama_logs();
  install_native_handlers();
  note(&format!(
    "Lucania {version} ({}, build {}) sur {} {}",
    profile(),
    build_backend(),
    std::env::consts::OS,
    std::env::consts::ARCH
  ));
}

/// Ouvre `session.log` (écrasé), y recopie les lignes déjà notées et purge les vieux rapports.
pub fn start_session() {
  let Some(dir) = dir() else { return };
  prune_reports(dir, MAX_REPORTS);
  let file = File::create(dir.join(SESSION_FILE));
  let mut j = journal();
  let Ok(mut file) = file else { return };
  let t = now();
  let mut head = format!(
    "Journal de session Lucania - démarrage le {:04}-{:02}-{:02} à {:02}:{:02}:{:02}\n",
    t.y, t.mo, t.d, t.h, t.mi, t.s
  );
  for line in &j.ring {
    head.push_str(line);
    head.push('\n');
  }
  if file.write_all(head.as_bytes()).is_ok() {
    j.written = head.len() as u64;
    j.file = Some(file);
  }
}

/// Supprime les rapports `crash-*.log` les plus anciens au-delà de `keep`.
fn prune_reports(dir: &Path, keep: usize) {
  let mut reports: Vec<(SystemTime, PathBuf)> = list_files(dir)
    .into_iter()
    .filter(|(name, _, _)| is_report(name))
    .map(|(name, _, modified)| (modified, dir.join(name)))
    .collect();
  reports.sort_by_key(|r| std::cmp::Reverse(r.0));
  for (_, path) in reports.into_iter().skip(keep) {
    let _ = std::fs::remove_file(path);
  }
}

fn is_report(name: &str) -> bool {
  name.starts_with("crash-") && name.ends_with(".log")
}

/// (nom, taille, date de modification) des journaux du dossier.
fn list_files(dir: &Path) -> Vec<(String, u64, SystemTime)> {
  let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
  entries
    .flatten()
    .filter_map(|e| {
      let name = e.file_name().to_str()?.to_string();
      if !(is_report(&name) || name == SESSION_FILE) {
        return None;
      }
      let meta = e.metadata().ok().filter(|m| m.is_file())?;
      Some((name, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)))
    })
    .collect()
}

// ---------------------------------------------------------------------------------------------
// Logs de llama.cpp / ggml
// ---------------------------------------------------------------------------------------------

static LAST_LEVEL: AtomicUsize = AtomicUsize::new(0);
static PARTIAL: Mutex<String> = Mutex::new(String::new());

unsafe extern "C" fn llama_log(level: llama_cpp_sys_2::ggml_log_level, text: *const c_char, _user: *mut c_void) {
  if text.is_null() {
    return;
  }
  let bytes = unsafe { CStr::from_ptr(text) }.to_bytes();
  // En debug, la sortie habituelle de llama.cpp sur stderr est conservée.
  if cfg!(debug_assertions) {
    let _ = std::io::stderr().write_all(bytes);
  }
  let level = level as usize;
  let level = if level == llama_cpp_sys_2::GGML_LOG_LEVEL_CONT as usize {
    LAST_LEVEL.load(Ordering::Relaxed)
  } else {
    LAST_LEVEL.store(level, Ordering::Relaxed);
    level
  };
  let tag = if level == llama_cpp_sys_2::GGML_LOG_LEVEL_WARN as usize {
    "[llama] attention :"
  } else if level == llama_cpp_sys_2::GGML_LOG_LEVEL_ERROR as usize {
    "[llama] erreur :"
  } else {
    return;
  };
  let text = String::from_utf8_lossy(bytes);
  let mut partial = PARTIAL.lock().unwrap_or_else(|e| e.into_inner());
  partial.push_str(&text);
  if partial.ends_with('\n') || partial.len() > 4096 {
    let line = std::mem::take(&mut *partial);
    drop(partial);
    note(&format!("{tag} {}", line.trim_end()));
  }
}

/// Redirige les logs de llama.cpp et ggml (une seule fois) : niveaux WARN/ERROR vers le
/// journal, tout vers stderr en debug.
pub fn install_llama_logs() {
  static ONCE: Once = Once::new();
  ONCE.call_once(|| unsafe {
    llama_cpp_sys_2::llama_log_set(Some(llama_log), std::ptr::null_mut());
    // Après llama_log_set, qui règle aussi celui de ggml (comme llama-cpp-2).
    llama_cpp_sys_2::ggml_log_set(Some(llama_log), std::ptr::null_mut());
  });
}

// ---------------------------------------------------------------------------------------------
// Rapports de plantage
// ---------------------------------------------------------------------------------------------

/// Écriture bornée dans un tampon (tronque sans erreur).
struct Cursor<'a> {
  buf: &'a mut [u8],
  len: usize,
}

impl std::fmt::Write for Cursor<'_> {
  fn write_str(&mut self, s: &str) -> std::fmt::Result {
    let n = s.len().min(self.buf.len() - self.len);
    self.buf[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
    self.len += n;
    Ok(())
  }
}

struct StaticBuf(std::cell::UnsafeCell<[u8; REPORT_BUF]>);
// SAFETY : accès exclusif garanti par REPORT_BUSY.
unsafe impl Sync for StaticBuf {}
static BUF: StaticBuf = StaticBuf(std::cell::UnsafeCell::new([0; REPORT_BUF]));
/// Un rapport est en cours d'écriture (évite la réentrance et les doublons simultanés).
static REPORT_BUSY: AtomicBool = AtomicBool::new(false);
/// Rapport déjà écrit par le callback d'abort de ggml : le SIGABRT qui suit est ignoré.
static ABORT_REPORTED: AtomicBool = AtomicBool::new(false);

/// Écrit `crash-<date>.log` : en-tête, `body`, puis les dernières lignes du journal. Renvoie le
/// chemin écrit.
fn write_report(kind: &str, body: impl FnOnce(&mut Cursor)) -> Option<PathBuf> {
  let cfg = CONFIG.get()?;
  if REPORT_BUSY.swap(true, Ordering::Acquire) {
    return None;
  }
  // SAFETY : REPORT_BUSY donne l'accès exclusif au tampon.
  let buf = unsafe { &mut *BUF.0.get() };
  let mut c = Cursor { buf, len: 0 };
  let t = now();
  let _ = write!(
    c,
    "Rapport de plantage Lucania\nDate : {:04}-{:02}-{:02} {:02}:{:02}:{:02}\nVersion : {} ({}, build {})\nType : {kind}\n\n",
    t.y, t.mo, t.d, t.h, t.mi, t.s, cfg.version, profile(), build_backend()
  );
  body(&mut c);
  let _ = c.write_str("\n\n--- Dernières lignes du journal ---\n");
  // try_lock : le plantage a pu survenir pendant une écriture du journal.
  match JOURNAL.try_lock() {
    Ok(j) => {
      for line in &j.ring {
        let _ = c.write_str(line);
        let _ = c.write_str("\n");
      }
    }
    Err(std::sync::TryLockError::Poisoned(p)) => {
      for line in &p.get_ref().ring {
        let _ = c.write_str(line);
        let _ = c.write_str("\n");
      }
    }
    Err(std::sync::TryLockError::WouldBlock) => {
      let _ = c.write_str("(journal verrouillé au moment du plantage)\n");
    }
  }
  let len = c.len;
  let stamp = format!("crash-{:04}{:02}{:02}-{:02}{:02}{:02}", t.y, t.mo, t.d, t.h, t.mi, t.s);
  let mut written = None;
  for i in 0..10 {
    let name = if i == 0 { format!("{stamp}.log") } else { format!("{stamp}-{i}.log") };
    let path = cfg.dir.join(name);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(mut f) => {
        let _ = f.write_all(&buf[..len]);
        written = Some(path);
        break;
      }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(_) => break,
    }
  }
  REPORT_BUSY.store(false, Ordering::Release);
  written
}

fn install_panic_hook() {
  let previous = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    let thread = std::thread::current();
    let thread = thread.name().unwrap_or("sans nom").to_string();
    let payload = info.payload();
    let msg = payload
      .downcast_ref::<&str>()
      .map(|s| s.to_string())
      .or_else(|| payload.downcast_ref::<String>().cloned())
      .unwrap_or_else(|| "(message non textuel)".into());
    let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
    note(&format!("panique dans le thread « {thread} » ({location}) : {msg}"));
    let backtrace = std::backtrace::Backtrace::force_capture();
    let written = write_report("panique Rust (le moteur peut l'avoir interceptée et continué)", |c| {
      let _ = write!(c, "Thread : {thread}\nEmplacement : {location}\nMessage : {msg}\n\nPile d'appels :\n{backtrace}");
    });
    if written.is_some() {
      if let Some(d) = dir() {
        prune_reports(d, MAX_REPORTS);
      }
    }
    previous(info);
  }));
}

unsafe extern "C" fn ggml_abort_cb(message: *const c_char) {
  let msg = if message.is_null() { Default::default() } else { unsafe { CStr::from_ptr(message) }.to_string_lossy() };
  if write_report("arrêt de ggml / llama.cpp (GGML_ASSERT ou GGML_ABORT)", |c| {
    let _ = write!(c, "Message : {}", msg.trim_end());
  })
  .is_some()
  {
    ABORT_REPORTED.store(true, Ordering::SeqCst);
  }
}

extern "C" fn on_sigabrt(_sig: i32) {
  if ABORT_REPORTED.load(Ordering::SeqCst) {
    return;
  }
  write_report("abort() (signal SIGABRT)", |c| {
    let _ = c.write_str("Le processus a appelé abort() (bibliothèque native ou exception C++ non rattrapée).");
  });
}

fn install_native_handlers() {
  unsafe {
    llama_cpp_sys_2::ggml_set_abort_callback(Some(ggml_abort_cb));
    let handler: extern "C" fn(i32) = on_sigabrt;
    crt::signal(crt::SIGABRT, handler as usize);
  }
  arm_exception_filter();
}

/// (Ré)installe le filtre d'exceptions non gérées de Windows. Rappelé après l'initialisation de
/// llama.cpp/CUDA au cas où une bibliothèque l'aurait remplacé (l'ancien filtre est chaîné).
pub fn arm_exception_filter() {
  #[cfg(windows)]
  win::arm();
}

mod crt {
  pub const SIGABRT: i32 = if cfg!(windows) { 22 } else { 6 };
  unsafe extern "C" {
    pub fn signal(sig: i32, handler: usize) -> usize;
  }
}

#[cfg(windows)]
mod win {
  use std::ffi::c_void;
  use std::fmt::Write as _;
  use std::sync::atomic::{AtomicUsize, Ordering};

  #[repr(C)]
  #[derive(Default)]
  pub struct SystemTime {
    pub year: u16,
    pub month: u16,
    pub day_of_week: u16,
    pub day: u16,
    pub hour: u16,
    pub minute: u16,
    pub second: u16,
    pub milliseconds: u16,
  }

  #[repr(C)]
  struct ExceptionRecord {
    code: u32,
    flags: u32,
    record: *mut ExceptionRecord,
    address: *mut c_void,
    n_params: u32,
    info: [usize; 15],
  }

  #[repr(C)]
  struct ExceptionPointers {
    record: *const ExceptionRecord,
    context: *const c_void,
  }

  type Filter = Option<unsafe extern "system" fn(*const ExceptionPointers) -> i32>;

  const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
  const GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS: u32 = 0x4;
  const GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT: u32 = 0x2;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    pub fn GetLocalTime(st: *mut SystemTime);
    fn SetUnhandledExceptionFilter(filter: Filter) -> Filter;
    fn GetModuleHandleExW(flags: u32, name: *const c_void, module: *mut *mut c_void) -> i32;
    fn GetModuleFileNameW(module: *mut c_void, buf: *mut u16, size: u32) -> u32;
  }

  /// Filtre précédent (chaîné), 0 si aucun.
  static PREVIOUS: AtomicUsize = AtomicUsize::new(0);

  pub fn arm() {
    let ours: unsafe extern "system" fn(*const ExceptionPointers) -> i32 = filter;
    let prev = unsafe { SetUnhandledExceptionFilter(Some(ours)) };
    if let Some(p) = prev {
      if p as usize != ours as usize {
        PREVIOUS.store(p as usize, Ordering::SeqCst);
      }
    }
  }

  fn describe(code: u32) -> &'static str {
    match code {
      0xC000_0005 => "violation d'accès (EXCEPTION_ACCESS_VIOLATION)",
      0xC000_001D => "instruction illégale (CPU non compatible ?)",
      0xC000_00FD => "débordement de pile",
      0xC000_0094 => "division entière par zéro",
      0xC000_0409 => "dépassement de tampon détecté (/GS)",
      0xC000_0374 => "corruption du tas",
      0xC000_0006 => "erreur de page (fichier mappé illisible ?)",
      0xE06D_7363 => "exception C++ non rattrapée",
      _ => "exception native",
    }
  }

  /// Nom (sans dossier) du module qui contient `addr`, et décalage dans ce module.
  fn module_of(addr: *const c_void, c: &mut super::Cursor) {
    let mut module: *mut c_void = std::ptr::null_mut();
    let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
    if unsafe { GetModuleHandleExW(flags, addr, &mut module) } == 0 || module.is_null() {
      let _ = c.write_str("Module : inconnu\n");
      return;
    }
    let mut name = [0u16; 520];
    let n = unsafe { GetModuleFileNameW(module, name.as_mut_ptr(), name.len() as u32) } as usize;
    let path = &name[..n.min(name.len())];
    let start = path.iter().rposition(|&ch| ch == b'\\' as u16 || ch == b'/' as u16).map_or(0, |i| i + 1);
    let _ = c.write_str("Module : ");
    for ch in char::decode_utf16(path[start..].iter().copied()) {
      let _ = c.write_char(ch.unwrap_or('?'));
    }
    let _ = writeln!(c, " + 0x{:x}", (addr as usize).wrapping_sub(module as usize));
  }

  unsafe extern "system" fn filter(info: *const ExceptionPointers) -> i32 {
    let record = unsafe { info.as_ref().and_then(|i| i.record.as_ref()) };
    super::write_report("exception native Windows non gérée", |c| {
      let Some(r) = record else {
        let _ = c.write_str("Aucun détail disponible.");
        return;
      };
      let _ = writeln!(c, "Code : 0x{:08X} - {}", r.code, describe(r.code));
      let _ = writeln!(c, "Adresse : 0x{:016X}", r.address as usize);
      module_of(r.address, c);
      if r.code == 0xC000_0005 && r.n_params >= 2 {
        let op = match r.info[0] {
          0 => "lecture",
          1 => "écriture",
          8 => "exécution",
          _ => "accès",
        };
        let _ = writeln!(c, "Opération : {op} à l'adresse 0x{:016X}", r.info[1]);
      }
      let _ = c.write_str("\nCause fréquente : fichier GGUF incompatible, mémoire (VRAM) insuffisante ou pilote GPU.");
    });
    let prev = PREVIOUS.load(Ordering::SeqCst);
    if prev != 0 {
      // SAFETY : valeur enregistrée depuis un pointeur de fonction `Filter` valide.
      let f: unsafe extern "system" fn(*const ExceptionPointers) -> i32 = unsafe { std::mem::transmute(prev) };
      return unsafe { f(info) };
    }
    EXCEPTION_CONTINUE_SEARCH
  }
}

// ---------------------------------------------------------------------------------------------
// Commandes Tauri
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashLogFile {
  pub name: String,
  pub size_bytes: u64,
  /// ISO 8601 (UTC)
  pub modified: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashLogs {
  pub dir: String,
  pub files: Vec<CrashLogFile>,
}

const NO_DIR: &str = "Dossier des journaux indisponible.";

/// Rapports `crash-*.log` et `session.log`, du plus récent au plus ancien.
pub fn crash_logs() -> Result<CrashLogs, String> {
  let dir = dir().ok_or(NO_DIR)?;
  let mut files = list_files(dir);
  files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
  Ok(CrashLogs {
    dir: dir.to_string_lossy().into_owned(),
    files: files
      .into_iter()
      .map(|(name, size_bytes, modified)| CrashLogFile { name, size_bytes, modified: iso8601(modified) })
      .collect(),
  })
}

#[tauri::command]
pub async fn app_crash_logs() -> Result<CrashLogs, String> {
  crash_logs()
}

/// Ouvre le dossier des journaux dans l'Explorateur Windows (sans plugin shell).
#[tauri::command]
pub async fn app_open_crash_logs() -> Result<(), String> {
  let dir = dir().ok_or(NO_DIR)?;
  std::fs::create_dir_all(dir).map_err(|e| format!("Création du dossier des journaux impossible : {e}"))?;
  std::process::Command::new("explorer")
    .arg(dir)
    .spawn()
    .map(|_| ())
    .map_err(|e| format!("Ouverture de l'Explorateur impossible : {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn dates() {
    assert_eq!(civil(0), (1970, 1, 1));
    assert_eq!(civil(19_723), (2024, 1, 1));
    assert_eq!(civil(20_744), (2026, 10, 18));
    assert_eq!(iso8601(UNIX_EPOCH + std::time::Duration::from_secs(1_792_284_492)), "2026-10-18T00:48:12Z");
  }

  #[test]
  fn tampon_borne() {
    let mut b = [0u8; 8];
    let mut c = Cursor { buf: &mut b, len: 0 };
    let _ = write!(c, "abcdefghijkl");
    assert_eq!(&b[..], b"abcdefgh");
  }

  #[test]
  fn purge_et_liste() {
    let d = std::env::temp_dir().join(format!("lucania-crashlog-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    for i in 0..25 {
      std::fs::write(d.join(format!("crash-20260101-0000{i:02}.log")), b"x").unwrap();
    }
    std::fs::write(d.join(SESSION_FILE), b"s").unwrap();
    std::fs::write(d.join("autre.txt"), b"a").unwrap();
    prune_reports(&d, 20);
    let files = list_files(&d);
    assert_eq!(files.iter().filter(|f| is_report(&f.0)).count(), 20);
    assert!(files.iter().any(|f| f.0 == SESSION_FILE));
    assert!(!files.iter().any(|f| f.0 == "autre.txt"));
    let _ = std::fs::remove_dir_all(&d);
  }

  /// Variables du processus enfant : mode de plantage et dossier des journaux.
  const CHILD_MODE: &str = "LUCANIA_CRASH_CHILD";
  const CHILD_DIR: &str = "LUCANIA_CRASH_DIR";

  /// Processus enfant (lancé par `plantages_reels`) : installe les gestionnaires puis plante.
  #[test]
  #[ignore]
  fn enfant_plantage() {
    let (Ok(mode), Ok(dir)) = (std::env::var(CHILD_MODE), std::env::var(CHILD_DIR)) else { return };
    init(PathBuf::from(dir), "0.0.0-test");
    start_session();
    note("[moteur] ligne de test avant plantage");
    match mode.as_str() {
      "panic" => panic!("panique volontaire de test"),
      "ggml" => unsafe {
        llama_cpp_sys_2::ggml_abort(c"test.c".as_ptr(), 42, c"assertion de test".as_ptr());
      },
      "abort" => unsafe {
        unsafe extern "C" {
          fn abort() -> !;
        }
        abort();
      },
      "segv" => unsafe {
        // Adresse non nulle et alignée : read_volatile vérifie le pointeur nul en debug.
        let p = std::hint::black_box(0x10usize) as *const u64;
        let _ = std::ptr::read_volatile(p);
      },
      // Fichier réel chargé SANS la vérification du moteur (ex. tête MTP : violation d'accès
      // dans llama.cpp à la création du contexte).
      "llama" => {
        use llama_cpp_2::context::params::LlamaContextParams;
        use llama_cpp_2::llama_backend::LlamaBackend;
        use llama_cpp_2::model::LlamaModel;
        use llama_cpp_2::model::params::LlamaModelParams;
        let path = std::env::var("LUCANIA_TEST_GGUF").unwrap();
        install_llama_logs();
        let backend = LlamaBackend::init().unwrap();
        arm_exception_filter();
        let model = LlamaModel::load_from_file(&backend, &path, &LlamaModelParams::default()).unwrap();
        let ctx = LlamaContextParams::default().with_n_ctx(std::num::NonZeroU32::new(512));
        let _ = model.new_context(&backend, ctx);
      }
      _ => {}
    }
  }

  /// Test manuel : cargo test --lib crashlog -- --ignored --nocapture
  /// Lance un sous-processus par mode et vérifie le rapport crash-*.log écrit. Avec
  /// LUCANIA_TEST_GGUF=<fichier qui fait planter llama.cpp>, vérifie aussi le cas réel.
  #[test]
  #[ignore]
  fn plantages_reels() {
    let exe = std::env::current_exe().unwrap();
    for (mode, expected) in [
      ("panic", "panique volontaire de test"),
      ("ggml", "assertion de test"),
      ("abort", "SIGABRT"),
      ("segv", "0xC0000005"),
      ("llama", "0xC0000005"),
    ] {
      if mode == "llama" && std::env::var_os("LUCANIA_TEST_GGUF").is_none() {
        continue;
      }
      let dir = std::env::temp_dir().join(format!("lucania-crash-{mode}-{}", std::process::id()));
      let _ = std::fs::remove_dir_all(&dir);
      let out = std::process::Command::new(&exe)
        .args(["--ignored", "--exact", "crashlog::tests::enfant_plantage", "--nocapture", "--test-threads=1"])
        .env(CHILD_MODE, mode)
        .env(CHILD_DIR, &dir)
        .output()
        .unwrap();
      let reports: Vec<_> = list_files(&dir).into_iter().filter(|f| is_report(&f.0)).collect();
      eprintln!("== {mode} : code de sortie {:?}, rapports {:?}", out.status.code().map(|c| format!("0x{:X}", c as u32)), reports.iter().map(|r| &r.0).collect::<Vec<_>>());
      assert!(!out.status.success(), "{mode} : l'enfant aurait dû planter");
      assert_eq!(reports.len(), 1, "{mode} : un rapport attendu");
      let text = std::fs::read_to_string(dir.join(&reports[0].0)).unwrap();
      eprintln!("{text}");
      assert!(text.contains(expected), "{mode} : « {expected} » absent");
      assert!(text.contains("ligne de test avant plantage"), "{mode} : tampon circulaire absent");
      let session = std::fs::read_to_string(dir.join(SESSION_FILE)).unwrap();
      assert!(session.contains("ligne de test avant plantage"));
      let _ = std::fs::remove_dir_all(&dir);
    }
  }
}
