//! Checking the coordinator's permission slips.
//!
//! A grant says one account may pull one game from one node, up to a byte
//! ceiling, until a deadline. A node verifies it with the coordinator's public
//! key alone — which is the whole reason the server signs with Ed25519 rather
//! than an HMAC. Under a shared secret, a node able to check a grant would also
//! be able to write one, and enrolling a node would mean trusting it with the
//! authority of the coordinator itself.
//!
//! The wire format is the server's: `v2.<base64url payload>.<base64url
//! signature>`, signed over the payload segment exactly as transmitted.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

use crate::error::{MeshError, MeshResult};
use crate::identity::PublicKey;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantClaims {
    pub user_id: String,
    pub game_id: String,
    pub node_id: String,
    pub max_bytes: u64,
    /// Unix seconds.
    pub expires_at: i64,
    pub nonce: String,
}

/// Verify a grant and return what it claims.
///
/// `now` is passed in rather than read from the clock so expiry is testable and
/// so a caller with a better idea of the time than the local clock — a node that
/// just heard from the coordinator, say — can use it.
pub fn verify_grant(
    grant: &str,
    coordinator: &PublicKey,
    now_unix: i64,
) -> MeshResult<GrantClaims> {
    let rest = grant.strip_prefix("v2.").ok_or_else(|| {
        MeshError::Refused("that grant is not in a format this node knows".into())
    })?;

    let (payload, signature) = rest
        .split_once('.')
        .ok_or_else(|| MeshError::Refused("that grant is malformed".into()))?;

    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| MeshError::Refused("that grant's signature is malformed".into()))?;

    // Signature first, always. Parsing an unverified payload means acting on
    // fields an attacker chose, even if only to decide what error to return.
    if !coordinator.verify(payload.as_bytes(), &signature) {
        return Err(MeshError::Refused(
            "that grant was not signed by the coordinator".into(),
        ));
    }

    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| MeshError::Refused("that grant's payload is malformed".into()))?;

    let claims: GrantClaims = serde_json::from_slice(&decoded)
        .map_err(|_| MeshError::Refused("that grant's payload is not readable".into()))?;

    if claims.expires_at <= now_unix {
        return Err(MeshError::Refused("that grant has expired".into()));
    }

    Ok(claims)
}

/// What one grant has spent so far on this node.
///
/// Held per nonce, in memory. Losing the count on restart lets a client get a
/// little more than its ceiling out of one grant, which is a far better failure
/// than a node that has to write to disk on every chunk — and the coordinator's
/// own total is the number that ultimately decides an account's allowance.
#[derive(Debug, Default)]
pub struct GrantLedger {
    entries: std::collections::HashMap<String, LedgerEntry>,
}

#[derive(Debug, Clone, Copy)]
struct LedgerEntry {
    served: u64,
    max: u64,
}

