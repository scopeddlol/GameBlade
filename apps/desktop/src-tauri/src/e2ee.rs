//! End-to-end encryption for messages between players.
//!
//! # What the server is trusted with, and what it is not
//!
//! The server routes and stores; it never reads. Every message body and every
//! attachment reaches it already sealed, and the key that would open them is
//! never sent in a form the server can use. What it *is* trusted with is the
//! membership list and the public keys — which means it could, in principle,
//! hand out a key of its own and read what follows. That is the standard
//! limitation of key distribution without out-of-band verification, and it is
//! stated here rather than glossed over: this protects a conversation from
//! anyone who reads the database, takes a backup, or intercepts the traffic,
//! and it does not protect it from an operator who has replaced the server
//! binary. Fingerprints are exposed so two people can check by hand.
//!
//! # The shape of it
//!
//! Each device has a long-lived X25519 identity key, generated on first use and
//! kept in the OS credential store beside the device token — never on disk in
//! the clear, and never sent anywhere.
//!
//! A conversation has one symmetric key, made by whoever starts it. For each
//! member it is *wrapped*: an ephemeral X25519 keypair, ECDH against that
//! member's identity key, HKDF-SHA256 over the shared secret, and
//! XChaCha20-Poly1305 around the conversation key. The server stores one
//! wrapped blob per member and can open none of them.
//!
//! Messages and attachments are then XChaCha20-Poly1305 under the conversation
//! key with a fresh random nonce each time. XChaCha rather than ChaCha or
//! AES-GCM specifically for the 192-bit nonce: one key covers a whole
//! conversation's history, and at that many messages a random 96-bit nonce is
//! no longer comfortably collision-free.
//!
//! # What this deliberately is not
//!
//! There is no ratchet, so there is no forward secrecy: someone who obtains a
//! conversation key can read that conversation's past as well as its future.
//! Adding a ratchet means per-device sessions, out-of-order handling and key
//! agreement over a store-and-forward transport — a different and much larger
//! piece of work. The honest summary is at the top of the Messages tab rather
//! than only in this comment, because a security promise nobody reads is worth
//! nothing.

use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

const SERVICE: &str = "GameBlade";
const ACCOUNT: &str = "message-identity";

/// Domain separation for the wrapping KDF.
///
/// Without it, the same ECDH secret could be repurposed by any other protocol
/// that ever agreed a key between the same two identities. It costs nothing and
/// closes off a whole class of cross-protocol mistake.
const WRAP_INFO: &[u8] = b"gameblade/conversation-key/v1";

/// Bound into every sealed payload as associated data, so a ciphertext cannot
/// be replayed into a context it was not written for.
const MESSAGE_AAD: &[u8] = b"gameblade/message/v1";
const ATTACHMENT_AAD: &[u8] = b"gameblade/attachment/v1";

/// This device's identity, as the rest of the app sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    /// The X25519 public key, base64. Published; safe to show anybody.
    pub public_key: String,
    /// A short, human-comparable digest of the public key.
    ///
    /// The whole point of the exercise: two people reading the same eight
    /// groups aloud have verified that no server sat in the middle swapping
    /// keys. Nothing else in this design can establish that.
    pub fingerprint: String,
}

/// One conversation key, sealed for one recipient.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedKey {
    /// The one-time public key this wrap was made with, base64.
    pub ephemeral_public: String,
    pub nonce: String,
    pub ciphertext: String,
}

/// A sealed message body or attachment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sealed {
    pub nonce: String,
    pub ciphertext: String,
}

fn decode(label: &str, value: &str) -> AppResult<Vec<u8>> {
    BASE64
        .decode(value)
        .map_err(|_| AppError::Other(format!("The {label} is not valid base64")))
}

fn public_key_from(value: &str) -> AppResult<PublicKey> {
    let raw = decode("public key", value)?;
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| AppError::Other("A public key was the wrong length".to_string()))?;
    Ok(PublicKey::from(bytes))
}

