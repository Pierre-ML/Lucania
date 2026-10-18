//! Bus d'événements interne (moteur et téléchargements), en plus de l'émission Tauri vers les
//! pages. Le serveur de la tour s'y abonne pour ses flux `/generate` et `/events`.

use std::sync::OnceLock;

use tokio::sync::broadcast;

use crate::engine::{EngineStatus, TokenEvent};
use crate::hf::DownloadInfo;

/// Capacité du tampon : un abonné trop lent perd les plus anciens événements (`Lagged`).
const CAPACITY: usize = 4096;

#[derive(Debug, Clone)]
pub enum BusEvent {
  Token(TokenEvent),
  Status(EngineStatus),
  Download(DownloadInfo),
  Removed(String),
}

fn sender() -> &'static broadcast::Sender<BusEvent> {
  static BUS: OnceLock<broadcast::Sender<BusEvent>> = OnceLock::new();
  BUS.get_or_init(|| broadcast::channel(CAPACITY).0)
}

/// Vrai si quelqu'un écoute (évite de copier chaque jeton pour rien).
pub fn has_subscribers() -> bool {
  sender().receiver_count() > 0
}

/// Publie un événement ; sans abonné, il est simplement perdu.
pub fn publish(ev: BusEvent) {
  let _ = sender().send(ev);
}

pub fn subscribe() -> broadcast::Receiver<BusEvent> {
  sender().subscribe()
}
