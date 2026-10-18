//! Matériel de la machine (RAM, GPU), pour conseiller des modèles adaptés.
//!
//! - RAM : `GlobalMemoryStatusEx` (kernel32), déclarée à la main comme dans `crashlog` : un
//!   seul appel, pas de crate supplémentaire (`windows-sys` n'est qu'une dépendance indirecte, il
//!   faudrait l'ajouter avec ses features). Relue à chaque appel (coût négligeable).
//! - GPU, build cuda : périphériques ggml de llama.cpp (après l'initialisation du moteur), mémoire
//!   libre relue à chaque appel ;
//! - GPU, build CPU (ou aucun GPU vu par llama.cpp) : `nvidia-smi` s'il existe (sans fenêtre,
//!   8 s au plus), relancé au plus toutes les 10 s pour la mémoire libre ;
//! - sinon : liste vide.
//!
//! La source est choisie une fois (première détection), puis gardée.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::engine::Engine;

/// Le premier appel peut prendre quelques secondes (GPU de portable qui sort de veille).
const SMI_TIMEOUT: Duration = Duration::from_secs(8);
const SMI_REFRESH: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
  pub name: String,
  pub vram_total_bytes: u64,
  pub vram_free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
  pub ram_total_bytes: u64,
  pub ram_available_bytes: u64,
  pub gpus: Vec<Gpu>,
  /// "llama", "nvidia-smi" ou "none".
  pub source: &'static str,
}

#[derive(Clone, Copy, PartialEq)]
enum Source {
  Llama,
  NvidiaSmi,
  None,
}

impl Source {
  fn label(self) -> &'static str {
    match self {
      Source::Llama => "llama",
      Source::NvidiaSmi => "nvidia-smi",
      Source::None => "none",
    }
  }
}

struct Detected {
  source: Source,
  gpus: Vec<Gpu>,
  at: Instant,
}

static DETECTED: Mutex<Option<Detected>> = Mutex::new(None);

fn log(msg: &str) {
  eprintln!("[matériel] {msg}");
  crate::crashlog::note(&format!("[matériel] {msg}"));
}

// ---------------------------------------------------------------------------------------------
// RAM
// ---------------------------------------------------------------------------------------------

#[cfg(windows)]
mod win {
  #[repr(C)]
  pub struct MemoryStatusEx {
    pub length: u32,
    pub memory_load: u32,
    pub total_phys: u64,
    pub avail_phys: u64,
    pub total_page_file: u64,
    pub avail_page_file: u64,
    pub total_virtual: u64,
    pub avail_virtual: u64,
    pub avail_extended_virtual: u64,
  }

  #[link(name = "kernel32")]
  unsafe extern "system" {
    pub fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
  }
}

/// RAM physique (totale, disponible) en octets ; (0, 0) si inconnue.
fn ram() -> (u64, u64) {
  #[cfg(windows)]
  {
    let mut s = win::MemoryStatusEx {
      length: std::mem::size_of::<win::MemoryStatusEx>() as u32,
      memory_load: 0,
      total_phys: 0,
      avail_phys: 0,
      total_page_file: 0,
      avail_page_file: 0,
      total_virtual: 0,
      avail_virtual: 0,
      avail_extended_virtual: 0,
    };
    // SAFETY : structure initialisée avec sa taille, comme l'exige l'API.
    if unsafe { win::GlobalMemoryStatusEx(&mut s) } != 0 {
      return (s.total_phys, s.avail_phys);
    }
    (0, 0)
  }
  #[cfg(not(windows))]
  (0, 0)
}

// ---------------------------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------------------------

/// GPU vus par llama.cpp (build cuda seulement : le build CPU ne voit que le processeur).
#[cfg(feature = "cuda")]
fn llama_gpus() -> Vec<Gpu> {
  use llama_cpp_2::{LlamaBackendDeviceType, list_llama_ggml_backend_devices};
  list_llama_ggml_backend_devices()
    .into_iter()
    .filter(|d| matches!(d.device_type, LlamaBackendDeviceType::Gpu | LlamaBackendDeviceType::IntegratedGpu))
    .map(|d| Gpu {
      name: if d.description.trim().is_empty() { d.name } else { d.description.trim().to_string() },
      vram_total_bytes: d.memory_total as u64,
      vram_free_bytes: Some(d.memory_free as u64),
    })
    .collect()
}

#[cfg(not(feature = "cuda"))]
fn llama_gpus() -> Vec<Gpu> {
  Vec::new()
}

/// Sortie de `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`
/// (Mio) : une ligne par GPU, « nom, total, libre ». Lignes illisibles ignorées.
fn parse_nvidia_smi(out: &str) -> Vec<Gpu> {
  const MIB: u64 = 1024 * 1024;
  out
    .lines()
    .filter_map(|line| {
      // Analyse par la droite : le nom pourrait contenir une virgule.
      let mut it = line.rsplitn(3, ',');
      let free = it.next()?.trim();
      let total = it.next()?.trim();
      let name = it.next()?.trim();
      let total: u64 = total.parse().ok()?;
      (!name.is_empty() && total > 0).then(|| Gpu {
        name: name.to_string(),
        vram_total_bytes: total.saturating_mul(MIB),
        vram_free_bytes: free.parse::<u64>().ok().map(|f| f.saturating_mul(MIB)),
      })
    })
    .collect()
}

