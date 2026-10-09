fn main() {
  // Commandes de l'app appelables depuis les pages distantes : chacune génère une permission
  // `allow-<nom>` à déclarer dans capabilities/default.json.
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .app_manifest(tauri_build::AppManifest::new().commands(&["uninstall_app"])),
  )
  .unwrap()
}