/// A cipher from raw key bytes, with the length checked rather than assumed.
fn cipher(key: &[u8]) -> AppResult<XChaCha20Poly1305> {
    let bytes: [u8; 32] = key
        .try_into()
        .map_err(|_| AppError::Other("A key was the wrong length".to_string()))?;
    Ok(XChaCha20Poly1305::new(&bytes.into()))
}

fn random_nonce() -> [u8; 24] {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

/// Eight groups of four hex characters, for reading aloud.
///
/// Grouped and truncated on purpose: 128 bits is far past what anybody will
/// compare by voice, and an unbroken 64-character string is one people skim
/// rather than check.
fn fingerprint_of(public_key: &[u8]) -> String {
    let digest = Sha256::digest(public_key);
    hex::encode(&digest[..16])
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Loads this device's identity, generating one the first time.
///
/// In the OS credential store rather than a file: it is the single secret that
/// makes every message readable, and a file next to the executable is one
/// backup away from being somewhere else.
pub fn identity() -> AppResult<(StaticSecret, Identity)> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;

    let secret = match entry.get_password() {
        Ok(stored) => {
            let raw = decode("stored identity", &stored)?;
            let bytes: [u8; 32] = raw.try_into().map_err(|_| {
                AppError::Other("The stored message identity is corrupt".to_string())
            })?;
            StaticSecret::from(bytes)
        }
        Err(keyring::Error::NoEntry) => {
            let secret = StaticSecret::random_from_rng(OsRng);
            entry.set_password(&BASE64.encode(secret.to_bytes()))?;
            secret
        }
        Err(err) => return Err(AppError::Keyring(err.to_string())),
    };

    let public = PublicKey::from(&secret);
    let identity = Identity {
        public_key: BASE64.encode(public.as_bytes()),
        fingerprint: fingerprint_of(public.as_bytes()),
    };
    Ok((secret, identity))
}

/// Forgets this device's identity.
///
/// Signing out is the one time this is right: the key is what makes the
/// account's messages readable on this machine, and leaving it behind on a
/// shared PC would be the whole point of the exercise thrown away. Every
/// conversation is re-keyed for the device that signs in next.
pub fn forget_identity() -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(AppError::Keyring(err.to_string())),
    }
}

/// The fingerprint of somebody else's published key, for comparing by hand.
pub fn fingerprint(public_key: &str) -> AppResult<String> {
    let raw = decode("public key", public_key)?;
    Ok(fingerprint_of(&raw))
}

/// A fresh conversation key. Never leaves this machine unwrapped.
pub fn new_conversation_key() -> String {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    BASE64.encode(key)
}

/// Seals a conversation key for one recipient's device.
pub fn wrap_key(conversation_key: &str, recipient_public: &str) -> AppResult<WrappedKey> {
    let key = decode("conversation key", conversation_key)?;
    let recipient = public_key_from(recipient_public)?;

    // A one-time keypair per wrap. Reusing the sender's identity key here would
    // make every wrap for the same recipient derive the same secret, so two
    // wraps could be told apart only by their nonce.
    let ephemeral = StaticSecret::random_from_rng(OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral);
    let shared = ephemeral.diffie_hellman(&recipient);

    let wrapping = derive(shared.as_bytes())?;
    let nonce = random_nonce();
    let ciphertext = cipher(&wrapping)?
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &key,
                aad: WRAP_INFO,
            },
        )
        .map_err(|_| AppError::Other("Could not seal the conversation key".to_string()))?;

    Ok(WrappedKey {
        ephemeral_public: BASE64.encode(ephemeral_public.as_bytes()),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

/// Opens a conversation key that was sealed for this device.
pub fn unwrap_key(secret: &StaticSecret, wrapped: &WrappedKey) -> AppResult<String> {
    let ephemeral = public_key_from(&wrapped.ephemeral_public)?;
    let shared = secret.diffie_hellman(&ephemeral);
    let wrapping = derive(shared.as_bytes())?;

    let nonce = decode("nonce", &wrapped.nonce)?;
    let ciphertext = decode("ciphertext", &wrapped.ciphertext)?;

    let key = cipher(&wrapping)?
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: WRAP_INFO,
            },
        )
        // Deliberately one message for every failure. Distinguishing "wrong
        // key" from "tampered ciphertext" tells an attacker which of the two
        // they achieved.
        .map_err(|_| AppError::Other("This conversation key is not for this device".to_string()))?;

    Ok(BASE64.encode(key))
}