impl GrantLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve `bytes` against a grant, or refuse if that would exceed it.
    ///
    /// Reserved before the bytes are sent rather than counted after. Counting
    /// after would let any number of concurrent streams each check a ceiling
    /// none of them had yet spent, and a client opening sixteen connections is
    /// the normal case here, not an attack.
    pub fn reserve(&mut self, claims: &GrantClaims, bytes: u64) -> MeshResult<()> {
        let entry = self
            .entries
            .entry(claims.nonce.clone())
            .or_insert(LedgerEntry {
                served: 0,
                max: claims.max_bytes,
            });

        if entry.served.saturating_add(bytes) > entry.max {
            return Err(MeshError::GrantExhausted);
        }

        entry.served += bytes;
        Ok(())
    }

    /// Give back a reservation whose bytes never made it out.
    pub fn release(&mut self, nonce: &str, bytes: u64) {
        if let Some(entry) = self.entries.get_mut(nonce) {
            entry.served = entry.served.saturating_sub(bytes);
        }
    }

    pub fn served(&self, nonce: &str) -> u64 {
        self.entries.get(nonce).map_or(0, |entry| entry.served)
    }

    /// Every grant with bytes to report, for the next report to the coordinator.
    pub fn pending_reports(&self) -> Vec<(String, u64)> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.served > 0)
            .map(|(nonce, entry)| (nonce.clone(), entry.served))
            .collect()
    }

    /// Drop grants that can no longer be used, so the map does not grow forever.
    pub fn forget_expired(&mut self, live_nonces: &[String]) {
        self.entries.retain(|nonce, _| live_nonces.contains(nonce));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::NodeIdentity;

    /// Build a grant the way the server does, so these test the real format.
    fn issue(signer: &NodeIdentity, claims: &GrantClaims) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signature = URL_SAFE_NO_PAD.encode(signer.sign(payload.as_bytes()));
        format!("v2.{payload}.{signature}")
    }

    fn claims() -> GrantClaims {
        GrantClaims {
            user_id: "usr_1".into(),
            game_id: "gam_1".into(),
            node_id: "nod_1".into(),
            max_bytes: 1_000,
            expires_at: 2_000,
            nonce: "n1".into(),
        }
    }

    #[test]
    fn a_grant_signed_by_the_coordinator_verifies() {
        let coordinator = NodeIdentity::generate();
        let grant = issue(&coordinator, &claims());

        let verified = verify_grant(&grant, &coordinator.public_key(), 1_000).unwrap();
        assert_eq!(verified.user_id, "usr_1");
        assert_eq!(verified.max_bytes, 1_000);
    }

    #[test]
    fn a_grant_signed_by_anyone_else_does_not() {
        // This is the property that makes enrolling a node safe. A node holds
        // only the public key, so it cannot mint what it can check.
        let coordinator = NodeIdentity::generate();
        let impostor = NodeIdentity::generate();
        let grant = issue(&impostor, &claims());

        assert!(verify_grant(&grant, &coordinator.public_key(), 1_000).is_err());
    }

    #[test]
    fn a_grant_with_a_raised_ceiling_is_refused() {
        let coordinator = NodeIdentity::generate();
        let grant = issue(&coordinator, &claims());

        // Swap the payload for one claiming a bigger allowance, keeping the
        // signature. This is the obvious attack and it has to fail.
        let mut greedy = claims();
        greedy.max_bytes = u64::MAX;
        let forged_payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&greedy).unwrap());
        let signature = grant.rsplit('.').next().unwrap();

        let forged = format!("v2.{forged_payload}.{signature}");
        assert!(verify_grant(&forged, &coordinator.public_key(), 1_000).is_err());
    }

    #[test]
    fn an_expired_grant_is_refused() {
        let coordinator = NodeIdentity::generate();
        let grant = issue(&coordinator, &claims());

        assert!(verify_grant(&grant, &coordinator.public_key(), 2_001).is_err());
    }

    #[test]
    fn a_grant_in_an_unknown_format_is_refused_not_guessed_at() {
        let coordinator = NodeIdentity::generate();

        for bad in ["", "v2.", "v2.only-one-part", "no-prefix.a.b", "v2.a.b"] {
            assert!(verify_grant(bad, &coordinator.public_key(), 0).is_err());
        }
    }

    #[test]
    fn the_ledger_refuses_the_chunk_that_would_cross_the_ceiling() {
        let mut ledger = GrantLedger::new();
        let claims = claims();

        assert!(ledger.reserve(&claims, 600).is_ok());
        assert!(ledger.reserve(&claims, 400).is_ok());
        // 1000 of 1000 spent; the next byte is one too many.
        assert!(matches!(
            ledger.reserve(&claims, 1),
            Err(MeshError::GrantExhausted)
        ));
        assert_eq!(ledger.served("n1"), 1_000);
    }

    #[test]
    fn a_refused_reservation_does_not_consume_the_allowance() {
        // Otherwise a client that asked for too much once would find its
        // remaining allowance quietly reduced by the amount it was denied.
        let mut ledger = GrantLedger::new();
        let claims = claims();

        assert!(ledger.reserve(&claims, 999).is_ok());
        assert!(ledger.reserve(&claims, 500).is_err());
        assert_eq!(ledger.served("n1"), 999);
        assert!(ledger.reserve(&claims, 1).is_ok());
    }

    #[test]
    fn releasing_returns_bytes_that_never_left() {
        let mut ledger = GrantLedger::new();
        let claims = claims();

        ledger.reserve(&claims, 800).unwrap();
        ledger.release("n1", 800);

        assert_eq!(ledger.served("n1"), 0);
        assert!(ledger.reserve(&claims, 1_000).is_ok());
    }

    #[test]
    fn reservations_are_counted_before_sending_so_concurrent_streams_cannot_overspend() {
        // Sixteen streams each checking a ceiling nobody had spent yet is the
        // normal shape of a download here, not an attack.
        let mut ledger = GrantLedger::new();
        let claims = claims();

        let mut granted = 0;
        for _ in 0..16 {
            if ledger.reserve(&claims, 100).is_ok() {
                granted += 1;
            }
        }

        assert_eq!(granted, 10);
        assert_eq!(ledger.served("n1"), 1_000);
    }

    #[test]
    fn expired_grants_are_forgotten_so_the_ledger_does_not_grow_forever() {
        let mut ledger = GrantLedger::new();
        let mut second = claims();
        second.nonce = "n2".into();

        ledger.reserve(&claims(), 10).unwrap();
        ledger.reserve(&second, 20).unwrap();

        ledger.forget_expired(&["n2".to_string()]);

        assert_eq!(ledger.served("n1"), 0);
        assert_eq!(ledger.served("n2"), 20);
    }

    #[test]
    fn pending_reports_lists_only_grants_that_moved_bytes() {
        let mut ledger = GrantLedger::new();
        ledger.reserve(&claims(), 42).unwrap();

        let reports = ledger.pending_reports();
        assert_eq!(reports, vec![("n1".to_string(), 42)]);
    }
}
