//! Réglages par modèle : `<app_local_data_dir>/model-profiles.json`, objet identifiant ->
//! profil. Chargé au démarrage (fichier absent : vide ; JSON corrompu : mis de côté en .bak),
//! réécrit en entier à chaque modification (fichier temporaire puis renommage).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::log;
use super::types::{ChatMessage, GenParams, LoadOptions, ModelProfile};

/// Longueur maximale du prompt système d'un profil (caractères).
const MAX_SYSTEM_PROMPT: usize = 32_000;

pub(crate) struct ProfileStore {
  path: PathBuf,
  map: BTreeMap<String, ModelProfile>,
}

impl ProfileStore {
  pub fn open(path: PathBuf) -> ProfileStore {
    let map = match std::fs::read(&path) {
      Ok(bytes) => match serde_json::from_slice::<BTreeMap<String, ModelProfile>>(&bytes) {
        Ok(m) => m,
        Err(e) => {
          let bak = path.with_extension("json.bak");
          log(&format!("profils des modèles illisibles ({e}) : fichier mis de côté ({})", bak.display()));
          if let Err(e) = std::fs::rename(&path, &bak) {
            log(&format!("mise de côté impossible : {e}"));
          }
          BTreeMap::new()
        }
      },
      Err(_) => BTreeMap::new(),
    };
    ProfileStore { path, map }
  }

  /// Profil du modèle (vide s'il n'en a pas).
  pub fn get(&self, id: &str) -> ModelProfile {
    self.map.get(id).cloned().unwrap_or_default()
  }

  /// Enregistre un profil validé ; un profil vide supprime l'entrée. Renvoie l'ancien profil.
  pub fn set(&mut self, id: &str, profile: ModelProfile) -> Result<ModelProfile, String> {
    let profile = validate(profile)?;
    let old = self.get(id);
    let mut next = self.map.clone();
    if profile == ModelProfile::default() {
      next.remove(id);
    } else {
      next.insert(id.to_string(), profile);
    }
    self.save(&next)?;
    self.map = next;
    Ok(old)
  }

  /// Supprime le profil du modèle. Renvoie l'ancien profil.
  pub fn remove(&mut self, id: &str) -> Result<ModelProfile, String> {
    self.set(id, ModelProfile::default())
  }

  fn save(&self, map: &BTreeMap<String, ModelProfile>) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(map).map_err(|e| format!("Enregistrement des réglages impossible : {e}"))?;
    write_atomic(&self.path, &json).map_err(|e| format!("Enregistrement des réglages impossible : {e}"))
  }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  if let Some(dir) = path.parent() {
    std::fs::create_dir_all(dir)?;
  }
  let tmp = path.with_extension("json.tmp");
  std::fs::write(&tmp, bytes)?;
  std::fs::rename(&tmp, path)
}

fn check<T: PartialOrd + Copy + std::fmt::Display>(name: &str, v: Option<T>, min: T, max: T) -> Result<(), String> {
  match v {
    Some(x) if x < min || x > max => Err(format!("{name} doit être compris entre {min} et {max} (reçu : {x}).")),
    _ => Ok(()),
  }
}

fn check_f(name: &str, v: Option<f32>, min: f32, max: f32) -> Result<(), String> {
  match v {
    Some(x) if !x.is_finite() => Err(format!("{name} doit être un nombre fini.")),
    _ => check(name, v, min, max),
  }
}

/// Valide et normalise un profil (prompt système rogné, vide -> absent ; useProfile retiré).
pub fn validate(mut p: ModelProfile) -> Result<ModelProfile, String> {
  let l: &LoadOptions = &p.load;
  if l.n_ctx != Some(0) {
    check("nCtx", l.n_ctx, 256, 1_048_576).map_err(|e| format!("{e} 0 = contexte d'entraînement du modèle."))?;
  }
  check("nGpuLayers", l.n_gpu_layers, 0, 999)?;
  check("nThreads", l.n_threads, 1, 256)?;
  check("nBatch", l.n_batch, 32, 8192)?;
  let g: &GenParams = &p.generation;
  check_f("temperature", g.temperature, 0.0, 10.0)?;
  check_f("topP", g.top_p, 0.0, 1.0)?;
  check_f("minP", g.min_p, 0.0, 1.0)?;
  check("topK", g.top_k, 0, i32::MAX)?;
  check_f("repeatPenalty", g.repeat_penalty, 0.5, 2.0)?;
  check("maxTokens", g.max_tokens, 1, 131_072)?;
  p.generation.system_prompt = p.generation.system_prompt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
  if let Some(s) = &p.generation.system_prompt {
    let n = s.chars().count();
    if n > MAX_SYSTEM_PROMPT {
      return Err(format!("Le prompt système est trop long ({n} caractères, {MAX_SYSTEM_PROMPT} au plus)."));
    }
  }
  p.generation.use_profile = None;
  Ok(p)
}

