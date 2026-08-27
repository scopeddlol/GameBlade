//! Who a node is, and how anyone proves it.
//!
//! A node's identity is an Ed25519 keypair it generates once and keeps. Not its
//! address — a machine on a home connection gets a new one whenever the lease
//! renews, and an identity that changed with it would be no identity at all.
//!
//! The same key does double duty. It names the node to the coordinator, and it
//! is what a client checks the TLS certificate against when it connects: the
//! node presents a self-signed certificate carrying the key, so "I reached the
//! machine the coordinator told me about" is a local check rather than a
//! question for a certificate authority.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;

use crate::error::{MeshError, MeshResult};

/// A node's long-lived keypair.
#[derive(Clone)]
pub struct NodeIdentity {
    signing: SigningKey,
}

impl NodeIdentity {
    pub fn generate() -> Self {
        Self {
            signing: SigningKey::generate(&mut OsRng),
        }
    }

    /// Restore an identity from the 32 secret bytes stored on disk.
    pub fn from_secret_bytes(bytes: &[u8]) -> MeshResult<Self> {
        let array: [u8; 32] = bytes
            .try_into()
            .map_err(|_| MeshError::Identity("a node secret key is exactly 32 bytes".into()))?;
        Ok(Self {
            signing: SigningKey::from_bytes(&array),
        })
    }

    /// The bytes to persist. Everything else is derived from these.
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey(self.signing.verifying_key())
    }

    /// Base64url, which is how the key travels over the API.
    pub fn public_key_base64(&self) -> String {
        self.public_key().to_base64()
    }

    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.signing.sign(message).to_bytes().to_vec()
    }
}

/// The public half — what a client is told to expect, and what it checks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PublicKey(VerifyingKey);

impl PublicKey {
    pub fn from_base64(encoded: &str) -> MeshResult<Self> {
        let raw = URL_SAFE_NO_PAD
            .decode(encoded.trim())
            .map_err(|_| MeshError::Identity("a public key must be base64url".into()))?;
        Self::from_bytes(&raw)
    }

    pub fn from_bytes(bytes: &[u8]) -> MeshResult<Self> {
        let array: [u8; 32] = bytes
            .try_into()
            .map_err(|_| MeshError::Identity("a public key is exactly 32 bytes".into()))?;
        VerifyingKey::from_bytes(&array)
            .map(Self)
            .map_err(|_| MeshError::Identity("that is not a valid Ed25519 public key".into()))
    }

    pub fn to_base64(self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.to_bytes())
    }

    pub fn as_bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn verify(&self, message: &[u8], signature: &[u8]) -> bool {
        let Ok(bytes) = <[u8; 64]>::try_from(signature) else {
            return false;
        };
        self.0
            .verify(message, &Signature::from_bytes(&bytes))
            .is_ok()
    }
}

/// The coordinator's key, in the SPKI form Node's `crypto` exports.
///
/// The server publishes `spki` DER because it carries the algorithm identifier,
/// so a verifier is not required to be told out of band that this is Ed25519.
/// Ed25519 SPKI is a fixed 44 bytes ending in the 32 raw key bytes, so the
/// prefix is checked rather than a full DER parser being pulled in for one
/// known shape.
pub fn coordinator_key_from_spki(encoded: &str) -> MeshResult<PublicKey> {
    const ED25519_SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];

    let raw = URL_SAFE_NO_PAD
        .decode(encoded.trim())
        .map_err(|_| MeshError::Identity("the coordinator key must be base64url".into()))?;

    if raw.len() != 44 || raw[..12] != ED25519_SPKI_PREFIX {
        return Err(MeshError::Identity(
            "the coordinator key is not an Ed25519 SPKI key".into(),
        ));
    }

    PublicKey::from_bytes(&raw[12..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identity_survives_a_round_trip_through_its_secret_bytes() {
        // A node that could not reload its own key would enrol again on every
        // restart, and every restart would strand a registration.
        let original = NodeIdentity::generate();
        let restored = NodeIdentity::from_secret_bytes(&original.secret_bytes()).unwrap();

        assert_eq!(original.public_key(), restored.public_key());
    }

    #[test]
    fn a_public_key_survives_a_round_trip_through_base64() {
        let identity = NodeIdentity::generate();
        let encoded = identity.public_key_base64();

        assert_eq!(
            PublicKey::from_base64(&encoded).unwrap(),
            identity.public_key()
        );
    }

    #[test]
    fn a_signature_verifies_under_the_matching_key_and_no_other() {
        let node = NodeIdentity::generate();
        let impostor = NodeIdentity::generate();
        let signature = node.sign(b"chunk request");

        assert!(node.public_key().verify(b"chunk request", &signature));
        assert!(!impostor.public_key().verify(b"chunk request", &signature));
    }

    #[test]
    fn a_signature_over_different_bytes_does_not_verify() {
        let node = NodeIdentity::generate();
        let signature = node.sign(b"chunk 1");

        assert!(!node.public_key().verify(b"chunk 2", &signature));
    }

    #[test]
    fn a_malformed_signature_is_rejected_rather_than_panicking() {
        // Signatures arrive over the wire from whoever is talking to us.
        let node = NodeIdentity::generate();

        assert!(!node.public_key().verify(b"anything", &[]));
        assert!(!node.public_key().verify(b"anything", &[0u8; 12]));
    }

    #[test]
    fn a_key_of_the_wrong_length_is_refused() {
        assert!(PublicKey::from_bytes(&[0u8; 31]).is_err());
        assert!(PublicKey::from_bytes(&[0u8; 33]).is_err());
    }

    #[test]
    fn a_coordinator_key_that_is_not_spki_is_refused() {
        // A raw 32-byte key encoded as if it were SPKI would otherwise be read
        // as one, and the bytes it verified against would be nonsense.
        let identity = NodeIdentity::generate();
        let raw = URL_SAFE_NO_PAD.encode(identity.public_key().as_bytes());

        assert!(coordinator_key_from_spki(&raw).is_err());
    }
}
