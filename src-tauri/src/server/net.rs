//! Interfaces réseau IPv4 de la machine et validation de l'adresse d'écoute.
//!
//! Noms : `if-addrs` (nom convivial Windows, ex. « Wi-Fi » ou le nom du tunnel). Sous Windows,
//! la description de la carte (« WireGuard Tunnel ») est lue en plus par `GetAdaptersAddresses`
//! (iphlpapi), déclarée à la main comme `GlobalMemoryStatusEx` dans `hardware`.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};

use serde::Serialize;

pub const DEFAULT_PORT: u16 = 4750;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInterface {
  pub name: String,
  pub ip: String,
  pub wireguard: bool,
  pub loopback: bool,
}

/// Nom ou description évoquant WireGuard (« wireguard » ou « wg », sans tenir compte de la casse).
pub fn is_wireguard(name: &str, description: Option<&str>) -> bool {
  [Some(name), description].into_iter().flatten().any(|s| {
    let s = s.to_lowercase();
    s.contains("wireguard") || s.contains("wg")
  })
}

/// WireGuard d'abord, puis les autres cartes, la boucle locale en dernier ; une seule entrée
/// par adresse.
pub fn sort_interfaces(list: &mut Vec<NetInterface>) {
  list.sort_by(|a, b| {
    (!a.wireguard, a.loopback, &a.name, &a.ip).cmp(&(!b.wireguard, b.loopback, &b.name, &b.ip))
  });
  let mut seen = std::collections::HashSet::new();
  list.retain(|i| seen.insert(i.ip.clone()));
}

/// Interfaces IPv4 actives (127.0.0.1 compris, jamais 0.0.0.0).
pub fn list() -> Vec<NetInterface> {
  let descriptions = adapter_descriptions();
  let addrs = match if_addrs::get_if_addrs() {
    Ok(a) => a,
    Err(e) => {
      super::log(&format!("liste des interfaces impossible : {e}"));
      Vec::new()
    }
  };
  let mut out: Vec<NetInterface> = addrs
    .into_iter()
    .filter_map(|i| {
      let if_addrs::IfAddr::V4(v4) = &i.addr else { return None };
      if v4.ip.is_unspecified() {
        return None;
      }
      #[cfg(windows)]
      let description = descriptions.get(&i.adapter_name).map(String::as_str);
      #[cfg(not(windows))]
      let description: Option<&str> = None;
      Some(NetInterface {
        wireguard: is_wireguard(&i.name, description),
        loopback: v4.ip.is_loopback(),
        ip: v4.ip.to_string(),
        name: i.name,
      })
    })
    .collect();
  #[cfg(not(windows))]
  let _ = descriptions;
  sort_interfaces(&mut out);
  out
}

/// Vérifie l'adresse et le port d'écoute demandés.
pub fn validate(bind_ip: &str, port: i64, allow_all: bool, interfaces: &[NetInterface]) -> Result<SocketAddr, String> {
  let port = u16::try_from(port)
    .ok()
    .filter(|p| *p >= 1024)
    .ok_or("Port invalide : choisissez un port entre 1024 et 65535.")?;
  let ip: Ipv4Addr = bind_ip.trim().parse().map_err(|_| format!("Adresse d'écoute invalide : « {} ».", bind_ip.trim()))?;
  if ip.is_unspecified() {
    if !allow_all {
      return Err("Écoute sur toutes les interfaces refusée sans choix explicite.".into());
    }
  } else if !interfaces.iter().any(|i| i.ip == ip.to_string()) {
    return Err(format!("Adresse d'écoute inconnue : aucune interface de cette machine n'a l'adresse {ip}."));
  }
  Ok(SocketAddr::from((ip, port)))
}

// ---------------------------------------------------------------------------------------------
// Descriptions des cartes (Windows)
// ---------------------------------------------------------------------------------------------

#[cfg(windows)]
mod win {
  use std::ffi::c_void;

  /// Début de `IP_ADAPTER_ADDRESSES_LH` (seuls ces champs sont lus ; la mémoire est allouée
  /// par nous, remplie par Windows).
  #[repr(C)]
  pub struct AdapterAddresses {
    pub length: u32,
    pub if_index: u32,
    pub next: *const AdapterAddresses,
    pub adapter_name: *const u8,
    pub first_unicast: *const c_void,
    pub first_anycast: *const c_void,
    pub first_multicast: *const c_void,
    pub first_dns_server: *const c_void,
    pub dns_suffix: *const u16,
    pub description: *const u16,
    pub friendly_name: *const u16,
  }

  #[link(name = "iphlpapi")]
  unsafe extern "system" {
    pub fn GetAdaptersAddresses(family: u32, flags: u32, reserved: *mut c_void, addresses: *mut AdapterAddresses, size: *mut u32) -> u32;
  }
}