/// Place le prompt système du profil en tête de la conversation : avant le contenu d'un
/// message system existant, sinon dans un nouveau message system.
pub fn apply_system_prompt(messages: &mut Vec<ChatMessage>, prompt: Option<&str>) {
  let Some(prompt) = prompt.map(str::trim).filter(|p| !p.is_empty()) else {
    return;
  };
  match messages.first_mut() {
    Some(first) if first.role == "system" => first.content = format!("{prompt}\n\n{}", first.content),
    _ => messages.insert(0, ChatMessage { role: "system".into(), content: prompt.to_string() }),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::types::CacheType;

  fn msg(role: &str, content: &str) -> ChatMessage {
    ChatMessage { role: role.into(), content: content.into() }
  }

  #[test]
  fn validation() {
    let ok = |p: ModelProfile| validate(p).map(|_| ());
    let load = |l: LoadOptions| ModelProfile { load: l, ..Default::default() };
    let gp = |g: GenParams| ModelProfile { generation: g, ..Default::default() };
    assert!(ok(ModelProfile::default()).is_ok());
    assert!(ok(load(LoadOptions { n_ctx: Some(0), ..Default::default() })).is_ok());
    assert!(ok(load(LoadOptions { n_ctx: Some(100), ..Default::default() })).unwrap_err().contains("nCtx"));
    assert!(ok(load(LoadOptions { n_ctx: Some(2_000_000), ..Default::default() })).is_err());
    assert!(ok(load(LoadOptions { n_gpu_layers: Some(1000), ..Default::default() })).unwrap_err().contains("nGpuLayers"));
    assert!(ok(load(LoadOptions { n_threads: Some(0), ..Default::default() })).is_err());
    assert!(ok(load(LoadOptions { n_batch: Some(16), ..Default::default() })).is_err());
    assert!(ok(gp(GenParams { temperature: Some(f32::NAN), ..Default::default() })).unwrap_err().contains("fini"));
    assert!(ok(gp(GenParams { temperature: Some(11.0), ..Default::default() })).is_err());
    assert!(ok(gp(GenParams { top_p: Some(1.5), ..Default::default() })).is_err());
    assert!(ok(gp(GenParams { min_p: Some(-0.1), ..Default::default() })).is_err());
    assert!(ok(gp(GenParams { top_k: Some(-1), ..Default::default() })).is_err());
    assert!(ok(gp(GenParams { repeat_penalty: Some(0.4), ..Default::default() })).is_err());
    assert!(ok(gp(GenParams { max_tokens: Some(0), ..Default::default() })).is_err());
    let long = "é".repeat(MAX_SYSTEM_PROMPT + 1);
    assert!(ok(gp(GenParams { system_prompt: Some(long), ..Default::default() })).unwrap_err().contains("trop long"));
    // Normalisation.
    let p = validate(gp(GenParams { system_prompt: Some("  \n ".into()), use_profile: Some(false), ..Default::default() })).unwrap();
    assert_eq!(p, ModelProfile::default());
    let p = validate(gp(GenParams { system_prompt: Some(" Sois bref. ".into()), ..Default::default() })).unwrap();
    assert_eq!(p.generation.system_prompt.as_deref(), Some("Sois bref."));
  }

  #[test]
  fn json_camel_case() {
    let p: ModelProfile = serde_json::from_str(
      r#"{"load":{"nCtx":8192,"cacheTypeK":"q8_0"},"gen":{"topP":0.9,"systemPrompt":"x","useProfile":false}}"#,
    )
    .unwrap();
    assert_eq!(p.load.n_ctx, Some(8192));
    assert_eq!(p.load.cache_type_k, Some(CacheType::Q8_0));
    assert_eq!(p.generation.use_profile, Some(false));
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("useProfile") && json.contains("\"nCtx\":8192") && json.contains("\"topP\":0.9"), "{json}");
    assert_eq!(serde_json::to_string(&ModelProfile::default()).unwrap(), r#"{"load":{},"gen":{}}"#);
    let p: ModelProfile = serde_json::from_str("{}").unwrap();
    assert_eq!(p, ModelProfile::default());
  }

  #[test]
  fn stockage() {
    let dir = std::env::temp_dir().join(format!("lucania-profiles-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("model-profiles.json");
    let mut s = ProfileStore::open(path.clone());
    assert_eq!(s.get("a.gguf"), ModelProfile::default());
    let p = ModelProfile { load: LoadOptions { n_ctx: Some(8192), ..Default::default() }, ..Default::default() };
    assert_eq!(s.set("a.gguf", p.clone()).unwrap(), ModelProfile::default());
    assert!(s.set("b.gguf", ModelProfile { generation: GenParams { top_k: Some(-3), ..Default::default() }, ..Default::default() }).is_err());
    // Relu par une nouvelle instance.
    let mut s = ProfileStore::open(path.clone());
    assert_eq!(s.get("a.gguf"), p);
    assert!(!dir.join("model-profiles.json.tmp").exists());
    // Profil vide : entrée supprimée.
    assert_eq!(s.remove("a.gguf").unwrap(), p);
    assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "{}");
    // JSON corrompu : mis de côté, profils vides.
    std::fs::write(&path, b"{pas du json").unwrap();
    let s = ProfileStore::open(path.clone());
    assert_eq!(s.get("a.gguf"), ModelProfile::default());
    assert!(dir.join("model-profiles.json.bak").is_file());
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn fusion_prompt_systeme() {
    let mut m = vec![msg("user", "Salut")];
    apply_system_prompt(&mut m, Some("Réponds en français."));
    assert_eq!(m, vec![msg("system", "Réponds en français."), msg("user", "Salut")]);
    let mut m = vec![msg("system", "Tu es Lucania."), msg("user", "Salut")];
    apply_system_prompt(&mut m, Some("Réponds en français."));
    assert_eq!(m[0], msg("system", "Réponds en français.\n\nTu es Lucania."));
    assert_eq!(m.len(), 2);
    let mut m = vec![msg("user", "Salut")];
    apply_system_prompt(&mut m, Some("  "));
    apply_system_prompt(&mut m, None);
    assert_eq!(m, vec![msg("user", "Salut")]);
  }

  #[test]
  fn fusion_parametres() {
    let profile = GenParams { temperature: Some(0.2), top_k: Some(10), system_prompt: Some("P".into()), ..Default::default() };
    let merged = GenParams { temperature: Some(0.7), ..Default::default() }.or(&profile);
    assert_eq!((merged.temperature, merged.top_k, merged.top_p), (Some(0.7), Some(10), None));
    assert_eq!(merged.system_prompt.as_deref(), Some("P"));
  }
}