/// Lance `nvidia-smi` (dossier système d'abord, sinon PATH) ; `None` s'il est absent, échoue ou
/// dépasse le délai.
fn run_nvidia_smi() -> Option<Vec<Gpu>> {
  use std::io::Read;
  use std::process::{Command, Stdio};
  let exe = std::env::var_os("SystemRoot")
    .map(|root| std::path::PathBuf::from(root).join("System32").join("nvidia-smi.exe"))
    .filter(|p| p.is_file())
    .unwrap_or_else(|| "nvidia-smi".into());
  let mut cmd = Command::new(exe);
  cmd
    .args(["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
  }
  let mut child = cmd.spawn().ok()?;
  let deadline = Instant::now() + SMI_TIMEOUT;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        log("nvidia-smi : délai dépassé");
        return None;
      }
    }
  };
  if !status.success() {
    return None;
  }
  // Sortie courte (quelques lignes) : elle tient dans le tampon du tube.
  let mut out = String::new();
  child.stdout.take()?.read_to_string(&mut out).ok()?;
  Some(parse_nvidia_smi(&out))
}

/// GPU de la machine (source choisie à la première détection).
fn gpus(engine: Option<&Engine>) -> (Source, Vec<Gpu>) {
  let mut guard = DETECTED.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(d) = guard.as_mut() {
    match d.source {
      Source::Llama => d.gpus = llama_gpus(),
      Source::NvidiaSmi if d.at.elapsed() >= SMI_REFRESH => {
        if let Some(g) = run_nvidia_smi().filter(|g| !g.is_empty()) {
          d.gpus = g;
        }
        d.at = Instant::now();
      }
      _ => {}
    }
    return (d.source, d.gpus.clone());
  }

  let mut detected = (Source::None, Vec::new());
  if cfg!(feature = "cuda") {
    // Attend l'initialisation du backend par le thread du moteur (30 s au plus).
    if let Some(e) = engine {
      e.info();
    }
    let g = llama_gpus();
    if !g.is_empty() {
      detected = (Source::Llama, g);
    }
  }
  if detected.0 == Source::None {
    if let Some(g) = run_nvidia_smi().filter(|g| !g.is_empty()) {
      detected = (Source::NvidiaSmi, g);
    }
  }
  let list: Vec<String> = detected.1.iter().map(|g| format!("{} ({} Mo)", g.name, g.vram_total_bytes >> 20)).collect();
  log(&format!("GPU détectés via {} : {}", detected.0.label(), if list.is_empty() { "aucun".into() } else { list.join(", ") }));
  *guard = Some(Detected { source: detected.0, gpus: detected.1.clone(), at: Instant::now() });
  detected
}

/// Matériel actuel. Bloquant (première détection : jusqu'à l'initialisation du moteur ou au
/// délai de nvidia-smi) : à appeler hors du thread principal.
pub fn detect(engine: Option<&Engine>) -> Hardware {
  let (ram_total_bytes, ram_available_bytes) = ram();
  let (source, gpus) = gpus(engine);
  Hardware { ram_total_bytes, ram_available_bytes, gpus, source: source.label() }
}

#[tauri::command]
pub async fn system_hardware(app: AppHandle) -> Result<Hardware, String> {
  let engine = app.try_state::<Engine>().map(|e| e.inner().clone());
  tauri::async_runtime::spawn_blocking(move || detect(engine.as_ref()))
    .await
    .map_err(|e| format!("Détection du matériel interrompue : {e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sortie_nvidia_smi() {
    let out = "NVIDIA GeForce RTX 5070, 8151, 7020\r\nNVIDIA RTX A2000, 6138, [N/A]\n\nligne illisible\nX, abc, 1\n";
    let g = parse_nvidia_smi(out);
    assert_eq!(g.len(), 2);
    assert_eq!(g[0], Gpu { name: "NVIDIA GeForce RTX 5070".into(), vram_total_bytes: 8151 << 20, vram_free_bytes: Some(7020 << 20) });
    assert_eq!(g[1].vram_free_bytes, None);
    assert!(parse_nvidia_smi("").is_empty());
  }

  #[test]
  fn ram_lue() {
    let (total, avail) = ram();
    if cfg!(windows) {
      assert!(total > 0 && avail > 0 && avail <= total);
    }
  }

  /// Test manuel : cargo test --lib hardware -- --ignored --nocapture (ajouter --features cuda
  /// pour la source llama.cpp).
  #[test]
  #[ignore]
  fn detection_reelle() {
    // Build cuda : initialise le backend comme le ferait le moteur.
    #[cfg(feature = "cuda")]
    let _backend = llama_cpp_2::llama_backend::LlamaBackend::init().ok();
    let start = Instant::now();
    let h = detect(None);
    eprintln!("1re détection en {:?} : {}", start.elapsed(), serde_json::to_string_pretty(&h).unwrap());
    let start = Instant::now();
    let h2 = detect(None);
    eprintln!("2e appel en {:?} : source {}, {:?}", start.elapsed(), h2.source, h2.gpus);
    assert!(h.ram_total_bytes > 0);
  }
}