/// HKDF-SHA256 over a raw ECDH secret.
///
/// The output of X25519 is not uniformly distributed and is not a key. Using it
/// as one directly is the classic mistake this step exists to prevent.
fn derive(shared: &[u8]) -> AppResult<Vec<u8>> {
    let hkdf = Hkdf::<Sha256>::new(None, shared);
    let mut key = vec![0u8; 32];
    hkdf.expand(WRAP_INFO, &mut key)
        .map_err(|_| AppError::Other("Could not derive a key".to_string()))?;
    Ok(key)
}

/// Seals bytes under a conversation key.
pub fn seal(conversation_key: &str, plaintext: &[u8], aad: &[u8]) -> AppResult<Sealed> {
    let key = decode("conversation key", conversation_key)?;
    let nonce = random_nonce();
    let ciphertext = cipher(&key)?
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| AppError::Other("Could not encrypt that".to_string()))?;

    Ok(Sealed {
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

/// Opens bytes sealed under a conversation key.
pub fn open(conversation_key: &str, sealed: &Sealed, aad: &[u8]) -> AppResult<Vec<u8>> {
    let key = decode("conversation key", conversation_key)?;
    let nonce = decode("nonce", &sealed.nonce)?;
    let ciphertext = decode("ciphertext", &sealed.ciphertext)?;

    cipher(&key)?
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| AppError::Other("Could not read that message".to_string()))
}

pub fn seal_message(conversation_key: &str, plaintext: &str) -> AppResult<Sealed> {
    seal(conversation_key, plaintext.as_bytes(), MESSAGE_AAD)
}

pub fn open_message(conversation_key: &str, sealed: &Sealed) -> AppResult<String> {
    let bytes = open(conversation_key, sealed, MESSAGE_AAD)?;
    String::from_utf8(bytes)
        .map_err(|_| AppError::Other("That message is not readable text".to_string()))
}

pub fn seal_attachment(conversation_key: &str, bytes: &[u8]) -> AppResult<Sealed> {
    seal(conversation_key, bytes, ATTACHMENT_AAD)
}

pub fn open_attachment(conversation_key: &str, sealed: &Sealed) -> AppResult<Vec<u8>> {
    open(conversation_key, sealed, ATTACHMENT_AAD)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keypair() -> (StaticSecret, String) {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = BASE64.encode(PublicKey::from(&secret).as_bytes());
        (secret, public)
    }

    #[test]
    fn a_wrapped_key_opens_for_its_recipient() {
        let (secret, public) = keypair();
        let key = new_conversation_key();

        let wrapped = wrap_key(&key, &public).unwrap();

        assert_eq!(unwrap_key(&secret, &wrapped).unwrap(), key);
    }

    /// The whole promise: somebody else's device cannot open it, whatever the
    /// server hands them.
    #[test]
    fn a_wrapped_key_stays_shut_for_anybody_else() {
        let (_, alice_public) = keypair();
        let (mallory_secret, _) = keypair();
        let key = new_conversation_key();

        let wrapped = wrap_key(&key, &alice_public).unwrap();

        assert!(unwrap_key(&mallory_secret, &wrapped).is_err());
    }

    #[test]
    fn each_wrap_of_the_same_key_looks_different() {
        let (_, public) = keypair();
        let key = new_conversation_key();

        let first = wrap_key(&key, &public).unwrap();
        let second = wrap_key(&key, &public).unwrap();

        // A fresh ephemeral key per wrap, so two wraps of one key for one
        // recipient share nothing an observer could correlate.
        assert_ne!(first.ephemeral_public, second.ephemeral_public);
        assert_ne!(first.ciphertext, second.ciphertext);
    }

    #[test]
    fn a_message_survives_a_round_trip() {
        let key = new_conversation_key();
        let sealed = seal_message(&key, "meet me at the bonfire").unwrap();

        assert_eq!(
            open_message(&key, &sealed).unwrap(),
            "meet me at the bonfire"
        );
    }

    #[test]
    fn the_ciphertext_does_not_contain_the_message() {
        let key = new_conversation_key();
        let sealed = seal_message(&key, "meet me at the bonfire").unwrap();

        let raw = BASE64.decode(&sealed.ciphertext).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("bonfire"));
    }

    #[test]
    fn the_same_text_twice_produces_different_ciphertext() {
        let key = new_conversation_key();

        let first = seal_message(&key, "hello").unwrap();
        let second = seal_message(&key, "hello").unwrap();

        // A fresh nonce each time, so identical messages are not identifiable
        // as identical from the stored rows alone.
        assert_ne!(first.nonce, second.nonce);
        assert_ne!(first.ciphertext, second.ciphertext);
    }

    #[test]
    fn a_message_will_not_open_under_the_wrong_key() {
        let sealed = seal_message(&new_conversation_key(), "hello").unwrap();
        assert!(open_message(&new_conversation_key(), &sealed).is_err());
    }

    /// Poly1305 is what makes this authenticated rather than merely encrypted:
    /// a server that edits a stored row produces a message that will not open,
    /// instead of one that opens as something else.
    #[test]
    fn a_tampered_ciphertext_is_refused_rather_than_returning_rubbish() {
        let key = new_conversation_key();
        let sealed = seal_message(&key, "transfer 10 gold").unwrap();

        let mut raw = BASE64.decode(&sealed.ciphertext).unwrap();
        raw[0] ^= 0x01;
        let tampered = Sealed {
            nonce: sealed.nonce,
            ciphertext: BASE64.encode(raw),
        };

        assert!(open_message(&key, &tampered).is_err());
    }

    /// The associated data is what stops a sealed attachment being served back
    /// as a message body, or the reverse.
    #[test]
    fn a_sealed_attachment_will_not_open_as_a_message() {
        let key = new_conversation_key();
        let sealed = seal_attachment(&key, b"\x89PNG\r\n").unwrap();

        assert!(open_message(&key, &sealed).is_err());
        assert_eq!(open_attachment(&key, &sealed).unwrap(), b"\x89PNG\r\n");
    }

    #[test]
    fn a_fingerprint_is_stable_and_readable() {
        let (_, public) = keypair();

        let printed = fingerprint(&public).unwrap();

        assert_eq!(printed, fingerprint(&public).unwrap());
        assert_eq!(printed.split(' ').count(), 8);
        assert!(printed.split(' ').all(|group| group.len() == 4));
    }

    #[test]
    fn two_identities_do_not_share_a_fingerprint() {
        let (_, first) = keypair();
        let (_, second) = keypair();
        assert_ne!(fingerprint(&first).unwrap(), fingerprint(&second).unwrap());
    }

    #[test]
    fn a_malformed_key_is_an_error_rather_than_a_panic() {
        assert!(wrap_key("not base64!", "also not").is_err());
        assert!(fingerprint("!!!").is_err());

        let (secret, _) = keypair();
        let nonsense = WrappedKey {
            ephemeral_public: "short".to_string(),
            nonce: "x".to_string(),
            ciphertext: "y".to_string(),
        };
        assert!(unwrap_key(&secret, &nonsense).is_err());
    }
}