/// Description de chaque carte, par identifiant (GUID) ; vide hors Windows ou en cas d'échec.
fn adapter_descriptions() -> HashMap<String, String> {
  #[cfg(windows)]
  {
    const AF_UNSPEC: u32 = 0;
    // GAA_FLAG_SKIP_UNICAST | SKIP_ANYCAST | SKIP_MULTICAST | SKIP_DNS_SERVER
    const FLAGS: u32 = 0x0F;
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    /// Chaîne UTF-16 terminée par 0 (512 caractères au plus).
    fn wide(p: *const u16) -> String {
      if p.is_null() {
        return String::new();
      }
      let mut len = 0;
      // SAFETY : chaîne terminée par 0 fournie par Windows, lecture bornée.
      while len < 512 && unsafe { *p.add(len) } != 0 {
        len += 1;
      }
      // SAFETY : `len` caractères lus ci-dessus.
      String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
    }

    let mut size: u32 = 16 * 1024;
    for _ in 0..3 {
      // Tampon aligné sur 8 octets (u64), comme l'exige la structure.
      let mut buf = vec![0u64; (size as usize).div_ceil(8)];
      let first = buf.as_mut_ptr().cast::<win::AdapterAddresses>();
      // SAFETY : tampon de `size` octets au moins, taille passée par pointeur.
      let r = unsafe { win::GetAdaptersAddresses(AF_UNSPEC, FLAGS, std::ptr::null_mut(), first, &mut size) };
      match r {
        ERROR_SUCCESS => {
          let mut out = HashMap::new();
          let mut cur = first.cast_const();
          while !cur.is_null() {
            // SAFETY : liste chaînée écrite par Windows dans `buf`, vivant jusqu'ici.
            let a = unsafe { &*cur };
            if !a.adapter_name.is_null() {
              // SAFETY : chaîne ANSI terminée par 0.
              let name = unsafe { std::ffi::CStr::from_ptr(a.adapter_name.cast()) }.to_string_lossy().into_owned();
              out.insert(name, wide(a.description));
            }
            cur = a.next;
          }
          return out;
        }
        ERROR_BUFFER_OVERFLOW => continue,
        _ => break,
      }
    }
    HashMap::new()
  }
  #[cfg(not(windows))]
  HashMap::new()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn iface(name: &str, ip: &str, wg: bool) -> NetInterface {
    NetInterface { name: name.into(), ip: ip.into(), wireguard: wg, loopback: ip.starts_with("127.") }
  }

  #[test]
  fn detection_wireguard() {
    assert!(is_wireguard("wg0", None));
    assert!(is_wireguard("Tour", Some("WireGuard Tunnel")));
    assert!(is_wireguard("WG-maison", None));
    assert!(!is_wireguard("Wi-Fi", Some("Intel(R) Wi-Fi 6E AX211")));
    assert!(!is_wireguard("Ethernet", None));
  }

  #[test]
  fn tri_des_interfaces() {
    let mut l = vec![iface("Loopback", "127.0.0.1", false), iface("Wi-Fi", "192.168.1.5", false), iface("wg0", "10.0.0.2", true), iface("doublon", "10.0.0.2", false)];
    sort_interfaces(&mut l);
    let ips: Vec<&str> = l.iter().map(|i| i.ip.as_str()).collect();
    assert_eq!(ips, ["10.0.0.2", "192.168.1.5", "127.0.0.1"]);
    assert!(l[0].wireguard);
  }

  #[test]
  fn validation_ecoute() {
    let l = vec![iface("wg0", "10.0.0.2", true), iface("Loopback", "127.0.0.1", false)];
    assert_eq!(validate("10.0.0.2", 4750, false, &l), Ok(SocketAddr::from(([10, 0, 0, 2], 4750))));
    assert_eq!(validate(" 127.0.0.1 ", 65535, false, &l), Ok(SocketAddr::from(([127, 0, 0, 1], 65535))));
    // Toutes les interfaces : seulement avec le choix explicite.
    assert_eq!(validate("0.0.0.0", 4750, false, &l), Err("Écoute sur toutes les interfaces refusée sans choix explicite.".into()));
    assert_eq!(validate("0.0.0.0", 4750, true, &l), Ok(SocketAddr::from(([0, 0, 0, 0], 4750))));
    // Adresse absente des interfaces, invalide ou IPv6.
    assert!(validate("10.0.0.9", 4750, true, &l).unwrap_err().starts_with("Adresse d'écoute inconnue"));
    assert!(validate("abc", 4750, false, &l).unwrap_err().starts_with("Adresse d'écoute invalide"));
    assert!(validate("::1", 4750, false, &l).is_err());
    // Ports.
    for bad in [0, 80, 1023, 65536, -1] {
      assert!(validate("10.0.0.2", bad, false, &l).unwrap_err().starts_with("Port invalide"), "{bad}");
    }
    assert!(validate("10.0.0.2", 1024, false, &l).is_ok());
  }

  #[test]
  fn interfaces_reelles() {
    let l = list();
    assert!(l.iter().all(|i| i.ip != "0.0.0.0"));
    if cfg!(windows) {
      assert!(l.iter().any(|i| i.loopback && i.ip == "127.0.0.1"));
    }
  }
}
