//! Découpage UTF-8 des jetons : un caractère peut être réparti sur plusieurs jetons. On garde
//! les octets incomplets en attente et on n'émet que des morceaux UTF-8 valides.

#[derive(Debug, Default)]
pub struct Utf8Stream {
  pending: Vec<u8>,
}

impl Utf8Stream {
  /// Ajoute les octets d'un jeton et renvoie le texte complet disponible (éventuellement vide).
  /// Une séquence réellement invalide (pas seulement incomplète) devient U+FFFD.
  pub fn push(&mut self, bytes: &[u8]) -> String {
    self.pending.extend_from_slice(bytes);
    let mut out = String::new();
    loop {
      match std::str::from_utf8(&self.pending) {
        Ok(s) => {
          out.push_str(s);
          self.pending.clear();
          return out;
        }
        Err(e) => {
          let valid = e.valid_up_to();
          // `valid_up_to` délimite un préfixe UTF-8 valide : la conversion réussit toujours.
          if let Ok(s) = std::str::from_utf8(&self.pending[..valid]) {
            out.push_str(s);
          }
          match e.error_len() {
            // Séquence incomplète en fin de tampon : on attend le jeton suivant.
            None => {
              self.pending.drain(..valid);
              return out;
            }
            // Octets invalides : remplacés, puis on continue avec la suite.
            Some(bad) => {
              out.push(char::REPLACEMENT_CHARACTER);
              self.pending.drain(..valid + bad);
            }
          }
        }
      }
    }
  }

  /// Vide le tampon en fin de génération (octets restants remplacés s'ils sont incomplets).
  pub fn finish(&mut self) -> String {
    let rest = String::from_utf8_lossy(&self.pending).into_owned();
    self.pending.clear();
    rest
  }
}

#[cfg(test)]
mod tests {
  use super::Utf8Stream;

  #[test]
  fn ascii_direct() {
    let mut s = Utf8Stream::default();
    assert_eq!(s.push(b"Bonjour"), "Bonjour");
    assert_eq!(s.finish(), "");
  }

  #[test]
  fn caractere_coupe_en_deux() {
    let e = "é".as_bytes();
    let mut s = Utf8Stream::default();
    assert_eq!(s.push(&e[..1]), "");
    assert_eq!(s.push(&e[1..]), "é");
  }

  #[test]
  fn emoji_sur_trois_jetons() {
    let b = "a🐺b".as_bytes();
    let mut s = Utf8Stream::default();
    assert_eq!(s.push(&b[..2]), "a");
    assert_eq!(s.push(&b[2..4]), "");
    assert_eq!(s.push(&b[4..]), "🐺b");
  }

  #[test]
  fn octet_invalide_remplace() {
    let mut s = Utf8Stream::default();
    assert_eq!(s.push(&[b'x', 0xFF, b'y']), "x\u{FFFD}y");
  }

  #[test]
  fn reste_incomplet_en_fin() {
    let mut s = Utf8Stream::default();
    assert_eq!(s.push(&[b'z', 0xE2, 0x82]), "z");
    assert_eq!(s.finish(), "\u{FFFD}");
  }
}
