//! Lecture d'un flux `text/event-stream` reçu par morceaux quelconques (un paquet réseau peut
//! couper une ligne, voire un caractère UTF-8, n'importe où).

/// Au-delà, une ligne sans fin est abandonnée (mémoire bornée).
const MAX_PENDING: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
  /// Type (`event:`), « message » par défaut.
  pub event: String,
  /// Lignes `data:` jointes par « \n ».
  pub data: String,
}

#[derive(Default)]
pub struct SseParser {
  buf: Vec<u8>,
  event: Option<String>,
  data: Vec<String>,
  data_len: usize,
}

impl SseParser {
  /// Ajoute un morceau et renvoie les événements complets qu'il termine.
  pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
    self.buf.extend_from_slice(chunk);
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(rel) = self.buf[start..].iter().position(|&b| b == b'\n' || b == b'\r') {
      let end = start + rel;
      let skip = if self.buf[end] == b'\r' {
        match self.buf.get(end + 1) {
          Some(b'\n') => 2,
          Some(_) => 1,
          // « \r » en fin de morceau : attendre la suite (peut-être « \n »).
          None => break,
        }
      } else {
        1
      };
      let line = String::from_utf8_lossy(&self.buf[start..end]).into_owned();
      start = end + skip;
      self.line(&line, &mut out);
    }
    self.buf.drain(..start);
    if self.buf.len() > MAX_PENDING {
      self.buf.clear();
    }
    out
  }

  fn line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
    if line.is_empty() {
      // Fin d'événement : distribué seulement s'il a des données.
      let event = self.event.take();
      if !self.data.is_empty() {
        out.push(SseEvent { event: event.unwrap_or_else(|| "message".into()), data: self.data.join("\n") });
      }
      self.data.clear();
      self.data_len = 0;
      return;
    }
    // Commentaire (dont le maintien de connexion « : »).
    if line.starts_with(':') {
      return;
    }
    let (field, value) = match line.split_once(':') {
      Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
      None => (line, ""),
    };
    match field {
      "event" => self.event = Some(value.to_string()),
      "data" if self.data_len + value.len() <= MAX_PENDING => {
        self.data_len += value.len();
        self.data.push(value.to_string());
      }
      _ => {}
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ev(event: &str, data: &str) -> SseEvent {
    SseEvent { event: event.into(), data: data.into() }
  }

  #[test]
  fn evenements_simples_et_multilignes() {
    let mut p = SseParser::default();
    let out = p.push(b"event: token\ndata: {\"text\":\"a\"}\n\nevent: done\ndata: ligne 1\ndata: ligne 2\n\ndata:sans espace\n\n");
    assert_eq!(out, [ev("token", r#"{"text":"a"}"#), ev("done", "ligne 1\nligne 2"), ev("message", "sans espace")]);
  }

  #[test]
  fn maintien_de_connexion_et_lignes_ignorees() {
    let mut p = SseParser::default();
    // Commentaires, champs inconnus, événement sans données : rien.
    assert!(p.push(b":\n\n: keep-alive\n\nid: 3\nretry: 10\n\nevent: vide\n\n").is_empty());
    // Le type d'un événement vide ne fuit pas sur le suivant.
    assert_eq!(p.push(b"data: x\n\n"), [ev("message", "x")]);
  }

  #[test]
  fn coupures_au_milieu_d_un_paquet() {
    let all = "event: token\r\ndata: {\"text\":\"été\"}\r\n\r\n: ka\n\nevent: done\ndata: fin\n\n".as_bytes();
    // Toutes les coupures possibles en deux morceaux, puis octet par octet.
    for cut in 0..=all.len() {
      let mut p = SseParser::default();
      let mut out = p.push(&all[..cut]);
      out.extend(p.push(&all[cut..]));
      assert_eq!(out, [ev("token", r#"{"text":"été"}"#), ev("done", "fin")], "coupure {cut}");
    }
    let mut p = SseParser::default();
    let out: Vec<SseEvent> = all.iter().flat_map(|b| p.push(&[*b])).collect();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].data, r#"{"text":"été"}"#);
  }

  #[test]
  fn retour_chariot_seul() {
    let mut p = SseParser::default();
    // Le dernier « \r » attend l'octet suivant (« \n » éventuel).
    assert!(p.push(b"data: a\r\r").is_empty());
    // Événement incomplet : rien tant que la ligne vide n'est pas arrivée.
    assert_eq!(p.push(b"data: b\n"), [ev("message", "a")]);
    assert_eq!(p.push(b"\n"), [ev("message", "b")]);
  }
}
