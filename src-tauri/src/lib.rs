use tauri::Manager;

#[cfg(not(debug_assertions))]
mod sidecar {
  use std::net::{SocketAddr, TcpStream};
  use std::path::PathBuf;
  use std::process::{Child, Command};
  use std::sync::Mutex;
  use std::time::{Duration, Instant};
  use tauri::{AppHandle, Manager};

  pub const PORT: u16 = 4749;

  #[derive(Default)]
  pub struct NodeProcess(pub Mutex<Option<Child>>);

  /// Retire le préfixe verbatim (backslash x2, point d'interrogation, backslash) que Windows
  /// ajoute aux chemins de ressources et que node ne sait pas résoudre.
  fn clean(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
      Some(rest) => PathBuf::from(rest),
      None => p,
    }
  }

  fn spawn_node(app: &AppHandle) -> Result<Child, String> {
    let exe_dir = std::env::current_exe()
      .map_err(|e| e.to_string())?
      .parent()
      .ok_or("répertoire de l'exécutable introuvable")?
      .to_path_buf();
    let node = exe_dir.join("node.exe");
    if !node.exists() {
      return Err(format!("node.exe introuvable : {}", node.display()));
    }
    let res = clean(app.path().resource_dir().map_err(|e| e.to_string())?);
    let entry = res.join("app").join("server").join("entry.mjs");
    if !entry.exists() {
      return Err(format!("serveur introuvable : {}", entry.display()));
    }
    let app_dir = clean(app.path().app_data_dir().map_err(|e| e.to_string())?);
    let data_dir = app_dir.join("data");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(node);
    cmd
      .arg(entry)
      .env("PORT", PORT.to_string())
      .env("HOST", "127.0.0.1")
      .env("LUCANIA_DESKTOP", "1")
      .env("LUCANIA_DATA_DIR", &data_dir)
      .env("LUCANIA_VERSION", app.package_info().version.to_string())
      .current_dir(app_dir);
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| format!("lancement de node impossible : {e}"))
  }

  fn show_error(app: &AppHandle, msg: &str) {
    if let Some(w) = app.get_webview_window("main") {
      let js = format!(
        "var m=document.getElementById('msg');if(m){{m.className='error';m.textContent={};}}",
        serde_json::to_string(msg).unwrap_or_else(|_| "\"Erreur\"".into())
      );
      let _ = w.eval(&js);
    }
  }

  pub fn start(app: &AppHandle) {
    let child = match spawn_node(app) {
      Ok(c) => c,
      Err(e) => {
        show_error(app, &format!("Impossible de démarrer Lucania : {e}"));
        return;
      }
    };
    *app.state::<NodeProcess>().0.lock().unwrap() = Some(child);

    let handle = app.clone();
    std::thread::spawn(move || {
      let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
      let deadline = Instant::now() + Duration::from_secs(30);
      loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
          break;
        }
        // Le processus a-t-il planté ?
        if let Some(c) = handle.state::<NodeProcess>().0.lock().unwrap().as_mut() {
          if let Ok(Some(status)) = c.try_wait() {
            show_error(&handle, &format!("Le serveur s'est arrêté au démarrage ({status})."));
            return;
          }
        }
        if Instant::now() >= deadline {
          show_error(&handle, "Le serveur Lucania ne répond pas (délai de 30 s dépassé).");
          return;
        }
        std::thread::sleep(Duration::from_millis(250));
      }
      match (handle.get_webview_window("main"), format!("http://127.0.0.1:{PORT}").parse()) {
        (Some(w), Ok(url)) => {
          if let Err(e) = w.navigate(url) {
            show_error(&handle, &format!("Navigation impossible : {e}"));
          }
        }
        _ => show_error(&handle, "Fenêtre principale introuvable."),
      }
    });
  }

  pub fn kill(app: &AppHandle) {
    if let Some(mut c) = app.state::<NodeProcess>().0.lock().unwrap().take() {
      let _ = c.kill();
      let _ = c.wait();
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // Instance unique : doit être le PREMIER plugin enregistré. Une 2e instance transmet ses
  // arguments à la première puis se termine avant setup (aucun sidecar node n'est lancé).
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
    if let Some(w) = app.get_webview_window("main") {
      let _ = w.unminimize();
      let _ = w.show();
      let _ = w.set_focus();
    }
  }));

  let builder = builder
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      // Dossier de travail de l'utilisateur : Documents\Lucania
      if let Ok(docs) = app.path().document_dir() {
        let _ = std::fs::create_dir_all(docs.join("Lucania"));
      }

      #[cfg(debug_assertions)]
      if let Some(w) = app.get_webview_window("main") {
        w.open_devtools();
      }

      #[cfg(not(debug_assertions))]
      {
        app.manage(sidecar::NodeProcess::default());
        sidecar::start(app.handle());
      }
      Ok(())
    });

  builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app, _event| {
      #[cfg(not(debug_assertions))]
      if let tauri::RunEvent::Exit = _event {
        sidecar::kill(_app);
      }
    });
}
